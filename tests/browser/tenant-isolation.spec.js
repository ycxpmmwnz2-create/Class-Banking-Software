// Phase 2B Item 10: real-browser tenant isolation contracts.
//
// ASSERTION HONESTY — these constraints are deliberate; do not "strengthen" the
// titles without also strengthening the mechanism:
//
//  * Nothing here claims a purge is observable "synchronously before incoming
//    resolution". Playwright cannot observe an intra-task window. What IS
//    asserted is ORDERING (purge-side effects precede resolution-side effects)
//    and NO INTERMEDIATE RENDER containing outgoing sentinels, captured by a
//    MutationObserver installed BEFORE the switch.
//
//  * Nothing here claims a sentinel "never" reappears from one final snapshot.
//    "Never" claims are bounded by a stated quiescence window: the harness
//    activity counter must remain unchanged across a documented expect.poll
//    interval, and the MutationObserver log must contain no offending record for
//    the whole observed window.
//
//  * Epoch/event counts are asserted as MONOTONIC and BOUNDED, never as an exact
//    +1 delta. The auth observer double-invalidates by design (index.html plus
//    tenantClient.js), so an exact delta would encode a bug as a requirement.
//
//  * An already-accepted outgoing server write is read back honestly rather than
//    claimed cancelled. Cancellation applies to CLIENT-SIDE effects.

import { expect, test } from "@playwright/test";

import {
  PROJECT_ID,
  SHARED_LOGIN_ID,
  SHARED_STUDENT_NAME,
  TENANT_A,
  TENANT_B,
  cacheKey,
  cleanupFixtures,
  createStudentIdentity,
  poisonEnvelopes,
  readClassroomWithRulesDisabled,
  readInvitationWithRulesDisabled,
  seedAll
} from "./phase2b-fixtures.js";
import { registerTenantDataBrowserTests } from "../phase3/tenant-data.browser.spec.js";

// Documented quiescence window. Two consecutive stable polls at this interval
// are what licenses any bounded "no further effect" claim below.
const QUIESCENCE_INTERVAL_MS = 250;
const QUIESCENCE_POLLS = 4;

let seeded;

test.beforeAll(async () => {
  seeded = await seedAll();
});

test.afterAll(async () => {
  await cleanupFixtures();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function gotoApp(page) {
  await page.goto("/");
  await waitForAppReady(page);
}

async function waitForAppReady(page) {
  // The harness installs BEFORE the application module, so harness readiness
  // proves nothing about the app. index.html is one large inline module: a
  // top-level ReferenceError aborts the whole thing silently (exactly the
  // updateStudent regression fixed in 19ec8a7). The real gate is therefore a
  // window export written at the END of that module.
  const expected = {
    appExportReady: true,
    harnessReady: true,
    projectId: PROJECT_ID,
    authAppName: "phase2b-emulator-app",
    forceLongPolling: test.info().project.name === "webkit",
    lastError: null
  };
  let lastSignature = null;
  let stablePolls = 0;

  await expect
    .poll(
      async () => {
        try {
          const snapshot = await page.evaluate(() => ({
            appExportReady: typeof window.importBackup === "function",
            harnessReady: window.__PHASE2B_TEST__?.ready === true,
            projectId: window.__PHASE2B_TEST__?.projectId?.() ?? null,
            authAppName: window.__PHASE2B_TEST__?.authAppName?.() ?? null,
            forceLongPolling:
              window.PHASE2B_EMULATOR_TEST_CONFIG?.forceLongPolling ?? null,
            lastError: window.__PHASE2B_TEST__?.lastError?.() ?? null
          }));
          const signature = JSON.stringify(snapshot);
          stablePolls = signature === lastSignature ? stablePolls + 1 : 1;
          lastSignature = signature;
          return JSON.stringify(snapshot) === JSON.stringify(expected) ? stablePolls : 0;
        } catch (error) {
          if (/Execution context was destroyed|most likely because of a navigation/.test(error.message)) {
            // A cold Vite server can optimize dependencies and replace the
            // first document. Prove readiness in the replacement context.
            lastSignature = null;
            stablePolls = 0;
            return 0;
          }
          throw error;
        }
      },
      { intervals: Array(40).fill(100), timeout: 20_000 }
    )
    .toBeGreaterThanOrEqual(3);
}

// Installs a MutationObserver BEFORE the action under test, recording every
// added/changed text payload so "no intermediate render contained X" is a claim
// about the whole window rather than a final snapshot.
async function startDomRecorder(page) {
  await page.evaluate(() => {
    window.__DOM_LOG__ = [];
    window.__DOM_OBS__?.disconnect();
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") {
          window.__DOM_LOG__.push(String(r.target.data || ""));
        }
        for (const n of r.addedNodes || []) {
          window.__DOM_LOG__.push(String(n.textContent || ""));
        }
      }
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.__DOM_OBS__ = obs;
  });
}

async function domLog(page) {
  return page.evaluate(() => (window.__DOM_LOG__ || []).slice());
}

// Waits until the harness activity total stops changing across the documented
// window. Returns the stable total so callers can assert boundedness.
async function waitForQuiescence(page) {
  let last = -1;
  let stable = 0;
  await expect
    .poll(
      async () => {
        let now;
        try {
          now = await page.evaluate(() => window.__PHASE2B_TEST__.activityTotal());
        } catch (error) {
          if (/Execution context was destroyed|most likely because of a navigation/.test(error.message)) {
            // A reload can replace the document between two quiescence polls.
            // Reset the stability window and keep polling the new context.
            last = -1;
            stable = 0;
            return stable;
          }
          throw error;
        }
        stable = now === last ? stable + 1 : 0;
        last = now;
        return stable;
      },
      { intervals: Array(40).fill(QUIESCENCE_INTERVAL_MS), timeout: 30_000 }
    )
    .toBeGreaterThanOrEqual(QUIESCENCE_POLLS);
  return last;
}

// Auth always goes through the harness, which closes over firebase.js's live
// `auth` binding. A bare getAuth() would resolve the DEFAULT app — production
// morgan-bank — and authenticate against production while asserting against
// emulator data.
async function signIn(page, tenant) {
  return page.evaluate(
    ({ email, password }) => window.__PHASE2B_TEST__.signInTeacher(email, password),
    { email: tenant.email, password: tenant.password }
  );
}

async function signInPersistently(page, tenant) {
  return page.evaluate(
    ({ email, password }) => window.__PHASE2B_TEST__.signInTeacherPersistently(email, password),
    { email: tenant.email, password: tenant.password }
  );
}

async function signOutPage(page) {
  await page.evaluate(() => window.__PHASE2B_TEST__.signOutCurrent());
}

async function startProductionSettingsSave(page, marker) {
  const before = await page.evaluate(
    () => window.__PHASE2B_TEST__.counters().saveAdapterCalls
  );
  await page.evaluate((value) => {
    // Drive the application's exported UI functions. This reaches saveData()
    // and orchestrateClassroomDataSave with the real TenantSession; calling the
    // injected adapter directly would bypass the epoch contract under test.
    window.setScreen("editSettingsLists");
    const input = document.getElementById("purchaseCategoryList");
    if (!input) throw new Error("production settings list input did not render");
    input.value = value;
    window.saveSettingsLists();
  }, marker);
  await expect
    .poll(() => page.evaluate(() => window.__PHASE2B_TEST__.counters().saveAdapterCalls))
    .toBeGreaterThan(before);
}

// Positive proof that a sign-in actually established the expected tenant.
// Without this, every "foreign sentinel absent" assertion below could pass
// vacuously on a page that simply never resolved anything.
async function assertTenantEstablished(page, tenant, uid) {
  await expect
    .poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid()), { timeout: 20_000 })
    .toBe(uid);

  await expect
    .poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentClassroomId()), { timeout: 20_000 })
    .toBe(tenant.classroomId);

  const key = cacheKey(PROJECT_ID, uid, tenant.classroomId);
  await expect
    .poll(
      async () => {
        const envelope = await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), key);
        if (!envelope) return null;
        try {
          const parsed = JSON.parse(envelope);
          return {
            ownerUid: parsed.ownerUid,
            projectId: parsed.projectId,
            classroomId: parsed.classroomId
          };
        } catch {
          // A malformed envelope is deliberately installed by the poison-cache
          // coverage. WebKit can expose the short replacement window here, so
          // keep waiting for the network-loaded envelope that proves readiness.
          return null;
        }
      },
      {
        message: `${tenant.label}: rejected cache must be replaced by a valid owned envelope`,
        timeout: 20_000
      }
    )
    .toEqual({
      ownerUid: uid,
      projectId: PROJECT_ID,
      classroomId: tenant.classroomId
    });

  // The tenant's own sentinel must be present, and the foreign one absent.
  const text = await pageText(page);
  expect(text, `${tenant.label}: own sentinel must render`).toContain(tenant.studentMarker);
  expect(text, `${tenant.label}: foreign sentinel must not render`).not.toContain(
    foreign(tenant).studentMarker
  );
}

async function assertTenantPurged(page, tenant, uid) {
  const key = cacheKey(PROJECT_ID, uid, tenant.classroomId);
  expect(await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), key)).toBeNull();
  expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();
  const text = await pageText(page);
  for (const sentinel of sentinelsOf(tenant)) {
    expect(text, `${tenant.label}: invalidated tenant sentinel must be absent`).not.toContain(
      sentinel
    );
  }
}

function foreign(tenant) {
  return tenant === TENANT_A ? TENANT_B : TENANT_A;
}

function sentinelsOf(tenant) {
  return [
    tenant.classroomMarker,
    tenant.studentMarker,
    tenant.transactionMarker,
    tenant.historyMarker,
    tenant.authLogMarker
  ];
}

async function pageText(page) {
  return page.evaluate(() => document.body.innerText || "");
}

test("platform-admin invitation UI is authority-gated and creates a server-only invitation", async ({
  page
}) => {
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_A, seeded.aUid);

  const adminButton = page.getByRole("button", { name: "Teacher Invitations" });
  await expect(adminButton).toBeVisible();
  await adminButton.click();
  await page.getByLabel("Teacher Google email").fill("browser.friend@example.test");
  await page.getByLabel("Invitation expires after").selectOption("24");
  await page.getByRole("button", { name: "Create Invitation" }).click();
  await expect(page.getByText("Invitation created. The teacher can now sign in with Google.")).toBeVisible();

  const invitation = await readInvitationWithRulesDisabled("browser.friend@example.test");
  expect(invitation).not.toBeNull();
  expect(Object.keys(invitation).sort()).toEqual(["createdAt", "email", "expiresAt", "status"]);
  expect(invitation.email).toBe("browser.friend@example.test");
  expect(invitation.status).toBe("active");

  await signOutPage(page);
  await signIn(page, TENANT_B);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_B, seeded.bUid);
  await expect(page.getByRole("button", { name: "Teacher Invitations" })).toHaveCount(0);

  await page.evaluate(() => window.setScreen("teacherInvitations"));
  await expect(page.getByRole("heading", { name: "Teacher Invitations" })).toHaveCount(0);
});

test("ready teacher header shows only the resolved tenant classroom code", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async value => {
          window.__COPIED_CLASSROOM_CODE__ = value;
        }
      }
    });
  });
  await gotoApp(page);

  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_A, seeded.aUid);

  const badge = page.locator(".hero-badge");
  await expect(badge).toContainText(`Classroom code: ${TENANT_A.studentLoginCode}`);
  await expect(badge).not.toContainText(TENANT_B.studentLoginCode);
  const desktopHeader = await page.evaluate(() => {
    const hero = document.querySelector(".hero");
    const title = hero?.querySelector("h1");
    const logo = hero?.querySelector(".center-logo");
    const content = hero?.querySelector(".hero-content");
    const navigation = document.querySelector(".button-bar");
    if (!hero || !title || !logo || !content || !navigation) {
      throw new Error("ready header did not render");
    }
    const heroRect = hero.getBoundingClientRect();
    const logoRect = logo.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    return {
      heroHeight: heroRect.height,
      titleHeight: title.getBoundingClientRect().height,
      titleLineHeight: Number.parseFloat(titleStyle.lineHeight),
      navigationTop: navigation.getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
      contentInsideHero:
        logoRect.left >= heroRect.left &&
        logoRect.right <= heroRect.right &&
        contentRect.left >= heroRect.left &&
        contentRect.right <= heroRect.right,
    };
  });
  expect(desktopHeader.heroHeight).toBeLessThan(260);
  expect(desktopHeader.titleHeight).toBeLessThanOrEqual(desktopHeader.titleLineHeight * 1.25);
  expect(desktopHeader.navigationTop).toBeLessThan(desktopHeader.viewportHeight);
  expect(desktopHeader.contentInsideHero).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileHeader = await page.evaluate(() => {
    const hero = document.querySelector(".hero");
    const badge = document.querySelector(".hero-badge");
    if (!hero || !badge) throw new Error("responsive header did not render");
    const heroRect = hero.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    return {
      heroHeight: heroRect.height,
      badgeInsideHero: badgeRect.left >= heroRect.left && badgeRect.right <= heroRect.right,
      pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  expect(mobileHeader.heroHeight).toBeLessThan(430);
  expect(mobileHeader.badgeInsideHero).toBe(true);
  expect(mobileHeader.pageOverflows).toBe(false);
  await page.setViewportSize({ width: 1280, height: 720 });
  const loginInfo = page.locator(".student-login-info");
  await expect(loginInfo).toContainText("Student Login Information");
  await expect(loginInfo.locator("#teacherStudentClassroomCode")).toHaveText(TENANT_A.studentLoginCode);
  const desktopLoginRentLayout = await page.locator(".teacher-login-rent-row").evaluate(row => {
    const login = row.querySelector(".student-login-info");
    const rent = row.querySelector("#teacherRentCard");
    if (!login || !rent) throw new Error("teacher login and rent cards did not render");
    const loginRect = login.getBoundingClientRect();
    const rentRect = rent.getBoundingClientRect();
    const rentDisplay = rent.querySelector("#teacherRentDisplay");
    if (!rentDisplay) throw new Error("teacher rent display did not render");
    const originalRentText = rentDisplay.textContent;
    rentDisplay.textContent = "$1,000,000";
    const maximumRentFits = rent.scrollWidth <= rent.clientWidth;
    rentDisplay.textContent = originalRentText;
    return {
      sameRow: Math.abs(loginRect.top - rentRect.top) <= 1,
      rentOnRight: rentRect.left > loginRect.right,
      rentFraction: rentRect.width / (loginRect.width + rentRect.width),
      maximumRentFits,
    };
  });
  expect(desktopLoginRentLayout.sameRow).toBe(true);
  expect(desktopLoginRentLayout.rentOnRight).toBe(true);
  expect(desktopLoginRentLayout.rentFraction).toBeGreaterThan(0.24);
  expect(desktopLoginRentLayout.rentFraction).toBeLessThan(0.26);
  expect(desktopLoginRentLayout.maximumRentFits).toBe(true);

  await page.emulateMedia({ media: "print" });
  expect(await page.locator(".teacher-login-rent-row").evaluate(row => getComputedStyle(row).display)).toBe("none");
  await page.emulateMedia({ media: "screen" });

  await page.setViewportSize({ width: 900, height: 900 });
  const compactLoginRentLayout = await page.locator(".teacher-login-rent-row").evaluate(row => {
    const login = row.querySelector(".student-login-info");
    const rent = row.querySelector("#teacherRentCard");
    if (!login || !rent) throw new Error("teacher login and rent cards did not render");
    const loginRect = login.getBoundingClientRect();
    const rentRect = rent.getBoundingClientRect();
    return {
      rentBelowLogin: rentRect.top >= loginRect.bottom,
      equalWidth: Math.abs(loginRect.width - rentRect.width) <= 1,
    };
  });
  expect(compactLoginRentLayout.rentBelowLogin).toBe(true);
  expect(compactLoginRentLayout.equalWidth).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  await loginInfo.getByRole("button", { name: "Copy classroom code" }).click();
  await expect.poll(() => page.evaluate(() => window.__COPIED_CLASSROOM_CODE__)).toBe(
    TENANT_A.studentLoginCode
  );
  await expect(page.getByText("Classroom code copied.")).toBeVisible();

  await loginInfo.getByRole("button", { name: "Copy student login link" }).click();
  await expect.poll(async () => {
    const copied = await page.evaluate(() => window.__COPIED_CLASSROOM_CODE__);
    return typeof copied === "string" && copied.startsWith("http") ? copied : "";
  }).not.toBe("");
  const copiedStudentLoginLink = await page.evaluate(() => window.__COPIED_CLASSROOM_CODE__);
  const copiedStudentLoginUrl = new URL(copiedStudentLoginLink);
  const currentAppUrl = new URL(page.url());
  expect(copiedStudentLoginUrl.origin).toBe(currentAppUrl.origin);
  expect(copiedStudentLoginUrl.pathname).toBe(currentAppUrl.pathname);
  expect(copiedStudentLoginUrl.search).toBe("");
  expect(copiedStudentLoginUrl.hash).toBe(`#student-login=${TENANT_A.studentLoginCode}`);
  expect(copiedStudentLoginLink).not.toContain(SHARED_LOGIN_ID);
  expect(copiedStudentLoginLink).not.toMatch(/pin|password|token|student-id/i);
  await expect(page.getByText("Student login link copied.")).toBeVisible();

  await signOutPage(page);
  await expect(page.locator(".student-login-info")).toHaveCount(0);
  await signIn(page, TENANT_B);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_B, seeded.bUid);

  await expect(badge).toContainText(`Classroom code: ${TENANT_B.studentLoginCode}`);
  await expect(badge).not.toContainText(TENANT_A.studentLoginCode);
  await expect(loginInfo.locator("#teacherStudentClassroomCode")).toHaveText(TENANT_B.studentLoginCode);
});

test("teacher local persistence survives a closed tab, synchronizes the profile, and production logout clears it", async ({
  context
}) => {
  // OAuth popup behavior is owned by Firebase/Google and is not reproducible
  // against the Auth emulator. The source contract pins the production Google
  // call site to browserLocalPersistence; this real-browser test proves that
  // exact Firebase persistence mode across a genuinely closed tab.
  const initialPage = await context.newPage();
  await gotoApp(initialPage);
  await signInPersistently(initialPage, TENANT_A);
  await waitForQuiescence(initialPage);
  await assertTenantEstablished(initialPage, TENANT_A, seeded.aUid);
  await initialPage.close();

  const restoredPage = await context.newPage();
  await gotoApp(restoredPage);
  await waitForQuiescence(restoredPage);
  await assertTenantEstablished(restoredPage, TENANT_A, seeded.aUid);

  const synchronizedPage = await context.newPage();
  await gotoApp(synchronizedPage);
  await waitForQuiescence(synchronizedPage);
  await assertTenantEstablished(synchronizedPage, TENANT_A, seeded.aUid);

  await restoredPage.getByRole("button", { name: "Log Out", exact: true }).click();
  await expect
    .poll(() => restoredPage.evaluate(() => window.__PHASE2B_TEST__.currentUid()))
    .toBeNull();
  await expect
    .poll(() => synchronizedPage.evaluate(() => window.__PHASE2B_TEST__.currentUid()))
    .toBeNull();
  await waitForQuiescence(restoredPage);
  await waitForQuiescence(synchronizedPage);
  expect(await pageText(synchronizedPage)).not.toContain(TENANT_A.studentMarker);
  await expect(restoredPage.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await synchronizedPage.close();
  await restoredPage.close();

  const signedOutPage = await context.newPage();
  await gotoApp(signedOutPage);
  await waitForQuiescence(signedOutPage);
  expect(await signedOutPage.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();
  expect(await pageText(signedOutPage)).not.toContain(TENANT_A.studentMarker);
  await expect(signedOutPage.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await signedOutPage.close();
});

test("a student-claimed harness session remains session-only after its tab closes", async ({ context }) => {
  // This isolates Firebase's session mode for an identity carrying real student
  // claims. Production-form coverage lives in student-session.gate-off.spec.js;
  // this test intentionally makes no claim about a custom-token call site.
  const student = await createStudentIdentity({
    classroomId: TENANT_A.classroomId,
    studentId: TENANT_A.sharedStudentId
  });
  const initialPage = await context.newPage();
  await gotoApp(initialPage);
  await initialPage.evaluate(
    ({ email, password }) => window.__PHASE2B_TEST__.signInTeacher(email, password),
    { email: student.email, password: student.password }
  );
  await expect
    .poll(() => initialPage.evaluate(() => window.__PHASE2B_TEST__.currentUid()))
    .toBe(student.uid);
  await waitForQuiescence(initialPage);
  await expect.poll(() => pageText(initialPage)).toContain(SHARED_STUDENT_NAME);
  await initialPage.close();

  const reopenedPage = await context.newPage();
  await gotoApp(reopenedPage);
  await waitForQuiescence(reopenedPage);
  expect(await reopenedPage.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();
  await expect(reopenedPage.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await reopenedPage.close();
});

test("clipboard denial uses the legacy fallback and leaves no temporary textarea", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("clipboard denied");
        }
      }
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: command => {
        window.__LEGACY_COPY_COMMANDS__ = [
          ...(window.__LEGACY_COPY_COMMANDS__ || []),
          command
        ];
        return undefined;
      }
    });
  });
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_A, seeded.aUid);

  const textareaCountBefore = await page.locator("textarea").count();
  await page.getByRole("button", { name: "Copy classroom code" }).click();

  await expect.poll(() => page.evaluate(() => window.__LEGACY_COPY_COMMANDS__)).toEqual(["copy"]);
  await expect(page.getByText(
    "Could not copy the classroom code. Select the code and copy it manually."
  )).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(textareaCountBefore);
});

// ---------------------------------------------------------------------------
// Account switching and ordinary refresh, run in BOTH directions.
// ---------------------------------------------------------------------------

for (const [outgoing, incoming] of [
  [TENANT_A, TENANT_B],
  [TENANT_B, TENANT_A]
]) {
  test(`switching ${outgoing.label} -> ${incoming.label} purges outgoing state with no intermediate outgoing render`, async ({
    page
  }) => {
    await gotoApp(page);
    await signIn(page, outgoing);
    await waitForQuiescence(page);

    const outgoingUid = outgoing === TENANT_A ? seeded.aUid : seeded.bUid;
    await assertTenantEstablished(page, outgoing, outgoingUid);
    const outgoingKey = cacheKey(PROJECT_ID, outgoingUid, outgoing.classroomId);

    // Record the DOM for the entire switch window, before the switch begins.
    await startDomRecorder(page);

    await signOutPage(page);
    await signIn(page, incoming);
    await waitForQuiescence(page);

    const incomingUid = incoming === TENANT_A ? seeded.aUid : seeded.bUid;
    await assertTenantEstablished(page, incoming, incomingUid);

    const log = await domLog(page);
    const joined = log.join("\n");

    // ORDERING + NO INTERMEDIATE RENDER, not an intra-task synchrony claim.
    for (const sentinel of sentinelsOf(outgoing)) {
      expect(
        joined.includes(sentinel),
        `No render during the switch window may contain outgoing sentinel ${sentinel}`
      ).toBe(false);
    }

    // Outgoing V2 cache and the legacy key are gone.
    expect(await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), outgoingKey)).toBeNull();
    expect(
      await page.evaluate(() => window.__PHASE2B_TEST__.localGet("mrMorganClassCashDataV5"))
    ).toBeNull();

    // Only incoming data is visible at readiness.
    const text = await pageText(page);
    for (const sentinel of sentinelsOf(outgoing)) {
      expect(text).not.toContain(sentinel);
    }
  });

  test(`a delayed ${outgoing.label} invalidation cannot purge the established ${incoming.label} cache envelope`, async ({
    page
  }) => {
    await gotoApp(page);
    await signIn(page, incoming);
    await waitForQuiescence(page);

    const incomingUid = incoming === TENANT_A ? seeded.aUid : seeded.bUid;
    await assertTenantEstablished(page, incoming, incomingUid);
    const incomingKey = cacheKey(PROJECT_ID, incomingUid, incoming.classroomId);

    // NOTE deliberately narrow: invalidate() unconditionally removes the legacy
    // key and calls onResetGlobals, so this asserts only that the INCOMING
    // tenant's own cache envelope survives a late outgoing invalidation.
    const outgoingUid = outgoing === TENANT_A ? seeded.aUid : seeded.bUid;
    const digest = await page.evaluate(async (uid) => {
      const mod = await import("/src/phase2b/tenantCache.js");
      return mod.computeSha256Digest(uid);
    }, outgoingUid);

    const before = await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), incomingKey);
    expect(before, "Precondition: incoming cache envelope exists").not.toBeNull();

    // A storage event only fires in OTHER same-origin pages, never in the page
    // that performed the write. So the late invalidation is delivered from a
    // second real page in the same context.
    const writer = await page.context().newPage();
    await gotoApp(writer);
    await writer.evaluate((payload) => {
      window.__PHASE2B_TEST__.localSet("morganBank:v2:invalidation", payload);
    }, JSON.stringify({ type: "session-invalidated", uidDigest: digest, epoch: 1 }));

    await waitForQuiescence(page);
    await writer.close();

    expect(
      await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), incomingKey),
      "The incoming tenant's cache envelope must survive a late outgoing invalidation"
    ).not.toBeNull();
  });

  test(`refresh as ${incoming.label} resolves before admitting cache, and rejects every poisoned envelope`, async ({
    page
  }) => {
    await gotoApp(page);
    await signIn(page, incoming);
    await waitForQuiescence(page);

    const uid = incoming === TENANT_A ? seeded.aUid : seeded.bUid;
    await assertTenantEstablished(page, incoming, uid);
    const other = foreign(incoming);
    const otherUid = incoming === TENANT_A ? seeded.bUid : seeded.aUid;
    const key = cacheKey(PROJECT_ID, uid, incoming.classroomId);

    const poisons = poisonEnvelopes({
      projectId: PROJECT_ID,
      uid,
      classroomId: incoming.classroomId,
      foreignUid: otherUid,
      foreignClassroomId: other.classroomId
    });

    for (const [label, envelope] of Object.entries(poisons)) {
      await page.evaluate(
        ({ k, v }) => window.__PHASE2B_TEST__.localSet(k, typeof v === "string" ? v : JSON.stringify(v)),
        { k: key, v: envelope }
      );

      await page.reload();
      await waitForAppReady(page);
      await waitForQuiescence(page);
      await assertTenantEstablished(page, incoming, uid);

      const text = await pageText(page);
      expect(text, `Poisoned envelope (${label}) must never render`).not.toContain(
        "POISONED_STUDENT"
      );
      expect(text, `Poisoned envelope (${label}) must not leak an injected marker`).not.toContain(
        "EXTRA_FIELD_MARKER"
      );

      // A rejected envelope must be replaced by a freshly network-loaded,
      // exactly matching envelope. Null is not accepted: that would allow this
      // test to pass when tenant resolution never completed.
      const after = await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), key);
      expect(after, `A fresh valid envelope must replace poison (${label})`).not.toBeNull();
      const parsed = JSON.parse(after);
      expect(parsed.ownerUid).toBe(uid);
      expect(parsed.classroomId).toBe(incoming.classroomId);
      expect(parsed.projectId).toBe(PROJECT_ID);
      expect(parsed.schemaVersion).toBe("v1");
      expect(JSON.stringify(parsed.data)).toContain(incoming.studentMarker);
      expect(JSON.stringify(parsed.data)).not.toContain("POISONED_STUDENT");
    }
  });
}

// ---------------------------------------------------------------------------
// Cross-tab quarantine, two pages in ONE browser context.
// ---------------------------------------------------------------------------

test("a sign-out in tab 1 invalidates tab 2, and tab 2 cannot restore A by refreshing", async ({
  context
}) => {
  const tab1 = await context.newPage();
  const tab2 = await context.newPage();

  await gotoApp(tab1);
  await signIn(tab1, TENANT_A);
  await waitForQuiescence(tab1);
  await assertTenantEstablished(tab1, TENANT_A, seeded.aUid);

  // Tab 2 must be EXPLICITLY signed in as A and positively confirmed, otherwise
  // "A is gone from tab 2" could pass on a tab that never had A at all.
  await gotoApp(tab2);
  await signIn(tab2, TENANT_A);
  await waitForQuiescence(tab2);
  await assertTenantEstablished(tab2, TENANT_A, seeded.aUid);

  const receivedBefore = await tab2.evaluate(
    () => window.__PHASE2B_TEST__.counters().broadcastsReceived
  );
  await startDomRecorder(tab2);

  await signOutPage(tab1);
  await expect
    .poll(() =>
      tab2.evaluate(() => window.__PHASE2B_TEST__.counters().broadcastsReceived)
    )
    .toBeGreaterThan(receivedBefore);
  await expect
    .poll(() => tab2.evaluate(() => window.__PHASE2B_TEST__.currentUid()))
    .toBeNull();
  await waitForQuiescence(tab2);

  // Tab 2 must no longer show A.
  const text2 = await pageText(tab2);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text2).not.toContain(sentinel);
  }

  // And a refresh must not bring A back — this is the browserSessionPersistence
  // reanimation path that Item 9 closed.
  await tab2.reload();
  await waitForAppReady(tab2);
  await waitForQuiescence(tab2);

  const afterRefresh = await pageText(tab2);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(afterRefresh, "A refresh must not reanimate the invalidated teacher").not.toContain(
      sentinel
    );
  }
  expect(await tab2.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();

  await tab1.close();
  await tab2.close();
});

test("an invalidation arriving before tab 2's first Auth observation is quarantined and still blocks A", async ({
  context
}) => {
  const tab1 = await context.newPage();
  await gotoApp(tab1);
  await signIn(tab1, TENANT_A);
  await waitForQuiescence(tab1);

  // The target tab must FIRST genuinely hold a persisted A session, otherwise
  // "A never resolved" is trivially true and the test proves nothing about the
  // pre-Auth window.
  const tab2 = await context.newPage();
  await gotoApp(tab2);
  await signIn(tab2, TENANT_A);
  await waitForQuiescence(tab2);
  await assertTenantEstablished(tab2, TENANT_A, seeded.aUid);

  const digest = await tab1.evaluate(async (uid) => {
    const mod = await import("/src/phase2b/tenantCache.js");
    return mod.computeSha256Digest(uid);
  }, seeded.aUid);

  await tab2.addInitScript(
    ({ d }) => {
      sessionStorage.setItem(
        "morganBank:v2:pendingInvalidation",
        JSON.stringify({ scope: "digest", uidDigests: [d] })
      );
    },
    { d: digest }
  );

  // Reload: Auth persistence still holds A, and the quarantine (installed by the
  // init script before any document script) must block it.
  await tab2.reload();
  await waitForAppReady(tab2);
  await waitForQuiescence(tab2);

  const text = await pageText(tab2);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text, "A quarantined identity must never resolve").not.toContain(sentinel);
  }
  expect(await tab2.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();

  await tab1.close();
  await tab2.close();
});

test("an A-only digest quarantine does not block B and remains owed to A", async ({ context }) => {
  const page = await context.newPage();
  await gotoApp(page);
  await signIn(page, TENANT_B);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_B, seeded.bUid);

  const digestA = await page.evaluate(
    async (uid) => {
      const mod = await import("/src/phase2b/tenantCache.js");
      return mod.computeSha256Digest(uid);
    },
    seeded.aUid
  );

  await page.addInitScript(
    (a) => {
      sessionStorage.setItem(
        "morganBank:v2:pendingInvalidation",
        JSON.stringify({ scope: "digest", uidDigests: [a] })
      );
    },
    digestA
  );

  // B is already persisted in this tab. On reload the first Auth observation
  // is therefore B, not a preliminary signed-out observation that correctly
  // clears completed quarantine state.
  await page.reload();
  await waitForAppReady(page);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_B, seeded.bUid);

  const stored = await page.evaluate(() =>
    window.__PHASE2B_TEST__.sessionGet("morganBank:v2:pendingInvalidation")
  );
  const parsed = JSON.parse(stored);
  expect(parsed.scope).toBe("digest");
  expect(parsed.uidDigests).toEqual([digestA]);

  await page.close();
});

test("a concurrent A/B quarantine blocks whichever persisted identity Auth observes", async ({
  context
}) => {
  const seedPage = await context.newPage();
  await gotoApp(seedPage);
  const [digestA, digestB] = await seedPage.evaluate(
    async ({ a, b }) => {
      const mod = await import("/src/phase2b/tenantCache.js");
      return [mod.computeSha256Digest(a), mod.computeSha256Digest(b)];
    },
    { a: seeded.aUid, b: seeded.bUid }
  );
  await seedPage.close();

  for (const [tenant, uid] of [[TENANT_A, seeded.aUid], [TENANT_B, seeded.bUid]]) {
    const page = await context.newPage();
    await gotoApp(page);
    await signIn(page, tenant);
    await waitForQuiescence(page);
    await assertTenantEstablished(page, tenant, uid);

    await page.addInitScript(
      ({ a, b }) => {
        sessionStorage.setItem(
          "morganBank:v2:pendingInvalidation",
          JSON.stringify({ scope: "digest", uidDigests: [a, b] })
        );
      },
      { a: digestA, b: digestB }
    );
    await page.reload();
    await waitForAppReady(page);
    await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();
    await waitForQuiescence(page);
    for (const sentinel of sentinelsOf(tenant)) {
      expect(await pageText(page)).not.toContain(sentinel);
    }
    await page.close();
  }
});

test("a genuinely malformed payload fails closed, prevents refresh reanimation, and generically blocks B", async ({
  context
}) => {
  const page = await context.newPage();
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_A, seeded.aUid);

  // A real cross-page storage event carrying an unparseable payload. Written
  // from a SECOND page, because a page never receives its own storage events.
  const writer = await context.newPage();
  await gotoApp(writer);
  const storageBefore = await page.evaluate(
    () => window.__PHASE2B_TEST__.counters().storageEventsReceived
  );
  await writer.evaluate(() => {
    window.__PHASE2B_TEST__.localSet("morganBank:v2:invalidation", "{ not valid json");
  });
  await expect
    .poll(() => page.evaluate(() => window.__PHASE2B_TEST__.counters().storageEventsReceived))
    .toBeGreaterThan(storageBefore);
  await waitForQuiescence(page);
  // Current tenant purged, fail-closed.
  await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();
  let text = await pageText(page);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text).not.toContain(sentinel);
  }

  // Successful local sign-out confirms the quarantine has done its job, so the
  // observer clears it. Refresh must nevertheless not reanimate A.
  await page.reload();
  await waitForAppReady(page);
  await waitForQuiescence(page);
  expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(await pageText(page)).not.toContain(sentinel);
  }

  // On a genuinely signed-out tab, a malformed payload names no tenant and
  // must remain generic until the next identity is observed.
  const blockedPage = await context.newPage();
  await gotoApp(blockedPage);
  await waitForQuiescence(blockedPage);
  const blockedStorageBefore = await blockedPage.evaluate(
    () => window.__PHASE2B_TEST__.counters().storageEventsReceived
  );
  await writer.evaluate(() => {
    window.__PHASE2B_TEST__.localSet("morganBank:v2:invalidation", "{ second malformed payload");
  });
  await expect
    .poll(() =>
      blockedPage.evaluate(() => window.__PHASE2B_TEST__.counters().storageEventsReceived)
    )
    .toBeGreaterThan(blockedStorageBefore);
  const marker = await blockedPage.evaluate(() =>
    window.__PHASE2B_TEST__.sessionGet("morganBank:v2:pendingInvalidation")
  );
  expect(JSON.parse(marker).scope).toBe("generic");

  // The documented availability cost: even B is blocked, because a malformed
  // payload names no tenant. This is intentional fail-closed behavior.
  await signIn(blockedPage, TENANT_B);
  await waitForQuiescence(blockedPage);
  text = await pageText(blockedPage);
  for (const sentinel of sentinelsOf(TENANT_B)) {
    expect(
      text,
      "A generic quarantine intentionally blocks the next identity, including B"
    ).not.toContain(sentinel);
  }
  expect(await blockedPage.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();

  await writer.close();
  await blockedPage.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// Native transports.
// ---------------------------------------------------------------------------

test("native BroadcastChannel: outbound payloads carry exactly type/uidDigest/epoch and no tenant data", async ({
  context
}) => {
  const tab1 = await context.newPage();
  const tab2 = await context.newPage();

  await gotoApp(tab1);
  await signIn(tab1, TENANT_A);
  await waitForQuiescence(tab1);
  await assertTenantEstablished(tab1, TENANT_A, seeded.aUid);

  await gotoApp(tab2);
  await waitForQuiescence(tab2);
  await signIn(tab2, TENANT_A);
  await waitForQuiescence(tab2);
  await assertTenantEstablished(tab2, TENANT_A, seeded.aUid);

  expect(
    await tab1.evaluate(() => typeof BroadcastChannel === "function"),
    "This run requires a genuine native BroadcastChannel"
  ).toBe(true);

  const tab2Before = await tab2.evaluate(() => window.__PHASE2B_TEST__.counters());
  await signOutPage(tab1);
  await waitForQuiescence(tab1);
  await expect
    .poll(() => tab2.evaluate(() => window.__PHASE2B_TEST__.counters().broadcastsReceived))
    .toBeGreaterThan(tab2Before.broadcastsReceived);
  await waitForQuiescence(tab2);

  const payloads = await tab1.evaluate(() => window.__PHASE2B_TEST__.outboundPayloads());
  expect(payloads.length, "Sign-out must broadcast at least once").toBeGreaterThan(0);

  for (const p of payloads) {
    expect(Object.keys(p).sort()).toEqual(["epoch", "type", "uidDigest"]);
    expect(p.type).toBe("session-invalidated");
    expect(p.uidDigest).toMatch(/^sha256_[0-9a-f]{64}$/);
    expect(Number.isInteger(p.epoch) && p.epoch >= 0).toBe(true);

    // Exact keys prove there is no tenant-data field. Compare exact values too,
    // rather than searching inside the irreversible digest: any short marker
    // (for example student ID "11") can occur coincidentally in SHA-256 hex.
    for (const forbidden of [
      TENANT_A.classroomId,
      TENANT_A.studentId,
      TENANT_A.email,
      TENANT_A.classroomMarker,
      TENANT_A.studentMarker,
      SHARED_LOGIN_ID,
      seeded.aUid
    ]) {
      expect(Object.values(p), `Broadcast payload must not expose ${forbidden}`).not.toContain(forbidden);
    }
  }

  const tab2After = await tab2.evaluate(() => window.__PHASE2B_TEST__.counters());
  expect(tab2After.broadcastsReceived).toBeGreaterThan(tab2Before.broadcastsReceived);
  expect(
    tab2After.broadcastsSent - tab2Before.broadcastsSent,
    "Observer-driven duplicate invalidations must remain bounded"
  ).toBeLessThanOrEqual(3);
  await assertTenantPurged(tab2, TENANT_A, seeded.aUid);

  await tab2.reload();
  await waitForAppReady(tab2);
  await waitForQuiescence(tab2);
  await assertTenantPurged(tab2, TENANT_A, seeded.aUid);

  await tab1.close();
  await tab2.close();
});

test("storage fallback with BroadcastChannel removed: two real same-origin pages, a real storage event", async ({
  browser
}) => {
  // A fresh context so the init script lands before any document script.
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    // Removed BEFORE any application code can capture a reference.
    delete window.BroadcastChannel;
  });

  const tab1 = await ctx.newPage();
  const tab2 = await ctx.newPage();

  await gotoApp(tab1);
  expect(await tab1.evaluate(() => typeof window.BroadcastChannel)).toBe("undefined");

  await signIn(tab1, TENANT_A);
  await waitForQuiescence(tab1);
  await assertTenantEstablished(tab1, TENANT_A, seeded.aUid);

  await gotoApp(tab2);
  await waitForQuiescence(tab2);
  await signIn(tab2, TENANT_A);
  await waitForQuiescence(tab2);
  await assertTenantEstablished(tab2, TENANT_A, seeded.aUid);

  await startDomRecorder(tab2);

  // A genuine cross-page storage event: never a direct receiveMessage() call.
  const storageBefore = await tab2.evaluate(
    () => window.__PHASE2B_TEST__.counters().storageEventsReceived
  );
  await signOutPage(tab1);
  await expect
    .poll(() => tab2.evaluate(() => window.__PHASE2B_TEST__.counters().storageEventsReceived))
    .toBeGreaterThan(storageBefore);
  await waitForQuiescence(tab2);

  expect(
    await tab2.evaluate(() => window.__PHASE2B_TEST__.counters().storageEventsReceived),
    "The fallback transport must deliver a real storage event"
  ).toBeGreaterThan(0);

  const text = await pageText(tab2);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text).not.toContain(sentinel);
  }
  await assertTenantPurged(tab2, TENANT_A, seeded.aUid);

  await tab2.reload();
  await waitForAppReady(tab2);
  await waitForQuiescence(tab2);
  await assertTenantPurged(tab2, TENANT_A, seeded.aUid);

  await ctx.close();
});

test("duplicate BroadcastChannel + storage delivery settles once and never rebroadcasts", async ({
  context
}) => {
  const page = await context.newPage();
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_A, seeded.aUid);

  const digest = await page.evaluate(async (uid) => {
    const mod = await import("/src/phase2b/tenantCache.js");
    return mod.computeSha256Digest(uid);
  }, seeded.aUid);

  const before = await page.evaluate(() => window.__PHASE2B_TEST__.counters());

  // The SAME invalidation over BOTH transports, sent from a second real page so
  // the storage event genuinely fires in the receiver.
  const sender = await context.newPage();
  await gotoApp(sender);
  await sender.evaluate((d) => {
    const msg = JSON.stringify({ type: "session-invalidated", uidDigest: d, epoch: 3 });
    const ch = new BroadcastChannel("morgan_bank_v2_invalidation");
    ch.postMessage(JSON.parse(msg));
    window.__PHASE2B_TEST__.localSet("morganBank:v2:invalidation", msg);
    ch.close();
  }, digest);

  await expect
    .poll(() => page.evaluate(() => window.__PHASE2B_TEST__.counters().broadcastsReceived))
    .toBeGreaterThan(before.broadcastsReceived);
  await expect
    .poll(() => page.evaluate(() => window.__PHASE2B_TEST__.counters().storageEventsReceived))
    .toBeGreaterThan(before.storageEventsReceived);

  const stableTotal = await waitForQuiescence(page);

  // Both transports must actually have reached the receiver, otherwise
  // "duplicate delivery is idempotent" would be untested.
  const after = await page.evaluate(() => window.__PHASE2B_TEST__.counters());
  expect(
    after.broadcastsReceived,
    "the BroadcastChannel transport must have delivered"
  ).toBeGreaterThan(before.broadcastsReceived);
  expect(
    after.storageEventsReceived,
    "the storage transport must have delivered"
  ).toBeGreaterThan(before.storageEventsReceived);

  // The old tenant must not have returned.
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(await pageText(page)).not.toContain(sentinel);
  }

  // Bounded, not an exact delta: the auth observer double-invalidates by design.
  const sentAfter = after.broadcastsSent;
  expect(
    sentAfter - before.broadcastsSent,
    "Observer-driven duplicate invalidations must settle without a rebroadcast loop"
  ).toBeLessThanOrEqual(3);
  await assertTenantPurged(page, TENANT_A, seeded.aUid);

  // Quiescence reached: effects are idempotent and settled.
  const secondTotal = await page.evaluate(() => window.__PHASE2B_TEST__.activityTotal());
  expect(secondTotal).toBe(stableTotal);

  await sender.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// Stale async completions and offline behavior.
// ---------------------------------------------------------------------------

test("a released stale classroom load cannot overwrite the incoming tenant", async ({ page }) => {
  await gotoApp(page);

  // Hold the real emulator-backed classroom load open.
  await page.evaluate(() => window.__PHASE2B_TEST__.hold("classroomLoad"));

  await signIn(page, TENANT_A);
  // A's load is now parked inside the harness barrier.
  await expect
    .poll(() => page.evaluate(() => window.__PHASE2B_TEST__.counters().loadAdapterCalls))
    .toBeGreaterThan(0);

  await startDomRecorder(page);

  // Switch to B while A's load is still outstanding.
  await signOutPage(page);
  await page.evaluate(() => window.__PHASE2B_TEST__.release("classroomLoad"));
  await signIn(page, TENANT_B);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_B, seeded.bUid);

  const log = (await domLog(page)).join("\n");
  const text = await pageText(page);

  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(log, `Stale A load must not render ${sentinel}`).not.toContain(sentinel);
    expect(text, `Stale A load must not leave ${sentinel} on screen`).not.toContain(sentinel);
  }

  // B's own cache must not have been clobbered by A's late completion.
  const bKey = cacheKey(PROJECT_ID, seeded.bUid, TENANT_B.classroomId);
  const bEnvelope = await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), bKey);
  expect(bEnvelope, "B's cache must exist after A's late completion").not.toBeNull();
  expect(JSON.parse(bEnvelope).ownerUid, "B's cache must still belong to B").toBe(seeded.bUid);
});

test("an already-accepted outgoing save is reported honestly rather than claimed cancelled", async ({
  page
}) => {
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_A, seeded.aUid);

  // Drive the production UI -> saveData -> orchestrator path and let the real
  // emulator write commit before switching.
  const doneBefore = await page.evaluate(
    () => window.__PHASE2B_TEST__.eventTypes().filter((x) => x === "saveAdapter:done").length
  );
  await startProductionSettingsSave(page, "A_ACCEPTED_WRITE");
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__PHASE2B_TEST__.eventTypes().filter((x) => x === "saveAdapter:done").length
      )
    )
    .toBeGreaterThan(doneBefore);

  // Switch tenants.
  await signOutPage(page);
  await signIn(page, TENANT_B);
  await waitForQuiescence(page);

  // The accepted write still exists server-side. That is the honest outcome:
  // switching tenants cancels CLIENT-side effects, not a committed server write.
  const aClassroom = await readClassroomWithRulesDisabled(TENANT_A.classroomId);
  const stillThere = aClassroom?.settings?.purchaseCategories?.[0] || null;
  expect(
    stillThere,
    "An accepted server write must be read back honestly, not claimed cancelled"
  ).toBe("A_ACCEPTED_WRITE");

  // But it must not be visible in B's session.
  const text = await pageText(page);
  expect(text).not.toContain("A_ACCEPTED_WRITE");
});

test("a REAL student session (custom claims) never writes a teacher V2 cache envelope", async ({
  page
}) => {
  // The previous version of this test signed in a TEACHER and merely inspected
  // cache keys, so it never exercised a student session at all. This uses a
  // genuine student identity with role/classroomId/studentId claims.
  const student = await createStudentIdentity({
    classroomId: TENANT_A.classroomId,
    studentId: TENANT_A.studentId
  });

  await gotoApp(page);
  await page.evaluate(
    ({ email, password }) => window.__PHASE2B_TEST__.signInTeacher(email, password),
    { email: student.email, password: student.password }
  );
  await waitForQuiescence(page);

  // Confirm the session really is the student identity.
  expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBe(student.uid);

  // No teacher-role V2 cache envelope may exist for any uid.
  const keys = await page.evaluate(() => window.__PHASE2B_TEST__.localKeys());
  const dataKeys = keys.filter((k) => k.startsWith("morganBank:v2:") && k.endsWith(":data:v1"));
  expect(dataKeys, "a student session must create zero teacher cache envelopes").toEqual([]);

  // And the legacy key must not be written either.
  expect(
    await page.evaluate(() => window.__PHASE2B_TEST__.localGet("mrMorganClassCashDataV5"))
  ).toBeNull();
});

test("a transient failure may serve ONLY an exactly-matching cache, and labels it offline", async ({
  page
}) => {
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_A, seeded.aUid);

  const key = cacheKey(PROJECT_ID, seeded.aUid, TENANT_A.classroomId);
  const good = await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), key);
  expect(good).not.toBeNull();

  // Force the next load to fail transiently (offline-shaped), then reload.
  await page.evaluate(() => window.__PHASE2B_TEST__.failNextLoad("unavailable"));
  await page.reload();
  await waitForAppReady(page);
  await waitForQuiescence(page);

  const text = await pageText(page);
  // The exactly-matching cache may be used, and must be surfaced as offline.
  expect(text).toContain(TENANT_A.studentMarker);
  expect(text.toLowerCase()).toMatch(/offline|cached/);
  // Never the other tenant.
  expect(text).not.toContain(TENANT_B.studentMarker);
});

test("a permission/integrity failure never falls back to cache, and fails closed", async ({
  page
}) => {
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_A, seeded.aUid);

  // A permission-denied load must NOT be satisfied from cache, even though a
  // perfectly valid matching envelope exists.
  await page.evaluate(() => window.__PHASE2B_TEST__.failNextLoad("permission-denied"));
  await page.reload();
  await waitForAppReady(page);
  await waitForQuiescence(page);

  const text = await pageText(page);
  expect(
    text,
    "a permission/integrity failure must never serve cached tenant data"
  ).not.toContain(TENANT_A.studentMarker);
  expect(text).not.toContain(TENANT_B.studentMarker);
});

test("a missing matching cache under transient failure fails closed rather than showing another tenant", async ({
  page
}) => {
  await gotoApp(page);
  await signIn(page, TENANT_B);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_B, seeded.bUid);

  // Remove B's envelope, leave A's absent too, then fail transiently.
  const bKey = cacheKey(PROJECT_ID, seeded.bUid, TENANT_B.classroomId);
  await page.evaluate((k) => window.__PHASE2B_TEST__.localRemove(k), bKey);
  await page.evaluate(() => window.__PHASE2B_TEST__.failNextLoad("unavailable"));
  await page.reload();
  await waitForAppReady(page);
  await waitForQuiescence(page);

  const text = await pageText(page);
  expect(text).not.toContain(TENANT_A.studentMarker);
  expect(text).not.toContain(TENANT_B.studentMarker);
});

test("a released stale SAVE completion cannot affect the incoming tenant's client state", async ({
  page
}) => {
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_A, seeded.aUid);

  // Park the real production UI -> saveData -> orchestrator path inside the
  // harness adapter barrier.
  await page.evaluate(() => window.__PHASE2B_TEST__.hold("classroomSave"));
  await startProductionSettingsSave(page, "A_STALE_SAVE");

  await startDomRecorder(page);

  // Switch to B, then release A's save.
  await signOutPage(page);
  await signIn(page, TENANT_B);
  await waitForQuiescence(page);
  await assertTenantEstablished(page, TENANT_B, seeded.bUid);
  await page.evaluate(() => window.__PHASE2B_TEST__.release("classroomSave"));
  await waitForQuiescence(page);

  const log = (await domLog(page)).join("\n");
  const text = await pageText(page);
  expect(log).not.toContain("A_STALE_SAVE");
  expect(text).not.toContain("A_STALE_SAVE");
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text).not.toContain(sentinel);
  }

  // B's envelope must still be B's.
  const bKey = cacheKey(PROJECT_ID, seeded.bUid, TENANT_B.classroomId);
  const bEnvelope = await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), bKey);
  expect(bEnvelope).not.toBeNull();
  expect(JSON.parse(bEnvelope).ownerUid).toBe(seeded.bUid);

  // The outgoing adapter may complete server-side, but the production
  // orchestrator must not write A's late data into any incoming client cache.
  const aKey = cacheKey(PROJECT_ID, seeded.aUid, TENANT_A.classroomId);
  expect(await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), aKey)).toBeNull();
});

registerTenantDataBrowserTests({
  getSeeded: () => seeded,
  gotoApp,
  waitForQuiescence
});
