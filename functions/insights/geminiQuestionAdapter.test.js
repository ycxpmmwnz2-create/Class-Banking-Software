import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GEMINI_MODEL_ID,
} from './geminiProviderAdapter.js'
import {
  GeminiQuestionAdapterError,
  buildGeminiQuestionRequest,
  createGeminiQuestionAdapter,
} from './geminiQuestionAdapter.js'

const providerInput = Object.freeze({
  schemaVersion: 1,
  question: 'What category is [student-001] earning the most money in?',
  subjectAliases: Object.freeze(['student-001']),
  periodDays: 30,
})

test('question request uses the single regular Flash model with minimal thinking and no tools', () => {
  const request = buildGeminiQuestionRequest({ providerInput })
  assert.equal(request.model, GEMINI_MODEL_ID)
  assert.equal(request.model, 'gemini-3.6-flash')
  assert.equal(request.config.thinkingConfig.thinkingLevel, 'MINIMAL')
  assert.equal(request.config.maxOutputTokens, 96)
  assert.equal(Object.hasOwn(request.config, 'temperature'), false)
  assert.equal(Object.hasOwn(request.config, 'tools'), false)
  assert.match(request.config.systemInstruction, /Do not answer the question and do not add facts/)
  assert.doesNotMatch(JSON.stringify(request), /GianMarco/)
})

test('question adapter makes one injected call and accepts only structured interpretation usage', async () => {
  let calls = 0
  const adapter = createGeminiQuestionAdapter({
    async generateContentOnce() {
      calls += 1
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          intent: 'student-top-earning-category',
          subjectAlias: 'student-001',
        }),
        usageMetadata: {
          promptTokenCount: 90,
          candidatesTokenCount: 18,
          thoughtsTokenCount: 0,
          totalTokenCount: 108,
        },
      }
    },
  })
  const result = await adapter.interpret({ providerInput })
  assert.equal(calls, 1)
  assert.deepEqual(result.usage, { inputTokens: 90, outputTokens: 18, thinkingTokens: 0 })
})

test('question adapter redacts transport details and rejects malformed inputs before a call', async () => {
  let calls = 0
  const adapter = createGeminiQuestionAdapter({
    async generateContentOnce() {
      calls += 1
      throw new Error('upstream secret detail')
    },
  })
  await assert.rejects(
    adapter.interpret({ providerInput: { ...providerInput, realName: 'GianMarco' } }),
    error => error instanceof GeminiQuestionAdapterError && error.category === 'invalid-question-input',
  )
  assert.equal(calls, 0)
  await assert.rejects(
    adapter.interpret({ providerInput }),
    error => error instanceof GeminiQuestionAdapterError &&
      error.category === 'provider-unavailable' &&
      !error.message.includes('secret'),
  )
  assert.equal(calls, 1)
})
