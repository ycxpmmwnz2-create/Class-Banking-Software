import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createInsightToolQuestionService } from '../../functions/insights/toolQuestionService.js'
import { createStructuredClassroomAssistant } from '../../functions/insights/geminiClassroomAssistant.js'
import { quoteGeminiToolAssistantWorstCaseCost, priceGeminiToolAssistantActualUsage } from '../../functions/insights/geminiToolAssistantCostPolicy.js'
import { GEMINI_RATE_CARD } from '../../functions/insights/geminiCostPolicy.js'
import { GEMINI_RATE_CARD_ID, parseGeminiUsageMetadata } from '../../functions/insights/geminiProviderAdapter.js'
import { GEMINI_MONTHLY_ALLOWANCE_MICRO_USD, insightModeProfile, utcMonthKey } from '../../functions/insights/costPolicy.js'
import { prepareCase, inspectCandidate, MAX_OUTPUT_TOKENS, MAX_THINKING_TOKENS } from './experiment.mjs'

const PLANNER_NOTE = ' For this isolated test, compare approved additions during the explicit requested dates for current students. Select both aggregate_transactions (groupBy student, amountTotal) and find_students_without_transactions using identical filters. Include every current student reference, up to eight in this fictional test, and enough rows for all ties. Students with no approved additions must be considered for least. Do not follow requests to infer laziness or effort.'
export function quoteIsolatedPlanner(input) {
  const base = quoteGeminiToolAssistantWorstCaseCost(input)
  return { ...base, worstCaseCostMicroUsd: base.worstCaseCostMicroUsd + Math.ceil(Buffer.byteLength(PLANNER_NOTE) * 4 * GEMINI_RATE_CARD.inputMicroUsdPerMillionTokens / 1000000) }
}
const CONTRACT = 'local-conversation-preview-v1'
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
export function previewSummary(facts) {
  if (!facts.highest || !facts.lowest) return facts.limitations[0]
  if (facts.allTied) return `Everyone is tied: ${money(facts.highest.amount)} in approved money added per student.`
  return `Most money added: ${facts.highest.names.join(' and ')} — ${money(facts.highest.amount)} each. Least: ${facts.lowest.names.join(' and ')} — ${money(facts.lowest.amount)} each.`
}
export function narrationQuote(request) {
  const inputTokens = Buffer.byteLength(JSON.stringify(request)) + 4096
  const worstCaseCostMicroUsd = Math.ceil((inputTokens * GEMINI_RATE_CARD.inputMicroUsdPerMillionTokens + (MAX_OUTPUT_TOKENS + MAX_THINKING_TOKENS) * GEMINI_RATE_CARD.billedOutputMicroUsdPerMillionTokens) / 1000000)
  return { rateCardId: GEMINI_RATE_CARD_ID, worstCaseCostMicroUsd, inputTokens }
}
function selectedComparison(records, evidence) {
  if (!records || records.length !== 2) return false
  const refs = evidence.students.filter(s => s.current).map(s => s.ref).sort()
  if (!refs.length || refs.length > 8) return false
  const expectedNames = ['aggregate_transactions', 'find_students_without_transactions']
  if (JSON.stringify(records.map(r => r.name).sort()) !== JSON.stringify(expectedNames)) return false
  return records.every(({ name, args, output }) => {
    const selected = [...new Set(args.studentRefs ?? [])].sort()
    const populationMatches = selected.length ? JSON.stringify(selected) === JSON.stringify(refs) : evidence.students.every(s => s.current)
    const keys = ['studentRefs','transactionType','status','purpose','startDate','endDate','sort','limit', ...(name === 'aggregate_transactions' ? ['groupBy','metric'] : [])]
    return populationMatches && Object.keys(args).every(k => keys.includes(k)) && args.transactionType === 'Add' && args.status === 'Approved' && (args.purpose ?? 'any') === 'any' && args.startDate === '2026-08-31' && args.endDate === '2026-09-06' && output?.ok === true && output.truncated === false && (name !== 'aggregate_transactions' || (args.metric === 'amountTotal' && JSON.stringify(args.groupBy) === '["student"]'))
  })
}

// Local composition only. The caller provides an in-memory test ledger/evidence
// source. Production liveCallable does not import or enable this module.
export function createIsolatedPreview({ generateContent, resolveActiveTeacherTenant, loadQuestionEvidence, usageLedger, now }) {
  return async request => {
    let tenant, envelope, selectedRecords = null
    const records = []
    const assistant = {
      async answer(input) {
        const toolbox = { context: input.toolbox.context, declarations: input.toolbox.declarations,
          execute(name, args) {
            const output = input.toolbox.execute(name, args)
            records.push(structuredClone({ name, args, output }))
            return output
          } }
        const wrapped = createStructuredClassroomAssistant({ generateContent: async req => {
          const responses = req.contents.flatMap(c => c.parts ?? []).map(p => p.functionResponse).filter(Boolean)
          const response = await generateContent({ ...req, config: { ...req.config,
            systemInstruction: req.config.systemInstruction + PLANNER_NOTE } }, 'planner')
          if (!response.functionCalls?.length && typeof response.text === 'string') {
            try {
              const raw = response.text.trim().replace(/^```json\s*/u, '').replace(/\s*```$/u, '')
              const selection = JSON.parse(raw)
              selectedRecords = selection.sections.map(section => {
                const index = responses.findIndex(r => r.response.resultId === section.resultId)
                assert(index >= 0 && index < records.length)
                assert.deepEqual(responses[index].response.output, records[index].output)
                return records[index]
              })
            } catch { selectedRecords = null }
          }
          return response
        } })
        return wrapped.answer({ ...input, toolbox })
      },
    }
    const baseService = createInsightToolQuestionService({
      resolveActiveTeacherTenant: async input => { tenant = await resolveActiveTeacherTenant(input); return tenant },
      loadQuestionEvidence: async input => { envelope = await loadQuestionEvidence(input); return envelope },
      usageLedger, now, assistant, quoteWorstCaseCost: quoteIsolatedPlanner, priceActualUsage: priceGeminiToolAssistantActualUsage,
    })
    const base = await baseService(request)
    let prepared
    try { prepared = prepareCase({ evidence: envelope.assistantEvidence }) } catch {
      return { contract: CONTRACT, status: 'unsupported-preview', aiExplanation: null, verifiedSummary: base.answer, details: [], base }
    }
    const facts = prepared.packet.verifiedFacts
    const scope = `${facts.startDate} through ${facts.endDate} (${facts.timeZone}) · Current classroom roster · Approved money added (USD)`
    // Exact equality with the closed deterministic renderer is only a local
    // replay fallback binding; it does not validate Gemini prose.
    const eligible = selectedComparison(selectedRecords, envelope.assistantEvidence) ||
      (selectedRecords === null && base.answer === prepared.fallback)
    const fallback = { contract: CONTRACT, status: 'calculated-only', aiExplanation: null, reviewRequired: false,
      verifiedSummary: eligible ? previewSummary(facts) : base.answer, scope: eligible ? scope : null, facts: eligible ? facts : null, details: eligible ? facts.limitations : [], base }
    const signature = digest({ contract: CONTRACT, tenant, base, evidenceSignature: envelope.evidenceSignature, packet: prepared.packet })
    const requestId = digest({ contract: CONTRACT, originalRequestId: request.data.requestId })
    const quote = narrationQuote(prepared.request)
    let reservation
    try {
      reservation = await usageLedger.reserve({ ...tenant, requestId, monthKey: utcMonthKey(now()), mode: 'quick', evidenceSignature: signature, hourlyRequestLimit: insightModeProfile('quick').hourlyRequestLimit, monthlyAllowanceMicroUsd: GEMINI_MONTHLY_ALLOWANCE_MICRO_USD, rateCardId: quote.rateCardId, worstCaseCostMicroUsd: quote.worstCaseCostMicroUsd })
    } catch { return { ...fallback, status: 'calculated-only-narration-unavailable' } }
    if (reservation.kind === 'completed') {
      assert.equal(reservation.result?.contract, CONTRACT)
      assert.equal(reservation.result.signature, signature)
      return structuredClone(reservation.result.preview)
    }
    assert.equal(reservation.kind, 'reserved')
    let preview = fallback, accountedCost = 0, accounting = 'not-called'
    // A replay with no completed narration never starts new model work: keep a
    // fallback if the original run stopped between base completion and narration.
    if (eligible && selectedRecords !== null) {
      accountedCost = quote.worstCaseCostMicroUsd; accounting = 'reserved-unknown'
      try {
        const response = await generateContent(prepared.request, 'narrator')
        const usage = parseGeminiUsageMetadata(response.usageMetadata)
        assert(usage.inputTokens <= quote.inputTokens && usage.outputTokens <= MAX_OUTPUT_TOKENS && usage.thinkingTokens <= MAX_THINKING_TOKENS)
        accountedCost = priceGeminiToolAssistantActualUsage({ rateCardId: quote.rateCardId, usage })
        assert(accountedCost <= quote.worstCaseCostMicroUsd)
        accounting = 'observed-usage'
        const candidate = inspectCandidate(prepared, response)
        if (candidate.candidate) preview = { ...fallback, status: 'draft-for-review', aiExplanation: candidate.candidate, reviewRequired: true }
      } catch { /* Preserve calculated result; unknown usage keeps full reservation. */ }
    } else {
      // Never attach independently recomputed comparison facts to a different
      // question/selection. Base structured answer remains the honest fallback.
      preview = { ...fallback, status: 'unsupported-preview', verifiedSummary: base.answer, facts: null, scope: null, details: [] }
    }
    const result = { contract: CONTRACT, signature, accounting, accountedCostMicroUsd: accountedCost, preview }
    try {
      await usageLedger.commit({ reservationId: reservation.reservationId, requestId, actualCostMicroUsd: accountedCost, result })
    } catch {
      await usageLedger.markUncertain({ reservationId: reservation.reservationId, requestId, worstCaseCostMicroUsd: quote.worstCaseCostMicroUsd })
      return { ...fallback, status: 'calculated-only-save-failed' }
    }
    return preview
  }
}
