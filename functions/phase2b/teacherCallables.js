import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'

import {
  TeacherOnboardingError,
  onboardTeacherClassroomService,
  resolveTeacherTenantService,
} from './teacherOnboarding.js'

/**
 * The only messages this boundary is allowed to send to a browser. Service
 * messages describe invitation state ("revoked", "expired", "already
 * consumed"), document paths, and integrity findings; forwarding them would let
 * a caller enumerate invitation state and read internal structure. Every safe
 * callable code therefore maps to one fixed generic string.
 *
 * `unauthenticated`, `permission-denied`, and the invitation categories
 * deliberately collapse: uninvited, revoked, and expired callers must be
 * client-indistinguishable.
 */
const GENERIC_CLIENT_MESSAGES = Object.freeze({
  'unauthenticated': 'Sign in required.',
  'permission-denied': 'This account is not eligible to complete this action.',
  'invalid-argument': 'The request was invalid.',
  'failed-precondition':
    'This account cannot be set up automatically. Contact your administrator for assistance.',
  'already-exists': 'This account is not eligible to complete this action.',
  'aborted': 'The request could not be completed. Please try again.',
  'resource-exhausted': 'The request could not be completed. Please try again later.',
  'internal': 'An unexpected internal error occurred.',
})

function genericHttpsError(rawCode) {
  const code = Object.prototype.hasOwnProperty.call(GENERIC_CLIENT_MESSAGES, rawCode)
    ? rawCode
    : 'internal'
  // Only the allowlisted message is ever passed through, and no `details`
  // payload is attached, so nothing derived from the service error or the
  // request reaches the client.
  return new HttpsError(code, GENERIC_CLIENT_MESSAGES[code])
}

function mapToHttpsError(error) {
  if (error instanceof HttpsError) {
    return genericHttpsError(error.code)
  }

  if (error instanceof TeacherOnboardingError) {
    return genericHttpsError(error.code)
  }

  return genericHttpsError('internal')
}

export async function onboardTeacherClassroomCallable(request, options = {}) {
  const firestore = options.firestore ?? getFirestore()
  const service = options.onboardTeacherClassroomService ?? onboardTeacherClassroomService

  try {
    // Absent options stay `undefined`, so the service applies its own safe
    // defaults: real wall clock, serverTimestamp sentinel, CSPRNG code generator.
    return await service({
      firestore,
      auth: request?.auth,
      data: request?.data,
      codeGenerator: options.codeGenerator,
      now: options.now,
      serverTimestamp: options.serverTimestamp,
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
