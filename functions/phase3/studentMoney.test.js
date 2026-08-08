import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveDeterministicStudentAuthUid } from '../phase2b/scopedCredentialProjection.js'
import {
  StudentMoneyError,
  submitStudentTransactionV2CallableHandler,
  submitStudentTransactionV2Service,
} from './studentMoney.js'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createMockFirestore(initialDocs = {}, { abortAttempts = 0 } = {}) {
  const store = new Map(Object.entries(initialDocs).map(([path, data]) => [path, clone(data)]))
  const attempts = []
  let transactionAttempts = 0

  function doc(path) {
    return { path, id: path.split('/').pop() }
  }

  function snapshot(ref) {
    const data = store.get(ref.path)
    return {
      exists: data !== undefined,
      id: ref.id,
      ref,
      data: () => clone(data),
    }
  }

  return {
    store,
    attempts,
    doc,
    get transactionAttempts() {
      return transactionAttempts
    },
    async runTransaction(callback) {
      for (;;) {
        transactionAttempts += 1
        const operations = []
        const writes = []
        let wrote = false
        const transaction = {
          async get(ref) {
            if (wrote) throw new Error('read after write')
            operations.push({ kind: 'read', path: ref.path })
            return snapshot(ref)
          },
          create(ref, data) {
            wrote = true
            operations.push({ kind: 'create', path: ref.path })
            writes.push({ kind: 'create', path: ref.path, data: clone(data) })
          },
          update(ref, data) {
            wrote = true
            operations.push({ kind: 'update', path: ref.path })
            writes.push({ kind: 'update', path: ref.path, data: clone(data) })
          },
        }
        const result = await callback(transaction)
        attempts.push(operations)
        if (transactionAttempts <= abortAttempts) continue
        for (const write of writes) {
          if (write.kind === 'create') {
            if (store.has(write.path)) throw new Error(`ALREADY_EXISTS: ${write.path}`)
            store.set(write.path, write.data)
          } else {
            if (!store.has(write.path)) throw new Error(`NOT_FOUND: ${write.path}`)
            store.set(write.path, { ...store.get(write.path), ...write.data })
          }
        }
        return result
      }
    },
  }
}

const CLASSROOM_ID = 'class-a'
const STUDENT_ID = '7'
const STUDENT_UID = deriveDeterministicStudentAuthUid(CLASSROOM_ID, STUDENT_ID)
const studentAuth = Object.freeze({
  uid: STUDENT_UID,
  token: Object.freeze({ role: 'student', classroomId: CLASSROOM_ID, studentId: STUDENT_ID }),
})

function foundation(overrides = {}) {
  return {
    'teachers/teacher-a': {
      uid: 'teacher-a',
      classroomId: CLASSROOM_ID,
      status: 'active',
      ...overrides.teacher,
    },
    [`classrooms/${CLASSROOM_ID}`]: {
      ownerUid: 'teacher-a',
      settings: {},
      ...overrides.classroom,
    },
    [`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`]: {
      id: Number(STUDENT_ID),
      name: 'Ada Student',
      balance: 20,
      frozen: false,
      transactions: [],
      ...overrides.student,
    },
  }
}

function transaction(overrides = {}) {
  return {
    id: 1700000000000,
    date: '2026-08-08T18:00:00.000Z',
    studentId: Number(STUDENT_ID),
    studentName: 'Ada Student',
    type: 'Add',
    amount: 5,
    reason: 'Homework',
    memo: '',
    category: '',
    status: 'Pending',
    source: 'Student',
    ...overrides,
  }
}

test('Add creates one pending ledger record and exact student mirror without changing balance', async () => {
  const firestore = createMockFirestore(foundation(), { abortAttempts: 1 })
  const result = await submitStudentTransactionV2Service(
    { transactionId: 1700000000000, type: 'Add', amount: 5, reason: 'Homework' },
    { firestore, auth: studentAuth, now: () => Date.parse('2026-08-08T18:00:00.000Z') },
  )

  assert.equal(firestore.transactionAttempts, 2)
  assert.deepEqual(result, { transaction: transaction(), balance: 20 })
  assert.deepEqual(
    firestore.store.get(`classrooms/${CLASSROOM_ID}/transactions/1700000000000`),
    transaction(),
  )
  assert.deepEqual(
    firestore.store.get(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`),
    {
      id: 7,
      name: 'Ada Student',
      balance: 20,
      frozen: false,
      transactions: [transaction()],
    },
  )
  for (const attempt of firestore.attempts) {
    const firstWrite = attempt.findIndex(operation => operation.kind !== 'read')
    assert.ok(firstWrite > 0)
    assert.equal(attempt.slice(firstWrite).some(operation => operation.kind === 'read'), false)
  }
})

test('Subtract atomically decrements the latest balance and stores one approved transaction', async () => {
  const firestore = createMockFirestore(foundation())
  const result = await submitStudentTransactionV2Service(
    { transactionId: 1700000000001, type: 'Subtract', amount: 6, reason: 'Rent' },
    { firestore, auth: studentAuth, now: () => Date.parse('2026-08-08T18:01:00.000Z') },
  )
  const expected = transaction({
    id: 1700000000001,
    date: '2026-08-08T18:01:00.000Z',
    type: 'Subtract',
    amount: 6,
    reason: 'Rent',
    status: 'Approved',
  })
  assert.deepEqual(result, { transaction: expected, balance: 14 })
  assert.equal(
    firestore.store.get(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`).balance,
    14,
  )
  assert.deepEqual(
    firestore.store.get(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`).transactions,
    [expected],
  )
})

test('an exact retry is idempotent and an already-processed Add returns its current status', async () => {
  const approved = transaction({ status: 'Approved' })
  const firestore = createMockFirestore({
    ...foundation({ student: { balance: 25, transactions: [approved] } }),
    [`classrooms/${CLASSROOM_ID}/transactions/${approved.id}`]: approved,
  })
  const result = await submitStudentTransactionV2Service(
    { transactionId: approved.id, type: 'Add', amount: 5, reason: 'Homework' },
    { firestore, auth: studentAuth, now: () => { throw new Error('replay must not use the clock') } },
  )
  assert.deepEqual(result, { transaction: approved, balance: 25 })
  assert.equal(firestore.attempts[0].some(operation => operation.kind !== 'read'), false)
})

test('malformed requests and forged student identities fail before Firestore access', async () => {
  const invalidRequests = [
    null,
    {},
    { transactionId: 0, type: 'Add', amount: 1, reason: 'Homework' },
    { transactionId: 1.5, type: 'Add', amount: 1, reason: 'Homework' },
    { transactionId: 1, type: 'Credit', amount: 1, reason: 'Homework' },
    { transactionId: 1, type: 'Add', amount: 0, reason: 'Homework' },
    { transactionId: 1, type: 'Add', amount: 0.5, reason: 'Homework' },
    { transactionId: 1, type: 'Add', amount: Number.MAX_SAFE_INTEGER + 1, reason: 'Homework' },
    { transactionId: 1, type: 'Add', amount: Number.NaN, reason: 'Homework' },
    { transactionId: 1, type: 'Add', amount: 1, reason: '' },
    { transactionId: 1, type: 'Add', amount: 1, reason: 'Homework', classroomId: CLASSROOM_ID },
  ]
  for (const request of invalidRequests) {
    const firestore = createMockFirestore(foundation())
    await assert.rejects(
      submitStudentTransactionV2Service(request, { firestore, auth: studentAuth }),
      error => error instanceof StudentMoneyError && error.code === 'invalid-argument',
    )
    assert.equal(firestore.transactionAttempts, 0)
  }

  const forgedAuth = [
    null,
    { uid: STUDENT_UID, token: { role: 'teacher', classroomId: CLASSROOM_ID, studentId: STUDENT_ID } },
    { uid: 'someone-else', token: { role: 'student', classroomId: CLASSROOM_ID, studentId: STUDENT_ID } },
    { uid: STUDENT_UID, token: { role: 'student', classroomId: 'other-room', studentId: STUDENT_ID } },
    { uid: STUDENT_UID, token: { role: 'student', classroomId: CLASSROOM_ID, studentId: '07' } },
  ]
  for (const auth of forgedAuth) {
    const firestore = createMockFirestore(foundation())
    await assert.rejects(
      submitStudentTransactionV2Service(
        { transactionId: 1, type: 'Add', amount: 1, reason: 'Homework' },
        { firestore, auth },
      ),
      error => error instanceof StudentMoneyError &&
        ['unauthenticated', 'permission-denied'].includes(error.code),
    )
    assert.equal(firestore.transactionAttempts, 0)
  }
})

test('settings, frozen state, reason allowlists, and balance are enforced server-side', async () => {
  const cases = [
    ['global off', foundation({ classroom: { settings: { studentRequestsEnabled: false } } }),
      { type: 'Add', amount: 1, reason: 'Homework' }, 'failed-precondition'],
    ['add off', foundation({ classroom: { settings: { studentAddRequestsEnabled: false } } }),
      { type: 'Add', amount: 1, reason: 'Homework' }, 'failed-precondition'],
    ['subtract off', foundation({ classroom: { settings: { studentSubtractRequestsEnabled: false } } }),
      { type: 'Subtract', amount: 1, reason: 'Rent' }, 'failed-precondition'],
    ['frozen', foundation({ student: { frozen: true } }),
      { type: 'Add', amount: 1, reason: 'Homework' }, 'failed-precondition'],
    ['unknown add reason', foundation(),
      { type: 'Add', amount: 1, reason: 'Forged' }, 'invalid-argument'],
    ['teacher choice', foundation(),
      { type: 'Subtract', amount: 1, reason: "Teacher's Choice" }, 'invalid-argument'],
    ['insufficient balance', foundation(),
      { type: 'Subtract', amount: 21, reason: 'Rent' }, 'failed-precondition'],
    ['malformed settings', foundation({ classroom: { settings: { studentRequestsEnabled: 'yes' } } }),
      { type: 'Add', amount: 1, reason: 'Homework' }, 'failed-precondition'],
  ]
  for (const [label, docs, request, code] of cases) {
    const firestore = createMockFirestore(docs)
    await assert.rejects(
      submitStudentTransactionV2Service(
        { transactionId: 1700000000002, ...request },
        { firestore, auth: studentAuth },
      ),
      error => {
        assert.equal(error.code, code, label)
        return true
      },
    )
    assert.deepEqual(Object.fromEntries(firestore.store), docs, label)
  }
})

test('foundation, student shape, mirror, and transaction ID conflicts fail without repair writes', async () => {
  const sameId = transaction()
  const conflicting = transaction({ amount: 6 })
  const cases = [
    ['disabled owner', foundation({ teacher: { status: 'disabled' } }), 'failed-precondition'],
    ['owner mismatch', foundation({ classroom: { ownerUid: 'other-teacher' } }), 'failed-precondition'],
    ['student missing', (() => {
      const docs = foundation()
      delete docs[`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`]
      return docs
    })(), 'not-found'],
    ['student extra key', foundation({ student: { pin: '1234' } }), 'failed-precondition'],
    ['orphan mirror', foundation({ student: { transactions: [sameId] } }), 'failed-precondition'],
    ['ledger collision', {
      ...foundation(),
      [`classrooms/${CLASSROOM_ID}/transactions/${sameId.id}`]: {
        ...sameId,
        studentName: 'Different Student',
      },
    }, 'failed-precondition'],
    ['valid existing ID bound to different request data', {
      ...foundation({ student: { transactions: [conflicting] } }),
      [`classrooms/${CLASSROOM_ID}/transactions/${conflicting.id}`]: conflicting,
    }, 'already-exists'],
  ]
  for (const [label, docs, code] of cases) {
    const firestore = createMockFirestore(docs)
    await assert.rejects(
      submitStudentTransactionV2Service(
        { transactionId: sameId.id, type: 'Add', amount: 5, reason: 'Homework' },
        { firestore, auth: studentAuth },
      ),
      error => {
        assert.equal(error.code, code, label)
        return true
      },
    )
    assert.deepEqual(Object.fromEntries(firestore.store), docs, label)
  }
})

test('callable returns only public transaction state and redacts service details', async () => {
  const firestore = createMockFirestore(foundation())
  const result = await submitStudentTransactionV2CallableHandler(
    { transactionId: 1700000000000, type: 'Add', amount: 5, reason: 'Homework' },
    { auth: studentAuth },
    { firestore, now: () => Date.parse('2026-08-08T18:00:00.000Z') },
  )
  assert.deepEqual(Object.keys(result).sort(), ['balance', 'transaction'])
  assert.deepEqual(Object.keys(result.transaction).sort(), [...TRANSACTION_KEYS_FOR_TEST])

  await assert.rejects(
    submitStudentTransactionV2CallableHandler(
      { transactionId: 2, type: 'Add', amount: 1, reason: 'private-forged-reason' },
      { auth: studentAuth },
      { firestore: createMockFirestore(foundation()) },
    ),
    error => {
      assert.equal(error.code, 'invalid-argument')
      assert.equal(error.message, 'The request was invalid.')
      assert.equal(JSON.stringify(error).includes('private-forged-reason'), false)
      return true
    },
  )
})

const TRANSACTION_KEYS_FOR_TEST = Object.freeze([
  'amount', 'category', 'date', 'id', 'memo', 'reason', 'source', 'status',
  'studentId', 'studentName', 'type',
])
