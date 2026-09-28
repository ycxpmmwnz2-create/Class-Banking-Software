// FICTIONAL data only. SDK writes below are test setup/drift injection; reader is GET-only.
import assert from 'node:assert/strict'
import process from 'node:process'
import { createRequire } from 'node:module'
import { mkdtemp, realpath, chmod, rm, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, beforeEach, after, test } from 'node:test'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { DEMO_PROJECT as projectId } from '../../functions/operator/protectedMoneyScan/common.js'
import { makeFixture } from '../../functions/operator/protectedMoneyScan/fixtures.js'
import { createLoopbackReader } from '../../functions/operator/protectedMoneyScan/loopbackReader.js'
import { createPrivatePublisher } from '../../functions/operator/protectedMoneyScan/reportStore.js'
import { runProtectedMoneyScan } from '../../functions/operator/protectedMoneyScan/runner.js'
import { runObservedMoneyScan } from '../../functions/operator/protectedMoneyScan/observedRunner.js'
import { makeMaintenanceFixture } from '../../functions/operator/protectedMoneyScan/maintenanceFixtures.js'

assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Use the guarded protected scan npm command')
const { Firestore, Timestamp } = createRequire(new URL('../../functions/package.json', import.meta.url))('firebase-admin/firestore')
const fixtureRules = 'rules_version = "2"; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read: if true; allow write: if false; } } }'
let db, env, f
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080, rules: fixtureRules } })
  db = new Firestore({ projectId, databaseId: '(default)', host: '127.0.0.1:8080', ssl: false })
})
after(async () => { await db?.terminate();await env?.cleanup() })
beforeEach(async () => {
  await env.clearFirestore();f = makeFixture()
  const batch = db.batch()
  for (const [path, row] of f.store) batch.set(db.doc(path), row.data)
  await batch.commit()
  f.dependencies.reader = createLoopbackReader(f.plan)
})
const scan = () => runProtectedMoneyScan(f.plan, f.dependencies)
test('maintenance observer composes with the real REST reader and private file store', async t => {
  const m = makeMaintenanceFixture()
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'fictional-observed-emulator-')))
  await chmod(directory, 0o700);t.after(() => rm(directory, { recursive: true, force: true }))
  m.observedDependencies.reader = createLoopbackReader(m.plan)
  m.observedDependencies.publisher = createPrivatePublisher(directory)
  const paths = [...m.store.keys()], before = await db.getAll(...paths.map(path => db.doc(path)))
  const result = await runObservedMoneyScan(m.plan, m.expectation, m.observedDependencies)
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(m.releaseCount, 1);assert.equal(m.leaseHeld(), false)
  const report = JSON.parse(await readFile(join(directory, m.plan.runId, 'report.json'), 'utf8'))
  assert.equal(report.artifactAccepted, false);assert.equal(report.productionEligible, false)
  const after = await db.getAll(...paths.map(path => db.doc(path)))
  before.forEach((doc, n) => { assert.deepEqual(after[n].data(), doc.data());assert.ok(after[n].updateTime.isEqual(doc.updateTime)) })
})
test('unresolved writer evidence prevents every real-reader request', async () => {
  const m = makeMaintenanceFixture(), reader = createLoopbackReader(m.plan)
  let requests = 0
  m.observedDependencies.reader = { ...reader,
    get(...args) { requests++;return reader.get(...args) },
    listPage(...args) { requests++;return reader.listPage(...args) },
  }
  m.maintenance.writers[0].inFlight = 1
  const result = await runObservedMoneyScan(m.plan, m.expectation, m.observedDependencies)
  assert.equal(result.category, 'continuity');assert.equal(requests, 0);assert.equal(m.published.length, 0)
})
test('maintenance loss after real file publication returns unconfirmed and preserves the private artifact', async t => {
  const m = makeMaintenanceFixture()
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'fictional-observed-loss-')))
  await chmod(directory, 0o700);t.after(() => rm(directory, { recursive: true, force: true }))
  const publisher = createPrivatePublisher(directory)
  m.observedDependencies.reader = createLoopbackReader(m.plan)
  m.observedDependencies.publisher = { async publish(value) {
    const receipt = await publisher.publish(value);m.platformChange('revisions');return receipt
  } }
  const result = await runObservedMoneyScan(m.plan, m.expectation, m.observedDependencies)
  assert.equal(result.status, 'aborted');assert.equal(result.publication, 'unconfirmed')
  const report = JSON.parse(await readFile(join(directory, m.plan.runId, 'report.json'), 'utf8'))
  assert.equal(report.artifactAccepted, false);assert.equal(m.leaseHeld(), false)
})
test('actual paginated REST read and private publication leave all source versions/data unchanged', async t => {
  const batch = db.batch()
  for (let id = 2; id <= 27; id++) batch.set(db.doc(`classrooms/canary/students/${id}`), { id, name: 'Fictional', balance: 2, frozen: false, transactions: [] })
  batch.set(db.doc('classrooms/canary/studentDisplay/rent'), { rentAmount: 2, updatedAt: Timestamp.fromMillis(1790500000000) })
  await batch.commit()
  const paths = [...f.store.keys(), ...Array.from({ length: 26 }, (_, n) => `classrooms/canary/students/${n + 2}`), 'classrooms/canary/studentDisplay/rent']
  const initial = await db.getAll(...paths.map(path => db.doc(path)))
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'fictional-scan-emulator-')))
  await chmod(directory, 0o700);t.after(() => rm(directory, { recursive: true, force: true }))
  f.dependencies.publisher = createPrivatePublisher(directory)
  const result = await scan()
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(result.studentCount, 28)
  const report = JSON.parse(await readFile(join(directory, f.plan.runId, 'report.json'), 'utf8'))
  assert.equal(report.versions.length, 34)
  assert.equal(report.versions.find(v => v.path === 'classrooms/room-b/studentDisplay/rent').exists, false)
  assert.equal(JSON.stringify(report).includes('FICTIONAL_PRIVATE'), false)
  const final = await db.getAll(...paths.map(path => db.doc(path)))
  initial.forEach((doc, index) => {
    assert.deepEqual(final[index].data(), doc.data());assert.ok(final[index].updateTime.isEqual(doc.updateTime))
  })
})
test('REST showMissing discovers witness-only classroom and orphan student parents before publication', async () => {
  await db.doc('classrooms/phantom/balanceHistory/fictional').set({ fictional: true })
  assert.equal((await scan()).category, 'foundation')
  assert.equal(f.published.length, 0)
  await db.doc('classrooms/phantom/balanceHistory/fictional').delete()
  await db.doc('classrooms/canary/students/99/children/fictional').set({ fictional: true })
  assert.equal((await scan()).category, 'foundation')
  assert.equal(f.published.length, 0)
})
test('real edit/restore and new rent during version recheck abort without publication', async () => {
  const reader = f.dependencies.reader
  let injected = false
  f.dependencies.reader = { ...reader, async get(path, mask) {
    if (!injected && mask?.length === 0) {
      injected = true
      await db.doc('classrooms/canary/students/1').update({ balance: 8 })
      await db.doc('classrooms/canary/students/1').update({ balance: 1.1 })
      await db.doc('classrooms/room-b/studentDisplay/rent').set({ rentAmount: 0, updatedAt: 'fictional' })
    }
    return reader.get(path, mask)
  } }
  assert.equal((await scan()).category, 'drift');assert.equal(f.published.length, 0)
})
test('reader rejects foreign paths, credential reads and production construction before HTTP', async () => {
  const reader = f.dependencies.reader
  for (const path of ['classrooms/foreign', 'classrooms/canary/studentCredentials/private', 'teachers/foreign']) {
    await assert.rejects(reader.get(path, null), e => e.category === 'scope')
  }
  await assert.rejects(reader.get('teachers/fictional-owner-a', null), e => e.category === 'scope')
  assert.throws(() => createLoopbackReader({ ...f.plan, projectId: 'morgan-bank' }), e => e.category === 'live-unavailable')
})
test('each canary denial has the identical successful write under exact prior rules, then unchanged denial under maintenance rules', async () => {
  // Local baseline only: no inference about deployed rules, Admin IAM or a live fence.
  const probes = [
    ['', 'update', { settings: { theme: 'fictional' } }],
    ['/students/1', 'update', { balance: 2 }],
    ['/students/1', 'update', { name: 'Fictional changed', frozen: true }],
    ['/transactions/99', 'set', { id: 99, date: 'fictional', studentId: 1, studentName: 'Fictional', type: 'Add', amount: 1, reason: '', memo: '', category: '', status: 'Pending', source: 'Teacher' }],
    ['/studentDisplay/rent', 'set', { rentAmount: 2, updatedAt: 'fictional' }],
  ]
  for (const room of f.plan.rooms) {
    const path = `classrooms/${room.classroomId}`
    f.store.get(path).data = { ownerUid: room.ownerUid, name: 'Fictional', version: 1, settings: {}, lastBackupAt: null, updatedAt: 'original' }
    await db.doc(path).set(f.store.get(path).data)
  }
  const baseline = new Map([...f.store].map(([path, row]) => [path, row.data]))
  for (const [suffix, method, body] of probes) {
    const path = 'classrooms/canary' + suffix
    let priorEnv = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.phase3.final.rules', 'utf8') } })
    try {
      // Invalid auth/schema must fail the success control, not count as fence evidence.
      await assert.rejects(assertSucceeds(priorEnv.authenticatedContext('foreign-owner').firestore().doc(path)[method](body)))
      await assert.rejects(assertSucceeds(priorEnv.authenticatedContext('fictional-owner-a').firestore().doc('classrooms/canary/students/1').update({ balance: 'invalid' })))
      await assertSucceeds(priorEnv.authenticatedContext('fictional-owner-a').firestore().doc(path)[method](body))
    }
    finally { await priorEnv.cleanup() }
    if (baseline.has(path)) await db.doc(path).set(baseline.get(path));else await db.doc(path).delete()
    const prior = await db.doc(path).get()
    priorEnv = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.phase3.maintenance.rules', 'utf8') } })
    try { await assertFails(priorEnv.authenticatedContext('fictional-owner-a').firestore().doc(path)[method](body)) }
    finally { await priorEnv.cleanup() }
    const final = await db.doc(path).get()
    assert.deepEqual(final.data(), prior.data())
    if (prior.exists) assert.ok(final.updateTime.isEqual(prior.updateTime))
    else assert.equal(final.exists, false)
  }
})
