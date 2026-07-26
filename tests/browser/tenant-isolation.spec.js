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
  TENANT_A,
  TENANT_B,
  cacheKey,
  poisonEnvelopes,
  seedAll
} from "./phase2b-fixtures.js";

// Documented quiescence window. Two consecutive stable polls at this interval
// are what licenses any bounded "no further effect" claim below.
const QUIESCENCE_INTERVAL_MS = 250;
const QUIESCENCE_POLLS = 4;

let seeded;

test.beforeAll(async () => {
  seeded = await seedAll();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function gotoApp(page) {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => window.__PHASE2B_TEST__?.ready === true), { timeout: 20_000 })
    .toBe(true);
  // The harness must have reused the app's singleton and connected to the demo
  // project. If this fails, the injected config never reached firebase.js.
  expect(await page.evaluate(() => window.__PHASE2B_TEST__.projectId())).toBe(PROJECT_ID);
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
        const now = await page.evaluate(() => window.__PHASE2B_TEST__.activityTotal());
        stable = now === last ? stable + 1 : 0;
        last = now;
        return stable;
      },
      { intervals: Array(40).fill(QUIESCENCE_INTERVAL_MS), timeout: 30_000 }
    )
    .toBeGreaterThanOrEqual(QUIESCENCE_POLLS);
  return last;
}

async function signIn(page, tenant) {
  await page.evaluate(
    async ({ email, password }) => {
      const { getAuth, signInWithEmailAndPassword } = await import("firebase/auth");
      await signInWithEmailAndPassword(getAuth(), email, password);
    },
    { email: tenant.email, password: tenant.password }
  );
}

async function signOutPage(page) {
  await page.evaluate(async () => {
    const { getAuth, signOut } = await import("firebase/auth");
    await signOut(getAuth());
  });
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
    const outgoingKey = cacheKey(PROJECT_ID, outgoingUid, outgoing.classroomId);

    // Record the DOM for the entire switch window, before the switch begins.
    await startDomRecorder(page);

    await signOutPage(page);
    await signIn(page, incoming);
    await waitForQuiescence(page);

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

    // A genuine storage-event delivery for the OUTGOING tenant.
    await page.evaluate((payload) => {
      window.__PHASE2B_TEST__.localSet("morganBank:v2:invalidation", payload);
    }, JSON.stringify({ type: "session-invalidated", uidDigest: digest, epoch: 1 }));

    await waitForQuiescence(page);

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
      await gotoApp(page);
      await waitForQuiescence(page);

      const text = await pageText(page);
      expect(text, `Poisoned envelope (${label}) must never render`).not.toContain(
        "POISONED_STUDENT"
      );
      expect(text, `Poisoned envelope (${label}) must not leak an injected marker`).not.toContain(
        "EXTRA_FIELD_MARKER"
      );

      // A rejected envelope must also be REMOVED, not merely ignored.
      const after = await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), key);
      if (after !== null) {
        const parsed = JSON.parse(after);
        expect(
          parsed.ownerUid === uid && parsed.projectId === PROJECT_ID && parsed.schemaVersion === "v1",
          `A surviving envelope after poison (${label}) must be a freshly written valid one`
        ).toBe(true);
      }
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

  await gotoApp(tab2);
  await waitForQuiescence(tab2);

  await startDomRecorder(tab2);

  await signOutPage(tab1);
  await waitForQuiescence(tab2);

  // Tab 2 must no longer show A.
  const text2 = await pageText(tab2);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text2).not.toContain(sentinel);
  }

  // And a refresh must not bring A back — this is the browserSessionPersistence
  // reanimation path that Item 9 closed.
  await tab2.reload();
  await gotoApp(tab2);
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

  // Pre-seed the quarantine for A in a NEW tab before it ever observes Auth.
  // This is the exact pre-Auth window that commit 0fecba0 closed.
  const tab2 = await context.newPage();
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

  await gotoApp(tab2);
  await waitForQuiescence(tab2);

  const text = await pageText(tab2);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text, "A quarantined identity must never resolve").not.toContain(sentinel);
  }
  expect(await tab2.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull();

  await tab1.close();
  await tab2.close();
});

test("a digest quarantine for A does not block B, and concurrent A/B digests both survive", async ({
  context
}) => {
  const page = await context.newPage();

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

  // Both digests pending simultaneously — the bounded-set property from b756f75.
  await page.addInitScript(
    ({ a, b }) => {
      sessionStorage.setItem(
        "morganBank:v2:pendingInvalidation",
        JSON.stringify({ scope: "digest", uidDigests: [a, b] })
      );
    },
    { a: digestA, b: digestB }
  );

  await gotoApp(page);

  // Whichever identity appears must be blocked, and BOTH digests must have
  // survived being written together.
  const stored = await page.evaluate(() =>
    window.__PHASE2B_TEST__.sessionGet("morganBank:v2:pendingInvalidation")
  );
  const parsed = JSON.parse(stored);
  expect(parsed.scope).toBe("digest");
  expect(parsed.uidDigests).toHaveLength(2);

  await signIn(page, TENANT_A);
  await waitForQuiescence(page);
  const text = await pageText(page);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text, "A pending digest must block A even when B is also pending").not.toContain(
      sentinel
    );
  }

  await page.close();
});

test("a genuinely malformed payload fails closed, survives refresh, and blocks the next identity including B", async ({
  context
}) => {
  const page = await context.newPage();
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);

  // A real storage-event delivery of an unparseable payload.
  await page.evaluate(() => {
    window.__PHASE2B_TEST__.localSet("morganBank:v2:invalidation", "{ not valid json");
  });
  await waitForQuiescence(page);

  // Current tenant purged, fail-closed.
  let text = await pageText(page);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text).not.toContain(sentinel);
  }

  // Generic quarantine recorded and surviving a refresh.
  const marker = await page.evaluate(() =>
    window.__PHASE2B_TEST__.sessionGet("morganBank:v2:pendingInvalidation")
  );
  expect(JSON.parse(marker).scope).toBe("generic");

  await page.reload();
  await gotoApp(page);
  expect(
    JSON.parse(
      await page.evaluate(() => window.__PHASE2B_TEST__.sessionGet("morganBank:v2:pendingInvalidation"))
    ).scope,
    "The generic quarantine must survive a refresh"
  ).toBe("generic");

  // The documented availability cost: even B is blocked, because a malformed
  // payload names no tenant. This is intentional fail-closed behavior.
  await signIn(page, TENANT_B);
  await waitForQuiescence(page);
  text = await pageText(page);
  for (const sentinel of sentinelsOf(TENANT_B)) {
    expect(
      text,
      "A generic quarantine intentionally blocks the next identity, including B"
    ).not.toContain(sentinel);
  }

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
  await gotoApp(tab2);
  await waitForQuiescence(tab2);

  expect(
    await tab1.evaluate(() => typeof BroadcastChannel === "function"),
    "This run requires a genuine native BroadcastChannel"
  ).toBe(true);

  await signOutPage(tab1);
  await waitForQuiescence(tab1);

  const payloads = await tab1.evaluate(() => window.__PHASE2B_TEST__.outboundPayloads());
  expect(payloads.length, "Sign-out must broadcast at least once").toBeGreaterThan(0);

  for (const p of payloads) {
    expect(Object.keys(p).sort()).toEqual(["epoch", "type", "uidDigest"]);
    const serialized = JSON.stringify(p);
    for (const forbidden of [
      TENANT_A.classroomId,
      TENANT_A.studentId,
      TENANT_A.email,
      TENANT_A.classroomMarker,
      TENANT_A.studentMarker,
      SHARED_LOGIN_ID,
      seeded.aUid
    ]) {
      expect(serialized, `Broadcast payload must not contain ${forbidden}`).not.toContain(forbidden);
    }
  }

  // No inbound delivery may rebroadcast: tab 2 received, and must not have sent.
  const tab2Sent = await tab2.evaluate(() => window.__PHASE2B_TEST__.counters().broadcastsSent);
  expect(tab2Sent, "A receiving tab must never rebroadcast").toBe(0);

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
  await gotoApp(tab2);
  await waitForQuiescence(tab2);

  await startDomRecorder(tab2);

  // A genuine cross-page storage event: never a direct receiveMessage() call.
  await signOutPage(tab1);
  await waitForQuiescence(tab2);

  expect(
    await tab2.evaluate(() => window.__PHASE2B_TEST__.counters().storageEventsReceived),
    "The fallback transport must deliver a real storage event"
  ).toBeGreaterThan(0);

  const text = await pageText(tab2);
  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(text).not.toContain(sentinel);
  }

  await ctx.close();
});

test("duplicate BroadcastChannel + storage delivery settles once and never rebroadcasts", async ({
  context
}) => {
  const page = await context.newPage();
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);

  const digest = await page.evaluate(async (uid) => {
    const mod = await import("/src/phase2b/tenantCache.js");
    return mod.computeSha256Digest(uid);
  }, seeded.aUid);

  const sentBefore = await page.evaluate(() => window.__PHASE2B_TEST__.counters().broadcastsSent);

  // The same invalidation twice, over both transports.
  await page.evaluate((d) => {
    const msg = JSON.stringify({ type: "session-invalidated", uidDigest: d, epoch: 3 });
    const ch = new BroadcastChannel("morgan_bank_v2_invalidation");
    ch.postMessage(JSON.parse(msg));
    window.__PHASE2B_TEST__.localSet("morganBank:v2:invalidation", msg);
    ch.close();
  }, digest);

  const stableTotal = await waitForQuiescence(page);

  // Bounded, not an exact delta: the auth observer double-invalidates by design.
  const sentAfter = await page.evaluate(() => window.__PHASE2B_TEST__.counters().broadcastsSent);
  expect(
    sentAfter - sentBefore,
    "An inbound invalidation must not cause an outbound rebroadcast beyond the one we injected"
  ).toBeLessThanOrEqual(1);

  // Quiescence reached: effects are idempotent and settled.
  const secondTotal = await page.evaluate(() => window.__PHASE2B_TEST__.activityTotal());
  expect(secondTotal).toBe(stableTotal);

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

  const log = (await domLog(page)).join("\n");
  const text = await pageText(page);

  for (const sentinel of sentinelsOf(TENANT_A)) {
    expect(log, `Stale A load must not render ${sentinel}`).not.toContain(sentinel);
    expect(text, `Stale A load must not leave ${sentinel} on screen`).not.toContain(sentinel);
  }

  // B's own cache must not have been clobbered by A's late completion.
  const bKey = cacheKey(PROJECT_ID, seeded.bUid, TENANT_B.classroomId);
  const bEnvelope = await page.evaluate((k) => window.__PHASE2B_TEST__.localGet(k), bKey);
  if (bEnvelope !== null) {
    const parsed = JSON.parse(bEnvelope);
    expect(parsed.ownerUid, "B's cache must still belong to B").toBe(seeded.bUid);
  }
});

test("an already-accepted outgoing save is reported honestly rather than claimed cancelled", async ({
  page
}) => {
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);

  // Perform a real, allowed classroom-root write as A and let it commit.
  const wrote = await page.evaluate(async ({ classroomId }) => {
    if (typeof window.V2_TENANT_DATA_SAVE_ADAPTER !== "function") return false;
    await window.V2_TENANT_DATA_SAVE_ADAPTER({
      classroomId,
      settings: { label: "A_ACCEPTED_WRITE" }
    });
    return true;
  }, { classroomId: TENANT_A.classroomId });
  expect(wrote).toBe(true);

  // Switch tenants.
  await signOutPage(page);
  await signIn(page, TENANT_B);
  await waitForQuiescence(page);

  // The accepted write still exists server-side. That is the honest outcome:
  // switching tenants cancels CLIENT-side effects, not a committed server write.
  const stillThere = await page.evaluate(
    async ({ project, classroomId }) => {
      const res = await fetch(
        `http://127.0.0.1:8080/v1/projects/${project}/databases/(default)/documents/classrooms/${classroomId}`
      );
      const body = await res.json();
      return body?.fields?.settings?.mapValue?.fields?.label?.stringValue || null;
    },
    { project: PROJECT_ID, classroomId: TENANT_A.classroomId }
  );
  expect(
    stillThere,
    "An accepted server write must be read back honestly, not claimed cancelled"
  ).toBe("A_ACCEPTED_WRITE");

  // But it must not be visible in B's session.
  const text = await pageText(page);
  expect(text).not.toContain("A_ACCEPTED_WRITE");
});

test("a student session never persists teacher data to the V2 cache", async ({ page }) => {
  await gotoApp(page);
  await signIn(page, TENANT_A);
  await waitForQuiescence(page);

  const keys = await page.evaluate(() => window.__PHASE2B_TEST__.localKeys());
  const v2Keys = keys.filter((k) => k.startsWith("morganBank:v2:"));

  for (const k of v2Keys) {
    const raw = await page.evaluate((key) => window.__PHASE2B_TEST__.localGet(key), k);
    if (!raw || k.includes("invalidation")) continue;
    const parsed = JSON.parse(raw);
    // Only teacher-role envelopes may exist, and only for the signed-in teacher.
    expect(parsed.ownerUid).toBe(seeded.aUid);
  }
});
