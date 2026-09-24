import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import vm from 'node:vm'
import { control } from '../../tests/phase3/classroomAccess.fixture.js'

import {
  StudentPinDirectoryError,
  buildStudentPinDocument,
  listStudentPinsV2,
  listStudentPinsV2CallableHandler,
  studentPinPath,
} from './studentPinDirectory.js'

/**
 * Minimal Firestore double supporting the exact surface this module uses:
 * `collection(name).doc(id)`, a nested `collection(name)`, and a collection-wide
 * `get()`. Documents are addressed by full path so a query can never
 * accidentally span classrooms.
 */
function createMockFirestore(initialDocs = {}, { beforeTransaction, attempts = () => 1, beforeAttempt } = {}) {
  const store = new Map(Object.entries(initialDocs))
  const reads = [], writes = []
  let transactionNumber = 0

  function snapshot(path, data) {
    return {
      exists: data !== undefined,
      id: path.split('/').pop(),
      ref: { path },
      data: () => (data === undefined ? undefined : { ...data }),
    }
  }

  function docRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      collection: name => collectionRef(`${path}/${name}`),
      async get() {
        reads.push(path)
        return snapshot(path, store.get(path))
      },
    }
  }

  function collectionRef(path) {
    return {
      path,
      doc: id => docRef(`${path}/${id}`),
      async get() {
        reads.push(path)
        const docs = [...store.entries()]
          .filter(([candidate]) =>
            candidate.startsWith(`${path}/`) &&
            !candidate.slice(path.length + 1).includes('/'))
          .map(([candidate, data]) => snapshot(candidate, data))
        return { empty: docs.length === 0, docs }
      },
    }
  }

  return {
    store,
    reads,
    writes,
    collection: collectionRef,
    async runTransaction(callback) {
      const number = ++transactionNumber
      beforeTransaction?.(store, number)
      let result
      // Deliberately models discarded callbacks, not real Firestore contention.
      for (let attempt = 1; attempt <= attempts(number); attempt++) {
        beforeAttempt?.(store, number, attempt)
        const unexpectedWrite = () => { writes.push('unexpected'); throw new Error('Unexpected write') }
        result = await callback({
          get: reference => reference.get(),
          set: unexpectedWrite, update: unexpectedWrite,
          create: unexpectedWrite, delete: unexpectedWrite,
        })
      }
      return result
    },
  }
}

function foundation() {
  return {
    'teachers/teacher-a': { uid: 'teacher-a', classroomId: 'class-a', status: 'active' },
    'classrooms/class-a': { ownerUid: 'teacher-a', accessControl: control() },
    'teachers/teacher-b': { uid: 'teacher-b', classroomId: 'class-b', status: 'active' },
    'classrooms/class-b': { ownerUid: 'teacher-b', accessControl: control() },
  }
}

function pinDoc(studentId, pin, overrides = {}) {
  return { studentId, pin, updatedAt: 1000, ...overrides }
}

const authA = { uid: 'teacher-a' }

test('a teacher reads only their own classroom PINs, sorted by student ID', async () => {
  const firestore = createMockFirestore({
    ...foundation(),
    'classrooms/class-a/studentPins/2': pinDoc('2', '2468'),
    'classrooms/class-a/studentPins/1': pinDoc('1', '1357'),
    'classrooms/class-b/studentPins/1': pinDoc('1', '9999'),
  })

  const result = await listStudentPinsV2({}, { firestore, auth: authA })

  assert.equal(result.classroomId, 'class-a')
  assert.deepEqual(result.pins, [
    { studentId: '1', pin: '1357' },
    { studentId: '2', pin: '2468' },
  ])
  // The other tenant's PIN is not merely unsorted or filtered late — it is never
  // read, because the collection path is built from the resolved classroom.
  assert.ok(!JSON.stringify(result.pins).includes('9999'))
  assert.ok(firestore.reads.every(path => !path.startsWith('classrooms/class-b')))
  assert.deepEqual(firestore.writes, [])
})

test('the classroom comes from the caller identity, so a second teacher sees a different set', async () => {
  const firestore = createMockFirestore({
    ...foundation(),
    'classrooms/class-a/studentPins/1': pinDoc('1', '1357'),
    'classrooms/class-b/studentPins/1': pinDoc('1', '9999'),
  })

  const asB = await listStudentPinsV2({}, { firestore, auth: { uid: 'teacher-b' } })
  assert.deepEqual(asB.pins, [{ studentId: '1', pin: '9999' }])
})

test('a request carrying any field is refused, so no parameter can select a classroom', async () => {
  const firestore = createMockFirestore({
    ...foundation(),
    'classrooms/class-b/studentPins/1': pinDoc('1', '9999'),
  })

  for (const forged of [
    { classroomId: 'class-b' },
    { studentId: '1' },
    { unexpected: true },
  ]) {
    await assert.rejects(
      () => listStudentPinsV2(forged, { firestore, auth: authA }),
      error => error instanceof StudentPinDirectoryError &&
        error.code === 'invalid-argument',
    )
  }

  await assert.rejects(
    () => listStudentPinsV2([], { firestore, auth: authA }),
    error => error instanceof StudentPinDirectoryError && error.code === 'invalid-argument',
  )

  // An absent body is the ordinary call and must still work.
  assert.deepEqual((await listStudentPinsV2(undefined, { firestore, auth: authA })).pins, [])
})

test('a malformed or mis-pathed entry is skipped rather than shown against the wrong student', async () => {
  const firestore = createMockFirestore({
    ...foundation(),
    'classrooms/class-a/studentPins/1': pinDoc('1', '1357'),
    // Body disagrees with its own document ID: the document was copied.
    'classrooms/class-a/studentPins/2': pinDoc('9', '2468'),
    'classrooms/class-a/studentPins/3': pinDoc('3', '12'),
    'classrooms/class-a/studentPins/4': pinDoc('4', 'abcd'),
    'classrooms/class-a/studentPins/5': pinDoc('5', 1357),
    'classrooms/class-a/studentPins/6': { updatedAt: 1000 },
    'classrooms/class-a/studentPins/7': { studentId: '7', pin: '7777' },
    'classrooms/class-a/studentPins/8': pinDoc('8', '8888', { updatedAt: Number.NaN }),
    'classrooms/class-a/studentPins/9': pinDoc('9', '9999', { extra: true }),
  })

  const result = await listStudentPinsV2({}, { firestore, auth: authA })

  assert.deepEqual(result.pins, [{ studentId: '1', pin: '1357' }])
  // The copied document's PIN must not surface under either ID.
  assert.ok(!JSON.stringify(result.pins).includes('2468'))
})

test('tenant authority is revalidated in the same transaction that reads PINs', async () => {
  const firestore = createMockFirestore(
    {
      ...foundation(),
      'classrooms/class-a/studentPins/1': pinDoc('1', '1357'),
    },
    {
      beforeTransaction(store) {
        store.set('teachers/teacher-a', {
          uid: 'teacher-a',
          classroomId: 'class-a',
          status: 'disabled',
        })
      },
    },
  )

  await assert.rejects(
    () => listStudentPinsV2({}, { firestore, auth: authA }),
    error => error instanceof StudentPinDirectoryError &&
      error.code === 'failed-precondition',
  )
})

test('an unauthenticated or disabled caller is refused before any PIN is read', async () => {
  const firestore = createMockFirestore({
    'teachers/teacher-a': { uid: 'teacher-a', classroomId: 'class-a', status: 'disabled' },
    'classrooms/class-a': { ownerUid: 'teacher-a' },
    'classrooms/class-a/studentPins/1': pinDoc('1', '1357'),
  })

  await assert.rejects(
    () => listStudentPinsV2({}, { firestore, auth: undefined }),
    error => error?.code === 'unauthenticated' || error?.code === 'invalid-auth-uid',
  )
  await assert.rejects(() => listStudentPinsV2({}, { firestore, auth: authA }))
})

test('buildStudentPinDocument pins the exact stored shape and rejects a non-PIN', () => {
  assert.deepEqual(
    buildStudentPinDocument({ studentId: '7', pin: '0427', timestamp: 1000 }),
    { studentId: '7', pin: '0427', updatedAt: 1000 },
  )
  assert.deepEqual(
    Object.keys(buildStudentPinDocument({ studentId: '7', pin: '0427', timestamp: 1000 })).sort(),
    ['pin', 'studentId', 'updatedAt'],
  )

  for (const badPin of ['123', '12345', 'abcd', '12 4', '', '١٢٣٤', 12345, null]) {
    assert.throws(
      () => buildStudentPinDocument({ studentId: '7', pin: badPin, timestamp: 1000 }),
      error => error instanceof StudentPinDirectoryError &&
        error.code === 'invalid-argument',
      `pin ${JSON.stringify(badPin)} must be refused`,
    )
  }
  assert.throws(() => buildStudentPinDocument({ studentId: '../x', pin: '0427', timestamp: 1 }))
  for (const badTimestamp of [undefined, Number.NaN, new Date('invalid'), {}, { toDate: () => 'no' }]) {
    assert.throws(
      () => buildStudentPinDocument({ studentId: '7', pin: '0427', timestamp: badTimestamp }),
      error => error instanceof StudentPinDirectoryError &&
        error.code === 'invalid-argument',
    )
  }
})

test('studentPinPath refuses a traversal or non-canonical identifier', () => {
  assert.equal(studentPinPath('class-a', '7'), 'classrooms/class-a/studentPins/7')
  assert.throws(() => studentPinPath('class-a', '../../secrets'))
  assert.throws(() => studentPinPath('../x', '7'))
})

test('the callable returns only pins and maps every failure to a generic code', async () => {
  const firestore = createMockFirestore({
    ...foundation(),
    'classrooms/class-a/studentPins/1': pinDoc('1', '1357'),
  })

  const ok = await listStudentPinsV2CallableHandler({}, { auth: authA }, { firestore })
  assert.deepEqual(Object.keys(ok), ['pins'])
  assert.deepEqual(ok.pins, [{ studentId: '1', pin: '1357' }])
  // The resolved classroom is not echoed back to the browser.
  assert.equal(ok.classroomId, undefined)

  await assert.rejects(
    () => listStudentPinsV2CallableHandler({}, { auth: undefined }, { firestore }),
    error => {
      assert.equal(error.code, 'unauthenticated')
      assert.equal(error.message, 'Sign in required.')
      assert.equal(error.details, undefined)
      return true
    },
  )

  await assert.rejects(
    () => listStudentPinsV2CallableHandler(
      { classroomId: 'class-b' },
      { auth: authA },
      { firestore },
    ),
    error => {
      assert.equal(error.code, 'invalid-argument')
      assert.equal(error.message, 'The request was invalid.')
      return true
    },
  )

  // A disabled teacher must be indistinguishable from any other ineligible
  // account, and must never see a service message naming a document path.
  const disabled = createMockFirestore({
    'teachers/teacher-a': { uid: 'teacher-a', classroomId: 'class-a', status: 'disabled' },
    'classrooms/class-a': { ownerUid: 'teacher-a' },
  })
  await assert.rejects(
    () => listStudentPinsV2CallableHandler({}, { auth: authA }, { firestore: disabled }),
    error => {
      assert.equal(error.code, 'permission-denied')
      assert.equal(error.message, 'This account is not eligible to complete this action.')
      return true
    },
  )
})

const pinQuery = 'classrooms/class-a/studentPins'
const pinFixture = () => ({ ...foundation(), [`${pinQuery}/1`]: pinDoc('1', '1357') })
const readCallable = firestore => listStudentPinsV2CallableHandler({}, { auth: authA }, { firestore })
const denied = error => {
  assert.equal(error.code, 'permission-denied')
  assert.equal(error.message, 'This account is not eligible to complete this action.')
  assert.equal(error.details, undefined)
  assert.doesNotMatch(JSON.stringify(error), /1357|class-a|studentPins/)
  return true
}

test('sensitive read refuses non-active or invalid controls before querying any PINs', async () => {
  for (const value of [
    undefined, null, {}, control({ mode: 'readOnly' }), control({ mode: 'suspended' }),
    control({ mode: 'unknown' }), control({ generation: 0 }), control({ schemaVersion: 2 }),
    control({ extra: true }), control({ changedAt: 'invalid' }),
  ]) {
    const firestore = createMockFirestore(pinFixture())
    firestore.store.get('classrooms/class-a').accessControl = value
    await assert.rejects(readCallable(firestore), denied)
    assert.ok(!firestore.reads.includes(pinQuery))
    assert.deepEqual(firestore.writes, [])
  }
})

test('explicit student and other roles cannot look up a teacher, even with matching UID', async () => {
  for (const role of ['student', 'admin', '', null]) {
    const firestore = createMockFirestore(pinFixture())
    await assert.rejects(listStudentPinsV2CallableHandler({},
      { auth: { uid: 'teacher-a', token: { role } } }, { firestore }), denied)
    assert.deepEqual(firestore.reads, [])
    assert.deepEqual(firestore.writes, [])
  }
  const firestore = createMockFirestore(pinFixture())
  assert.deepEqual(await listStudentPinsV2CallableHandler(null,
    { auth: { uid: 'teacher-a', token: { role: 'teacher' } } }, { firestore }),
  { pins: [{ studentId: '1', pin: '1357' }] })
  assert.deepEqual(firestore.writes, [])
})

const accessChanges = {
  readOnly: store => { store.get('classrooms/class-a').accessControl = control({ mode: 'readOnly' }) },
  suspended: store => { store.get('classrooms/class-a').accessControl = control({ mode: 'suspended' }) },
  missingControl: store => { delete store.get('classrooms/class-a').accessControl },
  malformedControl: store => { store.get('classrooms/class-a').accessControl = control({ generation: 0 }) },
  resumed: store => { store.get('classrooms/class-a').accessControl = control({ generation: 5 }) },
  owner: store => { store.get('classrooms/class-a').ownerUid = 'teacher-b' },
  teacherStatus: store => { store.get('teachers/teacher-a').status = 'disabled' },
  teacherClassroom: store => { store.get('teachers/teacher-a').classroomId = 'class-b' },
  teacherIdentity: store => { store.get('teachers/teacher-a').uid = 'teacher-b' },
  missingTeacher: store => { store.delete('teachers/teacher-a') },
  missingClassroom: store => { store.delete('classrooms/class-a') },
}

for (const [name, change] of Object.entries(accessChanges)) {
  test(`final check discards read PINs after ${name} changes`, async () => {
    const firestore = createMockFirestore(pinFixture(), {
      beforeTransaction(store, number) { if (number === 2) change(store) },
    })
    await assert.rejects(readCallable(firestore), error => {
      assert.ok(['permission-denied', 'failed-precondition'].includes(error.code))
      assert.equal(error.details, undefined)
      assert.doesNotMatch(JSON.stringify(error), /1357|class-a|studentPins/)
      return true
    })
    assert.equal(firestore.reads.filter(path => path === pinQuery).length, 1)
    assert.deepEqual(firestore.writes, [])
  })
}

for (const transaction of [1, 2]) {
  for (const [name, change] of Object.entries(accessChanges).filter(([name]) => name !== 'resumed')) {
    test(`retry of transaction ${transaction} rechecks ${name} and discards prior result`, async () => {
      const firestore = createMockFirestore(pinFixture(), {
        attempts: number => number === transaction ? 2 : 1,
        beforeAttempt(store, number, attempt) {
          if (number === transaction && attempt === 2) change(store)
        },
      })
      await assert.rejects(readCallable(firestore))
      assert.equal(firestore.reads.filter(path => path === pinQuery).length, 1)
      assert.deepEqual(firestore.writes, [])
    })
  }
}

test('snapshot retries capture fresh generation and PINs, final retries still reject changed generation', async () => {
  const firestore = createMockFirestore(pinFixture(), {
    attempts: number => number === 1 ? 2 : 1,
    beforeAttempt(store, number, attempt) {
      if (number === 1 && attempt === 2) {
        accessChanges.resumed(store)
        store.set(`${pinQuery}/1`, pinDoc('1', '2468'))
      }
    },
  })
  assert.deepEqual(await readCallable(firestore), { pins: [{ studentId: '1', pin: '2468' }] })
  assert.equal(firestore.reads.filter(path => path === pinQuery).length, 2)
  assert.deepEqual(firestore.writes, [])
  const finalRetry = createMockFirestore(pinFixture(), {
    attempts: number => number === 2 ? 2 : 1,
    beforeAttempt(store, number, attempt) {
      if (number === 2 && attempt === 2) accessChanges.resumed(store)
    },
  })
  await assert.rejects(readCallable(finalRetry), denied)
  assert.deepEqual(finalRetry.writes, [])
})

test('active success rechecks only the same foundation immediately before returning, with zero writes', async () => {
  const firestore = createMockFirestore(pinFixture())
  assert.deepEqual(await readCallable(firestore), { pins: [{ studentId: '1', pin: '1357' }] })
  assert.deepEqual(firestore.reads, [
    'teachers/teacher-a', 'classrooms/class-a',
    'teachers/teacher-a', 'classrooms/class-a', pinQuery,
    'teachers/teacher-a', 'classrooms/class-a',
  ])
  assert.deepEqual(firestore.writes, [])
})

test('raw database failures at snapshot and final check become generic internal failures', async () => {
  for (const failedTransaction of [1, 2]) {
    const firestore = createMockFirestore(pinFixture(), {
      beforeTransaction(store, number) {
        if (number === failedTransaction) throw new Error('PRIVATE studentPins 1357 class-a')
      },
    })
    await assert.rejects(readCallable(firestore), error => {
      assert.equal(error.code, 'internal')
      assert.equal(error.message, 'An unexpected internal error occurred.')
      assert.equal(error.details, undefined)
      assert.doesNotMatch(error.stack, /PRIVATE|1357|class-a/)
      return true
    })
    assert.deepEqual(firestore.writes, [])
  }
})

test('actual PIN export gates before handle acquisition and uses the protected service', async () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const route = source.match(/export const listStudentPinsV2 = onCall\(async \(request\) => \{[\s\S]*?\n\}\)/)?.[0]
  assert.ok(route)
  const events = [], firestore = createMockFirestore(pinFixture())
  let block = true
  const context = vm.createContext({
    onCall: handler => handler,
    assertV2Invocation: name => { events.push(name); if (block) throw new Error('disabled') },
    getFirestore: () => { events.push('handle'); return firestore },
    listStudentPinsV2CallableHandler,
  })
  const handler = vm.runInContext(route.replace('export const listStudentPinsV2 = ', ''), context)
  await assert.rejects(handler({ auth: authA }), /disabled/)
  assert.deepEqual(events, ['listStudentPinsV2'])
  assert.deepEqual(firestore.reads, [])
  block = false
  assert.deepEqual(await handler({ auth: authA }), { pins: [{ studentId: '1', pin: '1357' }] })
  accessChanges.suspended(firestore.store)
  await assert.rejects(handler({ auth: authA }), denied)
  assert.deepEqual(firestore.writes, [])
})
