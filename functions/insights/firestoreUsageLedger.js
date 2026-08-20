import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import {
  GEMINI_MONTHLY_ALLOWANCE_MICRO_USD,
  insightModeProfile,
  utcMonthKey,
} from './costPolicy.js'
import { InsightIdentityError, validateInsightIdentity } from './identity.js'

const APPLICATION_LEDGER_COLLECTION = 'insightUsageLedgers'
const RATE_LIMIT_COLLECTION = 'insightUsageRateLimits'
const RESERVATION_COLLECTION = 'insightUsageReservations'
const SCHEMA_VERSION = 3
const ROLLING_HOUR_MS = 60 * 60 * 1000
const MAX_RESULT_BYTES = 64 * 1024
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const RATE_CARD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const APPLICATION_LEDGER_KEYS = Object.freeze([
  'chargedMicroUsd',
  'monthKey',
  'schemaVersion',
  'updatedAtMs',
])
const RATE_LIMIT_KEYS = Object.freeze([
  'deepReservationTimesMs',
  'monthKey',
  'quickReservationTimesMs',
  'schemaVersion',
  'scopeDigest',
  'updatedAtMs',
])
const RESERVATION_KEYS = Object.freeze([
  'actualCostMicroUsd',
  'evidenceSignature',
  'ledgerId',
  'mode',
  'monthKey',
  'rateLimitLedgerId',
  'rateCardId',
  'requestIdDigest',
  'reservedAtMs',
  'result',
  'schemaVersion',
  'scopeDigest',
  'status',
  'worstCaseCostMicroUsd',
])

export class FirestoreUsageLedgerError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'FirestoreUsageLedgerError'
    this.category = category
  }
}

export function createFirestoreUsageLedger({ firestore, now = Date.now } = {}) {
  if (
    !firestore ||
    typeof firestore.collection !== 'function' ||
    typeof firestore.runTransaction !== 'function'
  ) {
    throw new TypeError('firestore with collection and runTransaction methods is required.')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.')

  return Object.freeze({
    reserve: input => reserve({ firestore, now, input }),
    commit: input => commit({ firestore, now, input }),
    markUncertain: input => markUncertain({ firestore, input }),
  })
}

async function reserve({ firestore, now, input }) {
  const validated = validateReserveInput(input)
  const nowMs = requireNow(now())
  if (validated.monthKey !== utcMonthKey(new Date(nowMs))) {
    fail('stale-month', 'The requested usage month is not current.')
  }
  const scopeDigest = digest(`${validated.teacherUid}\u0000${validated.classroomId}`)
  const requestIdDigest = digest(validated.requestId)
  const ledgerId = applicationLedgerId(validated.monthKey)
  const rateLimitLedgerId = tenantRateLimitLedgerId(scopeDigest, validated.monthKey)
  const reservationId = digest(`${rateLimitLedgerId}\u0000${requestIdDigest}`)
  const ledgerRef = firestore.collection(APPLICATION_LEDGER_COLLECTION).doc(ledgerId)
  const rateLimitLedgerRef = firestore.collection(RATE_LIMIT_COLLECTION).doc(rateLimitLedgerId)
  const reservationRef = firestore.collection(RESERVATION_COLLECTION).doc(reservationId)

  return firestore.runTransaction(async transaction => {
    const reservationSnapshot = await transaction.get(reservationRef)
    if (reservationSnapshot.exists) {
      const existing = validateReservationDocument(reservationSnapshot.data(), nowMs)
      requireMatchingReservation(existing, {
        scopeDigest,
        requestIdDigest,
        ledgerId,
        rateLimitLedgerId,
        ...validated,
      })
      if (existing.status === 'completed') {
        return Object.freeze({ kind: 'completed', result: cloneJsonSafe(existing.result) })
      }
      fail('request-unavailable', 'The request already has an active or uncertain reservation.')
    }

    const ledgerSnapshot = await transaction.get(ledgerRef)
    const ledger = ledgerSnapshot.exists
      ? validateApplicationLedgerDocument(
        ledgerSnapshot.data(),
        { monthKey: validated.monthKey, nowMs },
      )
      : emptyApplicationLedger({ monthKey: validated.monthKey, nowMs })

    const rateLimitLedgerSnapshot = await transaction.get(rateLimitLedgerRef)
    let rateLimitLedger
    if (rateLimitLedgerSnapshot.exists) {
      rateLimitLedger = validateRateLimitLedgerDocument(
        rateLimitLedgerSnapshot.data(),
        { scopeDigest, monthKey: validated.monthKey, nowMs },
      )
    } else {
      const previousMonth = previousUtcMonthKey(nowMs)
      const previousLedgerId = tenantRateLimitLedgerId(scopeDigest, previousMonth)
      const previousLedgerRef = firestore.collection(RATE_LIMIT_COLLECTION).doc(previousLedgerId)
      const previousLedgerSnapshot = await transaction.get(previousLedgerRef)
      const previousLedger = previousLedgerSnapshot.exists
        ? validateRateLimitLedgerDocument(
          previousLedgerSnapshot.data(),
          { scopeDigest, monthKey: previousMonth, nowMs },
        )
        : null
      rateLimitLedger = emptyRateLimitLedger({
        scopeDigest,
        monthKey: validated.monthKey,
        nowMs,
        quickReservationTimesMs: previousLedger?.quickReservationTimesMs,
        deepReservationTimesMs: previousLedger?.deepReservationTimesMs,
      })
    }
    const profile = insightModeProfile(validated.mode)
    if (validated.hourlyRequestLimit !== profile.hourlyRequestLimit) {
      fail('invalid-policy', 'The hourly request limit does not match the mode policy.')
    }
    const quickTimes = retainRollingHour(rateLimitLedger.quickReservationTimesMs, nowMs)
    const deepTimes = retainRollingHour(rateLimitLedger.deepReservationTimesMs, nowMs)
    const selectedTimes = validated.mode === 'quick' ? quickTimes : deepTimes
    if (selectedTimes.length >= validated.hourlyRequestLimit) {
      fail('rate-limit-exhausted', 'The rolling hourly request limit is exhausted.')
    }
    const nextCharged = ledger.chargedMicroUsd + validated.worstCaseCostMicroUsd
    if (
      !Number.isSafeInteger(nextCharged) ||
      nextCharged > validated.monthlyAllowanceMicroUsd
    ) {
      fail('allowance-exhausted', 'The monthly Gemini allowance is exhausted.')
    }
    const nextLedger = {
      ...ledger,
      chargedMicroUsd: nextCharged,
      updatedAtMs: nowMs,
    }
    const nextRateLimitLedger = {
      ...rateLimitLedger,
      quickReservationTimesMs: validated.mode === 'quick'
        ? [...quickTimes, nowMs]
        : quickTimes,
      deepReservationTimesMs: validated.mode === 'deep'
        ? [...deepTimes, nowMs]
        : deepTimes,
      updatedAtMs: nowMs,
    }
    const reservation = {
      schemaVersion: SCHEMA_VERSION,
      scopeDigest,
      ledgerId,
      rateLimitLedgerId,
      monthKey: validated.monthKey,
      requestIdDigest,
      mode: validated.mode,
      evidenceSignature: validated.evidenceSignature,
      rateCardId: validated.rateCardId,
      worstCaseCostMicroUsd: validated.worstCaseCostMicroUsd,
      status: 'reserved',
      reservedAtMs: nowMs,
      actualCostMicroUsd: null,
      result: null,
    }
    transaction.set(ledgerRef, nextLedger)
    transaction.set(rateLimitLedgerRef, nextRateLimitLedger)
    transaction.create(reservationRef, reservation)
    return Object.freeze({
      kind: 'reserved',
      reservationId,
      reservedCostMicroUsd: validated.worstCaseCostMicroUsd,
      remainingAfterReservationMicroUsd:
        validated.monthlyAllowanceMicroUsd - nextCharged,
    })
  })
}

async function commit({ firestore, now, input }) {
  const validated = validateCommitInput(input)
  const nowMs = requireNow(now())
  const reservationRef = firestore.collection(RESERVATION_COLLECTION).doc(validated.reservationId)
  const safeResult = cloneJsonSafe(validated.result)
  if (Buffer.byteLength(JSON.stringify(safeResult), 'utf8') > MAX_RESULT_BYTES) {
    fail('result-too-large', 'The completed analysis exceeds the ledger result limit.')
  }

  return firestore.runTransaction(async transaction => {
    const reservationSnapshot = await transaction.get(reservationRef)
    if (!reservationSnapshot.exists) fail('reservation-missing', 'The usage reservation is missing.')
    const reservation = validateReservationDocument(reservationSnapshot.data(), nowMs)
    if (
      reservation.requestIdDigest !== digest(validated.requestId) ||
      validated.reservationId !==
        digest(`${reservation.rateLimitLedgerId}\u0000${reservation.requestIdDigest}`)
    ) {
      fail('reservation-mismatch', 'The request does not match the usage reservation.')
    }
    if (validated.actualCostMicroUsd > reservation.worstCaseCostMicroUsd) {
      fail('cost-exceeds-reservation', 'Actual cost exceeds the usage reservation.')
    }
    if (reservation.status === 'completed') {
      if (
        reservation.actualCostMicroUsd === validated.actualCostMicroUsd &&
        JSON.stringify(reservation.result) === JSON.stringify(safeResult)
      ) return undefined
      fail('reservation-mismatch', 'The completed reservation has different results.')
    }
    if (reservation.status !== 'reserved') {
      fail('reservation-unavailable', 'The usage reservation cannot be reconciled.')
    }
    const ledgerRef = firestore.collection(APPLICATION_LEDGER_COLLECTION).doc(reservation.ledgerId)
    const ledgerSnapshot = await transaction.get(ledgerRef)
    if (!ledgerSnapshot.exists) fail('ledger-missing', 'The usage ledger is missing.')
    const ledger = validateApplicationLedgerDocument(ledgerSnapshot.data(), {
      monthKey: reservation.monthKey,
      nowMs,
    })
    const nextCharged = ledger.chargedMicroUsd -
      reservation.worstCaseCostMicroUsd + validated.actualCostMicroUsd
    if (!Number.isSafeInteger(nextCharged) || nextCharged < 0) {
      fail('ledger-malformed', 'The usage ledger cannot reconcile the reservation.')
    }
    transaction.set(ledgerRef, { ...ledger, chargedMicroUsd: nextCharged, updatedAtMs: nowMs })
    transaction.set(reservationRef, {
      ...reservation,
      status: 'completed',
      actualCostMicroUsd: validated.actualCostMicroUsd,
      result: safeResult,
    })
    return undefined
  })
}

async function markUncertain({ firestore, input }) {
  const validated = validateUncertainInput(input)
  const reservationRef = firestore.collection(RESERVATION_COLLECTION).doc(validated.reservationId)
  return firestore.runTransaction(async transaction => {
    const snapshot = await transaction.get(reservationRef)
    if (!snapshot.exists) fail('reservation-missing', 'The usage reservation is missing.')
    const reservation = validateReservationDocument(snapshot.data())
    if (
      reservation.requestIdDigest !== digest(validated.requestId) ||
      validated.reservationId !==
        digest(`${reservation.rateLimitLedgerId}\u0000${reservation.requestIdDigest}`) ||
      reservation.worstCaseCostMicroUsd !== validated.worstCaseCostMicroUsd
    ) {
      fail('reservation-mismatch', 'The request does not match the usage reservation.')
    }
    if (reservation.status === 'completed' || reservation.status === 'uncertain') return undefined
    if (reservation.status !== 'reserved') {
      fail('reservation-unavailable', 'The usage reservation cannot be retained.')
    }
    transaction.set(reservationRef, { ...reservation, status: 'uncertain' })
    return undefined
  })
}

function validateReserveInput(value) {
  requireExactObject(value, [
    'teacherUid',
    'classroomId',
    'requestId',
    'monthKey',
    'mode',
    'evidenceSignature',
    'hourlyRequestLimit',
    'monthlyAllowanceMicroUsd',
    'rateCardId',
    'worstCaseCostMicroUsd',
  ], 'reservation input')
  let teacherUid
  let classroomId
  try {
    teacherUid = validateInsightIdentity(value.teacherUid, 'teacherUid')
    classroomId = validateInsightIdentity(value.classroomId, 'classroomId')
  } catch (error) {
    if (error instanceof InsightIdentityError) fail('invalid-identity', error.message)
    throw error
  }
  if (!REQUEST_ID_PATTERN.test(value.requestId)) fail('invalid-request', 'requestId is malformed.')
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value.monthKey)) {
    fail('invalid-month', 'monthKey is malformed.')
  }
  const profile = insightModeProfile(value.mode)
  if (
    value.hourlyRequestLimit !== profile.hourlyRequestLimit ||
    value.monthlyAllowanceMicroUsd !== GEMINI_MONTHLY_ALLOWANCE_MICRO_USD ||
    !RATE_CARD_PATTERN.test(value.rateCardId) ||
    !DIGEST_PATTERN.test(value.evidenceSignature) ||
    !Number.isSafeInteger(value.worstCaseCostMicroUsd) ||
    value.worstCaseCostMicroUsd < 1 ||
    value.worstCaseCostMicroUsd > GEMINI_MONTHLY_ALLOWANCE_MICRO_USD
  ) {
    fail('invalid-policy', 'The reservation policy is malformed.')
  }
  return Object.freeze({
    teacherUid,
    classroomId,
    requestId: value.requestId,
    monthKey: value.monthKey,
    mode: value.mode,
    hourlyRequestLimit: value.hourlyRequestLimit,
    monthlyAllowanceMicroUsd: value.monthlyAllowanceMicroUsd,
    rateCardId: value.rateCardId,
    evidenceSignature: value.evidenceSignature,
    worstCaseCostMicroUsd: value.worstCaseCostMicroUsd,
  })
}

function validateCommitInput(value) {
  requireExactObject(
    value,
    ['reservationId', 'requestId', 'actualCostMicroUsd', 'result'],
    'commit input',
  )
  if (!DIGEST_PATTERN.test(value.reservationId) || !REQUEST_ID_PATTERN.test(value.requestId)) {
    fail('invalid-request', 'The commit identity is malformed.')
  }
  if (!Number.isSafeInteger(value.actualCostMicroUsd) || value.actualCostMicroUsd < 0) {
    fail('invalid-cost', 'Actual cost is malformed.')
  }
  return value
}

function validateUncertainInput(value) {
  requireExactObject(
    value,
    ['reservationId', 'requestId', 'worstCaseCostMicroUsd'],
    'uncertain input',
  )
  if (
    !DIGEST_PATTERN.test(value.reservationId) ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    !Number.isSafeInteger(value.worstCaseCostMicroUsd) ||
    value.worstCaseCostMicroUsd < 1
  ) {
    fail('invalid-request', 'The uncertain reservation input is malformed.')
  }
  return value
}

function validateApplicationLedgerDocument(value, { monthKey, nowMs } = {}) {
  requireExactObject(value, APPLICATION_LEDGER_KEYS, 'application ledger document')
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    value.monthKey !== monthKey ||
    !Number.isSafeInteger(value.chargedMicroUsd) ||
    value.chargedMicroUsd < 0 ||
    value.chargedMicroUsd > GEMINI_MONTHLY_ALLOWANCE_MICRO_USD ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < 0 ||
    (nowMs !== undefined && value.updatedAtMs > nowMs)
  ) {
    fail('ledger-malformed', 'The usage ledger is malformed.')
  }
  return value
}

function validateRateLimitLedgerDocument(value, { scopeDigest, monthKey, nowMs } = {}) {
  requireExactObject(value, RATE_LIMIT_KEYS, 'rate-limit ledger document')
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    !DIGEST_PATTERN.test(value.scopeDigest) ||
    value.scopeDigest !== scopeDigest ||
    value.monthKey !== monthKey ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < 0 ||
    (nowMs !== undefined && value.updatedAtMs > nowMs)
  ) {
    fail('ledger-malformed', 'The usage rate-limit ledger is malformed.')
  }
  validateTimeList(value.quickReservationTimesMs, insightModeProfile('quick').hourlyRequestLimit, nowMs)
  validateTimeList(value.deepReservationTimesMs, insightModeProfile('deep').hourlyRequestLimit, nowMs)
  return value
}

function validateReservationDocument(value, nowMs) {
  requireExactObject(value, RESERVATION_KEYS, 'reservation document')
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    !DIGEST_PATTERN.test(value.scopeDigest) ||
    !DIGEST_PATTERN.test(value.ledgerId) ||
    !DIGEST_PATTERN.test(value.rateLimitLedgerId) ||
    !DIGEST_PATTERN.test(value.requestIdDigest) ||
    !DIGEST_PATTERN.test(value.evidenceSignature) ||
    !['quick', 'deep'].includes(value.mode) ||
    !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value.monthKey) ||
    !RATE_CARD_PATTERN.test(value.rateCardId) ||
    !Number.isSafeInteger(value.worstCaseCostMicroUsd) ||
    value.worstCaseCostMicroUsd < 1 ||
    value.worstCaseCostMicroUsd > GEMINI_MONTHLY_ALLOWANCE_MICRO_USD ||
    !['reserved', 'completed', 'uncertain'].includes(value.status) ||
    !Number.isSafeInteger(value.reservedAtMs) ||
    value.reservedAtMs < 0 ||
    (nowMs !== undefined && value.reservedAtMs > nowMs)
  ) {
    fail('reservation-malformed', 'The usage reservation is malformed.')
  }
  if (
    value.ledgerId !== applicationLedgerId(value.monthKey) ||
    value.rateLimitLedgerId !== tenantRateLimitLedgerId(value.scopeDigest, value.monthKey)
  ) {
    fail('reservation-malformed', 'The usage reservation is not bound to its ledger.')
  }
  if (value.status === 'completed') {
    if (
      !Number.isSafeInteger(value.actualCostMicroUsd) ||
      value.actualCostMicroUsd < 0 ||
      value.actualCostMicroUsd > value.worstCaseCostMicroUsd ||
      value.result === null
    ) {
      fail('reservation-malformed', 'The completed usage reservation is malformed.')
    }
  } else if (value.actualCostMicroUsd !== null || value.result !== null) {
    fail('reservation-malformed', 'An incomplete usage reservation carries a result.')
  }
  return value
}

function requireMatchingReservation(existing, expected) {
  for (const key of [
    'scopeDigest',
    'ledgerId',
    'rateLimitLedgerId',
    'monthKey',
    'requestIdDigest',
    'mode',
    'evidenceSignature',
    'rateCardId',
    'worstCaseCostMicroUsd',
  ]) {
    if (existing[key] !== expected[key]) {
      fail('request-conflict', 'The request ID is already bound to different usage.')
    }
  }
}

function emptyApplicationLedger({ monthKey, nowMs }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    monthKey,
    chargedMicroUsd: 0,
    updatedAtMs: nowMs,
  }
}

function emptyRateLimitLedger({
  scopeDigest,
  monthKey,
  nowMs,
  quickReservationTimesMs = [],
  deepReservationTimesMs = [],
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    scopeDigest,
    monthKey,
    quickReservationTimesMs: [...quickReservationTimesMs],
    deepReservationTimesMs: [...deepReservationTimesMs],
    updatedAtMs: nowMs,
  }
}

function applicationLedgerId(monthKey) {
  return digest(`application\u0000${monthKey}`)
}

function tenantRateLimitLedgerId(scopeDigest, monthKey) {
  return digest(`${scopeDigest}\u0000${monthKey}`)
}

function previousUtcMonthKey(nowMs) {
  const date = new Date(nowMs)
  return utcMonthKey(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)))
}

function retainRollingHour(values, nowMs) {
  return values.filter(timestamp => nowMs - timestamp < ROLLING_HOUR_MS)
}

function validateTimeList(value, maximum, nowMs) {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((timestamp, index) => (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      (nowMs !== undefined && timestamp > nowMs) ||
      (index > 0 && timestamp < value[index - 1])
    ))
  ) {
    fail('ledger-malformed', 'A rolling usage window is malformed.')
  }
}

function cloneJsonSafe(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('result-malformed', 'The ledger result contains a non-finite number.')
    return value
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    fail('result-malformed', 'The ledger result is not JSON-safe.')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.map(item => cloneJsonSafe(item, seen))
    seen.delete(value)
    return result
  }
  if (!isPlainObject(value)) fail('result-malformed', 'The ledger result contains an unsupported object.')
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      fail('result-malformed', 'The ledger result contains an unsafe key.')
    }
    result[key] = cloneJsonSafe(child, seen)
  }
  seen.delete(value)
  return result
}

function requireNow(value) {
  const candidate = value instanceof Date ? value.getTime() : value
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    fail('invalid-time', 'The usage ledger clock is invalid.')
  }
  return candidate
}

function requireExactObject(value, keys, label) {
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) {
    fail('invalid-shape', `${label} does not match the exact contract.`)
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fail(category, message) {
  throw new FirestoreUsageLedgerError(category, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
}
