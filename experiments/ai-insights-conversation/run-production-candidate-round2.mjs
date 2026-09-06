import assert from 'node:assert/strict'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { database } from '../../functions/insights/conversationTestFixtures.js'
import { createInsightToolQuestionService } from '../../functions/insights/toolQuestionService.js'
import { createFirestoreUsageLedger } from '../../functions/insights/firestoreUsageLedger.js'
import { createConversationalClassroomAssistant } from '../../functions/insights/geminiClassroomAssistant.js'
import { quoteConversationalWorstCaseCost, quoteGeminiToolAssistantWorstCaseCost, priceGeminiToolAssistantActualUsage } from '../../functions/insights/geminiToolAssistantCostPolicy.js'
import { CONVERSATIONAL_ANSWER_CONTRACT } from '../../functions/insights/conversationContract.js'
import { createGeminiGenerateContent } from '../../functions/insights/geminiTransport.js'
const root = '/private/tmp/morgan-bank-conversation-candidate-20260906-round2'
const runDir = `${root}/run-once`, budget = 2000000, baseline = 1072331
const now = new Date('2026-09-07T18:00:00.000Z')
const sha = v => createHash('sha256').update(v).digest('hex')
function fixtures() {
  const students = Array.from({ length: 40 }, (_, i) => ({ ref: `student-${String(i + 1).padStart(3, '0')}`, displayName: `Fable ${i + 1}`, current: true, balance: 97, frozen: false }))
  const transaction = (i, amount) => ({ ref: `transaction-${String(i + 1).padStart(5, '0')}`, studentRef: students[i].ref, date: '2026-09-02T15:00:00.000Z', type: 'Add', amount, category: 'Class job', purpose: 'other', status: 'Approved' })
  const base = { question: 'Who earned the most money last week and who earned the least?', generatedAt: now.toISOString(), asOfDate: '2026-09-07', timeZone: 'America/Denver', periodDays: 7, periodStart: '2026-08-31T18:00:00.000Z', historyStart: '2026-06-09T18:00:00.000Z', configuredRentAmount: 10, students, categories: [], transactions: students.map((_, i) => transaction(i, i === 0 ? 30 : i === 39 ? 0 : 5)).filter(t => t.amount > 0) }
  return [
    { id: 'forty-students-last-week', evidence: base },
    { id: 'partial-history', evidence: { ...structuredClone(base), historyStart: '2026-08-31T12:00:00.000Z' } },
  ]
}
async function preflight() {
  const priorRaw = await readFile('/private/tmp/morgan-bank-conversation-candidate-20260906/run-once/report.json')
  const prior = JSON.parse(priorRaw); assert.equal(prior.accountedMicroUsd, baseline); assert.equal(prior.maxBudgetMicroUsd, budget)
  const sources = []
  for (const directory of ['functions/insights', 'src/insights', 'experiments/ai-insights-conversation']) {
    for (const name of (await readdir(directory)).filter(n => /\.(?:js|mjs)$/u.test(n)).sort()) sources.push({ path: `${directory}/${name}`, sha256: sha(await readFile(`${directory}/${name}`)) })
  }
  sources.push({ path: 'index.html', sha256: sha(await readFile('index.html')) })
  const quotes = fixtures().map(c => ({ id: c.id, worstCaseCostMicroUsd: quoteConversationalWorstCaseCost({ assistantEvidence: c.evidence }).worstCaseCostMicroUsd }))
  assert(quotes.every(q => baseline + q.worstCaseCostMicroUsd <= budget))
  return { sources, priorSha256: sha(priorRaw), baseline, budget, quotes, fixtureSha256: sha(JSON.stringify(fixtures())) }
}
function readStagingKey() {
  const command = '/opt/homebrew/bin/gcloud'
  const options = { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1024 * 1024 }
  let bytes
  try {
    const data = JSON.parse(execFileSync(command, ['functions', 'describe', 'analyzeTeacherInsightsV3', '--gen2', '--region=us-central1', '--project=morgan-bank-staging', '--format=json(serviceConfig.secretEnvironmentVariables)'], options).toString('utf8'))
    const matches = data.serviceConfig?.secretEnvironmentVariables?.filter(b => b.key === 'GEMINI_API_KEY') ?? []
    assert.equal(matches.length, 1)
    const b = matches[0]
    assert.equal(b.projectId, 'morgan-bank-staging'); assert.equal(b.secret, 'GEMINI_API_KEY'); assert.equal(b.version, '1')
    bytes = execFileSync(command, ['secrets', 'versions', 'access', '1', '--secret=GEMINI_API_KEY', '--project=morgan-bank-staging', '--quiet'], options)
    const key = bytes.toString('utf8').trim()
    assert(key.length >= 20 && !/\s/u.test(key))
    return key
  } catch { throw new Error('staging-credential-setup-failed') }
  finally { bytes?.fill(0) }
}async function run(manifest) {
  assert.deepEqual(JSON.parse(await readFile(`${root}/preflight.json`)), manifest)
  await mkdir(runDir, { mode: 0o700 })
  const report = { status: 'RUNNING', syntheticOnly: true, deployed: false, baselineAccountedMicroUsd: baseline, accountedMicroUsd: baseline, maxBudgetMicroUsd: budget, manifest, cases: [] }
  const save = () => writeFile(`${runDir}/report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await save()
  try {
    const transport = createGeminiGenerateContent({ apiKey: readStagingKey(), maxAttempts: 1 })
    for (const item of fixtures()) {
      const quote = manifest.quotes.find(q => q.id === item.id)
      if (report.accountedMicroUsd + quote.worstCaseCostMicroUsd > budget) { report.status = 'STOPPED_BUDGET'; break }
      const entry = { id: item.id, status: 'RESERVED', reservedMicroUsd: quote.worstCaseCostMicroUsd }
      report.cases.push(entry); report.accountedMicroUsd += quote.worstCaseCostMicroUsd; await save()
      const db = database(), calls = []
      const usageLedger = createFirestoreUsageLedger({ firestore: db.firestore, now: () => now.getTime() })
      const service = createInsightToolQuestionService({ answerContract: CONVERSATIONAL_ANSWER_CONTRACT, now: () => now,
        resolveActiveTeacherTenant: async () => ({ teacherUid: 'fictional-teacher', classroomId: 'fictional-class' }),
        loadQuestionEvidence: async () => ({ assistantEvidence: item.evidence, assistantMemoResolver: () => null, evidenceSignature: sha(JSON.stringify(item.evidence)) }),
        usageLedger, quoteWorstCaseCost: quoteConversationalWorstCaseCost, quoteBaseWorstCaseCost: quoteGeminiToolAssistantWorstCaseCost, priceActualUsage: priceGeminiToolAssistantActualUsage,
        assistant: createConversationalClassroomAssistant({ generateContent: async request => { calls.push(request.config.tools ? 'planner' : 'narrator'); return transport(request) } }),
      })
      const request = { auth: { uid: 'fictional-teacher' }, data: { kind: 'question', question: item.evidence.question, periodDays: 7, timeZone: item.evidence.timeZone, requestId: `candidate-${item.id}-000001` } }
      try {
        const first = await service(request), count = calls.length, writes = db.writes.length, before = JSON.stringify([...db.store])
        assert.deepEqual(await service(request), first); assert.equal(calls.length, count); assert.equal(db.writes.length, writes); assert.equal(JSON.stringify([...db.store]), before)
        const charged = [...db.store].filter(([p]) => p.startsWith('insightUsageLedgers/')).reduce((sum, [, v]) => sum + v.chargedMicroUsd, 0)
        assert(charged <= quote.worstCaseCostMicroUsd)
        entry.response = first; entry.providerPhases = calls; entry.request = request; entry.replayIdentical = true; entry.replayAdditionalCalls = 0; entry.replayAdditionalChargeMicroUsd = 0; entry.replayAdditionalWrites = 0
        entry.onlyUsageWrites = db.writes.every(p => /^insightUsage/u.test(p)); assert(entry.onlyUsageWrites)
        entry.accountedCostMicroUsd = charged; report.accountedMicroUsd += charged - quote.worstCaseCostMicroUsd
        entry.status = first.presentation?.aiSummary ? 'READY_FOR_SEMANTIC_REVIEW' : 'FALLBACK_REQUIRES_INSPECTION'
        await save(); console.log(JSON.stringify({ id: item.id, status: entry.status, calls: count, costMicroUsd: charged }))
        if (entry.status !== 'READY_FOR_SEMANTIC_REVIEW') { report.status = 'STOPPED_FOR_INSPECTION'; break }
      } catch (error) {
        entry.status = 'FAILED'; report.status = 'STOPPED_FAILURE'; entry.providerPhases = calls
        const allowed = ['provider-timeout', 'provider-unavailable', 'provider-output-invalid', 'provider-output-truncated', 'usage-invalid', 'answer-unverified', 'answer-unavailable', 'tool-output-too-large', 'allowance-exhausted', 'budget-unavailable']
        entry.failureCategory = allowed.includes(error?.category) ? error.category : 'unclassified'
        await save(); break
      }
    }
    if (report.status === 'RUNNING') report.status = 'READY_FOR_SEMANTIC_REVIEW'
  } catch { report.status = 'STOPPED_SETUP_FAILURE' }
  finally { await save() }
  console.log(JSON.stringify({ status: report.status, accountedMicroUsd: report.accountedMicroUsd, report: `${runDir}/report.json` }))
  if (report.status !== 'READY_FOR_SEMANTIC_REVIEW') process.exitCode = 1
}
try {
  assert(process.argv.length === 3 && ['--check', '--run'].includes(process.argv[2]))
  const manifest = await preflight()
  if (process.argv[2] === '--check') {
    await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(`${root}/preflight.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ offline: true, quotes: manifest.quotes, remainingMicroUsd: budget - baseline }))
  } else await run(manifest)
} catch { console.error('Candidate test stopped; raw errors withheld. No automatic retry.'); process.exitCode = 1 }
