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
  await expect(page.getByTestId("provider-question-card")).toBeVisible();
  await expect(page.getByTestId("provider-quick-question")).toHaveCount(4);
  await expect(page.getByTestId("provider-question-submit")).toBeVisible();
  return uid;
}

const RESTROOM_QUESTION = "Who has used the restroom the most today?";
const QUICK_CHOICES = Object.freeze([
  Object.freeze(["Lowest balances", "Who currently has the lowest balance?"]),
  Object.freeze(["Spending patterns", "What category are students spending the most money in?"]),
  Object.freeze(["Rent check", "Which students did not pay rent today?"]),
  Object.freeze(["Repeated requests", "Who has submitted the most pending Add Money requests?"]),
]);

async function startHeldQuestionRequest(page, question = RESTROOM_QUESTION) {
  const before = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.readyResponseCount());
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.holdNextResponse());
  await page.locator("#providerQuestionInput").fill(question);
  await page.getByTestId("provider-question-submit").click();
  await expect(page.getByTestId("provider-question-loading")).toBeVisible();
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

test("authenticated question keeps browser storage unchanged, blocks duplicates, safely retries the same replay, and renders only its tenant", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const storageBefore = await browserStorageSnapshot(page);
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.makeNextOutcomeAmbiguous());
  await startHeldQuestionRequest(page);

  await page.evaluate(() => window.submitProviderQuestion());
  expect(await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.callCount())).toBe(1);
  await releaseHeldResponses(page);

  await expect(page.getByTestId("provider-question-error")).toContainText(
    "The result may still be finishing.",
  );
  await expect(page.locator("#providerQuestionInput")).toHaveValue(RESTROOM_QUESTION);
  await page.getByTestId("provider-question-retry").click();
  await expect(page.getByTestId("provider-question-result")).toBeVisible();
  await expect(page.getByTestId("provider-question-result")).toContainText(TENANT_A.studentName);
  await expect(page.getByTestId("provider-question-result")).not.toContainText(TENANT_A.foreignName);
  await expect(page.locator("#providerQuestionInput")).toHaveValue("");

  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(2);
  expect(Object.keys(calls[0]).sort()).toEqual(["kind", "periodDays", "question", "requestId", "timeZone"]);
  expect(calls[1]).toEqual(calls[0]);
  expect(await browserStorageSnapshot(page)).toEqual(storageBefore);
});

test("quick questions fill the prompt, Enter submits, and the selected period stays inside the exact safe request", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.evaluate(() => window.setInsightsPeriod(90));
  await page.locator("#providerQuestionInput").fill("A two-line question");
  await page.locator("#providerQuestionInput").press("Shift+Enter");
  await expect(page.locator("#providerQuestionInput")).toHaveValue("A two-line question\n");
  expect(await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.callCount())).toBe(0);
  await page.getByTestId("provider-quick-question").filter({ hasText: "Rent check" }).click();
  await expect(page.locator("#providerQuestionInput")).toHaveValue("Which students did not pay rent today?");
  await page.locator("#providerQuestionInput").press("Enter");
  await expect(page.getByTestId("provider-question-result")).toBeVisible();
  await expect(page.getByTestId("provider-question-result").locator(".insights-answer-copy")).toHaveCount(1);
  await expect(page.getByTestId("provider-question-result").locator(".insights-answer-details")).not.toHaveAttribute("open", "");
  await expect(page.locator("#providerQuestionInput")).toHaveValue("");
  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    kind: "question",
    periodDays: 90,
    question: "Which students did not pay rent today?",
  });
  const browserTimeZone = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  for (const call of calls) {
    expect(Object.keys(call).sort()).toEqual(["kind", "periodDays", "question", "requestId", "timeZone"]);
    expect(call.timeZone).toBe(browserTimeZone);
  }
});

for (const [label, question] of QUICK_CHOICES) {
  test(`quick insight choice "${label}" produces one paragraph answer and clears the successful prompt`, async ({ page }) => {
    await openApp(page);
    await signIn(page, TENANT_A);
    await page.getByTestId("provider-quick-question").filter({ hasText: label }).click();
    await expect(page.locator("#providerQuestionInput")).toHaveValue(question);
    await page.locator("#providerQuestionInput").press("Enter");
    await expect.poll(() => page.evaluate(() => window.__VERSION3_GEMINI_TEST__.callCount()))
      .toBe(1);
    const result = page.getByTestId("provider-question-result");
    await expect(result).toBeVisible();
    await expect(result.locator(".insights-answer-copy")).not.toHaveText("");
    await expect(result.locator(".insights-answer-copy")).not.toContainText("but not that request");
    await expect(result.locator(".insights-answer-copy")).toHaveCount(1);
    await expect(page.locator("#providerQuestionInput")).toHaveValue("");
    const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
    expect(calls).toHaveLength(1);
    expect(calls[0].question).toBe(question);
  });
}

test("lists every current student balance in one result without crossing tenants", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const question = "List for me each student and their current balance";
  await page.locator("#providerQuestionInput").fill(question);
  await page.locator("#providerQuestionInput").press("Enter");
  const result = page.getByTestId("provider-question-result");
  await expect(result).toBeVisible();
  const answer = result.locator(".insights-answer-copy");
  await expect(answer).toHaveCount(1);
  const sortedBalances = [
    [TENANT_A.studentName, "$45.00"],
    [TENANT_A.classmateName, "-$5.00"],
  ].sort(([left], [right]) => left.localeCompare(right, "en-US"));
  expect(await answer.textContent()).toBe(
    `Current balances for all 2 students:\n${sortedBalances.map(([name, balance]) => `${name}: ${balance}`).join("\n")}`,
  );
  await expect(result).not.toContainText(TENANT_A.foreignName);
  await expect(page.locator("#providerQuestionInput")).toHaveValue("");
  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(1);
  expect(calls[0].question).toBe(question);
});

test("a successful answer preserves a new draft typed while the submitted question is loading", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuestionRequest(page);
  const newDraft = "What should I ask next?";
  await page.locator("#providerQuestionInput").fill(newDraft);
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-question-result")).toBeVisible();
  await expect(page.locator("#providerQuestionInput")).toHaveValue(newDraft);
});

test("logout makes a late AI result disappear", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuestionRequest(page);
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.signOutCurrent());
  await expect.poll(() => page.evaluate(() => window.__VERSION3_GEMINI_TEST__.currentUid())).toBeNull();
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-question-result")).toHaveCount(0);
  await expect(page.getByText(TENANT_A.studentName, { exact: true })).toHaveCount(0);
});

test("changing the period makes a late AI result disappear", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuestionRequest(page);
  await page.evaluate(() => window.setInsightsPeriod(7));
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-question-result")).toHaveCount(0);
  await expect(page.getByText("7 days", { exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("changing classroom data makes a late AI result disappear", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuestionRequest(page);
  await page.evaluate(() => window.changeProviderInsightsLocalDataForTest());
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-question-result")).toHaveCount(0);
});

test("switching teachers discards the old result and the new teacher sees only the new classroom", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuestionRequest(page);
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.signOutCurrent());
  await expect.poll(() => page.evaluate(() => window.__VERSION3_GEMINI_TEST__.currentUid())).toBeNull();
  await signIn(page, TENANT_B);
  await releaseHeldResponses(page);
  await expect(page.getByTestId("provider-question-result")).toHaveCount(0);

  await page.locator("#providerQuestionInput").fill(RESTROOM_QUESTION);
  await page.locator("#providerQuestionInput").press("Enter");
  await expect(page.getByTestId("provider-question-result")).toContainText(TENANT_B.studentName);
  await expect(page.getByTestId("provider-question-result")).not.toContainText(TENANT_B.foreignName);
});

test("a newer request wins and an older late result cannot replace it", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await startHeldQuestionRequest(page);
  await page.evaluate(() => window.setInsightsPeriod(7));
  await page.locator("#providerQuestionInput").fill("Who currently has the lowest balance?");
  await page.locator("#providerQuestionInput").press("Enter");
  await expect(page.getByTestId("provider-question-result")).toBeVisible();
  const beforeRelease = await page.getByTestId("provider-question-result").innerText();
  await releaseHeldResponses(page);
  expect(await page.getByTestId("provider-question-result").innerText()).toBe(beforeRelease);
});

test("a malformed response is rejected with bounded text and no raw detail", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.corruptNextResponse());
  await page.locator("#providerQuestionInput").fill(RESTROOM_QUESTION);
  await page.locator("#providerQuestionInput").press("Enter");
  await expect(page.getByTestId("provider-question-error")).toContainText(
    "AI test insights could not be loaded.",
  );
  await expect(page.getByTestId("provider-question-error")).not.toContainText("unexpected");
  await expect(page.getByTestId("provider-question-error")).not.toContainText("invalid-response");
  await expect(page.locator("#providerQuestionInput")).toHaveValue(RESTROOM_QUESTION);
});

test("opening AI Insights or selecting a quick question makes no request until the teacher submits", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  expect(await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.callCount())).toBe(0);
  await page.getByTestId("provider-quick-question").filter({ hasText: "Lowest balances" }).click();
  await expect(page.locator("#providerQuestionInput")).toHaveValue("Who currently has the lowest balance?");
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.callCount())).toBe(0);
});

test("teacher cleanup keeps the Dashboard compact and moves authorization logs under Settings", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.evaluate(() => window.setScreen("teacher"));
  await page.getByRole("tab", { name: "Custom Transaction" }).click();

  const studentPicker = page.getByTestId("dashboard-student-picker");
  const transactions = page.getByTestId("dashboard-transactions");
  await expect(studentPicker).not.toHaveAttribute("open", "");
  await expect(transactions).not.toHaveAttribute("open", "");

  await studentPicker.locator("summary").click();
  await expect(studentPicker).toHaveAttribute("open", "");
  await expect(studentPicker.locator(".student-check").first()).toBeVisible();

  await transactions.locator("summary").click();
  await expect(transactions).toHaveAttribute("open", "");
  await expect(transactions.getByLabel("Filter transactions")).toBeVisible();

  await expect(page.getByRole("button", { name: "Student Auth Logs" })).toHaveCount(0);
  await page.evaluate(() => window.setScreen("settings"));
  await expect(page.getByRole("heading", { name: "Student Authorization Logs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "View Authorization Logs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible();
});

test("natural restroom question uses the exact five-field request and ranks visits by count", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const storageBefore = await browserStorageSnapshot(page);
  await page.locator("#providerQuestionInput").fill(RESTROOM_QUESTION);
  await page.getByTestId("provider-question-submit").click();
  await expect(page.getByTestId("provider-question-result")).toContainText(TENANT_A.studentName);
  await expect(page.getByTestId("provider-question-result")).toContainText("Bathroom break");
  await expect(page.getByTestId("provider-question-result")).toContainText("3 transactions");
  await expect(page.getByTestId("provider-question-result")).not.toContainText(TENANT_A.classmateName);
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
  expect(calls[0].question).toBe(RESTROOM_QUESTION);
  expect(await browserStorageSnapshot(page)).toEqual(storageBefore);
});

test("broad duplicate-transaction question is calculated instead of refused as unsupported", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const question = "Are there any students who have duplicate transactions today?";
  await page.locator("#providerQuestionInput").fill(question);
  await page.getByTestId("provider-question-submit").click();

  const result = page.getByTestId("provider-question-result");
  await expect(result).toBeVisible();
  await expect(result.locator(".insights-answer-copy")).toContainText(/^(Yes|No)\./);
  await expect(result).not.toContainText("but not that request");
  await expect(result).not.toContainText("outside the Morgan Bank classroom-assistant scope");
  await expect(result).not.toContainText(TENANT_A.foreignName);

  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]).sort()).toEqual([
    "kind",
    "periodDays",
    "question",
    "requestId",
    "timeZone",
  ]);
  expect(calls[0].question).toBe(question);
});

test("today-versus-yesterday submission question renders both calendar days", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const question = `Did ${TENANT_A.studentName} submit ${TENANT_A.reason} yesterday or today?`;
  await page.locator("#providerQuestionInput").fill(question);
  await page.getByTestId("provider-question-submit").click();

  const result = page.getByTestId("provider-question-result");
  await expect(result).toContainText(TENANT_A.studentName);
  await expect(result).toContainText("0 transactions");
  await expect(result).toContainText("1 transaction");
  await expect(result).toContainText("today and yesterday");
  await expect(result).not.toContainText(TENANT_A.foreignName);

  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(1);
  expect(calls[0].question).toBe(question);
});

test("current-week payment question uses the exact safe request and server-calculated week", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const question = `Has ${TENANT_A.studentName} been paid for Class job all three days this week or just yesterday?`;
  await page.locator("#providerQuestionInput").fill(question);
  await page.getByTestId("provider-question-submit").click();

  const result = page.getByTestId("provider-question-result");
  await expect(result).toContainText(TENANT_A.studentName);
  await expect(result.locator(".insights-answer-copy")).toHaveText(
    `${TENANT_A.studentName} received approved Class job credits on 3 different days this week.`,
  );
  await expect(result.locator(".insights-answer-copy")).not.toContainText("Calculation");
  await expect(result.locator(".insights-answer-copy")).not.toContainText("transaction count");
  await expect(result).not.toContainText(TENANT_A.foreignName);

  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]).sort()).toEqual([
    "kind",
    "periodDays",
    "question",
    "requestId",
    "timeZone",
  ]);
  expect(calls[0].question).toBe(question);
});

test("general analytics lists every current negative balance", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.locator("#providerQuestionInput").fill("Which students currently have a negative balance?");
  await page.getByTestId("provider-question-submit").click();
  const answer = page.getByTestId("provider-question-result").locator(".insights-answer-copy");
  await expect(answer).toContainText(`1 current student has a negative balance: ${TENANT_A.classmateName} (-$5.00)`);
  await expect(answer).not.toContainText(TENANT_A.studentName);
});

test("general analytics answers a named student's 10-day balance history", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.locator("#providerQuestionInput").fill(`Show ${TENANT_A.studentName}'s account balance over the last 10 days.`);
  await page.getByTestId("provider-question-submit").click();
  const answer = page.getByTestId("provider-question-result").locator(".insights-answer-copy");
  await expect(answer).toContainText(`${TENANT_A.studentName}'s end-of-day balance`);
  await expect(answer).toContainText("$45.00");
  await expect(answer).toContainText("over the last 10 days");
});

test("general analytics answers when approved money is given out most", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.locator("#providerQuestionInput").fill("Around what time of day is money given out the most?");
  await page.getByTestId("provider-question-submit").click();
  const answer = page.getByTestId("provider-question-result").locator(".insights-answer-copy");
  await expect(answer).toContainText("Money was added most during the");
  await expect(answer).toContainText("$36.00");
  await expect(answer).not.toContainText("highest total amount");
  await expect(answer).not.toContainText(TENANT_A.foreignName);
});

test("rent question names current students without an approved exact payment today", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.locator("#providerQuestionInput").fill("Who did not pay $10 in rent today?");
  await page.getByTestId("provider-question-submit").click();
  await expect(page.getByTestId("provider-question-result")).toContainText(TENANT_A.classmateName);
  await expect(page.getByTestId("provider-question-result")).toContainText("$10.00");
  await expect(page.getByTestId("provider-question-result")).toContainText("rent payment");
  await expect(page.getByTestId("provider-question-result")).not.toContainText(TENANT_A.studentName);
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
  expect(calls[0].question).toBe("Who did not pay $10 in rent today?");
});

test("rent question without a typed amount uses the server-owned configured rent", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  await page.locator("#providerQuestionInput").fill("Who did not pay rent today?");
  await page.getByTestId("provider-question-submit").click();
  const result = page.getByTestId("provider-question-result");
  await expect(result).toContainText(TENANT_A.classmateName);
  await expect(result).toContainText("configured rent amount of $10.00");
  await expect(result).not.toContainText(TENANT_A.studentName);
  await expect(result).not.toContainText(TENANT_A.foreignName);
});

test("Morgan Bank guidance question receives useful domain help without claiming classroom facts", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const question = "How can I help students build a saving habit in Morgan Bank?";
  await page.locator("#providerQuestionInput").fill(question);
  await page.getByTestId("provider-question-submit").click();
  const result = page.getByTestId("provider-question-result");
  await expect(result).toContainText("savings goal");
  await expect(result).toContainText("no classroom records were used");
  await expect(result).not.toContainText(TENANT_A.studentName);
  await expect(result).not.toContainText(TENANT_A.classmateName);
  await expect(result).not.toContainText(TENANT_A.foreignName);

  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]).sort()).toEqual([
    "kind",
    "periodDays",
    "question",
    "requestId",
    "timeZone",
  ]);
  expect(calls[0].question).toBe(question);
});

test("one question can combine a calculated classroom answer with general Morgan Bank guidance", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  const question = "Who has the lowest balance, and how can I help them set a goal?";
  await page.locator("#providerQuestionInput").fill(question);
  await page.getByTestId("provider-question-submit").click();
  const result = page.getByTestId("provider-question-result");
  await expect(result).toContainText(/lowest current balance/i);
  await expect(result).toContainText("General Morgan Bank guidance");
  await expect(result).toContainText("realistic next goal");
  await expect(result).not.toContainText(TENANT_A.foreignName);

  const calls = await page.evaluate(() => window.__VERSION3_GEMINI_TEST__.calls());
  expect(calls).toHaveLength(1);
  expect(calls[0].question).toBe(question);
});

test("unrelated and data-changing requests receive the bounded unsupported response", async ({ page }) => {
  await openApp(page);
  await signIn(page, TENANT_A);
  for (const question of [
    "Write a poem about the moon.",
    "Change every student balance to $100.",
  ]) {
    await page.locator("#providerQuestionInput").fill(question);
    await page.getByTestId("provider-question-submit").click();
    const result = page.getByTestId("provider-question-result");
    await expect(result).toContainText("I can help with Morgan Bank");
    await expect(result).toContainText("No answer was generated outside");
    await expect(result).not.toContainText(TENANT_A.studentName);
    await expect(result).not.toContainText(TENANT_A.foreignName);
  }
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
