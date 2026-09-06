import assert from 'node:assert/strict'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { setup } from './local-fixtures.mjs'
import { prepareCase, cases } from './experiment.mjs'
import { quoteIsolatedPlanner, narrationQuote } from './integrated-preview.mjs'
import { createGeminiGenerateContent } from '../../functions/insights/geminiTransport.js'

const root = '/private/tmp/morgan-bank-isolated-integration-20260906'
const runDir = `${root}/run-once`
const ids = ['unique-zero-and-filter-distractors','ties-at-both-ends','partial-history']
const budget = 2000000, baseline = 973493
const sha = v => createHash('sha256').update(v).digest('hex')
async function preflight() {
  const priorRaw = await readFile('/private/tmp/morgan-bank-conversation-20260906-round2/run-once/report.json')
  const prior = JSON.parse(priorRaw)
  assert.equal(prior.accountedMicroUsd, baseline); assert.equal(prior.maxBudgetMicroUsd, budget)
  const sources = []
  for (const name of (await readdir(new URL('.', import.meta.url))).filter(n => n.endsWith('.mjs')).sort()) sources.push({ name, sha256: sha(await readFile(new URL(name, import.meta.url))) })
  const quotes = ids.map(id => {
    const s = setup({ id })
    const e = s.snapshots.a
    return { id, worstCaseCostMicroUsd: quoteIsolatedPlanner({ assistantEvidence: e }).worstCaseCostMicroUsd + narrationQuote(prepareCase({ evidence: e }).request).worstCaseCostMicroUsd }
  })
  assert(quotes.every(q => q.worstCaseCostMicroUsd + baseline <= budget))
  return { sources, priorSha256: sha(priorRaw), baseline, budget, quotes, fixtureSha256: sha(JSON.stringify(cases())) }
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
async function run(manifest) {
  assert.deepEqual(JSON.parse(await readFile(`${root}/preflight.json`)), manifest)
  await mkdir(runDir, { mode: 0o700 })
  const report = { status: 'RUNNING', syntheticOnly: true, productionChanged: false, startedAt: new Date().toISOString(), baselineAccountedMicroUsd: baseline, accountedMicroUsd: baseline, maxBudgetMicroUsd: budget, manifest, cases: [] }
  const save = () => writeFile(`${runDir}/report.json`, JSON.stringify(report,null,2)+'\n',{mode:0o600})
  await save()
  try {
    const transport = createGeminiGenerateContent({ apiKey: readStagingKey(), maxAttempts: 1 })
    for (const q of manifest.quotes) {
      if(report.accountedMicroUsd + q.worstCaseCostMicroUsd > budget){ report.status='STOPPED_BUDGET';break }
      const entry = { id:q.id, status:'RESERVED', reservedMicroUsd:q.worstCaseCostMicroUsd }
      report.cases.push(entry);report.accountedMicroUsd += q.worstCaseCostMicroUsd;await save()
      const s = setup({ id:q.id, generateContent: (r) => transport(r) })
      try {
        const first = await s.service(s.request)
        const callCount = s.calls.length, charge = s.charged(), writes = s.writes.length
        assert(callCount <= 5)
        const replay = await s.service(s.request)
        assert.deepEqual(replay,first);assert.equal(s.calls.length,callCount);assert.equal(s.charged(),charge);assert.equal(s.writes.length,writes)
        assert(charge <= q.worstCaseCostMicroUsd)
        entry.preview=first;entry.request=s.request;entry.providerPhases=s.calls.map(c=>c.phase)
        entry.accountedCostMicroUsd=charge;entry.replayIdentical=true;entry.replayAdditionalCalls=0;entry.replayAdditionalChargeMicroUsd=0
        entry.onlyUsageWrites=s.writes.every(p=>/^insightUsage(?:Ledgers|Reservations|RateLimits)\//u.test(p))
        entry.status=first.status==='draft-for-review'?'READY_FOR_SEMANTIC_REVIEW':'FALLBACK_REQUIRES_INSPECTION'
        report.accountedMicroUsd += charge-q.worstCaseCostMicroUsd
        console.log(JSON.stringify({id:q.id,status:entry.status,calls:callCount,replayAdditionalCalls:0,accountedCostMicroUsd:charge}))
        await save()
        if(entry.status!=='READY_FOR_SEMANTIC_REVIEW'){ report.status='STOPPED_FOR_INSPECTION';break }
      } catch { entry.status='FAILED';report.status='STOPPED_FAILURE';await save();break }
    }
    if(report.status==='RUNNING')report.status='READY_FOR_SEMANTIC_REVIEW'
  } catch { report.status='STOPPED_SETUP_FAILURE' }
  finally { report.finishedAt=new Date().toISOString();await save() }
  console.log(JSON.stringify({status:report.status,accountedMicroUsd:report.accountedMicroUsd,report:`${runDir}/report.json`}))
  if(report.status!=='READY_FOR_SEMANTIC_REVIEW')process.exitCode=1
}
try {
  assert(process.argv.length===3 && ['--check','--run'].includes(process.argv[2]))
  const manifest=await preflight()
  if(process.argv[2]==='--check'){
    await mkdir(root,{recursive:true,mode:0o700});await writeFile(`${root}/preflight.json`,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
    console.log(JSON.stringify({offline:true,cases:ids.length,quotes:manifest.quotes,remainingMicroUsd:budget-baseline}))
  }else await run(manifest)
}catch{console.error('Isolated test stopped; raw errors withheld. No automatic retry.');process.exitCode=1}
