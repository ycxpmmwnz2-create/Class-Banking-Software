import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASSROOM_ASSISTANT_VALIDATION_SUBCATEGORIES,
  GeminiClassroomAssistantError,
  buildGeminiClassroomAssistantRequest,
  createGeminiClassroomAssistant,
} from './geminiClassroomAssistant.js'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { callableErrorDetails } from './callableErrors.js'

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

// The teacher must always be told they are seeing part of a list. When the
// provider omits that, the disclosure is added from the same cited result
// rather than the whole answer being discarded.
test('always shows a truncation disclosure, adding it when the provider omits one', async () => {
  for (const [answer, alreadyDisclosed] of [
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
    if (alreadyDisclosed) {
      // The provider said it correctly, so nothing is added or duplicated.
      assert.equal(result.answer, answer)
      assert.equal(result.answer.match(/Showing/gu).length, 1)
    } else {
      assert.match(result.answer, /^Showing 25 of 500 matching students\./u)
      // The provider's own answer survives intact behind the disclosure.
      assert.ok(result.answer.endsWith(answer), result.answer)
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
  // Omitted by the provider: added for the teacher, original answer preserved.
  const bare = 'The first memo is "Rent payment for the week".'
  const added = (await answerWithTool({
    assistantEvidence,
    toolbox,
    name: 'list_transactions',
    args: { includeMemos: true },
    answer: bare,
    factRefs,
  })).answer
  assert.equal(added, `Showing 50 of 60 matching transactions. ${bare}`)

  // Written correctly by the provider: left exactly as it was, not duplicated.
  const answer = 'Showing 50 of 60 matching transactions. The first memo is "Rent payment for the week".'
  const untouched = (await answerWithTool({
    assistantEvidence,
    toolbox,
    name: 'list_transactions',
    args: { includeMemos: true },
    answer,
    factRefs,
  })).answer
  assert.equal(untouched, answer)
  assert.equal(untouched.match(/Showing/gu).length, 1)
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

test('adds the disclosure when the provider attempt does not qualify, and still refuses a wrong total', async () => {
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

  // None of these count as a disclosure, so the teacher gets a real one added.
  const notADisclosure = [
    // No numbers at all -- the teacher cannot tell how much is missing.
    'Some matching transactions are not shown.',
    // Only the returned count. The total is the number that matters most.
    'Showing the first 50 matching transactions.',
    // Both numbers present but not read together as one disclosure.
    'There are 50 here. Separately, the classroom has 60 matching transactions.',
    // A bare "of" with nothing marking the listing as partial.
    'Transaction 50 of 60 is the newest.',
  ]
  for (const attempt of notADisclosure) {
    const result = await answerWithTool({
      assistantEvidence,
      toolbox,
      name: 'list_transactions',
      args: { includeMemos: true },
      answer: `${attempt}${tail}`,
      factRefs,
    })
    assert.match(result.answer, /^Showing 50 of 60 matching transactions\./u, `should disclose for: ${attempt}`)
  }

  // A total the records do not support is still refused, by numeric grounding
  // rather than by the disclosure check. Stating it for the teacher would mean
  // repeating a wrong number back to them.
  await assert.rejects(
    answerWithTool({
      assistantEvidence,
      toolbox,
      name: 'list_transactions',
      args: { includeMemos: true },
      answer: `Showing 50 of 61 matching transactions.${tail}`,
      factRefs,
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.category === 'answer-unverified',
  )
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
  // "1 student had none" leaves the thing the student had none of in the other
  // half of the sentence, and the count that made it pass was the count of who
  // *did* transact -- both were 1 here. Each count now names its own predicate.
  const answer = 'In the last 30 days there were 3 transactions and 1 student had no matching transactions.'
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

// Andrew's first real classroom question after the production deploy failed
// with category 'provider-output-invalid' and no subcategory at all. Four
// separate tool-loop sites could produce it and none of them said which, so
// diagnosing it would have cost a deploy round per hypothesis. Each site now
// names itself and reports value-free counts.
function answerWithLoop({ turns, assistantEvidence = evidence() }) {
  let turn = 0
  const assistant = createGeminiClassroomAssistant({
    async generateContent() {
      const response = turns[Math.min(turn, turns.length - 1)]
      turn += 1
      return { finishReason: 'STOP', usageMetadata: USAGE, ...response }
    },
  })
  return assistant.answer({ assistantEvidence })
}

function toolTurn(calls) {
  return {
    functionCalls: calls,
    candidateContent: { role: 'model', parts: calls.map(call => ({ functionCall: call })) },
  }
}

test('each tool-loop failure names its own cause and reports only value-free counts', async () => {
  const call = { id: 'call', name: 'get_balances', args: {} }
  const scenarios = [
    {
      name: 'tool-turn-content-missing',
      turns: [{ functionCalls: [call], candidateContent: { role: 'user', parts: [] } }],
      diagnostic: { turnIndex: 0, toolCallCount: 0 },
    },
    {
      name: 'tool-call-limit',
      turns: [toolTurn(Array.from({ length: 9 }, (item, index) => ({
        id: `call-${index}`,
        name: 'get_balances',
        args: {},
      })))],
      diagnostic: { turnIndex: 0, toolCallCount: 0, requestedCallCount: 9 },
    },
    {
      name: 'tool-call-id-repeated',
      turns: [toolTurn([call, { ...call }])],
      diagnostic: { turnIndex: 0, toolCallCount: 1, providerCallIdPresent: true },
    },
    {
      name: 'tool-turn-limit',
      // Never stops calling tools, so the loop runs out of turns.
      turns: [0, 1, 2, 3].map(index => toolTurn([{ id: `call-${index}`, name: 'get_balances', args: {} }])),
      diagnostic: { turnIndex: 4, toolCallCount: 4 },
    },
  ]
  for (const scenario of scenarios) {
    await assert.rejects(
      answerWithLoop({ turns: scenario.turns }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.category === 'provider-output-invalid' &&
        error.subcategory === scenario.name &&
        CLASSROOM_ASSISTANT_VALIDATION_SUBCATEGORIES.has(error.subcategory),
      `${scenario.name} must name itself`,
    )
    const error = await answerWithLoop({ turns: scenario.turns }).catch(caught => caught)
    assert.deepEqual(error.diagnostic, scenario.diagnostic, `${scenario.name} diagnostic`)
    // Every reported value is a count or a flag, never classroom content.
    for (const value of Object.values(error.diagnostic)) {
      assert.equal(
        typeof value === 'boolean' || (Number.isSafeInteger(value) && value >= 0),
        true,
        `${scenario.name} must report only counts and flags`,
      )
    }
  }
})

// The model was stating how many students matched a filter after counting
// distinct names off a returned row list -- a number with nothing to cite, and
// a wrong one whenever that list was truncated. The count is now returned by
// the same call the model already makes, so the honest answer is citable.
test('a student count cited from list_transactions distinctCurrentStudentCount is grounded', async () => {
  const result = await answerWithTool({
    name: 'list_transactions',
    args: {},
    answer: '1 student had matching transactions.',
    factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
  })
  assert.equal(result.answer, '1 student had matching transactions.')
})

test('a student count the model invented is still refused when no student count was cited', async () => {
  await assert.rejects(
    answerWithTool({
      name: 'list_transactions',
      args: {},
      answer: '2 students had matching transactions.',
      factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-number',
  )
})

test('the outbound system instruction sends the model to a citable student count', () => {
  const request = buildGeminiClassroomAssistantRequest({
    contents: [{ role: 'user', parts: [{ text: 'test' }] }],
    declarations: [],
    requireTool: false,
  })
  const instruction = request.config.systemInstruction
  assert.match(instruction, /list_transactions distinctCurrentStudentCount/u)
  assert.match(instruction, /never count distinct names yourself from a returned row list/iu)
  assert.match(instruction, /still matches a filter, so distinctParticipantCount/u)
})

// A transaction from a student who has left the class still matches a filter,
// so a count over matched transactions is not a count of the current class. One
// field carrying both meanings let a participant total be stated as a
// current-roster total: with one current student and one former student having
// matching transactions, "all 2 current students had matching transactions"
// passed grounding while being false. The populations are now separate kinds,
// so no wording can make one stand in for the other.
function mixedRosterEvidence() {
  const data = evidence()
  data.question = 'Which students were paid for technology today?'
  data.students = [
    { ref: 'student-001', displayName: 'Ava R.', current: true, balance: 10, frozen: false },
    { ref: 'student-002', displayName: 'Ava S.', current: true, balance: 4, frozen: false },
    { ref: 'student-003', displayName: 'Ava T.', current: false, balance: 0, frozen: false },
  ]
  data.transactions = [
    { ref: 'transaction-00001', studentRef: 'student-001', date: '2026-08-27T15:01:00.000Z', type: 'Add', amount: 5, category: 'Technology', purpose: 'other', status: 'Approved' },
    { ref: 'transaction-00002', studentRef: 'student-003', date: '2026-08-27T15:02:00.000Z', type: 'Add', amount: 5, category: 'Technology', purpose: 'other', status: 'Approved' },
  ]
  return data
}

test('a participant total cannot be stated as a count of the current class', async () => {
  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'list_transactions',
      args: {},
      answer: 'All 2 current students had matching transactions.',
      factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-number' &&
      error.diagnostic.claimKind === 'student-count',
  )
})

test('the same false claim is refused even when the participant total is not the cited fact', async () => {
  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'list_transactions',
      args: {},
      answer: 'All 2 current students had matching transactions.',
      factRefs: [{ callId: 'call', path: '/matchedCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-number',
  )
})

test('the current-roster count backs the true claim about the same classroom', async () => {
  const result = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: '1 current student had matching transactions.',
    factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
  })
  assert.equal(result.answer, '1 current student had matching transactions.')
})

test('a participant total stays citable in an answer that says it includes former students', async () => {
  const result = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: '2 participants had matching transactions, including students who have left the class.',
    factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
  })
  assert.match(result.answer, /2 participants/u)
})

// Separating the two populations was not sufficient on its own. Resolving the
// participant wording first meant historical framing anywhere nearby relabelled
// the whole claim, so an explicitly current-roster sentence could be supported
// by a participant total. This is the exact sentence that got through.
const MIXED_POPULATION_BYPASS =
  'Including students who left the class, all 2 current students had matching transactions.'

test('mixed population wording cannot license a participant total for a current-roster claim', async () => {
  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'list_transactions',
      args: {},
      answer: MIXED_POPULATION_BYPASS,
      factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-number' &&
      error.diagnostic.claimKind === 'population-ambiguous',
  )
})

// Reordering the clauses moves the historical wording out of the claim's
// context window, so the claim reads as current-roster and is refused for
// having no current-roster fact at its value. Either path must refuse; neither
// may resolve to the participant population.
test('the same false claim is refused however the two populations are ordered', async () => {
  for (const answer of [
    'All 2 current students had matching transactions, including students who left the class.',
    '2 of the current students had matching transactions, including former students.',
    '2 currently enrolled students had matching transactions, including archived students.',
    '2 students still in the class had matching transactions; 1 has left the class.',
  ]) {
    await assert.rejects(
      answerWithTool({
        assistantEvidence: mixedRosterEvidence(),
        name: 'list_transactions',
        args: {},
        answer,
        factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-number' &&
        ['population-ambiguous', 'student-count'].includes(error.diagnostic.claimKind),
      `must refuse: ${answer}`,
    )
  }
})

// Population wording must only ever choose between the two student
// populations. Deciding it ahead of the nouns a number sits against turned
// "over 8 days, including former students" into a participant claim that no
// day-count fact could support.
test('population wording does not relabel counts that are not about students', async () => {
  // "8 days for former students" is a day count, and the participant wording
  // sits inside the claim's context window. Resolving population first made it
  // a participant claim that no day-count fact could support.
  const dayCount = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: '8 days for former students were checked.',
    factRefs: [{ callId: 'call', path: '/windowDays' }],
  })
  assert.match(dayCount.answer, /8 days/u)

  const combined = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: 'Over 8 days, including former students, 2 transactions matched.',
    factRefs: [
      { callId: 'call', path: '/windowDays' },
      { callId: 'call', path: '/matchedCount' },
    ],
  })
  assert.match(combined.answer, /2 transactions/u)
})

// The aggregate metric had the identical defect before this branch existed, so
// reclassifying only the list_transactions field would have left it reachable.
test('the aggregate distinctStudents metric is a participant total, not a roster total', async () => {
  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'aggregate_transactions',
      args: { groupBy: [], metric: 'distinctStudents' },
      answer: 'All 2 current students had matching transactions.',
      factRefs: [{ callId: 'call', path: '/rows/0/value' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-number',
  )
  const result = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'aggregate_transactions',
    args: { groupBy: [], metric: 'distinctCurrentStudents' },
    answer: '1 current student had matching transactions.',
    factRefs: [{ callId: 'call', path: '/rows/0/value' }],
  })
  assert.equal(result.answer, '1 current student had matching transactions.')
})

// Separating the populations and giving explicit roster wording precedence
// still left the decision to a fixed 24-character window, so it turned on
// distance rather than meaning. Here the historical wording sits inside the
// window and the "currently enrolled" that scopes the claim to the roster sits
// just outside it, so the claim was read as a participant claim and the
// participant total supported it. This is the exact sentence that got through.
const TRUNCATED_ROSTER_WORDING_BYPASS =
  'Including past students: 2 of the currently enrolled students had matching transactions.'

test('roster wording beyond a character window still scopes the claim to the roster', async () => {
  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'list_transactions',
      args: {},
      answer: TRUNCATED_ROSTER_WORDING_BYPASS,
      factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-number' &&
      error.diagnostic.claimKind === 'population-ambiguous',
  )
})

// Distance from the number must not decide the population, in either
// direction, so the same false claim is put at a range of separations and
// orderings. Every one must refuse; none may resolve to the participant
// population and take the participant total.
test('mixed population wording is refused at any distance from the number', async () => {
  for (const answer of [
    'Including past students: 2 of the currently enrolled students had matching transactions.',
    '2 of the currently enrolled students, including past students, had matching transactions.',
    'Counting students who have left: 2 of the students still in the class had matching transactions.',
    '2 currently enrolled students, plus former students, had matching transactions.',
    'Including archived students, and counting every one of them, 2 current students had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTool({
        assistantEvidence: mixedRosterEvidence(),
        name: 'list_transactions',
        args: {},
        answer,
        factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        ['unsupported-number', 'unverified-quantifier'].includes(error.subcategory) &&
        ['population-ambiguous', 'student-count'].includes(error.diagnostic.claimKind),
      `must refuse: ${answer}`,
    )
  }
})

// The widening direction is the one that fails open, so it now takes wording
// that says the wider population is what was counted. Mentioning former
// students while excluding them is not that: each sentence below counts the
// roster, and reading any historical word in range as a widening let the
// participant total support them.
test('historical wording that excludes former students does not widen the population', async () => {
  for (const answer of [
    '2 students had matching transactions but 1 former student was excluded.',
    '2 students had matching transactions, and 1 former student was excluded.',
    'Ignoring former students, 2 students had matching transactions.',
    'Past students are included elsewhere. 2 of the students still in the class had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTool({
        assistantEvidence: mixedRosterEvidence(),
        name: 'list_transactions',
        args: {},
        answer,
        factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-number' &&
        ['student-count', 'population-ambiguous'].includes(error.diagnostic.claimKind),
      `must refuse: ${answer}`,
    )
  }
})

// This expectation is deliberately reversed from the previous commit, which
// let an inclusive disclosure anywhere in the clause widen the population. That
// only held while a pattern recognised every way a teacher might name the
// current roster, and it did not: "2 enrolled students" and "2 active students"
// walked past it and took the participant total. A generic count that does not
// name its own population no longer widens, so this sentence now fails closed,
// and the answer that says the same true thing names the population on the
// count instead.
test('a generic student count is not widened by a disclosure elsewhere', async () => {
  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'list_transactions',
      args: {},
      answer: '2 students had matching transactions, including one who left the class.',
      factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-number' &&
      error.diagnostic.claimKind === 'population-ambiguous',
  )
  const result = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: '2 participants had matching transactions, including one who left the class.',
    factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
  })
  assert.match(result.answer, /2 participants/u)
})

// A quantifier asserts the counted group is the whole population, and the
// count alone cannot establish that. "All 1 current student had matching
// transactions" was accepted on a roster of two: the 1 was correctly cited
// from distinctCurrentStudentCount, and nothing checked the word carrying the
// false part of the sentence.
test('a quantifier over a count is refused when no population total is cited', async () => {
  for (const answer of [
    'All 1 current student had matching transactions.',
    'Every 1 current student had matching transactions.',
    'All of the 1 current student had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTool({
        assistantEvidence: mixedRosterEvidence(),
        name: 'list_transactions',
        args: {},
        answer,
        factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.category === 'answer-unverified' &&
        error.subcategory === 'unverified-quantifier' &&
        CLASSROOM_ASSISTANT_VALIDATION_SUBCATEGORIES.has(error.subcategory) &&
        error.diagnostic.claimKind === 'student-count' &&
        error.diagnostic.populationTotalFactCount === 0,
      `must refuse: ${answer}`,
    )
  }
})

// No call returns how many students ever transacted, so a quantified
// participant claim has no total to check and fails closed until one exists.
test('a quantified participant claim fails closed for want of a participant total', async () => {
  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'list_transactions',
      args: {},
      answer: 'All 2 participants had matching transactions.',
      factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier' &&
      error.diagnostic.claimKind === 'participant-count',
  )
})

// The quantifier is verified rather than banned: a call that returns the
// roster total makes the honest claim citable, which is the direction this
// project takes every time -- make the number checkable, do not exempt it.
test('the outbound system instruction sends the model to a roster total for a quantifier', () => {
  const request = buildGeminiClassroomAssistantRequest({
    contents: [{ role: 'user', parts: [{ text: 'test' }] }],
    declarations: [],
    requireTool: false,
  })
  const instruction = request.config.systemInstruction
  assert.match(instruction, /Saying all, every, or each of a number of students/u)
  assert.match(instruction, /currentStudentCount/u)
  // Every rule the validator enforces is stated, so the model writes a
  // groundable sentence rather than discovering the rule as a refusal: the
  // digit belongs inside the quantified phrase, a page count is not a count of
  // students, and each count names its subject in its own clause.
  assert.match(instruction, /put the number in digits inside that same phrase/u)
  assert.match(instruction, /A number elsewhere in the sentence does not count/u)
  assert.match(instruction, /is the size of the class and shows nothing about transactions/u)
  assert.match(instruction, /Cite it only as the first number of a "Showing X of Y" disclosure/u)
  // The two disclosure numbers are checked against different fields, so the
  // instruction has to say which is which rather than naming both together.
  assert.match(instruction, /where X is that result’s returnedCount and Y is its exact total count/u)
  assert.match(instruction, /The two numbers are not interchangeable/u)
  // Both numbers now have to come from one result, and the subject has to be
  // one that result can speak to, so the instruction says so rather than
  // leaving the model to find it as a refusal.
  assert.match(instruction, /A disclosure describes one result/u)
  assert.match(instruction, /take both numbers from that same result/u)
  assert.match(instruction, /Say what each count is a count of in the same clause as its digits/u)
  assert.match(instruction, /Both and neither additionally claim the class is exactly two/u)
})

test('a cited roster total licenses the quantifier it actually supports', async () => {
  const result = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'get_balances',
    args: {},
    answer: 'All 2 current students have a balance.',
    factRefs: [{ callId: 'call', path: '/currentStudentCount' }],
  })
  assert.match(result.answer, /All 2 current students/u)
})

test('the quantifier refusal reaches the client as a category alone', async () => {
  const error = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: 'All 1 current student had matching transactions.',
    factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
  }).catch(caught => caught)
  assert.deepEqual(Object.keys(callableErrorDetails(error)), ['category'])
  assert.equal(callableErrorDetails(error).category, 'answer-unverified')
  // Every reported value is a count or a fixed vocabulary word, never a figure
  // read out of the classroom.
  for (const [field, value] of Object.entries(error.diagnostic)) {
    assert.equal(
      typeof value === 'string' || (Number.isSafeInteger(value) && value >= 0),
      true,
      `${field} must be a count or a fixed word`,
    )
  }
})

// Naming the current roster is not a closed vocabulary, and the previous fix
// depended on it being one: an inclusive disclosure widened the count, so
// anything the roster pattern failed to recognise became an all-participant
// total. These three ordinary phrasings all walked past it and were accepted
// against the participant total while only one current student had matched.
// Widening now takes wording on the count itself, so no synonym list stands
// between these sentences and a refusal.
const ROSTER_SYNONYM_BYPASSES = Object.freeze([
  'Including former students, 2 enrolled students had matching transactions.',
  'Including former students, 2 active students had matching transactions.',
  'Including former students, 2 students on the roster had matching transactions.',
])

test('a roster phrasing the pattern does not know still cannot take a participant total', async () => {
  for (const answer of ROSTER_SYNONYM_BYPASSES) {
    await assert.rejects(
      answerWithTool({
        assistantEvidence: mixedRosterEvidence(),
        name: 'list_transactions',
        args: {},
        answer,
        factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-number' &&
        error.diagnostic.claimKind === 'population-ambiguous',
      `must refuse: ${answer}`,
    )
  }
})

// A quantifier without a digit still claims a whole class. Claim extraction
// scans digits, so these three said something false about the roster and were
// never checked at all. The prompt asking for digits is not an enforcement
// boundary.
const DIGITLESS_QUANTIFIER_BYPASSES = Object.freeze([
  'Every current student had matching transactions.',
  'Both current students had matching transactions.',
  'None of the current students had matching transactions.',
])

// The previous commit tried to ground these by recognising the quantifier and
// checking it. That only held for the wordings it knew: "everyone in the
// current class" was not one of them, and "both" was read as an unrestricted
// universal, so both walked past. Recognising more wordings would have been the
// same bet again, so the requirement is inverted -- a clause that speaks about
// students as a group states its count in digits or it is refused. The
// expectation here is therefore stricter than it was, not merely renamed.
test('a group claim carrying no digit is refused outright', async () => {
  for (const answer of [
    ...DIGITLESS_QUANTIFIER_BYPASSES,
    'Everyone in the current class matched the filter.',
    'The whole class had matching transactions.',
    'Each student had a matching transaction.',
    'No students had matching transactions.',
  ]) {
    const error = await answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'list_transactions',
      args: {},
      answer,
      factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
    }).catch(caught => caught)
    assert.equal(error instanceof GeminiClassroomAssistantError, true, `must refuse: ${answer}`)
    assert.equal(error.category, 'answer-unverified', answer)
    assert.equal(error.subcategory, 'group-claim-without-count', answer)
    assert.equal(CLASSROOM_ASSISTANT_VALIDATION_SUBCATEGORIES.has(error.subcategory), true)
    assert.deepEqual(Object.keys(callableErrorDetails(error)), ['category'], answer)
    for (const [field, value] of Object.entries(error.diagnostic)) {
      assert.equal(
        typeof value === 'string' || (Number.isSafeInteger(value) && value >= 0),
        true,
        `${field} must be a count or a fixed word`,
      )
    }
  }
})

// "Both" says the population is two. It was accepted on a roster of three, all
// three of whom matched, because it was treated as any other universal.
test('both is refused unless the population it quantifies is two', async () => {
  // All three current students matched here, so the count, the roster total
  // and the predicate fact all agree at 3. The only thing wrong with the
  // sentence is the word "both", which is what this isolates.
  const threeStudents = mixedRosterEvidence()
  threeStudents.students = [
    ...threeStudents.students,
    { ref: 'student-004', displayName: 'Ava U.', current: true, balance: 7, frozen: false },
  ]
  threeStudents.transactions = [
    ...threeStudents.transactions,
    { ref: 'transaction-00003', studentRef: 'student-002', date: '2026-08-27T15:03:00.000Z', type: 'Add', amount: 5, category: 'Technology', purpose: 'other', status: 'Approved' },
    { ref: 'transaction-00004', studentRef: 'student-004', date: '2026-08-27T15:04:00.000Z', type: 'Add', amount: 5, category: 'Technology', purpose: 'other', status: 'Approved' },
  ]
  await assert.rejects(
    answerWithTools({
      assistantEvidence: threeStudents,
      calls: [
        { id: 'balances', name: 'get_balances', args: {} },
        { id: 'transactions', name: 'list_transactions', args: {} },
      ],
      answer: 'Both 3 current students had matching transactions.',
      factRefs: [
        { callId: 'balances', path: '/currentStudentCount' },
        { callId: 'transactions', path: '/distinctCurrentStudentCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier',
  )
})

// A predicate the contract does not recognise is settled by nothing. Matching
// the bare noun "students" as a roster predicate made the roster total prove
// what the roster did, which is the one thing a population noun cannot show.
test('an unrecognised predicate cannot be settled by a population noun', async () => {
  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'get_balances',
      args: {},
      answer: 'All 2 current students matched the filter.',
      factRefs: [{ callId: 'call', path: '/currentStudentCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier' &&
      error.diagnostic.claimPredicate === 'unclassified',
  )
})

// There is no total for the participant population, so a claim quantified over
// it cannot be proven at all. Comparing a total and a predicate fact on value
// alone let a roster total of two stand in as the size of that population.
test('a participant universal cannot borrow the roster total', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: mixedRosterEvidence(),
      calls: [
        { id: 'balances', name: 'get_balances', args: {} },
        { id: 'transactions', name: 'list_transactions', args: {} },
      ],
      answer: 'All participants had matching transactions.',
      factRefs: [
        { callId: 'balances', path: '/currentStudentCount' },
        { callId: 'transactions', path: '/distinctParticipantCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      ['group-claim-without-count', 'unverified-quantifier'].includes(error.subcategory),
  )
  // The same claim stated with its count is refused on the population binding
  // rather than on the missing digit, so neither path can reach the total.
  await assert.rejects(
    answerWithTools({
      assistantEvidence: mixedRosterEvidence(),
      calls: [
        { id: 'balances', name: 'get_balances', args: {} },
        { id: 'transactions', name: 'list_transactions', args: {} },
      ],
      answer: 'All 2 participants had matching transactions.',
      factRefs: [
        { callId: 'balances', path: '/currentStudentCount' },
        { callId: 'transactions', path: '/distinctParticipantCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier' &&
      error.diagnostic.claimKind === 'participant-count',
  )
})

// Two current students, both of whom transacted, plus one archived
// participant. The quantified claim is true here, which is what separates
// grounding a quantifier from banning one.
function fullyMatchedRosterEvidence() {
  const data = mixedRosterEvidence()
  data.transactions = [
    ...data.transactions,
    { ref: 'transaction-00003', studentRef: 'student-002', date: '2026-08-27T15:03:00.000Z', type: 'Add', amount: 5, category: 'Technology', purpose: 'other', status: 'Approved' },
  ]
  return data
}

// The roster total proves how large the class is. It does not prove anything
// about transactions, and a student count of the same value from a balance
// call does not either. "All 2 current students had matching transactions" was
// accepted on the strength of get_balances currentStudentCount alone, with
// only one current student having transacted.
test('a roster total cannot prove a claim about transactions', async () => {
  for (const factRefs of [
    [{ callId: 'balances', path: '/currentStudentCount' }],
    [
      { callId: 'balances', path: '/currentStudentCount' },
      { callId: 'transactions', path: '/distinctCurrentStudentCount' },
    ],
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: mixedRosterEvidence(),
        calls: [
          { id: 'balances', name: 'get_balances', args: {} },
          { id: 'transactions', name: 'list_transactions', args: {} },
        ],
        answer: 'All 2 current students had matching transactions.',
        factRefs,
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unverified-quantifier' &&
        error.diagnostic.claimPredicate === 'transactions',
      `must refuse with factRefs ${JSON.stringify(factRefs)}`,
    )
  }
})

// The digit form remains sayable when it is true, which is what separates
// constraining the output from refusing the claim. The digitless form of the
// same true sentence is now refused, because nothing binds its quantifier to a
// count -- the model states the number instead.
test('the same quantified claim is accepted when the transaction count really is the roster total', async () => {
  for (const answer of [
    'All 2 current students had matching transactions.',
  ]) {
    const result = await answerWithTools({
      assistantEvidence: fullyMatchedRosterEvidence(),
      calls: [
        { id: 'balances', name: 'get_balances', args: {} },
        { id: 'transactions', name: 'list_transactions', args: {} },
      ],
      answer,
      factRefs: [
        { callId: 'balances', path: '/currentStudentCount' },
        { callId: 'transactions', path: '/distinctCurrentStudentCount' },
      ],
    })
    assert.equal(result.answer, answer)
  }
})

// The predicate decides which tool can answer it. A balance claim is settled
// by the balance call, and find_students_without_transactions is deliberately
// not evidence for the positive transaction predicate, because its count is
// the complement and would invert the claim.
test('each predicate is settled only by a tool that answers it', async () => {
  const balances = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'get_balances',
    args: {},
    answer: 'All 2 current students have a balance.',
    factRefs: [{ callId: 'call', path: '/currentStudentCount' }],
  })
  assert.match(balances.answer, /All 2 current students/u)

  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'find_students_without_transactions',
      args: {},
      answer: 'All 2 current students had matching transactions.',
      factRefs: [{ callId: 'call', path: '/currentStudentCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier' &&
      error.diagnostic.claimPredicate === 'transactions',
  )
})

// Output bounds and the answer envelope are unchanged by the quantifier work:
// a refusal still carries a category the client can read and nothing else, and
// the checks above run on the provider's own text, before this module appends
// its truncation disclosure.
test('the quantifier checks leave the answer envelope and its bounds alone', async () => {
  const result = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: '1 current student had matching transactions.',
    factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
  })
  assert.deepEqual(Object.keys(result).sort(), ['answer', 'evidence', 'toolCallCount', 'usage'])
  assert.equal(result.answer.length <= 1_200, true)
  assert.equal(Array.isArray(result.evidence), true)
})

// "Both current students had matching transactions." on a roster of three, all
// three of whom matched. The sentence is false about the class size, and it
// carries no digit, so nothing bound it to a fact.
test('both without a digit is refused even when every student did match', async () => {
  const threeAllMatched = mixedRosterEvidence()
  threeAllMatched.students = [
    ...threeAllMatched.students,
    { ref: 'student-004', displayName: 'Ava U.', current: true, balance: 7, frozen: false },
  ]
  threeAllMatched.transactions = [
    ...threeAllMatched.transactions,
    { ref: 'transaction-00003', studentRef: 'student-002', date: '2026-08-27T15:03:00.000Z', type: 'Add', amount: 5, category: 'Technology', purpose: 'other', status: 'Approved' },
    { ref: 'transaction-00004', studentRef: 'student-004', date: '2026-08-27T15:04:00.000Z', type: 'Add', amount: 5, category: 'Technology', purpose: 'other', status: 'Approved' },
  ]
  await assert.rejects(
    answerWithTools({
      assistantEvidence: threeAllMatched,
      calls: [
        { id: 'balances', name: 'get_balances', args: {} },
        { id: 'transactions', name: 'list_transactions', args: {} },
      ],
      answer: 'Both current students had matching transactions.',
      factRefs: [
        { callId: 'balances', path: '/currentStudentCount' },
        { callId: 'transactions', path: '/distinctCurrentStudentCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'group-claim-without-count',
  )
})

// The quantifier was never what let a roster total prove a transaction claim,
// so the same false sentence stripped of its quantifier passed the same way.
// Every count of a student population is now bound to a tool that answers what
// the claim says those students did.
test('a population count is bound to its predicate with or without a quantifier', async () => {
  for (const answer of [
    '2 current students had matching transactions.',
    '2 current students matched the filter.',
  ]) {
    await assert.rejects(
      answerWithTool({
        assistantEvidence: mixedRosterEvidence(),
        name: 'get_balances',
        args: {},
        answer,
        factRefs: [{ callId: 'call', path: '/currentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-predicate' &&
        CLASSROOM_ASSISTANT_VALIDATION_SUBCATEGORIES.has(error.subcategory),
      `must refuse: ${answer}`,
    )
  }
  // The same shape of claim stays sayable from the tool that answers it, and a
  // claim about the class size still comes from the roster total.
  const transacted = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: '1 current student had matching transactions.',
    factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
  })
  assert.match(transacted.answer, /1 current student/u)
  const rosterSize = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'get_balances',
    args: {},
    answer: 'There are 2 current students.',
    factRefs: [{ callId: 'call', path: '/currentStudentCount' }],
  })
  assert.match(rosterSize.answer, /2 current students/u)
})

// A count of who transacted is the complement of a count of who did not, so
// neither may be cited for the other even when the value happens to be right.
test('a count of who transacted cannot state how many did not', async () => {
  await assert.rejects(
    answerWithTool({
      assistantEvidence: mixedRosterEvidence(),
      name: 'list_transactions',
      args: {},
      answer: '1 current student had no matching transactions.',
      factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-predicate' &&
      error.diagnostic.claimPredicate === 'no-transactions',
  )
})

// Requiring "a digit in the clause" was not the same as requiring the count.
// An unrelated number satisfied it, so "All students matched, over 8 days"
// carried a day count and the group claim went unchecked. The number has to be
// a count of the students themselves.
test('an unrelated number does not stand in for a missing student count', async () => {
  for (const [answer, path] of [
    ['All students matched, over 8 days.', '/windowDays'],
    ['Every current student transacted across 2 transactions.', '/matchedCount'],
    ['All students were paid 5 dollars.', '/transactions/0/amount'],
  ]) {
    await assert.rejects(
      answerWithTool({
        assistantEvidence: mixedRosterEvidence(),
        name: 'list_transactions',
        args: {},
        answer,
        factRefs: [{ callId: 'call', path }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'group-claim-without-count',
      `must refuse: ${answer}`,
    )
  }
})

// The determiner does not have to sit in front of the noun, the noun does not
// have to be "student", and the class can be named as one thing. Each of these
// was found by probing rather than by the suite, so each is kept.
test('a group claim is caught however the group is named', async () => {
  for (const answer of [
    'The students all had matching transactions.',
    'The class as a whole had matching transactions.',
    'Nobody had matching transactions.',
    'Any of the students could have matching transactions.',
    'Every kid had matching transactions.',
    'All participants had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTool({
        assistantEvidence: mixedRosterEvidence(),
        name: 'list_transactions',
        args: {},
        answer,
        factRefs: [{ callId: 'call', path: '/distinctCurrentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'group-claim-without-count',
      `must refuse: ${answer}`,
    )
  }
})

// A group named without a determiner asserts nothing countable about it, so
// this rule must not reach a claim that merely mentions students in passing.
test('a group named in passing does not require a count of its own', async () => {
  const days = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: '8 days for former students were checked.',
    factRefs: [{ callId: 'call', path: '/windowDays' }],
  })
  assert.match(days.answer, /8 days/u)
  const participants = await answerWithTool({
    assistantEvidence: mixedRosterEvidence(),
    name: 'list_transactions',
    args: {},
    answer: '2 participants had matching transactions, including one who left the class.',
    factRefs: [{ callId: 'call', path: '/distinctParticipantCount' }],
  })
  assert.match(participants.answer, /2 participants/u)
})

// A roster of `currentCount` current students, the first `transactedCount` of
// whom have a matching transaction. Stating the two numbers separately is what
// makes each of the sentences below true or false on purpose.
function rosterEvidence(currentCount, transactedCount) {
  const data = evidence()
  data.question = 'How did the class do?'
  data.students = Array.from({ length: currentCount }, (_, index) => ({
    ref: `student-${String(index + 1).padStart(3, '0')}`,
    displayName: `Ava ${index + 1}`,
    current: true,
    balance: index + 1,
    frozen: false,
  }))
  data.transactions = Array.from({ length: transactedCount }, (_, index) => ({
    ref: `transaction-0000${index + 1}`,
    studentRef: `student-${String(index + 1).padStart(3, '0')}`,
    date: '2026-08-27T15:01:00.000Z',
    type: 'Add',
    amount: 5,
    category: 'Technology',
    purpose: 'other',
    status: 'Approved',
  }))
  return data
}

const WITHOUT_ONE_ROW = Object.freeze({ id: 'without', name: 'find_students_without_transactions', args: { limit: 1 } })
const WITHOUT_ALL = Object.freeze({ id: 'without', name: 'find_students_without_transactions', args: {} })
const BALANCES = Object.freeze({ id: 'balances', name: 'get_balances', args: {} })
const TRANSACTIONS = Object.freeze({ id: 'transactions', name: 'list_transactions', args: {} })

// The count that answers a group claim has to be the size of that group. It was
// enough for a population count to appear somewhere in the clause, so the
// second half of "All students had matching transactions and 2 current students
// are enrolled" lent its enrolment count to the first half, and the universal
// went unchecked on a roster of two where one student had transacted.
test('a count in a neighbouring assertion cannot answer a group claim', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(2, 1),
      calls: [BALANCES],
      answer: 'All students had matching transactions and 2 current students are enrolled.',
      factRefs: [{ callId: 'balances', path: '/currentStudentCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'group-claim-without-count',
  )
  // The same borrowing one sentence away, and with a pronoun in place of the
  // determiner, which has nowhere to put a count at all.
  for (const answer of [
    'All students had matching transactions. There are 2 current students.',
    'Everyone had matching transactions and 2 current students are enrolled.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(2, 1),
        calls: [BALANCES],
        answer,
        factRefs: [{ callId: 'balances', path: '/currentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'group-claim-without-count',
      `must refuse: ${answer}`,
    )
  }
})

// The quantifier was read from the characters immediately before the digit, so
// any modifier between the two hid it: "All current 1 student" claimed a class
// of one on a roster of two and was checked as a bare count.
test('a modifier between the quantifier and its digit does not hide the quantifier', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(2, 1),
      calls: [TRANSACTIONS],
      answer: 'All current 1 student had matching transactions.',
      factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier',
  )
})

// A page length says how many rows came back. On a truncated call that is
// smaller than the number of students the sentence is about, so it cannot
// settle a predicate: with two students lacking transactions and a limit of
// one, "1 current student had no matching transactions" was accepted from
// returnedCount. The same held for a truncated get_balances.
test('a truncated page length cannot stand as a predicate count', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [WITHOUT_ONE_ROW],
      answer: 'Showing 1 of 2 matching students. 1 current student had no matching transactions.',
      factRefs: [
        { callId: 'without', path: '/returnedCount' },
        { callId: 'without', path: '/studentsWithoutCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-predicate' &&
      error.diagnostic.claimPredicate === 'no-transactions',
  )
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [{ id: 'balances', name: 'get_balances', args: { limit: 1 } }],
      answer: '1 current student has a matching balance.',
      factRefs: [{ callId: 'balances', path: '/returnedCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-predicate' &&
      error.diagnostic.claimPredicate === 'balances',
  )
})

// The disclosure itself is still sayable, because there the page length is
// exactly what the sentence claims.
test('a truncation disclosure still states its own page length', async () => {
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 1),
    calls: [WITHOUT_ONE_ROW],
    answer: 'Showing 1 of 2 students without matching transactions.',
    factRefs: [
      { callId: 'without', path: '/returnedCount' },
      { callId: 'without', path: '/studentsWithoutCount' },
    ],
  })
  assert.match(result.answer, /Showing 1 of 2 students/u)
})

// Naming the page count without the total it came out of is not a disclosure,
// and treating the disclosure word alone as one let it relabel an ordinary
// predicate claim: "Showing 1 current student had no matching transactions"
// passed on a returnedCount of 1 while two students actually had none.
test('a disclosure word cannot relabel a predicate count as a page count', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [WITHOUT_ONE_ROW],
      answer: 'Showing 1 current student had no matching transactions.',
      factRefs: [{ callId: 'without', path: '/returnedCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-predicate' &&
      error.diagnostic.claimPredicate === 'no-transactions',
  )
})

// English does not keep the negator next to the word it negates. Allowing two
// words between them read "did not have any matching transactions" as a claim
// about who did transact, so a count of one student who transacted was accepted
// as the count of the two who had not.
test('a negated transaction claim is negative however far the negator sits', async () => {
  for (const answer of [
    '1 current student did not have any matching transactions.',
    '1 current student never had any matching transactions.',
    '1 current student has not yet had a single matching transaction.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 1),
        calls: [TRANSACTIONS],
        answer,
        factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-predicate' &&
        error.diagnostic.claimPredicate === 'no-transactions',
      `must refuse: ${answer}`,
    )
  }
})

// The negation can also be carried by the quantifier itself, which the old
// pattern never saw. That refused a truthful, fully cited sentence: no current
// student had transacted, and the roster total and the count of who had not
// were both cited.
test('a negative quantifier makes its claim negative rather than unprovable', async () => {
  const answer = 'None of the 2 current students had matching transactions.'
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(2, 0),
    calls: [WITHOUT_ALL, BALANCES],
    answer,
    factRefs: [
      { callId: 'without', path: '/studentsWithoutCount' },
      { callId: 'balances', path: '/currentStudentCount' },
    ],
  })
  assert.equal(result.answer, answer)
  // The same claim in the other direction, and the same claim when it is false.
  const positive = 'All 2 current students had no matching transactions.'
  const stated = await answerWithTools({
    assistantEvidence: rosterEvidence(2, 0),
    calls: [WITHOUT_ALL, BALANCES],
    answer: positive,
    factRefs: [
      { callId: 'without', path: '/studentsWithoutCount' },
      { callId: 'balances', path: '/currentStudentCount' },
    ],
  })
  assert.equal(stated.answer, positive)
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [WITHOUT_ALL, BALANCES],
      answer: 'None of the 3 current students had matching transactions.',
      factRefs: [
        { callId: 'without', path: '/studentsWithoutCount' },
        { callId: 'balances', path: '/currentStudentCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier',
  )
})

// "Neither" states the population is two just as "both" does, and each has to
// agree with the count it governs.
test('neither is refused unless the population it quantifies is two', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 0),
      calls: [WITHOUT_ALL, BALANCES],
      answer: 'Neither of the 3 current students had matching transactions.',
      factRefs: [
        { callId: 'without', path: '/studentsWithoutCount' },
        { callId: 'balances', path: '/currentStudentCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier',
  )
})

// The quantifier can also follow the noun, and the count it governs then sits
// in front of it. That phrasing is true here and stays sayable.
test('a quantifier after the noun is bound to the count in front of it', async () => {
  const answer = 'The 2 current students both had matching transactions.'
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(2, 2),
    calls: [TRANSACTIONS, BALANCES],
    answer,
    factRefs: [
      { callId: 'transactions', path: '/distinctCurrentStudentCount' },
      { callId: 'balances', path: '/currentStudentCount' },
    ],
  })
  assert.equal(result.answer, answer)
})

// A quantifier reaches its noun across as much of the phrase as the phrase
// needs. Budgeting three modifier words meant "every one of the 2 current
// students" needed five and so registered as neither a group claim nor a
// quantified one, and its count was then checked as an ordinary predicate count
// with no roster total required. Two of three students had transacted here.
test('a quantifier reaches its noun however long the phrase between them is', async () => {
  for (const answer of [
    'Every one of the 2 current students had matching transactions.',
    'Each one of the 2 current students had matching transactions.',
    'Every single one of the 2 current students had matching transactions.',
    'All of the 2 current students had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 2),
        calls: [TRANSACTIONS],
        answer,
        factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unverified-quantifier',
      `must refuse: ${answer}`,
    )
  }
  // Citing the roster total does not rescue it either, because the roster is 3.
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 2),
      calls: [TRANSACTIONS, BALANCES],
      answer: 'Every one of the 2 current students had matching transactions.',
      factRefs: [
        { callId: 'transactions', path: '/distinctCurrentStudentCount' },
        { callId: 'balances', path: '/currentStudentCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier',
  )
  // And the true form of the same phrasing stays sayable.
  const answer = 'Every one of the 2 current students had matching transactions.'
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(2, 2),
    calls: [TRANSACTIONS, BALANCES],
    answer,
    factRefs: [
      { callId: 'transactions', path: '/distinctCurrentStudentCount' },
      { callId: 'balances', path: '/currentStudentCount' },
    ],
  })
  assert.equal(result.answer, answer)
})

// A preposition hands the head of the phrase to another noun, so the quantifier
// is not reaching the students named after it and no count of them is owed.
test('a quantifier over another noun does not demand a count of students', async () => {
  const answer = 'All matching transactions for the 1 current student were approved.'
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 1),
    calls: [TRANSACTIONS],
    answer,
    factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
  })
  assert.equal(result.answer, answer)
})

// A contraction carries its negation inside the word, where a leading word
// boundary cannot find it, so "didn't have matching transactions" was read as a
// claim about who did transact and settled by that count.
test('a contraction carries its negation into the predicate', async () => {
  for (const answer of [
    '1 current student didn’t have matching transactions.',
    "1 current student didn't have matching transactions.",
    '1 current student hasn’t had matching transactions.',
    '1 current student weren’t paid.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 1),
        calls: [TRANSACTIONS],
        answer,
        factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-predicate' &&
        error.diagnostic.claimPredicate === 'no-transactions',
      `must refuse: ${answer}`,
    )
  }
})

// A conjunction begins a new assertion whether or not a comma precedes it.
// Sharing one clause let a negation belonging to the other half reach across:
// "No balances were negative and 2 current students had matching transactions"
// was read as a claim about who had none and settled by studentsWithoutCount.
test('a negation does not reach across a coordinated assertion', async () => {
  for (const answer of [
    'No balances were negative and 2 current students had matching transactions.',
    'No student was frozen while 2 current students had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 1),
        calls: [WITHOUT_ALL],
        answer,
        factRefs: [{ callId: 'without', path: '/studentsWithoutCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-predicate' &&
        error.diagnostic.claimPredicate === 'transactions',
      `must refuse: ${answer}`,
    )
  }
  // Both halves of a coordinated sentence still stand when each names its own
  // predicate and cites the field that answers it.
  const answer = '1 current student had matching transactions and 2 current students had no matching transactions.'
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 1),
    calls: [TRANSACTIONS, WITHOUT_ALL],
    answer,
    factRefs: [
      { callId: 'transactions', path: '/distinctCurrentStudentCount' },
      { callId: 'without', path: '/studentsWithoutCount' },
    ],
  })
  assert.equal(result.answer, answer)
})

// The two numbers in a disclosure hold different roles. Giving both the same
// predicate let each take whichever cited fact matched its value, so the
// reversed "Showing 2 of 1 students" passed on a returnedCount of 1 and a total
// of 2 -- each number proven by the other's field.
test('the numbers in a disclosure are bound to the fields that hold them', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [WITHOUT_ONE_ROW],
      answer: 'Showing 2 of 1 students without matching transactions.',
      factRefs: [
        { callId: 'without', path: '/returnedCount' },
        { callId: 'without', path: '/studentsWithoutCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-predicate' &&
      error.diagnostic.claimPredicate === 'listing-page',
  )
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [{ id: 'balances', name: 'get_balances', args: { limit: 1 } }],
      answer: 'Showing 3 of 1 matching balances.',
      factRefs: [
        { callId: 'balances', path: '/returnedCount' },
        { callId: 'balances', path: '/matchedCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-predicate' &&
      error.diagnostic.claimPredicate === 'listing-page',
  )
  // A page length cannot stand as the total either, even when it is the only
  // number cited and the two happen to be written the same.
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [WITHOUT_ONE_ROW],
      answer: 'Showing 1 of 1 students without matching transactions.',
      factRefs: [{ callId: 'without', path: '/returnedCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unsupported-predicate' &&
      error.diagnostic.claimPredicate === 'listing-total',
  )
  // Both disclosures in the right order stay sayable, for either tool.
  const withoutTransactions = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 1),
    calls: [WITHOUT_ONE_ROW],
    answer: 'Showing 1 of 2 students without matching transactions.',
    factRefs: [
      { callId: 'without', path: '/returnedCount' },
      { callId: 'without', path: '/studentsWithoutCount' },
    ],
  })
  assert.match(withoutTransactions.answer, /Showing 1 of 2 students/u)
  const balances = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 1),
    calls: [{ id: 'balances', name: 'get_balances', args: { limit: 1 } }],
    answer: 'Showing 1 of 3 matching balances.',
    factRefs: [
      { callId: 'balances', path: '/returnedCount' },
      { callId: 'balances', path: '/matchedCount' },
    ],
  })
  assert.match(balances.answer, /Showing 1 of 3 matching balances/u)
})

// English joins two words with a hyphen as readily as with a space, and every
// phrase pattern in the validator was written expecting whitespace, so one
// hyphen hid the phrase from the check that reads it. The two spellings of a
// sentence have to be answered the same way.
test('a hyphen between two words does not hide the phrase they form', async () => {
  for (const answer of [
    'Every one of the 2 currently-enrolled students had matching transactions.',
    'All 2 currently-enrolled students had matching transactions.',
    'The 2 currently-enrolled students all had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 2),
        calls: [TRANSACTIONS],
        answer,
        factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unverified-quantifier',
      `must refuse: ${answer}`,
    )
  }
  // The same wording is still sayable when the roster really is that size.
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(2, 2),
    calls: [TRANSACTIONS, BALANCES],
    answer: 'Every one of the 2 currently-enrolled students had matching transactions.',
    factRefs: [
      { callId: 'transactions', path: '/distinctCurrentStudentCount' },
      { callId: 'balances', path: '/currentStudentCount' },
    ],
  })
  assert.match(result.answer, /Every one of the 2 currently-enrolled students/u)
})

// The same hyphen in the wording that widens a count past the current roster:
// the spaced spellings were refused as ambiguous while the hyphenated ones
// passed on a roster total, which is a count of a different population than the
// sentence described.
test('a hyphen does not hide the wording that widens a population', async () => {
  for (const answer of [
    'There are 2 students, including students who have left.',
    'There are 2 students, including no-longer-enrolled ones.',
    'There are 2 students, counting former students too.',
    'There are 2 students, counting former-students too.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: mixedRosterEvidence(),
        calls: [BALANCES],
        answer,
        factRefs: [{ callId: 'balances', path: '/currentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-number' &&
        error.diagnostic.claimKind === 'population-ambiguous',
      `must refuse: ${answer}`,
    )
  }
})

// How many modifiers stand between a quantifier and its noun is not something a
// budget can decide. Three of them lost the quantifier its count, and the same
// three hid a spelled-out quantity from the check that requires digits -- and a
// spelled-out count is invisible to the digit scan too, so nothing checked it.
test('a quantifier reaches its noun however many words stand between them', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 2),
      calls: [TRANSACTIONS],
      answer: 'The 2 very recently enrolled students all had matching transactions.',
      factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'unverified-quantifier',
  )
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(2, 2),
    calls: [TRANSACTIONS, BALANCES],
    answer: 'The 2 very recently enrolled students all had matching transactions.',
    factRefs: [
      { callId: 'transactions', path: '/distinctCurrentStudentCount' },
      { callId: 'balances', path: '/currentStudentCount' },
    ],
  })
  assert.match(result.answer, /The 2 very recently enrolled students all/u)
})

test('a spelled-out count cannot outrun the digits rule by adding modifiers', async () => {
  for (const answer of [
    'Seven enrolled students had matching transactions.',
    'Seven very recently enrolled students had matching transactions.',
    'Seven still-currently-enrolled students had matching transactions.',
    'Seven exceptionally well prepared and eager students had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 1),
        calls: [TRANSACTIONS],
        answer,
        factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'number-words',
      `must refuse: ${answer}`,
    )
  }
  // A number word doing ordinary work is not a quantity, and the scan must not
  // read across the words that end a noun phrase to reach a noun it never
  // modified.
  for (const answer of [
    'The one clear pattern is that 1 current student had matching transactions.',
    'That is one thing to watch. 1 current student had matching transactions.',
  ]) {
    const result = await answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [TRANSACTIONS],
      answer,
      factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
    })
    assert.match(result.answer, /1 current student had matching transactions/u, `must allow: ${answer}`)
  }
})

// What a number counts was read from a fixed 24 characters either side of it,
// which decided the question on distance: the same claim was refused with the
// noun near the digit and accepted with three modifiers in between, because it
// then resolved to no kind at all -- and a claim of no kind is supported by any
// number of any kind, so a transaction count stood as a count of students.
test('what a number counts is read from its clause, not from a fixed distance', async () => {
  for (const answer of [
    '2 students had matching transactions.',
    '2 very recently enrolled students had matching transactions.',
    '2 exceptionally well prepared students had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: oneStudentTransactedTwice(),
        calls: [TRANSACTIONS],
        answer,
        factRefs: [{ callId: 'transactions', path: '/matchedCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-number' &&
        error.diagnostic.claimKind === 'student-count',
      `must refuse: ${answer}`,
    )
  }
})

// A roster of 3 in which one student made 2 transactions, so a transaction
// count of 2 and a student count of 2 are only ever the same number by
// coincidence -- which is what a claim of no kind used to trade on.
function oneStudentTransactedTwice() {
  const data = evidence()
  data.question = 'How did the class do?'
  data.students = [1, 2, 3].map(index => ({
    ref: `student-${String(index).padStart(3, '0')}`,
    displayName: `Ava ${index}`,
    current: true,
    balance: index,
    frozen: false,
  }))
  data.transactions = [1, 2].map(index => ({
    ref: `transaction-0000${index}`,
    studentRef: 'student-001',
    date: `2026-08-27T15:0${index}:00.000Z`,
    type: 'Add',
    amount: 5,
    category: 'Technology',
    purpose: 'other',
    status: 'Approved',
  }))
  return data
}

// A bare "and" ends a clause, correctly, wherever the clause boundary needs
// it to (see CLAUSE_BOUNDARY_PATTERN). But it does not end a noun phrase --
// "calm and kind students" is one -- and computing what a number counts from
// the clause slice let that same "and" cut the noun away from the number
// entirely: "2 calm and kind students had matching transactions" fell to a
// clause of just "2 calm", resolved to no kind at all, and a transaction
// count of 2 stood as a count of students who never transacted.
test('a coordinating "and" between modifiers does not cut the noun from the number', async () => {
  for (const answer of [
    '2 calm and kind students had matching transactions.',
    '2 newly-enrolled and eager students had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: oneStudentTransactedTwice(),
        calls: [TRANSACTIONS],
        answer,
        factRefs: [{ callId: 'transactions', path: '/matchedCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-number' &&
        error.diagnostic.claimKind === 'student-count',
      `must refuse: ${answer}`,
    )
  }
})

// The same clause can hold two numbers, and reading a bag of words from the
// whole clause let the noun for one outvote the noun sitting right next to
// the other: "3 matching transactions were recorded for 1 student" let
// "student" -- forty characters on, and stating a different number entirely
// -- relabel a transaction count of 3 as a student count, refusing a claim
// every bit as true as the count it names.
test('a later noun in the same clause does not relabel an earlier number', async () => {
  const oneStudentThreeTransactions = evidence()
  oneStudentThreeTransactions.transactions = [1, 2, 3].map(index => ({
    ref: `transaction-0000${index}`,
    studentRef: 'student-001',
    date: `2026-08-27T15:0${index}:00.000Z`,
    type: 'Add',
    amount: 5,
    category: 'Technology',
    purpose: 'other',
    status: 'Approved',
  }))
  const answer = '3 matching transactions were recorded for 1 student.'
  const result = await answerWithTools({
    assistantEvidence: oneStudentThreeTransactions,
    calls: [TRANSACTIONS],
    answer,
    factRefs: [
      { callId: 'transactions', path: '/matchedCount' },
      { callId: 'transactions', path: '/distinctCurrentStudentCount' },
    ],
  })
  assert.equal(result.answer, answer)
})

// A disclosure is one sentence about one result. Checking its two numbers
// separately let the pair come apart: reversed, each was proven by the other's
// field, and the teacher was handed two contradictory disclosures in one answer.
test('the two numbers in a disclosure come from one result in the order it holds them', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 3),
      calls: [{ id: 'transactions', name: 'list_transactions', args: { limit: 1 } }],
      answer: 'Showing 3 of 1 matching transactions.',
      factRefs: [
        { callId: 'transactions', path: '/matchedCount' },
        { callId: 'transactions', path: '/returnedCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'disclosure-counts-unbound' &&
      error.diagnostic.claimPredicate === 'transactions' &&
      error.diagnostic.toolName === 'list_transactions',
  )
  // A page length from one call and a total from another describe no result.
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [WITHOUT_ONE_ROW, BALANCES],
      answer: 'Showing 1 of 3 students without matching transactions.',
      factRefs: [
        { callId: 'without', path: '/returnedCount' },
        { callId: 'balances', path: '/matchedCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'disclosure-counts-unbound',
  )
  // Written in the order the result holds them, the same disclosure stands.
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 3),
    calls: [{ id: 'transactions', name: 'list_transactions', args: { limit: 1 } }],
    answer: 'Showing 1 of 3 matching transactions.',
    factRefs: [
      { callId: 'transactions', path: '/returnedCount' },
      { callId: 'transactions', path: '/matchedCount' },
    ],
  })
  assert.match(result.answer, /Showing 1 of 3 matching transactions/u)
})

// The subject of a disclosure says which result was shown, and a total from a
// call that cannot speak to that subject proves nothing about it: a get_balances
// pair carried "students without matching transactions" while a different
// number of students actually had none.
test('a disclosure is answered only by the tool that proves its subject', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [{ id: 'balances', name: 'get_balances', args: { limit: 2 } }],
      answer: 'Showing 2 of 3 students without matching transactions.',
      factRefs: [
        { callId: 'balances', path: '/returnedCount' },
        { callId: 'balances', path: '/matchedCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'disclosure-counts-unbound' &&
      error.diagnostic.claimPredicate === 'no-transactions' &&
      error.diagnostic.toolName === 'find_students_without_transactions',
  )
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [WITHOUT_ONE_ROW],
      answer: 'Showing 1 of 2 matching balances.',
      factRefs: [
        { callId: 'without', path: '/returnedCount' },
        { callId: 'without', path: '/studentsWithoutCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'disclosure-counts-unbound' &&
      error.diagnostic.toolName === 'get_balances',
  )
  // "Grouped" names aggregate_transactions, so a grouped-result disclosure is
  // still sayable from the pair that result actually holds.
  const grouped = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 3),
    calls: [{ id: 'grouped', name: 'aggregate_transactions', args: { groupBy: ['student'], metric: 'count', limit: 1 } }],
    answer: 'Showing 1 of 3 grouped results.',
    factRefs: [
      { callId: 'grouped', path: '/returnedCount' },
      { callId: 'grouped', path: '/resultCount' },
    ],
  })
  assert.match(grouped.answer, /Showing 1 of 3 grouped results/u)
})

// "Grouped" is not an unrestricted subject: it is the exact noun this module
// writes for aggregate_transactions, in TRUNCATION_DISCLOSURE_NOUNS, and
// nothing else. Treating any subject this module cannot classify as
// unrestricted let "Showing 1 of 3 grouped results by category" pass against
// a plain list_transactions page and total, with no aggregation performed at
// all -- three matching transactions, one category, no grouping call made.
test('a grouped-result disclosure must actually come from aggregate_transactions', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 3),
      calls: [{ id: 'transactions', name: 'list_transactions', args: { limit: 1 } }],
      answer: 'Showing 1 of 3 grouped results by category.',
      factRefs: [
        { callId: 'transactions', path: '/returnedCount' },
        { callId: 'transactions', path: '/matchedCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'disclosure-counts-unbound' &&
      error.diagnostic.claimPredicate === 'grouped' &&
      error.diagnostic.toolName === 'aggregate_transactions',
  )
})

// A subject this module truly cannot classify -- no recognised predicate and
// no "grouped" wording either -- still binds to no tool, so a disclosure
// phrased this plainly stays sayable from whichever cited result holds the
// pair. Narrowing every unclassified subject to aggregate_transactions would
// have refused this true sentence instead.
test('a disclosure subject with no predicate and no "grouped" wording binds to no tool', async () => {
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 1),
    calls: [WITHOUT_ONE_ROW],
    answer: 'Showing 1 of 2 students.',
    factRefs: [
      { callId: 'without', path: '/returnedCount' },
      { callId: 'without', path: '/studentsWithoutCount' },
    ],
  })
  assert.match(result.answer, /Showing 1 of 2 students/u)
})

// Codex found this pair reversed and reworded three ways, none of which the
// old frame -- a fixed verb immediately before the numbers -- recognised: the
// verb after the numbers, a present-tense verb the pattern never listed, and
// "the" before the second number where only the first was allowed one.
test('a reversed disclosure pair is refused however its verb is worded or placed', async () => {
  for (const answer of [
    'Only 3 of 1 matching transactions are shown.',
    'The list shows 3 out of 1 matching transactions.',
    'Showing 3 of the 1 matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 3),
        calls: [{ id: 'transactions', name: 'list_transactions', args: { limit: 1 } }],
        answer,
        factRefs: [
          { callId: 'transactions', path: '/matchedCount' },
          { callId: 'transactions', path: '/returnedCount' },
        ],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'disclosure-counts-unbound',
      `must refuse: ${answer}`,
    )
  }
})

// The "N of M" shape alone is an ordinary partitive -- "1 of the 3 current
// students" -- not a disclosure, because nothing in its clause is a
// disclosure verb. Widening the shape to allow "the" before the second
// number (for "Showing 3 of the 1 matching transactions") must not turn this
// into a page-count claim it was never intended to be: it is refused, if at
// all, as an ordinary uncited count -- never as a mismatched disclosure pair,
// which would be the wrong reason and would mean the verb gate stopped
// gating.
test('an ordinary "N of M" partitive is never read as a disclosure pair', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [TRANSACTIONS],
      answer: '1 of the 3 current students had matching transactions.',
      factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory !== 'disclosure-counts-unbound',
  )
})

// One word list decided both how far a spelled-out quantifier reaches and what
// a digit counts, and the two fail in opposite directions. A break word
// missing from the first costs a refusal; a break word too many in the second
// costs an answer. "Of" and "the" belong to the first and not the second, so
// "2 of the students had matching transactions" stopped at "of", kept no noun
// at all, and became a claim of no kind -- which any fact of any kind
// satisfies, so a transaction count of 2 stood as a count of students on a
// roster where one student had transacted twice.
test('a partitive determiner does not strip a number of the noun it counts', async () => {
  for (const answer of [
    '2 of the students had matching transactions.',
    '2 of our students had matching transactions.',
    '2 of their students had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: oneStudentTransactedTwice(),
        calls: [TRANSACTIONS],
        answer,
        factRefs: [{ callId: 'transactions', path: '/matchedCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-number' &&
        error.diagnostic.claimKind === 'student-count',
      `must refuse: ${answer}`,
    )
  }
  // And the same wording stays sayable when the count is the one the cited
  // field actually holds, which is what crossing the determiner is for.
  for (const answer of [
    '1 of the students had matching transactions.',
    '1 of our students had matching transactions.',
  ]) {
    const result = await answerWithTools({
      assistantEvidence: rosterEvidence(3, 1),
      calls: [TRANSACTIONS],
      answer,
      factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
    })
    assert.equal(result.answer, answer, `must allow: ${answer}`)
  }
})

// A disclosure reports what was shown and stops. A sentence that goes on to
// predicate something of that subject is a claim about the students, and
// reading it as a page disclosure exempted it from every factual check: "The
// records show 1 of 3 current students had no matching transactions" passed on
// a page length of 1 while all three students had none. Identifying a
// disclosure and exempting a number from being checked are separate questions
// -- the first is read broadly so no pair goes unbound, the second narrowly so
// no page length proves a fact.
test('a sentence that predicates something of its subject is not a page disclosure', async () => {
  for (const answer of [
    // A finite auxiliary opens the predication.
    'The records show 1 of 3 current students had no matching transactions.',
    // And so does a lexical verb, which no closed class can list -- the
    // negation it carries is what gives it away, because a nominal negator is
    // introduced by a preposition and this one is not.
    'The records show 1 of 3 current students made no deposits.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 0),
        calls: [WITHOUT_ONE_ROW],
        answer,
        factRefs: [
          { callId: 'without', path: '/returnedCount' },
          { callId: 'without', path: '/studentsWithoutCount' },
        ],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'unsupported-predicate' &&
        error.diagnostic.claimPredicate === 'no-transactions',
      `must refuse: ${answer}`,
    )
  }
  // A prepositional phrase is part of the subject, not a predication about it,
  // so the disclosure this module's own tools describe stays sayable in both
  // of the ways English writes that negation.
  for (const answer of [
    'Showing 1 of 3 students without matching transactions.',
    'Showing 1 of 3 students with no matching transactions.',
  ]) {
    const result = await answerWithTools({
      assistantEvidence: rosterEvidence(3, 0),
      calls: [WITHOUT_ONE_ROW],
      answer,
      factRefs: [
        { callId: 'without', path: '/returnedCount' },
        { callId: 'without', path: '/studentsWithoutCount' },
      ],
    })
    assert.match(result.answer, /Showing 1 of 3 students/u, `must allow: ${answer}`)
  }
})

// The two numbers of a disclosure do not have to stand next to each other.
// Requiring them to let "Showing 3 matching transactions out of 1" past the
// binding check as no disclosure at all, and this module then prefixed its own
// truthful disclosure to it -- handing the teacher two contradictory sentences
// in one answer.
test('a reversed disclosure is bound however far its two numbers stand apart', async () => {
  await assert.rejects(
    answerWithTools({
      assistantEvidence: rosterEvidence(3, 3),
      calls: [{ id: 'transactions', name: 'list_transactions', args: { limit: 1 } }],
      answer: 'Showing 3 matching transactions out of 1.',
      factRefs: [
        { callId: 'transactions', path: '/matchedCount' },
        { callId: 'transactions', path: '/returnedCount' },
      ],
    }),
    error => error instanceof GeminiClassroomAssistantError &&
      error.subcategory === 'disclosure-counts-unbound',
  )
  // Written in the order the result holds them, the same spacing is fine.
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 3),
    calls: [{ id: 'transactions', name: 'list_transactions', args: { limit: 1 } }],
    answer: 'Showing 1 matching transaction out of 3.',
    factRefs: [
      { callId: 'transactions', path: '/returnedCount' },
      { callId: 'transactions', path: '/matchedCount' },
    ],
  })
  assert.match(result.answer, /Showing 1 matching transaction out of 3/u)
})

// Aggregation is a property of the whole subject, and proximity is not.
// Deciding the subject by the nearest predicate let a transaction word sitting
// closer to the frame win, so a disclosure about grouping bound to
// list_transactions and was answered by a plain, ungrouped page and total --
// no aggregation call made at all. Naming the aggregate in any of the words
// this module's own tools use has to reach the same call.
test('an aggregated-result disclosure names its call however it is worded', async () => {
  for (const answer of [
    'Showing 1 of 3 grouped transaction results by category.',
    'Showing 1 of 3 category groups.',
    'Showing 1 of 3 grouped results by category.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 3),
        calls: [{ id: 'transactions', name: 'list_transactions', args: { limit: 1 } }],
        answer,
        factRefs: [
          { callId: 'transactions', path: '/returnedCount' },
          { callId: 'transactions', path: '/matchedCount' },
        ],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'disclosure-counts-unbound' &&
        error.diagnostic.claimPredicate === 'grouped' &&
        error.diagnostic.toolName === 'aggregate_transactions',
      `must refuse: ${answer}`,
    )
  }
  // A category named as an ordinary filter is not an aggregation, and the
  // listing that mentions one still binds to the call that produced it.
  const listed = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 3),
    calls: [{ id: 'transactions', name: 'list_transactions', args: { limit: 1 } }],
    answer: 'Showing 1 of 3 matching transactions in the Technology category.',
    factRefs: [
      { callId: 'transactions', path: '/returnedCount' },
      { callId: 'transactions', path: '/matchedCount' },
    ],
  })
  assert.match(listed.answer, /Showing 1 of 3 matching transactions/u)
})

// A spelled-out count is invisible to the digit scan, so nothing checks it at
// all -- which is why this module refuses one outright and tells the model to
// use digits. A partitive hid every such count from that refusal: "Seven of
// the current students had matching transactions" was accepted on a roster of
// three where one student had transacted, while the same sentence without "of
// the" was refused. Only "one of the" is the idiom the refusal has to spare.
test('a spelled-out count is refused across a partitive too', async () => {
  for (const answer of [
    'Seven of the current students had matching transactions.',
    'Two of the current students had matching transactions.',
    'Seven of our students had matching transactions.',
    'Twenty one of the students had matching transactions.',
  ]) {
    await assert.rejects(
      answerWithTools({
        assistantEvidence: rosterEvidence(3, 1),
        calls: [TRANSACTIONS],
        answer,
        factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
      }),
      error => error instanceof GeminiClassroomAssistantError &&
        error.subcategory === 'number-words',
      `must refuse: ${answer}`,
    )
  }
  // "One of the students" names a student rather than counting them, and the
  // digits rule has never governed it.
  const result = await answerWithTools({
    assistantEvidence: rosterEvidence(3, 1),
    calls: [TRANSACTIONS],
    answer: 'One of the students had matching transactions.',
    factRefs: [{ callId: 'transactions', path: '/distinctCurrentStudentCount' }],
  })
  assert.match(result.answer, /One of the students/u)
})
