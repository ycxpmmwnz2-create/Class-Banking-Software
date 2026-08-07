import { HttpsError } from 'firebase-functions/v2/https'

import { validateCanonicalDocumentId } from '../phase2b/identityNormalization.js'
import { STUDENT_CREDENTIAL_COLLECTIONS } from '../phase2b/studentCredentialPaths.js'
import {
  TeacherTenantResolverError,
  resolveActiveTeacherTenant,
} from '../phase2b/teacherTenantResolver.js'

/**
 * Teacher-visible current student PINs.
 *
 * Andrew decided that a classroom teacher must be able to look up a student's
 * current PIN instead of resetting it blind, and accepted that this means the
 * PIN is recoverable rather than bcrypt-only. This directory is that decision's
 * entire footprint.
 *
 * It is deliberately a SEPARATE collection from `studentCredentials`, not a new
 * field on the credential document:
 *
 * - the credential document carries the authentication material and has an
 *   exact, independently asserted key set; widening it would weaken a reviewed
 *   security contract for a convenience feature;
 * - `classrooms/{classroomId}/studentPins/{studentId}` matches no rule in any
 *   deployed ruleset, so Firestore's default deny already makes it
 *   server-only. No pinned rules artifact has to change; and
 * - authentication continues to verify the bcrypt hash in the credential
 *   document. Nothing in this directory is ever consulted to authorize a login.
 *
 * The plaintext PIN is a real secret at rest. It must reach only the
 * authenticated, active, owning teacher of that exact classroom, and it must
 * never enter the aggregate client data object, tenant cache, backup export, or
 * any log.
 */
export const STUDENT_PIN_DIRECTORY_COLLECTION = 'studentPins'

const ASCII_FOUR_DIGITS_REGEX = /^[0-9]{4}$/

const GENERIC_CLIENT_MESSAGES = Object.freeze({
  'unauthenticated': 'Sign in required.',
  'permission-denied': 'This account is not eligible to complete this action.',
  'invalid-argument': 'The request was invalid.',
  'failed-precondition':
    'This classroom cannot be read automatically. Contact your administrator for assistance.',
  'internal': 'An unexpected internal error occurred.',
})

export class StudentPinDirectoryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StudentPinDirectoryError'
    this.code = code
  }
}

export function studentPinCollection(firestore, classroomId) {
  const validClassroomId = validateCanonicalDocumentId(classroomId, 'classroomId')
  return firestore
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS)
    .doc(validClassroomId)
    .collection(STUDENT_PIN_DIRECTORY_COLLECTION)
}

export function studentPinPath(classroomId, studentId) {
  const validClassroomId = validateCanonicalDocumentId(classroomId, 'classroomId')
  const validStudentId = validateCanonicalDocumentId(studentId, 'studentId')
  return `${STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS}/${validClassroomId}/${STUDENT_PIN_DIRECTORY_COLLECTION}/${validStudentId}`
}

/**
 * The exact stored shape. `studentId` is mirrored into the body so a document
 * that was copied to the wrong path is detectable on read rather than being
 * shown against the wrong child.
 */
export function buildStudentPinDocument({ studentId, pin, timestamp }) {
  const validStudentId = validateCanonicalDocumentId(studentId, 'studentId')
  if (typeof pin !== 'string' || !ASCII_FOUR_DIGITS_REGEX.test(pin)) {
    throw new StudentPinDirectoryError(
      'invalid-argument',
      'pin must be exactly 4 ASCII digits.',
    )
  }
  return Object.freeze({
    studentId: validStudentId,
    pin,
    updatedAt: timestamp,
  })
}

/**
 * A stored entry is shown only when its whole identity is intact. A malformed or
 * mis-pathed document is skipped rather than surfaced, so the roster degrades to
 * "not set" for that child instead of displaying a value that may belong to
 * someone else.
 */
function readableEntry(docSnap) {
  const data = docSnap.data() ?? {}
  let canonicalStudentId
  try {
    canonicalStudentId = validateCanonicalDocumentId(docSnap.id, 'studentId')
  } catch {
    return null
  }
  if (canonicalStudentId !== docSnap.id) return null
  if (data.studentId !== canonicalStudentId) return null
  if (typeof data.pin !== 'string' || !ASCII_FOUR_DIGITS_REGEX.test(data.pin)) return null
  return { studentId: canonicalStudentId, pin: data.pin }
}

/**
 * Returns every current PIN for the caller's own classroom.
 *
 * The classroom is resolved from the caller's authenticated identity, never from
 * the request, so there is no parameter a caller could point at another
 * teacher's room. The request must be empty for the same reason.
 */
export async function listStudentPinsV2(request, { firestore, auth } = {}) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('firestore with collection method is required.')
  }
  if (request !== undefined && request !== null) {
    if (typeof request !== 'object' || Array.isArray(request)) {
      throw new StudentPinDirectoryError(
        'invalid-argument',
        'Request must be an object.',
      )
    }
    if (Object.keys(request).length > 0) {
      throw new StudentPinDirectoryError(
        'invalid-argument',
        'Request contains unknown or unauthorized fields.',
      )
    }
  }

  const tenant = await resolveActiveTeacherTenant({ firestore, auth })
  const snapshot = await studentPinCollection(firestore, tenant.classroomId).get()

  const pins = []
  for (const docSnap of snapshot.docs ?? []) {
    const entry = readableEntry(docSnap)
    if (entry) pins.push(entry)
  }
  pins.sort((a, b) => a.studentId.localeCompare(b.studentId))

  return Object.freeze({ classroomId: tenant.classroomId, pins })
}

function externalCodeFor(error) {
  if (error instanceof TeacherTenantResolverError) {
    switch (error.code) {
      case 'unauthenticated':
      case 'invalid-auth-uid':
        return 'unauthenticated'
      case 'teacher-not-found':
      case 'teacher-disabled':
        return 'permission-denied'
      default:
        return 'failed-precondition'
    }
  }
  if (error instanceof StudentPinDirectoryError) {
    return Object.prototype.hasOwnProperty.call(GENERIC_CLIENT_MESSAGES, error.code)
      ? error.code
      : 'internal'
  }
  return 'internal'
}

/**
 * Versioned callable adapter. The browser only ever sees an allowlisted code
 * with a fixed generic message, and the classroom ID is not echoed back.
 */
export async function listStudentPinsV2CallableHandler(
  data,
  context,
  dependencies = {},
) {
  const auth = context?.auth
  try {
    const result = await listStudentPinsV2(data, { ...dependencies, auth })
    return { pins: result.pins }
  } catch (error) {
    const code = externalCodeFor(error)
    throw new HttpsError(code, GENERIC_CLIENT_MESSAGES[code])
  }
}
