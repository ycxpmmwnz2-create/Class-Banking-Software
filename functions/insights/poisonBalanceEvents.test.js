import test from 'node:test'
import assert from 'node:assert/strict'
import { recordBalanceWitness } from './balanceHistoryLedger.js'

const stamp = seconds => ({ seconds, nanoseconds: 0 })
const snapshot = (seconds, balance, extra = {}) => ({
  exists: true, id: '1', ref: { path: 'classrooms/fictional/students/1' },
  createTime: stamp(10), updateTime: stamp(seconds), data: () => ({ id: 1, balance }), ...extra,
})
const before = snapshot(20, -10)
const after = snapshot(30, 0)
const event = (prior = before, next = after) => ({
  params: { classroomId: 'fictional', studentId: '1' }, data: { before: prior, after: next },
})
const db = ref => ({ collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }) })

for (const [label, input, reason] of [
  ['legacy identity', { ...event(), params: { classroomId: 'morgan', studentId: 'legacy-student' } }, 'invalid-identity'],
  ['foreign path', event(before, snapshot(30, 0, { ref: { path: 'classrooms/private/students/1' } })), 'path-mismatch'],
  ['body identity', event(before, snapshot(30, 0, { data: () => ({ id: 2, balance: 0, name: 'Private name' }) })), 'invalid-state'],
  ['malformed timestamp', event(before, snapshot(30, 0, { updateTime: stamp(-1) })), 'invalid-state'],
  ['invalid balance', event(before, snapshot(30, Infinity)), 'invalid-state'],
  ['reversed versions', event(after, before), 'invalid-state'],
  ['equal-version no-op', event(before, before), 'invalid-state'],
  ['equal-version disagreement', event(before, snapshot(20, 7)), 'invalid-state'],
]) {
  test(`permanent ${label} is acknowledged without database access or private logs`, async () => {
    const warnings = []
    await recordBalanceWitness(input, {
      firestore: { collection() { assert.fail('Invalid events must not access Firestore') } },
      warn: (...args) => warnings.push(args),
    })
    assert.deepEqual(warnings, [['Balance-history event skipped.', { reason }]])
  })
}

test('conflicting duplicate keeps the first witness and acknowledges with a redacted warning', async () => {
  let stored
  let creates = 0
  const warnings = []
  const firestore = db({
    async create(value) {
      creates++
      if (stored) throw { code: 6, message: 'private database details' }
      stored = { ...value }
    },
    async get() { return { data: () => stored } },
  })
  await recordBalanceWitness(event(), { firestore })
  const original = { ...stored }
  await recordBalanceWitness(event(snapshot(20, -99)), { firestore, warn: (...args) => warnings.push(args) })
  assert.equal(creates, 2)
  assert.deepEqual(stored, original)
  assert.deepEqual(warnings, [['Balance-history event skipped.', { reason: 'witness-conflict' }]])
})

for (const stage of ['create', 'duplicate-read']) {
  test(`${stage} database failure remains retryable, then retry completes without duplicates`, async () => {
    const failure = Object.assign(new Error('temporary failure'), { code: 14 })
    let stored, failOnce = true
    const firestore = db({
      async create(value) {
        if (stage === 'create' && failOnce) { failOnce = false; throw failure }
        if (stored) throw { code: 'already-exists' }
        stored = { ...value }
      },
      async get() {
        if (failOnce) { failOnce = false; throw failure }
        return { data: () => stored }
      },
    })
    const options = { firestore, warn() { assert.fail('Database failures must not be swallowed') } }
    if (stage === 'duplicate-read') await recordBalanceWitness(event(), options)
    await assert.rejects(recordBalanceWitness(event(), options), error => error === failure)
    await recordBalanceWitness(event(), options)
    const original = { ...stored }
    await recordBalanceWitness(event(), options)
    assert.deepEqual(stored, original)
  })
}

test('unexpected errors are not mistaken for permanent validation failures', async () => {
  const failure = new Error('Invalid balance-history event state.')
  const input = event(before, snapshot(30, 0, { data() { throw failure } }))
  await assert.rejects(recordBalanceWitness(input, {
    firestore: {}, warn() { assert.fail('Unexpected errors must surface') },
  }), error => error === failure)
})
