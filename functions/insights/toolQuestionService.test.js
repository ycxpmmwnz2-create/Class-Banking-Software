import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASSROOM_ASSISTANT_MAX_BILLED_OUTPUT_TOKENS,
  CLASSROOM_ASSISTANT_MAX_BILLED_THINKING_TOKENS,
} from './classroomAssistantUsageContract.js'
import { GeminiClassroomAssistantError } from './geminiClassroomAssistant.js'
import { createStructuredClassroomAssistant } from './geminiClassroomAssistant.js'
import { STRUCTURED_ANSWER_CONTRACT } from './structuredClassroomAnswers.js'
import { InsightQuestionEvidenceError } from './questionEvidenceAdapter.js'
import {
  InsightToolQuestionServiceError,
  createInsightToolQuestionService,
} from './toolQuestionService.js'

const REQUEST = Object.freeze({
  requestId: '12345678-1234-4234-8234-123456789abc',
  kind: 'question',
  periodDays: 7,
  timeZone: 'America/Denver',
  question: 'Are there duplicate transactions today?',
})

function fixture() {
  const calls = []
  const toolboxes = []
  const assistantEvidence = {
    question: REQUEST.question,
    generatedAt: '2026-08-27T18:00:00.000Z',
    asOfDate: '2026-08-27',
    timeZone: REQUEST.timeZone,
    periodDays: 7,
    periodStart: '2026-08-20T18:00:00.000Z',
    historyStart: '2026-05-29T18:00:00.000Z',
    configuredRentAmount: 10,
    students: [],
    categories: [],
    transactions: [],
  }
  const completed = []
  const deps = {
    now: () => new Date('2026-08-27T18:00:00.000Z'),
    async resolveActiveTeacherTenant() {
      calls.push('tenant')
      return { teacherUid: 'teacher-a', classroomId: 'class-a' }
    },
    async loadQuestionEvidence() {
      calls.push('evidence')
      return {
        assistantEvidence,
        assistantMemoResolver: () => null,
        evidenceSignature: 'a'.repeat(64),
      }
    },
    async quoteWorstCaseCost({ toolbox }) {
      calls.push('quote')
      toolboxes.push(toolbox)
      return { rateCardId: 'rate-card', worstCaseCostMicroUsd: 100 }
    },
    assistant: {
      async answer({ toolbox }) {
        calls.push('assistant')
        toolboxes.push(toolbox)
        return {
          answerContract: STRUCTURED_ANSWER_CONTRACT,
          answer: 'No. There are no duplicate transactions today.',
          evidence: ['Calculated 0 grouped results from 3 matching transactions.'],
          usage: { inputTokens: 20, outputTokens: 10, thinkingTokens: 0 },
          toolCallCount: 1,
        }
      },
    },
    async priceActualUsage() {
      calls.push('price')
      return 10
    },
    usageLedger: {
      async reserve() {
        calls.push('reserve')
        return {
          kind: 'reserved',
          reservationId: 'reservation-a',
          reservedCostMicroUsd: 100,
          remainingAfterReservationMicroUsd: 1000,
        }
      },
      async commit(value) {
        calls.push('commit')
        completed.push(value)
      },
      async markUncertain() { calls.push('uncertain') },
    },
  }
  return { calls, completed, deps, toolboxes }
}

test('resolves tenant, reserves, runs the tool assistant, and commits a natural answer', async () => {
  const setup = fixture()
  const service = createInsightToolQuestionService(setup.deps)
  const result = await service({ auth: { uid: 'teacher-a' }, data: REQUEST })
  assert.equal(result.answer, 'No. There are no duplicate transactions today.')
  assert.deepEqual(setup.calls, ['tenant', 'evidence', 'quote', 'reserve', 'assistant', 'price', 'commit'])
  assert.equal(setup.completed[0].result.source, 'provider-tool-assistant')
  assert.equal(setup.completed[0].result.usage.costMicroUsd, 10)
  assert.equal(setup.toolboxes.length, 2)
  assert.equal(setup.toolboxes[0], setup.toolboxes[1])
})

test('returns and commits valid usage at the exact accumulated multi-turn ceiling', async () => {
  const setup = fixture()
  setup.deps.assistant.answer = async () => ({
    answerContract: STRUCTURED_ANSWER_CONTRACT,
    answer: 'No. There are no duplicate transactions today.',
    evidence: ['Calculated 0 grouped results from 3 matching transactions.'],
    usage: {
      inputTokens: 1,
      outputTokens: CLASSROOM_ASSISTANT_MAX_BILLED_OUTPUT_TOKENS,
      thinkingTokens: CLASSROOM_ASSISTANT_MAX_BILLED_THINKING_TOKENS,
    },
    toolCallCount: 1,
  })
  const result = await createInsightToolQuestionService(setup.deps)({
    auth: { uid: 'teacher-a' },
    data: REQUEST,
  })
  assert.equal(result.usage.outputTokens, 8_192)
  assert.equal(result.usage.thinkingTokens, 16_384)
  assert.equal(setup.completed[0].result.usage.outputTokens, 8_192)
})

test('retains the reservation and preserves safe provider failure categories', async () => {
  for (const scenario of [
    { category: 'provider-rate-limited', subcategory: null },
    { category: 'answer-unverified', subcategory: 'unsupported-number' },
  ]) {
    const setup = fixture()
    setup.deps.assistant.answer = async () => {
      throw new GeminiClassroomAssistantError(
        scenario.category,
        'raw provider text',
        scenario.subcategory,
      )
    }
    await assert.rejects(
      createInsightToolQuestionService(setup.deps)({ auth: { uid: 'teacher-a' }, data: REQUEST }),
      error => error instanceof InsightToolQuestionServiceError &&
        error.category === scenario.category &&
        error.subcategory === scenario.subcategory &&
        !error.message.includes('raw provider text'),
    )
    assert.equal(setup.calls.includes('uncertain'), true)
    assert.equal(setup.calls.includes('commit'), false)
  }
})

test('rejects an obscured-name question before quoting, reserving, or invoking Gemini', async () => {
  const setup = fixture()
  setup.deps.loadQuestionEvidence = async () => {
    setup.calls.push('evidence')
    throw new InsightQuestionEvidenceError(
      'question-sensitive',
      'Type student names with normal spacing and punctuation before asking.',
    )
  }
  await assert.rejects(
    createInsightToolQuestionService(setup.deps)({ auth: { uid: 'teacher-a' }, data: REQUEST }),
    error => error instanceof InsightToolQuestionServiceError && error.category === 'question-sensitive',
  )
  assert.deepEqual(setup.calls, ['tenant', 'evidence'])
})

test('replays only an exact tool-assistant result bound to current evidence', async () => {
  const setup = fixture()
  const service = createInsightToolQuestionService(setup.deps)
  const first = await service({ auth: { uid: 'teacher-a' }, data: REQUEST })
  const completed = setup.completed[0].result
  setup.calls.length = 0
  setup.deps.usageLedger.reserve = async () => ({
    kind: 'completed',
    result: completed,
  })
  const result = await service({
    auth: { uid: 'teacher-a' },
    data: REQUEST,
  })
  assert.deepEqual(result, first)
  assert.equal(setup.calls.includes('assistant'), false)
  assert.equal(completed.schemaVersion, 2)
  assert.equal(completed.answerContract, 'structured-v1')
  assert.notEqual(completed.evidenceSignature, 'a'.repeat(64))
})

test('rejects old prose, mismatched contract, question, classroom, teacher and snapshot replays without invoking provider', async () => {
  for (const variation of ['old-prose', 'contract', 'question', 'classroom', 'teacher', 'snapshot']) {
    const setup = fixture()
    const service = createInsightToolQuestionService(setup.deps)
    await service({ auth: { uid: 'teacher-a' }, data: REQUEST })
    const completed = { ...setup.completed[0].result }
    setup.deps.usageLedger.reserve = async () => ({ kind: 'completed', result: completed })
    if (variation === 'old-prose') { completed.schemaVersion = 1; delete completed.answerContract }
    if (variation === 'contract') completed.answerContract = 'legacy-prose'
    if (variation === 'classroom' || variation === 'teacher') {
      setup.deps.resolveActiveTeacherTenant = async () => ({
        teacherUid: variation === 'teacher' ? 'teacher-b' : 'teacher-a',
        classroomId: variation === 'classroom' ? 'class-b' : 'class-a',
      })
    }
    if (variation === 'snapshot') completed.evidenceSignature = 'b'.repeat(64)
    setup.calls.length = 0
    await assert.rejects(service({ auth: { uid: 'teacher-a' }, data: {
      ...REQUEST, ...(variation === 'question' ? { question: 'Who has a frozen account?' } : {}),
    } }), error => error.category === 'invalid-replay')
    assert.equal(setup.calls.includes('assistant'), false)
    assert.equal(setup.calls.includes('commit'), false)
  }
})

test('legacy assistant output cannot be stored under the structured revision', async () => {
  const setup = fixture()
  const answer = setup.deps.assistant.answer
  setup.deps.assistant.answer = async input => {
    const result = await answer(input)
    delete result.answerContract
    return result
  }
  await assert.rejects(createInsightToolQuestionService(setup.deps)({ auth: { uid: 'teacher-a' }, data: REQUEST }),
    error => error.category === 'provider-output-invalid')
  assert.equal(setup.calls.includes('commit'), false)
  assert.equal(setup.calls.includes('uncertain'), true)
})

test('real structured assistant runs through tenant, toolbox, reservation, pricing and replay with a fake provider', async () => {
  const setup = fixture()
  let providerCalls = 0
  setup.deps.assistant = createStructuredClassroomAssistant({
    async generateContent(request) {
      providerCalls += 1
      assert.match(request.config.systemInstruction, /server writes all factual answer text/u)
      const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
      if (providerCalls === 1) {
        const call = { id: 'balance-call', name: 'get_balances', args: { condition: 'negative' } }
        return { usageMetadata, finishReason: 'STOP', functionCalls: [call], candidateContent: { role: 'model', parts: [{ functionCall: call }] } }
      }
      const result = request.contents.at(-1).parts[0].functionResponse.response
      return { usageMetadata, finishReason: 'STOP', text: JSON.stringify({ schemaVersion: 1, sections: [{ resultId: result.resultId, view: result.view }] }) }
    },
  })
  const service = createInsightToolQuestionService(setup.deps)
  const result = await service({ auth: { uid: 'teacher-a' }, data: REQUEST })
  assert.match(result.answer, /^0 current students match: negative balances/u)
  assert.equal(result.usage.inputTokens, 20)
  assert.equal(setup.completed[0].result.answerContract, 'structured-v1')
  assert.equal(providerCalls, 2)
  setup.deps.usageLedger.reserve = async () => ({ kind: 'completed', result: setup.completed[0].result })
  assert.deepEqual(await service({ auth: { uid: 'teacher-a' }, data: REQUEST }), result)
  assert.equal(providerCalls, 2)
})
