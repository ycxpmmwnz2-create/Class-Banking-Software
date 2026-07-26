import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TenantSession, SESSION_STATES } from "./tenantSession.js";
import {
  mapSafeClientError,
  orchestrateTeacherResolution,
  orchestrateTeacherOnboarding,
  safeExecuteWithEpochCheck
} from "./tenantClient.js";

describe("TenantClient Orchestration and Safe Error Mapping", () => {
  test("successful active resolution transitions session to active", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);

    const mockCallable = async (name, payload) => {
      assert.equal(name, "resolveTeacherTenant");
      assert.deepEqual(payload, {}, "Detects client sending illegal payload to resolveTeacherTenant");
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

  test("onboarding-required resolution transitions session to onboarding-required", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);

    const mockCallable = async () => ({
      data: { state: "onboarding-required", eligibility: "invited" }
    });

    const res = await orchestrateTeacherResolution(session, mockCallable);

    assert.equal(res.success, true);
    assert.equal(session.getState(), SESSION_STATES.ONBOARDING_REQUIRED);
  });

  test("successful onboarding sends only classroomName and resolves active tenant", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ONBOARDING_REQUIRED);

    let onboardingCalledWith = null;

    const mockCallable = async (name, payload) => {
      if (name === "onboardTeacherClassroom") {
        onboardingCalledWith = payload;
        return { data: { state: "resolving" } };
      }
      if (name === "resolveTeacherTenant") {
        return {
          data: {
            state: "active",
            teacher: { uid: "t1", displayName: "Teacher" },
            classroom: { id: "room_new", name: payload?.classroomName || "New Class", studentLoginCode: "ABC123" }
          }
        };
      }
      throw new Error(`Unexpected callable ${name}`);
    };

    const res = await orchestrateTeacherOnboarding(session, mockCallable, { classroomName: "  Math 101  " });

    assert.equal(res.success, true);
    assert.deepEqual(onboardingCalledWith, { classroomName: "Math 101" }, "Detects failure to send trimmed classroomName only");
    assert.equal("classroomId" in onboardingCalledWith, false, "Detects illegal classroomId parameter in onboarding request");
    assert.equal(session.getState(), SESSION_STATES.ACTIVE);
  });

  test("maps missing/disabled/inconsistent errors to generic safe messages without leaking paths", () => {
    const unauthErr = { code: "unauthenticated", message: "Firebase auth error at /users/doc/1" };
    const permErr = { code: "permission-denied", message: "firestore/permission-denied at /teachers/t1" };
    const precondErr = { code: "failed-precondition", details: { correlationId: "CORR_999" } };
    const rawUnknownErr = { code: "internal", message: "Firestore doc /classrooms/123/secret failed" };

    assert.equal(
      mapSafeClientError(unauthErr),
      "Authentication required. Please sign in again.",
      "Detects failure to map unauthenticated error safely"
    );
    assert.equal(
      mapSafeClientError(permErr),
      "Access denied. Your account is not authorized.",
      "Detects failure to map permission-denied error safely"
    );
    assert.equal(
      mapSafeClientError(precondErr).includes("CORR_999"),
      true,
      "Detects failure to include correlation ID in failed-precondition error"
    );
    assert.equal(
      mapSafeClientError(rawUnknownErr).includes("classrooms"),
      false,
      "Detects raw internal path leak in user-facing error message"
    );
  });

  test("stale resolution response is ignored after epoch increment", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);

    let resolvePromiseResolver;
    const pendingPromise = new Promise(resolve => {
      resolvePromiseResolver = resolve;
    });

    const slowCallable = async () => pendingPromise;

    const resolutionPromise = orchestrateTeacherResolution(session, slowCallable);

    // Invalidate session mid-flight (epoch changes)
    session.invalidate("user-signed-out-during-resolution");

    // Now resolve slow callable
    resolvePromiseResolver({
      data: {
        state: "active",
        teacher: { uid: "stale_uid" },
        classroom: { id: "stale_room" }
      }
    });

    const res = await resolutionPromise;

    assert.equal(res.success, false);
    assert.equal(res.reason, "stale-epoch-ignored");
    assert.notEqual(session.classroomId, "stale_room", "Detects stale resolution mutating session state");
  });

  test("stale onboarding response is ignored after epoch increment", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ONBOARDING_REQUIRED);

    let resolveOnboarding;
    const slowOnboardingCallable = async () => new Promise(res => { resolveOnboarding = res; });

    const onboardingPromise = orchestrateTeacherOnboarding(session, slowOnboardingCallable, { classroomName: "Test Class" });

    session.invalidate("tab-switched");
    resolveOnboarding({ data: { state: "resolving" } });

    const res = await onboardingPromise;
    assert.equal(res.success, false);
    assert.equal(res.reason, "stale-epoch-ignored");
  });

  test("safeExecuteWithEpochCheck ignores stale callbacks for loads, saves, auth logs, and PIN resets", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "u1", role: "teacher", classroomId: "c1" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    let applyFnCalled = false;
    const slowLoad = () => new Promise(res => setTimeout(() => res({ loaded: true }), 20));

    const loadPromise = safeExecuteWithEpochCheck(
      session,
      slowLoad,
      () => {
        applyFnCalled = true;
      }
    );

    // Epoch changes before load finishes
    session.invalidate("account-switch");

    const res = await loadPromise;
    assert.equal(res.executed, false);
    assert.equal(res.reason, "stale-epoch-ignored");
    assert.equal(applyFnCalled, false, "Detects stale callback executing apply function after epoch invalidation");
  });

  test("isolation between Teacher A->B and B->A switching", async () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    const epochA = session.getEpoch();
    assert.equal(session.uid, "teacher_a");
    assert.equal(session.classroomId, "room_a");

    // Switch to Teacher B
    session.invalidate("switch-account", { uid: "teacher_b", role: "teacher", state: SESSION_STATES.RESOLVING });
    const epochB = session.getEpoch();

    assert.notEqual(epochA, epochB, "Detects failure to increment epoch between account switch A->B");
    assert.equal(session.uid, "teacher_b");
    assert.equal(session.classroomId, null, "Detects uncleared classroomId on switch to Teacher B");

    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_b", role: "teacher", classroomId: "room_b" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    assert.equal(session.uid, "teacher_b");
    assert.equal(session.classroomId, "room_b");

    // Switch back B->A
    session.invalidate("switch-account-back", { uid: "teacher_a", role: "teacher", state: SESSION_STATES.RESOLVING });
    const epochA2 = session.getEpoch();

    assert.notEqual(epochB, epochA2, "Detects failure to increment epoch on switch back B->A");
    assert.equal(session.uid, "teacher_a");
    assert.equal(session.classroomId, null, "Detects uncleared classroomId on switch back B->A");
  });
});
