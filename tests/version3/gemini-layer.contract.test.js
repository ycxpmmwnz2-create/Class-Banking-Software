import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import process from 'node:process'
import test from 'node:test'

async function readJavaScriptTree(directoryUrl, { exclude } = {}) {
  const sources = []
  const entries = await readdir(directoryUrl, { withFileTypes: true })
  for (const entry of entries) {
    const entryUrl = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directoryUrl)
    if (exclude?.(entryUrl)) continue
    if (entry.isDirectory()) {
      sources.push(...await readJavaScriptTree(entryUrl, { exclude }))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      sources.push(Object.freeze({
        path: entryUrl.pathname,
        source: await readFile(entryUrl, 'utf8'),
      }))
    }
  }
  return sources
}

function exportedConstSource(source, exportName) {
  const marker = `export const ${exportName} =`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing ${exportName} export`)
  const nextExport = source.indexOf('\nexport const ', start + marker.length)
  return source.slice(start, nextExport === -1 ? source.length : nextExport)
}

function assertTokensInOrder(source, tokens) {
  const offsets = tokens.map((token) => {
    const offset = source.indexOf(token)
    assert.notEqual(offset, -1, `missing ordered token: ${token}`)
    return offset
  })
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(
      offsets[index - 1] < offsets[index],
      `ordered token appeared too early: ${tokens[index]}`,
    )
  }
}

const [
  indexHtml,
  contractsSource,
  costPolicySource,
  serviceSource,
  evidenceAdapterSource,
  factPacketBuilderSource,
  usageLedgerSource,
  emulatorCallableSource,
  functionsIndexSource,
  emulatorFunctionsIndexSource,
  callableEnvironmentSource,
  firebaseJsonSource,
  emulatorFirebaseJsonSource,
  functionsPackageJsonSource,
  emulatorFunctionsPackageJsonSource,
  packageJson,
  plan,
  bridgePlan,
  callableBrowserPlan,
  correctionBrief,
  architecturePlan,
] = await Promise.all([
  readFile(new URL('../../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/contracts.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/costPolicy.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/analysisService.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/tenantEvidenceAdapter.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/factPacketBuilder.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/firestoreUsageLedger.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/emulatorCallable.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/version3-emulator/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/version3-emulator/.env.demo-morgan-bank-version3-gemini-callable-browser', import.meta.url), 'utf8'),
  readFile(new URL('../../firebase.json', import.meta.url), 'utf8'),
  readFile(new URL('../../firebase.version3-gemini-emulator.json', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/package.json', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/version3-emulator/package.json', import.meta.url), 'utf8'),
  readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../../VERSION3_GEMINI_LAYER_PLAN.md', import.meta.url), 'utf8'),
  readFile(new URL('../../VERSION3_GEMINI_EMULATOR_BRIDGE_PLAN.md', import.meta.url), 'utf8'),
  readFile(new URL('../../VERSION3_GEMINI_EMULATOR_CALLABLE_BROWSER_PLAN.md', import.meta.url), 'utf8'),
  readFile(new URL('../../VERSION3_AI_INSIGHTS_CORRECTION_BRIEF.md', import.meta.url), 'utf8'),
  readFile(new URL('../../MULTI_TEACHER_ARCHITECTURE_PLAN.md', import.meta.url), 'utf8'),
])

const nonKernelJavaScript = [
  ...await readJavaScriptTree(new URL('../../functions/', import.meta.url), {
    exclude: url => (
      url.pathname.includes('/functions/insights/') ||
      url.pathname.endsWith('/functions/index.js') ||
      url.pathname.includes('/functions/version3-emulator/') ||
      url.pathname.includes('/node_modules/')
    ),
  }),
  ...await readJavaScriptTree(new URL('../../src/', import.meta.url)),
]

const nonGeminiInsightJavaScript = await readJavaScriptTree(
  new URL('../../functions/insights/', import.meta.url),
  {
    exclude: url => (
      url.pathname.endsWith('.test.js') ||
      url.pathname.endsWith('/geminiProviderAdapter.js') ||
      url.pathname.endsWith('/geminiCostPolicy.js') ||
      url.pathname.endsWith('/geminiQuestionAdapter.js') ||
      url.pathname.endsWith('/geminiQuestionCostPolicy.js') ||
      url.pathname.endsWith('/geminiClassroomAssistant.js') ||
      url.pathname.endsWith('/geminiToolAssistantCostPolicy.js') ||
      url.pathname.endsWith('/conversationNarrator.js') ||
      url.pathname.endsWith('/geminiTransport.js') ||
      url.pathname.endsWith('/liveCallable.js') ||
      url.pathname.endsWith('/liveRuntime.js')
    ),
  },
)

const DORMANT_KERNEL_IMPORT = /(?:from\s+|import\s+|import\s*\(|require\s*\()\s*(['"`])(?:[^'"`]*\/)?insights\/(?:contracts|costPolicy|analysisService|tenantEvidenceAdapter|factPacketBuilder|firestoreUsageLedger|geminiProviderAdapter|geminiCostPolicy)(?:\.js)?\1/
const REAL_GEMINI_IMPORT = /(?:from\s+|import\s+|import\s*\(|require\s*\()\s*(['"`])(?:[^'"`]*\/)?(?:insights\/)?(?:geminiProviderAdapter|geminiCostPolicy)(?:\.js)?\1/

test('source contract: guarded kernel and emulator stay network-free while live transport is isolated', () => {
  const combinedKernel = [
    contractsSource,
    costPolicySource,
    serviceSource,
    evidenceAdapterSource,
    factPacketBuilderSource,
    usageLedgerSource,
    emulatorCallableSource,
  ].join('\n')
  for (const forbidden of [
    /\bhttpsCallable\s*\(/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /GoogleGenerativeAI|GoogleAIBackend|GenerativeModel|VertexAI|FirebaseAI/,
    /https?:\/\//,
  ]) {
    assert.doesNotMatch(combinedKernel, forbidden)
  }
  for (const file of nonKernelJavaScript) {
    assert.doesNotMatch(file.source, DORMANT_KERNEL_IMPORT, `dormant kernel imported by ${file.path}`)
  }
  assert.ok(
    nonGeminiInsightJavaScript.some(file => file.path.endsWith('/identity.js')),
    'dynamic real-Gemini import guard must include identity.js',
  )
  for (const file of [
    ...nonGeminiInsightJavaScript,
    { path: 'functions/version3-emulator/index.js', source: emulatorFunctionsIndexSource },
  ]) {
    assert.doesNotMatch(file.source, REAL_GEMINI_IMPORT, `real Gemini module imported by ${file.path}`)
  }
  assert.doesNotMatch(functionsIndexSource, /emulatorCallable/)
  assert.match(functionsIndexSource, /createVersion3GeminiLiveHandler/)
  assert.match(functionsIndexSource, /export const analyzeTeacherInsightsV3 = onCall/)
  assert.match(emulatorFunctionsIndexSource, /import \{[\s\S]*?createVersion3GeminiEmulatorHandler[\s\S]*?from '\.\.\/insights\/emulatorCallable\.js'/)
  assert.match(emulatorFunctionsIndexSource, /export const analyzeTeacherInsightsV3 = onCall/)
  assert.doesNotMatch(
    indexHtml,
    /functions\/insights\/(?:contracts|costPolicy|analysisService|tenantEvidenceAdapter|factPacketBuilder|firestoreUsageLedger|geminiProviderAdapter|geminiCostPolicy)(?:\.js)?/,
  )
})

test('source contract: dormancy matcher detects real static, dynamic, and CommonJS imports', () => {
  for (const source of [
    "import './insights/analysisService.js'",
    "import '../../functions/insights/contracts'",
    "export { validateFactPacket } from '../insights/contracts.js'",
    "const module = import('../insights/costPolicy.js')",
    'const module = import(`../insights/costPolicy`)',
    "const module = require('../insights/analysisService.js')",
    "import '../insights/firestoreUsageLedger.js'",
    "import '../insights/geminiProviderAdapter.js'",
    "const module = import('../insights/geminiCostPolicy.js')",
  ]) {
    assert.match(source, DORMANT_KERNEL_IMPORT)
  }
  for (const source of [
    "import './geminiProviderAdapter.js'",
    "export { GEMINI_RATE_CARD } from './geminiCostPolicy.js'",
    "const module = import('../insights/geminiProviderAdapter.js')",
    "const module = require('./geminiCostPolicy')",
  ]) {
    assert.match(source, REAL_GEMINI_IMPORT)
  }
})

test('source contract: request excludes browser authority over tenant, facts, prompts, and cost', () => {
  assert.match(
    contractsSource,
    /\['requestId', 'mode', 'periodDays', 'timeZone'\]/,
  )
  assert.doesNotMatch(
    contractsSource.match(/export function validateInsightRequest[\s\S]*?^}/m)?.[0] ?? '',
    /classroomId|factPacket|prompt|model|maxOutputTokens|price|evidenceSignature/,
  )
  assert.match(
    serviceSource,
    /resolveActiveTeacherTenant\(\{ auth \}\)[\s\S]*?loadDeidentifiedTenantEvidence\(\{[\s\S]*?teacherUid: identity\.teacherUid,[\s\S]*?classroomId: identity\.classroomId,[\s\S]*?timeZone: request\.timeZone/,
  )
  assert.doesNotMatch(serviceSource, /request\.evidenceSignature/)
  assert.match(
    serviceSource,
    /buildFactPacket\(\{[\s\S]*?evidence: evidenceEnvelope\.analysisEvidence,[\s\S]*?mode: request\.mode,[\s\S]*?periodDays: request\.periodDays/,
  )
  assert.doesNotMatch(factPacketBuilderSource, /evidenceSignature/)
  assert.match(serviceSource, /evidenceSignature: evidenceEnvelope\.evidenceSignature/)
  assert.match(serviceSource, /pairDisplayObservations\(packet, evidenceEnvelope\.displayEvidence\)/)
})

test('source contract: callable is locked to the exact three-emulator demo runtime', () => {
  assert.match(emulatorCallableSource, /VERSION3_GEMINI_EMULATOR_ENABLED !== 'true'/)
  assert.match(emulatorCallableSource, /FUNCTIONS_EMULATOR !== 'true'/)
  assert.match(emulatorCallableSource, /demo-morgan-bank-version3-gemini-callable-browser/)
  assert.match(emulatorCallableSource, /FIRESTORE_EMULATOR_HOST/)
  assert.match(emulatorCallableSource, /FIREBASE_AUTH_EMULATOR_HOST/)
  const handlerSource = exportedConstSource(emulatorFunctionsIndexSource, 'analyzeTeacherInsightsV3')
  const orderedHandlerTokens = [
    'assertVersion3GeminiEmulatorRuntime({',
    "await import('../../src/insights/classInsights.js')",
    'getFirestore(',
  ]
  assertTokensInOrder(handlerSource, orderedHandlerTokens)
  const preGuardFirestoreRegression = handlerSource.replace(
    orderedHandlerTokens[0],
    `const hoisted = getFirestore()\n    ${orderedHandlerTokens[0]}`,
  )
  assert.throws(
    () => assertTokensInOrder(preGuardFirestoreRegression, orderedHandlerTokens),
    /ordered token appeared too early/,
  )
  assert.doesNotMatch(emulatorCallableSource, /API[_-]?KEY|secret|GoogleGenerativeAI|VertexAI|fetch\s*\(|https?:\/\//i)
  assert.match(callableEnvironmentSource, /VERSION3_GEMINI_EMULATOR_ENABLED=true/)
  assert.doesNotMatch(callableEnvironmentSource, /API[_-]?KEY|secret|password|token/i)
  assert.ok(JSON.parse(firebaseJsonSource).functions[0].ignore.includes('.env.demo-*'))
})

test('source contract: production discovery includes only the protected live callable', () => {
  const defaultConfig = JSON.parse(firebaseJsonSource)
  const emulatorConfig = JSON.parse(emulatorFirebaseJsonSource)
  const functionsPackage = JSON.parse(functionsPackageJsonSource)
  const emulatorFunctionsPackage = JSON.parse(emulatorFunctionsPackageJsonSource)

  assert.equal(defaultConfig.functions.length, 1)
  assert.equal(defaultConfig.functions[0].source, 'functions')
  assert.equal(functionsPackage.main, 'index.js')
  assert.ok(defaultConfig.functions[0].ignore.includes('version3-emulator'))
  assert.doesNotMatch(functionsIndexSource, /emulatorCallable/)
  assert.match(functionsIndexSource, /export const analyzeTeacherInsightsV3 = onCall\(\{[\s\S]*?enforceAppCheck: true,[\s\S]*?consumeAppCheckToken: true,[\s\S]*?secrets: \[GEMINI_API_KEY\]/)

  assert.equal(emulatorConfig.functions.length, 1)
  assert.equal(emulatorConfig.functions[0].source, 'functions/version3-emulator')
  assert.equal(emulatorConfig.functions[0].codebase, 'version3-gemini-emulator')
  assert.equal(emulatorFunctionsPackage.main, 'index.js')
  assertTokensInOrder(emulatorFunctionsIndexSource, [
    "process.env.FUNCTIONS_EMULATOR !== 'true'",
    'initializeApp()',
    'export const analyzeTeacherInsightsV3 = onCall',
  ])
  assert.doesNotMatch(
    emulatorFunctionsIndexSource,
    /VERSION3_GEMINI_EMULATOR_ENABLED\s*=/,
  )
})

test('source contract: V2 gates secret access and the live gate precedes Firestore/provider use', () => {
  const start = functionsIndexSource.indexOf('export const analyzeTeacherInsightsV3 = onCall')
  const end = functionsIndexSource.indexOf('export const syncStudentProfilesV2', start)
  assert.ok(start >= 0 && end > start)
  const callable = functionsIndexSource.slice(start, end)
  const v2Gate = callable.indexOf("assertV2Invocation('analyzeTeacherInsightsV3')")
  const secretRead = callable.indexOf('GEMINI_API_KEY.value()')
  const liveGate = callable.indexOf('assertVersion3GeminiLiveRuntime({')
  const liveModuleLoad = callable.indexOf("await import('./insights/liveCallable.js')")
  const firestoreRead = callable.indexOf('firestore: getFirestore()')
  const providerCall = callable.indexOf('return await analyze(')
  assert.ok(v2Gate >= 0)
  assert.ok(v2Gate < secretRead)
  assert.ok(secretRead < liveGate)
  assert.ok(liveGate < liveModuleLoad)
  assert.ok(liveModuleLoad < firestoreRead)
  assert.ok(liveGate < firestoreRead)
  assert.ok(firestoreRead < providerCall)
  assert.doesNotMatch(
    functionsIndexSource,
    /import\s+\{\s*createVersion3GeminiLiveHandler\s*\}\s+from\s+'\.\/insights\/liveCallable\.js'/,
  )
  assert.match(functionsIndexSource, /VERSION3_GEMINI_ENABLED = defineBoolean\([\s\S]*?default: false/)
  assert.match(functionsIndexSource, /VERSION3_GEMINI_TOOL_ASSISTANT_ENABLED = defineBoolean\([\s\S]*?default: false/)
  assert.match(callable, /toolAssistantEnabled: VERSION3_GEMINI_TOOL_ASSISTANT_ENABLED\.value\(\)/)
  assert.match(functionsIndexSource, /VERSION3_GEMINI_RELEASE_ID = defineString\([\s\S]*?default: ''/)
  assert.doesNotMatch(callable, /error\?\.message|console\.(?:log|error)\(error/)
})

test('runtime contract: default Functions exports the protected live callable', async () => {
  const functionsExports = await import('../../functions/index.js')
  assert.equal(Object.hasOwn(functionsExports, 'analyzeTeacherInsightsV3'), true)
  assert.equal(Object.hasOwn(functionsExports, 'GEMINI_API_KEY'), true)
  assert.equal(Object.hasOwn(functionsExports, 'VERSION3_GEMINI_TOOL_ASSISTANT_ENABLED'), true)
})

test('runtime contract: the tenant resolver stays warm only in production', async () => {
  const functionsExports = await import('../../functions/index.js')
  const minInstances = functionsExports.resolveTeacherTenantV2.__endpoint?.minInstances
  assert.equal(
    JSON.parse(JSON.stringify(minInstances)),
    'params.PROJECT_ID == "morgan-bank" ? 1 : 0',
  )
})

test('runtime contract: dedicated callable entrypoint refuses non-emulator discovery', () => {
  const entrypoint = new URL(
    '../../functions/version3-emulator/index.js',
    import.meta.url,
  )
  const probe = spawnSync(process.execPath, [entrypoint.pathname], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      NODE_NO_WARNINGS: '1',
    },
  })
  assert.notEqual(probe.status, 0)
  assert.match(probe.stderr, /Version 3 emulator Functions discovery is disabled/)
  assert.doesNotMatch(
    probe.stderr,
    /GCLOUD_PROJECT|FIREBASE_CONFIG|FIRESTORE_EMULATOR_HOST|FIREBASE_AUTH_EMULATOR_HOST/,
  )
})

test('source contract: pseudonymized names are asserted before deterministic calculation', () => {
  assertTokensInOrder(evidenceAdapterSource, [
    'const pseudonymized = pseudonymizeEvidence(raw.students, periodTransactions)',
    'assertPseudonymizedStudentNames(pseudonymized)',
    'const providerReport = projectReport(calculateReport({',
  ])
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
  assert.match(
    scripts['test:version3:gemini-callable:emulator'],
    /-u VERSION3_GEMINI_EMULATOR_ENABLED/,
  )
  for (const command of [
    scripts['test:version3:gemini-callable:emulator'],
    scripts['test:version3:gemini-browser:chromium'],
    scripts['test:version3:gemini-browser:webkit'],
  ]) {
    assert.match(command, /--config firebase\.version3-gemini-emulator\.json/)
  }
})

test('source contract: governing documents record dormancy and later approval gates', () => {
  assert.match(plan, /This item is deliberately dormant/)
  assert.match(plan, /No `functions\/index\.js`, `index\.html`/)
  assert.match(plan, /No Gemini SDK, model identifier, rate card, prompt, API key, secret/)
  assert.match(plan, /No commit, push, pull request, merge, staging\/production access/)
  assert.match(architecturePlan, /The first guarded-provider slice is the dormant contract kernel/)
  assert.match(architecturePlan, /Real adapters, callable\/browser wiring, emulator and[\s\S]*?remain later separately approved items/)
  assert.match(bridgePlan, /The bridge remains unreachable from the deployed application/)
  assert.match(bridgePlan, /No live callable or browser integration/)
  assert.match(bridgePlan, /No Gemini SDK, model selection, API key, secret, billing/)
  assert.match(callableBrowserPlan, /Checkpoint A/)
  assert.match(callableBrowserPlan, /Firebase Auth, Functions, and Firestore emulators/)
  assert.match(callableBrowserPlan, /before any real provider work/)
  assert.match(callableBrowserPlan, /merged through PR #10/)
  assert.match(callableBrowserPlan, /does not establish the complete required[\s\S]*?Claude detailed-review and Grok final-review closure/)
  assert.match(correctionBrief, /one\s+application-wide monthly cap/)
  assert.match(correctionBrief, /default deployable Functions/)
  assert.match(correctionBrief, /cannot discover or package/)
  assert.match(correctionBrief, /Stop after preparing the complete Claude read-only handoff/)
})
