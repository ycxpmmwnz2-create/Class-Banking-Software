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
  validateRehearsalWriteAuthorization,
  validateWriteAuthorization,
} from './productionEnvironment.js'
import {
  PreflightAbortError,
  createRawDataReaders,
} from './productionPreflight.js'
import {
  ProductionManifestError,
  readProductionManifest,
} from './productionManifest.js'
import {
  ProductionReconciliationError,
  readAndReconcileWriteRun,
} from './productionReconciliation.js'

/**
 * Phase 3 Commit 5 — the read-only re-verification entrypoint.
 *
 * REMOTE READ-ONLY AND LOCAL STATE READ-ONLY.
 *
 * This module deliberately does NOT import `productionWriter.js`. That is a
 * structural guarantee, not a convention: the writer is the only module holding
 * transaction, create, update, and batch code, so not importing it means no
 * mutating call is reachable from this file at all. The shared
 * read-and-reconcile helper lives in `productionReconciliation.js` precisely so
 * this separation can hold.
 *
 * It appends no journal event, persists no manifest, and exposes no cleanup
 * operation. It succeeds only for a completed journal and exactly matching
 * state.
 *
 * Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 8, 9.
 */

export const REVERIFY_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  ARGUMENT_REJECTED: 1,
  ENVIRONMENT_REJECTED: 2,
  AUTHORIZATION_REJECTED: 3,
  REVERIFY_FAILED: 4,
  MANIFEST_FAILED: 5,
  JOURNAL_NOT_COMPLETED: 12,
})

/** The same artifact set write.js accepts. No more, no fewer. */
const VALUE_FLAGS = new Map([
  ['--write-authorization-file', 'writeAuthorizationFile'],
  ['--preflight-authorization-file', 'preflightAuthorizationFile'],
  ['--initialization-expectations-file', 'initializationExpectationsFile'],
  ['--copy-expectations-file', 'copyExpectationsFile'],
  ['--credential-file', 'credentialFile'],
])

const FORBIDDEN_FLAGS = Object.freeze(new Set([
  '--teacher-uid', '--teacher', '--uid',
  '--project-id', '--project',
  '--release-id', '--release',
  '--change-id', '--change',
  '--manifest', '--manifest-id', '--manifest-path', '--manifest-file',
  '--manifest-filename', '--manifest-dir',
  '--state-dir', '--state-directory', '--journal-dir', '--journal-path',
  '--stage', '--mode', '--phase', '--step',
  '--resume', '--retry', '--continue', '--restart',
  '--force', '--yes', '--confirm',
  '--dry-run', '--dry-run-override',
  '--production', '--production-override', '--allow-production',
  '--skip-preflight', '--skip-verification', '--bypass',
  '--login-code', '--student-login-code', '--classroom-code',
  '--preflight', '--reverify', '--write', '--repair', '--fix', '--cleanup',
]))

const FORBIDDEN_SUBCOMMANDS = Object.freeze(new Set([
  'write', 'preflight', 'reverify', 'migrate', 'deploy',
  'init', 'initialize', 'copy', 'resume', 'rollback', 'cleanup', 'repair',
]))

const ARTIFACT_ERROR_CATEGORIES = Object.freeze(new Set([
  PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_ARTIFACT,
  PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
  PRODUCTION_ENVIRONMENT_CATEGORIES.WRONG_PROJECT_CREDENTIAL,
]))

export class ReverifyArgumentError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ReverifyArgumentError'
    this.code = 'PHASE3_REVERIFY_ARGUMENT_ERROR'
    this.category = category
    this.details = Object.freeze({ ...details })
  }
}

function failArgument(category, message, details) {
  throw new ReverifyArgumentError(category, message, details)
}

export function parseReverifyArguments(argv) {
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
        `${token} is not accepted by the reverify entrypoint.`,
        { flag: token, index },
      )
    }

    if (FORBIDDEN_SUBCOMMANDS.has(token)) {
      failArgument(
        'forbidden-subcommand',
        `${token} is not a subcommand; reverify is a separate executable.`,
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
    writeAuthorizationFile: values.writeAuthorizationFile,
    preflightAuthorizationFile: values.preflightAuthorizationFile,
    initializationExpectationsFile: values.initializationExpectationsFile,
    copyExpectationsFile: values.copyExpectationsFile,
    credentialFile: values.credentialFile,
  })
}

/**
 * Replays the journal READ-ONLY and requires a completed chain.
 *
 * Reverify never appends, so it takes a replay-only view. A run that has not
 * completed is reported as such rather than being "finished" by this program.
 */
export function requireCompletedJournal(replay) {
  if (!replay?.exists || replay.events.length === 0) {
    failArgument('journal-absent', 'No journal exists for this manifest.')
  }
  const head = replay.head
  if (head.event !== 'completed') {
    failArgument(
      'journal-not-completed',
      'The retained journal does not record a completed write.',
      { head: head.event },
    )
  }
  return replay
}

export async function runReverifyMain(argv = process.argv.slice(2), dependencies = {}) {
  const logger = dependencies.logger ?? globalThis.console
  const environment = dependencies.environment ?? process.env

  let parsed
  let managedHandles
  try {
    parsed = parseReverifyArguments(argv)
  } catch (error) {
    logger.error(`Reverify rejected arguments: ${error.message}`)
    return { exitCode: REVERIFY_EXIT_CODES.ARGUMENT_REJECTED, error }
  }

  let validatedEnvironment
  try {
    validatedEnvironment = validateExecutionEnvironment(environment)
  } catch (error) {
    const redacted = error instanceof ProductionEnvironmentError
      ? redactEnvironmentError(error)
      : { category: 'unknown' }
    logger.error(`Reverify rejected the environment [${redacted.category}].`)
    return { exitCode: REVERIFY_EXIT_CODES.ENVIRONMENT_REJECTED, error }
  }

  const isProduction =
    validatedEnvironment.context === EXECUTION_CONTEXT.PRODUCTION

  try {
    const writeAuthorizationArtifact = await readHashedArtifact(
      parsed.writeAuthorizationFile, dependencies,
    )
    const preflightAuthorizationArtifact = await readHashedArtifact(
      parsed.preflightAuthorizationFile, dependencies,
    )
    const initializationExpectationsArtifact = await readHashedArtifact(
      parsed.initializationExpectationsFile, dependencies,
    )
    const copyExpectationsArtifact = await readHashedArtifact(
      parsed.copyExpectationsFile, dependencies,
    )
    const credentialArtifact = await readHashedArtifact(
      parsed.credentialFile, dependencies,
    )

    const writeAuthorization = parseJsonArtifact(
      writeAuthorizationArtifact.contents, 'The write authorization file',
    )
    const preflightAuthorization = parseJsonArtifact(
      preflightAuthorizationArtifact.contents,
      'The preflight authorization file',
    )
    const copyExpectations = parseJsonArtifact(
      copyExpectationsArtifact.contents, 'The copy expectations file',
    )

    const nowMillis = dependencies.nowMillis ?? Date.now()
    const validateAuthorization = isProduction
      ? validateWriteAuthorization
      : validateRehearsalWriteAuthorization
    const validatedAuthorization = validateAuthorization(writeAuthorization, {
      environment,
      expectedReleaseId: writeAuthorization.releaseId,
      nowMillis,
    })
    if (validatedAuthorization.initializationExpectationsSha256 !==
          initializationExpectationsArtifact.sha256 ||
        validatedAuthorization.copyExpectationsSha256 !==
          copyExpectationsArtifact.sha256) {
      failArgument(
        'unbound-expectations',
        'A presented expectations artifact is not the authorized one.',
      )
    }

    const manifest = await readProductionManifest(
      validatedAuthorization.preflightManifestId,
      dependencies,
    )

    // The journal is read and required to be COMPLETE before any audit runs.
    const journal = dependencies.journal
    if (!journal || typeof journal.replay !== 'function') {
      failArgument('journal-unavailable', 'A read-only journal view is required.')
    }
    let replay
    try {
      replay = requireCompletedJournal(await journal.replay())
    } catch (error) {
      logger.error(`Reverify: ${error.message}`)
      return { exitCode: REVERIFY_EXIT_CODES.JOURNAL_NOT_COMPLETED, error }
    }

    // Current copy-stage deployment expectations are revalidated. Reverify
    // compares; it never deploys or repairs.
    const observedInventory = await dependencies.readDeploymentInventory()
    const gate = observedInventory?.gateParameters?.MULTI_TEACHER_V2_ENABLED
    if (Array.isArray(copyExpectations.acknowledgedWriters) === false) {
      failArgument(
        'unbound-expectations',
        'The copy expectations must enumerate acknowledged active writers.',
      )
    }
    if (gate !== 'false' && gate !== false) {
      failArgument(
        'deployment-drift',
        'The V2 gate is not in the expected copy-stage state.',
      )
    }

    let credential = null
    if (isProduction) {
      credential = validateExplicitCredential(
        parseJsonArtifact(credentialArtifact.contents, 'The credential file'),
        dependencies.credentialFactory ?? cert,
      )
    }
    const handles = await (dependencies.createHandles ?? defaultCreateHandles)({
      context: validatedEnvironment.context,
      projectId: validatedEnvironment.projectId,
      credential,
    })
    if (handles && typeof handles.close === 'function') managedHandles = handles

    const rawReaders = dependencies.rawReaders ?? createRawDataReaders({
      firestore: handles.firestore,
      teacherUid: manifest.teacherUid,
    })

    const teacher = await rawReaders.readTeacher()
    if (teacher.exists !== true) {
      failArgument('foundation-absent', 'The teacher foundation is absent.')
    }
    const classroomId = teacher.data.classroomId
    const classroom = await rawReaders.readClassroom(classroomId)
    if (classroom.exists !== true) {
      failArgument('foundation-absent', 'The classroom is absent.')
    }

    const canonicalLoginCode = preflightAuthorization.studentLoginCode
    const reconciliation = await readAndReconcileWriteRun({
      rawReaders,
      foundation: { teacherUid: manifest.teacherUid, classroomId, classroom },
      initialization: {
        canonicalLoginCode,
        formattedLoginCode: classroom.data.studentLoginCode,
        nextStudentNumber: classroom.data.nextStudentNumber,
      },
    })

    logger.log('Reverify succeeded: state matches the reviewed projection.')
    return {
      exitCode: REVERIFY_EXIT_CODES.SUCCESS,
      reconciliation,
      journalHead: replay.head.event,
    }
  } catch (error) {
    if (error instanceof ReverifyArgumentError) {
      logger.error(`Reverify rejected an artifact: ${error.message}`)
      return { exitCode: REVERIFY_EXIT_CODES.AUTHORIZATION_REJECTED, error }
    }
    if (error instanceof ProductionReconciliationError) {
      logger.error(`Reverify found a mismatch [${error.category}].`)
      return { exitCode: REVERIFY_EXIT_CODES.REVERIFY_FAILED, error }
    }
    if (error instanceof PreflightAbortError) {
      logger.error(`Reverify aborted [${error.category}]: ${error.message}`)
      return { exitCode: REVERIFY_EXIT_CODES.REVERIFY_FAILED, error }
    }
    if (error instanceof ProductionManifestError) {
      logger.error(`Reverify manifest failed [${error.category}].`)
      return { exitCode: REVERIFY_EXIT_CODES.MANIFEST_FAILED, error }
    }
    if (error instanceof ProductionEnvironmentError) {
      const redacted = redactEnvironmentError(error)
      if (ARTIFACT_ERROR_CATEGORIES.has(error.category)) {
        logger.error(`Reverify rejected an artifact [${redacted.category}].`)
        return { exitCode: REVERIFY_EXIT_CODES.AUTHORIZATION_REJECTED, error }
      }
      logger.error(`Reverify rejected the environment [${redacted.category}].`)
      return { exitCode: REVERIFY_EXIT_CODES.ENVIRONMENT_REJECTED, error }
    }
    logger.error(`Reverify failed: ${error?.message ?? 'unknown error'}`)
    return { exitCode: REVERIFY_EXIT_CODES.REVERIFY_FAILED, error }
  } finally {
    if (managedHandles !== undefined) {
      try {
        await managedHandles.close()
      } catch {
        logger.error('Reverify handle cleanup failed.')
      }
    }
  }
}

async function defaultCreateHandles() {
  throw new Error(
    'A handle factory must be supplied; reverify.js constructs no ambient client.',
  )
}

const isDirectExecution = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectExecution) {
  runReverifyMain().then(({ exitCode }) => {
    process.exitCode = exitCode
  }).catch(() => {
    process.exitCode = REVERIFY_EXIT_CODES.REVERIFY_FAILED
  })
}
