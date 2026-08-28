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
        factRefs: [
          { callId: 'duplicate-check', path: '/rows/0/group/student' },
          { callId: 'duplicate-check', path: '/rows/0/value' },
        ],
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

test('accumulates a four-turn tool answer at the shared billed usage ceiling', async () => {
  let turn = 0
  const ceilingUsage = {
    promptTokenCount: 1,
    candidatesTokenCount: 2_048,
    thoughtsTokenCount: 4_096,
    toolUsePromptTokenCount: 0,
    totalTokenCount: 6_145,
  }
  const assistant = createGeminiClassroomAssistant({
    async generateContent() {
      turn += 1
      if (turn < 4) return {
        functionCalls: [{ id: `call-${turn}`, name: 'get_balances', args: {} }],
        candidateContent: { role: 'model', parts: [{ functionCall: { id: `call-${turn}`, name: 'get_balances', args: {} } }] },
        finishReason: 'STOP',
        usageMetadata: ceilingUsage,
      }
      return {
        text: JSON.stringify({
          answer: 'There is 1 matching balance for Ava.',
          evidenceCallIds: ['call-3'],
          factRefs: [
            { callId: 'call-3', path: '/matchedCount' },
            { callId: 'call-3', path: '/students/0/student' },
          ],
        }),
        functionCalls: [],
        finishReason: 'STOP',
        usageMetadata: ceilingUsage,
      }
    },
  })
  const result = await assistant.answer({ assistantEvidence: evidence() })
  assert.deepEqual(result.usage, {
    inputTokens: 4,
    outputTokens: 8_192,
    thinkingTokens: 16_384,
  })
  assert.equal(result.toolCallCount, 3)
})

test('rejects uncited, opaque, or truncated provider answers', async () => {
  for (const finalResponse of [
    { text: JSON.stringify({ answer: 'Ava has 2 matches.', evidenceCallIds: [], factRefs: [] }), finishReason: 'STOP' },
    { text: JSON.stringify({ answer: 'student-001 has 2 matches.', evidenceCallIds: ['call'], factRefs: [{ callId: 'call', path: '/matchedCount' }] }), finishReason: 'STOP' },
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
        text: JSON.stringify({
          answer: 'Michael R. has 1 matching balance.',
          evidenceCallIds: ['call'],
          factRefs: [{ callId: 'call', path: '/matchedCount' }],
        }),
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

test('rejects an invented first name but accepts an ordinary sentence start and a cited first name', async () => {
  for (const [answer, shouldPass] of [
    ['Priya has 1 matching balance.', false],
    ['There is 1 matching balance for Ava.', true],
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
        return {
          text: JSON.stringify({
            answer,
            evidenceCallIds: ['call'],
            factRefs: [
              { callId: 'call', path: '/matchedCount' },
              { callId: 'call', path: '/students/0/student' },
            ],
          }),
          functionCalls: [],
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
      },
    })
    if (shouldPass) {
      assert.equal((await assistant.answer({ assistantEvidence: evidence() })).answer, answer)
    } else {
      await assert.rejects(
        assistant.answer({ assistantEvidence: evidence() }),
        error => error instanceof GeminiClassroomAssistantError && error.category === 'answer-unverified',
      )
    }
  }
})

test('requires student names to come from fields in cited calls', async () => {
  let count = 0
  const assistant = createGeminiClassroomAssistant({
    async generateContent() {
      count += 1
      if (count === 1) return {
        functionCalls: [
          { id: 'balances', name: 'get_balances', args: {} },
          { id: 'schema', name: 'describe_schema', args: {} },
        ],
        candidateContent: { role: 'model', parts: [{ functionCall: { id: 'balances', name: 'get_balances', args: {} } }] },
        finishReason: 'STOP',
        usageMetadata: USAGE,
      }
      return {
        text: JSON.stringify({
          answer: 'Ava is listed.',
          evidenceCallIds: ['schema'],
          factRefs: [{ callId: 'schema', path: '/classroomDate' }],
        }),
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

test('binds currency and count claims to exact typed result fields', async () => {
  for (const [answer, path, shouldPass] of [
    ["Ava's balance is $10.", '/students/0/currentBalance', true],
    ["Ava's balance is $1.", '/matchedCount', false],
    ['Ava has 1 transaction.', '/matchedCount', false],
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
        return {
          text: JSON.stringify({
            answer,
            evidenceCallIds: ['call'],
            factRefs: [
              { callId: 'call', path: '/students/0/student' },
              { callId: 'call', path },
            ],
          }),
          functionCalls: [],
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
      },
    })
    if (shouldPass) {
      assert.equal((await assistant.answer({ assistantEvidence: evidence() })).answer, answer)
    } else {
      await assert.rejects(
        assistant.answer({ assistantEvidence: evidence() }),
        error => error instanceof GeminiClassroomAssistantError && error.category === 'answer-unverified',
      )
    }
  }
})

test('requires a teacher-visible disclosure when cited tool output is truncated', async () => {
  for (const [answer, shouldPass] of [
    ['500 students had no matching rent transactions.', false],
    ['There are 500 students without rent transactions, which is more than last week.', false],
    ['Showing 25 of 500 students without matching rent transactions.', true],
  ]) {
    let count = 0
    const assistant = createGeminiClassroomAssistant({
      async generateContent() {
        count += 1
        if (count === 1) return {
          functionCalls: [{ id: 'call', name: 'find_students_without_transactions', args: { purpose: 'rent' } }],
          candidateContent: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'find_students_without_transactions', args: { purpose: 'rent' } } }] },
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
        return {
          text: JSON.stringify({
            answer,
            evidenceCallIds: ['call'],
            factRefs: [
              { callId: 'call', path: '/returnedCount' },
              { callId: 'call', path: '/currentStudentCount' },
              { callId: 'call', path: '/studentsWithoutCount' },
            ],
          }),
          functionCalls: [],
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
      },
    })
    if (shouldPass) {
      const result = await assistant.answer({ assistantEvidence: {
        ...evidence(),
        students: Array.from({ length: 500 }, (_, index) => ({
          ref: `student-${String(index + 1).padStart(3, '0')}`,
          displayName: `Learner ${String(index + 1).padStart(3, '0')}`,
          current: true,
          balance: index,
          frozen: false,
        })),
      } })
      assert.equal(result.answer, answer)
    } else {
      await assert.rejects(
        assistant.answer({ assistantEvidence: {
          ...evidence(),
          students: Array.from({ length: 500 }, (_, index) => ({
            ref: `student-${String(index + 1).padStart(3, '0')}`,
            displayName: `Learner ${String(index + 1).padStart(3, '0')}`,
            current: true,
            balance: index,
            frozen: false,
          })),
        } }),
        error => error instanceof GeminiClassroomAssistantError && error.category === 'answer-unverified',
      )
    }
  }
})

test('accepts a grounded truncated answer beginning with Not', async () => {
  let count = 0
  const assistant = createGeminiClassroomAssistant({
    async generateContent() {
      count += 1
      if (count === 1) return {
        functionCalls: [{ id: 'call', name: 'find_students_without_transactions', args: { purpose: 'rent' } }],
        candidateContent: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'find_students_without_transactions', args: { purpose: 'rent' } } }] },
        finishReason: 'STOP',
        usageMetadata: USAGE,
      }
      return {
        text: JSON.stringify({
          answer: 'Showing 25 of 29 students. Not all are listed: 29 students have not paid rent.',
          evidenceCallIds: ['call'],
          factRefs: [
            { callId: 'call', path: '/returnedCount' },
            { callId: 'call', path: '/studentsWithoutCount' },
          ],
        }),
        functionCalls: [],
        finishReason: 'STOP',
        usageMetadata: USAGE,
      }
    },
  })
  const students = Array.from({ length: 30 }, (_, index) => ({
    ref: `student-${String(index + 1).padStart(3, '0')}`,
    displayName: `Learner ${String(index + 1).padStart(3, '0')}`,
    current: true,
    balance: index,
    frozen: false,
  }))
  const result = await assistant.answer({ assistantEvidence: {
    ...evidence(),
    students,
    transactions: [{
      ref: 'transaction-00001',
      studentRef: 'student-001',
      date: '2026-08-27T15:01:00.000Z',
      type: 'Subtract',
      amount: 10,
      category: 'Rent',
      purpose: 'rent',
      status: 'Approved',
    }],
  } })
  assert.equal(result.answer, 'Showing 25 of 29 students. Not all are listed: 29 students have not paid rent.')
})

test('requires exact returned and total counts for every truncated tool shape', async () => {
  const cases = [
    {
      name: 'list_transactions',
      args: { limit: 1 },
      answer: 'Showing 1 of 2 matching transactions.',
      factRefs: ['/returnedCount', '/matchedCount'],
      assistantEvidence: evidence(),
    },
    {
      name: 'aggregate_transactions',
      args: { groupBy: ['amount'], metric: 'count', limit: 1 },
      answer: 'Showing 1 of 2 matching results.',
      factRefs: ['/returnedCount', '/resultCount'],
      assistantEvidence: {
        ...evidence(),
        transactions: evidence().transactions.map((transaction, index) => ({
          ...transaction,
          amount: 5 + index,
        })),
      },
    },
    {
      name: 'get_balances',
      args: { limit: 25 },
      answer: 'Showing 25 of 60 balances.',
      factRefs: ['/returnedCount', '/matchedCount'],
      assistantEvidence: {
        ...evidence(),
        students: Array.from({ length: 60 }, (_, index) => ({
          ref: `student-${String(index + 1).padStart(3, '0')}`,
          displayName: `Learner ${String(index + 1).padStart(3, '0')}`,
          current: true,
          balance: index,
          frozen: false,
        })),
      },
    },
  ]
  for (const scenario of cases) {
    let count = 0
    const assistant = createGeminiClassroomAssistant({
      async generateContent() {
        count += 1
        if (count === 1) return {
          functionCalls: [{ id: 'call', name: scenario.name, args: scenario.args }],
          candidateContent: { role: 'model', parts: [{ functionCall: { id: 'call', name: scenario.name, args: scenario.args } }] },
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
        return {
          text: JSON.stringify({
            answer: scenario.answer,
            evidenceCallIds: ['call'],
            factRefs: scenario.factRefs.map(path => ({ callId: 'call', path })),
          }),
          functionCalls: [],
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
      },
    })
    assert.equal(
      (await assistant.answer({ assistantEvidence: scenario.assistantEvidence })).answer,
      scenario.answer,
    )
  }
})
