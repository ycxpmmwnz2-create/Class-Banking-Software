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

test("source contract: Dashboard places concise AI guidance beside login information and rent", () => {
  assert.match(
    indexHtml,
    /class="teacher-dashboard-top-row[\s\S]*?class="teacher-dashboard-essential student-login-info"[\s\S]*?id="teacherRentCard"[\s\S]*?class="teacher-dashboard-essential insights-dashboard-card"/,
  );
  assert.match(indexHtml, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(indexHtml, /<span class="insights-eyebrow">Classroom patterns<\/span>/);
  assert.match(indexHtml, /<h2>AI Insights<\/h2>/);
  assert.match(
    indexHtml,
    /<p>Review classroom patterns and ask questions about your data\. Open the AI Insights tab for full details\.<\/p>/,
  );
  assert.doesNotMatch(indexHtml, /See what changed without crowding the dashboard/);
  assert.doesNotMatch(indexHtml, /Open one calm, focused view/);
});

test("source contract: the page exposes teacher-selected quick questions and only three periods", () => {
  assert.match(indexHtml, /<h2>AI Insights<\/h2>/);
  assert.match(indexHtml, /aria-label="Quick insight questions"/);
  for (const label of ["Lowest balances", "Spending patterns", "Rent check", "Repeated requests"]) {
    assert.match(indexHtml, new RegExp(label));
  }
  assert.equal(indexHtml.match(/data-testid="provider-quick-question"/g)?.length, 1);
  assert.doesNotMatch(indexHtml, /provider-insights-action|Get AI Insights|Get More Insights/);
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
  assert.doesNotMatch(indexHtml, /providerInsightsClient\.analyze\(request\)|generateProviderInsights/);
  assert.match(indexHtml, /providerInsightsClient\.ask\(request\)/);
});

test("source contract: Q&A is explicit, paragraph-shaped, period-bound, and never automatic", () => {
  assert.match(indexHtml, /data-testid="provider-question-submit"/);
  assert.match(indexHtml, /onclick="submitProviderQuestion\(\)"/);
  assert.match(indexHtml, /onclick="retryProviderQuestion\(\)"/);
  assert.match(
    indexHtml,
    /function submitProviderQuestion\(\)[\s\S]*?if \(!providerInsightsEnabled \|\| !providerInsightsClient\)[\s\S]*?providerQuestionError = "AI Insights could not start in this browser\./,
  );
  assert.match(
    indexHtml,
    /data-testid="provider-question-submit"[\s\S]*?\$\{providerQuestionLoading \? "disabled" : ""\}/,
  );
  assert.match(indexHtml, /aria-keyshortcuts="Enter"/);
  assert.match(indexHtml, /onkeydown="handleProviderQuestionKeyDown\(event\)"/);
  assert.match(
    indexHtml,
    /function handleProviderQuestionKeyDown\(event\) \{[\s\S]*?event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing[\s\S]*?event\.preventDefault\(\);[\s\S]*?submitProviderQuestion\(\);/,
  );
  assert.match(
    indexHtml,
    /providerQuestionResult = result;\s*if \(providerQuestionDraft === request\.question\) providerQuestionDraft = "";/,
  );
  assert.match(indexHtml, /<p class="insights-answer-copy">\$\{escapeHtml\(providerQuestionResult\.answer\)\}<\/p>/);
  assert.match(indexHtml, /\.insights-answer-copy\s*\{[\s\S]*?white-space: pre-line;/);
  assert.match(indexHtml, /<details class="insights-answer-details">[\s\S]*?<summary>How this was calculated<\/summary>/);
  assert.doesNotMatch(indexHtml, /class="insight-observation"/);
  assert.match(indexHtml, /Who did not pay rent today, or how can I encourage saving\?/);
  assert.match(indexHtml, /Morgan Bank features, or classroom-economy ideas/);
  assert.doesNotMatch(indexHtml, /Get a focused look at your classroom data|Ready when you are/);
  assert.match(indexHtml, /kind: "question",\s*periodDays,\s*timeZone,\s*question,/);
  assert.match(providerClientSource, /QUESTION_REQUEST_FIELDS = Object\.freeze\(\[\s*"requestId",\s*"kind",\s*"periodDays",\s*"timeZone",\s*"question",/);
  assert.match(providerClientSource, /async ask\(request\)[\s\S]*?callable\(accepted\)/);
  assert.equal(
    indexHtml.match(/\bsubmitProviderQuestion\(\)/g)?.length,
    3,
    "the explicit submit wrapper may appear only in its definition, Enter handler, and button click handler",
  );
  assert.equal(
    indexHtml.match(/askProviderQuestion\(/g)?.length,
    3,
    "askProviderQuestion may be called only from the explicit submit and retry wrappers",
  );
  assert.equal(
    indexHtml.match(/retryProviderQuestion\(\)/g)?.length,
    2,
    "the explicit retry wrapper may appear only in its definition and retry button click handler",
  );
});

test("source contract: tenant and data changes discard question answers", () => {
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
