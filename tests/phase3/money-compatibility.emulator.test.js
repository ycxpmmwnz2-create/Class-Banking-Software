import assert from 'node:assert/strict'
import process from 'node:process'
import { createRequire } from 'node:module'
import { before, beforeEach, after, test } from 'node:test'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { MONEY_COMPATIBILITY_DEMO_PROJECT as projectId, scanMoneyCompatibilityRehearsal,
  estimateMoneyDocumentBytes } from '../../functions/phase3/moneyCompatibility.js'

assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Use the guarded money compatibility npm command')
const { Firestore } = createRequire(new URL('../../functions/package.json', import.meta.url))('firebase-admin/firestore')
let db, env
const clock = () => '2026-09-25T12:00:00.000Z'
const entry = (id = 1, extra = {}) => ({ id, studentId: 1, studentName: 'Fictional former name', date: 'historical local date',
  type: 'Add', amount: 1.1, status: 'Approved', source: 'Teacher', category: 'Homework', reason: 'Homework', memo: '', ...extra })
const student = (extra = {}) => ({ id: 1, name: 'Fictional current name', balance: 1.1, frozen: false, transactions: [entry()], ...extra })
const scan = (extra = {}) => scanMoneyCompatibilityRehearsal({ firestore: db, projectId, classroomIds: ['room-a'], clock, ...extra })
const codes = result => result.summary.reasonCounts
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080,
    rules: 'rules_version = "2"; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }' } })
  db = new Firestore({ projectId, databaseId: '(default)', host: '127.0.0.1:8080', ssl: false })
})
after(async () => { await db?.terminate(); await env?.cleanup() })
beforeEach(async () => {
  await env.clearFirestore()
  const batch = db.batch()
  batch.set(db.doc('classrooms/room-a'), { ownerUid: 'owner-a', settings: {} })
  batch.set(db.doc('teachers/owner-a'), { uid: 'owner-a', classroomId: 'room-a', status: 'active' })
  batch.set(db.doc('classrooms/room-a/students/1'), student())
  batch.set(db.doc('classrooms/room-a/transactions/1'), entry())
  await batch.commit()
})
async function setPair(value) {
  const batch = db.batch()
  batch.set(db.doc('classrooms/room-a/students/1'), student({ transactions: [value] }))
  batch.set(db.doc('classrooms/room-a/transactions/1'), value)
  await batch.commit()
}

test('actual SDK completes scan with identical document versions, historical names and no new collections', async () => {
  const paths = ['classrooms/room-a', 'teachers/owner-a', 'classrooms/room-a/students/1', 'classrooms/room-a/transactions/1']
  const beforeDocs = await db.getAll(...paths.map(path => db.doc(path)))
  const result = await scan()
  assert.equal(result.summary.blockerCount, 0); assert.equal(result.summary.studentCount, 1)
  assert.equal(result.restrictedManifest.activationAllowed, false)
  const afterDocs = await db.getAll(...paths.map(path => db.doc(path)))
  for (let n = 0; n < paths.length; n++) {
    assert.deepEqual(afterDocs[n].data(), beforeDocs[n].data())
    assert.ok(afterDocs[n].updateTime.isEqual(beforeDocs[n].updateTime))
  }
  assert.deepEqual((await db.listCollections()).map(ref => ref.id).sort(), ['classrooms', 'teachers'])
  assert.deepEqual((await db.doc('classrooms/room-a').listCollections()).map(ref => ref.id).sort(), ['students', 'transactions'])
})

test('real fractional balance and Pending data block, finite Approved/Denied historical amounts stay legacy-only unchanged', async () => {
  for (const status of ['Pending', 'Approved', 'Denied']) {
    await setPair(entry(1, { amount: 1.001, status }))
    const result = await scan()
    assert.equal(result.summary.blockerCount, status === 'Pending' ? 2 : 0)
    assert.equal(result.summary.legacyOnlyCount, status === 'Pending' ? 0 : 2)
    assert.equal((await db.doc('classrooms/room-a/transactions/1').get()).data().amount, 1.001)
  }
  await db.doc('classrooms/room-a/students/1').update({ balance: 1.001 })
  assert.equal(codes(await scan())['balance-out-of-domain'], 1)
})

test('SDK queries paginate both collections beyond 25 and bind every document version', async () => {
  const batch = db.batch()
  for (let n = 2; n <= 26; n++) {
    const value = entry(n, { studentId: n })
    batch.set(db.doc(`classrooms/room-a/students/${n}`), student({ id: n, transactions: [value] }))
    batch.set(db.doc(`classrooms/room-a/transactions/${n}`), value)
  }
  await batch.commit()
  const result = await scan()
  assert.equal(result.summary.studentCount, 26); assert.equal(result.summary.ledgerCount, 26)
  assert.equal(result.restrictedManifest.documents.length, 54); assert.equal(result.summary.blockerCount, 0)
})

test('real orphan mirror, reserved source and removed-student Pending are explicit blockers', async () => {
  await db.doc('classrooms/room-a/transactions/1').delete()
  assert.equal(codes(await scan())['mirror-ledger-mismatch'], 1)
  await setPair(entry(1, { source: 'Operator correction' }))
  assert.equal(codes(await scan())['reserved-source-category'], 2)
  await setPair(entry(1, { status: 'Pending' })); await db.doc('classrooms/room-a/students/1').delete()
  assert.equal(codes(await scan())['pending-student-absent'], 1)
})

test('phantom money parent with real descendants invalidates whole scan', async () => {
  await db.doc('classrooms/room-a/students/99/children/x').set({ fictional: true })
  await assert.rejects(scan(), error => error.category === 'changed-or-incomplete')
})

test('actual changed-and-restored balance after first read is detected by updateTime', async () => {
  const original = db.collection.bind(db)
  let queries = 0
  db.collection = path => {
    const ref = original(path)
    if (path !== 'classrooms/room-a/students') return ref
    const orderBy = ref.orderBy.bind(ref)
    ref.orderBy = (...args) => {
      const query = orderBy(...args), limit = query.limit.bind(query)
      query.limit = count => {
        const limited = limit(count), get = limited.get.bind(limited)
        limited.get = async () => {
          if (++queries === 2) {
            await db.doc(path + '/1').update({ balance: 9 })
            await db.doc(path + '/1').update({ balance: 1.1 })
          }
          return get()
        }
        return limited
      }
      return query
    }
    return ref
  }
  try { await assert.rejects(scan(), error => error.category === 'changed-since-scan') }
  finally { db.collection = original }
})

test('actual conservative size threshold neighbors are SDK-storable and block only insufficient headroom', async () => {
  const path = 'classrooms/room-a/students/1', data = student({ name: 'x', transactions: [] })
  await db.doc('classrooms/room-a/transactions/1').delete()
  const base = estimateMoneyDocumentBytes(path, data)
  data.name += 'x'.repeat((800 * 1024 - 1 - base) / 2)
  await db.doc(path).set(data)
  assert.equal(!!codes(await scan())['student-byte-headroom'], false)
  data.name += 'x'; await db.doc(path).set(data)
  assert.equal(codes(await scan())['student-byte-headroom'], 1)
})

test('900 and 901 real mirror entries preserve every entry and discriminate required slot headroom', async () => {
  for (const count of [900, 901]) {
    const values = Array.from({ length: count }, (_, n) => entry(n + 1, { memo: '', studentName: 'x', date: 'x', reason: '', category: '', source: 'Teacher' }))
    for (let offset = 0; offset < count; offset += 400) {
      const batch = db.batch()
      for (const value of values.slice(offset, offset + 400)) batch.set(db.doc(`classrooms/room-a/transactions/${value.id}`), value)
      await batch.commit()
    }
    await db.doc('classrooms/room-a/students/1').set(student({ transactions: values }))
    const result = await scan()
    assert.equal(!!codes(result)['mirror-slot-headroom'], count > 900)
    assert.equal(result.restrictedManifest.capacities[0].mirrorSlotsRemaining, 1000 - count)
    assert.equal((await db.doc('classrooms/room-a/students/1').get()).data().transactions.length, count)
  }
})


test('real required text rejects blank fields without repairing stored data', async () => {
  for (const field of ['date', 'studentName', 'source']) {
    for (const value of ['', ' ', '\t\n', '\u00a0']) {
      await setPair(entry(1, { [field]: value }))
      const ref = db.doc('classrooms/room-a/transactions/1'), before = await ref.get()
      const result = await scan()
      assert.equal(codes(result)['ledger-shape-or-id'], 1)
      assert.equal(codes(result)['mirror-shape-or-owner'], 1)
      const after = await ref.get(); assert.deepEqual(after.data(), before.data())
      assert.ok(after.updateTime.isEqual(before.updateTime))
    }
  }
  await setPair(entry())
  for (const name of ['', ' ', '\t\n', '\u00a0']) {
    await db.doc('classrooms/room-a/students/1').update({ name })
    assert.equal(codes(await scan())['student-shape-or-id'], 1)
  }
  await db.doc('classrooms/room-a/students/1').update({ name: ' Fictional ' })
  await setPair(entry(1, { studentName: ' Former name ', date: ' historical ', source: ' Teacher ', memo: '', reason: '', category: '' }))
  assert.equal((await scan()).summary.blockerCount, 0)
})

test('real settings container rejects non-map values and preserves null/missing defaults', async () => {
  const ref = db.doc('classrooms/room-a')
  for (const settings of ['x', '', 0, 1, true, false, [], ['Homework']]) {
    await ref.set({ ownerUid: 'owner-a', settings }); const before = await ref.get()
    const result = await scan()
    assert.equal(codes(result)['category-settings-shape'], 1)
    assert.ok((await ref.get()).updateTime.isEqual(before.updateTime))
  }
  for (const settings of [undefined, null, {}, { addMoneyCategories: ['Homework'] }]) {
    await ref.set({ ownerUid: 'owner-a', ...(settings === undefined ? {} : { settings }) })
    assert.equal((await scan()).summary.blockerCount, 0)
  }
})
