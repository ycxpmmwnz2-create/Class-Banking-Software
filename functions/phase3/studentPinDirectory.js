import { HttpsError } from 'firebase-functions/v2/https'

import { FIRESTORE_COLLECTIONS, TEACHER_STATUS } from '../phase1/firestoreSchema.js'
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
 * - `classrooms/{classroomId}/studentPins/{studentId}` matches no rule in the
 *   three Phase 3 rulesets, so under those Firestore's default deny makes it
 *   server-only and no pinned artifact had to change (see the CAVEAT below,
 *   which is load-bearing); and
 * - authentication continues to verify the bcrypt hash in the credential
 *   document. Nothing in this directory is ever consulted to authorize a login.
 *
 * CAVEAT — the server-only property is NOT unconditional. The legacy production
 * ruleset `firestore.rules` contains a recursive
 * `match /classrooms/{document=**}` that grants the single hard-coded teacher
 * UID read AND write on everything beneath /classrooms, this directory
 * included. Verified in the emulator: that identity can both read a PIN and
 * overwrite one, which would make a displayed PIN disagree with the bcrypt hash
 * that actually authenticates.
 *
 * An added `allow read, write: if false` does NOT fix this. Firestore rules are
 * a permissive union — any matching allow wins, and a narrower deny is ignored.
 * Closing it properly means narrowing that recursive legacy rule, which is a
 * change to the live V1 ruleset and out of scope for this feature.
 *
 * The operative control is therefore release ordering, which
 * `PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md` decision 8 already requires: final
 * rules deploy BEFORE the V2 server gate. Because V2 is gated off until then, no
 * document in this collection can exist while the legacy ruleset is live. Do not
 * deploy any V2 Function that writes here while `firestore.rules` is the active
 * ruleset. The default production `firebase.json` therefore selects
 * `firestore.phase3.final.rules`; the release-order contract pins that target so
 * a routine rules deployment cannot silently restore the recursive baseline.
 *
 * `tests/firestore/rules.baseline.test.js` pins this exposure as a fact rather
 * than leaving it an assumption, so narrowing the legacy rule later fails that
 * test and forces this comment to be revisited.
 *
 * The plaintext PIN is a real secret at rest. It must reach only the
 * authenticated, active, owning teacher of that exact classroom, and it must
 * never enter the aggregate client data object, tenant cache, backup export, or
 * any log.
 */
export const STUDENT_PIN_DIRECTORY_COLLECTION = 'studentPins'

const ASCII_FOUR_DIGITS_REGEX = /^[0-9]{4}$/
const STUDENT_PIN_DOCUMENT_KEYS = Object.freeze(['pin', 'studentId', 'updatedAt'])

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
  if (!isValidTimestamp(timestamp)) {
    throw new StudentPinDirectoryError(
      'invalid-argument',
      'timestamp must be a valid timestamp value.',
    )
  }
  return Object.freeze({
    studentId: validStudentId,
    pin,
    updatedAt: timestamp,
  })
}

function isValidTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value)
  if (value instanceof Date) return Number.isFinite(value.getTime())
  if (!value || typeof value !== 'object' || typeof value.toDate !== 'function') return false
  try {
    const date = value.toDate()
    return date instanceof Date && Number.isFinite(date.getTime())
  } catch {
    return false
  }
}

/**
 * A stored entry is shown only when its whole identity is intact. A malformed or
 * mis-pathed document is skipped rather than surfaced, so the roster degrades to
 * "not set" for that child instead of displaying a value that may belong to
 * someone else.
 */
function readableEntry(docSnap) {
  const data = docSnap.data() ?? {}
  const keys = Object.keys(data).sort()
  if (
    keys.length !== STUDENT_PIN_DOCUMENT_KEYS.length ||
    keys.some((key, index) => key !== STUDENT_PIN_DOCUMENT_KEYS[index])
  ) return null
  let canonicalStudentId
  try {
    canonicalStudentId = validateCanonicalDocumentId(docSnap.id, 'studentId')
  } catch {
    return null
  }
  if (canonicalStudentId !== docSnap.id) return null
  if (data.studentId !== canonicalStudentId) return null
  if (typeof data.pin !== 'string' || !ASCII_FOUR_DIGITS_REGEX.test(data.pin)) return null
  if (!isValidTimestamp(data.updatedAt)) return null
  return { studentId: canonicalStudentId, pin: data.pin }
}

function snapshotExists(snapshot) {
  return Boolean(snapshot && snapshot.exists === true)
}

async function readAuthorizedPinSnapshot(transaction, firestore, tenant) {
  const teacherRef = firestore
    .collection(FIRESTORE_COLLECTIONS.TEACHERS)
    .doc(tenant.teacherUid)
  const classroomRef = firestore
    .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
    .doc(tenant.classroomId)

  const teacherSnap = await transaction.get(teacherRef)
  const classroomSnap = await transaction.get(classroomRef)
  const teacher = teacherSnap.data?.() ?? {}
  const classroom = classroomSnap.data?.() ?? {}

  if (
    !snapshotExists(teacherSnap) ||
    !snapshotExists(classroomSnap) ||
    teacher.uid !== tenant.teacherUid ||
    teacher.status !== TEACHER_STATUS.ACTIVE ||
    teacher.classroomId !== tenant.classroomId ||
    classroom.ownerUid !== tenant.teacherUid
  ) {
    throw new StudentPinDirectoryError(
      'failed-precondition',
      'The reciprocal tenant foundation changed or is inconsistent.',
    )
  }

  return transaction.get(studentPinCollection(firestore, tenant.classroomId))
}

/**
 * Returns every current PIN for the caller's own classroom.
 *
 * The classroom is resolved from the caller's authenticated identity, never from
 * the request, so there is no parameter a caller could point at another
 * teacher's room. The request must be empty for the same reason.
 */
export async function listStudentPinsV2(request, { firestore, auth } = {}) {
  if (
    !firestore ||
    typeof firestore.collection !== 'function' ||
    typeof firestore.runTransaction !== 'function'
  ) {
    throw new TypeError('firestore with collection and runTransaction methods is required.')
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
  return firestore.runTransaction(async transaction => {
    const snapshot = await readAuthorizedPinSnapshot(transaction, firestore, tenant)
    const pins = []
    for (const docSnap of snapshot.docs ?? []) {
      const entry = readableEntry(docSnap)
      if (entry) pins.push(entry)
    }
    pins.sort((a, b) => a.studentId.localeCompare(b.studentId))

    return Object.freeze({ classroomId: tenant.classroomId, pins })
  })
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
