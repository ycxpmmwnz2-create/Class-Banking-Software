import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyStudentCredentials } from './studentCredentialVerifier.js'

function firestoreWithTestCredential(record, exists = true) {
  return {
    collection(collectionName) {
      assert.equal(collectionName, 'studentTestCredentials')
      return {
        doc(loginId) {
          assert.equal(loginId, 'test-student')
          return {
            async get() {
              return {
                exists,
                data: () => record,
              }
            },
          }
        },
      }
    },
  }
}

const temporaryTestRecord = {
  pin: '7391',
  active: true,
  authUid: 'test-student',
  classroomId: 'morgan',
  studentId: 'test-student',
}

test('returns the Firestore-backed test student for valid credentials', async () => {
  const student = await verifyStudentCredentials(
    { loginId: 'test-student', pin: '7391' },
    firestoreWithTestCredential(temporaryTestRecord),
  )

  assert.deepEqual(student, {
    authUid: 'test-student',
    claims: {
      role: 'student',
      classroomId: 'morgan',
      studentId: 'test-student',
    },
  })
})

test('rejects an invalid PIN', async () => {
  const student = await verifyStudentCredentials(
    { loginId: 'test-student', pin: 'wrong' },
    firestoreWithTestCredential(temporaryTestRecord),
  )

  assert.equal(student, null)
})

test('rejects a missing credential document', async () => {
  const student = await verifyStudentCredentials(
    { loginId: 'test-student', pin: '7391' },
    firestoreWithTestCredential(undefined, false),
  )

  assert.equal(student, null)
})
