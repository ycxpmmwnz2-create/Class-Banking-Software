import test from 'node:test'
import assert from 'node:assert/strict'
import { reportingEvidence, REPORTING_CASES } from './broaderConversationFixtures.js'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { createStructuredAnswerRegistry } from './structuredClassroomAnswers.js'
import { narrateClassroomAnswer } from './conversationNarrator.js'

function fixture() {
  const evidence = reportingEvidence()
  const base = evidence.transactions[0]
  evidence.transactions.push(
    { ...base, ref: 'transaction-00006', date: '2026-08-24T16:00:00.000Z' },
    { ...base, ref: 'transaction-00007', date: '2026-08-26T16:00:00.000Z' },
  )
  return evidence
}
function calculate(evidence, args = {}) {
  const registry = createStructuredAnswerRegistry(createClassroomAssistantToolbox(evidence))
  const selected = registry.execute('aggregate_transactions', { ...REPORTING_CASES[0].args, ...args })
  return { output: selected.output, ...registry.render({ schemaVersion: 1, sections: [{ resultId: selected.resultId, view: selected.view }] }) }
}
test('day answers carry actual Monday/Wednesday/Friday dates through the registry to narration', async () => {
  const result = calculate(fixture())
  assert.equal(result.output.rows[0].value, 3)
  assert.equal(result.output.matchedTransactionCount, 4, 'Two Friday transactions still count as one day')
  assert.deepEqual(result.output.rows[0].matchingDates, ['2026-08-24', '2026-08-26', '2026-08-28'])
  assert.match(result.answer, /Monday, August 24, 2026/u)
  assert.match(result.answer, /Wednesday, August 26, 2026/u)
  assert.match(result.answer, /Friday, August 28, 2026/u)
  assert.doesNotMatch(result.answer, /Tuesday, August 25|Thursday, August 27/u)
  await narrateClassroomAnswer({ answer: result.answer, question: 'How many days did Fable earn Technology money last week?', timeoutMs: 10000, generateContent: async request => {
    const supplied = JSON.parse(request.contents[0].parts[0].text)
    assert.equal(supplied.calculatedAnswer, result.answer)
    assert.match(supplied.calculatedAnswer, /Monday, August 24, 2026/u)
    return { finishReason: 'STOP', text: '{"answer":"Fable earned Technology money three days last week: Monday, Wednesday, and Friday."}', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 } }
  } })
})
test('matching weekdays use classroom dates across UTC midnight', () => {
  const evidence = fixture(), base = evidence.transactions[0]
  evidence.transactions = [{ ...base, date: '2026-08-25T01:00:00.000Z' }]
  const result = calculate(evidence)
  assert.deepEqual(result.output.rows[0].matchingDates, ['2026-08-24'])
  assert.match(result.answer, /Monday, August 24, 2026/u)
  assert.doesNotMatch(result.answer, /Tuesday/u)
})
test('grouped days retain the dates belonging to each student', () => {
  const result = calculate(fixture(), { studentRefs: [], groupBy: ['student'] })
  const fable = result.output.rows.find(row => row.group.student === 'Fable')
  const quill = result.output.rows.find(row => row.group.student === 'Quill')
  assert.deepEqual(fable.matchingDates, ['2026-08-24', '2026-08-26', '2026-08-28'])
  assert.deepEqual(quill.matchingDates, ['2026-08-25'])
})
test('long date lists keep the full count and explicitly identify a bounded date sample', () => {
  const evidence = fixture(), base = evidence.transactions[0]
  evidence.transactions = Array.from({ length: 10 }, (_, index) => ({ ...base, ref: `transaction-${String(index + 1).padStart(5, '0')}`, date: `2026-08-${String(index + 1).padStart(2, '0')}T16:00:00.000Z` }))
  const result = calculate(evidence, { startDate: '2026-08-01', endDate: '2026-08-10' })
  assert.equal(result.output.rows[0].value, 10)
  assert.equal(result.output.rows[0].matchingDates.length, 7)
  assert.match(result.answer, /First 7 of 10 matching dates/u)
})
test('zero matching days has no invented weekday', () => {
  const result = calculate(fixture(), { categoryContains: 'No such category' })
  assert.equal(result.output.rows[0].value, 0)
  assert.deepEqual(result.output.rows[0].matchingDates, [])
  assert.doesNotMatch(result.answer, /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/u)
})
