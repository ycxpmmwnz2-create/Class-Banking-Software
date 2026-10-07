// Read-only projection of authoritative settings. No mirrored settings document.
import { HttpsError } from 'firebase-functions/v2/https'
import { ClassroomAccessError, hasExactDataKeys, readStudentClassroomAccess } from './classroomAccess.js'
import { normalizedStudentMoneySettings } from './studentMoney.js'

export async function getStudentSettingsService({ firestore, auth, data }) {
  if (!hasExactDataKeys(data, [])) throw new ClassroomAccessError('invalid-argument')
  return firestore.runTransaction(async transaction => {
    const { classroomId, studentId } = await readStudentClassroomAccess({ transaction, firestore, auth })
    const student = await transaction.get(firestore.doc(`classrooms/${classroomId}/students/${studentId}`))
    if (!student.exists || student.data()?.id !== Number(studentId)) throw new ClassroomAccessError()
    // Re-reading this document stays within the same consistent transaction.
    const classroom = await transaction.get(firestore.doc(`classrooms/${classroomId}`))
    const settings = normalizedStudentMoneySettings(classroom.data())
    return { protocolVersion: 1, classroomId, studentId, settings }
  })
}

export async function getStudentSettingsCallable(request, { firestore }) {
  try {
    return await getStudentSettingsService({ firestore, auth: request?.auth, data: request?.data })
  } catch (error) {
    const code = error instanceof ClassroomAccessError ? error.code : 'failed-precondition'
    throw new HttpsError(code, 'Student settings are unavailable. Refresh and try again.')
  }
}
