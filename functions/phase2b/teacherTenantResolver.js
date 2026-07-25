import { FIRESTORE_COLLECTIONS, TEACHER_STATUS } from '../phase1/firestoreSchema.js'

export class TeacherTenantResolverError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TeacherTenantResolverError'
    this.code = code
  }
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

export function validateCanonicalDocumentId(id, name) {
  if (typeof id !== 'string') {
    throw new TeacherTenantResolverError('invalid-argument', `${name} must be a string.`)
  }
  if (!id) {
    throw new TeacherTenantResolverError('invalid-argument', `${name} must not be empty.`)
  }
  if (id.trim() !== id) {
    throw new TeacherTenantResolverError(
      'invalid-argument',
      `${name} must not have leading or trailing whitespace.`,
    )
  }
  if (id.includes('/')) {
    throw new TeacherTenantResolverError('invalid-argument', `${name} must not contain slashes.`)
  }
  if (id === '.' || id === '..') {
    throw new TeacherTenantResolverError('invalid-argument', `${name} must not be a dot segment.`)
  }
  if (!isWellFormedUnicode(id)) {
    throw new TeacherTenantResolverError('invalid-argument', `${name} contains invalid Unicode.`)
  }
  return id
}

export async function resolveActiveTeacherTenant({ firestore, auth }) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('firestore with a collection method is required.')
  }
  if (!auth || typeof auth !== 'object' || typeof auth.uid !== 'string' || !auth.uid) {
    throw new TeacherTenantResolverError('unauthenticated', 'Authentication required.')
  }

  let teacherUid
  try {
    teacherUid = validateCanonicalDocumentId(auth.uid, 'auth.uid')
  } catch (error) {
    if (error instanceof TeacherTenantResolverError) {
      throw new TeacherTenantResolverError('invalid-auth-uid', 'Authentication UID is malformed.')
    }
    throw error
  }

  const teacherRef = firestore.collection(FIRESTORE_COLLECTIONS.TEACHERS).doc(teacherUid)
  const teacherSnap = await teacherRef.get()

  if (!teacherSnap.exists) {
    throw new TeacherTenantResolverError('teacher-not-found', 'Teacher document not found.')
  }

  const teacherData = teacherSnap.data() ?? {}

  if (teacherData.uid !== teacherUid) {
    throw new TeacherTenantResolverError(
      'teacher-uid-mismatch',
      'Teacher document UID does not match auth UID.',
    )
  }

  if (teacherData.status === 'disabled') {
    throw new TeacherTenantResolverError('teacher-disabled', 'Teacher account is disabled.')
  }

  if (teacherData.status !== TEACHER_STATUS.ACTIVE) {
    throw new TeacherTenantResolverError(
      'invalid-teacher-status',
      'Teacher status is not active.',
    )
  }

  const rawClassroomId = teacherData.classroomId
  let classroomId
  try {
    classroomId = validateCanonicalDocumentId(rawClassroomId, 'classroomId')
  } catch {
    throw new TeacherTenantResolverError(
      'invalid-classroom-id',
      'Teacher classroom ID is invalid.',
    )
  }

  const classroomRef = firestore
    .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
  const classroomSnap = await classroomRef.get()

  if (!classroomSnap.exists) {
    throw new TeacherTenantResolverError(
      'classroom-not-found',
      'Referenced classroom document not found.',
    )
  }

  const classroomData = classroomSnap.data() ?? {}

  if (classroomData.ownerUid !== teacherUid) {
    throw new TeacherTenantResolverError(
      'classroom-owner-mismatch',
      'Classroom owner UID does not match teacher UID.',
    )
  }

  return Object.freeze({
    teacherUid,
    classroomId,
    teacher: Object.freeze({
      id: teacherSnap.id,
      path: teacherRef.path,
      data: Object.freeze({ ...teacherData }),
    }),
    classroom: Object.freeze({
      id: classroomSnap.id,
      path: classroomRef.path,
      data: Object.freeze({ ...classroomData }),
    }),
  })
}
