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
  schemaVersion: 6,
  question: 'Who has used the restroom the most?',
  subjectAliases: Object.freeze([]),
  subjectHints: Object.freeze([]),
  categoryCatalog: Object.freeze([
    Object.freeze({
      alias: 'category-001',
      label: 'Bathroom break',
      transactionTypes: Object.freeze(['Subtract']),
    }),
  ]),
  periodDays: 30,
})

test('question request uses the single regular Flash model with minimal thinking and no tools', () => {
  const request = buildGeminiQuestionRequest({ providerInput })
  assert.equal(request.model, GEMINI_MODEL_ID)
  assert.equal(request.model, 'gemini-3.6-flash')
  assert.equal(request.config.thinkingConfig.thinkingLevel, 'MINIMAL')
  assert.equal(request.config.maxOutputTokens, 384)
  assert.equal(Object.hasOwn(request.config, 'temperature'), false)
  assert.equal(Object.hasOwn(request.config, 'tools'), false)
  assert.match(request.config.systemInstruction, /kind query.*fact.*classroom records/i)
  assert.match(request.config.systemInstruction, /kind guidance.*Morgan Bank explanations/i)
  assert.match(request.config.systemInstruction, /classroom tool, not a real bank/i)
  assert.match(request.config.systemInstruction, /visits.*use metric count/)
  assert.match(request.config.systemInstruction, /students-without-transactions/)
  assert.match(request.config.systemInstruction, /list-student-balances/)
  assert.match(request.config.systemInstruction, /unpaid rent.*amountExact.*dateScope today/)
  assert.match(request.config.systemInstruction, /submitted.*status any/i)
  assert.match(request.config.systemInstruction, /whether or did.*metric count/i)
  assert.match(request.config.systemInstruction, /today-versus-yesterday.*calendar-day/i)
  assert.match(request.config.systemInstruction, /this week.*Monday.*server-calculated current classroom date/i)
  assert.match(request.config.systemInstruction, /comparison of days this week.*calendar-day/i)
  assert.match(request.config.systemInstruction, /dataset students.*dateScope period/i)
  assert.match(request.config.systemInstruction, /subjectHints.*possible student alias/i)
  assert.match(JSON.stringify(request.config.responseJsonSchema), /students-without-transactions/)
  assert.match(JSON.stringify(request.config.responseJsonSchema), /list-student-balances/)
  assert.match(JSON.stringify(request.config.responseJsonSchema), /today-and-yesterday/)
  assert.match(JSON.stringify(request.config.responseJsonSchema), /this-week/)
  assert.match(JSON.stringify(request.config.responseJsonSchema), /calendar-day/)
  assert.match(JSON.stringify(request.config.responseJsonSchema), /guidance/)
  assert.doesNotMatch(JSON.stringify(request), /GianMarco/)
})

test('question request carries only bounded single-word subject hints for model disambiguation', () => {
  const request = buildGeminiQuestionRequest({
    providerInput: {
      ...providerInput,
      question: 'Which category does Grace use most?',
      subjectAliases: ['student-001'],
      subjectHints: [{ text: 'grace', studentAlias: 'student-001' }],
    },
  })
  const payload = JSON.parse(request.contents[0].parts[0].text)
  assert.deepEqual(payload.providerInput.subjectHints, [{
    text: 'grace',
    studentAlias: 'student-001',
  }])
  assert.deepEqual(payload.providerInput.subjectAliases, ['student-001'])
  assert.doesNotMatch(JSON.stringify(request), /Liu|teacher-a|class-a/)
})

test('question adapter makes one injected call and accepts only structured interpretation usage', async () => {
  let calls = 0
  const adapter = createGeminiQuestionAdapter({
    async generateContentOnce() {
      calls += 1
      return {
        text: JSON.stringify({
          schemaVersion: 6,
          kind: 'query',
          plan: {
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
          },
          guidance: null,
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
  assert.equal(result.plan.categoryAlias, undefined)
  assert.equal(result.plan.filters.categoryAlias, 'category-001')
})

test('question adapter accepts a bounded Morgan Bank guidance route', async () => {
  const guidance = 'Use a weekly savings goal and predictable earning categories so students can practice planning before optional classroom purchases.'
  const adapter = createGeminiQuestionAdapter({
    async generateContentOnce(request) {
      assert.match(request.config.systemInstruction, /must not claim that you inspected data/i)
      return {
        text: JSON.stringify({
          schemaVersion: 6,
          kind: 'guidance',
          plan: null,
          guidance,
        }),
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 35,
          thoughtsTokenCount: 0,
          totalTokenCount: 155,
        },
      }
    },
  })
  const result = await adapter.interpret({
    providerInput: {
      ...providerInput,
      question: 'How can I encourage saving in Morgan Bank?',
    },
  })
  assert.equal(result.kind, 'guidance')
  assert.equal(result.guidance, guidance)
  assert.equal(result.plan, null)
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
    adapter.interpret({
      providerInput: {
        ...providerInput,
        subjectAliases: ['student-001'],
        subjectHints: [{ text: 'Grace Liu', studentAlias: 'student-001' }],
      },
    }),
    error => error instanceof GeminiQuestionAdapterError && error.category === 'invalid-question-input',
  )
  assert.equal(calls, 0)
  await assert.rejects(
    adapter.interpret({
      providerInput: {
        ...providerInput,
        categoryCatalog: [{ ...providerInput.categoryCatalog[0], answerCount: 4 }],
      },
    }),
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
