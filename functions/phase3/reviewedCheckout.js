import { execFile as nodeExecFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath, URL } from 'node:url'

import {
  PRODUCTION_ENVIRONMENT_CATEGORIES,
  ProductionEnvironmentError,
} from './productionEnvironment.js'

/**
 * Phase 3 — operator-only reviewed-checkout proof.
 *
 * This module exists so the ONLY Phase 3 code that can spawn a subprocess stays
 * out of the deployed Cloud Functions module graph. `functions/index.js` imports
 * `productionEnvironment.js` for the V2 gate, so that module ships in the
 * Functions artifact and must remain free of `node:child_process`. Nothing
 * deployed imports this file: its only callers are the four operator
 * entrypoints — `inventory.js`, `preflight.js`, `write.js`, and `reverify.js` —
 * which run from an operator workstation, never in a Cloud Functions runtime.
 *
 * Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 2, 6, 8, and 11.
 *
 * Design rules this module exists to enforce:
 *
 *  1. The proof is local and read-only. It inspects Git only; it never opens a
 *     credential, constructs an SDK or API handle, or contacts a remote.
 *  2. It raises the shared `ProductionEnvironmentError` with the shared
 *     `CHECKOUT_*` categories, so every entrypoint keeps the exact redacted
 *     failure behavior it had when this code lived beside those categories.
 *  3. Git inspection is anchored to this repository and stripped of caller
 *     routing, so an inherited `GIT_DIR`/`GIT_WORK_TREE`/config variable cannot
 *     redirect the proof at a different checkout.
 *  4. Every failure mode is closed: unreadable, non-canonical, foreign,
 *     mismatched, or dirty all throw. There is no success-by-default path.
 */

/** A full lowercase Git commit SHA. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/

/**
 * Git inspection is anchored to this repository and stripped of caller routing.
 * These checks are local and read-only; they never open a credential or remote
 * client.
 */
const REPOSITORY_ROOT = path.resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
)
const execFile = promisify(nodeExecFile)
const GIT_ROUTING_VARIABLES = Object.freeze(new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
]))

/** The anchored repository root this module proves an entrypoint runs from. */
export const ANCHORED_REPOSITORY_ROOT = REPOSITORY_ROOT

/**
 * The routing variables scrubbed from every Git invocation. Exported so a test
 * can prove the scrub list and the actual invocation cannot drift apart.
 */
export const SCRUBBED_GIT_ROUTING_VARIABLES = Object.freeze([
  ...GIT_ROUTING_VARIABLES,
])

function fail(category, message, details) {
  throw new ProductionEnvironmentError(category, message, details)
}

async function defaultRunGit(argumentsValue) {
  const gitEnvironment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        !GIT_ROUTING_VARIABLES.has(name) &&
        !name.startsWith('GIT_CONFIG_KEY_') &&
        !name.startsWith('GIT_CONFIG_VALUE_')),
    ),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
  }
  const safeArguments = [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.untrackedCache=false',
    ...argumentsValue,
  ]
  const { stdout } = await execFile('git', safeArguments, {
    cwd: REPOSITORY_ROOT,
    env: gitEnvironment,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })
  return stdout
}

function oneCanonicalGitLine(value, label) {
  if (typeof value !== 'string' || !value.endsWith('\n') ||
      value.slice(0, -1).includes('\n') || value.includes('\r')) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_UNVERIFIABLE,
      `Git returned a non-canonical ${label}.`,
    )
  }
  return value.slice(0, -1)
}

/**
 * Proves an operational entrypoint is running from the exact clean reviewed
 * checkout named by its authorization artifact.
 *
 * The caller invokes this before opening a credential or constructing any SDK
 * or API handle. `runGit` is injectable so every entrypoint can prove ordering
 * without consulting the real worktree in emulator tests.
 */
export async function verifyReviewedCheckout({
  expectedCommitSha,
  runGit = defaultRunGit,
}) {
  if (typeof expectedCommitSha !== 'string' ||
      !COMMIT_SHA_PATTERN.test(expectedCommitSha) ||
      typeof runGit !== 'function') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_UNVERIFIABLE,
      'The reviewed checkout cannot be verified.',
    )
  }
  let topLevelOutput
  let headOutput
  let statusOutput
  try {
    [topLevelOutput, headOutput, statusOutput] = await Promise.all([
      runGit(['rev-parse', '--show-toplevel']),
      runGit(['rev-parse', '--verify', 'HEAD']),
      runGit(['status', '--porcelain=v1', '--untracked-files=all']),
    ])
  } catch (error) {
    if (error instanceof ProductionEnvironmentError) throw error
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_UNVERIFIABLE,
      'The reviewed checkout cannot be verified.',
    )
  }
  const topLevel = oneCanonicalGitLine(topLevelOutput, 'repository root')
  const head = oneCanonicalGitLine(headOutput, 'commit identity')
  if (topLevel !== REPOSITORY_ROOT || !COMMIT_SHA_PATTERN.test(head)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_UNVERIFIABLE,
      'The entrypoint is not running from its expected repository.',
    )
  }
  if (head !== expectedCommitSha) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_MISMATCH,
      'The running checkout is not the reviewed commit.',
    )
  }
  if (statusOutput !== '') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_DIRTY,
      'The reviewed checkout contains local or untracked changes.',
    )
  }
  return Object.freeze({ repositoryRoot: topLevel, commitSha: head })
}
