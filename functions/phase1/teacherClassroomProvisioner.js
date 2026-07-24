import { FieldValue } from 'firebase-admin/firestore'

import { FIRESTORE_COLLECTIONS } from './firestoreSchema.js'
import {
  buildClassroomDocument,
  buildTeacherDocument,
} from './teacherClassroomModels.js'

export class TeacherClassroomFoundationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TeacherClassroomFoundationError'
    this.code = code
  }
}

function requiredDependency(value, name) {
  if (!value) {
    throw new TypeError(`${name} is required.`)
  }

  return value
}

function requiredIdentifier(value, name) {
  const normalizedValue = typeof value === 'string' ? value.trim() : ''

  if (!normalizedValue || normalizedValue.includes('/')) {
    throw new TypeError(`${name} must be a non-empty Firestore document ID.`)
  }

  return normalizedValue
}

function existingClassroomId(teacherData) {
  const classroomId = typeof teacherData?.classroomId === 'string'
    ? teacherData.classroomId.trim()
    : ''

  if (!classroomId) {
    throw new TeacherClassroomFoundationError(
      'invalid-teacher-document',
      'The existing teacher document does not reference a classroom.',
    )
  }

  return classroomId
}

/**
 * Atomically creates the Phase 1 teacher and classroom documents.
 *
 * This helper is server-only. The caller is responsible for authenticating
 * and authorizing `uid`; a client-supplied UID must never be passed through
 * without verification. The helper is deliberately not registered as a
 * deployed callable during the additive foundation phase.
 */
export async function provisionTeacherClassroom({
  firestore,
  uid,
  displayName,
  email,
  classroomName,
  timestampFactory = FieldValue.serverTimestamp,
}) {
  const database = requiredDependency(firestore, 'firestore')
  const createTimestamp = requiredDependency(
    timestampFactory,
    'timestampFactory',
  )
  const teacherUid = requiredIdentifier(uid, 'uid')

  const teacherCollection = database.collection(
    FIRESTORE_COLLECTIONS.TEACHERS,
  )
  const classroomCollection = database.collection(
    FIRESTORE_COLLECTIONS.CLASSROOMS,
  )
  const teacherRef = teacherCollection.doc(teacherUid)
  const generatedClassroomRef = classroomCollection.doc()

  return database.runTransaction(async transaction => {
    const teacherSnapshot = await transaction.get(teacherRef)

    if (teacherSnapshot.exists) {
      const teacherData = teacherSnapshot.data()
      const classroomId = existingClassroomId(teacherData)
      const classroomRef = classroomCollection.doc(classroomId)
      const classroomSnapshot = await transaction.get(classroomRef)

      if (!classroomSnapshot.exists) {
        throw new TeacherClassroomFoundationError(
          'missing-classroom-document',
          'The existing teacher document references a missing classroom.',
        )
      }

      if (classroomSnapshot.data()?.ownerUid !== teacherUid) {
        throw new TeacherClassroomFoundationError(
          'classroom-owner-mismatch',
          'The existing classroom is not owned by the teacher.',
        )
      }

      return {
        created: false,
        teacherUid,
        classroomId,
      }
    }

    const timestamp = createTimestamp()
    const classroomId = generatedClassroomRef.id
    const classroomDocument = buildClassroomDocument({
      ownerUid: teacherUid,
      name: classroomName,
      timestamp,
    })
    const teacherDocument = buildTeacherDocument({
      uid: teacherUid,
      classroomId,
      displayName,
      email,
      timestamp,
    })

    transaction.create(generatedClassroomRef, classroomDocument)
    transaction.create(teacherRef, teacherDocument)

    return {
      created: true,
      teacherUid: teacherDocument.uid,
      classroomId,
    }
  })
}
