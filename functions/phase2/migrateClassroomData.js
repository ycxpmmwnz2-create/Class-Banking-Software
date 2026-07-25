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
import { buildDestinationPreflight, DestinationPreflightError } from './destinationPreflight.js'
import { reconcileDryRun, reconcileWriteRun } from './reconciliation.js'
import { writeMigrationBatches } from './batchWriter.js'
import { hashCanonicalState, encodeCanonicalFirestoreValue } from './canonicalState.js'

export const MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES = Object.freeze({
  INVALID_ARGUMENT: 'invalid-argument',
  CREDENTIAL_CLASSROOM_ID_INVALID: 'credential-classroom-id-invalid',
  PREFLIGHT_CONFLICT: 'preflight-conflict',
  STALE_MANIFEST_DRIFT: 'stale-manifest-drift',
  RECOVERY_DIVERGENT: 'recovery-divergent',
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

function validateRawCredentials(studentCredentials, classroomId) {
  for (const credential of studentCredentials) {
    const credClassroomId = credential?.data?.classroomId
    if (credClassroomId !== LEGACY_CLASSROOM_ID && credClassroomId !== classroomId) {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.CREDENTIAL_CLASSROOM_ID_INVALID,
        `Raw credential document ${credential.path} has classroomId "${credClassroomId}", expected "${LEGACY_CLASSROOM_ID}".`,
        { path: credential.path, classroomId: credClassroomId },
      )
    }
  }
}

function normalizeSourceForProjection(source, classroomId) {
  const normalizedCredentials = source.studentCredentials.map(envelope => {
    if (envelope.data?.classroomId === classroomId) {
      return {
        ...envelope,
        data: { ...envelope.data, classroomId: LEGACY_CLASSROOM_ID },
      }
    }
    return envelope
  })
  return {
    ...source,
    studentCredentials: normalizedCredentials,
  }
}

function calculateChecksums(source, foundation, preflight, projection) {
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

  const planChecksum = preflight.planChecksum

  const credentialInvariantHashes = Object.freeze(
    Object.fromEntries(
      projection.studentCredentials.map(cred => {
        const { classroomId, ...invariantData } = cred.data
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

async function recoverBatches({ firestore, manifest, foundation, projection, clock }) {
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
        const hash = hashCanonicalState(encodeCanonicalFirestoreValue(snap.data()))
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
    const updatedAt = getTimestamp(clock)

    if (isDivergent) {
      const divergentOpIds = opStates.filter(item => item.state === 'divergent').map(item => item.op.operationId)
      const failedManifest = transitionManifest(currentManifest, {
        type: MANIFEST_TRANSITIONS.RECOVER_BATCH_DIVERGENT,
        batchId,
        operationIds: divergentOpIds,
        error: { code: 'DIVERGENT_RECOVERY_STATE', message: 'Divergent state detected during recovery.' },
        updatedAt,
      })
      await writeCanonicalManifest(failedManifest)
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
      currentManifest = await writeCanonicalManifest(verifiedManifest)
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
      currentManifest = await writeCanonicalManifest(resetManifest)
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
      currentManifest = await writeCanonicalManifest(mixedManifest)
    }
  }

  return currentManifest
}

export async function migrateClassroomData(options) {
  const { firestore, teacherUid, projectId, write, clock, pageSize } = validateOptions(options)
  const identity = { emulatorProjectId: projectId, teacherUid }

  // Canonical-slot-first derivation and inspection
  const slot = deriveCanonicalManifestSlot(identity)
  let manifest = await readCanonicalManifest(identity)

  if (manifest === null || (manifest.runState === MANIFEST_RUN_STATES.FAILED && !manifest.writePhaseStarted)) {
    // Brand new run OR replacement of failed dry-run manifest (writePhaseStarted === false)
    const rawSource = await readLegacySources({ firestore, pageSize })
    const foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })
    validateRawCredentials(rawSource.studentCredentials, foundation.classroomId)
    const source = normalizeSourceForProjection(rawSource, foundation.classroomId)

    const projection = buildMigrationProjection({ classroomId: foundation.classroomId, ...source })

    let preflight
    try {
      preflight = await buildDestinationPreflight({ firestore, foundation, projection })
    } catch (error) {
      if (error instanceof DestinationPreflightError) {
        fail(
          MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.PREFLIGHT_CONFLICT,
          error.message,
          { error },
          error,
        )
      }
      throw error
    }

    const expectedChecksums = calculateChecksums(source, foundation, preflight, projection)
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
  } else if (manifest.runState === MANIFEST_RUN_STATES.PLANNED && !manifest.writePhaseStarted) {
    // Retained valid planned manifest
    const rawSource = await readLegacySources({ firestore, pageSize })
    const foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })
    validateRawCredentials(rawSource.studentCredentials, foundation.classroomId)
    const source = normalizeSourceForProjection(rawSource, foundation.classroomId)

    const projection = buildMigrationProjection({ classroomId: foundation.classroomId, ...source })

    let preflight
    try {
      preflight = await buildDestinationPreflight({ firestore, foundation, projection })
    } catch (error) {
      if (error instanceof DestinationPreflightError) {
        fail(
          MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.PREFLIGHT_CONFLICT,
          error.message,
          { error },
          error,
        )
      }
      throw error
    }

    const currentChecksums = calculateChecksums(source, foundation, preflight, projection)

    if (
      manifest.classroomId !== foundation.classroomId ||
      manifest.immutableSourceChecksum !== currentChecksums.immutableSourceChecksum ||
      manifest.foundationInvariantChecksum !== currentChecksums.foundationInvariantChecksum ||
      manifest.planChecksum !== currentChecksums.planChecksum
    ) {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT,
        'Retained planned manifest identity, checksum, or plan mismatch with current state.',
        {
          expectedClassroomId: manifest.classroomId,
          actualClassroomId: foundation.classroomId,
          expectedSourceChecksum: manifest.immutableSourceChecksum,
          actualSourceChecksum: currentChecksums.immutableSourceChecksum,
          expectedFoundationChecksum: manifest.foundationInvariantChecksum,
          actualFoundationChecksum: currentChecksums.foundationInvariantChecksum,
          expectedPlanChecksum: manifest.planChecksum,
          actualPlanChecksum: currentChecksums.planChecksum,
        },
      )
    }

    if (!write) {
      const reconciliationSummary = reconcileDryRun({
        source,
        foundation,
        projection,
        expectedChecksums: currentChecksums,
        observedChecksums: currentChecksums,
      })

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
    // Retained write-phase started restart recovery
    const rawSource = await readLegacySources({ firestore, pageSize })
    const foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })
    const source = normalizeSourceForProjection(rawSource, foundation.classroomId)
    const projection = buildMigrationProjection({ classroomId: foundation.classroomId, ...source })
    const preflight = await buildDestinationPreflight({ firestore, foundation, projection })
    const currentChecksums = calculateChecksums(source, foundation, preflight, projection)

    if (
      manifest.immutableSourceChecksum !== currentChecksums.immutableSourceChecksum ||
      manifest.foundationInvariantChecksum !== currentChecksums.foundationInvariantChecksum
    ) {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT,
        'Retained write-started manifest immutable source or foundation invariant checksum mismatch.',
        {
          expectedSourceChecksum: manifest.immutableSourceChecksum,
          actualSourceChecksum: currentChecksums.immutableSourceChecksum,
          expectedFoundationChecksum: manifest.foundationInvariantChecksum,
          actualFoundationChecksum: currentChecksums.foundationInvariantChecksum,
        },
      )
    }

    manifest = await recoverBatches({ firestore, manifest, foundation, projection, clock })
  } else if (manifest.runState === MANIFEST_RUN_STATES.COMPLETED) {
    // Completed manifest is read-only reverification
    const rawSource = await readLegacySources({ firestore, pageSize })
    const foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })
    const source = normalizeSourceForProjection(rawSource, foundation.classroomId)
    const projection = buildMigrationProjection({ classroomId: foundation.classroomId, ...source })
    const preflight = await buildDestinationPreflight({ firestore, foundation, projection })
    const currentChecksums = calculateChecksums(source, foundation, preflight, projection)

    const actual = await readActualFirestoreState(firestore, foundation, projection)

    const reconciliationSummary = reconcileWriteRun({
      source,
      foundation,
      projection,
      expectedChecksums: currentChecksums,
      observedChecksums: currentChecksums,
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
  }

  // Execute write mode if required
  if (write) {
    // Verify source and foundation checksums immediately before first write batch
    const rawSource = await readLegacySources({ firestore, pageSize })
    const foundation = await validateTeacherClassroomFoundation({ firestore, teacherUid })
    const source = normalizeSourceForProjection(rawSource, foundation.classroomId)
    const projection = buildMigrationProjection({ classroomId: foundation.classroomId, ...source })
    const preflight = await buildDestinationPreflight({ firestore, foundation, projection })
    const currentChecksums = calculateChecksums(source, foundation, preflight, projection)

    if (
      manifest.immutableSourceChecksum !== currentChecksums.immutableSourceChecksum ||
      manifest.foundationInvariantChecksum !== currentChecksums.foundationInvariantChecksum
    ) {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT,
        'Checksum mismatch immediately before write execution.',
      )
    }

    // Call batchWriter
    try {
      manifest = await writeMigrationBatches({
        firestore,
        manifest,
        projection,
        persistManifest: writeCanonicalManifest,
        clock,
      })
    } catch (error) {
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.WRITE_FAILED,
        `Write migration batches failed: ${error.message}`,
        {},
        error,
      )
    }

    const updatedAt = getTimestamp(clock)

    // Transition to verification
    manifest = transitionManifest(manifest, {
      type: MANIFEST_TRANSITIONS.START_VERIFICATION,
      updatedAt,
    })
    manifest = await writeCanonicalManifest(manifest)

    // Re-read actual post-write state and run write reconciliation
    const actual = await readActualFirestoreState(firestore, foundation, projection)

    let reconciliationSummary
    try {
      reconciliationSummary = reconcileWriteRun({
        source,
        foundation,
        projection,
        expectedChecksums: currentChecksums,
        observedChecksums: currentChecksums,
        actual,
      })
    } catch (error) {
      const failedManifest = transitionManifest(manifest, {
        type: MANIFEST_TRANSITIONS.RECORD_RECONCILIATION_FAILURE,
        error: { code: 'RECONCILIATION_FAILED', message: error.message },
        updatedAt: getTimestamp(clock),
      })
      await writeCanonicalManifest(failedManifest)
      fail(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.RECONCILIATION_FAILED,
        `Write-run reconciliation failed: ${error.message}`,
        { error },
        error,
      )
    }

    // Transition to completed
    manifest = transitionManifest(manifest, {
      type: MANIFEST_TRANSITIONS.COMPLETE,
      reconciliationSummary,
      updatedAt: getTimestamp(clock),
    })
    manifest = await writeCanonicalManifest(manifest)

    return Object.freeze({
      mode: MANIFEST_MODES.WRITE,
      canonicalPath: slot.manifestPath,
      manifest,
      reconciliationSummary,
      writesApplied: manifest.operations.length,
    })
  }

  return Object.freeze({
    mode: MANIFEST_MODES.DRY_RUN,
    canonicalPath: slot.manifestPath,
    manifest,
    writesApplied: 0,
  })
}
