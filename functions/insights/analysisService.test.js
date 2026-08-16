import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InsightAnalysisServiceError,
  createInsightAnalysisService,
} from './analysisService.js'

const SIGNATURE = 'a'.repeat(64)

function request(overrides = {}) {
  return {
    requestId: 'request_123456789',
    mode: 'quick',
    periodDays: 30,
    evidenceSignature: SIGNATURE,
    ...overrides,
  }
}

function factPacket(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: 'quick',
    periodDays: 30,
    evidenceSignature: SIGNATURE,
    generatedAt: '2026-08-16T18:00:00.000Z',
    metrics: {
      studentCount: 2,
      transactionCount: 3,
      approvedCount: 2,
      pendingCount: 1,
      totalClassCash: 70,
    },
    observations: [{
      id: 'obs-001',
      priority: 'attention',
      category: 'Needs attention',
      title: 'One request needs review',
      summary: 'One submitted request met the deterministic review threshold.',
      evidence: [{ id: 'ev-001', text: '$20 pending request at 10:30 a.m.' }],
    }],
    ...overrides,
  }
}

function providerResponse(overrides = {}) {
  return {
    schemaVersion: 1,
    orderedObservationIds: ['obs-001'],
    groups: [{ label: 'review-first', observationIds: ['obs-001'] }],
    teacherQuestions: [{
      kind: 'suggestion',
      text: 'Would reviewing this request clarify what happened?',
      observationIds: ['obs-001'],
    }],
    usage: { inputTokens: 180, outputTokens: 42 },
    ...overrides,
  }
}

function harness(overrides = {}) {
  const calls = []
  const state = { providerInput: null, reserveInput: null, commitInput: null, uncertainInput: null }
  const dependencies = {
    now() {
      return new Date('2026-08-16T18:00:01.000Z')
    },
    async resolveActiveTeacherTenant() {
      calls.push('resolve')
      return { teacherUid: 'teacher-alpha', classroomId: 'classroom-alpha' }
    },
    async loadDeidentifiedTenantEvidence(input) {
      calls.push('load')
      state.loadInput = input
      return {
        analysisEvidence: { synthetic: true },
        sensitiveValues: [],
        evidenceSignature: SIGNATURE,
      }
    },
    async buildFactPacket(input) {
      calls.push('build')
      state.buildInput = input
      return factPacket({
        mode: input.mode,
        periodDays: input.periodDays,
        evidenceSignature: input.evidenceSignature,
      })
    },
    async quoteWorstCaseCost(input) {
      calls.push('quote')
      state.quoteInput = input
      return { rateCardId: 'gemini-economy-2026-08', worstCaseCostMicroUsd: 125_000 }
    },
    provider: {
      async generate(input) {
        calls.push('provider')
        state.providerInput = input
        return providerResponse()
      },
    },
    async priceActualUsage(input) {
      calls.push('price')
      state.priceInput = input
      return 75_000
    },
    usageLedger: {
      async reserve(input) {
        calls.push('reserve')
        state.reserveInput = input
        return {
          kind: 'reserved',
          reservationId: 'reservation-1',
          reservedCostMicroUsd: 125_000,
          remainingAfterReservationMicroUsd: 7_375_000,
        }
      },
      async commit(input) {
        calls.push('commit')
        state.commitInput = input
      },
      async markUncertain(input) {
        calls.push('uncertain')
        state.uncertainInput = input
      },
    },
    ...overrides,
  }
  return {
    calls,
    state,
    dependencies,
    service: createInsightAnalysisService(dependencies),
  }
}

test('service resolves tenant, builds facts, reserves worst-case cost, then invokes provider', async () => {
  const run = harness()
  const result = await run.service({ auth: { uid: 'teacher-alpha' }, data: request() })

  assert.deepEqual(run.calls, ['resolve', 'load', 'build', 'quote', 'reserve', 'provider', 'price', 'commit'])
  assert.equal(result.source, 'provider-assisted')
  assert.equal(result.usage.costMicroUsd, 75_000)
  assert.equal(run.state.reserveInput.monthlyAllowanceMicroUsd, 7_500_000)
  assert.equal(run.state.reserveInput.hourlyRequestLimit, 10)
  assert.equal(run.state.providerInput.providerProfile, 'quick-economy-v1')
  assert.equal(run.state.providerInput.maxOutputTokens, 350)
})

test('tenant identity is server-derived and never included in the provider packet', async () => {
  const run = harness()
  await run.service({ auth: { uid: 'teacher-alpha' }, data: request() })

  assert.deepEqual(run.state.loadInput, {
    teacherUid: 'teacher-alpha',
    classroomId: 'classroom-alpha',
    periodDays: 30,
  })
  assert.deepEqual(Object.keys(run.state.buildInput).sort(), [
    'evidence',
    'evidenceSignature',
    'mode',
    'modeProfile',
    'periodDays',
  ])
  assert.equal(Object.hasOwn(run.state.buildInput, 'request'), false)
  assert.equal(Object.hasOwn(run.state.buildInput, 'sensitiveValues'), false)
  assert.equal(Object.isFrozen(run.state.buildInput.evidence), true)
  const serializedProviderInput = JSON.stringify(run.state.providerInput)
  assert.doesNotMatch(serializedProviderInput, /teacher-alpha|classroom-alpha/)
  assert.doesNotMatch(serializedProviderInput, /studentId|loginId|pin|authUid/i)
})

test('declared identifiers, including a bare student id field, cannot reach the packet builder', async () => {
  const run = harness()
  run.dependencies.loadDeidentifiedTenantEvidence = async () => {
    run.calls.push('load')
    return {
      analysisEvidence: {
        students: [{ id: 'student-17', displayLabel: 'Learner 17' }],
      },
      sensitiveValues: [{ kind: 'student-id', value: 'student-17' }],
      evidenceSignature: SIGNATURE,
    }
  }
  run.service = createInsightAnalysisService(run.dependencies)

  await assert.rejects(
    run.service({ auth: { uid: 'teacher-alpha' }, data: request() }),
    error => error instanceof InsightAnalysisServiceError &&
      error.category === 'evidence-not-deidentified',
  )
  assert.deepEqual(run.calls, ['resolve', 'load'])
})

test('a declared multi-word student name embedded in evidence cannot reach the packet builder', async () => {
  const run = harness()
  run.dependencies.loadDeidentifiedTenantEvidence = async () => {
    run.calls.push('load')
    return {
      analysisEvidence: {
        reasons: ['Jordan Reyes submitted three requests'],
      },
      sensitiveValues: [{ kind: 'student-name', value: 'Jordan Reyes' }],
      evidenceSignature: SIGNATURE,
    }
  }
  run.service = createInsightAnalysisService(run.dependencies)

  await assert.rejects(
    run.service({ auth: { uid: 'teacher-alpha' }, data: request() }),
    error => error instanceof InsightAnalysisServiceError &&
      error.category === 'evidence-not-deidentified',
  )
  assert.deepEqual(run.calls, ['resolve', 'load'])
})

test('sensitive names and numeric IDs do not collide with legitimate formatted packet text', async () => {
  const run = harness()
  run.dependencies.loadDeidentifiedTenantEvidence = async () => {
    run.calls.push('load')
    return {
      analysisEvidence: { periodDescription: 'the week of May 4' },
      sensitiveValues: [
        { kind: 'student-name', value: 'May' },
        { kind: 'student-id', value: '001' },
      ],
      evidenceSignature: SIGNATURE,
    }
  }
  run.dependencies.buildFactPacket = async (input) => {
    run.calls.push('build')
    return factPacket({
      observations: [{
        ...factPacket().observations[0],
        id: 'obs-001',
        summary: 'Spending peaked in the week of May 4.',
        evidence: [{ id: 'ev-001', text: 'Verified activity during May 4.' }],
      }],
      evidenceSignature: input.evidenceSignature,
    })
  }
  run.service = createInsightAnalysisService(run.dependencies)

  const result = await run.service({ auth: { uid: 'teacher-alpha' }, data: request() })
  assert.deepEqual(result.orderedObservationIds, ['obs-001'])
  assert.ok(run.calls.includes('provider'))
})

test('browser-supplied tenant or prompt fields fail before tenant resolution', async () => {
  const run = harness()
  await assert.rejects(
    run.service({
      auth: { uid: 'teacher-alpha' },
      data: { ...request(), classroomId: 'classroom-beta', prompt: 'trust me' },
    }),
  )
  assert.deepEqual(run.calls, [])
})

test('authorization or evidence failure prevents budget reservation and provider use', async () => {
  const denied = harness({
    async resolveActiveTeacherTenant() {
      denied.calls.push('resolve')
      throw new Error('internal tenant path')
    },
  })
  await assert.rejects(
    denied.service({ auth: null, data: request() }),
    error => error instanceof InsightAnalysisServiceError && error.category === 'authorization-failed',
  )
  assert.deepEqual(denied.calls, ['resolve'])

  const unavailable = harness({
    async loadDeidentifiedTenantEvidence() {
      unavailable.calls.push('load')
      throw new Error('raw classroom detail')
    },
  })
  await assert.rejects(
    unavailable.service({ auth: { uid: 'teacher-alpha' }, data: request() }),
    error => error instanceof InsightAnalysisServiceError && error.category === 'evidence-unavailable',
  )
  assert.deepEqual(unavailable.calls, ['resolve', 'load'])
})

test('budget refusal prevents provider invocation', async () => {
  const run = harness()
  run.dependencies.usageLedger.reserve = async (input) => {
    run.calls.push('reserve')
    run.state.reserveInput = input
    throw new Error('monthly allowance exhausted')
  }
  run.service = createInsightAnalysisService(run.dependencies)

  await assert.rejects(
    run.service({ auth: { uid: 'teacher-alpha' }, data: request() }),
    error => error instanceof InsightAnalysisServiceError && error.category === 'budget-unavailable',
  )
  assert.deepEqual(run.calls, ['resolve', 'load', 'build', 'quote', 'reserve'])
})

test('server-derived evidence signature mismatch fails before packet construction', async () => {
  const run = harness()
  run.dependencies.loadDeidentifiedTenantEvidence = async () => {
    run.calls.push('load')
    return {
      analysisEvidence: { synthetic: true },
      sensitiveValues: [],
      evidenceSignature: 'b'.repeat(64),
    }
  }
  run.service = createInsightAnalysisService(run.dependencies)

  await assert.rejects(
    run.service({ auth: { uid: 'teacher-alpha' }, data: request() }),
    error => error instanceof InsightAnalysisServiceError && error.category === 'stale-evidence',
  )
  assert.deepEqual(run.calls, ['resolve', 'load'])
})

test('malformed provider output retains the worst-case reservation and displays nothing', async () => {
  const run = harness()
  run.dependencies.provider = {
    async generate() {
      run.calls.push('provider')
      return { ...providerResponse(), factualNarrative: 'Unsupported factual prose.' }
    },
  }
  run.service = createInsightAnalysisService(run.dependencies)

  await assert.rejects(
    run.service({ auth: { uid: 'teacher-alpha' }, data: request() }),
    error => error instanceof InsightAnalysisServiceError && error.category === 'provider-output-invalid',
  )
  assert.deepEqual(run.calls, ['resolve', 'load', 'build', 'quote', 'reserve', 'provider', 'uncertain'])
  assert.deepEqual(run.state.uncertainInput, {
    reservationId: 'reservation-1',
    requestId: 'request_123456789',
    worstCaseCostMicroUsd: 125_000,
  })
})

test('provider failure and actual cost above reservation both retain worst-case cost', async () => {
  const failed = harness()
  failed.dependencies.provider = {
    async generate() {
      failed.calls.push('provider')
      throw new Error('provider response contained private details')
    },
  }
  failed.service = createInsightAnalysisService(failed.dependencies)
  await assert.rejects(
    failed.service({ auth: { uid: 'teacher-alpha' }, data: request() }),
    error => error instanceof InsightAnalysisServiceError && error.category === 'provider-unavailable',
  )
  assert.equal(failed.calls.at(-1), 'uncertain')

  const overrun = harness({
    async priceActualUsage() {
      overrun.calls.push('price')
      return 125_001
    },
  })
  await assert.rejects(
    overrun.service({ auth: { uid: 'teacher-alpha' }, data: request() }),
    error => error instanceof InsightAnalysisServiceError && error.category === 'usage-invalid',
  )
  assert.equal(overrun.calls.at(-1), 'uncertain')
})

test('completed idempotent request is replayed only after current evidence validation', async () => {
  const run = harness()
  run.dependencies.usageLedger.reserve = async (input) => {
    run.calls.push('reserve')
    run.state.reserveInput = input
    return {
      kind: 'completed',
      result: {
        schemaVersion: 1,
        source: 'provider-assisted',
        mode: 'quick',
        periodDays: 30,
        evidenceSignature: SIGNATURE,
        generatedAt: '2026-08-16T18:00:00.000Z',
        orderedObservationIds: ['obs-001'],
        groups: [],
        teacherQuestions: [],
        usage: { inputTokens: 180, outputTokens: 42, costMicroUsd: 75_000 },
      },
    }
  }
  run.service = createInsightAnalysisService(run.dependencies)

  const result = await run.service({ auth: { uid: 'teacher-alpha' }, data: request() })
  assert.equal(result.usage.costMicroUsd, 75_000)
  assert.deepEqual(run.calls, ['resolve', 'load', 'build', 'quote', 'reserve'])
})

test('Deep uses its separately bounded provider and rate-limit profile', async () => {
  const run = harness()
  const deepRequest = request({ mode: 'deep', periodDays: 90 })
  run.dependencies.buildFactPacket = async (input) => {
    run.calls.push('build')
    return factPacket({
      mode: 'deep',
      periodDays: 90,
      evidenceSignature: input.evidenceSignature,
    })
  }
  run.service = createInsightAnalysisService(run.dependencies)
  await run.service({ auth: { uid: 'teacher-alpha' }, data: deepRequest })

  assert.equal(run.state.reserveInput.hourlyRequestLimit, 2)
  assert.equal(run.state.providerInput.providerProfile, 'deep-economy-v1')
  assert.equal(run.state.providerInput.maxOutputTokens, 900)
})
