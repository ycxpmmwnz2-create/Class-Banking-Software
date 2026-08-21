import {
  GEMINI_MONTHLY_ALLOWANCE_MICRO_USD,
  insightModeProfile,
  utcMonthKey,
  validateActualCost,
  validateWorstCaseQuote,
} from './costPolicy.js'
import { FirestoreUsageLedgerError } from './firestoreUsageLedger.js'
import { InsightIdentityError, validateInsightIdentity } from './identity.js'
import { calculateQuestionAnswer } from './questionAnswerCalculator.js'
import {
  INSIGHT_QUESTION_SCHEMA_VERSION,
  InsightQuestionContractError,
  validateCompletedQuestion,
  validateInsightQuestionRequest,
  validateQuestionInterpretation,
  validateTeacherQuestionResponse,
} from './questionContracts.js'
import { InsightQuestionEvidenceError } from './questionEvidenceAdapter.js'

const RESERVATION_FAILURE_MESSAGES = Object.freeze({
  'allowance-exhausted': 'The monthly AI allowance is exhausted.',
  'rate-limit-exhausted': 'The rolling hourly request limit is exhausted.',
  'request-unavailable': 'The request already has an active or uncertain reservation.',
})

export class InsightQuestionServiceError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightQuestionServiceError'
    this.category = category
  }
}

export function createInsightQuestionService(dependencies) {
  const deps = validateDependencies(dependencies)

  return async function askTeacherQuestion({ auth, data } = {}) {
    const request = validateInsightQuestionRequest(data)
    const quickProfile = insightModeProfile('quick')
    const now = requireDate(deps.now())
    const tenant = validateTenantIdentity(await guardedCall(
      () => deps.resolveActiveTeacherTenant({ auth }),
      'authorization-failed',
      'The active teacher tenant could not be resolved.',
    ))

    let envelope
    try {
      envelope = validateEvidenceEnvelope(await deps.loadQuestionEvidence({
        teacherUid: tenant.teacherUid,
        classroomId: tenant.classroomId,
        periodDays: request.periodDays,
        timeZone: request.timeZone,
        question: request.question,
      }))
    } catch (error) {
      if (error instanceof InsightQuestionServiceError) throw error
      if (
        error instanceof InsightQuestionEvidenceError &&
        ['question-ambiguous', 'question-sensitive'].includes(error.category)
      ) {
        throw new InsightQuestionServiceError(error.category, error.message)
      }
      throw new InsightQuestionServiceError('evidence-unavailable', 'Question evidence could not be loaded.')
    }

    const quote = validateWorstCaseQuote(await guardedCall(
      () => deps.quoteWorstCaseCost({ providerInput: envelope.providerInput }),
      'cost-policy-unavailable',
      'The trusted question cost policy is unavailable.',
    ))
    const reservation = await reserveUsage(() => deps.usageLedger.reserve({
      teacherUid: tenant.teacherUid,
      classroomId: tenant.classroomId,
      requestId: request.requestId,
      monthKey: utcMonthKey(now),
      mode: 'quick',
      evidenceSignature: envelope.evidenceSignature,
      hourlyRequestLimit: quickProfile.hourlyRequestLimit,
      monthlyAllowanceMicroUsd: GEMINI_MONTHLY_ALLOWANCE_MICRO_USD,
      rateCardId: quote.rateCardId,
      worstCaseCostMicroUsd: quote.worstCaseCostMicroUsd,
    }))

    if (reservation?.kind === 'completed') {
      let replay
      try {
        replay = validateCompletedQuestion(reservation.result, {
          periodDays: request.periodDays,
          evidenceSignature: envelope.evidenceSignature,
          allowedAliases: envelope.allowedAliases,
        })
      } catch {
        throw new InsightQuestionServiceError('invalid-replay', 'Stored question does not match current evidence.')
      }
      return buildTeacherResponse({
        interpretation: replay,
        envelope,
        generatedAt: reservation.result.generatedAt,
        usage: replay.usage,
      })
    }

    const acceptedReservation = validateReservation(reservation, quote.worstCaseCostMicroUsd)
    let providerStarted = false
    try {
      providerStarted = true
      const interpretation = validateQuestionInterpretation(
        await deps.provider.interpret({ providerInput: envelope.providerInput }),
        envelope.allowedAliases,
      )
      const actualCostMicroUsd = validateActualCost(
        await deps.priceActualUsage({
          rateCardId: quote.rateCardId,
          usage: interpretation.usage,
        }),
        quote.worstCaseCostMicroUsd,
      )
      const billedUsage = Object.freeze({
        ...interpretation.usage,
        costMicroUsd: actualCostMicroUsd,
      })
      const completed = Object.freeze({
        schemaVersion: INSIGHT_QUESTION_SCHEMA_VERSION,
        source: 'provider-interpreted',
        periodDays: request.periodDays,
        evidenceSignature: envelope.evidenceSignature,
        generatedAt: now.toISOString(),
        intent: interpretation.intent,
        subjectAlias: interpretation.subjectAlias,
        usage: billedUsage,
      })
      await deps.usageLedger.commit({
        reservationId: acceptedReservation.reservationId,
        requestId: request.requestId,
        actualCostMicroUsd,
        result: completed,
      })
      return buildTeacherResponse({
        interpretation,
        envelope,
        generatedAt: completed.generatedAt,
        usage: billedUsage,
      })
    } catch (error) {
      if (providerStarted) {
        await retainWorstCaseReservation(deps.usageLedger, {
          reservationId: acceptedReservation.reservationId,
          requestId: request.requestId,
          worstCaseCostMicroUsd: quote.worstCaseCostMicroUsd,
        })
      }
      if (error instanceof InsightQuestionContractError) {
        throw new InsightQuestionServiceError('provider-output-invalid', 'The AI question interpretation was invalid.')
      }
      if (error instanceof InsightQuestionServiceError) throw error
      throw new InsightQuestionServiceError('provider-unavailable', 'AI question interpretation is unavailable.')
    }
  }
}

function buildTeacherResponse({ interpretation, envelope, generatedAt, usage }) {
  const calculated = calculateQuestionAnswer({
    intent: interpretation.intent,
    subjectAlias: interpretation.subjectAlias,
    evidence: envelope.answerEvidence,
  })
  return validateTeacherQuestionResponse({
    schemaVersion: INSIGHT_QUESTION_SCHEMA_VERSION,
    source: 'ai-grounded',
    periodDays: envelope.answerEvidence.periodDays,
    generatedAt,
    answer: calculated.answer,
    evidence: calculated.evidence,
    usage,
  })
}

function validateEvidenceEnvelope(value) {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    ['generatedAt', 'providerInput', 'answerEvidence', 'allowedAliases', 'sensitiveValues', 'evidenceSignature'],
  )) {
    throw new InsightQuestionServiceError('evidence-unavailable', 'The question evidence envelope is malformed.')
  }
  if (
    !isPlainObject(value.providerInput) ||
    !isPlainObject(value.answerEvidence) ||
    !Array.isArray(value.allowedAliases) ||
    !Array.isArray(value.sensitiveValues) ||
    typeof value.evidenceSignature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.evidenceSignature)
  ) {
    throw new InsightQuestionServiceError('evidence-unavailable', 'The question evidence envelope is malformed.')
  }
  assertProviderInputIsDeidentified(value.providerInput, value.sensitiveValues)
  return value
}

function assertProviderInputIsDeidentified(providerInput, sensitiveValues) {
  const leaves = []
  collectStringLeaves(providerInput, leaves)
  const privacyLeaves = leaves.map(providerLeafForSensitiveScan)
  for (const entry of sensitiveValues) {
    if (
      !isPlainObject(entry) ||
      !hasExactKeys(entry, ['kind', 'value']) ||
      !['teacher-uid', 'classroom-id', 'student-id', 'student-name'].includes(entry.kind) ||
      typeof entry.value !== 'string' ||
      entry.value.length < 1 ||
      entry.value.length > 320
    ) {
      throw new InsightQuestionServiceError('evidence-unavailable', 'A sensitive-value declaration is malformed.')
    }
    if (entry.kind === 'student-id' && /^[0-9]+$/.test(entry.value)) continue
    const values = entry.kind === 'student-name'
      ? [entry.value, ...entry.value.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 2)]
      : [entry.value]
    for (const sensitive of values) {
      const pattern = new RegExp(
        `(^|[^\\p{L}\\p{N}])${sensitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`,
        'iu',
      )
      if (leaves.some(leaf => pattern.test(leaf))) {
        throw new InsightQuestionServiceError(
          'evidence-not-deidentified',
          'The provider question input contains a declared sensitive value.',
        )
      }
    }
    if (entry.kind === 'student-name') {
      if (sensitiveNameSequences(entry.value).some(sensitive => (
        privacyLeaves.some(leaf => containsSeparatorObscuredSequence(leaf, sensitive))
      ))) {
        throw new InsightQuestionServiceError(
          'evidence-not-deidentified',
          'The provider question input contains an obscured sensitive value.',
        )
      }
    }
  }
}

function providerLeafForSensitiveScan(value) {
  if (/^student-[0-9]{3}$/iu.test(value)) return ''
  return value.replace(/\[student(?:-[0-9]{3})?\]/giu, '')
}

function collapseSensitiveText(value) {
  return String(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function sensitiveNameSequences(value) {
  const nameTokens = String(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .split(/[^\p{L}\p{N}]+/u)
    .map(collapseSensitiveText)
    .filter(Boolean)
  const sequences = new Set(nameTokens.filter(token => token.length >= 2))
  for (let index = 0; index < nameTokens.length - 1; index += 1) {
    sequences.add(`${nameTokens[index]}${nameTokens[index + 1]}`)
  }
  if (nameTokens.length > 1) {
    sequences.add(`${nameTokens[0]}${nameTokens.at(-1)}`)
    sequences.add(nameTokens.join(''))
  }
  return [...sequences]
}

function containsSeparatorObscuredSequence(value, sequence) {
  if (!sequence) return false
  const characters = [...sequence].map(escapeRegExp)
  const obscured = characters.join('[^\\p{L}\\p{N}]*')
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${obscured}(?=$|[^\\p{L}\\p{N}])`,
    'u',
  ).test(String(value).normalize('NFKC').toLocaleLowerCase('en-US'))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
  for (const child of Object.values(value)) collectStringLeaves(child, output)
}

function validateReservation(value, expectedCost) {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    ['kind', 'reservationId', 'reservedCostMicroUsd', 'remainingAfterReservationMicroUsd'],
  )) {
    throw new InsightQuestionServiceError('budget-unavailable', 'Usage reservation is malformed.')
  }
  if (value.kind !== 'reserved' || value.reservedCostMicroUsd !== expectedCost) {
    throw new InsightQuestionServiceError('budget-unavailable', 'Usage reservation is inconsistent.')
  }
  let reservationId
  try {
    reservationId = validateInsightIdentity(value.reservationId, 'reservationId')
  } catch {
    throw new InsightQuestionServiceError('budget-unavailable', 'Usage reservation is malformed.')
  }
  return Object.freeze({ reservationId })
}

function validateTenantIdentity(value) {
  if (!isPlainObject(value)) throw new InsightQuestionServiceError('authorization-failed', 'Tenant identity is malformed.')
  try {
    return Object.freeze({
      teacherUid: validateInsightIdentity(value.teacherUid, 'teacherUid'),
      classroomId: validateInsightIdentity(value.classroomId, 'classroomId'),
    })
  } catch (error) {
    if (error instanceof InsightIdentityError) {
      throw new InsightQuestionServiceError('authorization-failed', error.message)
    }
    throw error
  }
}

function validateDependencies(value) {
  if (!isPlainObject(value)) throw new TypeError('Question service dependencies are required.')
  for (const key of [
    'resolveActiveTeacherTenant',
    'loadQuestionEvidence',
    'quoteWorstCaseCost',
    'priceActualUsage',
    'now',
  ]) {
    if (typeof value[key] !== 'function') throw new TypeError(`${key} must be a function.`)
  }
  if (!isPlainObject(value.provider) || typeof value.provider.interpret !== 'function') {
    throw new TypeError('provider.interpret must be a function.')
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

async function reserveUsage(operation) {
  try {
    return await operation()
  } catch (error) {
    if (
      error instanceof FirestoreUsageLedgerError &&
      Object.hasOwn(RESERVATION_FAILURE_MESSAGES, error.category)
    ) {
      throw new InsightQuestionServiceError(error.category, RESERVATION_FAILURE_MESSAGES[error.category])
    }
    throw new InsightQuestionServiceError('budget-unavailable', 'A usage reservation could not be obtained.')
  }
}

async function retainWorstCaseReservation(usageLedger, reservation) {
  try {
    await usageLedger.markUncertain(reservation)
  } catch {
    // The reserved amount remains the conservative accounting state.
  }
}

async function guardedCall(operation, category, message) {
  try {
    return await operation()
  } catch {
    throw new InsightQuestionServiceError(category, message)
  }
}

function requireDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new InsightQuestionServiceError('invalid-time', 'The server clock is invalid.')
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
