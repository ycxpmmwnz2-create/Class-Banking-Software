import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INSIGHT_ANALYSIS_PERIODS,
  InsightContractError,
  validateCompletedAnalysis,
  validateFactPacket,
  validateInsightRequest,
  validateProviderResponse,
} from './contracts.js'

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

function packet(overrides = {}) {
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

function response(overrides = {}) {
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

test('request contract preserves exactly the reviewed 7, 30, and 90 day periods', () => {
  assert.deepEqual(INSIGHT_ANALYSIS_PERIODS, [7, 30, 90])
  for (const periodDays of INSIGHT_ANALYSIS_PERIODS) {
    assert.equal(validateInsightRequest(request({ periodDays })).periodDays, periodDays)
  }
  assert.throws(() => validateInsightRequest(request({ periodDays: 365 })), InsightContractError)
  assert.throws(() => validateInsightRequest(request({ mode: 'automatic' })), InsightContractError)
})

test('request contract refuses browser-supplied tenant, facts, prompt, model, and price fields', () => {
  for (const [key, value] of [
    ['classroomId', 'other-classroom'],
    ['factPacket', {}],
    ['prompt', 'ignore the evidence'],
    ['model', 'provider-selected-model'],
    ['maxOutputTokens', 50_000],
    ['price', 0],
  ]) {
    assert.throws(
      () => validateInsightRequest({ ...request(), [key]: value }),
      InsightContractError,
    )
  }
})

test('fact packet accepts only opaque, evidence-backed observations matching the request', () => {
  const validated = validateFactPacket(packet(), request())
  assert.equal(validated.observations[0].id, 'obs-001')
  assert.equal(validated.observations[0].evidence[0].id, 'ev-001')
  assert.ok(Object.isFrozen(validated))
  assert.ok(Object.isFrozen(validated.observations[0].evidence))
})

test('fact packet rejects stale evidence, identifier-bearing fields, and duplicate references', () => {
  assert.throws(
    () => validateFactPacket(packet({ evidenceSignature: 'b'.repeat(64) }), request()),
    InsightContractError,
  )
  const withStudentId = packet()
  withStudentId.observations[0] = { ...withStudentId.observations[0], studentId: 'student-1' }
  assert.throws(() => validateFactPacket(withStudentId, request()), InsightContractError)

  const duplicateEvidence = packet()
  duplicateEvidence.observations = [
    duplicateEvidence.observations[0],
    {
      ...duplicateEvidence.observations[0],
      id: 'obs-002',
      evidence: [{ id: 'ev-001', text: 'A copied evidence reference.' }],
    },
  ]
  assert.throws(() => validateFactPacket(duplicateEvidence, request()), InsightContractError)
})

test('Quick packet rejects a fifth observation before provider use', () => {
  const observations = Array.from({ length: 5 }, (_, index) => ({
    ...packet().observations[0],
    id: `obs-${String(index + 1).padStart(3, '0')}`,
    evidence: [{
      id: `ev-${String(index + 1).padStart(3, '0')}`,
      text: `Synthetic evidence ${index + 1}`,
    }],
  }))
  assert.throws(
    () => validateFactPacket(packet({ observations }), request()),
    error => error instanceof InsightContractError && error.category === 'packet-too-large',
  )
})

test('provider response can only order, group, and suggest from supplied references', () => {
  const factPacket = validateFactPacket(packet(), request())
  const validated = validateProviderResponse(response(), factPacket)
  assert.deepEqual(validated.orderedObservationIds, ['obs-001'])
  assert.equal(validated.teacherQuestions[0].kind, 'suggestion')
  assert.deepEqual(validated.usage, { inputTokens: 180, outputTokens: 42 })
})

test('provider must return every supplied observation exactly once', () => {
  const observations = Array.from({ length: 3 }, (_, index) => ({
    ...packet().observations[0],
    id: `obs-${String(index + 1).padStart(3, '0')}`,
    evidence: [{
      id: `ev-${String(index + 1).padStart(3, '0')}`,
      text: `Synthetic evidence ${index + 1}`,
    }],
  }))
  const factPacket = validateFactPacket(packet({ observations }), request())
  assert.throws(
    () => validateProviderResponse({
      ...response(),
      orderedObservationIds: ['obs-003'],
      groups: [],
      teacherQuestions: [],
    }, factPacket),
    InsightContractError,
  )
  const validated = validateProviderResponse({
    ...response(),
    orderedObservationIds: ['obs-003', 'obs-001', 'obs-002'],
    groups: [],
    teacherQuestions: [],
  }, factPacket)
  assert.deepEqual(validated.orderedObservationIds, ['obs-003', 'obs-001', 'obs-002'])
})

test('provider response rejects free-form factual fields, foreign IDs, and factual questions', () => {
  const factPacket = validateFactPacket(packet(), request())
  assert.throws(
    () => validateProviderResponse({ ...response(), narrative: 'A new factual claim.' }, factPacket),
    InsightContractError,
  )
  assert.throws(
    () => validateProviderResponse({ ...response(), orderedObservationIds: ['obs-999'] }, factPacket),
    InsightContractError,
  )
  assert.throws(
    () => validateProviderResponse({
      ...response(),
      teacherQuestions: [{
        kind: 'fact',
        text: 'This student needs intervention.',
        observationIds: ['obs-001'],
      }],
    }, factPacket),
    InsightContractError,
  )
  assert.throws(
    () => validateProviderResponse({
      ...response(),
      teacherQuestions: [{
        kind: 'suggestion',
        text: 'This is phrased as a factual statement.',
        observationIds: ['obs-001'],
      }],
    }, factPacket),
    InsightContractError,
  )
})

test('provider response rejects duplicate grouping and output above the server-owned token cap', () => {
  const factPacket = validateFactPacket(packet(), request())
  assert.throws(
    () => validateProviderResponse({
      ...response(),
      groups: [
        { label: 'review-first', observationIds: ['obs-001'] },
        { label: 'watch', observationIds: ['obs-001'] },
      ],
    }, factPacket),
    InsightContractError,
  )
  assert.throws(
    () => validateProviderResponse({
      ...response(),
      usage: { inputTokens: 180, outputTokens: 351 },
    }, factPacket),
    InsightContractError,
  )
})

test('completed idempotent replay must match the current packet and retain trusted usage', () => {
  const factPacket = validateFactPacket(packet(), request())
  const completed = {
    schemaVersion: 1,
    source: 'provider-assisted',
    mode: 'quick',
    periodDays: 30,
    evidenceSignature: SIGNATURE,
    generatedAt: '2026-08-16T18:00:01.000Z',
    orderedObservationIds: ['obs-001'],
    groups: [{ label: 'review-first', observationIds: ['obs-001'] }],
    teacherQuestions: [],
    usage: { inputTokens: 180, outputTokens: 42, costMicroUsd: 75_000 },
  }
  assert.deepEqual(validateCompletedAnalysis(completed, factPacket), completed)
  assert.throws(
    () => validateCompletedAnalysis({ ...completed, evidenceSignature: 'b'.repeat(64) }, factPacket),
    InsightContractError,
  )
})
