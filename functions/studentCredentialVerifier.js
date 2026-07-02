import { getFirestore } from 'firebase-admin/firestore'
import bcrypt from 'bcryptjs'

const TEMPORARY_CREDENTIAL_COLLECTION = 'studentTestCredentials'

// PIN verification stays isolated here so the hashing strategy can be upgraded
// without changing credential lookup or custom-token creation.
async function verifyHashedPin(submittedPin, storedHash) {
  if (typeof storedHash !== 'string') {
    return false
  }

  try {
    return await bcrypt.compare(submittedPin, storedHash)
  } catch {
    return false
  }
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

  if (!hasValidIdentity || !await verifyHashedPin(pin, record.pinHash)) {
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
