import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TenantSession, SESSION_STATES } from "./tenantSession.js";
import {
  mapSafeClientError,
  normalizeFirebaseErrorCode,
  orchestrateProductionLogout,
  orchestrateTeacherResolution,
  orchestrateTeacherOnboarding,
  loadClassroomDataWithCacheFallback,
  handleAuthTransition,
  orchestrateClassroomDataLoad,
  orchestrateClassroomDataSave,
  orchestrateAuthLogsFetch,
  orchestrateStudentPinReset,
  orchestrateBulkOperation
} from "./tenantClient.js";
import { connectPhase2bEmulatorsIfConfigured, isPortValid } from "../firebase/firebase.js";
import { purgeTenantCache, purgeLegacyCache, buildCacheKey, writeTeacherCache } from "./tenantCache.js";

function createMockStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    store
  };
}

const INDEX_HTML_PATH = fileURLToPath(new URL("../../index.html", import.meta.url));

/**
 * Returns the source text of every `if (IS_MULTI_TEACHER_V2_ENABLED) { ... }`
 * block in index.html, brace-matched so each string is exactly one V2 branch.
 *
 * The V2 branches are the only place the gate is on, so scoping assertions to
 * them is what makes "no legacy call in V2 mode" checkable at all: the legacy
 * branches of the same functions legitimately still contain `loadData()`,
 * `resetStudentPin`, `classroomId: "morgan"` and the `mrMorganClassCashDataV5`
 * key, and Item 9 must not change them.
 */
function readV2Branches() {
  const source = readFileSync(INDEX_HTML_PATH, "utf8");
  const marker = "if (IS_MULTI_TEACHER_V2_ENABLED) {";
  const branches = [];

  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + marker.length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    branches.push(source.slice(start, i + 1));
    from = i + 1;
  }

  return { source, branches };
}

describe("TenantClient Orchestration and Production Isolation Contracts", () => {
  const PROJECT_ID = "demo-morgan-bank";

  test("normalizes Firebase error codes and maps safe client error messages", () => {
    const unauth = { code: "functions/unauthenticated" };
    const perm = { code: "functions/permission-denied" };
    const precond = { code: "functions/failed-precondition" };
    const invalid = { code: "functions/invalid-argument" };
    const internal = { code: "functions/internal" };

    assert.equal(normalizeFirebaseErrorCode(unauth), "unauthenticated");
    assert.equal(mapSafeClientError(unauth), "Sign in required.");
    assert.equal(mapSafeClientError(perm), "This account is not eligible to complete this action.");
    assert.equal(mapSafeClientError(precond), "This account cannot be set up automatically. Contact your administrator for assistance.");
    assert.equal(mapSafeClientError(invalid), "The request was invalid.");
    assert.equal(mapSafeClientError(internal), "An unexpected internal error occurred.");
  });

  test("orchestrateTeacherOnboarding onboardTeacherClassroomV2 flow", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ONBOARDING_REQUIRED);

    const mockCallable = async (name, payload) => {
      if (name === "onboardTeacherClassroomV2") {
        return {
          data: {
            created: true,
            teacher: { uid: "t1", displayName: "Mr. Morgan", email: "morgan@school.edu" },
            classroom: { id: "room_new", name: payload.classroomName, studentLoginCode: "ABC12345" }
          }
        };
      }
      if (name === "resolveTeacherTenantV2") {
        return {
          data: {
            state: "active",
            teacher: { uid: "t1", displayName: "Mr. Morgan", email: "morgan@school.edu" },
            classroom: { id: "room_new", name: "Period 1", studentLoginCode: "ABC12345" }
          }
        };
      }
    };

    const res = await orchestrateTeacherOnboarding(session, mockCallable, { classroomName: "Period 1" });
    assert.equal(res.success, true);
    assert.equal(res.created, true);
    assert.equal(session.getState(), SESSION_STATES.ACTIVE);
    assert.equal(session.classroomId, "room_new");
  });

  test("orchestrateClassroomDataLoad loads data and invokes apply callback if epoch remains valid", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let appliedData = null;
    const res = await orchestrateClassroomDataLoad(
      session,
      async () => ({ loaded: true }),
      (d) => { appliedData = d; }
    );

    assert.equal(res.executed, true);
    assert.deepEqual(appliedData, { loaded: true });
  });

  test("1. REMOVE THE UNSCOPED CLASSROOM-DATA WRITE: missing save adapter fails closed and real save adapter writes only exact scoped key", async () => {
    const storage = createMockStorage();
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    // 1. Missing save adapter fails closed
    const missingRes = await orchestrateClassroomDataSave(session, null, { students: [] }, { storageAdapter: storage, projectId: PROJECT_ID });
    assert.equal(missingRes.executed, false);
    assert.equal(missingRes.reason, "missing-v2-save-adapter");

    // 2. Real save adapter writes ONLY exact scoped key and NO unscoped/legacy key
    let realAdapterCalledWith = null;
    const realSaveAdapter = async (d) => {
      realAdapterCalledWith = d;
      return { success: true };
    };

    const saveRes = await orchestrateClassroomDataSave(session, realSaveAdapter, { students: [{ id: "s1" }] }, { storageAdapter: storage, projectId: PROJECT_ID });
    assert.equal(saveRes.executed, true);
    assert.deepEqual(realAdapterCalledWith, { students: [{ id: "s1" }] });

    const keys = Array.from(storage.store.keys());
    assert.equal(keys.includes("morganBank:saveData"), false, "Must NEVER write unscoped morganBank:saveData key");
    assert.equal(keys.includes("mrMorganClassCashDataV5"), false, "Must NEVER write legacy mrMorganClassCashDataV5 key");
    assert.equal(keys.length, 1);
    assert.equal(keys[0], buildCacheKey(PROJECT_ID, "teacher_1", "room_1"));
  });

  test("2. WIRE REAL V2 SIGN-OUT: orchestrateProductionLogout purges cache, resets globals, and renders signed-out synchronously before signOut settles", async () => {
    let resetGlobalsCalled = false;
    let renderCalled = false;
    let authSignOutSettled = false;
    let resolveAuthSignOut;

    const pendingAuthSignOut = new Promise((resolve) => {
      resolveAuthSignOut = resolve;
    });

    const storage = createMockStorage();
    const cacheModule = { purgeTenantCache, purgeLegacyCache, buildCacheKey };

    const session = new TenantSession({
      storageAdapter: storage,
      cacheModule,
      projectId: PROJECT_ID,
      onResetGlobals: () => { resetGlobalsCalled = true; }
    });

    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    const mockAuthAdapter = {
      signOut: async () => {
        await pendingAuthSignOut;
        authSignOutSettled = true;
      }
    };

    const logoutPromise = orchestrateProductionLogout(session, mockAuthAdapter, () => { renderCalled = true; });

    // Assert synchronously BEFORE Firebase signOut settles
    assert.equal(authSignOutSettled, false, "Firebase signOut should still be pending");
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT, "State must be signed-out synchronously");
    assert.equal(session.getEpoch(), 1, "Epoch must be incremented synchronously");
    assert.equal(resetGlobalsCalled, true, "Globals must be reset synchronously");
    assert.equal(renderCalled, true, "Render callback must be invoked synchronously");

    resolveAuthSignOut();
    const result = await logoutPromise;
    assert.equal(result.success, true);
    assert.equal(authSignOutSettled, true);
  });

  test("2. WIRE REAL V2 SIGN-OUT: reset remains complete even if Firebase signOut rejects and does not reanimate old state", async () => {
    const storage = createMockStorage();
    const cacheModule = { purgeTenantCache, purgeLegacyCache, buildCacheKey };

    const session = new TenantSession({
      storageAdapter: storage,
      cacheModule,
      projectId: PROJECT_ID
    });

    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    const rejectingAuthAdapter = {
      signOut: async () => {
        throw new Error("Network offline during sign-out");
      }
    };

    let renderedState = null;
    const res = await orchestrateProductionLogout(session, rejectingAuthAdapter, () => { renderedState = session.getState(); });

    assert.equal(res.success, true);
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(renderedState, SESSION_STATES.SIGNED_OUT);
    assert.equal(session.uid, null);
    assert.equal(session.classroomId, null);
  });

  test("V2 operation orchestrators fail closed on a rejected callable instead of letting the rejection escape", async () => {
    // The V2 call sites in index.html set studentPinResetPending /
    // bulkOperationPending / studentAuthLogsLoading and a progress message
    // BEFORE awaiting. If an orchestrator let a rejection escape, those flags
    // would stay set forever, the progress message would stay on screen, and
    // no render would run. Every orchestrator must therefore resolve to a
    // structured failure so the caller's failure branch is actually reachable.
    const rejectingCallable = async () => {
      const err = new Error("Firestore rejected the request");
      err.code = "functions/permission-denied";
      throw err;
    };

    const storage = createMockStorage();

    const cases = [
      ["orchestrateAuthLogsFetch", (s) => orchestrateAuthLogsFetch(s, rejectingCallable, () => {
        throw new Error("apply callback MUST NOT run for a failed fetch");
      }), "auth-logs-fetch-failed"],
      ["orchestrateStudentPinReset", (s) => orchestrateStudentPinReset(s, rejectingCallable, { studentId: "s1", newPin: "1234" }), "pin-reset-failed"],
      ["orchestrateBulkOperation", (s) => orchestrateBulkOperation(s, rejectingCallable, { checkboxes: [] }), "bulk-operation-failed"],
      ["orchestrateClassroomDataSave", (s) => orchestrateClassroomDataSave(s, rejectingCallable, { students: [] }, { storageAdapter: storage, projectId: PROJECT_ID }), "save-failed"]
    ];

    for (const [label, invoke, expectedReason] of cases) {
      const session = new TenantSession();
      session.transitionTo(SESSION_STATES.AUTHENTICATING);
      session.transitionTo(SESSION_STATES.RESOLVING);
      session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
      session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
      session.transitionTo(SESSION_STATES.READY);

      const epochBefore = session.getEpoch();
      let res;
      try {
        res = await invoke(session);
      } catch (err) {
        assert.fail(`${label} MUST NOT let the rejection escape to the caller (threw ${err.code || err.message})`);
      }

      assert.equal(res.executed, false, `${label} must report a failure`);
      assert.equal(res.reason, expectedReason, `${label} must report its specific failure reason`);
      // Only allowlisted generic text ever reaches the browser.
      assert.equal(res.error, "This account is not eligible to complete this action.");
      // A failed operation is not an invalidation: the tenant stays resolved so
      // the teacher can retry, and the epoch does not drift.
      assert.equal(session.getEpoch(), epochBefore, `${label} must not change the epoch on failure`);
      assert.equal(session.getState(), SESSION_STATES.READY);
    }

    // A rejected server save must never seed the tenant cache.
    assert.equal(storage.store.size, 0, "A failed save MUST NOT write the tenant cache envelope");
  });

  test("a rejected V2 operation that lands after invalidation is reported as stale, not as a live failure", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let rejectPending;
    const pending = new Promise((_resolve, reject) => { rejectPending = reject; });

    const resetPromise = orchestrateStudentPinReset(session, () => pending, { studentId: "s1", newPin: "1234" });

    // Tenant switches while the PIN reset is in flight, then the old call fails.
    session.invalidate("switch-to-b", { uid: "teacher_b", role: "teacher", state: SESSION_STATES.RESOLVING });
    const err = new Error("late failure");
    err.code = "functions/unavailable";
    rejectPending(err);

    const res = await resetPromise;
    assert.equal(res.executed, false);
    assert.equal(
      res.reason,
      "stale-epoch-ignored-post-reset",
      "A rejection that lands after invalidation must be reported as stale so the new tenant's UI is never repainted with the old tenant's error"
    );
    assert.equal(res.error, undefined, "A stale rejection must not surface an error message to the new tenant");
  });

  test("integrity and permission failures never fall back to the tenant cache", async () => {
    const storage = createMockStorage();

    function readySessionWithCache() {
      const session = new TenantSession({
        storageAdapter: storage,
        cacheModule: { purgeTenantCache, purgeLegacyCache, buildCacheKey },
        projectId: PROJECT_ID
      });
      session.transitionTo(SESSION_STATES.AUTHENTICATING);
      session.transitionTo(SESSION_STATES.RESOLVING);
      session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
      session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
      session.transitionTo(SESSION_STATES.READY);
      writeTeacherCache(storage, session, PROJECT_ID, { secret: "teacher-1-roster" }, session.captureIdentity());
      session.transitionTo(SESSION_STATES.RESOLVING);
      session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
      return session;
    }

    // Non-transient codes: an authoritative denial or integrity finding, never
    // a network blip. A cache read here would render data the server just
    // refused to authorize.
    for (const code of ["permission-denied", "unauthenticated", "failed-precondition", "invalid-argument", "already-exists"]) {
      const session = readySessionWithCache();
      const cacheKey = buildCacheKey(PROJECT_ID, "teacher_1", "room_1");
      assert.notEqual(storage.getItem(cacheKey), null, "Precondition: a matching cache entry exists");

      const res = await loadClassroomDataWithCacheFallback(session, {
        loadNetworkFn: async () => {
          const err = new Error("denied");
          err.code = `functions/${code}`;
          throw err;
        },
        storageAdapter: storage,
        projectId: PROJECT_ID
      });

      assert.equal(res.executed, false, `${code} MUST NOT be served from cache`);
      assert.equal(res.reason, "non-transient-network-failure", `${code} must be treated as authoritative, not transient`);
      assert.equal(res.data, undefined, `${code} MUST NOT return any cached data`);
      assert.equal(session.getState(), SESSION_STATES.DENIED_OR_INCONSISTENT);
      // Invalidation purges the cache, so the entry is gone afterwards.
      assert.equal(storage.getItem(cacheKey), null, `${code} must purge, never serve, the tenant cache`);
    }

    // Control: a genuinely transient failure IS allowed to serve the matching
    // cache, proving the assertions above detect the classification rather than
    // a permanently disabled fallback.
    const transientSession = readySessionWithCache();
    const transientRes = await loadClassroomDataWithCacheFallback(transientSession, {
      loadNetworkFn: async () => {
        const err = new Error("offline");
        err.code = "functions/unavailable";
        throw err;
      },
      storageAdapter: storage,
      projectId: PROJECT_ID
    });
    assert.equal(transientRes.executed, true);
    assert.equal(transientRes.isOffline, true);
    assert.deepEqual(transientRes.data, { secret: "teacher-1-roster" });
  });

  test("3. USE THE REAL V2 PIN CALLABLE CONTRACT: resetStudentPinV2 called with exact payload { studentId, newPin } and no classroomId", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let calledPayload = null;
    const resetFn = async (p) => {
      calledPayload = p;
      return { success: true };
    };

    const payload = { studentId: "s101", newPin: "4321" };
    const res = await orchestrateStudentPinReset(session, resetFn, payload);

    assert.equal(res.executed, true);
    assert.deepEqual(calledPayload, { studentId: "s101", newPin: "4321" });
    assert.equal("classroomId" in calledPayload, false, "Must NOT send classroomId in V2 PIN callable contract");
  });

  test("4. USE THE SCOPED V2 AUTH-LOG PATH: orchestrateAuthLogsFetch requires READY teacher session and exact resolved classroom ID", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);

    assert.equal(session.requireTeacher("teacher_1"), false, "Auth log fetch requires READY teacher session");

    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    assert.equal(session.requireTeacher("teacher_1"), true);
    assert.equal(session.classroomId, "room_1");

    let fetchCalled = false;
    let appliedLogs = null;
    const res = await orchestrateAuthLogsFetch(
      session,
      async () => { fetchCalled = true; return [{ id: "log1" }]; },
      (logs) => { appliedLogs = logs; }
    );

    assert.equal(res.executed, true);
    assert.equal(fetchCalled, true);
    assert.deepEqual(appliedLogs, [{ id: "log1" }]);
  });

  test("5. FIX REAL STALE-COMPLETION EFFECTS: stale completion of save, reset, or bulk does not mutate state or cache", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let resolveBulk;
    const pendingBulk = new Promise((r) => { resolveBulk = r; });

    const bulkPromise = orchestrateBulkOperation(session, () => pendingBulk, { newPin: "1111" });

    // Mid-flight invalidation
    session.invalidate("user-switched");

    resolveBulk({ successfulStudentIds: ["s1", "s2"], failCount: 0 });
    const res = await bulkPromise;

    assert.equal(res.executed, false);
    assert.equal(res.reason, "stale-epoch-ignored-post-bulk");
  });

  test("5. FIX REAL STALE-COMPLETION EFFECTS: bulk operations check identity before each remote call in loop", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let callsIssued = 0;

    const bulkFn = async (p, cap) => {
      for (const id of ["s1", "s2", "s3", "s4"]) {
        if (!session.validateCapturedIdentity(cap)) break;
        callsIssued++;
        if (id && callsIssued === 2) {
          // Mid-loop invalidation
          session.invalidate("invalidated-during-bulk-loop");
        }
      }
      return { callsIssued };
    };

    const res = await orchestrateBulkOperation(session, bulkFn, { checkboxes: [] });
    assert.equal(res.executed, false);
    assert.equal(callsIssued, 2, "Bulk loop MUST stop issuing remote calls immediately when session becomes invalid");
  });

  test("6. RENDER BLOCKING STATES DURING THE ACTUAL AWAITS: persistent offline label is set on transient load and cleared on online recovery", async () => {
    const storage = createMockStorage();
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    writeTeacherCache(storage, session, PROJECT_ID, { data: "cached" }, session.captureIdentity());

    // Transient network failure
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });

    const transientFail = async () => {
      const err = new Error("Network offline");
      err.code = "functions/unavailable";
      throw err;
    };

    const offlineRes = await loadClassroomDataWithCacheFallback(session, {
      loadNetworkFn: transientFail,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(offlineRes.executed, true);
    assert.equal(offlineRes.isOffline, true);
    assert.equal(session.getState(), SESSION_STATES.READY);

    // Online recovery load
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
    const onlineLoad = async () => ({ data: "fresh" });

    const onlineRes = await loadClassroomDataWithCacheFallback(session, {
      loadNetworkFn: onlineLoad,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(onlineRes.executed, true);
    assert.equal(onlineRes.isOffline, false);
    assert.equal(session.getState(), SESSION_STATES.READY);
  });

  test("7. slow A resolution then fast B, slow A load then fast B, sign-out during resolution, sign-out during classroom load (token-stage race covered separately)", async () => {
    const storage = createMockStorage();
    const session = new TenantSession();

    const renderedStates = [];
    session.onStateChange = (st) => renderedStates.push(st);

    // Case 1: Slow A resolution then fast B
    let resolveA;
    const pendingA = new Promise((r) => { resolveA = r; });
    const callAdapterSlowA = async (name) => {
      if (name === "resolveTeacherTenantV2") {
        await pendingA;
        return { data: { state: "active", teacher: { uid: "teacher_a" }, classroom: { id: "room_a" } } };
      }
    };
    const callAdapterFastB = async () => ({
      data: { state: "active", teacher: { uid: "teacher_b" }, classroom: { id: "room_b" } }
    });

    const userA = { uid: "teacher_a" };
    const tokenA = { claims: { role: "teacher" } };
    const userB = { uid: "teacher_b" };
    const tokenB = { claims: { role: "teacher" } };

    const transitionAPromise = handleAuthTransition(session, userA, tokenA, {
      callAdapter: callAdapterSlowA,
      loadNetworkFn: async () => ({ dataA: 1 }),
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    const resB = await handleAuthTransition(session, userB, tokenB, {
      callAdapter: callAdapterFastB,
      loadNetworkFn: async () => ({ dataB: 2 }),
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(resB.executed, true);
    assert.equal(session.uid, "teacher_b");
    assert.equal(session.classroomId, "room_b");
    assert.equal(session.getState(), SESSION_STATES.READY);

    resolveA();
    const resA = await transitionAPromise;
    assert.equal(resA.reason, "stale-epoch-ignored");
    assert.equal(session.uid, "teacher_b", "Stale A resolution must not overwrite B session identity");

    // Case 2: Slow A classroom load then fast B
    let resolveLoadA;
    const pendingLoadA = new Promise((r) => { resolveLoadA = r; });
    const slowLoadFnA = async () => {
      await pendingLoadA;
      return { dataA: 1 };
    };

    session.invalidate("test-slow-load", { uid: "teacher_a", role: "teacher", state: SESSION_STATES.RESOLVING });
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });

    const loadAPromise = loadClassroomDataWithCacheFallback(session, {
      loadNetworkFn: slowLoadFnA,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    // Fast B switch while A load is pending
    const resB2 = await handleAuthTransition(session, userB, tokenB, {
      callAdapter: callAdapterFastB,
      loadNetworkFn: async () => ({ dataB: 2 }),
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(resB2.executed, true);
    assert.equal(session.uid, "teacher_b");

    resolveLoadA();
    const resLoadA = await loadAPromise;
    assert.equal(resLoadA.reason, "stale-epoch-ignored");
    assert.equal(session.uid, "teacher_b");

    // Case 3: Sign out during resolution
    let resolveResA3;
    const pendingResA3 = new Promise((r) => { resolveResA3 = r; });
    const transitionA3Promise = handleAuthTransition(session, userA, tokenA, {
      callAdapter: async () => { await pendingResA3; return { data: { state: "active", teacher: { uid: "teacher_a" }, classroom: { id: "room_a" } } }; },
      loadNetworkFn: async () => ({ dataA: 1 }),
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    await session.signOut();
    resolveResA3();
    const resA3 = await transitionA3Promise;
    assert.equal(resA3.reason, "stale-epoch-ignored");
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);

    // Case 4: Sign out during classroom load
    let resolveLoadA4;
    const pendingLoadA4 = new Promise((r) => { resolveLoadA4 = r; });
    session.invalidate("test-load-signout", { uid: "teacher_a", role: "teacher", state: SESSION_STATES.RESOLVING });
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });

    const loadA4Promise = loadClassroomDataWithCacheFallback(session, {
      loadNetworkFn: async () => { await pendingLoadA4; return { dataA: 1 }; },
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    await session.signOut();
    resolveLoadA4();
    const resLoadA4 = await loadA4Promise;
    assert.equal(resLoadA4.reason, "stale-epoch-ignored");
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);

    // The lifecycle states must actually have been pushed to the render
    // callback during the awaits above, not merely reached internally: this is
    // what makes a blocking screen appear instead of leaving the previous
    // tenant's DOM visible. (That the DOM itself repaints is Item 10.)
    for (const expected of [
      SESSION_STATES.AUTHENTICATING,
      SESSION_STATES.RESOLVING,
      SESSION_STATES.ACTIVE,
      SESSION_STATES.CLASSROOM_LOADING,
      SESSION_STATES.READY,
      SESSION_STATES.SIGNED_OUT
    ]) {
      assert.equal(
        renderedStates.includes(expected),
        true,
        `Render callback must be invoked for the ${expected} lifecycle state`
      );
    }
    assert.equal(
      renderedStates.indexOf(SESSION_STATES.RESOLVING) < renderedStates.indexOf(SESSION_STATES.READY),
      true,
      "A blocking resolving render must precede the ready render"
    );
  });

  test("7b. TOKEN-STAGE RACE: the previous tenant is invalidated, purged, reset, and blocked BEFORE the new ID token is awaited", async () => {
    // This mirrors the exact ordering the production auth observer uses in
    // index.html: invalidate synchronously on the auth event, and only then
    // await getIdTokenResult(). Real-browser execution of this sequence is
    // Item 10; what is proven here is that the ordering leaves no window in
    // which the previous tenant remains trusted while a slow token resolves.
    const storage = createMockStorage();
    const renderedStates = [];
    let globalsResetCount = 0;

    const session = new TenantSession({
      storageAdapter: storage,
      cacheModule: { purgeTenantCache, purgeLegacyCache, buildCacheKey },
      projectId: PROJECT_ID,
      onResetGlobals: () => { globalsResetCount++; },
      onStateChange: (st) => renderedStates.push(st)
    });

    // Teacher A is fully READY with a populated tenant cache.
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);
    writeTeacherCache(storage, session, PROJECT_ID, { roster: "A" }, session.captureIdentity());
    storage.setItem("mrMorganClassCashDataV5", JSON.stringify({ legacy: true }));

    const keyA = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    assert.notEqual(storage.getItem(keyA), null, "Precondition: teacher A cache exists");
    const epochA = session.getEpoch();
    const resetsBefore = globalsResetCount;
    renderedStates.length = 0;

    // --- Production observer step 1: synchronous invalidation on the auth event.
    let resolveToken;
    const slowTokenB = new Promise((r) => { resolveToken = r; });
    session.invalidate("auth-observer-change", { uid: "teacher_b", state: SESSION_STATES.AUTHENTICATING });

    // --- Production observer step 2: await the new user's ID token.
    const tokenPromise = slowTokenB;

    // Everything below is asserted while the token is STILL PENDING.
    assert.equal(session.getEpoch(), epochA + 1, "Epoch must increment before the token is awaited");
    assert.equal(session.classroomId, null, "Previous tenant classroom must be dropped before the token is awaited");
    assert.equal(session.role, null, "Previous tenant role must be dropped before the token is awaited");
    assert.equal(session.getState(), SESSION_STATES.AUTHENTICATING, "A blocking authenticating state must be entered before the token is awaited");
    assert.deepEqual(renderedStates, [SESSION_STATES.AUTHENTICATING], "The blocking state must be rendered before the token is awaited");
    assert.equal(globalsResetCount, resetsBefore + 1, "Globals must be reset before the token is awaited");
    assert.equal(storage.getItem(keyA), null, "Teacher A cache must be purged before the token is awaited");
    assert.equal(storage.getItem("mrMorganClassCashDataV5"), null, "Legacy cache must be purged before the token is awaited");

    // A load captured under teacher A can no longer apply.
    assert.equal(session.validateCapturedIdentity({ uid: "teacher_a", role: "teacher", classroomId: "room_a", epoch: epochA }), false);

    // --- Token finally arrives; teacher B resolves normally.
    resolveToken({ claims: { role: "teacher" } });
    const tokenResult = await tokenPromise;

    const res = await handleAuthTransition(session, { uid: "teacher_b" }, tokenResult, {
      callAdapter: async () => ({ data: { state: "active", teacher: { uid: "teacher_b" }, classroom: { id: "room_b" } } }),
      loadNetworkFn: async () => ({ roster: "B" }),
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(res.executed, true);
    assert.equal(session.uid, "teacher_b");
    assert.equal(session.classroomId, "room_b");
    assert.equal(session.getState(), SESSION_STATES.READY);
    assert.deepEqual(res.data, { roster: "B" });
    // Only teacher B's scoped envelope exists; nothing of A survived.
    assert.deepEqual(Array.from(storage.store.keys()), [buildCacheKey(PROJECT_ID, "teacher_b", "room_b")]);
  });

  test("7c. TOKEN-STAGE RACE: sign-out during the token lookup leaves the session signed out and the late token inert", async () => {
    const storage = createMockStorage();
    const session = new TenantSession({
      storageAdapter: storage,
      cacheModule: { purgeTenantCache, purgeLegacyCache, buildCacheKey },
      projectId: PROJECT_ID
    });

    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);
    writeTeacherCache(storage, session, PROJECT_ID, { roster: "A" }, session.captureIdentity());

    // Observer fires for teacher A again and invalidates, then the token stalls.
    let resolveToken;
    const slowToken = new Promise((r) => { resolveToken = r; });
    session.invalidate("auth-observer-change", { uid: "teacher_a", state: SESSION_STATES.AUTHENTICATING });

    // The user signs out while the token is still in flight.
    await session.signOut();
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    const epochAfterSignOut = session.getEpoch();

    // The token now arrives late. Continuing the transition must not resurrect
    // teacher A: resolution is never even attempted for a signed-out session.
    resolveToken({ claims: { role: "teacher" } });
    const lateToken = await slowToken;

    let resolveAttempts = 0;
    const res = await handleAuthTransition(session, null, lateToken, {
      callAdapter: async () => { resolveAttempts++; return {}; },
      loadNetworkFn: async () => ({ roster: "A" }),
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(res.state, SESSION_STATES.SIGNED_OUT);
    assert.equal(resolveAttempts, 0, "A signed-out session must not issue a tenant resolution");
    assert.equal(session.uid, null);
    assert.equal(session.classroomId, null);
    assert.equal(session.getEpoch() >= epochAfterSignOut, true);
    assert.equal(storage.store.size, 0, "No tenant cache may survive sign-out during the token lookup");
  });

  test("a stale student load is inert: it applies no data, sets no identity, and writes no storage", async () => {
    const storage = createMockStorage();
    const session = new TenantSession();

    let resolveStudentLoad;
    const pendingStudentLoad = new Promise((r) => { resolveStudentLoad = r; });

    const studentClaims = { claims: { role: "student", classroomId: "room_s", studentId: "student_9" } };
    const transitionPromise = handleAuthTransition(session, { uid: "student_uid_9" }, studentClaims, {
      callAdapter: async () => {},
      loadNetworkFn: async () => {},
      loadStudentNetworkFn: () => pendingStudentLoad,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    // The student signs out while their profile load is in flight.
    await session.signOut();

    resolveStudentLoad({ studentProfile: { name: "Should never be applied" } });
    const res = await transitionPromise;

    assert.equal(res.executed, false);
    assert.equal(res.reason, "stale-epoch-ignored");
    assert.equal(res.data, undefined, "A stale student load MUST NOT return profile data");
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(session.uid, null);
    assert.equal(session.role, null);
    assert.equal(session.classroomId, null);
    assert.equal(storage.store.size, 0, "A student session MUST NOT touch localStorage, stale or live");
  });

  test("8. HANDLE RESOLVED CLASSROOM CHANGES AS INVALIDATION: same-UID classroom-A to classroom-B transition increments epoch, purges cache, resets globals, and broadcasts invalidation", async () => {
    let broadcastCount = 0;
    const mockInvalidator = {
      broadcastInvalidation() { broadcastCount++; }
    };
    let globalsResetCount = 0;
    const storage = createMockStorage();

    const session = new TenantSession({
      storageAdapter: storage,
      cacheModule: { purgeTenantCache, purgeLegacyCache, buildCacheKey },
      projectId: PROJECT_ID,
      multiTabInvalidator: mockInvalidator,
      onResetGlobals: () => { globalsResetCount++; }
    });

    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "classroom_A" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    writeTeacherCache(storage, session, PROJECT_ID, { room: "A" }, session.captureIdentity());
    const keyA = buildCacheKey(PROJECT_ID, "teacher_1", "classroom_A");
    assert.notEqual(storage.getItem(keyA), null);

    const initialEpoch = session.getEpoch();

    const mockCallableClassroomB = async (name) => {
      if (name === "resolveTeacherTenantV2") {
        return {
          data: {
            state: "active",
            teacher: { uid: "teacher_1", displayName: "Mr. Morgan", email: "morgan@school.edu" },
            classroom: { id: "classroom_B", name: "Period 2", studentLoginCode: "ROOMB" }
          }
        };
      }
    };

    const resB = await orchestrateTeacherResolution(session, mockCallableClassroomB);

    assert.equal(resB.success, true);
    assert.equal(session.classroomId, "classroom_B");
    assert.equal(session.getEpoch(), initialEpoch + 1, "Epoch MUST increment when resolved classroom identity changes");
    assert.equal(storage.getItem(keyA), null, "Previous tenant cache MUST be purged on classroom change");
    assert.equal(globalsResetCount > 0, true, "Globals MUST be reset on classroom change");
    assert.equal(broadcastCount > 0, true, "Multi-tab invalidation MUST be published on classroom change");
  });

  test("9. STUDENT SESSION SAFETY: rejects fabricated fallback 'student-room', requires exact claims, memory-only, and fails closed without student network adapter", async () => {
    const session = new TenantSession();
    const studentUser = { uid: "student_uid_1" };

    // 1. Missing or empty classroomId/studentId claims fail closed
    const invalidClaims = { claims: { role: "student", classroomId: "", studentId: "s1" } };
    const resInvalid = await handleAuthTransition(session, studentUser, invalidClaims, {
      callAdapter: async () => {},
      loadNetworkFn: async () => {},
      loadStudentNetworkFn: async () => ({ ok: 1 }),
      storageAdapter: createMockStorage(),
      projectId: PROJECT_ID
    });

    assert.equal(resInvalid.success, false);
    assert.equal(resInvalid.reason, "student-claims-invalid");
    assert.equal(session.getState(), SESSION_STATES.DENIED_OR_INCONSISTENT);

    // 2. Valid claims without loadStudentNetworkFn fail closed explicitly
    const validClaims = { claims: { role: "student", classroomId: "room_student", studentId: "student_101" } };
    const resNoAdapter = await handleAuthTransition(session, studentUser, validClaims, {
      callAdapter: async () => {},
      loadNetworkFn: async () => {},
      storageAdapter: createMockStorage(),
      projectId: PROJECT_ID
    });

    assert.equal(resNoAdapter.success, false);
    assert.equal(resNoAdapter.reason, "student-access-unavailable");
    assert.equal(session.getState(), SESSION_STATES.DENIED_OR_INCONSISTENT);

    // 3. Valid claims with loadStudentNetworkFn transitions to READY and is memory-only
    const storage = createMockStorage();
    const resWithAdapter = await handleAuthTransition(session, studentUser, validClaims, {
      callAdapter: async () => {},
      loadNetworkFn: async () => {},
      loadStudentNetworkFn: async () => ({ studentProfile: { name: "Alice" } }),
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(resWithAdapter.executed, true);
    assert.equal(session.getState(), SESSION_STATES.READY);
    assert.equal(session.role, "student");
    assert.equal(session.classroomId, "room_student");
    assert.equal(storage.store.size, 0, "Student session MUST remain memory-only and write no localStorage");
  });

  // SOURCE GUARD, NOT BEHAVIOURAL PROOF.
  //
  // The tests above exercise the orchestrators directly with mocks. They cannot
  // show that index.html actually calls them with the right callable names,
  // Firestore paths and payloads, because index.html is a single inline module
  // that cannot be imported here. Executing the real page against the emulators
  // is Item 10.
  //
  // What these two tests do give is a regression barrier on the V2 branches of
  // the real production file: if a V2 branch regains a legacy callable, the
  // legacy data path, the legacy storage key, a hardcoded classroom, or a
  // classroomId in the V2 PIN payload, they fail. That is a real check on
  // production source, and it is deliberately described as no more than that.
  test("SOURCE GUARD: every V2 branch in index.html uses the V2 callables and scoped paths, and none reaches a legacy V2-forbidden path", () => {
    const { branches } = readV2Branches();
    assert.equal(branches.length > 0, true, "Expected V2 branches in index.html");

    const v2Source = branches.join("\n/* --- next V2 branch --- */\n");

    // index.html names the PIN callable directly in its V2 branches; the
    // resolution and onboarding callables are named inside tenantClient.js and
    // invoked through the callAdapter, so they are asserted at their real site.
    assert.equal(
      branches.filter(b => b.includes('httpsCallable(functions, "resetStudentPinV2")')).length,
      3,
      "All three V2 PIN sites (profile reset, single activation, bulk activation) must call resetStudentPinV2"
    );

    const tenantClientSource = readFileSync(
      fileURLToPath(new URL("./tenantClient.js", import.meta.url)),
      "utf8"
    );
    for (const callable of ["resolveTeacherTenantV2", "onboardTeacherClassroomV2"]) {
      assert.match(
        tenantClientSource,
        new RegExp(`callableAdapter\\(\\s*"${callable}"`),
        `The V2 orchestrator must invoke the ${callable} callable by name`
      );
    }
    assert.equal(
      /callableAdapter\(\s*"(resolveTeacherTenant|onboardTeacherClassroom|ensureTeacherClassroom)"/.test(tenantClientSource),
      false,
      "V2 orchestrators must never invoke the unversioned legacy callables"
    );

    // The scoped auth-log path, never the flat legacy collection.
    assert.match(
      v2Source,
      /collection\(\s*db\s*,\s*"studentAuthLogs"\s*,\s*classroomId\s*,\s*"logs"\s*\)/,
      "V2 auth logs must read studentAuthLogs/{classroomId}/logs"
    );
    assert.equal(
      /collection\(\s*db\s*,\s*"studentAuthLogs"\s*\)/.test(v2Source),
      false,
      "V2 branches must never read the flat legacy studentAuthLogs collection"
    );

    // V2-forbidden legacy access must not appear in any V2 branch.
    const forbidden = [
      [/\bloadData\(\)/, "V2 must never call the legacy loadData()"],
      [/"morganBank"\s*,\s*"classroomData"/, "V2 must never read or write the fixed morganBank/classroomData document"],
      [/mrMorganClassCashDataV5/, "V2 must never read, write, or migrate the legacy cache key"],
      [/localStorage\.setItem\(\s*STORAGE_KEY/, "V2 must never write the unscoped legacy storage key"],
      [/morganBank:saveData/, "V2 must never write an unscoped classroom-data storage key"],
      [/"morgan"/, "V2 must never fall back to the hardcoded legacy classroom identity"],
      [/"student-room"/, "V2 must never fabricate a placeholder student classroom identity"],
      [/httpsCallable\(\s*functions\s*,\s*"resetStudentPin"\s*\)/, "V2 must never call the legacy resetStudentPin callable"],
      [/httpsCallable\(\s*functions\s*,\s*"studentPinLogin"\s*\)/, "V2 must never call the legacy studentPinLogin callable"]
    ];

    for (const [pattern, why] of forbidden) {
      const offending = branches.findIndex(b => pattern.test(b));
      assert.equal(offending, -1, `${why} (found in V2 branch #${offending + 1})`);
    }

    // viewStudentProfile gates on ternaries rather than an `if` block, so it is
    // not one of the extracted branches and is asserted explicitly here. It
    // must fail closed on an unresolved classroom instead of defaulting to the
    // hardcoded legacy classroom.
    const { source } = readV2Branches();
    const profileFn = source.slice(
      source.indexOf("async function viewStudentProfile"),
      source.indexOf("async function resetProfileStudentPin")
    );
    assert.equal(profileFn.length > 0, true, "Expected to locate viewStudentProfile in index.html");
    assert.match(
      profileFn,
      /if \(IS_MULTI_TEACHER_V2_ENABLED && !v2TenantSession\.classroomId\)/,
      "viewStudentProfile must fail closed when the V2 classroom is unresolved"
    );
    assert.equal(
      /IS_MULTI_TEACHER_V2_ENABLED \?\s*\(?v2TenantSession\.classroomId \|\| "morgan"\)?/.test(profileFn),
      false,
      'viewStudentProfile must never default the V2 classroom to "morgan"'
    );
    assert.match(
      profileFn,
      /const classroomId = IS_MULTI_TEACHER_V2_ENABLED \? v2TenantSession\.classroomId : "morgan";/,
      "viewStudentProfile must take its V2 classroom only from the resolved session"
    );

    // The V2 PIN payload is exactly { studentId, newPin }: resetStudentPinV2
    // rejects any additional key server-side, so a classroomId here would make
    // every V2 PIN reset fail with invalid-argument.
    const pinPayloads = v2Source.match(/const payload = \{[\s\S]*?\};/g) || [];
    assert.equal(pinPayloads.length >= 2, true, "Expected the profile and activation V2 PIN payloads");
    for (const payload of pinPayloads) {
      assert.equal(/\bclassroomId\b/.test(payload), false, "V2 PIN payload must not contain classroomId");
      assert.match(payload, /studentId:/);
      assert.match(payload, /newPin/);
    }
  });

  test("SOURCE GUARD: the V2 gate defaults to off and legacy default-off behaviour is preserved", () => {
    const { source, branches } = readV2Branches();

    // The authoritative client gate is build-time, opt-in, and exact: absent,
    // false, or any string other than "true" must leave V2 disabled.
    assert.match(
      source,
      /const IS_MULTI_TEACHER_V2_ENABLED = import\.meta\.env\.VITE_MULTI_TEACHER_V2_ENABLED === "true";/,
      'V2 must activate only when VITE_MULTI_TEACHER_V2_ENABLED is exactly "true"'
    );
    assert.equal(
      /window\.MULTI_TEACHER_V2_ENABLED/.test(source),
      false,
      "index.html must not bypass the required Vite environment gate with a runtime window flag"
    );

    // MultiTabInvalidator's constructor opens a BroadcastChannel immediately.
    // Its production construction therefore must itself be gate-conditional;
    // merely guarding start() would still change default-off browser behavior.
    assert.match(
      source,
      /const v2MultiTabInvalidator = IS_MULTI_TEACHER_V2_ENABLED\s*\? new MultiTabInvalidator\(/,
      "default-off mode must not construct the multi-tab transport"
    );

    // The legacy paths still exist outside the V2 branches.
    const legacyOnly = branches.reduce((acc, b) => acc.replace(b, ""), source);
    for (const [pattern, why] of [
      [/async function loadData\(\)/, "legacy loadData() must remain"],
      [/"morganBank"\s*,\s*"classroomData"/, "legacy morganBank/classroomData path must remain"],
      [/localStorage\.setItem\(\s*STORAGE_KEY/, "legacy localStorage save must remain"],
      [/httpsCallable\(\s*functions\s*,\s*"resetStudentPin"\s*\)/, "legacy resetStudentPin callable must remain"],
      [/const TEACHER_UID = /, "legacy hardcoded teacher UID must remain"]
    ]) {
      assert.match(legacyOnly, pattern, why);
    }

    // Each V2 branch that shadows a legacy alternative must return, otherwise
    // execution falls through and runs the legacy path as well — which would
    // reinstate exactly the unscoped writes and legacy callables Item 9 forbids.
    const branchesShadowingLegacy = [
      ["V2_TENANT_DATA_SAVE_ADAPTER", "saveData"],
      ["studentAuthLogs", "openStudentAuthLogs"],
      ["orchestrateProductionLogout", "logout"],
      ["orchestrateBulkOperation", "bulkActivateStudents"],
      ["handleAuthTransition", "the auth observer"]
    ];

    for (const [needle, where] of branchesShadowingLegacy) {
      const branch = branches.find(b => b.includes(needle));
      assert.notEqual(branch, undefined, `Expected a V2 branch in ${where}`);
      assert.match(
        branch,
        /\breturn\b/,
        `The V2 branch in ${where} must return rather than fall through into the legacy path`
      );
    }

    // Both V2 PIN branches (profile reset and single activation) also return.
    const pinBranches = branches.filter(b => b.includes("orchestrateStudentPinReset"));
    assert.equal(pinBranches.length, 2, "Expected the profile-reset and activation V2 PIN branches");
    for (const branch of pinBranches) {
      assert.match(branch, /\breturn;/, "Each V2 PIN branch must return rather than fall through");
    }
  });

  // SOURCE GUARD for the Item 9 cache-project correction.
  //
  // V2 cache keys and envelope validation embed the project ID. If index.html
  // hardcodes "morgan-bank" while the Firebase app is actually connected to an
  // emulator demo project, every emulator-backed cache entry is written into the
  // production project's namespace and the envelope's projectId check becomes
  // meaningless. The active project ID must come from the Firebase app in use.
  test("SOURCE GUARD: V2 cache project IDs are derived from the active Firebase app, never hardcoded, and are derived only after the emulator connection", () => {
    const { source } = readV2Branches();

    // 1. No V2 cache/session call site may hardcode the project ID.
    assert.equal(
      /projectId:\s*"morgan-bank"/.test(source),
      false,
      'No V2 call site may pass a hardcoded projectId: "morgan-bank"'
    );

    // 2. There is exactly one derivation, and it reads the live app options.
    assert.match(
      source,
      /const V2_ACTIVE_PROJECT_ID = app\.options\.projectId;/,
      "The active V2 project ID must be derived from the Firebase app actually in use"
    );

    // 3. `app` must be imported for that derivation to be live.
    assert.match(
      source,
      /import \{[^}]*\bapp\b[^}]*\} from "\.\/src\/firebase\/firebase\.js";/,
      "index.html must import the Firebase app binding to derive the active project ID"
    );

    // 4. ORDERING: connectPhase2bEmulatorsIfConfigured() may re-initialize the
    //    app under the demo project, so it must run BEFORE the project ID is
    //    derived and before TenantSession is constructed.
    const connectAt = source.indexOf("connectPhase2bEmulatorsIfConfigured();");
    const deriveAt = source.indexOf("const V2_ACTIVE_PROJECT_ID = app.options.projectId;");
    const sessionAt = source.indexOf("const v2TenantSession = new TenantSession({");

    assert.notEqual(connectAt, -1, "Expected the emulator connection call in index.html");
    assert.notEqual(deriveAt, -1, "Expected the active project ID derivation in index.html");
    assert.notEqual(sessionAt, -1, "Expected the TenantSession construction in index.html");

    assert.equal(
      connectAt < deriveAt,
      true,
      "The emulator connection MUST run before the active project ID is derived"
    );
    assert.equal(
      deriveAt < sessionAt,
      true,
      "The active project ID MUST be derived before TenantSession is constructed"
    );

    // 5. The session is constructed with the derived value, and the remaining
    //    V2 call sites reuse the session's project ID rather than re-deriving.
    assert.match(
      source,
      /projectId: V2_ACTIVE_PROJECT_ID,/,
      "TenantSession must be constructed with the derived active project ID"
    );
    assert.equal(
      (source.match(/projectId: v2TenantSession\.projectId/g) || []).length,
      3,
      "The save, cache-fallback load, and auth-transition sites must all reuse the session project ID"
    );
  });

  // The receiving tab must end its own Firebase Auth session after a cross-tab
  // invalidation, otherwise browserSessionPersistence lets a refresh re-resolve
  // the invalidated teacher. Behaviour is proven in tenantCache.test.js; this
  // guards the production wiring that supplies the adapter.
  test("SOURCE GUARD: the production MultiTabInvalidator is wired with a local Firebase Auth sign-out adapter", () => {
    const { source } = readV2Branches();

    const ctorAt = source.indexOf("new MultiTabInvalidator(");
    assert.notEqual(ctorAt, -1, "Expected the production MultiTabInvalidator construction");
    const ctorBlock = source.slice(ctorAt, ctorAt + 1600);

    assert.match(
      ctorBlock,
      /localAuthAdapter:\s*\{\s*signOut:\s*\(\)\s*=>\s*signOut\(auth\)\s*\}/,
      "The production invalidator must receive a local Firebase Auth sign-out adapter"
    );

    // The quarantine marker is what survives a refresh; without a real
    // sessionStorage transport in production the pre-Auth and rejected-sign-out
    // windows reopen silently.
    assert.match(
      ctorBlock,
      /sessionStorageAdapter:\s*typeof sessionStorage !== "undefined" \? sessionStorage : null/,
      "The production invalidator must receive a per-tab sessionStorage quarantine adapter"
    );
  });

  // The Auth observer is the only place a quarantined identity can be stopped
  // before classroom data resolves, so the gate must be wired ahead of the token
  // lookup and the resolution call.
  test("SOURCE GUARD: the Auth observer consumes the quarantine before resolving any classroom data", () => {
    const { source } = readV2Branches();

    const gateAt = source.indexOf("consumeQuarantineForObservedUid");
    assert.notEqual(gateAt, -1, "Expected the Auth observer quarantine gate");

    const tokenAt = source.indexOf("getIdTokenResult");
    const transitionAt = source.indexOf("handleAuthTransition(v2TenantSession");
    assert.notEqual(transitionAt, -1, "Expected the V2 auth transition call");

    assert.ok(
      gateAt < tokenAt,
      "The quarantine gate must run BEFORE the ID token lookup"
    );
    assert.ok(
      gateAt < transitionAt,
      "The quarantine gate must run BEFORE handleAuthTransition resolves classroom data"
    );
  });

  test("11. REQUIRE COMPLETE EMULATOR CONFIGURATION: missing ports, zero ports, non-demo IDs, non-loopback hosts throw before observer installation", () => {
    // 1. Missing config returns disabled
    const disabledRes = connectPhase2bEmulatorsIfConfigured(null);
    assert.equal(disabledRes.connected, false);

    // 2. Non-demo project ID throws
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "production-id", host: "127.0.0.1", authPort: 9099, firestorePort: 8080, functionsPort: 5001 }),
      /Emulator connection requires an explicit demo- project ID/
    );

    // 3. Non-loopback host throws
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-test", host: "10.0.0.1", authPort: 9099, firestorePort: 8080, functionsPort: 5001 }),
      /Emulator connection must use loopback host/
    );

    // 4. Missing authPort throws
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-test", host: "127.0.0.1", firestorePort: 8080, functionsPort: 5001 }),
      /Invalid Auth emulator port/
    );

    // 5. Missing firestorePort throws
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-test", host: "127.0.0.1", authPort: 9099, functionsPort: 5001 }),
      /Invalid Firestore emulator port/
    );

    // 6. Missing functionsPort throws
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-test", host: "127.0.0.1", authPort: 9099, firestorePort: 8080 }),
      /Invalid Functions emulator port/
    );

    // 7. Port 0 for authPort throws
    assert.equal(isPortValid(0), false);
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-test", host: "127.0.0.1", authPort: 0, firestorePort: 8080, functionsPort: 5001 }),
      /Invalid Auth emulator port: 0/
    );

    // 8. Port 0 for firestorePort throws
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-test", host: "127.0.0.1", authPort: 9099, firestorePort: 0, functionsPort: 5001 }),
      /Invalid Firestore emulator port: 0/
    );

    // 9. Port 0 for functionsPort throws
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-test", host: "127.0.0.1", authPort: 9099, firestorePort: 8080, functionsPort: 0 }),
      /Invalid Functions emulator port: 0/
    );

    // 10. Valid complete configuration connects successfully
    const validRes = connectPhase2bEmulatorsIfConfigured({
      enabled: true,
      projectId: "demo-morgan-bank-full-test",
      host: "127.0.0.1",
      authPort: 9099,
      firestorePort: 8080,
      functionsPort: 5001
    });

    assert.equal(validRes.connected, true);
    assert.equal(validRes.app.options.projectId, "demo-morgan-bank-full-test");

    // 11. Repeated invocation with exact same config succeeds
    const repeatRes = connectPhase2bEmulatorsIfConfigured({
      enabled: true,
      projectId: "demo-morgan-bank-full-test",
      host: "127.0.0.1",
      authPort: 9099,
      firestorePort: 8080,
      functionsPort: 5001
    });
    assert.equal(repeatRes.connected, true);
    assert.equal(repeatRes.reason, "already-connected");

    // 12. Repeated invocation with conflicting config throws
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({
        enabled: true,
        projectId: "demo-different-project",
        host: "127.0.0.1",
        authPort: 9099,
        firestorePort: 8080,
        functionsPort: 5001
      }),
      /Conflicting emulator configuration/
    );
  });
  // ---------------------------------------------------------------------------
  // Boot-integrity guard.
  //
  // index.html is one large inline module. A ReferenceError at its top level
  // aborts the WHOLE module, so the application never boots — and no unit test
  // notices, because unit tests import the extracted modules rather than running
  // index.html.
  //
  // That is exactly what commit d1765f2 caused: it renamed `function
  // updateStudent` to `function toggleStudentFrozen` while leaving both the
  // roster button (`onclick="updateStudent(...)"`) and the top-level export
  // `window.updateStudent = updateStudent;` pointing at the old name. The export
  // threw on every page load and the app never started.
  //
  // This guard is deliberately GENERAL: every `window.X = X` export must have a
  // matching definition, so the next accidental rename fails here instead of
  // silently bricking the app.
  // ---------------------------------------------------------------------------
  test("BOOT GUARD: every top-level window.X = X export in index.html has a matching definition", () => {
    const source = readFileSync(INDEX_HTML_PATH, "utf8");

    const exportRe = /^\s*window\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/gm;
    const missing = [];

    for (const m of source.matchAll(exportRe)) {
      const identifier = m[2];
      const defined =
        new RegExp(`function\\s+${identifier}\\s*\\(`).test(source) ||
        new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=`).test(source) ||
        new RegExp(`class\\s+${identifier}\\b`).test(source);
      if (!defined) missing.push(`${m[1]} -> ${identifier}`);
    }

    assert.deepEqual(
      missing,
      [],
      `index.html exports identifiers that are never defined, which throws at module top level and prevents the app from booting: ${missing.join(", ")}`
    );
  });

  // Pins the specific handler d1765f2 broke, including its Save behavior, so a
  // future rename cannot quietly reintroduce the regression or drop the body.
  test("BOOT GUARD: updateStudent is defined, exported, wired to the roster Save button, and still saves", () => {
    const source = readFileSync(INDEX_HTML_PATH, "utf8");

    assert.match(source, /function\s+updateStudent\s*\(\s*studentId\s*\)/, "updateStudent must be defined");
    assert.match(source, /window\.updateStudent\s*=\s*updateStudent\s*;/, "updateStudent must be exported");
    assert.match(source, /onclick="updateStudent\(\$\{student\.id\}\)"/, "the roster Save button must call updateStudent");

    // The dead name must be gone entirely, not left as an alias.
    assert.equal(
      source.includes("toggleStudentFrozen"),
      false,
      "toggleStudentFrozen was an accidental rename of updateStudent and must not reappear"
    );

    // Save behavior: reads name/pin/balance and persists. Asserted so a future
    // edit cannot keep the name while gutting what it does.
    const body = source.slice(source.indexOf("function updateStudent"));
    const end = body.indexOf("\n    }");
    const fn = body.slice(0, end);
    for (const needle of ['"name-" + studentId', '"pin-" + studentId', '"balance-" + studentId', "saveData()"]) {
      assert.ok(fn.includes(needle), `updateStudent must still ${needle}`);
    }
  });
});
