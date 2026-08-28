export const INSIGHT_QUESTION_SCHEMA_VERSION = 2
export const INSIGHT_QUERY_PLAN_SCHEMA_VERSION = 8

export const INSIGHT_QUERY_DATASETS = Object.freeze(['transactions', 'students', 'balance-history'])
export const INSIGHT_QUERY_METRICS = Object.freeze([
  'count',
  'distinct-days',
  'distinct-values',
  'amount-total',
  'amount-average',
  'net-amount',
  'current-balance',
  'average-balance',
  'closing-balance',
])
export const INSIGHT_QUERY_GROUPS = Object.freeze([
  'none',
  'student',
  'category',
  'transaction-type',
  'status',
  'amount',
  'purpose',
  'time-of-day',
  'calendar-day',
  'day-of-week',
  'week',
  'composite',
])
export const INSIGHT_QUERY_ORDERS = Object.freeze(['highest', 'lowest', 'chronological'])
export const INSIGHT_QUERY_DIMENSIONS = Object.freeze([
  'student',
  'category',
  'transaction-type',
  'status',
  'amount',
  'purpose',
  'time-of-day',
  'calendar-day',
  'day-of-week',
  'week',
])
export const INSIGHT_QUERY_COMPARATORS = Object.freeze([
  'greater-than',
  'at-least',
  'equal',
  'at-most',
  'less-than',
])

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const SUBJECT_ALIAS_PATTERN = /^student-[0-9]{3}$/
const CATEGORY_ALIAS_PATTERN = /^category-[0-9]{3}$/
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/
const PERIODS = Object.freeze([7, 30, 90])
const TRANSACTION_TYPES = Object.freeze(['Add', 'Subtract', 'any'])
const TRANSACTION_STATUSES = Object.freeze(['Approved', 'Pending', 'Denied', 'any'])
const TIME_BUCKETS = Object.freeze(['morning', 'afternoon', 'evening', 'night'])
const STUDENT_STATES = Object.freeze(['active', 'frozen', 'any'])
const BALANCE_CONDITIONS = Object.freeze(['any', 'negative', 'zero', 'positive', 'nonpositive'])
const TRANSACTION_PURPOSES = Object.freeze(['any', 'rent', 'other'])
const DATE_SCOPES = Object.freeze([
  'period',
  'today',
  'yesterday',
  'today-and-yesterday',
  'this-week',
])
const MIN_LOOKBACK_DAYS = 1
const MAX_LOOKBACK_DAYS = 90
const MAX_EXACT_AMOUNT = 1_000_000
const MIN_GUIDANCE_LENGTH = 20
const MAX_GUIDANCE_LENGTH = 480
const MAX_TEACHER_QUESTION_ANSWER_LENGTH = 80_000
const MAX_INTERPRETATION_OUTPUT_TOKENS = 512
const MAX_INTERPRETATION_THINKING_TOKENS = 4_096
const MAX_BILLED_OUTPUT_TOKENS = 8_192
const MAX_BILLED_THINKING_TOKENS = 16_384
const PROVIDER_ALIAS_PATTERN = /(?:student|category)-[0-9]{3}/iu
const PROVIDER_PLACEHOLDER_PATTERN = /\[(?:student|category)(?:-[0-9]{3})?\]/iu
const URL_PATTERN = /(?:https?:\/\/|www\.)/iu

export class InsightQuestionContractError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightQuestionContractError'
    this.category = category
  }
}

export function validateInsightQuestionRequest(value) {
  requireExactObject(
    value,
    ['requestId', 'kind', 'periodDays', 'timeZone', 'question'],
    'question request',
  )
  if (!REQUEST_ID_PATTERN.test(value.requestId) || value.kind !== 'question') {
    fail('invalid-request', 'The question request identity is malformed.')
  }
  if (!PERIODS.includes(value.periodDays)) {
    fail('invalid-request', 'The question period is unsupported.')
  }
  const question = boundedText(value.question, 3, 500, 'question')
  const timeZone = canonicalTimeZone(value.timeZone)
  return Object.freeze({
    requestId: value.requestId,
    kind: 'question',
    periodDays: value.periodDays,
    timeZone,
    question,
  })
}

export function validateQuestionInterpretation(value, allowed) {
  requireExactObject(
    value,
    ['schemaVersion', 'kind', 'plan', 'guidance', 'usage'],
    'question interpretation',
    'invalid-provider-output',
  )
  if (
    value.schemaVersion !== INSIGHT_QUERY_PLAN_SCHEMA_VERSION ||
    !['query', 'guidance', 'query-and-guidance', 'unsupported'].includes(value.kind)
  ) {
    fail('invalid-provider-output', 'The question interpretation is unsupported.')
  }
  const aliases = validateAllowedAliases(allowed, 'invalid-provider-output')
  const plan = ['query', 'query-and-guidance'].includes(value.kind)
    ? validateQuestionPlan(value.plan, aliases, 'invalid-provider-output')
    : requireNullPlan(value.plan, 'invalid-provider-output')
  const guidance = ['guidance', 'query-and-guidance'].includes(value.kind)
    ? validateGuidance(
        value.guidance,
        'invalid-provider-output',
        value.kind === 'query-and-guidance' ? 240 : MAX_GUIDANCE_LENGTH,
      )
    : requireNullGuidance(value.guidance, 'invalid-provider-output')
  return Object.freeze({
    schemaVersion: INSIGHT_QUERY_PLAN_SCHEMA_VERSION,
    kind: value.kind,
    plan,
    guidance,
    usage: validateProviderUsage(value.usage),
  })
}

export function validateCompletedQuestion(value, expected) {
  requireExactObject(
    value,
    [
      'schemaVersion',
      'source',
      'periodDays',
      'evidenceSignature',
      'generatedAt',
      'kind',
      'plan',
      'guidance',
      'usage',
    ],
    'completed question',
    'invalid-replay',
  )
  if (
    value.schemaVersion !== INSIGHT_QUERY_PLAN_SCHEMA_VERSION ||
    value.source !== 'provider-interpreted' ||
    value.periodDays !== expected.periodDays ||
    value.evidenceSignature !== expected.evidenceSignature ||
    !SIGNATURE_PATTERN.test(value.evidenceSignature) ||
    !['query', 'guidance', 'query-and-guidance', 'unsupported'].includes(value.kind)
  ) {
    fail('invalid-replay', 'The stored question does not match current evidence.')
  }
  requireIsoTimestamp(value.generatedAt, 'generatedAt', 'invalid-replay')
  const aliases = validateAllowedAliases(expected.allowedAliases, 'invalid-replay')
  return Object.freeze({
    schemaVersion: INSIGHT_QUERY_PLAN_SCHEMA_VERSION,
    kind: value.kind,
    plan: ['query', 'query-and-guidance'].includes(value.kind)
      ? validateQuestionPlan(value.plan, aliases, 'invalid-replay')
      : requireNullPlan(value.plan, 'invalid-replay'),
    guidance: ['guidance', 'query-and-guidance'].includes(value.kind)
      ? validateGuidance(
          value.guidance,
          'invalid-replay',
          value.kind === 'query-and-guidance' ? 240 : MAX_GUIDANCE_LENGTH,
        )
      : requireNullGuidance(value.guidance, 'invalid-replay'),
    usage: validateBilledUsage(value.usage, 'invalid-replay'),
  })
}

export function validateTeacherQuestionResponse(value) {
  requireExactObject(
    value,
    ['schemaVersion', 'source', 'periodDays', 'generatedAt', 'answer', 'evidence', 'usage'],
    'question response',
  )
  if (
    value.schemaVersion !== INSIGHT_QUESTION_SCHEMA_VERSION ||
    value.source !== 'ai-grounded' ||
    !PERIODS.includes(value.periodDays)
  ) {
    fail('invalid-response', 'The question response metadata is malformed.')
  }
  requireIsoTimestamp(value.generatedAt, 'generatedAt', 'invalid-response')
  const answer = boundedText(
    value.answer,
    1,
    MAX_TEACHER_QUESTION_ANSWER_LENGTH,
    'answer',
    'invalid-response',
  )
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 8) {
    fail('invalid-response', 'The question evidence is malformed.')
  }
  return Object.freeze({
    schemaVersion: INSIGHT_QUESTION_SCHEMA_VERSION,
    source: 'ai-grounded',
    periodDays: value.periodDays,
    generatedAt: value.generatedAt,
    answer,
    evidence: Object.freeze(value.evidence.map((item) => (
      boundedText(item, 1, 320, 'evidence', 'invalid-response')
    ))),
    usage: validateBilledUsage(value.usage, 'invalid-response'),
  })
}

function validateQuestionPlan(value, allowed, category) {
  if (isPlainObject(value) && Object.hasOwn(value, 'operation')) {
    if (value.operation === 'analyze') {
      return validateAnalysisPlan(value, allowed, category)
    }
    if (value.operation === 'list-student-balances') {
      return validateStudentBalanceListPlan(value, category)
    }
    return validateMissingTransactionPlan(value, allowed, category)
  }
  return validateQueryPlan(value, allowed, category)
}

function validateAnalysisPlan(value, allowed, category) {
  requireExactObject(value, ['operation', 'queries'], 'analysis plan', category)
  if (
    value.operation !== 'analyze' || !Array.isArray(value.queries) ||
    value.queries.length < 1 || value.queries.length > 4
  ) {
    fail(category, 'The analysis plan must contain one through four bounded queries.')
  }
  return Object.freeze({
    operation: 'analyze',
    queries: Object.freeze(value.queries.map(query => validateQueryPlan(query, allowed, category))),
  })
}

function validateStudentBalanceListPlan(value, category) {
  requireExactObject(value, ['operation'], 'student balance list plan', category)
  if (value.operation !== 'list-student-balances') {
    fail(category, 'The student balance list plan contains an unsupported operation.')
  }
  return Object.freeze({ operation: 'list-student-balances' })
}

function validateQueryPlan(value, allowed, category) {
  requireQueryPlanKeys(value, category)
  requireQueryFilters(value.filters, category)
  const groupByFields = value.groupByFields ?? []
  const having = value.having ?? null
  const distinctBy = value.distinctBy ?? null
  if (
    !INSIGHT_QUERY_DATASETS.includes(value.dataset) ||
    !INSIGHT_QUERY_METRICS.includes(value.metric) ||
    !INSIGHT_QUERY_GROUPS.includes(value.groupBy) ||
    !INSIGHT_QUERY_ORDERS.includes(value.order) ||
    !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 500 ||
    !TRANSACTION_TYPES.includes(value.filters.transactionType) ||
    !TRANSACTION_STATUSES.includes(value.filters.status) ||
    !DATE_SCOPES.includes(value.filters.dateScope) ||
    !(value.filters.lookbackDays === undefined || value.filters.lookbackDays === null || validLookbackDays(value.filters.lookbackDays)) ||
    !(value.filters.timeBucket === null || TIME_BUCKETS.includes(value.filters.timeBucket)) ||
    !STUDENT_STATES.includes(value.filters.studentState) ||
    !(value.filters.balanceCondition === undefined || BALANCE_CONDITIONS.includes(value.filters.balanceCondition)) ||
    !(value.filters.purpose === undefined || TRANSACTION_PURPOSES.includes(value.filters.purpose)) ||
    !(value.filters.amountMinimum === undefined || value.filters.amountMinimum === null || validQueryAmount(value.filters.amountMinimum)) ||
    !(value.filters.amountMaximum === undefined || value.filters.amountMaximum === null || validQueryAmount(value.filters.amountMaximum)) ||
    !validGroupByFields(groupByFields) ||
    !validHaving(having) ||
    !(distinctBy === null || INSIGHT_QUERY_DIMENSIONS.includes(distinctBy))
  ) {
    fail(category, 'The question query plan contains an unsupported operation.')
  }
  if (
    !Array.isArray(value.filters.subjectAliases) || value.filters.subjectAliases.length > 8 ||
    value.filters.subjectAliases.some(alias => (
      !SUBJECT_ALIAS_PATTERN.test(alias) || !allowed.studentAliases.includes(alias)
    )) || new Set(value.filters.subjectAliases).size !== value.filters.subjectAliases.length ||
    !(value.filters.categoryAlias === null || (
      CATEGORY_ALIAS_PATTERN.test(value.filters.categoryAlias) &&
      allowed.categoryAliases.includes(value.filters.categoryAlias)
    ))
  ) {
    fail(category, 'The question query plan contains an unsupported alias.')
  }
  const coherenceError = questionQueryPlanCoherenceError(value)
  if (coherenceError) fail(category, coherenceError)
  return Object.freeze({
    dataset: value.dataset,
    metric: value.metric,
    filters: Object.freeze({ ...value.filters }),
    groupBy: value.groupBy,
    order: value.order,
    limit: value.limit,
    ...(Object.hasOwn(value, 'groupByFields') ? { groupByFields: Object.freeze([...groupByFields]) } : {}),
    ...(Object.hasOwn(value, 'having') ? { having: having === null ? null : Object.freeze({ ...having }) } : {}),
    ...(Object.hasOwn(value, 'distinctBy') ? { distinctBy } : {}),
  })
}

function validateMissingTransactionPlan(value, allowed, category) {
  requireMissingTransactionKeys(value, category)
  if (
    value.operation !== 'students-without-transactions' ||
    !TRANSACTION_PURPOSES.includes(value.purpose) ||
    !TRANSACTION_TYPES.includes(value.transactionType) ||
    !TRANSACTION_STATUSES.includes(value.status) ||
    !DATE_SCOPES.includes(value.dateScope) ||
    !(value.lookbackDays === undefined || value.lookbackDays === null || validLookbackDays(value.lookbackDays)) ||
    !STUDENT_STATES.includes(value.studentState) ||
    !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 8 ||
    !(value.amountExact === null || (
      typeof value.amountExact === 'number' && Number.isFinite(value.amountExact) &&
      value.amountExact > 0 && value.amountExact <= MAX_EXACT_AMOUNT
    ))
  ) {
    fail(category, 'The missing transaction plan contains an unsupported operation.')
  }
  if (
    !Array.isArray(value.subjectAliases) || value.subjectAliases.length > 8 ||
    value.subjectAliases.some(alias => (
      !SUBJECT_ALIAS_PATTERN.test(alias) || !allowed.studentAliases.includes(alias)
    )) || new Set(value.subjectAliases).size !== value.subjectAliases.length ||
    !(value.categoryAlias === null || (
      CATEGORY_ALIAS_PATTERN.test(value.categoryAlias) &&
      allowed.categoryAliases.includes(value.categoryAlias)
    ))
  ) {
    fail(category, 'The missing transaction plan contains an unsupported alias.')
  }
  if (
    value.purpose === 'rent' &&
    (value.categoryAlias !== null || value.transactionType !== 'Subtract')
  ) {
    fail(category, 'The missing transaction plan is inconsistent.')
  }
  return Object.freeze({
    operation: 'students-without-transactions',
    subjectAliases: Object.freeze([...value.subjectAliases]),
    categoryAlias: value.categoryAlias,
    purpose: value.purpose,
    transactionType: value.transactionType,
    status: value.status,
    dateScope: value.dateScope,
    ...(Object.hasOwn(value, 'lookbackDays') ? { lookbackDays: value.lookbackDays } : {}),
    amountExact: value.amountExact,
    studentState: value.studentState,
    limit: value.limit,
  })
}

export function questionQueryPlanCoherenceError(value) {
  const lookbackDays = value.filters.lookbackDays ?? null
  const balanceCondition = value.filters.balanceCondition ?? 'any'
  const purpose = value.filters.purpose ?? 'any'
  const amountMinimum = value.filters.amountMinimum ?? null
  const amountMaximum = value.filters.amountMaximum ?? null
  const groupByFields = value.groupByFields ?? []
  const having = value.having ?? null
  const distinctBy = value.distinctBy ?? null
  if (amountMinimum !== null && amountMaximum !== null && amountMinimum > amountMaximum) {
    return 'The transaction amount range is inconsistent.'
  }
  if (value.dataset === 'students') {
    const isBalanceRanking = value.metric === 'current-balance' && value.groupBy === 'student'
    const isStudentAggregate = ['count', 'average-balance'].includes(value.metric) && value.groupBy === 'none'
    if (
      (!isBalanceRanking && !isStudentAggregate) ||
      value.filters.categoryAlias !== null || value.filters.transactionType !== 'any' ||
      value.filters.status !== 'any' || value.filters.dateScope !== 'period' ||
      lookbackDays !== null ||
      value.filters.timeBucket !== null ||
      purpose !== 'any' || amountMinimum !== null || amountMaximum !== null ||
      groupByFields.length !== 0 || having !== null || distinctBy !== null ||
      value.order === 'chronological'
    ) return 'The balance query plan is inconsistent.'
    if (balanceCondition !== 'any' && isBalanceRanking && value.limit !== 500) {
      return 'A filtered current-balance list must include the complete current roster.'
    }
    if (balanceCondition === 'any' && isBalanceRanking && value.limit > 8) {
      return 'An unfiltered balance ranking cannot exceed eight students.'
    }
    return null
  }
  if (value.dataset === 'balance-history') {
    if (
      value.metric !== 'closing-balance' || value.groupBy !== 'calendar-day' ||
      value.filters.subjectAliases.length !== 1 || value.filters.categoryAlias !== null ||
      value.filters.transactionType !== 'any' || value.filters.status !== 'any' ||
      value.filters.dateScope !== 'period' || lookbackDays === null ||
      value.filters.timeBucket !== null || value.filters.studentState !== 'any' ||
      purpose !== 'any' || amountMinimum !== null || amountMaximum !== null ||
      groupByFields.length !== 0 || having !== null || distinctBy !== null ||
      balanceCondition !== 'any' || value.order !== 'chronological' ||
      value.limit !== lookbackDays
    ) return 'The balance-history query plan is inconsistent.'
    return null
  }
  if (value.limit > 90) return 'A transaction query cannot return more than ninety groups.'
  if (['current-balance', 'average-balance', 'closing-balance'].includes(value.metric)) {
    return 'A transaction query cannot read balances.'
  }
  if (balanceCondition !== 'any') {
    return 'A transaction query cannot filter current balances.'
  }
  if (value.groupBy === 'composite') {
    if (groupByFields.length < 2) return 'A composite transaction query needs at least two grouping fields.'
  } else if (groupByFields.length !== 0) {
    return 'Grouping fields are allowed only for a composite transaction query.'
  }
  if (value.metric === 'distinct-values' && distinctBy === null) {
    return 'A distinct-value query must name the value to count.'
  }
  if (value.metric !== 'distinct-values' && distinctBy !== null) {
    return 'Only a distinct-value query can name a distinct value.'
  }
  if (having !== null && value.groupBy === 'none') {
    return 'A result condition requires grouped transaction results.'
  }
  if (
    having !== null && ['count', 'distinct-days', 'distinct-values'].includes(value.metric) &&
    (!Number.isSafeInteger(having.value) || having.value < 0)
  ) return 'A count result condition must use a nonnegative whole number.'
  if (
    having !== null && ['amount-total', 'amount-average'].includes(value.metric) &&
    having.value < 0
  ) return 'A positive amount result condition cannot use a negative value.'
  if (value.metric === 'net-amount' && value.filters.transactionType !== 'any') {
    return 'A net query cannot preselect one transaction type.'
  }
  const temporal = ['time-of-day', 'calendar-day', 'day-of-week', 'week'].includes(value.groupBy) || (
    value.groupBy === 'composite' && groupByFields.every(field => (
      ['time-of-day', 'calendar-day', 'day-of-week', 'week'].includes(field)
    ))
  )
  if (value.filters.dateScope !== 'period' && lookbackDays !== null) {
    return 'A named rolling-day window requires the period date scope.'
  }
  if (value.order === 'chronological' && !temporal) {
    return 'Only a time grouping can be ordered chronologically.'
  }
  return null
}

function requireQueryFilters(value, category) {
  if (!isPlainObject(value)) fail(category, 'The question query filters must be an object.')
  const required = ['subjectAliases', 'categoryAlias', 'transactionType', 'status', 'dateScope', 'timeBucket', 'studentState']
  const allowed = new Set([
    ...required,
    'lookbackDays',
    'balanceCondition',
    'purpose',
    'amountMinimum',
    'amountMaximum',
  ])
  if (required.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !allowed.has(field))) {
    fail(category, 'The question query filters contain unsupported fields.')
  }
}

function requireQueryPlanKeys(value, category) {
  if (!isPlainObject(value)) fail(category, 'The question query plan must be an object.')
  const required = ['dataset', 'metric', 'filters', 'groupBy', 'order', 'limit']
  const allowed = new Set([...required, 'groupByFields', 'having', 'distinctBy'])
  if (required.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !allowed.has(field))) {
    fail(category, 'The question query plan has an unexpected shape.')
  }
}

function validQueryAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_EXACT_AMOUNT
}

function validGroupByFields(value) {
  return Array.isArray(value) && value.length <= 8 &&
    value.every(field => INSIGHT_QUERY_DIMENSIONS.includes(field)) &&
    new Set(value).size === value.length
}

function validHaving(value) {
  return value === null || (
    isPlainObject(value) && hasExactKeys(value, ['comparator', 'value']) &&
    INSIGHT_QUERY_COMPARATORS.includes(value.comparator) &&
    typeof value.value === 'number' && Number.isFinite(value.value) &&
    value.value >= -MAX_EXACT_AMOUNT && value.value <= MAX_EXACT_AMOUNT
  )
}

function requireMissingTransactionKeys(value, category) {
  if (!isPlainObject(value)) fail(category, 'The missing transaction plan must be an object.')
  const required = [
    'operation', 'subjectAliases', 'categoryAlias', 'purpose', 'transactionType',
    'status', 'dateScope', 'amountExact', 'studentState', 'limit',
  ]
  const allowed = new Set([...required, 'lookbackDays'])
  if (required.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !allowed.has(field))) {
    fail(category, 'The missing transaction plan has an unexpected shape.')
  }
}

function validLookbackDays(value) {
  return Number.isSafeInteger(value) && value >= MIN_LOOKBACK_DAYS && value <= MAX_LOOKBACK_DAYS
}

function validateAllowedAliases(value, category) {
  if (
    !isPlainObject(value) || !hasExactKeys(value, ['studentAliases', 'categoryAliases']) ||
    !Array.isArray(value.studentAliases) ||
    value.studentAliases.some(alias => !SUBJECT_ALIAS_PATTERN.test(alias)) ||
    new Set(value.studentAliases).size !== value.studentAliases.length ||
    !Array.isArray(value.categoryAliases) ||
    value.categoryAliases.some(alias => !CATEGORY_ALIAS_PATTERN.test(alias)) ||
    new Set(value.categoryAliases).size !== value.categoryAliases.length
  ) {
    fail(category, 'The allowed question aliases are malformed.')
  }
  return value
}

function requireNullPlan(value, category) {
  if (value !== null) fail(category, 'A non-query question cannot contain a query plan.')
  return null
}

function requireNullGuidance(value, category) {
  if (value !== null) fail(category, 'A non-guidance question cannot contain guidance text.')
  return null
}

function validateGuidance(value, category, maximum = MAX_GUIDANCE_LENGTH) {
  const guidance = boundedText(
    value,
    MIN_GUIDANCE_LENGTH,
    maximum,
    'guidance',
    category,
  )
  const hasControl = [...guidance].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint === 127 || codePoint < 32
  })
  if (
    hasControl ||
    PROVIDER_ALIAS_PATTERN.test(guidance) ||
    PROVIDER_PLACEHOLDER_PATTERN.test(guidance) ||
    URL_PATTERN.test(guidance)
  ) {
    fail(category, 'The Morgan Bank guidance contains unsupported content.')
  }
  return guidance
}

function canonicalTimeZone(value) {
  const timeZone = boundedText(value, 1, 80, 'timeZone')
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    fail('invalid-request', 'The question time zone is unsupported.')
  }
}

function validateProviderUsage(value) {
  requireExactObject(
    value,
    ['inputTokens', 'outputTokens', 'thinkingTokens'],
    'question usage',
    'invalid-provider-output',
  )
  return Object.freeze(validateTokenUsage(
    value,
    'invalid-provider-output',
    MAX_INTERPRETATION_OUTPUT_TOKENS,
    MAX_INTERPRETATION_THINKING_TOKENS,
  ))
}

function validateBilledUsage(value, category) {
  requireExactObject(
    value,
    ['inputTokens', 'outputTokens', 'thinkingTokens', 'costMicroUsd'],
    'question usage',
    category,
  )
  const result = validateTokenUsage(
    value,
    category,
    MAX_BILLED_OUTPUT_TOKENS,
    MAX_BILLED_THINKING_TOKENS,
  )
  if (!Number.isSafeInteger(value.costMicroUsd) || value.costMicroUsd < 0 || value.costMicroUsd > 7_500_000) {
    fail(category, 'Question usage exceeds the reviewed limits.')
  }
  return Object.freeze({ ...result, costMicroUsd: value.costMicroUsd })
}

function validateTokenUsage(value, category, maximumOutputTokens, maximumThinkingTokens) {
  const result = {}
  for (const field of ['inputTokens', 'outputTokens', 'thinkingTokens']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      fail(category, 'Question usage is malformed.')
    }
    result[field] = value[field]
  }
  if (
    result.outputTokens > maximumOutputTokens ||
    result.thinkingTokens > maximumThinkingTokens
  ) {
    fail(category, 'Question usage exceeds the reviewed limits.')
  }
  return result
}

function requireIsoTimestamp(value, label, category) {
  const date = new Date(value)
  if (typeof value !== 'string' || !Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail(category, `${label} is malformed.`)
  }
}

function boundedText(value, minimum, maximum, label, category = 'invalid-request') {
  const hasDisallowedControl = typeof value === 'string' && [...value].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint === 127 || (codePoint < 32 && ![9, 10, 13].includes(codePoint))
  })
  if (
    typeof value !== 'string' || value.length < minimum || value.length > maximum ||
    value.trim() !== value || hasDisallowedControl
  ) {
    fail(category, `${label} is malformed.`)
  }
  return value
}

function requireExactObject(value, expected, label, category = 'invalid-request') {
  if (!isPlainObject(value) || !hasExactKeys(value, expected)) {
    fail(category, `${label} has an unexpected shape.`)
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index])
}

function fail(category, message) {
  throw new InsightQuestionContractError(category, message)
}
