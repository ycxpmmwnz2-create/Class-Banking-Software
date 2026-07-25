import bcrypt from 'bcryptjs'
import {
  resolveActiveTeacherTenant,
  TeacherTenantResolverError,
} from './teacherTenantResolver.js'
import { validateCanonicalDocumentId } from './identityNormalization.js'
import { STUDENT_CREDENTIAL_COLLECTIONS } from './studentCredentialPaths.js'

const ASCII_FOUR_DIGITS_REGEX = /^[0-9]{4}$/

export class ResetStudentPinError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ResetStudentPinError'
    this.code = code
  }
}

export async function defaultHashPin(pin) {
  return await bcrypt.hash(pin, 10)
}

export async function resetStudentPinV2(
  request,
  {
    firestore,
    auth,
    hashPin = defaultHashPin,
    now = Date.now,
  } = {},
) {
  if (typeof request !== 'object' || request === null) {
    throw new ResetStudentPinError(
      'invalid-argument',
      'Request must be a non-null object.',
    )
  }

  const keys = Object.keys(request)
  const allowedKeys = ['studentId', 'newPin']
  if (keys.some(k => !allowedKeys.includes(k))) {
    throw new ResetStudentPinError(
      'invalid-argument',
      'Request contains unknown or unauthorized fields.',
    )
  }

  if (typeof request.studentId !== 'string') {
    throw new ResetStudentPinError(
      'invalid-argument',
      'studentId must be a string.',
    )
  }

  let validStudentId
  try {
    validStudentId = validateCanonicalDocumentId(request.studentId, 'studentId')
  } catch (error) {
    throw new ResetStudentPinError(
      'invalid-argument',
      `studentId is malformed: ${error.message}`,
    )
  }

  if (
    typeof request.newPin !== 'string' ||
    !ASCII_FOUR_DIGITS_REGEX.test(request.newPin)
  ) {
    throw new ResetStudentPinError(
      'invalid-argument',
      'newPin must be exactly 4 ASCII digits.',
    )
  }

  const tenant = await resolveActiveTeacherTenant({ firestore, auth })
  const classroomId = tenant.classroomId
  const attemptTime = now()

  const pinHash = await hashPin(request.newPin)

  const credColRef = firestore
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_CREDENTIALS)

  const query = credColRef.where('studentId', '==', validStudentId).limit(2)

  return await firestore.runTransaction(async (transaction) => {
    const credQuerySnap = await transaction.get(query)

    if (credQuerySnap.empty || credQuerySnap.docs.length === 0) {
      throw new ResetStudentPinError(
        'not-found',
        'Student credential document not found in classroom.',
      )
    }

    if (credQuerySnap.docs.length > 1) {
      throw new ResetStudentPinError(
        'failed-precondition',
        'Multiple credential documents found for studentId in classroom.',
      )
    }

    const credDocSnap = credQuerySnap.docs[0]
    const credRef = credDocSnap.ref

    const studentDocRef = firestore
      .collection(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS)
      .doc(classroomId)
      .collection('students')
      .doc(validStudentId)

    const studentSnap = await transaction.get(studentDocRef)
    if (!studentSnap.exists) {
      throw new ResetStudentPinError(
        'not-found',
        'Student document not found in classroom.',
      )
    }

    const credData = credDocSnap.data() ?? {}
    if (
      credData.studentId !== validStudentId ||
      (typeof credData.classroomId === 'string' &&
        credData.classroomId !== classroomId)
    ) {
      throw new ResetStudentPinError(
        'failed-precondition',
        'Credential document identity mismatch.',
      )
    }

    transaction.update(credRef, {
      pinHash,
      active: true,
      pinUpdatedAt: attemptTime,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: attemptTime,
    })

    return Object.freeze({
      success: true,
      classroomId,
      studentId: validStudentId,
    })
  })
}

export async function resetStudentPinV2CallableHandler(
  data,
  context,
  dependencies = {},
) {
  const auth = context?.auth
  try {
    const result = await resetStudentPinV2(data, { ...dependencies, auth })
    return { success: result.success }
  } catch (error) {
    if (
      error instanceof ResetStudentPinError ||
      error instanceof TeacherTenantResolverError
    ) {
      let canonicalCode = error.code
      if (canonicalCode === 'invalid-auth-uid') canonicalCode = 'unauthenticated'
      if (
        canonicalCode === 'teacher-not-found' ||
        canonicalCode === 'teacher-disabled' ||
        canonicalCode === 'invalid-teacher-status' ||
        canonicalCode === 'classroom-not-found' ||
        canonicalCode === 'classroom-owner-mismatch'
      ) {
        canonicalCode = 'permission-denied'
      }

      const httpsError = new Error(error.message)
      httpsError.code = canonicalCode
      throw httpsError
    }
    throw error
  }
}
