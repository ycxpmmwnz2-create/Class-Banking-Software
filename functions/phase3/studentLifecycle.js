import { Buffer } from 'node:buffer'
import { teacherAwardPaths, actorState, receiptCount, moneyReceiptReply } from './teacherAwardService.js'
import { creationBinding, matchingCreationBinding, readCreationReceipt } from './studentCreationReceipt.js'
import { TEACHER_MONEY_LIMITS, deriveMoneyLedgerIds, requireMoneyCents } from './teacherMoneyContract.js'
import { estimateMoneyDocumentBytes } from './moneyDocumentSize.js'
import bcrypt from 'bcryptjs'
import { ClassroomAccessError, requireClassroomAccess, hasExactDataKeys, isControlGeneration } from './classroomAccess.js'
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
import {
  buildStudentPinDocument,
  studentPinCollection,
} from './studentPinDirectory.js'

const ASCII_FOUR_DIGITS_REGEX = /^[0-9]{4}$/
const MAX_LOGIN_ID_CANDIDATES = 200
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

function validateCreateRequest(request) {
  if (!hasExactDataKeys(request, ['name', 'startingBalanceCents', 'pin', 'requestId', 'classroomId', 'protocolVersion', 'controlGeneration']) ||
      request.protocolVersion !== 1 || !isControlGeneration(request.controlGeneration) ||
      typeof request.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(request.requestId)) {
    throw new StudentLifecycleError('invalid-argument', 'Refresh before creating a student.')
  }
  let name
  try {
    name = normalizeDisplayName(request.name)
    validateCanonicalDocumentId(request.classroomId)
    requireMoneyCents(request.startingBalanceCents)
  } catch { throw new StudentLifecycleError('invalid-argument', 'Invalid student request.') }
  if (!name || name.length > 120 || typeof request.pin !== 'string' || !ASCII_FOUR_DIGITS_REGEX.test(request.pin) ||
      Buffer.byteLength(JSON.stringify(request), 'utf8') > TEACHER_MONEY_LIMITS.requestBytes) {
    throw new StudentLifecycleError('invalid-argument', 'Invalid student request.')
  }
  return Object.freeze({ ...request, name })
}

function validateRemoveRequest(request) {
  if (!hasExactDataKeys(request, ['studentId', 'classroomId', 'protocolVersion', 'controlGeneration']) ||
      request.protocolVersion !== 1 || !isControlGeneration(request.controlGeneration)) {
    throw new StudentLifecycleError('invalid-argument', 'Refresh before removing a student.')
  }
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
  { firestore, auth, projectId, keyRing, hashPin = defaultHashStudentPin, now = Date.now } = {},
) {
  if (!firestore || typeof firestore.runTransaction !== 'function') {
    throw new TypeError('firestore with runTransaction method is required.')
  }
  const validated = validateCreateRequest(request)
  validateCanonicalDocumentId(projectId)
  const tenant = await resolveActiveTeacherTenant({ firestore, auth })
  if (validated.classroomId !== tenant.classroomId) throw new StudentLifecycleError('permission-denied', 'Classroom changed.')
  const identity = { projectId, classroomId: tenant.classroomId, teacherUid: tenant.teacherUid }
  const paths = teacherAwardPaths(tenant.classroomId, tenant.teacherUid, validated.requestId)
  // Keep one private key-ring snapshot across transaction retries. It is never logged or returned.
  const keys = JSON.parse(JSON.stringify(typeof keyRing === 'function' ? keyRing() : keyRing ?? null))

  // This expensive secret-bearing work happens once, before Firestore may
  // retry the transaction callback. Neither the PIN nor its hash is returned.
  const pinHash = await hashPin(validated.pin)
  if (typeof pinHash !== 'string' || !pinHash) {
    throw new StudentLifecycleError('internal', 'PIN hash dependency failed.')
  }
  const timestamp = now()
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !/^\d{4}-/.test(new Date(timestamp).toISOString())) {
    throw new StudentLifecycleError('failed-precondition', 'Invalid clock.')
  }
  const serverTime = new Date(timestamp).toISOString()
  const students = studentCollection(firestore, tenant.classroomId)
  const credentials = credentialCollection(firestore, tenant.classroomId)

  return await firestore.runTransaction(async rawTransaction => {
    let readBytes = 0
    const bound = 1024 * 1024 + 32 * 1024
    const transaction = {
      create: (...args) => rawTransaction.create(...args),
      update: (...args) => rawTransaction.update(...args),
      async get(ref) {
        // A query is limited to two credentials; reserve their maximum size before I/O.
        const reserved = typeof ref.path === 'string' && !ref.limit ? bound : 2 * bound
        if (readBytes + reserved > TEACHER_MONEY_LIMITS.transactionBytes) throw new StudentLifecycleError('resource-exhausted', 'Read capacity exceeded.')
        const snap = await rawTransaction.get(ref)
        if (snap.docs) readBytes += snap.docs.reduce((sum, row) => sum + estimateMoneyDocumentBytes(row.ref.path, row.data()), 0)
        else if (ref.path === `teachers/${tenant.teacherUid}` || ref.path === `classrooms/${tenant.classroomId}`) readBytes += bound
        else readBytes += estimateMoneyDocumentBytes(ref.path, snap.exists ? snap.data() : null)
        if (readBytes > TEACHER_MONEY_LIMITS.transactionBytes) throw new StudentLifecycleError('resource-exhausted', 'Read capacity exceeded.')
        return snap
      },
    }
    const { classroomRef, classroom } = await revalidateResolvedFoundation(
      transaction,
      firestore,
      tenant,
    )
    requireClassroomAccess(classroom.accessControl, { operation: 'recovery' })
    const receiptSnap = await transaction.get(firestore.doc(paths.receipt))
    const actor = actorState((await transaction.get(firestore.doc(paths.actor))).data(), tenant.teacherUid)
    const count = receiptCount((await transaction.get(firestore.doc(paths.quota))).data())
    if (receiptSnap.exists) {
      if (receiptSnap.data()?.status === 'cancelled') throw new StudentLifecycleError('failed-precondition', 'Request cancelled.')
      const receipt = readCreationReceipt(receiptSnap.data(), identity, validated.requestId)
      const binding = creationBinding(validated, identity, keys, receipt.keyVersion)
      if (!matchingCreationBinding(receipt.intentHmac, binding.intentHmac) || receipt.generation !== validated.controlGeneration) {
        throw new StudentLifecycleError('already-exists', 'Request conflict.')
      }
      if (count < 1 || (!receipt.acknowledged && actor.unacknowledgedRequestId !== validated.requestId) ||
          (receipt.acknowledged && actor.unacknowledgedRequestId === validated.requestId)) throw new StudentLifecycleError('failed-precondition', 'Invalid receipt state.')
      return moneyReceiptReply(receipt, count)
    }
    requireClassroomAccess(classroom.accessControl, { operation: 'mutate', ...validated })
    if (actor.unacknowledgedRequestId !== null || count >= TEACHER_MONEY_LIMITS.receipts) {
      throw new StudentLifecycleError('failed-precondition', 'Resolve the prior save or receipt capacity.')
    }
    const binding = creationBinding(validated, identity, keys)
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
      balance: validated.startingBalanceCents / 100,
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
    // The teacher-visible mirror of the same PIN. Written in this transaction so
    // a created student can never exist with a credential but no recoverable PIN,
    // which would silently show "not set" on the roster for a brand new child.
    const pinRef = studentPinCollection(firestore, tenant.classroomId).doc(studentId)
    const pinDocument = buildStudentPinDocument({
      studentId,
      pin: validated.pin,
      timestamp,
    })

    const ledgerId = deriveMoneyLedgerIds({ ...identity, protocolVersion: 1,
      requestId: validated.requestId, action: 'createStudent' }, [studentNumber])[0].ledgerId
    const ledgerRef = firestore.doc(`classrooms/${tenant.classroomId}/transactions/${ledgerId}`)
    const opening = validated.startingBalanceCents === 0 ? null : {
      id: ledgerId, studentId: studentNumber, studentName: validated.name, date: serverTime,
      type: validated.startingBalanceCents > 0 ? 'Add' : 'Subtract',
      amount: Math.abs(validated.startingBalanceCents) / 100, status: 'Approved',
      source: 'Opening Balance', category: 'Balance adjustment', reason: 'Opening balance',
      memo: 'Starting balance recorded when this account was created.',
    }
    if (opening && (await transaction.get(ledgerRef)).exists) throw new StudentLifecycleError('already-exists', 'Opening ledger collision.')
    if ((await transaction.get(pinRef)).exists) throw new StudentLifecycleError('already-exists', 'PIN identity collision.')
    const studentWithHistory = { ...studentDocument, transactions: opening ? [opening] : [] }
    const receipt = { version: 4, actorUid: tenant.teacherUid, requestId: validated.requestId,
      generation: validated.controlGeneration, status: 'committed', serverTime,
      action: 'createStudent', itemCount: 1, ledgerIds: opening ? [ledgerId] : [],
      acknowledged: false, studentId: studentNumber, loginId, ...binding }
    if (estimateMoneyDocumentBytes(paths.receipt, receipt) > TEACHER_MONEY_LIMITS.receiptBytes ||
        estimateMoneyDocumentBytes(studentRef.path, studentWithHistory) > TEACHER_MONEY_LIMITS.studentBytes) {
      throw new StudentLifecycleError('resource-exhausted', 'Creation exceeds capacity.')
    }
    const mutationBytes = [[studentRef.path, studentWithHistory], [credentialRef.path, credentialDocument],
      [pinRef.path, pinDocument], [paths.receipt, receipt], [paths.actor, actor],
      [paths.quota, {version: 1, count: count + 1}], [classroomRef.path, {nextStudentNumber: studentNumber + 1}],
      ...(opening ? [[ledgerRef.path, opening]] : [])].reduce((sum, [path, body]) => sum + estimateMoneyDocumentBytes(path, body), 0)
    if (readBytes + mutationBytes > TEACHER_MONEY_LIMITS.transactionBytes) throw new StudentLifecycleError('resource-exhausted', 'Creation capacity exceeded.')
    // Every transaction read is complete before this first write.
    transaction.update(classroomRef, { nextStudentNumber: studentNumber + 1 })
    transaction.create(studentRef, studentWithHistory)
    transaction.create(credentialRef, credentialDocument)
    transaction.create(pinRef, pinDocument)

    if (opening) transaction.create(ledgerRef, opening)
    transaction.create(firestore.doc(paths.receipt), receipt)
    transaction.update(firestore.doc(paths.actor), { ...actor, unacknowledgedRequestId: validated.requestId })
    transaction.update(firestore.doc(paths.quota), { version: 1, count: count + 1 })
    return moneyReceiptReply(receipt, count + 1)
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
  const capturedRequest = Object.freeze({ ...request })
  const tenant = await resolveActiveTeacherTenant({ firestore, auth })
  const timestamp = now()
  const students = studentCollection(firestore, tenant.classroomId)
  const credentials = credentialCollection(firestore, tenant.classroomId)

  return await firestore.runTransaction(async transaction => {
    const { classroom } = await revalidateResolvedFoundation(transaction, firestore, tenant)
    requireClassroomAccess(classroom.accessControl, { operation: 'mutate', ...capturedRequest })
    if (capturedRequest.classroomId !== tenant.classroomId) throw new StudentLifecycleError('permission-denied', 'Classroom changed.')
    const studentRef = students.doc(studentId)
    const studentSnap = await transaction.get(studentRef)
    const credentialQuery = credentials.where('studentId', '==', studentId).limit(2)
    const credentialQuerySnap = await transaction.get(credentialQuery)

    if (!snapshotExists(studentSnap)) {
      throw new StudentLifecycleError('not-found', 'Student document was not found.')
    }
    assertStudentIdentity(studentSnap.data() ?? {}, studentId)
    // Refuse before deletion, including a ledger-only pending record. The query
    // participates in this transaction, so a concurrent submission must retry.
    const pending = await transaction.get(firestore.collection('classrooms').doc(tenant.classroomId)
      .collection('transactions').where('studentId', '==', Number(studentId))
      .where('status', '==', 'Pending').limit(1))
    const history = studentSnap.data().transactions
    if (!Array.isArray(history)) throw new StudentLifecycleError('failed-precondition', 'Malformed history.')
    if (pending.docs.length || history.some(entry => entry?.status === 'Pending')) {
      throw new HttpsError('failed-precondition', 'Decide this student’s pending requests before removing them.',
        { reason: 'pending-requests', wroteNothing: true })
    }

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
    // The credential is retained deactivated for identity reasons, but a removed
    // student has no roster row to display a PIN on, so keeping the recoverable
    // copy would be exposure with no purpose. Deleting a document that was never
    // created is a no-op, which is the pre-existing-student case.
    transaction.delete(studentPinCollection(firestore, tenant.classroomId).doc(studentId))
    return Object.freeze({ success: true })
  })
}

function externalCodeFor(error) {
  if (error instanceof ClassroomAccessError) return error.code
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
    if (error instanceof HttpsError && error.details?.reason === 'pending-requests') throw error
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
