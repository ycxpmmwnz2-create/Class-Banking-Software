import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlannerReadBudget, PlannerReadBudgetError } from './plannerReadBudget.js'

const MiB = 1024 * 1024
const KiB = 1024
const dep = (key, maxBytes) => ({ key, maxBytes })
function rejects(fn, code) {
  assert.throws(fn, error => error instanceof PlannerReadBudgetError && error.code === code)
}

test('budget configuration requires explicit overhead and bounded safe integer bytes', () => {
  for (const options of [undefined, {}, { overheadBytes: -1 }, { overheadBytes: 1, limitBytes: 0 },
    { overheadBytes: 0, limitBytes: 8 * MiB + 1 }, { overheadBytes: NaN },
    { overheadBytes: 2, limitBytes: 1 }, { overheadBytes: 0.1 }]) {
    rejects(() => createPlannerReadBudget(options), 'invalid-budget')
  }
  assert.equal(createPlannerReadBudget({ overheadBytes: 8 * MiB }).snapshot().remainingBytes, 0)
})

test('whole dependency group is reserved atomically before any read', () => {
  const budget = createPlannerReadBudget({ limitBytes: 100, overheadBytes: 10 })
  const initial = budget.snapshot()
  assert.equal(budget.tryReserveGroup([dep('root', 40), dep('student', 51)]), false)
  assert.deepEqual(budget.snapshot(), initial)
  assert.equal(budget.tryReserveGroup([dep('root', 40), dep('student', 50)]), true)
  assert.equal(budget.snapshot().remainingBytes, 0)
  assert.equal(budget.snapshot().reservedBytes, 90)
})

test('settling one read releases only its excess, preserving unread dependencies', () => {
  const budget = createPlannerReadBudget({ limitBytes: 100, overheadBytes: 10 })
  assert.equal(budget.tryReserveGroup([dep('root', 40), dep('student', 40)]), true)
  assert.deepEqual(budget.settleRead('root', 5), {
    limitBytes: 100, consumedBytes: 15, reservedBytes: 40, remainingBytes: 45, reads: 2, aborted: false,
  })
  assert.equal(budget.tryReserveGroup([dep('other', 46)]), false)
  assert.equal(budget.tryReserveGroup([dep('other', 45)]), true)
  budget.settleRead('student', 40)
  budget.settleRead('other', 45)
  assert.equal(budget.snapshot().consumedBytes, 100)
  assert.equal(budget.snapshot().reservedBytes, 0)
})

test('30 small documents remain one prefix after worst-case reservations are released', () => {
  const budget = createPlannerReadBudget({ overheadBytes: 64 * KiB })
  const prefix = []
  // These are synthetic accounting fixtures, NOT verified Firestore byte sizes.
  for (let i = 0; i < 30; i += 1) {
    if (!budget.tryReserveGroup([dep('root', MiB), dep(`student-${i}`, MiB)])) break
    if (i === 0) budget.settleRead('root', 4 * KiB)
    budget.settleRead(`student-${i}`, 15 * KiB)
    prefix.push(i)
  }
  assert.equal(prefix.length, 30)
  assert.equal(budget.snapshot().consumedBytes, (64 + 4 + 30 * 15) * KiB)
  assert.equal(budget.snapshot().reservedBytes, 0)
})

test('large target group stops before fetch and produces the complete remainder', () => {
  const budget = createPlannerReadBudget({ limitBytes: 100, overheadBytes: 10 })
  const targets = [1, 2, 3, 4]
  const fetched = []
  const prefix = []
  for (const id of targets) {
    if (!budget.tryReserveGroup([dep('root', 10), dep(`student-${id}`, 30), dep(`ledger-${id}`, 10)])) break
    // A caller can reach this read seam ONLY once the COMPLETE group fits.
    fetched.push(id)
    if (id === 1) budget.settleRead('root', 10)
    budget.settleRead(`student-${id}`, 30)
    budget.settleRead(`ledger-${id}`, 10)
    prefix.push(id)
  }
  assert.deepEqual(fetched, [1, 2])
  assert.deepEqual(prefix, [1, 2])
  assert.deepEqual(targets.slice(prefix.length), [3, 4])
  assert.equal(budget.snapshot().consumedBytes, 100)
})

test('oversized first target reserves nothing and cannot cause an accidental first read', () => {
  const budget = createPlannerReadBudget({ limitBytes: 100, overheadBytes: 10 })
  assert.equal(budget.tryReserveGroup([dep('student', Number.MAX_SAFE_INTEGER)]), false)
  assert.equal(budget.snapshot().reads, 0)
  assert.equal(budget.snapshot().reservedBytes, 0)
})

test('cached dependency is counted once, including duplicate entries within a group', () => {
  const budget = createPlannerReadBudget({ limitBytes: 100, overheadBytes: 0 })
  assert.equal(budget.tryReserveGroup([dep('root', 50), dep('root', 50)]), true)
  assert.equal(budget.snapshot().reservedBytes, 50)
  budget.settleRead('root', 10)
  const before = budget.snapshot()
  assert.equal(budget.tryReserveGroup([dep('root', 50)]), true)
  assert.deepEqual(budget.snapshot(), before)
})

test('changed bounds cannot reinterpret existing reservations or settled reads', () => {
  for (const settle of [false, true]) {
    const budget = createPlannerReadBudget({ limitBytes: 100, overheadBytes: 0 })
    budget.tryReserveGroup([dep('root', 50)])
    if (settle) budget.settleRead('root', 10)
    rejects(() => budget.tryReserveGroup([dep('root', 10)]), 'inconsistent-read-bound')
    rejects(() => budget.tryReserveGroup([dep('other', 1)]), 'budget-aborted')
  }
})

test('underestimated sizes, repeat settlement and unreserved reads poison the attempt', () => {
  for (const act of [b => b.settleRead('root', 51), b => b.settleRead('other', 1),
    b => b.settleRead('root', -1), b => b.settleRead('root', NaN),
    b => { b.settleRead('root', 10); b.settleRead('root', 10) }]) {
    const budget = createPlannerReadBudget({ limitBytes: 100, overheadBytes: 0 })
    budget.tryReserveGroup([dep('root', 50)])
    assert.throws(() => act(budget), PlannerReadBudgetError)
    assert.equal(budget.snapshot().aborted, true)
    rejects(() => budget.tryReserveGroup([dep('next', 1)]), 'budget-aborted')
    rejects(() => budget.settleRead('root', 1), 'budget-aborted')
  }
})

test('invalid dependency groups fail closed without evaluating getters', () => {
  for (const group of [[], [undefined], [dep('', 1)], [dep('a', 0)], [dep('a', Infinity)],
    [{ key: 'a', maxBytes: 1, extra: true }], [dep('a', 2), dep('a', 3)],
    [{ get key() { throw new Error('getter invoked') }, maxBytes: 1 }]]) {
    const budget = createPlannerReadBudget({ overheadBytes: 0 })
    assert.throws(() => budget.tryReserveGroup(group), PlannerReadBudgetError)
    assert.equal(budget.snapshot().reads, 0)
    assert.equal(budget.snapshot().aborted, true)
  }
})

test('fresh callback attempts do not inherit actual or reserved consumption', () => {
  const first = createPlannerReadBudget({ limitBytes: 100, overheadBytes: 10 })
  first.tryReserveGroup([dep('root', 60)])
  first.settleRead('root', 50)
  first.abort()
  const retry = createPlannerReadBudget({ limitBytes: 100, overheadBytes: 10 })
  assert.equal(retry.tryReserveGroup([dep('root', 60)]), true)
  retry.settleRead('root', 20)
  assert.equal(retry.snapshot().consumedBytes, 30)
  assert.equal(first.snapshot().consumedBytes, 60)
  rejects(() => first.tryReserveGroup([dep('x', 1)]), 'budget-aborted')
})

test('snapshots cannot mutate internal accounting and reveal no dependency names', () => {
  const budget = createPlannerReadBudget({ limitBytes: 10, overheadBytes: 1 })
  budget.tryReserveGroup([dep('synthetic-private-path', 3)])
  const snapshot = budget.snapshot()
  assert.ok(Object.isFrozen(snapshot))
  assert.throws(() => { snapshot.reservedBytes = 0 }, TypeError)
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-private-path/)
  assert.equal(budget.snapshot().reservedBytes, 3)
})
