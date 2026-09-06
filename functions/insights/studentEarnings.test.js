import assert from 'node:assert/strict'
import test from 'node:test'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { createStructuredAnswerRegistry } from './structuredClassroomAnswers.js'

const student = (i, overrides = {}) => ({ ref: `student-${String(i).padStart(3, '0')}`, displayName: `Fictional ${i}`, current: true, balance: 97, frozen: true, ...overrides })
const tx = (i, amount, overrides = {}) => ({ ref: `transaction-${String(i).padStart(5, '0')}`, studentRef: student(i).ref, date: '2026-09-02T15:00:00.000Z', type: 'Add', amount, category: 'Class job', purpose: 'other', status: 'Approved', ...overrides })
function evidence(overrides = {}) {
  return { question: 'Who earned the most and least last week?', generatedAt: '2026-09-07T18:00:00.000Z', asOfDate: '2026-09-07', timeZone: 'America/Denver', periodDays: 7, periodStart: '2026-08-31T18:00:00.000Z', historyStart: '2026-06-09T18:00:00.000Z', configuredRentAmount: 10, students: Array.from({ length: 40 }, (_, i) => student(i + 1)), transactions: [tx(1, 30), tx(2, 20)], categories: [], ...overrides }
}
function run(e = evidence(), args = { window: 'last-week' }) {
  const toolbox = createClassroomAssistantToolbox(e)
  return toolbox.execute('compare_student_earnings', args)
}

test('full roster includes 38 zero earners rather than truncating at eight or 25', () => {
  const result = run()
  assert.equal(result.ok, true)
  assert.equal(result.currentStudentCount, 40)
  assert.equal(result.highestAmount, 30)
  assert.deepEqual(result.highestRefs, ['student-001'])
  assert.equal(result.lowestAmount, 0)
  assert.equal(result.lowestRefs.length, 38)
  assert.equal(result.windowStartDate, '2026-08-31')
  assert.equal(result.windowEndDate, '2026-09-06')
})
test('complete 500-student all-zero roster has one complete tie set', () => {
  const result = run(evidence({ students: Array.from({ length: 500 }, (_, i) => student(i + 1)), transactions: [] }))
  assert.equal(result.highestRefs.length, 500)
  assert.equal(result.lowestRefs.length, 0)
  assert.equal(result.allTied, true)
  assert.equal(result.highestAmount, 0)
})
test('stable refs keep duplicate labels separate, exclude former/status/type distractors and count all ties', () => {
  const result = run(evidence({ students: [student(1, { displayName: 'Avery' }), student(2, { displayName: 'Avery' }), student(3, { current: false })], transactions: [tx(1, 0.1), tx(2, 0.3), tx(4, 0.2, { studentRef: 'student-001' }), tx(3, 999), tx(5, 555, { studentRef: 'student-001', status: 'Pending' }), tx(6, 500, { studentRef: 'student-002', type: 'Subtract' })] }))
  assert.equal(result.highestAmount, 0.3)
  assert.equal(result.lowestAmount, 0.3)
  assert.equal(result.allTied, true)
  assert.deepEqual(result.highestRefs, ['student-001', 'student-002'])
  assert.equal(result.matchedTransactionCount, 3)
})
test('partial first day refuses extrema, exact midnight permits them', () => {
  for (const [historyStart, complete] of [['2026-08-31T06:00:00.000Z', true], ['2026-08-31T06:00:00.001Z', false], ['2026-08-31T17:00:00.000Z', false], ['2026-09-01T06:00:00.000Z', false]]) {
    const result = run(evidence({ historyStart, periodStart: '2026-09-02T18:00:00.000Z' }))
    assert.equal(result.complete, complete)
    assert.equal(result.highestAmount, complete ? 30 : null)
    if (!complete) assert.deepEqual(result.highestRefs, [])
  }
})
test('calendar edges and DST use classroom dates, not fixed 24-hour offsets', () => {
  const e = evidence({ generatedAt: '2026-03-09T18:00:00.000Z', asOfDate: '2026-03-09', periodStart: '2026-03-02T18:00:00.000Z', historyStart: '2026-03-02T07:00:00.000Z', transactions: [tx(1, 1, { date: '2026-03-02T06:59:59.999Z' }), tx(2, 2, { date: '2026-03-02T07:00:00.000Z' }), tx(3, 3, { date: '2026-03-09T05:59:59.999Z' }), tx(4, 4, { date: '2026-03-09T06:00:00.000Z' })] })
  const result = run(e)
  assert.equal(result.complete, true)
  assert.equal(result.matchedTransactionCount, 2)
  assert.equal(result.highestAmount, 3)
  assert.equal(result.windowStartDate, '2026-03-02')
  assert.equal(result.windowEndDate, '2026-03-08')
  const sunday = run(evidence({ asOfDate: '2026-09-06', generatedAt: '2026-09-06T18:00:00.000Z' }))
  assert.equal(sunday.windowStartDate, '2026-08-24')
  assert.equal(sunday.windowEndDate, '2026-08-30')
})
test('selected rolling period honors exact start and excludes future snapshot records', () => {
  const e = evidence({ transactions: [tx(1, 1, { date: '2026-08-31T17:59:59.999Z' }), tx(2, 2, { date: '2026-08-31T18:00:00.000Z' }), tx(3, 3, { date: '2026-09-07T18:00:00.001Z' })] })
  const result = run(e, { window: 'selected-period' })
  assert.equal(result.matchedTransactionCount, 1)
  assert.equal(result.highestAmount, 2)
  assert.equal(result.throughSnapshot, true)
  assert.throws(() => run({ ...e, historyStart: '2026-08-31T18:00:00.001Z' }, { window: 'selected-period' }), /evidence is malformed/u)
})
test('explicit windows reject ambiguous or unsupported filters and invalid dates', () => {
  for (const args of [{ window: 'explicit' }, { window: 'explicit', startDate: '2026-02-30', endDate: '2026-03-01' }, { window: 'explicit', startDate: '2026-09-01', endDate: '2026-09-08' }, { window: 'last-week', status: 'Pending' }, { window: 'last-week', studentRefs: ['student-001'] }, { window: 'last-week', startDate: '2026-09-01' }]) assert.equal(run(evidence(), args).ok, false)
  assert.equal(run(evidence(), { window: 'explicit', startDate: '2026-09-01', endDate: '2026-09-03' }).highestAmount, 30)
})
test('empty roster and incomplete data render honest summaries without balances or frozen state', () => {
  for (const [e, pattern] of [[evidence({ students: [], transactions: [] }), /no current students/u], [evidence({ historyStart: '2026-09-01T06:00:00.000Z', periodStart: '2026-09-01T18:00:00.000Z' }), /cannot determine/u], [evidence(), /Least:/u]]) {
    const registry = createStructuredAnswerRegistry(createClassroomAssistantToolbox(e))
    const result = registry.execute('compare_student_earnings', { window: 'last-week' })
    const rendered = registry.render({ schemaVersion: 1, sections: [{ resultId: result.resultId, view: result.view }] })
    assert.match(rendered.answer, pattern)
    assert.doesNotMatch(rendered.answer, /\$97|frozen/u)
    assert.match(rendered.answer, /America\/Denver/u)
  }
})

test('fall DST and positive-offset classroom zones preserve local midnight coverage', () => {
  const fall = evidence({ generatedAt: '2026-11-02T18:00:00.000Z', asOfDate: '2026-11-02', periodStart: '2026-10-26T18:00:00.000Z', historyStart: '2026-10-26T06:00:00.000Z', transactions: [tx(1, 3, { date: '2026-11-02T06:59:59.999Z' }), tx(2, 4, { date: '2026-11-02T07:00:00.000Z' })] })
  const result = run(fall)
  assert.equal(result.complete, true)
  assert.equal(result.windowStartDate, '2026-10-26')
  assert.equal(result.windowEndDate, '2026-11-01')
  assert.equal(result.matchedTransactionCount, 1)
  assert.equal(result.highestAmount, 3)
  const tokyo = run(evidence({ timeZone: 'Asia/Tokyo', historyStart: '2026-08-30T15:00:00.000Z' }))
  assert.equal(tokyo.complete, true)
  assert.equal(tokyo.windowStartDate, '2026-08-31')
})
