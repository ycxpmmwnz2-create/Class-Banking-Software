import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [
  indexHtml,
  functionsIndex,
  contractsSource,
  costPolicySource,
  serviceSource,
  packageJson,
  plan,
  architecturePlan,
] = await Promise.all([
  readFile(new URL('../../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/contracts.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/costPolicy.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/analysisService.js', import.meta.url), 'utf8'),
  readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../../VERSION3_GEMINI_LAYER_PLAN.md', import.meta.url), 'utf8'),
  readFile(new URL('../../MULTI_TEACHER_ARCHITECTURE_PLAN.md', import.meta.url), 'utf8'),
])

test('source contract: guarded provider kernel remains unreachable and makes no network call', () => {
  const combinedKernel = `${contractsSource}\n${costPolicySource}\n${serviceSource}`
  for (const forbidden of [
    /from\s+['"]firebase(?:-admin|-functions|\/|['"])/,
    /\bonCall\s*\(/,
    /\bhttpsCallable\s*\(/,
    /\bgetFirestore\s*\(/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /GoogleGenerativeAI|GoogleAIBackend|GenerativeModel|VertexAI|FirebaseAI/,
    /https?:\/\//,
  ]) {
    assert.doesNotMatch(combinedKernel, forbidden)
  }
  assert.doesNotMatch(functionsIndex, /insights\/(?:contracts|costPolicy|analysisService)/)
  assert.doesNotMatch(functionsIndex, /generateTeacherInsightsV3/)
  assert.doesNotMatch(indexHtml, /generateTeacherInsightsV3/)
  assert.doesNotMatch(indexHtml, /test:version3:gemini-layer/)
})

test('source contract: request excludes browser authority over tenant, facts, prompts, and cost', () => {
  assert.match(
    contractsSource,
    /\['requestId', 'mode', 'periodDays', 'evidenceSignature'\]/,
  )
  assert.doesNotMatch(
    contractsSource.match(/export function validateInsightRequest[\s\S]*?^}/m)?.[0] ?? '',
    /classroomId|factPacket|prompt|model|maxOutputTokens|price/,
  )
  assert.match(
    serviceSource,
    /resolveActiveTeacherTenant\(\{ auth \}\)[\s\S]*?loadTenantEvidence\(\{[\s\S]*?teacherUid: identity\.teacherUid,[\s\S]*?classroomId: identity\.classroomId/,
  )
})

test('source contract: provider output has no factual narrative field', () => {
  assert.match(
    contractsSource,
    /\['schemaVersion', 'orderedObservationIds', 'groups', 'teacherQuestions', 'usage'\]/,
  )
  assert.match(contractsSource, /question\.kind !== 'suggestion'/)
  assert.match(contractsSource, /Observation IDs must be unique opaque references/)
  assert.match(contractsSource, /Evidence IDs must be unique opaque references/)
  assert.doesNotMatch(contractsSource, /factualNarrative|providerSummary|generatedClaim/)
})

test('source contract: separate allowances and Quick/Deep bounds are exact', () => {
  assert.match(costPolicySource, /GEMINI_MONTHLY_ALLOWANCE_MICRO_USD = 7_500_000/)
  assert.match(costPolicySource, /FIREBASE_MONTHLY_ALLOWANCE_MICRO_USD = 5_000_000/)
  assert.match(costPolicySource, /COMBINED_MONTHLY_ALLOWANCE_MICRO_USD = 12_500_000/)
  assert.match(costPolicySource, /quick:[\s\S]*?maxObservations: 4,[\s\S]*?maxEvidenceItems: 12,[\s\S]*?maxInputBytes: 16 \* 1024,[\s\S]*?maxOutputTokens: 350,[\s\S]*?hourlyRequestLimit: 10/)
  assert.match(costPolicySource, /deep:[\s\S]*?maxObservations: 20,[\s\S]*?maxEvidenceItems: 60,[\s\S]*?maxInputBytes: 48 \* 1024,[\s\S]*?maxOutputTokens: 900,[\s\S]*?hourlyRequestLimit: 2/)
})

test('source contract: reservation precedes provider and ambiguous outcomes remain charged', () => {
  assert.match(
    serviceSource,
    /usageLedger\.reserve\([\s\S]*?providerStarted = true[\s\S]*?provider\.generate\(/,
  )
  assert.match(
    serviceSource,
    /if \(providerStarted\) \{[\s\S]*?retainWorstCaseReservation/,
  )
  assert.match(serviceSource, /usageLedger\.markUncertain\(reservation\)/)
  assert.doesNotMatch(serviceSource, /usageLedger\.(?:release|cancel|refund)/)
})

test('source contract: focused command is local, bounded, and separate from existing Insights', () => {
  const scripts = JSON.parse(packageJson).scripts
  assert.equal(
    scripts['test:version3:gemini-layer'],
    "node --test 'functions/insights/*.test.js' 'tests/version3/gemini-layer.contract.test.js'",
  )
  assert.equal(
    scripts['test:version3:insights'],
    "node --test 'src/insights/*.test.js' 'tests/version3/*.test.js'",
  )
  assert.doesNotMatch(
    scripts['test:version3:gemini-layer'],
    /firebase|emulator|playwright|curl|https?:/i,
  )
})

test('source contract: governing documents record dormancy and later approval gates', () => {
  assert.match(plan, /This item is deliberately dormant/)
  assert.match(plan, /No `functions\/index\.js`, `index\.html`/)
  assert.match(plan, /No Gemini SDK, model identifier, rate card, prompt, API key, secret/)
  assert.match(plan, /No commit, push, pull request, merge, staging\/production access/)
  assert.match(architecturePlan, /The first guarded-provider slice is the dormant contract kernel/)
  assert.match(architecturePlan, /Real adapters, callable\/browser wiring, emulator and[\s\S]*?remain later separately approved items/)
})
