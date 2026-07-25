import {
  normalizeClassroomCode,
  normalizeStudentLoginId,
} from './identityNormalization.js'

export const STUDENT_CREDENTIAL_COLLECTIONS = Object.freeze({
  CLASSROOMS: 'classrooms',
  STUDENT_CREDENTIALS: 'studentCredentials',
  STUDENT_AUTH_LOGS: 'studentAuthLogs',
  LOGS: 'logs',
  STUDENT_LOGIN_THROTTLE: 'studentLoginThrottle',
  STUDENT_AUTH_UNRESOLVED_LOGS: 'studentAuthUnresolvedLogs',
  TEACHER_INVITATIONS: 'teacherInvitations',
  CLASSROOM_LOGIN_CODES: 'classroomLoginCodes',
})

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

function validateCanonicalId(id, name) {
  if (typeof id !== 'string') {
    throw new TypeError(`${name} must be a string.`)
  }
  if (!id) {
    throw new Error(`${name} must not be empty.`)
  }
  if (id.trim() !== id) {
    throw new Error(`${name} must not have leading or trailing whitespace.`)
  }
  if (id.includes('/')) {
    throw new Error(`${name} must not contain slashes.`)
  }
  if (id === '.' || id === '..') {
    throw new Error(`${name} must not be a dot segment.`)
  }
  if (!isWellFormedUnicode(id)) {
    throw new Error(`${name} contains invalid Unicode.`)
  }
  return id
}

export function studentCredentialPath(classroomId, loginId) {
  const validClassroomId = validateCanonicalId(classroomId, 'classroomId')
  if (typeof loginId !== 'string') {
    throw new TypeError('loginId must be a string.')
  }
  const canonicalLoginId = normalizeStudentLoginId(loginId)
  if (loginId !== canonicalLoginId) {
    throw new Error('loginId must already be in canonical normalized form.')
  }
  return `${STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS}/${validClassroomId}/${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_CREDENTIALS}/${canonicalLoginId}`
}

export function studentAuthLogsCollectionPath(classroomId) {
  const validClassroomId = validateCanonicalId(classroomId, 'classroomId')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_AUTH_LOGS}/${validClassroomId}/${STUDENT_CREDENTIAL_COLLECTIONS.LOGS}`
}

export function studentAuthLogPath(classroomId, logId) {
  const validClassroomId = validateCanonicalId(classroomId, 'classroomId')
  const validLogId = validateCanonicalId(logId, 'logId')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_AUTH_LOGS}/${validClassroomId}/${STUDENT_CREDENTIAL_COLLECTIONS.LOGS}/${validLogId}`
}

export function studentLoginThrottlePath(digest) {
  const validDigest = validateCanonicalId(digest, 'digest')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_LOGIN_THROTTLE}/${validDigest}`
}

export function studentAuthUnresolvedLogsCollectionPath() {
  return STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_AUTH_UNRESOLVED_LOGS
}

export function studentAuthUnresolvedLogPath(logId) {
  const validLogId = validateCanonicalId(logId, 'logId')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_AUTH_UNRESOLVED_LOGS}/${validLogId}`
}

export function teacherInvitationPath(emailDigest) {
  const validDigest = validateCanonicalId(emailDigest, 'emailDigest')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.TEACHER_INVITATIONS}/${validDigest}`
}

export function classroomLoginCodePath(canonicalCode) {
  if (typeof canonicalCode !== 'string') {
    throw new TypeError('canonicalCode must be a string.')
  }
  const normalized = normalizeClassroomCode(canonicalCode)
  if (canonicalCode !== normalized) {
    throw new Error('canonicalCode must already be in canonical normalized form.')
  }
  return `${STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOM_LOGIN_CODES}/${normalized}`
}
