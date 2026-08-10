import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'

import { deriveCanonicalManifestSlot } from './manifestSlot.js'
import {
  readCanonicalManifest,
  writeCanonicalManifest,
  createPlannedManifest,
  transitionManifest,
  listRecoveryBatchIds,
  MANIFEST_MODES,
  MANIFEST_RUN_STATES,
  MANIFEST_BATCH_STATES,
  MANIFEST_OPERATION_STATES,
  MANIFEST_OPERATION_TYPES,
  MANIFEST_TRANSITIONS,
} from './manifest.js'
import { readLegacySources } from './sourceReader.js'
import { validateTeacherClassroomFoundation } from './foundationValidator.js'
import { buildMigrationProjection, LEGACY_CLASSROOM_ID } from './projection.js'
import {
  buildDestinationPreflight,
  DestinationPreflightError,
  DESTINATION_PREFLIGHT_ERROR_CATEGORIES,
} from './destinationPreflight.js'
import { reconcileDryRun, reconcileWriteRun } from './reconciliation.js'
import {
  writeMigrationBatches,
  BatchWriterError,
  BATCH_WRITER_ERROR_CATEGORIES,
} from './batchWriter.js'
import { hashCanonicalState, encodeCanonicalFirestoreValue } from './canonicalState.js'

export const MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES = Object.freeze({
  INVALID_ARGUMENT: 'invalid-argument',
  CREDENTIAL_CLASSROOM_ID_INVALID: 'credential-classroom-id-invalid',
  RETAINED_PLAN_REQUIRED: 'retained-plan-required',
  PREFLIGHT_CONFLICT: 'preflight-conflict',
  STALE_MANIFEST_DRIFT: 'stale-manifest-drift',
  RECOVERY_DIVERGENT: 'recovery-divergent',
  INDETERMINATE_RECOVERY_REQUIRED: 'indeterminate-recovery-required',
  RECONCILIATION_FAILED: 'reconciliation-failed',
  WRITE_FAILED: 'write-failed',
})

export class MigrateClassroomDataError extends Error {
  constructor(category, message, details = {}, cause = undefined) {
    super(message, cause ? { cause } : undefined)
    this.name = 'MigrateClassroomDataError'
    this.code = 'MIGRATE_CLASSROOM_DATA_ERROR'
    this.category = category
    Object.assign(this, details)
  }
}

function fail(category, message, details = {}, cause = undefined) {
  throw new MigrateClassroomDataError(category, message, details, cause)
}

function getTimestamp(clock) {
  if (!clock) return new Date().toISOString()
  const val = clock()
  return typeof val === 'string' ? val : val.toISOString()
}

function getNextTimestamp(manifest, clock) {
  const sampled = getTimestamp(clock)
  const sampledMilliseconds = Date.parse(sampled)
  const previousMilliseconds = Date.parse(manifest.updatedAt)

  if (!Number.isFinite(sampledMilliseconds) ||
      !Number.isFinite(previousMilliseconds)) {
    return sampled
  }

  return new Date(Math.max(
    sampledMilliseconds,
    previousMilliseconds + 1,
  )).toISOString()
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INVALID_ARGUMENT,
      'migrateClassroomData requires an options object.',
    )
  }

  const { firestore, teacherUid, projectId, write = false, clock, pageSize } = options

  if (firestore === null || typeof firestore !== 'object') {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INVALID_ARGUMENT,
      'A valid Firestore instance is required.',
    )
  }

  if (typeof teacherUid !== 'string' || teacherUid.length === 0 || teacherUid.trim() !== teacherUid) {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INVALID_ARGUMENT,
      'teacherUid must be a non-empty canonical string.',
    )
  }

  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.trim() !== projectId) {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INVALID_ARGUMENT,
      'projectId must be a non-empty canonical string.',
    )
  }

  if (typeof write !== 'boolean') {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INVALID_ARGUMENT,
      'write option must be a boolean.',
    )
  }

  return { firestore, teacherUid, projectId, write, clock, pageSize }
}

function validateRawCredentials(studentCredentials) {
  for (const credential of studentCredentials) {
    const credClassroomId = credential?.data?.classroomId
    if (credClassroomId !== LEGACY_CLASSROOM_ID) {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.CREDENTIAL_CLASSROOM_ID_INVALID,
        `Raw credential document ${credential.path} has classroomId "${credClassroomId}", expected "${LEGACY_CLASSROOM_ID}".`,
        { path: credential.path, classroomId: credClassroomId },
      )
    }
  }
}

function normalizeRetainedSourceForProjection(source) {
  const normalizedCredentials = source.studentCredentials.map(envelope => {
    return {
      ...envelope,
      data: { ...envelope.data, classroomId: LEGACY_CLASSROOM_ID },
    }
  })
  return {
    ...source,
    studentCredentials: normalizedCredentials,
  }
}

function calculateChecksums(source, foundation, planChecksum, projection) {
  const immutableSourceChecksum = hashCanonicalState({
    classroomData: encodeCanonicalFirestoreValue(source.classroomData),
    studentAuthLogs: encodeCanonicalFirestoreValue(source.studentAuthLogs),
  })

  const foundationInvariantChecksum = hashCanonicalState({
    teacher: encodeCanonicalFirestoreValue(foundation.teacher),
    classroom: {
      id: foundation.classroom.id,
      path: foundation.classroom.path,
      data: {
        ownerUid: foundation.classroom.data.ownerUid,
        name: foundation.classroom.data.name,
        createdAt: encodeCanonicalFirestoreValue(foundation.classroom.data.createdAt),
        updatedAt: encodeCanonicalFirestoreValue(foundation.classroom.data.updatedAt),
        version: foundation.classroom.data.version,
      },
    },
  })

  const credentialInvariantHashes = Object.freeze(
    Object.fromEntries(
      projection.studentCredentials.map(cred => {
        const invariantData = { ...cred.data }
        delete invariantData.classroomId
        return [cred.path, hashCanonicalState(encodeCanonicalFirestoreValue(invariantData))]
      }),
    ),
  )

  return Object.freeze({
    immutableSourceChecksum,
    foundationInvariantChecksum,
    planChecksum,
    credentialInvariantHashes,
  })
}

function expectedChecksumsFromManifest(manifest) {
  const credentialInvariantHashes = Object.freeze(Object.fromEntries(
    manifest.operations
      .filter(operation => operation.type ===
        MANIFEST_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE)
      .map(operation => [
        operation.path,
        operation.rollbackPreimage.invariantHash,
      ]),
  ))

  return Object.freeze({
    immutableSourceChecksum: manifest.immutableSourceChecksum,
    foundationInvariantChecksum: manifest.foundationInvariantChecksum,
    planChecksum: manifest.planChecksum,
    credentialInvariantHashes,
  })
}

function assertManifestChecksums(
  manifest,
  foundation,
  currentChecksums,
  { includeCredentials = true } = {},
) {
  const expectedChecksums = expectedChecksumsFromManifest(manifest)
  const checksumMismatch =
    manifest.classroomId !== foundation.classroomId ||
    expectedChecksums.immutableSourceChecksum !==
      currentChecksums.immutableSourceChecksum ||
    expectedChecksums.foundationInvariantChecksum !==
      currentChecksums.foundationInvariantChecksum ||
    (includeCredentials && !isDeepStrictEqual(
      expectedChecksums.credentialInvariantHashes,
      currentChecksums.credentialInvariantHashes,
    ))

  if (checksumMismatch) {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT,
      'Retained manifest identity or checksum does not match current state.',
      {
        expectedClassroomId: manifest.classroomId,
        actualClassroomId: foundation.classroomId,
        expectedSourceChecksum: expectedChecksums.immutableSourceChecksum,
        actualSourceChecksum: currentChecksums.immutableSourceChecksum,
        expectedFoundationChecksum:
          expectedChecksums.foundationInvariantChecksum,
        actualFoundationChecksum:
          currentChecksums.foundationInvariantChecksum,
      },
    )
  }

  return expectedChecksums
}

function expectedPlannedBatches(preflight) {
  const operationById = new Map(preflight.operations.map(operation => [
    operation.operationId,
    operation,
  ]))

  return preflight.batches.map(batch => ({
    ...batch,
    state: batch.operationIds.every(operationId =>
      operationById.get(operationId).state ===
        MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL)
      ? MANIFEST_BATCH_STATES.VERIFIED
      : MANIFEST_BATCH_STATES.PENDING,
  }))
}

function assertRetainedPlannedManifest(
  manifest,
  foundation,
  preflight,
  currentChecksums,
) {
  assertManifestChecksums(manifest, foundation, currentChecksums)

  const retainedPlanMatches =
    manifest.planChecksum === currentChecksums.planChecksum &&
    isDeepStrictEqual(manifest.operations, preflight.operations) &&
    isDeepStrictEqual(manifest.batches, expectedPlannedBatches(preflight)) &&
    isDeepStrictEqual(
      manifest.orphanedCredentialPaths,
      preflight.orphanedCredentialPaths,
    )

  if (!retainedPlanMatches) {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT,
      'Retained planned manifest does not match the current destination plan.',
      {
        expectedPlanChecksum: manifest.planChecksum,
        actualPlanChecksum: currentChecksums.planChecksum,
      },
    )
  }
}

function projectedAfterOperations(projection) {
  const entries = [{
    type: MANIFEST_OPERATION_TYPES.CLASSROOM_FIELD_UPDATE,
    path: projection.classroom.path,
    data: projection.classroom.data,
  }]

  for (const collection of [
    'students',
    'transactions',
    'loginHistory',
    'studentAuthLogs',
  ]) {
    for (const entry of projection[collection]) {
      entries.push({
        type: MANIFEST_OPERATION_TYPES.CREATE,
        path: entry.path,
        data: entry.data,
      })
    }
  }

  for (const entry of projection.studentCredentials) {
    entries.push({
      type: MANIFEST_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE,
      path: entry.path,
      data: entry.data,
    })
  }

  return new Map(entries.map(entry => [entry.path, {
    type: entry.type,
    expectedAfterHash: hashCanonicalState(
      encodeCanonicalFirestoreValue(entry.data),
    ),
  }]))
}

function operationPlanChecksum(operations) {
  return hashCanonicalState(operations.map(operation => ({
    type: operation.type,
    path: operation.path,
    expectedBeforeHash: operation.expectedBeforeHash,
    expectedAfterHash: operation.expectedAfterHash,
  })))
}

function assertRetainedProjection(manifest, projection) {
  const projected = projectedAfterOperations(projection)
  const matches =
    manifest.planChecksum === operationPlanChecksum(manifest.operations) &&
    projected.size === manifest.operations.length &&
    manifest.operations.every(operation => {
      const expected = projected.get(operation.path)
      return expected?.type === operation.type &&
        expected.expectedAfterHash === operation.expectedAfterHash
    }) &&
    isDeepStrictEqual(
      manifest.orphanedCredentialPaths,
      projection.orphanedCredentialPaths,
    )

  if (!matches) {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT,
      'Current source projection does not match the retained operation plan.',
    )
  }
}

async function buildPreflightOrFail({ firestore, foundation, projection }) {
  try {
    return await buildDestinationPreflight({
      firestore,
      foundation,
      projection,
    })
  } catch (error) {
    if (error instanceof DestinationPreflightError &&
        error.category ===
          DESTINATION_PREFLIGHT_ERROR_CATEGORIES.DIVERGENT_DESTINATIONS) {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.PREFLIGHT_CONFLICT,
        error.message,
        { error },
        error,
      )
    }
    throw error
  }
}

async function persistRecoveryManifest(candidate) {
  try {
    return await writeCanonicalManifest(candidate)
  } catch {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INDETERMINATE_RECOVERY_REQUIRED,
      'Restart recovery state could not be durably persisted; recovery remains required.',
    )
  }
}

async function readActualFirestoreState(firestore, foundation, projection) {
  const teacherDoc = await firestore.doc(foundation.teacher.path).get()
  const classroomDoc = await firestore.doc(foundation.classroom.path).get()
  const legacyClassroomDataDoc = await firestore.doc('morganBank/classroomData').get()

  const readEnvelope = async (docRef) => {
    const snap = await docRef.get()
    if (!snap.exists) return null
    return { id: snap.id, path: snap.ref.path, data: snap.data() }
  }

  const students = await Promise.all(
    projection.students.map(item => readEnvelope(firestore.doc(item.path))),
  ).then(list => list.filter(Boolean))

  const transactions = await Promise.all(
    projection.transactions.map(item => readEnvelope(firestore.doc(item.path))),
  ).then(list => list.filter(Boolean))

  const loginHistory = await Promise.all(
    projection.loginHistory.map(item => readEnvelope(firestore.doc(item.path))),
  ).then(list => list.filter(Boolean))

  const studentCredentials = await Promise.all(
    projection.studentCredentials.map(item => readEnvelope(firestore.doc(item.path))),
  ).then(list => list.filter(Boolean))

  const studentAuthLogs = await Promise.all(
    projection.studentAuthLogs.map(item => readEnvelope(firestore.doc(item.path))),
  ).then(list => list.filter(Boolean))

  const originalStudentAuthLogs = await Promise.all(
    projection.studentAuthLogs.map(item => readEnvelope(firestore.doc(item.sourcePath ?? `studentAuthLogs/${item.id}`))),
  ).then(list => list.filter(Boolean))

  return {
    teacher: teacherDoc.exists ? { id: teacherDoc.id, path: teacherDoc.ref.path, data: teacherDoc.data() } : null,
    classroom: classroomDoc.exists ? { id: classroomDoc.id, path: classroomDoc.ref.path, data: classroomDoc.data() } : null,
    legacyClassroomData: legacyClassroomDataDoc.exists ? { id: legacyClassroomDataDoc.id, path: legacyClassroomDataDoc.ref.path, data: legacyClassroomDataDoc.data() } : null,
    students,
    transactions,
    loginHistory,
    studentCredentials,
    studentAuthLogs,
    originalStudentAuthLogs,
  }
}

function recoveryDocumentData(operation, data) {
  if (operation.type !== MANIFEST_OPERATION_TYPES.CLASSROOM_FIELD_UPDATE) {
    return data
  }

  const fields = {}
  if (Object.hasOwn(data, 'settings')) {
    fields.settings = data.settings
  }
  if (Object.hasOwn(data, 'lastBackupAt')) {
    fields.lastBackupAt = data.lastBackupAt
  }
  return fields
}

async function recoverBatches({ firestore, manifest, clock }) {
  let currentManifest = manifest
  const unverifiedBatchIds = listRecoveryBatchIds(currentManifest)

  for (const batchId of unverifiedBatchIds) {
    const batch = currentManifest.batches.find(b => b.batchId === batchId)
    if (!batch) continue

    const batchOps = currentManifest.operations.filter(op => op.batchId === batchId)
    const opStates = []

    for (const op of batchOps) {
      const snap = await firestore.doc(op.path).get()
      if (!snap.exists) {
        if (op.type === MANIFEST_OPERATION_TYPES.CREATE || op.expectedBeforeHash === 'absent') {
          opStates.push({ op, state: 'before-state', snap: null })
        } else {
          opStates.push({ op, state: 'divergent', snap: null })
        }
      } else {
        const hash = hashCanonicalState(encodeCanonicalFirestoreValue(
          recoveryDocumentData(op, snap.data()),
        ))
        if (hash === op.expectedAfterHash) {
          opStates.push({ op, state: 'after-state', snap })
        } else if (hash === op.expectedBeforeHash) {
          opStates.push({ op, state: 'before-state', snap })
        } else {
          opStates.push({ op, state: 'divergent', snap })
        }
      }
    }

    const isDivergent = opStates.some(item => item.state === 'divergent')
    const allAfter = opStates.every(item => item.state === 'after-state')
    const allBefore = opStates.every(item => item.state === 'before-state')
    const updatedAt = getNextTimestamp(currentManifest, clock)

    if (isDivergent) {
      const divergentOpIds = opStates.filter(item => item.state === 'divergent').map(item => item.op.operationId)
      const failedManifest = transitionManifest(currentManifest, {
        type: MANIFEST_TRANSITIONS.RECOVER_BATCH_DIVERGENT,
        batchId,
        operationIds: divergentOpIds,
        error: { code: 'DIVERGENT_RECOVERY_STATE', message: 'Divergent state detected during recovery.' },
        updatedAt,
      })
      await persistRecoveryManifest(failedManifest)
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.RECOVERY_DIVERGENT,
        `Divergent destination state detected in batch ${batchId} during restart recovery.`,
        { batchId },
      )
    } else if (allAfter) {
      const verifiedManifest = transitionManifest(currentManifest, {
        type: MANIFEST_TRANSITIONS.RECOVER_BATCH_AFTER,
        batchId,
        updatedAt,
      })
      currentManifest = await persistRecoveryManifest(verifiedManifest)
    } else if (allBefore) {
      const freshUpdateTimePreconditions = {}
      for (const item of opStates) {
        if (item.snap?.updateTime) {
          freshUpdateTimePreconditions[item.op.operationId] = encodeCanonicalFirestoreValue(item.snap.updateTime)
        }
      }
      const resetManifest = transitionManifest(currentManifest, {
        type: MANIFEST_TRANSITIONS.RECOVER_BATCH_BEFORE,
        batchId,
        freshUpdateTimePreconditions,
        updatedAt,
      })
      currentManifest = await persistRecoveryManifest(resetManifest)
      break
    } else {
      const beforeOperationIds = opStates.filter(item => item.state === 'before-state').map(item => item.op.operationId)
      const afterOperationIds = opStates.filter(item => item.state === 'after-state').map(item => item.op.operationId)
      const freshUpdateTimePreconditions = {}
      for (const item of opStates) {
        if (item.state === 'before-state' && item.snap?.updateTime) {
          freshUpdateTimePreconditions[item.op.operationId] = encodeCanonicalFirestoreValue(item.snap.updateTime)
        }
      }
      const mixedManifest = transitionManifest(currentManifest, {
        type: MANIFEST_TRANSITIONS.RECOVER_BATCH_MIXED,
        batchId,
        beforeOperationIds,
        afterOperationIds,
        freshUpdateTimePreconditions,
        updatedAt,
      })
      currentManifest = await persistRecoveryManifest(mixedManifest)
      break
    }
  }

  return currentManifest
}

export async function migrateClassroomData(options) {
  const { firestore, teacherUid, projectId, write, clock, pageSize } = validateOptions(options)
  const identity = { emulatorProjectId: projectId, teacherUid }

  const slot = deriveCanonicalManifestSlot(identity)
  let manifest = await readCanonicalManifest(identity)
  let source
  let foundation
  let projection
  let observedChecksums
  let recoveringWriteStartedManifest = false

  if (manifest === null || (manifest.runState === MANIFEST_RUN_STATES.FAILED && !manifest.writePhaseStarted)) {
    if (write) {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.RETAINED_PLAN_REQUIRED,
        'Write mode requires a successful retained dry-run manifest in the canonical slot.',
        { canonicalPath: slot.manifestPath },
      )
    }

    const rawSource = await readLegacySources({ firestore, pageSize })
    foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })
    validateRawCredentials(rawSource.studentCredentials)
    source = rawSource
    projection = buildMigrationProjection({
      classroomId: foundation.classroomId,
      ...source,
    })
    const preflight = await buildPreflightOrFail({
      firestore,
      foundation,
      projection,
    })
    const expectedChecksums = calculateChecksums(
      source,
      foundation,
      preflight.planChecksum,
      projection,
    )
    const reconciliationSummary = reconcileDryRun({
      source,
      foundation,
      projection,
      expectedChecksums,
      observedChecksums: expectedChecksums,
    })

    const createdAt = getTimestamp(clock)
    const runId = randomUUID()

    const planned = createPlannedManifest({
      runId,
      emulatorProjectId: projectId,
      teacherUid,
      classroomId: foundation.classroomId,
      createdAt,
      immutableSourceChecksum: expectedChecksums.immutableSourceChecksum,
      foundationInvariantChecksum: expectedChecksums.foundationInvariantChecksum,
      planChecksum: expectedChecksums.planChecksum,
      batches: preflight.batches,
      operations: preflight.operations,
      orphanedCredentialPaths: projection.orphanedCredentialPaths,
    })

    manifest = await writeCanonicalManifest(planned)

    return Object.freeze({
      mode: MANIFEST_MODES.DRY_RUN,
      canonicalPath: slot.manifestPath,
      manifest,
      preflight,
      reconciliationSummary,
      writesApplied: 0,
    })
  } else if (manifest.runState === MANIFEST_RUN_STATES.PLANNED && !manifest.writePhaseStarted) {
    const rawSource = await readLegacySources({ firestore, pageSize })
    foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })
    validateRawCredentials(rawSource.studentCredentials)
    source = rawSource
    projection = buildMigrationProjection({
      classroomId: foundation.classroomId,
      ...source,
    })
    const preflight = await buildPreflightOrFail({
      firestore,
      foundation,
      projection,
    })
    observedChecksums = calculateChecksums(
      source,
      foundation,
      preflight.planChecksum,
      projection,
    )
    assertRetainedPlannedManifest(
      manifest,
      foundation,
      preflight,
      observedChecksums,
    )

    const reconciliationSummary = reconcileDryRun({
      source,
      foundation,
      projection,
      expectedChecksums: expectedChecksumsFromManifest(manifest),
      observedChecksums,
    })

    if (!write) {
      return Object.freeze({
        mode: MANIFEST_MODES.DRY_RUN,
        canonicalPath: slot.manifestPath,
        manifest,
        preflight,
        reconciliationSummary,
        writesApplied: 0,
      })
    }
  } else if (manifest.writePhaseStarted && [
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.VERIFYING,
    MANIFEST_RUN_STATES.FAILED,
    MANIFEST_RUN_STATES.INDETERMINATE,
  ].includes(manifest.runState)) {
    recoveringWriteStartedManifest = true
    const rawSource = await readLegacySources({ firestore, pageSize })
    foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })
    source = normalizeRetainedSourceForProjection(rawSource)
    projection = buildMigrationProjection({
      classroomId: foundation.classroomId,
      ...source,
    })
    observedChecksums = calculateChecksums(
      source,
      foundation,
      manifest.planChecksum,
      projection,
    )
    assertManifestChecksums(
      manifest,
      foundation,
      observedChecksums,
      { includeCredentials: false },
    )

    manifest = await recoverBatches({ firestore, manifest, clock })
    assertRetainedProjection(manifest, projection)
    assertManifestChecksums(manifest, foundation, observedChecksums)
  } else if (manifest.runState === MANIFEST_RUN_STATES.COMPLETED) {
    const rawSource = await readLegacySources({ firestore, pageSize })
    foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })
    source = normalizeRetainedSourceForProjection(rawSource)
    projection = buildMigrationProjection({
      classroomId: foundation.classroomId,
      ...source,
    })
    observedChecksums = calculateChecksums(
      source,
      foundation,
      manifest.planChecksum,
      projection,
    )
    assertRetainedProjection(manifest, projection)
    const expectedChecksums = assertManifestChecksums(
      manifest,
      foundation,
      observedChecksums,
    )

    const actual = await readActualFirestoreState(firestore, foundation, projection)

    const reconciliationSummary = reconcileWriteRun({
      source,
      foundation,
      projection,
      expectedChecksums,
      observedChecksums,
      actual,
    })

    return Object.freeze({
      mode: write ? MANIFEST_MODES.WRITE : MANIFEST_MODES.DRY_RUN,
      canonicalPath: slot.manifestPath,
      manifest,
      reconciliationSummary,
      writesApplied: 0,
      reverified: true,
    })
  } else {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT,
      'The retained manifest lifecycle cannot be safely continued.',
    )
  }

  if (recoveringWriteStartedManifest) {
    const pendingRecoveryWrites = manifest.operations.some(operation =>
      operation.state === MANIFEST_OPERATION_STATES.PLANNED)

    if (!write && pendingRecoveryWrites) {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INDETERMINATE_RECOVERY_REQUIRED,
        'Restart recovery found operations that require --write to retry safely.',
        { canonicalPath: slot.manifestPath },
      )
    }
  }

  if (write) {
    const rawSource = await readLegacySources({ firestore, pageSize })
    foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })

    if (recoveringWriteStartedManifest) {
      source = normalizeRetainedSourceForProjection(rawSource)
      projection = buildMigrationProjection({
        classroomId: foundation.classroomId,
        ...source,
      })
      observedChecksums = calculateChecksums(
        source,
        foundation,
        manifest.planChecksum,
        projection,
      )
      assertManifestChecksums(
        manifest,
        foundation,
        observedChecksums,
        { includeCredentials: false },
      )
      manifest = await recoverBatches({ firestore, manifest, clock })
      assertRetainedProjection(manifest, projection)
      assertManifestChecksums(manifest, foundation, observedChecksums)
    } else {
      validateRawCredentials(rawSource.studentCredentials)
      source = rawSource
      projection = buildMigrationProjection({
        classroomId: foundation.classroomId,
        ...source,
      })
      const preflight = await buildPreflightOrFail({
        firestore,
        foundation,
        projection,
      })
      observedChecksums = calculateChecksums(
        source,
        foundation,
        preflight.planChecksum,
        projection,
      )
      assertRetainedPlannedManifest(
        manifest,
        foundation,
        preflight,
        observedChecksums,
      )
    }
  }

  const writesToApply = manifest.operations.filter(operation =>
    operation.state === MANIFEST_OPERATION_STATES.PLANNED).length

  if (write && (
    manifest.runState === MANIFEST_RUN_STATES.PLANNED ||
    manifest.runState === MANIFEST_RUN_STATES.WRITING ||
    writesToApply > 0
  )) {
    try {
      manifest = await writeMigrationBatches({
        firestore,
        manifest,
        projection,
        persistManifest: writeCanonicalManifest,
        clock,
      })
    } catch (error) {
      const indeterminateCategories = new Set([
        BATCH_WRITER_ERROR_CATEGORIES.COMMIT_INDETERMINATE,
        BATCH_WRITER_ERROR_CATEGORIES.MANIFEST_PERSISTENCE_INDETERMINATE,
        BATCH_WRITER_ERROR_CATEGORIES.VERIFICATION_INDETERMINATE,
      ])

      if (error instanceof BatchWriterError &&
          indeterminateCategories.has(error.category)) {
        fail(
          MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INDETERMINATE_RECOVERY_REQUIRED,
          'A migration write outcome is uncertain; restart recovery is required.',
          { batchId: error.details?.batchId },
        )
      }

      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.WRITE_FAILED,
        'Migration batch execution failed clearly; the retained manifest must be recovered before retrying.',
        {},
        error,
      )
    }
  }

  if (manifest.runState !== MANIFEST_RUN_STATES.VERIFYING) {
    manifest = transitionManifest(manifest, {
      type: MANIFEST_TRANSITIONS.START_VERIFICATION,
      updatedAt: getNextTimestamp(manifest, clock),
    })
    try {
      manifest = await writeCanonicalManifest(manifest)
    } catch {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INDETERMINATE_RECOVERY_REQUIRED,
        'Post-write verification state could not be durably persisted; restart recovery is required.',
      )
    }
  }

  let actual
  try {
    actual = await readActualFirestoreState(firestore, foundation, projection)
  } catch {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INDETERMINATE_RECOVERY_REQUIRED,
      'Post-write Firestore state could not be read safely; restart recovery is required.',
    )
  }

  let reconciliationSummary
  try {
    reconciliationSummary = reconcileWriteRun({
      source,
      foundation,
      projection,
      expectedChecksums: expectedChecksumsFromManifest(manifest),
      observedChecksums,
      actual,
    })
  } catch (error) {
    const failedManifest = transitionManifest(manifest, {
      type: MANIFEST_TRANSITIONS.FAIL,
      updatedAt: getNextTimestamp(manifest, clock),
    })
    try {
      await writeCanonicalManifest(failedManifest)
    } catch {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INDETERMINATE_RECOVERY_REQUIRED,
        'Reconciliation failed and its retained manifest state could not be durably persisted; restart recovery is required.',
      )
    }

    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.RECONCILIATION_FAILED,
      `Write-run reconciliation failed: ${error.message}`,
      { error },
      error,
    )
  }

  manifest = transitionManifest(manifest, {
    type: MANIFEST_TRANSITIONS.COMPLETE,
    reconciliationSummary,
    updatedAt: getNextTimestamp(manifest, clock),
  })
  try {
    manifest = await writeCanonicalManifest(manifest)
  } catch {
    fail(
      MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INDETERMINATE_RECOVERY_REQUIRED,
      'Completion could not be durably persisted; restart recovery is required.',
    )
  }

  return Object.freeze({
    mode: write ? MANIFEST_MODES.WRITE : MANIFEST_MODES.DRY_RUN,
    canonicalPath: slot.manifestPath,
    manifest,
    reconciliationSummary,
    writesApplied: write ? writesToApply : 0,
  })
}
