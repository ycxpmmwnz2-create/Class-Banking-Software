import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [indexHtml, providerClientSource, packageJson] = await Promise.all([
  readFile(new URL("../../index.html", import.meta.url), "utf8"),
  readFile(new URL("../../src/insights/providerInsightsClient.js", import.meta.url), "utf8"),
  readFile(new URL("../../package.json", import.meta.url), "utf8"),
]);

test("source contract: AI Insights is teacher-only and immediately after Dashboard", () => {
  assert.match(
    indexHtml,
    /isTeacher\s*\?\s*`<button onclick="setScreen\('teacher'\)">Dashboard<\/button>`[\s\S]*?isTeacher\s*\?\s*`<button onclick="setScreen\('insights'\)">Insights<\/button>`/,
  );
  assert.match(indexHtml, /if \(screen === "insights" && isTeacher\)/);
  assert.match(indexHtml, /function setInsightsPeriod\(days\) \{\s*if \(!requireTeacher\(\)\) return;/);
  assert.match(indexHtml, /async function askProviderQuestion\(retry = false\)/);
});

test("source contract: the page exposes one model-neutral initial/more flow and only three periods", () => {
  assert.match(indexHtml, /<h2>AI Insights<\/h2>/);
  assert.match(indexHtml, /Get AI Insights/);
  assert.match(indexHtml, /Get More Insights/);
  assert.match(providerClientSource, /PROVIDER_INSIGHTS_PERIODS = Object\.freeze\(\[7, 30, 90\]\)/);
  for (const forbidden of [
    /Gemini Quick/,
    /Gemini Deep/,
    /Quick Insights<\/button>/,
    /Deep Analysis/,
    /Morgan Bank Version 3/,
    /Gemini allowance/,
    /Firebase allowance/,
    /Combined budget target/,
    /API cost/,
  ]) assert.doesNotMatch(indexHtml, forbidden);
});

test("source contract: production has no local analysis call site or fallback", () => {
  assert.doesNotMatch(indexHtml, /buildClassInsightsReport|generateLocalInsights|insightsReport/);
  assert.doesNotMatch(indexHtml, /Analysis runs locally|Local analysis|\$0\.00 API cost/);
  assert.match(indexHtml, /AI Insights are currently unavailable for this classroom/);
  assert.match(indexHtml, /providerInsightsClient\.analyze\(request\)/);
});

test("source contract: Q&A is explicit, exact-shaped, period-bound, and never automatic", () => {
  assert.match(indexHtml, /data-testid="provider-question-submit"/);
  assert.match(indexHtml, /onclick="askProviderQuestion\(\)"/);
  assert.match(indexHtml, /kind: "question",\s*periodDays,\s*timeZone,\s*question,/);
  assert.match(providerClientSource, /QUESTION_REQUEST_FIELDS = Object\.freeze\(\[\s*"requestId",\s*"kind",\s*"periodDays",\s*"timeZone",\s*"question",/);
  assert.match(providerClientSource, /async ask\(request\)[\s\S]*?callable\(accepted\)/);
  assert.doesNotMatch(indexHtml, /(?:render|setScreen|setInsightsPeriod)\([^)]*\)[\s\S]{0,120}?askProviderQuestion\(/);
});

test("source contract: tenant and data changes discard both generated insights and answers", () => {
  assert.match(indexHtml, /providerQuestionDataSignature === dataSignature/);
  assert.match(indexHtml, /v2TenantSession\.validateCapturedIdentity\(providerQuestionCapturedIdentity\)/);
  assert.match(indexHtml, /providerQuestionRequestVersion \+= 1;/);
  assert.match(indexHtml, /providerQuestionResult = null;/);
  assert.match(indexHtml, /function resetAllGlobalState\(\)[\s\S]*?insightsPeriodDays = 30;[\s\S]*?resetProviderInsightsState\(\);/);
});

test("source contract: the focused Version 3 test command remains local", () => {
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(
    scripts["test:version3:insights"],
    "node --test 'src/insights/*.test.js' 'tests/version3/*.test.js'",
  );
  assert.doesNotMatch(scripts["test:version3:insights"], /firebase|emulator|playwright|curl|https?:/i);
});
