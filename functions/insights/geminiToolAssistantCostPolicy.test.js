import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GeminiToolAssistantCostPolicyError,
  priceGeminiToolAssistantActualUsage,
  quoteGeminiToolAssistantWorstCaseCost,
} from './geminiToolAssistantCostPolicy.js'
import {
  CLASSROOM_ASSISTANT_MAX_BILLED_OUTPUT_TOKENS,
  CLASSROOM_ASSISTANT_MAX_BILLED_THINKING_TOKENS,
} from './classroomAssistantUsageContract.js'
import { GEMINI_RATE_CARD_ID } from './geminiProviderAdapter.js'

const EVIDENCE = Object.freeze({
  question: 'Which students are currently negative?',
  generatedAt: '2026-08-27T18:00:00.000Z',
  asOfDate: '2026-08-27',
  timeZone: 'America/Denver',
  periodDays: 7,
  periodStart: '2026-08-20T18:00:00.000Z',
  historyStart: '2026-05-29T18:00:00.000Z',
  configuredRentAmount: 10,
  students: Object.freeze([
    Object.freeze({ ref: 'student-001', displayName: 'Ava', current: true, balance: -2, frozen: false }),
  ]),
  categories: Object.freeze([]),
  transactions: Object.freeze([]),
})

test('tool-assistant quote covers the bounded multi-turn loop and actual usage', () => {
  const quote = quoteGeminiToolAssistantWorstCaseCost({ assistantEvidence: EVIDENCE })
  assert.equal(quote.rateCardId, GEMINI_RATE_CARD_ID)
  const actual = priceGeminiToolAssistantActualUsage({
    rateCardId: quote.rateCardId,
    usage: { inputTokens: 2_000, outputTokens: 500, thinkingTokens: 100 },
  })
  assert.equal(Number.isSafeInteger(quote.worstCaseCostMicroUsd), true)
  assert.equal(actual > 0, true)
  assert.equal(actual <= quote.worstCaseCostMicroUsd, true)
})

test('tool-assistant actual pricing rejects a mismatched card and over-limit output', () => {
  assert.throws(
    () => priceGeminiToolAssistantActualUsage({
      rateCardId: 'wrong',
      usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 1 },
    }),
    GeminiToolAssistantCostPolicyError,
  )
  assert.throws(
    () => priceGeminiToolAssistantActualUsage({
      rateCardId: GEMINI_RATE_CARD_ID,
      usage: { inputTokens: 1, outputTokens: 8_193, thinkingTokens: 0 },
    }),
    GeminiToolAssistantCostPolicyError,
  )
})

test('tool-assistant actual pricing accepts each exact accumulated usage ceiling', () => {
  assert.equal(priceGeminiToolAssistantActualUsage({
    rateCardId: GEMINI_RATE_CARD_ID,
    usage: {
      inputTokens: 1,
      outputTokens: CLASSROOM_ASSISTANT_MAX_BILLED_OUTPUT_TOKENS,
      thinkingTokens: CLASSROOM_ASSISTANT_MAX_BILLED_THINKING_TOKENS,
    },
  }) > 0, true)
  assert.throws(() => priceGeminiToolAssistantActualUsage({
    rateCardId: GEMINI_RATE_CARD_ID,
    usage: {
      inputTokens: 1,
      outputTokens: CLASSROOM_ASSISTANT_MAX_BILLED_OUTPUT_TOKENS,
      thinkingTokens: CLASSROOM_ASSISTANT_MAX_BILLED_THINKING_TOKENS + 1,
    },
  }), GeminiToolAssistantCostPolicyError)
})
