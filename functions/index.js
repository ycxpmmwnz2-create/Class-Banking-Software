import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { verifyStudentCredentials } from './studentCredentialVerifier.js'

if (getApps().length === 0) {
  initializeApp()
}

export const studentPinLogin = onCall(async (request) => {
  const { loginId, pin } = request.data ?? {}

  const student = await verifyStudentCredentials({ loginId, pin })

  if (!student) {
    throw new HttpsError('unauthenticated', 'Invalid student credentials.')
  }

  const token = await getAuth().createCustomToken(
    student.authUid,
    student.claims,
  )

  return { token }
})
