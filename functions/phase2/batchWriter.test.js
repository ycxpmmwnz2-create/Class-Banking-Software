import assert from 'node:assert/strict'
import test from 'node:test'

import { Timestamp } from 'firebase-admin/firestore'

import {
  BATCH_WRITER_ERROR_CATEGORIES,
  BatchWriterError,
  MAX_BATCH_OPERATIONS,
  MAX_BATCH_PAYLOAD_BYTES,
  isClearlyRejectedCommit,
  writeMigrationBatches,
} from './batchWriter.js'
import {
  decodeCanonicalFirestoreValue,
  encodeCanonicalFirestoreValue,
  hashCanonicalState,
} from './canonicalState.js'
import {
  MANIFEST_BATCH_STATES,
  MANIFEST_OPERATION_STATES,
  MANIFEST_OPERATION_TYPES,
  MANIFEST_RUN_STATES,
  createPlannedManifest,
  listRecoveryBatchIds,
} from './manifest.js'

const CLASSROOM_ID = 'classroom-1'
const SECRET = 'secret-pin-hash-that-must-never-leak'

function timestamp(seconds, nanoseconds = 0) {
  return new Timestamp(seconds, nanoseconds)
}

function cloneFirestoreValue(value) {
  return decodeCanonicalFirestoreValue(
    encodeCanonicalFirestoreValue(value),
  )
}

function firestoreHash(value) {
  return hashCanonicalState(encodeCanonicalFirestoreValue(value))
}

function baseProjection(overrides = {}) {
  return {
    classroomId: CLASSROOM_ID,
    classroom: {
      id: CLASSROOM_ID,
      path: `classrooms/${CLASSROOM_ID}`,
      data: {
        settings: { currencyName: 'Class Cash' },
        lastBackupAt: timestamp(20, 200),
      },
    },
    students: [],
    transactions: [],
    loginHistory: [],
    studentCredentials: [],
    studentAuthLogs: [],
    orphanedCredentialPaths: [],
    ...overrides,
  }
}

function createOperation({
  operationId,
  path,
  data,
  state = MANIFEST_OPERATION_STATES.PLANNED,
}) {
  return {
    operationId,
    type: MANIFEST_OPERATION_TYPES.CREATE,
    path,
    expectedBeforeHash: 'absent',
    expectedAfterHash: firestoreHash(data),
    rollbackPreimage: null,
    updateTimePrecondition: null,
    state,
  }
}

function classroomOperation({ before, after, updateTime }) {
  return {
    operationId: 'operation-classroom',
    type: MANIFEST_OPERATION_TYPES.CLASSROOM_FIELD_UPDATE,
    path: `classrooms/${CLASSROOM_ID}`,
    expectedBeforeHash: firestoreHash(before),
    expectedAfterHash: firestoreHash(after),
    rollbackPreimage: {
      settings: encodeCanonicalFirestoreValue(before.settings),
      lastBackupAt: {
        present: Object.hasOwn(before, 'lastBackupAt'),
        value: Object.hasOwn(before, 'lastBackupAt')
          ? encodeCanonicalFirestoreValue(before.lastBackupAt)
          : null,
      },
    },
    updateTimePrecondition: encodeCanonicalFirestoreValue(updateTime),
    state: MANIFEST_OPERATION_STATES.PLANNED,
  }
}

function credentialOperation({ path, before, after, updateTime }) {
  const invariant = { ...before }
  delete invariant.classroomId

  return {
    operationId: 'operation-credential',
    type: MANIFEST_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE,
    path,
    expectedBeforeHash: firestoreHash(before),
    expectedAfterHash: firestoreHash(after),
    rollbackPreimage: {
      path,
      oldClassroomId: 'morgan',
      newClassroomId: CLASSROOM_ID,
      invariantHash: firestoreHash(invariant),
    },
    updateTimePrecondition: encodeCanonicalFirestoreValue(updateTime),
    state: MANIFEST_OPERATION_STATES.PLANNED,
  }
}

function plannedManifest(operations, groups = operations.map(
  operation => [operation.operationId],
)) {
  const batchByOperationId = new Map()
  const batches = groups.map((operationIds, index) => {
    const batchId = `batch-${String(index + 1).padStart(6, '0')}`
    operationIds.forEach(operationId => {
      batchByOperationId.set(operationId, batchId)
    })
    return { batchId, operationIds }
  })
  const associatedOperations = operations.map(operation => ({
    ...operation,
    batchId: batchByOperationId.get(operation.operationId),
  }))

  return createPlannedManifest({
    runId: 'run-batch-writer-test',
    emulatorProjectId: 'demo-batch-writer-test',
    teacherUid: 'teacher-1',
    classroomId: CLASSROOM_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    immutableSourceChecksum: '1'.repeat(64),
    foundationInvariantChecksum: '2'.repeat(64),
    planChecksum: '3'.repeat(64),
    batches,
    operations: associatedOperations,
    orphanedCredentialPaths: [],
  })
}

function happyScenario() {
  const classroomBefore = {
    settings: { currencyName: 'Points' },
  }
  const classroomAfter = {
    settings: { currencyName: 'Class Cash' },
    lastBackupAt: timestamp(20, 200),
  }
  const classroomUpdateTime = timestamp(100, 111)
  const studentPath = `classrooms/${CLASSROOM_ID}/students/student-1`
  const student = {
    id: 'student-1',
    name: 'Student One',
    balance: 12,
    frozen: false,
    transactions: [],
  }
  const credentialPath = 'studentCredentials/login-1'
  const credentialBefore = {
    classroomId: 'morgan',
    studentId: 'student-1',
    pinHash: SECRET,
    active: true,
  }
  const credentialAfter = {
    ...credentialBefore,
    classroomId: CLASSROOM_ID,
  }
  const credentialUpdateTime = timestamp(101, 222)
  const projection = baseProjection({
    classroom: {
      id: CLASSROOM_ID,
      path: `classrooms/${CLASSROOM_ID}`,
      data: classroomAfter,
    },
    students: [{
      sourceIndex: 0,
      id: 'student-1',
      normalizedId: 'student-1',
      path: studentPath,
      data: student,
    }],
    studentCredentials: [{
      sourceIndex: 0,
      id: 'login-1',
      path: credentialPath,
      data: credentialAfter,
      orphaned: false,
    }],
  })
  const operations = [
    classroomOperation({
      before: classroomBefore,
      after: classroomAfter,
      updateTime: classroomUpdateTime,
    }),
    createOperation({
      operationId: 'operation-student',
      path: studentPath,
      data: student,
    }),
    credentialOperation({
      path: credentialPath,
      before: credentialBefore,
      after: credentialAfter,
      updateTime: credentialUpdateTime,
    }),
  ]

  return {
    projection,
    manifest: plannedManifest(operations),
    initialDocuments: new Map([
      [`classrooms/${CLASSROOM_ID}`, {
        data: {
          ownerUid: 'teacher-1',
          name: 'Period 1',
          ...classroomBefore,
        },
        updateTime: classroomUpdateTime,
      }],
      [credentialPath, {
        data: credentialBefore,
        updateTime: credentialUpdateTime,
      }],
    ]),
    classroomUpdateTime,
    credentialUpdateTime,
    studentPath,
    credentialPath,
  }
}

function fakeFirestore({
  documents = new Map(),
  commitError = null,
  applyBeforeCommitError = false,
  mutateAfterCommit = null,
} = {}) {
  const stored = new Map([...documents].map(([path, entry]) => [path, {
    data: cloneFirestoreValue(entry.data),
    updateTime: entry.updateTime,
  }]))
  const state = {
    batchFactoryCalls: 0,
    commitCalls: 0,
    deleteCalls: 0,
    configuredBatches: [],
    committedBatches: [],
    reads: [],
  }

  function documentReference(path) {
    const reference = {
      path,
      async get() {
        state.reads.push(path)
        const entry = stored.get(path)
        return {
          exists: entry !== undefined,
          data: () => entry === undefined
            ? undefined
            : cloneFirestoreValue(entry.data),
          updateTime: entry?.updateTime,
          ref: reference,
          id: path.slice(path.lastIndexOf('/') + 1),
        }
      },
    }
    return reference
  }

  function applyWrites(writes) {
    for (const write of writes) {
      if (write.method === 'create') {
        if (stored.has(write.path)) {
          const error = new Error('Destination already exists.')
          error.code = 'already-exists'
          throw error
        }
        stored.set(write.path, {
          data: cloneFirestoreValue(write.data),
          updateTime: timestamp(1000 + state.commitCalls),
        })
        continue
      }

      const current = stored.get(write.path)
      if (!current || !current.updateTime.isEqual(
        write.precondition.lastUpdateTime,
      )) {
        const error = new Error('Update-time precondition failed.')
        error.code = 'failed-precondition'
        throw error
      }
      stored.set(write.path, {
        data: {
          ...cloneFirestoreValue(current.data),
          ...cloneFirestoreValue(write.data),
        },
        updateTime: timestamp(1000 + state.commitCalls),
      })
    }
  }

  const firestore = {
    doc: documentReference,
    batch() {
      state.batchFactoryCalls += 1
      const writes = []
      state.configuredBatches.push(writes)

      return {
        create(reference, data) {
          writes.push({
            method: 'create',
            path: reference.path,
            data: cloneFirestoreValue(data),
          })
        },
        update(reference, data, precondition) {
          writes.push({
            method: 'update',
            path: reference.path,
            data: cloneFirestoreValue(data),
            precondition,
          })
        },
        delete() {
          state.deleteCalls += 1
          throw new Error('delete() must never be called')
        },
        async commit() {
          state.commitCalls += 1
          if (commitError !== null) {
            if (applyBeforeCommitError) {
              applyWrites(writes)
            }
            throw commitError
          }

          applyWrites(writes)
          state.committedBatches.push(writes)
          mutateAfterCommit?.({ stored, writes, state })
          return []
        },
      }
    },
  }

  return { firestore, state, stored }
}

function manifestRecorder({ fail = () => false } = {}) {
  const attempts = []
  const persisted = []

  return {
    attempts,
    persisted,
    async persist(candidate) {
      attempts.push(candidate)
      if (fail(candidate, attempts.length)) {
        throw new Error(`Injected manifest failure containing ${SECRET}`)
      }
      persisted.push(candidate)
    },
  }
}

function writerClock() {
  return new Date('2026-02-01T00:00:00.000Z')
}

test('writes deterministic create/update batches with exact preconditions and no deletes', async () => {
  const scenario = happyScenario()
  const database = fakeFirestore({ documents: scenario.initialDocuments })
  const recorder = manifestRecorder()

  const result = await writeMigrationBatches({
    firestore: database.firestore,
    manifest: scenario.manifest,
    projection: scenario.projection,
    persistManifest: recorder.persist,
    clock: writerClock,
  })

  assert.equal(result.runState, MANIFEST_RUN_STATES.WRITING)
  assert.equal(result.writePhaseStarted, true)
  assert.equal(result.inFlightBatchId, null)
  assert.deepEqual(
    result.batches.map(batch => batch.state),
    [
      MANIFEST_BATCH_STATES.VERIFIED,
      MANIFEST_BATCH_STATES.VERIFIED,
      MANIFEST_BATCH_STATES.VERIFIED,
    ],
  )
  assert.deepEqual(
    result.operations.map(operation => operation.state),
    [
      MANIFEST_OPERATION_STATES.VERIFIED,
      MANIFEST_OPERATION_STATES.VERIFIED,
      MANIFEST_OPERATION_STATES.VERIFIED,
    ],
  )

  assert.equal(database.state.commitCalls, 3)
  assert.equal(database.state.deleteCalls, 0)
  assert.deepEqual(
    database.state.committedBatches.map(writes => writes.map(write =>
      write.path)),
    [
      [`classrooms/${CLASSROOM_ID}`],
      [scenario.studentPath],
      [scenario.credentialPath],
    ],
  )

  const classroomWrite = database.state.committedBatches[0][0]
  assert.equal(classroomWrite.method, 'update')
  assert.deepEqual(classroomWrite.data, scenario.projection.classroom.data)
  assert.equal(
    classroomWrite.precondition.lastUpdateTime.isEqual(
      scenario.classroomUpdateTime,
    ),
    true,
  )

  const studentWrite = database.state.committedBatches[1][0]
  assert.equal(studentWrite.method, 'create')
  assert.deepEqual(
    studentWrite.data,
    scenario.projection.students[0].data,
  )

  const credentialWrite = database.state.committedBatches[2][0]
  assert.equal(credentialWrite.method, 'update')
  assert.deepEqual(credentialWrite.data, { classroomId: CLASSROOM_ID })
  assert.equal(
    credentialWrite.precondition.lastUpdateTime.isEqual(
      scenario.credentialUpdateTime,
    ),
    true,
  )
  assert.equal(database.stored.get(scenario.credentialPath).data.pinHash, SECRET)
  assert.equal(
    database.stored.get(scenario.credentialPath).data.classroomId,
    CLASSROOM_ID,
  )

  assert.equal(recorder.persisted.length, 10)
  assert.equal(recorder.persisted[0].writePhaseStarted, true)
  assert.deepEqual(
    recorder.persisted.slice(1).map(manifest =>
      manifest.batches.find(batch => batch.batchId ===
        manifest.inFlightBatchId)?.state ??
      manifest.batches.findLast(batch =>
        batch.state === MANIFEST_BATCH_STATES.VERIFIED)?.state),
    Array(9).fill(undefined).map((_, index) => [
      MANIFEST_BATCH_STATES.IN_FLIGHT,
      MANIFEST_BATCH_STATES.COMMITTED,
      MANIFEST_BATCH_STATES.VERIFIED,
    ][index % 3]),
  )
})

test('create semantics turn an existence race into a clear failed batch', async () => {
  const path = `classrooms/${CLASSROOM_ID}/students/student-race`
  const body = {
    id: 'student-race',
    name: 'Race',
    balance: 0,
    frozen: false,
    transactions: [],
  }
  const projection = baseProjection({
    students: [{ path, data: body }],
  })
  const manifest = plannedManifest([
    createOperation({ operationId: 'operation-race', path, data: body }),
  ])
  const database = fakeFirestore({
    documents: new Map([[path, {
      data: { ...body, balance: 999 },
      updateTime: timestamp(1),
    }]]),
  })
  const recorder = manifestRecorder()

  await assert.rejects(
    writeMigrationBatches({
      firestore: database.firestore,
      manifest,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    }),
    error => error instanceof BatchWriterError &&
      error.category === BATCH_WRITER_ERROR_CATEGORIES.COMMIT_REJECTED,
  )

  const retained = recorder.persisted.at(-1)
  assert.equal(retained.runState, MANIFEST_RUN_STATES.FAILED)
  assert.equal(retained.batches[0].state, MANIFEST_BATCH_STATES.FAILED)
  assert.equal(
    retained.operations[0].error.code,
    'PHASE2A_BATCH_COMMIT_REJECTED',
  )
  assert.equal(database.stored.get(path).data.balance, 999)
  assert.equal(database.state.deleteCalls, 0)
})

test('an exact update-time precondition blocks a concurrent credential change', async () => {
  const scenario = happyScenario()
  const credentialProjection = baseProjection({
    studentCredentials: scenario.projection.studentCredentials,
  })
  const credentialManifest = plannedManifest([
    scenario.manifest.operations.find(operation =>
      operation.type ===
        MANIFEST_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE),
  ])
  const concurrentData = {
    ...scenario.initialDocuments.get(scenario.credentialPath).data,
    failedAttempts: 1,
  }
  const database = fakeFirestore({
    documents: new Map([[scenario.credentialPath, {
      data: concurrentData,
      updateTime: timestamp(999, 999),
    }]]),
  })
  const recorder = manifestRecorder()

  await assert.rejects(
    writeMigrationBatches({
      firestore: database.firestore,
      manifest: credentialManifest,
      projection: credentialProjection,
      persistManifest: recorder.persist,
      clock: writerClock,
    }),
    error => error instanceof BatchWriterError &&
      error.category === BATCH_WRITER_ERROR_CATEGORIES.COMMIT_REJECTED,
  )

  assert.deepEqual(
    database.stored.get(scenario.credentialPath).data,
    concurrentData,
  )
  assert.equal(
    database.stored.get(scenario.credentialPath).data.classroomId,
    'morgan',
  )
  assert.equal(recorder.persisted.at(-1).runState, MANIFEST_RUN_STATES.FAILED)
})

test('an uncertain commit is durably indeterminate and exposes no raw error text', async () => {
  const path = `classrooms/${CLASSROOM_ID}/students/student-timeout`
  const body = {
    id: 'student-timeout',
    name: 'Timeout',
    balance: 1,
    frozen: false,
    transactions: [],
  }
  const projection = baseProjection({ students: [{ path, data: body }] })
  const manifest = plannedManifest([
    createOperation({ operationId: 'operation-timeout', path, data: body }),
  ])
  const commitError = new Error(`Deadline exceeded: ${SECRET}`)
  commitError.code = 'deadline-exceeded'
  const database = fakeFirestore({
    commitError,
    applyBeforeCommitError: true,
  })
  const recorder = manifestRecorder()
  let caught

  try {
    await writeMigrationBatches({
      firestore: database.firestore,
      manifest,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    })
  } catch (error) {
    caught = error
  }

  assert.equal(caught instanceof BatchWriterError, true)
  assert.equal(
    caught.category,
    BATCH_WRITER_ERROR_CATEGORIES.COMMIT_INDETERMINATE,
  )
  const retained = recorder.persisted.at(-1)
  assert.equal(retained.runState, MANIFEST_RUN_STATES.INDETERMINATE)
  assert.equal(
    retained.batches[0].state,
    MANIFEST_BATCH_STATES.INDETERMINATE,
  )
  assert.deepEqual(listRecoveryBatchIds(retained), ['batch-000001'])
  assert.equal(database.stored.has(path), true)
  assert.equal(
    JSON.stringify({ caught, retained }).includes(SECRET),
    false,
  )
})

test('a post-commit manifest failure attempts a durable indeterminate state', async () => {
  const path = `classrooms/${CLASSROOM_ID}/students/student-persist`
  const body = {
    id: 'student-persist',
    name: 'Persist',
    balance: 2,
    frozen: false,
    transactions: [],
  }
  const projection = baseProjection({ students: [{ path, data: body }] })
  const manifest = plannedManifest([
    createOperation({ operationId: 'operation-persist', path, data: body }),
  ])
  let failedCommittedState = false
  const recorder = manifestRecorder({
    fail(candidate) {
      if (!failedCommittedState &&
          candidate.batches[0].state === MANIFEST_BATCH_STATES.COMMITTED) {
        failedCommittedState = true
        return true
      }
      return false
    },
  })
  const database = fakeFirestore()

  await assert.rejects(
    writeMigrationBatches({
      firestore: database.firestore,
      manifest,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    }),
    error => error instanceof BatchWriterError &&
      error.category ===
      BATCH_WRITER_ERROR_CATEGORIES.MANIFEST_PERSISTENCE_INDETERMINATE &&
      error.details.indeterminateStatePersisted === true,
  )

  assert.equal(database.stored.has(path), true)
  assert.equal(
    recorder.persisted.at(-1).runState,
    MANIFEST_RUN_STATES.INDETERMINATE,
  )
  assert.deepEqual(
    listRecoveryBatchIds(recorder.persisted.at(-1)),
    ['batch-000001'],
  )
  assert.equal(
    JSON.stringify(recorder.persisted.at(-1)).includes(SECRET),
    false,
  )
})

test('a post-commit verification mismatch becomes indeterminate', async () => {
  const path = `classrooms/${CLASSROOM_ID}/students/student-diverged`
  const body = {
    id: 'student-diverged',
    name: 'Diverged',
    balance: 3,
    frozen: false,
    transactions: [],
  }
  const projection = baseProjection({ students: [{ path, data: body }] })
  const manifest = plannedManifest([
    createOperation({ operationId: 'operation-diverged', path, data: body }),
  ])
  const database = fakeFirestore({
    mutateAfterCommit({ stored }) {
      const entry = stored.get(path)
      entry.data.balance = 999
    },
  })
  const recorder = manifestRecorder()

  await assert.rejects(
    writeMigrationBatches({
      firestore: database.firestore,
      manifest,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    }),
    error => error instanceof BatchWriterError &&
      error.category ===
      BATCH_WRITER_ERROR_CATEGORIES.VERIFICATION_INDETERMINATE,
  )

  assert.equal(
    recorder.persisted.at(-1).batches[0].state,
    MANIFEST_BATCH_STATES.INDETERMINATE,
  )
})

test('failure to persist writePhaseStarted prevents every Firestore write', async () => {
  const path = `classrooms/${CLASSROOM_ID}/students/student-safe-boundary`
  const body = {
    id: 'student-safe-boundary',
    name: 'Boundary',
    balance: 0,
    frozen: false,
    transactions: [],
  }
  const projection = baseProjection({ students: [{ path, data: body }] })
  const manifest = plannedManifest([
    createOperation({ operationId: 'operation-boundary', path, data: body }),
  ])
  const database = fakeFirestore()
  const recorder = manifestRecorder({ fail: () => true })

  await assert.rejects(
    writeMigrationBatches({
      firestore: database.firestore,
      manifest,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    }),
    error => error instanceof BatchWriterError &&
      error.category ===
      BATCH_WRITER_ERROR_CATEGORIES.MANIFEST_PERSISTENCE_FAILED,
  )

  assert.equal(database.state.batchFactoryCalls, 0)
  assert.equal(database.state.commitCalls, 0)
  assert.equal(database.stored.has(path), false)
})

test('skipped-identical batches enter write mode without constructing a batch', async () => {
  const path = `classrooms/${CLASSROOM_ID}/students/student-complete`
  const body = {
    id: 'student-complete',
    name: 'Complete',
    balance: 4,
    frozen: false,
    transactions: [],
  }
  const projection = baseProjection({ students: [{ path, data: body }] })
  const manifest = plannedManifest([
    createOperation({
      operationId: 'operation-complete',
      path,
      data: body,
      state: MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL,
    }),
  ])
  const database = fakeFirestore({
    documents: new Map([[path, { data: body, updateTime: timestamp(1) }]]),
  })
  const recorder = manifestRecorder()

  const result = await writeMigrationBatches({
    firestore: database.firestore,
    manifest,
    projection,
    persistManifest: recorder.persist,
    clock: writerClock,
  })

  assert.equal(result.writePhaseStarted, true)
  assert.equal(result.batches[0].state, MANIFEST_BATCH_STATES.VERIFIED)
  assert.equal(database.state.batchFactoryCalls, 0)
  assert.equal(database.state.commitCalls, 0)
  assert.equal(recorder.persisted.length, 1)
})

test('more than 400 writes in one retained batch blocks before write mode', async () => {
  const entries = []
  const operations = []

  for (let index = 0; index < MAX_BATCH_OPERATIONS + 1; index += 1) {
    const id = `student-${String(index).padStart(3, '0')}`
    const path = `classrooms/${CLASSROOM_ID}/students/${id}`
    const data = { id, value: index }
    entries.push({ path, data })
    operations.push(createOperation({
      operationId: `operation-${id}`,
      path,
      data,
    }))
  }

  const projection = baseProjection({ students: entries })
  const manifest = plannedManifest(
    operations,
    [operations.map(operation => operation.operationId)],
  )
  const database = fakeFirestore()
  const recorder = manifestRecorder()

  await assert.rejects(
    writeMigrationBatches({
      firestore: database.firestore,
      manifest,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    }),
    error => error instanceof BatchWriterError &&
      error.category ===
      BATCH_WRITER_ERROR_CATEGORIES.BATCH_TOO_MANY_OPERATIONS &&
      error.details.operationCount === 401,
  )

  assert.equal(recorder.attempts.length, 0)
  assert.equal(database.state.batchFactoryCalls, 0)
})

test('a single operation over 8 MiB blocks instead of escaping the batch mechanism', async () => {
  const path = `classrooms/${CLASSROOM_ID}/transactions/oversized`
  const body = {
    id: 'oversized',
    payload: 'x'.repeat(MAX_BATCH_PAYLOAD_BYTES),
  }
  const projection = baseProjection({ transactions: [{ path, data: body }] })
  const manifest = plannedManifest([
    createOperation({ operationId: 'operation-oversized', path, data: body }),
  ])
  const database = fakeFirestore()
  const recorder = manifestRecorder()

  await assert.rejects(
    writeMigrationBatches({
      firestore: database.firestore,
      manifest,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    }),
    error => error instanceof BatchWriterError &&
      error.category === BATCH_WRITER_ERROR_CATEGORIES.OPERATION_TOO_LARGE &&
      error.details.estimatedBytes > MAX_BATCH_PAYLOAD_BYTES,
  )

  assert.equal(recorder.attempts.length, 0)
  assert.equal(database.state.batchFactoryCalls, 0)
})

test('aggregate payload over 8 MiB blocks while preserving retained order', async () => {
  const operations = []
  const entries = []
  const payloadLength = Math.floor(MAX_BATCH_PAYLOAD_BYTES / 2)

  for (const suffix of ['a', 'b']) {
    const path = `classrooms/${CLASSROOM_ID}/transactions/${suffix}`
    const data = { id: suffix, payload: suffix.repeat(payloadLength) }
    entries.push({ path, data })
    operations.push(createOperation({
      operationId: `operation-${suffix}`,
      path,
      data,
    }))
  }

  const projection = baseProjection({ transactions: entries })
  const manifest = plannedManifest(
    operations,
    [operations.map(operation => operation.operationId)],
  )
  const database = fakeFirestore()
  const recorder = manifestRecorder()

  await assert.rejects(
    writeMigrationBatches({
      firestore: database.firestore,
      manifest,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    }),
    error => error instanceof BatchWriterError &&
      error.category === BATCH_WRITER_ERROR_CATEGORIES.BATCH_TOO_LARGE &&
      error.details.estimatedBytes > MAX_BATCH_PAYLOAD_BYTES,
  )

  assert.equal(recorder.attempts.length, 0)
  assert.equal(database.state.batchFactoryCalls, 0)
})

test('delete operations are explicitly rejected before manifest or Firestore access', async () => {
  const path = `classrooms/${CLASSROOM_ID}/students/student-delete`
  const body = { id: 'student-delete' }
  const projection = baseProjection({ students: [{ path, data: body }] })
  const valid = plannedManifest([
    createOperation({ operationId: 'operation-delete', path, data: body }),
  ])
  const forged = JSON.parse(JSON.stringify(valid))
  forged.operations[0].type = 'delete'
  const database = fakeFirestore()
  const recorder = manifestRecorder()

  await assert.rejects(
    writeMigrationBatches({
      firestore: database.firestore,
      manifest: forged,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    }),
    error => error instanceof BatchWriterError &&
      error.category === BATCH_WRITER_ERROR_CATEGORIES.DELETE_PROHIBITED,
  )

  assert.equal(recorder.attempts.length, 0)
  assert.equal(database.state.batchFactoryCalls, 0)
})

test('credential projection drift blocks without leaking or writing secrets', async () => {
  const scenario = happyScenario()
  const projection = {
    ...scenario.projection,
    studentCredentials: [{
      ...scenario.projection.studentCredentials[0],
      data: {
        ...scenario.projection.studentCredentials[0].data,
        pinHash: `${SECRET}-changed`,
      },
    }],
  }
  const database = fakeFirestore({ documents: scenario.initialDocuments })
  const recorder = manifestRecorder()
  let caught

  try {
    await writeMigrationBatches({
      firestore: database.firestore,
      manifest: scenario.manifest,
      projection,
      persistManifest: recorder.persist,
      clock: writerClock,
    })
  } catch (error) {
    caught = error
  }

  assert.equal(caught instanceof BatchWriterError, true)
  assert.equal(
    caught.category,
    BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
  )
  assert.equal(JSON.stringify(caught).includes(SECRET), false)
  assert.equal(recorder.attempts.length, 0)
  assert.equal(database.state.batchFactoryCalls, 0)
})

test('commit classification treats only explicit non-commit statuses as clear', () => {
  assert.equal(isClearlyRejectedCommit({ code: 'already-exists' }), true)
  assert.equal(isClearlyRejectedCommit({ code: 9 }), true)
  assert.equal(isClearlyRejectedCommit({ code: 'deadline-exceeded' }), false)
  assert.equal(isClearlyRejectedCommit({ code: 'unavailable' }), false)
  assert.equal(isClearlyRejectedCommit(new Error('no status')), false)
})
