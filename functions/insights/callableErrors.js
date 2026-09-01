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

// Diagnostic fields are allowlisted by name and re-checked by shape on the way
// out, because a refusal reason is worth nothing if reading it can put a
// child's balance in a log. Every permitted field is a count, a boolean, or a
// fixed vocabulary word -- never a value read from classroom data, and never a
// name. Anything else is dropped rather than truncated or redacted.
const CALLABLE_LOG_DIAGNOSTIC_KIND_WORDS = Object.freeze(new Set([
  'money', 'percent', 'day-count', 'student-count', 'transaction-count', 'count', 'generic',
]))

const CALLABLE_LOG_DIAGNOSTIC_TOOL_NAMES = Object.freeze(new Set([
  'aggregate_transactions',
  'compare_periods',
  'describe_schema',
  'find_students_without_transactions',
  'get_balance_history',
  'get_balances',
  'list_transactions',
]))

const MAX_LOGGED_DIAGNOSTIC_KINDS = 12

const isCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isFlag = value => typeof value === 'boolean'
const isWordFrom = allowed => value => typeof value === 'string' && allowed.has(value)
const isWordListFrom = allowed => value => Array.isArray(value) &&
  value.length <= MAX_LOGGED_DIAGNOSTIC_KINDS &&
  value.every(entry => typeof entry === 'string' && allowed.has(entry))

// Each field is paired with the shape it is allowed to have, so a free-text
// value smuggled under an allowlisted key is dropped rather than logged.
const CALLABLE_LOG_DIAGNOSTIC_FIELDS = Object.freeze(new Map([
  ['claimKind', isWordFrom(CALLABLE_LOG_DIAGNOSTIC_KIND_WORDS)],
  ['numericFactCount', isCount],
  ['numericFactKinds', isWordListFrom(CALLABLE_LOG_DIAGNOSTIC_KIND_WORDS)],
  ['distinctWindowCount', isCount],
  ['returnedCount', isCount],
  ['totalCount', isCount],
  ['disclosureNumbersPresent', isFlag],
  ['disclosureWordPresent', isFlag],
  ['toolName', isWordFrom(CALLABLE_LOG_DIAGNOSTIC_TOOL_NAMES)],
  ['returnedCountUsable', isFlag],
  ['totalCountUsable', isFlag],
]))

export function callableLogDiagnostic(error) {
  if (!CALLABLE_LOG_SUBCATEGORIES.has(error?.subcategory)) return null
  const diagnostic = error?.diagnostic
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return null
  const logged = {}
  for (const [key, value] of Object.entries(diagnostic)) {
    const isAllowed = CALLABLE_LOG_DIAGNOSTIC_FIELDS.get(key)
    if (!isAllowed || !isAllowed(value)) continue
    logged[key] = value
  }
  return Object.keys(logged).length === 0 ? null : Object.freeze(logged)
}
