import { teacherAwardPaths, recoverTeacherAwardService } from './teacherAwardService.js'
import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveDeterministicStudentAuthUid } from '../phase2b/scopedCredentialProjection.js'
import {
  createStudentV2CallableHandler as createHandler,
  createStudentV2Service as createService,
  removeStudentV2CallableHandler,
  removeStudentV2Service,
  StudentLifecycleError,
} from './studentLifecycle.js'

const projectId = 'demo-creation'
const keyRing = { currentVersion: 'v1', keys: { v1: 'ab'.repeat(32) } }
const envelope = { requestId: '1'.repeat(32), classroomId: 'class-a', protocolVersion: 1, controlGeneration: 1 }
const createStudentV2Service = (request, deps) => createService(request, { projectId, keyRing, ...deps })
const createStudentV2CallableHandler = (request, ctx, deps) => createHandler(request, ctx, { projectId, keyRing, ...deps })

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createMockFirestore(initialDocs = {}, { abortAttempts = 0, beforeRetry = () => {} } = {}) {
  const store = new Map(Object.entries(initialDocs).map(([path, data]) => [path, clone(data)]))
  const attempts = []
  let transactionAttempts = 0

  function docRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      collection(name) {
        return collectionRef(`${path}/${name}`)
      },
      async get() {
        const data = store.get(path)
        return snapshot(path, data)
      },
    }
  }

  function snapshot(path, data) {
    return {
      exists: data !== undefined,
      id: path.split('/').pop(),
      ref: docRef(path),
      data: () => clone(data),
    }
  }

  function collectionRef(path) {
    return {
      path,
      doc(id) {
        return docRef(`${path}/${id}`)
      },
      where(field, operator, value) {
        const filters = [[field, operator, value]];
        const query = {
          where(field, operator, value) { filters.push([field, operator, value]); return query; },
          limit(maximum) {
            return { _query() {
              return [...store.entries()].filter(([candidatePath, data]) =>
                candidatePath.startsWith(`${path}/`) && !candidatePath.slice(path.length + 1).includes('/') &&
                filters.every(([field, operator, value]) => { assert.equal(operator, '=='); return data[field] === value; }))
                .slice(0, maximum).map(([candidatePath, data]) => snapshot(candidatePath, data));
            } };
          }
        };
        return query;
      },
    }
  }

  return {
    store,
    attempts,
    get transactionAttempts() {
      return transactionAttempts
    },
    doc: docRef,
    collection: collectionRef,
    async runTransaction(callback) {
      for (;;) {
        transactionAttempts += 1
        const operations = []
        const writes = []
        let wrote = false
        const transaction = {
          async get(target) {
            if (wrote) throw new Error('read after write')
            if (typeof target?._query === 'function') {
              const docs = target._query()
              operations.push({ kind: 'read-query', paths: docs.map(doc => doc.ref.path) })
              return { empty: docs.length === 0, docs }
            }
            operations.push({ kind: 'read', path: target.path })
            return snapshot(target.path, store.get(target.path))
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
          delete(ref) {
            wrote = true
            operations.push({ kind: 'delete', path: ref.path })
            writes.push({ kind: 'delete', path: ref.path })
          },
        }
        const result = await callback(transaction)
        attempts.push(operations)
        if (transactionAttempts <= abortAttempts) { beforeRetry(store); continue }
        for (const write of writes) {
          if (write.kind === 'create') {
            if (store.has(write.path)) throw new Error(`ALREADY_EXISTS: ${write.path}`)
            store.set(write.path, write.data)
          } else if (write.kind === 'update') {
            if (!store.has(write.path)) throw new Error(`NOT_FOUND: ${write.path}`)
            store.set(write.path, { ...store.get(write.path), ...write.data })
          } else {
            store.delete(write.path)
          }
        }
        return result
      }
    },
  }
}

function foundation({ counter = 7 } = {}) {
  const paths = teacherAwardPaths('class-a', 'teacher-a', envelope.requestId)
  return {
    [paths.actor]: { version: 1, actorUid: 'teacher-a', unacknowledgedRequestId: null },
    [paths.quota]: { version: 1, count: 0 },
    'teachers/teacher-a': {
      uid: 'teacher-a', classroomId: 'class-a', status: 'active',
    },
    'classrooms/class-a': { ownerUid: 'teacher-a', nextStudentNumber: counter,
      accessControl: { schemaVersion: 1, mode: 'active', generation: 1, changedAt: '2026-10-04T00:00:00.000Z', auditId: 'test-control' } },
  }
}

function lifecycleCredential(loginId, studentId, overrides = {}) {
  return {
    loginId,
    classroomId: 'class-a',
    studentId,
    authUid: deriveDeterministicStudentAuthUid('class-a', studentId),
    active: true,
    pinHash: 'secret-hash',
    failedAttempts: 0,
    lockedUntil: null,
    schemaVersion: 1,
    createdAt: 1000,
    updatedAt: 1000,
    pinUpdatedAt: 1000,
    ...overrides,
  }
}

const auth = { uid: 'teacher-a' }

test('create allocates the counter and login ID atomically with one pre-transaction hash', async () => {
  const firestore = createMockFirestore(foundation(), { abortAttempts: 1 })
  const pins = []
  const result = await createStudentV2Service(
    { ...envelope, name: '  Ada   Lovelace  ', startingBalanceCents: (12.5) * 100, pin: '0427' },
    {
      firestore,
      auth,
      now: () => 1000,
      hashPin: async pin => {
        pins.push(pin)
        assert.equal(firestore.transactionAttempts, 0)
        return 'secret-hash'
      },
    },
  )

  assert.deepEqual(pins, ['0427'])
  assert.equal(firestore.transactionAttempts, 2)
  assert.equal(result.studentId, 7)
  assert.equal(result.loginId, 'ada-lovelace')
  assert.equal(result.action, 'createStudent')
  assert.equal(result.status, 'committed')
  assert.equal(JSON.stringify(result).includes('0427'), false)
  assert.equal(JSON.stringify(result).includes('secret-hash'), false)
  assert.equal(firestore.store.get('classrooms/class-a').nextStudentNumber, 8)
  assert.deepEqual(
    Object.keys(firestore.store.get('classrooms/class-a/students/7')).sort(),
    ['balance', 'frozen', 'id', 'name', 'transactions'],
  )
  assert.deepEqual(
    firestore.store.get('classrooms/class-a/students/7'),
    { id: 7, name: 'Ada Lovelace', balance: 12.5, frozen: false, transactions: firestore.store.get('classrooms/class-a/students/7').transactions },
  )
  const credential = firestore.store.get(
    'classrooms/class-a/studentCredentials/ada-lovelace',
  )
  assert.equal(credential.studentId, '7')
  assert.equal(credential.authUid, deriveDeterministicStudentAuthUid('class-a', '7'))
  assert.equal(credential.active, true)
  // The credential document keeps its exact reviewed key set: the recoverable
  // PIN lives in a separate collection, never as a new credential field.
  assert.deepEqual(
    Object.keys(credential).sort(),
    [
      'active', 'authUid', 'classroomId', 'createdAt', 'failedAttempts',
      'lockedUntil', 'loginId', 'pinHash', 'pinUpdatedAt', 'schemaVersion',
      'studentId', 'updatedAt',
    ],
  )
  assert.equal(credential.pin, undefined)
  assert.equal(JSON.stringify(credential).includes('0427'), false)
  // The teacher-visible PIN is created in the SAME transaction, so a new student
  // can never exist with a credential but no recoverable PIN.
  assert.deepEqual(
    firestore.store.get('classrooms/class-a/studentPins/7'),
    { studentId: '7', pin: '0427', updatedAt: 1000 },
  )
  for (const attempt of firestore.attempts) {
    const firstWrite = attempt.findIndex(operation => operation.kind !== 'read' && operation.kind !== 'read-query')
    assert.ok(firstWrite > 0)
    assert.equal(
      attempt.slice(firstWrite).some(operation => operation.kind === 'read' || operation.kind === 'read-query'),
      false,
    )
  }
})

test('create allocates the first free classroom-scoped login suffix without flat writes', async () => {
  const firestore = createMockFirestore({
    ...foundation(),
    'classrooms/class-a/studentCredentials/alex': lifecycleCredential('alex', '1'),
    'classrooms/class-a/studentCredentials/alex-2': lifecycleCredential('alex-2', '2'),
  })
  const result = await createStudentV2Service(
    { ...envelope, name: 'Alex', startingBalanceCents: (0) * 100, pin: '1234' },
    { firestore, auth, hashPin: async () => 'new-hash', now: () => 2000 },
  )
  assert.equal(result.loginId, 'alex-3')
  assert.equal([...firestore.store.keys()].some(path => /^studentCredentials\//.test(path)), false)
  assert.equal([...firestore.store.keys()].some(path => /^morganBank\//.test(path)), false)
})

test('create rejects malformed inputs before hashing or a transaction', async () => {
  const invalidRequests = [
    null,
    {},
    { ...envelope, name: '', startingBalanceCents: (0) * 100, pin: '1234' },
    { ...envelope, name: 'A', startingBalanceCents: (Number.NaN) * 100, pin: '1234' },
    { ...envelope, name: 'A', startingBalanceCents: (Infinity) * 100, pin: '1234' },
    { ...envelope, name: 'A', startingBalanceCents: (0) * 100, pin: '１２３４' },
    { ...envelope, name: 'A', startingBalanceCents: (0) * 100, pin: '12345' },
    { ...envelope, name: 'A', startingBalanceCents: (0) * 100, pin: '1234', studentId: '1' },
  ]
  for (const request of invalidRequests) {
    const firestore = createMockFirestore(foundation())
    let hashes = 0
    await assert.rejects(
      createStudentV2Service(request, {
        firestore,
        auth,
        hashPin: async () => { hashes += 1; return 'hash' },
      }),
      error => error instanceof StudentLifecycleError && error.code === 'invalid-argument',
    )
    assert.equal(hashes, 0)
    assert.equal(firestore.transactionAttempts, 0)
  }
})

test('create fails closed on tenant, counter, and allocated identity anomalies', async () => {
  const cases = [
    ['unauthenticated', foundation(), null, 'unauthenticated'],
    ['one-sided tenant', {
      'teachers/teacher-a': { uid: 'teacher-a', classroomId: 'class-a', status: 'active' },
    }, auth, 'classroom-not-found'],
    ['missing counter', {
      'teachers/teacher-a': { uid: 'teacher-a', classroomId: 'class-a', status: 'active' },
      'classrooms/class-a': { ...foundation()['classrooms/class-a'], nextStudentNumber: null },
      ...Object.fromEntries(Object.entries(foundation()).filter(([path]) => path.includes('teacherMoney'))),
    }, auth, 'failed-precondition'],
    ['zero counter', foundation({ counter: 0 }), auth, 'failed-precondition'],
    ['unsafe counter', foundation({ counter: Number.MAX_SAFE_INTEGER }), auth, 'failed-precondition'],
    ['student collision', {
      ...foundation(),
      'classrooms/class-a/students/7': {
        id: 7, name: 'Existing', balance: 0, frozen: false, transactions: [],
      },
    }, auth, 'already-exists'],
    ['inactive credential collision', {
      ...foundation(),
      'classrooms/class-a/studentCredentials/old': lifecycleCredential('old', '7', { active: false }),
    }, auth, 'already-exists'],
  ]
  for (const [label, docs, callerAuth, expectedCode] of cases) {
    const firestore = createMockFirestore(docs)
    await assert.rejects(
      createStudentV2Service(
        { ...envelope, name: 'New', startingBalanceCents: (0) * 100, pin: '1234' },
        { firestore, auth: callerAuth, hashPin: async () => 'hash' },
      ),
      error => {
        assert.equal(error.code, expectedCode, label)
        return true
      },
    )
    assert.equal([...firestore.store.keys()].some(path => path.endsWith('/students/7') && !docs[path]), false)
  }
})

test('transaction revalidation blocks a foundation changed after initial resolution', async () => {
  const firestore = createMockFirestore(foundation())
  const originalRun = firestore.runTransaction.bind(firestore)
  firestore.runTransaction = async callback => {
    firestore.store.set('classrooms/class-a', {
      ownerUid: 'teacher-other', nextStudentNumber: 7,
    })
    return originalRun(callback)
  }
  await assert.rejects(
    createStudentV2Service(
      { ...envelope, name: 'New', startingBalanceCents: (0) * 100, pin: '1234' },
      { firestore, auth, hashPin: async () => 'hash' },
    ),
    error => error instanceof StudentLifecycleError && error.code === 'failed-precondition',
  )
  assert.equal(firestore.store.has('classrooms/class-a/students/7'), false)
})

test('remove deletes only the exact student, retains and deactivates one credential, and preserves counter', async () => {
  const credential = {
    ...lifecycleCredential('ada', '7'),
    migratedField: { retained: true },
  }
  const firestore = createMockFirestore({
    ...foundation({ counter: 19 }),
    'classrooms/class-a/students/7': {
      id: 7, name: 'Ada', balance: 2, frozen: false, transactions: [],
    },
    'classrooms/class-a/studentCredentials/ada': credential,
    'classrooms/class-a/studentPins/7': { studentId: '7', pin: '0427', updatedAt: 1000 },
    'classrooms/class-a/studentPins/8': { studentId: '8', pin: '1111', updatedAt: 1000 },
    'studentCredentials/ada': { untouched: true, pinHash: 'flat-secret' },
  })
  assert.deepEqual(
    await removeStudentV2Service({ studentId: '7', classroomId: 'class-a', protocolVersion: 1, controlGeneration: 1 }, { firestore, auth, now: () => 3000 }),
    { success: true },
  )
  assert.equal(firestore.store.has('classrooms/class-a/students/7'), false)
  // The credential is retained deactivated for identity reasons, but the removed
  // student has no roster row, so their recoverable PIN is deleted outright. A
  // classmate's PIN must survive.
  assert.equal(firestore.store.has('classrooms/class-a/studentPins/7'), false)
  assert.deepEqual(
    firestore.store.get('classrooms/class-a/studentPins/8'),
    { studentId: '8', pin: '1111', updatedAt: 1000 },
  )
  assert.equal(firestore.store.has('classrooms/class-a/studentCredentials/ada'), true)
  assert.equal(firestore.store.get('classrooms/class-a/studentCredentials/ada').active, false)
  assert.equal(firestore.store.get('classrooms/class-a/studentCredentials/ada').updatedAt, 3000)
  assert.deepEqual(firestore.store.get('classrooms/class-a/studentCredentials/ada').migratedField, { retained: true })
  assert.equal(firestore.store.get('classrooms/class-a').nextStudentNumber, 19)
  assert.deepEqual(firestore.store.get('studentCredentials/ada'), {
    untouched: true, pinHash: 'flat-secret',
  })
})

test('remove blocks missing, duplicate, malformed, and cross-tenant identities without writes', async () => {
  const student = { id: 7, name: 'Ada', balance: 0, frozen: false, transactions: [] }
  const cases = [
    ['missing student', { ...foundation(), 'classrooms/class-a/studentCredentials/ada': lifecycleCredential('ada', '7') }, 'not-found'],
    ['missing credential', { ...foundation(), 'classrooms/class-a/students/7': student }, 'failed-precondition'],
    ['duplicate credentials', {
      ...foundation(),
      'classrooms/class-a/students/7': student,
      'classrooms/class-a/studentCredentials/ada': lifecycleCredential('ada', '7'),
      'classrooms/class-a/studentCredentials/ada-2': lifecycleCredential('ada-2', '7'),
    }, 'failed-precondition'],
    ['wrong credential tenant', {
      ...foundation(),
      'classrooms/class-a/students/7': student,
      'classrooms/class-a/studentCredentials/ada': lifecycleCredential('ada', '7', { classroomId: 'class-b' }),
    }, 'failed-precondition'],
    ['malformed student shape', {
      ...foundation(),
      'classrooms/class-a/students/7': { ...student, pin: '1234' },
      'classrooms/class-a/studentCredentials/ada': lifecycleCredential('ada', '7'),
    }, 'failed-precondition'],
  ]
  for (const [label, docs, expectedCode] of cases) {
    const firestore = createMockFirestore(docs)
    await assert.rejects(
      removeStudentV2Service({ studentId: '7', classroomId: 'class-a', protocolVersion: 1, controlGeneration: 1 }, { firestore, auth }),
      error => {
        assert.equal(error.code, expectedCode, label)
        return true
      },
    )
    assert.deepEqual(Object.fromEntries(firestore.store), docs, label)
  }
})

test('remove accepts only canonical positive safe-integer student IDs', async () => {
  for (const studentId of [null, 7, '', '0', '-1', '01', '9007199254740992', 'bad/id']) {
    const firestore = createMockFirestore(foundation())
    await assert.rejects(
      removeStudentV2Service({ studentId }, { firestore, auth }),
      error => error instanceof StudentLifecycleError && error.code === 'invalid-argument',
    )
    assert.equal(firestore.transactionAttempts, 0)
  }
})

test('callable boundaries return exact public shapes and redact service details and secrets', async () => {
  const firestore = createMockFirestore(foundation())
  const created = await createStudentV2CallableHandler(
    { ...envelope, name: 'Ada', startingBalanceCents: (1) * 100, pin: '1234' },
    { auth },
    { firestore, hashPin: async () => 'super-secret-hash', now: () => 1000 },
  )
  assert.deepEqual(Object.keys(created).sort(), ['protocolVersion', 'requestId', 'status', 'action', 'itemCount', 'serverTime', 'requiresRefresh', 'acknowledged', 'receiptCapacityWarning', 'studentId', 'loginId'].sort())
  assert.equal(JSON.stringify(created).includes('secret'), false)

  await assert.rejects(
    createStudentV2CallableHandler(
      { ...envelope, name: 'Ada', startingBalanceCents: (1) * 100, pin: 'secret-not-pin' },
      { auth },
      { firestore },
    ),
    error => {
      assert.equal(error.code, 'invalid-argument')
      assert.equal(error.message, 'The request was invalid.')
      assert.equal(JSON.stringify(error).includes('secret-not-pin'), false)
      return true
    },
  )

  const removed = await removeStudentV2CallableHandler(
    { studentId: '7', classroomId: 'class-a', protocolVersion: 1, controlGeneration: 1 },
    { auth },
    { firestore, now: () => 2000 },
  )
  assert.deepEqual(removed, { success: true })
})

const removeRequest = { studentId: '7', classroomId: 'class-a', protocolVersion: 1, controlGeneration: 1 }
function removable() {
  return { ...foundation(),
    'classrooms/class-a/students/7': { id: 7, name: 'Ada', balance: 20, frozen: false, transactions: [] },
    'classrooms/class-a/studentCredentials/ada': lifecycleCredential('ada', '7'),
    'classrooms/class-a/studentPins/7': { studentId: '7', pin: '0427', updatedAt: 1000 } }
}
test('removal refuses pending mirror or ledger records without deleting student, credential, PIN or history', async () => {
  for (const inMirror of [true, false]) {
    const docs = removable()
    const entry = { id: 321, studentId: 7, status: 'Pending' }
    if (inMirror) docs['classrooms/class-a/students/7'].transactions.push(entry)
    else docs['classrooms/class-a/transactions/321'] = entry
    const f = createMockFirestore(docs)
    await assert.rejects(removeStudentV2CallableHandler(removeRequest, { auth }, { firestore: f }),
      e => e.code === 'failed-precondition' && e.details.reason === 'pending-requests' && e.details.wroteNothing === true)
    assert.deepEqual(Object.fromEntries(f.store), docs)
  }
})
test('removal binds classroom and rechecks control and authority on each retry', async () => {
  for (const mutate of [
    f => { f.store.get('classrooms/class-a').accessControl.mode = 'readOnly' },
    f => { f.store.get('classrooms/class-a').accessControl.mode = 'suspended' },
    f => { f.store.get('classrooms/class-a').accessControl.generation = 3 },
    f => { f.store.get('teachers/teacher-a').status = 'disabled' },
    f => { f.store.set('classrooms/class-a/transactions/321', { id: 321, studentId: 7, status: 'Pending' }) },
  ]) {
    const f = createMockFirestore(removable(), { abortAttempts: 1 })
    const run = f.runTransaction.bind(f); let attempts = 0
    f.runTransaction = callback => run(tx => { if (++attempts === 2) mutate(f); return callback(tx) })
    await assert.rejects(removeStudentV2Service(removeRequest, { firestore: f, auth }))
    assert.equal(attempts, 2)
    assert.equal(f.store.has('classrooms/class-a/students/7'), true)
    assert.equal(f.store.get('classrooms/class-a/studentCredentials/ada').active, true)
    assert.equal(f.store.has('classrooms/class-a/studentPins/7'), true)
  }
  for (const request of [{ studentId: '7' }, { ...removeRequest, classroomId: 'other-room' }]) {
    const f = createMockFirestore(removable()), before = clone(Object.fromEntries(f.store))
    await assert.rejects(removeStudentV2Service(request, { firestore: f, auth }))
    assert.deepEqual(Object.fromEntries(f.store), before)
  }
})

test('removal preserves decided history and ignores another student’s pending requests', async () => {
  const docs = removable()
  docs['classrooms/class-a/transactions/321'] = { id: 321, studentId: 7, status: 'Denied' }
  docs['classrooms/class-a/transactions/322'] = { id: 322, studentId: 8, status: 'Pending' }
  docs['classrooms/class-a/students/7'].transactions = [docs['classrooms/class-a/transactions/321']]
  const f = createMockFirestore(docs)
  await removeStudentV2Service(removeRequest, { firestore: f, auth })
  assert.equal(f.store.has('classrooms/class-a/students/7'), false)
  assert.deepEqual(f.store.get('classrooms/class-a/transactions/321'), docs['classrooms/class-a/transactions/321'])
  assert.deepEqual(f.store.get('classrooms/class-a/transactions/322'), docs['classrooms/class-a/transactions/322'])
})

const creation = extra => ({ ...envelope, name: 'Fictional New', startingBalanceCents: 123, pin: '0427', ...extra })
const createDeps = firestore => ({ firestore, auth, hashPin: async () => 'fictional-hash', now: () => 1791216000000 })
test('opening balance and mirror are atomic, signed, ISO-dated; zero creates no ledger', async () => {
  for (const cents of [123, -123, 0, 100000000, -100000000]) {
    const firestore = createMockFirestore(foundation())
    const result = await createStudentV2Service(creation({ startingBalanceCents: cents }), createDeps(firestore))
    const student = firestore.store.get('classrooms/class-a/students/7')
    const ledger = [...firestore.store].filter(([path]) => path.includes('/transactions/'))
    assert.equal(student.balance, cents / 100)
    assert.equal(ledger.length, cents === 0 ? 0 : 1)
    assert.deepEqual(student.transactions, ledger.map(([, row]) => row))
    if (cents) {
      const row = ledger[0][1]
      assert.equal(row.type, cents > 0 ? 'Add' : 'Subtract')
      assert.equal(row.amount, Math.abs(cents) / 100)
      assert.equal(row.source, 'Opening Balance'); assert.equal(row.category, 'Balance adjustment')
      assert.equal(row.status, 'Approved'); assert.equal(row.date, new Date(1791216000000).toISOString())
    }
    const paths = teacherAwardPaths('class-a', auth.uid, envelope.requestId)
    const receipt = firestore.store.get(paths.receipt)
    assert.equal(receipt.digest, undefined)
    for (const secret of ['0427', 'fictional-hash', 'Fictional New']) assert.equal(JSON.stringify(receipt).includes(secret), false)
    assert.equal(firestore.store.get(paths.quota).count, 1)
    assert.equal(result.studentId, 7)
  }
})
test('lost response retries and recovery do not allocate twice; PIN and all intent changes conflict', async () => {
  const firestore = createMockFirestore(foundation()), deps = createDeps(firestore), wire = creation()
  const first = await createStudentV2Service(wire, deps)
  const saved = clone(Object.fromEntries(firestore.store))
  assert.deepEqual(await createStudentV2Service(wire, deps), first)
  for (const extra of [{ pin: '1111' }, { name: 'Other' }, { startingBalanceCents: 124 }, { controlGeneration: 2 }]) {
    await assert.rejects(createStudentV2Service(creation(extra), deps))
    assert.deepEqual(Object.fromEntries(firestore.store), saved)
  }
  const recovery = { protocolVersion: 1, classroomId: 'class-a', requestId: envelope.requestId, operation: 'status' }
  assert.deepEqual(await recoverTeacherAwardService(recovery, { ...deps, projectId }), first)
  await recoverTeacherAwardService({ ...recovery, operation: 'acknowledge' }, { ...deps, projectId })
  assert.equal((await createStudentV2Service(wire, deps)).acknowledged, true)
  assert.equal(firestore.store.get('classrooms/class-a').nextStudentNumber, 8)
})
test('key rotation retains replay, missing historical key refuses replay; recovery needs no secret', async () => {
  const firestore = createMockFirestore(foundation()), deps = createDeps(firestore)
  await createStudentV2Service(creation(), deps)
  const rotated = { currentVersion: 'v2', keys: { ...keyRing.keys, v2: 'cd'.repeat(32) } }
  assert.equal((await createStudentV2Service(creation(), { ...deps, keyRing: rotated })).studentId, 7)
  delete rotated.keys.v1
  await assert.rejects(createStudentV2Service(creation(), { ...deps, keyRing: rotated }))
  assert.equal((await recoverTeacherAwardService({ protocolVersion: 1, classroomId: 'class-a', requestId: envelope.requestId, operation: 'status' }, { ...deps, projectId })).status, 'committed')
})
test('cancellation fences creation; missing metadata, cap, lock, mode and generation refuse without writes', async () => {
  const paths = teacherAwardPaths('class-a', auth.uid, envelope.requestId)
  for (const mutate of [
    f => f.store.delete(paths.actor), f => f.store.delete(paths.quota),
    f => f.store.get(paths.quota).count = 100000,
    f => f.store.get(paths.actor).unacknowledgedRequestId = '2'.repeat(32),
    f => f.store.get('classrooms/class-a').accessControl.mode = 'readOnly',
    f => f.store.get('classrooms/class-a').accessControl.mode = 'suspended',
    f => f.store.get('classrooms/class-a').accessControl.generation = 2,
  ]) {
    const firestore = createMockFirestore(foundation()); mutate(firestore)
    const before = clone(Object.fromEntries(firestore.store))
    await assert.rejects(createStudentV2Service(creation(), createDeps(firestore)))
    assert.deepEqual(Object.fromEntries(firestore.store), before)
  }
  const firestore = createMockFirestore(foundation()), deps = createDeps(firestore)
  await recoverTeacherAwardService({ protocolVersion: 1, classroomId: 'class-a', requestId: envelope.requestId, operation: 'cancel' }, { ...deps, projectId, now: () => '2026-10-05T00:00:00.000Z' })
  await assert.rejects(createStudentV2Service(creation(), deps))
  assert.equal(firestore.store.has('classrooms/class-a/students/7'), false)
})
test('old wire and non-cent amounts fail before hashing; post-hash pause cannot commit', async () => {
  for (const request of [{ name: 'Old', startingBalance: 2, pin: '1234' }, creation({ startingBalanceCents: 1.2 }), creation({ startingBalanceCents: 100000001 })]) {
    const firestore = createMockFirestore(foundation())
    await assert.rejects(createStudentV2Service(request, { ...createDeps(firestore), hashPin: () => assert.fail('must not hash') }))
    assert.equal(firestore.transactionAttempts, 0)
  }
  const firestore = createMockFirestore(foundation())
  await assert.rejects(createStudentV2Service(creation(), { ...createDeps(firestore), hashPin: async () => {
    firestore.store.get('classrooms/class-a').accessControl.mode = 'readOnly'; return 'hash'
  } }))
  assert.equal(firestore.store.has('classrooms/class-a/students/7'), false)
})

test('creation rechecks owner, control and generation after a transaction conflict', async () => {
  for (const change of [
    store => store.get('classrooms/class-a').accessControl.generation++,
    store => store.get('classrooms/class-a').accessControl.mode = 'suspended',
    store => store.get('teachers/teacher-a').status = 'disabled',
  ]) {
    const firestore = createMockFirestore(foundation(), {abortAttempts:1,beforeRetry:change})
    await assert.rejects(createStudentV2Service(creation(),createDeps(firestore)))
    assert.equal(firestore.transactionAttempts,2)
    assert.equal(firestore.store.has('classrooms/class-a/students/7'),false)
    assert.equal(firestore.store.get('classrooms/class-a').nextStudentNumber,7)
  }
})
