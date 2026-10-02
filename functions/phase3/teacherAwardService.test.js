import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { executeTeacherAwardService, teacherAwardPaths, planTeacherAwardService, executePlannedTeacherAwardService, recoverTeacherAwardService } from './teacherAwardService.js'
import { estimateMoneyDocumentBytes } from './moneyDocumentSize.js'

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
          return { exists: snapshot.has(ref.path), data: () => clone(snapshot.get(ref.path)),
            updateTime: { seconds: 1, nanoseconds: Number.parseInt(createHash('sha256').update(JSON.stringify(snapshot.get(ref.path) ?? null)).digest('hex').slice(0, 7), 16) } } },
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

// Decode independently in tests; execution compares the canonical string directly.
const receiptMapping = receipt => receipt.version === 1 ? receipt.ledgerIds :
  receipt.ledgerIds.slice('b36:1:'.length).split(',').map(pair => {
    const [targetId, ledgerId] = pair.split(':').map(value => Number.parseInt(value, 36))
    return { targetId, ledgerId }
  })
function seedGroup(f, count, historyCount = 0) {
  const ids = Array.from({ length: count }, (_, i) => i + 1)
  for (const n of ids) f.data.set(`classrooms/class-a/students/${n}`, {
    id: n, name: 'Fictional student', balance: 0, frozen: false,
    transactions: Array.from({ length: historyCount }, (_, j) => ({ id: j + 1,
      date: time, studentId: n, studentName: 'Fictional student', type: 'Add', amount: 1,
      reason: 'Homework', memo: '', category: 'Homework', status: 'Approved', source: 'Teacher' })),
  })
  return ids
}

test('one atomic batch saves exact cents, matching ledger/history and private minimal receipt', async () => {
  const f = fixture(), result = await f.run()
  const student = f.data.get('classrooms/class-a/students/1'), receipt = f.data.get(paths.receipt)
  assert.equal(student.balance, 2.2)
  assert.deepEqual(f.data.get(`classrooms/class-a/transactions/${receiptMapping(receipt)[0].ledgerId}`), student.transactions[0])
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
  const r = f.data.get(paths.receipt), item = receiptMapping(r)[0]
  r.version = 1 // Preserve replay of the earlier dormant receipt representation.
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
  const ids = seedGroup(f, 100)
  const longUid = 't'.repeat(1500), longPaths = teacherAwardPaths(classroomId, longUid, id)
  f.data.delete('teachers/teacher-a')
  f.data.set(`teachers/${longUid}`, { uid: longUid, status: 'active', classroomId })
  f.data.get('classrooms/class-a').ownerUid = longUid
  f.data.delete(paths.actor)
  f.data.set(longPaths.actor, { version: 1, actorUid: longUid, unacknowledgedRequestId: null })
  const before = clone([...f.data])
  await assert.rejects(f.run(request({ studentIds: ids }), { auth: { uid: longUid, token: { role: 'teacher' } } }), code('receipt-size-limit'))
  assert.equal(f.batches.length, 0); assert.deepEqual([...f.data], before)
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

for (const count of [3, 23, 24, 30, 100]) test(`compact receipt saves ${count} targets atomically and replays`, async () => {
  const f = fixture(), ids = seedGroup(f, count)
  const result = await f.run(request({ studentIds: ids }))
  assert.equal(result.itemCount, count); assert.equal(f.batches.length, 1)
  assert.equal(f.batches[0].length, 2 * count + 3)
  const receipt = f.data.get(paths.receipt)
  assert.equal(receipt.version, 2); assert.ok(receipt.ledgerIds.startsWith('b36:1:'))
  assert.ok(estimateMoneyDocumentBytes(paths.receipt, receipt) <= 8192)
  const mapping = receiptMapping(receipt)
  assert.deepEqual(mapping.map(item => item.targetId), ids)
  for (const n of ids) {
    const student = f.data.get(`classrooms/class-a/students/${n}`)
    assert.equal(student.balance, 1.1); assert.equal(student.transactions.length, 1)
    const ledger = mapping.find(item => item.targetId === n)
    assert.deepEqual(f.data.get(`classrooms/class-a/transactions/${ledger.ledgerId}`), student.transactions[0])
  }
  const saved = clone([...f.data]); f.reads = []
  assert.deepEqual(await f.run(request({ studentIds: ids })), result)
  assert.deepEqual([...f.data], saved); assert.equal(f.batches.length, 1)
  assert.ok(!f.reads.some(path => path.includes('/students/') || path.includes('/transactions/')))
})

test('compact receipt rejects noncanonical, corrupt, reordered and unknown-version mappings', async () => {
  for (const mutate of [r => { r.ledgerIds += ',' }, r => { r.ledgerIds = r.ledgerIds.replace('b36:1:', 'b36:2:') },
    r => { r.ledgerIds = r.ledgerIds.replace('b36:1:1:', 'b36:1:01:') }, r => { r.ledgerIds = 'b36:1:' + r.ledgerIds.slice(6).split(',').reverse().join(',') },
    r => { r.ledgerIds = [] }, r => { r.version = 3 }]) {
    const f = fixture(), ids = seedGroup(f, 3)
    await f.run(request({ studentIds: ids })); mutate(f.data.get(paths.receipt))
    const before = clone([...f.data])
    await assert.rejects(f.run(request({ studentIds: ids })), code('invalid-receipt'))
    assert.deepEqual([...f.data], before); assert.equal(f.batches.length, 1)
  }
})

test('largest safe student IDs retain their exact mapping within receipt budget', async () => {
  const f = fixture(), ids = Array.from({ length: 100 }, (_, i) => Number.MAX_SAFE_INTEGER - i)
  f.data.delete('classrooms/class-a/students/1')
  for (const n of ids) f.data.set(`classrooms/class-a/students/${n}`, { id: n, name: 'Fictional student', balance: 0, frozen: false, transactions: [] })
  await f.run(request({ studentIds: ids }))
  const receipt = f.data.get(paths.receipt)
  assert.deepEqual(receiptMapping(receipt).map(item => item.targetId), [...ids].sort((a, b) => a - b))
  assert.ok(estimateMoneyDocumentBytes(paths.receipt, receipt) <= 8192)
  for (const { targetId, ledgerId } of receiptMapping(receipt)) {
    assert.deepEqual(f.data.get(`classrooms/class-a/transactions/${ledgerId}`), f.data.get(`classrooms/class-a/students/${targetId}`).transactions[0])
  }
})

for (const [historyCount, maximum] of [[50, 54], [100, 27], [200, 14], [300, 9], [600, 4]]) {
  test(`history fixture ${historyCount}: ${maximum} fits, next target refuses all writes`, async () => {
    const f = fixture(), ids = seedGroup(f, maximum, historyCount)
    const before = clone([...f.data])
    await f.run(request({ studentIds: ids }))
    for (const n of ids) {
      const path = `classrooms/class-a/students/${n}`, student = f.data.get(path)
      assert.equal(student.balance, 1.1)
      assert.deepEqual(student.transactions.slice(1), new Map(before).get(path).transactions)
    }
    const g = fixture(), tooMany = seedGroup(g, maximum + 1, historyCount), unchanged = clone([...g.data])
    await assert.rejects(g.run(request({ studentIds: tooMany })), code('transaction-size-limit'))
    assert.deepEqual([...g.data], unchanged); assert.equal(g.batches.length, 0)
  })
}

const deps = f => ({ firestore: f.firestore, auth, projectId: 'demo-integrity', now: () => time })
const recover = (f, operation, requestId = id, extra = {}) => recoverTeacherAwardService({ protocolVersion: 1, classroomId, requestId, operation }, { ...deps(f), ...extra })

test('planner is read-only and its full-class plan executes once, including expiry-safe replay', async () => {
  const f = fixture(), ids = seedGroup(f, 30, 50), before = clone([...f.data])
  const preview = await planTeacherAwardService(request({ studentIds: ids }), deps(f))
  assert.equal(preview.selected.length, 30); assert.deepEqual(preview.notYetPlanned, [])
  assert.equal(preview.plan.expiresAt - preview.plan.createdAt, 60000)
  assert.deepEqual([...f.data], before); assert.equal(f.batches.length, 0)
  const envelope = { request: preview.request, plan: preview.plan }
  const result = await executePlannedTeacherAwardService(envelope, deps(f))
  assert.equal(result.itemCount, 30); assert.equal(f.batches.length, 1)
  assert.deepEqual(await executePlannedTeacherAwardService(envelope, { ...deps(f), now: () => '2026-09-29T19:00:00.000Z' }), result)
  assert.equal(f.batches.length, 1)
})
test('history-sized prefix preserves every remainder ID and does not fetch beyond the first excluded target', async () => {
  const f = fixture(), ids = seedGroup(f, 30, 200)
  const preview = await planTeacherAwardService(request({ studentIds: ids }), deps(f))
  assert.equal(preview.selected.length, 14); assert.deepEqual(preview.notYetPlanned, ids.slice(14))
  assert.equal(preview.reason, 'transaction-size-limit'); assert.equal(f.batches.length, 0)
  assert.ok(!f.reads.includes('classrooms/class-a/students/16'))
  await executePlannedTeacherAwardService({ request: preview.request, plan: preview.plan }, deps(f))
  for (const n of ids) assert.equal(f.data.get(`classrooms/class-a/students/${n}`).balance, n <= 14 ? 1.1 : 0)
})
test('planner handles reply trimming and single-target no-progress without writes', async () => {
  const f = fixture(), ids = seedGroup(f, 3)
  for (const n of ids) f.data.get(`classrooms/class-a/students/${n}`).name = 'x'.repeat(40000)
  const preview = await planTeacherAwardService(request({ studentIds: ids }), deps(f))
  assert.equal(preview.selected.length, 1); assert.deepEqual(preview.notYetPlanned, [2, 3])
  assert.equal(preview.reason, 'reply-size-limit'); assert.ok(JSON.stringify(preview).length < 65536)
  const g = fixture(); g.data.get('classrooms/class-a/students/1').name = 'x'.repeat(70000)
  const noProgress = await planTeacherAwardService(request(), deps(g))
  assert.equal(noProgress.plan, null); assert.deepEqual(noProgress.notYetPlanned, [1]); assert.equal(g.batches.length, 0)
  const k = fixture(); seedGroup(k, 1, 1000)
  assert.equal((await planTeacherAwardService(request(), deps(k))).reason, 'mirror-capacity')
})
test('planned execution refuses stale versions, expired/future plan, wrong tenant or altered intent with no writes', async () => {
  for (const mutate of [ (f) => { f.data.get('classrooms/class-a/students/1').balance = 5 },
    (f, p) => { p.plan.createdAt -= 60000; p.plan.expiresAt -= 60000 },
    (f, p) => { p.plan.createdAt += 1; p.plan.expiresAt += 1 },
    (f, p) => { p.plan.classroomId = 'other' }, (f, p) => { p.request.amountCents++ },
    (f, p) => { p.plan.versions = [] }]) {
    const f = fixture(), p = await planTeacherAwardService(request(), deps(f)); mutate(f, p)
    const before = clone([...f.data])
    await assert.rejects(executePlannedTeacherAwardService({ request: p.request, plan: p.plan }, deps(f)), code('stale-plan'))
    assert.deepEqual([...f.data], before); assert.equal(f.batches.length, 0)
  }
})
test('planner rebuilds each callback attempt and planned save rechecks versions on a retry', async () => {
  const f = fixture(); f.beforeCommit = data => { data.get('classrooms/class-a/students/1').balance = 5 }
  const p = await planTeacherAwardService(request(), deps(f)); assert.equal(f.attempts, 2)
  assert.equal(p.selected[0].expectedBalanceCents, 610)
  f.beforeCommit = data => { data.get('classrooms/class-a/students/1').balance = 6 }
  await assert.rejects(executePlannedTeacherAwardService({ request: p.request, plan: p.plan }, deps(f)), code('stale-plan'))
  assert.equal(f.batches.length, 0)
})
test('status absence is unconfirmed; cancellation tombstone fences execution and is idempotent', async () => {
  const f = fixture(), before = clone([...f.data])
  assert.equal((await recover(f, 'status')).status, 'unconfirmed'); assert.deepEqual([...f.data], before)
  await assert.rejects(recover(f, 'acknowledge'), code('unconfirmed-request'))
  const cancelled = await recover(f, 'cancel')
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.itemCount, 0)
  assert.deepEqual(await recover(f, 'cancel'), cancelled); assert.equal(f.data.get(paths.quota).count, 1)
  await assert.rejects(f.run(), code('request-cancelled')); assert.equal(f.batches.length, 1)
  assert.deepEqual(f.data.get('classrooms/class-a/students/1'), new Map(before).get('classrooms/class-a/students/1'))
})
test('status finds actor pointer, acknowledgment is idempotent and never clears a newer operation', async () => {
  const f = fixture(); await f.run()
  const status = await recover(f, 'status', null); assert.equal(status.requestId, id)
  for (const key of ['digest', 'ledgerIds', 'name', 'balance', 'memo']) assert.equal(Object.hasOwn(status, key), false)
  assert.equal((await recover(f, 'acknowledge')).acknowledged, true)
  assert.equal((await recover(f, 'acknowledge')).acknowledged, true)
  const newId = 'b'.repeat(32); await f.run(request({ requestId: newId }))
  await recover(f, 'acknowledge'); assert.equal(f.data.get(paths.actor).unacknowledgedRequestId, newId)
  await recover(f, 'cancel', 'c'.repeat(32)); assert.equal(f.data.get(paths.actor).unacknowledgedRequestId, newId)
  assert.equal((await recover(f, 'cancel', newId)).status, 'committed')
  assert.equal(f.data.get('classrooms/class-a/students/1').balance, 3.3)
})
test('execution and cancellation race commits exactly one terminal outcome', async () => {
  for (const cancelFirst of [false, true]) {
    const f = fixture()
    const calls = cancelFirst ? [recover(f, 'cancel'), f.run()] : [f.run(), recover(f, 'cancel')]
    await Promise.allSettled(calls)
    const receipt = f.data.get(paths.receipt)
    assert.ok(['cancelled', 'committed'].includes(receipt.status)); assert.equal(f.data.get(paths.quota).count, 1)
    assert.equal(f.batches.length, 1)
    assert.equal(f.data.get('classrooms/class-a/students/1').balance, receipt.status === 'committed' ? 2.2 : 1.1)
  }
})
test('recovery works in readOnly but rejects suspended, wrong binding, student and revoked owner', async () => {
  const f = fixture(); await f.run(); f.data.get('classrooms/class-a').accessControl.mode = 'readOnly'
  await recover(f, 'acknowledge'); await recover(f, 'cancel', 'd'.repeat(32))
  for (const mutate of [f => { f.data.get('classrooms/class-a').accessControl.mode = 'suspended' },
    f => { f.data.get('classrooms/class-a').ownerUid = 'other' }]) {
    const g = fixture(); mutate(g); await assert.rejects(recover(g, 'cancel')); assert.equal(g.batches.length, 0)
  }
  await assert.rejects(recover(f, 'status', id, { auth: { uid, token: { role: 'student' } } }))
  await assert.rejects(recoverTeacherAwardService({ protocolVersion: 1, classroomId: 'other', requestId: id, operation: 'status' }, deps(f)))
})
test('recovery validates both receipt versions, malformed mapping, metadata and quota without bypass', async () => {
  const f = fixture(); await f.run(); const receipt = f.data.get(paths.receipt)
  receipt.ledgerIds = receiptMapping(receipt); receipt.version = 1
  assert.equal((await recover(f, 'status')).status, 'committed'); await recover(f, 'acknowledge')
  for (const mutate of [r => { r.ledgerIds += ',' }, r => { r.version = 3 }, r => { r.itemCount++ }, r => { r.digest = 'bad' }]) {
    const g = fixture(); await g.run(); mutate(g.data.get(paths.receipt)); const before = clone([...g.data])
    await assert.rejects(recover(g, 'acknowledge')); assert.deepEqual([...g.data], before)
  }
  const k = fixture(); k.data.get(paths.quota).count = 100000
  await assert.rejects(recover(k, 'cancel'), code('receipt-quota-exhausted')); assert.equal(k.batches.length, 0)
  const j = fixture(); j.data.delete(paths.actor); await assert.rejects(recover(j, 'cancel')); assert.equal(j.batches.length, 0)
})

test('lost cancellation/acknowledgment response is safe to retry without changing money or quota twice', async () => {
  const f = fixture(); f.loseResponse = true
  await assert.rejects(recover(f, 'cancel'), /response loss/)
  assert.equal((await recover(f, 'cancel')).status, 'cancelled'); assert.equal(f.data.get(paths.quota).count, 1)
  const g = fixture(); await g.run(); g.loseResponse = true
  await assert.rejects(recover(g, 'acknowledge'), /response loss/)
  assert.equal((await recover(g, 'acknowledge')).acknowledged, true)
  assert.equal(g.data.get(paths.quota).count, 1); assert.equal(g.data.get('classrooms/class-a/students/1').balance, 2.2)
})
test('planner rejects pending actors and invalid authority, and cannot plan a used request ID', async () => {
  const f = fixture(); await f.run()
  await assert.rejects(planTeacherAwardService(request(), deps(f)), code('request-already-used'))
  await assert.rejects(planTeacherAwardService(request({ requestId: 'f'.repeat(32) }), deps(f)), code('acknowledgment-required'))
  const g = fixture(); g.data.get('classrooms/class-a').accessControl.mode = 'readOnly'
  await assert.rejects(planTeacherAwardService(request(), deps(g))); assert.equal(g.batches.length, 0)
  const k = fixture(); await assert.rejects(planTeacherAwardService(request(), { ...deps(k), auth: { uid: 'other' } }))
  assert.equal(k.batches.length, 0)
})
test('recovery malformed envelopes and v2 cancellation never mutate state', async () => {
  const f = fixture()
  for (const input of [{}, { protocolVersion: 1, classroomId, requestId: null, operation: 'cancel' },
    { protocolVersion: 1, classroomId, requestId: id, operation: 'acknowledge', extra: true }]) {
    await assert.rejects(recoverTeacherAwardService(input, deps(f)), code('invalid-recovery'))
  }
  f.data.set(paths.receipt, { version: 2, actorUid: uid, requestId: id, generation: 7, status: 'cancelled', serverTime: time })
  f.data.get(paths.quota).count = 1
  await assert.rejects(recover(f, 'status'), code('invalid-receipt')); assert.equal(f.batches.length, 0)
})
