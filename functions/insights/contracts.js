import { Buffer } from 'node:buffer'

import { insightModeProfile } from './costPolicy.js'

export const INSIGHT_ANALYSIS_SCHEMA_VERSION = 1
export const INSIGHT_ANALYSIS_PERIODS = Object.freeze([7, 30, 90])
export const INSIGHT_ANALYSIS_MODES = Object.freeze(['quick', 'deep'])

const GROUP_LABELS = Object.freeze(['review-first', 'watch', 'context'])
const PRIORITIES = Object.freeze(['attention', 'notable', 'context'])
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/
const OBSERVATION_ID_PATTERN = /^obs-[0-9]{3}$/
const EVIDENCE_ID_PATTERN = /^ev-[0-9]{3}$/

export class InsightContractError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightContractError'
    this.category = category
  }
}

export function validateInsightRequest(value) {
  requireExactObject(
    value,
    ['requestId', 'mode', 'periodDays'],
    'request',
  )
  if (!REQUEST_ID_PATTERN.test(value.requestId)) {
    fail('invalid-request', 'requestId is malformed.')
  }
  if (!INSIGHT_ANALYSIS_MODES.includes(value.mode)) {
    fail('invalid-request', 'mode is unsupported.')
  }
  if (!INSIGHT_ANALYSIS_PERIODS.includes(value.periodDays)) {
    fail('invalid-request', 'periodDays is unsupported.')
  }
  return Object.freeze({
    requestId: value.requestId,
    mode: value.mode,
    periodDays: value.periodDays,
  })
}

export function validateFactPacket(value, expectedRequest) {
  const request = validateInsightRequest(expectedRequest)
  const profile = insightModeProfile(request.mode)
  requireExactObject(
    value,
    [
      'schemaVersion',
      'mode',
      'periodDays',
      'generatedAt',
      'metrics',
      'observations',
    ],
    'fact packet',
  )
  if (value.schemaVersion !== INSIGHT_ANALYSIS_SCHEMA_VERSION) {
    fail('invalid-packet', 'Fact packet schemaVersion is unsupported.')
  }
  if (
    value.mode !== request.mode ||
    value.periodDays !== request.periodDays
  ) {
    fail('invalid-packet', 'Fact packet does not match the accepted request.')
  }
  const generatedAt = requireIsoTimestamp(value.generatedAt, 'generatedAt')
  const metrics = validateMetrics(value.metrics)
  if (!Array.isArray(value.observations) || value.observations.length < 1) {
    fail('invalid-packet', 'Fact packet requires at least one observation.')
  }
  if (value.observations.length > profile.maxObservations) {
    fail('packet-too-large', 'Fact packet has too many observations.')
  }

  const observationIds = new Set()
  const evidenceIds = new Set()
  let evidenceCount = 0
  const observations = value.observations.map((observation, index) => {
    requireExactObject(
      observation,
      ['id', 'priority', 'category', 'title', 'summary', 'evidence'],
      `observations[${index}]`,
    )
    if (!OBSERVATION_ID_PATTERN.test(observation.id) || observationIds.has(observation.id)) {
      fail('invalid-packet', 'Observation IDs must be unique opaque references.')
    }
    observationIds.add(observation.id)
    if (!PRIORITIES.includes(observation.priority)) {
      fail('invalid-packet', 'Observation priority is unsupported.')
    }
    const category = boundedText(observation.category, 1, 60, 'category')
    const title = boundedText(observation.title, 1, 120, 'title')
    const summary = boundedText(observation.summary, 1, 320, 'summary')
    if (!Array.isArray(observation.evidence) || observation.evidence.length < 1) {
      fail('invalid-packet', 'Every observation requires evidence.')
    }
    const evidence = observation.evidence.map((item, evidenceIndex) => {
      requireExactObject(item, ['id', 'text'], `evidence[${evidenceIndex}]`)
      if (!EVIDENCE_ID_PATTERN.test(item.id) || evidenceIds.has(item.id)) {
        fail('invalid-packet', 'Evidence IDs must be unique opaque references.')
      }
      evidenceIds.add(item.id)
      evidenceCount += 1
      return Object.freeze({
        id: item.id,
        text: boundedText(item.text, 1, 320, 'evidence text'),
      })
    })
    return Object.freeze({
      id: observation.id,
      priority: observation.priority,
      category,
      title,
      summary,
      evidence: Object.freeze(evidence),
    })
  })
  if (evidenceCount > profile.maxEvidenceItems) {
    fail('packet-too-large', 'Fact packet has too many evidence entries.')
  }

  const packet = Object.freeze({
    schemaVersion: INSIGHT_ANALYSIS_SCHEMA_VERSION,
    mode: request.mode,
    periodDays: request.periodDays,
    generatedAt,
    metrics,
    observations: Object.freeze(observations),
  })
  if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > profile.maxInputBytes) {
    fail('packet-too-large', 'Serialized fact packet exceeds the mode limit.')
  }
  return packet
}

export function validateProviderResponse(value, packet) {
  const profile = insightModeProfile(packet.mode)
  requireExactObject(
    value,
    ['schemaVersion', 'orderedObservationIds', 'groups', 'teacherQuestions', 'usage'],
    'provider response',
  )
  if (value.schemaVersion !== INSIGHT_ANALYSIS_SCHEMA_VERSION) {
    fail('invalid-provider-output', 'Provider schemaVersion is unsupported.')
  }
  const allowedIds = new Set(packet.observations.map((observation) => observation.id))
  const orderedObservationIds = validateReferenceList(
    value.orderedObservationIds,
    allowedIds,
    'orderedObservationIds',
    { minimum: allowedIds.size, maximum: allowedIds.size },
  )
  const orderedSet = new Set(orderedObservationIds)

  if (!Array.isArray(value.groups) || value.groups.length > GROUP_LABELS.length) {
    fail('invalid-provider-output', 'groups is malformed.')
  }
  const seenLabels = new Set()
  const groupedIds = new Set()
  const groups = value.groups.map((group, index) => {
    requireExactObject(group, ['label', 'observationIds'], `groups[${index}]`)
    if (!GROUP_LABELS.includes(group.label) || seenLabels.has(group.label)) {
      fail('invalid-provider-output', 'Group labels must be unique and supported.')
    }
    seenLabels.add(group.label)
    const observationIds = validateReferenceList(
      group.observationIds,
      orderedSet,
      `groups[${index}].observationIds`,
      { minimum: 1, maximum: orderedSet.size },
    )
    for (const id of observationIds) {
      if (groupedIds.has(id)) {
        fail('invalid-provider-output', 'An observation cannot appear in multiple groups.')
      }
      groupedIds.add(id)
    }
    return Object.freeze({ label: group.label, observationIds })
  })

  if (!Array.isArray(value.teacherQuestions) || value.teacherQuestions.length > profile.maxQuestions) {
    fail('invalid-provider-output', 'teacherQuestions is malformed.')
  }
  const teacherQuestions = value.teacherQuestions.map((question, index) => {
    requireExactObject(
      question,
      ['kind', 'text', 'observationIds'],
      `teacherQuestions[${index}]`,
    )
    if (question.kind !== 'suggestion') {
      fail('invalid-provider-output', 'Teacher questions must be labeled suggestions.')
    }
    const text = boundedText(question.text, 3, 240, 'teacher question')
    if (!text.endsWith('?')) {
      fail('invalid-provider-output', 'Teacher suggestions must remain questions.')
    }
    return Object.freeze({
      kind: 'suggestion',
      text,
      observationIds: validateReferenceList(
        question.observationIds,
        orderedSet,
        `teacherQuestions[${index}].observationIds`,
        { minimum: 1, maximum: orderedSet.size },
      ),
    })
  })
  const usage = validateUsage(value.usage, profile)
  return Object.freeze({
    schemaVersion: INSIGHT_ANALYSIS_SCHEMA_VERSION,
    orderedObservationIds,
    groups: Object.freeze(groups),
    teacherQuestions: Object.freeze(teacherQuestions),
    usage,
  })
}

export function validateCompletedAnalysis(value, packet, evidenceSignature) {
  if (typeof evidenceSignature !== 'string' || !SIGNATURE_PATTERN.test(evidenceSignature)) {
    fail('invalid-replay', 'The current evidence signature is malformed.')
  }
  requireExactObject(
    value,
    [
      'schemaVersion',
      'source',
      'mode',
      'periodDays',
      'evidenceSignature',
      'generatedAt',
      'orderedObservationIds',
      'groups',
      'teacherQuestions',
      'usage',
    ],
    'completed analysis',
  )
  if (
    value.schemaVersion !== INSIGHT_ANALYSIS_SCHEMA_VERSION ||
    value.source !== 'provider-assisted' ||
    value.mode !== packet.mode ||
    value.periodDays !== packet.periodDays ||
    value.evidenceSignature !== evidenceSignature
  ) {
    fail('invalid-replay', 'Completed analysis does not match current evidence.')
  }
  requireExactObject(value.usage, ['inputTokens', 'outputTokens', 'costMicroUsd'], 'usage')
  if (!Number.isSafeInteger(value.usage.costMicroUsd) || value.usage.costMicroUsd < 0) {
    fail('invalid-replay', 'Completed analysis cost is malformed.')
  }
  const provider = validateProviderResponse({
    schemaVersion: value.schemaVersion,
    orderedObservationIds: value.orderedObservationIds,
    groups: value.groups,
    teacherQuestions: value.teacherQuestions,
    usage: {
      inputTokens: value.usage.inputTokens,
      outputTokens: value.usage.outputTokens,
    },
  }, packet)
  return Object.freeze({
    schemaVersion: INSIGHT_ANALYSIS_SCHEMA_VERSION,
    source: 'provider-assisted',
    mode: packet.mode,
    periodDays: packet.periodDays,
    evidenceSignature,
    generatedAt: requireIsoTimestamp(value.generatedAt, 'generatedAt'),
    orderedObservationIds: provider.orderedObservationIds,
    groups: provider.groups,
    teacherQuestions: provider.teacherQuestions,
    usage: Object.freeze({
      inputTokens: provider.usage.inputTokens,
      outputTokens: provider.usage.outputTokens,
      costMicroUsd: value.usage.costMicroUsd,
    }),
  })
}

export function validateTeacherAnalysisResponse(value) {
  requireExactObject(
    value,
    [
      'schemaVersion',
      'source',
      'mode',
      'periodDays',
      'generatedAt',
      'observations',
      'orderedObservationIds',
      'groups',
      'teacherQuestions',
      'usage',
    ],
    'teacher analysis response',
  )
  if (
    value.schemaVersion !== INSIGHT_ANALYSIS_SCHEMA_VERSION ||
    value.source !== 'provider-assisted' ||
    !INSIGHT_ANALYSIS_MODES.includes(value.mode) ||
    !INSIGHT_ANALYSIS_PERIODS.includes(value.periodDays)
  ) {
    fail('invalid-response', 'Teacher analysis response metadata is malformed.')
  }
  const profile = insightModeProfile(value.mode)
  const generatedAt = requireIsoTimestamp(value.generatedAt, 'generatedAt')
  if (
    !Array.isArray(value.observations) ||
    value.observations.length < 1 ||
    value.observations.length > profile.maxObservations
  ) {
    fail('invalid-response', 'Teacher analysis response observations are malformed.')
  }
  const observationIds = new Set()
  const observations = value.observations.map((observation, index) => {
    requireExactObject(
      observation,
      ['id', 'priority', 'category', 'title', 'summary', 'evidence'],
      `teacher observations[${index}]`,
    )
    if (!OBSERVATION_ID_PATTERN.test(observation.id) || observationIds.has(observation.id)) {
      fail('invalid-response', 'Teacher observation IDs must be unique opaque references.')
    }
    observationIds.add(observation.id)
    if (!PRIORITIES.includes(observation.priority)) {
      fail('invalid-response', 'Teacher observation priority is unsupported.')
    }
    return Object.freeze({
      id: observation.id,
      priority: observation.priority,
      category: boundedText(observation.category, 1, 60, 'teacher category'),
      title: boundedText(observation.title, 1, 120, 'teacher title'),
      summary: boundedText(observation.summary, 1, 320, 'teacher summary'),
      evidence: boundedText(observation.evidence, 1, 320, 'teacher evidence'),
    })
  })
  requireExactObject(value.usage, ['inputTokens', 'outputTokens', 'costMicroUsd'], 'usage')
  if (!Number.isSafeInteger(value.usage.costMicroUsd) || value.usage.costMicroUsd < 0) {
    fail('invalid-response', 'Teacher analysis response cost is malformed.')
  }
  const provider = validateProviderResponse({
    schemaVersion: value.schemaVersion,
    orderedObservationIds: value.orderedObservationIds,
    groups: value.groups,
    teacherQuestions: value.teacherQuestions,
    usage: {
      inputTokens: value.usage.inputTokens,
      outputTokens: value.usage.outputTokens,
    },
  }, { mode: value.mode, observations })
  return Object.freeze({
    schemaVersion: INSIGHT_ANALYSIS_SCHEMA_VERSION,
    source: 'provider-assisted',
    mode: value.mode,
    periodDays: value.periodDays,
    generatedAt,
    observations: Object.freeze(observations),
    orderedObservationIds: provider.orderedObservationIds,
    groups: provider.groups,
    teacherQuestions: provider.teacherQuestions,
    usage: Object.freeze({
      inputTokens: provider.usage.inputTokens,
      outputTokens: provider.usage.outputTokens,
      costMicroUsd: value.usage.costMicroUsd,
    }),
  })
}

function validateMetrics(value) {
  requireExactObject(
    value,
    ['studentCount', 'transactionCount', 'approvedCount', 'pendingCount', 'totalClassCash'],
    'metrics',
  )
  for (const key of ['studentCount', 'transactionCount', 'approvedCount', 'pendingCount']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail('invalid-packet', `${key} must be a non-negative safe integer.`)
    }
  }
  if (typeof value.totalClassCash !== 'number' || !Number.isFinite(value.totalClassCash)) {
    fail('invalid-packet', 'totalClassCash must be finite.')
  }
  return Object.freeze({
    studentCount: value.studentCount,
    transactionCount: value.transactionCount,
    approvedCount: value.approvedCount,
    pendingCount: value.pendingCount,
    totalClassCash: value.totalClassCash,
  })
}

function validateUsage(value, profile) {
  requireExactObject(value, ['inputTokens', 'outputTokens'], 'usage')
  for (const key of ['inputTokens', 'outputTokens']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail('invalid-provider-output', `${key} must be a non-negative safe integer.`)
    }
  }
  if (value.outputTokens > profile.maxOutputTokens) {
    fail('invalid-provider-output', 'Provider output exceeds the configured token limit.')
  }
  return Object.freeze({ inputTokens: value.inputTokens, outputTokens: value.outputTokens })
}

function validateReferenceList(value, allowed, label, { minimum, maximum }) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail('invalid-provider-output', `${label} has an invalid length.`)
  }
  const seen = new Set()
  const normalized = value.map((id) => {
    if (typeof id !== 'string' || !allowed.has(id) || seen.has(id)) {
      fail('invalid-provider-output', `${label} contains an unknown or duplicate reference.`)
    }
    seen.add(id)
    return id
  })
  return Object.freeze(normalized)
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== 'string') fail('invalid-packet', `${label} is malformed.`)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail('invalid-packet', `${label} must be a canonical ISO timestamp.`)
  }
  return value
}

function boundedText(value, minimum, maximum, label) {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value ||
    containsDisallowedControl(value)
  ) {
    fail('invalid-text', `${label} is malformed.`)
  }
  return value
}

function containsDisallowedControl(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint === 0x7f ||
      (codePoint >= 0 && codePoint <= 0x08) ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f)
    ) return true
  }
  return false
}

function requireExactObject(value, expectedKeys, label) {
  if (!isPlainObject(value)) fail('invalid-shape', `${label} must be a plain object.`)
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail('invalid-shape', `${label} fields do not match the contract.`)
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(category, message) {
  throw new InsightContractError(category, message)
}
