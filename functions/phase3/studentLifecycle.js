import bcrypt from 'bcryptjs'
import { HttpsError } from 'firebase-functions/v2/https'

import { FIRESTORE_COLLECTIONS, TEACHER_STATUS } from '../phase1/firestoreSchema.js'
import {
  normalizeDisplayName,
  validateCanonicalDocumentId,
} from '../phase2b/identityNormalization.js'
import {
  STUDENT_CREDENTIAL_COLLECTIONS,
} from '../phase2b/studentCredentialPaths.js'
import {
  TeacherTenantResolverError,
  resolveActiveTeacherTenant,
} from '../phase2b/teacherTenantResolver.js'
import {
  buildCandidateLoginId,
  buildTrustedLifecycleCredential,
  deriveBaseLoginId,
  assertExistingCredentialIdentity,
} from '../phase2b/syncStudentProfiles.js'

const ASCII_FOUR_DIGITS_REGEX = /^[0-9]{4}$/
const MAX_LOGIN_ID_CANDIDATES = 200
const MAX_STARTING_BALANCE = Number.MAX_SAFE_INTEGER
const STUDENT_PIN_BCRYPT_COST = 12

const GENERIC_CLIENT_MESSAGES = Object.freeze({
  'unauthenticated': 'Sign in required.',
  'permission-denied': 'This account is not eligible to complete this action.',
  'invalid-argument': 'The request was invalid.',
  'not-found': 'That student was not found in your classroom.',
  'failed-precondition':
    'This student record cannot be updated automatically. Contact your administrator for assistance.',
  'already-exists': 'That student could not be created because its identity is already in use.',
  'aborted': 'The request could not be completed. Please try again.',
  'resource-exhausted': 'The request could not be completed. Please try again later.',
  'internal': 'An unexpected internal error occurred.',
})

export class StudentLifecycleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StudentLifecycleError'
    this.code = code
  }
}

export async function defaultHashStudentPin(pin) {
  return await bcrypt.hash(pin, STUDENT_PIN_BCRYPT_COST)
}

function requireExactRequestKeys(request, allowedKeys) {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new StudentLifecycleError('invalid-argument', 'Request must be a plain object.')
  }
  const keys = Object.keys(request)
  if (keys.length !== allowedKeys.length || keys.some(key => !allowedKeys.includes(key))) {
    throw new StudentLifecycleError(
      'invalid-argument',
      'Request fields do not match the lifecycle contract.',
    )
  }
}

function validateCreateRequest(request) {
  requireExactRequestKeys(request, ['name', 'startingBalance', 'pin'])

  let name
  try {
    name = normalizeDisplayName(request.name)
  } catch {
    throw new StudentLifecycleError('invalid-argument', 'Student name is malformed.')
  }
  if (!name) {
    throw new StudentLifecycleError('invalid-argument', 'Student name must not be empty.')
  }

  const startingBalance = request.startingBalance
  if (
    typeof startingBalance !== 'number' ||
    !Number.isFinite(startingBalance) ||
    Math.abs(startingBalance) > MAX_STARTING_BALANCE
  ) {
    throw new StudentLifecycleError('invalid-argument', 'Starting balance is invalid.')
  }

  if (typeof request.pin !== 'string' || !ASCII_FOUR_DIGITS_REGEX.test(request.pin)) {
    throw new StudentLifecycleError('invalid-argument', 'PIN must be exactly four ASCII digits.')
  }

  return Object.freeze({ name, startingBalance, pin: request.pin })
}

function validateRemoveRequest(request) {
  requireExactRequestKeys(request, ['studentId'])
  let studentId
  try {
    studentId = validateCanonicalDocumentId(request.studentId, 'studentId')
  } catch {
    throw new StudentLifecycleError('invalid-argument', 'studentId is malformed.')
  }
  if (!/^[1-9][0-9]*$/.test(studentId) || !Number.isSafeInteger(Number(studentId))) {
    throw new StudentLifecycleError(
      'invalid-argument',
      'studentId must be a canonical positive safe integer string.',
    )
  }
  return studentId
}

function snapshotExists(snapshot) {
  return Boolean(snapshot && snapshot.exists === true)
}

async function revalidateResolvedFoundation(transaction, firestore, tenant) {
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
    throw new StudentLifecycleError(
      'failed-precondition',
      'The reciprocal tenant foundation changed or is inconsistent.',
    )
  }

  return { classroomRef, classroom }
}

function requireCounter(classroom) {
  const counter = classroom.nextStudentNumber
  if (!Number.isSafeInteger(counter) || counter < 1 || counter >= Number.MAX_SAFE_INTEGER) {
    throw new StudentLifecycleError(
      'failed-precondition',
      'Classroom nextStudentNumber is missing, exhausted, or malformed.',
    )
  }
  return counter
}

function credentialCollection(firestore, classroomId) {
  return firestore
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_CREDENTIALS)
}

function studentCollection(firestore, classroomId) {
  return firestore
    .collection(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS)
    .doc(classroomId)
    .collection('students')
}

export async function createStudentV2Service(
  request,
  { firestore, auth, hashPin = defaultHashStudentPin, now = Date.now } = {},
) {
  if (!firestore || typeof firestore.runTransaction !== 'function') {
    throw new TypeError('firestore with runTransaction method is required.')
  }
  const validated = validateCreateRequest(request)
  const tenant = await resolveActiveTeacherTenant({ firestore, auth })

  // This expensive secret-bearing work happens once, before Firestore may
  // retry the transaction callback. Neither the PIN nor its hash is returned.
  const pinHash = await hashPin(validated.pin)
  if (typeof pinHash !== 'string' || !pinHash) {
    throw new StudentLifecycleError('internal', 'PIN hash dependency failed.')
  }
  const timestamp = now()
  const students = studentCollection(firestore, tenant.classroomId)
  const credentials = credentialCollection(firestore, tenant.classroomId)

  return await firestore.runTransaction(async transaction => {
    const { classroomRef, classroom } = await revalidateResolvedFoundation(
      transaction,
      firestore,
      tenant,
    )
    const studentNumber = requireCounter(classroom)
    const studentId = String(studentNumber)
    const studentRef = students.doc(studentId)
    const studentSnap = await transaction.get(studentRef)
    const studentCredentialQuery = credentials.where('studentId', '==', studentId).limit(2)
    const credentialQuerySnap = await transaction.get(studentCredentialQuery)

    if (snapshotExists(studentSnap) || (credentialQuerySnap.docs?.length ?? 0) > 0) {
      throw new StudentLifecycleError(
        'already-exists',
        'The allocated student identity is already present.',
      )
    }

    const baseLoginId = deriveBaseLoginId(validated.name)
    let loginId = null
    let credentialRef = null
    for (let candidate = 1; candidate <= MAX_LOGIN_ID_CANDIDATES; candidate += 1) {
      const candidateLoginId = buildCandidateLoginId(baseLoginId, candidate)
      const candidateRef = credentials.doc(candidateLoginId)
      const candidateSnap = await transaction.get(candidateRef)
      if (!snapshotExists(candidateSnap)) {
        loginId = candidateLoginId
        credentialRef = candidateRef
        break
      }
    }
    if (!loginId || !credentialRef) {
      throw new StudentLifecycleError(
        'resource-exhausted',
        'No collision-free classroom login ID is available.',
      )
    }

    const studentDocument = Object.freeze({
      id: studentNumber,
      name: validated.name,
      balance: validated.startingBalance,
      frozen: false,
      transactions: [],
    })
    const credentialDocument = buildTrustedLifecycleCredential({
      loginId,
      classroomId: tenant.classroomId,
      studentId,
      pinHash,
      timestamp,
    })

    // Every transaction read is complete before this first write.
    transaction.update(classroomRef, { nextStudentNumber: studentNumber + 1 })
    transaction.create(studentRef, studentDocument)
    transaction.create(credentialRef, credentialDocument)

    return Object.freeze({
      student: Object.freeze({
        id: studentDocument.id,
        name: studentDocument.name,
        balance: studentDocument.balance,
        frozen: studentDocument.frozen,
      }),
      loginId,
    })
  })
}

function assertStudentIdentity(studentData, studentId) {
  const keys = Object.keys(studentData).sort()
  const exactKeys = ['balance', 'frozen', 'id', 'name', 'transactions']
  const bodyIdMatches =
    (typeof studentData.id === 'string' && studentData.id === studentId) ||
    (Number.isSafeInteger(studentData.id) &&
      studentData.id >= 1 &&
      String(studentData.id) === studentId)
  if (
    keys.length !== exactKeys.length ||
    !keys.every((key, index) => key === exactKeys[index]) ||
    !bodyIdMatches
  ) {
    throw new StudentLifecycleError(
      'failed-precondition',
      'Student document identity or shape is inconsistent.',
    )
  }
}

export async function removeStudentV2Service(
  request,
  { firestore, auth, now = Date.now } = {},
) {
  if (!firestore || typeof firestore.runTransaction !== 'function') {
    throw new TypeError('firestore with runTransaction method is required.')
  }
  const studentId = validateRemoveRequest(request)
  const tenant = await resolveActiveTeacherTenant({ firestore, auth })
  const timestamp = now()
  const students = studentCollection(firestore, tenant.classroomId)
  const credentials = credentialCollection(firestore, tenant.classroomId)

  return await firestore.runTransaction(async transaction => {
    await revalidateResolvedFoundation(transaction, firestore, tenant)
    const studentRef = students.doc(studentId)
    const studentSnap = await transaction.get(studentRef)
    const credentialQuery = credentials.where('studentId', '==', studentId).limit(2)
    const credentialQuerySnap = await transaction.get(credentialQuery)

    if (!snapshotExists(studentSnap)) {
      throw new StudentLifecycleError('not-found', 'Student document was not found.')
    }
    assertStudentIdentity(studentSnap.data() ?? {}, studentId)

    const credentialDocs = credentialQuerySnap.docs ?? []
    if (credentialDocs.length !== 1) {
      throw new StudentLifecycleError(
        'failed-precondition',
        'The student does not have exactly one scoped credential.',
      )
    }
    const credentialSnap = credentialDocs[0]
    const credentialData = credentialSnap.data() ?? {}
    try {
      assertExistingCredentialIdentity({
        credDocSnap: credentialSnap,
        credData: credentialData,
        classroomId: tenant.classroomId,
        studentId,
      })
    } catch {
      throw new StudentLifecycleError(
        'failed-precondition',
        'The scoped credential identity does not match the student.',
      )
    }
    if (credentialData.active !== true && credentialData.active !== false) {
      throw new StudentLifecycleError(
        'failed-precondition',
        'The scoped credential activation state is malformed.',
      )
    }

    // The counter is intentionally untouched and the credential is retained.
    transaction.delete(studentRef)
    transaction.update(credentialSnap.ref, { active: false, updatedAt: timestamp })
    return Object.freeze({ success: true })
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
  if (
    error instanceof StudentLifecycleError &&
    Object.prototype.hasOwnProperty.call(GENERIC_CLIENT_MESSAGES, error.code)
  ) {
    return error.code
  }
  if (error?.code === 10 || error?.code === 'aborted') return 'aborted'
  if (error?.code === 6 || error?.code === 'already-exists') return 'already-exists'
  return 'internal'
}

async function lifecycleCallable(service, data, context, dependencies) {
  try {
    return await service(data, { ...dependencies, auth: context?.auth })
  } catch (error) {
    const code = externalCodeFor(error)
    throw new HttpsError(code, GENERIC_CLIENT_MESSAGES[code])
  }
}

export async function createStudentV2CallableHandler(data, context, dependencies = {}) {
  return lifecycleCallable(createStudentV2Service, data, context, dependencies)
}

export async function removeStudentV2CallableHandler(data, context, dependencies = {}) {
  return lifecycleCallable(removeStudentV2Service, data, context, dependencies)
}
