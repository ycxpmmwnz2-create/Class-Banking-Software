import assert from 'node:assert/strict'
import test from 'node:test'
import { executeTeacherAwardService, teacherAwardPaths } from './teacherAwardService.js'

const clone = value => globalThis.structuredClone(value)
const uid = 'teacher-a', classroomId = 'class-a'
const auth = { uid, token: { role: 'teacher' } }
const id = '00112233445566778899aabbccddeeff'
const time = '2026-09-29T18:00:00.000Z'
const paths = teacherAwardPaths(classroomId, uid, id)
const request = (extra = {}) => ({ protocolVersion: 1, controlGeneration: 7, requestId: id,
  action: 'award', studentIds: [1], amountCents: 110, reason: 'Homework', category: 'Homework', memo: '', ...extra })
const control = (extra = {}) => ({ schemaVersion: 1, mode: 'active', generation: 7, changedAt: time, auditId: 'audit-a', ...extra })
function fixture() {
  const data = new Map(Object.entries({
    'teachers/teacher-a': { uid, status: 'active', classroomId },
    'classrooms/class-a': { ownerUid: uid, accessControl: control(), settings: { addMoneyCategories: ['Homework'], subtractMoneyCategories: ['Rent'] } },
    'classrooms/class-a/students/1': { id: 1, name: 'Fictional student', balance: 1.1, frozen: false, transactions: [] },
    [paths.actor]: { version: 1, actorUid: uid, unacknowledgedRequestId: null },
    [paths.quota]: { version: 1, count: 0 },
  }))
  let revision = 0
  const state = { data, reads: [], batches: [], beforeCommit: null, loseResponse: false, attempts: 0 }
  // An optimistic atomic fake: writes stay staged, all reads precede writes,
  // conflicts rerun the callback, and create/update preconditions are enforced.
  state.firestore = { doc: path => ({ path }), async runTransaction(callback) {
    for (let attempt = 0; attempt < 6; attempt++) {
      state.attempts++
      const start = revision, snapshot = new Map([...data].map(([k, v]) => [k, clone(v)])), writes = []
      const result = await callback({
        async get(ref) { assert.equal(writes.length, 0, 'read after write'); state.reads.push(ref.path)
          return { exists: snapshot.has(ref.path), data: () => clone(snapshot.get(ref.path)) } },
        create(ref, value) { writes.push(['create', ref.path, clone(value)]) },
        update(ref, value) { writes.push(['update', ref.path, clone(value)]) },
      })
      if (state.beforeCommit) { const hook = state.beforeCommit; state.beforeCommit = null; hook(data); revision++ }
      if (start !== revision) continue
      for (const [kind, path] of writes) assert.equal(data.has(path), kind === 'update', 'write precondition')
      for (const [, path, value] of writes) data.set(path, value)
      if (writes.length) { revision++; state.batches.push(writes) }
      if (state.loseResponse) { state.loseResponse = false; throw new Error('simulated response loss') }
      return result
    }
    throw new Error('fake contention exhausted')
  } }
  state.run = (raw = request(), extra = {}) => executeTeacherAwardService(raw, { firestore: state.firestore, auth, projectId: 'demo-integrity', now: () => time, ...extra })
  return state
}
const code = expected => error => error.code === expected

test('one atomic batch saves exact cents, matching ledger/history and private minimal receipt', async () => {
  const f = fixture(), result = await f.run()
  const student = f.data.get('classrooms/class-a/students/1'), receipt = f.data.get(paths.receipt)
  assert.equal(student.balance, 2.2)
  assert.deepEqual(f.data.get(`classrooms/class-a/transactions/${receipt.ledgerIds[0].ledgerId}`), student.transactions[0])
  assert.equal(f.batches.length, 1); assert.equal(f.batches[0].length, 5)
  assert.equal(f.data.get(paths.actor).unacknowledgedRequestId, id)
  assert.equal(f.data.get(paths.quota).count, 1)
  assert.deepEqual(Object.keys(receipt).sort(), ['version','actorUid','requestId','generation','status','serverTime','digest','action','itemCount','ledgerIds','acknowledged'].sort())
  for (const field of ['balance', 'memo', 'name', 'ledgerIds', 'digest', 'studentIds']) assert.equal(Object.hasOwn(result, field), false)
  assert.equal(result.requiresRefresh, true)
})
test('lost response followed by same-intent retry returns receipt without applying money again', async () => {
  const f = fixture(); f.loseResponse = true
  await assert.rejects(f.run(), /response loss/)
  const before = clone([...f.data]); f.reads = []
  const result = await f.run()
  assert.equal(result.status, 'committed'); assert.deepEqual([...f.data], before)
  assert.equal(f.batches.length, 1)
  assert.ok(!f.reads.some(p => p.includes('/students/') || p.includes('/transactions/')))
})
test('replay tolerates Firestore map-key order and checks exact mapping', async () => {
  const f = fixture(); await f.run()
  const r = f.data.get(paths.receipt), item = r.ledgerIds[0]
  r.ledgerIds = [{ ledgerId: item.ledgerId, targetId: item.targetId }]
  await f.run()
  r.ledgerIds[0].targetId = 2
  await assert.rejects(f.run(), code('invalid-receipt'))
})
test('same key with different intent fails; a new key is blocked until acknowledgment', async () => {
  const f = fixture(); await f.run()
  await assert.rejects(f.run(request({ amountCents: 111 })), code('request-conflict'))
  await assert.rejects(f.run(request({ requestId: 'a'.repeat(32) })), code('acknowledgment-required'))
  assert.equal(f.batches.length, 1)
})
test('concurrent identical requests commit once; distinct requests serialize on actor state', async () => {
  const f = fixture(); const results = await Promise.all([f.run(), f.run()])
  assert.deepEqual(results[0], results[1]); assert.equal(f.batches.length, 1)
  const g = fixture(); const outcomes = await Promise.allSettled([g.run(), g.run(request({ requestId: 'b'.repeat(32) }))])
  assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1)
  assert.equal(g.batches.length, 1); assert.equal(g.data.get(paths.quota).count, 1)
})
test('transaction retries use fresh balance and recheck revoked ownership/control', async () => {
  const f = fixture(); f.beforeCommit = data => { data.get('classrooms/class-a/students/1').balance = 5 }
  await f.run(); assert.equal(f.attempts, 2); assert.equal(f.data.get('classrooms/class-a/students/1').balance, 6.1)
  for (const change of [c => { c.ownerUid = 'other' }, c => { c.accessControl.mode = 'readOnly' }, c => { c.accessControl.generation++ }]) {
    const g = fixture(); g.beforeCommit = data => change(data.get('classrooms/class-a'))
    await assert.rejects(g.run()); assert.equal(g.batches.length, 0)
  }
})
test('replay permits old generation in readOnly, but suspended and foreign/student callers fail', async () => {
  const f = fixture(); await f.run()
  f.data.get('classrooms/class-a').accessControl = control({ mode: 'readOnly', generation: 8 })
  await f.run()
  f.data.get('classrooms/class-a').accessControl.mode = 'suspended'
  await assert.rejects(f.run())
  for (const bad of [{ uid, token: { role: 'student' } }, { uid: 'other' }, null]) {
    const g = fixture(); await assert.rejects(g.run(request(), { auth: bad })); assert.equal(g.batches.length, 0)
  }
})
test('cancelled tombstone fences all payloads; missing or corrupt metadata never resets', async () => {
  const f = fixture(); f.data.set(paths.receipt, { version: 1, actorUid: uid, requestId: id, generation: 7, status: 'cancelled', serverTime: time })
  await assert.rejects(f.run(), code('request-cancelled'))
  for (const path of [paths.actor, paths.quota]) {
    const g = fixture(); g.data.delete(path); await assert.rejects(g.run()); assert.equal(g.batches.length, 0)
  }
  const g = fixture(); g.data.get(paths.quota).count = -1; await assert.rejects(g.run(), code('invalid-quota'))
})
test('quota cap blocks new actions; replay still works at cap; warnings at 80/95 percent', async () => {
  const f = fixture(); f.data.get(paths.quota).count = 100000
  await assert.rejects(f.run(), code('receipt-quota-exhausted')); assert.equal(f.batches.length, 0)
  for (const [count, warning] of [[79998, null], [79999, '80-percent'], [94999, '95-percent']]) {
    const g = fixture(); g.data.get(paths.quota).count = count
    assert.equal((await g.run()).receiptCapacityWarning, warning)
    g.data.get(paths.quota).count = 100000; await g.run(); assert.equal(g.batches.length, 1)
  }
})
test('bad later target, wrong path ID, bad settings or clock stage no writes', async () => {
  const f = fixture(); await assert.rejects(f.run(request({ studentIds: [1, 2] })), code('missing-student')); assert.equal(f.batches.length, 0)
  for (const mutate of [f => { f.data.get('classrooms/class-a/students/1').id = 2 },
    f => { delete f.data.get('classrooms/class-a').settings },
    f => { f.data.get('classrooms/class-a/students/1').balance = 1.001 }]) {
    const g = fixture(); mutate(g); await assert.rejects(g.run()); assert.equal(g.batches.length, 0)
  }
  const g = fixture(); await assert.rejects(g.run(request(), { now: () => 'invalid' }), code('invalid-clock')); assert.equal(g.batches.length, 0)
})
test('deductions allow teacher overdraft/frozen accounts and use subtraction policy', async () => {
  const f = fixture(); f.data.get('classrooms/class-a/students/1').frozen = true
  await f.run(request({ action: 'deduct', amountCents: 200, reason: 'Rent', category: 'Rent' }))
  assert.equal(f.data.get('classrooms/class-a/students/1').balance, -0.9)
  const g = fixture(); await assert.rejects(g.run(request({ action: 'deduct' })), code('reason-not-allowed'))
})
test('oversized cumulative read/write and receipt budgets fail atomically', async () => {
  const f = fixture()
  const ids = Array.from({ length: 70 }, (_, i) => i + 1)
  for (const n of ids) f.data.set(`classrooms/class-a/students/${n}`, { id: n, name: 'Fictional', balance: 0, frozen: false, transactions: [] })
  await assert.rejects(f.run(request({ studentIds: ids })), code('receipt-size-limit')); assert.equal(f.batches.length, 0)
  const g = fixture()
  for (const n of ids) g.data.set(`classrooms/class-a/students/${n}`, { id: n, name: 'x'.repeat(150000), balance: 0, frozen: false, transactions: [] })
  await assert.rejects(g.run(request({ studentIds: ids })), code('transaction-size-limit'))
  assert.equal(g.batches.length, 0); assert.ok(g.reads.length < 145)
})

test('future acknowledged state permits a deliberate new request while old replay cannot clear its pointer', async () => {
  const f = fixture(); await f.run()
  // Simulate the postcondition of the separately required acknowledgment service.
  f.data.get(paths.receipt).acknowledged = true
  f.data.get(paths.actor).unacknowledgedRequestId = null
  const nextId = 'c'.repeat(32)
  await f.run(request({ requestId: nextId }))
  await f.run()
  assert.equal(f.data.get('classrooms/class-a/students/1').balance, 3.3)
  assert.equal(f.data.get(paths.actor).unacknowledgedRequestId, nextId)
  assert.equal(f.data.get(paths.quota).count, 2)
})
test('inconsistent receipt actor and counter state refuses replay without writes', async () => {
  for (const mutate of [f => { f.data.get(paths.actor).unacknowledgedRequestId = null },
    f => { f.data.get(paths.quota).count = 0 },
    f => { f.data.get(paths.receipt).actorUid = 'foreign' },
    f => { f.data.get(paths.receipt).acknowledged = true }]) {
    const f = fixture(); await f.run(); mutate(f)
    const before = clone([...f.data]); await assert.rejects(f.run())
    assert.deepEqual([...f.data], before); assert.equal(f.batches.length, 1)
  }
})

for (const count of [3, 23, 24]) test(`multi-target capacity boundary ${count}`, async () => {
  const f = fixture(), ids = Array.from({length: count}, (_, i) => i + 1)
  for (const n of ids) f.data.set(`classrooms/class-a/students/${n}`, {id:n, name:'Fictional', balance:0, frozen:false, transactions:[]})
  const before = clone([...f.data])
  if (count === 24) {
    await assert.rejects(f.run(request({studentIds:ids})), code('receipt-size-limit'))
    assert.deepEqual([...f.data], before); assert.equal(f.batches.length, 0)
  } else {
    const result = await f.run(request({studentIds:ids}))
    assert.equal(result.itemCount, count); assert.equal(f.batches.length, 1)
    assert.equal(f.batches[0].length, 2 * count + 3)
    const receipt = f.data.get(paths.receipt)
    for (const n of ids) {
      const student = f.data.get(`classrooms/class-a/students/${n}`)
      assert.equal(student.balance, 1.1); assert.equal(student.transactions.length, 1)
      const ledger = receipt.ledgerIds.find(item => item.targetId === n)
      assert.deepEqual(f.data.get(`classrooms/class-a/transactions/${ledger.ledgerId}`), student.transactions[0])
    }
    const saved = clone([...f.data]); await f.run(request({studentIds:ids}))
    assert.deepEqual([...f.data], saved); assert.equal(f.batches.length, 1)
  }
})
