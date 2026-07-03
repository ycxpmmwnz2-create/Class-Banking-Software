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

  if (auth.uid !== TEACHER_UID || auth.token?.role !== 'teacher') {
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

  await credentialsSnapshot.docs[0].ref.update({
    pinHash,
    pinUpdatedAt: timestamp,
    failedAttempts: 0,
    lockedUntil: null,
    updatedAt: timestamp,
  })

  return { success: true }
}
