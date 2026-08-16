import assert from 'node:assert/strict'
import test from 'node:test'

import { insightModeProfile } from './costPolicy.js'
import {
  InsightFactPacketBuilderError,
  buildFactPacketFromEvidence,
} from './factPacketBuilder.js'

const SIGNATURE = 'a'.repeat(64)

function observation(index) {
  return {
    priority: index === 0 ? 'attention' : 'context',
    category: 'Classwide trends',
    title: `Observation ${index + 1}`,
    summary: `Deterministic summary ${index + 1}.`,
    evidence: [`Evidence ${index + 1}.`],
  }
}

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-16T18:00:00.000Z',
    metrics: {
      studentCount: 2,
      transactionCount: 3,
      approvedCount: 2,
      pendingCount: 1,
      totalClassCash: 70,
    },
    observations: Array.from({ length: 6 }, (_, index) => observation(index)),
    ...overrides,
  }
}

test('builds opaque exact-schema packets and applies the server-owned Quick limit', () => {
  const packet = buildFactPacketFromEvidence({
    evidence: evidence(),
    evidenceSignature: SIGNATURE,
    mode: 'quick',
    periodDays: 30,
    modeProfile: insightModeProfile('quick'),
  })

  assert.equal(packet.observations.length, 4)
  assert.deepEqual(packet.observations.map(item => item.id), [
    'obs-001',
    'obs-002',
    'obs-003',
    'obs-004',
  ])
  assert.deepEqual(packet.observations.map(item => item.evidence[0].id), [
    'ev-001',
    'ev-002',
    'ev-003',
    'ev-004',
  ])
  assert.equal(packet.mode, 'quick')
  assert.equal(packet.periodDays, 30)
  assert.equal(packet.evidenceSignature, SIGNATURE)
})

test('Deep retains the complete bounded deterministic observation set', () => {
  const packet = buildFactPacketFromEvidence({
    evidence: evidence(),
    evidenceSignature: SIGNATURE,
    mode: 'deep',
    periodDays: 90,
    modeProfile: insightModeProfile('deep'),
  })
  assert.equal(packet.observations.length, 6)
  assert.equal(packet.observations.at(-1).id, 'obs-006')
})

test('malformed evidence fails before a packet can be returned', () => {
  assert.throws(
    () => buildFactPacketFromEvidence({
      evidence: evidence({ observations: [{ ...observation(0), studentId: '1' }] }),
      evidenceSignature: SIGNATURE,
      mode: 'quick',
      periodDays: 30,
      modeProfile: insightModeProfile('quick'),
    }),
    error => error instanceof InsightFactPacketBuilderError &&
      error.category === 'invalid-evidence',
  )
})
