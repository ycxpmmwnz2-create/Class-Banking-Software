import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import vm from 'node:vm'
import {
  ClassroomAccessError, getClassroomAccessCallable, getClassroomAccessService,
  readTeacherClassroomAccess, readStudentClassroomAccess,
  requireClassroomAccess, requireClassroomControl,
} from './classroomAccess.js'
import { control, database, documents, studentAuth, teacherAuth } from '../../tests/phase3/classroomAccess.fixture.js'

const denied = error => error instanceof ClassroomAccessError && error.code === 'permission-denied'
const read = (firestore, auth = teacherAuth, data = {}) => getClassroomAccessService({ firestore, auth, data })

test('control schema rejects absent, malformed, extra and accessor fields without evaluation', () => {
  for (const value of [undefined, null, {}, [], control({ schemaVersion: 2 }), control({ mode: 'unknown' }),
    control({ generation: 0 }), control({ generation: 1.5 }), control({ generation: Number.MAX_SAFE_INTEGER + 1 }),
    control({ changedAt: '2026-02-30T00:00:00.000Z' }), control({ changedAt: '2026-09-22' }),
    control({ auditId: 'a/b' }), control({ extra: true }), control({ generation: '3' })]) {
    assert.throws(() => requireClassroomControl(value), denied)
  }
  let invoked = false
  const accessor = { ...control(), get mode() { invoked = true; return 'active' } }
  assert.throws(() => requireClassroomControl(accessor), denied)
  assert.equal(invoked, false)
  assert.ok(Object.isFrozen(requireClassroomControl(control())))
})

test('mode matrix preserves scoped reads and recovery but restricts mutations and sensitive reads', () => {
  for (const mode of ['active', 'readOnly', 'suspended']) {
    for (const operation of ['read', 'recovery', 'sensitiveRead', 'mutate']) {
      const allowed = mode === 'active' || mode === 'readOnly' && ['read', 'recovery'].includes(operation)
      const call = () => requireClassroomAccess(control({ mode }), { operation, protocolVersion: 1, controlGeneration: 3 })
      if (allowed) assert.equal(call().mode, mode)
      else assert.throws(call, denied)
    }
  }
  assert.throws(() => requireClassroomAccess(control(), { operation: 'operator' }), denied)
})

test('mutations never inherit current generation or accept old protocol after resume', () => {
  for (const request of [{}, { protocolVersion: 1 }, { protocolVersion: 0, controlGeneration: 3 },
    { protocolVersion: 1, controlGeneration: 2 }, { protocolVersion: 1, controlGeneration: '3' }]) {
    assert.throws(() => requireClassroomAccess(control(), { operation: 'mutate', ...request }), denied)
  }
  assert.throws(() => requireClassroomAccess(control({ generation: 5 }),
    { operation: 'mutate', protocolVersion: 1, controlGeneration: 3 }), denied)
})

test('teacher endpoint returns only fresh public control state, with zero writes', async () => {
  for (const mode of ['active', 'readOnly']) {
    const db = database([documents(mode)])
    assert.deepEqual(await read(db), { protocolVersion: 1, mode, generation: 3 })
    assert.deepEqual(db.reads.map(r => r.path), ['teachers/teacher-a', 'classrooms/class-a'])
    assert.deepEqual(db.staged, [])
  }
})

test('teacher foundation and missing or suspended controls fail closed', async () => {
  for (const modify of [
    d => { delete d['teachers/teacher-a'] },
    d => { d['teachers/teacher-a'].uid = 'teacher-b' },
    d => { d['teachers/teacher-a'].status = 'disabled' },
    d => { d['teachers/teacher-a'].classroomId = 'class-b' },
    d => { delete d['classrooms/class-a'] },
    d => { d['classrooms/class-a'].ownerUid = 'teacher-b' },
    d => { delete d['classrooms/class-a'].accessControl },
    d => { d['classrooms/class-a'].accessControl.mode = 'suspended' },
  ]) {
    const d = documents(); modify(d)
    const db = database([d])
    await assert.rejects(read(db), denied)
    assert.deepEqual(db.staged, [])
  }
})

test('request cannot select a tenant; anonymous, malformed and unexpected-role callers fail', async () => {
  const db = database()
  await assert.rejects(read(db, teacherAuth, { classroomId: 'class-b' }), e => e.code === 'invalid-argument')
  await assert.rejects(read(db, null), e => e.code === 'unauthenticated')
  for (const auth of [{ uid: 'a/b' }, { uid: 'teacher-a', token: { role: 'admin' } }]) {
    await assert.rejects(read(db, auth), denied)
  }
  assert.equal(db.reads.length, 0)
})

test('student route checks only its current reciprocal foundation and exact credential', async () => {
  for (const mode of ['active', 'readOnly']) {
    const db = database([documents(mode)])
    assert.deepEqual(await read(db, studentAuth), { protocolVersion: 1, mode, generation: 3 })
    assert.deepEqual(db.reads.map(r => r.path), ['classrooms/class-a', 'teachers/teacher-a', 'classrooms/class-a/studentCredentials/learner1'])
    assert.ok(!db.reads.some(r => r.path === `teachers/${studentAuth.uid}`))
    assert.deepEqual(db.staged, [])
  }
})

test('student credential removal, disable, identity and version mismatch deny without disclosure', async () => {
  const path = 'classrooms/class-a/studentCredentials/learner1'
  for (const changes of [null, { active: false }, { classroomId: 'class-b' }, { studentId: '2' },
    { authUid: 'wrong-uid' }, { pinUpdatedAt: 999 }, { pinUpdatedAt: NaN }, { pinUpdatedAt: { toMillis() { throw new Error('PRIVATE') } } }]) {
    const d = documents()
    if (changes === null) delete d[path]
    else Object.assign(d[path], changes)
    await assert.rejects(read(database([d]), studentAuth), denied)
  }
  for (const value of [new Date(1000), { toMillis: () => 1000 }]) {
    const d = documents(); d[path].pinUpdatedAt = value
    assert.equal((await read(database([d]), studentAuth)).mode, 'active')
  }
})

test('forged student claims cannot fall through to a teacher identity', async () => {
  for (const changes of [{ classroomId: 'class-b' }, { studentId: '2' }, { studentId: '01' },
    { loginId: ' LEARNER1 ' }, { credentialVersion: 0 }, { credentialVersion: '1000' }]) {
    const db = database()
    await assert.rejects(read(db, { ...studentAuth, token: { ...studentAuth.token, ...changes } }), denied)
    assert.equal(db.reads.length, 0)
  }
  const d = documents('suspended')
  d[`teachers/${studentAuth.uid}`] = { uid: studentAuth.uid, classroomId: 'class-a', status: 'active' }
  const db = database([d])
  await assert.rejects(read(db, studentAuth), denied)
  assert.ok(!db.reads.some(r => r.path === `teachers/${studentAuth.uid}`))
})

test('student policy cannot acquire teacher recovery or sensitive-read permissions', async () => {
  for (const operation of ['recovery', 'sensitiveRead']) {
    const db = database()
    await assert.rejects(db.runTransaction(transaction => readStudentClassroomAccess({
      transaction, firestore: db, auth: studentAuth, policy: { operation },
    })), denied)
    assert.equal(db.reads.length, 0)
  }
})

test('student access refuses a missing or disabled owner and foreign reciprocal foundation', async () => {
  for (const change of [
    d => { delete d['teachers/teacher-a'] },
    d => { d['teachers/teacher-a'].status = 'disabled' },
    d => { d['teachers/teacher-a'].classroomId = 'class-b' },
    d => { d['teachers/teacher-a'].uid = 'teacher-b' },
    d => { delete d['classrooms/class-a'].accessControl },
  ]) {
    const d = documents(); change(d)
    const db = database([d])
    await assert.rejects(read(db, studentAuth), denied)
    assert.deepEqual(db.staged, [])
  }
})

test('student credential rotation on retry discards a previously authorized status', async () => {
  const rotated = documents()
  rotated['classrooms/class-a/studentCredentials/learner1'].pinUpdatedAt = 1001
  const db = database([documents(), rotated])
  await assert.rejects(read(db, studentAuth), denied)
  assert.equal(db.reads.filter(r => r.path.endsWith('/learner1')).length, 2)
})

test('access status retries re-read foundation and discard an earlier active result', async () => {
  for (const auth of [teacherAuth, studentAuth]) {
    const db = database([documents(), documents('suspended')])
    await assert.rejects(read(db, auth), denied)
    assert.ok(db.reads.some(r => r.attempt === 1 && r.path === 'classrooms/class-a'))
    assert.deepEqual(db.committed, [])
  }
})

test('mutation guard is evaluated inside every callback before staged writes', async () => {
  for (const mutate of [
    d => { d['classrooms/class-a'].accessControl.mode = 'readOnly' },
    d => { d['classrooms/class-a'].accessControl.generation = 5 },
    d => { d['classrooms/class-a'].ownerUid = 'teacher-b' },
  ]) {
    const retry = documents(); mutate(retry)
    const db = database([documents(), retry])
    await assert.rejects(db.runTransaction(async transaction => {
      await readTeacherClassroomAccess({ transaction, firestore: db, auth: teacherAuth,
        policy: { operation: 'mutate', protocolVersion: 1, controlGeneration: 3 } })
      transaction.update(db.doc('classrooms/class-a/students/1'), { testOnly: true })
    }), denied)
    assert.equal(db.staged.length, 1) // first callback only, then discarded
    assert.equal(db.committed.length, 0)
  }
})

test('callable maps access and unexpected failures to bounded generic messages', async () => {
  await assert.rejects(getClassroomAccessCallable({ auth: teacherAuth, data: {} },
    { firestore: database([documents('suspended')]) }), error =>
    error.code === 'permission-denied' && error.message === 'Classroom access is unavailable.')
  await assert.rejects(getClassroomAccessCallable({ auth: teacherAuth, data: {} },
    { firestore: { runTransaction() { throw new Error('PRIVATE PATH AND PIN') } } }), error =>
    error.code === 'internal' && error.message === 'Classroom access is unavailable.' && !JSON.stringify(error).includes('PRIVATE'))
})

test('actual exported access route gates before acquiring a handle or calling service', async () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const route = source.match(/export const getClassroomAccessV2 = onCall\(async \(request\) => \{[\s\S]*?\n\}\)/)?.[0]
  assert.ok(route, 'Missing access endpoint wiring')
  const events = []
  const firestore = database()
  let block = true
  const context = vm.createContext({
    onCall: handler => handler,
    assertV2Invocation: operation => { events.push(operation); if (block) throw new Error('disabled') },
    getFirestore: () => { events.push('handle'); return firestore },
    getClassroomAccessCallable,
  })
  const handler = vm.runInContext(route.replace('export const getClassroomAccessV2 = ', ''), context)
  await assert.rejects(handler({ auth: teacherAuth, data: {} }), /disabled/)
  assert.deepEqual(events, ['getClassroomAccessV2'])
  block = false
  assert.deepEqual(await handler({ auth: teacherAuth, data: {} }), { protocolVersion: 1, mode: 'active', generation: 3 })
  assert.deepEqual(events, ['getClassroomAccessV2', 'getClassroomAccessV2', 'handle'])
})
