import assert from 'node:assert/strict'
import test from 'node:test'
import { createVersion3GeminiLiveHandler } from './liveCallable.js'
import { callableErrorDetails, callableLogDiagnostic } from './callableErrors.js'

const NOW = new Date('2026-08-27T18:00:00.000Z')
const REQUEST = { kind: 'question', question: 'Show all current balances.', periodDays: 7,
  timeZone: 'America/Denver', requestId: '12345678-1234-4234-8234-123456789abc' }

// In-memory Firestore semantics used by the real tenant resolver, snapshot
// loader and usage ledger. No Firebase SDK initialization, network or data.
function database() {
  const initial = {}
  for (const tenant of ['a', 'b']) {
    initial[`teachers/teacher-${tenant}`] = { uid: `teacher-${tenant}`, status: 'active', classroomId: `class-${tenant}` }
    initial[`classrooms/class-${tenant}`] = { ownerUid: `teacher-${tenant}` }
    initial[`classrooms/class-${tenant}/studentDisplay/rent`] = { rentAmount: 10, updatedAt: '2026-08-27T17:00:00.000Z' }
    for (const id of [1, 2]) initial[`classrooms/class-${tenant}/students/${id}`] = {
      id, name: tenant === 'a' ? 'Avery Morgan' : 'Blake Smith', balance: tenant === 'a' ? id : id * 10,
      frozen: false, transactions: [],
    }
  }
  const store = new Map(Object.entries(globalThis.structuredClone(initial)))
  const reads = [], writes = []
  function snapshot(path) { return { exists: store.has(path), id: path.split('/').at(-1), data: () => globalThis.structuredClone(store.get(path)) } }
  function get(reference) {
    reads.push(reference.path)
    if (reference.kind !== 'query') return snapshot(reference.path)
    const prefix = reference.path + '/'
    const docs = [...store.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .sort().slice(0, reference.limitCount ?? undefined).map(snapshot)
    return { size: docs.length, docs }
  }
  function doc(path) { return { path, id: path.split('/').at(-1), get: async () => get({ path }), collection: name => query(`${path}/${name}`) } }
  function query(path) { return { path, kind: 'query', doc: id => doc(`${path}/${id}`), limit(count) { return { ...this, limitCount: count } } } }
  return {
    initial, store, reads, writes,
    firestore: {
      collection: query,
      async runTransaction(callback) {
        const pending = new Map()
        const result = await callback({
          get: async reference => get(reference),
          set(reference, value) { pending.set(reference.path, globalThis.structuredClone(value)) },
          create(reference, value) {
            assert.equal(store.has(reference.path) || pending.has(reference.path), false)
            pending.set(reference.path, globalThis.structuredClone(value))
          },
        })
        for (const [path, value] of pending) { writes.push(path); store.set(path, value) }
        return result
      },
    },
  }
}

function liveSetup(finalMode = 'valid') {
  const db = database()
  const providerRequests = []
  class FakeGoogleGenAI {
    constructor() {
      this.models = { generateContent: async request => {
        providerRequests.push(request)
        const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
        const result = request.contents.at(-1).parts[0].functionResponse?.response
        if (!result) {
          const call = { id: 'call-1', name: 'get_balances', args: {} }
          return { usageMetadata, functionCalls: [call], candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: call }] } }] }
        }
        const selection = { schemaVersion: 1, sections: [{ resultId: result.resultId, view: result.view }] }
        const text = finalMode === 'prose' ? JSON.stringify({ answer: 'Showing 2 frozen students.', evidenceCallIds: ['call-1'], factRefs: [] })
          : finalMode === 'fenced' ? '```json\n' + JSON.stringify(selection) + '\n```' : JSON.stringify(selection)
        return { usageMetadata, text, candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] }
      } }
    }
  }
  const handler = createVersion3GeminiLiveHandler({ firestore: db.firestore, apiKey: 'synthetic-test-api-key-at-least-twenty-characters',
    GoogleGenAIClass: FakeGoogleGenAI, toolAssistantEnabled: true, now: () => NOW })
  return { ...db, handler, providerRequests }
}

test('real live composition isolates two tenants, disambiguates duplicate names and only writes usage records', async () => {
  const setup = liveSetup()
  const a = await setup.handler({ auth: { uid: 'teacher-a' }, data: REQUEST })
  assert.match(a.answer, /"Avery M\." — \$1.00/u)
  assert.match(a.answer, /"Avery M\. \(2\)" — \$2.00/u)
  assert.match(a.answer, /Total balance: \$3.00/u)
  assert.doesNotMatch(JSON.stringify(setup.providerRequests), /Avery Morgan|teacher-a|class-a|Blake Smith/u)
  const priorRequests = setup.providerRequests.length
  const priorReads = setup.reads.length
  const b = await setup.handler({ auth: { uid: 'teacher-b' }, data: REQUEST })
  assert.match(b.answer, /Total balance: \$30.00/u)
  assert.doesNotMatch(b.answer, /Avery/u)
  assert.equal(setup.reads.slice(priorReads).some(path => path.startsWith('classrooms/class-a')), false)
  assert.doesNotMatch(JSON.stringify(setup.providerRequests.slice(priorRequests).map(request => request.contents)), /Avery|teacher-b|class-b/u)
  assert.equal(setup.providerRequests.length, 4)
  const replay = await setup.handler({ auth: { uid: 'teacher-a' }, data: REQUEST })
  assert.deepEqual(replay, a)
  assert.equal(setup.providerRequests.length, 4)
  assert.ok(setup.writes.length > 0)
  assert.ok(setup.writes.every(path => /^insightUsage(?:Ledgers|RateLimits|Reservations)\//u.test(path)))
  for (const [path, value] of Object.entries(setup.initial)) assert.deepEqual(setup.store.get(path), value)
})

test('live composition refuses legacy factual prose and retains the uncertain reservation', async () => {
  const setup = liveSetup('prose')
  await assert.rejects(setup.handler({ auth: { uid: 'teacher-a' }, data: REQUEST }), error => {
    assert.equal(error.category, 'answer-unverified')
    assert.equal(error.subcategory, 'answer-shape')
    assert.deepEqual(error.diagnostic, { structuredAnswerCode: 'envelope-keys' })
    assert.deepEqual(callableLogDiagnostic(error), { structuredAnswerCode: 'envelope-keys' })
    assert.deepEqual(callableErrorDetails(error), { category: 'answer-unverified' })
    assert.ok(!JSON.stringify(error).includes('Showing 2 frozen students'))
    assert.ok(!JSON.stringify(error).includes('Avery'))
    return true
  })
  const reservations = [...setup.store.entries()].filter(([path]) => path.startsWith('insightUsageReservations/'))
  assert.equal(reservations.length, 1)
  assert.equal(reservations[0][1].status, 'uncertain')
  assert.equal(reservations[0][1].result, null)
  await assert.rejects(setup.handler({ auth: { uid: 'teacher-a' }, data: REQUEST }))
  assert.equal(setup.providerRequests.length, 2)
})

test('a single JSON fence is accepted without permitting prose outside the closed envelope', async () => {
  const setup = liveSetup('fenced')
  const result = await setup.handler({ auth: { uid: 'teacher-a' }, data: REQUEST })
  assert.match(result.answer, /Total balance: \$3.00/u)
})

test('ambiguous first or duplicate full names refuse before any provider request or reservation', async () => {
  for (const question of ["Show Avery's balance.", "Show Avery Morgan's balance."]) {
    const setup = liveSetup()
    await assert.rejects(setup.handler({ auth: { uid: 'teacher-a' }, data: { ...REQUEST, question } }),
      error => error.category === 'question-ambiguous')
    assert.equal(setup.providerRequests.length, 0)
    assert.equal(setup.writes.length, 0)
  }
})

test('qualified occurrence names survive the ambiguity guard', async () => {
  const setup = liveSetup()
  const result = await setup.handler({ auth: { uid: 'teacher-a' }, data: { ...REQUEST, question: "Show Avery M. (2)'s balance." } })
  // The injected provider deliberately returns all balances; this tests the
  // real privacy/name boundary, not whether a live model chooses the right ref.
  assert.match(result.answer, /Avery M\. \(2\)/u)
})
