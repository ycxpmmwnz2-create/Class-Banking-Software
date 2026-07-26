import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TenantSession, SESSION_STATES } from "./tenantSession.js";

describe("TenantSession State Machine and Epoch Isolation", () => {
  test("initial state is signed-out with epoch 0", () => {
    const session = new TenantSession();
    assert.equal(
      session.getState(),
      SESSION_STATES.SIGNED_OUT,
      "Detects failure if initial state is not signed-out"
    );
    assert.equal(
      session.getEpoch(),
      0,
      "Detects failure if initial epoch is not 0"
    );
  });

  test("valid state transitions: signed-out -> authenticating -> resolving", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    assert.equal(
      session.getState(),
      SESSION_STATES.AUTHENTICATING,
      "Detects failure to transition to authenticating"
    );

    session.transitionTo(SESSION_STATES.RESOLVING);
    assert.equal(
      session.getState(),
      SESSION_STATES.RESOLVING,
      "Detects failure to transition to resolving"
    );
  });

  test("valid state transition: resolving -> onboarding-required -> onboarding -> resolving", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ONBOARDING_REQUIRED);
    assert.equal(
      session.getState(),
      SESSION_STATES.ONBOARDING_REQUIRED,
      "Detects failure to transition to onboarding-required"
    );

    session.transitionTo(SESSION_STATES.ONBOARDING);
    assert.equal(
      session.getState(),
      SESSION_STATES.ONBOARDING,
      "Detects failure to transition to onboarding"
    );

    session.transitionTo(SESSION_STATES.RESOLVING);
    assert.equal(
      session.getState(),
      SESSION_STATES.RESOLVING,
      "Detects failure to transition back to resolving"
    );
  });

  test("valid state transition: resolving -> active -> classroom-loading -> ready", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, {
      uid: "teacher_123",
      role: "teacher",
      classroomId: "room_abc"
    });
    assert.equal(
      session.getState(),
      SESSION_STATES.ACTIVE,
      "Detects failure to transition to active"
    );

    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    assert.equal(
      session.getState(),
      SESSION_STATES.CLASSROOM_LOADING,
      "Detects failure to transition to classroom-loading"
    );

    session.transitionTo(SESSION_STATES.READY);
    assert.equal(
      session.getState(),
      SESSION_STATES.READY,
      "Detects failure to transition to ready"
    );
  });

  test("rejects invalid state transitions", () => {
    const session = new TenantSession();
    // Cannot transition directly from signed-out to ready
    assert.throws(
      () => session.transitionTo(SESSION_STATES.READY),
      /Invalid state transition/,
      "Detects failure to reject illegal direct transition to ready from signed-out"
    );
  });

  test("handles missing/disabled/denied/inconsistent outcomes", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, {
      errorMessage: "Account is disabled"
    });
    assert.equal(
      session.getState(),
      SESSION_STATES.DENIED_OR_INCONSISTENT,
      "Detects failure to record denied-or-inconsistent state"
    );
    assert.equal(
      session.errorMessage,
      "Account is disabled",
      "Detects failure to record error message"
    );
  });

  test("epoch increments on UID, role, or classroom change invalidation", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, {
      uid: "user1",
      role: "teacher",
      classroomId: "room1"
    });

    const initialEpoch = session.getEpoch();
    session.invalidate("uid-changed", { uid: "user2", role: "teacher", state: SESSION_STATES.RESOLVING });

    assert.equal(
      session.getEpoch(),
      initialEpoch + 1,
      "Detects failure to increment epoch on UID invalidation"
    );
    assert.equal(
      session.uid,
      "user2",
      "Detects failure to set new UID"
    );
  });

  test("cancels listeners, abort controllers, timeouts, and pending tokens on invalidation", () => {
    const session = new TenantSession();
    let listenerCalled = false;
    let abortCalled = false;
    let timeoutCalled = false;

    session.registerListener(() => {
      listenerCalled = true;
    });

    const controller = {
      abort() {
        abortCalled = true;
      }
    };
    session.registerAbortController(controller);

    const timerId = setTimeout(() => {
      timeoutCalled = true;
    }, 1000);
    session.registerTimeout(timerId);

    session.registerPendingToken("token123");

    session.invalidate("test-invalidation");

    assert.equal(
      listenerCalled,
      true,
      "Detects failure to execute registered listener on invalidation"
    );
    assert.equal(
      abortCalled,
      true,
      "Detects failure to call controller.abort() on invalidation"
    );
    assert.equal(
      session.listeners.size,
      0,
      "Detects failure to clear registered listeners set"
    );
    assert.equal(
      session.abortControllers.size,
      0,
      "Detects failure to clear registered abortControllers set"
    );
    assert.equal(
      session.timeouts.size,
      0,
      "Detects failure to clear registered timeouts set"
    );
    assert.equal(
      session.pendingTokens.size,
      0,
      "Detects failure to clear pending tokens set"
    );

    clearTimeout(timerId);
    assert.equal(
      timeoutCalled,
      false,
      "Detects failure to clear pending timeout"
    );
  });

  test("signOut purges tenant state even when adapter signOut rejects", async () => {
    let resetGlobalsCalled = false;
    const mockStorage = {
      items: { mrMorganClassCashDataV5: "{}" },
      removeItem(key) {
        delete this.items[key];
      }
    };

    const session = new TenantSession({
      storageAdapter: mockStorage,
      onResetGlobals: () => {
        resetGlobalsCalled = true;
      }
    });

    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, {
      uid: "teacher_a",
      role: "teacher",
      classroomId: "room_a"
    });

    const rejectingAuthAdapter = {
      signOut: async () => {
        throw new Error("Network offline during sign out");
      }
    };

    const result = await session.signOut(rejectingAuthAdapter);

    assert.equal(
      result.success,
      true,
      "Detects failure to return success from signOut fallback"
    );
    assert.equal(
      session.getState(),
      SESSION_STATES.SIGNED_OUT,
      "Detects failure to transition to signed-out state on adapter rejection"
    );
    assert.equal(
      resetGlobalsCalled,
      true,
      "Detects failure to invoke resetGlobals callback on signOut rejection"
    );
    assert.equal(
      "mrMorganClassCashDataV5" in mockStorage.items,
      false,
      "Detects failure to remove legacy cache on signOut rejection"
    );
  });

  test("refresh begins with no trusted tenant", () => {
    const session = new TenantSession();
    assert.equal(
      session.getState(),
      SESSION_STATES.SIGNED_OUT,
      "Detects failure of refresh to start with no trusted tenant"
    );
    assert.equal(
      session.uid,
      null,
      "Detects failure of refresh to have null UID"
    );
    assert.equal(
      session.classroomId,
      null,
      "Detects failure of refresh to have null classroomId"
    );
  });

  test("captured identity validation rejects stale epochs", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, {
      uid: "uid1",
      role: "teacher",
      classroomId: "room1"
    });

    const captured = session.captureIdentity();
    assert.equal(
      session.validateCapturedIdentity(captured),
      true,
      "Detects failure to validate matching current captured identity"
    );

    session.invalidate("account-switch");
    assert.equal(
      session.validateCapturedIdentity(captured),
      false,
      "Detects failure to reject stale captured identity after epoch increment"
    );
  });

  test("requireTeacher enforces strict ready state and identity boundaries", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, {
      uid: "uid1",
      role: "teacher",
      classroomId: "room1"
    });

    assert.equal(
      session.requireTeacher(),
      false,
      "Detects failure to reject active state before ready state"
    );

    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    assert.equal(
      session.requireTeacher(),
      true,
      "Detects failure to approve teacher in ready state with valid identity"
    );

    session.role = "student";
    assert.equal(
      session.requireTeacher(),
      false,
      "Detects failure to reject student role in requireTeacher"
    );
  });
});
