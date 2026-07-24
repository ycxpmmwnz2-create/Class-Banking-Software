import {
  CLASSROOM_DOCUMENT_VERSION,
  TEACHER_STATUS,
} from './firestoreSchema.js'

function requiredString(value, fieldName) {
  const normalizedValue = typeof value === 'string' ? value.trim() : ''

  if (!normalizedValue) {
    throw new TypeError(`${fieldName} is required.`)
  }

  return normalizedValue
}

function optionalString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function requiredTimestamp(value) {
  if (value == null) {
    throw new TypeError('timestamp is required.')
  }

  return value
}

export function buildTeacherDocument({
  uid,
  classroomId,
  displayName,
  email,
  timestamp,
}) {
  const normalizedUid = requiredString(uid, 'uid')
  const normalizedClassroomId = requiredString(classroomId, 'classroomId')
  const documentTimestamp = requiredTimestamp(timestamp)

  return {
    uid: normalizedUid,
    classroomId: normalizedClassroomId,
    createdAt: documentTimestamp,
    updatedAt: documentTimestamp,
    status: TEACHER_STATUS.ACTIVE,
    displayName: optionalString(displayName),
    email: optionalString(email),
  }
}

export function buildClassroomDocument({
  ownerUid,
  name,
  timestamp,
}) {
  const normalizedOwnerUid = requiredString(ownerUid, 'ownerUid')
  const normalizedName = requiredString(name, 'name')
  const documentTimestamp = requiredTimestamp(timestamp)

  return {
    ownerUid: normalizedOwnerUid,
    name: normalizedName,
    createdAt: documentTimestamp,
    updatedAt: documentTimestamp,
    version: CLASSROOM_DOCUMENT_VERSION,
    settings: {},
  }
}
