import {
  normalizeClassroomCode,
  normalizeStudentLoginId,
  validateCanonicalDocumentId,
  validateSha256Digest,
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

export function studentCredentialPath(classroomId, loginId) {
  const validClassroomId = validateCanonicalDocumentId(classroomId, 'classroomId')
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
  const validClassroomId = validateCanonicalDocumentId(classroomId, 'classroomId')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_AUTH_LOGS}/${validClassroomId}/${STUDENT_CREDENTIAL_COLLECTIONS.LOGS}`
}

export function studentAuthLogPath(classroomId, logId) {
  const validClassroomId = validateCanonicalDocumentId(classroomId, 'classroomId')
  const validLogId = validateCanonicalDocumentId(logId, 'logId')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_AUTH_LOGS}/${validClassroomId}/${STUDENT_CREDENTIAL_COLLECTIONS.LOGS}/${validLogId}`
}

export function studentLoginThrottlePath(digest) {
  const validDigest = validateSha256Digest(digest, 'digest')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_LOGIN_THROTTLE}/${validDigest}`
}

export function studentAuthUnresolvedLogsCollectionPath() {
  return STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_AUTH_UNRESOLVED_LOGS
}

export function studentAuthUnresolvedLogPath(logId) {
  const validLogId = validateCanonicalDocumentId(logId, 'logId')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_AUTH_UNRESOLVED_LOGS}/${validLogId}`
}

export function teacherInvitationPath(emailDigest) {
  const validDigest = validateSha256Digest(emailDigest, 'emailDigest')
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
