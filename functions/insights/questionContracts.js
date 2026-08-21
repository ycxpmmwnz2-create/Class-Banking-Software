export const INSIGHT_QUESTION_SCHEMA_VERSION = 1

export const INSIGHT_QUESTION_INTENTS = Object.freeze([
  'student-top-earning-category',
  'student-top-spending-category',
  'class-top-earning-category',
  'class-top-spending-category',
  'student-peak-earning-time',
  'student-peak-spending-time',
  'class-peak-earning-time',
  'class-peak-spending-time',
  'student-current-balance',
  'highest-current-balance',
  'lowest-current-balance',
  'student-total-earned',
  'student-total-spent',
  'student-net-change',
  'class-total-earned',
  'class-total-spent',
  'class-net-change',
  'pending-request-count',
  'unsupported',
])

const SUBJECT_INTENTS = new Set(INSIGHT_QUESTION_INTENTS.filter(intent => (
  intent.startsWith('student-')
)))
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const SUBJECT_ALIAS_PATTERN = /^student-[0-9]{3}$/
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/
const PERIODS = Object.freeze([7, 30, 90])

export class InsightQuestionContractError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightQuestionContractError'
    this.category = category
  }
}

export function validateInsightQuestionRequest(value) {
  requireExactObject(
    value,
    ['requestId', 'kind', 'periodDays', 'timeZone', 'question'],
    'question request',
  )
  if (!REQUEST_ID_PATTERN.test(value.requestId) || value.kind !== 'question') {
    fail('invalid-request', 'The question request identity is malformed.')
  }
  if (!PERIODS.includes(value.periodDays)) {
    fail('invalid-request', 'The question period is unsupported.')
  }
  const question = boundedText(value.question, 3, 500, 'question')
  const timeZone = canonicalTimeZone(value.timeZone)
  return Object.freeze({
    requestId: value.requestId,
    kind: 'question',
    periodDays: value.periodDays,
    timeZone,
    question,
  })
}

function canonicalTimeZone(value) {
  const timeZone = boundedText(value, 1, 80, 'timeZone')
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    fail('invalid-request', 'The question time zone is unsupported.')
  }
}

export function validateQuestionInterpretation(value, allowedAliases) {
  requireExactObject(
    value,
    ['schemaVersion', 'intent', 'subjectAlias', 'usage'],
    'question interpretation',
    'invalid-provider-output',
  )
  if (
    value.schemaVersion !== INSIGHT_QUESTION_SCHEMA_VERSION ||
    !INSIGHT_QUESTION_INTENTS.includes(value.intent)
  ) {
    fail('invalid-provider-output', 'The question intent is unsupported.')
  }
  if (!Array.isArray(allowedAliases) || allowedAliases.some(alias => !SUBJECT_ALIAS_PATTERN.test(alias))) {
    fail('invalid-provider-output', 'The allowed question subjects are malformed.')
  }
  const subjectAlias = validateIntentSubject(
    value.intent,
    value.subjectAlias,
    allowedAliases,
    'invalid-provider-output',
  )
  return Object.freeze({
    schemaVersion: INSIGHT_QUESTION_SCHEMA_VERSION,
    intent: value.intent,
    subjectAlias,
    usage: validateProviderUsage(value.usage),
  })
}

export function validateCompletedQuestion(value, expected) {
  requireExactObject(
    value,
    [
      'schemaVersion',
      'source',
      'periodDays',
      'evidenceSignature',
      'generatedAt',
      'intent',
      'subjectAlias',
      'usage',
    ],
    'completed question',
    'invalid-replay',
  )
  if (
    value.schemaVersion !== INSIGHT_QUESTION_SCHEMA_VERSION ||
    value.source !== 'provider-interpreted' ||
    value.periodDays !== expected.periodDays ||
    value.evidenceSignature !== expected.evidenceSignature ||
    !SIGNATURE_PATTERN.test(value.evidenceSignature)
  ) {
    fail('invalid-replay', 'The stored question does not match current evidence.')
  }
  requireIsoTimestamp(value.generatedAt, 'generatedAt', 'invalid-replay')
  if (!INSIGHT_QUESTION_INTENTS.includes(value.intent)) {
    fail('invalid-replay', 'The stored question intent is unsupported.')
  }
  return Object.freeze({
    schemaVersion: INSIGHT_QUESTION_SCHEMA_VERSION,
    intent: value.intent,
    subjectAlias: validateIntentSubject(
      value.intent,
      value.subjectAlias,
      expected.allowedAliases,
      'invalid-replay',
    ),
    usage: validateBilledUsage(value.usage, 'invalid-replay'),
  })
}

export function validateTeacherQuestionResponse(value) {
  requireExactObject(
    value,
    ['schemaVersion', 'source', 'periodDays', 'generatedAt', 'answer', 'evidence', 'usage'],
    'question response',
  )
  if (
    value.schemaVersion !== INSIGHT_QUESTION_SCHEMA_VERSION ||
    value.source !== 'ai-grounded' ||
    !PERIODS.includes(value.periodDays)
  ) {
    fail('invalid-response', 'The question response metadata is malformed.')
  }
  requireIsoTimestamp(value.generatedAt, 'generatedAt', 'invalid-response')
  const answer = boundedText(value.answer, 1, 500, 'answer', 'invalid-response')
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 4) {
    fail('invalid-response', 'The question evidence is malformed.')
  }
  return Object.freeze({
    schemaVersion: INSIGHT_QUESTION_SCHEMA_VERSION,
    source: 'ai-grounded',
    periodDays: value.periodDays,
    generatedAt: value.generatedAt,
    answer,
    evidence: Object.freeze(value.evidence.map((item) => (
      boundedText(item, 1, 320, 'evidence', 'invalid-response')
    ))),
    usage: validateBilledUsage(value.usage, 'invalid-response'),
  })
}

function validateProviderUsage(value) {
  requireExactObject(
    value,
    ['inputTokens', 'outputTokens', 'thinkingTokens'],
    'question usage',
    'invalid-provider-output',
  )
  const result = {}
  for (const field of ['inputTokens', 'outputTokens', 'thinkingTokens']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      fail('invalid-provider-output', 'Question usage is malformed.')
    }
    result[field] = value[field]
  }
  if (result.outputTokens > 96 || result.thinkingTokens > 4_096) {
    fail('invalid-provider-output', 'Question usage exceeds the reviewed limits.')
  }
  return Object.freeze(result)
}

function validateBilledUsage(value, category) {
  requireExactObject(
    value,
    ['inputTokens', 'outputTokens', 'thinkingTokens', 'costMicroUsd'],
    'question usage',
    category,
  )
  const result = {}
  for (const field of ['inputTokens', 'outputTokens', 'thinkingTokens', 'costMicroUsd']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      fail(category, 'Question usage is malformed.')
    }
    result[field] = value[field]
  }
  if (
    result.outputTokens > 96 ||
    result.thinkingTokens > 4_096 ||
    result.costMicroUsd > 7_500_000
  ) {
    fail(category, 'Question usage exceeds the reviewed limits.')
  }
  return Object.freeze(result)
}

function validateIntentSubject(intent, subjectAlias, allowedAliases, category) {
  if (SUBJECT_INTENTS.has(intent)) {
    if (!SUBJECT_ALIAS_PATTERN.test(subjectAlias) || !allowedAliases.includes(subjectAlias)) {
      fail(category, 'The question subject is unsupported.')
    }
    return subjectAlias
  }
  if (subjectAlias !== null) {
    fail(category, 'A class-level question cannot select a student.')
  }
  return null
}

function requireIsoTimestamp(value, label, category) {
  const date = new Date(value)
  if (typeof value !== 'string' || !Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail(category, `${label} is malformed.`)
  }
}

function boundedText(value, minimum, maximum, label, category = 'invalid-request') {
  const hasDisallowedControl = typeof value === 'string' && [...value].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint === 127 || (codePoint < 32 && ![9, 10, 13].includes(codePoint))
  })
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value ||
    hasDisallowedControl
  ) {
    fail(category, `${label} is malformed.`)
  }
  return value
}

function requireExactObject(value, expected, label, category = 'invalid-request') {
  if (!isPlainObject(value) || !hasExactKeys(value, expected)) {
    fail(category, `${label} has an unexpected shape.`)
  }
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

function fail(category, message) {
  throw new InsightQuestionContractError(category, message)
}
