const CLIENT_SAFE_CATEGORIES = Object.freeze(new Set([
  'allowance-exhausted',
  'rate-limit-exhausted',
  'request-unavailable',
  'evidence-unavailable',
  'provider-output-invalid',
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
  'provider-unavailable',
  'answer-unavailable',
  'question-ambiguous',
  'question-sensitive',
  'rate-limit-exhausted',
  'request-unavailable',
  'usage-invalid',
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
  if (category === 'provider-unavailable') return 'unavailable'
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
