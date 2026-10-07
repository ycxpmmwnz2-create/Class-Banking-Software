import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
export const DEMO_PROJECT = 'demo-morgan-bank-cutover-qualification'
export const LIMITS = Object.freeze({ page: 25, rooms: 100, documents: 20000, reads: 40000,
  responseBytes: 8 * 1024 * 1024, wireBytes: 64 * 1024 * 1024, reportBytes: 32 * 1024 * 1024, durationMs: 15 * 60 * 1000 })
export const RESERVATION_MASK = Object.freeze(['schemaVersion', 'scopeDigest', 'ledgerId',
  'rateLimitLedgerId', 'requestIdDigest', 'monthKey', 'status', 'reservedAtMs', 'controlGeneration'])
export const DISPATCH_MASK = Object.freeze(['schemaVersion', 'reservationId', 'requestIdDigest',
  'scopeDigest', 'controlGeneration', 'dispatchIndex', 'status', 'claimedAtMs', 'finishedAtMs', 'outcome'])
export const ROOT_MASK = Object.freeze(['ownerUid', 'classroomId', 'accessControl'])
export const OWNER_MASK = Object.freeze(['uid', 'status', 'classroomId'])
const CATEGORIES = new Set(['live-unavailable', 'scope', 'transport', 'budget', 'expired', 'drift', 'foundation'])
export class QualificationError extends Error {
  constructor(category) { super('Cutover qualification unavailable.'); this.category = CATEGORIES.has(category) ? category : 'transport' }
}
export const fail = category => { throw new QualificationError(category) }
export function demo(projectId) { if (projectId !== DEMO_PROJECT) fail('live-unavailable') }
export const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const hash = value => createHash('sha256').update(value).digest('hex')
export const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
export const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
export const natural = value => Number.isSafeInteger(value) && value >= 0
export const positive = value => natural(value) && value > 0
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
export const version = value => Array.isArray(value) && value.length === 2 &&
  natural(value[0]) && natural(value[1]) && value[1] < 1e9
export function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}
