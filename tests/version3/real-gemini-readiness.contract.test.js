import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [
  functionsIndex,
  emulatorFunctionsIndex,
  functionsPackage,
  adapterSource,
  costSource,
  readinessPlan,
  indexHtml,
] = await Promise.all([
  readFile(new URL('../../functions/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/version3-emulator/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/package.json', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/geminiProviderAdapter.js', import.meta.url), 'utf8'),
  readFile(new URL('../../functions/insights/geminiCostPolicy.js', import.meta.url), 'utf8'),
  readFile(new URL('../../VERSION3_REAL_GEMINI_READINESS_PLAN.md', import.meta.url), 'utf8'),
  readFile(new URL('../../index.html', import.meta.url), 'utf8'),
])

test('real Gemini layer is dormant and absent from both Functions entry points', () => {
  for (const source of [functionsIndex, emulatorFunctionsIndex]) {
    assert.doesNotMatch(source, /geminiProviderAdapter|geminiCostPolicy|gemini-3\.5-flash-lite/)
  }
  assert.equal(Object.hasOwn(JSON.parse(functionsPackage).dependencies, '@google/genai'), false)
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

test('readiness plan keeps every external action behind a later gate', () => {
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
