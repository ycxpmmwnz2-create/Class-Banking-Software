import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'

export const DEMO_PROJECT = 'demo-morgan-bank-protected-scan'
export const LIMITS = Object.freeze({ classrooms: 100, documents: 20000, findings: 100000,
  pageSize: 25, inputBytes: 64 * 1024 * 1024, reportBytes: 32 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024, runMs: 15 * 60 * 1000, authorizationMs: 30 * 60 * 1000 })
export const ABORTS = Object.freeze(['live-unavailable', 'invalid-plan', 'authorization', 'expired',
  'clock', 'scope', 'foundation', 'transport', 'budget', 'drift', 'continuity', 'storage'])
export class ScanAbort extends Error {
  constructor(category) { super('Protected money scan aborted.'); this.name = 'ScanAbort'; this.category = ABORTS.includes(category) ? category : 'transport' }
}
export function fail(category) { throw new ScanAbort(category) }
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
export const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function exact(value, keys) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable && Object.hasOwn(d, 'value')
    })
}
export function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
// Bounded detached data, never invoke arbitrary getters/toJSON. Timestamp is the
// sole SDK value supported; unsupported types abort, not silently stringified.
export function copyData(value, budget = { bytes: 0, nodes: 0 }, depth = 0, seen = new Set()) {
  if (++budget.nodes > 1000000 || depth > 32) fail('budget')
  budget.bytes += 16
  if (budget.bytes > LIMITS.inputBytes) fail('budget')
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8') * 2
    if (budget.bytes > LIMITS.inputBytes) fail('budget')
    return value
  }
  if (value instanceof Timestamp) return Object.freeze(new Timestamp(value.seconds, value.nanoseconds))
  if (!value || typeof value !== 'object' || seen.has(value)) fail('transport')
  seen.add(value)
  let result
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) fail('transport')
    result = []
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i))
      if (!d || !Object.hasOwn(d, 'value')) fail('transport')
      result.push(copyData(d.value, budget, depth + 1, seen))
    }
  } else {
    const keys = Object.keys(value)
    if (!exact(value, keys)) fail('transport')
    result = {}
    for (const key of keys) {
      budget.bytes += Buffer.byteLength(key, 'utf8') * 2
      Object.defineProperty(result, key, { value: copyData(value[key], budget, depth + 1, seen), enumerable: true })
    }
  }
  seen.delete(value)
  return result
}
export function timestamp(value) {
  if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0]) || value[0] < 0 ||
      value[0] > 253402300799 || !Number.isInteger(value[1]) || value[1] < 0 || value[1] >= 1e9) fail('transport')
  return [value[0], value[1]]
}
export function abortSummary(error, publicationAttempted = false) {
  return Object.freeze({ status: 'aborted', category: error instanceof ScanAbort ? error.category : 'transport',
    publication: publicationAttempted ? 'unconfirmed' : 'not-attempted', initializationAllowed: false, activationAllowed: false })
}
