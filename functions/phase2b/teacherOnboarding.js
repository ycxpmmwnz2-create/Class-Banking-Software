import { FieldValue } from 'firebase-admin/firestore'

import {
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

export class TeacherOnboardingError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TeacherOnboardingError'
    this.code = code
  }
}

function defaultCodeGenerator() {
  let result = ''
  for (let index = 0; index < 8; index += 1) {
    const randomIndex = Math.floor(Math.random() * CLASSROOM_CODE_ALPHABET.length)
    result += CLASSROOM_CODE_ALPHABET[randomIndex]
  }
  return result
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
  codeGenerator = defaultCodeGenerator,
  clock = FieldValue.serverTimestamp,
}) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('firestore with a collection method is required.')
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

      const classroomId = teacherData.classroomId
      if (typeof classroomId !== 'string' || !classroomId) {
        throw new TeacherOnboardingError(
          'failed-precondition',
          'Teacher document missing classroom ID.',
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
        codeData.status !== TEACHER_STATUS.ACTIVE
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
      const now = typeof clock === 'function' ? clock() : Date.now()
      const expiryTime =
        typeof invData.expiresAt.toMillis === 'function'
          ? invData.expiresAt.toMillis()
          : invData.expiresAt
      const currentTime =
        typeof now?.toMillis === 'function' ? now.toMillis() : now

      if (expiryTime <= currentTime) {
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
    const timestamp = typeof clock === 'function' ? clock() : clock

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
      status: 'active',
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

  if (data !== null && typeof data === 'object' && Object.keys(data).length > 0) {
    throw new TeacherOnboardingError(
      'invalid-argument',
      'resolveTeacherTenant takes no input parameters.',
    )
  }

  const teacherRef = firestore
    .collection(FIRESTORE_COLLECTIONS.TEACHERS)
    .doc(uid)
  const teacherSnap = await teacherRef.get()

  if (teacherSnap.exists) {
    const teacherData = teacherSnap.data() ?? {}

    if (teacherData.status === TEACHER_STATUS.DISABLED) {
      throw new TeacherOnboardingError(
        'permission-denied',
        'Teacher account is disabled.',
      )
    }

    if (teacherData.status !== TEACHER_STATUS.ACTIVE || teacherData.uid !== uid) {
      throw new TeacherOnboardingError(
        'failed-precondition',
        'Teacher status or UID mismatch.',
      )
    }

    const classroomId = teacherData.classroomId
    if (typeof classroomId !== 'string' || !classroomId) {
      throw new TeacherOnboardingError(
        'failed-precondition',
        'Teacher document missing classroom ID.',
      )
    }

    const classroomRef = firestore
      .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
      .doc(classroomId)
    const classroomSnap = await classroomRef.get()

    if (!classroomSnap.exists) {
      throw new TeacherOnboardingError(
        'failed-precondition',
        'Referenced classroom document not found.',
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
        'Classroom document missing student login code.',
      )
    }

    return {
      state: 'active',
      teacher: {
        uid,
        displayName: teacherData.displayName || '',
        email: teacherData.email || '',
      },
      classroom: {
        id: classroomId,
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
