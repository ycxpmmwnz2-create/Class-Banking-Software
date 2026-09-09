import test from 'node:test'
import assert from 'node:assert/strict'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { createStructuredAnswerRegistry } from './structuredClassroomAnswers.js'

const evidence = (history) => ({
  question: 'Who was negative on Friday?', generatedAt: '2026-09-08T18:00:00.000Z',
  asOfDate: '2026-09-08', timeZone: 'America/Denver', periodDays: 7,
  periodStart: '2026-09-01T18:00:00.000Z', historyStart: '2026-06-10T18:00:00.000Z',
  configuredRentAmount: 10, categories: [], transactions: [],
  students: [{ ref: 'student-001', displayName: 'Fictional Avery', current: true, balance: 0, frozen: false,
    ...(history === undefined ? {} : { balanceHistory: history }) }],
})
function render(data, tool, args) {
  const registry = createStructuredAnswerRegistry(createClassroomAssistantToolbox(data))
  const result = registry.execute(tool, args)
  const selection = { schemaVersion: 1, sections: [{ resultId: result.resultId, view: result.view }] }
  return { result: result.output, rendered: registry.render(selection), verifiedOnly: registry.requiresVerifiedAnswer(selection) }
}

test('a prior silent roster reset cannot support a claim of zero Friday matches', () => {
  const r = render(evidence(), 'get_balances_as_of', { asOfDate: '2026-09-04', condition: 'negative' })
  assert.equal(r.result.unavailableCount, 1)
  assert.equal(r.result.matchedPercent, null)
  assert.deepEqual(r.result.students, [])
  assert.match(r.rendered.answer, /Cannot determine the complete list/u)
  assert.doesNotMatch(r.rendered.answer, /0 current students match/u)
  assert.equal(r.verifiedOnly, true)
})

test('verified historical balance survives current zero and a missing transaction ledger', () => {
  const r = render(evidence({ '2026-09-04': -10 }), 'get_balances_as_of', { asOfDate: '2026-09-04', condition: 'negative' })
  assert.equal(r.result.students[0].balanceAsOf, -10)
  assert.equal(r.result.unavailableCount, 0)
})

test('editable Approved transactions cannot fill a missing history date', () => {
  const data = evidence({})
  data.transactions = [{ ref: 'transaction-00001', studentRef: 'student-001', date: '2026-09-08T17:00:00Z',
    type: 'Add', amount: 500, category: 'Adjustment', status: 'Approved', purpose: 'other' }]
  const r = render(data, 'get_balances_as_of', { asOfDate: '2026-09-04', condition: 'negative' })
  assert.equal(r.result.unavailableCount, 1)
  assert.deepEqual(r.result.students, [])
})

test('named history with no witnesses never fabricates past zeros', () => {
  const r = render(evidence(), 'get_balance_history', { studentRefs: ['student-001'], startDate: '2026-09-04', endDate: '2026-09-04' })
  assert.deepEqual(r.result.rows, [])
  assert.match(r.rendered.answer, /Balance history unavailable/u)
  assert.equal(r.verifiedOnly, true)
})

test('mixed date range preserves today but discloses missing dates per student', () => {
  const r = render(evidence({ '2026-09-06': -10 }), 'get_balance_history', {
    studentRefs: ['student-001'], startDate: '2026-09-04', endDate: '2026-09-08',
  })
  assert.deepEqual(r.result.rows.map(row => [row.date, row.closingBalance]), [['2026-09-06', -10], ['2026-09-08', 0]])
  assert.match(r.rendered.answer, /Some requested balance history is unavailable/u)
  assert.match(r.rendered.answer, /not a future end-of-day balance/u)
})

test('today does not require a history witness and ignores a supplied historical today value', () => {
  const r = render(evidence({ '2026-09-08': -20 }), 'get_balances_as_of', { asOfDate: '2026-09-08', condition: 'zero' })
  assert.equal(r.result.students[0].balanceAsOf, 0)
  assert.equal(r.result.throughSnapshot, true)
})

test('malformed date/value maps are refused instead of enabling a historical answer', () => {
  for (const history of [null, [], { '2026-02-30': 10 }, { '2026-09-09': 10 }, { '2026-09-04': null }, { '2026-09-04': Infinity }]) {
    assert.throws(() => createClassroomAssistantToolbox(evidence(history)), /balance history is malformed/u)
  }
})

test('provider arguments cannot inject historical proof', () => {
  const result = createClassroomAssistantToolbox(evidence()).execute('get_balances_as_of', {
    asOfDate: '2026-09-04', balanceHistory: { '2026-09-04': -10 },
  })
  assert.equal(result.ok, false)
})
