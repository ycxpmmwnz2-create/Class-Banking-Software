import { getFirestore } from 'firebase-admin/firestore'
import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'

const STUDENT_CREDENTIAL_COLLECTION = 'studentCredentials'
const AUTH_LOG_COLLECTION = 'studentAuthLogs'
const MAX_FAILED_ATTEMPTS = 5
const DUMMY_PIN_HASH = '$2b$10$Ds5wfuAE9LT3Xe4vdygSMu1VUq0m8830nB5uQauQ0105kP4WDUR.a'
const LOGIN_THROTTLE_COLLECTION = 'studentLoginThrottle'
const THROTTLE_WINDOW_MS = 5 * 60 * 1000
const MAX_IDENTIFIER_ATTEMPTS = 10
const MAX_SOURCE_ATTEMPTS = 30
const MAX_GLOBAL_ATTEMPTS = 300

// PIN verification stays isolated here so the hashing strategy can be upgraded
// without changing credential lookup, rate limiting, or custom-token creation.
async function verifyHashedPin(submittedPin, storedHash) {
  try {
    return await bcrypt.compare(submittedPin, storedHash)
  } catch {
    return false
  }
}

function authenticationLog({
  loginId,
  success,
  reason,
  timestamp,
  record,
}) {
  return {
    loginId,
    success,
    reason,
    timestamp: new Date(timestamp),
    ...(typeof record?.classroomId === 'string'
      ? { classroomId: record.classroomId }
      : {}),
    ...(typeof record?.studentId === 'string'
      ? { studentId: record.studentId }
      : {}),
  }
}

export async function verifyStudentCredentials(
  { loginId, pin },
  {
    firestore = getFirestore(),
    now = Date.now,
    sourceKey = 'unknown-source',
  } = {},
) {
  const attemptTime = now()
  const normalizedLoginId = typeof loginId === 'string'
    ? loginId.slice(0, 64).trim().toLowerCase()
    : ''

  if (
    !normalizedLoginId
    || normalizedLoginId.includes('/')
    || typeof pin !== 'string'
    || !/^[0-9]{4}$/.test(pin)
  ) {
    return null
  }

  // The Admin SDK reads production credentials server-side. Client Firestore
  // rules intentionally grant no access to this collection.
  const credentialRef = firestore
    .collection(STUDENT_CREDENTIAL_COLLECTION)
    .doc(normalizedLoginId)

  const digest = value => createHash('sha256').update(value).digest('hex')
  const throttleCollection = firestore.collection(LOGIN_THROTTLE_COLLECTION)
  const identifierThrottleRef = throttleCollection
    .doc(digest(`legacy-identifier-v1\0${normalizedLoginId}`))
  const sourceThrottleRef = throttleCollection
    .doc(digest(`legacy-source-v1\0${String(sourceKey).slice(0, 200)}`))
  const globalThrottleRef = throttleCollection.doc(digest('legacy-global-v1'))

  return firestore.runTransaction(async transaction => {
    const identifierThrottleSnap = await transaction.get(identifierThrottleRef)
    const sourceThrottleSnap = await transaction.get(sourceThrottleRef)
    const globalThrottleSnap = await transaction.get(globalThrottleRef)
    const attemptsFor = snapshot => {
      const data = snapshot.exists ? (snapshot.data() ?? {}) : {}
      return (Array.isArray(data.attempts) ? data.attempts : []).filter(
        value => typeof value === 'number' && attemptTime - value < THROTTLE_WINDOW_MS,
      )
    }
    const identifierAttempts = attemptsFor(identifierThrottleSnap)
    const sourceAttempts = attemptsFor(sourceThrottleSnap)
    const globalAttempts = attemptsFor(globalThrottleSnap)
    const identifierThrottled = identifierAttempts.length >= MAX_IDENTIFIER_ATTEMPTS
    const sourceOrGlobalThrottled =
      sourceAttempts.length >= MAX_SOURCE_ATTEMPTS ||
      globalAttempts.length >= MAX_GLOBAL_ATTEMPTS
    if (sourceOrGlobalThrottled) {
      return null
    }

    const snapshot = await transaction.get(credentialRef)
    const logRef = firestore.collection(AUTH_LOG_COLLECTION).doc()
    const recordFailureBudgets = () => {
      if (!identifierThrottled) {
        transaction.set(identifierThrottleRef, {
          attempts: [...identifierAttempts, attemptTime].slice(-MAX_IDENTIFIER_ATTEMPTS),
          updatedAt: attemptTime,
        })
      }
      transaction.set(sourceThrottleRef, {
        attempts: [...sourceAttempts, attemptTime].slice(-MAX_SOURCE_ATTEMPTS),
        updatedAt: attemptTime,
      })
      transaction.set(globalThrottleRef, {
        attempts: [...globalAttempts, attemptTime].slice(-MAX_GLOBAL_ATTEMPTS),
        updatedAt: attemptTime,
      })
    }

    if (!snapshot.exists) {
      recordFailureBudgets()
      if (identifierThrottled) return null
      // Keep missing-ID and wrong-PIN responses similar without revealing
      // whether a credential document exists.
      await verifyHashedPin(pin, DUMMY_PIN_HASH)
      transaction.set(logRef, authenticationLog({
        loginId: normalizedLoginId,
        success: false,
        reason: 'invalid_credentials',
        timestamp: attemptTime,
      }))
      return null
    }

    const record = snapshot.data()
    const hasValidIdentity = record?.active === true
      && typeof record.authUid === 'string'
      && typeof record.classroomId === 'string'
      && typeof record.studentId === 'string'
    const hash = typeof record?.pinHash === 'string'
      ? record.pinHash
      : DUMMY_PIN_HASH

    if (!hasValidIdentity) {
      recordFailureBudgets()
      if (identifierThrottled) return null
      await verifyHashedPin(pin, hash)
      transaction.set(logRef, authenticationLog({
        loginId: normalizedLoginId,
        success: false,
        reason: 'invalid_credentials',
        timestamp: attemptTime,
        record,
      }))
      return null
    }

    const pinMatches = await verifyHashedPin(pin, hash)
    if (!pinMatches) {
      recordFailureBudgets()
      if (identifierThrottled) return null
      const previousAttempts = Math.max(0, Number(record.failedAttempts) || 0)
      const failedAttempts = Math.min(previousAttempts + 1, MAX_FAILED_ATTEMPTS)

      transaction.update(credentialRef, {
        failedAttempts,
        lockedUntil: null,
      })
      transaction.set(logRef, authenticationLog({
        loginId: normalizedLoginId,
        success: false,
        reason: 'invalid_credentials',
        timestamp: attemptTime,
        record,
      }))

      return null
    }

    transaction.set(identifierThrottleRef, {
      attempts: [],
      updatedAt: attemptTime,
    })
    transaction.update(credentialRef, {
      failedAttempts: 0,
      lockedUntil: null,
    })
    transaction.set(logRef, authenticationLog({
      loginId: normalizedLoginId,
      success: true,
      reason: 'success',
      timestamp: attemptTime,
      record,
    }))

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
