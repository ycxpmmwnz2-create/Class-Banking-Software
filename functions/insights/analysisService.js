import {
  INSIGHT_ANALYSIS_SCHEMA_VERSION,
  InsightContractError,
  validateCompletedAnalysis,
  validateFactPacket,
  validateInsightRequest,
  validateProviderResponse,
  validateTeacherAnalysisResponse,
} from './contracts.js'
import {
  GEMINI_MONTHLY_ALLOWANCE_MICRO_USD,
  InsightCostPolicyError,
  insightModeProfile,
  utcMonthKey,
  validateActualCost,
  validateWorstCaseQuote,
} from './costPolicy.js'
import { FirestoreUsageLedgerError } from './firestoreUsageLedger.js'
import { InsightIdentityError, validateInsightIdentity } from './identity.js'

const RESERVATION_FAILURE_MESSAGES = Object.freeze({
  'allowance-exhausted': 'The monthly Gemini allowance is exhausted.',
  'rate-limit-exhausted': 'The rolling hourly request limit is exhausted.',
  'request-unavailable': 'The request already has an active or uncertain reservation.',
})

export class InsightAnalysisServiceError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightAnalysisServiceError'
    this.category = category
  }
}

export function createInsightAnalysisService(dependencies) {
  const deps = validateDependencies(dependencies)

  return async function analyzeTeacherInsights({ auth, data } = {}) {
    const request = validateInsightRequest(data)
    const profile = insightModeProfile(request.mode)
    const now = requireDate(deps.now(), 'now')

    const tenant = await guardedCall(
      () => deps.resolveActiveTeacherTenant({ auth }),
      'authorization-failed',
      'The active teacher tenant could not be resolved.',
    )
    const identity = validateTenantIdentity(tenant)

    const rawEvidenceEnvelope = await guardedCall(
      () => deps.loadDeidentifiedTenantEvidence({
        teacherUid: identity.teacherUid,
        classroomId: identity.classroomId,
        periodDays: request.periodDays,
        timeZone: request.timeZone,
      }),
      'evidence-unavailable',
      'Classroom evidence could not be loaded.',
    )
    const evidenceEnvelope = validateEvidenceEnvelope(rawEvidenceEnvelope)
    assertAnalysisEvidenceIsDeidentified(evidenceEnvelope)
    const rawPacket = await guardedCall(
      () => deps.buildFactPacket({
        evidence: evidenceEnvelope.analysisEvidence,
        mode: request.mode,
        periodDays: request.periodDays,
        modeProfile: profile,
      }),
      'evidence-unavailable',
      'The deterministic fact packet could not be built.',
    )
    const packet = validateFactPacket(rawPacket, request)
    const displayObservations = pairDisplayObservations(packet, evidenceEnvelope.displayEvidence)

    const rawQuote = await guardedCall(
      () => deps.quoteWorstCaseCost({ modeProfile: profile, factPacket: packet }),
      'cost-policy-unavailable',
      'The trusted cost policy is unavailable.',
    )
    const quote = validateWorstCaseQuote(rawQuote)

    const reservation = await reserveUsage(
      () => deps.usageLedger.reserve({
        teacherUid: identity.teacherUid,
        classroomId: identity.classroomId,
        requestId: request.requestId,
        monthKey: utcMonthKey(now),
        mode: request.mode,
        evidenceSignature: evidenceEnvelope.evidenceSignature,
        hourlyRequestLimit: profile.hourlyRequestLimit,
        monthlyAllowanceMicroUsd: GEMINI_MONTHLY_ALLOWANCE_MICRO_USD,
        rateCardId: quote.rateCardId,
        worstCaseCostMicroUsd: quote.worstCaseCostMicroUsd,
      }),
    )

    if (reservation?.kind === 'completed') {
      let replay
      try {
        replay = validateCompletedAnalysis(
          reservation.result,
          packet,
          evidenceEnvelope.evidenceSignature,
        )
      } catch {
        throw new InsightAnalysisServiceError(
          'invalid-replay',
          'Stored analysis does not match current evidence.',
        )
      }
      if (replay.usage.costMicroUsd > GEMINI_MONTHLY_ALLOWANCE_MICRO_USD) {
        throw new InsightAnalysisServiceError('invalid-replay', 'Stored usage exceeds the allowance.')
      }
      return buildTeacherResponse(replay, displayObservations)
    }

    const acceptedReservation = validateReservation(
      reservation,
      quote.worstCaseCostMicroUsd,
    )
    let providerStarted = false

    try {
      providerStarted = true
      const rawProviderResponse = await deps.provider.generate({
        providerProfile: profile.id,
        maxOutputTokens: profile.maxOutputTokens,
        factPacket: packet,
      })
      const providerResponse = validateProviderResponse(rawProviderResponse, packet)
      const rawActualCost = await deps.priceActualUsage({
        rateCardId: quote.rateCardId,
        modeProfile: profile,
        usage: providerResponse.usage,
      })
      const actualCostMicroUsd = validateActualCost(
        rawActualCost,
        quote.worstCaseCostMicroUsd,
      )
      const completed = buildCompletedAnalysis({
        packet,
        providerResponse,
        evidenceSignature: evidenceEnvelope.evidenceSignature,
        generatedAt: now.toISOString(),
        actualCostMicroUsd,
      })
      await deps.usageLedger.commit({
        reservationId: acceptedReservation.reservationId,
        requestId: request.requestId,
        actualCostMicroUsd,
        result: completed,
      })
      return buildTeacherResponse(completed, displayObservations)
    } catch (error) {
      if (providerStarted) {
        await retainWorstCaseReservation(deps.usageLedger, {
          reservationId: acceptedReservation.reservationId,
          requestId: request.requestId,
          worstCaseCostMicroUsd: quote.worstCaseCostMicroUsd,
        })
      }
      if (error instanceof InsightContractError) {
        throw new InsightAnalysisServiceError(
          'provider-output-invalid',
          'Provider output did not satisfy the guarded response contract.',
        )
      }
      if (error instanceof InsightCostPolicyError) {
        throw new InsightAnalysisServiceError(
          'usage-invalid',
          'Provider usage could not be reconciled safely.',
        )
      }
      if (error instanceof InsightAnalysisServiceError) throw error
      throw new InsightAnalysisServiceError(
        'provider-unavailable',
        'Provider-assisted analysis is unavailable.',
      )
    }
  }
}

function buildCompletedAnalysis({
  packet,
  providerResponse,
  evidenceSignature,
  generatedAt,
  actualCostMicroUsd,
}) {
  return Object.freeze({
    schemaVersion: INSIGHT_ANALYSIS_SCHEMA_VERSION,
    source: 'provider-assisted',
    mode: packet.mode,
    periodDays: packet.periodDays,
    evidenceSignature,
    generatedAt,
    orderedObservationIds: providerResponse.orderedObservationIds,
    groups: providerResponse.groups,
    teacherQuestions: providerResponse.teacherQuestions,
    usage: Object.freeze({
      inputTokens: providerResponse.usage.inputTokens,
      outputTokens: providerResponse.usage.outputTokens,
      thinkingTokens: providerResponse.usage.thinkingTokens,
      costMicroUsd: actualCostMicroUsd,
    }),
  })
}

function validateDependencies(value) {
  if (!isPlainObject(value)) {
    throw new TypeError('Insight analysis dependencies are required.')
  }
  for (const key of [
    'resolveActiveTeacherTenant',
    'loadDeidentifiedTenantEvidence',
    'buildFactPacket',
    'quoteWorstCaseCost',
    'priceActualUsage',
    'now',
  ]) {
    if (typeof value[key] !== 'function') throw new TypeError(`${key} must be a function.`)
  }
  if (!isPlainObject(value.provider) || typeof value.provider.generate !== 'function') {
    throw new TypeError('provider.generate must be a function.')
  }
  if (
    !isPlainObject(value.usageLedger) ||
    typeof value.usageLedger.reserve !== 'function' ||
    typeof value.usageLedger.commit !== 'function' ||
    typeof value.usageLedger.markUncertain !== 'function'
  ) {
    throw new TypeError('usageLedger must implement reserve, commit, and markUncertain.')
  }
  return value
}

function validateTenantIdentity(value) {
  if (!isPlainObject(value)) {
    throw new InsightAnalysisServiceError('authorization-failed', 'Tenant identity is malformed.')
  }
  try {
    return Object.freeze({
      teacherUid: validateInsightIdentity(value.teacherUid, 'teacherUid'),
      classroomId: validateInsightIdentity(value.classroomId, 'classroomId'),
    })
  } catch (error) {
    if (error instanceof InsightIdentityError) {
      throw new InsightAnalysisServiceError('authorization-failed', error.message)
    }
    throw error
  }
}

const SENSITIVE_VALUE_KINDS = Object.freeze(new Set([
  'student-name',
  'student-id',
  'login-id',
  'pin',
  'auth-uid',
  'teacher-uid',
  'classroom-id',
  'email',
]))

const DIRECT_IDENTIFIER_KINDS = Object.freeze(new Set([
  'student-id',
  'login-id',
  'pin',
  'auth-uid',
  'teacher-uid',
  'classroom-id',
  'email',
]))

function validateEvidenceEnvelope(value) {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    ['analysisEvidence', 'displayEvidence', 'sensitiveValues', 'evidenceSignature'],
  )) {
    throw new InsightAnalysisServiceError(
      'evidence-unavailable',
      'The de-identified evidence envelope is malformed.',
    )
  }
  if (!isPlainObject(value.analysisEvidence) || !isPlainObject(value.displayEvidence)) {
    throw new InsightAnalysisServiceError(
      'evidence-unavailable',
      'De-identified analysis evidence must be a plain object.',
    )
  }
  if (typeof value.evidenceSignature !== 'string' || !/^[a-f0-9]{64}$/.test(value.evidenceSignature)) {
    throw new InsightAnalysisServiceError(
      'evidence-unavailable',
      'The server evidence signature is malformed.',
    )
  }
  if (!Array.isArray(value.sensitiveValues)) {
    throw new InsightAnalysisServiceError(
      'evidence-unavailable',
      'The sensitive-value declaration is malformed.',
    )
  }
  const seen = new Set()
  const sensitiveValues = value.sensitiveValues.map((entry) => {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ['kind', 'value'])) {
      throw new InsightAnalysisServiceError(
        'evidence-unavailable',
        'A sensitive-value declaration is malformed.',
      )
    }
    if (!SENSITIVE_VALUE_KINDS.has(entry.kind)) {
      throw new InsightAnalysisServiceError(
        'evidence-unavailable',
        'A sensitive-value kind is unsupported.',
      )
    }
    if (
      typeof entry.value !== 'string' ||
      entry.value.length < 1 ||
      entry.value.length > 320 ||
      entry.value.trim() !== entry.value
    ) {
      throw new InsightAnalysisServiceError(
        'evidence-unavailable',
        'A sensitive value is malformed.',
      )
    }
    const identity = `${entry.kind}\u0000${entry.value}`
    if (seen.has(identity)) {
      throw new InsightAnalysisServiceError(
        'evidence-unavailable',
        'Sensitive-value declarations must be unique.',
      )
    }
    seen.add(identity)
    return Object.freeze({ kind: entry.kind, value: entry.value })
  })
  return Object.freeze({
    analysisEvidence: cloneAnalysisEvidence(value.analysisEvidence),
    displayEvidence: cloneAnalysisEvidence(value.displayEvidence),
    sensitiveValues: Object.freeze(sensitiveValues),
    evidenceSignature: value.evidenceSignature,
  })
}

function cloneAnalysisEvidence(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InsightAnalysisServiceError(
        'evidence-unavailable',
        'De-identified analysis evidence contains a non-finite number.',
      )
    }
    return value
  }
  if (!value || typeof value !== 'object') {
    throw new InsightAnalysisServiceError(
      'evidence-unavailable',
      'De-identified analysis evidence is not JSON-safe.',
    )
  }
  if (seen.has(value)) {
    throw new InsightAnalysisServiceError(
      'evidence-unavailable',
      'De-identified analysis evidence is cyclic.',
    )
  }
  seen.add(value)
  if (Array.isArray(value)) {
    const result = Object.freeze(value.map((item) => cloneAnalysisEvidence(item, seen)))
    seen.delete(value)
    return result
  }
  if (!isPlainObject(value)) {
    throw new InsightAnalysisServiceError(
      'evidence-unavailable',
      'De-identified analysis evidence contains an unsupported object.',
    )
  }
  const result = {}
  for (const [key, childValue] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new InsightAnalysisServiceError(
        'evidence-unavailable',
        'De-identified analysis evidence contains an unsafe key.',
      )
    }
    result[key] = cloneAnalysisEvidence(childValue, seen)
  }
  seen.delete(value)
  return Object.freeze(result)
}

function assertAnalysisEvidenceIsDeidentified(envelope) {
  const leaves = []
  collectStringLeaves(envelope.analysisEvidence, leaves)
  for (const sensitive of envelope.sensitiveValues) {
    const escaped = sensitive.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tokenPattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i')
    const numericStudentId = sensitive.kind === 'student-id' && /^[0-9]+$/.test(sensitive.value)
    const leaked = leaves.some((leaf) => (
      (DIRECT_IDENTIFIER_KINDS.has(sensitive.kind) && !numericStudentId) ||
        /\s/.test(sensitive.value)
        ? tokenPattern.test(leaf)
        : leaf.localeCompare(sensitive.value, 'en-US', { sensitivity: 'accent' }) === 0
    ))
    if (leaked) {
      throw new InsightAnalysisServiceError(
        'evidence-not-deidentified',
        'Analysis evidence contains a declared sensitive value.',
      )
    }
  }
}

function collectStringLeaves(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, output)
    return
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') output.push(value)
    return
  }
  for (const childValue of Object.values(value)) {
    collectStringLeaves(childValue, output)
  }
}

function validateReservation(value, expectedCost) {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    ['kind', 'reservationId', 'reservedCostMicroUsd', 'remainingAfterReservationMicroUsd'],
  )) {
    throw new InsightAnalysisServiceError('budget-unavailable', 'Usage reservation is malformed.')
  }
  if (value.kind !== 'reserved') {
    throw new InsightAnalysisServiceError('budget-unavailable', 'Usage reservation was refused.')
  }
  let reservationId
  try {
    reservationId = validateInsightIdentity(value.reservationId, 'reservationId')
  } catch {
    throw new InsightAnalysisServiceError('budget-unavailable', 'Usage reservation is malformed.')
  }
  if (value.reservedCostMicroUsd !== expectedCost) {
    throw new InsightAnalysisServiceError('budget-unavailable', 'Usage reservation cost is inconsistent.')
  }
  if (
    !Number.isSafeInteger(value.remainingAfterReservationMicroUsd) ||
    value.remainingAfterReservationMicroUsd < 0 ||
    value.reservedCostMicroUsd + value.remainingAfterReservationMicroUsd >
      GEMINI_MONTHLY_ALLOWANCE_MICRO_USD
  ) {
    throw new InsightAnalysisServiceError('budget-unavailable', 'Usage reservation exceeds the allowance.')
  }
  return Object.freeze({ reservationId })
}

function pairDisplayObservations(packet, displayEvidence) {
  if (
    !isPlainObject(displayEvidence) ||
    !Array.isArray(displayEvidence.observations) ||
    displayEvidence.observations.length < packet.observations.length
  ) {
    throw new InsightAnalysisServiceError(
      'evidence-unavailable',
      'Teacher display evidence is incomplete.',
    )
  }
  return Object.freeze(packet.observations.map((providerObservation, index) => {
    const displayObservation = displayEvidence.observations[index]
    if (
      !isPlainObject(displayObservation) ||
      providerObservation.priority !== displayObservation.priority ||
      providerObservation.category !== displayObservation.category ||
      providerObservation.title !== displayObservation.title ||
      !Array.isArray(displayObservation.evidence) ||
      displayObservation.evidence.length !== 1
    ) {
      throw new InsightAnalysisServiceError(
        'evidence-unavailable',
        'Provider and teacher display evidence are not aligned.',
      )
    }
    return Object.freeze({
      id: providerObservation.id,
      priority: displayObservation.priority,
      category: displayObservation.category,
      title: displayObservation.title,
      summary: displayObservation.summary,
      evidence: displayObservation.evidence[0],
    })
  }))
}

function buildTeacherResponse(completed, observations) {
  return validateTeacherAnalysisResponse({
    schemaVersion: completed.schemaVersion,
    source: completed.source,
    mode: completed.mode,
    periodDays: completed.periodDays,
    generatedAt: completed.generatedAt,
    observations,
    orderedObservationIds: completed.orderedObservationIds,
    groups: completed.groups,
    teacherQuestions: completed.teacherQuestions,
    usage: completed.usage,
  })
}

async function retainWorstCaseReservation(usageLedger, reservation) {
  try {
    await usageLedger.markUncertain(reservation)
  } catch {
    // The original reserved amount remains the safe accounting state. Never
    // replace the primary failure with telemetry or reconciliation details.
  }
}

async function reserveUsage(operation) {
  try {
    return await operation()
  } catch (error) {
    if (
      error instanceof FirestoreUsageLedgerError &&
      Object.hasOwn(RESERVATION_FAILURE_MESSAGES, error.category)
    ) {
      throw new InsightAnalysisServiceError(
        error.category,
        RESERVATION_FAILURE_MESSAGES[error.category],
      )
    }
    throw new InsightAnalysisServiceError(
      'budget-unavailable',
      'A usage reservation could not be obtained.',
    )
  }
}

async function guardedCall(operation, category, message) {
  try {
    return await operation()
  } catch {
    throw new InsightAnalysisServiceError(category, message)
  }
}

function requireDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new InsightAnalysisServiceError('invalid-time', `${label} is invalid.`)
  }
  return date
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expectedKeys) {
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
}
