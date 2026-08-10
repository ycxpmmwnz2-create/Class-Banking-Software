import {
  CLASSROOM_DOCUMENT_VERSION,
  FIRESTORE_COLLECTIONS,
  TEACHER_STATUS,
} from '../phase1/firestoreSchema.js'
import { normalizeFirestoreDocumentId } from './firestoreDocumentId.js'

export const LEGACY_CLASSROOM_ID = 'morgan'

export const REQUIRED_CLASSROOM_FIELDS = Object.freeze([
  'ownerUid',
  'name',
  'createdAt',
  'updatedAt',
  'version',
  'settings',
])

export const FOUNDATION_VALIDATION_CATEGORIES = Object.freeze({
  CLASSROOM_NOT_FOUND: 'classroom-not-found',
  CLASSROOM_OWNER_MISMATCH: 'classroom-owner-mismatch',
  CLASSROOM_VERSION_MISMATCH: 'classroom-version-mismatch',
  INVALID_CLASSROOM_FIELD: 'invalid-classroom-field',
  INVALID_CLASSROOM_ID: 'invalid-classroom-id',
  INVALID_TEACHER_UID: 'invalid-teacher-uid',
  LEGACY_CLASSROOM_ID: 'legacy-classroom-id',
  MISSING_CLASSROOM_FIELDS: 'missing-classroom-fields',
  MISSING_CLASSROOM_ID: 'missing-classroom-id',
  TEACHER_NOT_ACTIVE: 'teacher-not-active',
  TEACHER_NOT_FOUND: 'teacher-not-found',
  TEACHER_UID_MISMATCH: 'teacher-uid-mismatch',
})

export class FoundationValidationError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'FoundationValidationError'
    this.code = 'PHASE2A_FOUNDATION_VALIDATION_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new FoundationValidationError(category, message, details)
}

function requireFirestore(firestore) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('firestore with a collection method is required.')
  }

  return firestore
}

function requireTeacherUid(teacherUid) {
  const validation = normalizeFirestoreDocumentId(teacherUid)

  if (typeof teacherUid !== 'string' || !validation.valid) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.INVALID_TEACHER_UID,
      'teacherUid must be a canonical Firestore document ID string.',
      {
        teacherUid,
        documentIdRejection: validation.rejection,
      },
    )
  }

  return validation.normalizedValue
}

function snapshotEnvelope(reference, snapshot, data) {
  return Object.freeze({
    id: reference.id,
    path: reference.path,
    data,
    updateTime: snapshot.updateTime,
  })
}

function validateTeacherDocument({ teacherData, teacherPath, teacherUid }) {
  if (teacherData?.uid !== teacherUid) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.TEACHER_UID_MISMATCH,
      'The teacher document uid does not match its document ID.',
      {
        path: teacherPath,
        expectedUid: teacherUid,
        actualUid: teacherData?.uid,
      },
    )
  }

  if (teacherData?.status !== TEACHER_STATUS.ACTIVE) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.TEACHER_NOT_ACTIVE,
      'The teacher document is not active.',
      {
        path: teacherPath,
        expectedStatus: TEACHER_STATUS.ACTIVE,
        actualStatus: teacherData?.status,
      },
    )
  }

  if (!Object.hasOwn(teacherData, 'classroomId')) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.MISSING_CLASSROOM_ID,
      'The teacher document does not contain classroomId.',
      {
        path: teacherPath,
        field: 'classroomId',
      },
    )
  }

  const classroomId = teacherData.classroomId
  const validation = normalizeFirestoreDocumentId(classroomId)

  if (typeof classroomId !== 'string' || !validation.valid) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.INVALID_CLASSROOM_ID,
      'The teacher classroomId must be a canonical Firestore document ID string.',
      {
        path: teacherPath,
        classroomId,
        documentIdRejection: validation.rejection,
      },
    )
  }

  if (classroomId === LEGACY_CLASSROOM_ID) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.LEGACY_CLASSROOM_ID,
      'The legacy classroom ID cannot be used as the Version 2 classroom ID.',
      {
        path: teacherPath,
        classroomId,
      },
    )
  }

  return classroomId
}

function missingClassroomFields(classroomData) {
  if (classroomData === null || typeof classroomData !== 'object' ||
      Array.isArray(classroomData)) {
    return [...REQUIRED_CLASSROOM_FIELDS]
  }

  return REQUIRED_CLASSROOM_FIELDS.filter(
    field => !Object.hasOwn(classroomData, field),
  )
}

function invalidClassroomField(path, field, value, reason) {
  fail(
    FOUNDATION_VALIDATION_CATEGORIES.INVALID_CLASSROOM_FIELD,
    `The classroom document has an invalid ${field} field.`,
    { path, field, value, reason },
  )
}

function isMapLike(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateClassroomDocument({
  classroomData,
  classroomPath,
  teacherUid,
}) {
  const missingFields = missingClassroomFields(classroomData)

  if (missingFields.length > 0) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.MISSING_CLASSROOM_FIELDS,
      'The classroom document is missing required Phase 1 fields.',
      {
        path: classroomPath,
        missingFields,
      },
    )
  }

  if (classroomData.ownerUid !== teacherUid) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.CLASSROOM_OWNER_MISMATCH,
      'The classroom ownerUid does not match the teacher UID.',
      {
        path: classroomPath,
        expectedOwnerUid: teacherUid,
        actualOwnerUid: classroomData.ownerUid,
      },
    )
  }

  if (classroomData.version !== CLASSROOM_DOCUMENT_VERSION) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.CLASSROOM_VERSION_MISMATCH,
      'The classroom document version is unsupported.',
      {
        path: classroomPath,
        expectedVersion: CLASSROOM_DOCUMENT_VERSION,
        actualVersion: classroomData.version,
      },
    )
  }

  if (typeof classroomData.name !== 'string' ||
      classroomData.name.length === 0 ||
      classroomData.name.trim() !== classroomData.name) {
    invalidClassroomField(
      classroomPath,
      'name',
      classroomData.name,
      'must be a non-empty canonical string',
    )
  }

  for (const timestampField of ['createdAt', 'updatedAt']) {
    if (classroomData[timestampField] == null) {
      invalidClassroomField(
        classroomPath,
        timestampField,
        classroomData[timestampField],
        'must be non-null',
      )
    }
  }

  if (!isMapLike(classroomData.settings)) {
    invalidClassroomField(
      classroomPath,
      'settings',
      classroomData.settings,
      'must be a map-like object',
    )
  }
}

/**
 * Independently validates the existing Phase 1 teacher/classroom foundation.
 *
 * This performs direct document reads only. It deliberately does not use the
 * Phase 1 provisioner or a transaction and never attempts to repair invalid
 * state.
 */
export async function validateTeacherClassroomFoundation({
  firestore,
  teacherUid,
}) {
  const database = requireFirestore(firestore)
  const normalizedTeacherUid = requireTeacherUid(teacherUid)
  const teacherReference = database
    .collection(FIRESTORE_COLLECTIONS.TEACHERS)
    .doc(normalizedTeacherUid)
  const teacherSnapshot = await teacherReference.get()

  if (!teacherSnapshot.exists) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.TEACHER_NOT_FOUND,
      'The Phase 1 teacher document does not exist.',
      {
        teacherUid: normalizedTeacherUid,
        path: teacherReference.path,
      },
    )
  }

  const teacherData = teacherSnapshot.data()
  const classroomId = validateTeacherDocument({
    teacherData,
    teacherPath: teacherReference.path,
    teacherUid: normalizedTeacherUid,
  })
  const classroomReference = database
    .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
  const classroomSnapshot = await classroomReference.get()

  if (!classroomSnapshot.exists) {
    fail(
      FOUNDATION_VALIDATION_CATEGORIES.CLASSROOM_NOT_FOUND,
      'The teacher-referenced Phase 1 classroom document does not exist.',
      {
        classroomId,
        path: classroomReference.path,
      },
    )
  }

  const classroomData = classroomSnapshot.data()
  validateClassroomDocument({
    classroomData,
    classroomPath: classroomReference.path,
    teacherUid: normalizedTeacherUid,
  })

  return Object.freeze({
    teacherUid: normalizedTeacherUid,
    classroomId,
    teacher: snapshotEnvelope(
      teacherReference,
      teacherSnapshot,
      teacherData,
    ),
    classroom: snapshotEnvelope(
      classroomReference,
      classroomSnapshot,
      classroomData,
    ),
  })
}
