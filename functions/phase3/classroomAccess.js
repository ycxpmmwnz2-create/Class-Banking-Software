import { HttpsError } from 'firebase-functions/v2/https'
import { normalizeStudentLoginId, validateCanonicalDocumentId } from '../phase2b/identityNormalization.js'
import { deriveDeterministicStudentAuthUid } from '../phase2b/scopedCredentialProjection.js'
import { studentCredentialPath } from '../phase2b/studentCredentialPaths.js'

export class ClassroomAccessError extends Error {
  constructor(code = 'permission-denied') {
    super('Classroom access is unavailable.')
    this.name = 'ClassroomAccessError'
    this.code = code
  }
}

function deny() { throw new ClassroomAccessError() }

export function hasExactDataKeys(value, keys) {
  return value !== null && typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
    })
}

function id(value) {
  try { return validateCanonicalDocumentId(value) } catch { return deny() }
}

export function isControlGeneration(value) {
  return Number.isSafeInteger(value) && value > 0
}

export function requireClassroomControl(value) {
  if (!hasExactDataKeys(value, ['schemaVersion', 'mode', 'generation', 'changedAt', 'auditId']) ||
      value.schemaVersion !== 1 || !['active', 'readOnly', 'suspended'].includes(value.mode) ||
      !isControlGeneration(value.generation) || typeof value.changedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.changedAt)) deny()
  const instant = new Date(value.changedAt)
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value.changedAt) deny()
  id(value.auditId)
  return Object.freeze({ ...value })
}

// Call inside EACH transaction callback before any mutation. This policy does
// not authenticate by itself; the foundation readers below bind the current owner.
// Recovery is for receipt metadata only, never arbitrary classroom writes.
export function requireClassroomAccess(control, {
  operation = 'read', protocolVersion, controlGeneration,
} = {}) {
  const current = requireClassroomControl(control)
  if (!['read', 'sensitiveRead', 'mutate', 'recovery'].includes(operation) || current.mode === 'suspended') deny()
  if (['sensitiveRead', 'mutate'].includes(operation) && current.mode !== 'active') deny()
  if (operation === 'mutate' && (protocolVersion !== 1 ||
      !isControlGeneration(controlGeneration) || controlGeneration !== current.generation)) deny()
  return current
}

function document(snapshot) {
  if (snapshot?.exists !== true) deny()
  const data = snapshot.data()
  if (!data || typeof data !== 'object' || Array.isArray(data)) deny()
  return data
}

function requireAuth(auth) {
  if (!auth?.uid) throw new ClassroomAccessError('unauthenticated')
  return id(auth.uid)
}

function requireFoundation(teacher, classroom, teacherUid, classroomId) {
  if (teacher.uid !== teacherUid || teacher.status !== 'active' ||
      teacher.classroomId !== classroomId || classroom.ownerUid !== teacherUid) deny()
}

// No independent root .get(): the consuming mutation must use its own transaction.
export async function readTeacherClassroomAccess({ transaction, firestore, auth, policy }) {
  const teacherUid = requireAuth(auth)
  if (auth.token?.role !== undefined && auth.token.role !== 'teacher') deny()
  const teacher = document(await transaction.get(firestore.doc(`teachers/${teacherUid}`)))
  const classroomId = id(teacher.classroomId)
  const classroom = document(await transaction.get(firestore.doc(`classrooms/${classroomId}`)))
  requireFoundation(teacher, classroom, teacherUid, classroomId)
  const control = requireClassroomAccess(classroom.accessControl, policy)
  return Object.freeze({ teacherUid, classroomId, control })
}

function credentialVersion(value) {
  try {
    const version = typeof value?.toMillis === 'function' ? value.toMillis()
      : value instanceof Date ? value.getTime() : value
    return isControlGeneration(version) ? version : 0
  } catch { return 0 }
}

export async function readStudentClassroomAccess({ transaction, firestore, auth, policy }) {
  const uid = requireAuth(auth)
  const token = auth.token
  if (token?.role !== 'student') deny()
  const classroomId = id(token.classroomId)
  const studentId = id(token.studentId)
  if (!/^[1-9][0-9]*$/.test(studentId) || !Number.isSafeInteger(Number(studentId)) ||
      uid !== deriveDeterministicStudentAuthUid(classroomId, studentId) ||
      !isControlGeneration(token.credentialVersion)) deny()
  let loginId
  try { loginId = normalizeStudentLoginId(token.loginId) } catch { deny() }
  if (token.loginId !== loginId) deny()
  // Students have ordinary reads/mutations only; teacher recovery and PIN-list
  // exceptions cannot be acquired by sending a different operation selector.
  if (policy?.operation && !['read', 'mutate'].includes(policy.operation)) deny()
  const classroom = document(await transaction.get(firestore.doc(`classrooms/${classroomId}`)))
  const teacherUid = id(classroom.ownerUid)
  const teacher = document(await transaction.get(firestore.doc(`teachers/${teacherUid}`)))
  requireFoundation(teacher, classroom, teacherUid, classroomId)
  const control = requireClassroomAccess(classroom.accessControl, policy)
  const credential = document(await transaction.get(firestore.doc(studentCredentialPath(classroomId, loginId))))
  if (credential.active !== true || credential.classroomId !== classroomId ||
      credential.studentId !== studentId || credential.authUid !== uid ||
      credentialVersion(credential.pinUpdatedAt) !== token.credentialVersion) deny()
  return Object.freeze({ classroomId, studentId, control })
}

export async function getClassroomAccessService({ firestore, auth, data }) {
  if (!hasExactDataKeys(data, [])) throw new ClassroomAccessError('invalid-argument')
  // Current control is read in one consistent transaction with identity. No token
  // generation claim is necessary merely to deny suspended reads.
  return firestore.runTransaction(async transaction => {
    const reader = auth?.token?.role === 'student' ? readStudentClassroomAccess : readTeacherClassroomAccess
    const { control } = await reader({ transaction, firestore, auth })
    return Object.freeze({ protocolVersion: 1, mode: control.mode, generation: control.generation })
  })
}

export async function getClassroomAccessCallable(request, { firestore }) {
  try {
    return await getClassroomAccessService({ firestore, auth: request?.auth, data: request?.data })
  } catch (error) {
    const code = error instanceof ClassroomAccessError ? error.code : 'internal'
    throw new HttpsError(code, code === 'unauthenticated' ? 'Sign in required.' : 'Classroom access is unavailable.')
  }
}
