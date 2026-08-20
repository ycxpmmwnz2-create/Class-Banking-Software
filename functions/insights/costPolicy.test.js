import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMBINED_MONTHLY_ALLOWANCE_MICRO_USD,
  FIREBASE_MONTHLY_ALLOWANCE_MICRO_USD,
  GEMINI_MONTHLY_ALLOWANCE_MICRO_USD,
  InsightCostPolicyError,
  insightModeProfile,
  utcMonthKey,
  validateActualCost,
  validateWorstCaseQuote,
} from './costPolicy.js'

test('cost policy pins separate Gemini, Firebase, and combined allowances', () => {
  assert.equal(GEMINI_MONTHLY_ALLOWANCE_MICRO_USD, 7_500_000)
  assert.equal(FIREBASE_MONTHLY_ALLOWANCE_MICRO_USD, 5_000_000)
  assert.equal(COMBINED_MONTHLY_ALLOWANCE_MICRO_USD, 12_500_000)
})

test('cost policy pins conservative initial and more-insights limits with minimal-thinking ceiling', () => {
  assert.deepEqual(insightModeProfile('quick'), {
    id: 'quick-economy-v1',
    maxObservations: 4,
    maxEvidenceItems: 12,
    maxInputBytes: 16 * 1024,
    maxOutputTokens: 350,
    maxThinkingTokens: 4_096,
    maxQuestions: 3,
    hourlyRequestLimit: 10,
  })
  assert.deepEqual(insightModeProfile('deep'), {
    id: 'deep-economy-v1',
    maxObservations: 20,
    maxEvidenceItems: 60,
    maxInputBytes: 48 * 1024,
    maxOutputTokens: 900,
    maxThinkingTokens: 4_096,
    maxQuestions: 6,
    hourlyRequestLimit: 2,
  })
  assert.throws(() => insightModeProfile('automatic'), InsightCostPolicyError)
})

test('UTC month keys do not depend on local timezone', () => {
  assert.equal(utcMonthKey('2026-09-01T00:30:00.000+02:00'), '2026-08')
  assert.equal(utcMonthKey('2026-12-31T23:59:59.999Z'), '2026-12')
  assert.throws(() => utcMonthKey('not-a-date'), InsightCostPolicyError)
})

test('trusted worst-case quotes require integer microdollars within the allowance', () => {
  assert.deepEqual(validateWorstCaseQuote({
    rateCardId: 'gemini-economy-2026-08',
    worstCaseCostMicroUsd: 125_000,
  }), {
    rateCardId: 'gemini-economy-2026-08',
    worstCaseCostMicroUsd: 125_000,
  })

  for (const worstCaseCostMicroUsd of [0, 1.5, -1, 7_500_001]) {
    assert.throws(
      () => validateWorstCaseQuote({
        rateCardId: 'gemini-economy-2026-08',
        worstCaseCostMicroUsd,
      }),
      InsightCostPolicyError,
    )
  }
})

test('actual cost cannot exceed the amount reserved before provider invocation', () => {
  assert.equal(validateActualCost(75_000, 125_000), 75_000)
  assert.equal(validateActualCost(125_000, 125_000), 125_000)
  assert.throws(() => validateActualCost(125_001, 125_000), InsightCostPolicyError)
  assert.throws(() => validateActualCost(1.25, 125_000), InsightCostPolicyError)
})
