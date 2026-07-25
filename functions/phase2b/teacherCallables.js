import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'

import {
  TeacherOnboardingError,
  onboardTeacherClassroomService,
  resolveTeacherTenantService,
} from './teacherOnboarding.js'

function mapToHttpsError(error) {
  if (error instanceof HttpsError) {
    return error
  }

  if (error instanceof TeacherOnboardingError) {
    const validCodes = [
      'unauthenticated',
      'permission-denied',
      'invalid-argument',
      'failed-precondition',
      'already-exists',
      'aborted',
      'resource-exhausted',
      'internal',
    ]

    const code = validCodes.includes(error.code) ? error.code : 'internal'
    return new HttpsError(code, error.message)
  }

  return new HttpsError('internal', 'An unexpected internal error occurred.')
}

export async function onboardTeacherClassroomCallable(request, options = {}) {
  const firestore = options.firestore ?? getFirestore()
  const service = options.onboardTeacherClassroomService ?? onboardTeacherClassroomService

  try {
    return await service({
      firestore,
      auth: request?.auth,
      data: request?.data,
      codeGenerator: options.codeGenerator,
      clock: options.clock,
    })
  } catch (error) {
    throw mapToHttpsError(error)
  }
}

export async function resolveTeacherTenantCallable(request, options = {}) {
  const firestore = options.firestore ?? getFirestore()
  const service = options.resolveTeacherTenantService ?? resolveTeacherTenantService

  try {
    return await service({
      firestore,
      auth: request?.auth,
      data: request?.data,
    })
  } catch (error) {
    throw mapToHttpsError(error)
  }
}
