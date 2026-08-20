import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [indexHtml, insightsSource, packageJson, plan] = await Promise.all([
  readFile(new URL("../../index.html", import.meta.url), "utf8"),
  readFile(new URL("../../functions/insights/classInsights.js", import.meta.url), "utf8"),
  readFile(new URL("../../package.json", import.meta.url), "utf8"),
  readFile(new URL("../../VERSION3_AI_INSIGHTS_PLAN.md", import.meta.url), "utf8"),
]);

test("source contract: Insights is a teacher-only destination immediately after Dashboard", () => {
  assert.match(
    indexHtml,
    /isTeacher\s*\?\s*`<button onclick="setScreen\('teacher'\)">Dashboard<\/button>`[\s\S]*?isTeacher\s*\?\s*`<button onclick="setScreen\('insights'\)">Insights<\/button>`/,
  );
  assert.match(indexHtml, /if \(screen === "insights" && isTeacher\)/);
  assert.match(indexHtml, /function setInsightsPeriod\(days\) \{\s*if \(!requireTeacher\(\)\) return;/);
  assert.match(indexHtml, /function generateLocalInsights\(mode\) \{\s*if \(!requireTeacher\(\)\) return;/);
});

test("source contract: the first item exposes Quick Insights, Deep Analysis, and only three period choices", () => {
  assert.match(indexHtml, /generateLocalInsights\('quick'\)[^>]*>Quick Insights<\/button>/);
  assert.match(indexHtml, /generateLocalInsights\('deep'\)[^>]*>Deep Analysis<\/button>/);
  assert.match(insightsSource, /export const INSIGHTS_PERIODS = Object\.freeze\(\[7, 30, 90\]\)/);
});

test("source contract: opening or rendering Insights cannot trigger the deterministic report implicitly", () => {
  const calls = indexHtml.match(/buildClassInsightsReport\(/g) || [];
  assert.equal(calls.length, 1, "the report builder must have one explicit production call site");
  assert.match(
    indexHtml,
    /function generateLocalInsights\(mode\)[\s\S]*?buildClassInsightsReport\([\s\S]*?screen = "insights";/,
  );
  assert.match(indexHtml, /onclick="generateLocalInsights\('quick'\)"/);
  assert.match(indexHtml, /onclick="generateLocalInsights\('deep'\)"/);
});

test("source contract: the local Insights engine has no Firebase, provider, network, or persistence dependency", () => {
  for (const forbidden of [
    /from\s+["']firebase(?:\/|["'])/i,
    /FirebaseAI|GoogleAIBackend|GenerativeModel|GoogleGenerativeAI/,
    /httpsCallable/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /localStorage/,
    /sessionStorage/,
    /setDoc/,
    /getDoc/,
  ]) {
    assert.doesNotMatch(insightsSource, forbidden);
  }
  assert.match(indexHtml, /Analysis runs locally · No additional Gemini or Firebase call · \$0\.00 API cost/);
});

test("source contract: approved monthly allowances are exact and separately presented", () => {
  assert.match(insightsSource, /geminiMonthlyUsd:\s*7\.5/);
  assert.match(insightsSource, /firebaseMonthlyUsd:\s*5/);
  assert.match(insightsSource, /combinedMonthlyUsd:\s*12\.5/);
  assert.match(indexHtml, /Gemini allowance/);
  assert.match(indexHtml, /Firebase allowance/);
  assert.match(indexHtml, /Combined budget target/);
  assert.match(indexHtml, /Not a guaranteed hard cap/);
  assert.match(indexHtml, /INSIGHTS_BUDGETS\.geminiMonthlyUsd\.toFixed\(2\)/);
  assert.match(indexHtml, /INSIGHTS_BUDGETS\.firebaseMonthlyUsd\.toFixed\(2\)/);
  assert.match(indexHtml, /INSIGHTS_BUDGETS\.combinedMonthlyUsd\.toFixed\(2\)/);
  assert.match(plan, /Gemini API: \*\*\$7\.50\*\*/);
  assert.match(plan, /Firebase: \*\*\$5\.00\*\*/);
  assert.match(plan, /Combined budget target: \*\*\$12\.50\*\*/);
});

test("source contract: insight view state is cleared during the tenant reset", () => {
  assert.match(
    indexHtml,
    /function resetAllGlobalState\(\)[\s\S]*?insightsPeriodDays = 30;[\s\S]*?insightsMode = "quick";[\s\S]*?insightsReport = null;[\s\S]*?insightsDataSignature = null;/,
  );
});

test("source contract: a classroom-data change discards the old report before rendering", () => {
  assert.match(
    indexHtml,
    /function discardStaleInsightsReport\(\)[\s\S]*?insightsDataSignature === currentInsightsDataSignature\(\)[\s\S]*?insightsReport = null;[\s\S]*?insightsDataSignature = null;/,
  );
  assert.match(
    indexHtml,
    /function render\(\)[\s\S]*?discardStaleInsightsReport\(\);/,
  );
  assert.match(
    indexHtml,
    /const currentDataSignature = currentInsightsDataSignature\(\);[\s\S]*?insightsReport = nextReport;[\s\S]*?insightsDataSignature = currentDataSignature;/,
  );
  assert.match(indexHtml, /Generated \$\{escapeHtml\(formattedInsightsGeneratedAt\(insightsReport\.generatedAt\)\)\}/);
});

test("source contract: the focused Version 3 test command runs behavior and wiring suites locally", () => {
  const parsed = JSON.parse(packageJson);
  assert.equal(
    parsed.scripts["test:version3:insights"],
    "node --test 'src/insights/*.test.js' 'tests/version3/*.test.js'",
  );
  assert.doesNotMatch(parsed.scripts["test:version3:insights"], /firebase|emulator|playwright|curl|https?:/i);
});
