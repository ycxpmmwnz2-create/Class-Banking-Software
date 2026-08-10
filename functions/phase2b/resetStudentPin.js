import bcrypt from 'bcryptjs'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  resolveActiveTeacherTenant,
  TeacherTenantResolverError,
} from './teacherTenantResolver.js'
import {
  normalizeStudentLoginId,
  validateCanonicalDocumentId,
} from './identityNormalization.js'
import { STUDENT_CREDENTIAL_COLLECTIONS } from './studentCredentialPaths.js'
import { deriveDeterministicStudentAuthUid } from './scopedCredentialProjection.js'
import {
  buildStudentPinDocument,
  studentPinCollection,
} from '../phase3/studentPinDirectory.js'

const ASCII_FOUR_DIGITS_REGEX = /^[0-9]{4}$/
const SUPPORTED_CREDENTIAL_SCHEMA_VERSION = 1

/**
 * The existing reset contract hashes at cost 12
 * (`functions/resetStudentPin.js:6`), and Phase 2B preserves the existing
 * bcrypt behavior rather than weakening it for the scoped path.
 */
export const STUDENT_PIN_BCRYPT_COST = 12

/**
 * Only these messages reach a browser. Service messages name document paths,
 * identity findings, and resolver states; forwarding them would expose internal
 * structure and let a caller distinguish foundation failure modes.
 */
const GENERIC_CLIENT_MESSAGES = Object.freeze({
  'unauthenticated': 'Sign in required.',
  'permission-denied': 'This account is not eligible to complete this action.',
  'invalid-argument': 'The request was invalid.',
  'not-found': 'That student was not found in your classroom.',
  'failed-precondition':
    'This student record cannot be updated automatically. Contact your administrator for assistance.',
  'aborted': 'The request could not be completed. Please try again.',
  'internal': 'An unexpected internal error occurred.',
})

export class ResetStudentPinError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ResetStudentPinError'
    this.code = code
  }
}

export async function defaultHashPin(pin) {
  return await bcrypt.hash(pin, STUDENT_PIN_BCRYPT_COST)
}

function credentialVersionMillis(value) {
  let candidate = value
  try {
    if (typeof value?.toMillis === 'function') candidate = value.toMillis()
    else if (value instanceof Date) candidate = value.getTime()
  } catch {
    return 0
  }
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 0
}

function assertScopedCredentialIdentity({
  credDocSnap,
  credData,
  classroomId,
  studentId,
}) {
  let canonicalLoginId
  try {
    canonicalLoginId = normalizeStudentLoginId(credDocSnap.id)
  } catch {
    canonicalLoginId = null
  }

  const identityMatches =
    canonicalLoginId === credDocSnap.id &&
    (credData.loginId === undefined || credData.loginId === canonicalLoginId) &&
    credData.studentId === studentId &&
    credData.classroomId === classroomId &&
    credData.authUid === deriveDeterministicStudentAuthUid(classroomId, studentId) &&
    credData.schemaVersion === SUPPORTED_CREDENTIAL_SCHEMA_VERSION

  if (!identityMatches) {
    // A malformed or forged credential is an integrity failure to be
    // reconciled administratively, never repaired by an ordinary reset.
    throw new ResetStudentPinError(
      'failed-precondition',
      'Credential document identity mismatch.',
    )
  }
}

export async function resetStudentPinV2(
  request,
  {
    firestore,
    auth,
    hashPin = defaultHashPin,
    now = Date.now,
  } = {},
) {
  if (typeof request !== 'object' || request === null) {
    throw new ResetStudentPinError(
      'invalid-argument',
      'Request must be a non-null object.',
    )
  }

  const keys = Object.keys(request)
  const allowedKeys = ['studentId', 'newPin']
  if (keys.some(k => !allowedKeys.includes(k))) {
    throw new ResetStudentPinError(
      'invalid-argument',
      'Request contains unknown or unauthorized fields.',
    )
  }

  if (typeof request.studentId !== 'string') {
    throw new ResetStudentPinError(
      'invalid-argument',
      'studentId must be a string.',
    )
  }

  let validStudentId
  try {
    validStudentId = validateCanonicalDocumentId(request.studentId, 'studentId')
  } catch (error) {
    throw new ResetStudentPinError(
      'invalid-argument',
      `studentId is malformed: ${error.message}`,
    )
  }

  if (
    typeof request.newPin !== 'string' ||
    !ASCII_FOUR_DIGITS_REGEX.test(request.newPin)
  ) {
    throw new ResetStudentPinError(
      'invalid-argument',
      'newPin must be exactly 4 ASCII digits.',
    )
  }

  const tenant = await resolveActiveTeacherTenant({ firestore, auth })
  const classroomId = tenant.classroomId
  const attemptTime = now()
  if (!Number.isSafeInteger(attemptTime) || attemptTime < 1) {
    throw new ResetStudentPinError('internal', 'Server clock is unavailable.')
  }

  // Hashing happens once, outside the transaction: a retried transaction
  // callback must not repeat an expensive bcrypt round, and the hash is never
  // logged.
  const pinHash = await hashPin(request.newPin)

  const credColRef = firestore
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_CREDENTIALS)

  const query = credColRef.where('studentId', '==', validStudentId).limit(2)

  return await firestore.runTransaction(async (transaction) => {
    // All reads precede the single write, as Firestore transactions require.
    const credQuerySnap = await transaction.get(query)

    if (credQuerySnap.empty || credQuerySnap.docs.length === 0) {
      throw new ResetStudentPinError(
        'not-found',
        'Student credential document not found in classroom.',
      )
    }

    if (credQuerySnap.docs.length > 1) {
      throw new ResetStudentPinError(
        'failed-precondition',
        'Multiple credential documents found for studentId in classroom.',
      )
    }

    const credDocSnap = credQuerySnap.docs[0]
    const credRef = credDocSnap.ref
    const credData = credDocSnap.data() ?? {}

    const studentDocRef = firestore
      .collection(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS)
      .doc(classroomId)
      .collection('students')
      .doc(validStudentId)

    const studentSnap = await transaction.get(studentDocRef)
    if (!studentSnap.exists) {
      throw new ResetStudentPinError(
        'not-found',
        'Student document not found in classroom.',
      )
    }

    assertScopedCredentialIdentity({
      credDocSnap,
      credData,
      classroomId,
      studentId: validStudentId,
      authUid: credData.authUid,
    })
    const priorCredentialVersion = credentialVersionMillis(credData.pinUpdatedAt)
    if (priorCredentialVersion >= Number.MAX_SAFE_INTEGER) {
      throw new ResetStudentPinError('failed-precondition', 'Credential version is exhausted.')
    }
    const pinUpdatedAt = Math.max(attemptTime, priorCredentialVersion + 1)

    // Update allowlist: PIN, activation, lockout, and timestamps only. Identity
    // and ownership fields are never rewritten by a reset.
    transaction.update(credRef, {
      pinHash,
      active: true,
      pinUpdatedAt,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: attemptTime,
    })

    // The teacher-visible mirror, written in the same transaction so the shown
    // PIN and the hash that actually authenticates can never disagree. `set`
    // rather than `update`: a student created before this directory existed has
    // no document yet, and their first reset is exactly what makes their PIN
    // visible.
    transaction.set(
      studentPinCollection(firestore, classroomId).doc(validStudentId),
      buildStudentPinDocument({
        studentId: validStudentId,
        pin: request.newPin,
        timestamp: pinUpdatedAt,
      }),
    )

    return Object.freeze({
      success: true,
      classroomId,
      studentId: validStudentId,
      authUid: credData.authUid,
    })
  })
}

function externalCodeFor(error) {
  if (error instanceof TeacherTenantResolverError) {
    switch (error.code) {
      case 'unauthenticated':
      case 'invalid-auth-uid':
        return 'unauthenticated'
      case 'teacher-not-found':
      case 'teacher-disabled':
        return 'permission-denied'
      default:
        // Every other resolver state — invalid status, UID mismatch, malformed
        // or missing classroom, owner mismatch — is inconsistent foundation
        // data and must not be distinguishable from any other.
        return 'failed-precondition'
    }
  }

  if (error instanceof ResetStudentPinError) {
    return Object.prototype.hasOwnProperty.call(GENERIC_CLIENT_MESSAGES, error.code)
      ? error.code
      : 'internal'
  }

  return 'internal'
}

async function revokeStudentRefreshTokens(adminAuth, authUid) {
  try {
    await adminAuth.revokeRefreshTokens(authUid)
  } catch (error) {
    // A deterministic student UID has no Auth record until its first custom-
    // token sign-in. In that state there is no refresh token to revoke, so the
    // reset is already session-safe. Every other Auth failure remains fatal.
    if (error?.code !== 'auth/user-not-found') throw error
  }
}

/**
 * Versioned callable adapter. Item 8 owns the gated `resetStudentPinV2`
 * export; this boundary guarantees the browser only ever sees an allowlisted
 * code with a fixed generic message and no `details` payload.
 */
export async function resetStudentPinV2CallableHandler(
  data,
  context,
  dependencies = {},
) {
  const auth = context?.auth
  try {
    if (!dependencies.adminAuth ||
        typeof dependencies.adminAuth.revokeRefreshTokens !== 'function') {
      throw new ResetStudentPinError('internal', 'Admin Auth revocation is unavailable.')
    }
    const result = await resetStudentPinV2(data, { ...dependencies, auth })
    await revokeStudentRefreshTokens(dependencies.adminAuth, result.authUid)
    return { success: result.success }
  } catch (error) {
    const code = externalCodeFor(error)
    throw new HttpsError(code, GENERIC_CLIENT_MESSAGES[code])
  }
}
