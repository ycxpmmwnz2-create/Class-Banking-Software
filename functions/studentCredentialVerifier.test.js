import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyStudentCredentials } from './studentCredentialVerifier.js'

test('returns the temporary student identity for valid credentials', async () => {
  const student = await verifyStudentCredentials({
    loginId: 'test-student',
    pin: '7391',
  })

  assert.deepEqual(student, {
    authUid: 'test-student',
    claims: {
      role: 'student',
      classroomId: 'morgan',
      studentId: 'test-student',
    },
  })
})

test('rejects invalid credentials', async () => {
  const student = await verifyStudentCredentials({
    loginId: 'test-student',
    pin: 'wrong',
  })

  assert.equal(student, null)
})
