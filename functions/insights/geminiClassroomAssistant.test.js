import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASSROOM_ASSISTANT_VALIDATION_SUBCATEGORIES,
  GeminiClassroomAssistantError,
  createGeminiClassroomAssistant,
} from './geminiClassroomAssistant.js'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'

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

function answerWithTool({
  assistantEvidence = evidence(),
  toolbox,
  name = 'get_balances',
  args = {},
  answer = 'There is 1 matching balance.',
  evidenceCallIds = ['call'],
  factRefs = [{ callId: 'call', path: '/matchedCount' }],
  finalFinishReason = 'STOP',
  usageByTurn = [USAGE, USAGE],
} = {}) {
  let turn = 0
  const assistant = createGeminiClassroomAssistant({
    async generateContent() {
      const usageMetadata = usageByTurn[turn] ?? USAGE
      turn += 1
      if (turn === 1) return {
        functionCalls: [{ id: 'call', name, args }],
        candidateContent: { role: 'model', parts: [{ functionCall: { id: 'call', name, args } }] },
        finishReason: 'STOP',
        usageMetadata,
      }
      return {
        text: JSON.stringify({ answer, evidenceCallIds, factRefs }),
        functionCalls: [],
        finishReason: finalFinishReason,
        usageMetadata,
      }
    },
  })
  return assistant.answer({ assistantEvidence, ...(toolbox ? { toolbox } : {}) })
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
          { callId: 'duplicate-check', path: '/rows/0/group/category' },
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

test('accepts cited multiword category labels without treating their words as student names', async () => {
  for (const category of ["Teacher's Choice", 'Class Job']) {
    let count = 0
    const assistant = createGeminiClassroomAssistant({
      async generateContent() {
        count += 1
        if (count === 1) return {
          functionCalls: [{ id: 'category-count', name: 'aggregate_transactions', args: {
            startDate: '2026-08-27',
            endDate: '2026-08-27',
            categoryContains: category,
            groupBy: ['category'],
            metric: 'count',
          } }],
          candidateContent: { role: 'model', parts: [{ functionCall: { id: 'category-count', name: 'aggregate_transactions', args: {} } }] },
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
        return {
          text: JSON.stringify({
            answer: `${category} had 2 matching transactions.`,
            evidenceCallIds: ['category-count'],
            factRefs: [
              { callId: 'category-count', path: '/rows/0/group/category' },
              { callId: 'category-count', path: '/rows/0/value' },
            ],
          }),
          functionCalls: [],
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
      },
    })
    const customEvidence = evidence()
    customEvidence.categories = [{ label: category, transactionTypes: ['Add'] }]
    customEvidence.transactions = customEvidence.transactions.map(transaction => ({
      ...transaction,
      category,
    }))
    assert.equal(
      (await assistant.answer({ assistantEvidence: customEvidence })).answer,
      `${category} had 2 matching transactions.`,
    )
  }
})

test('does not let cited free text or labels authorize invented student names elsewhere', async () => {
  for (const [category, answer] of [
    ['Priya Fund', "Priya's balance is $5."],
    ['Priya Fund', "Priya Fund is the cited category. Priya's balance is $5."],
    ['Ava Fund', 'Ava spent $5.'],
  ]) {
    let count = 0
    const assistant = createGeminiClassroomAssistant({
      async generateContent() {
        count += 1
        if (count === 1) return {
          functionCalls: [{ id: 'category', name: 'list_transactions', args: {} }],
          candidateContent: { role: 'model', parts: [{ functionCall: { id: 'category', name: 'list_transactions', args: {} } }] },
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
        return {
          text: JSON.stringify({
            answer,
            evidenceCallIds: ['category'],
            factRefs: [
              { callId: 'category', path: '/transactions/0/category' },
              { callId: 'category', path: '/transactions/0/amount' },
            ],
          }),
          functionCalls: [],
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
      },
    })
    const customEvidence = evidence()
    customEvidence.students = [{
      ...customEvidence.students[0],
      displayName: category.startsWith('Ava') ? 'Ava P.' : 'Ava',
    }]
    customEvidence.categories = [{ label: category, transactionTypes: ['Add'] }]
    customEvidence.transactions = customEvidence.transactions.map(transaction => ({
      ...transaction,
      category,
    }))
    await assert.rejects(
      assistant.answer({ assistantEvidence: customEvidence }),
      error => error instanceof GeminiClassroomAssistantError && error.category === 'answer-unverified',
    )
  }

  for (const memo of ['Paid Priya back for the pencil', 'Priya']) {
    let count = 0
    const assistant = createGeminiClassroomAssistant({
      async generateContent() {
        count += 1
        if (count === 1) return {
          functionCalls: [{ id: 'memo', name: 'list_transactions', args: { includeMemos: true } }],
          candidateContent: { role: 'model', parts: [{ functionCall: { id: 'memo', name: 'list_transactions', args: { includeMemos: true } } }] },
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
        return {
          text: JSON.stringify({
            answer: 'Priya: $5.',
            evidenceCallIds: ['memo'],
            factRefs: [
              { callId: 'memo', path: '/transactions/0/memo' },
              { callId: 'memo', path: '/transactions/0/amount' },
            ],
          }),
          functionCalls: [],
          finishReason: 'STOP',
          usageMetadata: USAGE,
        }
      },
    })
    const assistantEvidence = evidence()
    const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
      memoResolver: () => Object.freeze({ text: memo, truncated: false }),
    })
    await assert.rejects(
      assistant.answer({ assistantEvidence, toolbox }),
      error => error instanceof GeminiClassroomAssistantError && error.category === 'answer-unverified',
    )
  }
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

test('rejects every uncited capitalized identity while preserving ordinary language and cited names', async () => {
  for (const [answer, factPath, shouldPass] of [
    ['Priya has 1 matching balance.', '/matchedCount', false],
    ["Priya's balance is $10.", '/students/0/currentBalance', false],
    ['Ava and Priya have 1 matching balance.', '/matchedCount', false],
    ['Priya: $10.', '/students/0/currentBalance', false],
    ['There is 1 matching balance for Ava.', '/matchedCount', true],
    ['Overall, there is 1 matching balance for Ava.', '/matchedCount', true],
    ["Ava's balance is $10.", '/students/0/currentBalance', true],
    ["Today's balance total is $10.", '/students/0/currentBalance', true],
    ["It's 1 matching balance.", '/matchedCount', true],
    ['I’m seeing 1 matching balance.', '/matchedCount', true],
    ['Unfortunately, there is 1 matching balance.', '/matchedCount', true],
    ['Some students have 1 matching balance.', '/matchedCount', true],
    ['Deposits show 1 matching balance.', '/matchedCount', true],
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
              { callId: 'call', path: factPath },
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

test('answers the memo-wording question over a stated 30-day window', async () => {
  const assistantEvidence = {
    ...evidence(),
    question: 'In the last 30 days, what wording appears in the transaction memos?',
    periodDays: 30,
    periodStart: '2026-07-28T18:00:00.000Z',
  }
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Rent payment for the week', truncated: false }),
  })
  const answer = 'Across the last 30 days, the memo wording includes "Rent payment for the week" in a list of 2 matching transactions.'
  const result = await answerWithTool({
    assistantEvidence,
    toolbox,
    name: 'list_transactions',
    args: {
      startDate: '2026-07-29',
      endDate: '2026-08-27',
      includeMemos: true,
    },
    answer,
    factRefs: [
      { callId: 'call', path: '/windowDays' },
      { callId: 'call', path: '/transactions/0/memo' },
      { callId: 'call', path: '/matchedCount' },
    ],
  })
  assert.equal(result.answer, answer)
})

test('answers the newest sanitized memo question inside a 30-day period', async () => {
  const assistantEvidence = {
    ...evidence(),
    question: 'What is the sanitized memo on the newest transaction in this 30-day period?',
    periodDays: 30,
    periodStart: '2026-07-28T18:00:00.000Z',
  }
  assistantEvidence.transactions = assistantEvidence.transactions.slice(0, 1)
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Paid rent [contact removed] thanks', truncated: false }),
  })
  const answer = 'In this 30-day period, the newest transaction on August 27, 2026 has the memo "Paid rent [contact removed] thanks".'
  const result = await answerWithTool({
    assistantEvidence,
    toolbox,
    name: 'list_transactions',
    args: {
      startDate: '2026-07-29',
      endDate: '2026-08-27',
      includeMemos: true,
      limit: 1,
      sort: 'newest',
    },
    answer,
    factRefs: [
      { callId: 'call', path: '/windowDays' },
      { callId: 'call', path: '/transactions/0/memo' },
      { callId: 'call', path: '/transactions/0/classroomDate' },
    ],
  })
  assert.equal(result.answer, answer)
})

test('rejects a stated window length that is absent or does not match the applied range', async () => {
  for (const [answer, factRefs] of [
    ['Across the last 30 days, there are 2 matching transactions.', [
      { callId: 'call', path: '/matchedCount' },
    ]],
    ['Across the last 14 days, there are 2 matching transactions.', [
      { callId: 'call', path: '/windowDays' },
      { callId: 'call', path: '/matchedCount' },
    ]],
  ]) {
    await assert.rejects(
      answerWithTool({
        name: 'list_transactions',
        args: { startDate: '2026-07-29', endDate: '2026-08-27' },
        answer,
        factRefs,
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.category === 'answer-unverified' &&
        error.subcategory === 'unsupported-number',
    )
  }
})

test('allows only exact quoted spans from cited memo fields', async () => {
  const assistantEvidence = evidence()
  assistantEvidence.transactions = assistantEvidence.transactions.slice(0, 1)
  for (const scenario of [
    {
      memo: 'Rent payment for the week',
      answer: '"Rent payment for the week" is the cited memo.',
      shouldPass: true,
    },
    {
      memo: 'Ask Jordan Blake about this',
      answer: '"Ask Jordan Blake about this" is the cited memo. Jordan Blake appears again.',
      shouldPass: false,
    },
    {
      memo: 'Rent payment for the week',
      answer: '"Rent payment for the month" is the cited memo.',
      shouldPass: false,
    },
  ]) {
    const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
      memoResolver: () => ({ text: scenario.memo, truncated: false }),
    })
    const operation = answerWithTool({
      assistantEvidence,
      toolbox,
      name: 'list_transactions',
      args: { includeMemos: true, limit: 1 },
      answer: scenario.answer,
      factRefs: [{ callId: 'call', path: '/transactions/0/memo' }],
    })
    if (scenario.shouldPass) {
      assert.equal((await operation).answer, scenario.answer)
    } else {
      await assert.rejects(
        operation,
        error => error instanceof GeminiClassroomAssistantError &&
          error.category === 'answer-unverified' &&
          error.subcategory === 'unknown-identity',
      )
    }
  }
})

test('rejects an uncited roster name even inside a correctly quoted memo', async () => {
  const assistantEvidence = evidence()
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Ava paid rent', truncated: false }),
  })
  await assert.rejects(
    answerWithTool({
      assistantEvidence,
      toolbox,
      name: 'list_transactions',
      args: { includeMemos: true, limit: 1 },
      answer: '"Ava paid rent" is the cited memo.',
      factRefs: [{ callId: 'call', path: '/transactions/0/memo' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.category === 'answer-unverified' &&
      error.subcategory === 'uncited-roster-name',
  )
})

test('requires the exact showing-of disclosure when a memo listing is truncated', async () => {
  const assistantEvidence = evidence()
  assistantEvidence.transactions = Array.from({ length: 60 }, (_, index) => ({
    ...assistantEvidence.transactions[index % assistantEvidence.transactions.length],
    ref: `transaction-${String(index + 1).padStart(5, '0')}`,
    date: `2026-08-${String(21 + (index % 7)).padStart(2, '0')}T15:${String(index % 60).padStart(2, '0')}:00.000Z`,
  }))
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Rent payment for the week', truncated: false }),
  })
  const factRefs = [
    { callId: 'call', path: '/returnedCount' },
    { callId: 'call', path: '/matchedCount' },
    { callId: 'call', path: '/transactions/0/memo' },
  ]
  await assert.rejects(
    answerWithTool({
      assistantEvidence,
      toolbox,
      name: 'list_transactions',
      args: { includeMemos: true },
      answer: 'The first memo is "Rent payment for the week".',
      factRefs,
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'truncation-not-disclosed',
  )
  const answer = 'Showing 50 of 60 matching transactions. The first memo is "Rent payment for the week".'
  assert.equal((await answerWithTool({
    assistantEvidence,
    toolbox,
    name: 'list_transactions',
    args: { includeMemos: true },
    answer,
    factRefs,
  })).answer, answer)
})

test('rejects a MAX_TOKENS turn as provider-output-truncated', async () => {
  await assert.rejects(
    answerWithTool({ finalFinishReason: 'MAX_TOKENS' }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.category === 'provider-output-truncated',
  )
})

test('accumulates cached and tool-use prompt tokens across turns', async () => {
  const firstUsage = {
    promptTokenCount: 10,
    candidatesTokenCount: 4,
    thoughtsTokenCount: 1,
    cachedContentTokenCount: 7,
    toolUsePromptTokenCount: 3,
    totalTokenCount: 18,
  }
  const secondUsage = {
    promptTokenCount: 12,
    candidatesTokenCount: 5,
    thoughtsTokenCount: 2,
    cachedContentTokenCount: 8,
    toolUsePromptTokenCount: 4,
    totalTokenCount: 23,
  }
  const result = await answerWithTool({ usageByTurn: [firstUsage, secondUsage] })
  assert.deepEqual(result.usage, { inputTokens: 29, outputTokens: 9, thinkingTokens: 3 })
})

test('every final-answer validation failure carries an allowlisted subcategory', async () => {
  assert.equal(Object.isFrozen(CLASSROOM_ASSISTANT_VALIDATION_SUBCATEGORIES), true)
  const validFactRefs = [{ callId: 'call', path: '/matchedCount' }]
  const scenarios = [
    { answer: 'x', factRefs: validFactRefs, subcategory: 'answer-shape' },
    { answer: 'Visit https://example.com.', factRefs: validFactRefs, subcategory: 'answer-contact-pattern' },
    { answer: 'The student-001 record is present.', factRefs: validFactRefs, subcategory: 'answer-opaque-ref' },
    { answer: 'There is 1 matching balance.', evidenceCallIds: [], factRefs: validFactRefs, subcategory: 'evidence-call-ids' },
    { answer: 'There is 1 matching balance.', factRefs: [], subcategory: 'fact-refs-shape' },
    { answer: 'There is 1 matching balance.', factRefs: [...validFactRefs, ...validFactRefs], subcategory: 'fact-ref-duplicate' },
    { answer: 'There is 1 matching balance.', factRefs: [{ callId: 'call', path: '/__proto__' }], subcategory: 'fact-ref-unsafe-path' },
    { answer: 'There is 1 matching balance.', factRefs: [{ callId: 'call', path: '/missing' }], subcategory: 'fact-ref-unavailable' },
    { answer: 'There is 1 matching balance.', factRefs: [{ callId: 'call', path: '/students' }], subcategory: 'fact-ref-non-scalar' },
    { answer: 'There is one balance.', factRefs: validFactRefs, subcategory: 'number-words' },
    { answer: 'There are 2 matching balances.', factRefs: validFactRefs, subcategory: 'unsupported-number' },
    { answer: 'The date is August 26, 2026.', factRefs: validFactRefs, subcategory: 'unsupported-date' },
    { answer: 'Ava is listed.', factRefs: validFactRefs, subcategory: 'uncited-roster-name' },
    { answer: 'Priya is listed.', factRefs: validFactRefs, subcategory: 'unknown-identity' },
  ]
  for (const scenario of scenarios) {
    await assert.rejects(
      answerWithTool(scenario),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === scenario.subcategory &&
        CLASSROOM_ASSISTANT_VALIDATION_SUBCATEGORIES.has(error.subcategory),
    )
  }
})
