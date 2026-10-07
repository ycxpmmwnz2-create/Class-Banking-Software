import assert from 'node:assert/strict'
import test from 'node:test'

import { hashSha256 } from '../phase2b/identityNormalization.js'
import { deriveDeterministicStudentAuthUid } from '../phase2b/scopedCredentialProjection.js'
import {
  DEFAULT_ADD_MONEY_CATEGORIES,
  LEGACY_DEFAULT_ADD_MONEY_CATEGORIES as CLIENT_LEGACY_DEFAULT_ADD_MONEY_CATEGORIES,
} from '../../src/phase2b/transactionCategoryDisplay.js'
import {
  DEFAULT_STUDENT_ADD_MONEY_CATEGORIES,
  LEGACY_DEFAULT_ADD_MONEY_CATEGORIES,
  StudentMoneyError,
  submitStudentTransactionV2CallableHandler,
  submitStudentTransactionV2Service,
} from './studentMoney.js'

test('client and server standard Add Money category lists stay aligned', () => {
  assert.deepEqual(DEFAULT_STUDENT_ADD_MONEY_CATEGORIES, DEFAULT_ADD_MONEY_CATEGORIES)
  assert.deepEqual(
    LEGACY_DEFAULT_ADD_MONEY_CATEGORIES,
    CLIENT_LEGACY_DEFAULT_ADD_MONEY_CATEGORIES,
  )
})

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
          set(ref, data) {
            wrote = true
            operations.push({ kind: 'set', path: ref.path })
            writes.push({ kind: 'set', path: ref.path, data: clone(data) })
          },
        }
        const result = await callback(transaction)
        attempts.push(operations)
        if (transactionAttempts <= abortAttempts) continue
        for (const write of writes) {
          if (write.kind === 'create') {
            if (store.has(write.path)) throw new Error(`ALREADY_EXISTS: ${write.path}`)
            store.set(write.path, write.data)
          } else if (write.kind === 'update') {
            if (!store.has(write.path)) throw new Error(`NOT_FOUND: ${write.path}`)
            store.set(write.path, { ...store.get(write.path), ...write.data })
          } else {
            store.set(write.path, write.data)
          }
        }
        return result
      }
    },
  }
}

const CLASSROOM_ID = 'class-a'
const STUDENT_ID = '7'
const STUDENT_LOGIN_ID = 'ada-student'
const CREDENTIAL_VERSION = 1000
const STUDENT_UID = deriveDeterministicStudentAuthUid(CLASSROOM_ID, STUDENT_ID)
const studentAuth = Object.freeze({
  uid: STUDENT_UID,
  token: Object.freeze({
    role: 'student',
    classroomId: CLASSROOM_ID,
    studentId: STUDENT_ID,
    loginId: STUDENT_LOGIN_ID,
    credentialVersion: CREDENTIAL_VERSION,
  }),
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
      accessControl: { schemaVersion: 1, mode: 'active', generation: 1, changedAt: '2026-10-04T00:00:00.000Z', auditId: 'test-control' },
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
    [`classrooms/${CLASSROOM_ID}/studentCredentials/${STUDENT_LOGIN_ID}`]: {
      active: true,
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
      authUid: STUDENT_UID,
      pinUpdatedAt: CREDENTIAL_VERSION,
      ...overrides.credential,
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

function transactionHistory(count, startId = 1600000000000) {
  return Array.from({ length: count }, (_, index) => transaction({
    id: startId + index,
    date: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index).toISOString(),
  }))
}

test('Add creates one pending ledger record and exact student mirror without changing balance', async () => {
  const firestore = createMockFirestore(foundation(), { abortAttempts: 1 })
  const result = await submitStudentTransactionV2Service(
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000000, type: 'Add', amountCents: 500, reason: 'Homework' },
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
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000001, type: 'Subtract', amountCents: 600, reason: 'Rent' },
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
    { protocolVersion: 1, controlGeneration: 1, transactionId: approved.id, type: 'Add', amountCents: 500, reason: 'Homework' },
    { firestore, auth: studentAuth, now: () => { throw new Error('replay must not use the clock') } },
  )
  assert.deepEqual(result, { transaction: approved, balance: 25 })
  assert.equal(firestore.attempts[0].some(operation => operation.kind !== 'read'), false)
})

test('student submissions stop at the fixed mirror boundary while exact retries remain available', async () => {
  const existing = transactionHistory(999)
  const firestore = createMockFirestore(foundation({ student: { transactions: existing } }))
  const boundaryId = 1700000000100
  const boundaryTime = Date.parse('2026-08-08T18:02:00.000Z')

  const accepted = await submitStudentTransactionV2Service(
    { protocolVersion: 1, controlGeneration: 1, transactionId: boundaryId, type: 'Add', amountCents: 100, reason: 'Homework' },
    { firestore, auth: studentAuth, now: () => boundaryTime },
  )
  assert.equal(accepted.transaction.id, boundaryId)
  assert.equal(
    firestore.store.get(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`).transactions.length,
    1000,
  )

  const storeAtLimit = clone(Object.fromEntries(firestore.store))
  await assert.rejects(
    submitStudentTransactionV2Service(
      { protocolVersion: 1, controlGeneration: 1, transactionId: boundaryId + 1, type: 'Add', amountCents: 100, reason: 'Homework' },
      { firestore, auth: studentAuth, now: () => boundaryTime + 1 },
    ),
    error => error instanceof StudentMoneyError && error.code === 'resource-exhausted',
  )
  assert.deepEqual(Object.fromEntries(firestore.store), storeAtLimit)

  const replay = await submitStudentTransactionV2Service(
    { protocolVersion: 1, controlGeneration: 1, transactionId: boundaryId, type: 'Add', amountCents: 100, reason: 'Homework' },
    { firestore, auth: studentAuth, now: () => { throw new Error('replay must not use the clock') } },
  )
  assert.deepEqual(replay, accepted)
})

test('student submissions use a bounded per-student rolling throttle window', async () => {
  const firestore = createMockFirestore(foundation())
  const windowStart = Date.parse('2026-08-08T18:10:00.000Z')

  for (let index = 0; index < 10; index += 1) {
    const id = 1700000000200 + index
    const result = await submitStudentTransactionV2Service(
      { protocolVersion: 1, controlGeneration: 1, transactionId: id, type: 'Add', amountCents: 100, reason: 'Homework' },
      { firestore, auth: studentAuth, now: () => windowStart + index * 1000 },
    )
    assert.equal(result.transaction.id, id)
  }

  const throttleEntries = [...firestore.store.entries()]
    .filter(([path]) => path.startsWith('studentLoginThrottle/'))
  assert.equal(throttleEntries.length, 1)
  assert.equal(throttleEntries[0][1].attempts.length, 10)
  assert.equal(throttleEntries[0][0].includes(CLASSROOM_ID), false)
  assert.match(throttleEntries[0][0], /^studentLoginThrottle\/[a-f0-9]{64}$/)
  const primaryThrottlePath = throttleEntries[0][0]

  const storeAtThrottle = clone(Object.fromEntries(firestore.store))
  await assert.rejects(
    submitStudentTransactionV2Service(
      { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000210, type: 'Add', amountCents: 100, reason: 'Homework' },
      { firestore, auth: studentAuth, now: () => windowStart + 10_000 },
    ),
    error => error instanceof StudentMoneyError && error.code === 'resource-exhausted',
  )
  assert.deepEqual(Object.fromEntries(firestore.store), storeAtThrottle)

  const otherStudentId = '8'
  const otherStudentAuth = {
    uid: deriveDeterministicStudentAuthUid(CLASSROOM_ID, otherStudentId),
    token: {
      role: 'student',
      classroomId: CLASSROOM_ID,
      studentId: otherStudentId,
      loginId: 'grace-student',
      credentialVersion: CREDENTIAL_VERSION,
    },
  }
  firestore.store.set(`classrooms/${CLASSROOM_ID}/students/${otherStudentId}`, {
    id: Number(otherStudentId),
    name: 'Grace Student',
    balance: 20,
    frozen: false,
    transactions: [],
  })
  firestore.store.set(`classrooms/${CLASSROOM_ID}/studentCredentials/grace-student`, {
    active: true,
    classroomId: CLASSROOM_ID,
    studentId: otherStudentId,
    authUid: otherStudentAuth.uid,
    pinUpdatedAt: CREDENTIAL_VERSION,
  })
  const otherStudentResult = await submitStudentTransactionV2Service(
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000300, type: 'Add', amountCents: 100, reason: 'Homework' },
    { firestore, auth: otherStudentAuth, now: () => windowStart + 11_000 },
  )
  assert.equal(otherStudentResult.transaction.studentId, Number(otherStudentId))
  assert.equal(
    [...firestore.store.keys()].filter(path => path.startsWith('studentLoginThrottle/')).length,
    2,
  )

  const afterWindow = await submitStudentTransactionV2Service(
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000211, type: 'Add', amountCents: 100, reason: 'Homework' },
    { firestore, auth: studentAuth, now: () => windowStart + 6 * 60 * 1000 },
  )
  assert.equal(afterWindow.transaction.id, 1700000000211)
  assert.equal(firestore.store.get(primaryThrottlePath).attempts.length, 1)
})

test('student money throttle keys cannot be targeted through the login throttle preimage', async () => {
  const firestore = createMockFirestore(foundation())
  await submitStudentTransactionV2Service(
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000400, type: 'Add', amountCents: 100, reason: 'Homework' },
    {
      firestore,
      auth: studentAuth,
      now: () => Date.parse('2026-08-08T18:20:00.000Z'),
    },
  )

  const [moneyThrottlePath] = [...firestore.store.keys()]
    .filter(path => path.startsWith('studentLoginThrottle/'))
  const attackerLoginDigest = hashSha256(
    `student-money-submission\0${CLASSROOM_ID}\0${STUDENT_ID}`,
  )

  assert.notEqual(
    moneyThrottlePath,
    `studentLoginThrottle/${attackerLoginDigest}`,
  )
})

test('malformed requests and forged student identities fail before Firestore access', async () => {
  const invalidRequests = [
    null,
    {},
    { protocolVersion: 1, controlGeneration: 1, transactionId: 0, type: 'Add', amountCents: 100, reason: 'Homework' },
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1.5, type: 'Add', amountCents: 100, reason: 'Homework' },
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1, type: 'Credit', amountCents: 100, reason: 'Homework' },
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1, type: 'Add', amountCents: 0, reason: 'Homework' },
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1, type: 'Add', amountCents: 0.5, reason: 'Homework' },
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1, type: 'Add', amountCents: Number.MAX_SAFE_INTEGER + 1, reason: 'Homework' },
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1, type: 'Add', amountCents: Number.NaN, reason: 'Homework' },
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1, type: 'Add', amountCents: 100, reason: '' },
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1, type: 'Add', amountCents: 100, reason: 'Homework', classroomId: CLASSROOM_ID },
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
    { uid: STUDENT_UID, token: { ...studentAuth.token, role: 'teacher' } },
    { uid: 'someone-else', token: { ...studentAuth.token } },
    { uid: STUDENT_UID, token: { ...studentAuth.token, classroomId: 'other-room' } },
    { uid: STUDENT_UID, token: { ...studentAuth.token, studentId: '07' } },
    { uid: STUDENT_UID, token: { ...studentAuth.token, loginId: 'bad/id' } },
    { uid: STUDENT_UID, token: { ...studentAuth.token, credentialVersion: 0 } },
  ]
  for (const auth of forgedAuth) {
    const firestore = createMockFirestore(foundation())
    await assert.rejects(
      submitStudentTransactionV2Service(
        { protocolVersion: 1, controlGeneration: 1, transactionId: 1, type: 'Add', amountCents: 100, reason: 'Homework' },
        { firestore, auth },
      ),
      error => error instanceof StudentMoneyError &&
        ['unauthenticated', 'permission-denied'].includes(error.code),
    )
    assert.equal(firestore.transactionAttempts, 0)
  }
})

test('a PIN reset immediately invalidates the prior student money session', async () => {
  const docs = foundation({ credential: { pinUpdatedAt: CREDENTIAL_VERSION + 1 } })
  const firestore = createMockFirestore(docs)

  await assert.rejects(
    submitStudentTransactionV2Service(
      { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000500, type: 'Add', amountCents: 100, reason: 'Homework' },
      { firestore, auth: studentAuth },
    ),
    error => error instanceof StudentMoneyError && error.code === 'permission-denied',
  )
  assert.deepEqual(Object.fromEntries(firestore.store), docs)
})

test('settings, frozen state, reason allowlists, and balance are enforced server-side', async () => {
  const cases = [
    ['global off', foundation({ classroom: { settings: { studentRequestsEnabled: false } } }),
      { type: 'Add', amountCents: 100, reason: 'Homework' }, 'failed-precondition'],
    ['add off', foundation({ classroom: { settings: { studentAddRequestsEnabled: false } } }),
      { type: 'Add', amountCents: 100, reason: 'Homework' }, 'failed-precondition'],
    ['subtract off', foundation({ classroom: { settings: { studentSubtractRequestsEnabled: false } } }),
      { type: 'Subtract', amountCents: 100, reason: 'Rent' }, 'failed-precondition'],
    ['frozen', foundation({ student: { frozen: true } }),
      { type: 'Add', amountCents: 100, reason: 'Homework' }, 'failed-precondition'],
    ['unknown add reason', foundation(),
      { type: 'Add', amountCents: 100, reason: 'Forged' }, 'invalid-argument'],
    ['custom add list excludes Technology', foundation({ classroom: { settings: { addMoneyCategories: ['Homework'] } } }),
      { type: 'Add', amountCents: 100, reason: 'Technology' }, 'invalid-argument'],
    ['removing Technology from the new standard list is honored', foundation({ classroom: { settings: {
      addMoneyCategories: DEFAULT_STUDENT_ADD_MONEY_CATEGORIES.filter(category => category !== 'Technology'),
    } } }), { type: 'Add', amountCents: 100, reason: 'Technology' }, 'invalid-argument'],
    ['Technology is not a subtract reason', foundation(),
      { type: 'Subtract', amountCents: 100, reason: 'Technology' }, 'invalid-argument'],
    ['teacher choice', foundation(),
      { type: 'Subtract', amountCents: 100, reason: "Teacher's Choice" }, 'invalid-argument'],
    ['insufficient balance', foundation(),
      { type: 'Subtract', amountCents: 2100, reason: 'Rent' }, 'failed-precondition'],
    ['malformed settings', foundation({ classroom: { settings: { studentRequestsEnabled: 'yes' } } }),
      { type: 'Add', amountCents: 100, reason: 'Homework' }, 'failed-precondition'],
  ]
  for (const [label, docs, request, code] of cases) {
    const firestore = createMockFirestore(docs)
    await assert.rejects(
      submitStudentTransactionV2Service(
        { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000002, ...request },
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

test('Technology is allowed for the current and former standard add-money lists', async () => {
  const classrooms = [
    foundation(),
    foundation({ classroom: { settings: {
      addMoneyCategories: [...LEGACY_DEFAULT_ADD_MONEY_CATEGORIES],
    } } }),
  ]

  for (const [index, docs] of classrooms.entries()) {
    const firestore = createMockFirestore(docs)
    const result = await submitStudentTransactionV2Service(
      { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000100 + index, type: 'Add', amountCents: 100, reason: 'Technology' },
      { firestore, auth: studentAuth },
    )

    assert.equal(result.transaction.reason, 'Technology')
    assert.equal(result.transaction.status, 'Pending')
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
    }, 'already-exists'],
    ['valid existing ID bound to different request data', {
      ...foundation({ student: { transactions: [conflicting] } }),
      [`classrooms/${CLASSROOM_ID}/transactions/${conflicting.id}`]: conflicting,
    }, 'already-exists'],
  ]
  for (const [label, docs, code] of cases) {
    const firestore = createMockFirestore(docs)
    await assert.rejects(
      submitStudentTransactionV2Service(
        { protocolVersion: 1, controlGeneration: 1, transactionId: sameId.id, type: 'Add', amountCents: 500, reason: 'Homework' },
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
    { protocolVersion: 1, controlGeneration: 1, transactionId: 1700000000000, type: 'Add', amountCents: 500, reason: 'Homework' },
    { auth: studentAuth },
    { firestore, now: () => Date.parse('2026-08-08T18:00:00.000Z') },
  )
  assert.deepEqual(Object.keys(result).sort(), ['balance', 'transaction'])
  assert.deepEqual(Object.keys(result.transaction).sort(), [...TRANSACTION_KEYS_FOR_TEST])

  await assert.rejects(
    submitStudentTransactionV2CallableHandler(
      { protocolVersion: 1, controlGeneration: 1, transactionId: 2, type: 'Add', amountCents: 100, reason: 'private-forged-reason' },
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


test('renamed student can replay a historic request and submit a new request without rewriting prior names', async () => {
  const old = transaction({ status: 'Approved' });
  const firestore = createMockFirestore({
    ...foundation({ student: { name: 'Renamed Student', balance: 25, transactions: [old] } }),
    [`classrooms/${CLASSROOM_ID}/transactions/${old.id}`]: old,
  });
  const deps = { firestore, auth: studentAuth, now: () => Date.parse('2026-08-09T18:01:00.000Z') };
  assert.deepEqual(await submitStudentTransactionV2Service({ protocolVersion: 1, controlGeneration: 1, transactionId: old.id, type: 'Add', amountCents: 500, reason: 'Homework' }, deps), { transaction: old, balance: 25 });
  const result = await submitStudentTransactionV2Service({ protocolVersion: 1, controlGeneration: 1, transactionId: old.id + 1, type: 'Add', amountCents: 500, reason: 'Homework' }, deps);
  assert.equal(result.transaction.studentName, 'Renamed Student');
  assert.deepEqual(firestore.store.get(`classrooms/${CLASSROOM_ID}/transactions/${old.id}`), old);
  const bad = createMockFirestore({
    ...foundation({ student: { name: 'Renamed Student', balance: 25, transactions: [{ ...old, studentName: 'Different' }] } }),
    [`classrooms/${CLASSROOM_ID}/transactions/${old.id}`]: old,
  });
  await assert.rejects(submitStudentTransactionV2Service({ protocolVersion: 1, controlGeneration: 1, transactionId: old.id, type: 'Add', amountCents: 500, reason: 'Homework' }, { ...deps, firestore: bad }));
});

test('versioned cents accepts the ceiling and cent precision; old or out-of-domain requests write nothing', async () => {
  const wire = { protocolVersion: 1, controlGeneration: 1, transactionId: 9001, type: 'Subtract', amountCents: 100000000, reason: 'Rent' }
  const firestore = createMockFirestore(foundation({ student: { balance: 1000000 } }))
  const saved = await submitStudentTransactionV2Service(wire, { firestore, auth: studentAuth })
  assert.equal(saved.balance, 0)
  assert.equal(saved.transaction.amount, 1000000)
  const cents = createMockFirestore(foundation({ student: { balance: 0.3 } }))
  assert.equal((await submitStudentTransactionV2Service({ ...wire, amountCents: 10 }, { firestore: cents, auth: studentAuth })).balance, 0.2)
  for (const request of [
    { transactionId: 9001, type: 'Add', amount: 1, reason: 'Homework' },
    ...[100000001, 0.5, -1, 0].map(amountCents => ({ ...wire, amountCents })),
    { ...wire, protocolVersion: 2 }, { ...wire, controlGeneration: 0 },
  ]) {
    const f = createMockFirestore(foundation()), before = clone(Object.fromEntries(f.store))
    await assert.rejects(submitStudentTransactionV2Service(request, { firestore: f, auth: studentAuth }))
    assert.deepEqual(Object.fromEntries(f.store), before)
    assert.equal(f.transactionAttempts, 0)
  }
  for (const balance of [1000000.01, -1000000.01, 0.001]) {
    const f = createMockFirestore(foundation({ student: { balance } })), before = clone(Object.fromEntries(f.store))
    await assert.rejects(submitStudentTransactionV2Service({ ...wire, type: 'Add', reason: 'Homework' }, { firestore: f, auth: studentAuth }))
    assert.deepEqual(Object.fromEntries(f.store), before)
  }
})

test('student money rechecks pause, generation and authority on transaction retry, even for replay', async () => {
  const wire = { protocolVersion: 1, controlGeneration: 1, transactionId: 9002, type: 'Add', amountCents: 100, reason: 'Homework' }
  for (const change of [
    f => { f.store.get(`classrooms/${CLASSROOM_ID}`).accessControl.mode = 'readOnly' },
    f => { f.store.get(`classrooms/${CLASSROOM_ID}`).accessControl.mode = 'suspended' },
    f => { f.store.get(`classrooms/${CLASSROOM_ID}`).accessControl.generation = 3 },
    f => { f.store.get('teachers/teacher-a').status = 'disabled' },
  ]) {
    const f = createMockFirestore(foundation(), { abortAttempts: 1 })
    const original = f.runTransaction.bind(f)
    let callbacks = 0
    f.runTransaction = callback => original(async tx => {
      if (++callbacks === 2) change(f)
      return callback(tx)
    })
    await assert.rejects(submitStudentTransactionV2Service(wire, { firestore: f, auth: studentAuth }))
    assert.equal(callbacks, 2)
    assert.equal(f.store.has(`classrooms/${CLASSROOM_ID}/transactions/9002`), false)
    assert.equal([...f.store.keys()].some(p => p.startsWith('studentLoginThrottle/')), false)
    assert.equal(f.store.get(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`).balance, 20)
  }
  const f = createMockFirestore(foundation())
  await submitStudentTransactionV2Service(wire, { firestore: f, auth: studentAuth })
  f.store.get(`classrooms/${CLASSROOM_ID}`).accessControl.generation = 3
  const before = clone(Object.fromEntries(f.store))
  await assert.rejects(submitStudentTransactionV2Service(wire, { firestore: f, auth: studentAuth }))
  assert.deepEqual(Object.fromEntries(f.store), before)
})
