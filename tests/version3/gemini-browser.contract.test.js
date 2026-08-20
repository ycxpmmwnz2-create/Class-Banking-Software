import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [indexHtml, browserClient, providerAppCheck, browserViteConfig, packageJson] = await Promise.all([
  readFile(new URL("../../index.html", import.meta.url), "utf8"),
  readFile(new URL("../../src/insights/providerInsightsClient.js", import.meta.url), "utf8"),
  readFile(new URL("../../src/firebase/providerAppCheck.js", import.meta.url), "utf8"),
  readFile(new URL("./browser/vite.gemini-browser.config.js", import.meta.url), "utf8"),
  readFile(new URL("../../package.json", import.meta.url), "utf8"),
]);

test("source contract: assisted controls are default-off and locked to the one demo project", () => {
  assert.match(indexHtml, /VITE_VERSION3_GEMINI_BROWSER_TEST === "true"/);
  assert.match(indexHtml, /runtimeConfig: window\.VERSION3_GEMINI_BROWSER_TEST_CONFIG/);
  assert.match(indexHtml, /&& app\.options\.projectId === VERSION3_GEMINI_BROWSER_PROJECT_ID/);
  assert.match(indexHtml, /data-testid="provider-insights-action"/);
  assert.match(indexHtml, /!providerInsightsEnabled \|\| providerInsightsLoading \|\| providerQuestionLoading \? "disabled"/);
  assert.match(browserClient, /demo-morgan-bank-version3-gemini-callable-browser/);
  assert.match(browserViteConfig, /VITE_VERSION3_GEMINI_BROWSER_TEST/);
  assert.doesNotMatch(browserViteConfig, /morgan-bank-staging|["']morgan-bank["']/);
});

test("source contract: live assisted controls are exact-project, V2, and verified App Check gated", () => {
  assert.match(indexHtml, /VITE_VERSION3_GEMINI_LIVE === "true"/);
  assert.match(indexHtml, /resolveLiveProviderInsightsBrowserActivation\(\{/);
  assert.match(indexHtml, /providerAppCheckReadyPromise\.then\(appCheckReady/);
  assert.match(indexHtml, /appCheckReady,/);
  assert.match(indexHtml, /v2Enabled: IS_MULTI_TEACHER_V2_ENABLED/);
  assert.match(indexHtml, /limitedUseAppCheckTokens: true/);
  assert.match(browserClient, /production: "morgan-bank"/);
  assert.match(browserClient, /staging: "morgan-bank-staging"/);
  assert.match(browserClient, /buildEnabled === true[\s\S]*?appCheckReady === true[\s\S]*?v2Enabled === true/);
  assert.match(providerAppCheck, /await getLimitedUseTokenFn\(appCheck\)/);
  assert.doesNotMatch(providerAppCheck, /Boolean\(appCheck\)/);
  assert.doesNotMatch(indexHtml, /GEMINI_API_KEY/);
});

test("source contract: browser request carries exactly requestId, mode, and periodDays", () => {
  assert.match(browserClient, /REQUEST_FIELDS = Object\.freeze\(\["requestId", "mode", "periodDays"\]\)/);
  assert.match(
    indexHtml,
    /try \{\s*if \(!request\) \{\s*request = \{\s*requestId: providerInsightsClient\.newRequestId\(\),\s*mode: acceptedMode,\s*periodDays,\s*\};/,
  );
  const requestBody = indexHtml.match(
    /request = \{\s*([\s\S]*?)\s*\};\s*\}\s*const result = await providerInsightsClient\.analyze\(request\);/,
  )?.[1];
  assert.ok(requestBody, "the new-request object must remain directly attached to the analyzed request");
  assert.deepEqual(
    [...requestBody.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)(?::|,)/gm)].map(match => match[1]),
    ["requestId", "mode", "periodDays"],
  );
});

test("source contract: assisted state is in memory, reset with tenant state, and stale-checked", () => {
  assert.match(indexHtml, /function resetProviderInsightsState\(\)[\s\S]*?providerInsightsReport = null;[\s\S]*?providerInsightsRetryRequest = null;/);
  assert.match(indexHtml, /function resetAllGlobalState\(\)[\s\S]*?resetProviderInsightsState\(\);/);
  assert.match(indexHtml, /v2TenantSession\.validateCapturedIdentity\(capturedIdentity\)/);
  assert.match(indexHtml, /currentInsightsDataSignature\(\) === dataSignature/);
  assert.match(indexHtml, /providerInsightsRequestVersion === requestVersion/);
  assert.match(
    indexHtml,
    /function changeProviderInsightsLocalDataForTest\(\) \{\s*if \(!providerInsightsEnabled \|\| !requireTeacher\(\)/,
  );
  assert.doesNotMatch(browserClient, /localStorage|sessionStorage|setDoc|getDoc|fetch\s*\(/);
});

test("source contract: test tenant loading cannot become browser authority for the Insights request", () => {
  assert.match(
    indexHtml,
    /providerInsightsEnabled[\s\S]*?name === "resolveTeacherTenantV2"[\s\S]*?__VERSION3_RESOLVE_TEACHER_TENANT__/,
  );
  assert.match(browserViteConfig, /VERSION3_GEMINI_BROWSER_HARNESS/);
  assert.doesNotMatch(browserClient, /__VERSION3_RESOLVE_TEACHER_TENANT__/);
});

test("source contract: production has no local fallback and the UI stays model-neutral", () => {
  assert.doesNotMatch(indexHtml, /generateLocalInsights|buildClassInsightsReport|Analysis runs locally|Local analysis/);
  assert.match(indexHtml, /AI Insights are currently unavailable for this classroom/);
  assert.match(indexHtml, /Get AI Insights/);
  assert.match(indexHtml, /Get More Insights/);
  assert.doesNotMatch(indexHtml, /Gemini Quick|Gemini Deep|API cost|Gemini allowance/);
});

test("source contract: focused Chromium and WebKit commands use only three emulators", () => {
  const scripts = JSON.parse(packageJson).scripts;
  for (const browser of ["chromium", "webkit"]) {
    const command = scripts[`test:version3:gemini-browser:${browser}`];
    assert.match(command, /demo-morgan-bank-version3-gemini-callable-browser/);
    assert.match(command, /--only auth,functions,firestore/);
    assert.match(command, new RegExp(`--project=${browser}`));
    assert.match(command, /application_default_credentials\.json/);
    assert.doesNotMatch(command, /firebase\s+deploy|morgan-bank-staging\.web\.app/);
  }
});
