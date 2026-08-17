import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [indexHtml, browserClient, browserViteConfig, packageJson] = await Promise.all([
  readFile(new URL("../../index.html", import.meta.url), "utf8"),
  readFile(new URL("../../src/insights/providerInsightsClient.js", import.meta.url), "utf8"),
  readFile(new URL("./browser/vite.gemini-browser.config.js", import.meta.url), "utf8"),
  readFile(new URL("../../package.json", import.meta.url), "utf8"),
]);

test("source contract: assisted controls are default-off and locked to the one demo project", () => {
  assert.match(indexHtml, /VITE_VERSION3_GEMINI_BROWSER_TEST === "true"/);
  assert.match(indexHtml, /runtimeConfig: window\.VERSION3_GEMINI_BROWSER_TEST_CONFIG/);
  assert.match(indexHtml, /&& app\.options\.projectId === VERSION3_GEMINI_BROWSER_PROJECT_ID/);
  assert.match(indexHtml, /\$\{providerInsightsEnabled \? `[\s\S]*?data-testid="provider-insights-controls"/);
  assert.match(browserClient, /demo-morgan-bank-version3-gemini-callable-browser/);
  assert.match(browserViteConfig, /VITE_VERSION3_GEMINI_BROWSER_TEST/);
  assert.doesNotMatch(browserViteConfig, /morgan-bank-staging|["']morgan-bank["']/);
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

test("source contract: local Insights remains visible and explicitly zero-cost", () => {
  assert.match(indexHtml, /onclick="generateLocalInsights\('quick'\)"[^>]*>Quick Insights<\/button>/);
  assert.match(indexHtml, /onclick="generateLocalInsights\('deep'\)"[^>]*>Deep Analysis<\/button>/);
  assert.match(indexHtml, /Analysis runs locally · No additional Gemini or Firebase call · \$0\.00 API cost/);
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
