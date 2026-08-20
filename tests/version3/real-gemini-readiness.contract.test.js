import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [
  functionsIndex,
  emulatorFunctionsIndex,
  functionsPackage,
  adapterSource,
  costSource,
  transportSource,
  liveRuntimeSource,
  readinessPlan,
  indexHtml,
] = await Promise.all([
  readFile(new URL('../../functions/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/version3-emulator/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/package.json', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/geminiProviderAdapter.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/geminiCostPolicy.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/geminiTransport.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/liveRuntime.js', import.meta.url), 'utf8'),
  readFile(new URL('../../VERSION3_REAL_GEMINI_READINESS_PLAN.md', import.meta.url), 'utf8'),
  readFile(new URL('../../index.html', import.meta.url), 'utf8'),
])

test('real Gemini layer is server-only, pinned, and absent from the emulator entry point', () => {
  assert.equal(JSON.parse(functionsPackage).dependencies['@google/genai'], '2.18.0')
  assert.match(functionsIndex, /createVersion3GeminiLiveHandler/)
  assert.match(functionsIndex, /defineSecret\('GEMINI_API_KEY'\)/)
  assert.match(functionsIndex, /enforceAppCheck: true/)
  assert.match(functionsIndex, /consumeAppCheckToken: true/)
  assert.doesNotMatch(emulatorFunctionsIndex, /geminiProviderAdapter|geminiCostPolicy|@google\/genai/)
  assert.doesNotMatch(indexHtml, /GEMINI_API_KEY|@google\/genai/)
})

test('dormant adapter has no environment, secret, SDK, or direct network access', () => {
  for (const source of [adapterSource, costSource]) {
    assert.doesNotMatch(
      source,
      /process\.env|defineSecret|SecretManager|@google\/genai|fetch\(|https?:\/\//,
    )
  }
  assert.match(adapterSource, /generateContentOnce/)
  assert.match(adapterSource, /thinkingLevel: 'minimal'/)
  assert.match(adapterSource, /Timing-pattern evidence is disabled/)
})

test('live transport explicitly disables retries and keeps the dormant adapter pure', () => {
  assert.match(transportSource, /from '@google\/genai'/)
  assert.match(transportSource, /retryOptions: Object\.freeze\(\{ attempts: 1 \}\)/)
  assert.match(transportSource, /timeout: 60_000/)
  assert.doesNotMatch(transportSource, /setTimeout|for\s*\(|while\s*\(/)
  assert.match(liveRuntimeSource, /gemini-3\.5-flash-lite-live-v1/)
})

test('historical readiness plan records the external cutover gates being implemented', () => {
  assert.match(readinessPlan, /no Gemini SDK, API key, Firebase/)
  assert.match(readinessPlan, /No automatic generation retry/)
  assert.match(readinessPlan, /App Check/)
  assert.match(readinessPlan, /requires new authorization and is outside this checkpoint/)
  assert.match(readinessPlan, /No commit, push, pull request, Firebase access, provider call/)
})

test('budget wording is truthful about the non-guaranteed combined target', () => {
  assert.match(indexHtml, /Combined budget target/)
  assert.match(indexHtml, /Not a guaranteed hard cap/)
  assert.doesNotMatch(indexHtml, /Monthly maximum/)
})
