import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import { insightModeProfile } from './costPolicy.js'
import {
  GEMINI_RATE_CARD,
  GeminiCostPolicyError,
  priceGeminiActualUsage,
  quoteGeminiWorstCaseCost,
} from './geminiCostPolicy.js'
import { buildGeminiGenerateRequest } from './geminiProviderAdapter.js'

function factPacket(summary = 'One verified request met the local threshold.') {
  return {
    schemaVersion: 2,
    mode: 'quick',
    periodDays: 30,
    generatedAt: '2026-08-19T18:00:00.000Z',
    metrics: {
      studentCount: 2,
      transactionCount: 3,
      approvedCount: 2,
      pendingCount: 1,
      totalClassCash: 70,
    },
    observations: [{
      id: 'obs-001',
      priority: 'attention',
      category: 'Needs attention',
      title: 'One request needs review',
      summary,
      evidence: [{ id: 'ev-001', text: 'One verified request met the local threshold.' }],
    }],
  }
}

test('pins regular Gemini 3.6 Flash at the conservative post-promotion ceiling', () => {
  assert.deepEqual(GEMINI_RATE_CARD, {
    id: 'gemini-3.6-flash-standard-ceiling-2027-01-01',
    model: 'gemini-3.6-flash',
    effectiveDate: '2027-01-01',
    inputMicroUsdPerMillionTokens: 1_500_000,
    billedOutputMicroUsdPerMillionTokens: 7_500_000,
  })
})

test('worst-case quote covers the complete serialized request plus safety margin', () => {
  const profile = insightModeProfile('quick')
  const packet = factPacket()
  const shorter = quoteGeminiWorstCaseCost({ modeProfile: profile, factPacket: packet })
  const longer = quoteGeminiWorstCaseCost({
    modeProfile: profile,
    factPacket: factPacket('x'.repeat(300)),
  })
  const request = buildGeminiGenerateRequest({
    providerProfile: profile.id,
    maxOutputTokens: profile.maxOutputTokens,
    factPacket: packet,
  })
  const conservativeInputTokens = Buffer.byteLength(JSON.stringify(request), 'utf8') + 1_024
  const expectedWorstCaseCostMicroUsd = Math.ceil((
    conservativeInputTokens * GEMINI_RATE_CARD.inputMicroUsdPerMillionTokens +
    (profile.maxOutputTokens + 4_096) *
      GEMINI_RATE_CARD.billedOutputMicroUsdPerMillionTokens
  ) / 1_000_000)
  const maximumAcceptedActualCostMicroUsd = priceGeminiActualUsage({
    rateCardId: GEMINI_RATE_CARD.id,
    modeProfile: profile,
    usage: {
      inputTokens: conservativeInputTokens,
      outputTokens: profile.maxOutputTokens,
      thinkingTokens: 4_096,
    },
  })

  assert.equal(shorter.rateCardId, GEMINI_RATE_CARD.id)
  assert.equal(shorter.worstCaseCostMicroUsd, expectedWorstCaseCostMicroUsd)
  assert.equal(shorter.worstCaseCostMicroUsd, maximumAcceptedActualCostMicroUsd)
  assert.ok(shorter.worstCaseCostMicroUsd < 7_500_000)
  assert.ok(longer.worstCaseCostMicroUsd > shorter.worstCaseCostMicroUsd)
})

test('actual price bills visible and thinking output at the same output rate', () => {
  const cost = priceGeminiActualUsage({
    rateCardId: GEMINI_RATE_CARD.id,
    modeProfile: insightModeProfile('deep'),
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 200,
      thinkingTokens: 200,
    },
  })
  assert.equal(cost, 1_503_000)
})

test('actual usage cannot exceed either visible or conservative thinking reservation', () => {
  assert.throws(
    () => priceGeminiActualUsage({
      rateCardId: GEMINI_RATE_CARD.id,
      modeProfile: insightModeProfile('quick'),
      usage: { inputTokens: 100, outputTokens: 300, thinkingTokens: 4_097 },
    }),
    error => error instanceof GeminiCostPolicyError && error.category === 'invalid-usage',
  )
  assert.throws(
    () => priceGeminiActualUsage({
      rateCardId: 'browser-selected-rate',
      modeProfile: insightModeProfile('quick'),
      usage: { inputTokens: 100, outputTokens: 30, thinkingTokens: 20 },
    }),
    error => error instanceof GeminiCostPolicyError && error.category === 'rate-card-mismatch',
  )
})
