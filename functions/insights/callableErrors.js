const CLIENT_SAFE_CATEGORIES = Object.freeze(new Set([
  'allowance-exhausted',
  'rate-limit-exhausted',
  'request-unavailable',
  'evidence-unavailable',
  'provider-output-invalid',
  'provider-output-truncated',
  'answer-unverified',
  'tool-output-too-large',
  'provider-rate-limited',
  'answer-unavailable',
  'question-ambiguous',
  'question-sensitive',
]))

const LOG_CATEGORIES = Object.freeze(new Set([
  'allowance-exhausted',
  'authorization-failed',
  'budget-unavailable',
  'cost-policy-unavailable',
  'evidence-not-deidentified',
  'evidence-unavailable',
  'invalid-replay',
  'invalid-request',
  'invalid-runtime',
  'invalid-shape',
  'invalid-time',
  'provider-output-invalid',
  'provider-output-truncated',
  'answer-unverified',
  'tool-output-too-large',
  'provider-authentication-failed',
  'provider-rate-limited',
  'provider-request-rejected',
  'provider-timeout',
  'provider-unavailable',
  'answer-unavailable',
  'question-ambiguous',
  'question-sensitive',
  'rate-limit-exhausted',
  'request-unavailable',
  'usage-invalid',
]))

export const CALLABLE_LOG_SUBCATEGORIES = Object.freeze(new Set([
  'answer-shape',
  'answer-contact-pattern',
  'answer-opaque-ref',
  'evidence-call-ids',
  'fact-refs-shape',
  'fact-ref-duplicate',
  'fact-ref-unsafe-path',
  'fact-ref-unavailable',
  'fact-ref-non-scalar',
  'number-words',
  'unsupported-number',
  'unsupported-date',
  'uncited-roster-name',
  'truncation-not-disclosed',
  'quoted-span-unverified',
]))

export function callableErrorCode(error) {
  const category = typeof error?.category === 'string' ? error.category : ''
  if (category === 'authorization-failed') return 'unauthenticated'
  if (
    category === 'invalid-request' ||
    category === 'invalid-shape' ||
    category === 'question-ambiguous' ||
    category === 'question-sensitive'
  ) return 'invalid-argument'
  if (
    category === 'allowance-exhausted' ||
    category === 'budget-unavailable' ||
    category === 'rate-limit-exhausted'
  ) return 'resource-exhausted'
  if (category === 'request-unavailable') return 'failed-precondition'
  if (category === 'provider-rate-limited') return 'resource-exhausted'
  if (category === 'provider-unavailable' || category === 'provider-timeout') return 'unavailable'
  if (category === 'invalid-runtime' || category === 'invalid-replay') {
    return 'failed-precondition'
  }
  return 'internal'
}

export function callableErrorDetails(error) {
  const category = typeof error?.category === 'string' ? error.category : ''
  if (!CLIENT_SAFE_CATEGORIES.has(category)) return undefined
  return Object.freeze({ category })
}

export function callableLogCategory(error) {
  return LOG_CATEGORIES.has(error?.category) ? error.category : 'internal'
}

export function callableLogSubcategory(error) {
  return CALLABLE_LOG_SUBCATEGORIES.has(error?.subcategory) ? error.subcategory : null
}
