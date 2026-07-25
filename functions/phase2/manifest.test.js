import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { Timestamp } from 'firebase-admin/firestore'

import {
  decodeCanonicalFirestoreValue,
  encodeCanonicalFirestoreValue,
  serializeCanonicalState,
} from './canonicalState.js'
import {
  createPlannedManifest,
  MANIFEST_BATCH_STATES,
  MANIFEST_ERROR_CATEGORIES,
  ManifestError,
  MANIFEST_MODES,
  MANIFEST_OPERATION_STATES,
  MANIFEST_OPERATION_TYPES,
  MANIFEST_RUN_STATES,
  MANIFEST_TRANSITIONS,
  listRecoveryBatchIds,
  readCanonicalManifest,
  transitionManifest,
  validateManifest,
  writeCanonicalManifest,
} from './manifest.js'
import {
  deriveCanonicalManifestSlot,
  MANIFEST_SCHEMA_VERSION,
  PHASE2A_MIGRATION_ID,
} from './manifestSlot.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const HASH_E = 'e'.repeat(64)
const HASH_F = 'f'.repeat(64)
const STARTED_AT = '2026-07-24T12:00:00.000Z'

function timestamp(seconds, nanoseconds = 0) {
  return encodeCanonicalFirestoreValue(new Timestamp(seconds, nanoseconds))
}

function time(second) {
  return `2026-07-24T12:00:${String(second).padStart(2, '0')}.000Z`
}

function identity(label = 'manifest') {
  const unique = `${process.pid}-${randomUUID()}`
  return {
    emulatorProjectId: `phase2a-${label}-${unique}`,
    teacherUid: `teacher-${unique}`,
  }
}

function plannedOptions(overrides = {}) {
  const emulatorProjectId = overrides.emulatorProjectId ??
    'phase2a-manifest-test'
  const teacherUid = overrides.teacherUid ?? 'teacher-1'
  const classroomId = overrides.classroomId ?? 'classroom-1'
  const runId = overrides.runId ?? 'run-1'
  const createdAt = overrides.createdAt ?? STARTED_AT

  return {
    runId,
    emulatorProjectId,
    teacherUid,
    classroomId,
    createdAt,
    immutableSourceChecksum: overrides.immutableSourceChecksum ?? HASH_A,
    foundationInvariantChecksum:
      overrides.foundationInvariantChecksum ?? HASH_B,
    planChecksum: overrides.planChecksum ?? HASH_C,
    batches: [
      {
        batchId: 'batch-1',
        operationIds: ['create-student', 'update-classroom'],
      },
      {
        batchId: 'batch-2',
        operationIds: ['create-auth-log', 'update-credential'],
      },
      {
        batchId: 'batch-3',
        operationIds: ['existing-login-history'],
      },
    ],
    operations: [
      {
        operationId: 'create-student',
        type: MANIFEST_OPERATION_TYPES.CREATE,
        path: `classrooms/${classroomId}/students/student-1`,
        expectedBeforeHash: 'absent',
        expectedAfterHash: HASH_D,
        rollbackPreimage: null,
        updateTimePrecondition: null,
        state: MANIFEST_OPERATION_STATES.PLANNED,
        batchId: 'batch-1',
      },
      {
        operationId: 'update-classroom',
        type: MANIFEST_OPERATION_TYPES.CLASSROOM_FIELD_UPDATE,
        path: `classrooms/${classroomId}`,
        expectedBeforeHash: HASH_D,
        expectedAfterHash: HASH_E,
        rollbackPreimage: {
          settings: encodeCanonicalFirestoreValue({ theme: 'blue' }),
          lastBackupAt: {
            present: false,
            value: null,
          },
        },
        updateTimePrecondition: timestamp(100, 123456789),
        state: MANIFEST_OPERATION_STATES.PLANNED,
        batchId: 'batch-1',
      },
      {
        operationId: 'create-auth-log',
        type: MANIFEST_OPERATION_TYPES.CREATE,
        path: `studentAuthLogs/${classroomId}/logs/log-1`,
        expectedBeforeHash: 'absent',
        expectedAfterHash: HASH_E,
        rollbackPreimage: null,
        updateTimePrecondition: null,
        state: MANIFEST_OPERATION_STATES.PLANNED,
        batchId: 'batch-2',
      },
      {
        operationId: 'update-credential',
        type: MANIFEST_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE,
        path: 'studentCredentials/login-1',
        expectedBeforeHash: HASH_E,
        expectedAfterHash: HASH_F,
        rollbackPreimage: {
          path: 'studentCredentials/login-1',
          oldClassroomId: 'morgan',
          newClassroomId: classroomId,
          invariantHash: HASH_A,
        },
        updateTimePrecondition: timestamp(-1, 999999999),
        state: MANIFEST_OPERATION_STATES.PLANNED,
        batchId: 'batch-2',
      },
      {
        operationId: 'existing-login-history',
        type: MANIFEST_OPERATION_TYPES.CREATE,
        path: `classrooms/${classroomId}/loginHistory/history-1`,
        expectedBeforeHash: 'absent',
        expectedAfterHash: HASH_A,
        rollbackPreimage: null,
        updateTimePrecondition: null,
        state: MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL,
        batchId: 'batch-3',
      },
    ],
    orphanedCredentialPaths: ['studentCredentials/orphan-1'],
  }
}

function createManifest(overrides = {}) {
  return createPlannedManifest(plannedOptions(overrides))
}

function mutable(value) {
  return JSON.parse(serializeCanonicalState(value))
}

function action(type, second, extra = {}) {
  return {
    type,
    updatedAt: time(second),
    ...extra,
  }
}

function passingReconciliationSummary() {
  return {
    mode: MANIFEST_MODES.WRITE,
    passed: true,
    counts: {
      students: 1,
      transactions: 0,
      loginHistory: 1,
      studentCredentials: 1,
      studentAuthLogs: 1,
      orphanedCredentials: 1,
    },
    equality: {
      foundation: true,
      classroomMetadata: true,
      students: true,
      transactions: true,
      loginHistory: true,
      studentCredentials: true,
      studentAuthLogs: true,
      originalSources: true,
      checksums: true,
    },
  }
}

function advanceBatch(manifest, batchId, second) {
  let next = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_BATCH, second, { batchId }),
  )
  next = transitionManifest(
    next,
    action(MANIFEST_TRANSITIONS.COMMIT_BATCH, second + 1, { batchId }),
  )
  return transitionManifest(
    next,
    action(MANIFEST_TRANSITIONS.VERIFY_BATCH, second + 2, { batchId }),
  )
}

async function cleanupIdentity(testIdentity) {
  const slot = deriveCanonicalManifestSlot(testIdentity)
  let entries = []

  try {
    entries = await readdir(slot.stateDirectory)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  const ownedNames = entries.filter(name =>
    name === slot.filename || name.startsWith(`${slot.filename}.`),
  )
  await Promise.all(ownedNames.map(name =>
    rm(path.join(slot.stateDirectory, name), { force: true }),
  ))
}

test('creates the exact frozen version-1 planned manifest shape', () => {
  const manifest = createManifest()

  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION)
  assert.equal(manifest.migrationId, PHASE2A_MIGRATION_ID)
  assert.equal(manifest.mode, MANIFEST_MODES.DRY_RUN)
  assert.equal(manifest.runState, MANIFEST_RUN_STATES.PLANNED)
  assert.equal(manifest.writePhaseStarted, false)
  assert.equal(manifest.inFlightBatchId, null)
  assert.deepEqual(
    manifest.batches.map(batch => batch.state),
    [
      MANIFEST_BATCH_STATES.PENDING,
      MANIFEST_BATCH_STATES.PENDING,
      MANIFEST_BATCH_STATES.VERIFIED,
    ],
  )
  assert.equal(Object.isFrozen(manifest), true)
  assert.equal(Object.isFrozen(manifest.operations[1].rollbackPreimage), true)
  assert.throws(() => {
    manifest.writePhaseStarted = true
  }, TypeError)
  assert.doesNotMatch(serializeCanonicalState(manifest), /pinHash|"pin"|token/)
})

test('strict validation blocks schema drift, identity mismatch, and secret preimages', () => {
  const manifest = createManifest()
  const extraField = mutable(manifest)
  extraField.unexpected = true
  assert.throws(
    () => validateManifest(extraField),
    error => error instanceof ManifestError &&
      error.category === MANIFEST_ERROR_CATEGORIES.INVALID_MANIFEST,
  )

  const wrongVersion = mutable(manifest)
  wrongVersion.schemaVersion = 2
  assert.throws(() => validateManifest(wrongVersion), /fixed identity/)

  const legacyClassroom = mutable(manifest)
  legacyClassroom.classroomId = 'morgan'
  assert.throws(() => validateManifest(legacyClassroom), /legacy classroom ID/)

  assert.throws(
    () => validateManifest(manifest, {
      emulatorProjectId: 'another-project',
      teacherUid: manifest.teacherUid,
    }),
    /canonical slot/,
  )

  const secretPreimage = mutable(manifest)
  secretPreimage.operations[3].rollbackPreimage.pinHash = 'must-not-persist'
  assert.throws(() => validateManifest(secretPreimage), /unexpected field set/)

  const scalarSettings = mutable(manifest)
  scalarSettings.operations[1].rollbackPreimage.settings =
    encodeCanonicalFirestoreValue('not-a-settings-map')
  assert.throws(
    () => validateManifest(scalarSettings),
    /rollbackPreimage\.settings must encode a map/,
  )

  const rawTimestamp = mutable(manifest)
  rawTimestamp.operations[1].updateTimePrecondition =
    new Timestamp(1, 2)
  assert.throws(
    () => validateManifest(rawTimestamp),
    /strict canonical JSON values/,
  )

  const reordered = mutable(manifest)
  reordered.batches[0].operationIds.reverse()
  assert.throws(() => validateManifest(reordered), /plan order/)

  const rejectedDocumentId = 'private-value/with-slash'
  assert.throws(
    () => createManifest({ teacherUid: rejectedDocumentId }),
    error => error instanceof ManifestError &&
      !JSON.stringify(error.details).includes(rejectedDocumentId) &&
      error.details.documentIdRejection.category === 'contains-slash',
  )
})

test('normal lifecycle durably models write, batch, reconciliation, and completion', () => {
  let manifest = createManifest()
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )

  assert.equal(manifest.mode, MANIFEST_MODES.WRITE)
  assert.equal(manifest.runState, MANIFEST_RUN_STATES.WRITING)
  assert.equal(manifest.writePhaseStarted, true)

  manifest = advanceBatch(manifest, 'batch-1', 2)
  assert.equal(manifest.batches[0].state, MANIFEST_BATCH_STATES.VERIFIED)
  assert.equal(manifest.inFlightBatchId, null)

  manifest = advanceBatch(manifest, 'batch-2', 5)
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_VERIFICATION, 8),
  )
  assert.equal(manifest.runState, MANIFEST_RUN_STATES.VERIFYING)

  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.COMPLETE, 9, {
      reconciliationSummary: passingReconciliationSummary(),
    }),
  )
  assert.equal(manifest.runState, MANIFEST_RUN_STATES.COMPLETED)
  assert.equal(manifest.writePhaseStarted, true)
  assert.deepEqual(
    manifest.reconciliationSummary,
    passingReconciliationSummary(),
  )
  assert.throws(
    () => transitionManifest(
      manifest,
      action(MANIFEST_TRANSITIONS.FAIL, 10),
    ),
    /not allowed from runState completed/,
  )
})

test('state machine blocks skipped durability boundaries and out-of-order batches', () => {
  const planned = createManifest()

  assert.throws(
    () => transitionManifest(
      planned,
      action(MANIFEST_TRANSITIONS.START_BATCH, 1, { batchId: 'batch-1' }),
    ),
    /not allowed from runState planned/,
  )

  const writing = transitionManifest(
    planned,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )
  assert.throws(
    () => transitionManifest(
      writing,
      action(MANIFEST_TRANSITIONS.START_BATCH, 2, { batchId: 'batch-2' }),
    ),
    /manifest order/,
  )
  assert.throws(
    () => transitionManifest(
      writing,
      action(MANIFEST_TRANSITIONS.START_VERIFICATION, 2),
    ),
    /every batch is verified/,
  )
  assert.throws(
    () => transitionManifest(
      writing,
      action(MANIFEST_TRANSITIONS.FAIL, 1),
    ),
    /must advance monotonically/,
  )
})

test('clear batch failure is recorded and remains recoverable from actual state', () => {
  let manifest = createManifest()
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_BATCH, 2, { batchId: 'batch-1' }),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.FAIL_BATCH, 3, {
      batchId: 'batch-1',
      error: { code: 'COMMIT_REJECTED', message: 'Batch commit was rejected.' },
    }),
  )

  assert.equal(manifest.runState, MANIFEST_RUN_STATES.FAILED)
  assert.equal(manifest.batches[0].state, MANIFEST_BATCH_STATES.FAILED)
  assert.equal(manifest.inFlightBatchId, 'batch-1')
  assert.equal(manifest.operations[0].state, MANIFEST_OPERATION_STATES.FAILED)

  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.RECOVER_BATCH_BEFORE, 4, {
      batchId: 'batch-1',
      freshUpdateTimePreconditions: {
        'update-classroom': timestamp(150, 1),
      },
    }),
  )
  assert.equal(manifest.runState, MANIFEST_RUN_STATES.WRITING)
  assert.equal(manifest.batches[0].state, MANIFEST_BATCH_STATES.PENDING)
  assert.equal(manifest.inFlightBatchId, null)
})

test('state transitions and persistence reject caller-forged manifest objects', async () => {
  const forged = validateManifest(mutable(createManifest()))

  assert.throws(
    () => transitionManifest(
      forged,
      action(MANIFEST_TRANSITIONS.START_WRITE, 1),
    ),
    /created or read by this module/,
  )
  await assert.rejects(
    writeCanonicalManifest(forged),
    error => error instanceof ManifestError &&
      error.category === MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
  )
})

test('indeterminate after-state recovery verifies actual results without retrying', () => {
  let manifest = createManifest()
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_BATCH, 2, { batchId: 'batch-1' }),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.MARK_INDETERMINATE, 3, {
      batchId: 'batch-1',
      error: { code: 'COMMIT_OUTCOME_UNKNOWN', message: 'Commit outcome unknown.' },
    }),
  )

  assert.equal(manifest.runState, MANIFEST_RUN_STATES.INDETERMINATE)
  assert.equal(manifest.batches[0].state, MANIFEST_BATCH_STATES.INDETERMINATE)
  assert.equal(manifest.writePhaseStarted, true)

  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.RECOVER_BATCH_AFTER, 4, {
      batchId: 'batch-1',
    }),
  )
  assert.equal(manifest.runState, MANIFEST_RUN_STATES.WRITING)
  assert.equal(manifest.batches[0].state, MANIFEST_BATCH_STATES.VERIFIED)
  assert.equal(manifest.inFlightBatchId, null)
  assert.equal(manifest.writePhaseStarted, true)
  assert.equal(
    manifest.operations[0].state,
    MANIFEST_OPERATION_STATES.VERIFIED,
  )
})

test('recovery selection includes every unverified batch in manifest order', () => {
  let manifest = createManifest()
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_BATCH, 2, { batchId: 'batch-1' }),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.COMMIT_BATCH, 3, { batchId: 'batch-1' }),
  )

  assert.deepEqual(
    listRecoveryBatchIds(manifest),
    ['batch-1', 'batch-2'],
  )

  const zeroWriteFailure = transitionManifest(
    createManifest(),
    action(MANIFEST_TRANSITIONS.FAIL, 1),
  )
  assert.throws(
    () => listRecoveryBatchIds(zeroWriteFailure),
    /not allowed from runState failed|requires writePhaseStarted/,
  )
})

test('failed post-write reconciliation can re-enter read-only verification', () => {
  let manifest = createManifest()
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )
  manifest = advanceBatch(manifest, 'batch-1', 2)
  manifest = advanceBatch(manifest, 'batch-2', 5)
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.FAIL, 8),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_VERIFICATION, 9),
  )

  assert.equal(manifest.runState, MANIFEST_RUN_STATES.VERIFYING)
  assert.equal(manifest.writePhaseStarted, true)
  assert.deepEqual(listRecoveryBatchIds(manifest), [])
})

test('before-state recovery resets safely and refreshes exact update preconditions', () => {
  let manifest = createManifest()
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_BATCH, 2, { batchId: 'batch-1' }),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.MARK_INDETERMINATE, 3, {
      batchId: 'batch-1',
      error: { code: 'TIMEOUT', message: 'Commit response timed out.' },
    }),
  )
  const freshTimestamp = timestamp(200, 987654321)
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.RECOVER_BATCH_BEFORE, 4, {
      batchId: 'batch-1',
      freshUpdateTimePreconditions: {
        'update-classroom': freshTimestamp,
      },
    }),
  )

  assert.equal(manifest.batches[0].state, MANIFEST_BATCH_STATES.PENDING)
  assert.deepEqual(
    manifest.operations[1].updateTimePrecondition,
    freshTimestamp,
  )
  assert.equal(
    decodeCanonicalFirestoreValue(
      manifest.operations[1].updateTimePrecondition,
    ).isEqual(new Timestamp(200, 987654321)),
    true,
  )
  assert.equal(manifest.operations[1].error, undefined)
  assert.equal(manifest.writePhaseStarted, true)
})

test('mixed recovery verifies after-state operations and retries only before-state ones', () => {
  let manifest = createManifest()
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_BATCH, 2, { batchId: 'batch-1' }),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.MARK_INDETERMINATE, 3, {
      batchId: 'batch-1',
      error: { code: 'PROCESS_EXITED', message: 'Process exited during commit.' },
    }),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.RECOVER_BATCH_MIXED, 4, {
      batchId: 'batch-1',
      beforeOperationIds: ['update-classroom'],
      afterOperationIds: ['create-student'],
      freshUpdateTimePreconditions: {
        'update-classroom': timestamp(300, 444444444),
      },
    }),
  )

  assert.equal(
    manifest.operations[0].state,
    MANIFEST_OPERATION_STATES.VERIFIED,
  )
  assert.equal(
    manifest.operations[1].state,
    MANIFEST_OPERATION_STATES.PLANNED,
  )
  assert.equal(manifest.batches[0].state, MANIFEST_BATCH_STATES.PENDING)

  assert.throws(
    () => transitionManifest(
      manifest,
      action(MANIFEST_TRANSITIONS.RECOVER_BATCH_MIXED, 5, {
        batchId: 'batch-1',
        beforeOperationIds: ['create-student'],
        afterOperationIds: ['update-classroom'],
        freshUpdateTimePreconditions: {},
      }),
    ),
    /terminal operation cannot be reclassified as before-state/,
  )
  assert.throws(
    () => transitionManifest(
      manifest,
      action(MANIFEST_TRANSITIONS.RECOVER_BATCH_BEFORE, 5, {
        batchId: 'batch-1',
        freshUpdateTimePreconditions: {
          'update-classroom': timestamp(301, 555555555),
        },
      }),
    ),
    /terminal operations cannot be wholly before-state/,
  )
  assert.throws(
    () => transitionManifest(
      manifest,
      action(MANIFEST_TRANSITIONS.RECOVER_BATCH_DIVERGENT, 5, {
        batchId: 'batch-1',
        operationIds: ['create-student'],
        error: {
          code: 'DIVERGENT_STATE',
          message: 'Verified destination changed unexpectedly.',
        },
      }),
    ),
    /terminal operation cannot be reclassified as divergent/,
  )

  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_BATCH, 6, { batchId: 'batch-1' }),
  )
  assert.equal(
    manifest.operations[0].state,
    MANIFEST_OPERATION_STATES.VERIFIED,
  )
  assert.equal(
    manifest.operations[1].state,
    MANIFEST_OPERATION_STATES.IN_FLIGHT,
  )
})

test('divergent recovery blocks the batch and every later batch', () => {
  let manifest = createManifest()
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_BATCH, 2, { batchId: 'batch-1' }),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.MARK_INDETERMINATE, 3, {
      batchId: 'batch-1',
      error: { code: 'TIMEOUT', message: 'Commit response timed out.' },
    }),
  )
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.RECOVER_BATCH_DIVERGENT, 4, {
      batchId: 'batch-1',
      operationIds: ['update-classroom'],
      error: { code: 'DIVERGENT_STATE', message: 'Document matches neither state.' },
    }),
  )

  assert.equal(manifest.runState, MANIFEST_RUN_STATES.FAILED)
  assert.equal(manifest.batches[0].state, MANIFEST_BATCH_STATES.FAILED)
  assert.deepEqual(manifest.operations[1].error, {
    code: 'DIVERGENT_STATE',
    message: 'Document matches neither state.',
  })
  assert.throws(
    () => transitionManifest(
      manifest,
      action(MANIFEST_TRANSITIONS.RECOVER_BATCH_AFTER, 5, {
        batchId: 'batch-2',
      }),
    ),
    /manifest order/,
  )
})

test('recovery never reclassifies a skipped-identical operation', () => {
  const options = plannedOptions()
  options.operations[0].state = MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL
  let manifest = createPlannedManifest(options)
  manifest = transitionManifest(
    manifest,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )

  assert.throws(
    () => transitionManifest(
      manifest,
      action(MANIFEST_TRANSITIONS.RECOVER_BATCH_DIVERGENT, 2, {
        batchId: 'batch-1',
        operationIds: ['create-student'],
        error: {
          code: 'DIVERGENT_STATE',
          message: 'Skipped destination changed unexpectedly.',
        },
      }),
    ),
    /terminal operation cannot be reclassified as divergent/,
  )
})

test('canonical durability round-trips exact Timestamp preconditions', async t => {
  const testIdentity = identity('round-trip')
  t.after(() => cleanupIdentity(testIdentity))
  const manifest = createManifest(testIdentity)
  const slot = deriveCanonicalManifestSlot(testIdentity)

  assert.equal(await readCanonicalManifest(testIdentity), null)
  await writeCanonicalManifest(manifest)

  const serialized = await readFile(slot.manifestPath, 'utf8')
  const fileStats = await stat(slot.manifestPath)
  const restarted = await readCanonicalManifest(testIdentity)
  const originalTimestamp = decodeCanonicalFirestoreValue(
    manifest.operations[1].updateTimePrecondition,
  )
  const restartedTimestamp = decodeCanonicalFirestoreValue(
    restarted.operations[1].updateTimePrecondition,
  )

  assert.equal(serialized, serializeCanonicalState(manifest))
  assert.equal(fileStats.mode & 0o777, 0o600)
  assert.equal(restartedTimestamp instanceof Timestamp, true)
  assert.equal(restartedTimestamp.isEqual(originalTimestamp), true)
})

test('simulated crash before rename retains the last durable lifecycle state', async t => {
  const testIdentity = identity('crash')
  t.after(() => cleanupIdentity(testIdentity))
  const planned = createManifest(testIdentity)
  const started = transitionManifest(
    planned,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )
  const slot = deriveCanonicalManifestSlot(testIdentity)
  const interruptedPath = path.join(
    slot.stateDirectory,
    `${slot.filename}.simulated-crash.tmp`,
  )

  await writeCanonicalManifest(planned)
  const interruptedHandle = await open(interruptedPath, 'wx', 0o600)
  await interruptedHandle.writeFile(serializeCanonicalState(started), 'utf8')
  await interruptedHandle.sync()
  await interruptedHandle.close()

  const afterCrash = await readCanonicalManifest(testIdentity)
  assert.equal(afterCrash.runState, MANIFEST_RUN_STATES.PLANNED)
  assert.equal(afterCrash.writePhaseStarted, false)

  await writeCanonicalManifest(started)
  const afterRestart = await readCanonicalManifest(testIdentity)
  assert.equal(afterRestart.runState, MANIFEST_RUN_STATES.WRITING)
  assert.equal(afterRestart.writePhaseStarted, true)
})

test('durability rejects skipped dry runs and stale concurrent transitions', async t => {
  const testIdentity = identity('stale-transition')
  t.after(() => cleanupIdentity(testIdentity))
  const planned = createManifest(testIdentity)
  const firstStart = transitionManifest(
    planned,
    action(MANIFEST_TRANSITIONS.START_WRITE, 1),
  )

  await assert.rejects(
    writeCanonicalManifest(firstStart),
    /changed after this transition was derived/,
  )

  await writeCanonicalManifest(planned)
  const staleStart = transitionManifest(
    planned,
    action(MANIFEST_TRANSITIONS.START_WRITE, 2),
  )
  await writeCanonicalManifest(firstStart)

  await assert.rejects(
    writeCanonicalManifest(staleStart),
    error => error instanceof ManifestError &&
      error.category === MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
  )
  const retained = await readCanonicalManifest(testIdentity)
  assert.equal(retained.updatedAt, time(1))
  assert.equal(retained.writePhaseStarted, true)
})

test('only zero-write failed state permits same-slot replacement with a new run', async t => {
  const testIdentity = identity('replacement')
  t.after(() => cleanupIdentity(testIdentity))
  const first = createManifest(testIdentity)
  await writeCanonicalManifest(first)
  const failed = transitionManifest(
    first,
    action(MANIFEST_TRANSITIONS.FAIL, 1),
  )
  await writeCanonicalManifest(failed)

  const replacement = createManifest({
    ...testIdentity,
    runId: 'replacement-run',
    createdAt: time(2),
    immutableSourceChecksum: HASH_F,
  })
  await writeCanonicalManifest(replacement)
  assert.equal(
    (await readCanonicalManifest(testIdentity)).runId,
    'replacement-run',
  )

  const blockedReplacement = createManifest({
    ...testIdentity,
    runId: 'blocked-run',
    createdAt: time(3),
  })
  await assert.rejects(
    writeCanonicalManifest(blockedReplacement),
    error => error instanceof ManifestError &&
      error.category === MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
  )

  const started = transitionManifest(
    replacement,
    action(MANIFEST_TRANSITIONS.START_WRITE, 3),
  )
  await writeCanonicalManifest(started)
  await assert.rejects(
    writeCanonicalManifest(blockedReplacement),
    /cannot be replaced by a new run/,
  )
})

test('malformed or noncanonical retained files block reads and replacement', async t => {
  const testIdentity = identity('malformed')
  t.after(() => cleanupIdentity(testIdentity))
  const manifest = createManifest(testIdentity)
  const slot = deriveCanonicalManifestSlot(testIdentity)
  await mkdir(slot.stateDirectory, { recursive: true })
  await writeFile(
    slot.manifestPath,
    JSON.stringify(manifest, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )

  await assert.rejects(
    readCanonicalManifest(testIdentity),
    error => error instanceof ManifestError &&
      error.category === MANIFEST_ERROR_CATEGORIES.READ_FAILED,
  )
  await assert.rejects(
    writeCanonicalManifest(manifest),
    error => error instanceof ManifestError &&
      error.category === MANIFEST_ERROR_CATEGORIES.READ_FAILED,
  )
})

test('manifest runtime has no Firestore data access or migration writes', async () => {
  const source = await readFile(fileURLToPath(
    new URL('./manifest.js', import.meta.url),
  ), 'utf8')

  assert.match(
    source,
    /import \{ Timestamp \} from 'firebase-admin\/firestore'/,
  )
  assert.doesNotMatch(
    source,
    /getFirestore|initializeApp|firebase-functions|\.(collection|doc)\s*\(/,
  )
  assert.doesNotMatch(source, /\.(update|create|delete|batch|commit)\s*\(/)
})
