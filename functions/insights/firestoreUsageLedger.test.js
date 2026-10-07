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
  const foundation = new Map()
  for (const id of ['a', 'b', 'c']) {
    foundation.set(`teachers/teacher-${id}`, { uid: `teacher-${id}`, classroomId: `class-${id}`, status: 'active' })
    foundation.set(`classrooms/class-${id}`, { ownerUid: `teacher-${id}`, accessControl: { schemaVersion: 1, mode: 'active', generation: 1, changedAt: '2026-08-01T00:00:00.000Z', auditId: 'fixture' } })
  }
  function document(path) {
    return { path, id: path.split('/').at(-1), collection: name => ({ doc: id => document(`${path}/${name}/${id}`) }) }
  }
  return {
    store, foundation,
    firestore: {
      doc: document,
      collection(name) {
        return { doc: id => document(`${name}/${id}`) }
      },
      async runTransaction(callback) {
        const pending = []
        const result = await callback({
          async get(reference) {
            const exists = store.has(reference.path) || foundation.has(reference.path)
            return {
              exists,
              id: reference.id,
              data: () => clone(store.get(reference.path) ?? foundation.get(reference.path)),
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
    controlGeneration: 1, teacherUid: 'teacher-a',
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

for (const mode of ['readOnly', 'suspended', 'missing', 'malformed', 'stale']) test(`new usage refuses ${mode} with no accounting writes`, async () => {
  const fake = createFirestoreDouble()
  const root = fake.foundation.get('classrooms/class-a')
  if (mode === 'missing') delete root.accessControl
  else if (mode === 'malformed') root.accessControl.generation = 0
  else if (mode === 'stale') root.accessControl.generation = 3
  else root.accessControl.mode = mode
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => START })
  await assert.rejects(ledger.reserve(reserveInput()))
  assert.equal(fake.store.size, 0)
})

test('reservation retry rechecks foundation and discards an attempt interrupted by pause', async () => {
  const fake = createFirestoreDouble()
  let attempts = 0
  const original = fake.firestore.runTransaction
  fake.firestore.runTransaction = async callback => {
    const result = await callback({
      get: async ref => ({ exists: fake.foundation.has(ref.path), data: () => clone(fake.foundation.get(ref.path)) }),
      set() {}, create() {},
    })
    assert.equal(result.kind, 'reserved'); attempts++
    fake.foundation.get('classrooms/class-a').accessControl.mode = 'suspended'
    attempts++
    return original(callback)
  }
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => START })
  await assert.rejects(ledger.reserve(reserveInput()))
  assert.equal(attempts, 2); assert.equal(fake.store.size, 0)
})

test('dispatches are single-use, sequential, bounded, and settle during pause', async () => {
  const fake = createFirestoreDouble()
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => START })
  const request = reserveInput()
  const reserved = await ledger.reserve(request)
  const claim = { teacherUid: request.teacherUid, classroomId: request.classroomId, controlGeneration: 1,
    requestId: request.requestId, reservationId: reserved.reservationId, dispatchIndex: 1 }
  const finish = i => ({ requestId: request.requestId, reservationId: reserved.reservationId, dispatchIndex: i, outcome: 'returned' })
  await assert.rejects(ledger.claimDispatch({ ...claim, dispatchIndex: 2 }))
  await ledger.claimDispatch(claim)
  await assert.rejects(ledger.claimDispatch(claim))
  await assert.rejects(ledger.claimDispatch({ ...claim, dispatchIndex: 2 }))
  const charged = [...fake.store].find(([p]) => p.startsWith('insightUsageLedgers/'))[1].chargedMicroUsd
  fake.foundation.get('classrooms/class-a').accessControl.mode = 'suspended'
  await ledger.finishDispatch(finish(1))
  await ledger.finishDispatch(finish(1)) // exact accounting replay
  await assert.rejects(ledger.finishDispatch({ ...finish(1), outcome: 'failed' }))
  await assert.rejects(ledger.claimDispatch({ ...claim, dispatchIndex: 2 }))
  fake.foundation.get('classrooms/class-a').accessControl.mode = 'active'
  for (let i = 2; i <= 4; i++) {
    await ledger.claimDispatch({ ...claim, dispatchIndex: i })
    await ledger.finishDispatch(finish(i))
  }
  await assert.rejects(ledger.claimDispatch({ ...claim, dispatchIndex: 5 }))
  assert.equal([...fake.store.keys()].filter(p => p.includes('/dispatches/')).length, 4)
  assert.equal([...fake.store].find(([p]) => p.startsWith('insightUsageLedgers/'))[1].chargedMicroUsd, charged)
})

test('resume, foreign identity, and old schema cannot authorize dispatch on an existing reservation', async () => {
  const fake = createFirestoreDouble()
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => START })
  const request = reserveInput(), reserved = await ledger.reserve(request)
  const input = { teacherUid: request.teacherUid, classroomId: request.classroomId, controlGeneration: 1,
    requestId: request.requestId, reservationId: reserved.reservationId, dispatchIndex: 1 }
  fake.foundation.get('classrooms/class-a').accessControl.generation = 3
  await assert.rejects(ledger.claimDispatch(input))
  await assert.rejects(ledger.claimDispatch({ ...input, controlGeneration: 3 }))
  await assert.rejects(ledger.claimDispatch({ ...input, teacherUid: 'teacher-b', classroomId: 'class-b' }))
  const record = fake.store.get(`insightUsageReservations/${reserved.reservationId}`)
  record.schemaVersion = 3; delete record.controlGeneration
  await assert.rejects(ledger.claimDispatch({ ...input, controlGeneration: 3 }))
  // Old schema reservations retain accounting-only compatibility during a pause.
  fake.foundation.get('classrooms/class-a').accessControl.mode = 'suspended'
  await ledger.commit({ requestId: request.requestId, reservationId: reserved.reservationId,
    actualCostMicroUsd: 2_000_000, result: completedResult() })
  assert.equal(record.status, 'reserved') // original snapshot not mutated in place
  assert.equal(fake.store.get(`insightUsageReservations/${reserved.reservationId}`).status, 'completed')
  assert.equal([...fake.store.keys()].filter(p => p.includes('/dispatches/')).length, 0)
})

test('failed transport is an uncertain claim, never proof the external provider stopped', async () => {
  const fake = createFirestoreDouble()
  const ledger = createFirestoreUsageLedger({ firestore: fake.firestore, now: () => START })
  const input = reserveInput(), r = await ledger.reserve(input)
  const dispatch = { teacherUid: input.teacherUid, classroomId: input.classroomId, controlGeneration: 1,
    reservationId: r.reservationId, requestId: input.requestId, dispatchIndex: 1 }
  await ledger.claimDispatch(dispatch)
  const finish = { reservationId: r.reservationId, requestId: input.requestId, dispatchIndex: 1, outcome: 'failed' }
  await ledger.finishDispatch(finish)
  await ledger.finishDispatch(finish)
  const claim = fake.store.get(`insightUsageReservations/${r.reservationId}/dispatches/1`)
  assert.equal(claim.status, 'uncertain'); assert.equal(claim.finishedAtMs, null)
  await assert.rejects(ledger.claimDispatch({ ...dispatch, dispatchIndex: 2 }))
  await assert.rejects(ledger.finishDispatch({ ...finish, outcome: 'returned' }))
})
