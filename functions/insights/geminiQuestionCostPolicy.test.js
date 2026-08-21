import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GeminiQuestionCostPolicyError,
  priceGeminiQuestionActualUsage,
  quoteGeminiQuestionWorstCaseCost,
} from './geminiQuestionCostPolicy.js'
import { GEMINI_RATE_CARD_ID } from './geminiProviderAdapter.js'

const providerInput = {
  schemaVersion: 1,
  question: 'What category is [student-001] earning the most money in?',
  subjectAliases: ['student-001'],
  periodDays: 30,
}

test('question quote covers the complete structured request and minimal-thinking ceiling', () => {
  const quote = quoteGeminiQuestionWorstCaseCost({ providerInput })
  assert.equal(quote.rateCardId, GEMINI_RATE_CARD_ID)
  assert.ok(quote.worstCaseCostMicroUsd > 0)
  assert.ok(quote.worstCaseCostMicroUsd < 7_500_000)
  const longer = quoteGeminiQuestionWorstCaseCost({
    providerInput: { ...providerInput, question: 'x'.repeat(500) },
  })
  assert.ok(longer.worstCaseCostMicroUsd > quote.worstCaseCostMicroUsd)
})

test('question pricing rejects mismatched cards and usage above either output ceiling', () => {
  assert.ok(priceGeminiQuestionActualUsage({
    rateCardId: GEMINI_RATE_CARD_ID,
    usage: { inputTokens: 1_000, outputTokens: 20, thinkingTokens: 10 },
  }) > 0)
  for (const input of [
    { rateCardId: 'browser-selected', usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 } },
    { rateCardId: GEMINI_RATE_CARD_ID, usage: { inputTokens: 1, outputTokens: 97, thinkingTokens: 0 } },
    { rateCardId: GEMINI_RATE_CARD_ID, usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 4_097 } },
  ]) {
    assert.throws(() => priceGeminiQuestionActualUsage(input), GeminiQuestionCostPolicyError)
  }
})
