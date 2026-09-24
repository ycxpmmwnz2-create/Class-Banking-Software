import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import vm from 'node:vm'
import { resolveTeacherTenantCallable } from './teacherCallables.js'
import { resolveTeacherTenantService } from './teacherOnboarding.js'
import { hashEmailDigest } from './identityNormalization.js'
import { control, teacherAuth } from '../../tests/phase3/classroomAccess.fixture.js'

const teacherPath = 'teachers/teacher-a'
const classroomPath = 'classrooms/class-a'
const invitationPath = `teacherInvitations/${hashEmailDigest('fictional@example.com')}`
const invitedAuth = { uid: 'teacher-a', token: {
  email: 'fictional@example.com', email_verified: true,
  firebase: { sign_in_provider: 'google.com' },
} }
const foundation = () => ({
  [teacherPath]: { uid: 'teacher-a', classroomId: 'class-a', status: 'active', displayName: 'Teacher A', email: 'fictional@example.com', privateField: 'PRIVATE TEACHER' },
  [classroomPath]: { ownerUid: 'teacher-a', name: 'Class A', studentLoginCode: '2345-6789', accessControl: control(), privateField: 'PRIVATE CLASSROOM' },
  'teachers/teacher-b': { uid: 'teacher-b', classroomId: 'class-b', status: 'active' },
  'classrooms/class-b': { ownerUid: 'teacher-b', name: 'Class B', studentLoginCode: '2345-678A', accessControl: control() },
  [invitationPath]: { status: 'active', email: 'fictional@example.com', expiresAt: 5000 },
})

// Fictional callback invocations, not SDK retry/consistency/contention proof.
// Real read-only transactions do not retry. Repeated invocations here stress
// response reconstruction only; they deliberately exceed the SDK's behavior.
function database(initial = foundation(), { attempts = 1, beforeAttempt } = {}) {
  const store = globalThis.structuredClone(initial), reads = [], writes = [], transactionOptions = []
  const snapshot = (path, source) => ({
    exists: Object.hasOwn(source, path), id: path.split('/').pop(),
    data: () => globalThis.structuredClone(source[path]),
  })
  const doc = path => ({ path, id: path.split('/').pop(), async get() {
    reads.push({ kind: 'direct', path })
    return snapshot(path, store)
  } })
  return {
    store, reads, writes, transactionOptions,
    collection: name => ({ doc: id => doc(`${name}/${id}`) }),
    async runTransaction(callback, options) {
      transactionOptions.push(options)
      let result
      for (let attempt = 1; attempt <= attempts; attempt++) {
        beforeAttempt?.(store, attempt)
        const view = globalThis.structuredClone(store)
        const write = () => { writes.push(attempt); throw new Error('Unexpected write') }
        result = await callback({
          get: async ref => {
            reads.push({ kind: 'transaction', attempt, path: ref.path })
            return snapshot(ref.path, view)
          },
          set: write, update: write, create: write, delete: write,
        })
      }
      return result
    },
  }
}
const read = (firestore, { auth = teacherAuth, data } = {}) =>
  resolveTeacherTenantCallable({ auth, data }, { firestore, now: () => 1000 })
const denial = (code = 'permission-denied') => error => {
  assert.equal(error.code, code)
  assert.equal(error.details, undefined)
  assert.doesNotMatch(error.message, /PRIVATE|class-a|teacher-a|fictional|2345/)
  assert.doesNotMatch(error.stack, /PRIVATE|fictional|2345/)
  return true
}

for (const mode of ['active', 'readOnly']) {
  test(`teacher resolution returns current ${mode} control and only existing public identity fields`, async () => {
    const db = database()
    db.store[classroomPath].accessControl = control({ mode })
    const result = await read(db)
    assert.deepEqual(result, {
      state: 'active', protocolVersion: 1, mode, generation: 3,
      teacher: { uid: 'teacher-a', displayName: 'Teacher A', email: 'fictional@example.com' },
      classroom: { id: 'class-a', name: 'Class A', studentLoginCode: '2345-6789' },
    })
    assert.deepEqual(db.reads, [
      { kind: 'direct', path: teacherPath }, { kind: 'direct', path: classroomPath },
      { kind: 'transaction', attempt: 1, path: teacherPath }, { kind: 'transaction', attempt: 1, path: classroomPath },
    ])
    assert.deepEqual(db.writes, [])
    assert.deepEqual(db.transactionOptions, [{ readOnly: true }])
  })
}

test('resolution refuses suspended, missing and malformed control without exposing classroom data', async () => {
  for (const value of [undefined, null, {}, control({ mode: 'suspended' }), control({ mode: 'unknown' }),
    control({ generation: 0 }), control({ generation: 1.5 }), control({ schemaVersion: 2 }),
    control({ changedAt: 'invalid' }), control({ extra: true })]) {
    const db = database()
    db.store[classroomPath].accessControl = value
    await assert.rejects(read(db), denial())
    assert.ok(db.reads.every(row => [teacherPath, classroomPath].includes(row.path)))
    assert.deepEqual(db.writes, [])
  }
})

test('explicit non-teacher roles cannot resolve a teacher or learn invitation eligibility', async () => {
  for (const initial of [foundation(), { [invitationPath]: foundation()[invitationPath] }]) {
    for (const role of ['student', 'admin', '', null]) {
      const db = database(initial)
      await assert.rejects(read(db, { auth: { ...invitedAuth, token: { ...invitedAuth.token, role } } }), denial())
      assert.deepEqual(db.reads, [])
      assert.deepEqual(db.writes, [])
    }
  }
})

const changes = {
  suspended: store => { store[classroomPath].accessControl = control({ mode: 'suspended' }) },
  missingControl: store => { delete store[classroomPath].accessControl },
  malformedControl: store => { store[classroomPath].accessControl = control({ generation: 0 }) },
  owner: store => { store[classroomPath].ownerUid = 'teacher-b' },
  disabled: store => { store[teacherPath].status = 'disabled' },
  invalidStatus: store => { store[teacherPath].status = 'unknown' },
  classroom: store => { store[teacherPath].classroomId = 'class-b' },
  uid: store => { store[teacherPath].uid = 'teacher-b' },
  missingTeacher: store => { delete store[teacherPath] },
  missingClassroom: store => { delete store[classroomPath] },
  missingCode: store => { delete store[classroomPath].studentLoginCode },
  malformedCode: store => { store[classroomPath].studentLoginCode = 'malformed' },
  noncanonicalCode: store => { store[classroomPath].studentLoginCode = '23456789' },
}
for (const [name, change] of Object.entries(changes)) {
  for (const changedAttempt of [1, 2]) {
    test(`resolution discards identity after ${name} changes before synthetic callback ${changedAttempt}`, async () => {
      const db = database(foundation(), {
        attempts: changedAttempt,
        beforeAttempt(store, attempt) { if (attempt === changedAttempt) change(store) },
      })
      await assert.rejects(read(db, { auth: invitedAuth }), error => {
        assert.ok(['permission-denied', 'failed-precondition'].includes(error.code))
        assert.equal(error.details, undefined)
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE|class-a|teacher-a|fictional|2345/)
        return true
      })
      assert.ok(db.reads.every(row => [teacherPath, classroomPath].includes(row.path)))
      assert.deepEqual(db.writes, [])
    })
  }
}

test('synthetic repeated callbacks rebuild identity and mode/generation from their own snapshots', async () => {
  const db = database(foundation(), {
    attempts: 2,
    beforeAttempt(store, attempt) {
      store[teacherPath].displayName = `Current ${attempt}`
      store[teacherPath].email = `current${attempt}@example.com`
      store[classroomPath].name = `Current class ${attempt}`
      store[classroomPath].studentLoginCode = '2345-678A'
      store[classroomPath].accessControl = control({ mode: attempt === 1 ? 'active' : 'readOnly', generation: attempt + 3 })
    },
  })
  const result = await read(db)
  assert.equal(result.teacher.displayName, 'Current 2')
  assert.equal(result.teacher.email, 'current2@example.com')
  assert.equal(result.classroom.name, 'Current class 2')
  assert.equal(result.classroom.studentLoginCode, '2345-678A')
  assert.equal(result.mode, 'readOnly')
  assert.equal(result.generation, 5)
  assert.deepEqual(db.writes, [])
})

test('fresh resolution after pause/resume returns new generation without accepting request-supplied authority', async () => {
  const db = database()
  db.store[classroomPath].accessControl = control({ generation: 5 })
  assert.equal((await read(db)).generation, 5)
  for (const data of [{ generation: 3 }, { mode: 'active' }, { classroomId: 'class-b' }, { protocolVersion: 1 }]) {
    const before = db.reads.length
    await assert.rejects(read(db, { data }), denial('invalid-argument'))
    assert.equal(db.reads.length, before)
  }
  assert.deepEqual(db.writes, [])
})

test('teacher role, absent role, null and absent request bodies preserve successful resolution', async () => {
  for (const data of [null, undefined, {}]) {
    const db = database()
    const result = await read(db, { data, auth: { uid: 'teacher-a', token: { role: 'teacher' } } })
    assert.equal(result.state, 'active')
    assert.equal(result.mode, 'active')
    assert.deepEqual(db.writes, [])
  }
})

test('teacher B resolves only its own foundation', async () => {
  const db = database()
  const result = await read(db, { auth: { uid: 'teacher-b' } })
  assert.equal(result.classroom.id, 'class-b')
  assert.equal(result.generation, 3)
  assert.ok(db.reads.every(row => ![teacherPath, classroomPath].includes(row.path)))
  assert.deepEqual(db.writes, [])
})

test('invited missing teacher keeps onboarding eligibility only, without fabricated control', async () => {
  const db = database({ [invitationPath]: foundation()[invitationPath] })
  assert.deepEqual(await read(db, { auth: invitedAuth }), { state: 'onboarding-required', eligibility: 'invited' })
  assert.deepEqual(db.reads, [{ kind: 'direct', path: teacherPath }, { kind: 'direct', path: invitationPath }])
  assert.deepEqual(db.writes, [])
  assert.deepEqual(db.transactionOptions, [])
})

test('invitation-only resolution requires runTransaction before any lookup', async () => {
  const db = database({ [invitationPath]: foundation()[invitationPath] })
  const collectionOnly = { collection: db.collection }
  await assert.rejects(resolveTeacherTenantService({
    firestore: collectionOnly, auth: invitedAuth, now: () => 1000,
  }), TypeError)
  await assert.rejects(read(collectionOnly, { auth: invitedAuth }), denial('internal'))
  assert.deepEqual(db.reads, [])
  assert.deepEqual(db.writes, [])
  assert.deepEqual(db.transactionOptions, [])
})

test('unauthenticated, uninvited and invalid invitation callers still fail closed', async () => {
  const db = database({})
  await assert.rejects(read(db, { auth: null }), denial('unauthenticated'))
  assert.deepEqual(db.reads, [])
  await assert.rejects(read(db, { auth: invitedAuth }), denial())
  db.store[invitationPath] = { ...foundation()[invitationPath], expiresAt: 999 }
  await assert.rejects(read(db, { auth: invitedAuth }), denial())
  assert.deepEqual(db.writes, [])
})

test('transaction failures are generic and never fall back to old identity or invitation', async () => {
  const db = database(foundation(), { beforeAttempt() { throw new Error('PRIVATE fictional@example.com 2345-6789') } })
  await assert.rejects(read(db, { auth: invitedAuth }), denial('internal'))
  assert.ok(db.reads.every(row => row.path !== invitationPath))
  assert.deepEqual(db.writes, [])
})

test('actual teacher-resolution export gates before handles and calls protected service', async () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const route = source.match(/export const resolveTeacherTenantV2 = onCall\([\s\S]*?\n\}\)/)?.[0]
  assert.ok(route)
  const db = database(), events = []
  let block = true
  const context = vm.createContext({
    onCall: (options, handler) => handler,
    RESOLVE_TEACHER_TENANT_MIN_INSTANCES: 0,
    assertV2Invocation: name => { events.push(name); if (block) throw new Error('disabled') },
    getFirestore: () => { events.push('firestore'); return db },
    getAuth: () => { events.push('auth'); return {} },
    resolveTeacherTenantCallable,
  })
  const handler = vm.runInContext(route.replace('export const resolveTeacherTenantV2 = ', ''), context)
  await assert.rejects(handler({ auth: teacherAuth, data: {} }), /disabled/)
  assert.deepEqual(events, ['resolveTeacherTenantV2'])
  assert.deepEqual(db.reads, [])
  block = false
  assert.equal((await handler({ auth: teacherAuth, data: {} })).generation, 3)
  db.store[classroomPath].accessControl = control({ mode: 'suspended' })
  await assert.rejects(handler({ auth: teacherAuth, data: {} }), denial())
  assert.deepEqual(db.writes, [])
})
