import { getFirestore } from 'firebase-admin/firestore'
import bcrypt from 'bcryptjs'

const TEMPORARY_CREDENTIAL_COLLECTION = 'studentTestCredentials'
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 5 * 60 * 1000
const DUMMY_PIN_HASH = '$2b$10$Ds5wfuAE9LT3Xe4vdygSMu1VUq0m8830nB5uQauQ0105kP4WDUR.a'

// PIN verification stays isolated here so the hashing strategy can be upgraded
// without changing credential lookup, rate limiting, or custom-token creation.
async function verifyHashedPin(submittedPin, storedHash) {
  try {
    return await bcrypt.compare(submittedPin, storedHash)
  } catch {
    return false
  }
}

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') {
    return value.toMillis()
  }

  if (value instanceof Date) {
    return value.getTime()
  }

  return 0
}

export async function verifyStudentCredentials(
  { loginId, pin },
  {
    firestore = getFirestore(),
    now = Date.now,
  } = {},
) {
  if (!loginId || loginId.includes('/') || !pin) {
    return null
  }

  // TEMPORARY TEST-ONLY collection. The Admin SDK reads this server-side;
  // client Firestore rules intentionally grant no access to it.
  const credentialRef = firestore
    .collection(TEMPORARY_CREDENTIAL_COLLECTION)
    .doc(loginId)

  return firestore.runTransaction(async transaction => {
    const snapshot = await transaction.get(credentialRef)

    if (!snapshot.exists) {
      // Keep missing-ID and wrong-PIN responses similar without revealing
      // whether a credential document exists.
      await verifyHashedPin(pin, DUMMY_PIN_HASH)
      return null
    }

    const record = snapshot.data()
    const currentTime = now()
    const lockedUntilMillis = timestampMillis(record?.lockedUntil)
    const isLocked = lockedUntilMillis > currentTime
    const hasExpiredLock = lockedUntilMillis > 0 && !isLocked
    const hasValidIdentity = record?.active === true
      && typeof record.authUid === 'string'
      && typeof record.classroomId === 'string'
      && typeof record.studentId === 'string'
    const hash = typeof record?.pinHash === 'string'
      ? record.pinHash
      : DUMMY_PIN_HASH
    const pinMatches = await verifyHashedPin(pin, hash)

    if (!hasValidIdentity || isLocked) {
      return null
    }

    if (!pinMatches) {
      const previousAttempts = hasExpiredLock
        ? 0
        : Math.max(0, Number(record.failedAttempts) || 0)
      const failedAttempts = previousAttempts + 1
      const shouldLock = failedAttempts >= MAX_FAILED_ATTEMPTS

      transaction.update(credentialRef, {
        failedAttempts,
        lockedUntil: shouldLock
          ? new Date(currentTime + LOCKOUT_DURATION_MS)
          : null,
      })

      return null
    }

    transaction.update(credentialRef, {
      failedAttempts: 0,
      lockedUntil: null,
    })

    return {
      authUid: record.authUid,
      claims: {
        role: 'student',
        classroomId: record.classroomId,
        studentId: record.studentId,
      },
    }
  })
}
