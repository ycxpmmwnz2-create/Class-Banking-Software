import { createInsightAnalysisService } from './analysisService.js'
import { buildFactPacketFromEvidence } from './factPacketBuilder.js'
import { createFirestoreUsageLedger } from './firestoreUsageLedger.js'
import { createFirestoreTenantEvidenceLoader } from './tenantEvidenceAdapter.js'
import { createFirestoreQuestionEvidenceLoader } from './questionEvidenceAdapter.js'
import { INSIGHT_QUERY_PLAN_SCHEMA_VERSION } from './questionContracts.js'
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

function classifyMoneyDirection(normalized) {
  return Object.freeze({
    added: /\b(?:earn(?:ed|ing)?|add(?:ed|ing)?|gain(?:ed|ing)?|credit(?:ed|ing)?|receive(?:d|ing)?)\b|\b(?:give|gave|given|pay|paid|paying)\s+(?:out\s+)?money\b|\bmoney\s+(?:is|was|gets?|got|being)?\s*(?:given|paid|credited|added|earned|received)\b/.test(normalized),
    subtracted: /\b(?:spend|spent|spending|subtract(?:ed|ing)?|deduct(?:ed|ing)?|remove(?:d|ing)?|los(?:e|t|ing))\b|\b(?:take|took|taken|taking)\s+(?:away\s+)?money\b|\bmoney\s+(?:is|was|gets?|got|being)?\s*(?:taken|subtracted|deducted|removed|spent)\b/.test(normalized),
  })
}

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
      const asksWhen = /\b(?:when|time|hour|morning|afternoon|evening|night|day)\b/.test(normalized)
      const moneyDirection = classifyMoneyDirection(normalized)
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
          lookbackDays: null,
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
      } else if (
        category && /\b(?:did|whether|has|submit(?:ted)?|request(?:ed)?|attempt(?:ed)?|paid|credit(?:ed)?|earn(?:ed)?|receive(?:d)?)\b/.test(normalized) &&
        /(today|yesterday|this week|current week|week to date)/.test(normalized)
      ) {
        const hasToday = /today/.test(normalized)
        const hasYesterday = /yesterday/.test(normalized)
        const hasThisWeek = /(this week|current week|week to date)/.test(normalized)
        const approvedOnly = /\b(?:paid|credit(?:ed)?|earn(?:ed)?|receive(?:d)?)\b/.test(normalized)
        const compareDistinctDays = hasThisWeek && /(?:all\s+(?:three|3)|how many)\s+days|just yesterday/.test(normalized)
        plan = queryPlan({
          metric: compareDistinctDays ? 'distinct-days' : 'count',
          subjectAliases,
          categoryAlias: category.alias,
          transactionType: 'Add',
          status: approvedOnly ? 'Approved' : 'any',
          dateScope: hasThisWeek
            ? 'this-week'
            : hasToday && hasYesterday
              ? 'today-and-yesterday'
              : hasYesterday ? 'yesterday' : 'today',
          groupBy: compareDistinctDays ? 'none' : 'calendar-day',
          order: compareDistinctDays ? 'highest' : 'chronological',
          limit: compareDistinctDays ? 1 : hasThisWeek ? 7 : hasToday && hasYesterday ? 2 : 1,
        })
      } else if (/categor/.test(normalized) && moneyDirection.added) {
        plan = queryPlan({ subjectAliases, transactionType: 'Add', groupBy: 'category' })
      } else if (/categor/.test(normalized) && moneyDirection.subtracted) {
        plan = queryPlan({ subjectAliases, transactionType: 'Subtract', groupBy: 'category' })
      } else if (asksWhen && moneyDirection.subtracted) {
        plan = queryPlan({ subjectAliases, transactionType: 'Subtract', groupBy: 'time-of-day' })
      } else if (asksWhen && moneyDirection.added) {
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
            dateScope: 'period',
            timeBucket: null,
            studentState: /frozen/.test(normalized) ? 'frozen' : 'any',
          },
          groupBy: 'none',
          order: 'highest',
          limit: 1,
        }
      } else if (/balance/.test(normalized) && /(?:last|past|over|across)\s+\d+\s+days/.test(normalized) && subjectAliases.length === 1) {
        const lookbackDays = Number(normalized.match(/(?:last|past|over|across)\s+(\d+)\s+days/)?.[1])
        plan = {
          operation: 'analyze',
          queries: [{
            dataset: 'balance-history',
            metric: 'closing-balance',
            filters: {
              subjectAliases,
              categoryAlias: null,
              transactionType: 'any',
              status: 'any',
              dateScope: 'period',
              lookbackDays,
              timeBucket: null,
              studentState: 'any',
              balanceCondition: 'any',
            },
            groupBy: 'calendar-day',
            order: 'chronological',
            limit: lookbackDays,
          }],
        }
      } else if (/balance/.test(normalized)) {
        const negative = /negative|below\s+(?:zero|\$?0)|under\s+\$?0/.test(normalized)
        plan = {
          dataset: 'students',
          metric: /average|mean/.test(normalized) ? 'average-balance' : 'current-balance',
          filters: {
            subjectAliases,
            categoryAlias: null,
            transactionType: 'any',
            status: 'any',
            dateScope: 'period',
            lookbackDays: null,
            timeBucket: null,
            studentState: /frozen/.test(normalized) ? 'frozen' : 'any',
            balanceCondition: negative ? 'negative' : 'any',
          },
          groupBy: /average|mean/.test(normalized) ? 'none' : 'student',
          order: negative || /lowest/.test(normalized) ? 'lowest' : 'highest',
          limit: negative ? 500 : subjectAliases.length ? 1 : 8,
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
        schemaVersion: INSIGHT_QUERY_PLAN_SCHEMA_VERSION,
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
  dateScope = 'period',
  groupBy = 'none',
  order = 'highest',
  limit = 1,
} = {}) {
  return {
    dataset: 'transactions',
    metric,
    filters: {
      subjectAliases,
      categoryAlias,
      transactionType,
      status,
      dateScope,
      lookbackDays: null,
      timeBucket: null,
      studentState: 'any',
      balanceCondition: 'any',
    },
    groupBy,
    order,
    limit,
  }
}

function isLoopbackHost(value) {
  const match = typeof value === 'string' ? LOOPBACK_HOST_PATTERN.exec(value) : null
  return Boolean(match && Number(value.slice(value.lastIndexOf(':') + 1)) <= 65_535)
}
