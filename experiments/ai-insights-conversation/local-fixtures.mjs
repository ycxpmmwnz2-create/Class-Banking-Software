import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createFirestoreUsageLedger } from '../../functions/insights/firestoreUsageLedger.js'
import { createIsolatedPreview } from './integrated-preview.mjs'
import { cases } from './experiment.mjs'

export const NOW = new Date('2026-09-07T18:00:00.000Z')
export const USAGE = { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }
export function memoryDatabase() {
  const store = new Map(), writes = []
  const snapshot = path => ({ exists: store.has(path), id: path.split('/').at(-1), data: () => structuredClone(store.get(path)) })
  const doc = path => ({ path, id: path.split('/').at(-1), get: async () => snapshot(path) })
  let tail = Promise.resolve()
  const firestore = {
    collection: path => ({ doc: id => doc(`${path}/${id}`) }),
    runTransaction(callback) {
      const execute = async () => {
        const pending = new Map()
        const transaction = {
          get: async reference => snapshot(reference.path),
          set: (reference, value) => pending.set(reference.path, structuredClone(value)),
          create: (reference, value) => { assert(!store.has(reference.path) && !pending.has(reference.path)); pending.set(reference.path, structuredClone(value)) },
        }
        const result = await callback(transaction)
        for (const [path, value] of pending) { store.set(path, value); writes.push(path) }
        return result
      }
      const next = tail.then(execute); tail = next.catch(() => {})
      return next
    },
  }
  return { firestore, store, writes }
}
export function scriptedProvider({ narrator = async () => ({ finishReason: 'STOP', text: '{"answer":"Fable had $30 added; Quill had no approved additions."}', usageMetadata: USAGE }), wrongScope = false, onCall = () => {} } = {}) {
  return async (request, phase) => {
    onCall(request, phase)
    if (phase === 'narrator') return narrator(request)
    const responses = request.contents.flatMap(c => c.parts ?? []).map(p => p.functionResponse).filter(Boolean)
    if (responses.length) return { finishReason: 'STOP', usageMetadata: USAGE, text: JSON.stringify({ schemaVersion: 1, sections: responses.map(r => ({ resultId: r.response.resultId, view: r.response.view })) }) }
    const context = JSON.parse(request.contents[0].parts[0].text).classroomContext
    const refs = context.students.filter(s => s.current).map(s => s.ref)
    const args = { studentRefs: refs, transactionType: 'Add', status: wrongScope ? 'Pending' : 'Approved', purpose: 'any', startDate: '2026-08-31', endDate: '2026-09-06' }
    const calls = [
      { id: 'sum-call', name: 'aggregate_transactions', args: { ...args, groupBy: ['student'], metric: 'amountTotal', sort: 'highest', limit: 50 } },
      { id: 'zero-call', name: 'find_students_without_transactions', args: { ...args, limit: 25 } },
    ]
    return { finishReason: 'STOP', usageMetadata: USAGE, functionCalls: calls, candidateContent: { role: 'model', parts: calls.map(functionCall => ({ functionCall })) } }
  }
}
export function setup({ id = 'unique-zero-and-filter-distractors', generateContent, narrator, wrongScope, ledgerDecorator = l => l } = {}) {
  const db = memoryDatabase()
  const fixture = structuredClone(cases().find(c => c.id === id).evidence)
  fixture.question = 'Who received the most and least approved money added among current students from August 31 through September 6, 2026? Include students with no approved additions.'
  const snapshots = { a: fixture, b: structuredClone(fixture) }
  snapshots.b.students.forEach(s => { s.displayName = `Other ${s.displayName}` })
  snapshots.b.transactions.filter(t => t.status === 'Approved' && t.type === 'Add').forEach(t => { t.amount *= 2 })
  const calls = []
  const underlying = generateContent ?? scriptedProvider({ narrator, wrongScope })
  const provider = async (request, phase) => { calls.push({ phase, request: structuredClone(request) }); return underlying(request, phase) }
  const ledger = createFirestoreUsageLedger({ firestore: db.firestore, now: () => NOW.getTime() })
  const service = createIsolatedPreview({
    generateContent: provider, usageLedger: ledgerDecorator(ledger), now: () => NOW,
    resolveActiveTeacherTenant: async ({ auth }) => { assert(['teacher-a', 'teacher-b'].includes(auth?.uid)); return { teacherUid: auth.uid, classroomId: `class-${auth.uid.at(-1)}` } },
    loadQuestionEvidence: async ({ classroomId, question, periodDays, timeZone }) => {
      const assistantEvidence = structuredClone(snapshots[classroomId.at(-1)])
      Object.assign(assistantEvidence, { question, periodDays, timeZone })
      return { assistantEvidence, assistantMemoResolver: () => null, evidenceSignature: createHash('sha256').update(JSON.stringify(assistantEvidence)).digest('hex') }
    },
  })
  const request = { auth: { uid: 'teacher-a' }, data: { kind: 'question', question: fixture.question, periodDays: 7, timeZone: 'America/Denver', requestId: 'isotest-0000000000000001' } }
  const charged = () => [...db.store].filter(([k]) => k.startsWith('insightUsageLedgers/')).reduce((s, [, v]) => s + v.chargedMicroUsd, 0)
  return { ...db, snapshots, service, request, calls, charged }
}
