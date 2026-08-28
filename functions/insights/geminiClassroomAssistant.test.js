import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GeminiClassroomAssistantError,
  createGeminiClassroomAssistant,
} from './geminiClassroomAssistant.js'

const USAGE = Object.freeze({
  promptTokenCount: 10,
  candidatesTokenCount: 5,
  totalTokenCount: 17,
  cachedContentTokenCount: 3,
  toolUsePromptTokenCount: 2,
})

function evidence() {
  return {
    question: 'Does Ava have duplicate transactions today?',
    generatedAt: '2026-08-27T18:00:00.000Z',
    asOfDate: '2026-08-27',
    timeZone: 'America/Denver',
    periodDays: 7,
    periodStart: '2026-08-20T18:00:00.000Z',
    historyStart: '2026-05-29T18:00:00.000Z',
    configuredRentAmount: 10,
    students: [{ ref: 'student-001', displayName: 'Ava', current: true, balance: 10, frozen: false }],
    categories: [{ label: 'Technology', transactionTypes: ['Add'] }],
    transactions: [1, 2].map(index => ({
      ref: `transaction-${String(index).padStart(5, '0')}`,
      studentRef: 'student-001',
      date: `2026-08-27T15:0${index}:00.000Z`,
      type: 'Add',
      amount: 5,
      category: 'Technology',
      purpose: 'other',
      status: 'Approved',
    })),
  }
}

test('runs a grounded tool turn and returns a direct conversational answer', async () => {
  const requests = []
  const responses = [
    {
      functionCalls: [{ id: 'duplicate-check', name: 'aggregate_transactions', args: {
        startDate: '2026-08-27',
        endDate: '2026-08-27',
        groupBy: ['student', 'category', 'transactionType',],
        metric: 'count',
        minimumResult: 2,
      } }],
      candidateContent: { role: 'model', parts: [{ functionCall: { id: 'duplicate-check', name: 'aggregate_transactions', args: {} } }] },
      finishReason: 'STOP',
      usageMetadata: USAGE,
    },
    {
      text: JSON.stringify({
        answer: 'Yes. Ava has 2 matching Technology Add transactions today.',
        evidenceCallIds: ['duplicate-check'],
      }),
      functionCalls: [],
      finishReason: 'STOP',
      usageMetadata: USAGE,
    },
  ]
  const assistant = createGeminiClassroomAssistant({
    async generateContent(request) {
      requests.push(request)
      return responses.shift()
    },
  })
  const result = await assistant.answer({ assistantEvidence: evidence() })
  assert.equal(result.answer, 'Yes. Ava has 2 matching Technology Add transactions today.')
  assert.deepEqual(result.usage, { inputTokens: 24, outputTokens: 10, thinkingTokens: 0 })
  assert.equal(result.toolCallCount, 1)
  assert.match(result.evidence[0], /2 matching transactions/)
  assert.equal(requests[0].config.toolConfig.functionCallingConfig.mode, 'ANY')
  assert.equal(requests[1].config.toolConfig.functionCallingConfig.mode, 'AUTO')
  assert.equal(requests[0].config.httpOptions.timeout <= 60_000, true)
  assert.equal(requests[1].contents.at(-1).parts[0].functionResponse.id, 'duplicate-check')
})

test('stops the multi-turn loop at one overall minute', async () => {
  let providerCalls = 0
  const times = [0, 0, 60_001]
  const assistant = createGeminiClassroomAssistant({
    now: () => times.shift() ?? 60_001,
    async generateContent() {
      providerCalls += 1
      return {
        functionCalls: [{ id: 'call', name: 'get_balances', args: {} }],
        candidateContent: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'get_balances', args: {} } }] },
        finishReason: 'STOP',
        usageMetadata: USAGE,
      }
    },
  })
  await assert.rejects(
    assistant.answer({ assistantEvidence: evidence() }),
    error => error instanceof GeminiClassroomAssistantError && error.category === 'provider-timeout',
  )
  assert.equal(providerCalls, 1)
})

test('rejects uncited, opaque, or truncated provider answers', async () => {
  for (const finalResponse of [
    { text: JSON.stringify({ answer: 'Ava has 2 matches.', evidenceCallIds: [] }), finishReason: 'STOP' },
    { text: JSON.stringify({ answer: 'student-001 has 2 matches.', evidenceCallIds: ['call'] }), finishReason: 'STOP' },
    { text: '{}', finishReason: 'MAX_TOKENS' },
  ]) {
    let count = 0
    const assistant = createGeminiClassroomAssistant({
      async generateContent() {
        count += 1
        if (count === 1) return {
          functionCalls: [{ id: 'call', name: 'get_balances', args: {} }],
          candidateContent: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'get_balances', args: {} } }] },
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
        return { ...finalResponse, functionCalls: [], usageMetadata: USAGE }
      },
    })
    await assert.rejects(
      assistant.answer({ assistantEvidence: evidence() }),
      error => error instanceof GeminiClassroomAssistantError &&
        ['answer-unverified', 'provider-output-truncated'].includes(error.category),
    )
  }
})

test('rejects an unknown two-part student identity even when tool evidence is cited', async () => {
  let count = 0
  const assistant = createGeminiClassroomAssistant({
    async generateContent() {
      count += 1
      if (count === 1) return {
        functionCalls: [{ id: 'call', name: 'get_balances', args: {} }],
        candidateContent: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'get_balances', args: {} } }] },
        finishReason: 'STOP',
        usageMetadata: USAGE,
      }
      return {
        text: JSON.stringify({ answer: 'Michael R. has 2 matches.', evidenceCallIds: ['call'] }),
        functionCalls: [],
        finishReason: 'STOP',
        usageMetadata: USAGE,
      }
    },
  })
  await assert.rejects(
    assistant.answer({ assistantEvidence: evidence() }),
    error => error instanceof GeminiClassroomAssistantError && error.category === 'answer-unverified',
  )
})
