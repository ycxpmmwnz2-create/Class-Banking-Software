import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

import { requireFirestoreEmulatorHost, EmulatorEnvironmentError } from './emulatorEnvironment.js'
import { parseCliArguments, CliArgumentError } from './cli.js'
import { deriveCanonicalManifestSlot } from './manifestSlot.js'
import {
  migrateClassroomData,
  MigrateClassroomDataError,
  MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES,
} from './migrateClassroomData.js'
import { FoundationValidationError } from './foundationValidator.js'
import { SourceReaderError } from './sourceReader.js'
import { ProjectionError } from './projection.js'
import { DestinationPreflightError } from './destinationPreflight.js'
import { ReconciliationError } from './reconciliation.js'
import { BatchWriterError } from './batchWriter.js'
import { ManifestError, MANIFEST_ERROR_CATEGORIES } from './manifest.js'

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  VALIDATION_FAILURE: 1,
  PREFLIGHT_CONFLICT: 2,
  STALE_MANIFEST_MISMATCH: 3,
  WRITE_FAILURE: 4,
  INDETERMINATE_RECOVERY_REQUIRED: 5,
  RECONCILIATION_FAILURE: 6,
})

export function classifyErrorToExitCode(error) {
  if (
    error instanceof CliArgumentError ||
    error instanceof EmulatorEnvironmentError ||
    error instanceof FoundationValidationError ||
    error instanceof SourceReaderError ||
    error instanceof ProjectionError ||
    (error instanceof MigrateClassroomDataError &&
      (error.category === MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.CREDENTIAL_CLASSROOM_ID_INVALID ||
       error.category === MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INVALID_ARGUMENT))
  ) {
    return EXIT_CODES.VALIDATION_FAILURE
  }

  if (
    error instanceof DestinationPreflightError ||
    (error instanceof MigrateClassroomDataError &&
      (error.category === MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.PREFLIGHT_CONFLICT ||
       error.category === MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.RECOVERY_DIVERGENT))
  ) {
    return EXIT_CODES.PREFLIGHT_CONFLICT
  }

  if (
    error instanceof ManifestError ||
    (error instanceof MigrateClassroomDataError &&
      error.category === MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT)
  ) {
    return EXIT_CODES.STALE_MANIFEST_MISMATCH
  }

  if (
    error instanceof BatchWriterError ||
    (error instanceof MigrateClassroomDataError &&
      error.category === MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.WRITE_FAILED)
  ) {
    return EXIT_CODES.WRITE_FAILURE
  }

  if (
    error instanceof ReconciliationError ||
    (error instanceof MigrateClassroomDataError &&
      error.category === MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.RECONCILIATION_FAILED)
  ) {
    return EXIT_CODES.RECONCILIATION_FAILURE
  }

  return EXIT_CODES.VALIDATION_FAILURE
}

function getOrCreateFirestore(projectId) {
  const appName = `phase2a-cli-${projectId}`
  const existingApps = getApps()
  const app = existingApps.find(a => a.name === appName) || initializeApp({ projectId }, appName)
  return getFirestore(app)
}

export async function runMain(argv = process.argv.slice(2), dependencies = {}) {
  const logger = dependencies.logger ?? console
  const firestoreFactory = dependencies.firestoreFactory ?? getOrCreateFirestore

  try {
    // Emulator environment check MUST run first
    requireFirestoreEmulatorHost()

    const parsed = parseCliArguments(argv)
    const slot = deriveCanonicalManifestSlot({
      emulatorProjectId: parsed.projectId,
      teacherUid: parsed.teacherUid,
    })

    logger.log(`Canonical manifest slot: ${slot.manifestPath}`)

    const firestore = dependencies.firestore ?? firestoreFactory(parsed.projectId)

    const result = await migrateClassroomData({
      firestore,
      teacherUid: parsed.teacherUid,
      projectId: parsed.projectId,
      write: parsed.write,
      clock: dependencies.clock,
      pageSize: dependencies.pageSize,
    })

    logger.log(`Phase 2A migration (${result.mode}) finished successfully.`)
    return { exitCode: EXIT_CODES.SUCCESS, result, canonicalPath: slot.manifestPath }
  } catch (error) {
    const exitCode = classifyErrorToExitCode(error)
    logger.error(`Phase 2A migration failed [exit ${exitCode}]: ${error.message}`)
    return { exitCode, error }
  }
}

const isDirectExecution = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectExecution) {
  runMain().then(({ exitCode }) => {
    process.exitCode = exitCode
  }).catch(() => {
    process.exitCode = EXIT_CODES.VALIDATION_FAILURE
  })
}
