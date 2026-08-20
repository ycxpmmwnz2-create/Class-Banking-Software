import { createInsightAnalysisService } from './analysisService.js'
import { buildClassInsightsReport } from './classInsights.js'
import { buildFactPacketFromEvidence } from './factPacketBuilder.js'
import { createFirestoreUsageLedger } from './firestoreUsageLedger.js'
import {
  priceGeminiActualUsage,
  quoteGeminiWorstCaseCost,
} from './geminiCostPolicy.js'
import { createGeminiProviderAdapter } from './geminiProviderAdapter.js'
import { createGeminiGenerateContentOnce } from './geminiTransport.js'
import { createFirestoreTenantEvidenceLoader } from './tenantEvidenceAdapter.js'
import { resolveActiveTeacherTenant } from '../phase2b/teacherTenantResolver.js'

export function createVersion3GeminiLiveHandler({
  firestore,
  apiKey,
  GoogleGenAIClass,
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
  const provider = createGeminiProviderAdapter({
    generateContentOnce: createGeminiGenerateContentOnce({
      apiKey,
      GoogleGenAIClass,
    }),
  })

  return createInsightAnalysisService({
    now,
    resolveActiveTeacherTenant: ({ auth }) => resolveActiveTeacherTenant({ firestore, auth }),
    loadDeidentifiedTenantEvidence: loadEvidence,
    buildFactPacket: buildFactPacketFromEvidence,
    quoteWorstCaseCost: quoteGeminiWorstCaseCost,
    provider,
    priceActualUsage: priceGeminiActualUsage,
    usageLedger,
  })
}
