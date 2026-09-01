import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASSROOM_ASSISTANT_VALIDATION_SUBCATEGORIES,
  GeminiClassroomAssistantError,
  buildGeminiClassroomAssistantRequest,
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

test('the outbound system instruction roots factRef paths at the call result and forbids wrapper prefixes', () => {
  const request = buildGeminiClassroomAssistantRequest({
    contents: [{ role: 'user', parts: [{ text: 'test' }] }],
    declarations: [],
    requireTool: false,
  })
  const instruction = request.config.systemInstruction
  assert.match(instruction, /rooted directly at that call.s result object/u)
  assert.match(instruction, /\/windowDays/u)
  assert.match(instruction, /\/rows\/0\/group\/category/u)
  assert.match(instruction, /never prefix a path with the tool name, the call id, or a wrapper word like result or output/iu)
})

test('the outbound system instruction tells the model to omit dates for a standard rolling window', () => {
  const request = buildGeminiClassroomAssistantRequest({
    contents: [{ role: 'user', parts: [{ text: 'test' }] }],
    declarations: [],
    requireTool: false,
  })
  const instruction = request.config.systemInstruction
  assert.match(instruction, /call it without startDate or endDate whenever the requested window is 7, 30, or 90 days/iu)
  assert.match(instruction, /do not set your own startDate or endDate on those three tools just to match a day count the teacher stated/iu)
  assert.match(instruction, /list_transactions, aggregate_transactions, or find_students_without_transactions/iu)
  assert.match(instruction, /get_balances and get_balance_history never include selectedPeriodDays/iu)
  assert.match(instruction, /call describe_schema and cite its selectedPeriodDays instead/iu)
})

test('the outbound system instruction requires a citation for every named category even without a number', () => {
  const request = buildGeminiClassroomAssistantRequest({
    contents: [{ role: 'user', parts: [{ text: 'test' }] }],
    declarations: [],
    requireTool: false,
  })
  const instruction = request.config.systemInstruction
  assert.match(instruction, /a category or label you name only for comparison, contrast, or context/iu)
  assert.match(instruction, /never name a student, category, or label in your answer unless you also cite the exact tool result field/iu)
})

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

test('applies roster-only grounding to names found in cited free text and labels', async () => {
  for (const [category, answer, shouldPass] of [
    ['Priya Fund', "Priya's balance is $5.", true],
    ['Priya Fund', "Priya Fund is the cited category. Priya's balance is $5.", true],
    ['Ava Fund', 'Ava spent $5.', false],
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
    const operation = assistant.answer({ assistantEvidence: customEvidence })
    if (shouldPass) {
      assert.equal((await operation).answer, answer)
    } else {
      await assert.rejects(
        operation,
        error => error instanceof GeminiClassroomAssistantError &&
          error.subcategory === 'uncited-roster-name',
      )
    }
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
    assert.equal(
      (await assistant.answer({ assistantEvidence, toolbox })).answer,
      'Priya: $5.',
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

test('accepts a non-roster two-part identity under the roster-only contract', async () => {
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
  assert.equal(
    (await assistant.answer({ assistantEvidence: evidence() })).answer,
    'Michael R. has 1 matching balance.',
  )
})

test('accepts non-roster identities while preserving cited roster names and ordinary language', async () => {
  for (const [answer, factPath] of [
    ['Priya has 1 matching balance.', '/matchedCount'],
    ["Priya's balance is $10.", '/students/0/currentBalance'],
    ['Ava and Priya have 1 matching balance.', '/matchedCount'],
    ['Priya: $10.', '/students/0/currentBalance'],
    ['There is 1 matching balance for Ava.', '/matchedCount'],
    ['Overall, there is 1 matching balance for Ava.', '/matchedCount'],
    ["Ava's balance is $10.", '/students/0/currentBalance'],
    ["Today's balance total is $10.", '/students/0/currentBalance'],
    ["It's 1 matching balance.", '/matchedCount'],
    ['I’m seeing 1 matching balance.', '/matchedCount'],
    ['Unfortunately, there is 1 matching balance.', '/matchedCount'],
    ['Some students have 1 matching balance.', '/matchedCount'],
    ['Deposits show 1 matching balance.', '/matchedCount'],
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
    assert.equal((await assistant.answer({ assistantEvidence: evidence() })).answer, answer)
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
    args: { includeMemos: true },
    answer,
    factRefs: [
      { callId: 'call', path: '/selectedPeriodDays' },
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
      includeMemos: true,
      limit: 1,
      sort: 'newest',
    },
    answer,
    factRefs: [
      { callId: 'call', path: '/selectedPeriodDays' },
      { callId: 'call', path: '/transactions/0/memo' },
      { callId: 'call', path: '/transactions/0/classroomDate' },
    ],
  })
  assert.equal(result.answer, answer)
})

test('rejects selected-window wording when only the default calendar span is cited', async () => {
  const assistantEvidence = {
    ...evidence(),
    question: 'What happened in the last 30 days?',
    periodDays: 30,
    periodStart: '2026-07-28T18:00:00.000Z',
  }
  await assert.rejects(
    answerWithTool({
      assistantEvidence,
      name: 'list_transactions',
      answer: 'Across the last 30 days, there are 2 matching transactions.',
      factRefs: [
        { callId: 'call', path: '/windowDays' },
        { callId: 'call', path: '/matchedCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.category === 'answer-unverified' &&
      error.subcategory === 'unsupported-number',
  )
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
      memo: 'Bonus for Technology help',
      answer: '"Bonus for Technology help" is the cited memo.',
      additionalFactRefs: [{ callId: 'call', path: '/transactions/0/category' }],
      shouldPass: true,
    },
    {
      memo: 'Paid Ava back for lunch',
      answer: '"Paid Ava back for lunch" is the cited memo.',
      additionalFactRefs: [{ callId: 'call', path: '/transactions/0/student' }],
      shouldPass: true,
    },
    {
      memo: 'Ask Jordan Blake about this',
      answer: '"Ask Jordan Blake about this" is the cited memo. Jordan Blake appears again.',
      shouldPass: true,
    },
    {
      memo: 'Rent payment for the week',
      answer: '"Rent payment for the month" is the cited memo.',
      shouldPass: false,
      subcategory: 'quoted-span-unverified',
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
      factRefs: [
        { callId: 'call', path: '/transactions/0/memo' },
        ...(scenario.additionalFactRefs ?? []),
      ],
    })
    if (scenario.shouldPass) {
      assert.equal((await operation).answer, scenario.answer)
    } else {
      await assert.rejects(
        operation,
        error => error instanceof GeminiClassroomAssistantError &&
          error.category === 'answer-unverified' &&
          error.subcategory === scenario.subcategory,
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

test('requires both truncation counts in one sentence, in any natural wording', async () => {
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

// Grok/canary follow-up 2026-09-01. The live canary refused a correct answer
// because the disclosure had to read exactly "showing N of M". The protection is
// that the teacher sees both real numbers together, not that one phrasing was
// used, so the wording is now free and the numbers are not.
test('accepts any wording that puts both truncation counts in one sentence', async () => {
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
  const tail = ' The first memo is "Rent payment for the week".'
  const accepted = [
    'Showing 50 of 60 matching transactions.',
    'Showing the first 50 of 60 matching transactions.',
    'Only 50 of 60 matching transactions are listed.',
    'This lists 50 of 60 matching transactions.',
    '50 out of 60 matching transactions are included.',
    'I returned 50 of 60 matching transactions.',
  ]
  for (const disclosure of accepted) {
    const answer = `${disclosure}${tail}`
    assert.equal((await answerWithTool({
      assistantEvidence,
      toolbox,
      name: 'list_transactions',
      args: { includeMemos: true },
      answer,
      factRefs,
    })).answer, answer, `should accept: ${disclosure}`)
  }
})

test('still refuses a truncated listing when a count is wrong, absent, or split across sentences', async () => {
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
  const tail = ' The first memo is "Rent payment for the week".'
  const refused = [
    // No numbers at all -- the teacher cannot tell how much is missing.
    'Some matching transactions are not shown.',
    // Only the returned count. The total is the number that matters most.
    'Showing the first 50 matching transactions.',
    // A total that is not the real one.
    'Showing 50 of 61 matching transactions.',
    // Both numbers present but not read together as one disclosure.
    'There are 50 here. Separately, the classroom has 60 matching transactions.',
    // A bare "of" with nothing marking the listing as partial.
    'Transaction 50 of 60 is the newest.',
  ]
  for (const disclosure of refused) {
    await assert.rejects(
      answerWithTool({
        assistantEvidence,
        toolbox,
        name: 'list_transactions',
        args: { includeMemos: true },
        answer: `${disclosure}${tail}`,
        factRefs,
      }),
      // A wrong total is caught by numeric grounding before the disclosure
      // check ever runs, so the property under test is that the answer is
      // refused, not which of the two gates caught it first.
      error => error instanceof GeminiClassroomAssistantError &&
        error.category === 'answer-unverified',
      `should refuse: ${disclosure}`,
    )
  }
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

// Teachers read a date as "August 27", not "2026-08-27". Requiring the year
// left the day number in the answer for the numeric scan to find, so an
// ordinary correct sentence was refused as an uncited quantity. Verification
// still binds every spelling to a date the answer actually cited.
// A modifier between the number word and the noun hid a spelled-out quantity
// from both this check and the digit scan, so a false count could reach the
// teacher. This is the one failure in this family that admits a wrong answer
// rather than refusing a right one.
test('a spelled-out quantity is refused even behind a modifier', async () => {
  for (const claim of [
    'There are seven transactions',
    'There are seven matching transactions',
    'There are twelve approved transactions',
    'There are five recently approved payments',
    'Three current students earned money',
    'There are two matching balances',
  ]) {
    await assert.rejects(
      answerWithTool({ answer: `${claim}.` }),
      error => error instanceof GeminiClassroomAssistantError && error.subcategory === 'number-words',
    )
  }
})

test('ordinary partitive wording is not read as a spelled-out quantity', async () => {
  // "one of the students" is how the sentence reads, not a count written out.
  // Refusing it would trade a false-answer bug for a false-refusal bug.
  for (const phrasing of [
    'There is 1 matching balance, one of the balances in the class',
    'There is 1 matching balance for one of the students',
  ]) {
    const result = await answerWithTool({ answer: `${phrasing}.` })
    assert.equal(result.answer, `${phrasing}.`)
  }
})

test('a cited date is verified in the spellings a teacher actually writes', async () => {
  for (const phrasing of [
    'on 2026-08-27',
    'on August 27, 2026',
    'on August 27',
    'on Aug 27',
    'on August 27th',
    'on Thursday, August 27',
  ]) {
    const result = await answerWithTool({ answer: `There is 1 matching balance ${phrasing}.` })
    assert.equal(result.answer, `There is 1 matching balance ${phrasing}.`)
  }
})

test('widening date spellings still refuses a date no cited fact covers', async () => {
  for (const phrasing of [
    'on August 26',
    'on Aug 26',
    'on August 26th',
    'on Wednesday, August 26',
    'on August 27, 2024',
    'on February 30',
  ]) {
    await assert.rejects(
      answerWithTool({ answer: `There is 1 matching balance ${phrasing}.` }),
      error => error instanceof GeminiClassroomAssistantError && error.subcategory === 'unsupported-date',
    )
  }
})

test('a bare ordinal naming a cited day reads as a date', async () => {
  for (const phrasing of [
    'on the 27th',
    'from the 27th',
    'on the 27th and the 27th',
  ]) {
    const result = await answerWithTool({ answer: `There is 1 matching balance ${phrasing}.` })
    assert.equal(result.answer, `There is 1 matching balance ${phrasing}.`)
  }
})

test('a bare ordinal naming an uncited day is still refused', async () => {
  for (const phrasing of ['on the 14th', 'from the 1st', 'on the 30th']) {
    await assert.rejects(
      answerWithTool({ answer: `There is 1 matching balance ${phrasing}.` }),
      error => error instanceof GeminiClassroomAssistantError && error.subcategory === 'unsupported-date',
    )
  }
})

test('an ordinal that ranks something still needs a citation', async () => {
  // A rank names the thing it ranks, which is what separates it from a date.
  // "the 27th transaction" must not ride through on the cited 27th.
  for (const phrasing of [
    'and it is the 3rd transaction',
    'and it is the 27th transaction',
    'and it is the 2nd highest balance',
    'and Ava is the 5th student listed',
  ]) {
    await assert.rejects(
      answerWithTool({ answer: `There is 1 matching balance ${phrasing}.` }),
      error => error instanceof GeminiClassroomAssistantError &&
        ['unsupported-number', 'uncited-roster-name'].includes(error.subcategory),
    )
  }
})

test('a month word cannot launder an uncited count into a date', async () => {
  // "In May 5 students earned money" reads as a date to the scanner. It must
  // not become a way to state 5 without citing it.
  await assert.rejects(
    answerWithTool({ answer: 'There is 1 matching balance. In May 5 students earned money.' }),
    error => error instanceof GeminiClassroomAssistantError &&
      ['unsupported-date', 'unsupported-number'].includes(error.subcategory),
  )
})

test('a refusal over a student name carries no diagnostic detail at all', async () => {
  // The only token this check can flag is a real roster name, so there is
  // nothing about it that is safe to put in a log.
  const assistantEvidence = evidence()
  assistantEvidence.students = [
    { ref: 'student-001', displayName: 'Ava Chen', current: true, balance: 10, frozen: false },
  ]
  let error
  await assert.rejects(
    answerWithTool({ assistantEvidence, answer: 'Chen has 1 matching balance.' }),
    caught => {
      error = caught
      return caught instanceof GeminiClassroomAssistantError &&
        caught.subcategory === 'uncited-roster-name'
    },
  )
  assert.equal(error.diagnostic, null)
  assert.equal(JSON.stringify(error.diagnostic ?? {}).includes('Chen'), false)
})

test('ordinary capitalized words are unaffected by roster-only grounding', async () => {
  for (const answer of [
    'Approximately 1 matching balance is recorded.',
    'Interestingly, there is 1 matching balance.',
    'Significantly fewer than 1 matching balance would be unusual; there is 1 matching balance.',
    'Encouragingly, there is 1 matching balance.',
  ]) {
    const result = await answerWithTool({ answer })
    assert.equal(result.answer, answer)
  }
})

test('ordinary sentence openers are unaffected by roster-only grounding', async () => {
  const openers = [
    'Interestingly', 'Approximately', 'Significantly', 'Alternatively',
    'Encouragingly', 'Comparatively', 'Understanding', 'Participation',
    'Additionally', 'Specifically', 'Nevertheless', 'Consistently',
    'Historically', 'Collectively', 'Notably', 'Meanwhile', 'Similarly',
    'Conversely', 'Combined', 'Together', 'Looking', 'Given', 'Assuming',
    'Considering', 'Roughly', 'Nearly', 'Almost', 'Slightly', 'Therefore',
    'Please', 'Remember', 'Consider', 'Ranked', 'Sorted', 'Grouped',
  ]
  for (const opener of openers) {
    for (const answer of [
      `${opener}, there is 1 matching balance.`,
      `${opener} the class has 1 matching balance.`,
    ]) {
      assert.equal((await answerWithTool({ answer })).answer, answer)
    }
  }
})

test('accepts non-roster identities regardless of sentence position', async () => {
  for (const answer of [
    'Priya has 1 matching balance.',
    "Priya's balance is 1 matching balance.",
    'There is 1 matching balance for Priya.',
    'The only current student is Priya.',
    // A label, a roll call, and a conjunction each attribute as surely as a verb.
    'Priya: 1 matching balance.',
    'Priya, Marco, and Ben share 1 matching balance.',
    'Top savers: Priya and Marco across 1 matching balance.',
    'Jordan Blake appears in 1 matching balance.',
    // Verbs outside the common set still read as a person acting.
    'Priya appears in 1 matching balance.',
    'Priya shows 1 matching balance.',
    'Priya recorded 1 matching balance.',
    'Priya seems to hold 1 matching balance.',
  ]) {
    assert.equal((await answerWithTool({ answer })).answer, answer)
  }
})

test('requires an uncited roster name part in every sentence position', async () => {
  const assistantEvidence = evidence()
  assistantEvidence.students = [
    { ref: 'student-001', displayName: 'Ava Chen', current: true, balance: 10, frozen: false },
  ]
  for (const answer of [
    'Chen has 1 matching balance.',
    'Chen appears in 1 matching balance.',
    'Chen, Marco, and Ben share 1 matching balance.',
    'There is 1 matching balance for Chen.',
  ]) {
    await assert.rejects(
      answerWithTool({ assistantEvidence, answer }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'uncited-roster-name',
    )
  }
})

test('a cited roster display name grounds both the full name and its parts', async () => {
  const assistantEvidence = evidence()
  assistantEvidence.students = [
    { ref: 'student-001', displayName: 'Ava Chen', current: true, balance: 10, frozen: false },
  ]
  const factRefs = [
    { callId: 'call', path: '/students/0/student' },
    { callId: 'call', path: '/matchedCount' },
  ]
  for (const answer of [
    'Ava Chen has 1 matching balance.',
    'Ava has 1 matching balance.',
    'Chen has 1 matching balance.',
  ]) {
    assert.equal((await answerWithTool({ assistantEvidence, answer, factRefs })).answer, answer)
  }
})

test('ordinary lowercase name words remain usable while capitalized roster references are grounded', async () => {
  const assistantEvidence = evidence()
  assistantEvidence.students = [
    { ref: 'student-001', displayName: 'May Grace', current: true, balance: 10, frozen: false },
  ]
  for (const answer of [
    'We may have 1 matching balance.',
    'This grace period has 1 matching balance.',
  ]) {
    assert.equal((await answerWithTool({ assistantEvidence, answer })).answer, answer)
  }
  for (const answer of [
    'May has 1 matching balance.',
    'GRACE has 1 matching balance.',
  ]) {
    await assert.rejects(
      answerWithTool({ assistantEvidence, answer }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'uncited-roster-name',
    )
  }
})

test('an uncited single-word roster name requires name-like capitalization', async () => {
  const assistantEvidence = evidence()
  assistantEvidence.students = [
    { ref: 'student-001', displayName: 'Will', current: true, balance: 10, frozen: false },
  ]
  await assert.rejects(
    answerWithTool({ assistantEvidence, answer: 'Will has 1 matching balance.' }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'uncited-roster-name',
  )
  const ordinaryProse = 'Students will reach 1 matching balance.'
  assert.equal(
    (await answerWithTool({ assistantEvidence, answer: ordinaryProse })).answer,
    ordinaryProse,
  )
})

test('attributes overlapping full roster labels to the longest exact match', async () => {
  for (const scenario of [
    {
      displayNames: ['Ava P.', 'Ava P. (2)'],
      citedIndex: 1,
      answer: 'Ava P. has 2 matching balances.',
      shouldPass: false,
    },
    {
      displayNames: ['Ava', 'Ava (2)'],
      citedIndex: 1,
      answer: 'Ava has 2 matching balances.',
      shouldPass: false,
    },
    {
      displayNames: ['Ava P.', 'Ava P. (2)'],
      citedIndex: 0,
      answer: 'Ava P. (2) has 2 matching balances.',
      shouldPass: false,
    },
    {
      displayNames: ['Ava P.', 'Ava P. (2)'],
      citedIndex: 1,
      answer: 'Ava P. (2) has 2 matching balances.',
      shouldPass: true,
    },
    {
      displayNames: ['Ava P.', 'Ava S.'],
      citedIndex: 0,
      answer: 'Ava has 2 matching balances.',
      shouldPass: true,
    },
  ]) {
    const assistantEvidence = evidence()
    assistantEvidence.students = scenario.displayNames.map((displayName, index) => ({
      ref: `student-${String(index + 1).padStart(3, '0')}`,
      displayName,
      current: true,
      balance: 10 - index,
      frozen: false,
    }))
    const operation = answerWithTool({
      assistantEvidence,
      answer: scenario.answer,
      factRefs: [
        { callId: 'call', path: `/students/${scenario.citedIndex}/student` },
        { callId: 'call', path: '/matchedCount' },
      ],
    })
    if (scenario.shouldPass) {
      assert.equal((await operation).answer, scenario.answer)
    } else {
      await assert.rejects(
        operation,
        error => error instanceof GeminiClassroomAssistantError &&
          error.subcategory === 'uncited-roster-name',
      )
    }
  }
})

test('a non-roster name repeated from a cited memo does not trigger identity grounding', async () => {
  const assistantEvidence = evidence()
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => Object.freeze({ text: 'priya', truncated: false }),
  })
  const factRefs = [
    { callId: 'call', path: '/transactions/0/memo' },
    { callId: 'call', path: '/transactions/0/amount' },
  ]
  assert.equal((await answerWithTool({
    toolbox,
    name: 'list_transactions',
    args: { includeMemos: true },
    answer: 'Priya is listed.',
    factRefs,
  })).answer, 'Priya is listed.')
})

test('unsupported-number diagnostic includes numeric facts only', async () => {
  const privateLabel = 'Private Classroom Label'
  const assistantEvidence = evidence()
  assistantEvidence.categories = [{ label: privateLabel, transactionTypes: ['Add'] }]
  assistantEvidence.transactions = assistantEvidence.transactions.map(transaction => ({
    ...transaction,
    category: privateLabel,
  }))
  let diagnostic
  await assert.rejects(
    answerWithTool({
      assistantEvidence,
      name: 'list_transactions',
      answer: `${privateLabel} had 99 matching transactions.`,
      factRefs: [
        { callId: 'call', path: '/transactions/0/category' },
        { callId: 'call', path: '/matchedCount' },
      ],
    }),
    error => {
      diagnostic = error.diagnostic
      return error instanceof GeminiClassroomAssistantError &&
        error.category === 'answer-unverified' &&
        error.subcategory === 'unsupported-number'
    },
  )
  // The comparison set is every scalar in the cited results, so the diagnostic
  // reports the kinds available to match the claim and never their values.
  assert.deepEqual(diagnostic, {
    claimKind: 'transaction-count',
    numericFactCount: diagnostic.numericFactCount,
    numericFactKinds: diagnostic.numericFactKinds,
    distinctWindowCount: diagnostic.distinctWindowCount,
  })
  // The guarantee is the key set: no classroom value can appear in a log that
  // carries only a claim kind, two counts, and a list of kinds.
  assert.deepEqual(
    Object.keys(diagnostic).sort(),
    ['claimKind', 'distinctWindowCount', 'numericFactCount', 'numericFactKinds'],
  )
  assert.ok(diagnostic.numericFactKinds.includes('transaction-count'))
  assert.equal(diagnostic.numericFactKinds.every(kind => typeof kind === 'string'), true)
  assert.equal(JSON.stringify(diagnostic).includes(privateLabel), false)
})

test('unsupported-number diagnostic anonymizes matching and different fact windows', async () => {
  const assistantEvidence = twoStudentEvidence()
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Private memo text', truncated: false }),
  })
  const calls = [DEFAULT_LIST, DEFAULT_WITHOUT, ONE_DAY_LIST]
  const factRefs = [
    { callId: DEFAULT_LIST.id, path: '/matchedCount' },
    { callId: DEFAULT_WITHOUT.id, path: '/studentsWithoutCount' },
    { callId: ONE_DAY_LIST.id, path: '/matchedCount' },
  ]
  let diagnostic
  await assert.rejects(
    answerWithTools({
      assistantEvidence,
      toolbox,
      calls,
      answer: 'There are 999 results.',
      factRefs,
    }),
    error => {
      diagnostic = error.diagnostic
      return error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-number'
    },
  )
  // Two of the three calls share a range and the third does not, so the
  // diagnostic reports two distinct windows without naming either one.
  assert.equal(diagnostic.distinctWindowCount, 2)
  assert.equal(Object.hasOwn(diagnostic, 'numericFacts'), false)
  const serialized = JSON.stringify(diagnostic)
  for (const call of calls) {
    const result = toolbox.execute(call.name, call.args)
    for (const date of [result.windowStartDate, result.windowEndDate]) {
      if (typeof date === 'string') assert.equal(serialized.includes(date), false)
    }
  }
})

test('fact-ref-unavailable diagnostic allowlists schema fields and redacts every other segment', async () => {
  for (const unsafeSegment of ['memo with spaces', 'Andrew']) {
    let diagnostic
    await assert.rejects(
      answerWithTool({
        name: 'list_transactions',
        answer: 'There is 1 matching transaction.',
        factRefs: [{ callId: 'call', path: `/transactions/0/${unsafeSegment}` }],
      }),
      error => {
        diagnostic = error.diagnostic
        return error instanceof GeminiClassroomAssistantError &&
          error.subcategory === 'fact-ref-unavailable'
      },
    )
    assert.equal(diagnostic.toolName, 'list_transactions')
    assert.equal(diagnostic.path, '/transactions/0/<redacted>')
    assert.equal(diagnostic.failedAtSegment, '<redacted>')
    assert.equal(JSON.stringify(diagnostic).includes(unsafeSegment), false)
  }

  const unsafeKeyToolbox = {
    context: {},
    declarations: [],
    execute() {
      return { ok: true, Andrew: 1, 'memo with spaces': 2 }
    },
  }
  let availableKeysDiagnostic
  await assert.rejects(
    answerWithTool({
      toolbox: unsafeKeyToolbox,
      name: 'list_transactions',
      answer: 'There is 1 matching transaction.',
      factRefs: [{ callId: 'call', path: '/matchedCount' }],
    }),
    error => {
      availableKeysDiagnostic = error.diagnostic
      return error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'fact-ref-unavailable'
    },
  )
  assert.deepEqual(
    availableKeysDiagnostic.availableKeysAtFailure,
    ['ok', '<redacted>', '<redacted>'],
  )
  assert.equal(JSON.stringify(availableKeysDiagnostic).includes('Andrew'), false)
  assert.equal(JSON.stringify(availableKeysDiagnostic).includes('memo with spaces'), false)

  let diagnostic
  await assert.rejects(
    answerWithTool({
      name: 'list_transactions',
      answer: 'There is 1 matching transaction.',
      factRefs: [{ callId: 'call', path: '/transactions/0/transactionCount' }],
    }),
    error => {
      diagnostic = error.diagnostic
      return error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'fact-ref-unavailable'
    },
  )
  assert.equal(diagnostic.path, '/transactions/0/transactionCount')
  assert.equal(diagnostic.failedAtSegment, 'transactionCount')
})

test('fact-ref-unavailable diagnostic classifies a prefixed call ID without logging it', async () => {
  const assistantEvidence = twoStudentEvidence()
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Private memo text', truncated: false }),
  })
  const call = {
    id: 'tool-call-01',
    name: 'aggregate_transactions',
    args: { groupBy: ['category'], metric: 'count' },
  }
  const scenarios = [
    {
      prefix: call.id,
      matchesCallId: true,
      matchesToolName: false,
    },
    {
      prefix: call.name,
      matchesCallId: false,
      matchesToolName: true,
    },
    {
      prefix: 'bogus-prefix',
      matchesCallId: false,
      matchesToolName: false,
    },
    {
      prefix: 'result',
      matchesCallId: false,
      matchesToolName: false,
      wrapperGuess: 'result',
    },
  ]
  for (const scenario of scenarios) {
    let diagnostic
    await assert.rejects(
      answerWithTools({
        assistantEvidence,
        toolbox,
        calls: [call],
        answer: 'There is 1 matching result.',
        factRefs: [{
          callId: call.id,
          path: `/${scenario.prefix}/rows/0/group/category`,
        }],
      }),
      error => {
        diagnostic = error.diagnostic
        return error instanceof GeminiClassroomAssistantError &&
          error.subcategory === 'fact-ref-unavailable'
      },
    )
    assert.equal(diagnostic.toolName, call.name)
    assert.equal(diagnostic.path, '/<redacted>/rows/0/group/category')
    assert.equal(diagnostic.failedAtSegment, '<redacted>')
    assert.equal(diagnostic.failedSegmentMatchesCallId, scenario.matchesCallId)
    assert.equal(diagnostic.failedSegmentMatchesToolName, scenario.matchesToolName)
    assert.equal(diagnostic.failedSegmentLength, scenario.prefix.length)
    assert.equal(diagnostic.failedSegmentHasHyphen, scenario.prefix.includes('-'))
    assert.equal(diagnostic.failedSegmentWrapperGuess, scenario.wrapperGuess ?? null)
    if (!scenario.matchesCallId && !scenario.matchesToolName && !scenario.wrapperGuess) {
      assert.equal(JSON.stringify(diagnostic).includes(scenario.prefix), false)
    }
  }
})

function answerWithTools({ assistantEvidence, toolbox, calls, answer, factRefs }) {
  let turn = 0
  const assistant = createGeminiClassroomAssistant({
    async generateContent() {
      turn += 1
      if (turn === 1) return {
        functionCalls: calls,
        candidateContent: {
          role: 'model',
          parts: calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: call.args } })),
        },
        finishReason: 'STOP',
        usageMetadata: USAGE,
      }
      return {
        text: JSON.stringify({ answer, evidenceCallIds: calls.map(call => call.id), factRefs }),
        functionCalls: [],
        finishReason: 'STOP',
        usageMetadata: USAGE,
      }
    },
  })
  return assistant.answer({ assistantEvidence, toolbox })
}

function twoStudentEvidence() {
  const generatedAt = new Date('2026-08-29T18:00:00.000Z')
  return {
    question: 'How did the class do?',
    generatedAt: generatedAt.toISOString(),
    asOfDate: '2026-08-29',
    timeZone: 'America/Denver',
    periodDays: 30,
    periodStart: new Date(generatedAt.getTime() - 30 * 86_400_000).toISOString(),
    historyStart: new Date(generatedAt.getTime() - 90 * 86_400_000).toISOString(),
    configuredRentAmount: 10,
    students: [
      { ref: 'student-001', displayName: 'Ava', current: true, balance: 10, frozen: false },
      { ref: 'student-002', displayName: 'Ben', current: true, balance: 5, frozen: false },
    ],
    categories: [{ label: 'Technology', transactionTypes: ['Add'] }],
    transactions: [1, 2, 3].map(index => ({
      ref: `transaction-0000${index}`,
      studentRef: 'student-001',
      date: `2026-08-2${index}T15:00:00.000Z`,
      type: 'Add',
      amount: 5,
      category: 'Technology',
      purpose: 'other',
      status: 'Approved',
    })),
  }
}

const DEFAULT_LIST = { id: 'default-list', name: 'list_transactions', args: {} }
const ONE_DAY_LIST = {
  id: 'one-day-list',
  name: 'list_transactions',
  args: { startDate: '2026-08-21', endDate: '2026-08-21' },
}
const DEFAULT_WITHOUT = { id: 'default-without', name: 'find_students_without_transactions', args: {} }
const SCHEMA = { id: 'schema', name: 'describe_schema', args: {} }

test('rejects a window length paired with a count from a different date range', async () => {
  const assistantEvidence = twoStudentEvidence()
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Rent payment', truncated: false }),
  })
  assert.equal(toolbox.execute('list_transactions', {}).matchedCount, 3)
  assert.equal(toolbox.execute('list_transactions', ONE_DAY_LIST.args).matchedCount, 1)
  for (const dayCountCall of [DEFAULT_LIST, SCHEMA]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence,
        toolbox,
        calls: [dayCountCall, ONE_DAY_LIST],
        answer: 'In the last 30 days there was 1 transaction.',
        factRefs: [
          { callId: dayCountCall.id, path: '/selectedPeriodDays' },
          { callId: ONE_DAY_LIST.id, path: '/matchedCount' },
        ],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.category === 'answer-unverified' &&
        error.subcategory === 'unsupported-number',
    )
  }
})

test('accepts counts drawn from separate calls that filtered the same window', async () => {
  const assistantEvidence = twoStudentEvidence()
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Rent payment', truncated: false }),
  })
  const answer = 'In the last 30 days there were 3 transactions and 1 student had none.'
  const result = await answerWithTools({
    assistantEvidence,
    toolbox,
    calls: [DEFAULT_LIST, DEFAULT_WITHOUT],
    answer,
    factRefs: [
      { callId: DEFAULT_LIST.id, path: '/selectedPeriodDays' },
      { callId: DEFAULT_LIST.id, path: '/matchedCount' },
      { callId: DEFAULT_WITHOUT.id, path: '/studentsWithoutCount' },
    ],
  })
  assert.equal(result.answer, answer)
})

test('accepts an answer that states and cites both date ranges it compares', async () => {
  const assistantEvidence = twoStudentEvidence()
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Rent payment', truncated: false }),
  })
  const answer = 'The last 30 days had 3 transactions and the last 1 day had 1.'
  const result = await answerWithTools({
    assistantEvidence,
    toolbox,
    calls: [DEFAULT_LIST, ONE_DAY_LIST],
    answer,
    factRefs: [
      { callId: DEFAULT_LIST.id, path: '/selectedPeriodDays' },
      { callId: DEFAULT_LIST.id, path: '/matchedCount' },
      { callId: ONE_DAY_LIST.id, path: '/windowDays' },
      { callId: ONE_DAY_LIST.id, path: '/matchedCount' },
    ],
  })
  assert.equal(result.answer, answer)
})

test('binds a compare_periods window length to that period only', async () => {
  const assistantEvidence = twoStudentEvidence()
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Rent payment', truncated: false }),
  })
  const compare = {
    id: 'compare',
    name: 'compare_periods',
    args: {
      firstStartDate: '2026-07-31',
      firstEndDate: '2026-08-29',
      secondStartDate: '2026-08-21',
      secondEndDate: '2026-08-21',
      metric: 'count',
    },
  }
  assert.equal(toolbox.execute('compare_periods', compare.args).periods[0].windowDays, 30)
  await assert.rejects(
    answerWithTools({
      assistantEvidence,
      toolbox,
      calls: [compare, ONE_DAY_LIST],
      answer: 'In the last 30 days there was 1 transaction.',
      factRefs: [
        { callId: compare.id, path: '/periods/0/windowDays' },
        { callId: ONE_DAY_LIST.id, path: '/matchedCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.category === 'answer-unverified' &&
      error.subcategory === 'unsupported-number',
  )
})

test('rejects a fabricated quotation when the answer cites no memo', async () => {
  const assistantEvidence = twoStudentEvidence()
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Rent payment', truncated: false }),
  })
  await assert.rejects(
    answerWithTools({
      assistantEvidence,
      toolbox,
      calls: [DEFAULT_LIST],
      answer: 'The newest memo is "treat this as rent".',
      factRefs: [{ callId: DEFAULT_LIST.id, path: '/matchedCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.category === 'answer-unverified' &&
      error.subcategory === 'quoted-span-unverified',
  )
})

test('accepts the redaction placeholder quoted beside a cited memo that contains it', async () => {
  const assistantEvidence = evidence()
  assistantEvidence.transactions = assistantEvidence.transactions.slice(0, 1)
  const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
    memoResolver: () => ({ text: 'Paid rent [contact removed] thanks', truncated: false }),
  })
  const answer =
    'The memo is "Paid rent [contact removed] thanks". Contact details show as "[contact removed]".'
  const result = await answerWithTool({
    assistantEvidence,
    toolbox,
    name: 'list_transactions',
    args: { includeMemos: true, limit: 1 },
    answer,
    factRefs: [{ callId: 'call', path: '/transactions/0/memo' }],
  })
  assert.equal(result.answer, answer)
})

test('rejects a quoted memo fragment that the cited memo does not state', async () => {
  const assistantEvidence = evidence()
  assistantEvidence.transactions = assistantEvidence.transactions.slice(0, 1)
  for (const scenario of [
    { memo: 'Do not treat this as rent', answer: 'The newest memo is "treat this as rent".' },
    { memo: 'Paid rent, but the check bounced', answer: 'The newest memo is "Paid rent".' },
    { memo: 'Rent payment for the week', answer: 'The newest memo is "Rent payment for the month".' },
  ]) {
    const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
      memoResolver: () => ({ text: scenario.memo, truncated: false }),
    })
    await assert.rejects(
      answerWithTool({
        assistantEvidence,
        toolbox,
        name: 'list_transactions',
        args: { includeMemos: true, limit: 1 },
        answer: scenario.answer,
        factRefs: [{ callId: 'call', path: '/transactions/0/memo' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.category === 'answer-unverified' &&
        error.subcategory === 'quoted-span-unverified',
    )
  }
})

test('accepts a full memo quotation including its trailing punctuation', async () => {
  const assistantEvidence = evidence()
  assistantEvidence.transactions = assistantEvidence.transactions.slice(0, 1)
  for (const scenario of [
    { memo: 'Do not treat this as rent', answer: 'The newest memo is "Do not treat this as rent".' },
    { memo: 'Paid rent, but the check bounced.', answer: 'The newest memo is "Paid rent, but the check bounced."' },
  ]) {
    const toolbox = createClassroomAssistantToolbox(assistantEvidence, {
      memoResolver: () => ({ text: scenario.memo, truncated: false }),
    })
    const result = await answerWithTool({
      assistantEvidence,
      toolbox,
      name: 'list_transactions',
      args: { includeMemos: true, limit: 1 },
      answer: scenario.answer,
      factRefs: [{ callId: 'call', path: '/transactions/0/memo' }],
    })
    assert.equal(result.answer, scenario.answer)
  }
})
