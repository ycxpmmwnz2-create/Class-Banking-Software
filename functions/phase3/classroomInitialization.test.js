import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIALIZATION_DEMO_PROJECT as projectId, planClassroomInitializationRehearsal,
  initializeClassroomControlsRehearsal } from './classroomInitialization.js'

const environment = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }
const operationId = '00112233445566778899aabbccddeeff'
const clock = () => '2026-09-25T12:00:00.000Z'
const copy = value => globalThis.structuredClone(value)
function fixture(count = 2) {
  let tick = 100
  const store = new Map(), writes = [], options = []
  const db = { projectId, databaseId: '(default)', store, writes, options, pages: 0, writeCommits: 0,
    put(path, data) { store.set(path, { data: copy(data), version: { seconds: ++tick, nanoseconds: 7 } }) },
    doc(path) { return { path, id: path.split('/').at(-1) } },
    collection(path) {
      const query = { path, count: 25, cursor: '',
        orderBy(field) { assert.equal(field, '__name__'); return this },
        limit(count) { this.count = count; return this },
        startAfter(doc) { this.cursor = doc.id; return this },
        async listDocuments() {
          return [...new Set([...store.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.split('/')[1]))]
            .map(id => db.doc(`${path}/${id}`))
        },
      }
      return query
    },
    async runTransaction(callback, option) {
      options.push(option)
      const attempts = db.retryNext ? 2 : 1; db.retryNext = false
      for (let attempt = 0; attempt < attempts; attempt++) {
        const pending = []
        const snapshot = path => {
          const value = store.get(path)
          return { ...db.doc(path), ref: db.doc(path), exists: !!value, data: () => copy(value?.data), updateTime: value?.version }
        }
        const transaction = {
          async get(ref) {
            assert.equal(pending.length, 0, 'all reads precede all writes')
            if (ref.count) {
              db.pages++
              let paths = [...store.keys()].filter(key => key.startsWith(`${ref.path}/`) && key.split('/').length === ref.path.split('/').length + 1).sort()
              paths = paths.filter(path => path.split('/').at(-1) > ref.cursor).slice(0, ref.count)
              const docs = paths.map(snapshot)
              if (db.badPage && ref.path === 'classrooms') return { docs: [docs[0], docs[0]] }
              return { docs }
            }
            return snapshot(ref.path)
          },
          create(ref, data) { assert.notEqual(option?.readOnly, true); pending.push({ method: 'create', path: ref.path, data }) },
          update(ref, data) { assert.notEqual(option?.readOnly, true); pending.push({ method: 'update', path: ref.path, data }) },
        }
        const result = await callback(transaction)
        if (attempt < attempts - 1) { db.onRetry?.(); continue }
        if (pending.length) {
          const stamp = { seconds: ++tick, nanoseconds: 7 }
          for (const change of pending) assert.equal(store.has(change.path), change.method === 'update', 'create-only witness / update-only root')
          for (const change of pending) {
            const data = { ...change.data }
            store.set(change.path, { data: copy(change.method === 'update' ? { ...store.get(change.path).data, ...data } : data), version: stamp })
            writes.push(change.path)
          }
          db.writeCommits++
          if (db.writeCommits === db.failAfterWrite) throw new Error('PRIVATE LOST RESPONSE')
        }
        return result
      }
    },
  }
  for (let i = 0; i < count; i++) {
    const id = `class-${String(i).padStart(3, '0')}`
    db.put(`classrooms/${id}`, { ownerUid: `owner-${i}`, privateData: 'PRIVATE CLASSROOM', settings: { rent: 10 } })
    db.put(`teachers/owner-${i}`, { uid: `owner-${i}`, classroomId: id, status: 'active', name: 'PRIVATE NAME' })
    db.put(`classrooms/${id}/students/1`, { balance: 1.001, privateData: 'PRIVATE STUDENT' })
  }
  return db
}
const plan = (db, overrides = {}) => planClassroomInitializationRehearsal({ firestore: db, projectId, operationId, clock, environment, ...overrides })
const execute = (db, p, overrides = {}) => initializeClassroomControlsRehearsal({ firestore: db, projectId, plan: p, environment, ...overrides })
const category = expected => error => error.category === expected && error.message === 'Classroom initialization rehearsal is unavailable.'

test('rehearsal guard rejects real/default/mismatched projects, nondefault database and missing/nonlocal emulator before reads', async () => {
  for (const overrides of [{ projectId: 'morgan-bank' }, { projectId: undefined }, { environment: {} },
    { environment: { FIRESTORE_EMULATOR_HOST: 'external:8080' } }]) {
    const db = fixture(); await assert.rejects(plan(db, overrides), category('rehearsal-only')); assert.equal(db.pages, 0)
  }
  for (const field of ['projectId', 'databaseId']) {
    const db = fixture(); db[field] = 'different'; await assert.rejects(plan(db), category('rehearsal-only')); assert.equal(db.pages, 0)
  }
  const db = fixture(); Object.defineProperty(db, 'projectId', { get() { throw new Error('PRIVATE SDK') } })
  await assert.rejects(plan(db), error => error.category === 'rehearsal-failed' && !String(error.stack).includes('PRIVATE'))
  assert.equal(db.pages, 0)
})

test('paginated whole-namespace read-only inventory is immutable and contains no raw records', async () => {
  const db = fixture(26), p = await plan(db)
  assert.equal(p.rows.length, 26); assert.equal(db.pages, 28)
  assert.deepEqual(db.options, [{ readOnly: true }]); assert.deepEqual(db.writes, [])
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.rows) && Object.isFrozen(p.rows[0].rootVersion))
  assert.ok(!JSON.stringify(p).includes('PRIVATE'))
  assert.equal((await plan(db)).scopeDigest, p.scopeDigest)
  assert.notEqual((await plan(db, { operationId: '112233445566778899aabbccddeeff00' })).scopeDigest, p.scopeDigest)
})

test('phantom root, broken foundation, duplicate page and empty/oversized inventory never yield partial plans', async () => {
  for (const mutate of [db => db.store.delete('classrooms/class-001'),
    db => db.store.delete('teachers/owner-1'), db => db.put('teachers/owner-1', { uid: 'owner-1', classroomId: 'other', status: 'active' }),
    db => { db.badPage = true }, db => db.store.clear()]) {
    const db = fixture(); mutate(db); await assert.rejects(plan(db)); assert.deepEqual(db.writes, [])
  }
  const db = fixture(101); await assert.rejects(plan(db), category('inventory-limit')); assert.deepEqual(db.writes, [])
})

test('any existing control or operation audit blocks planning rather than resets generation', async () => {
  for (const accessControl of [null, {}, { mode: 'active', generation: 1 }, { mode: 'readOnly', generation: 99 }, { mode: 'suspended', generation: 7 }]) {
    const db = fixture(); db.put('classrooms/class-001', { ...db.store.get('classrooms/class-001').data, accessControl })
    await assert.rejects(plan(db), category('existing-control')); assert.deepEqual(db.writes, [])
  }
  const db = fixture(); db.put(`classrooms/class-001/accessControlAudits/${operationId}`, {})
  await assert.rejects(plan(db), category('journal-conflict')); assert.deepEqual(db.writes, [])
})

test('saved-plan replay creates readOnly generation1 and atomic witnesses, never changes student data or activates', async () => {
  const db = fixture(), p = await plan(db), studentBefore = copy(db.store.get('classrooms/class-000/students/1'))
  const result = await execute(db, JSON.parse(JSON.stringify(p)))
  assert.deepEqual(result, { kind: 'classroom-initialization-rehearsal', classroomCount: 2, completedCount: 2,
    mode: 'readOnly', productionEligible: false, activationAllowed: false })
  assert.ok(!JSON.stringify(result).includes('class-'))
  for (const row of p.rows) {
    const root = db.store.get(`classrooms/${row.classroomId}`)
    assert.deepEqual(root.data.accessControl, { schemaVersion: 1, mode: 'readOnly', generation: 1, changedAt: clock(), auditId: operationId })
    assert.equal(root.data.privateData, 'PRIVATE CLASSROOM')
    assert.deepEqual(root.version, db.store.get(`classrooms/${row.classroomId}/accessControlAudits/${operationId}`).version)
  }
  assert.deepEqual(db.store.get('classrooms/class-000/students/1'), studentBefore)
  const count = db.writes.length
  assert.deepEqual(await execute(db, p), result); assert.equal(db.writes.length, count)
})

test('lost response after first room resumes from server journal with no double write or reset', async () => {
  const db = fixture(), p = await plan(db); db.failAfterWrite = 2
  await assert.rejects(execute(db, p), category('rehearsal-failed'))
  assert.equal(db.store.get(`classroomInitializationRuns/${operationId}`).data.completedCount, 1)
  assert.equal(db.store.get('classrooms/class-001').data.accessControl, undefined)
  const completedBefore = copy(db.store.get('classrooms/class-000'))
  await execute(db, p)
  assert.deepEqual(db.store.get('classrooms/class-000'), completedBefore)
  assert.equal(db.store.get(`classroomInitializationRuns/${operationId}`).data.completedCount, 2)
})

test('changed project/scope/time/digest and malformed plans fail before any writes', async () => {
  for (const mutate of [p => { p.scopeDigest = '0'.repeat(64) }, p => { p.rows.pop() },
    p => { p.changedAt = '2026-09-26T12:00:00.000Z' }, p => { p.operationId = 'different' },
    p => { p.projectId = 'morgan-bank' }, p => { p.extra = true }, p => { p.rows = new Array(2) }]) {
    const db = fixture(), p = JSON.parse(JSON.stringify(await plan(db))); mutate(p)
    await assert.rejects(execute(db, p), category('invalid-plan')); assert.deepEqual(db.writes, [])
  }
})

test('any root/owner version drift invalidates entire scope before journal creation', async () => {
  for (const path of ['classrooms/class-001', 'teachers/owner-1']) {
    const db = fixture(), p = await plan(db); db.put(path, db.store.get(path).data)
    await assert.rejects(execute(db, p), category('version-conflict')); assert.deepEqual(db.writes, [])
  }
})

test('callback retry rechecks changed later classroom and cannot publish prior staged journal', async () => {
  const db = fixture(), p = await plan(db); db.retryNext = true
  db.onRetry = () => db.put('classrooms/class-001', db.store.get('classrooms/class-001').data)
  await assert.rejects(execute(db, p), category('version-conflict')); assert.deepEqual(db.writes, [])
})

test('partial recovery rejects namespace drift, owner drift, missing/tampered witness, changed control and journal count', async () => {
  for (const mutate of [
    db => db.put('classrooms/new-orphan/students/1', {}),
    db => db.put('teachers/owner-1', db.store.get('teachers/owner-1').data),
    db => db.store.delete(`classrooms/class-000/accessControlAudits/${operationId}`),
    db => db.put('classrooms/class-000', { ...db.store.get('classrooms/class-000').data, accessControl: { mode: 'active' } }),
    db => db.put('classrooms/class-000', db.store.get('classrooms/class-000').data),
    db => db.put(`classrooms/class-000/accessControlAudits/${operationId}`, db.store.get(`classrooms/class-000/accessControlAudits/${operationId}`).data),
    db => db.put(`classroomInitializationRuns/${operationId}`, { ...db.store.get(`classroomInitializationRuns/${operationId}`).data, completedCount: 2 }),
    db => db.store.delete(`classroomInitializationRuns/${operationId}`),
  ]) {
    const db = fixture(), p = await plan(db); db.failAfterWrite = 2
    await assert.rejects(execute(db, p)); mutate(db); const count = db.writes.length
    await assert.rejects(execute(db, p)); assert.equal(db.writes.length, count)
    assert.equal(db.store.get('classrooms/class-001').data.accessControl, undefined)
  }
})


test('plan rejects namespace change during enumeration and sanitizes failed page reads', async () => {
  const db = fixture(), original = db.collection.bind(db)
  let lists = 0
  db.collection = path => {
    const query = original(path), list = query.listDocuments.bind(query)
    query.listDocuments = async () => {
      if (++lists === 2) db.put('classrooms/orphan/students/1', {})
      return list()
    }
    return query
  }
  await assert.rejects(plan(db), category('inventory-incomplete')); assert.deepEqual(db.writes, [])
  const broken = fixture()
  broken.runTransaction = async () => { throw new Error('PRIVATE SDK PAGE') }
  await assert.rejects(plan(broken), error => error.category === 'rehearsal-failed' && !String(error.stack).includes('PRIVATE'))
  assert.deepEqual(broken.writes, [])
})

test('saved plan is detached before asynchronous execution and namespace drift cannot be hidden by caller mutation', async () => {
  const db = fixture(), p = JSON.parse(JSON.stringify(await plan(db))), original = db.collection.bind(db)
  let mutated = false
  db.collection = path => {
    const query = original(path), list = query.listDocuments.bind(query)
    query.listDocuments = async () => {
      if (!mutated) { mutated = true; p.rows.length = 0; p.operationId = 'different' }
      return list()
    }
    return query
  }
  const result = await execute(db, p)
  assert.equal(result.completedCount, 2)
  assert.equal(db.store.get('classrooms/class-000').data.accessControl.auditId, operationId)
})


test('missing control with any prior audit cannot restart generation1 under a new operation', async () => {
  const db = fixture()
  db.put('classrooms/class-001/accessControlAudits/onboarding', { generation: 9 })
  await assert.rejects(plan(db), category('journal-conflict')); assert.deepEqual(db.writes, [])
  const other = fixture(), p = await plan(other)
  other.put('classrooms/class-001/accessControlAudits/prior-operation', { generation: 9 })
  await assert.rejects(execute(other, p), category('journal-conflict')); assert.deepEqual(other.writes, [])
})


test('SDK contention is an explicit retryable stop without exposing SDK details', async () => {
  const db = fixture(), p = await plan(db), original = db.runTransaction
  db.runTransaction = async () => { throw Object.assign(new Error('PRIVATE LOCK DETAILS'), { code: 10 }) }
  await assert.rejects(execute(db, p), error => error.category === 'retryable-conflict' && !String(error.stack).includes('PRIVATE'))
  assert.deepEqual(db.writes, [])
  db.runTransaction = original
  assert.equal((await execute(db, p)).completedCount, 2)
})
