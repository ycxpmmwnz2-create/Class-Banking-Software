import assert from 'node:assert/strict'
import test from 'node:test'
import { teacherAwardFixture } from '../../tests/phase3/teacherAward.fixture.js'
import { executeTeacherAwardService, planTeacherAwardService, executePlannedTeacherAwardService,
  recoverTeacherAwardService } from './teacherAwardService.js'
import { executeTeacherMoneyCallable } from './teacherMoneyCallables.js'

const copy = value => globalThis.structuredClone(value)
const code = value => error => error.code === value
function fixture() {
  const f = teacherAwardFixture()
  f.request = extra => ({ protocolVersion: 1, controlGeneration: 7,
    requestId: '00112233445566778899aabbccddeeff', action: 'approve', transactionIds: [11], allowNegative: false, ...extra })
  f.seed = (id = 11, studentId = 1, extra = {}) => {
    const row = { id, studentId, studentName: 'Recorded former name', date: '2026-09-01T00:00:00.000Z',
      type: 'Add', amount: 2.35, status: 'Pending', source: 'Student', reason: 'Homework', category: '', memo: '', ...extra }
    f.student(studentId).transactions.push(copy(row))
    f.data.set(`classrooms/class-a/transactions/${id}`, row)
    return row
  }
  f.run = request => executeTeacherAwardService(request ?? f.request(), f.dependencies)
  f.plan = request => planTeacherAwardService(request ?? f.request(), f.dependencies)
  f.execute = preview => executePlannedTeacherAwardService({ request: preview.request, plan: preview.plan }, f.dependencies)
  f.adjust = (adjustments = [{ studentId: 1, expectedCents: 2000, targetCents: 100 }], action = 'adjust') => ({
    protocolVersion: 1, controlGeneration: 7, requestId: f.request().requestId, action, adjustments })
  f.recover = (operation, requestId = f.request().requestId) => recoverTeacherAwardService({
    protocolVersion: 1, classroomId: 'class-a', requestId, operation }, f.dependencies)
  return f
}

test('approve multiple pending records for one student atomically; preserve historical date/name and mirror order', async () => {
  const f = fixture(); const a = f.seed(), b = f.seed(12, 1, { type: 'Subtract', amount: 1.15 })
  const preview = await f.plan(f.request({ transactionIds: [12, 11] }))
  assert.equal(f.commits.length, 0); assert.deepEqual(preview.notYetPlanned, [])
  assert.equal(preview.selected.length, 1); assert.equal(preview.selected[0].expectedBalanceCents, 2120)
  await f.execute(preview)
  assert.equal(f.student(1).balance, 21.2); assert.equal(f.commits.length, 1)
  assert.deepEqual(f.student(1).transactions, [a, b].map(row => ({ ...row, status: 'Approved' })))
  for (const row of f.student(1).transactions) assert.deepEqual(row, f.data.get(`classrooms/class-a/transactions/${row.id}`))
  assert.equal(f.data.get(f.paths.actor).unacknowledgedRequestId, f.request().requestId)
  assert.equal(f.data.get(f.paths.quota).count, 1)
})
test('deny changes status and mirror only; frozen teacher target remains eligible', async () => {
  const f = fixture(); f.seed(); f.student(1).frozen = true
  await f.run(f.request({ action: 'deny' }))
  assert.equal(f.student(1).balance, 20); assert.equal(f.student(1).transactions[0].status, 'Denied')
  assert.equal((await f.recover('status')).action, 'deny')
})
test('negative approval requires explicit bound consent and changed consent is a different intent', async () => {
  const f = fixture(); f.seed(11, 1, { type: 'Subtract', amount: 21 })
  await assert.rejects(f.run(), code('negative-confirmation-required')); assert.equal(f.commits.length, 0)
  await f.run(f.request({ allowNegative: true })); assert.equal(f.student(1).balance, -1)
  await assert.rejects(f.run(), code('request-conflict'))
})
test('missing, decided, malformed, foreign and mismatched pending records reject the whole group without writes', async () => {
  for (const corrupt of [
    f => f.data.delete('classrooms/class-a/transactions/12'),
    f => { f.data.get('classrooms/class-a/transactions/12').status = 'Approved' },
    f => { f.data.get('classrooms/class-a/transactions/12').studentId = 99 },
    f => { f.data.get('classrooms/class-a/transactions/12').memo = 'different' },
    f => { f.data.get('classrooms/class-a/transactions/12').amount = 0.001; f.student(2).transactions[0].amount = 0.001 },
  ]) {
    const f = fixture(); f.seed(); f.seed(12, 2); corrupt(f); const before = copy([...f.data])
    await assert.rejects(f.run(f.request({ transactionIds: [11, 12] })))
    assert.deepEqual([...f.data], before); assert.equal(f.commits.length, 0)
  }
})
test('duplicate IDs, empty/oversized selections and smuggled fields never become a smaller group', async () => {
  for (const request of [{ transactionIds: [11, 11] }, { transactionIds: [] },
    { transactionIds: Array.from({ length: 101 }, (_, i) => i + 1) }, { balance: 99 }, { allowNegative: 'yes' }]) {
    const f = fixture(); f.seed(); await assert.rejects(f.run(f.request(request))); assert.equal(f.commits.length, 0)
  }
})
test('stale approval preview and changed pending status refuse all writes', async () => {
  const f = fixture(); f.seed(); const preview = await f.plan(); f.student(1).balance = 21
  await assert.rejects(f.execute(preview), code('stale-plan')); assert.equal(f.commits.length, 0)
  const reply = await executeTeacherMoneyCallable({ auth: f.dependencies.auth,
    data: { request: preview.request, plan: preview.plan } }, f.dependencies)
  assert.equal(reply.status, 'rejected'); assert.equal(reply.wroteNothing, true)
  f.data.get('classrooms/class-a/transactions/11').status = 'Denied'
  await assert.rejects(f.execute(preview), code('pending-conflict')); assert.equal(f.commits.length, 0)
})
test('concurrent approve versus deny yields exactly one winner', async () => {
  const f = fixture(); f.seed()
  const result = await Promise.allSettled([f.run(), f.run(f.request({ action: 'deny', requestId: '1'.repeat(32) }))])
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(f.commits.length, 1); assert.equal(f.data.get(f.paths.quota).count, 1)
})
test('adjust and reset store exact before/after explanation with matching immutable ledger and mirror', async () => {
  for (const action of ['adjust', 'reset']) {
    const f = fixture(); const old = f.seed(); const targetCents = action === 'reset' ? 0 : -235
    const request = f.adjust([{ studentId: 1, expectedCents: 2000, targetCents }], action)
    const preview = await f.plan(request); await f.execute(preview)
    assert.equal(f.student(1).balance, targetCents / 100)
    const entry = f.student(1).transactions[0]
    assert.equal(entry.category, 'Balance adjustment'); assert.equal(entry.amount, (2000 - targetCents) / 100)
    assert.match(entry.memo, /Balance changed from 20.00 to/)
    assert.deepEqual(f.student(1).transactions[1], old)
    assert.deepEqual(entry, f.data.get(`classrooms/class-a/transactions/${entry.id}`))
    assert.equal((await f.recover('status')).action, action)
    await f.recover('acknowledge'); assert.equal(f.data.get(f.paths.actor).unacknowledgedRequestId, null)
  }
})
test('stale reset expected balance, unsafe deltas, duplicate targets and zero-delta requests reject with no writes', async () => {
  for (const rows of [[{ studentId: 1, expectedCents: 1999, targetCents: 0 }],
    [{ studentId: 1, expectedCents: 2000, targetCents: 2000 }],
    [{ studentId: 1, expectedCents: 100000000, targetCents: -100000000 }],
    [{ studentId: 1, expectedCents: 2000, targetCents: 0 }, { studentId: 1, expectedCents: 2000, targetCents: 0 }]]) {
    const f = fixture(); await assert.rejects(f.run(f.adjust(rows))); assert.equal(f.commits.length, 0)
  }
})
test('lost decision/adjustment responses recover once; replay needs no mutable money reads and cannot change intent', async () => {
  for (const action of ['approve', 'deny', 'adjust', 'reset']) {
    const f = fixture(); f.seed()
    const request = ['approve', 'deny'].includes(action) ? f.request({ action }) : f.adjust([{ studentId: 1, expectedCents: 2000, targetCents: 0 }], action)
    f.loseResponse = true; await assert.rejects(f.run(request), /lost SDK/)
    const before = copy([...f.data]); f.reads.length = 0
    assert.equal((await f.run(request)).status, 'committed'); assert.deepEqual([...f.data], before)
    assert.ok(!f.reads.some(path => path.includes('/students/') || path.includes('/transactions/')))
    assert.equal((await f.recover('status')).action, action)
    await f.recover('acknowledge'); assert.equal(f.data.get(f.paths.actor).unacknowledgedRequestId, null)
  }
})
test('cancel tombstone fences every new action at the same key', async () => {
  const f = fixture(); f.seed(); await f.recover('cancel')
  for (const request of [f.request(), f.request({ action: 'deny' }), f.adjust()]) await assert.rejects(f.run(request), code('request-cancelled'))
  assert.equal(f.student(1).balance, 20); assert.equal(f.commits.length, 1)
})
test('transaction retries recheck owner, active mode, generation, pending set and expected balance', async () => {
  for (const mutate of [
    data => { data.get('classrooms/class-a').ownerUid = 'other' },
    data => { data.get('classrooms/class-a').accessControl.mode = 'readOnly' },
    data => { data.get('classrooms/class-a').accessControl.generation++ },
    data => { data.get('classrooms/class-a/transactions/11').status = 'Denied' },
  ]) {
    const f = fixture(); f.seed(); f.beforeCommit = mutate
    await assert.rejects(f.run()); assert.equal(f.commits.length, 0); assert.equal(f.student(1).balance, 20)
  }
  const f = fixture(); f.beforeCommit = data => { data.get('classrooms/class-a/students/1').balance = 21 }
  await assert.rejects(f.run(f.adjust()), code('balance-conflict')); assert.equal(f.commits.length, 0)
})
