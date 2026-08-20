/**
 * Version 3 emulator-only Gemini bridge acceptance.
 *
 * Run only through `npm run test:version3:gemini-bridge:emulator`. The wrapper
 * refuses local ADC, scrubs all routing/credential variables, starts only the
 * Firestore emulator for an explicit demo project, and then runs this file.
 * This suite calls the dormant service directly with a fake provider. It does
 * not start the Functions emulator, export a callable, contact Gemini, or
 * exercise staging/production.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createInsightAnalysisService, InsightAnalysisServiceError } from '../../../functions/insights/analysisService.js'
import { buildFactPacketFromEvidence } from '../../../functions/insights/factPacketBuilder.js'
import {
  FirestoreUsageLedgerError,
  createFirestoreUsageLedger,
} from '../../../functions/insights/firestoreUsageLedger.js'
import { createFirestoreTenantEvidenceLoader } from '../../../functions/insights/tenantEvidenceAdapter.js'
import { resolveActiveTeacherTenant } from '../../../functions/phase2b/teacherTenantResolver.js'
import { buildClassInsightsReport } from '../../../src/insights/classInsights.js'

const PROJECT_ID = 'demo-morgan-bank-version3-gemini-bridge'
const NOW = new Date('2026-08-16T18:00:00.000Z')
const NOW_MS = NOW.getTime()
const TEACHER_A = 'teacher-a-version3'
const TEACHER_B = 'teacher-b-version3'
const CLASS_A = 'class-a-version3'
const CLASS_B = 'class-b-version3'

function isLoopbackHostPort(value) {
  if (typeof value !== 'string') return false
  const match = /^(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/.exec(value)
  return Boolean(match && Number(match[2]) <= 65535)
}

assert.equal(process.env.VERSION3_GEMINI_EMULATOR_TEST, 'true')
assert.ok(isLoopbackHostPort(process.env.FIRESTORE_EMULATOR_HOST))
assert.equal(process.env.GCLOUD_PROJECT, PROJECT_ID)
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined)
assert.ok(PROJECT_ID.startsWith('demo-'))

const repositoryRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const functionsRequire = createRequire(path.join(repositoryRoot, 'functions/package.json'))
const admin = functionsRequire('firebase-admin')
const app = admin.initializeApp({ projectId: PROJECT_ID }, `version3-gemini-${process.pid}`)
const firestore = admin.firestore(app)

function storedTransaction({
  id,
  studentId,
  studentName,
  date,
  type = 'Add',
  amount,
  reason,
  status = 'Approved',
  source = 'Teacher',
}) {
  return {
    id,
    date,
    studentId,
    studentName,
    type,
    amount,
    reason,
    memo: '',
    category: '',
    status,
    source,
  }
}

async function seedSyntheticClassrooms() {
  const batch = firestore.batch()
  batch.set(firestore.doc(`teachers/${TEACHER_A}`), {
    uid: TEACHER_A,
    status: 'active',
    classroomId: CLASS_A,
    displayName: 'Synthetic Teacher A',
  })
  batch.set(firestore.doc(`classrooms/${CLASS_A}`), { ownerUid: TEACHER_A, version: 1 })
  batch.set(firestore.doc(`classrooms/${CLASS_A}/students/1`), {
    id: 1,
    name: 'May',
    balance: 45,
    frozen: false,
    transactions: [],
  })
  batch.set(firestore.doc(`classrooms/${CLASS_A}/students/2`), {
    id: 2,
    name: 'Jordan Reyes',
    balance: 5,
    frozen: false,
    transactions: [],
  })
  batch.set(
    firestore.doc(`classrooms/${CLASS_A}/transactions/101`),
    storedTransaction({
      id: 101,
      studentId: 1,
      studentName: 'May',
      date: '2026-08-15T16:30:00.000Z',
      amount: 25,
      reason: 'Paid Jordan Reyes back',
      status: 'Pending',
      source: 'Student',
    }),
  )

  batch.set(firestore.doc(`teachers/${TEACHER_B}`), {
    uid: TEACHER_B,
    status: 'active',
    classroomId: CLASS_B,
    displayName: 'Synthetic Teacher B',
  })
  batch.set(firestore.doc(`classrooms/${CLASS_B}`), { ownerUid: TEACHER_B, version: 1 })
  batch.set(firestore.doc(`classrooms/${CLASS_B}/students/7`), {
    id: 7,
    name: 'Blaise Example',
    balance: 80,
    frozen: false,
    transactions: [],
  })
  batch.set(
    firestore.doc(`classrooms/${CLASS_B}/transactions/701`),
    storedTransaction({
      id: 701,
      studentId: 7,
      studentName: 'Blaise Example',
      date: '2026-08-14T10:00:00.000Z',
      type: 'Subtract',
      amount: 10,
      reason: 'Class store purchase',
    }),
  )
  await batch.commit()
}

before(seedSyntheticClassrooms)
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
after(async () => app.delete())

function reserveInput(overrides = {}) {
  return {
    teacherUid: 'ledger-teacher-a',
    classroomId: 'ledger-class-a',
    requestId: 'ledger_request_0001',
    monthKey: '2026-08',
    mode: 'quick',
    evidenceSignature: 'a'.repeat(64),
    hourlyRequestLimit: 10,
    monthlyAllowanceMicroUsd: 7_500_000,
    rateCardId: 'fake-emulator-rate-v1',
    worstCaseCostMicroUsd: 4_000_000,
    ...overrides,
  }
}

function createBridgeHarness() {
  const providerInputs = []
  const loadEvidence = createFirestoreTenantEvidenceLoader({
    firestore,
    calculateReport: buildClassInsightsReport,
    now: () => NOW,
  })
  const usageLedger = createFirestoreUsageLedger({ firestore, now: () => NOW_MS })
  const provider = {
    async generate(input) {
      providerInputs.push(input)
      const ids = input.factPacket.observations.map(observation => observation.id)
      return {
        schemaVersion: 2,
        orderedObservationIds: ids,
        groups: [{ label: 'review-first', observationIds: ids }],
        teacherQuestions: [{
          kind: 'suggestion',
          text: 'Would reviewing these verified observations help?',
          observationIds: ids,
        }],
        usage: { inputTokens: 120, outputTokens: 30, thinkingTokens: 0 },
      }
    },
  }
  const service = createInsightAnalysisService({
    now: () => NOW,
    resolveActiveTeacherTenant: ({ auth }) => resolveActiveTeacherTenant({ firestore, auth }),
    loadDeidentifiedTenantEvidence: loadEvidence,
    buildFactPacket: buildFactPacketFromEvidence,
    async quoteWorstCaseCost() {
      return { rateCardId: 'fake-emulator-rate-v1', worstCaseCostMicroUsd: 4_000_000 }
    },
    provider,
    async priceActualUsage() {
      return 3_000_000
    },
    usageLedger,
  })
  return { loadEvidence, providerInputs, service, usageLedger }
}

function request(requestId, overrides = {}) {
  return {
    requestId,
    mode: 'quick',
    periodDays: 30,
    ...overrides,
  }
}

test('real emulator bridge isolates tenants, strips identities, and replays safely', async () => {
  const bridge = createBridgeHarness()
  const firstRequest = request('request_a_first001')
  const first = await bridge.service({ auth: { uid: TEACHER_A }, data: firstRequest })
  assert.equal(first.source, 'provider-assisted')
  assert.equal(first.usage.costMicroUsd, 3_000_000)
  assert.match(JSON.stringify(first.observations), /May|Jordan Reyes/)
  assert.equal(bridge.providerInputs.length, 1)

  const providerPayload = JSON.stringify(bridge.providerInputs[0])
  for (const forbidden of [
    TEACHER_A,
    CLASS_A,
    'May',
    'Jordan Reyes',
    'Paid Jordan Reyes back',
    '101',
  ]) {
    assert.doesNotMatch(providerPayload, new RegExp(forbidden, 'i'))
  }

  const replay = await bridge.service({ auth: { uid: TEACHER_A }, data: firstRequest })
  assert.deepEqual(replay, first)
  assert.equal(bridge.providerInputs.length, 1)

  const tenantB = await bridge.service({
    auth: { uid: TEACHER_B },
    data: request('request_b_cross001'),
  })
  assert.equal(tenantB.source, 'provider-assisted')
  assert.doesNotMatch(JSON.stringify(tenantB.observations), /May|Jordan Reyes/)
  assert.equal(bridge.providerInputs.length, 2)
})

test('server evidence changes bind request reuse and monthly budget remains application-scoped', async () => {
  const bridge = createBridgeHarness()
  await bridge.service({
    auth: { uid: TEACHER_A },
    data: request('request_stale_0001'),
  })
  await firestore.doc(`classrooms/${CLASS_A}/transactions/101`).update({ amount: 26 })
  await assert.rejects(
    bridge.service({
      auth: { uid: TEACHER_A },
      data: request('request_stale_0001'),
    }),
    error => error instanceof InsightAnalysisServiceError && error.category === 'budget-unavailable',
  )
  assert.equal(bridge.providerInputs.length, 1)

  await bridge.service({
    auth: { uid: TEACHER_A },
    data: request('request_a_second01'),
  })
  assert.equal(bridge.providerInputs.length, 2)

  await assert.rejects(
    bridge.service({
      auth: { uid: TEACHER_B },
      data: request('request_b_first001'),
    }),
    error => error instanceof InsightAnalysisServiceError && error.category === 'budget-unavailable',
  )
  assert.equal(bridge.providerInputs.length, 2)

  const [ledgers, rateLimits, reservations] = await Promise.all([
    firestore.collection('insightUsageLedgers').get(),
    firestore.collection('insightUsageRateLimits').get(),
    firestore.collection('insightUsageReservations').get(),
  ])
  const storedUsage = JSON.stringify([
    ...ledgers.docs.map(document => document.data()),
    ...rateLimits.docs.map(document => document.data()),
    ...reservations.docs.map(document => document.data()),
  ])
  for (const forbidden of [TEACHER_A, TEACHER_B, CLASS_A, CLASS_B, 'May', 'Jordan Reyes']) {
    assert.doesNotMatch(storedUsage, new RegExp(forbidden, 'i'))
  }
})

test('real Firestore transactions serialize concurrent cross-tenant allowance reservations', async () => {
  const ledger = createFirestoreUsageLedger({ firestore, now: () => NOW_MS })
  const outcomes = await Promise.allSettled([
    ledger.reserve(reserveInput({ requestId: 'concurrent_req_001' })),
    ledger.reserve(reserveInput({
      teacherUid: 'ledger-teacher-b',
      classroomId: 'ledger-class-b',
      requestId: 'concurrent_req_002',
    })),
  ])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  const rejected = outcomes.find(outcome => outcome.status === 'rejected')
  assert.ok(rejected.reason instanceof FirestoreUsageLedgerError)
  assert.equal(rejected.reason.category, 'allowance-exhausted')
})

test('real Firestore ledger enforces the rolling Quick limit', async () => {
  const ledger = createFirestoreUsageLedger({ firestore, now: () => NOW_MS })
  for (let index = 0; index < 10; index += 1) {
    await ledger.reserve(reserveInput({
      teacherUid: 'rate-teacher',
      classroomId: 'rate-classroom',
      requestId: `rate_request_${String(index).padStart(4, '0')}`,
      worstCaseCostMicroUsd: 1,
    }))
  }
  await assert.rejects(
    ledger.reserve(reserveInput({
      teacherUid: 'rate-teacher',
      classroomId: 'rate-classroom',
      requestId: 'rate_request_9999',
      worstCaseCostMicroUsd: 1,
    })),
    error => error instanceof FirestoreUsageLedgerError &&
      error.category === 'rate-limit-exhausted',
  )
})
