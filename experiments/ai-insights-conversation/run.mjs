import assert from 'node:assert/strict'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { cases, prepareCase, inspectCandidate, MAX_OUTPUT_TOKENS, MAX_THINKING_TOKENS } from './experiment.mjs'
import { createGeminiGenerateContent } from '../../functions/insights/geminiTransport.js'
import { parseGeminiUsageMetadata, GEMINI_RATE_CARD_ID } from '../../functions/insights/geminiProviderAdapter.js'
import { GEMINI_RATE_CARD } from '../../functions/insights/geminiCostPolicy.js'
import { priceGeminiToolAssistantActualUsage } from '../../functions/insights/geminiToolAssistantCostPolicy.js'

const root = '/private/tmp/morgan-bank-conversation-20260906-round2'
const runDir = `${root}/run-once`
const baselinePath = '/private/tmp/morgan-bank-conversation-20260906/run-once/report.json'
const baselineCost = 965298, ceiling = 2000000, localCeiling = 488877
const sha = data => createHash('sha256').update(data).digest('hex')
const sourcePaths = ['./experiment.mjs', './run.mjs', './experiment.test.mjs', '../../functions/insights/classroomAssistantTools.js', '../../functions/insights/structuredClassroomAnswers.js', '../../functions/insights/geminiTransport.js', '../../functions/insights/geminiProviderAdapter.js', '../../functions/insights/geminiCostPolicy.js', '../../functions/insights/geminiToolAssistantCostPolicy.js']
async function prepare() {
  const baselineBytes = await readFile(baselinePath)
  const baseline = JSON.parse(baselineBytes)
  assert.equal(baseline.accountedMicroUsd, baselineCost)
  assert.equal(baseline.maxBudgetMicroUsd, ceiling)
  const sources = []
  for (const relative of sourcePaths) sources.push({ relative, sha256: sha(await readFile(new URL(relative, import.meta.url))) })
  const prepared = cases().map(prepareCase)
  const quotes = prepared.map(p => {
    const conservativeInputTokens = Buffer.byteLength(JSON.stringify(p.request)) + 4096
    const worstCaseMicroUsd = Math.ceil((conservativeInputTokens * GEMINI_RATE_CARD.inputMicroUsdPerMillionTokens + (MAX_OUTPUT_TOKENS + MAX_THINKING_TOKENS) * GEMINI_RATE_CARD.billedOutputMicroUsdPerMillionTokens) / 1000000)
    return { id: p.id, conservativeInputTokens, worstCaseMicroUsd }
  })
  const maxRun = quotes.reduce((s, q) => s + q.worstCaseMicroUsd, 0)
  assert(maxRun <= localCeiling && maxRun + baselineCost <= ceiling)
  return { prepared, manifest: { sources, baselineSha256: sha(baselineBytes), baselineCost, ceiling, localCeiling, maxRun, quotes, packetHashes: prepared.map(p => ({ id: p.id, sha256: p.packetSha256 })), runnerPath: fileURLToPath(import.meta.url) } }
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
}
async function run(prepared, manifest) {
  assert.deepEqual(JSON.parse(await readFile(`${root}/preflight.json`, 'utf8')), manifest)
  await mkdir(runDir, { mode: 0o700 }) // No repeat/retry if this directory exists.
  const report = { status: 'RUNNING', syntheticOnly: true, productionChanged: false, startedAt: new Date().toISOString(), model: 'gemini-3.6-flash', baselineAccountedMicroUsd: baselineCost, accountedMicroUsd: baselineCost, newAccountedMicroUsd: 0, maxBudgetMicroUsd: ceiling, localCeilingMicroUsd: localCeiling, manifest, cases: [] }
  const save = () => writeFile(`${runDir}/report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await save()
  try {
    const transport = createGeminiGenerateContent({ apiKey: readStagingKey(), maxAttempts: 1 })
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i], quote = manifest.quotes[i]
      assert(report.accountedMicroUsd + quote.worstCaseMicroUsd <= ceiling)
      assert(report.newAccountedMicroUsd + quote.worstCaseMicroUsd <= localCeiling)
      const entry = { id: p.id, packet: p.packet, packetSha256: p.packetSha256, request: p.request, fallback: p.fallback, status: 'RESERVED', reservedMicroUsd: quote.worstCaseMicroUsd }
      report.cases.push(entry)
      report.accountedMicroUsd += quote.worstCaseMicroUsd
      report.newAccountedMicroUsd += quote.worstCaseMicroUsd
      await save() // Reserve before crossing the network boundary.
      try {
        const response = await transport(p.request)
        entry.finishReason = response.finishReason ?? null
        entry.rawText = typeof response.text === 'string' && Buffer.byteLength(response.text) <= 16384 ? response.text : null
        const usage = parseGeminiUsageMetadata(response.usageMetadata)
        assert(usage.inputTokens <= quote.conservativeInputTokens && usage.outputTokens <= MAX_OUTPUT_TOKENS && usage.thinkingTokens <= MAX_THINKING_TOKENS)
        const actual = priceGeminiToolAssistantActualUsage({ rateCardId: GEMINI_RATE_CARD_ID, usage })
        assert(actual <= quote.worstCaseMicroUsd)
        entry.usage = usage; entry.actualCostMicroUsd = actual
        report.accountedMicroUsd += actual - quote.worstCaseMicroUsd
        report.newAccountedMicroUsd += actual - quote.worstCaseMicroUsd
        const inspected = inspectCandidate(p, response)
        entry.candidate = inspected.candidate; entry.status = inspected.status
        assert.equal(inspected.servingAnswer, p.fallback)
        console.log(JSON.stringify({ id: p.id, status: entry.status, newAccountedMicroUsd: report.newAccountedMicroUsd }))
        await save()
        if (entry.status === 'fallback') { report.status = 'STOPPED_RESPONSE_FAILURE'; break }
      } catch {
        entry.status = 'FAILED_WITH_FALLBACK'; report.status = 'STOPPED_FAILURE'
        // An unsettled reservation remains charged. Never log a provider or CLI error.
        await save(); break
      }
    }
    if (report.status === 'RUNNING') report.status = 'AWAITING_HUMAN_SEMANTIC_REVIEW'
  } catch { report.status = 'STOPPED_SETUP_FAILURE' }
  finally { report.finishedAt = new Date().toISOString(); await save() }
  console.log(JSON.stringify({ status: report.status, report: `${runDir}/report.json`, newAccountedMicroUsd: report.newAccountedMicroUsd, cumulativeAccountedMicroUsd: report.accountedMicroUsd }))
}
try {
  assert(process.argv.length === 3 && ['--check', '--run'].includes(process.argv[2]))
  const { prepared, manifest } = await prepare()
  if (process.argv[2] === '--check') {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(`${root}/preflight.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ offline: true, cases: prepared.length, maxNewCostMicroUsd: manifest.maxRun, cumulativeWorstCaseMicroUsd: baselineCost + manifest.maxRun }))
  } else await run(prepared, manifest)
} catch { console.error('Experiment stopped; no automatic retry. Raw errors withheld.'); process.exitCode = 1 }
