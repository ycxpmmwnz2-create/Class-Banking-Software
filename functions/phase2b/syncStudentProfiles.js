import {
  validateCanonicalDocumentId,
} from './identityNormalization.js'
import { STUDENT_CREDENTIAL_COLLECTIONS } from './studentCredentialPaths.js'
import { deriveDeterministicStudentAuthUid } from './scopedCredentialProjection.js'
import { FIRESTORE_COLLECTIONS, TEACHER_STATUS } from '../phase1/firestoreSchema.js'

const DUMMY_PIN_HASH =
  '$2b$10$Ds5wfuAE9LT3Xe4vdygSMu1VUq0m8830nB5uQauQ0105kP4WDUR.a'

export class SyncStudentProfilesError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SyncStudentProfilesError'
    this.code = code
  }
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

export async function syncStudentProfilesV2Handler(
  event,
  { firestore, now = Date.now } = {},
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

  const attemptTime = now()

  // 1. Foundation validation: check classroom root and reciprocal owner teacher
  const classroomRef = firestore
    .collection(FIRESTORE_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
  const classroomSnap = await classroomRef.get()

  if (!classroomSnap.exists) {
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
  const teacherSnap = await teacherRef.get()

  if (!teacherSnap.exists) {
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

  const beforeSnap = event.change?.before
  const afterSnap = event.change?.after

  const isCreate = (!beforeSnap || !beforeSnap.exists) && (afterSnap && afterSnap.exists)
  const isDelete = (beforeSnap && beforeSnap.exists) && (!afterSnap || !afterSnap.exists)
  const isUpdate = (beforeSnap && beforeSnap.exists) && (afterSnap && afterSnap.exists)

  const credColRef = firestore
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_CREDENTIALS)

  return await firestore.runTransaction(async (transaction) => {
    // Check existing credential by studentId in this classroom
    const existingStudentCredQuery = credColRef.where('studentId', '==', studentId).limit(2)
    const existingCredSnap = await transaction.get(existingStudentCredQuery)

    if (isCreate) {
      // Fail closed if ANY existing credential for this studentId exists
      if (!existingCredSnap.empty && existingCredSnap.docs.length > 0) {
        throw new SyncStudentProfilesError(
          'failed-precondition',
          `Credential already exists for studentId ${studentId}; recycled studentId is rejected.`,
        )
      }

      const studentData = afterSnap.data() ?? {}
      const rawName = studentData.name ?? studentData.displayName ?? ''
      const baseLoginId = deriveBaseLoginId(rawName)

      // Derive collision-free loginId inside this classroom
      let assignedLoginId = baseLoginId
      let suffixCounter = 2

      while (true) {
        const candidateRef = credColRef.doc(assignedLoginId)
        const candidateSnap = await transaction.get(candidateRef)
        if (!candidateSnap.exists) {
          break
        }
        assignedLoginId = `${baseLoginId}-${suffixCounter}`
        suffixCounter += 1
      }

      const authUid = deriveDeterministicStudentAuthUid(classroomId, studentId)

      const newCredRef = credColRef.doc(assignedLoginId)
      const newCredData = {
        loginId: assignedLoginId,
        classroomId,
        studentId,
        authUid,
        active: false,
        pinHash: DUMMY_PIN_HASH,
        failedAttempts: 0,
        lockedUntil: null,
        schemaVersion: 1,
        createdAt: attemptTime,
        updatedAt: attemptTime,
        pinUpdatedAt: attemptTime,
      }

      transaction.set(newCredRef, newCredData)

      return Object.freeze({
        success: true,
        action: 'created',
        loginId: assignedLoginId,
        authUid,
      })
    }

    if (isUpdate) {
      if (existingCredSnap.empty || existingCredSnap.docs.length === 0) {
        throw new SyncStudentProfilesError(
          'failed-precondition',
          `No credential document found for studentId ${studentId}.`,
        )
      }

      if (existingCredSnap.docs.length > 1) {
        throw new SyncStudentProfilesError(
          'failed-precondition',
          `Multiple credential documents found for studentId ${studentId}.`,
        )
      }

      const credDocSnap = existingCredSnap.docs[0]
      const credRef = credDocSnap.ref

      // Preserve all immutable identity, PIN, auth, and lock fields
      transaction.update(credRef, {
        updatedAt: attemptTime,
      })

      return Object.freeze({
        success: true,
        action: 'updated',
        loginId: credDocSnap.id,
      })
    }

    if (isDelete) {
      if (existingCredSnap.empty || existingCredSnap.docs.length === 0) {
        // State-idempotent: no credential to deactivate
        return Object.freeze({
          success: true,
          action: 'deleted_noop',
        })
      }

      if (existingCredSnap.docs.length > 1) {
        throw new SyncStudentProfilesError(
          'failed-precondition',
          `Multiple credential documents found for studentId ${studentId}.`,
        )
      }

      const credDocSnap = existingCredSnap.docs[0]
      const credRef = credDocSnap.ref

      // Mark credential inactive without deleting document
      transaction.update(credRef, {
        active: false,
        updatedAt: attemptTime,
      })

      return Object.freeze({
        success: true,
        action: 'deactivated',
        loginId: credDocSnap.id,
      })
    }

    return Object.freeze({ success: true, action: 'none' })
  })
}
