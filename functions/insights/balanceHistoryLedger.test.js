import test from 'node:test'
import assert from 'node:assert/strict'
import { makeBalanceWitness, recordBalanceWitness, resolveBalanceDays, snapshotBalanceVersion, versionKey } from './balanceHistoryLedger.js'

const classroomId = 'classroom-fictional'
const birth = '2026-09-01T18:00:00Z'
const ts = iso => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 })
function snap(iso, balance, extra = {}) {
  return { exists: true, id: '1', ref: { path: `classrooms/${classroomId}/students/1` },
    createTime: ts(birth), updateTime: ts(iso), data: () => ({ id: 1, balance }), ...extra }
}
function event(before, after) { return { params: { classroomId, studentId: '1' }, data: { before, after } } }
const friday = snap('2026-09-04T17:00:00Z', -10)
const reset = snap('2026-09-08T17:00:00Z', 0)
const options = { classroomId, dates: ['2026-09-04', '2026-09-07', '2026-09-08'], timeZone: 'America/Denver' }
const resolve = (current, records, more = {}) => resolveBalanceDays(snapshotBalanceVersion(current), records, { ...options, ...more })

test('dated server reset preserves Friday negative without relying on a transaction', () => {
  assert.deepEqual(resolve(reset, [makeBalanceWitness(event(friday, reset))]), {
    '2026-09-08': 0, '2026-09-07': -10, '2026-09-04': -10,
  })
})
test('undelivered reset event gives unavailable past instead of today zero', () => {
  assert.deepEqual(resolve(reset, []), { '2026-09-08': 0 })
})
test('out-of-order events connect; a missing intermediate version stays unavailable', () => {
  const renamed = snap('2026-09-07T17:00:00Z', -10)
  const first = makeBalanceWitness(event(friday, renamed))
  const second = makeBalanceWitness(event(renamed, reset))
  assert.equal(resolve(reset, [second, first])['2026-09-04'], -10)
  assert.equal(resolve(reset, [first, second])['2026-09-04'], -10)
  assert.equal(resolve(reset, [second])['2026-09-04'], undefined)
  assert.equal(resolve(reset, [second])['2026-09-07'], -10)
})
test('an unchanged current document proves dates since its last write, not earlier dates', () => {
  assert.deepEqual(resolve(friday, []), { '2026-09-08': -10, '2026-09-07': -10, '2026-09-04': -10 })
  assert.deepEqual(resolve(friday, [], { dates: ['2026-09-03'] }), {})
})
test('old silent reset cannot be repaired by a later witnessed rename', () => {
  const renamed = snap('2026-09-09T17:00:00Z', 0)
  assert.equal(resolve(renamed, [makeBalanceWitness(event(reset, renamed))])['2026-09-04'], undefined)
})
test('foreign classroom, student and incarnation witnesses cannot bridge gaps', () => {
  const witness = makeBalanceWitness(event(friday, reset))
  for (const patch of [{ classroomId: 'other' }, { studentId: '2' }, { incarnation: versionKey(ts('2026-08-01T00:00:00Z')) }]) {
    assert.equal(resolve(reset, [{ ...witness, ...patch }])['2026-09-04'], undefined)
  }
})
test('mismatched balance, invalid timestamp, cycles and duplicate witnesses fail closed', () => {
  const witness = makeBalanceWitness(event(friday, reset))
  for (const patch of [{ afterBalance: 50 }, { beforeBalance: null }, { beforeVersion: witness.afterVersion }, { beforeVersion: 'bad' }]) {
    assert.equal(resolve(reset, [{ ...witness, ...patch }])['2026-09-04'], undefined)
  }
  assert.deepEqual(resolve(reset, [witness, witness]), {})
  assert.deepEqual(resolve(reset, [], { dates: ['2026-09-04'] }), {})
})
test('creation does not invent a zero before a student existed; deletion writes nothing', () => {
  const created = snap(birth, 20)
  const witness = makeBalanceWitness(event({ exists: false }, created))
  assert.equal(witness.beforeBalance, null)
  assert.deepEqual(resolve(created, [witness], { dates: ['2026-08-31'] }), {})
  assert.equal(makeBalanceWitness(event(created, { exists: false })), null)
})
test('local midnight and daylight-saving dates use Firestore time, with nanosecond precision in version linkage', () => {
  const before = snap('2026-09-05T05:59:59Z', -10)
  before.updateTime.nanoseconds = 999999999
  const after = snap('2026-09-05T06:00:00Z', 0)
  assert.equal(resolve(after, [makeBalanceWitness(event(before, after))])['2026-09-04'], -10)
  const springBefore = snap('2026-03-09T05:59:59Z', -7, { createTime: ts('2026-01-01T00:00:00Z') })
  const springAfter = snap('2026-03-09T06:00:00Z', 4, { createTime: ts('2026-01-01T00:00:00Z') })
  assert.equal(resolve(springAfter, [makeBalanceWitness(event(springBefore, springAfter))], { dates: ['2026-03-08'] })['2026-03-08'], -7)
})
test('writer rejects mismatched path, body identity and malformed metadata', () => {
  for (const after of [snap('2026-09-08T17:00:00Z', 0, { ref: { path: 'classrooms/other/students/1' } }),
    snap('2026-09-08T17:00:00Z', 0, { data: () => ({ id: 2, balance: 0 }) }),
    snap('2026-09-08T17:00:00Z', 0, { updateTime: { seconds: 1, nanoseconds: 1e9 } })]) {
    assert.throws(() => makeBalanceWitness(event(friday, after)), /Balance-history|balance-history/u)
  }
})
test('create-only writer is idempotent, contains no names, and never writes student data', async () => {
  const store = new Map()
  const firestore = { collection: name => ({ doc: id => ({ collection: sub => ({ doc: key => {
    const path = `${name}/${id}/${sub}/${key}`
    return { create: async value => { if (store.has(path)) throw { code: 6 }; store.set(path, value) },
      get: async () => ({ data: () => store.get(path) }) }
  } }) }) }) }
  await recordBalanceWitness(event(friday, reset), { firestore })
  await recordBalanceWitness(event(friday, reset), { firestore })
  assert.equal(store.size, 1)
  assert.match([...store.keys()][0], /\/balanceHistory\//u)
  const record = [...store.values()][0]
  assert.deepEqual(Object.keys(record).sort(), ['afterBalance', 'afterVersion', 'beforeBalance', 'beforeVersion', 'classroomId', 'incarnation', 'schemaVersion', 'studentId'])
  record.beforeBalance = 999
  const warnings = []
  await recordBalanceWitness(event(friday, reset), { firestore, warn: (...args) => warnings.push(args) })
  assert.deepEqual(warnings, [['Balance-history event skipped.', { reason: 'witness-conflict' }]])
  assert.equal(record.beforeBalance, 999)
  assert.equal(store.size, 1)
})
