import { getFirestore } from 'firebase-admin/firestore'

const TEMPORARY_CREDENTIAL_COLLECTION = 'studentTestCredentials'

// TEMPORARY PLAINTEXT COMPARISON.
// Replace only this function with bcrypt/Argon2 verification once PIN hashes
// are stored instead of test PINs.
function verifyTemporaryPin(submittedPin, storedPin) {
  return typeof storedPin === 'string' && submittedPin === storedPin
}

export async function verifyStudentCredentials(
  { loginId, pin },
  firestore = getFirestore(),
) {
  if (!loginId || loginId.includes('/') || !pin) {
    return null
  }

  // TEMPORARY TEST-ONLY collection. The Admin SDK reads this server-side;
  // client Firestore rules intentionally grant no access to it.
  const snapshot = await firestore
    .collection(TEMPORARY_CREDENTIAL_COLLECTION)
    .doc(loginId)
    .get()

  if (!snapshot.exists) {
    return null
  }

  const record = snapshot.data()
  const hasValidIdentity = record?.active === true
    && typeof record.authUid === 'string'
    && typeof record.classroomId === 'string'
    && typeof record.studentId === 'string'

  if (!hasValidIdentity || !verifyTemporaryPin(pin, record.pin)) {
    return null
  }

  return {
    authUid: record.authUid,
    claims: {
      role: 'student',
      classroomId: record.classroomId,
      studentId: record.studentId,
    },
  }
}
