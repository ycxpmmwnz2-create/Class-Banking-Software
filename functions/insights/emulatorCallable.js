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
      const subjectAliases = providerInput.subjectAliases
      const category = providerInput.categoryCatalog.find(candidate => {
        const label = candidate.label.toLocaleLowerCase('en-US')
        return (/(restroom|bathroom)/.test(normalized) && /(restroom|bathroom)/.test(label)) ||
          label.split(/[^a-z0-9]+/).filter(token => token.length >= 4).some(token => normalized.includes(token))
      })
      let plan = null
      let guidance = null
      const asksToChangeData = /^(?:please\s+)?(?:change|set|delete|transfer|freeze|unfreeze|approve|deny)\b/.test(normalized)
      if (asksToChangeData) {
        // The production contract routes data mutations to unsupported. Keep the
        // browser double honest instead of accidentally treating "change every
        // balance" as a read-only balance query.
      } else if (
        /(?:list|show|give)(?:\s+for\s+me)?\s+(?:each|every|all)/.test(normalized) &&
        /student/.test(normalized) && /balance/.test(normalized)
      ) {
        plan = { operation: 'list-student-balances' }
      } else if (/(did not|didn't|not pay|unpaid)/.test(normalized) && /rent/.test(normalized)) {
        const amount = normalized.match(/\$\s*(\d+(?:\.\d+)?)/)?.[1]
        plan = {
          operation: 'students-without-transactions',
          subjectAliases,
          categoryAlias: null,
          purpose: 'rent',
          transactionType: 'Subtract',
          status: 'Approved',
          dateScope: /today/.test(normalized) ? 'today' : 'period',
          amountExact: amount ? Number(amount) : null,
          studentState: 'any',
          limit: 8,
        }
      } else if (category && /(who|which student)/.test(normalized)) {
        plan = queryPlan({
          metric: /(money|amount|dollar)/.test(normalized) ? 'amount-total' : 'count',
          categoryAlias: category.alias,
          transactionType: 'Subtract',
          groupBy: 'student',
        })
      } else if (/categor/.test(normalized) && /(earn|add|gain)/.test(normalized)) {
        plan = queryPlan({ subjectAliases, transactionType: 'Add', groupBy: 'category' })
      } else if (/categor/.test(normalized) && /(spend|spent|los|subtract)/.test(normalized)) {
        plan = queryPlan({ subjectAliases, transactionType: 'Subtract', groupBy: 'category' })
      } else if (/(time|hour|day)/.test(normalized) && /(spend|spent|los|subtract)/.test(normalized)) {
        plan = queryPlan({ subjectAliases, transactionType: 'Subtract', groupBy: 'time-of-day' })
      } else if (/(time|hour|day)/.test(normalized) && /(earn|add|gain)/.test(normalized)) {
        plan = queryPlan({ subjectAliases, transactionType: 'Add', groupBy: 'time-of-day' })
      } else if (/(how many students|student count|class size)/.test(normalized)) {
        plan = {
          dataset: 'students',
          metric: 'count',
          filters: {
            subjectAliases: [],
            categoryAlias: null,
            transactionType: 'any',
            status: 'any',
            timeBucket: null,
            studentState: /frozen/.test(normalized) ? 'frozen' : 'any',
          },
          groupBy: 'none',
          order: 'highest',
          limit: 1,
        }
      } else if (/balance/.test(normalized)) {
        plan = {
          dataset: 'students',
          metric: /average|mean/.test(normalized) ? 'average-balance' : 'current-balance',
          filters: {
            subjectAliases,
            categoryAlias: null,
            transactionType: 'any',
            status: 'any',
            timeBucket: null,
            studentState: /frozen/.test(normalized) ? 'frozen' : 'any',
          },
          groupBy: /average|mean/.test(normalized) ? 'none' : 'student',
          order: /lowest/.test(normalized) ? 'lowest' : 'highest',
          limit: subjectAliases.length ? 1 : 8,
        }
      } else if (/pending/.test(normalized)) {
        plan = queryPlan({ metric: 'count', status: 'Pending', groupBy: 'none' })
      } else if (
        /(?:how|ideas|explain|help|routine|strategy)/.test(normalized) &&
        /(?:morgan bank|classroom econom|saving|rent|balance|categor|transaction|student account)/.test(normalized)
      ) {
        guidance = 'Set a small, visible savings goal, use consistent earning categories, and celebrate progress without comparing students. Review balances privately and let students choose how much to save before optional classroom purchases.'
      }
      if (
        plan &&
        /(?:and|then).*(?:what should|how can|ideas|strategy|help)/.test(normalized)
      ) {
        guidance = 'Review the result privately, ask students to set a realistic next goal, and use consistent earning opportunities rather than public comparisons or automatic penalties.'
      }
      return {
        schemaVersion: 4,
        kind: plan && guidance ? 'query-and-guidance' : plan ? 'query' : guidance ? 'guidance' : 'unsupported',
        plan,
        guidance,
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

function queryPlan({
  metric = 'amount-total',
  subjectAliases = [],
  categoryAlias = null,
  transactionType = 'any',
  status = 'Approved',
  groupBy = 'none',
} = {}) {
  return {
    dataset: 'transactions',
    metric,
    filters: { subjectAliases, categoryAlias, transactionType, status, timeBucket: null, studentState: 'any' },
    groupBy,
    order: 'highest',
    limit: 1,
  }
}

function isLoopbackHost(value) {
  const match = typeof value === 'string' ? LOOPBACK_HOST_PATTERN.exec(value) : null
  return Boolean(match && Number(value.slice(value.lastIndexOf(':') + 1)) <= 65_535)
}
