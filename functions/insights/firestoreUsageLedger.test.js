import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FirestoreUsageLedgerError,
  createFirestoreUsageLedger,
} from './firestoreUsageLedger.js'

const START = Date.parse('2026-08-16T18:00:00.000Z')
const SIGNATURE = 'a'.repeat(64)

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createFirestoreDouble() {
  const store = new Map()
  function document(path) {
    return { path, id: path.split('/').at(-1) }
  }
  return {
    store,
    firestore: {
      collection(name) {
        return { doc: id => document(`${name}/${id}`) }
      },
      async runTransaction(callback) {
        const pending = []
        const result = await callback({
          async get(reference) {
            const exists = store.has(reference.path)
            return {
              exists,
              id: reference.id,
              data: () => clone(store.get(reference.path)),
            }
          },
          set(reference, value) {
            pending.push({ kind: 'set', path: reference.path, value: clone(value) })
          },
          create(reference, value) {
            pending.push({ kind: 'create', path: reference.path, value: clone(value) })
          },
        })
        for (const operation of pending) {
          if (operation.kind === 'create' && store.has(operation.path)) {
            throw new Error('already exists')
          }
          store.set(operation.path, operation.value)
        }
        return result
      },
    },
  }
}

function reserveInput(overrides = {}) {
  return {
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    requestId: 'request_123456789',
    monthKey: '2026-08',
    mode: 'quick',
    evidenceSignature: SIGNATURE,
    hourlyRequestLimit: 10,
    monthlyAllowanceMicroUsd: 7_500_000,
    rateCardId: 'fake-emulator-rate-v1',
    worstCaseCostMicroUsd: 4_000_000,
    ...overrides,
  }
}

function completedResult() {
  return {
    schemaVersion: 2,
    source: 'provider-assisted',
    mode: 'quick',
    periodDays: 30,
    evidenceSignature: 'a'.repeat(64),
    generatedAt: '2026-08-16T18:00:00.000Z',
    orderedObservationIds: ['obs-001'],
    groups: [],
    teacherQuestions: [],
    usage: { inputTokens: 10, outputTokens: 5, thinkingTokens: 0, costMicroUsd: 2_000_000 },
  }
}

test('reserves worst case, reconciles downward, and replays a completed request', async () => {
  const fake = createFirestoreDouble()
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => START })
  const input = reserveInput()
  const reservation = await ledger.reserve(input)
  assert.equal(reservation.reservedCostMicroUsd, 4_000_000)
  assert.equal(reservation.remainingAfterReservationMicroUsd, 3_500_000)

  const result = completedResult()
  await ledger.commit({
    reservationId: reservation.reservationId,
    requestId: input.requestId,
    actualCostMicroUsd: 2_000_000,
    result,
  })
  const replay = await ledger.reserve(input)
  assert.deepEqual(replay, { kind: 'completed', result })

  const otherTenant = await ledger.reserve(reserveInput({
    teacherUid: 'teacher-b',
    classroomId: 'class-b',
    requestId: 'request_other_001',
    worstCaseCostMicroUsd: 5_500_000,
  }))
  assert.equal(otherTenant.remainingAfterReservationMicroUsd, 0)

  const stored = JSON.stringify([...fake.store.entries()])
  assert.doesNotMatch(stored, /teacher-[ab]|class-[ab]|request_(?:123456789|other_001)/)
  assert.match(stored, /"chargedMicroUsd":7500000/)
})

test('one monthly application allowance is enforced across tenant-scoped reservations', async () => {
  const fake = createFirestoreDouble()
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => START })
  await ledger.reserve(reserveInput())
  await assert.rejects(
    ledger.reserve(reserveInput({ requestId: 'request_223456789' })),
    error => error instanceof FirestoreUsageLedgerError &&
      error.category === 'allowance-exhausted',
  )
  await assert.rejects(
    ledger.reserve(reserveInput({
      teacherUid: 'teacher-b',
      classroomId: 'class-b',
      requestId: 'request_other_001',
    })),
    error => error instanceof FirestoreUsageLedgerError &&
      error.category === 'allowance-exhausted',
  )
  const sharedRemainder = await ledger.reserve(reserveInput({
    teacherUid: 'teacher-b',
    classroomId: 'class-b',
    requestId: 'request_other_002',
    worstCaseCostMicroUsd: 3_500_000,
  }))
  assert.equal(sharedRemainder.remainingAfterReservationMicroUsd, 0)
  await assert.rejects(
    ledger.reserve(reserveInput({
      teacherUid: 'teacher-c',
      classroomId: 'class-c',
      requestId: 'request_other_003',
      worstCaseCostMicroUsd: 1,
    })),
    error => error instanceof FirestoreUsageLedgerError &&
      error.category === 'allowance-exhausted',
  )

  const applicationLedgers = [...fake.store.keys()]
    .filter(path => path.startsWith('insightUsageLedgers/'))
  const tenantRateLimits = [...fake.store.keys()]
    .filter(path => path.startsWith('insightUsageRateLimits/'))
  assert.equal(applicationLedgers.length, 1)
  assert.equal(tenantRateLimits.length, 2)
  assert.doesNotMatch(
    JSON.stringify([...fake.store.entries()]),
    /teacher-[abc]|class-[abc]|request_other_00[123]/,
  )
})

test('rolling hourly limits expire without releasing monthly charges', async () => {
  const fake = createFirestoreDouble()
  let clock = START
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => clock })
  for (let index = 0; index < 10; index += 1) {
    await ledger.reserve(reserveInput({
      requestId: `request_rate_${String(index).padStart(4, '0')}`,
      worstCaseCostMicroUsd: 1,
    }))
  }
  await assert.rejects(
    ledger.reserve(reserveInput({ requestId: 'request_rate_9999', worstCaseCostMicroUsd: 1 })),
    error => error instanceof FirestoreUsageLedgerError &&
      error.category === 'rate-limit-exhausted',
  )
  clock += 60 * 60 * 1000
  const afterWindow = await ledger.reserve(reserveInput({
    requestId: 'request_rate_1000',
    worstCaseCostMicroUsd: 1,
  }))
  assert.equal(afterWindow.kind, 'reserved')
})

test('rolling hourly limits carry across a UTC month boundary', async () => {
  const fake = createFirestoreDouble()
  let clock = Date.parse('2026-08-31T23:50:00.000Z')
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => clock })
  for (let index = 0; index < 10; index += 1) {
    await ledger.reserve(reserveInput({
      requestId: `request_month_${String(index).padStart(4, '0')}`,
      worstCaseCostMicroUsd: 1,
    }))
  }

  clock = Date.parse('2026-09-01T00:10:00.000Z')
  await assert.rejects(
    ledger.reserve(reserveInput({
      requestId: 'request_month_9999',
      monthKey: '2026-09',
      worstCaseCostMicroUsd: 1,
    })),
    error => error instanceof FirestoreUsageLedgerError &&
      error.category === 'rate-limit-exhausted',
  )

  clock = Date.parse('2026-09-01T00:50:00.000Z')
  const afterWindow = await ledger.reserve(reserveInput({
    requestId: 'request_month_1000',
    monthKey: '2026-09',
    worstCaseCostMicroUsd: 1,
  }))
  assert.equal(afterWindow.kind, 'reserved')
})

test('uncertain reservations retain cost and cannot invoke a retry', async () => {
  const fake = createFirestoreDouble()
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => START })
  const input = reserveInput()
  const reservation = await ledger.reserve(input)
  await ledger.markUncertain({
    reservationId: reservation.reservationId,
    requestId: input.requestId,
    worstCaseCostMicroUsd: input.worstCaseCostMicroUsd,
  })
  await ledger.markUncertain({
    reservationId: reservation.reservationId,
    requestId: input.requestId,
    worstCaseCostMicroUsd: input.worstCaseCostMicroUsd,
  })
  await assert.rejects(
    ledger.reserve(input),
    error => error instanceof FirestoreUsageLedgerError &&
      error.category === 'request-unavailable',
  )
  assert.match(JSON.stringify([...fake.store.values()]), /"chargedMicroUsd":4000000/)
})

test('policy widening and conflicting request reuse fail closed', async () => {
  const fake = createFirestoreDouble()
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => START })
  await assert.rejects(
    ledger.reserve(reserveInput({ monthlyAllowanceMicroUsd: 8_000_000 })),
    error => error instanceof FirestoreUsageLedgerError && error.category === 'invalid-policy',
  )
  await ledger.reserve(reserveInput())
  await assert.rejects(
    ledger.reserve(reserveInput({ mode: 'deep', hourlyRequestLimit: 2 })),
    error => error instanceof FirestoreUsageLedgerError && error.category === 'request-conflict',
  )
  await assert.rejects(
    ledger.reserve(reserveInput({ evidenceSignature: 'b'.repeat(64) })),
    error => error instanceof FirestoreUsageLedgerError && error.category === 'request-conflict',
  )
})

test('malformed application and tenant rate-limit ledgers fail closed', async () => {
  const malformedApplication = createFirestoreDouble()
  const applicationLedger = createFirestoreUsageLedger({
    firestore: malformedApplication.firestore,
    now: () => START,
  })
  await applicationLedger.reserve(reserveInput())
  const applicationPath = [...malformedApplication.store.keys()]
    .find(path => path.startsWith('insightUsageLedgers/'))
  malformedApplication.store.set(applicationPath, {
    ...malformedApplication.store.get(applicationPath),
    scopeDigest: 'a'.repeat(64),
  })
  await assert.rejects(
    applicationLedger.reserve(reserveInput({
      teacherUid: 'teacher-b',
      classroomId: 'class-b',
      requestId: 'request_other_004',
    })),
    error => error instanceof FirestoreUsageLedgerError && error.category === 'invalid-shape',
  )

  const malformedRateLimit = createFirestoreDouble()
  const rateLimitLedger = createFirestoreUsageLedger({
    firestore: malformedRateLimit.firestore,
    now: () => START,
  })
  await rateLimitLedger.reserve(reserveInput())
  const rateLimitPath = [...malformedRateLimit.store.keys()]
    .find(path => path.startsWith('insightUsageRateLimits/'))
  malformedRateLimit.store.set(rateLimitPath, {
    ...malformedRateLimit.store.get(rateLimitPath),
    quickReservationTimesMs: [START + 1],
  })
  await assert.rejects(
    rateLimitLedger.reserve(reserveInput({ requestId: 'request_rate_bad01' })),
    error => error instanceof FirestoreUsageLedgerError && error.category === 'ledger-malformed',
  )
})
