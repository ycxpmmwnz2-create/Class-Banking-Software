export const GEMINI_MONTHLY_ALLOWANCE_MICRO_USD = 7_500_000
export const FIREBASE_MONTHLY_ALLOWANCE_MICRO_USD = 5_000_000
export const COMBINED_MONTHLY_ALLOWANCE_MICRO_USD = 12_500_000

const MODE_PROFILES = Object.freeze({
  quick: Object.freeze({
    id: 'quick-economy-v1',
    maxObservations: 4,
    maxEvidenceItems: 12,
    maxInputBytes: 16 * 1024,
    maxOutputTokens: 350,
    maxThinkingTokens: 65_536,
    maxQuestions: 3,
    hourlyRequestLimit: 10,
  }),
  deep: Object.freeze({
    id: 'deep-economy-v1',
    maxObservations: 20,
    maxEvidenceItems: 60,
    maxInputBytes: 48 * 1024,
    maxOutputTokens: 900,
    maxThinkingTokens: 65_536,
    maxQuestions: 6,
    hourlyRequestLimit: 2,
  }),
})

export class InsightCostPolicyError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightCostPolicyError'
    this.category = category
  }
}

export function insightModeProfile(mode) {
  const profile = MODE_PROFILES[mode]
  if (!profile) {
    throw new InsightCostPolicyError('invalid-mode', 'Insight mode is unsupported.')
  }
  return profile
}

export function utcMonthKey(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new InsightCostPolicyError('invalid-time', 'A valid time is required.')
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function validateWorstCaseQuote(quote) {
  if (!isPlainObject(quote) || !hasExactKeys(quote, ['rateCardId', 'worstCaseCostMicroUsd'])) {
    throw new InsightCostPolicyError('invalid-quote', 'The trusted cost quote is malformed.')
  }
  const rateCardId = boundedIdentifier(quote.rateCardId, 'rateCardId')
  const worstCaseCostMicroUsd = requireMicroUsd(
    quote.worstCaseCostMicroUsd,
    'worstCaseCostMicroUsd',
  )
  if (worstCaseCostMicroUsd === 0 || worstCaseCostMicroUsd > GEMINI_MONTHLY_ALLOWANCE_MICRO_USD) {
    throw new InsightCostPolicyError(
      'invalid-quote',
      'Worst-case cost must fit inside the Gemini monthly allowance.',
    )
  }
  return Object.freeze({ rateCardId, worstCaseCostMicroUsd })
}

export function validateActualCost(actualCostMicroUsd, reservedCostMicroUsd) {
  const actual = requireMicroUsd(actualCostMicroUsd, 'actualCostMicroUsd')
  const reserved = requireMicroUsd(reservedCostMicroUsd, 'reservedCostMicroUsd')
  if (reserved === 0 || actual > reserved) {
    throw new InsightCostPolicyError(
      'cost-exceeds-reservation',
      'Actual cost exceeds the trusted worst-case reservation.',
    )
  }
  return actual
}

function requireMicroUsd(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InsightCostPolicyError('invalid-cost', `${label} must be non-negative integer microdollars.`)
  }
  return value
}

function boundedIdentifier(value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 80 ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(value)
  ) {
    throw new InsightCostPolicyError('invalid-quote', `${label} is malformed.`)
  }
  return value
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
