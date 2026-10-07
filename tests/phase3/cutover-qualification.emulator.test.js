import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import process from 'node:process'
import { before, beforeEach, after, test } from 'node:test'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { createQualificationReader } from '../../functions/operator/cutoverQualification/reader.js'
import { inventoryClassrooms, reportProviderClaims } from '../../functions/operator/cutoverQualification/reports.js'
import { DEMO_PROJECT as projectId, hash } from '../../functions/operator/cutoverQualification/common.js'

assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Use test:phase3:qualification')
const { Firestore } = createRequire(new URL('../../functions/package.json', import.meta.url))('firebase-admin/firestore')
let db, env
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080,
    rules: "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }" } })
  db = new Firestore({ projectId, databaseId: '(default)', host: '127.0.0.1:8080', ssl: false })
})
beforeEach(async () => { await env.clearFirestore() })
after(async () => { await db?.terminate(); await env?.cleanup() })
const readerFor = profile => createQualificationReader({ projectId, profile })
async function rooms(n = 26) {
  const batch = db.batch()
  for (let i = 0; i < n; i++) {
    const classroomId = `room-${String(i).padStart(3, '0')}`, uid = `owner-${i}`
    batch.set(db.doc(`classrooms/${classroomId}`), { ownerUid: uid, classroomId, settings: { private: 'PRIVATE ROOT SENTINEL' } })
    batch.set(db.doc(`teachers/${uid}`), { uid, classroomId, status: 'active', email: 'PRIVATE TEACHER SENTINEL' })
  }
  await batch.commit()
}
function reservation(n, monthKey, schemaVersion = 4, status = 'reserved') {
  const scopeDigest = hash('fictional-scope'), requestIdDigest = hash(`fictional-request-${n}`), rateLimitLedgerId = hash(`${scopeDigest}\0${monthKey}`)
  const id = hash(`${rateLimitLedgerId}\0${requestIdDigest}`)
  return { id, data: { schemaVersion, scopeDigest, requestIdDigest, rateLimitLedgerId, ledgerId: hash(`application\0${monthKey}`),
    monthKey, status, reservedAtMs: 1000, ...(schemaVersion === 4 ? { controlGeneration: 1 } : {}),
    result: 'PRIVATE ANSWER SENTINEL', actualCostMicroUsd: 101 } }
}
function claim(parent, index, status = 'claimed') {
  return { schemaVersion: 1, reservationId: parent.id, requestIdDigest: parent.data.requestIdDigest,
    scopeDigest: parent.data.scopeDigest, controlGeneration: 1, dispatchIndex: index, status,
    claimedAtMs: 2000 + index, finishedAtMs: status === 'finished' ? 3000 + index : null,
    outcome: status === 'finished' ? 'returned' : status === 'uncertain' ? 'failed' : null }
}

test('masked GET excludes private fields, but emulator showMissing ignores masks and qualification refuses', async () => {
  await rooms()
  const reader = readerFor('inventory'), root = await db.doc('classrooms/room-000').get(), teacher = await db.doc('teachers/owner-0').get()
  assert.deepEqual(Object.keys((await reader.get(root.ref.path)).data).sort(), ['classroomId', 'ownerUid'])
  assert.deepEqual(Object.keys((await reader.get(teacher.ref.path)).data).sort(), ['classroomId', 'status', 'uid'])
  await assert.rejects(reader.listPage('classrooms'), { category: 'transport' })
  const result = await inventoryClassrooms({ projectId, reader })
  assert.equal(result.completion, 'UNKNOWN'); assert.equal(result.counts, null)
  assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  assert.ok((await root.ref.get()).updateTime.isEqual(root.updateTime))
  assert.ok((await teacher.ref.get()).updateTime.isEqual(teacher.updateTime))
  assert.equal(result.productionEligible, false)
})

test('missing parents with only balance history descendants block full inventory', async () => {
  await db.doc('classrooms/orphan/balanceHistory/witness').set({ fixture: true })
  const result = await inventoryClassrooms({ projectId, reader: readerFor('inventory') })
  assert.equal(result.coverage, 'UNKNOWN'); assert.equal(result.category, 'foundation'); assert.equal(result.counts, null)
})

test('metadata-only fictional records exercise real pagination and phantom parents; this is not mask qualification', async () => {
  const batch = db.batch(), parents = []
  for (let i = 0; i < 26; i++) {
    const parent = reservation(i, i % 2 ? '2026-10' : '2024-01', i === 0 ? 3 : 4)
    delete parent.data.result; delete parent.data.actualCostMicroUsd
    parents.push(parent); batch.set(db.doc(`insightUsageReservations/${parent.id}`), parent.data)
    if (i > 0) batch.set(db.doc(`insightUsageReservations/${parent.id}/dispatches/1`), claim(parent, 1, i === 1 ? 'uncertain' : 'claimed'))
  }
  const orphan = reservation(100, '2025-02')
  batch.set(db.doc(`insightUsageReservations/${orphan.id}/dispatches/1`), claim(orphan, 1))
  await batch.commit()
  const reader = readerFor('provider-claims'), ref = db.doc(`insightUsageReservations/${parents[1].id}`), before = await ref.get()
  const page = await reader.listPage('insightUsageReservations')
  assert.equal(page.documents.length, 25); assert.ok(page.nextPageToken)
  assert.ok(!JSON.stringify(page).includes('PRIVATE')); assert.ok(!JSON.stringify(page).includes('actualCostMicroUsd'))
  const result = await reportProviderClaims({ projectId, reader })
  assert.equal(result.coverage, 'COMPLETE'); assert.equal(result.counts.reservations, 27)
  assert.equal(result.counts.dispatches, 26); assert.equal(result.counts.claimed, 24)
  assert.equal(result.counts.uncertainDispatches, 1); assert.equal(result.counts.orphanParents, 1)
  assert.equal(result.counts.legacyWithoutDispatch, 1); assert.equal(result.providerDrain, 'UNKNOWN')
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok((await ref.get()).updateTime.isEqual(before.updateTime))
})

test('changed then restored reservation is rejected by version revalidation', async () => {
  const parent = reservation(1, '2026-10'), ref = db.doc(`insightUsageReservations/${parent.id}`)
  delete parent.data.result; delete parent.data.actualCostMicroUsd
  await ref.set(parent.data)
  const reader = readerFor('provider-claims'); let enumerations = 0
  const wrapped = { ...reader, async listPage(path, token) {
    if (path === 'insightUsageReservations' && ++enumerations === 2) {
      await ref.update({ fixtureChange: true }); await ref.set(parent.data)
    }
    return reader.listPage(path, token)
  } }
  const result = await reportProviderClaims({ projectId, reader: wrapped })
  assert.equal(result.category, 'drift'); assert.equal(result.counts, null)
})

test('reader rejects cross-profile, credentials, money and encoded foreign paths before HTTP', async () => {
  const inventory = readerFor('inventory'), provider = readerFor('provider-claims')
  for (const path of ['studentCredentials/secret', 'classrooms/room-000/students', 'classrooms/a%2Fb', 'insightUsageReservations']) {
    await assert.rejects(inventory.get(path), { category: 'scope' })
  }
  await assert.rejects(provider.listPage('classrooms'), { category: 'scope' })
  await assert.rejects(provider.get('teachers/owner'), { category: 'scope' })
  await assert.rejects(provider.listPage('insightUsageReservations/../dispatches'), { category: 'scope' })
})

// This is a regression for a discovered emulator limitation, not a passing privacy claim.
test('unmasked provider answer from emulator is rejected without report publication', async () => {
  const parent = reservation(1, '2026-10')
  await db.doc(`insightUsageReservations/${parent.id}`).set(parent.data)
  const result = await reportProviderClaims({ projectId, reader: readerFor('provider-claims') })
  assert.equal(result.completion, 'UNKNOWN'); assert.equal(result.counts, null)
  assert.equal(result.category, 'transport'); assert.ok(!JSON.stringify(result).includes('PRIVATE'))
})
