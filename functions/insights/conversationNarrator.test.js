import assert from 'node:assert/strict'
import test from 'node:test'
import { narrateEarnings, NARRATION_MAX_INPUT_TOKENS } from './conversationNarrator.js'
import { validateConversationPresentation } from './conversationContract.js'

const input = { answer: 'Most: Fable — $30. Least: Quill — $0.\nApproved additions, current roster.', question: 'Who earned the most?', timeoutMs: 10000 }
const response = { finishReason: 'STOP', text: '{"answer":"Fable had the most approved money added: $30."}', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 } }
test('narrator never starts when its prompt or remaining deadline cannot fit', async () => {
  let calls = 0
  for (const override of [{ timeoutMs: 999 }, { answer: 'x'.repeat(NARRATION_MAX_INPUT_TOKENS) }]) {
    const result = await narrateEarnings({ ...input, ...override, generateContent: async () => { calls++; return response } })
    assert.equal(result.aiSummary, null)
    assert.equal(result.uncertain, false)
  }
  assert.equal(calls, 0)
})
test('unknown or out-of-quote usage does not invent usage counts or release the reservation', async () => {
  for (const usageMetadata of [undefined, { promptTokenCount: 12001, candidatesTokenCount: 1, totalTokenCount: 12002 }, { promptTokenCount: 1, candidatesTokenCount: 1025, totalTokenCount: 1026 }]) {
    const result = await narrateEarnings({ ...input, generateContent: async () => ({ ...response, usageMetadata }) })
    assert.equal(result.uncertain, true)
    assert.equal(result.aiSummary, null)
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 })
  }
})
test('presentation binds calculated text exactly and bounds the separate unverified summary', () => {
  const presentation = { aiSummary: 'An AI summary.', calculatedSummary: 'Fable: $30.', calculationDetails: 'Approved additions.', billingBasis: 'observed' }
  const answer = 'Fable: $30.\nApproved additions.'
  assert.deepEqual(validateConversationPresentation(presentation, answer), presentation)
  for (const patch of [{ calculatedSummary: 'Fable: $999.' }, { billingBasis: 'free' }, { aiSummary: 'x'.repeat(1201) }, { injected: true }, { aiSummary: '\u0000' }]) assert.throws(() => validateConversationPresentation({ ...presentation, ...patch }, answer))
})

test('four planner turns remain available; narration yields its slot when planning needs all four', async () => {
  const { createConversationalClassroomAssistant } = await import('./geminiClassroomAssistant.js')
  const evidence = { question: 'Who earned the most last week?', generatedAt: '2026-09-07T18:00:00.000Z', asOfDate: '2026-09-07', timeZone: 'America/Denver', periodDays: 7, periodStart: '2026-08-31T18:00:00.000Z', historyStart: '2026-06-09T18:00:00.000Z', configuredRentAmount: 10, students: [], categories: [], transactions: [] }
  let calls = 0
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    calls++
    assert.ok(request.config.tools, 'No fifth narration call is allowed')
    const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
    const call = { id: `call-${calls}`, name: calls === 4 ? 'compare_student_earnings' : 'describe_schema', args: calls === 4 ? { window: 'last-week' } : {} }
    return { usageMetadata, finishReason: 'STOP', functionCalls: [call], candidateContent: { role: 'model', parts: [{ functionCall: call }] } }
  } })
  const result = await assistant.answer({ assistantEvidence: evidence })
  assert.equal(calls, 4)
  assert.equal(result.presentation.aiSummary, null)
  assert.match(result.answer, /no current students/u)
})
