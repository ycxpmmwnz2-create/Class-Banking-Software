/**
 * Real Auth + Functions + Firestore emulator acceptance for Checkpoint A.
 * Run only through `npm run test:version3:gemini-callable:emulator`.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { initializeApp as initializeClientApp, deleteApp } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions'

const PROJECT_ID = 'demo-morgan-bank-version3-gemini-callable-browser'

function loopback(value) {
  return /^(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(value ?? '')
}

assert.equal(process.env.VERSION3_GEMINI_CALLABLE_TEST, 'true')
assert.equal(process.env.GCLOUD_PROJECT, PROJECT_ID)
assert.ok(loopback(process.env.FIRESTORE_EMULATOR_HOST))
assert.ok(loopback(process.env.FIREBASE_AUTH_EMULATOR_HOST))
assert.ok(loopback(process.env.FUNCTIONS_EMULATOR_HOST))
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined)

const repositoryRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const functionsRequire = createRequire(path.join(repositoryRoot, 'functions/package.json'))
const admin = functionsRequire('firebase-admin')
const adminApp = admin.initializeApp({ projectId: PROJECT_ID }, `version3-callable-${process.pid}`)
const firestore = admin.firestore(adminApp)

const clientApp = initializeClientApp({
  apiKey: 'synthetic-emulator-key',
  authDomain: `${PROJECT_ID}.firebaseapp.com`,
  projectId: PROJECT_ID,
}, `version3-callable-client-${process.pid}`)
const auth = getAuth(clientApp)
const [authHost, authPort] = process.env.FIREBASE_AUTH_EMULATOR_HOST.split(':')
connectAuthEmulator(auth, `http://${authHost}:${authPort}`, { disableWarnings: true })
const callableFunctions = getFunctions(clientApp, 'us-central1')
const [functionsHost, functionsPort] = process.env.FUNCTIONS_EMULATOR_HOST.split(':')
connectFunctionsEmulator(callableFunctions, functionsHost, Number(functionsPort))
const analyze = httpsCallable(callableFunctions, 'analyzeTeacherInsightsV3')

const credentials = Object.freeze({
  a: { email: 'teacher-a@example.test', password: 'Synthetic!Password1' },
  b: { email: 'teacher-b@example.test', password: 'Synthetic!Password2' },
})
const identities = {}

function storedTransaction({ id, studentId, studentName, amount, reason }) {
  return {
    id,
    date: new Date(Date.now() - 60_000).toISOString(),
    studentId,
    studentName,
    type: 'Add',
    amount,
    reason,
    memo: '',
    category: '',
    status: 'Pending',
    source: 'Student',
  }
}

async function seedTeacher(uid, classroomId, studentName, transactionReason, offset) {
  const batch = firestore.batch()
  batch.set(firestore.doc(`teachers/${uid}`), {
    uid,
    status: 'active',
    classroomId,
    displayName: 'Synthetic Teacher',
  })
  batch.set(firestore.doc(`classrooms/${classroomId}`), { ownerUid: uid, version: 1 })
  batch.set(firestore.doc(`classrooms/${classroomId}/students/${offset}`), {
    id: offset,
    name: studentName,
    balance: 45,
    frozen: false,
    transactions: [],
  })
  batch.set(
    firestore.doc(`classrooms/${classroomId}/transactions/${offset + 100}`),
    storedTransaction({
      id: offset + 100,
      studentId: offset,
      studentName,
      amount: 25,
      reason: transactionReason,
    }),
  )
  await batch.commit()
}

before(async () => {
  identities.a = (await createUserWithEmailAndPassword(
    auth,
    credentials.a.email,
    credentials.a.password,
  )).user.uid
  await signOut(auth)
  identities.b = (await createUserWithEmailAndPassword(
    auth,
    credentials.b.email,
    credentials.b.password,
  )).user.uid
  await signOut(auth)
  await seedTeacher(identities.a, 'class-callable-a', 'Jordan Reyes', 'Robotics reward', 1)
  await seedTeacher(identities.b, 'class-callable-b', 'Blaise Example', 'Library helper reward', 7)
})

beforeEach(async () => {
  for (const collectionName of [
    'insightUsageLedgers',
    'insightUsageRateLimits',
    'insightUsageReservations',
  ]) {
    const snapshot = await firestore.collection(collectionName).get()
    if (snapshot.empty) continue
    const batch = firestore.batch()
    for (const document of snapshot.docs) batch.delete(document.ref)
    await batch.commit()
  }
})

after(async () => {
  await signOut(auth).catch(() => {})
  await deleteApp(clientApp)
  await adminApp.delete()
})

function request(requestId) {
  return { requestId, mode: 'quick', periodDays: 30 }
}

test('callable requires Auth and returns only the caller tenant display facts', async () => {
  await assert.rejects(
    analyze(request('request_unauth_001')),
    error => String(error?.code).includes('unauthenticated'),
  )

  await signInWithEmailAndPassword(auth, credentials.a.email, credentials.a.password)
  const first = (await analyze(request('request_callable_a1'))).data
  assert.match(JSON.stringify(first.observations), /Jordan Reyes|Robotics reward/)
  assert.doesNotMatch(JSON.stringify(first), /Blaise Example|Library helper reward/)
  assert.deepEqual(Object.keys(first).sort(), [
    'generatedAt',
    'groups',
    'mode',
    'observations',
    'orderedObservationIds',
    'periodDays',
    'schemaVersion',
    'source',
    'teacherQuestions',
    'usage',
  ])

  const replay = (await analyze(request('request_callable_a1'))).data
  assert.deepEqual(replay, first)

  await signOut(auth)
  await signInWithEmailAndPassword(auth, credentials.b.email, credentials.b.password)
  const tenantB = (await analyze(request('request_callable_b1'))).data
  assert.match(JSON.stringify(tenantB.observations), /Blaise Example|Library helper reward/)
  assert.doesNotMatch(JSON.stringify(tenantB), /Jordan Reyes|Robotics reward/)
})

test('replay is not charged twice and stored artifacts contain no display facts', async () => {
  await signOut(auth)
  await signInWithEmailAndPassword(auth, credentials.a.email, credentials.a.password)
  const first = (await analyze(request('request_callable_a2'))).data
  const replay = (await analyze(request('request_callable_a2'))).data
  assert.deepEqual(replay, first)
  await analyze(request('request_callable_a3'))
  await assert.rejects(
    analyze(request('request_callable_a4')),
    error => String(error?.code).includes('resource-exhausted'),
  )

  const [ledgers, rateLimits, reservations] = await Promise.all([
    firestore.collection('insightUsageLedgers').get(),
    firestore.collection('insightUsageRateLimits').get(),
    firestore.collection('insightUsageReservations').get(),
  ])
  const stored = JSON.stringify([
    ...ledgers.docs.map(document => document.data()),
    ...rateLimits.docs.map(document => document.data()),
    ...reservations.docs.map(document => document.data()),
  ])
  for (const forbidden of [
    identities.a,
    identities.b,
    'class-callable-a',
    'class-callable-b',
    'Jordan Reyes',
    'Blaise Example',
    'Robotics reward',
    'Library helper reward',
  ]) {
    assert.doesNotMatch(stored, new RegExp(forbidden, 'i'))
  }
  assert.doesNotMatch(stored, /"observations"/)
  assert.match(stored, /"evidenceSignature":"[a-f0-9]{64}"/)
})
