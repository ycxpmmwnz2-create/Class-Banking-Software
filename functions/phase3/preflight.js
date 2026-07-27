import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { cert } from 'firebase-admin/app'

import {
  EXECUTION_CONTEXT,
  PRODUCTION_ENVIRONMENT_CATEGORIES,
  ProductionEnvironmentError,
  parseJsonArtifact,
  readHashedArtifact,
  redactEnvironmentError,
  validateExecutionEnvironment,
  validateExplicitCredential,
} from './productionEnvironment.js'
import {
  PreflightAbortError,
  createProductionReaders,
  runProductionPreflight,
  validateReadAuthorization,
} from './productionPreflight.js'
import {
  ProductionManifestError,
  persistProductionManifest,
} from './productionManifest.js'

/**
 * Phase 3 Commit 3 — the preflight entrypoint.
 *
 * This is a COMPLETELY SEPARATE executable from the future write and reverify
 * entrypoints. There is no subcommand dispatch: no argument, typo, or flag can
 * turn this program into a writer, because the write code path does not exist in
 * this file and is not imported.
 *
 * Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 2.10, 8, 9.
 *
 * Credential policy: an explicit credential file is required in production and is
 * hashed before it is parsed. There is deliberately no fallback to Application
 * Default Credentials, a cached Firebase CLI login, metadata-server credentials,
 * or any other ambient discovery — an implicitly-authenticated production read is
 * exactly the accident this entrypoint exists to prevent.
 */

export const PREFLIGHT_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  ARGUMENT_REJECTED: 1,
  ENVIRONMENT_REJECTED: 2,
  AUTHORIZATION_REJECTED: 3,
  PREFLIGHT_ABORTED: 4,
  MANIFEST_FAILED: 5,
})

/** Required flags. Every one takes a value; none is optional. */
const VALUE_FLAGS = new Map([
  ['--teacher-uid', 'teacherUid'],
  ['--authorization-file', 'authorizationFile'],
  ['--expectations-file', 'expectationsFile'],
  ['--credential-file', 'credentialFile'],
])

/**
 * Flags rejected BY NAME with a specific message, rather than falling through to
 * the generic unknown-flag path. Naming them makes the refusal unambiguous in an
 * operator's terminal: `--write` on the preflight binary is a serious mistake and
 * should not read like a typo.
 */
const FORBIDDEN_FLAGS = Object.freeze(new Set([
  '--write',
  '--force',
  '--project-id',
  '--project',
  '--manifest',
  '--manifest-path',
  '--manifest-file',
  '--manifest-filename',
  '--manifest-dir',
  '--state-dir',
  '--state-directory',
  '--production',
  '--production-override',
  '--allow-production',
  '--dry-run',
  '--dry-run-override',
  '--reverify',
  '--skip-preflight',
  '--bypass',
]))

/** Subcommands rejected outright: this binary has exactly one behavior. */
const FORBIDDEN_SUBCOMMANDS = Object.freeze(new Set([
  'write', 'reverify', 'preflight', 'migrate', 'deploy',
]))

/**
 * Environment-module categories that describe a rejected ARTIFACT rather than a
 * rejected execution environment. Shared by all three entrypoints' exit-code
 * classification.
 */
export const ARTIFACT_ERROR_CATEGORIES = Object.freeze(new Set([
  PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_ARTIFACT,
  PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
  PRODUCTION_ENVIRONMENT_CATEGORIES.WRONG_PROJECT_CREDENTIAL,
]))

export class PreflightArgumentError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'PreflightArgumentError'
    this.code = 'PHASE3_PREFLIGHT_ARGUMENT_ERROR'
    this.category = category
    this.details = Object.freeze({ ...details })
  }
}

function failArgument(category, message, details) {
  throw new PreflightArgumentError(category, message, details)
}

/**
 * Parses argv with no tolerance for ambiguity.
 *
 * Rejects: forbidden flags and subcommands by name, `--flag=value` form,
 * duplicates, unknown flags, positionals, non-string tokens, and missing or
 * whitespace-padded values.
 */
export function parsePreflightArguments(argv) {
  if (!Array.isArray(argv)) {
    failArgument('invalid-arguments', 'Arguments must be provided as an array.')
  }

  const values = {}
  const seen = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (typeof token !== 'string') {
      failArgument('invalid-argument', 'Every argument must be a string.', { index })
    }

    // `--flag=value` is rejected before anything else so a forbidden flag cannot
    // smuggle itself past the name check in that form.
    if (token.startsWith('--') && token.includes('=')) {
      const flag = token.slice(0, token.indexOf('='))
      failArgument(
        'inline-value-rejected',
        `${flag} must be given as a separate value, not --flag=value.`,
        { flag, index },
      )
    }

    if (FORBIDDEN_FLAGS.has(token)) {
      failArgument(
        'forbidden-flag',
        `${token} is not accepted by the preflight entrypoint.`,
        { flag: token, index },
      )
    }

    if (FORBIDDEN_SUBCOMMANDS.has(token)) {
      failArgument(
        'forbidden-subcommand',
        `${token} is not a subcommand; preflight is a separate executable.`,
        { token, index },
      )
    }

    if (VALUE_FLAGS.has(token)) {
      if (seen.has(token)) {
        failArgument('duplicate-flag', `Duplicate flag: ${token}.`, { flag: token, index })
      }
      seen.add(token)

      const value = argv[index + 1]
      if (typeof value !== 'string' || value === '' || value.trim() === '' ||
          value.startsWith('--')) {
        failArgument('missing-value', `${token} requires a value.`, { flag: token, index })
      }
      if (value !== value.trim()) {
        failArgument(
          'invalid-value',
          `${token} must not have surrounding whitespace.`,
          { flag: token, index },
        )
      }
      values[VALUE_FLAGS.get(token)] = value
      index += 1
      continue
    }

    if (token.startsWith('--')) {
      failArgument('unknown-flag', `Unknown flag: ${token}.`, { flag: token, index })
    }

    failArgument(
      'positional-argument',
      `Positional arguments are not supported: ${token}.`,
      { index },
    )
  }

  const missing = [...VALUE_FLAGS.keys()].filter(flag => !seen.has(flag))
  if (missing.length > 0) {
    failArgument(
      'missing-required-flag',
      `Missing required flag${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
      { flags: missing },
    )
  }

  return Object.freeze({
    teacherUid: values.teacherUid,
    authorizationFile: values.authorizationFile,
    expectationsFile: values.expectationsFile,
    credentialFile: values.credentialFile,
  })
}

/**
 * Main. Returns an exit code rather than calling process.exit, so tests can drive
 * it directly and assert on outcomes.
 *
 * `dependencies` exists because the deployment control planes (Rules releases,
 * Functions revisions, Hosting releases) have no emulator, so the emulator suite
 * injects that inventory while still exercising real Firestore and Auth reads.
 */
export async function runPreflightMain(argv = process.argv.slice(2), dependencies = {}) {
  const logger = dependencies.logger ?? globalThis.console
  const environment = dependencies.environment ?? process.env

  let parsed
  let managedReaders
  try {
    parsed = parsePreflightArguments(argv)
  } catch (error) {
    logger.error(`Preflight rejected arguments: ${error.message}`)
    return { exitCode: PREFLIGHT_EXIT_CODES.ARGUMENT_REJECTED, error }
  }

  // Environment guard BEFORE any SDK/API handle is created. Nothing above this
  // point has touched a network client.
  let validatedEnvironment
  try {
    validatedEnvironment = validateExecutionEnvironment(environment)
  } catch (error) {
    const redacted = error instanceof ProductionEnvironmentError
      ? redactEnvironmentError(error)
      : { category: 'unknown' }
    logger.error(
      `Preflight rejected the environment [${redacted.category}].`,
    )
    return { exitCode: PREFLIGHT_EXIT_CODES.ENVIRONMENT_REJECTED, error }
  }

  try {
    const authorizationArtifact = await readHashedArtifact(
      parsed.authorizationFile,
      dependencies,
    )
    const expectationsArtifact = await readHashedArtifact(
      parsed.expectationsFile,
      dependencies,
    )

    // The emulator branch may omit a credential file: the hardened command
    // supplies the exact demo project and loopback hosts, and the emulators
    // accept unauthenticated Admin access. Production may never omit it.
    let credentialSha256
    let credential = null
    if (validatedEnvironment.context === EXECUTION_CONTEXT.PRODUCTION) {
      const credentialArtifact = await readHashedArtifact(
        parsed.credentialFile,
        dependencies,
      )
      credentialSha256 = credentialArtifact.sha256
      credential = validateExplicitCredential(
        parseJsonArtifact(credentialArtifact.contents, 'The credential file'),
        dependencies.credentialFactory ?? cert,
      )
    } else {
      // Still hashed and bound, so the emulator path exercises the same binding
      // logic rather than a weaker variant.
      const credentialArtifact = await readHashedArtifact(
        parsed.credentialFile,
        dependencies,
      )
      credentialSha256 = credentialArtifact.sha256
    }

    const authorization = parseJsonArtifact(
      authorizationArtifact.contents,
      'The authorization file',
    )
    const expectations = parseJsonArtifact(
      expectationsArtifact.contents,
      'The expectations file',
    )

    const nowMillis = dependencies.nowMillis ?? Date.now()

    // Bind authorization before the first Admin handle exists. The full runner
    // repeats this validation as a defense-in-depth invariant, but doing it here
    // keeps a mismatched/expired artifact from even constructing an SDK client.
    validateReadAuthorization({
      authorization,
      credentialSha256,
      expectationsSha256: expectationsArtifact.sha256,
      teacherUid: parsed.teacherUid,
      projectId: validatedEnvironment.projectId,
      nowMillis,
    })

    // Readers are constructed only now — after arguments, environment, and
    // artifacts (including authorization binding) have all been accepted.
    const readerFactory = typeof dependencies.createReaders === 'function'
      ? dependencies.createReaders
      : validatedEnvironment.context === EXECUTION_CONTEXT.PRODUCTION
        ? dependencies.productionReaderFactory ?? createProductionReaders
        : null
    const readers = typeof readerFactory === 'function'
      ? await readerFactory({
        context: validatedEnvironment.context,
        projectId: validatedEnvironment.projectId,
        teacherUid: parsed.teacherUid,
        credential,
      })
      : dependencies.readers
    if (readers && typeof readers.close === 'function') managedReaders = readers

    const result = await runProductionPreflight({
      environment,
      readers,
      authorization,
      expectations,
      credentialSha256,
      expectationsSha256: expectationsArtifact.sha256,
      // The authorization file's raw bytes, hashed before parsing, so the manifest
      // binds the whole artifact rather than a reconstruction of selected fields.
      authorizationSha256: authorizationArtifact.sha256,
      teacherUid: parsed.teacherUid,
      nowMillis,
      observedAt: dependencies.observedAt ?? new Date().toISOString(),
      persistManifest: dependencies.persistManifest ?? persistProductionManifest,
    })

    logger.log(
      `Preflight succeeded. Manifest ${result.preflightManifestId} retained.`,
    )
    return { exitCode: PREFLIGHT_EXIT_CODES.SUCCESS, result }
  } catch (error) {
    if (error instanceof PreflightArgumentError) {
      logger.error(`Preflight rejected an artifact: ${error.message}`)
      return { exitCode: PREFLIGHT_EXIT_CODES.AUTHORIZATION_REJECTED, error }
    }
    if (error instanceof PreflightAbortError) {
      logger.error(`Preflight aborted [${error.category}]: ${error.message}`)
      return { exitCode: PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED, error }
    }
    if (error instanceof ProductionManifestError) {
      logger.error(`Preflight manifest failed [${error.category}]: ${error.message}`)
      return { exitCode: PREFLIGHT_EXIT_CODES.MANIFEST_FAILED, error }
    }
    if (error instanceof ProductionEnvironmentError) {
      const redacted = redactEnvironmentError(error)
      // The shared artifact/credential helpers live in productionEnvironment.js
      // and therefore raise its error type. An artifact or credential rejection
      // is an ARTIFACT failure, not an environment one, and must keep reporting
      // as such — otherwise a malformed credential would be indistinguishable
      // from a misconfigured project.
      if (ARTIFACT_ERROR_CATEGORIES.has(error.category)) {
        logger.error(`Preflight rejected an artifact [${redacted.category}].`)
        return { exitCode: PREFLIGHT_EXIT_CODES.AUTHORIZATION_REJECTED, error }
      }
      logger.error(`Preflight rejected the environment [${redacted.category}].`)
      return { exitCode: PREFLIGHT_EXIT_CODES.ENVIRONMENT_REJECTED, error }
    }
    // Filesystem and unexpected errors: message only, never a stack containing
    // artifact contents.
    logger.error(`Preflight failed: ${error?.message ?? 'unknown error'}`)
    return { exitCode: PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED, error }
  } finally {
    if (managedReaders !== undefined) {
      try {
        await managedReaders.close()
      } catch {
        // A completed preflight result is immutable; SDK cleanup cannot rewrite
        // it into success or failure. The direct executable exits immediately,
        // and the failure is reported without credential or SDK details.
        logger.error('Preflight reader cleanup failed.')
      }
    }
  }
}

const isDirectExecution = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectExecution) {
  runPreflightMain().then(({ exitCode }) => {
    process.exitCode = exitCode
  }).catch(() => {
    process.exitCode = PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED
  })
}
