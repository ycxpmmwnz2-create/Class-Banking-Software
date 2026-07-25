import bcrypt from 'bcryptjs'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  CLASSROOM_LOGIN_CODE_STATUS,
  FIRESTORE_COLLECTIONS,
  TEACHER_STATUS,
} from '../phase1/firestoreSchema.js'
import {
  formatClassroomCode,
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

// Match the cost used by live credential hashes. A lower-cost dummy would
// create a measurable timing distinction between an unknown credential and a
// wrong PIN for an existing credential.
export const STUDENT_LOGIN_DUMMY_PIN_HASH =
  '$2b$12$tkuV.NIDy2kwjmeSTGNDruO5eIUvcNY3shJwjb9ijSRjCw5HgC4VW'
const LOCKOUT_DURATION_MS = 5 * 60 * 1000
const MAX_CREDENTIAL_FAILED_ATTEMPTS = 5
const THROTTLE_WINDOW_MS = 5 * 60 * 1000
const MAX_THROTTLE_ATTEMPTS = 10
const SUPPORTED_CREDENTIAL_SCHEMA_VERSION = 1

const GENERIC_STUDENT_LOGIN_MESSAGE = 'Invalid student credentials.'

export const STUDENT_LOGIN_OUTCOMES = Object.freeze({
  MALFORMED_REQUEST: 'malformed_request',
  INVALID_CODE_OR_LOGIN: 'invalid_code_or_login',
  THROTTLED: 'throttled',
  INVALID_CREDENTIALS: 'invalid_credentials',
  LOCKED: 'locked',
  SUCCESS: 'success',
})

export class StudentVerifierError extends Error {
  constructor(code = 'unauthenticated', message = GENERIC_STUDENT_LOGIN_MESSAGE) {
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

function optionalCanonicalId(value, fieldName) {
  if (typeof value !== 'string') {
    return null
  }
  try {
    return validateCanonicalDocumentId(value, fieldName)
  } catch {
    return null
  }
}

/**
 * Resolves the classroom code index, classroom root, and reciprocal owner
 * teacher inside the caller's transaction. Every read here happens before the
 * transaction performs any write, which real Firestore transactions require.
 *
 * The classroom code is a locator only: the classroom root must independently
 * name the same code, and the owner teacher must be exactly active and linked
 * both ways, so a forged code index cannot point at another tenant.
 */
async function resolveClassroomFromCode(transaction, firestore, canonicalCode) {
  const codeIndexRef = firestore.doc(classroomLoginCodePath(canonicalCode))
  const codeIndexSnap = await transaction.get(codeIndexRef)
  const codeIndexData = codeIndexSnap.exists ? (codeIndexSnap.data() ?? {}) : {}

  const isCodeActive =
    codeIndexSnap.exists &&
    codeIndexData.status === CLASSROOM_LOGIN_CODE_STATUS.ACTIVE

  const indexedClassroomId = isCodeActive
    ? optionalCanonicalId(codeIndexData.classroomId, 'classroomId')
    : null

  if (!indexedClassroomId) {
    return null
  }

  const classroomRef = firestore
    .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
    .doc(indexedClassroomId)
  const classroomSnap = await transaction.get(classroomRef)
  const classroomData = classroomSnap.exists ? (classroomSnap.data() ?? {}) : null

  const ownerUid = classroomData
    ? optionalCanonicalId(classroomData.ownerUid, 'ownerUid')
    : null

  if (!ownerUid) {
    return null
  }

  const teacherRef = firestore
    .collection(FIRESTORE_COLLECTIONS.TEACHERS)
    .doc(ownerUid)
  const teacherSnap = await transaction.get(teacherRef)
  const teacherData = teacherSnap.exists ? (teacherSnap.data() ?? {}) : null

  const codeBindingMatches =
    classroomData.studentLoginCode === formatClassroomCode(canonicalCode)

  const foundationValid =
    codeBindingMatches &&
    teacherData !== null &&
    teacherData.status === TEACHER_STATUS.ACTIVE &&
    teacherData.uid === ownerUid &&
    teacherData.classroomId === indexedClassroomId

  return foundationValid ? { classroomId: indexedClassroomId } : null
}

function isCredentialIdentityValid({
  credSnap,
  credData,
  classroomId,
  canonicalLoginId,
  studentId,
}) {
  if (studentId === null) {
    return false
  }
  // The credential is read by exact scoped path, so the document ID is the
  // canonical login ID. A body `loginId` that disagrees is a forged or
  // mis-copied credential. Legacy flat credentials predate the field, so
  // absence is tolerated while any present value must match exactly.
  if (credSnap.id !== canonicalLoginId) {
    return false
  }
  if (credData.loginId !== undefined && credData.loginId !== canonicalLoginId) {
    return false
  }
  if (credData.active !== true) {
    return false
  }
  if (credData.classroomId !== classroomId) {
    return false
  }
  if (credData.authUid !== deriveDeterministicStudentAuthUid(classroomId, studentId)) {
    return false
  }
  if (credData.schemaVersion !== SUPPORTED_CREDENTIAL_SCHEMA_VERSION) {
    return false
  }
  // A missing or non-string PIN hash must fail closed. Substituting the shared
  // dummy hash here would make the timing-defense constant a live credential.
  if (typeof credData.pinHash !== 'string' || !credData.pinHash) {
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

  const tokenFactory = typeof createCustomToken === 'function'
    ? createCustomToken
    : (auth && typeof auth.createCustomToken === 'function'
        ? (uid, claims) => auth.createCustomToken(uid, claims)
        : null)

  if (!tokenFactory) {
    throw new TypeError(
      'createCustomToken dependency or auth with createCustomToken is required.',
    )
  }

  const attemptTime = now()
  const shapeValid = validateRequestShape(request)
  const submittedPin = shapeValid ? request.pin : ''

  const rawCode = typeof request?.classroomCode === 'string'
    ? request.classroomCode
    : null
  const rawLoginId = typeof request?.loginId === 'string' ? request.loginId : null

  // Normalization is attempted whenever the field is a string, independent of
  // the overall request shape, so a malformed request still lands in the same
  // throttle bucket as a well-formed one for the same identifiers.
  let canonicalCode = null
  let canonicalLoginId = null
  if (rawCode !== null) {
    try {
      canonicalCode = normalizeClassroomCode(rawCode)
    } catch {
      canonicalCode = null
    }
  }
  if (rawLoginId !== null) {
    try {
      canonicalLoginId = normalizeStudentLoginId(rawLoginId)
    } catch {
      canonicalLoginId = null
    }
  }
  const normalizationFailed =
    shapeValid && (canonicalCode === null || canonicalLoginId === null)

  // The digest throttle must cover resolved *and* unresolved attempts, so the
  // bucket identity falls back to the raw submitted strings when normalization
  // fails. Only the one-way digest is persisted; no raw code, login ID, or PIN
  // reaches a document ID or log body.
  const throttleCodeKey = canonicalCode ?? rawCode ?? ''
  const throttleLoginKey = canonicalLoginId ?? rawLoginId ?? ''
  const identifierDigest = hashSha256(`${throttleCodeKey}\0${throttleLoginKey}`)
  const throttleRef = firestore.doc(studentLoginThrottlePath(identifierDigest))

  const result = await firestore.runTransaction(async (transaction) => {
    // ---------------------------------------------------------------------
    // Phase 1: every read. Firestore rejects a transaction read that follows
    // a write in the same transaction, so nothing below may write yet.
    // ---------------------------------------------------------------------
    const throttleSnap = await transaction.get(throttleRef)
    const throttleData = throttleSnap.exists ? (throttleSnap.data() ?? {}) : {}
    const recordedAttempts = Array.isArray(throttleData.attempts)
      ? throttleData.attempts
      : []
    const attemptsInWindow = recordedAttempts.filter(
      t => typeof t === 'number' && attemptTime - t < THROTTLE_WINDOW_MS,
    )

    const resolved = shapeValid && canonicalCode && canonicalLoginId
      ? await resolveClassroomFromCode(transaction, firestore, canonicalCode)
      : null
    const classroomId = resolved?.classroomId ?? null

    let credSnap = null
    if (classroomId) {
      const credRef = firestore.doc(
        studentCredentialPath(classroomId, canonicalLoginId),
      )
      credSnap = await transaction.get(credRef)
    }

    // ---------------------------------------------------------------------
    // Phase 2: decisions, including the single bcrypt comparison for a valid
    // credential. No Firestore read may occur past this point.
    // ---------------------------------------------------------------------
    const isThrottled = attemptsInWindow.length >= MAX_THROTTLE_ATTEMPTS

    let outcome
    let credRefToUpdate = null
    let credUpdate = null
    let studentId = null
    let dummyCompareNeeded = true

    if (isThrottled) {
      outcome = STUDENT_LOGIN_OUTCOMES.THROTTLED
    } else if (!shapeValid) {
      outcome = STUDENT_LOGIN_OUTCOMES.MALFORMED_REQUEST
    } else if (normalizationFailed) {
      outcome = STUDENT_LOGIN_OUTCOMES.INVALID_CODE_OR_LOGIN
    } else if (!classroomId || !credSnap?.exists) {
      outcome = STUDENT_LOGIN_OUTCOMES.INVALID_CREDENTIALS
    } else {
      const credData = credSnap.data() ?? {}
      studentId = optionalCanonicalId(credData.studentId, 'studentId')

      if (
        !isCredentialIdentityValid({
          credSnap,
          credData,
          classroomId,
          canonicalLoginId,
          studentId,
        })
      ) {
        // studentId is only logged when the credential itself resolved a
        // canonical one; an unusable credential still logs nothing else.
        outcome = STUDENT_LOGIN_OUTCOMES.INVALID_CREDENTIALS
      } else {
        const lockedUntilMillis = timestampMillis(credData.lockedUntil)
        const isLocked = lockedUntilMillis > attemptTime
        const hasExpiredLock = lockedUntilMillis > 0 && !isLocked

        if (isLocked) {
          outcome = STUDENT_LOGIN_OUTCOMES.LOCKED
        } else {
          const pinMatches = await verifyPin(submittedPin, credData.pinHash)
          dummyCompareNeeded = false
          credRefToUpdate = credSnap.ref ?? firestore.doc(
            studentCredentialPath(classroomId, canonicalLoginId),
          )

          if (pinMatches) {
            outcome = STUDENT_LOGIN_OUTCOMES.SUCCESS
            credUpdate = {
              failedAttempts: 0,
              lockedUntil: null,
              updatedAt: attemptTime,
            }
          } else {
            const previousAttempts = hasExpiredLock
              ? 0
              : (typeof credData.failedAttempts === 'number'
                  ? credData.failedAttempts
                  : 0)
            const failedAttempts = previousAttempts + 1
            const willLock = failedAttempts >= MAX_CREDENTIAL_FAILED_ATTEMPTS
            credUpdate = {
              failedAttempts,
              lockedUntil: willLock ? attemptTime + LOCKOUT_DURATION_MS : null,
              updatedAt: attemptTime,
            }
            outcome = willLock
              ? STUDENT_LOGIN_OUTCOMES.LOCKED
              : STUDENT_LOGIN_OUTCOMES.INVALID_CREDENTIALS
          }
        }
      }
    }

    // ---------------------------------------------------------------------
    // Phase 3: writes only.
    // ---------------------------------------------------------------------
    if (!isThrottled) {
      // Rejected attempts are deliberately not appended: the window stays a
      // true rolling five minutes and the stored array cannot grow without
      // bound under a flood.
      transaction.set(throttleRef, {
        attempts: [...attemptsInWindow, attemptTime].slice(-MAX_THROTTLE_ATTEMPTS),
        updatedAt: attemptTime,
      })
    }

    // Known-classroom attempts, throttled ones included, belong to that
    // tenant's scoped log; only genuinely unresolved codes use the
    // server-private unresolved collection.
    const logCollectionPath = classroomId
      ? studentAuthLogsCollectionPath(classroomId)
      : studentAuthUnresolvedLogsCollectionPath()
    const logRef = firestore.collection(logCollectionPath).doc()

    transaction.set(logRef, {
      outcome,
      timestamp: attemptTime,
      identifierDigest,
      success: outcome === STUDENT_LOGIN_OUTCOMES.SUCCESS,
      ...(studentId ? { studentId } : {}),
    })

    if (credRefToUpdate && credUpdate) {
      transaction.update(credRefToUpdate, credUpdate)
    }

    if (outcome !== STUDENT_LOGIN_OUTCOMES.SUCCESS) {
      return Object.freeze({ success: false, outcome, dummyPin: dummyCompareNeeded })
    }

    // Only verified identity material leaves the transaction. Custom-token
    // creation is an external side effect and must not run inside a callback
    // Firestore may retry.
    return Object.freeze({
      success: true,
      outcome,
      authUid: deriveDeterministicStudentAuthUid(classroomId, studentId),
      claims: Object.freeze({
        role: 'student',
        classroomId,
        studentId,
      }),
    })
  })

  if (!result.success) {
    if (result.dummyPin) {
      await verifyPin(submittedPin, STUDENT_LOGIN_DUMMY_PIN_HASH)
    }
    throw new StudentVerifierError()
  }

  const token = await tokenFactory(result.authUid, result.claims)

  return Object.freeze({
    success: true,
    authUid: result.authUid,
    claims: result.claims,
    token,
  })
}

/**
 * Versioned callable adapter. Item 8 owns the gated `studentPinLoginV2`
 * export; this boundary only guarantees that a browser sees one generic
 * `HttpsError` for every failure category, so malformed codes, unknown
 * classrooms, wrong PINs, inactive records, lockouts, and throttling stay
 * indistinguishable and nothing internal leaks.
 */
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
      throw new HttpsError('unauthenticated', GENERIC_STUDENT_LOGIN_MESSAGE)
    }
    throw new HttpsError('internal', 'An unexpected internal error occurred.')
  }
}
