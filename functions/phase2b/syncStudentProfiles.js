import bcrypt from 'bcryptjs'
import {
  normalizeStudentLoginId,
  validateCanonicalDocumentId,
} from './identityNormalization.js'
import { STUDENT_CREDENTIAL_COLLECTIONS } from './studentCredentialPaths.js'
import { deriveDeterministicStudentAuthUid } from './scopedCredentialProjection.js'
import { FIRESTORE_COLLECTIONS, TEACHER_STATUS } from '../phase1/firestoreSchema.js'

/**
 * Pure V2 handler for the trusted trigger path
 * `classrooms/{classroomId}/students/{studentId}`. Item 8 owns registering it
 * with `onDocumentWritten`; the legacy singleton trigger stays active and
 * untouched through Phase 2B.
 */

/** Matches the legacy sync's default PIN and bcrypt cost. */
export const DEFAULT_STUDENT_PIN = '1234'
export const STUDENT_PIN_BCRYPT_COST = 12

const SUPPORTED_CREDENTIAL_SCHEMA_VERSION = 1
const MAX_LOGIN_ID_LENGTH = 64
const MAX_COLLISION_CANDIDATES = 200
const MAX_CREATE_ATTEMPTS = 5

export class SyncStudentProfilesError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SyncStudentProfilesError'
    this.code = code
  }
}

export async function defaultHashPin(pin) {
  return await bcrypt.hash(pin, STUDENT_PIN_BCRYPT_COST)
}

export function deriveBaseLoginId(rawName) {
  if (typeof rawName !== 'string') {
    return 'student'
  }

  const nfkd = rawName.normalize('NFKD')
  const noCombining = nfkd.replace(/[\u0300-\u036f]/g, '')
  const asciiLower = noCombining.replace(/[A-Z]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) + 32),
  )
  const hyphens = asciiLower.replace(/[^a-z0-9]+/g, '-')
  const trimmed = hyphens.replace(/^-+|-+$/g, '')

  if (!trimmed) {
    return 'student'
  }

  const capped = trimmed.slice(0, 48).replace(/-+$/g, '')
  return capped || 'student'
}

/**
 * Collision candidates are `base`, then `base-2`, `base-3`, … Every candidate
 * must stay inside the 64-character login maximum and remain canonical, so a
 * long base is shortened to make room for the suffix rather than producing an
 * overlength or noncanonical ID.
 */
export function buildCandidateLoginId(baseLoginId, candidateNumber) {
  if (candidateNumber === 1) {
    return baseLoginId
  }

  const suffix = `-${candidateNumber}`
  const room = MAX_LOGIN_ID_LENGTH - suffix.length
  if (room < 1) {
    throw new SyncStudentProfilesError(
      'resource-exhausted',
      'Collision suffix cannot fit inside the login ID maximum.',
    )
  }
  const trimmedBase = baseLoginId.slice(0, room).replace(/-+$/g, '') || 'student'
  return `${trimmedBase}${suffix}`
}

function assertCanonicalLoginId(loginId) {
  let canonical
  try {
    canonical = normalizeStudentLoginId(loginId)
  } catch (error) {
    throw new SyncStudentProfilesError(
      'failed-precondition',
      `Generated login ID is not canonical: ${error.message}`,
    )
  }
  if (canonical !== loginId) {
    throw new SyncStudentProfilesError(
      'failed-precondition',
      'Generated login ID is not canonical.',
    )
  }
  return canonical
}

function snapshotExists(snapshot) {
  return Boolean(snapshot && snapshot.exists === true)
}

/**
 * Firestore Functions v2 delivers the document change as the CloudEvent
 * payload `event.data`; `firebase-functions` additionally patches a
 * v1-compatible `event.change` alias onto the same object. `event.data` is the
 * canonical contract Item 8 will register against, and the alias is accepted
 * only so a v1-shaped fixture stays usable.
 */
function resolveWrittenChange(event) {
  const isChangeLike = value =>
    typeof value === 'object' &&
    value !== null &&
    ('before' in value || 'after' in value)

  if (isChangeLike(event.data)) {
    return event.data
  }
  if (isChangeLike(event.change)) {
    return event.change
  }
  throw new SyncStudentProfilesError(
    'invalid-argument',
    'Event must carry a Firestore document change payload.',
  )
}

/**
 * Reads the classroom root and its reciprocal owner teacher *inside* the
 * credential transaction. Reading the foundation outside would let a teacher or
 * classroom be disabled between validation and the credential write.
 */
async function readValidatedFoundation(transaction, firestore, classroomId) {
  const classroomRef = firestore
    .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
  const classroomSnap = await transaction.get(classroomRef)

  if (!snapshotExists(classroomSnap)) {
    throw new SyncStudentProfilesError(
      'failed-precondition',
      'Classroom document not found.',
    )
  }

  const classroomData = classroomSnap.data() ?? {}
  let ownerUid
  try {
    ownerUid = validateCanonicalDocumentId(classroomData.ownerUid, 'ownerUid')
  } catch {
    throw new SyncStudentProfilesError(
      'failed-precondition',
      'Classroom ownerUid is invalid.',
    )
  }

  const teacherRef = firestore
    .collection(FIRESTORE_COLLECTIONS.TEACHERS)
    .doc(ownerUid)
  const teacherSnap = await transaction.get(teacherRef)

  if (!snapshotExists(teacherSnap)) {
    throw new SyncStudentProfilesError(
      'failed-precondition',
      'Teacher document not found.',
    )
  }

  const teacherData = teacherSnap.data() ?? {}
  if (
    teacherData.status !== TEACHER_STATUS.ACTIVE ||
    teacherData.uid !== ownerUid ||
    teacherData.classroomId !== classroomId
  ) {
    throw new SyncStudentProfilesError(
      'failed-precondition',
      'Teacher account is inactive or classroom ownership is mismatched.',
    )
  }
}

/**
 * An existing credential is only mutated when its whole identity matches the
 * event path's tenant and student. A forged or mis-copied credential must fail
 * closed instead of being updated or silently deactivated.
 */
function assertExistingCredentialIdentity({ credDocSnap, credData, classroomId, studentId }) {
  let canonicalLoginId
  try {
    canonicalLoginId = normalizeStudentLoginId(credDocSnap.id)
  } catch {
    canonicalLoginId = null
  }

  const identityMatches =
    canonicalLoginId === credDocSnap.id &&
    (credData.loginId === undefined || credData.loginId === canonicalLoginId) &&
    credData.studentId === studentId &&
    credData.classroomId === classroomId &&
    credData.authUid === deriveDeterministicStudentAuthUid(classroomId, studentId) &&
    credData.schemaVersion === SUPPORTED_CREDENTIAL_SCHEMA_VERSION

  if (!identityMatches) {
    throw new SyncStudentProfilesError(
      'failed-precondition',
      'Existing scoped credential identity does not match the event path.',
    )
  }
}

function isAlreadyExistsError(error) {
  if (!error) {
    return false
  }
  // gRPC ALREADY_EXISTS is code 6; the Admin SDK also surfaces the string form.
  if (error.code === 6 || error.code === 'already-exists') {
    return true
  }
  return typeof error.message === 'string' && /ALREADY_EXISTS/i.test(error.message)
}

export async function syncStudentProfilesV2Handler(
  event,
  { firestore, now = Date.now, hashPin = defaultHashPin } = {},
) {
  if (!firestore || typeof firestore.runTransaction !== 'function') {
    throw new TypeError('firestore with runTransaction method is required.')
  }

  if (typeof event !== 'object' || event === null) {
    throw new SyncStudentProfilesError(
      'invalid-argument',
      'Event must be a non-null object.',
    )
  }

  const params = event.params
  if (typeof params !== 'object' || params === null) {
    throw new SyncStudentProfilesError(
      'invalid-argument',
      'Event params must be a non-null object.',
    )
  }

  let classroomId
  let studentId
  try {
    classroomId = validateCanonicalDocumentId(params.classroomId, 'classroomId')
    studentId = validateCanonicalDocumentId(params.studentId, 'studentId')
  } catch (error) {
    throw new SyncStudentProfilesError(
      'invalid-argument',
      `Invalid event path params: ${error.message}`,
    )
  }

  const change = resolveWrittenChange(event)
  const beforeExists = snapshotExists(change.before)
  const afterExists = snapshotExists(change.after)

  let operation = 'none'
  if (!beforeExists && afterExists) {
    operation = 'create'
  } else if (beforeExists && !afterExists) {
    operation = 'delete'
  } else if (beforeExists && afterExists) {
    operation = 'update'
  }

  const attemptTime = now()

  // bcrypt runs once, before the transaction: hashing inside a callback
  // Firestore may retry would repeat an expensive round per attempt.
  let defaultPinHash = null
  if (operation === 'create') {
    defaultPinHash = await hashPin(DEFAULT_STUDENT_PIN)
    if (typeof defaultPinHash !== 'string' || !defaultPinHash) {
      throw new SyncStudentProfilesError(
        'internal',
        'Default PIN hash dependency produced no hash.',
      )
    }
  }

  const credColRef = firestore
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_CREDENTIALS)

  const runOnce = () => firestore.runTransaction(async (transaction) => {
    // ---- reads: foundation, then the studentId uniqueness check ----
    await readValidatedFoundation(transaction, firestore, classroomId)

    const existingCredQuery = credColRef.where('studentId', '==', studentId).limit(2)
    const existingCredSnap = await transaction.get(existingCredQuery)
    const existingDocs = existingCredSnap.empty ? [] : existingCredSnap.docs

    if (operation === 'create') {
      // `studentId` is load-bearing for PIN reset and for the deterministic
      // Auth UID, so any existing credential for it — active or inactive — is a
      // blocking integrity failure, never a second credential.
      if (existingDocs.length > 0) {
        throw new SyncStudentProfilesError(
          'failed-precondition',
          'Credential already exists for this student; a recycled studentId is rejected.',
        )
      }

      const studentData = change.after.data() ?? {}
      const rawName = studentData.name ?? studentData.displayName ?? ''
      const baseLoginId = deriveBaseLoginId(rawName)

      let assignedLoginId = null
      for (
        let candidateNumber = 1;
        candidateNumber <= MAX_COLLISION_CANDIDATES;
        candidateNumber += 1
      ) {
        const candidate = assertCanonicalLoginId(
          buildCandidateLoginId(baseLoginId, candidateNumber),
        )
        const candidateSnap = await transaction.get(credColRef.doc(candidate))
        if (!snapshotExists(candidateSnap)) {
          assignedLoginId = candidate
          break
        }
      }

      if (assignedLoginId === null) {
        throw new SyncStudentProfilesError(
          'resource-exhausted',
          'Could not allocate a collision-free scoped login ID for this classroom.',
        )
      }

      const authUid = deriveDeterministicStudentAuthUid(classroomId, studentId)

      // ---- writes ----
      // `create` carries an explicit does-not-exist precondition, so two
      // concurrent same-name creates cannot overwrite one another; the losing
      // transaction retries and takes the next suffix.
      transaction.create(credColRef.doc(assignedLoginId), {
        loginId: assignedLoginId,
        classroomId,
        studentId,
        authUid,
        active: false,
        pinHash: defaultPinHash,
        failedAttempts: 0,
        lockedUntil: null,
        schemaVersion: SUPPORTED_CREDENTIAL_SCHEMA_VERSION,
        createdAt: attemptTime,
        updatedAt: attemptTime,
        pinUpdatedAt: attemptTime,
      })

      return Object.freeze({
        success: true,
        action: 'created',
        loginId: assignedLoginId,
        authUid,
      })
    }

    if (operation === 'none') {
      return Object.freeze({ success: true, action: 'none' })
    }

    if (existingDocs.length > 1) {
      throw new SyncStudentProfilesError(
        'failed-precondition',
        'Multiple credential documents found for this student.',
      )
    }

    if (existingDocs.length === 0) {
      if (operation === 'delete') {
        // State-idempotent: nothing to deactivate.
        return Object.freeze({ success: true, action: 'deleted_noop' })
      }
      throw new SyncStudentProfilesError(
        'failed-precondition',
        'No credential document found for this student.',
      )
    }

    const credDocSnap = existingDocs[0]
    assertExistingCredentialIdentity({
      credDocSnap,
      credData: credDocSnap.data() ?? {},
      classroomId,
      studentId,
    })

    // ---- writes ----
    if (operation === 'update') {
      // Renaming a student never renames the assigned login ID, and no
      // identity, PIN, auth, or lock field is repaired here.
      transaction.update(credDocSnap.ref, { updatedAt: attemptTime })
      return Object.freeze({
        success: true,
        action: 'updated',
        loginId: credDocSnap.id,
      })
    }

    // Deletion deactivates this classroom's credential and never deletes it or
    // touches another classroom.
    transaction.update(credDocSnap.ref, { active: false, updatedAt: attemptTime })
    return Object.freeze({
      success: true,
      action: 'deactivated',
      loginId: credDocSnap.id,
    })
  })

  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
    try {
      return await runOnce()
    } catch (error) {
      // A create precondition lost a race with a concurrent same-name create.
      // Rescan and take the next suffix instead of failing the event.
      if (
        operation === 'create' &&
        isAlreadyExistsError(error) &&
        attempt < MAX_CREATE_ATTEMPTS
      ) {
        continue
      }
      throw error
    }
  }

  throw new SyncStudentProfilesError(
    'resource-exhausted',
    'Could not create a scoped credential after repeated login ID contention.',
  )
}
