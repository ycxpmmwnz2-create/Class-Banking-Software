import { INSIGHT_ANALYSIS_SCHEMA_VERSION } from './contracts.js'

const EVIDENCE_SCHEMA_VERSION = 1

export class InsightFactPacketBuilderError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightFactPacketBuilderError'
    this.category = category
  }
}

export function buildFactPacketFromEvidence({
  evidence,
  mode,
  periodDays,
  modeProfile,
}) {
  if (!isPlainObject(evidence) || !hasExactKeys(
    evidence,
    ['schemaVersion', 'generatedAt', 'metrics', 'observations'],
  )) {
    fail('invalid-evidence', 'Analysis evidence does not match the bridge contract.')
  }
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    fail('invalid-evidence', 'Analysis evidence schemaVersion is unsupported.')
  }
  if (!isPlainObject(modeProfile) || !Number.isSafeInteger(modeProfile.maxObservations)) {
    fail('invalid-profile', 'The mode profile is malformed.')
  }
  if (!Array.isArray(evidence.observations) || evidence.observations.length < 1) {
    fail('invalid-evidence', 'Analysis evidence requires at least one observation.')
  }

  const selected = evidence.observations.slice(0, modeProfile.maxObservations)
  let nextEvidenceId = 1
  const observations = selected.map((observation, index) => {
    if (!isPlainObject(observation) || !hasExactKeys(
      observation,
      ['priority', 'category', 'title', 'summary', 'evidence'],
    )) {
      fail('invalid-evidence', 'An evidence observation is malformed.')
    }
    if (!Array.isArray(observation.evidence) || observation.evidence.length < 1) {
      fail('invalid-evidence', 'Every evidence observation requires support.')
    }
    const evidenceItems = observation.evidence.map((text) => Object.freeze({
      id: opaqueId('ev', nextEvidenceId++),
      text,
    }))
    return Object.freeze({
      id: opaqueId('obs', index + 1),
      priority: observation.priority,
      category: observation.category,
      title: observation.title,
      summary: observation.summary,
      evidence: Object.freeze(evidenceItems),
    })
  })

  return Object.freeze({
    schemaVersion: INSIGHT_ANALYSIS_SCHEMA_VERSION,
    mode,
    periodDays,
    generatedAt: evidence.generatedAt,
    metrics: Object.freeze({ ...evidence.metrics }),
    observations: Object.freeze(observations),
  })
}

function opaqueId(prefix, value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999) {
    fail('invalid-evidence', 'Opaque evidence capacity was exceeded.')
  }
  return `${prefix}-${String(value).padStart(3, '0')}`
}

function fail(category, message) {
  throw new InsightFactPacketBuilderError(category, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
}
