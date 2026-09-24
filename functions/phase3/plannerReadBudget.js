import { TEACHER_MONEY_LIMITS } from './teacherMoneyContract.js'

export class PlannerReadBudgetError extends Error {
  constructor(code) {
    super('The planner read budget cannot be used.')
    this.name = 'PlannerReadBudgetError'
    this.code = code
  }
}

function bytes(value) {
  return Number.isSafeInteger(value) && value >= 0
}

// One instance per Firestore transaction CALLBACK ATTEMPT. This is accounting,
// not a Firestore size estimator. Trusted callers supply verified complete read
// bounds and actual conservative encoded sizes, including per-read overhead.
// Keys identify cached point-read snapshots; a repeated SDK read needs a new key.
export function createPlannerReadBudget({ limitBytes = TEACHER_MONEY_LIMITS.transactionBytes, overheadBytes } = {}) {
  if (!bytes(limitBytes) || limitBytes === 0 || limitBytes > TEACHER_MONEY_LIMITS.transactionBytes ||
      !bytes(overheadBytes) || overheadBytes > limitBytes) {
    throw new PlannerReadBudgetError('invalid-budget')
  }
  const reads = new Map()
  let consumedBytes = overheadBytes
  let reservedBytes = 0
  let failed = false

  function reject(code) {
    failed = true
    throw new PlannerReadBudgetError(code)
  }

  function requireOpen() {
    if (failed) throw new PlannerReadBudgetError('budget-aborted')
  }

  function snapshot() {
    return Object.freeze({
      limitBytes, consumedBytes, reservedBytes,
      remainingBytes: limitBytes - consumedBytes - reservedBytes,
      reads: reads.size, aborted: failed,
    })
  }

  function tryReserveGroup(dependencies) {
    requireOpen()
    if (!Array.isArray(dependencies) || dependencies.length < 1 || dependencies.length > 400) {
      reject('invalid-dependency-group')
    }
    const additions = new Map()
    for (const entry of dependencies) {
      if (!entry || Object.getPrototypeOf(entry) !== Object.prototype ||
          Reflect.ownKeys(entry).length !== 2 ||
          !Object.getOwnPropertyDescriptor(entry, 'key')?.enumerable ||
          !Object.getOwnPropertyDescriptor(entry, 'maxBytes')?.enumerable ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(entry, 'key'), 'value') ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(entry, 'maxBytes'), 'value')) {
        reject('invalid-dependency')
      }
      const { key, maxBytes } = entry
      if (typeof key !== 'string' || !key || key.length > 6144 || !bytes(maxBytes) || maxBytes === 0) {
        reject('invalid-dependency')
      }
      const existing = reads.get(key) ?? additions.get(key)
      if (existing && existing.maxBytes !== maxBytes) reject('inconsistent-read-bound')
      if (!existing) additions.set(key, { maxBytes, settled: false })
    }
    // No partial reservations on a normal capacity stop. Subtract before adding
    // to avoid overflow even if a caller supplies a very large safe integer.
    let available = limitBytes - consumedBytes - reservedBytes
    let increment = 0
    for (const { maxBytes } of additions.values()) {
      if (maxBytes > available) return false
      available -= maxBytes
      increment += maxBytes
    }
    for (const [key, entry] of additions) reads.set(key, entry)
    reservedBytes += increment
    return true
  }

  function settleRead(key, actualBytes) {
    requireOpen()
    const entry = reads.get(key)
    if (!entry || entry.settled) reject('unreserved-or-repeated-read')
    if (!bytes(actualBytes) || actualBytes > entry.maxBytes) reject('read-bound-exceeded')
    // Release only this read's unused reservation; other dependencies stay held.
    reservedBytes -= entry.maxBytes
    consumedBytes += actualBytes
    entry.settled = true
    return snapshot()
  }

  return Object.freeze({
    tryReserveGroup, settleRead, snapshot,
    abort() { failed = true },
  })
}
