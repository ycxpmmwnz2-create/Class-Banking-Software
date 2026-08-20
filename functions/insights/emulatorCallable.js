import { createInsightAnalysisService } from './analysisService.js'
import { buildFactPacketFromEvidence } from './factPacketBuilder.js'
import { createFirestoreUsageLedger } from './firestoreUsageLedger.js'
import { createFirestoreTenantEvidenceLoader } from './tenantEvidenceAdapter.js'
import { createFirestoreQuestionEvidenceLoader } from './questionEvidenceAdapter.js'
import { createInsightQuestionService } from './questionService.js'
import { resolveActiveTeacherTenant } from '../phase2b/teacherTenantResolver.js'

export {
  callableErrorCode,
  callableErrorDetails,
  callableLogCategory,
} from './callableErrors.js'

export const VERSION3_GEMINI_CALLABLE_DEMO_PROJECT =
  'demo-morgan-bank-version3-gemini-callable-browser'

const LOOPBACK_HOST_PATTERN = /^(?:127\.0\.0\.1|localhost):(?:[1-9][0-9]{0,4})$/
const FAKE_RATE_CARD_ID = 'fake-emulator-rate-v2'
const FAKE_WORST_CASE_COST_MICRO_USD = 4_000_000
const FAKE_ACTUAL_COST_MICRO_USD = 3_000_000

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
  const analyzeInsights = createInsightAnalysisService({
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
  const loadQuestionEvidence = createFirestoreQuestionEvidenceLoader({ firestore, now })
  const questionProvider = Object.freeze({
    async interpret({ providerInput }) {
      const normalized = providerInput.question.toLocaleLowerCase('en-US')
      const subjectAlias = providerInput.subjectAliases[0] || null
      let intent = 'unsupported'
      if (/categor/.test(normalized) && /(earn|add|gain)/.test(normalized)) {
        intent = subjectAlias ? 'student-top-earning-category' : 'class-top-earning-category'
      } else if (/categor/.test(normalized) && /(spend|spent|los|subtract)/.test(normalized)) {
        intent = subjectAlias ? 'student-top-spending-category' : 'class-top-spending-category'
      } else if (/(time|hour|day)/.test(normalized) && /(spend|spent|los|subtract)/.test(normalized)) {
        intent = subjectAlias ? 'student-peak-spending-time' : 'class-peak-spending-time'
      } else if (/(time|hour|day)/.test(normalized) && /(earn|add|gain)/.test(normalized)) {
        intent = subjectAlias ? 'student-peak-earning-time' : 'class-peak-earning-time'
      } else if (/balance/.test(normalized) && subjectAlias) {
        intent = 'student-current-balance'
      } else if (/pending/.test(normalized)) {
        intent = 'pending-request-count'
      }
      return {
        schemaVersion: 1,
        intent,
        subjectAlias: intent.startsWith('student-') ? subjectAlias : null,
        usage: { inputTokens: 90, outputTokens: 18, thinkingTokens: 0 },
      }
    },
  })
  const askQuestion = createInsightQuestionService({
    now,
    resolveActiveTeacherTenant: ({ auth }) => resolveActiveTeacherTenant({ firestore, auth }),
    loadQuestionEvidence,
    async quoteWorstCaseCost() {
      return {
        rateCardId: FAKE_RATE_CARD_ID,
        worstCaseCostMicroUsd: FAKE_WORST_CASE_COST_MICRO_USD,
      }
    },
    provider: questionProvider,
    async priceActualUsage() {
      return FAKE_ACTUAL_COST_MICRO_USD
    },
    usageLedger,
  })
  return async function handleVersion3AiRequest(request) {
    return request?.data?.kind === 'question'
      ? askQuestion(request)
      : analyzeInsights(request)
  }
}

function isLoopbackHost(value) {
  const match = typeof value === 'string' ? LOOPBACK_HOST_PATTERN.exec(value) : null
  return Boolean(match && Number(value.slice(value.lastIndexOf(':') + 1)) <= 65_535)
}
