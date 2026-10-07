import assert from 'node:assert/strict'
import test from 'node:test'
import { database } from './conversationTestFixtures.js'
import { createVersion3GeminiLiveHandler } from './liveCallable.js'

const NOW = new Date('2026-08-27T18:00:00.000Z')
const REQUEST = { kind: 'question', question: 'Show all current balances.', periodDays: 7,
  timeZone: 'America/Denver', requestId: 'containment-request-0001' }
const control = (db, patch) => Object.assign(db.store.get('classrooms/class-a').accessControl, patch)
const reservations = db => [...db.store].filter(([p]) => /^insightUsageReservations\/[^/]+$/.test(p))
const claims = db => [...db.store].filter(([p]) => p.includes('/dispatches/'))
function setup({ onProvider, beforeTransaction, afterTransaction } = {}) {
  const db = database(), calls = []
  const original = db.firestore.runTransaction
  db.firestore.runTransaction = async (callback, options) => {
    await beforeTransaction?.(db)
    const result = await original(callback, options)
    await afterTransaction?.(db)
    return result
  }
  class SDK {
    constructor() { this.models = { generateContent: async request => {
      calls.push(request)
      await onProvider?.(db, calls.length)
      const result = request.contents.at(-1).parts[0].functionResponse?.response
      const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
      if (!result) {
        const call = { id: 'one', name: 'get_balances', args: {} }
        return { usageMetadata, functionCalls: [call], candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: call }] } }] }
      }
      const text = JSON.stringify({ schemaVersion: 1, sections: [{ resultId: result.resultId, view: result.view }] })
      return { usageMetadata, text, candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] }
    } } }
  }
  const handler = createVersion3GeminiLiveHandler({ firestore: db.firestore,
    apiKey: 'synthetic-key-at-least-twenty-characters', GoogleGenAIClass: SDK,
    toolAssistantEnabled: true, now: () => NOW })
  return { db, calls, handler, run: () => handler({ auth: { uid: 'teacher-a' }, data: REQUEST }) }
}

for (const mode of ['readOnly', 'suspended', 'missing', 'malformed']) test(`control admission denies ${mode} before evidence, reservation or provider`, async () => {
  const s = setup()
  if (mode === 'missing') delete s.db.store.get('classrooms/class-a').accessControl
  else if (mode === 'malformed') control(s.db, { generation: 0 })
  else control(s.db, { mode, generation: 2 })
  await assert.rejects(s.run())
  assert.equal(s.calls.length, 0)
  assert.equal(s.db.writes.length, 0)
  assert(s.db.reads.every(p => p === 'teachers/teacher-a' || p === 'classrooms/class-a'))
})

test('student role cannot enter Insights even with a teacher-shaped UID', async () => {
  const s = setup()
  await assert.rejects(s.handler({ auth: { uid: 'teacher-a', token: { role: 'student' } }, data: REQUEST }))
  assert.equal(s.calls.length, 0); assert.equal(s.db.writes.length, 0)
})

test('pause after evidence refuses a new reservation without usage writes', async () => {
  let paused = false
  const s = setup({ afterTransaction(db) {
    if (!paused && db.reads.some(p => p.endsWith('/balanceHistory'))) { paused = true; control(db, { mode: 'suspended', generation: 2 }) }
  } })
  await assert.rejects(s.run())
  assert.equal(paused, true); assert.equal(s.calls.length, 0); assert.equal(s.db.writes.length, 0)
})

test('pause after reservation refuses the first dispatch without increasing its charge', async () => {
  let paused = false
  const s = setup({ afterTransaction(db) {
    if (!paused && reservations(db).length) { paused = true; control(db, { mode: 'suspended', generation: 2 }) }
  } })
  await assert.rejects(s.run())
  assert.equal(paused, true); assert.equal(s.calls.length, 0); assert.equal(claims(s.db).length, 0)
  const r = reservations(s.db)[0][1]
  const charge = [...s.db.store].find(([p]) => p.startsWith('insightUsageLedgers/'))[1].chargedMicroUsd
  assert.equal(charge, r.worstCaseCostMicroUsd)
  assert.equal(r.status, 'uncertain')
})

for (const change of ['suspended', 'resume', 'disabled', 'transfer']) test(`control change ${change} after first model call blocks tools and subsequent dispatch`, async () => {
  const s = setup({ onProvider(db) {
    if (change === 'resume') control(db, { generation: 3 })
    else if (change === 'disabled') db.store.get('teachers/teacher-a').status = 'disabled'
    else if (change === 'transfer') db.store.get('classrooms/class-a').ownerUid = 'teacher-b'
    else control(db, { mode: 'suspended', generation: 2 })
  } })
  await assert.rejects(s.run())
  assert.equal(s.calls.length, 1)
  assert.equal(claims(s.db).length, 1)
  assert.equal(claims(s.db)[0][1].status, 'finished')
  assert.equal(reservations(s.db)[0][1].status, 'uncertain')
})

test('a call claimed just before pause may finish, but nothing can publish or dispatch again', async () => {
  let paused = false
  const s = setup({ afterTransaction(db) {
    if (!paused && claims(db).some(([, v]) => v.status === 'claimed')) {
      paused = true; control(db, { mode: 'suspended', generation: 2 })
    }
  } })
  await assert.rejects(s.run())
  assert.equal(paused, true); assert.equal(s.calls.length, 1)
  assert.equal(claims(s.db)[0][1].status, 'finished')
})

test('pause after final provider result permits accounting but denies answer publication and replay', async () => {
  const s = setup({ onProvider(db, n) { if (n === 2) control(db, { mode: 'suspended', generation: 2 }) } })
  await assert.rejects(s.run())
  assert.equal(s.calls.length, 2)
  assert.equal(reservations(s.db)[0][1].status, 'completed')
  assert(claims(s.db).every(([, v]) => v.status === 'finished'))
  const prior = JSON.stringify([...s.db.store])
  await assert.rejects(s.run())
  assert.equal(JSON.stringify([...s.db.store]), prior)
  control(s.db, { mode: 'active', generation: 3 })
  await assert.rejects(s.run()) // request remains bound to generation 1
  assert.equal(s.calls.length, 2)
})

test('pause while replay is being returned is checked again at publication', async () => {
  let pauseReplay = false
  const s = setup({ afterTransaction(db) {
    if (pauseReplay && /^insightUsageReservations\/[^/]+$/.test(db.reads.at(-1)) && reservations(db).some(([, r]) => r.status === 'completed')) control(db, { mode: 'suspended', generation: 2 })
  } })
  await s.run()
  pauseReplay = true
  await assert.rejects(s.run())
  assert.equal(s.calls.length, 2)
})

for (const kind of ['analysis', 'question']) test(`${kind} route claims once, settles after pause and withholds its response`, async () => {
  const db = database()
  let calls = 0
  class SDK {
    constructor() { this.models = { generateContent: async request => {
      calls++
      assert.equal(claims(db).length, 1)
      assert.equal(claims(db)[0][1].status, 'claimed')
      const payload = JSON.parse(request.contents[0].parts[0].text)
      const result = kind === 'analysis'
        ? { schemaVersion: 2, orderedObservationIds: payload.factPacket.observations.map(o => o.id), groups: [], teacherQuestions: [] }
        : { schemaVersion: 8, kind: 'guidance', plan: null, guidance: 'Use consistent earning categories and review classroom balances privately with each student.' }
      control(db, { mode: 'suspended', generation: 2 })
      const text = JSON.stringify(result)
      return { text, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, candidates: [{ finishReason: 'STOP' }] }
    } } }
  }
  const handler = createVersion3GeminiLiveHandler({ firestore: db.firestore, apiKey: 'synthetic-key-at-least-twenty-characters', GoogleGenAIClass: SDK, now: () => NOW })
  const data = kind === 'analysis' ? { requestId: REQUEST.requestId, mode: 'quick', periodDays: 7, timeZone: 'America/Denver' } : REQUEST
  await assert.rejects(handler({ auth: { uid: 'teacher-a' }, data }))
  assert.equal(calls, 1)
  assert.equal(claims(db)[0][1].status, 'finished')
  assert.equal(reservations(db)[0][1].status, 'completed')
})

test('a failed claim settlement leaves observable unresolved work and prevents a second dispatch', async () => {
  const s = setup()
  const original = s.db.firestore.runTransaction
  s.db.firestore.runTransaction = (callback, options) => original(t => callback({ ...t,
    set(ref, value) {
      if (ref.path.includes('/dispatches/') && value.status === 'finished') throw new Error('fictional settlement failure')
      t.set(ref, value)
    },
  }), options)
  await assert.rejects(s.run())
  assert.equal(s.calls.length, 1)
  assert.equal(claims(s.db)[0][1].status, 'claimed')
  assert.equal(reservations(s.db)[0][1].status, 'uncertain')
  await assert.rejects(s.run())
  assert.equal(s.calls.length, 1)
})
