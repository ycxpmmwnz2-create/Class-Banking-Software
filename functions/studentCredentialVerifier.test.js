import assert from 'node:assert/strict'
import test from 'node:test'
import bcrypt from 'bcryptjs'

import { verifyStudentCredentials } from './studentCredentialVerifier.js'

const NOW = Date.parse('2026-07-02T12:00:00Z')

function firestoreWithTestCredential(record, exists = true) {
  const state = {
    record: record ? { ...record } : undefined,
    logs: [],
    throttles: new Map(),
  }
  const credentialRef = { kind: 'credential' }
  let nextLogId = 0

  return {
    state,
    firestore: {
      collection(collectionName) {
        if (collectionName === 'studentAuthLogs') {
          return {
            doc(logId) {
              assert.equal(logId, undefined)
              nextLogId += 1
              return { kind: 'log', id: nextLogId }
            },
          }
        }

        if (collectionName === 'studentLoginThrottle') {
          return {
            doc(id) {
              return { kind: 'throttle', id }
            },
          }
        }

        assert.equal(collectionName, 'studentCredentials')
        return {
          doc(loginId) {
            assert.equal(typeof loginId, 'string')
            return credentialRef
          },
        }
      },
      async runTransaction(callback) {
        return callback({
          async get(ref) {
            if (ref.kind === 'throttle') {
              const value = state.throttles.get(ref.id)
              return {
                exists: value !== undefined,
                data: () => value ? { ...value } : undefined,
              }
            }
            assert.equal(ref.kind, 'credential')
            return {
              exists,
              data: () => ({ ...state.record }),
            }
          },
          update(ref, updates) {
            assert.equal(ref, credentialRef)
            Object.assign(state.record, updates)
          },
          set(ref, value) {
            if (ref.kind === 'throttle') {
              state.throttles.set(ref.id, { ...value })
              return
            }
            assert.equal(ref.kind, 'log')
            state.logs.push(value)
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

function assertSafeLog(log, expected) {
  assert.deepEqual(log, {
    loginId: 'test-student',
    timestamp: new Date(NOW),
    ...expected,
  })
  assert.equal('pin' in log, false)
  assert.equal('pinHash' in log, false)
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
  assert.equal(testStore.state.logs.length, 1)
  assertSafeLog(testStore.state.logs[0], {
    success: true,
    reason: 'success',
    classroomId: 'morgan',
    studentId: 'test-student',
  })
})

test('normalizes uppercase and whitespace in the login ID', async () => {
  const testStore = firestoreWithTestCredential(temporaryTestRecord)

  const student = await verify(
    { loginId: '  TEST-STUDENT  ', pin: '7391' },
    testStore,
  )

  assert.equal(student?.claims.studentId, 'test-student')
  assert.equal(testStore.state.logs.length, 1)
  assertSafeLog(testStore.state.logs[0], {
    success: true,
    reason: 'success',
    classroomId: 'morgan',
    studentId: 'test-student',
  })
})

test('wrong PIN increments failed attempts', async () => {
  const testStore = firestoreWithTestCredential({
    ...temporaryTestRecord,
    failedAttempts: 2,
  })

  const student = await verify(
    { loginId: 'test-student', pin: '0000' },
    testStore,
  )

  assert.equal(student, null)
  assert.equal(testStore.state.record.failedAttempts, 3)
  assert.equal(testStore.state.record.lockedUntil, null)
  assert.equal(testStore.state.logs.length, 1)
  assertSafeLog(testStore.state.logs[0], {
    success: false,
    reason: 'invalid_credentials',
    classroomId: 'morgan',
    studentId: 'test-student',
  })
})

test('fifth failed attempt caps the counter without locking the credential', async () => {
  const testStore = firestoreWithTestCredential({
    ...temporaryTestRecord,
    failedAttempts: 4,
  })

  const student = await verify(
    { loginId: 'test-student', pin: '0000' },
    testStore,
  )

  assert.equal(student, null)
  assert.equal(testStore.state.record.failedAttempts, 5)
  assert.equal(testStore.state.record.lockedUntil, null)
  assert.equal(testStore.state.logs.length, 1)
  assertSafeLog(testStore.state.logs[0], {
    success: false,
    reason: 'invalid_credentials',
    classroomId: 'morgan',
    studentId: 'test-student',
  })
})

test('an old lock cannot prevent the correct PIN from signing in', async () => {
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

  assert.equal(student?.authUid, 'test-student')
  assert.equal(testStore.state.record.failedAttempts, 0)
  assert.equal(testStore.state.record.lockedUntil, null)
  assert.equal(testStore.state.logs.length, 1)
  assertSafeLog(testStore.state.logs[0], {
    success: true,
    reason: 'success',
    classroomId: 'morgan',
    studentId: 'test-student',
  })
})

test('a filled identifier bucket cannot lock out the victim correct PIN', async () => {
  const testStore = firestoreWithTestCredential(temporaryTestRecord)

  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal(
      await verifyStudentCredentials(
        { loginId: 'test-student', pin: '0000' },
        {
          firestore: testStore.firestore,
          now: () => NOW + attempt,
          sourceKey: 'same-source',
        },
      ),
      null,
    )
  }

  const student = await verifyStudentCredentials(
    { loginId: 'test-student', pin: '7391' },
    {
      firestore: testStore.firestore,
      now: () => NOW + 11,
      sourceKey: 'same-source',
    },
  )

  assert.equal(student?.authUid, 'test-student')
  assert.equal(testStore.state.record.failedAttempts, 0)
  assert.equal(testStore.state.record.lockedUntil, null)
})

test('missing credential is rejected and logged without credential changes', async () => {
  const testStore = firestoreWithTestCredential(undefined, false)

  const student = await verify(
    { loginId: 'test-student', pin: '7391' },
    testStore,
  )

  assert.equal(student, null)
  assert.equal(testStore.state.record, undefined)
  assert.equal(testStore.state.logs.length, 1)
  assertSafeLog(testStore.state.logs[0], {
    success: false,
    reason: 'invalid_credentials',
  })
})

test('malformed credentials are rejected without creating audit or throttle records', async () => {
  const testStore = firestoreWithTestCredential(undefined, false)

  const student = await verify(
    { loginId: undefined, pin: undefined },
    testStore,
  )

  assert.equal(student, null)
  assert.deepEqual(testStore.state.logs, [])
  assert.equal(testStore.state.throttles.size, 0)
})

test('source throttling bounds work across rotating login identifiers', async () => {
  const testStore = firestoreWithTestCredential(undefined, false)

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await verifyStudentCredentials(
      { loginId: `missing-${attempt}`, pin: '0000' },
      {
        firestore: testStore.firestore,
        now: () => NOW + attempt,
        sourceKey: 'same-source',
      },
    )
  }

  const before = {
    logs: testStore.state.logs.length,
    throttles: testStore.state.throttles.size,
  }
  const rejected = await verifyStudentCredentials(
    { loginId: 'missing-after-cap', pin: '0000' },
    {
      firestore: testStore.firestore,
      now: () => NOW + 31,
      sourceKey: 'same-source',
    },
  )

  assert.equal(rejected, null)
  assert.equal(testStore.state.logs.length, before.logs)
  assert.equal(testStore.state.throttles.size, before.throttles)
})
