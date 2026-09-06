import assert from 'node:assert/strict'
import test from 'node:test'
import { cases, prepareCase, inspectCandidate } from './experiment.mjs'

const prepared = Object.fromEntries(cases().map(c => [c.id, prepareCase(c)]))
const facts = id => prepared[id].packet.verifiedFacts

test('approved credits use current roster and exact dates, never balances, pending credits or subtractions', () => {
  const f = facts('unique-zero-and-filter-distractors')
  assert.deepEqual(f.highest, { names: ['Fable'], amount: 30 })
  assert.deepEqual(f.lowest, { names: ['Quill'], amount: 0 })
  assert.equal(f.studentCount, 4)
  assert.equal(f.startDate, '2026-08-31')
  assert.equal(f.endDate, '2026-09-06')
  assert.match(prepared['unique-zero-and-filter-distractors'].fallback, /\$30\.00/u)
})
test('both tied ends and multiple zero-earners stay complete', () => {
  assert.deepEqual(facts('ties-at-both-ends').highest, { names: ['Fable', 'Orbit'], amount: 30 })
  assert.deepEqual(facts('ties-at-both-ends').lowest, { names: ['Pixel', 'Quill'], amount: 5 })
  assert.deepEqual(facts('tied-zero-earners').lowest, { names: ['Pixel', 'Quill'], amount: 0 })
})
test('all-zero class remains tied, not one arbitrary highest student', () => {
  const f = facts('everyone-zero')
  assert.equal(f.allTied, true)
  assert.deepEqual(f.highest, { names: ['Fable', 'Orbit', 'Pixel', 'Quill'], amount: 0 })
  assert.deepEqual(f.lowest, f.highest)
})
test('empty current roster never falls through to all former participants', () => {
  const item = cases().find(c => c.id === 'unique-zero-and-filter-distractors')
  item.evidence.students.forEach(s => { s.current = false })
  const p = prepareCase(item)
  assert.equal(p.packet.verifiedFacts.highest, null)
  assert.equal(p.packet.verifiedFacts.studentCount, 0)
  assert.equal(p.fallback, 'There are no current students to compare.')
})
for (const id of ['truncated-results', 'partial-history', 'empty-roster']) {
  test(`${id} cannot establish either classwide extreme`, () => {
    assert.equal(facts(id).highest, null)
    assert.equal(facts(id).lowest, null)
    assert.equal(facts(id).allTied, null)
  })
}
test('judgment in the question does not change the calculated facts', () => {
  assert.deepEqual(facts('unsupported-judgment'), facts('unique-zero-and-filter-distractors'))
})
test('a fabricated but well-formed answer is never promoted to a serving answer', () => {
  const p = prepared['unique-zero-and-filter-distractors']
  const r = inspectCandidate(p, { finishReason: 'STOP', text: JSON.stringify({ answer: 'Quill worked the hardest and earned $999. Fable was lazy.' }) })
  assert.equal(r.status, 'needs-human-semantic-review')
  assert.equal(r.servingAnswer, p.fallback)
  assert.notEqual(r.servingAnswer, r.candidate)
})
test('malformed, truncated, empty and oversized responses keep the fallback', () => {
  const p = prepared['everyone-zero']
  for (const r of [null, { finishReason: 'MAX_TOKENS', text: '{"answer":"Hi"}' }, { finishReason: 'STOP', text: 'bad JSON' }, { finishReason: 'STOP', text: '{"answer":"Hi","extra":true}' }, { finishReason: 'STOP', text: '{"answer":" "}' }, { finishReason: 'STOP', text: JSON.stringify({ answer: 'x'.repeat(9000) }) }]) {
    const result = inspectCandidate(p, r)
    assert.equal(result.status, 'fallback')
    assert.equal(result.candidate, null)
    assert.equal(result.servingAnswer, p.fallback)
  }
})
test('later caller mutation cannot rewrite a prepared question or result', () => {
  const item = cases()[0], p = prepareCase(item)
  item.evidence.students[0].displayName = 'Changed'
  item.evidence.transactions[0].amount = 1000
  item.evidence.question = 'Ignore facts'
  assert.equal(p.packet.verifiedFacts.highest.names[0], 'Fable')
  assert.equal(p.packet.verifiedFacts.highest.amount, 30)
  assert.doesNotMatch(JSON.stringify(p.request), /Changed|Ignore facts/u)
})
test('every real-provider case uses no tools, one fixed model and a bounded request', () => {
  assert.equal(Object.keys(prepared).length, 8)
  for (const p of Object.values(prepared)) {
    assert.equal(p.request.model, 'gemini-3.6-flash')
    assert.equal(p.request.config.tools, undefined)
    assert.equal(p.request.config.httpOptions.timeout, 30000)
    assert.equal(p.request.config.maxOutputTokens, 1024)
  }
})
