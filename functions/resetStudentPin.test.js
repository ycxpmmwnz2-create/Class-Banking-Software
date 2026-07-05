import assert from 'node:assert/strict'
import test from 'node:test'
import bcrypt from 'bcryptjs'

import { resetStudentPinForTeacher } from './resetStudentPin.js'

const TEACHER_AUTH = {
  uid: 'YkYUzIzy0aW7roolM1VaLcIJPuN2',
  token: {},
}
const TIMESTAMP = { serverTimestamp: true }

function firestoreWithCredentials(records = [{}]) {
  const state = {
    filters: [],
    limit: null,
    updates: [],
  }
  const docs = records.map((record, index) => ({
    data: () => record,
    ref: {
      async update(updates) {
        state.updates.push({ index, updates })
      },
    },
  }))
  const query = {
    where(field, operator, value) {
      state.filters.push([field, operator, value])
      return query
    },
    limit(value) {
      state.limit = value
      return query
    },
    async get() {
      return {
        docs,
        empty: docs.length === 0,
        size: docs.length,
      }
    },
  }

  return {
    state,
    firestore: {
      collection(collectionName) {
        assert.equal(collectionName, 'studentCredentials')
        return query
      },
    },
  }
}

function request(overrides = {}) {
  return {
    auth: TEACHER_AUTH,
    data: {
      classroomId: 'morgan',
      studentId: 'student-1',
      newPin: '7391',
    },
    ...overrides,
  }
}

async function assertHttpsError(promise, expectedCode) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, expectedCode)
    return true
  })
}

test('requires an authenticated teacher', async () => {
  await assertHttpsError(
    resetStudentPinForTeacher(request({ auth: undefined })),
    'unauthenticated',
  )
})

test('requires the trusted teacher UID', async () => {
  await assertHttpsError(
    resetStudentPinForTeacher(request({
      auth: { uid: 'another-user', token: { role: 'teacher' } },
    })),
    'permission-denied',
  )
})

test('requires a PIN containing exactly four digits', async () => {
  for (const invalidPin of ['123', '12345', '12a4', 1234]) {
    await assertHttpsError(
      resetStudentPinForTeacher(request({
        data: {
          classroomId: 'morgan',
          studentId: 'student-1',
          newPin: invalidPin,
        },
      })),
      'invalid-argument',
    )
  }
})

test('requires classroom and student identifiers', async () => {
  for (const data of [
    { classroomId: '', studentId: 'student-1', newPin: '7391' },
    { classroomId: 'morgan', studentId: ' ', newPin: '7391' },
  ]) {
    await assertHttpsError(
      resetStudentPinForTeacher(request({ data })),
      'invalid-argument',
    )
  }
})

test('rejects a missing student credential', async () => {
  const testStore = firestoreWithCredentials([])

  await assertHttpsError(
    resetStudentPinForTeacher(request(), {
      firestore: testStore.firestore,
    }),
    'not-found',
  )
  assert.equal(testStore.state.updates.length, 0)
})

test('rejects duplicate student credentials', async () => {
  const testStore = firestoreWithCredentials([{}, {}])

  await assertHttpsError(
    resetStudentPinForTeacher(request(), {
      firestore: testStore.firestore,
    }),
    'failed-precondition',
  )
  assert.equal(testStore.state.updates.length, 0)
})

test('hashes the PIN at cost 12 and updates only PIN state', async () => {
  const testStore = firestoreWithCredentials()
  const hashCalls = []

  const result = await resetStudentPinForTeacher(request(), {
    firestore: testStore.firestore,
    async hashPin(pin, cost) {
      hashCalls.push([pin, cost])
      return bcrypt.hash(pin, cost)
    },
    serverTimestamp: () => TIMESTAMP,
  })

  assert.deepEqual(result, { success: true })
  assert.deepEqual(testStore.state.filters, [
    ['classroomId', '==', 'morgan'],
    ['studentId', '==', 'student-1'],
  ])
  assert.equal(testStore.state.limit, 2)
  assert.deepEqual(hashCalls, [['7391', 12]])
  assert.equal(testStore.state.updates.length, 1)

  const updates = testStore.state.updates[0].updates
  assert.deepEqual(Object.keys(updates).sort(), [
    'active',
    'failedAttempts',
    'lockedUntil',
    'pinHash',
    'pinUpdatedAt',
    'updatedAt',
  ])
  assert.equal(await bcrypt.compare('7391', updates.pinHash), true)
  assert.equal(bcrypt.getRounds(updates.pinHash), 12)
  assert.equal(updates.active, true)
  assert.equal(updates.failedAttempts, 0)
  assert.equal(updates.lockedUntil, null)
  assert.equal(updates.pinUpdatedAt, TIMESTAMP)
  assert.equal(updates.updatedAt, TIMESTAMP)
})
