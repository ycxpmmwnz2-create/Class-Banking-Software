export const FIRESTORE_COLLECTIONS = Object.freeze({
  TEACHERS: 'teachers',
  CLASSROOMS: 'classrooms',
  TEACHER_INVITATIONS: 'teacherInvitations',
  CLASSROOM_LOGIN_CODES: 'classroomLoginCodes',
})

export const TEACHER_STATUS = Object.freeze({
  ACTIVE: 'active',
  DISABLED: 'disabled',
})

export const INVITATION_STATUS = Object.freeze({
  ACTIVE: 'active',
  CONSUMED: 'consumed',
  REVOKED: 'revoked',
})

export const CLASSROOM_LOGIN_CODE_STATUS = Object.freeze({
  ACTIVE: 'active',
})

export const CLASSROOM_DOCUMENT_VERSION = 1
