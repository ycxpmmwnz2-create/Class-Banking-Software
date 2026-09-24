import { createHash } from 'node:crypto'
import { validateCanonicalDocumentId } from '../phase2b/identityNormalization.js'

// Dormant protocol foundations. Callers must authenticate/resolve the tenant,
// validate the action, and atomically check receipt/ledger/mirror collisions.
export const TEACHER_MONEY_PROTOCOL = 1
export const TEACHER_MONEY_LIMITS = Object.freeze({
  cents: 100_000_000,
  targets: 100,
  requestBytes: 64 * 1024,
  replyBytes: 64 * 1024,
  receiptBytes: 8 * 1024,
  studentBytes: 900 * 1024,
  transactionBytes: 8 * 1024 * 1024,
  writes: 400,
  mirrorEntries: 1000,
  receipts: 100_000,
})

const LEDGER_DOMAIN = 'morgan-bank/teacher-money-ledger'
const ACTIONS = new Set(['award', 'deduct', 'approve', 'deny', 'adjust', 'reset', 'createStudent'])
const CONTEXT_KEYS = ['action', 'classroomId', 'projectId', 'protocolVersion', 'requestId', 'teacherUid']

export class TeacherMoneyContractError extends Error {
  constructor(code) {
    super('The teacher money contract is invalid.')
    this.name = 'TeacherMoneyContractError'
    this.code = code
  }
}

function fail(code) {
  throw new TeacherMoneyContractError(code)
}

export function requireMoneyCents(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > TEACHER_MONEY_LIMITS.cents) {
    fail('amount-out-of-domain')
  }
  return value === 0 ? 0 : value
}

export function requirePositiveMoneyCents(value) {
  const cents = requireMoneyCents(value)
  if (cents <= 0) fail('amount-out-of-domain')
  return cents
}

export function storedMoneyToCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    fail('amount-out-of-domain')
  }
  const scaled = value * 100
  const rounded = Math.round(scaled)
  // The existing roster helper's tolerance is in cents, not dollars.
  if (Math.abs(scaled - rounded) > 0.0000001) fail('amount-out-of-domain')
  return requireMoneyCents(rounded)
}

export function moneyCentsToStored(value) {
  return requireMoneyCents(value) / 100
}

// UI parsing is decimal-string based. Callers choose positive-only amounts or
// signed balances afterward; whitespace, exponent notation and rounding fail.
export function parseMoneyDecimal(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(value)) {
    fail('invalid-decimal')
  }
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return requireMoneyCents(negative ? -cents : cents)
}

export function applyMoneyDelta(balanceCents, deltaCents) {
  const balance = requireMoneyCents(balanceCents)
  const delta = requireMoneyCents(deltaCents)
  return requireMoneyCents(balance + delta)
}

export function canonicalMoneyTargets(targets) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > TEACHER_MONEY_LIMITS.targets) {
    fail('invalid-targets')
  }
  // Iterate every index: sparse arrays must not silently drop an input target.
  const unique = new Set()
  for (const target of targets) {
    if (!Number.isSafeInteger(target) || target <= 0) fail('invalid-targets')
    unique.add(target)
  }
  return Object.freeze([...unique].sort((left, right) => left - right))
}

function requireContext(context) {
  if (!context || Object.getPrototypeOf(context) !== Object.prototype ||
      Reflect.ownKeys(context).length !== CONTEXT_KEYS.length ||
      !CONTEXT_KEYS.every(key => Object.getOwnPropertyDescriptor(context, key)?.value !== undefined)) {
    fail('invalid-ledger-context')
  }
  if (context.protocolVersion !== TEACHER_MONEY_PROTOCOL ||
      typeof context.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(context.requestId) ||
      !ACTIONS.has(context.action)) {
    fail('invalid-ledger-context')
  }
  try {
    for (const key of ['projectId', 'classroomId', 'teacherUid']) {
      validateCanonicalDocumentId(context[key])
    }
  } catch {
    fail('invalid-ledger-context')
  }
}

// Wire encoding: compact JSON array in this exact field order, UTF-8, no Unicode
// normalization, no BOM/newline. Child index follows ascending numeric deduped IDs.
// SHA-256's first 13 hex digits are its most-significant 52 bits (big endian).
// This is an ID namespace, NOT an intent digest or proof of authorization.
export function canonicalLedgerTuple(context, childIndex) {
  requireContext(context)
  if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex >= TEACHER_MONEY_LIMITS.targets) {
    fail('invalid-child-index')
  }
  return JSON.stringify([
    LEDGER_DOMAIN, TEACHER_MONEY_PROTOCOL, context.projectId, context.classroomId,
    context.teacherUid, context.requestId, context.action, childIndex,
  ])
}

export function deriveMoneyLedgerIds(context, targets) {
  requireContext(context)
  const ids = new Set()
  return Object.freeze(canonicalMoneyTargets(targets).map((targetId, childIndex) => {
    const digest = createHash('sha256').update(canonicalLedgerTuple(context, childIndex), 'utf8').digest('hex')
    const ledgerId = Number.parseInt(digest.slice(0, 13), 16) + 1
    if (ids.has(ledgerId)) fail('ledger-id-collision')
    ids.add(ledgerId)
    return Object.freeze({ targetId, ledgerId })
  }))
}
