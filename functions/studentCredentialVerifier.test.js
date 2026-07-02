import assert from 'node:assert/strict'
import test from 'node:test'
import bcrypt from 'bcryptjs'

import { verifyStudentCredentials } from './studentCredentialVerifier.js'

const NOW = Date.parse('2026-07-02T12:00:00Z')

function firestoreWithTestCredential(record, exists = true) {
  const state = {
    record: record ? { ...record } : undefined,
  }
  const credentialRef = {}

  return {
    state,
    firestore: {
      collection(collectionName) {
        assert.equal(collectionName, 'studentTestCredentials')
        return {
          doc(loginId) {
            assert.equal(loginId, 'test-student')
            return credentialRef
          },
        }
      },
      async runTransaction(callback) {
        return callback({
          async get(ref) {
            assert.equal(ref, credentialRef)
            return {
              exists,
              data: () => ({ ...state.record }),
            }
          },
          update(ref, updates) {
            assert.equal(ref, credentialRef)
            Object.assign(state.record, updates)
          },
        })
      },
    },
  }
}

const temporaryTestRecord = {
  pinHash: await bcrypt.hash('7391', 4),
  active: true,
  authUid: 'test-student',
  classroomId: 'morgan',
  studentId: 'test-student',
  failedAttempts: 0,
  lockedUntil: null,
}

async function verify(credentials, testStore) {
  return verifyStudentCredentials(credentials, {
    firestore: testStore.firestore,
    now: () => NOW,
  })
}

test('successful login resets failed attempts and lockout', async () => {
  const testStore = firestoreWithTestCredential({
    ...temporaryTestRecord,
    failedAttempts: 3,
    lockedUntil: new Date(NOW - 1000),
  })

  const student = await verify(
    { loginId: 'test-student', pin: '7391' },
    testStore,
  )

  assert.deepEqual(student, {
    authUid: 'test-student',
    claims: {
      role: 'student',
      classroomId: 'morgan',
      studentId: 'test-student',
    },
  })
  assert.equal(testStore.state.record.failedAttempts, 0)
  assert.equal(testStore.state.record.lockedUntil, null)
})

test('wrong PIN increments failed attempts', async () => {
  const testStore = firestoreWithTestCredential({
    ...temporaryTestRecord,
    failedAttempts: 2,
  })

  const student = await verify(
    { loginId: 'test-student', pin: 'wrong' },
    testStore,
  )

  assert.equal(student, null)
  assert.equal(testStore.state.record.failedAttempts, 3)
  assert.equal(testStore.state.record.lockedUntil, null)
})

test('fifth failed attempt locks the credential for five minutes', async () => {
  const testStore = firestoreWithTestCredential({
    ...temporaryTestRecord,
    failedAttempts: 4,
  })

  const student = await verify(
    { loginId: 'test-student', pin: 'wrong' },
    testStore,
  )

  assert.equal(student, null)
  assert.equal(testStore.state.record.failedAttempts, 5)
  assert.equal(
    testStore.state.record.lockedUntil.getTime(),
    NOW + (5 * 60 * 1000),
  )
})

test('locked credential rejects the correct PIN without resetting', async () => {
  const lockedUntil = new Date(NOW + 60_000)
  const testStore = firestoreWithTestCredential({
    ...temporaryTestRecord,
    failedAttempts: 5,
    lockedUntil,
  })

  const student = await verify(
    { loginId: 'test-student', pin: '7391' },
    testStore,
  )

  assert.equal(student, null)
  assert.equal(testStore.state.record.failedAttempts, 5)
  assert.equal(testStore.state.record.lockedUntil, lockedUntil)
})

test('missing credential is rejected without a write', async () => {
  const testStore = firestoreWithTestCredential(undefined, false)

  const student = await verify(
    { loginId: 'test-student', pin: '7391' },
    testStore,
  )

  assert.equal(student, null)
  assert.equal(testStore.state.record, undefined)
})
