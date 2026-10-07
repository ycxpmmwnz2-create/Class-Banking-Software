import { HttpsError } from 'firebase-functions/v2/https'
import { ClassroomAccessError, hasExactDataKeys, readTeacherClassroomAccess } from './classroomAccess.js'
import { bindTeacherMoneyIntent } from './teacherRosterChanges.js'
import { TeacherMoneyContractError } from './teacherMoneyContract.js'
import {
  TeacherAwardServiceError, executePlannedTeacherAwardService,
  planTeacherAwardService, recoverTeacherAwardService,
} from './teacherAwardService.js'

const rejectionReasons = new Set([
  'stale-plan', 'acknowledgment-required', 'receipt-quota-exhausted',
  'request-already-used', 'request-cancelled', 'request-conflict',
  'missing-student', 'student-path-mismatch', 'ledger-id-collision',
  'reason-not-allowed', 'invalid-reason-policy', 'amount-out-of-domain',
  'receipt-size-limit', 'transaction-size-limit', 'mutation-size-limit',
  'student-size-limit', 'mirror-capacity', 'pending-conflict', 'balance-conflict',
  'negative-confirmation-required',
])

function requireTeacher(auth) {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.')
  if (auth.token?.role !== undefined && auth.token.role !== 'teacher') {
    throw new HttpsError('permission-denied', 'Teacher money access is unavailable.')
  }
}

function safeError(error) {
  if (error instanceof HttpsError) return error
  const code = error instanceof ClassroomAccessError ? error.code :
    error instanceof TeacherMoneyContractError ? 'invalid-argument' :
      error instanceof TeacherAwardServiceError ? 'failed-precondition' : 'internal'
  // SDK messages, document paths, request bodies and money values never escape.
  return new HttpsError(code, 'The money action could not be confirmed. Check its save status before trying again.')
}

export async function planTeacherMoneyCallable(request, dependencies) {
  try {
    requireTeacher(request?.auth)
    return await planTeacherAwardService(request?.data, { ...dependencies, auth: request.auth })
  } catch (error) { throw safeError(error) }
}

export async function executeTeacherMoneyCallable(request, dependencies) {
  try {
    requireTeacher(request?.auth)
    // There is deliberately no callable for the unplanned executor.
    return await executePlannedTeacherAwardService(request?.data, { ...dependencies, auth: request.auth })
  } catch (error) {
    // Only known validation refusals are correlated. A transport/SDK failure
    // remains ambiguous, even when it happened after an apparently safe read.
    if ((error instanceof TeacherAwardServiceError || error instanceof TeacherMoneyContractError) &&
        rejectionReasons.has(error.code) && hasExactDataKeys(request?.data, ['request', 'plan'])) {
      try {
        requireTeacher(request.auth)
        const bound = await dependencies.firestore.runTransaction(async transaction => {
          const foundation = await readTeacherClassroomAccess({ transaction,
            firestore: dependencies.firestore, auth: request.auth, policy: { operation: 'recovery' } })
          return bindTeacherMoneyIntent(request.data.request, { projectId: dependencies.projectId,
            teacherUid: foundation.teacherUid, classroomId: foundation.classroomId })
        }, { readOnly: true })
        return { protocolVersion: 1, status: 'rejected', requestId: bound.intent.requestId,
          digest: bound.digest, reason: error.code, wroteNothing: true }
      } catch { /* Authorization/correlation failure has only the generic error. */ }
    }
    throw safeError(error)
  }
}

export async function recoverTeacherMoneyCallable(request, dependencies, operation) {
  try {
    requireTeacher(request?.auth)
    if (!hasExactDataKeys(request?.data, ['protocolVersion', 'classroomId', 'requestId'])) {
      throw new TeacherAwardServiceError('invalid-recovery')
    }
    return await recoverTeacherAwardService({ ...request.data, operation }, { ...dependencies, auth: request.auth })
  } catch (error) { throw safeError(error) }
}
