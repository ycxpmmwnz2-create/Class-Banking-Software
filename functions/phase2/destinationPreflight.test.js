import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { URL } from 'node:url'

import { Timestamp } from 'firebase-admin/firestore'

import {
  encodeCanonicalFirestoreValue,
  hashCanonicalState,
  serializeCanonicalState,
} from './canonicalState.js'
import {
  DESTINATION_OPERATION_STATES,
  DESTINATION_OPERATION_TYPES,
  DESTINATION_PREFLIGHT_ERROR_CATEGORIES,
  DestinationPreflightError,
  buildDestinationPreflight,
} from './destinationPreflight.js'
import { createPlannedManifest } from './manifest.js'
import { buildMigrationProjection } from './projection.js'

const TEACHER_UID = 'teacher-1'
const CLASSROOM_ID = 'generated-classroom-1'
const MISSING_DOCUMENT = Symbol('missing-document')

function envelope(collection, id, data, second) {
  return {
    id,
    path: `${collection}/${id}`,
    data,
    updateTime: new Timestamp(second, 100 + second),
  }
}

function sourceFixture() {
  return {
    classroomData: {
      id: 'classroomData',
      path: 'morganBank/classroomData',
      data: {
        students: [
          {
            id: 'student-active',
            name: 'Active Student',
            balance: 12,
            frozen: false,
          },
          {
            id: 'student-inactive',
            name: 'Inactive Student',
            balance: 4,
            frozen: true,
          },
        ],
        transactions: [
          {
            id: 'transaction-2',
            studentId: 'student-active',
            amount: 2,
            createdAt: new Timestamp(20, 200000001),
          },
          {
            id: 'transaction-1',
            studentId: 'student-inactive',
            amount: -1,
          },
        ],
        loginHistory: [
          { id: 'history-1', studentId: 'student-active', success: true },
        ],
        settings: {
          currencyName: 'Class Cash',
          nested: { weeklyAllowance: 5 },
        },
        lastBackupAt: new Timestamp(30, 999999999),
      },
      updateTime: new Timestamp(31, 1),
    },
    studentCredentials: [
      envelope('studentCredentials', 'active-login', {
        classroomId: 'morgan',
        studentId: 'student-active',
        active: true,
        pinHash: 'secret-active-pin-hash',
        authToken: 'secret-active-token',
      }, 40),
      envelope('studentCredentials', 'inactive-login', {
        classroomId: 'morgan',
        studentId: 'student-inactive',
        active: false,
        pinHash: 'secret-inactive-pin-hash',
      }, 41),
      envelope('studentCredentials', 'orphan-login', {
        classroomId: 'morgan',
        studentId: 'removed-student',
        active: true,
        pinHash: 'secret-orphan-pin-hash',
      }, 42),
    ],
    studentAuthLogs: [
      envelope('studentAuthLogs', 'auth-log-1', {
        classroomId: 'morgan',
        loginId: 'active-login',
        success: false,
      }, 50),
    ],
  }
}

function foundationFixture(overrides = {}) {
  const classroomData = {
    ownerUid: TEACHER_UID,
    name: 'Period 1',
    createdAt: new Timestamp(1, 10),
    updatedAt: new Timestamp(2, 20),
    version: 1,
    settings: { currencyName: 'Points' },
    ...overrides.classroomData,
  }
  const teacherData = {
    uid: TEACHER_UID,
    classroomId: CLASSROOM_ID,
    status: 'active',
  }

  return {
    teacherUid: TEACHER_UID,
    classroomId: CLASSROOM_ID,
    teacher: {
      id: TEACHER_UID,
      path: `teachers/${TEACHER_UID}`,
      data: teacherData,
      updateTime: overrides.teacherUpdateTime ?? new Timestamp(3, 30),
    },
    classroom: {
      id: CLASSROOM_ID,
      path: `classrooms/${CLASSROOM_ID}`,
      data: classroomData,
      updateTime: overrides.classroomUpdateTime ?? new Timestamp(4, 40),
    },
  }
}

function buildProjection(source = sourceFixture()) {
  return buildMigrationProjection({
    classroomId: CLASSROOM_ID,
    ...source,
  })
}

function beforeDocuments(source, foundation) {
  const documents = new Map([
    [foundation.classroom.path, {
      data: foundation.classroom.data,
      updateTime: new Timestamp(100, 100000001),
    }],
  ])

  source.studentCredentials.forEach((credential, index) => {
    documents.set(credential.path, {
      data: credential.data,
      updateTime: new Timestamp(110 + index, 200000001 + index),
    })
  })
  return documents
}

function scenario() {
  const source = sourceFixture()
  const projection = buildProjection(source)
  const foundation = foundationFixture()
  const documents = beforeDocuments(source, foundation)
  return { source, projection, foundation, documents }
}

function fakeFirestore({
  documents,
  readErrorPath,
  readError,
  snapshotOverrides = new Map(),
}) {
  const state = { reads: [], writes: [] }

  function unexpectedWrite(kind, path, data) {
    state.writes.push({ kind, path, data })
    throw new Error(`Unexpected ${kind} write to ${path}.`)
  }

  function documentReference(path) {
    const reference = {
      id: path.slice(path.lastIndexOf('/') + 1),
      path,
      async get() {
        state.reads.push(path)
        if (path === readErrorPath) {
          throw readError
        }
        if (snapshotOverrides.has(path)) {
          return snapshotOverrides.get(path)
        }

        const entry = documents.has(path)
          ? documents.get(path)
          : MISSING_DOCUMENT
        return {
          exists: entry !== MISSING_DOCUMENT,
          id: reference.id,
          ref: reference,
          data: () => entry === MISSING_DOCUMENT ? undefined : entry.data,
          updateTime: entry === MISSING_DOCUMENT
            ? undefined
            : entry.updateTime,
        }
      },
      create(data) {
        return unexpectedWrite('create', path, data)
      },
      delete() {
        return unexpectedWrite('delete', path)
      },
      set(data) {
        return unexpectedWrite('set', path, data)
      },
      update(data) {
        return unexpectedWrite('update', path, data)
      },
    }
    return reference
  }

  return {
    firestore: {
      doc: documentReference,
      batch() {
        return unexpectedWrite('batch', '<database>')
      },
      bulkWriter() {
        return unexpectedWrite('bulkWriter', '<database>')
      },
      runTransaction() {
        return unexpectedWrite('transaction', '<database>')
      },
    },
    state,
  }
}

function operationFor(result, path) {
  return result.operations.find(operation => operation.path === path)
}

function expectedDestinationCount(projection) {
  return 1 + projection.students.length + projection.transactions.length +
    projection.loginHistory.length + projection.studentCredentials.length +
    projection.studentAuthLogs.length
}

function firestoreHash(value) {
  return hashCanonicalState(encodeCanonicalFirestoreValue(value))
}

function assertPreflightError(category, inspect = () => {}) {
  return error => {
    assert.ok(error instanceof DestinationPreflightError)
    assert.equal(error.code, 'PHASE2A_DESTINATION_PREFLIGHT_ERROR')
    assert.equal(error.category, category)
    assert.equal(error.blocking, true)
    assert.equal(Object.isFrozen(error.details), true)
    inspect(error)
    return true
  }
}

async function runScenario(currentScenario) {
  const testStore = fakeFirestore({ documents: currentScenario.documents })
  const result = await buildDestinationPreflight({
    firestore: testStore.firestore,
    foundation: currentScenario.foundation,
    projection: currentScenario.projection,
  })
  assert.deepEqual(testStore.state.writes, [])
  return { result, testStore }
}

test('classifies absent creates as planned with manifest-ready metadata', async () => {
  const current = scenario()
  const { result, testStore } = await runScenario(current)
  const creates = result.operations.filter(operation =>
    operation.type === DESTINATION_OPERATION_TYPES.CREATE)

  assert.ok(creates.length > 0)
  creates.forEach(operation => {
    assert.equal(operation.state, DESTINATION_OPERATION_STATES.PLANNED)
    assert.equal(operation.expectedBeforeHash, 'absent')
    assert.match(operation.expectedAfterHash, /^[a-f0-9]{64}$/)
    assert.equal(operation.rollbackPreimage, null)
    assert.equal(operation.updateTimePrecondition, null)
  })
  assert.equal(testStore.state.reads.length, expectedDestinationCount(
    current.projection,
  ))

  const manifest = createPlannedManifest({
    runId: 'run-1',
    emulatorProjectId: 'phase2a-project',
    teacherUid: TEACHER_UID,
    classroomId: CLASSROOM_ID,
    createdAt: '2026-07-24T12:00:00.000Z',
    immutableSourceChecksum: 'a'.repeat(64),
    foundationInvariantChecksum: 'b'.repeat(64),
    planChecksum: result.planChecksum,
    batches: result.batches,
    operations: result.operations,
    orphanedCredentialPaths: result.orphanedCredentialPaths,
  })
  assert.equal(manifest.operations.length, result.operations.length)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.operations), true)
  assert.equal(Object.isFrozen(result.operations[0]), true)
})

test('classifies identical creates as skipped and differing creates as divergent', async () => {
  const identical = scenario()
  const student = identical.projection.students[0]
  identical.documents.set(student.path, {
    data: student.data,
    updateTime: new Timestamp(200, 1),
  })
  const identicalRun = await runScenario(identical)
  assert.equal(
    operationFor(identicalRun.result, student.path).state,
    DESTINATION_OPERATION_STATES.SKIPPED_IDENTICAL,
  )

  const divergent = scenario()
  const divergentStudent = divergent.projection.students[0]
  divergent.documents.set(divergentStudent.path, {
    data: { ...divergentStudent.data, balance: 999 },
    updateTime: new Timestamp(201, 2),
  })
  const divergentStore = fakeFirestore({ documents: divergent.documents })

  await assert.rejects(
    buildDestinationPreflight({
      firestore: divergentStore.firestore,
      foundation: divergent.foundation,
      projection: divergent.projection,
    }),
    assertPreflightError(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.DIVERGENT_DESTINATIONS,
      error => {
        assert.deepEqual(error.details.conflicts, [{
          type: DESTINATION_OPERATION_TYPES.CREATE,
          path: divergentStudent.path,
          reason: 'existing-create-body-differs',
        }])
        assert.equal(
          error.details.classifiedDestinationCount,
          expectedDestinationCount(divergent.projection),
        )
      },
    ),
  )
  assert.equal(
    divergentStore.state.reads.length,
    expectedDestinationCount(divergent.projection),
  )
  assert.deepEqual(divergentStore.state.writes, [])
})

test('classifies classroom expected-before, expected-after, and partial states', async () => {
  const before = scenario()
  const beforeResult = await runScenario(before)
  const beforeOperation = operationFor(
    beforeResult.result,
    before.projection.classroom.path,
  )
  assert.equal(beforeOperation.state, DESTINATION_OPERATION_STATES.PLANNED)
  assert.equal(
    beforeOperation.expectedBeforeHash,
    firestoreHash({ settings: before.foundation.classroom.data.settings }),
  )
  assert.equal(
    beforeOperation.expectedAfterHash,
    firestoreHash(before.projection.classroom.data),
  )
  assert.deepEqual(beforeOperation.rollbackPreimage.lastBackupAt, {
    present: false,
    value: null,
  })

  const after = scenario()
  after.documents.set(after.projection.classroom.path, {
    data: {
      ...after.foundation.classroom.data,
      ...after.projection.classroom.data,
    },
    updateTime: new Timestamp(202, 3),
  })
  const afterResult = await runScenario(after)
  assert.equal(
    operationFor(afterResult.result, after.projection.classroom.path).state,
    DESTINATION_OPERATION_STATES.SKIPPED_IDENTICAL,
  )

  const partial = scenario()
  partial.documents.set(partial.projection.classroom.path, {
    data: {
      ...partial.foundation.classroom.data,
      settings: partial.projection.classroom.data.settings,
    },
    updateTime: new Timestamp(203, 4),
  })
  const partialStore = fakeFirestore({ documents: partial.documents })
  await assert.rejects(
    buildDestinationPreflight({
      firestore: partialStore.firestore,
      foundation: partial.foundation,
      projection: partial.projection,
    }),
    assertPreflightError(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.DIVERGENT_DESTINATIONS,
      error => {
        assert.deepEqual(error.details.conflicts, [{
          type: DESTINATION_OPERATION_TYPES.CLASSROOM_FIELD_UPDATE,
          path: partial.projection.classroom.path,
          reason: 'classroom-fields-divergent',
        }])
      },
    ),
  )
})

test('classifies credential before/after states and includes every lifecycle state', async () => {
  const current = scenario()
  const migratedCredential = current.projection.studentCredentials[0]
  current.documents.set(migratedCredential.path, {
    data: migratedCredential.data,
    updateTime: new Timestamp(300, 123456789),
  })
  const { result } = await runScenario(current)
  const credentialOperations = result.operations.filter(operation =>
    operation.type === DESTINATION_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE)

  assert.deepEqual(
    credentialOperations.map(operation => operation.path).sort(),
    current.projection.studentCredentials.map(entry => entry.path).sort(),
  )
  assert.equal(
    operationFor(result, migratedCredential.path).state,
    DESTINATION_OPERATION_STATES.SKIPPED_IDENTICAL,
  )
  assert.equal(
    operationFor(result, 'studentCredentials/inactive-login').state,
    DESTINATION_OPERATION_STATES.PLANNED,
  )
  assert.equal(
    operationFor(result, 'studentCredentials/orphan-login').state,
    DESTINATION_OPERATION_STATES.PLANNED,
  )
  assert.deepEqual(result.orphanedCredentialPaths, [
    'studentCredentials/orphan-login',
  ])

  const activeSource = current.source.studentCredentials[0].data
  const invariant = { ...activeSource }
  delete invariant.classroomId
  const operation = operationFor(result, migratedCredential.path)
  assert.equal(operation.rollbackPreimage.invariantHash, firestoreHash(invariant))
  assert.equal(operation.expectedBeforeHash, firestoreHash(activeSource))
  assert.equal(operation.expectedAfterHash, firestoreHash(migratedCredential.data))
})

test('blocks missing, changed-invariant, and unexpected-classroom credentials', async () => {
  const cases = [
    {
      reason: 'credential-missing',
      mutate(current, path) {
        current.documents.delete(path)
      },
    },
    {
      reason: 'credential-invariant-changed',
      mutate(current, path) {
        const entry = current.documents.get(path)
        current.documents.set(path, {
          ...entry,
          data: { ...entry.data, pinHash: 'secret-changed-pin-hash' },
        })
      },
    },
    {
      reason: 'credential-classroom-id-unexpected',
      mutate(current, path) {
        const entry = current.documents.get(path)
        current.documents.set(path, {
          ...entry,
          data: { ...entry.data, classroomId: 'unexpected-classroom' },
        })
      },
    },
  ]

  for (const currentCase of cases) {
    const current = scenario()
    const path = 'studentCredentials/active-login'
    currentCase.mutate(current, path)
    const testStore = fakeFirestore({ documents: current.documents })

    await assert.rejects(
      buildDestinationPreflight({
        firestore: testStore.firestore,
        foundation: current.foundation,
        projection: current.projection,
      }),
      assertPreflightError(
        DESTINATION_PREFLIGHT_ERROR_CATEGORIES.DIVERGENT_DESTINATIONS,
        error => {
          assert.deepEqual(error.details.conflicts, [{
            type: DESTINATION_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE,
            path,
            reason: currentCase.reason,
          }])
          const exposed = `${String(error)} ${JSON.stringify(error.details)}`
          assert.doesNotMatch(exposed, /secret-|pinHash|authToken/)
        },
      ),
    )
    assert.equal(
      testStore.state.reads.length,
      expectedDestinationCount(current.projection),
    )
    assert.deepEqual(testStore.state.writes, [])
  }
})

test('preserves exact nanosecond update-time preconditions', async () => {
  const current = scenario()
  const classroomUpdateTime = new Timestamp(-1, 999999999)
  const credentialUpdateTime = new Timestamp(123456, 987654321)
  current.documents.get(current.projection.classroom.path).updateTime =
    classroomUpdateTime
  current.documents.get('studentCredentials/active-login').updateTime =
    credentialUpdateTime
  const { result } = await runScenario(current)

  assert.deepEqual(
    operationFor(result, current.projection.classroom.path)
      .updateTimePrecondition,
    encodeCanonicalFirestoreValue(classroomUpdateTime),
  )
  assert.deepEqual(
    operationFor(result, 'studentCredentials/active-login')
      .updateTimePrecondition,
    encodeCanonicalFirestoreValue(credentialUpdateTime),
  )
  result.operations
    .filter(operation => operation.type === DESTINATION_OPERATION_TYPES.CREATE)
    .forEach(operation => assert.equal(operation.updateTimePrecondition, null))
})

test('builds a deterministic, complete path-ordered plan and association', async () => {
  const first = scenario()
  const second = scenario()
  const alreadyCreated = second.projection.students[0]
  const alreadyMigrated = second.projection.studentCredentials[0]
  second.documents.set(alreadyCreated.path, {
    data: alreadyCreated.data,
    updateTime: new Timestamp(400, 1),
  })
  second.documents.set(alreadyMigrated.path, {
    data: alreadyMigrated.data,
    updateTime: new Timestamp(401, 2),
  })
  const firstRun = await runScenario(first)
  const secondRun = await runScenario(second)
  const paths = firstRun.result.operations.map(operation => operation.path)
  const expectedPaths = [
    first.projection.classroom.path,
    ...first.projection.students.map(entry => entry.path),
    ...first.projection.transactions.map(entry => entry.path),
    ...first.projection.loginHistory.map(entry => entry.path),
    ...first.projection.studentCredentials.map(entry => entry.path),
    ...first.projection.studentAuthLogs.map(entry => entry.path),
  ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)

  assert.deepEqual(paths, expectedPaths)
  assert.equal(paths.length, expectedDestinationCount(first.projection))
  assert.deepEqual(
    firstRun.result.operations.map(operation => operation.operationId),
    secondRun.result.operations.map(operation => operation.operationId),
  )
  assert.equal(firstRun.result.planChecksum, secondRun.result.planChecksum)
  assert.deepEqual(
    firstRun.result.batches.flatMap(batch => batch.operationIds),
    firstRun.result.operations.map(operation => operation.operationId),
  )
  firstRun.result.batches.forEach((batch, index) => {
    assert.equal(batch.batchId, `batch-${String(index + 1).padStart(6, '0')}`)
    assert.equal(batch.operationIds.length, 1)
    assert.equal(
      firstRun.result.operations[index].batchId,
      batch.batchId,
    )
  })
})

test('never returns credential secrets in operation metadata', async () => {
  const current = scenario()
  const { result } = await runScenario(current)
  const serialized = JSON.stringify(result)

  assert.doesNotMatch(serialized, /secret-active|secret-inactive|secret-orphan/)
  assert.doesNotMatch(serialized, /pinHash|authToken/)
  result.operations
    .filter(operation =>
      operation.type === DESTINATION_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE)
    .forEach(operation => {
      assert.deepEqual(
        Object.keys(operation.rollbackPreimage).sort(),
        ['invariantHash', 'newClassroomId', 'oldClassroomId', 'path'],
      )
    })
})

test('fails closed on invalid arguments, projections, foundations, and snapshots', async () => {
  await assert.rejects(
    buildDestinationPreflight(null),
    assertPreflightError(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )

  const unknown = scenario()
  await assert.rejects(
    buildDestinationPreflight({
      firestore: fakeFirestore({ documents: unknown.documents }).firestore,
      foundation: unknown.foundation,
      projection: unknown.projection,
      write: true,
    }),
    assertPreflightError(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )

  const malformedProjection = scenario()
  const invalidStudent = {
    ...malformedProjection.projection.students[0],
    path: `classrooms/${CLASSROOM_ID}/students/wrong-id`,
  }
  const projection = {
    ...malformedProjection.projection,
    students: [invalidStudent, ...malformedProjection.projection.students.slice(1)],
  }
  await assert.rejects(
    buildDestinationPreflight({
      firestore: fakeFirestore({
        documents: malformedProjection.documents,
      }).firestore,
      foundation: malformedProjection.foundation,
      projection,
    }),
    assertPreflightError(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_PROJECTION,
    ),
  )

  const malformedFoundation = scenario()
  malformedFoundation.foundation.teacher.updateTime = { seconds: 1 }
  await assert.rejects(
    buildDestinationPreflight({
      firestore: fakeFirestore({
        documents: malformedFoundation.documents,
      }).firestore,
      foundation: malformedFoundation.foundation,
      projection: malformedFoundation.projection,
    }),
    assertPreflightError(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_FOUNDATION,
    ),
  )

  const malformedSnapshot = scenario()
  const path = malformedSnapshot.projection.classroom.path
  const snapshotOverrides = new Map([[path, {
    exists: true,
    id: CLASSROOM_ID,
    ref: { path },
    data: () => malformedSnapshot.foundation.classroom.data,
    updateTime: null,
  }]])
  await assert.rejects(
    buildDestinationPreflight({
      firestore: fakeFirestore({
        documents: malformedSnapshot.documents,
        snapshotOverrides,
      }).firestore,
      foundation: malformedSnapshot.foundation,
      projection: malformedSnapshot.projection,
    }),
    assertPreflightError(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_SNAPSHOT,
    ),
  )
})

test('propagates Firestore read failures unchanged', async () => {
  const current = scenario()
  const readError = new Error('injected destination read failure')
  const readErrorPath = current.projection.transactions[0].path
  const testStore = fakeFirestore({
    documents: current.documents,
    readError,
    readErrorPath,
  })

  await assert.rejects(
    buildDestinationPreflight({
      firestore: testStore.firestore,
      foundation: current.foundation,
      projection: current.projection,
    }),
    error => error === readError,
  )
  assert.deepEqual(testStore.state.writes, [])
})

function freezeRecursively(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return value
  }
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) {
      freezeRecursively(descriptor.value, seen)
    }
  }
  return Object.freeze(value)
}

test('accepts deeply frozen inputs without mutating projections or snapshots', async () => {
  const current = scenario()
  freezeRecursively(current.projection)
  freezeRecursively(current.foundation)
  for (const entry of current.documents.values()) {
    freezeRecursively(entry)
  }
  const documentState = () => [...current.documents.entries()].map(
    ([path, entry]) => ({ path, data: entry.data, updateTime: entry.updateTime }),
  )
  const before = serializeCanonicalState(encodeCanonicalFirestoreValue({
    projection: current.projection,
    foundation: current.foundation,
    documents: documentState(),
  }))
  await runScenario(current)
  const after = serializeCanonicalState(encodeCanonicalFirestoreValue({
    projection: current.projection,
    foundation: current.foundation,
    documents: documentState(),
  }))

  assert.equal(after, before)
  assert.equal(Object.isFrozen(current.projection.classroom.data), true)
  assert.equal(Object.isFrozen(current.foundation.classroom.data), true)
})

test('module has no destination-writer import or Firestore mutation call', async () => {
  const source = await readFile(
    new URL('./destinationPreflight.js', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(source, /batchWriter|migrateClassroomData|\.\/manifest\.js/)
  assert.doesNotMatch(
    source,
    /\.(?:set|update|create|delete|commit|batch|bulkWriter|runTransaction)\s*\(/,
  )
  assert.doesNotMatch(source, /firebase-admin|firebase-functions|getFirestore/)
})
