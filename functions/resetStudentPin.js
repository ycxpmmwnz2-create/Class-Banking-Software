import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import bcrypt from 'bcryptjs'

const TEACHER_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'
const BCRYPT_COST = 12
const STUDENT_CREDENTIAL_COLLECTION = 'studentCredentials'

function requireTeacher(auth) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Teacher authentication required.')
  }

  if (auth.uid !== TEACHER_UID) {
    throw new HttpsError('permission-denied', 'Teacher access required.')
  }
}

export async function resetStudentPinForTeacher(
  request,
  options = {},
) {
  requireTeacher(request.auth)

  const { classroomId, studentId, newPin } = request.data ?? {}
  const normalizedClassroomId = typeof classroomId === 'string'
    ? classroomId.trim()
    : ''
  const normalizedStudentId = typeof studentId === 'string'
    ? studentId.trim()
    : ''

  if (
    !normalizedClassroomId
    || !normalizedStudentId
    || typeof newPin !== 'string'
    || !/^\d{4}$/.test(newPin)
  ) {
    throw new HttpsError(
      'invalid-argument',
      'classroomId, studentId, and a four-digit PIN are required.',
    )
  }

  const firestore = options.firestore ?? getFirestore()
  const hashPin = options.hashPin ?? bcrypt.hash
  const serverTimestamp = options.serverTimestamp ?? FieldValue.serverTimestamp
  const revokeRefreshTokens = options.revokeRefreshTokens
  const credentialsSnapshot = await firestore
    .collection(STUDENT_CREDENTIAL_COLLECTION)
    .where('classroomId', '==', normalizedClassroomId)
    .where('studentId', '==', normalizedStudentId)
    .limit(2)
    .get()

  if (credentialsSnapshot.empty) {
    throw new HttpsError('not-found', 'Student credential not found.')
  }

  if (credentialsSnapshot.size !== 1) {
    throw new HttpsError(
      'failed-precondition',
      'Student credential is not unique.',
    )
  }

  const pinHash = await hashPin(newPin, BCRYPT_COST)
  const timestamp = serverTimestamp()
  const credential = credentialsSnapshot.docs[0].data() ?? {}
  if (typeof credential.authUid !== 'string' || !credential.authUid) {
    throw new HttpsError('failed-precondition', 'Student credential identity is invalid.')
  }
  if (typeof revokeRefreshTokens !== 'function') {
    throw new HttpsError('internal', 'Student session revocation is unavailable.')
  }

  await credentialsSnapshot.docs[0].ref.update({
    pinHash,
    active: true,
    pinUpdatedAt: timestamp,
    failedAttempts: 0,
    lockedUntil: null,
    updatedAt: timestamp,
  })

  try {
    await revokeRefreshTokens(credential.authUid)
  } catch (error) {
    // A credential may be reset before its deterministic Auth UID has ever
    // signed in. No Auth record means no refresh token exists to revoke.
    if (error?.code !== 'auth/user-not-found') throw error
  }

  return { success: true }
}
