import assert from 'node:assert/strict'
import process from 'node:process'
import { createRequire } from 'node:module'
import { before, beforeEach, after, test } from 'node:test'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { executeTeacherAwardService, teacherAwardPaths } from '../../functions/phase3/teacherAwardService.js'

const projectId = 'demo-morgan-bank-teacher-award'
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Use guarded teacher award command')
assert.equal(process.env.GCLOUD_PROJECT, projectId, 'Fictional emulator project only')
const { Firestore } = createRequire(new URL('../../functions/package.json', import.meta.url))('firebase-admin/firestore')
let db, env
const uid = 'owner-a', room = 'room-a', id = '00112233445566778899aabbccddeeff'
const time = '2026-09-29T18:00:00.000Z'
const paths = teacherAwardPaths(room, uid, id)
const request = (extra = {}) => ({ protocolVersion: 1, controlGeneration: 7, requestId: id,
  action: 'award', studentIds: [1], amountCents: 110, reason: 'Homework', category: 'Homework', memo: '', ...extra })
const run = (raw = request()) => executeTeacherAwardService(raw, { firestore: db, auth: { uid, token: { role: 'teacher' } }, projectId, now: () => time })
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080,
    rules: 'rules_version = "2"; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }' } })
  db = new Firestore({ projectId, databaseId: '(default)', host: '127.0.0.1:8080', ssl: false })
})
after(async () => { await db?.terminate(); await env?.cleanup() })
beforeEach(async () => {
  await env.clearFirestore()
  const batch = db.batch()
  batch.set(db.doc(`teachers/${uid}`), { uid, classroomId: room, status: 'active', createdAt: new Date() })
  batch.set(db.doc(`classrooms/${room}`), { ownerUid: uid, settings: { addMoneyCategories: ['Homework'], subtractMoneyCategories: ['Rent'] },
    accessControl: { schemaVersion: 1, mode: 'active', generation: 7, changedAt: time, auditId: 'audit-a' } })
  batch.set(db.doc(`classrooms/${room}/students/1`), { id: 1, name: 'Fictional', balance: 1.1, frozen: false, transactions: [] })
  batch.set(db.doc(paths.actor), { version: 1, actorUid: uid, unacknowledgedRequestId: null })
  batch.set(db.doc(paths.quota), { version: 1, count: 0 })
  await batch.commit()
})
test('SDK concurrent same-key requests save one award, one receipt and one ledger', async () => {
  const responses = await Promise.all([run(), run()])
  assert.deepEqual(responses[0], responses[1])
  const student = (await db.doc(`classrooms/${room}/students/1`).get()).data()
  assert.equal(student.balance, 2.2); assert.equal(student.transactions.length, 1)
  const ledgers = await db.collection(`classrooms/${room}/transactions`).get()
  assert.equal(ledgers.size, 1); assert.deepEqual(ledgers.docs[0].data(), student.transactions[0])
  assert.equal((await db.doc(paths.quota).get()).data().count, 1)
  assert.equal((await db.doc(paths.actor).get()).data().unacknowledgedRequestId, id)
  assert.equal((await db.collection(`classrooms/${room}/teacherMoneyReceipts`).get()).size, 1)
  // A response ignored by the caller is safely replayed through the actual SDK.
  assert.deepEqual(await run(), responses[0])
})
test('SDK distinct keys race on the same actor; losing request makes no money changes', async () => {
  const results = await Promise.allSettled([run(), run(request({ requestId: 'a'.repeat(32) }))])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'acknowledgment-required')
  assert.equal((await db.doc(`classrooms/${room}/students/1`).get()).data().balance, 2.2)
  assert.equal((await db.doc(paths.quota).get()).data().count, 1)
})
test('SDK invalid second target leaves first balance and all metadata untouched', async () => {
  await assert.rejects(run(request({ studentIds: [1, 2] })), error => error.code === 'missing-student')
  assert.equal((await db.doc(`classrooms/${room}/students/1`).get()).data().balance, 1.1)
  assert.equal((await db.doc(paths.quota).get()).data().count, 0)
  assert.equal((await db.doc(paths.actor).get()).data().unacknowledgedRequestId, null)
  assert.equal((await db.doc(paths.receipt).get()).exists, false)
  assert.equal((await db.collection(`classrooms/${room}/transactions`).get()).size, 0)
})
test('SDK readOnly mode prevents new writes while committed replay survives generation change', async () => {
  await run()
  await db.doc(`classrooms/${room}`).update({ 'accessControl.mode': 'readOnly', 'accessControl.generation': 8 })
  assert.equal((await run()).status, 'committed')
  await assert.rejects(run(request({ requestId: 'b'.repeat(32), controlGeneration: 8 })))
  await db.doc(`classrooms/${room}`).update({ 'accessControl.mode': 'suspended' })
  await assert.rejects(run())
})

test('SDK cancelled receipt fences a new action without touching money or quota', async () => {
  await db.doc(paths.receipt).create({ version: 1, actorUid: uid, requestId: id,
    generation: 7, status: 'cancelled', serverTime: time })
  await db.doc(paths.quota).update({ count: 1 })
  await assert.rejects(run(), error => error.code === 'request-cancelled')
  assert.equal((await db.doc(`classrooms/${room}/students/1`).get()).data().balance, 1.1)
  assert.equal((await db.doc(paths.quota).get()).data().count, 1)
  assert.equal((await db.collection(`classrooms/${room}/transactions`).get()).size, 0)
})

async function seedGroup(count, historyCount) {
  const ids = Array.from({ length: count }, (_, i) => i + 1), batch = db.batch()
  for (const n of ids) batch.set(db.doc(`classrooms/${room}/students/${n}`), {
    id: n, name: 'Fictional student', balance: 0, frozen: false,
    transactions: Array.from({ length: historyCount }, (_, j) => ({ id: j + 1, date: time,
      studentId: n, studentName: 'Fictional student', type: 'Add', amount: 1,
      reason: 'Homework', memo: '', category: 'Homework', status: 'Approved', source: 'Teacher' })),
  })
  await batch.commit()
  return ids
}
for (const [count, historyCount] of [[30, 50], [100, 0], [14, 200]]) {
  test(`SDK ${count} students with ${historyCount} history entries save once with compact receipt`, async () => {
    const ids = await seedGroup(count, historyCount), raw = request({ studentIds: ids })
    const results = await Promise.all([run(raw), run(raw)])
    assert.deepEqual(results[0], results[1]); assert.deepEqual(await run(raw), results[0])
    assert.equal(results[0].itemCount, count)
    const receipt = (await db.doc(paths.receipt).get()).data()
    assert.equal(receipt.version, 2); assert.ok(receipt.ledgerIds.startsWith('b36:1:'))
    const ledgers = await db.collection(`classrooms/${room}/transactions`).get()
    assert.equal(ledgers.size, count)
    for (const n of ids) {
      const student = (await db.doc(`classrooms/${room}/students/${n}`).get()).data()
      assert.equal(student.balance, 1.1); assert.equal(student.transactions.length, historyCount + 1)
      assert.deepEqual(ledgers.docs.find(d => d.data().studentId === n).data(), student.transactions[0])
    }
    assert.equal((await db.doc(paths.quota).get()).data().count, 1)
    assert.equal((await db.doc(paths.actor).get()).data().unacknowledgedRequestId, id)
  })
}
test('SDK history-heavy class refuses atomically without saving a prefix', async () => {
  const ids = await seedGroup(30, 200)
  const before = await db.getAll(...ids.map(n => db.doc(`classrooms/${room}/students/${n}`)))
  await assert.rejects(run(request({ studentIds: ids })), e => e.code === 'transaction-size-limit')
  const after = await db.getAll(...ids.map(n => db.doc(`classrooms/${room}/students/${n}`)))
  assert.deepEqual(after.map(s => s.data()), before.map(s => s.data()))
  assert.equal((await db.collection(`classrooms/${room}/transactions`).get()).size, 0)
  assert.equal((await db.doc(paths.receipt).get()).exists, false)
  assert.equal((await db.doc(paths.quota).get()).data().count, 0)
  assert.equal((await db.doc(paths.actor).get()).data().unacknowledgedRequestId, null)
})
