import { createInsightAnalysisService } from './analysisService.js'
import { buildFactPacketFromEvidence } from './factPacketBuilder.js'
import { createFirestoreUsageLedger } from './firestoreUsageLedger.js'
import { createFirestoreTenantEvidenceLoader } from './tenantEvidenceAdapter.js'
import { resolveActiveTeacherTenant } from '../phase2b/teacherTenantResolver.js'

export const VERSION3_GEMINI_CALLABLE_DEMO_PROJECT =
  'demo-morgan-bank-version3-gemini-callable-browser'

const LOOPBACK_HOST_PATTERN = /^(?:127\.0\.0\.1|localhost):(?:[1-9][0-9]{0,4})$/
const FAKE_RATE_CARD_ID = 'fake-emulator-rate-v2'
const FAKE_WORST_CASE_COST_MICRO_USD = 4_000_000
const FAKE_ACTUAL_COST_MICRO_USD = 3_000_000
const CLIENT_RESERVATION_CATEGORIES = Object.freeze(new Set([
  'allowance-exhausted',
  'rate-limit-exhausted',
  'request-unavailable',
]))
const LOG_CATEGORIES = Object.freeze(new Set([
  'allowance-exhausted',
  'authorization-failed',
  'budget-unavailable',
  'cost-policy-unavailable',
  'evidence-not-deidentified',
  'evidence-unavailable',
  'invalid-replay',
  'invalid-request',
  'invalid-runtime',
  'invalid-shape',
  'invalid-time',
  'provider-output-invalid',
  'provider-unavailable',
  'rate-limit-exhausted',
  'request-unavailable',
  'usage-invalid',
]))

export class Version3GeminiEmulatorError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'Version3GeminiEmulatorError'
    this.category = category
  }
}

export function assertVersion3GeminiEmulatorRuntime({
  environment,
  projectId,
  adminAppCount,
  adminProjectId,
}) {
  if (
    !environment ||
    environment.VERSION3_GEMINI_EMULATOR_ENABLED !== 'true' ||
    environment.FUNCTIONS_EMULATOR !== 'true' ||
    projectId !== VERSION3_GEMINI_CALLABLE_DEMO_PROJECT ||
    adminAppCount !== 1 ||
    adminProjectId !== VERSION3_GEMINI_CALLABLE_DEMO_PROJECT ||
    !isLoopbackHost(environment.FIRESTORE_EMULATOR_HOST) ||
    !isLoopbackHost(environment.FIREBASE_AUTH_EMULATOR_HOST)
  ) {
    throw new Version3GeminiEmulatorError(
      'invalid-runtime',
      'Version 3 Gemini emulator analysis is disabled.',
    )
  }
  return Object.freeze({ projectId })
}

export function createVersion3GeminiEmulatorHandler({
  firestore,
  calculateReport,
  now = () => new Date(),
}) {
  if (typeof calculateReport !== 'function') {
    throw new TypeError('calculateReport must be a function.')
  }
  const loadEvidence = createFirestoreTenantEvidenceLoader({
    firestore,
    calculateReport,
    now,
  })
  const usageLedger = createFirestoreUsageLedger({
    firestore,
    now: () => now().getTime(),
  })
  const provider = Object.freeze({
    async generate({ factPacket }) {
      const orderedObservationIds = factPacket.observations.map(observation => observation.id)
      return {
        schemaVersion: 2,
        orderedObservationIds,
        groups: [{ label: 'review-first', observationIds: orderedObservationIds }],
        teacherQuestions: [{
          kind: 'suggestion',
          text: 'Would reviewing these verified observations help?',
          observationIds: orderedObservationIds,
        }],
        usage: { inputTokens: 120, outputTokens: 30, thinkingTokens: 0 },
      }
    },
  })
  return createInsightAnalysisService({
    now,
    resolveActiveTeacherTenant: ({ auth }) => resolveActiveTeacherTenant({ firestore, auth }),
    loadDeidentifiedTenantEvidence: loadEvidence,
    buildFactPacket: buildFactPacketFromEvidence,
    async quoteWorstCaseCost() {
      return {
        rateCardId: FAKE_RATE_CARD_ID,
        worstCaseCostMicroUsd: FAKE_WORST_CASE_COST_MICRO_USD,
      }
    },
    provider,
    async priceActualUsage() {
      return FAKE_ACTUAL_COST_MICRO_USD
    },
    usageLedger,
  })
}

export function callableErrorCode(error) {
  const category = typeof error?.category === 'string' ? error.category : ''
  if (category === 'authorization-failed') return 'unauthenticated'
  if (category === 'invalid-request' || category === 'invalid-shape') return 'invalid-argument'
  if (
    category === 'allowance-exhausted' ||
    category === 'budget-unavailable' ||
    category === 'rate-limit-exhausted'
  ) return 'resource-exhausted'
  if (category === 'request-unavailable') return 'failed-precondition'
  if (category === 'provider-unavailable') return 'unavailable'
  if (category === 'invalid-runtime' || category === 'invalid-replay') return 'failed-precondition'
  return 'internal'
}

export function callableErrorDetails(error) {
  const category = typeof error?.category === 'string' ? error.category : ''
  if (!CLIENT_RESERVATION_CATEGORIES.has(category)) return undefined
  return Object.freeze({ category })
}

export function callableLogCategory(error) {
  return LOG_CATEGORIES.has(error?.category) ? error.category : 'internal'
}

function isLoopbackHost(value) {
  const match = typeof value === 'string' ? LOOPBACK_HOST_PATTERN.exec(value) : null
  return Boolean(match && Number(value.slice(value.lastIndexOf(':') + 1)) <= 65_535)
}
