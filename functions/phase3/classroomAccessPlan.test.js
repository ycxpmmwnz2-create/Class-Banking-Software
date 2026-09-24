import assert from 'node:assert/strict'
import test from 'node:test'
import { planClassroomAccessTransition } from './classroomAccessPlan.js'
import { database, documents } from '../../tests/phase3/classroomAccess.fixture.js'

const request = () => ({ operationId: '00112233445566778899aabbccddeeff', mode: 'readOnly',
  targets: [{ classroomId: 'class-a', expectedGeneration: 3 }] })
const plan = (firestore, input = request(), projectId = 'demo-access') => planClassroomAccessTransition({ firestore, projectId, request: input })

test('throwing project binding is sanitized before any database access', async () => {
  const db = database()
  let transactions = 0
  db.runTransaction = () => { transactions++; throw new Error('Unexpected database access') }
  Object.defineProperty(db, 'projectId', {
    get() { throw new Error('PRIVATE SDK INITIALIZATION DETAILS') },
  })
  await assert.rejects(plan(db), error => {
    assert.equal(error.name, 'ClassroomAccessError')
    assert.equal(error.code, 'invalid-argument')
    assert.equal(error.message, 'Classroom access is unavailable.')
    assert.equal(error.cause, undefined)
    assert.ok(!String(error.stack).includes('PRIVATE SDK'))
    return true
  })
  assert.equal(transactions, 0)
  assert.deepEqual(db.reads, [])
  assert.deepEqual(db.staged, [])
})

test('operator preview requires explicit matching project, exact scope and expected generations before reads', async () => {
  for (const projectId of [undefined, '', 'other-project', ' demo-access', 'demo/access']) {
    const db = database()
    await assert.rejects(planClassroomAccessTransition({ firestore: db, projectId, request: request() }), e => e.code === 'invalid-argument')
    assert.deepEqual(db.reads, [])
  }
  for (const overrides of [{ operationId: '' }, { mode: 'resume' }, { targets: [] },
    { targets: new Array(1) }, { targets: Array(101).fill(request().targets[0]) },
    { targets: [request().targets[0], request().targets[0]] }, { execute: true },
    { targets: [{ classroomId: 'class-a', expectedGeneration: 0 }] },
    { targets: [{ classroomId: 'class-a', expectedGeneration: Number.MAX_SAFE_INTEGER }] },
    { targets: [{ classroomId: 'a/b', expectedGeneration: 3 }] }]) {
    const db = database()
    await assert.rejects(plan(db, { ...request(), ...overrides }), e => e.code === 'invalid-argument')
    assert.deepEqual(db.reads, [])
  }
})

test('dry-run plans a generation increment without writes or classroom contents in output', async () => {
  for (const fromMode of ['active', 'readOnly', 'suspended']) {
    for (const mode of ['active', 'readOnly', 'suspended']) {
      const db = database([documents(fromMode)])
      const result = await plan(db, { ...request(), mode })
      assert.deepEqual(result.targets, [{ classroomId: 'class-a', fromMode, toMode: mode, expectedGeneration: 3, nextGeneration: 4 }])
      assert.equal(result.executable, false)
      assert.equal(result.kind, 'advisory-access-plan')
      assert.equal(result.classroomCount, 1)
      assert.ok(!JSON.stringify(result).includes('PRIVATE'))
      assert.deepEqual(db.staged, [])
      assert.ok(Object.isFrozen(result) && Object.isFrozen(result.targets) && Object.isFrozen(result.targets[0]))
    }
  }
})

test('scope digest binds project, operation, mode, IDs and expected generations; permutations are stable', async () => {
  const d = documents()
  d['teachers/teacher-b'] = { uid: 'teacher-b', status: 'active', classroomId: 'class-b' }
  d['classrooms/class-b'] = { ...globalThis.structuredClone(d['classrooms/class-a']), ownerUid: 'teacher-b' }
  const original = { ...request(), targets: [...request().targets, { classroomId: 'class-b', expectedGeneration: 3 }] }
  const result = await plan(database([d]), original)
  assert.equal((await plan(database([d]), { ...original, targets: [...original.targets].reverse() })).scopeDigest, result.scopeDigest)
  for (const input of [{ ...original, operationId: '112233445566778899aabbccddeeff00' },
    { ...original, mode: 'suspended' }, request()]) {
    assert.notEqual((await plan(database([d]), input)).scopeDigest, result.scopeDigest)
  }
  const db = database([d]); db.projectId = 'demo-other'
  assert.notEqual((await plan(db, original, 'demo-other')).scopeDigest, result.scopeDigest)
  const newer = globalThis.structuredClone(d)
  newer['classrooms/class-a'].accessControl.generation = 4
  assert.notEqual((await plan(database([newer]), { ...original, targets: [{ classroomId: 'class-a', expectedGeneration: 4 }, original.targets[1]] })).scopeDigest, result.scopeDigest)
})

test('stale generation, missing or malformed control and broken foundations refuse entire result', async () => {
  for (const mutate of [
    d => { d['classrooms/class-a'].accessControl.generation = 4 },
    d => { delete d['classrooms/class-a'].accessControl },
    d => { delete d['classrooms/class-a'] },
    d => { d['classrooms/class-a'].ownerUid = 'teacher-b' },
    d => { d['teachers/teacher-a'].status = 'disabled' },
    d => { d['teachers/teacher-a'].classroomId = 'other-class' },
  ]) {
    const d = documents(); mutate(d)
    const db = database([d])
    await assert.rejects(plan(db))
    assert.deepEqual(db.staged, [])
  }
})

test('operator callback retry observes changed control rather than returning a stale plan', async () => {
  const newer = documents(); newer['classrooms/class-a'].accessControl.generation = 4
  const db = database([documents(), newer])
  await assert.rejects(plan(db), e => e.code === 'failed-precondition')
  assert.equal(db.reads.filter(r => r.path === 'classrooms/class-a').length, 2)
  assert.deepEqual(db.staged, [])
})

test('valid earlier classroom cannot turn partial or stale scope into a successful plan', async () => {
  const db = database()
  await assert.rejects(plan(db, { ...request(), targets: [...request().targets, { classroomId: 'class-z', expectedGeneration: 3 }] }))
  assert.ok(db.reads.some(r => r.path === 'classrooms/class-a'))
  assert.ok(db.reads.some(r => r.path === 'classrooms/class-z'))
  assert.deepEqual(db.staged, [])
})
