import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InsightQuestionContractError,
  validateCompletedQuestion,
  validateInsightQuestionRequest,
  validateQuestionInterpretation,
  validateTeacherQuestionResponse,
} from './questionContracts.js'

const request = {
  requestId: '12345678-1234-4234-8234-123456789abc',
  kind: 'question',
  periodDays: 30,
  timeZone: 'America/Denver',
  question: 'Who has used the restroom the most?',
}
const usage = { inputTokens: 190, outputTokens: 86, thinkingTokens: 0 }
const allowed = {
  studentAliases: ['student-001'],
  categoryAliases: ['category-001', 'category-002'],
}
const restroomPlan = {
  dataset: 'transactions',
  metric: 'count',
  filters: {
    subjectAliases: [],
    categoryAlias: 'category-001',
    transactionType: 'Subtract',
    status: 'Approved',
    dateScope: 'period',
    timeBucket: null,
    studentState: 'any',
  },
  groupBy: 'student',
  order: 'highest',
  limit: 1,
}

test('server question request has exactly five browser fields and validates IANA time zones', () => {
  assert.deepEqual(validateInsightQuestionRequest(request), request)
  assert.equal(validateInsightQuestionRequest({ ...request, timeZone: 'aMeRiCa/DeNvEr' }).timeZone, 'America/Denver')
  for (const invalid of [
    { ...request, classroomId: 'class-a' },
    { ...request, studentId: '1' },
    { ...request, model: 'browser-choice' },
    { ...request, timeZone: 'Mountain Time' },
  ]) assert.throws(() => validateInsightQuestionRequest(invalid), InsightQuestionContractError)
})

test('provider may return only a bounded query plan using server allowlisted aliases', () => {
  const interpretation = {
    schemaVersion: 5,
    kind: 'query',
    plan: restroomPlan,
    guidance: null,
    usage,
  }
  assert.deepEqual(validateQuestionInterpretation(interpretation, allowed), interpretation)
  assert.throws(() => validateQuestionInterpretation({
    ...interpretation,
    plan: { ...restroomPlan, filters: { ...restroomPlan.filters, categoryAlias: 'category-999' } },
  }, allowed), InsightQuestionContractError)
  assert.throws(() => validateQuestionInterpretation({
    ...interpretation,
    plan: { ...restroomPlan, writeOperation: 'delete' },
  }, allowed), InsightQuestionContractError)
  assert.deepEqual(validateQuestionInterpretation({
    schemaVersion: 5,
    kind: 'unsupported',
    plan: null,
    guidance: null,
    usage,
  }, allowed).plan, null)
})

test('provider can compare today and yesterday using a bounded calendar-day plan', () => {
  const comparisonPlan = {
    ...restroomPlan,
    filters: {
      ...restroomPlan.filters,
      subjectAliases: ['student-001'],
      categoryAlias: 'category-002',
      transactionType: 'Add',
      status: 'any',
      dateScope: 'today-and-yesterday',
    },
    groupBy: 'calendar-day',
    order: 'chronological',
    limit: 2,
  }
  assert.deepEqual(validateQuestionInterpretation({
    schemaVersion: 5,
    kind: 'query',
    plan: comparisonPlan,
    guidance: null,
    usage,
  }, allowed).plan, comparisonPlan)
  assert.throws(() => validateQuestionInterpretation({
    schemaVersion: 5,
    kind: 'query',
    plan: {
      ...comparisonPlan,
      filters: { ...comparisonPlan.filters, dateScope: 'tomorrow' },
    },
    guidance: null,
    usage,
  }, allowed), InsightQuestionContractError)
})

test('provider may return bounded Morgan Bank guidance but cannot mix it with a data plan', () => {
  const guidance = 'Use a predictable weekly savings routine and let students set a small classroom goal before choosing optional purchases.'
  assert.deepEqual(validateQuestionInterpretation({
    schemaVersion: 5,
    kind: 'guidance',
    plan: null,
    guidance,
    usage,
  }, allowed), {
    schemaVersion: 5,
    kind: 'guidance',
    plan: null,
    guidance,
    usage,
  })
  for (const invalid of [
    { kind: 'guidance', plan: restroomPlan, guidance },
    { kind: 'guidance', plan: null, guidance: 'See https://example.com for help.' },
    { kind: 'guidance', plan: null, guidance: 'Ask student-001 to save more each week.' },
    { kind: 'guidance', plan: null, guidance: 'Too short.' },
    { kind: 'query', plan: restroomPlan, guidance },
    { kind: 'unsupported', plan: null, guidance },
  ]) {
    assert.throws(() => validateQuestionInterpretation({
      schemaVersion: 5,
      ...invalid,
      usage,
    }, allowed), InsightQuestionContractError)
  }
})

test('provider can pair a grounded plan with short result-independent guidance', () => {
  const guidance = 'Review the result privately and use a consistent earning routine to help students set a realistic next goal.'
  const combined = validateQuestionInterpretation({
    schemaVersion: 5,
    kind: 'query-and-guidance',
    plan: restroomPlan,
    guidance,
    usage,
  }, allowed)
  assert.equal(combined.kind, 'query-and-guidance')
  assert.deepEqual(combined.plan, restroomPlan)
  assert.equal(combined.guidance, guidance)
  assert.throws(() => validateQuestionInterpretation({
    schemaVersion: 5,
    kind: 'query-and-guidance',
    plan: restroomPlan,
    guidance: 'A'.repeat(241),
    usage,
  }, allowed), InsightQuestionContractError)
})

test('cross-field rules reject nonsensical balance, net, and chronological plans', () => {
  const wrap = plan => ({ schemaVersion: 5, kind: 'query', plan, guidance: null, usage })
  assert.throws(() => validateQuestionInterpretation(wrap({
    ...restroomPlan,
    dataset: 'students',
    metric: 'current-balance',
  }), allowed), InsightQuestionContractError)
  assert.throws(() => validateQuestionInterpretation(wrap({
    ...restroomPlan,
    metric: 'net-amount',
  }), allowed), InsightQuestionContractError)
  assert.throws(() => validateQuestionInterpretation(wrap({
    ...restroomPlan,
    order: 'chronological',
  }), allowed), InsightQuestionContractError)
})

test('student dataset permits roster counts and balance analysis without exposing a roster catalog', () => {
  const studentCount = {
    dataset: 'students',
    metric: 'count',
    filters: {
      subjectAliases: [],
      categoryAlias: null,
      transactionType: 'any',
      status: 'any',
      dateScope: 'period',
      timeBucket: null,
      studentState: 'frozen',
    },
    groupBy: 'none',
    order: 'highest',
    limit: 1,
  }
  assert.deepEqual(validateQuestionInterpretation({
    schemaVersion: 5,
    kind: 'query',
    plan: studentCount,
    guidance: null,
    usage,
  }, allowed).plan, studentCount)
})

test('completed replay is pinned to schema, evidence signature, and current aliases', () => {
  const completed = {
    schemaVersion: 5,
    source: 'provider-interpreted',
    periodDays: 30,
    evidenceSignature: 'a'.repeat(64),
    generatedAt: '2026-08-20T18:00:00.000Z',
    kind: 'query',
    plan: restroomPlan,
    guidance: null,
    usage: { ...usage, costMicroUsd: 500 },
  }
  assert.deepEqual(validateCompletedQuestion(completed, {
    periodDays: 30,
    evidenceSignature: 'a'.repeat(64),
    allowedAliases: allowed,
  }).plan, restroomPlan)
  assert.throws(() => validateCompletedQuestion(completed, {
    periodDays: 30,
    evidenceSignature: 'b'.repeat(64),
    allowedAliases: allowed,
  }), InsightQuestionContractError)
})

test('completed guidance replay is schema-bound and contains no data plan', () => {
  const guidance = 'Use a short weekly balance check-in and ask students to name one saving goal before they choose an optional purchase.'
  const completed = {
    schemaVersion: 5,
    source: 'provider-interpreted',
    periodDays: 30,
    evidenceSignature: 'a'.repeat(64),
    generatedAt: '2026-08-20T18:00:00.000Z',
    kind: 'guidance',
    plan: null,
    guidance,
    usage: { ...usage, costMicroUsd: 500 },
  }
  assert.equal(validateCompletedQuestion(completed, {
    periodDays: 30,
    evidenceSignature: 'a'.repeat(64),
    allowedAliases: allowed,
  }).guidance, guidance)
  assert.throws(() => validateCompletedQuestion({
    ...completed,
    plan: restroomPlan,
  }, {
    periodDays: 30,
    evidenceSignature: 'a'.repeat(64),
    allowedAliases: allowed,
  }), InsightQuestionContractError)
})

test('provider can request current students without exact matching rent payments today', () => {
  const plan = {
    operation: 'students-without-transactions',
    subjectAliases: [],
    categoryAlias: null,
    purpose: 'rent',
    transactionType: 'Subtract',
    status: 'Approved',
    dateScope: 'today',
    amountExact: 10,
    studentState: 'any',
    limit: 8,
  }
  assert.deepEqual(validateQuestionInterpretation({
    schemaVersion: 5,
    kind: 'query',
    plan,
    guidance: null,
    usage,
  }, allowed).plan, plan)
  for (const invalidPlan of [
    { ...plan, transactionType: 'Add' },
    { ...plan, categoryAlias: 'category-001' },
    { ...plan, amountExact: 0 },
    { ...plan, subjectAliases: ['student-999'] },
  ]) {
    assert.throws(() => validateQuestionInterpretation({
      schemaVersion: 5,
      kind: 'query',
      plan: invalidPlan,
      guidance: null,
      usage,
    }, allowed), InsightQuestionContractError)
  }
})

test('provider can request one exact read-only plan for every current student balance', () => {
  const plan = { operation: 'list-student-balances' }
  assert.deepEqual(validateQuestionInterpretation({
    schemaVersion: 5,
    kind: 'query',
    plan,
    guidance: null,
    usage,
  }, allowed).plan, plan)
  for (const invalidPlan of [
    { ...plan, limit: 8 },
    { operation: 'list-all-transactions' },
  ]) {
    assert.throws(() => validateQuestionInterpretation({
      schemaVersion: 5,
      kind: 'query',
      plan: invalidPlan,
      guidance: null,
      usage,
    }, allowed), InsightQuestionContractError)
  }
})

test('teacher response accepts only calculated answer text, bounded evidence, and billed usage', () => {
  const response = {
    schemaVersion: 2,
    source: 'ai-grounded',
    periodDays: 30,
    generatedAt: '2026-08-20T18:00:00.000Z',
    answer: 'Genesis has the highest restroom visit count: 3 transactions.',
    evidence: ['Genesis: 3 transactions; 3 matching transactions.'],
    usage: { ...usage, costMicroUsd: 500 },
  }
  assert.deepEqual(validateTeacherQuestionResponse(response), response)
  assert.throws(() => validateTeacherQuestionResponse({ ...response, schemaVersion: 1 }), InsightQuestionContractError)
  assert.throws(() => validateTeacherQuestionResponse({ ...response, rawProviderText: 'no' }), InsightQuestionContractError)
  assert.equal(validateTeacherQuestionResponse({
    ...response,
    answer: 'A'.repeat(80_000),
  }).answer.length, 80_000)
  assert.throws(() => validateTeacherQuestionResponse({
    ...response,
    answer: 'A'.repeat(80_001),
  }), InsightQuestionContractError)
})
