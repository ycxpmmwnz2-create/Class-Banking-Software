import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveDeterministicStudentAuthUid } from '../phase2b/scopedCredentialProjection.js'
import {
  createStudentV2CallableHandler,
  createStudentV2Service,
  removeStudentV2CallableHandler,
  removeStudentV2Service,
  StudentLifecycleError,
} from './studentLifecycle.js'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createMockFirestore(initialDocs = {}, { abortAttempts = 0 } = {}) {
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
        assert.equal(operator, '==')
        return {
          limit(maximum) {
            return {
              _query() {
                return [...store.entries()]
                  .filter(([candidatePath, data]) =>
                    candidatePath.startsWith(`${path}/`) &&
                    !candidatePath.slice(path.length + 1).includes('/') &&
                    data[field] === value)
                  .slice(0, maximum)
                  .map(([candidatePath, data]) => snapshot(candidatePath, data))
              },
            }
          },
        }
      },
    }
  }

  return {
    store,
    attempts,
    get transactionAttempts() {
      return transactionAttempts
    },
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
        if (transactionAttempts <= abortAttempts) continue
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
  return {
    'teachers/teacher-a': {
      uid: 'teacher-a', classroomId: 'class-a', status: 'active',
    },
    'classrooms/class-a': { ownerUid: 'teacher-a', nextStudentNumber: counter },
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
    { name: '  Ada   Lovelace  ', startingBalance: 12.5, pin: '0427' },
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
  assert.deepEqual(result, {
    student: { id: 7, name: 'Ada Lovelace', balance: 12.5, frozen: false },
    loginId: 'ada-lovelace',
  })
  assert.equal(JSON.stringify(result).includes('0427'), false)
  assert.equal(JSON.stringify(result).includes('secret-hash'), false)
  assert.equal(firestore.store.get('classrooms/class-a').nextStudentNumber, 8)
  assert.deepEqual(
    Object.keys(firestore.store.get('classrooms/class-a/students/7')).sort(),
    ['balance', 'frozen', 'id', 'name', 'transactions'],
  )
  assert.deepEqual(
    firestore.store.get('classrooms/class-a/students/7'),
    { id: 7, name: 'Ada Lovelace', balance: 12.5, frozen: false, transactions: [] },
  )
  const credential = firestore.store.get(
    'classrooms/class-a/studentCredentials/ada-lovelace',
  )
  assert.equal(credential.studentId, '7')
  assert.equal(credential.authUid, deriveDeterministicStudentAuthUid('class-a', '7'))
  assert.equal(credential.active, true)
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
    { name: 'Alex', startingBalance: 0, pin: '1234' },
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
    { name: '', startingBalance: 0, pin: '1234' },
    { name: 'A', startingBalance: Number.NaN, pin: '1234' },
    { name: 'A', startingBalance: Infinity, pin: '1234' },
    { name: 'A', startingBalance: 0, pin: '１２３４' },
    { name: 'A', startingBalance: 0, pin: '12345' },
    { name: 'A', startingBalance: 0, pin: '1234', studentId: '1' },
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
      'classrooms/class-a': { ownerUid: 'teacher-a' },
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
        { name: 'New', startingBalance: 0, pin: '1234' },
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
      { name: 'New', startingBalance: 0, pin: '1234' },
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
    'studentCredentials/ada': { untouched: true, pinHash: 'flat-secret' },
  })
  assert.deepEqual(
    await removeStudentV2Service({ studentId: '7' }, { firestore, auth, now: () => 3000 }),
    { success: true },
  )
  assert.equal(firestore.store.has('classrooms/class-a/students/7'), false)
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
      removeStudentV2Service({ studentId: '7' }, { firestore, auth }),
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
    { name: 'Ada', startingBalance: 1, pin: '1234' },
    { auth },
    { firestore, hashPin: async () => 'super-secret-hash', now: () => 1000 },
  )
  assert.deepEqual(Object.keys(created).sort(), ['loginId', 'student'])
  assert.equal(JSON.stringify(created).includes('secret'), false)

  await assert.rejects(
    createStudentV2CallableHandler(
      { name: 'Ada', startingBalance: 1, pin: 'secret-not-pin' },
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
    { studentId: '7' },
    { auth },
    { firestore, now: () => 2000 },
  )
  assert.deepEqual(removed, { success: true })
})
