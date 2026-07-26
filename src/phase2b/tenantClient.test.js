import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TenantSession, SESSION_STATES } from "./tenantSession.js";
import {
  mapSafeClientError,
  normalizeFirebaseErrorCode,
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

describe("TenantClient Orchestration and Safe Error Mapping", () => {
  const PROJECT_ID = "demo-morgan-bank";

  test("successful active resolution calls resolveTeacherTenantV2 and transitions session to active", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);

    const mockCallable = async (name, payload) => {
      assert.equal(name, "resolveTeacherTenantV2");
      assert.deepEqual(payload, {});
      return {
        data: {
          state: "active",
          teacher: { uid: "teacher_1", displayName: "Mr. Morgan", email: "morgan@school.edu" },
          classroom: { id: "room_123", name: "Period 1 Bank", studentLoginCode: "MRM123" }
        }
      };
    };

    const res = await orchestrateTeacherResolution(session, mockCallable);

    assert.equal(res.success, true);
    assert.equal(session.getState(), SESSION_STATES.ACTIVE);
    assert.equal(session.classroomId, "room_123");
    assert.equal(session.role, "teacher");
  });

  test("onboarding-required resolution calls resolveTeacherTenantV2 and transitions to onboarding-required", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);

    const mockCallable = async (name) => {
      assert.equal(name, "resolveTeacherTenantV2");
      return {
        data: { state: "onboarding-required", eligibility: "invited" }
      };
    };

    const res = await orchestrateTeacherResolution(session, mockCallable);

    assert.equal(res.success, true);
    assert.equal(session.getState(), SESSION_STATES.ONBOARDING_REQUIRED);
  });

  test("successful onboarding calls onboardTeacherClassroomV2 with classroomName and matches real response shape", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ONBOARDING_REQUIRED);

    let onboardingCalledWith = null;

    const mockCallable = async (name, payload) => {
      if (name === "onboardTeacherClassroomV2") {
        onboardingCalledWith = payload;
        return {
          data: {
            created: true,
            teacher: { uid: "t1", displayName: "Mr. Morgan", email: "morgan@school.edu" },
            classroom: { id: "room_new", name: payload.classroomName, studentLoginCode: "ABC12345" }
          }
        };
      }
      throw new Error(`Unexpected callable ${name}`);
    };

    const res = await orchestrateTeacherOnboarding(session, mockCallable, { classroomName: "  Period 2  " });

    assert.equal(res.success, true);
    assert.equal(res.created, true);
    assert.deepEqual(onboardingCalledWith, { classroomName: "Period 2" });
    assert.equal("classroomId" in onboardingCalledWith, false);
    assert.equal(session.getState(), SESSION_STATES.ACTIVE);
    assert.equal(session.classroomId, "room_new");
  });

  test("normalizes real Firebase callable client error codes such as functions/unauthenticated, functions/permission-denied, functions/failed-precondition", () => {
    const unauthErr = { code: "functions/unauthenticated", message: "Sign in required." };
    const permErr = { code: "functions/permission-denied", message: "Not eligible." };
    const precondErr = { code: "functions/failed-precondition", message: "Inconsistent state." };
    const internalErr = { code: "functions/internal", message: "Internal server error at /classrooms/123" };

    assert.equal(normalizeFirebaseErrorCode(unauthErr), "unauthenticated");
    assert.equal(mapSafeClientError(unauthErr), "Sign in required.");

    assert.equal(normalizeFirebaseErrorCode(permErr), "permission-denied");
    assert.equal(mapSafeClientError(permErr), "This account is not eligible to complete this action.");

    assert.equal(normalizeFirebaseErrorCode(precondErr), "failed-precondition");
    assert.equal(mapSafeClientError(precondErr), "This account cannot be set up automatically. Contact your administrator for assistance.");

    assert.equal(mapSafeClientError(internalErr), "An unexpected internal error occurred.");
  });

  test("loadClassroomDataWithCacheFallback handles successful load, non-transient failure, and transient offline fallback", async () => {
    const storage = createMockStorage();
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });

    // 1. Successful network load
    const loadSuccess = async () => ({ students: [{ id: "s1" }] });
    const successRes = await loadClassroomDataWithCacheFallback(session, {
      loadNetworkFn: loadSuccess,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(successRes.executed, true);
    assert.equal(successRes.isOffline, false);
    assert.equal(session.getState(), SESSION_STATES.READY);

    // 2. Transient network failure falls back to matching cache
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
    const loadTransientFail = async () => {
      const err = new Error("Failed to fetch network data");
      err.code = "functions/unavailable";
      throw err;
    };

    const transientRes = await loadClassroomDataWithCacheFallback(session, {
      loadNetworkFn: loadTransientFail,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(transientRes.executed, true);
    assert.equal(transientRes.isOffline, true);
    assert.equal(session.getState(), SESSION_STATES.READY);

    // 3. Non-transient failure (permission-denied) MUST NEVER fall back to cache
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_1", role: "teacher", classroomId: "room_1" });
    const loadPermFail = async () => {
      const err = new Error("Permission denied");
      err.code = "functions/permission-denied";
      throw err;
    };

    const permRes = await loadClassroomDataWithCacheFallback(session, {
      loadNetworkFn: loadPermFail,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(permRes.executed, false);
    assert.equal(permRes.reason, "non-transient-network-failure");
    assert.equal(session.getState(), SESSION_STATES.DENIED_OR_INCONSISTENT);
  });

  test("handleAuthTransition handles auth observer events, synchronous invalidation on A->B and B->A, and duplicate event filtering", async () => {
    const storage = createMockStorage();
    const session = new TenantSession();

    const callAdapterA = async () => ({
      data: { state: "active", teacher: { uid: "teacher_a" }, classroom: { id: "room_a" } }
    });
    const loadNetworkFnA = async () => ({ dataA: 1 });

    // Initial Auth Event: Teacher A
    const userA = { uid: "teacher_a" };
    const tokenResultA = { claims: { role: "teacher" } };

    const resA = await handleAuthTransition(session, userA, tokenResultA, {
      callAdapter: callAdapterA,
      loadNetworkFn: loadNetworkFnA,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(resA.executed, true);
    assert.equal(session.uid, "teacher_a");
    assert.equal(session.getState(), SESSION_STATES.READY);

    // Duplicate Auth Event: same Teacher A identity ignored
    const dupRes = await handleAuthTransition(session, userA, tokenResultA, {
      callAdapter: callAdapterA,
      loadNetworkFn: loadNetworkFnA,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });
    assert.equal(dupRes.ignored, true);

    // Auth Observer Event: direct switch Teacher A -> Teacher B
    const userB = { uid: "teacher_b" };
    const tokenResultB = { claims: { role: "teacher" } };
    const callAdapterB = async () => ({
      data: { state: "active", teacher: { uid: "teacher_b" }, classroom: { id: "room_b" } }
    });
    const loadNetworkFnB = async () => ({ dataB: 2 });

    const resB = await handleAuthTransition(session, userB, tokenResultB, {
      callAdapter: callAdapterB,
      loadNetworkFn: loadNetworkFnB,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(resB.executed, true);
    assert.equal(session.uid, "teacher_b");
    assert.equal(session.classroomId, "room_b");
    assert.equal(session.getState(), SESSION_STATES.READY);

    // Auth Observer Event: direct switch back Teacher B -> Teacher A
    const resA2 = await handleAuthTransition(session, userA, tokenResultA, {
      callAdapter: callAdapterA,
      loadNetworkFn: loadNetworkFnA,
      storageAdapter: storage,
      projectId: PROJECT_ID
    });

    assert.equal(resA2.executed, true);
    assert.equal(session.uid, "teacher_a");
    assert.equal(session.classroomId, "room_a");
    assert.equal(session.getState(), SESSION_STATES.READY);
  });

  test("storage spy proves stale captured identity cannot perform a cache or storage write", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let storageSetItemCalled = false;
    const storageSpy = {
      setItem() {
        storageSetItemCalled = true;
      }
    };

    let resolveSave;
    const pendingSave = new Promise((resolve) => {
      resolveSave = resolve;
    });

    const savePromise = orchestrateClassroomDataSave(
      session,
      () => pendingSave,
      { students: [] },
      storageSpy
    );

    // Mid-flight epoch invalidation
    session.invalidate("account-switched-during-save");

    resolveSave({ saved: true });

    const res = await savePromise;
    assert.equal(res.executed, false);
    assert.equal(res.reason, "stale-epoch-ignored-post-save");
    assert.equal(
      storageSetItemCalled,
      false,
      "PROOFS storage spy setItem was NOT called when captured identity became stale"
    );
  });

  test("distinct test: stale PIN reset callback is rejected", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let resolveReset;
    const pendingReset = new Promise((resolve) => { resolveReset = resolve; });

    const resetPromise = orchestrateStudentPinReset(
      session,
      () => pendingReset,
      { studentId: "s1", newPin: "1234" }
    );

    session.invalidate("user-switch-during-pin-reset");

    resolveReset({ success: true });

    const res = await resetPromise;
    assert.equal(res.executed, false);
    assert.equal(res.reason, "stale-epoch-ignored-post-reset");
  });

  test("distinct test: stale bulk operation callback is rejected", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let resolveBulk;
    const pendingBulk = new Promise((resolve) => { resolveBulk = resolve; });

    const bulkPromise = orchestrateBulkOperation(
      session,
      () => pendingBulk,
      { action: "activate-all" }
    );

    session.invalidate("role-change-during-bulk-op");

    resolveBulk({ success: true });

    const res = await bulkPromise;
    assert.equal(res.executed, false);
    assert.equal(res.reason, "stale-epoch-ignored-post-bulk");
  });

  test("distinct test: stale classroom data load is rejected and cannot mutate state", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let resolveLoad;
    const pendingLoad = new Promise((resolve) => { resolveLoad = resolve; });

    let applied = false;
    const loadPromise = orchestrateClassroomDataLoad(
      session,
      () => pendingLoad,
      () => { applied = true; }
    );

    session.invalidate("user-switch-during-load");
    resolveLoad({ students: [] });

    const res = await loadPromise;
    assert.equal(res.executed, false);
    assert.equal(applied, false);
  });

  test("distinct test: stale student auth logs fetch is rejected and cannot update UI logs", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let resolveLogs;
    const pendingLogs = new Promise((resolve) => { resolveLogs = resolve; });

    let appliedLogs = null;
    const fetchPromise = orchestrateAuthLogsFetch(
      session,
      () => pendingLogs,
      (logs) => { appliedLogs = logs; }
    );

    session.invalidate("user-switch-during-logs-fetch");
    resolveLogs([{ logId: 1 }]);

    const res = await fetchPromise;
    assert.equal(res.executed, false);
    assert.equal(appliedLogs, null);
  });

  test("connectPhase2bEmulatorsIfConfigured verifies config guards and safe re-initialization", () => {
    // 1. Missing config returns disabled
    const disabledRes = connectPhase2bEmulatorsIfConfigured(null);
    assert.equal(disabledRes.connected, false);

    // 2. Non-demo project ID fails closed
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "production-id" }),
      /Emulator connection requires an explicit demo- project ID/
    );

    // 3. Non-loopback host fails closed
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-test", host: "192.168.1.1" }),
      /Emulator connection must use loopback host/
    );

    // 4. Invalid port range fails closed
    assert.equal(isPortValid(8080), true);
    assert.equal(isPortValid(99999), false);
    assert.throws(
      () => connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-test", host: "127.0.0.1", authPort: 99999 }),
      /Invalid Auth emulator port/
    );

    // 5. Valid demo config re-initializes app with demo project ID
    const validRes = connectPhase2bEmulatorsIfConfigured({
      enabled: true,
      projectId: "demo-morgan-bank-test",
      host: "127.0.0.1",
      authPort: 9099
    });
    assert.equal(validRes.connected, true);
    assert.equal(validRes.app.options.projectId, "demo-morgan-bank-test");

    // 6. Repeated invocation is safe
    const repeatRes = connectPhase2bEmulatorsIfConfigured({ enabled: true, projectId: "demo-morgan-bank-test" });
    assert.equal(repeatRes.connected, true);
    assert.equal(repeatRes.reason, "already-connected");
  });
});
