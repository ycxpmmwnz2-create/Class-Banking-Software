import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GeminiQuestionCostPolicyError,
  priceGeminiQuestionActualUsage,
  quoteGeminiQuestionWorstCaseCost,
} from './geminiQuestionCostPolicy.js'
import { GEMINI_RATE_CARD_ID } from './geminiProviderAdapter.js'

const providerInput = {
  schemaVersion: 7,
  question: 'Who has used the restroom the most?',
  subjectAliases: [],
  subjectHints: [],
  categoryCatalog: [{
    alias: 'category-001',
    label: 'Bathroom break',
    transactionTypes: ['Subtract'],
  }],
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
    { rateCardId: GEMINI_RATE_CARD_ID, usage: { inputTokens: 1, outputTokens: 641, thinkingTokens: 0 } },
    { rateCardId: GEMINI_RATE_CARD_ID, usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 8_193 } },
  ]) {
    assert.throws(() => priceGeminiQuestionActualUsage(input), GeminiQuestionCostPolicyError)
  }
})
