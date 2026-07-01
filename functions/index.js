import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

if (getApps().length === 0) {
  initializeApp()
}

// TEMPORARY TEST-ONLY credentials. Remove before connecting the student UI.
const TEST_LOGIN_ID = 'test-student'
const TEST_PIN = '7391'

export const studentPinLogin = onCall(async (request) => {
  const { loginId, pin } = request.data ?? {}

  if (typeof loginId !== 'string' || typeof pin !== 'string') {
    throw new HttpsError(
      'invalid-argument',
      'A test login ID and PIN are required.',
    )
  }

  if (loginId !== TEST_LOGIN_ID || pin !== TEST_PIN) {
    throw new HttpsError('unauthenticated', 'Invalid test student credentials.')
  }

  const token = await getAuth().createCustomToken('test-student', {
    role: 'student',
    classroomId: 'morgan',
    studentId: 'test-student',
  })

  return { token }
})
