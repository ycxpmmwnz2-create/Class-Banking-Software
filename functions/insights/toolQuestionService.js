import {
  GEMINI_MONTHLY_ALLOWANCE_MICRO_USD,
  insightModeProfile,
  utcMonthKey,
  validateActualCost,
  validateWorstCaseQuote,
} from './costPolicy.js'
import { FirestoreUsageLedgerError } from './firestoreUsageLedger.js'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { GeminiClassroomAssistantError } from './geminiClassroomAssistant.js'
import { InsightIdentityError, validateInsightIdentity } from './identity.js'
import {
  INSIGHT_QUESTION_SCHEMA_VERSION,
  InsightQuestionContractError,
  validateInsightQuestionRequest,
  validateTeacherQuestionResponse,
} from './questionContracts.js'
import { InsightQuestionEvidenceError } from './questionEvidenceAdapter.js'

const TOOL_ASSISTANT_RESULT_SCHEMA_VERSION = 1
const RESERVATION_FAILURE_MESSAGES = Object.freeze({
  'allowance-exhausted': 'The monthly AI allowance is exhausted.',
  'rate-limit-exhausted': 'The rolling hourly request limit is exhausted.',
  'request-unavailable': 'The request already has an active or uncertain reservation.',
})

export class InsightToolQuestionServiceError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightToolQuestionServiceError'
    this.category = category
  }
}

export function createInsightToolQuestionService(dependencies) {
  const deps = validateDependencies(dependencies)
  return async function askTeacherQuestion({ auth, data } = {}) {
    const request = validateInsightQuestionRequest(data)
    const profile = insightModeProfile('quick')
    const now = requireDate(deps.now())
    const tenant = validateTenantIdentity(await guardedCall(
      () => deps.resolveActiveTeacherTenant({ auth }),
      'authorization-failed',
      'The active teacher tenant could not be resolved.',
    ))
    let envelope
    let toolbox
    try {
      envelope = validateEvidenceEnvelope(await deps.loadQuestionEvidence({
        teacherUid: tenant.teacherUid,
        classroomId: tenant.classroomId,
        periodDays: request.periodDays,
        timeZone: request.timeZone,
        question: request.question,
        assistantMode: true,
      }))
      toolbox = createClassroomAssistantToolbox(envelope.assistantEvidence, {
        memoResolver: envelope.assistantMemoResolver,
      })
    } catch (error) {
      if (
        error instanceof InsightQuestionEvidenceError &&
        ['question-ambiguous', 'question-sensitive', 'category-sensitive'].includes(error.category)
      ) throw new InsightToolQuestionServiceError(error.category, error.message)
      if (error instanceof InsightToolQuestionServiceError) throw error
      throw new InsightToolQuestionServiceError('evidence-unavailable', 'Question evidence could not be loaded.')
    }
    const quote = validateWorstCaseQuote(await guardedCall(
      () => deps.quoteWorstCaseCost({ assistantEvidence: envelope.assistantEvidence, toolbox }),
      'cost-policy-unavailable',
      'The trusted classroom assistant cost policy is unavailable.',
    ))
    const reservation = await reserveUsage(() => deps.usageLedger.reserve({
      teacherUid: tenant.teacherUid,
      classroomId: tenant.classroomId,
      requestId: request.requestId,
      monthKey: utcMonthKey(now),
      mode: 'quick',
      evidenceSignature: envelope.evidenceSignature,
      hourlyRequestLimit: profile.hourlyRequestLimit,
      monthlyAllowanceMicroUsd: GEMINI_MONTHLY_ALLOWANCE_MICRO_USD,
      rateCardId: quote.rateCardId,
      worstCaseCostMicroUsd: quote.worstCaseCostMicroUsd,
    }))
    if (reservation?.kind === 'completed') {
      return teacherResponse(validateCompletedResult(reservation.result, request, envelope), request.periodDays)
    }
    const accepted = validateReservation(reservation, quote.worstCaseCostMicroUsd)
    try {
      const result = validateAssistantResult(await deps.assistant.answer({
        assistantEvidence: envelope.assistantEvidence,
        toolbox,
      }))
      const actualCostMicroUsd = validateActualCost(await deps.priceActualUsage({
        rateCardId: quote.rateCardId,
        usage: result.usage,
      }), quote.worstCaseCostMicroUsd)
      const billedUsage = Object.freeze({ ...result.usage, costMicroUsd: actualCostMicroUsd })
      const completed = Object.freeze({
        schemaVersion: TOOL_ASSISTANT_RESULT_SCHEMA_VERSION,
        source: 'provider-tool-assistant',
        periodDays: request.periodDays,
        evidenceSignature: envelope.evidenceSignature,
        generatedAt: now.toISOString(),
        answer: result.answer,
        evidence: result.evidence,
        usage: billedUsage,
      })
      const response = teacherResponse(completed, request.periodDays)
      await deps.usageLedger.commit({
        reservationId: accepted.reservationId,
        requestId: request.requestId,
        actualCostMicroUsd,
        result: completed,
      })
      return response
    } catch (error) {
      await retainWorstCaseReservation(deps.usageLedger, {
        reservationId: accepted.reservationId,
        requestId: request.requestId,
        worstCaseCostMicroUsd: quote.worstCaseCostMicroUsd,
      })
      if (error instanceof InsightToolQuestionServiceError) throw error
      if (error instanceof GeminiClassroomAssistantError) {
        throw new InsightToolQuestionServiceError(error.category, 'The classroom assistant could not complete the answer.')
      }
      throw new InsightToolQuestionServiceError('provider-unavailable', 'The classroom assistant is unavailable.')
    }
  }
}

function validateAssistantResult(value) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['answer', 'evidence', 'usage', 'toolCallCount']) ||
    typeof value.answer !== 'string' ||
    !Array.isArray(value.evidence) ||
    value.evidence.length < 1 ||
    value.evidence.length > 8 ||
    !isPlainObject(value.usage)
  ) throw new InsightToolQuestionServiceError('provider-output-invalid', 'The classroom assistant result is malformed.')
  return value
}

function validateCompletedResult(value, request, envelope) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['schemaVersion', 'source', 'periodDays', 'evidenceSignature', 'generatedAt', 'answer', 'evidence', 'usage']) ||
    value.schemaVersion !== TOOL_ASSISTANT_RESULT_SCHEMA_VERSION ||
    value.source !== 'provider-tool-assistant' ||
    value.periodDays !== request.periodDays ||
    value.evidenceSignature !== envelope.evidenceSignature
  ) throw new InsightToolQuestionServiceError('invalid-replay', 'Stored question does not match current evidence.')
  return value
}

function teacherResponse(result, periodDays) {
  try {
    return validateTeacherQuestionResponse({
      schemaVersion: INSIGHT_QUESTION_SCHEMA_VERSION,
      source: 'ai-grounded',
      periodDays,
      generatedAt: result.generatedAt,
      answer: result.answer,
      evidence: result.evidence,
      usage: result.usage,
    })
  } catch (error) {
    if (error instanceof InsightQuestionContractError) {
      throw new InsightToolQuestionServiceError('answer-unavailable', 'The classroom assistant answer is invalid.')
    }
    throw error
  }
}

function validateEvidenceEnvelope(value) {
  if (
    !isPlainObject(value) ||
    !Object.hasOwn(value, 'assistantEvidence') ||
    !isPlainObject(value.assistantEvidence) ||
    typeof value.assistantMemoResolver !== 'function' ||
    typeof value.evidenceSignature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.evidenceSignature)
  ) throw new InsightToolQuestionServiceError('evidence-unavailable', 'The question evidence envelope is malformed.')
  return value
}

function validateReservation(value, expectedCost) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['kind', 'reservationId', 'reservedCostMicroUsd', 'remainingAfterReservationMicroUsd']) ||
    value.kind !== 'reserved' ||
    value.reservedCostMicroUsd !== expectedCost
  ) throw new InsightToolQuestionServiceError('budget-unavailable', 'Usage reservation is inconsistent.')
  try {
    return Object.freeze({ reservationId: validateInsightIdentity(value.reservationId, 'reservationId') })
  } catch {
    throw new InsightToolQuestionServiceError('budget-unavailable', 'Usage reservation is malformed.')
  }
}

function validateTenantIdentity(value) {
  if (!isPlainObject(value)) throw new InsightToolQuestionServiceError('authorization-failed', 'Tenant identity is malformed.')
  try {
    return Object.freeze({
      teacherUid: validateInsightIdentity(value.teacherUid, 'teacherUid'),
      classroomId: validateInsightIdentity(value.classroomId, 'classroomId'),
    })
  } catch (error) {
    if (error instanceof InsightIdentityError) throw new InsightToolQuestionServiceError('authorization-failed', error.message)
    throw error
  }
}

function validateDependencies(value) {
  if (!isPlainObject(value)) throw new TypeError('Tool question service dependencies are required.')
  for (const key of ['resolveActiveTeacherTenant', 'loadQuestionEvidence', 'quoteWorstCaseCost', 'priceActualUsage', 'now']) {
    if (typeof value[key] !== 'function') throw new TypeError(`${key} must be a function.`)
  }
  if (!isPlainObject(value.assistant) || typeof value.assistant.answer !== 'function') throw new TypeError('assistant.answer must be a function.')
  if (
    !isPlainObject(value.usageLedger) ||
    typeof value.usageLedger.reserve !== 'function' ||
    typeof value.usageLedger.commit !== 'function' ||
    typeof value.usageLedger.markUncertain !== 'function'
  ) throw new TypeError('usageLedger must implement reserve, commit, and markUncertain.')
  return value
}

async function reserveUsage(operation) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof FirestoreUsageLedgerError && Object.hasOwn(RESERVATION_FAILURE_MESSAGES, error.category)) {
      throw new InsightToolQuestionServiceError(error.category, RESERVATION_FAILURE_MESSAGES[error.category])
    }
    throw new InsightToolQuestionServiceError('budget-unavailable', 'A usage reservation could not be obtained.')
  }
}

async function retainWorstCaseReservation(usageLedger, reservation) {
  try {
    await usageLedger.markUncertain(reservation)
  } catch {
    // The reservation remains conservatively charged.
  }
}

async function guardedCall(operation, category, message) {
  try {
    return await operation()
  } catch {
    throw new InsightToolQuestionServiceError(category, message)
  }
}

function requireDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new InsightToolQuestionServiceError('invalid-time', 'The server clock is invalid.')
  return date
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index])
}
