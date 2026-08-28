import { createInsightAnalysisService } from './analysisService.js'
import { buildClassInsightsReport } from './classInsights.js'
import { buildFactPacketFromEvidence } from './factPacketBuilder.js'
import { createFirestoreUsageLedger } from './firestoreUsageLedger.js'
import {
  priceGeminiActualUsage,
  quoteGeminiWorstCaseCost,
} from './geminiCostPolicy.js'
import { createGeminiProviderAdapter } from './geminiProviderAdapter.js'
import { createGeminiClassroomAssistant } from './geminiClassroomAssistant.js'
import { createGeminiQuestionAdapter } from './geminiQuestionAdapter.js'
import {
  priceGeminiQuestionActualUsage,
  quoteGeminiQuestionWorstCaseCost,
} from './geminiQuestionCostPolicy.js'
import {
  priceGeminiToolAssistantActualUsage,
  quoteGeminiToolAssistantWorstCaseCost,
} from './geminiToolAssistantCostPolicy.js'
import {
  createGeminiGenerateContent,
  createGeminiGenerateContentOnce,
} from './geminiTransport.js'
import { createFirestoreQuestionEvidenceLoader } from './questionEvidenceAdapter.js'
import { createInsightQuestionService } from './questionService.js'
import { createInsightToolQuestionService } from './toolQuestionService.js'
import { createFirestoreTenantEvidenceLoader } from './tenantEvidenceAdapter.js'
import { resolveActiveTeacherTenant } from '../phase2b/teacherTenantResolver.js'

export function createVersion3GeminiLiveHandler({
  firestore,
  apiKey,
  GoogleGenAIClass,
  toolAssistantEnabled = false,
  now = () => new Date(),
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function.')
  const loadEvidence = createFirestoreTenantEvidenceLoader({
    firestore,
    calculateReport: buildClassInsightsReport,
    now,
  })
  const usageLedger = createFirestoreUsageLedger({
    firestore,
    now: () => now().getTime(),
  })
  const generateContentOnce = createGeminiGenerateContentOnce({ apiKey, GoogleGenAIClass })
  const provider = createGeminiProviderAdapter({ generateContentOnce })
  const questionProvider = createGeminiQuestionAdapter({ generateContentOnce })
  const loadQuestionEvidence = createFirestoreQuestionEvidenceLoader({ firestore, now })

  const analyzeInsights = createInsightAnalysisService({
    now,
    resolveActiveTeacherTenant: ({ auth }) => resolveActiveTeacherTenant({ firestore, auth }),
    loadDeidentifiedTenantEvidence: loadEvidence,
    buildFactPacket: buildFactPacketFromEvidence,
    quoteWorstCaseCost: quoteGeminiWorstCaseCost,
    provider,
    priceActualUsage: priceGeminiActualUsage,
    usageLedger,
  })
  const askQuestion = createInsightQuestionService({
    now,
    resolveActiveTeacherTenant: ({ auth }) => resolveActiveTeacherTenant({ firestore, auth }),
    loadQuestionEvidence,
    quoteWorstCaseCost: quoteGeminiQuestionWorstCaseCost,
    provider: questionProvider,
    priceActualUsage: priceGeminiQuestionActualUsage,
    usageLedger,
  })
  const askQuestionWithTools = toolAssistantEnabled
    ? createInsightToolQuestionService({
      now,
      resolveActiveTeacherTenant: ({ auth }) => resolveActiveTeacherTenant({ firestore, auth }),
      loadQuestionEvidence,
      quoteWorstCaseCost: quoteGeminiToolAssistantWorstCaseCost,
      assistant: createGeminiClassroomAssistant({
        generateContent: createGeminiGenerateContent({ apiKey, GoogleGenAIClass }),
      }),
      priceActualUsage: priceGeminiToolAssistantActualUsage,
      usageLedger,
    })
    : null

  return async function handleVersion3AiRequest(request) {
    return request?.data?.kind === 'question'
      ? (toolAssistantEnabled ? askQuestionWithTools(request) : askQuestion(request))
      : analyzeInsights(request)
  }
}
