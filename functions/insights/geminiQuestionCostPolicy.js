import { Buffer } from 'node:buffer'

import { GEMINI_RATE_CARD } from './geminiCostPolicy.js'
import {
  QUESTION_ANSWER_MAX_OUTPUT_TOKENS,
  QUESTION_ANSWER_MAX_THINKING_TOKENS,
  QUESTION_ANSWER_WRITER_SCHEMA_VERSION,
  QUESTION_MAX_OUTPUT_TOKENS,
  QUESTION_MAX_THINKING_TOKENS,
  buildGeminiAnswerRequest,
  buildGeminiQuestionRequest,
} from './geminiQuestionAdapter.js'
import { GEMINI_RATE_CARD_ID } from './geminiProviderAdapter.js'

const TOKENS_PER_MILLION = 1_000_000
const INPUT_TOKEN_SAFETY_MARGIN = 1_024
const MAXIMUM_ANSWER_WRITER_REQUEST_BYTES = Buffer.byteLength(JSON.stringify(
  buildGeminiAnswerRequest({
    writerInput: {
      schemaVersion: QUESTION_ANSWER_WRITER_SCHEMA_VERSION,
      question: 'q'.repeat(500),
      draftAnswer: 'a'.repeat(3_200),
      details: Array.from({ length: 8 }, () => 'd'.repeat(320)),
      studentAliases: Array.from(
        { length: 40 },
        (_, index) => `student-${String(index + 1).padStart(3, '0')}`,
      ),
      periodDays: 90,
    },
  }),
), 'utf8')

export class GeminiQuestionCostPolicyError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'GeminiQuestionCostPolicyError'
    this.category = category
  }
}

export function quoteGeminiQuestionWorstCaseCost({ providerInput } = {}) {
  const request = buildGeminiQuestionRequest({ providerInput })
  const inputTokens = Buffer.byteLength(JSON.stringify(request), 'utf8') +
    MAXIMUM_ANSWER_WRITER_REQUEST_BYTES +
    (INPUT_TOKEN_SAFETY_MARGIN * 2)
  return Object.freeze({
    rateCardId: GEMINI_RATE_CARD_ID,
    worstCaseCostMicroUsd: price({
      inputTokens,
      billedOutputTokens: QUESTION_MAX_OUTPUT_TOKENS + QUESTION_MAX_THINKING_TOKENS +
        QUESTION_ANSWER_MAX_OUTPUT_TOKENS + QUESTION_ANSWER_MAX_THINKING_TOKENS,
    }),
  })
}

export function priceGeminiQuestionActualUsage({ rateCardId, usage } = {}) {
  if (rateCardId !== GEMINI_RATE_CARD_ID) {
    fail('rate-card-mismatch', 'The AI question rate card is unsupported.')
  }
  if (!isPlainObject(usage) || !hasExactKeys(
    usage,
    ['inputTokens', 'outputTokens', 'thinkingTokens'],
  )) {
    fail('invalid-usage', 'AI question usage is malformed.')
  }
  for (const field of ['inputTokens', 'outputTokens', 'thinkingTokens']) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) {
      fail('invalid-usage', 'AI question usage is malformed.')
    }
  }
  if (
    usage.outputTokens > QUESTION_MAX_OUTPUT_TOKENS + QUESTION_ANSWER_MAX_OUTPUT_TOKENS ||
    usage.thinkingTokens > QUESTION_MAX_THINKING_TOKENS + QUESTION_ANSWER_MAX_THINKING_TOKENS
  ) {
    fail('invalid-usage', 'AI question usage exceeds its reservation.')
  }
  return price({
    inputTokens: usage.inputTokens,
    billedOutputTokens: usage.outputTokens + usage.thinkingTokens,
  })
}

function price({ inputTokens, billedOutputTokens }) {
  const numerator =
    inputTokens * GEMINI_RATE_CARD.inputMicroUsdPerMillionTokens +
    billedOutputTokens * GEMINI_RATE_CARD.billedOutputMicroUsdPerMillionTokens
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    fail('invalid-cost', 'AI question token cost exceeds safe precision.')
  }
  return Math.ceil(numerator / TOKENS_PER_MILLION)
}

function fail(category, message) {
  throw new GeminiQuestionCostPolicyError(category, message)
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
