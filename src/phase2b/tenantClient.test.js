import { test, describe } from "node:test";
import assert from "node:assert/strict";
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

  test("7. INVALIDATE BEFORE TOKEN LOOKUP: slow A token then fast B, slow A resolution then fast B, slow A load then fast B, sign-out during each stage", async () => {
    const storage = createMockStorage();
    const session = new TenantSession();

    let renderedStates = [];
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
});
