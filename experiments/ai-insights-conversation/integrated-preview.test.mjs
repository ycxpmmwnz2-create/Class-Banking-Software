import assert from 'node:assert/strict'
import test from 'node:test'
import { setup, USAGE, scriptedProvider } from './local-fixtures.mjs'

const good = answer => ({ finishReason: 'STOP', usageMetadata: USAGE, text: JSON.stringify({ answer }) })
test('real assistant/service/ledger path renders a draft separately and replays with no second call or charge', async () => {
  const s = setup(), snapshots = structuredClone(s.snapshots)
  const first = await s.service(s.request), cost = s.charged(), writes = s.writes.length
  assert.equal(first.status, 'draft-for-review')
  assert.equal(first.reviewRequired, true)
  assert.match(first.verifiedSummary, /Fable — \$30\.00/u)
  assert.match(first.verifiedSummary, /Quill — \$0\.00/u)
  assert.doesNotMatch(first.verifiedSummary + first.details.join(' '), /97|frozen/u)
  assert.equal(first.base.source, 'ai-grounded')
  assert.notEqual(first.base.answer, first.aiExplanation)
  assert.equal(s.calls.length, 3)
  assert.deepEqual(await s.service(s.request), first)
  assert.equal(s.calls.length, 3); assert.equal(s.charged(), cost); assert.equal(s.writes.length, writes)
  assert(s.writes.every(p => /^insightUsage(?:Ledgers|Reservations|RateLimits)\//u.test(p)))
  assert.deepEqual(s.snapshots, snapshots)
})
test('ties and zero-earners remain full-scope facts through the service', async () => {
  const s = setup({ id: 'ties-at-both-ends', narrator: async () => good('Fable and Orbit tied at $30; Pixel and Quill tied at $5.') })
  const p = await s.service(s.request)
  assert.deepEqual(p.facts.highest, { amount: 30, names: ['Fable','Orbit'] })
  assert.deepEqual(p.facts.lowest, { amount: 5, names: ['Pixel','Quill'] })
})
test('partial history gives an explicit calculated warning and never ranks partial-week values', async () => {
  const s = setup({ id: 'partial-history', narrator: async () => good('The records do not cover the entire date range.') })
  const p = await s.service(s.request)
  assert.equal(p.facts.highest, null); assert.equal(p.facts.lowest, null)
  assert.match(p.verifiedSummary, /does not cover the full requested date range/u)
  assert.doesNotMatch(p.verifiedSummary, /Fable|\$30|\$20|\$5/u)
  assert.doesNotMatch(p.details.join(' '), /balance:|frozen/u)
})
for (const [name, narrator] of [
  ['malformed JSON', async () => ({ ...good('x'), text: 'broken' })],
  ['truncated response', async () => ({ ...good('x'), finishReason: 'MAX_TOKENS' })],
  ['provider timeout', async () => { throw new Error('provider-timeout') }],
  ['missing usage', async () => ({ finishReason: 'STOP', text: '{"answer":"Fable had $30 added."}' })],
]) {
  test(`${name} preserves and persists the calculated fallback without retry`, async () => {
    const s = setup({ narrator })
    const p = await s.service(s.request), cost = s.charged()
    assert.equal(p.aiExplanation, null)
    assert.match(p.verifiedSummary, /Fable — \$30\.00/u)
    assert.equal(s.calls.length, 3)
    assert.deepEqual(await s.service(s.request), p)
    assert.equal(s.calls.length, 3); assert.equal(s.charged(), cost)
    if (['provider timeout','missing usage'].includes(name)) {
      const records = [...s.store].filter(([k]) => k.startsWith('insightUsageReservations/')).map(([,v]) => v)
      const narrative = records.find(v => v.result?.contract === 'local-conversation-preview-v1')
      assert.equal(narrative.result.accounting, 'reserved-unknown')
      assert.equal(narrative.actualCostMicroUsd, narrative.worstCaseCostMicroUsd)
    }
  })
}
test('narration budget failure never removes the valid calculation or calls narrator', async () => {
  const s = setup({ ledgerDecorator: ledger => ({ ...ledger, reserve: input => input.requestId.startsWith('isotest-') ? ledger.reserve(input) : Promise.reject(new Error('no-narration-budget')) }) })
  const p = await s.service(s.request)
  assert.equal(p.status, 'calculated-only-narration-unavailable')
  assert.match(p.verifiedSummary, /Fable/u)
  assert.equal(s.calls.length, 2)
  assert.deepEqual(await s.service(s.request), p)
  assert.equal(s.calls.length, 2)
})
test('wrong selected status cannot be relabelled as approved earnings', async () => {
  const s = setup({ wrongScope: true })
  const p = await s.service(s.request)
  assert.equal(p.status, 'unsupported-preview'); assert.equal(p.aiExplanation, null); assert.equal(p.facts, null)
  assert.equal(p.verifiedSummary, p.base.answer)
  assert.match(p.verifiedSummary, /Filters: Pending/u)
  assert.equal(s.calls.length, 2)
})
test('two tenants with the same request ID have separate facts, prompts and saved narration', async () => {
  const s = setup({ narrator: async r => { const f = JSON.parse(r.contents[0].parts[0].text).verifiedFacts; return good(`${f.highest.names.join(' and ')}: $${f.highest.amount}`) } })
  const a = await s.service(s.request), previous = s.calls.length
  const b = await s.service({ ...s.request, auth: { uid: 'teacher-b' } })
  assert.equal(a.facts.highest.amount, 30); assert.equal(b.facts.highest.amount, 60)
  assert.equal(b.facts.highest.names[0], 'Other Fable')
  assert.notEqual(a.aiExplanation, b.aiExplanation)
  const narrative = s.calls.slice(previous).find(c => c.phase === 'narrator').request
  assert.doesNotMatch(JSON.stringify(narrative), /teacher-a|class-a|"Fable"/u)
  assert.deepEqual(await s.service(s.request), a)
  assert.equal(s.calls.length, 6)
})
test('changed evidence cannot replay an old narration against the same request ID', async () => {
  const s = setup(); await s.service(s.request)
  s.snapshots.a.transactions[0].amount = 35
  await assert.rejects(s.service(s.request))
  assert.equal(s.calls.length, 3)
})
test('concurrent identical requests cannot duplicate provider work', async () => {
  let release, began
  const gate = new Promise(r => { release = r }), started = new Promise(r => { began = r })
  const script = scriptedProvider()
  const s = setup({ generateContent: async (r,p) => { if(p==='planner'){ began(); await gate } return script(r,p) } })
  const first = s.service(s.request); await started
  await assert.rejects(s.service(s.request))
  release(); const result = await first
  assert.equal(result.status, 'draft-for-review'); assert.equal(s.calls.length, 3)
})
test('fluent fabricated prose remains an unverified draft beside correct calculated facts', async () => {
  const s = setup({ narrator: async () => good('<img src=x onerror=alert(1)> Quill earned $999 and worked hardest.') })
  const p = await s.service(s.request)
  assert.equal(p.reviewRequired, true)
  assert.match(p.aiExplanation, /\$999/u)
  assert.equal(p.facts.highest.amount, 30)
  assert.notEqual(p.base.answer, p.aiExplanation)
})
