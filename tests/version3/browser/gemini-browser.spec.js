import { expect, test } from "@playwright/test";

import {
  PROJECT_ID,
  TENANT_A,
  TENANT_B,
  clearInsightUsageState,
  cleanupBrowserFixtures,
  seedBrowserFixtures,
} from "./gemini-browser-fixtures.js";

test.beforeAll(async () => {
  await seedBrowserFixtures();
});

test.beforeEach(async () => {
  await clearInsightUsageState();
});

test.afterAll(async () => {
  await cleanupBrowserFixtures();
});

async function openApp(page) {
  await page.goto("/");
  await expect.poll(async () => page.evaluate(() => ({
    appReady: typeof window.importBackup === "function",
    harnessReady: window.__VERSION3_GEMINI_TEST__?.ready === true,
    projectId: window.__VERSION3_GEMINI_TEST__?.projectId?.() ?? null,
    authAppName: window.__VERSION3_GEMINI_TEST__?.authAppName?.() ?? null,
    lastError: window.__VERSION3_GEMINI_TEST__?.lastError?.() ?? null,
  })), { timeout: 25_000 }).toEqual({
    appReady: true,
    harnessReady: true,
    projectId: PROJECT_ID,
    authAppName: "phase2b-emulator-app",
    lastError: null,
  });
}

async function signIn(page, tenant) {
  const uid = await page.evaluate(
    ({ email, password }) => window.__VERSION3_GEMINI_TEST__.signInTeacher(email, password),
    tenant,
  );
  await expect.poll(() => page.evaluate(() => window.__VERSION3_GEMINI_TEST__.currentUid()))
    .toBe(uid);
  await expect(page.locator(".activity-title").filter({ hasText: tenant.studentName }).first())
    .toBeVisible();
  await page.evaluate(() => window.setScreen("insights"));
  await expect(page.getByTestId("provider-insights-action")).toBeVisible();
  await expect(page.getByTestId("provider-question-submit")).toBeVisible();
  return uid;
}

async function startHeldQuickRequest(page) {
  const before = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.readyResponseCount());
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.holdNextResponse());
  await page.getByTestId("provider-insights-action").click();
  await expect(page.getByTestId("provider-insights-loading")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__VERSION3_GEMINI_TEST__.readyResponseCount()), {
    timeout: 25_000,
  }).toBe(before + 1);
}

async function releaseHeldResponses(page) {
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.releaseResponses());
}

async function browserStorageSnapshot(page) {
  return page.evaluate(() => {
    const snapshot = storage => Array.from(
      { length: storage.length },
      (_, index) => storage.key(index),
    )
      .filter(key => key !== null)
      .sort()
      .map(key => [key, storage.getItem(key)]);
    return {
      localStorage: snapshot(window.localStorage),
      sessionStorage: snapshot(window.sessionStorage),
    };
  });
}

test("authenticated click keeps browser storage unchanged, blocks duplicates, safely retries the same replay, and renders only its tenant", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const storageBefore = await browserStorageSnapshot(page);
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.makeNextOutcomeAmbiguous());
  await startHeldQuickRequest(page);

  await page.evaluate(() => window.generateProviderInsights("quick"));
  expect(await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.callCount())).toBe(1);
  await releaseHeldResponses(page);

  await expect(page.getByTestId("provider-insights-error")).toContainText(
    "The result may still be finishing.",
  );
  await page.getByTestId("provider-insights-retry").click();
  await expect(page.getByTestId("provider-insights-report")).toBeVisible();
  await expect(page.getByTestId("provider-insights-report")).toContainText(TENANT_A.studentName);
  await expect(page.getByTestId("provider-insights-report")).not.toContainText(TENANT_A.foreignName);

  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(2);
  expect(Object.keys(calls[0]).sort()).toEqual(["mode", "periodDays", "requestId"]);
  expect(calls[1]).toEqual(calls[0]);
  expect(await browserStorageSnapshot(page)).toEqual(storageBefore);
});

test("Get More Insights uses the selected period and the same exact three-field boundary", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.evaluate(() => window.setInsightsPeriod(90));
  await expect(page.getByTestId("provider-insights-action")).toHaveText("Get AI Insights");
  await page.getByTestId("provider-insights-action").click();
  await expect(page.getByTestId("provider-insights-report")).toContainText("last 90 days");
  await expect(page.getByTestId("provider-insights-action")).toHaveText("Get More Insights");
  await page.getByTestId("provider-insights-action").click();
  await expect(page.getByTestId("provider-insights-report")).toContainText("last 90 days");
  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ mode: "quick", periodDays: 90 });
  expect(calls[1]).toMatchObject({ mode: "deep", periodDays: 90 });
  for (const call of calls) {
    expect(Object.keys(call).sort()).toEqual(["mode", "periodDays", "requestId"]);
  }
});

test("logout makes a late AI result disappear", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuickRequest(page);
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.signOutCurrent());
  await expect.poll(() => page.evaluate(() => window.__VERSION3_GEMINI_TEST__.currentUid())).toBeNull();
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-insights-report")).toHaveCount(0);
  await expect(page.getByText(TENANT_A.studentName, { exact: true })).toHaveCount(0);
});

test("changing the period makes a late AI result disappear", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuickRequest(page);
  await page.evaluate(() => window.setInsightsPeriod(7));
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-insights-report")).toHaveCount(0);
  await expect(page.getByText("7 days", { exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("changing classroom data makes a late AI result disappear", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuickRequest(page);
  await page.evaluate(() => window.changeProviderInsightsLocalDataForTest());
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-insights-report")).toHaveCount(0);
});

test("switching teachers discards the old result and the new teacher sees only the new classroom", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuickRequest(page);
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.signOutCurrent());
  await expect.poll(() => page.evaluate(() => window.__VERSION3_GEMINI_TEST__.currentUid())).toBeNull();
  await signIn(page, TENANT_B);
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-insights-report")).toHaveCount(0);

  await page.getByTestId("provider-insights-action").click();
  await expect(page.getByTestId("provider-insights-report")).toContainText(TENANT_B.studentName);
  await expect(page.getByTestId("provider-insights-report")).not.toContainText(TENANT_B.foreignName);
});

test("a newer request wins and an older late result cannot replace it", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuickRequest(page);
  await page.evaluate(() => window.setInsightsPeriod(7));
  await page.getByTestId("provider-insights-action").click();
  await expect(page.getByTestId("provider-insights-report")).toContainText("last 7 days");
  const beforeRelease = await page.getByTestId("provider-insights-report").innerText();
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-insights-report")).toContainText("last 7 days");
  expect(await page.getByTestId("provider-insights-report").innerText()).toBe(beforeRelease);
});

test("a malformed response is rejected with bounded text and no raw detail", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.corruptNextResponse());
  await page.getByTestId("provider-insights-action").click();
  await expect(page.getByTestId("provider-insights-error")).toContainText(
    "AI test insights could not be loaded.",
  );
  await expect(page.getByTestId("provider-insights-error")).not.toContainText("unexpected");
  await expect(page.getByTestId("provider-insights-error")).not.toContainText("invalid-response");
});

test("opening AI Insights makes no request until the teacher clicks", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  expect(await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.callCount())).toBe(0);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.callCount())).toBe(0);
});

test("teacher question uses the exact five-field request and renders a server-calculated answer", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const storageBefore = await browserStorageSnapshot(page);
  await page.locator("#providerQuestionInput").fill(
    `What category is ${TENANT_A.studentName} earning the most money in?`,
  );
  await page.getByTestId("provider-question-submit").click();
  await expect(page.getByTestId("provider-question-result")).toContainText(TENANT_A.studentName);
  await expect(page.getByTestId("provider-question-result")).toContainText("Class job");
  await expect(page.getByTestId("provider-question-result")).toContainText("$12.00");
  await expect(page.getByTestId("provider-question-result")).not.toContainText(TENANT_A.foreignName);

  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]).sort()).toEqual([
    "kind",
    "periodDays",
    "question",
    "requestId",
    "timeZone",
  ]);
  expect(calls[0]).toMatchObject({ kind: "question", periodDays: 30 });
  expect(calls[0].question).toContain(TENANT_A.studentName);
  expect(await browserStorageSnapshot(page)).toEqual(storageBefore);
});

test("changing the period discards a late question answer", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.locator("#providerQuestionInput").fill(
    `What category is ${TENANT_A.studentName} earning the most money in?`,
  );
  const before = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.readyResponseCount());
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.holdNextResponse());
  await page.getByTestId("provider-question-submit").click();
  await expect(page.getByTestId("provider-question-loading")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__VERSION3_GEMINI_TEST__.readyResponseCount()), {
    timeout: 25_000,
  }).toBe(before + 1);
  await page.evaluate(() => window.setInsightsPeriod(7));
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-question-result")).toHaveCount(0);
  await expect(page.getByText("7 days", { exact: true })).toHaveAttribute("aria-pressed", "true");
});
