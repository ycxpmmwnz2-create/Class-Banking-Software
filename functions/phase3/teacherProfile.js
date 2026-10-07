import { HttpsError } from 'firebase-functions/v2/https'
import { hasExactDataKeys, readTeacherClassroomAccess } from './classroomAccess.js'
import { copyMoneyStudent } from './teacherAwardChanges.js'
import { estimateMoneyDocumentBytes } from './moneyDocumentSize.js'
import { TEACHER_MONEY_LIMITS as LIMITS } from './teacherMoneyContract.js'

const name = value => typeof value === 'string' && value.isWellFormed() &&
  value === value.trim() && value.length > 0 && [...value].length <= 120

export async function editTeacherProfileService(input, { firestore, auth }) {
  if (!hasExactDataKeys(input, ['protocolVersion', 'controlGeneration', 'classroomId', 'studentId', 'expectedName', 'name']) ||
      !Number.isSafeInteger(input.studentId) || input.studentId <= 0 || !name(input.name) || !name(input.expectedName)) {
    throw new HttpsError('invalid-argument', 'Check the student name and refresh before trying again.')
  }
  const wire = { ...input }
  return firestore.runTransaction(async transaction => {
    const foundation = await readTeacherClassroomAccess({ transaction, firestore, auth,
      policy: { operation: 'mutate', protocolVersion: wire.protocolVersion, controlGeneration: wire.controlGeneration } })
    if (foundation.classroomId !== wire.classroomId) throw new HttpsError('failed-precondition', 'Refresh the classroom before trying again.')
    const ref = firestore.doc(`classrooms/${foundation.classroomId}/students/${wire.studentId}`)
    const snap = await transaction.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'Refresh the roster before trying again.')
    const student = copyMoneyStudent(snap.data(), false)
    if (student.id !== wire.studentId) throw new HttpsError('failed-precondition', 'Refresh the roster before trying again.')
    if (student.name !== wire.name && student.name !== wire.expectedName) {
      throw new HttpsError('failed-precondition', 'The name changed. Refresh the roster before trying again.')
    }
    if (estimateMoneyDocumentBytes(ref.path, { ...student, name: wire.name }) > LIMITS.studentBytes) {
      throw new HttpsError('failed-precondition', 'The student profile is too large to update.')
    }
    // Narrow field update: no historical fan-out, balance replacement or mirror reorder.
    if (student.name !== wire.name) transaction.update(ref, { name: wire.name })
    return { protocolVersion: 1, studentId: wire.studentId, status: 'saved', requiresRefresh: true }
  })
}

export async function editTeacherProfileCallable(request, dependencies) {
  if (!request?.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.')
  if (request.auth.token?.role !== undefined && request.auth.token.role !== 'teacher') throw new HttpsError('permission-denied', 'Teacher access is unavailable.')
  try { return await editTeacherProfileService(request?.data, { ...dependencies, auth: request?.auth }) }
  catch (error) {
    if (error instanceof HttpsError) throw error
    throw new HttpsError('failed-precondition', 'The name save could not be confirmed. Refresh the roster before trying again.')
  }
}
