import { CONVERSATIONAL_ANSWER_CONTRACT } from './conversationContract.js'
import { createInsightAnalysisService } from './analysisService.js'
import { buildClassInsightsReport } from './classInsights.js'
import { buildFactPacketFromEvidence } from './factPacketBuilder.js'
import { createFirestoreUsageLedger } from './firestoreUsageLedger.js'
import {
  priceGeminiActualUsage,
  quoteGeminiWorstCaseCost,
} from './geminiCostPolicy.js'
import { createGeminiProviderAdapter } from './geminiProviderAdapter.js'
import { createConversationalClassroomAssistant } from './geminiClassroomAssistant.js'
import { createGeminiQuestionAdapter } from './geminiQuestionAdapter.js'
import {
  priceGeminiQuestionActualUsage,
  quoteGeminiQuestionWorstCaseCost,
} from './geminiQuestionCostPolicy.js'
import {
  priceGeminiToolAssistantActualUsage,
  quoteGeminiToolAssistantWorstCaseCost,
  quoteConversationalWorstCaseCost,
} from './geminiToolAssistantCostPolicy.js'
import {
  createGeminiGenerateContent,
  createGeminiGenerateContentOnce,
} from './geminiTransport.js'
import { createFirestoreQuestionEvidenceLoader } from './questionEvidenceAdapter.js'
import { createInsightQuestionService } from './questionService.js'
import { createInsightToolQuestionService } from './toolQuestionService.js'
import { createFirestoreTenantEvidenceLoader } from './tenantEvidenceAdapter.js'
import { createInsightRequestScope } from './insightAccess.js'

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
  const generateContent = toolAssistantEnabled
    ? createGeminiGenerateContent({ apiKey, GoogleGenAIClass, maxAttempts: 1 }) : null
  const loadQuestionEvidence = createFirestoreQuestionEvidenceLoader({ firestore, now })

  return async function handleVersion3AiRequest(request) {
    const scope = await createInsightRequestScope({ firestore, auth: request?.auth, usageLedger })
    const scopedGenerateOnce = input => scope.dispatch(() => generateContentOnce(input))
    const shared = {
      now,
      resolveActiveTeacherTenant: async () => scope.identity,
      usageLedger: scope.ledger,
    }
    const analyzeInsights = createInsightAnalysisService({
      ...shared,
      loadDeidentifiedTenantEvidence: input => scope.load(loadEvidence, input),
      buildFactPacket: buildFactPacketFromEvidence,
      quoteWorstCaseCost: quoteGeminiWorstCaseCost,
      provider: createGeminiProviderAdapter({ generateContentOnce: scopedGenerateOnce }),
      priceActualUsage: priceGeminiActualUsage,
    })
    const askQuestion = createInsightQuestionService({
      ...shared,
      loadQuestionEvidence: input => scope.load(loadQuestionEvidence, input),
      quoteWorstCaseCost: quoteGeminiQuestionWorstCaseCost,
      provider: createGeminiQuestionAdapter({ generateContentOnce: scopedGenerateOnce }),
      priceActualUsage: priceGeminiQuestionActualUsage,
    })
    const assistant = toolAssistantEnabled ? createConversationalClassroomAssistant({
      // Every model turn and optional narration gets its own durable claim.
      generateContent: input => scope.dispatch(() => generateContent(input)),
    }) : null
    const askQuestionWithTools = toolAssistantEnabled ? createInsightToolQuestionService({
      ...shared,
      loadQuestionEvidence: input => scope.load(loadQuestionEvidence, input),
      answerContract: CONVERSATIONAL_ANSWER_CONTRACT,
      quoteWorstCaseCost: quoteConversationalWorstCaseCost,
      quoteBaseWorstCaseCost: quoteGeminiToolAssistantWorstCaseCost,
      assistant: { answer: input => assistant.answer({ ...input, beforeTool: scope.assertActive }) },
      priceActualUsage: priceGeminiToolAssistantActualUsage,
    }) : null
    const result = await (request?.data?.kind === 'question'
      ? (toolAssistantEnabled ? askQuestionWithTools(request) : askQuestion(request))
      : analyzeInsights(request))
    // Includes completed-result replay and deterministic/narration fallbacks.
    await scope.assertActive()
    return result
  }
}
