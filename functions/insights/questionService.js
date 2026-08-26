import {
  GEMINI_MONTHLY_ALLOWANCE_MICRO_USD,
  insightModeProfile,
  utcMonthKey,
  validateActualCost,
  validateWorstCaseQuote,
} from './costPolicy.js'
import { FirestoreUsageLedgerError } from './firestoreUsageLedger.js'
import { InsightIdentityError, validateInsightIdentity } from './identity.js'
import {
  calculateQuestionAnswer,
  InsightQuestionAnswerError,
} from './questionAnswerCalculator.js'
import {
  INSIGHT_QUERY_PLAN_SCHEMA_VERSION,
  INSIGHT_QUESTION_SCHEMA_VERSION,
  InsightQuestionContractError,
  validateCompletedQuestion,
  validateInsightQuestionRequest,
  validateQuestionInterpretation,
  validateTeacherQuestionResponse,
} from './questionContracts.js'
import { InsightQuestionEvidenceError } from './questionEvidenceAdapter.js'
import {
  QUESTION_ANSWER_MAX_OUTPUT_TOKENS,
  QUESTION_ANSWER_MAX_THINKING_TOKENS,
  QUESTION_ANSWER_WRITER_SCHEMA_VERSION,
} from './geminiQuestionAdapter.js'

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
        ['question-ambiguous', 'question-sensitive', 'category-sensitive'].includes(error.category)
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
        calculated: calculateGroundedAnswer({
          kind: replay.kind,
          plan: replay.plan,
          guidance: replay.guidance,
          evidence: envelope.answerEvidence,
        }),
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
      const calculated = calculateGroundedAnswer({
        kind: interpretation.kind,
        plan: interpretation.plan,
        guidance: interpretation.guidance,
        evidence: envelope.answerEvidence,
      })
      let finalAnswer = calculated.answer
      let combinedUsage = interpretation.usage
      if (shouldWriteNaturalAnswer(deps.answerWriter, interpretation)) {
        try {
          const writerInput = buildAnswerWriterInput({
            request,
            envelope,
            interpretation,
          })
          const written = validateWrittenAnswerResult(
            await deps.answerWriter.writeAnswer({ writerInput }),
            writerInput,
          )
          finalAnswer = restoreStudentAliases(written.answer, envelope.answerEvidence)
          combinedUsage = combineProviderUsage(interpretation.usage, written.usage)
        } catch {
          await retainWorstCaseReservation(deps.usageLedger, {
            reservationId: acceptedReservation.reservationId,
            requestId: request.requestId,
            worstCaseCostMicroUsd: quote.worstCaseCostMicroUsd,
          })
          return buildTeacherResponse({
            calculated,
            envelope,
            generatedAt: now.toISOString(),
            usage: Object.freeze({
              ...interpretation.usage,
              costMicroUsd: quote.worstCaseCostMicroUsd,
            }),
          })
        }
      }
      const actualCostMicroUsd = validateActualCost(
        await deps.priceActualUsage({
          rateCardId: quote.rateCardId,
          usage: combinedUsage,
        }),
        quote.worstCaseCostMicroUsd,
      )
      const billedUsage = Object.freeze({
        ...combinedUsage,
        costMicroUsd: actualCostMicroUsd,
      })
      const completed = Object.freeze({
        schemaVersion: INSIGHT_QUERY_PLAN_SCHEMA_VERSION,
        source: 'provider-interpreted',
        periodDays: request.periodDays,
        evidenceSignature: envelope.evidenceSignature,
        generatedAt: now.toISOString(),
        kind: interpretation.kind,
        plan: interpretation.plan,
        guidance: interpretation.guidance,
        usage: billedUsage,
      })
      const teacherResponse = buildTeacherResponse({
        calculated,
        finalAnswer,
        envelope,
        generatedAt: completed.generatedAt,
        usage: billedUsage,
      })
      await deps.usageLedger.commit({
        reservationId: acceptedReservation.reservationId,
        requestId: request.requestId,
        actualCostMicroUsd,
        result: completed,
      })
      return teacherResponse
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
      if (error instanceof InsightQuestionAnswerError) {
        throw new InsightQuestionServiceError('answer-unavailable', 'The classroom records could not produce a safe answer.')
      }
      if (error instanceof InsightQuestionServiceError) throw error
      throw new InsightQuestionServiceError('provider-unavailable', 'AI question interpretation is unavailable.')
    }
  }
}

function buildTeacherResponse({ calculated, finalAnswer = calculated.answer, envelope, generatedAt, usage }) {
  try {
    return validateTeacherQuestionResponse({
      schemaVersion: INSIGHT_QUESTION_SCHEMA_VERSION,
      source: 'ai-grounded',
      periodDays: envelope.answerEvidence.periodDays,
      generatedAt,
      answer: finalAnswer,
      evidence: calculated.evidence,
      usage,
    })
  } catch (error) {
    if (error instanceof InsightQuestionContractError) {
      throw new InsightQuestionServiceError('answer-unavailable', 'The classroom records could not produce a safe answer.')
    }
    throw error
  }
}

function calculateGroundedAnswer(input) {
  try {
    return calculateQuestionAnswer(input)
  } catch (error) {
    if (error instanceof InsightQuestionAnswerError) {
      throw new InsightQuestionServiceError('answer-unavailable', 'The classroom records could not produce a safe answer.')
    }
    throw error
  }
}

function shouldWriteNaturalAnswer(answerWriter, interpretation) {
  if (!isPlainObject(answerWriter) || typeof answerWriter.writeAnswer !== 'function') return false
  if (!['query', 'query-and-guidance'].includes(interpretation.kind)) return false
  return interpretation.plan?.operation !== 'list-student-balances'
}

function buildAnswerWriterInput({ request, envelope, interpretation }) {
  const safeCalculated = calculateGroundedAnswer({
    kind: interpretation.kind,
    plan: interpretation.plan,
    guidance: interpretation.guidance,
    evidence: deidentifyAnswerEvidence(envelope.answerEvidence),
  })
  const providerQuestion = envelope.providerInput.question
  const studentAliases = collectStudentAliases([
    providerQuestion,
    safeCalculated.answer,
    ...safeCalculated.evidence,
  ])
  const evidenceAliases = new Set(envelope.answerEvidence.participants.map(participant => participant.alias))
  if (studentAliases.some(alias => !evidenceAliases.has(alias))) {
    throw new InsightQuestionServiceError(
      'evidence-not-deidentified',
      'The grounded answer-writing input contains an unapproved student alias.',
    )
  }
  return Object.freeze({
    schemaVersion: QUESTION_ANSWER_WRITER_SCHEMA_VERSION,
    question: providerQuestion,
    draftAnswer: safeCalculated.answer,
    details: safeCalculated.evidence,
    studentAliases: Object.freeze(studentAliases),
    periodDays: request.periodDays,
  })
}

function deidentifyAnswerEvidence(evidence) {
  const aliasById = new Map(evidence.participants.map(participant => (
    [participant.id, participant.alias]
  )))
  return Object.freeze({
    ...evidence,
    participants: Object.freeze(evidence.participants.map(participant => Object.freeze({
      ...participant,
      name: `[${participant.alias}]`,
    }))),
    students: Object.freeze(evidence.students.map(student => Object.freeze({
      ...student,
      name: `[${aliasById.get(student.id) || student.alias}]`,
    }))),
  })
}

function collectStudentAliases(values) {
  const aliases = []
  const seen = new Set()
  for (const value of values) {
    for (const match of String(value).matchAll(/\[(student-[0-9]{3})\]/gu)) {
      if (seen.has(match[1])) continue
      seen.add(match[1])
      aliases.push(match[1])
    }
  }
  if (aliases.length > 40) {
    throw new InsightQuestionServiceError(
      'answer-unavailable',
      'The grounded answer-writing input contains too many student aliases.',
    )
  }
  return aliases
}

function validateWrittenAnswerResult(value, writerInput) {
  if (!isPlainObject(value) || !hasExactKeys(value, ['schemaVersion', 'answer', 'usage'])) {
    throw new InsightQuestionServiceError('provider-output-invalid', 'The AI answer-writing result is malformed.')
  }
  if (
    value.schemaVersion !== QUESTION_ANSWER_WRITER_SCHEMA_VERSION ||
    typeof value.answer !== 'string' || value.answer.length < 1 || value.answer.length > 480 ||
    value.answer.trim() !== value.answer || hasDisallowedAnswerText(value.answer) ||
    !isPlainObject(value.usage) || !hasExactKeys(
      value.usage,
      ['inputTokens', 'outputTokens', 'thinkingTokens'],
    )
  ) {
    throw new InsightQuestionServiceError('provider-output-invalid', 'The AI answer-writing result is malformed.')
  }
  for (const field of ['inputTokens', 'outputTokens', 'thinkingTokens']) {
    if (!Number.isSafeInteger(value.usage[field]) || value.usage[field] < 0) {
      throw new InsightQuestionServiceError('provider-output-invalid', 'The AI answer-writing usage is malformed.')
    }
  }
  if (
    value.usage.outputTokens > QUESTION_ANSWER_MAX_OUTPUT_TOKENS ||
    value.usage.thinkingTokens > QUESTION_ANSWER_MAX_THINKING_TOKENS
  ) {
    throw new InsightQuestionServiceError('provider-output-invalid', 'The AI answer-writing usage exceeds its reservation.')
  }

  const usedAliases = collectStudentAliases([value.answer])
  if (usedAliases.some(alias => !writerInput.studentAliases.includes(alias))) {
    throw new InsightQuestionServiceError('provider-output-invalid', 'The AI answer contains an unapproved student alias.')
  }
  if (
    writerInput.studentAliases.length === 1 &&
    writerInput.draftAnswer.includes(`[${writerInput.studentAliases[0]}]`) &&
    !usedAliases.includes(writerInput.studentAliases[0])
  ) {
    throw new InsightQuestionServiceError('provider-output-invalid', 'The AI answer omitted the selected student.')
  }
  const withoutApprovedPlaceholders = value.answer.replace(/\[student-[0-9]{3}\]/gu, '')
  if (
    /(?:student|category)-[0-9]{3}/iu.test(withoutApprovedPlaceholders) ||
    /\[(?:student|category)(?:-[0-9]{3})?\]/iu.test(withoutApprovedPlaceholders)
  ) {
    throw new InsightQuestionServiceError('provider-output-invalid', 'The AI answer contains an unsupported alias.')
  }

  const groundingText = `${writerInput.draftAnswer} ${writerInput.details.join(' ')}`
  const allowedNumbers = new Set(numberTokens(groundingText))
  if (numberTokens(withoutApprovedPlaceholders).some(number => !allowedNumbers.has(number))) {
    throw new InsightQuestionServiceError('provider-output-invalid', 'The AI answer contains an unsupported number.')
  }
  return Object.freeze({
    schemaVersion: QUESTION_ANSWER_WRITER_SCHEMA_VERSION,
    answer: value.answer,
    usage: Object.freeze({ ...value.usage }),
  })
}

function hasDisallowedAnswerText(value) {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint === 127 || codePoint < 32
  }) || /(?:https?:\/\/|www\.)/iu.test(value)
}

function numberTokens(value) {
  return String(value).match(/\d+(?:[,.]\d+)*/gu) ?? []
}

function restoreStudentAliases(value, evidence) {
  const namesByAlias = new Map(evidence.participants.map(participant => (
    [participant.alias, participant.name]
  )))
  const restored = value.replace(/\[(student-[0-9]{3})\]/gu, (placeholder, alias) => {
    const name = namesByAlias.get(alias)
    if (typeof name !== 'string' || !name) {
      throw new InsightQuestionServiceError('answer-unavailable', 'The selected student is unavailable.')
    }
    return name
  })
  if (/(?:student|category)-[0-9]{3}|\[(?:student|category)/iu.test(restored)) {
    throw new InsightQuestionServiceError('answer-unavailable', 'The restored answer contains an unresolved alias.')
  }
  return restored
}

function combineProviderUsage(first, second) {
  const combined = {}
  for (const field of ['inputTokens', 'outputTokens', 'thinkingTokens']) {
    const value = first[field] + second[field]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InsightQuestionServiceError('cost-policy-unavailable', 'The combined AI usage is malformed.')
    }
    combined[field] = value
  }
  return Object.freeze(combined)
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
    !isPlainObject(value.allowedAliases) ||
    !hasExactKeys(value.allowedAliases, ['studentAliases', 'categoryAliases']) ||
    !Array.isArray(value.allowedAliases.studentAliases) ||
    !Array.isArray(value.allowedAliases.categoryAliases) ||
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
  const naturalLanguageLeaves = providerNaturalLanguageLeaves(providerInput)
    .map(providerLeafForSensitiveScan)
  const subjectHintLeaves = providerInput.subjectHints.map(hint => providerLeafForSensitiveScan(hint.text))
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
    const singleTokenStudentName = entry.kind === 'student-name' &&
      entry.value.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean).length < 2
    if (singleTokenStudentName) {
      const exactHintPattern = new RegExp(
        `(^|[^\\p{L}\\p{N}])${entry.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`,
        'iu',
      )
      if (subjectHintLeaves.some(leaf => exactHintPattern.test(leaf))) {
        throw new InsightQuestionServiceError(
          'evidence-not-deidentified',
          'The provider subject hints contain a complete student identity.',
        )
      }
    }
    if (
      singleTokenStudentName &&
      naturalLanguageLeaves.some(leaf => containsSeparatorObscuredName(leaf, entry.value))
    ) {
      throw new InsightQuestionServiceError(
        'evidence-not-deidentified',
        'The provider question input contains an obscured sensitive value.',
      )
    }
    if (singleTokenStudentName) continue
    const values = [entry.value]
    for (const sensitive of values) {
      const pattern = new RegExp(
        `(^|[^\\p{L}\\p{N}])${sensitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`,
        'iu',
      )
      const candidates = entry.kind === 'student-name' ? naturalLanguageLeaves : leaves
      if (candidates.some(leaf => pattern.test(leaf))) {
        throw new InsightQuestionServiceError(
          'evidence-not-deidentified',
          'The provider question input contains a declared sensitive value.',
        )
      }
    }
    if (entry.kind === 'student-name') {
      if (naturalLanguageLeaves.some(leaf => (
        containsSeparatorObscuredName(leaf, entry.value) ||
        containsAllSensitiveNameTokens(leaf, entry.value)
      ))) {
        throw new InsightQuestionServiceError(
          'evidence-not-deidentified',
          'The provider question input contains an obscured sensitive value.',
        )
      }
    } else if (
      ['teacher-uid', 'classroom-id'].includes(entry.kind) &&
      collapseSensitiveText(entry.value).length >= 4 &&
      leaves.some(leaf => collapseSensitiveText(leaf).includes(collapseSensitiveText(entry.value)))
    ) {
      throw new InsightQuestionServiceError(
        'evidence-not-deidentified',
        'The provider question input contains an obscured sensitive value.',
      )
    }
  }
}

function providerNaturalLanguageLeaves(providerInput) {
  if (
    typeof providerInput.question !== 'string' ||
    !Array.isArray(providerInput.subjectHints) ||
    providerInput.subjectHints.some(hint => (
      !isPlainObject(hint) ||
      !hasExactKeys(hint, ['text', 'studentAlias']) ||
      typeof hint.text !== 'string' ||
      typeof hint.studentAlias !== 'string'
    )) ||
    !Array.isArray(providerInput.categoryCatalog) ||
    providerInput.categoryCatalog.some(category => !isPlainObject(category) || typeof category.label !== 'string')
  ) {
    throw new InsightQuestionServiceError('evidence-unavailable', 'The provider question input is malformed.')
  }
  // The evidence adapter owns category-label sanitization. Re-scanning those
  // labels against every roster token would turn ordinary category words into
  // false identity leaks. The sanitized question and roster-derived hint text
  // are the only provider fields that may contain teacher-entered name words.
  return [providerInput.question, ...providerInput.subjectHints.map(hint => hint.text)]
}

function containsAllSensitiveNameTokens(value, name) {
  const nameTokens = [...new Set(String(name)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean))]
  if (nameTokens.length < 2) return false
  const valueTokens = new Set(String(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean))
  return nameTokens.every(token => valueTokens.has(token))
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

function containsSeparatorObscuredName(value, name) {
  const nameTokens = String(name)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .split(/[^\p{L}\p{N}]+/u)
    .map(collapseSensitiveText)
    .filter(Boolean)
  if (nameTokens.length === 0) return false
  const maximumCandidateLength = nameTokens.reduce((total, token) => total + token.length, 0)
  const runs = String(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu) ?? []
  for (let start = 0; start < runs.length; start += 1) {
    let candidate = ''
    for (let end = start; end < runs.length; end += 1) {
      candidate += collapseSensitiveText(runs[end])
      if (candidate.length > maximumCandidateLength) break
      if (matchesSensitiveNameCombination(candidate, nameTokens, end - start + 1)) return true
    }
  }
  return false
}

function matchesSensitiveNameCombination(candidate, nameTokens, runCount) {
  const uniqueTokens = [...new Set(nameTokens)]
  if (runCount >= 2 && uniqueTokens.includes(candidate)) return true
  if (uniqueTokens.length === 1) {
    return runCount >= 2 && candidate === uniqueTokens[0]
  }
  const segmentCounts = Array(candidate.length + 1).fill(-1)
  segmentCounts[0] = 0
  for (let index = 0; index < candidate.length; index += 1) {
    if (segmentCounts[index] < 0) continue
    for (const token of uniqueTokens) {
      if (!candidate.startsWith(token, index)) continue
      const nextIndex = index + token.length
      segmentCounts[nextIndex] = Math.max(segmentCounts[nextIndex], segmentCounts[index] + 1)
    }
  }
  const usedCount = segmentCounts[candidate.length]
  return usedCount >= 2
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
    value.answerWriter !== undefined &&
    (!isPlainObject(value.answerWriter) || typeof value.answerWriter.writeAnswer !== 'function')
  ) {
    throw new TypeError('answerWriter.writeAnswer must be a function when supplied.')
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
