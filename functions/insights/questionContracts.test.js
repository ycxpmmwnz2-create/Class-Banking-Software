import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InsightQuestionContractError,
  validateInsightQuestionRequest,
  validateQuestionInterpretation,
  validateTeacherQuestionResponse,
} from './questionContracts.js'

const request = {
  requestId: '12345678-1234-4234-8234-123456789abc',
  kind: 'question',
  periodDays: 30,
  timeZone: 'America/Denver',
  question: 'What time are students losing the most money?',
}

test('server question request has exactly five browser fields and validates IANA time zones', () => {
  assert.deepEqual(validateInsightQuestionRequest(request), request)
  assert.equal(
    validateInsightQuestionRequest({ ...request, timeZone: 'aMeRiCa/DeNvEr' }).timeZone,
    'America/Denver',
  )
  for (const invalid of [
    { ...request, classroomId: 'class-a' },
    { ...request, studentId: '1' },
    { ...request, model: 'browser-choice' },
    { ...request, timeZone: 'Mountain Time' },
  ]) assert.throws(() => validateInsightQuestionRequest(invalid), InsightQuestionContractError)
})

test('provider may choose only an allowlisted intent and mentioned opaque subject', () => {
  const usage = { inputTokens: 90, outputTokens: 18, thinkingTokens: 0 }
  assert.deepEqual(validateQuestionInterpretation({
    schemaVersion: 1,
    intent: 'student-top-earning-category',
    subjectAlias: 'student-001',
    usage,
  }, ['student-001']), {
    schemaVersion: 1,
    intent: 'student-top-earning-category',
    subjectAlias: 'student-001',
    usage,
  })
  assert.throws(() => validateQuestionInterpretation({
    schemaVersion: 1,
    intent: 'student-top-earning-category',
    subjectAlias: 'student-002',
    usage,
  }, ['student-001']), InsightQuestionContractError)
  assert.throws(() => validateQuestionInterpretation({
    schemaVersion: 1,
    intent: 'write-a-story',
    subjectAlias: null,
    usage,
  }, []), InsightQuestionContractError)
})

test('teacher response accepts only calculated answer text, bounded evidence, and billed usage', () => {
  const response = {
    schemaVersion: 1,
    source: 'ai-grounded',
    periodDays: 30,
    generatedAt: '2026-08-20T18:00:00.000Z',
    answer: 'Students spent the most during the afternoon.',
    evidence: ['Afternoon: $20.00 across 2 approved transactions.'],
    usage: { inputTokens: 90, outputTokens: 18, thinkingTokens: 0, costMicroUsd: 500 },
  }
  assert.deepEqual(validateTeacherQuestionResponse(response), response)
  assert.throws(() => validateTeacherQuestionResponse({ ...response, rawProviderText: 'no' }), InsightQuestionContractError)
})
