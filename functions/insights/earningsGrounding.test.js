import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationalClassroomAssistant } from './geminiClassroomAssistant.js'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { renderQuestionAnswer } from '../../src/insights/renderQuestionAnswer.js'
const evidence = { question: 'Which student earned the most money today?', generatedAt: '2026-09-09T18:00:00.000Z', asOfDate: '2026-09-09', timeZone: 'America/Denver', periodDays: 7, periodStart: '2026-09-02T18:00:00.000Z', historyStart: '2026-06-09T18:00:00.000Z', configuredRentAmount: 10, categories: [], students: ['Fable', 'Quill', 'Sage'].map((displayName, i) => ({ ref: `student-00${i+1}`, displayName, current: true, balance: 0, frozen: false })), transactions: [10, 2, 10].map((amount, i) => ({ ref: `transaction-0000${i+1}`, studentRef: `student-00${i+1}`, date: '2026-09-09T16:00:00.000Z', type: 'Add', amount, status: 'Approved', category: 'Class job', purpose: 'other' })) }
const args = { window: 'explicit', startDate: '2026-09-09', endDate: '2026-09-09' }
const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 }
async function run(focus, overrides = {}) {
  let narrations = 0
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    if (!request.config.tools) { narrations++; return { usageMetadata, finishReason: 'STOP', text: JSON.stringify({ answer: 'No student whose name starts with S earned the most. Quill earned $999.' }) } }
    const functionCall = { id: 'earnings', name: 'compare_student_earnings', args: { ...args, ...(focus === undefined ? {} : { focus }) } }
    return { usageMetadata, finishReason: 'STOP', functionCalls: [functionCall], candidateContent: { role: 'model', parts: [{ functionCall }] } }
  } })
  const result = await assistant.answer({ assistantEvidence: { ...evidence, ...overrides } })
  assert.equal(narrations, 0)
  assert.equal(result.presentation.aiSummary, null)
  assert.doesNotMatch(renderQuestionAnswer(result), /name starts|999/u)
  assert.match(renderQuestionAnswer(result), /2026-09-09/u)
  return result.answer
}
test('unqualified earnings answer cannot acquire an S-name condition from narration', async () => { await run(undefined) })
test('most displays all highest ties without unrelated lowest earners', async () => {
  const text = await run('most')
  assert.match(text, /Fable.*Sage.*\$10.00/u)
  assert.doesNotMatch(text, /Quill|Least|least/u)
})
test('least displays the lowest result without the highest earners', async () => {
  const text = await run('least', { question: 'Who earned the least today?' })
  assert.match(text, /Quill.*\$2.00/u)
  assert.doesNotMatch(text, /Fable|Sage|Most|most/u)
})
test('both and omitted focus preserve both extremes', async () => {
  for (const focus of ['both', undefined]) assert.match(await run(focus), /Most money added:.*\$10.00.*Least:.*\$2.00/u)
})
test('empty, all-zero and incomplete-history answers retain their limitations', async () => {
  assert.match(await run('most', { students: [], transactions: [] }), /no current students/u)
  assert.match(await run('least', { transactions: [] }), /Everyone is tied at \$0.00/u)
  const text = await run('most', { historyStart: '2026-09-09T12:00:00.000Z', periodStart: '2026-09-09T13:00:00.000Z' })
  assert.match(text, /cannot determine.*most/u)
  assert.doesNotMatch(text, /\$10|least/u)
})
test('focus accepts only declared values and never changes calculated totals', () => {
  const toolbox = createClassroomAssistantToolbox(evidence)
  const original = toolbox.execute('compare_student_earnings', args)
  for (const focus of ['most', 'least', 'both']) assert.deepEqual(toolbox.execute('compare_student_earnings', { ...args, focus }), original)
  for (const focus of ['S', null, 1, {}, 'highest']) assert.equal(toolbox.execute('compare_student_earnings', { ...args, focus }).ok, false)
})

test('an unselected earnings result stays out of the verified current balance answer', async () => {
  let planner = 0, narrator = 0
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    if (!request.config.tools) { narrator++; return { usageMetadata, finishReason: 'STOP', text: JSON.stringify({ answer: 'All current balances are zero.' }) } }
    if (++planner === 1) {
      const calls = [{ id: 'earnings', name: 'compare_student_earnings', args }, { id: 'balances', name: 'get_balances', args: {} }]
      return { usageMetadata, finishReason: 'STOP', functionCalls: calls, candidateContent: { role: 'model', parts: calls.map(functionCall => ({ functionCall })) } }
    }
    const result = request.contents.at(-1).parts.map(p => p.functionResponse.response).find(r => r.view === 'student-balances')
    return { usageMetadata, finishReason: 'STOP', text: JSON.stringify({ schemaVersion: 1, sections: [{ resultId: result.resultId, view: result.view }] }) }
  } })
  const result = await assistant.answer({ assistantEvidence: evidence })
  assert.equal(narrator, 0)
  assert.equal(result.presentation.aiSummary, null)
  assert.doesNotMatch(result.answer, /Most money added/u)
})
