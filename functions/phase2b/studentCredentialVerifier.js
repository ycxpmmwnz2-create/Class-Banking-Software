import bcrypt from 'bcryptjs'
import {
  CLASSROOM_LOGIN_CODE_STATUS,
  FIRESTORE_COLLECTIONS,
  TEACHER_STATUS,
} from '../phase1/firestoreSchema.js'
import {
  hashSha256,
  normalizeClassroomCode,
  normalizeStudentLoginId,
  validateCanonicalDocumentId,
} from './identityNormalization.js'
import {
  classroomLoginCodePath,
  studentAuthLogsCollectionPath,
  studentAuthUnresolvedLogsCollectionPath,
  studentCredentialPath,
  studentLoginThrottlePath,
} from './studentCredentialPaths.js'
import { deriveDeterministicStudentAuthUid } from './scopedCredentialProjection.js'

const DUMMY_PIN_HASH =
  '$2b$10$Ds5wfuAE9LT3Xe4vdygSMu1VUq0m8830nB5uQauQ0105kP4WDUR.a'
const LOCKOUT_DURATION_MS = 5 * 60 * 1000
const MAX_CREDENTIAL_FAILED_ATTEMPTS = 5
const THROTTLE_WINDOW_MS = 5 * 60 * 1000
const MAX_THROTTLE_ATTEMPTS = 10

export class StudentVerifierError extends Error {
  constructor(code = 'unauthenticated', message = 'Invalid student credentials.') {
    super(message)
    this.name = 'StudentVerifierError'
    this.code = code
  }
}

export async function defaultVerifyPin(submittedPin, storedHash) {
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
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return 0
}

function validateRequestShape(request) {
  if (typeof request !== 'object' || request === null) {
    return false
  }
  const keys = Object.keys(request)
  const allowedKeys = ['classroomCode', 'loginId', 'pin']
  if (keys.some(k => !allowedKeys.includes(k))) {
    return false
  }
  if (
    typeof request.classroomCode !== 'string' ||
    typeof request.loginId !== 'string' ||
    typeof request.pin !== 'string'
  ) {
    return false
  }
  return true
}

export async function verifyStudentCredentialV2(
  request,
  {
    firestore,
    auth,
    now = Date.now,
    verifyPin = defaultVerifyPin,
    createCustomToken,
  } = {},
) {
  if (!firestore || typeof firestore.runTransaction !== 'function') {
    throw new TypeError('firestore with runTransaction method is required.')
  }

  const attemptTime = now()

  if (!validateRequestShape(request)) {
    // Write unresolved log for malformed request
    try {
      const unresolvedLogRef = firestore
        .collection(studentAuthUnresolvedLogsCollectionPath())
        .doc()
      if (typeof unresolvedLogRef.set === 'function') {
        await unresolvedLogRef.set({
          outcome: 'malformed_request',
          timestamp: attemptTime,
          identifierDigest: hashSha256('malformed'),
          success: false,
        })
      }
    } catch {
      // Ignore logging failure on malformed request
    }
    await verifyPin(request?.pin ?? '', DUMMY_PIN_HASH)
    throw new StudentVerifierError()
  }

  let canonicalCode
  let canonicalLoginId
  try {
    canonicalCode = normalizeClassroomCode(request.classroomCode)
    canonicalLoginId = normalizeStudentLoginId(request.loginId)
  } catch {
    try {
      const unresolvedLogRef = firestore
        .collection(studentAuthUnresolvedLogsCollectionPath())
        .doc()
      if (typeof unresolvedLogRef.set === 'function') {
        await unresolvedLogRef.set({
          outcome: 'invalid_code_or_login',
          timestamp: attemptTime,
          identifierDigest: hashSha256('invalid'),
          success: false,
        })
      }
    } catch {
      // Ignore logging failure on normalization error
    }
    await verifyPin(request.pin, DUMMY_PIN_HASH)
    throw new StudentVerifierError()
  }

  const identifierDigest = hashSha256(`${canonicalCode}\0${canonicalLoginId}`)
  const throttlePath = studentLoginThrottlePath(identifierDigest)
  const throttleRef = firestore.doc(throttlePath)

  const txResult = await firestore.runTransaction(async (transaction) => {
    // 1. Read throttle document
    const throttleSnap = await transaction.get(throttleRef)
    const throttleData = throttleSnap.exists ? (throttleSnap.data() ?? {}) : {}
    const rawAttempts = Array.isArray(throttleData.attempts)
      ? throttleData.attempts
      : []

    const activeThrottleAttempts = rawAttempts.filter(
      t => typeof t === 'number' && attemptTime - t < THROTTLE_WINDOW_MS,
    )

    if (activeThrottleAttempts.length >= MAX_THROTTLE_ATTEMPTS) {
      const newAttempts = [...activeThrottleAttempts, attemptTime]
      transaction.set(throttleRef, {
        attempts: newAttempts,
        updatedAt: attemptTime,
      })

      const unresolvedLogRef = firestore
        .collection(studentAuthUnresolvedLogsCollectionPath())
        .doc()
      transaction.set(unresolvedLogRef, {
        outcome: 'throttled',
        timestamp: attemptTime,
        identifierDigest,
        success: false,
      })

      return { success: false, dummyPin: true }
    }

    // Record this attempt in throttle bucket
    const updatedThrottleAttempts = [...activeThrottleAttempts, attemptTime]
    transaction.set(throttleRef, {
      attempts: updatedThrottleAttempts,
      updatedAt: attemptTime,
    })

    // 2. Resolve classroom code index
    const codeIndexPath = classroomLoginCodePath(canonicalCode)
    const codeIndexRef = firestore.doc(codeIndexPath)
    const codeIndexSnap = await transaction.get(codeIndexRef)

    const codeIndexData = codeIndexSnap.exists
      ? (codeIndexSnap.data() ?? {})
      : {}
    const isCodeActive =
      codeIndexSnap.exists &&
      codeIndexData.status === CLASSROOM_LOGIN_CODE_STATUS.ACTIVE

    let validClassroomId = null
    if (isCodeActive && typeof codeIndexData.classroomId === 'string') {
      try {
        validClassroomId = validateCanonicalDocumentId(
          codeIndexData.classroomId,
          'classroomId',
        )
      } catch {
        validClassroomId = null
      }
    }

    // 3. Resolve classroom & teacher foundation if code is valid
    let validOwnerUid = null
    let classroomData = null
    let teacherData = null

    if (validClassroomId) {
      const classroomRef = firestore
        .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
        .doc(validClassroomId)
      const classroomSnap = await transaction.get(classroomRef)

      if (classroomSnap.exists) {
        classroomData = classroomSnap.data() ?? {}
        if (typeof classroomData.ownerUid === 'string') {
          try {
            validOwnerUid = validateCanonicalDocumentId(
              classroomData.ownerUid,
              'ownerUid',
            )
          } catch {
            validOwnerUid = null
          }
        }
      }

      if (validOwnerUid) {
        const teacherRef = firestore
          .collection(FIRESTORE_COLLECTIONS.TEACHERS)
          .doc(validOwnerUid)
        const teacherSnap = await transaction.get(teacherRef)

        if (teacherSnap.exists) {
          teacherData = teacherSnap.data() ?? {}
        }
      }
    }

    const isFoundationValid =
      validClassroomId !== null &&
      validOwnerUid !== null &&
      classroomData !== null &&
      teacherData !== null &&
      teacherData.status === TEACHER_STATUS.ACTIVE &&
      teacherData.uid === validOwnerUid &&
      teacherData.classroomId === validClassroomId

    if (!isFoundationValid) {
      const unresolvedLogRef = firestore
        .collection(studentAuthUnresolvedLogsCollectionPath())
        .doc()
      transaction.set(unresolvedLogRef, {
        outcome: 'invalid_credentials',
        timestamp: attemptTime,
        identifierDigest,
        success: false,
      })

      return { success: false, dummyPin: true }
    }

    // 4. Read scoped credential document
    const credPath = studentCredentialPath(validClassroomId, canonicalLoginId)
    const credRef = firestore.doc(credPath)
    const credSnap = await transaction.get(credRef)

    const logCollectionRef = firestore.collection(
      studentAuthLogsCollectionPath(validClassroomId),
    )
    const resolvedLogRef = logCollectionRef.doc()

    if (!credSnap.exists) {
      transaction.set(resolvedLogRef, {
        outcome: 'invalid_credentials',
        timestamp: attemptTime,
        identifierDigest,
        success: false,
      })
      return { success: false, dummyPin: true }
    }

    const credData = credSnap.data() ?? {}

    let validStudentId = null
    if (typeof credData.studentId === 'string') {
      try {
        validStudentId = validateCanonicalDocumentId(
          credData.studentId,
          'studentId',
        )
      } catch {
        validStudentId = null
      }
    }

    const expectedAuthUid = validStudentId
      ? deriveDeterministicStudentAuthUid(validClassroomId, validStudentId)
      : null

    const isCredentialValid =
      credData.active === true &&
      credData.classroomId === validClassroomId &&
      validStudentId !== null &&
      credData.authUid === expectedAuthUid &&
      credData.schemaVersion === 1

    if (!isCredentialValid) {
      transaction.set(resolvedLogRef, {
        outcome: 'invalid_credentials',
        timestamp: attemptTime,
        identifierDigest,
        success: false,
        ...(validStudentId ? { studentId: validStudentId } : {}),
      })
      return { success: false, dummyPin: true }
    }

    // 5. Credential lockout check
    const lockedUntilMillis = timestampMillis(credData.lockedUntil)
    const isLocked = lockedUntilMillis > attemptTime
    const hasExpiredLock = lockedUntilMillis > 0 && !isLocked

    if (isLocked) {
      transaction.set(resolvedLogRef, {
        outcome: 'locked',
        timestamp: attemptTime,
        identifierDigest,
        success: false,
        studentId: validStudentId,
      })
      return { success: false, dummyPin: true }
    }

    // 6. PIN verification
    const storedPinHash =
      typeof credData.pinHash === 'string' ? credData.pinHash : DUMMY_PIN_HASH
    const pinMatches = await verifyPin(request.pin, storedPinHash)

    if (!pinMatches) {
      const currentFailedAttempts = hasExpiredLock
        ? 0
        : typeof credData.failedAttempts === 'number'
          ? credData.failedAttempts
          : 0
      const newFailedAttempts = currentFailedAttempts + 1
      const willLock = newFailedAttempts >= MAX_CREDENTIAL_FAILED_ATTEMPTS
      const newLockedUntil = willLock ? attemptTime + LOCKOUT_DURATION_MS : null

      transaction.update(credRef, {
        failedAttempts: newFailedAttempts,
        lockedUntil: newLockedUntil,
        updatedAt: attemptTime,
      })

      transaction.set(resolvedLogRef, {
        outcome: willLock ? 'locked' : 'invalid_credentials',
        timestamp: attemptTime,
        identifierDigest,
        success: false,
        studentId: validStudentId,
      })

      return { success: false, dummyPin: false }
    }

    // 7. Success! Reset credential lock & failed attempts
    transaction.update(credRef, {
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: attemptTime,
    })

    transaction.set(resolvedLogRef, {
      outcome: 'success',
      timestamp: attemptTime,
      identifierDigest,
      success: true,
      studentId: validStudentId,
    })

    const customClaims = Object.freeze({
      role: 'student',
      classroomId: validClassroomId,
      studentId: validStudentId,
    })

    let token = null
    if (typeof createCustomToken === 'function') {
      token = await createCustomToken(credData.authUid, customClaims)
    } else if (auth && typeof auth.createCustomToken === 'function') {
      token = await auth.createCustomToken(credData.authUid, customClaims)
    }

    return Object.freeze({
      success: true,
      authUid: credData.authUid,
      claims: customClaims,
      token,
    })
  })

  if (!txResult.success) {
    if (txResult.dummyPin) {
      await verifyPin(request.pin, DUMMY_PIN_HASH)
    }
    throw new StudentVerifierError()
  }

  return txResult
}

export async function studentPinLoginV2CallableHandler(
  data,
  context,
  dependencies = {},
) {
  try {
    const result = await verifyStudentCredentialV2(data, dependencies)
    return { token: result.token }
  } catch (error) {
    if (error instanceof StudentVerifierError) {
      const httpsError = new Error('Invalid student credentials.')
      httpsError.code = 'unauthenticated'
      throw httpsError
    }
    throw error
  }
}
