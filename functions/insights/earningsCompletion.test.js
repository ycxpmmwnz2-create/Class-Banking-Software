import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationalClassroomAssistant } from './geminiClassroomAssistant.js'
const evidence = { question: 'Who earned the most and least last week?', generatedAt: '2026-09-07T18:00:00.000Z', asOfDate: '2026-09-07', timeZone: 'America/Denver', periodDays: 7, periodStart: '2026-08-31T18:00:00.000Z', historyStart: '2026-08-31T12:00:00.000Z', configuredRentAmount: 10, students: [{ ref: 'student-001', displayName: 'Fable', current: true, balance: 97, frozen: true }], categories: [], transactions: [] }
const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 }
function toolResponse(calls) { return { usageMetadata, finishReason: 'STOP', functionCalls: calls, candidateContent: { role: 'model', parts: calls.map(functionCall => ({ functionCall })) } } }
function textResponse(value) { return { usageMetadata, finishReason: 'STOP', text: JSON.stringify(value) } }

test('partial history returns its computed warning without a fragile extra planner envelope', async () => {
  let planner = 0, narrator = 0
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    if (!request.config.tools) { narrator++; return textResponse({ answer: 'The retained history does not cover the full week, so I cannot establish who received the most or least.' }) }
    planner++
    if (planner === 1) return toolResponse([{ id: 'earnings', name: 'compare_student_earnings', args: { window: 'last-week' } }])
    // Reproduces the observed error class, not an invented transcript of the
    // provider reply: the failing run recorded envelope-keys, not raw text.
    return textResponse({ answer: 'Not enough history.', sections: [] })
  } })
  const result = await assistant.answer({ assistantEvidence: evidence })
  assert.match(result.answer, /cannot determine/u)
  assert.match(result.presentation.aiSummary, /cannot establish/u)
  assert.doesNotMatch(result.answer, /Most money added:|Least:/u)
  assert.equal(planner, 1)
  assert.equal(narrator, 1)
})

test('an unsuccessful earnings tool call is never automatically selected', async () => {
  let planner = 0
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    if (!request.config.tools) return textResponse({ answer: 'The requested history is incomplete.' })
    planner++
    return toolResponse([{ id: `call-${planner}`, name: 'compare_student_earnings', args: planner === 1 ? { window: 'last-week', status: 'Pending' } : { window: 'last-week' } }])
  } })
  const result = await assistant.answer({ assistantEvidence: evidence })
  assert.equal(planner, 2)
  assert.match(result.answer, /cannot determine/u)
})

test('a mixed tool batch still requires a valid final selection and does not discard another operation', async () => {
  let planner = 0
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    assert.ok(request.config.tools)
    planner++
    if (planner === 1) return toolResponse([{ id: 'earnings', name: 'compare_student_earnings', args: { window: 'last-week' } }, { id: 'balances', name: 'get_balances', args: {} }])
    const results = request.contents.at(-1).parts.map(p => p.functionResponse.response)
    return textResponse({ schemaVersion: 1, sections: results.map(r => ({ resultId: r.resultId, view: r.view })) })
  } })
  const result = await assistant.answer({ assistantEvidence: evidence })
  assert.equal(planner, 2)
  assert.equal(result.presentation, null)
  assert.match(result.answer, /cannot determine/u)
  assert.match(result.answer, /Total balance: \$97.00/u)
})

test('successful operations from prior turns are preserved for a multi-part question', async () => {
  let planner = 0
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    assert.ok(request.config.tools)
    planner++
    if (planner < 3) return toolResponse([{ id: `call-${planner}`, name: planner === 1 ? 'get_balances' : 'compare_student_earnings', args: planner === 1 ? {} : { window: 'last-week' } }])
    const results = request.contents.flatMap(c => c.parts).map(p => p.functionResponse?.response).filter(Boolean)
    return textResponse({ schemaVersion: 1, sections: results.map(r => ({ resultId: r.resultId, view: r.view })) })
  } })
  const result = await assistant.answer({ assistantEvidence: { ...evidence, question: 'Show balances and who earned most last week.' } })
  assert.equal(planner, 3)
  assert.equal(result.presentation, null)
  assert.match(result.answer, /Total balance: \$97.00/u)
  assert.match(result.answer, /cannot determine/u)
})
