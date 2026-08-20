import { Buffer } from 'node:buffer'

import {
  GEMINI_RATE_CARD_ID,
  buildGeminiGenerateRequest,
} from './geminiProviderAdapter.js'

const TOKENS_PER_MILLION = 1_000_000
// Reserve against the published post-promotion ceiling so the application
// remains fail-closed when temporary pricing expires.
const INPUT_MICRO_USD_PER_MILLION_TOKENS = 1_500_000
const BILLED_OUTPUT_MICRO_USD_PER_MILLION_TOKENS = 7_500_000
const INPUT_TOKEN_SAFETY_MARGIN = 1_024

export const GEMINI_RATE_CARD = Object.freeze({
  id: GEMINI_RATE_CARD_ID,
  model: 'gemini-3.6-flash',
  effectiveDate: '2027-01-01',
  inputMicroUsdPerMillionTokens: INPUT_MICRO_USD_PER_MILLION_TOKENS,
  billedOutputMicroUsdPerMillionTokens: BILLED_OUTPUT_MICRO_USD_PER_MILLION_TOKENS,
})

export class GeminiCostPolicyError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'GeminiCostPolicyError'
    this.category = category
  }
}

export function quoteGeminiWorstCaseCost({ modeProfile, factPacket } = {}) {
  assertModeProfile(modeProfile)
  const request = buildGeminiGenerateRequest({
    providerProfile: modeProfile.id,
    maxOutputTokens: modeProfile.maxOutputTokens,
    factPacket,
  })
  const serializedRequestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  const conservativeInputTokens = serializedRequestBytes + INPUT_TOKEN_SAFETY_MARGIN
  return Object.freeze({
    rateCardId: GEMINI_RATE_CARD_ID,
    worstCaseCostMicroUsd: priceTokens({
      inputTokens: conservativeInputTokens,
      billedOutputTokens: modeProfile.maxOutputTokens + modeProfile.maxThinkingTokens,
    }),
  })
}

export function priceGeminiActualUsage({ rateCardId, modeProfile, usage } = {}) {
  if (rateCardId !== GEMINI_RATE_CARD_ID) {
    fail('rate-card-mismatch', 'The Gemini rate card does not match the reviewed price.')
  }
  assertModeProfile(modeProfile)
  if (!isPlainObject(usage) || !hasExactKeys(
    usage,
    ['inputTokens', 'outputTokens', 'thinkingTokens'],
  )) {
    fail('invalid-usage', 'Gemini usage does not match the reviewed contract.')
  }
  for (const key of ['inputTokens', 'outputTokens', 'thinkingTokens']) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) {
      fail('invalid-usage', `${key} must be a non-negative safe integer.`)
    }
  }
  const billedOutputTokens = usage.outputTokens + usage.thinkingTokens
  if (
    !Number.isSafeInteger(billedOutputTokens) ||
    usage.outputTokens > modeProfile.maxOutputTokens ||
    usage.thinkingTokens > modeProfile.maxThinkingTokens
  ) {
    fail('invalid-usage', 'Gemini usage exceeds a reserved output-token limit.')
  }
  return priceTokens({ inputTokens: usage.inputTokens, billedOutputTokens })
}

function priceTokens({ inputTokens, billedOutputTokens }) {
  const numerator =
    inputTokens * INPUT_MICRO_USD_PER_MILLION_TOKENS +
    billedOutputTokens * BILLED_OUTPUT_MICRO_USD_PER_MILLION_TOKENS
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    fail('invalid-cost', 'Gemini token cost exceeds safe integer precision.')
  }
  return Math.ceil(numerator / TOKENS_PER_MILLION)
}

function assertModeProfile(value) {
  if (
    !isPlainObject(value) ||
    (value.id !== 'quick-economy-v1' && value.id !== 'deep-economy-v1') ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < 1 ||
    value.maxThinkingTokens !== 4_096
  ) {
    fail('invalid-profile', 'The Gemini mode profile is malformed.')
  }
}

function fail(category, message) {
  throw new GeminiCostPolicyError(category, message)
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
