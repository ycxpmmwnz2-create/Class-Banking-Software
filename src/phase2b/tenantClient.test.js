import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TenantSession, SESSION_STATES } from "./tenantSession.js";
import {
  mapSafeClientError,
  normalizeFirebaseErrorCode,
  orchestrateTeacherResolution,
  orchestrateTeacherOnboarding,
  orchestrateClassroomDataLoad,
  orchestrateClassroomDataSave,
  orchestrateAuthLogsFetch,
  orchestrateStudentPinReset,
  orchestrateBulkOperation
} from "./tenantClient.js";

describe("TenantClient Orchestration and Safe Error Mapping", () => {
  test("successful active resolution calls resolveTeacherTenantV2 and transitions session to active", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);

    const mockCallable = async (name, payload) => {
      assert.equal(name, "resolveTeacherTenantV2", "Must use exact real server callable name resolveTeacherTenantV2");
      assert.deepEqual(payload, {}, "Detects client sending illegal payload to resolveTeacherTenantV2");
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

  test("stale resolution response is ignored after epoch increment", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);

    let resolveCallable;
    const pendingPromise = new Promise((resolve) => {
      resolveCallable = resolve;
    });

    const slowCallable = async () => pendingPromise;

    const resolutionPromise = orchestrateTeacherResolution(session, slowCallable);

    // Mid-flight epoch invalidation
    session.invalidate("sign-out-during-resolution");

    resolveCallable({
      data: {
        state: "active",
        teacher: { uid: "stale_teacher" },
        classroom: { id: "stale_room" }
      }
    });

    const res = await resolutionPromise;
    assert.equal(res.success, false);
    assert.equal(res.reason, "stale-epoch-ignored");
    assert.notEqual(session.classroomId, "stale_room");
  });

  test("distinct test: stale classroom data load is rejected and cannot mutate state", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);

    let loadApplied = false;
    let resolveLoad;
    const pendingLoad = new Promise((resolve) => {
      resolveLoad = resolve;
    });

    const loadPromise = orchestrateClassroomDataLoad(
      session,
      () => pendingLoad,
      () => {
        loadApplied = true;
      }
    );

    session.invalidate("tenant-switch-before-load");

    resolveLoad({ students: [{ id: "stale_student" }] });

    const res = await loadPromise;
    assert.equal(res.executed, false);
    assert.equal(res.reason, "stale-epoch-ignored");
    assert.equal(loadApplied, false, "Detects stale classroom data load mutating state");
  });

  test("distinct test: stale classroom data save is rejected and cannot write storage", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let resolveSave;
    const pendingSave = new Promise((resolve) => {
      resolveSave = resolve;
    });

    const savePromise = orchestrateClassroomDataSave(
      session,
      () => pendingSave,
      { students: [] }
    );

    // Stale epoch change while save is in-flight
    session.invalidate("account-switched-during-save");

    resolveSave({ saved: true });

    const res = await savePromise;
    assert.equal(res.executed, false);
    assert.equal(res.reason, "stale-epoch-ignored-post-save");
  });

  test("distinct test: stale student auth logs fetch is rejected and cannot update UI logs", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let logsApplied = false;
    let resolveLogs;
    const pendingLogs = new Promise((res) => { resolveLogs = res; });

    const logsPromise = orchestrateAuthLogsFetch(
      session,
      () => pendingLogs,
      () => {
        logsApplied = true;
      }
    );

    session.invalidate("sign-out");
    resolveLogs([{ logId: "stale_log" }]);

    const res = await logsPromise;
    assert.equal(res.executed, false);
    assert.equal(logsApplied, false, "Detects stale auth logs updating UI state");
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

  test("auth/session orchestration exercises Teacher A->B and B->A switching", async () => {
    const session = new TenantSession();

    // Teacher A resolution
    session.transitionTo(SESSION_STATES.AUTHENTICATING, { uid: "teacher_a" });
    const callableA = async () => ({
      data: {
        state: "active",
        teacher: { uid: "teacher_a" },
        classroom: { id: "room_a", name: "Class A", studentLoginCode: "CODE_A" }
      }
    });

    await orchestrateTeacherResolution(session, callableA);
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    assert.equal(session.uid, "teacher_a");
    assert.equal(session.classroomId, "room_a");
    assert.equal(session.getEpoch(), 0);

    // Switch to Teacher B via auth session signOut & fresh resolution
    await session.signOut();
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(session.getEpoch(), 1);

    session.transitionTo(SESSION_STATES.AUTHENTICATING, { uid: "teacher_b" });
    const callableB = async () => ({
      data: {
        state: "active",
        teacher: { uid: "teacher_b" },
        classroom: { id: "room_b", name: "Class B", studentLoginCode: "CODE_B" }
      }
    });

    await orchestrateTeacherResolution(session, callableB);
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    assert.equal(session.uid, "teacher_b");
    assert.equal(session.classroomId, "room_b");

    // Switch back B->A via auth session signOut & fresh resolution
    await session.signOut();
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(session.getEpoch(), 2);

    session.transitionTo(SESSION_STATES.AUTHENTICATING, { uid: "teacher_a" });
    await orchestrateTeacherResolution(session, callableA);
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    assert.equal(session.uid, "teacher_a");
    assert.equal(session.classroomId, "room_a");
  });
});
