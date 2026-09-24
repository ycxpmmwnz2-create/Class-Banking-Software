import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import vm from 'node:vm'
import { onboardTeacherClassroomCallable, resolveTeacherTenantCallable } from './teacherCallables.js'
import { hashEmailDigest } from './identityNormalization.js'
import { control } from '../../tests/phase3/classroomAccess.fixture.js'
import { TenantSession, SESSION_STATES } from '../../src/phase2b/tenantSession.js'
import { orchestrateTeacherOnboarding } from '../../src/phase2b/tenantClient.js'

const auth = { uid: 'teacher-a', token: { email: 'fictional@example.com', email_verified: true,
  name: 'Teacher A', firebase: { sign_in_provider: 'google.com' } } }
const invite = `teacherInvitations/${hashEmailDigest(auth.token.email)}`
const teacher = 'teachers/teacher-a', classroom = 'classrooms/class-a'
const audit = `${classroom}/accessControlAudits/onboarding`
const instant = '2026-09-22T12:00:00.000Z', millis = Date.parse(instant)
const initial = () => ({ [invite]: { status: 'active', email: auth.token.email, expiresAt: millis + 1000 } })
const existing = (mode = 'active', generation = 7) => ({
  [teacher]: { uid: auth.uid, status: 'active', classroomId: 'class-a' },
  [classroom]: { ownerUid: auth.uid, name: 'Original', studentLoginCode: '2345-6789', nextStudentNumber: 9,
    accessControl: control({ mode, generation }) },
  'classroomLoginCodes/23456789': { classroomId: 'class-a', status: 'active' },
  [invite]: { status: 'consumed', consumedByUid: auth.uid },
})
const clone = value => globalThis.structuredClone(value)

// Synthetic consistent snapshots and atomic precondition checking. Hooks model
// failures/barriers; this does not prove Firestore isolation, retry or durability.
function database(documents = initial(), hooks = {}) {
  const store = clone(documents), reads = [], staged = [], committed = [], options = []
  let calls = 0, generated = 0
  const snapshot = (path, source) => ({ id: path.split('/').pop(), exists: Object.hasOwn(source, path),
    data: () => clone(source[path]) })
  const doc = path => ({ path, id: path.split('/').pop(), async get() {
    reads.push({ direct: true, path }); return snapshot(path, store)
  } })
  const db = { store, reads, staged, committed, options,
    collection: name => ({
      doc: id => {
        if (id === undefined) { generated++; id = hooks.newId?.(generated) ?? `new-class-${generated}` }
        return doc(`${name}/${id}`)
      },
      where: (field, operator, value) => ({ limit: count => ({ query: { name, field, operator, value, count } }) }),
    }),
    async runTransaction(callback, settings) {
      const call = ++calls
      options.push(settings)
      hooks.beforeAttempt?.(store, call)
      const view = clone(store), pending = []
      const queue = (op, ref, data) => {
        assert.notEqual(settings?.readOnly, true, 'no write allowed in read-only transaction')
        const entry = { op, path: ref.path, data: clone(data) }
        pending.push(entry); staged.push({ call, ...entry })
      }
      const result = await callback({
        async get(ref) {
          assert.equal(pending.length, 0, 'all reads precede writes')
          if (ref.query) {
            const { name, field, operator, value, count } = ref.query
            assert.equal(operator, '==')
            reads.push({ call, query: name, field, value })
            const docs = Object.keys(view).filter(path => path.startsWith(`${name}/`) &&
              path.split('/').length === name.split('/').length + 1 && view[path][field] === value)
              .slice(0, count).map(path => snapshot(path, view))
            return { docs, empty: docs.length === 0, size: docs.length }
          }
          reads.push({ call, path: ref.path }); return snapshot(ref.path, view)
        },
        create: (ref, data) => queue('create', ref, data),
        update: (ref, data) => queue('update', ref, data),
        set() { throw new Error('Unexpected set') }, delete() { throw new Error('Unexpected delete') },
      })
      hooks.beforeCommit?.(store, call, pending)
      for (const entry of pending) {
        if (entry.op === 'create' && Object.hasOwn(store, entry.path)) {
          throw Object.assign(new Error('Synthetic create conflict'), { code: 6 })
        }
        assert.ok(entry.op !== 'update' || Object.hasOwn(store, entry.path))
      }
      for (const entry of pending) {
        store[entry.path] = entry.op === 'create' ? clone(entry.data) : { ...store[entry.path], ...clone(entry.data) }
      }
      committed.push(...pending)
      hooks.afterCommit?.(store, call, pending)
      return result
    },
  }
  return db
}
const onboard = (db, extra = {}, request = {}) => onboardTeacherClassroomCallable({ auth,
  data: { classroomName: 'New class' }, ...request }, {
  firestore: db, now: () => millis, serverTimestamp: () => 'synthetic-server-timestamp',
  codeGenerator: () => '23456789', ...extra,
})
const deny = (code = 'permission-denied') => error => {
  assert.equal(error.code, code); assert.equal(error.details, undefined)
  assert.doesNotMatch(error.message, /fictional|teacher-a|class-a|2345|PRIVATE/)
  return true
}

test('onboarding creates exact generation-one control and private audit atomically with foundation and invitation', async () => {
  const db = database(initial(), { newId: () => 'class-a' })
  const result = await onboard(db)
  const expected = { schemaVersion: 1, mode: 'active', generation: 1, changedAt: instant, auditId: 'onboarding' }
  assert.deepEqual(db.store[classroom].accessControl, expected)
  assert.deepEqual(db.store[audit], { schemaVersion: 1, kind: 'onboarding', generation: 1, mode: 'active', changedAt: instant })
  assert.deepEqual(db.committed.map(({ op, path }) => ({ op, path })).sort((a, b) => a.path.localeCompare(b.path)), [
    { op: 'create', path: 'classroomLoginCodes/23456789' }, { op: 'create', path: classroom },
    { op: 'create', path: audit }, { op: 'create', path: teacher }, { op: 'update', path: invite },
  ].sort((a, b) => a.path.localeCompare(b.path)))
  assert.equal(db.store[classroom].nextStudentNumber, 1)
  assert.equal(db.store[invite].status, 'consumed')
  assert.equal(db.store[teacher].classroomId, result.classroom.id)
  assert.deepEqual(Object.keys(result).sort(), ['classroom', 'created', 'teacher'])
  assert.equal(JSON.stringify(result).includes('auditId'), false)
})

test('real client onboarding orchestration reaches active resolution with the newly committed control', async () => {
  const db = database(), session = new TenantSession({ storageAdapter: null, projectId: 'demo-onboarding' })
  session.transitionTo(SESSION_STATES.RESOLVING, { uid: auth.uid, role: 'teacher' })
  session.transitionTo(SESSION_STATES.ONBOARDING_REQUIRED)
  const calls = []
  const result = await orchestrateTeacherOnboarding(session, async (name, data) => {
    calls.push(name)
    if (name === 'onboardTeacherClassroomV2') return { data: await onboard(db, {}, { data }) }
    assert.equal(name, 'resolveTeacherTenantV2')
    return { data: await resolveTeacherTenantCallable({ auth, data }, { firestore: db, now: () => millis }) }
  }, { classroomName: 'New class' })
  assert.equal(result.success, true)
  assert.equal(session.getState(), SESSION_STATES.ACTIVE)
  assert.deepEqual(calls, ['onboardTeacherClassroomV2', 'resolveTeacherTenantV2'])
  assert.equal(db.store[`classrooms/${result.classroom.id}`].accessControl.generation, 1)
})

test('explicit teacher role and readable Date or Timestamp clocks produce canonical control time', async () => {
  for (const value of [new Date(millis), { toMillis: () => millis }]) {
    const db = database()
    const result = await onboard(db, { now: () => value }, { auth: { ...auth, token: { ...auth.token, role: 'teacher' } } })
    assert.equal(db.store[`classrooms/${result.classroom.id}`].accessControl.changedAt, instant)
  }
})

test('existing permitted tenant replays without reusing missing, revoked or consumed invitation', async () => {
  for (const status of [undefined, 'revoked', 'consumed']) {
    const docs = existing('readOnly', 9)
    if (status === undefined) delete docs[invite]
    else docs[invite].status = status
    const db = database(docs), before = clone(db.store)
    assert.equal((await onboard(db)).created, false)
    assert.deepEqual(db.store, before); assert.deepEqual(db.staged, [])
    assert.ok(db.reads.every(row => row.path !== invite))
  }
})

for (const mode of ['active', 'readOnly']) {
  for (const generation of [1, 7, Number.MAX_SAFE_INTEGER]) {
    test(`onboarding replay preserves ${mode} generation ${generation} and writes nothing`, async () => {
      const db = database(existing(mode, generation)), before = clone(db.store)
      const result = await onboard(db, { now: () => { throw new Error('Replay must not initialize') } })
      assert.equal(result.created, false); assert.equal(result.classroom.id, 'class-a')
      assert.deepEqual(db.store, before); assert.deepEqual(db.staged, [])
      assert.ok(db.reads.every(row => row.path !== invite))
    })
  }
}

for (const [name, value] of Object.entries({ suspended: control({ mode: 'suspended' }), missing: undefined,
  null: null, incomplete: {}, generation: control({ generation: 0 }), extra: control({ extra: true }),
  time: control({ changedAt: 'invalid' }), schema: control({ schemaVersion: 2 }) })) {
  test(`replay denies ${name} control before code-index reads and never repairs it`, async () => {
    const docs = existing(); docs[classroom].accessControl = value
    const db = database(docs), before = clone(db.store)
    await assert.rejects(onboard(db), deny())
    assert.deepEqual(db.store, before); assert.deepEqual(db.staged, [])
    assert.deepEqual(db.reads.map(row => row.path), [teacher, classroom])
  })
}

test('explicit non-teacher claims deny before any new or existing foundation lookup', async () => {
  for (const documents of [initial(), existing()]) for (const role of ['student', 'admin', '', null]) {
    const db = database(documents)
    await assert.rejects(onboard(db, {}, { auth: { ...auth, token: { ...auth.token, role } } }), deny())
    assert.deepEqual(db.reads, []); assert.deepEqual(db.staged, [])
  }
})

test('request cannot select mode, generation, audit, timestamp or tenant during onboarding', async () => {
  for (const field of ['mode', 'generation', 'auditId', 'changedAt', 'accessControl', 'classroomId']) {
    const db = database()
    await assert.rejects(onboard(db, {}, { data: { classroomName: 'New', [field]: 'PRIVATE' } }), deny('invalid-argument'))
    assert.deepEqual(db.reads, []); assert.deepEqual(db.staged, [])
  }
})

test('invalid control clocks fail before staging writes even for nonexpiring invitations', async () => {
  for (const value of [null, NaN, Infinity, -Infinity, 9e15, Date.parse('+010000-01-01T00:00:00.000Z'), '2026-09-22', {}]) {
    const docs = initial(); delete docs[invite].expiresAt
    const db = database(docs), before = clone(db.store)
    await assert.rejects(onboard(db, { now: () => value }), deny('failed-precondition'))
    assert.deepEqual(db.store, before); assert.deepEqual(db.staged, [])
  }
})

test('interruption before commit leaves invitation and foundation untouched; retry creates one control and audit', async () => {
  let fail = true
  const db = database(initial(), { beforeCommit() { if (fail) throw new Error('PRIVATE interruption') } })
  const before = clone(db.store)
  await assert.rejects(onboard(db), deny('internal'))
  assert.deepEqual(db.store, before); assert.deepEqual(db.committed, [])
  fail = false
  const result = await onboard(db)
  assert.equal(db.store[`classrooms/${result.classroom.id}`].accessControl.generation, 1)
  assert.equal(db.committed.filter(row => row.path.includes('/accessControlAudits/')).length, 1)
})

test('lost acknowledgment followed by retry preserves committed control and its single audit', async () => {
  const db = database(initial(), { afterCommit(_store, call) { if (call === 1) throw new Error('PRIVATE lost reply') } })
  await assert.rejects(onboard(db), deny('internal'))
  const before = clone(db.store), writes = db.committed.length
  assert.equal(db.store[invite].status, 'consumed')
  const result = await onboard(db)
  assert.equal(result.created, false); assert.deepEqual(db.store, before)
  assert.equal(db.committed.length, writes)
  assert.equal(db.committed.filter(row => row.path.includes('/accessControlAudits/')).length, 1)
})

test('audit create conflict never partially consumes invitation or replaces an audit', async () => {
  const docs = { ...initial(), [audit]: { private: 'PRIVATE existing audit' } }
  const db = database(docs, { newId: () => 'class-a' }), before = clone(db.store)
  await assert.rejects(onboard(db), deny('resource-exhausted'))
  assert.deepEqual(db.store, before); assert.deepEqual(db.committed, [])
})

for (const mode of ['readOnly', 'suspended']) {
  test(`synthetic aborted creation retries against current ${mode} foundation without resetting generation`, async () => {
    const db = database(initial(), {
      beforeCommit(store, call) {
        if (call === 1) {
          Object.assign(store, existing(mode, 11))
          throw Object.assign(new Error('Synthetic concurrent onboarding'), { code: 10 })
        }
      },
    })
    if (mode === 'suspended') await assert.rejects(onboard(db), deny())
    else assert.equal((await onboard(db)).created, false)
    assert.equal(db.store[classroom].accessControl.generation, 11)
    assert.equal(db.store[classroom].accessControl.mode, mode)
    assert.deepEqual(db.committed, [])
  })
}

test('invitation revoked between synthetic attempts prevents enrollment and invitation consumption', async () => {
  const db = database(initial(), { beforeCommit(store, call) {
    if (call === 1) { store[invite].status = 'revoked'; throw Object.assign(new Error('Synthetic abort'), { code: 10 }) }
  } })
  await assert.rejects(onboard(db), deny())
  assert.deepEqual(Object.keys(db.store), [invite]); assert.equal(db.store[invite].status, 'revoked')
  assert.deepEqual(db.committed, [])
})

test('invitation expiry is evaluated again after a synthetic aborted creation', async () => {
  let clock = millis
  const db = database(initial(), { beforeCommit(_store, call) {
    if (call === 1) { clock += 2000; throw Object.assign(new Error('Synthetic abort'), { code: 10 }) }
  } })
  await assert.rejects(onboard(db, { now: () => clock }), deny())
  assert.deepEqual(db.store, initial()); assert.deepEqual(db.committed, [])
})

test('simultaneous onboarding attempts commit one foundation, one audit and one invitation consumption', async () => {
  const db = database()
  const results = await Promise.all([onboard(db), onboard(db)])
  assert.deepEqual(results.map(row => row.created).sort(), [false, true])
  assert.equal(results[0].classroom.id, results[1].classroom.id)
  assert.equal(db.committed.length, 5)
  assert.equal(db.committed.filter(row => row.path.includes('/accessControlAudits/')).length, 1)
})

test('actual onboarding export gates before handles and reaches control-creating service', async () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const route = source.match(/export const onboardTeacherClassroomV2 = onCall\([\s\S]*?\n\}\)/)?.[0]
  assert.ok(route)
  const db = database(), events = []; let blocked = true
  const context = vm.createContext({ onCall: handler => handler,
    assertV2Invocation: name => { events.push(name); if (blocked) throw new Error('disabled') },
    getFirestore: () => { events.push('firestore'); return db }, getAuth: () => { events.push('auth'); return {} },
    onboardTeacherClassroomCallable: (request, options) => onboardTeacherClassroomCallable(request, {
      ...options, now: () => millis, serverTimestamp: () => 'synthetic', codeGenerator: () => '23456789',
    }),
  })
  const handler = vm.runInContext(route.replace('export const onboardTeacherClassroomV2 = ', ''), context)
  await assert.rejects(handler({ auth, data: { classroomName: 'New' } }), /disabled/)
  assert.deepEqual(events, ['onboardTeacherClassroomV2']); assert.deepEqual(db.reads, [])
  blocked = false
  const result = await handler({ auth, data: { classroomName: 'New' } })
  assert.equal(db.store[`classrooms/${result.classroom.id}`].accessControl.generation, 1)
})
