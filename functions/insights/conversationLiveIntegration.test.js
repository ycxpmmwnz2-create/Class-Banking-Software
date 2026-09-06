import assert from 'node:assert/strict'
import test from 'node:test'
import { database } from './conversationTestFixtures.js'
import { createVersion3GeminiLiveHandler } from './liveCallable.js'
import { validateProviderQuestionResponse } from '../../src/insights/providerInsightsClient.js'
import { GEMINI_MONTHLY_ALLOWANCE_MICRO_USD } from './costPolicy.js'

const NOW = new Date('2026-09-07T18:00:00.000Z')
const REQUEST = { kind: 'question', question: 'Who earned the most and least last week?', periodDays: 7, timeZone: 'America/Denver', requestId: 'conversation-000000000001' }
const USAGE = { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }
function setup({ mode = 'valid', tool = 'compare_student_earnings', failSave = false } = {}) {
  const db = database(), calls = []
  for (const tenant of ['a', 'b']) {
    for (let id = 3; id <= 40; id++) db.store.set(`classrooms/class-${tenant}/students/${id}`, { id, name: `${tenant === 'a' ? 'Fable' : 'Orbit'} ${id}`, balance: 97, frozen: true, transactions: [] })
    db.store.set(`classrooms/class-${tenant}/transactions/101`, { id: 101, date: '2026-09-02T18:00:00.000Z', studentId: 1, studentName: tenant === 'a' ? 'Avery Morgan' : 'Blake Smith', type: 'Add', amount: tenant === 'a' ? 30 : 60, reason: 'Class job', category: 'Class job', memo: '', status: 'Approved', source: 'Teacher' })
  }
  const initial = globalThis.structuredClone([...db.store])
  if (failSave) {
    const original = db.firestore.runTransaction
    db.firestore.runTransaction = callback => original(async t => callback({ ...t,
      set(ref, value) {
        if (value.status === 'completed' || value.status === 'uncertain') throw new Error('Simulated write failure')
        t.set(ref, value)
      },
    }))
  }
  class SDK {
    constructor() {
      this.models = { generateContent: async request => {
        calls.push(globalThis.structuredClone(request))
        const response = text => ({ usageMetadata: USAGE, text, candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] })
        if (!request.config.tools) {
          if (mode === 'timeout') throw new Error('simulated provider timeout')
          if (mode === 'missing-usage') return { ...response('{"answer":"Avery had $30 added."}'), usageMetadata: undefined }
          if (mode === 'bad-json') return response('{')
          if (mode === 'truncated') return { ...response('{"answer":"Avery"}'), candidates: [{ finishReason: 'MAX_TOKENS' }] }
          if (mode === 'html') return response('{"answer":"<img src=x onerror=alert(1)>"}')
          if (mode === 'false-prose') return response('{"answer":"Avery earned $999 because everyone else was lazy."}')
          const facts = JSON.parse(request.contents[0].parts[0].text).calculatedAnswer
          return response(JSON.stringify({ answer: facts.includes('Blake') ? 'Blake S. had the most approved money added: $60. The other students had none.' : 'Avery M. had the most approved money added: $30. The other students had none.' }))
        }
        const result = request.contents.at(-1).parts[0].functionResponse?.response
        if (!result) {
          const call = { id: 'call-1', name: tool, args: tool === 'compare_student_earnings' ? { window: 'last-week' } : {} }
          return { usageMetadata: USAGE, functionCalls: [call], candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: call }] } }] }
        }
        return response(JSON.stringify({ schemaVersion: 1, sections: [{ resultId: result.resultId, view: result.view }] }))
      } }
    }
  }
  const handler = createVersion3GeminiLiveHandler({ firestore: db.firestore, apiKey: 'synthetic-test-api-key-at-least-twenty-characters', GoogleGenAIClass: SDK, toolAssistantEnabled: true, now: () => NOW })
  return { ...db, initial, calls, handler, request: { auth: { uid: 'teacher-a' }, data: REQUEST } }
}
async function assertReplay(s, first) {
  const calls = s.calls.length, writes = s.writes.length
  const before = globalThis.structuredClone([...s.store])
  assert.deepEqual(await s.handler(s.request), first)
  assert.equal(s.calls.length, calls)
  assert.equal(s.writes.length, writes)
  assert.deepEqual([...s.store], before)
}

test('actual live composition saves a 40-student comparison and narration in one reservation with exact replay', async () => {
  const s = setup(), result = await s.handler(s.request)
  assert.match(result.presentation.aiSummary, /\$30/u)
  assert.match(result.presentation.calculatedSummary, /Least:/u)
  assert.match(result.presentation.calculationDetails, /40 students/u)
  assert.equal(result.presentation.billingBasis, 'observed')
  assert.equal(s.calls.length, 2)
  assert.equal(s.calls[1].config.httpOptions.retryOptions.attempts, 1)
  assert.ok(s.calls[1].config.httpOptions.timeout <= 15000)
  assert.equal(s.calls[1].config.tools, undefined)
  assert.doesNotMatch(s.calls[1].contents[0].parts[0].text, /teacher-a|class-a|Avery Morgan|frozen|currentBalance/u)
  assert.deepEqual(validateProviderQuestionResponse(result), result)
  const reservations = [...s.store].filter(([path]) => path.startsWith('insightUsageReservations/'))
  assert.equal(reservations.length, 1)
  assert.equal(reservations[0][1].result.answerContract, 'conversational-v1')
  assert.equal(reservations[0][1].status, 'completed')
  const limits = [...s.store].filter(([path]) => path.startsWith('insightUsageRateLimits/'))
  assert.equal(limits.length, 1)
  assert.equal(limits[0][1].quickReservationTimesMs.length, 1)
  assert.ok(s.writes.every(path => /^insightUsage/u.test(path)))
  for (const [path, value] of s.initial) assert.deepEqual(s.store.get(path), value)
  await assertReplay(s, result)
})
for (const mode of ['bad-json', 'truncated', 'html', 'timeout', 'missing-usage']) test(`${mode} preserves calculated answer and replays the saved fallback`, async () => {
  const s = setup({ mode }), result = await s.handler(s.request)
  assert.equal(result.presentation.aiSummary, null)
  assert.match(result.answer, /\$30.00/u)
  const unknown = ['timeout', 'missing-usage'].includes(mode)
  assert.equal(result.presentation.billingBasis, unknown ? 'reserved-unknown' : 'observed')
  const record = [...s.store].find(([path]) => path.startsWith('insightUsageReservations/'))[1]
  if (unknown) assert.equal(record.actualCostMicroUsd, record.worstCaseCostMicroUsd)
  assert.equal(s.calls.length, 2)
  await assertReplay(s, result)
})
test('same request ID for two tenants never reuses names, amounts or narration', async () => {
  const s = setup(), a = await s.handler(s.request)
  const b = await s.handler({ ...s.request, auth: { uid: 'teacher-b' } })
  assert.match(b.presentation.aiSummary, /Blake.*\$60/u)
  assert.doesNotMatch(b.answer, /Avery|Fable/u)
  assert.doesNotMatch(s.calls[3].contents[0].parts[0].text, /Avery|Fable/u)
  await assertReplay(s, a)
})
test('changed evidence conflicts without calling Gemini again', async () => {
  const s = setup(); await s.handler(s.request)
  s.store.get('classrooms/class-a/transactions/101').amount = 31
  await assert.rejects(s.handler(s.request))
  assert.equal(s.calls.length, 2)
})
test('concurrent duplicate requests do not duplicate planner or narration work', async () => {
  const s = setup()
  const results = await Promise.allSettled([s.handler(s.request), s.handler(s.request)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(s.calls.length, 2)
  await assertReplay(s, results.find(r => r.status === 'fulfilled').value)
})
test('unrelated selected results retain the original answer without earnings narration', async () => {
  const s = setup({ tool: 'get_balances' }), result = await s.handler(s.request)
  assert.equal(result.presentation, undefined)
  assert.equal(s.calls.length, 2)
})
test('fluent false prose is explicitly unverified and never overwrites the calculated answer', async () => {
  const s = setup({ mode: 'false-prose' }), result = await s.handler(s.request)
  assert.match(result.presentation.aiSummary, /\$999/u)
  assert.doesNotMatch(result.answer, /999|lazy/u)
  assert.match(result.answer, /\$30.00/u)
})
test('save and markUncertain failure keep the reservation active, blocking another provider run', async () => {
  const s = setup({ failSave: true })
  await assert.rejects(s.handler(s.request))
  await assert.rejects(s.handler(s.request))
  assert.equal(s.calls.length, 2)
})
test('when narration will not fit the remaining allowance, calculate within one base reservation', async () => {
  const s = setup(); await s.handler(s.request)
  const ledger = [...s.store].find(([path]) => path.startsWith('insightUsageLedgers/'))[1]
  const prior = [...s.store].find(([path]) => path.startsWith('insightUsageReservations/'))[1]
  // Leave slightly less than the combined quote but more than the base quote.
  ledger.chargedMicroUsd = GEMINI_MONTHLY_ALLOWANCE_MICRO_USD - prior.worstCaseCostMicroUsd + 1000
  const request = { ...s.request, data: { ...REQUEST, requestId: 'conversation-000000000002' } }
  const result = await s.handler(request)
  assert.equal(result.presentation.aiSummary, null)
  assert.match(result.answer, /\$30.00/u)
  assert.equal(s.calls.length, 3)
  await assertReplay({ ...s, request }, result)
})

test('a completed response with a different stored answer contract is refused without another call', async () => {
  const s = setup(); await s.handler(s.request)
  const record = [...s.store].find(([path]) => path.startsWith('insightUsageReservations/'))[1]
  record.result.answerContract = 'structured-v1'
  await assert.rejects(s.handler(s.request), error => error.category === 'invalid-replay')
  assert.equal(s.calls.length, 2)
})
