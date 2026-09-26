import assert from 'node:assert/strict'
import process from 'node:process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { before, beforeEach, after, test } from 'node:test'
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing'
import { INITIALIZATION_DEMO_PROJECT as projectId, planClassroomInitializationRehearsal,
  initializeClassroomControlsRehearsal } from '../../functions/phase3/classroomInitialization.js'

assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Use npm run test:phase3:classroom-initialization')
const { Firestore } = createRequire(new URL('../../functions/package.json', import.meta.url))('firebase-admin/firestore')
const operationId = '00112233445566778899aabbccddeeff'
const clock = () => '2026-09-25T12:00:00.000Z'
const createDb = () => new Firestore({ projectId, databaseId: '(default)', host: '127.0.0.1:8080', ssl: false })
let db, env
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: {
    host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.phase3.maintenance.rules', 'utf8'),
  } })
  db = createDb()
})
after(async () => { await db?.terminate(); await env?.cleanup() })
async function seed(count = 2) {
  const batch = db.batch()
  for (let i = 0; i < count; i++) {
    const room = `class-${String(i).padStart(3, '0')}`
    batch.set(db.doc(`teachers/owner-${i}`), { uid: `owner-${i}`, classroomId: room, status: 'active', name: 'Fictional' })
    batch.set(db.doc(`classrooms/${room}`), { ownerUid: `owner-${i}`, settings: { marker: room }, updatedAt: 'original', lastBackupAt: null })
    // Intentionally incompatible money data: this foundation-only rehearsal
    // preserves it and NEVER issues a compatibility pass or activation permit.
    batch.set(db.doc(`classrooms/${room}/students/1`), { name: 'Fictional', balance: 1.001 })
  }
  await batch.commit()
}
beforeEach(async () => { await env.clearFirestore(); await seed() })
const plan = () => planClassroomInitializationRehearsal({ firestore: db, projectId, operationId, clock })
const execute = (p, firestore = db) => initializeClassroomControlsRehearsal({ firestore, projectId, plan: p })
const category = expected => error => error.category === expected

test('real SDK read-only plan, atomic control/audit/journal, preservation and zero-write replay', async () => {
  const rootRef = db.doc('classrooms/class-000'), studentRef = rootRef.collection('students').doc('1')
  const rootBefore = await rootRef.get(), studentBefore = await studentRef.get()
  const p = await plan()
  assert.equal((await db.collection('classroomInitializationRuns').get()).size, 0)
  assert.ok((await rootRef.get()).updateTime.isEqual(rootBefore.updateTime))
  const result = await execute(p)
  assert.equal(result.completedCount, 2); assert.equal(result.activationAllowed, false); assert.equal(result.productionEligible, false)
  const root = await rootRef.get(), audit = await rootRef.collection('accessControlAudits').doc(operationId).get()
  assert.deepEqual(root.data(), { ...rootBefore.data(), accessControl: {
    schemaVersion: 1, mode: 'readOnly', generation: 1, changedAt: clock(), auditId: operationId,
  } })
  assert.ok(root.updateTime.isEqual(audit.updateTime))
  assert.ok((await studentRef.get()).updateTime.isEqual(studentBefore.updateTime))
  const runRef = db.doc(`classroomInitializationRuns/${operationId}`), run = await runRef.get()
  await execute(JSON.parse(JSON.stringify(p)))
  assert.ok((await rootRef.get()).updateTime.isEqual(root.updateTime))
  assert.ok((await runRef.get()).updateTime.isEqual(run.updateTime))
  // New journal and witness paths remain unavailable to an otherwise-valid owner.
  const client = env.authenticatedContext('owner-0').firestore()
  await assertFails(client.doc(runRef.path).get())
  await assertFails(client.doc(audit.ref.path).get())
  await assertFails(client.doc(rootRef.path).update({ settings: {} }))
})

test('lost committed response resumes from saved JSON using a fresh SDK handle', async () => {
  const p = await plan(), original = db.runTransaction.bind(db)
  let calls = 0
  db.runTransaction = async (...args) => {
    const result = await original(...args)
    if (++calls === 2) throw new Error('simulated lost response after first room commit')
    return result
  }
  try { await assert.rejects(execute(p), category('rehearsal-failed')) } finally { db.runTransaction = original }
  const first = await db.doc('classrooms/class-000').get()
  assert.equal((await db.doc('classrooms/class-001').get()).data().accessControl, undefined)
  assert.equal((await db.doc(`classroomInitializationRuns/${operationId}`).get()).data().completedCount, 1)
  const restarted = createDb()
  try { assert.equal((await execute(JSON.parse(JSON.stringify(p)), restarted)).completedCount, 2) }
  finally { await restarted.terminate() }
  assert.ok((await db.doc('classrooms/class-000').get()).updateTime.isEqual(first.updateTime))
})

test('concurrent same-operation attempts either complete or report contention, then replay safely', async () => {
  const p = await plan()
  const outcomes = await Promise.allSettled([execute(p), execute(p)])
  assert.ok(outcomes.every(result => result.status === 'fulfilled' || result.reason.category === 'retryable-conflict'), JSON.stringify(outcomes))
  for (const result of outcomes.filter(result => result.status === 'fulfilled')) {
    assert.equal(result.value.completedCount, 2); assert.equal(result.value.activationAllowed, false)
  }
  // Firestore retries are bounded; ABORTED under lock contention is an honest
  // stop. Explicit same-plan replay must converge without duplicate writes.
  assert.equal((await execute(JSON.parse(JSON.stringify(p)))).completedCount, 2)
  assert.equal((await db.doc(`classroomInitializationRuns/${operationId}`).get()).data().completedCount, 2)
  for (const row of p.rows) {
    const root = await db.doc(`classrooms/${row.classroomId}`).get()
    assert.equal(root.data().accessControl.generation, 1)
    assert.equal((await root.ref.collection('accessControlAudits').get()).size, 1)
  }
})

test('changed later-room version after journal creation stops before any classroom mutation', async () => {
  const p = await plan(), original = db.runTransaction.bind(db)
  let calls = 0
  db.runTransaction = async (...args) => {
    const result = await original(...args)
    if (++calls === 1) await db.doc('classrooms/class-001').update({ updatedAt: 'changed' })
    return result
  }
  try { await assert.rejects(execute(p), category('version-conflict')) } finally { db.runTransaction = original }
  assert.equal((await db.doc(`classroomInitializationRuns/${operationId}`).get()).data().completedCount, 0)
  for (const row of p.rows) assert.equal((await db.doc(`classrooms/${row.classroomId}`).get()).data().accessControl, undefined)
})

test('phantom parents and newly introduced classrooms are not silently omitted', async () => {
  const p = await plan()
  await db.doc('classrooms/orphan/students/1').set({ name: 'Fictional orphan' })
  await assert.rejects(plan(), category('inventory-incomplete'))
  await assert.rejects(execute(p), category('inventory-incomplete'))
  assert.equal((await db.collection('classroomInitializationRuns').get()).size, 0)
})

test('real query pagination includes every existing root and detects existing controls', async () => {
  await env.clearFirestore(); await seed(26)
  assert.equal((await plan()).rows.length, 26)
  await db.doc('classrooms/class-025').update({ accessControl: { mode: 'active', generation: 12 } })
  await assert.rejects(plan(), category('existing-control'))
  assert.equal((await db.collection('classroomInitializationRuns').get()).size, 0)
})

test('changed then restored initialized root or audit rejects replay by update version', async () => {
  for (const path of ['classrooms/class-000', `classrooms/class-000/accessControlAudits/${operationId}`]) {
    await env.clearFirestore(); await seed()
    const p = await plan(); await execute(p)
    const doc = db.doc(path), prior = await doc.get()
    // A no-op set can retain updateTime. Cause a real change, then restore the
    // original bytes: the final values match but the database version has moved.
    await doc.update({ rehearsalDrift: true })
    await doc.set(prior.data())
    assert.ok(!(await doc.get()).updateTime.isEqual(prior.updateTime))
    await assert.rejects(execute(p), category('version-conflict'))
  }
})


test('failure after staging all three writes commits none and resumes without a partial room', async () => {
  const p = await plan(), original = db.runTransaction.bind(db)
  let attempts = 0
  db.runTransaction = (callback, options) => original(async transaction => {
    const result = await callback(transaction)
    if (++attempts === 2) throw new Error('simulated abort after room writes were staged')
    return result
  }, options)
  try { await assert.rejects(execute(p), category('rehearsal-failed')) } finally { db.runTransaction = original }
  assert.equal((await db.doc(`classroomInitializationRuns/${operationId}`).get()).data().completedCount, 0)
  for (const row of p.rows) {
    const root = await db.doc(`classrooms/${row.classroomId}`).get()
    assert.equal(root.data().accessControl, undefined)
    assert.equal((await root.ref.collection('accessControlAudits').get()).size, 0)
  }
  assert.equal((await execute(p)).completedCount, 2)
})


test('retained audit history blocks resetting a missing control under a new operation', async () => {
  const p = await plan()
  await db.doc('classrooms/class-001/accessControlAudits/onboarding').set({ generation: 9 })
  await assert.rejects(plan(), category('journal-conflict'))
  await assert.rejects(execute(p), category('journal-conflict'))
  assert.equal((await db.collection('classroomInitializationRuns').get()).size, 0)
})
