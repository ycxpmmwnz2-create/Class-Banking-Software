import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASSROOM_ASSISTANT_MAX_BILLED_OUTPUT_TOKENS,
  CLASSROOM_ASSISTANT_MAX_BILLED_THINKING_TOKENS,
} from './classroomAssistantUsageContract.js'
import { GeminiClassroomAssistantError } from './geminiClassroomAssistant.js'
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

test('retains the reservation and preserves the safe provider failure category', async () => {
  const setup = fixture()
  setup.deps.assistant.answer = async () => {
    throw new GeminiClassroomAssistantError(
      'answer-unverified',
      'raw provider text',
      'unsupported-number',
    )
  }
  await assert.rejects(
    createInsightToolQuestionService(setup.deps)({ auth: { uid: 'teacher-a' }, data: REQUEST }),
    error => error instanceof InsightToolQuestionServiceError &&
      error.category === 'answer-unverified' &&
      error.subcategory === 'unsupported-number' &&
      !error.message.includes('raw provider text'),
  )
  assert.equal(setup.calls.includes('uncertain'), true)
  assert.equal(setup.calls.includes('commit'), false)
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
  setup.deps.usageLedger.reserve = async () => ({
    kind: 'completed',
    result: {
      schemaVersion: 1,
      source: 'provider-tool-assistant',
      periodDays: 7,
      evidenceSignature: 'a'.repeat(64),
      generatedAt: '2026-08-27T18:00:00.000Z',
      answer: 'Yes. Ava has two matching transactions today.',
      evidence: ['Checked 2 matching transactions.'],
      usage: { inputTokens: 20, outputTokens: 10, thinkingTokens: 0, costMicroUsd: 10 },
    },
  })
  const result = await createInsightToolQuestionService(setup.deps)({
    auth: { uid: 'teacher-a' },
    data: REQUEST,
  })
  assert.equal(result.answer, 'Yes. Ava has two matching transactions today.')
  assert.equal(setup.calls.includes('assistant'), false)
})
