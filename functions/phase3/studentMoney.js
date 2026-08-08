import { HttpsError } from 'firebase-functions/v2/https'

import { FIRESTORE_COLLECTIONS, TEACHER_STATUS } from '../phase1/firestoreSchema.js'
import { validateCanonicalDocumentId } from '../phase2b/identityNormalization.js'
import { deriveDeterministicStudentAuthUid } from '../phase2b/scopedCredentialProjection.js'

const DEFAULT_STUDENT_MONEY_SETTINGS = Object.freeze({
  studentRequestsEnabled: true,
  studentAddRequestsEnabled: true,
  studentSubtractRequestsEnabled: true,
  addMoneyCategories: Object.freeze([
    'Homework',
    'Class Job',
    'Positive Consequence',
    'Going Above and Beyond',
    'Showing Work',
    'Earned Class Cash in Specials',
    "Teacher's Choice",
  ]),
  subtractMoneyCategories: Object.freeze([
    'Rent',
    'Restroom',
    'Class Store Purchase',
    'Roadrunner Ticket Purchase',
    'Negative Consequence',
    'Bad Language (Swearing, Racial Slurs, Etc...)',
    "Teacher's Choice",
  ]),
})

const TRANSACTION_KEYS = Object.freeze([
  'amount',
  'category',
  'date',
  'id',
  'memo',
  'reason',
  'source',
  'status',
  'studentId',
  'studentName',
  'type',
])

const GENERIC_CLIENT_MESSAGES = Object.freeze({
  'unauthenticated': 'Sign in required.',
  'permission-denied': 'This account cannot submit student transactions.',
  'invalid-argument': 'The request was invalid.',
  'not-found': 'Your student account is not available.',
  'failed-precondition': 'This transaction cannot be completed right now.',
  'already-exists': 'This request conflicts with an existing transaction.',
  'aborted': 'The request could not be completed. Please try again.',
  'resource-exhausted': 'The request could not be completed. Please try again later.',
  'internal': 'An unexpected internal error occurred.',
})

export class StudentMoneyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StudentMoneyError'
    this.code = code
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
}

function requirePositiveSafeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StudentMoneyError(
      'invalid-argument',
      `${fieldName} must be a positive safe integer.`,
    )
  }
  return value
}

function requireCanonicalPositiveId(value, fieldName) {
  let canonical
  try {
    canonical = validateCanonicalDocumentId(value, fieldName)
  } catch {
    throw new StudentMoneyError('permission-denied', `${fieldName} is malformed.`)
  }
  if (!/^[1-9][0-9]*$/.test(canonical) || !Number.isSafeInteger(Number(canonical))) {
    throw new StudentMoneyError('permission-denied', `${fieldName} is not canonical.`)
  }
  return canonical
}

function validateStudentAuth(auth) {
  if (!isPlainObject(auth) || typeof auth.uid !== 'string' || !auth.uid) {
    throw new StudentMoneyError('unauthenticated', 'Authentication required.')
  }
  const token = auth.token
  if (!isPlainObject(token) || token.role !== 'student') {
    throw new StudentMoneyError('permission-denied', 'Student role required.')
  }

  let uid
  let classroomId
  try {
    uid = validateCanonicalDocumentId(auth.uid, 'auth.uid')
    classroomId = validateCanonicalDocumentId(token.classroomId, 'classroomId')
  } catch {
    throw new StudentMoneyError('permission-denied', 'Student identity is malformed.')
  }
  const studentId = requireCanonicalPositiveId(token.studentId, 'studentId')
  if (uid !== deriveDeterministicStudentAuthUid(classroomId, studentId)) {
    throw new StudentMoneyError('permission-denied', 'Student identity does not match claims.')
  }
  return Object.freeze({ uid, classroomId, studentId })
}

function validateRequest(request) {
  const expected = ['amount', 'reason', 'transactionId', 'type']
  if (!hasExactKeys(request, expected)) {
    throw new StudentMoneyError(
      'invalid-argument',
      'Request fields do not match the student transaction contract.',
    )
  }
  const transactionId = requirePositiveSafeInteger(request.transactionId, 'transactionId')
  if (request.type !== 'Add' && request.type !== 'Subtract') {
    throw new StudentMoneyError('invalid-argument', 'Transaction type is unsupported.')
  }
  const amount = requirePositiveSafeInteger(request.amount, 'amount')
  if (typeof request.reason !== 'string' || !request.reason) {
    throw new StudentMoneyError('invalid-argument', 'Transaction reason is invalid.')
  }
  return Object.freeze({
    transactionId,
    type: request.type,
    amount,
    reason: request.reason,
  })
}

function snapshotExists(snapshot) {
  return Boolean(snapshot && snapshot.exists === true)
}

function requireStudentDocument(snapshot, identity) {
  if (!snapshotExists(snapshot)) {
    throw new StudentMoneyError('not-found', 'Student document was not found.')
  }
  const student = snapshot.data?.() ?? null
  const expectedKeys = ['balance', 'frozen', 'id', 'name', 'transactions']
  const numericStudentId = Number(identity.studentId)
  if (
    !hasExactKeys(student, expectedKeys) ||
    student.id !== numericStudentId ||
    typeof student.name !== 'string' ||
    !student.name ||
    typeof student.balance !== 'number' ||
    !Number.isFinite(student.balance) ||
    typeof student.frozen !== 'boolean' ||
    !Array.isArray(student.transactions)
  ) {
    throw new StudentMoneyError(
      'failed-precondition',
      'Student document identity or shape is inconsistent.',
    )
  }

  const seen = new Set()
  const transactions = student.transactions.map((transaction, index) => {
    const valid = validateStoredTransaction(
      transaction,
      numericStudentId,
      student.name,
      `student.transactions[${index}]`,
    )
    if (seen.has(valid.id)) {
      throw new StudentMoneyError(
        'failed-precondition',
        'Student transaction mirror contains a duplicate ID.',
      )
    }
    seen.add(valid.id)
    return valid
  })

  return Object.freeze({ ...student, transactions })
}

function validateStoredTransaction(transaction, studentId, studentName, label) {
  if (
    !hasExactKeys(transaction, TRANSACTION_KEYS) ||
    !Number.isSafeInteger(transaction.id) ||
    transaction.id < 1 ||
    transaction.studentId !== studentId ||
    transaction.studentName !== studentName ||
    typeof transaction.date !== 'string' ||
    !transaction.date ||
    (transaction.type !== 'Add' && transaction.type !== 'Subtract') ||
    typeof transaction.amount !== 'number' ||
    !Number.isFinite(transaction.amount) ||
    transaction.amount <= 0 ||
    typeof transaction.reason !== 'string' ||
    typeof transaction.memo !== 'string' ||
    typeof transaction.category !== 'string' ||
    typeof transaction.status !== 'string' ||
    typeof transaction.source !== 'string'
  ) {
    throw new StudentMoneyError(
      'failed-precondition',
      `${label} does not match the transaction contract.`,
    )
  }
  return Object.freeze({ ...transaction })
}

function requireFoundation(classroomSnapshot, teacherSnapshot, identity) {
  if (!snapshotExists(classroomSnapshot) || !snapshotExists(teacherSnapshot)) {
    throw new StudentMoneyError('failed-precondition', 'Tenant foundation is incomplete.')
  }
  const classroom = classroomSnapshot.data?.() ?? {}
  const teacher = teacherSnapshot.data?.() ?? {}
  if (
    classroom.ownerUid !== teacher.uid ||
    teacher.uid !== teacherSnapshot.id ||
    teacher.status !== TEACHER_STATUS.ACTIVE ||
    teacher.classroomId !== identity.classroomId ||
    classroomSnapshot.id !== identity.classroomId
  ) {
    throw new StudentMoneyError('failed-precondition', 'Tenant foundation is inconsistent.')
  }
  return classroom
}

function normalizedStudentMoneySettings(classroom) {
  const raw = classroom.settings ?? {}
  if (!isPlainObject(raw)) {
    throw new StudentMoneyError('failed-precondition', 'Classroom settings are malformed.')
  }

  const result = {
    studentRequestsEnabled: DEFAULT_STUDENT_MONEY_SETTINGS.studentRequestsEnabled,
    studentAddRequestsEnabled: DEFAULT_STUDENT_MONEY_SETTINGS.studentAddRequestsEnabled,
    studentSubtractRequestsEnabled: DEFAULT_STUDENT_MONEY_SETTINGS.studentSubtractRequestsEnabled,
    addMoneyCategories: [...DEFAULT_STUDENT_MONEY_SETTINGS.addMoneyCategories],
    subtractMoneyCategories: [...DEFAULT_STUDENT_MONEY_SETTINGS.subtractMoneyCategories],
  }
  for (const flag of [
    'studentRequestsEnabled',
    'studentAddRequestsEnabled',
    'studentSubtractRequestsEnabled',
  ]) {
    if (Object.prototype.hasOwnProperty.call(raw, flag)) {
      if (typeof raw[flag] !== 'boolean') {
        throw new StudentMoneyError('failed-precondition', 'Classroom settings are malformed.')
      }
      result[flag] = raw[flag]
    }
  }
  for (const categories of ['addMoneyCategories', 'subtractMoneyCategories']) {
    if (Object.prototype.hasOwnProperty.call(raw, categories)) {
      if (!Array.isArray(raw[categories]) || raw[categories].some(value => typeof value !== 'string')) {
        throw new StudentMoneyError('failed-precondition', 'Classroom settings are malformed.')
      }
      result[categories] = [...raw[categories]]
    }
  }
  return result
}

function requireTransactionEnabled(classroom, student, request) {
  if (student.frozen) {
    throw new StudentMoneyError('failed-precondition', 'Student account is frozen.')
  }
  const settings = normalizedStudentMoneySettings(classroom)
  const typeEnabled = request.type === 'Add'
    ? settings.studentAddRequestsEnabled
    : settings.studentSubtractRequestsEnabled
  if (!settings.studentRequestsEnabled || !typeEnabled) {
    throw new StudentMoneyError('failed-precondition', 'Student transactions are disabled.')
  }
  const allowedReasons = request.type === 'Add'
    ? settings.addMoneyCategories
    : settings.subtractMoneyCategories
  if (request.reason === "Teacher's Choice" || !allowedReasons.includes(request.reason)) {
    throw new StudentMoneyError('invalid-argument', 'Transaction reason is not allowed.')
  }
}

function matchesReplay(transaction, request, student) {
  const validStatus = request.type === 'Add'
    ? ['Pending', 'Approved', 'Denied'].includes(transaction.status)
    : transaction.status === 'Approved'
  return transaction.id === request.transactionId &&
    transaction.studentId === student.id &&
    transaction.studentName === student.name &&
    transaction.type === request.type &&
    transaction.amount === request.amount &&
    transaction.reason === request.reason &&
    transaction.memo === '' &&
    transaction.category === '' &&
    validStatus &&
    transaction.source === 'Student'
}

function sameTransaction(left, right) {
  return TRANSACTION_KEYS.every(key => left[key] === right[key])
}

function buildTransaction(request, student, now) {
  const timestamp = now()
  if (!Number.isFinite(timestamp)) {
    throw new StudentMoneyError('internal', 'Server clock is unavailable.')
  }
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) {
    throw new StudentMoneyError('internal', 'Server clock is unavailable.')
  }
  return Object.freeze({
    id: request.transactionId,
    date: date.toISOString(),
    studentId: student.id,
    studentName: student.name,
    type: request.type,
    amount: request.amount,
    reason: request.reason,
    memo: '',
    category: '',
    status: request.type === 'Add' ? 'Pending' : 'Approved',
    source: 'Student',
  })
}

export async function submitStudentTransactionV2Service(
  request,
  { firestore, auth, now = Date.now } = {},
) {
  if (!firestore || typeof firestore.doc !== 'function' ||
      typeof firestore.runTransaction !== 'function') {
    throw new TypeError('firestore with doc and runTransaction methods is required.')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.')

  const identity = validateStudentAuth(auth)
  const validated = validateRequest(request)
  const classroomRef = firestore.doc(
    `${FIRESTORE_COLLECTIONS.CLASSROOMS}/${identity.classroomId}`,
  )
  const studentRef = firestore.doc(
    `${FIRESTORE_COLLECTIONS.CLASSROOMS}/${identity.classroomId}/students/${identity.studentId}`,
  )
  const transactionRef = firestore.doc(
    `${FIRESTORE_COLLECTIONS.CLASSROOMS}/${identity.classroomId}/transactions/${validated.transactionId}`,
  )

  return firestore.runTransaction(async transaction => {
    // The owner UID lives on the classroom root, so that read must occur first.
    // Every remaining read still precedes the first write.
    const classroomSnapshot = await transaction.get(classroomRef)
    if (!snapshotExists(classroomSnapshot)) {
      throw new StudentMoneyError('failed-precondition', 'Classroom document is missing.')
    }
    const ownerUid = classroomSnapshot.data?.()?.ownerUid
    let canonicalOwnerUid
    try {
      canonicalOwnerUid = validateCanonicalDocumentId(ownerUid, 'ownerUid')
    } catch {
      throw new StudentMoneyError('failed-precondition', 'Classroom owner is malformed.')
    }
    const teacherRef = firestore.doc(`${FIRESTORE_COLLECTIONS.TEACHERS}/${canonicalOwnerUid}`)
    const teacherSnapshot = await transaction.get(teacherRef)
    const studentSnapshot = await transaction.get(studentRef)
    const existingTransactionSnapshot = await transaction.get(transactionRef)

    const classroom = requireFoundation(classroomSnapshot, teacherSnapshot, identity)
    const student = requireStudentDocument(studentSnapshot, identity)
    const mirror = student.transactions.find(item => item.id === validated.transactionId)

    if (snapshotExists(existingTransactionSnapshot)) {
      const existing = validateStoredTransaction(
        existingTransactionSnapshot.data?.(),
        student.id,
        student.name,
        'existing transaction',
      )
      if (!matchesReplay(existing, validated, student) || !mirror || !sameTransaction(existing, mirror)) {
        throw new StudentMoneyError(
          'already-exists',
          'Transaction ID is already bound to different data.',
        )
      }
      return Object.freeze({ transaction: existing, balance: student.balance })
    }

    if (mirror) {
      throw new StudentMoneyError(
        'failed-precondition',
        'Student mirror contains a transaction missing from the classroom ledger.',
      )
    }
    requireTransactionEnabled(classroom, student, validated)
    if (validated.type === 'Subtract' && validated.amount > student.balance) {
      throw new StudentMoneyError('failed-precondition', 'Student balance is insufficient.')
    }

    const newTransaction = buildTransaction(validated, student, now)
    const balance = validated.type === 'Subtract'
      ? student.balance - validated.amount
      : student.balance
    if (!Number.isFinite(balance)) {
      throw new StudentMoneyError('resource-exhausted', 'Student balance cannot be represented.')
    }

    transaction.create(transactionRef, newTransaction)
    transaction.update(studentRef, {
      balance,
      transactions: [newTransaction, ...student.transactions],
    })
    return Object.freeze({ transaction: newTransaction, balance })
  })
}

function externalCodeFor(error) {
  if (
    error instanceof StudentMoneyError &&
    Object.prototype.hasOwnProperty.call(GENERIC_CLIENT_MESSAGES, error.code)
  ) return error.code
  if (error?.code === 10 || error?.code === 'aborted') return 'aborted'
  if (error?.code === 6 || error?.code === 'already-exists') return 'already-exists'
  if (error?.code === 8 || error?.code === 'resource-exhausted') return 'resource-exhausted'
  return 'internal'
}

export async function submitStudentTransactionV2CallableHandler(
  data,
  context,
  dependencies = {},
) {
  try {
    return await submitStudentTransactionV2Service(data, {
      ...dependencies,
      auth: context?.auth,
    })
  } catch (error) {
    const code = externalCodeFor(error)
    throw new HttpsError(code, GENERIC_CLIENT_MESSAGES[code])
  }
}
