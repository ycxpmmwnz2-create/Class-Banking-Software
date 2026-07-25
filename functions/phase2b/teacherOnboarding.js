import { randomInt } from 'node:crypto'

import { FieldValue } from 'firebase-admin/firestore'

import {
  CLASSROOM_LOGIN_CODE_STATUS,
  FIRESTORE_COLLECTIONS,
  INVITATION_STATUS,
  TEACHER_STATUS,
} from '../phase1/firestoreSchema.js'
import {
  buildClassroomDocument,
  buildTeacherDocument,
} from '../phase1/teacherClassroomModels.js'
import {
  CLASSROOM_CODE_ALPHABET,
  formatClassroomCode,
  hashEmailDigest,
  normalizeClassroomCode,
  normalizeClassroomName,
  normalizeDisplayName,
  normalizeEmail,
} from './identityNormalization.js'
import {
  TeacherTenantResolverError,
  resolveActiveTeacherTenant,
  validateCanonicalDocumentId,
} from './teacherTenantResolver.js'

export class TeacherOnboardingError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TeacherOnboardingError'
    this.code = code
  }
}

/**
 * Classroom login codes are student-facing locators. A predictable generator
 * would let an outsider guess live classroom codes, so the default draws from a
 * CSPRNG. `randomInt` is rejection-sampled by Node, so the 32-character
 * alphabet stays uniformly distributed.
 */
export function generateClassroomCode() {
  let result = ''
  for (let index = 0; index < 8; index += 1) {
    result += CLASSROOM_CODE_ALPHABET[randomInt(CLASSROOM_CODE_ALPHABET.length)]
  }
  return result
}

/**
 * Converts an injected wall-clock reading or a stored `expiresAt` field into
 * finite epoch milliseconds. Returns null for anything unusable — including a
 * `FieldValue.serverTimestamp()` sentinel, which is a write-time transform and
 * carries no readable time — so callers can fail closed instead of comparing
 * against NaN.
 */
function toEpochMillis(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (value instanceof Date) {
    const millis = value.getTime()
    return Number.isFinite(millis) ? millis : null
  }
  if (value && typeof value.toMillis === 'function') {
    const millis = value.toMillis()
    return typeof millis === 'number' && Number.isFinite(millis) ? millis : null
  }
  return null
}

function isWellFormedUnicode(value) {
  if (typeof String.prototype.isWellFormed === 'function') {
    return value.isWellFormed()
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (
        index + 1 >= value.length ||
        nextCodeUnit < 0xDC00 ||
        nextCodeUnit > 0xDFFF
      ) {
        return false
      }
      index += 1
      continue
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false
    }
  }
  return true
}

function validateUid(uid) {
  if (typeof uid !== 'string' || !uid) {
    throw new TeacherOnboardingError('unauthenticated', 'Authentication UID is required.')
  }
  if (uid.trim() !== uid || uid.includes('/') || !isWellFormedUnicode(uid)) {
    throw new TeacherOnboardingError('unauthenticated', 'Authentication UID is malformed.')
  }
  return uid
}

export async function onboardTeacherClassroomService({
  firestore,
  auth,
  data,
  codeGenerator = generateClassroomCode,
  // Deliberately two distinct dependencies. `now` must yield a readable current
  // time for expiry decisions; `serverTimestamp` yields the write-time sentinel
  // stored in documents. A serverTimestamp sentinel is not a readable clock, so
  // conflating them silently defeats invitation expiry.
  now = () => Date.now(),
  serverTimestamp = FieldValue.serverTimestamp,
}) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('firestore with a collection method is required.')
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function returning the current time.')
  }
  if (typeof serverTimestamp !== 'function') {
    throw new TypeError('serverTimestamp must be a function returning a write timestamp.')
  }
  if (!auth || typeof auth !== 'object') {
    throw new TeacherOnboardingError('unauthenticated', 'Authentication required.')
  }

  const uid = validateUid(auth.uid)
  const token = auth.token ?? {}

  if (token.email_verified !== true) {
    throw new TeacherOnboardingError('permission-denied', 'Verified email required.')
  }

  if (token.firebase?.sign_in_provider !== 'google.com') {
    throw new TeacherOnboardingError(
      'permission-denied',
      'Google sign-in provider required.',
    )
  }

  const rawEmail = token.email
  let normalizedEmail
  try {
    normalizedEmail = normalizeEmail(rawEmail)
  } catch {
    throw new TeacherOnboardingError('permission-denied', 'Valid email required.')
  }

  let displayName = ''
  if (typeof token.name === 'string' && token.name.length > 0) {
    try {
      displayName = normalizeDisplayName(token.name)
    } catch {
      throw new TeacherOnboardingError('invalid-argument', 'Invalid token display name.')
    }
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new TeacherOnboardingError('invalid-argument', 'Request data must be an object.')
  }

  const allowedKeys = ['classroomName']
  for (const key of Object.keys(data)) {
    if (!allowedKeys.includes(key)) {
      throw new TeacherOnboardingError(
        'invalid-argument',
        `Unknown request field: ${key}`,
      )
    }
  }

  let normalizedClassroomName
  try {
    normalizedClassroomName = normalizeClassroomName(data.classroomName)
  } catch {
    throw new TeacherOnboardingError('invalid-argument', 'Invalid classroomName.')
  }

  const emailDigest = hashEmailDigest(normalizedEmail)

  return firestore.runTransaction(async transaction => {
    const teacherRef = firestore
      .collection(FIRESTORE_COLLECTIONS.TEACHERS)
      .doc(uid)
    const teacherSnap = await transaction.get(teacherRef)

    if (teacherSnap.exists) {
      const teacherData = teacherSnap.data() ?? {}

      if (teacherData.status === TEACHER_STATUS.DISABLED) {
        throw new TeacherOnboardingError(
          'permission-denied',
          'Teacher account is disabled.',
        )
      }

      if (teacherData.status !== TEACHER_STATUS.ACTIVE) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Teacher status is invalid.',
        )
      }

      if (teacherData.uid !== uid) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Teacher UID mismatch.',
        )
      }

      let classroomId
      try {
        // Shared canonical contract: a stored classroom ID is never trusted as
        // a path segment until it is validated the same way the shared resolver
        // validates it.
        classroomId = validateCanonicalDocumentId(teacherData.classroomId, 'classroomId')
      } catch {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Teacher document has a missing or malformed classroom ID.',
        )
      }

      const classroomRef = firestore
        .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
        .doc(classroomId)
      const classroomSnap = await transaction.get(classroomRef)

      if (!classroomSnap.exists) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Referenced classroom document does not exist.',
        )
      }

      const classroomData = classroomSnap.data() ?? {}

      if (classroomData.ownerUid !== uid) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Classroom owner UID mismatch.',
        )
      }

      const studentLoginCode = classroomData.studentLoginCode
      if (typeof studentLoginCode !== 'string' || !studentLoginCode) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Existing classroom missing student login code.',
        )
      }

      let canonicalCode
      try {
        canonicalCode = normalizeClassroomCode(studentLoginCode)
      } catch {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Existing classroom has malformed student login code.',
        )
      }

      // The code index must contain exactly the one entry named by the
      // classroom root. Querying by classroomId (not just reading the named
      // document) is what detects duplicate indexes left behind by a partially
      // completed operation; a duplicate blocks rather than being repaired.
      const codeIndexQuery = firestore
        .collection(FIRESTORE_COLLECTIONS.CLASSROOM_LOGIN_CODES)
        .where('classroomId', '==', classroomId)
        .limit(2)
      const codeIndexSnap = await transaction.get(codeIndexQuery)
      const codeIndexDocs = codeIndexSnap.docs ?? []

      if (codeIndexDocs.length !== 1) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          codeIndexDocs.length === 0
            ? 'Existing classroom login code index missing.'
            : 'Existing classroom has multiple login code indexes.',
        )
      }

      if (codeIndexDocs[0].id !== canonicalCode) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Existing classroom login code index does not match the classroom root.',
        )
      }

      const codeRef = firestore
        .collection(FIRESTORE_COLLECTIONS.CLASSROOM_LOGIN_CODES)
        .doc(canonicalCode)
      const codeSnap = await transaction.get(codeRef)

      if (!codeSnap.exists) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Existing classroom login code index missing.',
        )
      }

      const codeData = codeSnap.data() ?? {}
      if (
        codeData.classroomId !== classroomId ||
        codeData.status !== CLASSROOM_LOGIN_CODE_STATUS.ACTIVE
      ) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Existing classroom login code index mismatch.',
        )
      }

      return {
        created: false,
        teacher: {
          uid,
          status: teacherData.status,
          displayName: teacherData.displayName || displayName,
          email: teacherData.email || normalizedEmail,
        },
        classroom: {
          id: classroomId,
          name: classroomData.name,
          studentLoginCode,
        },
      }
    }

    // New onboarding path: verify single ownership invariant
    const ownedQuery = firestore
      .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
      .where('ownerUid', '==', uid)
      .limit(2)
    const ownedSnap = await transaction.get(ownedQuery)

    if (!ownedSnap.empty) {
      throw new TeacherOnboardingError(
        'failed-precondition',
        'Teacher has inconsistent partial classroom state.',
      )
    }

    // Check invitation document
    const invRef = firestore
      .collection(FIRESTORE_COLLECTIONS.TEACHER_INVITATIONS)
      .doc(emailDigest)
    const invSnap = await transaction.get(invRef)

    if (!invSnap.exists) {
      throw new TeacherOnboardingError(
        'permission-denied',
        'No invitation found for email.',
      )
    }

    const invData = invSnap.data() ?? {}

    if (invData.status === INVITATION_STATUS.REVOKED) {
      throw new TeacherOnboardingError(
        'permission-denied',
        'Invitation has been revoked.',
      )
    }

    if (invData.status === INVITATION_STATUS.CONSUMED) {
      throw new TeacherOnboardingError(
        'already-exists',
        'Invitation has already been consumed.',
      )
    }

    if (invData.status !== INVITATION_STATUS.ACTIVE) {
      throw new TeacherOnboardingError(
        'permission-denied',
        'Invitation is not active.',
      )
    }

    if (invData.expiresAt != null) {
      const expiryMillis = toEpochMillis(invData.expiresAt)
      const currentMillis = toEpochMillis(now())

      // Fail closed: an unreadable expiry or an unreadable clock must never be
      // treated as "not expired".
      if (expiryMillis === null || currentMillis === null) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Invitation expiry could not be evaluated.',
        )
      }

      if (expiryMillis <= currentMillis) {
        throw new TeacherOnboardingError(
          'permission-denied',
          'Invitation has expired.',
        )
      }
    }

    // Code generation with collision retry loop
    let canonicalCode
    let codeRef
    let codeAvailable = false
    const maxRetries = 5

    for (let retry = 0; retry < maxRetries; retry += 1) {
      const rawGeneratedCode = codeGenerator()
      try {
        canonicalCode = normalizeClassroomCode(rawGeneratedCode)
      } catch {
        continue
      }
      codeRef = firestore
        .collection(FIRESTORE_COLLECTIONS.CLASSROOM_LOGIN_CODES)
        .doc(canonicalCode)
      const codeSnap = await transaction.get(codeRef)

      if (!codeSnap.exists) {
        codeAvailable = true
        break
      }
    }

    if (!codeAvailable) {
      throw new TeacherOnboardingError(
        'resource-exhausted',
        'Classroom login code generation retries exhausted.',
      )
    }

    const formattedCode = formatClassroomCode(canonicalCode)
    const generatedClassroomRef = firestore
      .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
      .doc()
    const generatedClassroomId = generatedClassroomRef.id
    const timestamp = serverTimestamp()

    const classroomDocument = buildClassroomDocument({
      ownerUid: uid,
      name: normalizedClassroomName,
      timestamp,
      studentLoginCode: formattedCode,
    })

    const teacherDocument = buildTeacherDocument({
      uid,
      classroomId: generatedClassroomId,
      displayName,
      email: normalizedEmail,
      timestamp,
    })

    const loginCodeDocument = {
      classroomId: generatedClassroomId,
      status: CLASSROOM_LOGIN_CODE_STATUS.ACTIVE,
      createdAt: timestamp,
    }

    transaction.create(codeRef, loginCodeDocument)
    transaction.create(generatedClassroomRef, classroomDocument)
    transaction.create(teacherRef, teacherDocument)
    transaction.update(invRef, {
      status: INVITATION_STATUS.CONSUMED,
      consumedAt: timestamp,
      consumedByUid: uid,
    })

    return {
      created: true,
      teacher: {
        uid,
        status: TEACHER_STATUS.ACTIVE,
        displayName,
        email: normalizedEmail,
      },
      classroom: {
        id: generatedClassroomId,
        name: normalizedClassroomName,
        studentLoginCode: formattedCode,
      },
    }
  })
}

export async function resolveTeacherTenantService({
  firestore,
  auth,
  data = {},
}) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('firestore with a collection method is required.')
  }
  if (!auth || typeof auth !== 'object') {
    throw new TeacherOnboardingError('unauthenticated', 'Authentication required.')
  }

  const uid = validateUid(auth.uid)

  // No tenant input at all: any request field is rejected, and a non-object
  // payload is rejected rather than silently ignored.
  if (data !== undefined && data !== null) {
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new TeacherOnboardingError(
        'invalid-argument',
        'resolveTeacherTenant takes no input parameters.',
      )
    }
    if (Object.keys(data).length > 0) {
      throw new TeacherOnboardingError(
        'invalid-argument',
        'resolveTeacherTenant takes no input parameters.',
      )
    }
  }

  // The bidirectional ownership invariant lives in exactly one place: the
  // shared resolver. This callable maps its structured codes onto the callable
  // contract instead of reimplementing the checks.
  let tenant = null
  try {
    tenant = await resolveActiveTeacherTenant({ firestore, auth: { uid } })
  } catch (error) {
    if (!(error instanceof TeacherTenantResolverError)) {
      throw error
    }
    switch (error.code) {
      case 'teacher-not-found':
        break
      case 'unauthenticated':
      case 'invalid-auth-uid':
        throw new TeacherOnboardingError(
          'unauthenticated',
          'Authentication UID is malformed.',
        )
      case 'teacher-disabled':
        throw new TeacherOnboardingError(
          'permission-denied',
          'Teacher account is disabled.',
        )
      default:
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Teacher foundation records are inconsistent.',
        )
    }
  }

  if (tenant) {
    const teacherData = tenant.teacher.data
    const classroomData = tenant.classroom.data
    const studentLoginCode = classroomData.studentLoginCode

    if (typeof studentLoginCode !== 'string' || !studentLoginCode) {
      throw new TeacherOnboardingError(
        'failed-precondition',
        'Classroom document missing student login code.',
      )
    }

    return {
      state: 'active',
      teacher: {
        uid: tenant.teacherUid,
        displayName: teacherData.displayName || '',
        email: teacherData.email || '',
      },
      classroom: {
        id: tenant.classroomId,
        name: classroomData.name,
        studentLoginCode,
      },
    }
  }

  // Not onboarded yet — evaluate invitation eligibility
  const token = auth.token ?? {}
  if (
    token.email_verified !== true ||
    token.firebase?.sign_in_provider !== 'google.com' ||
    typeof token.email !== 'string'
  ) {
    throw new TeacherOnboardingError(
      'permission-denied',
      'User is not invited or sign-in token is invalid.',
    )
  }

  let normalizedEmail
  try {
    normalizedEmail = normalizeEmail(token.email)
  } catch {
    throw new TeacherOnboardingError('permission-denied', 'User is not invited.')
  }

  const emailDigest = hashEmailDigest(normalizedEmail)
  const invRef = firestore
    .collection(FIRESTORE_COLLECTIONS.TEACHER_INVITATIONS)
    .doc(emailDigest)
  const invSnap = await invRef.get()

  if (!invSnap.exists) {
    throw new TeacherOnboardingError('permission-denied', 'User is not invited.')
  }

  const invData = invSnap.data() ?? {}

  if (invData.status !== INVITATION_STATUS.ACTIVE) {
    throw new TeacherOnboardingError('permission-denied', 'User is not invited.')
  }

  return {
    state: 'onboarding-required',
    eligibility: 'invited',
  }
}
