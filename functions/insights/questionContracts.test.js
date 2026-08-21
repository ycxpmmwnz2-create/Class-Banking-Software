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
    schemaVersion: 2,
    kind: 'query',
    plan: restroomPlan,
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
    schemaVersion: 2,
    kind: 'unsupported',
    plan: null,
    usage,
  }, allowed).plan, null)
})

test('cross-field rules reject nonsensical balance, net, and chronological plans', () => {
  const wrap = plan => ({ schemaVersion: 2, kind: 'query', plan, usage })
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
      timeBucket: null,
      studentState: 'frozen',
    },
    groupBy: 'none',
    order: 'highest',
    limit: 1,
  }
  assert.deepEqual(validateQuestionInterpretation({
    schemaVersion: 2,
    kind: 'query',
    plan: studentCount,
    usage,
  }, allowed).plan, studentCount)
})

test('completed replay is pinned to schema, evidence signature, and current aliases', () => {
  const completed = {
    schemaVersion: 2,
    source: 'provider-interpreted',
    periodDays: 30,
    evidenceSignature: 'a'.repeat(64),
    generatedAt: '2026-08-20T18:00:00.000Z',
    kind: 'query',
    plan: restroomPlan,
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
})
