import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TenantSession, SESSION_STATES, createDefaultGlobalState, resetGlobalApplicationState } from "./tenantSession.js";

describe("TenantSession State Machine and Epoch Isolation", () => {
  test("initializes in signed-out state with epoch 0", () => {
    const session = new TenantSession();
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(session.getEpoch(), 0);
    assert.equal(session.uid, null);
    assert.equal(session.classroomId, null);
    assert.equal(session.teacher, null);
    assert.equal(session.classroom, null);
  });

  test("valid state transitions: signed-out -> authenticating -> resolving", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    assert.equal(session.getState(), SESSION_STATES.AUTHENTICATING);

    session.transitionTo(SESSION_STATES.RESOLVING);
    assert.equal(session.getState(), SESSION_STATES.RESOLVING);
  });

  test("valid state transition: resolving -> onboarding-required -> onboarding -> active", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ONBOARDING_REQUIRED);
    assert.equal(session.getState(), SESSION_STATES.ONBOARDING_REQUIRED);

    session.transitionTo(SESSION_STATES.ONBOARDING);
    assert.equal(session.getState(), SESSION_STATES.ONBOARDING);

    session.transitionTo(SESSION_STATES.ACTIVE, {
      uid: "teacher_123",
      role: "teacher",
      classroomId: "room_abc"
    });
    assert.equal(session.getState(), SESSION_STATES.ACTIVE);
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
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    assert.equal(session.getState(), SESSION_STATES.CLASSROOM_LOADING);

    session.transitionTo(SESSION_STATES.READY);
    assert.equal(session.getState(), SESSION_STATES.READY);
  });

  test("rejects invalid state transitions", () => {
    const session = new TenantSession();
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
    assert.equal(session.getState(), SESSION_STATES.DENIED_OR_INCONSISTENT);
    assert.equal(session.errorMessage, "Account is disabled");
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

    assert.equal(session.getEpoch(), initialEpoch + 1);
    assert.equal(session.uid, "user2");
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

    assert.equal(listenerCalled, true);
    assert.equal(abortCalled, true);
    assert.equal(session.listeners.size, 0);
    assert.equal(session.abortControllers.size, 0);
    assert.equal(session.timeouts.size, 0);
    assert.equal(session.pendingTokens.size, 0);

    clearTimeout(timerId);
    assert.equal(timeoutCalled, false);
  });

  test("invalidation and global reset happen synchronously BEFORE awaiting Firebase signOut", async () => {
    let resetGlobalsCalled = false;
    let signOutResolved = false;
    let resolveSignOutPromise;

    const pendingSignOutPromise = new Promise((resolve) => {
      resolveSignOutPromise = resolve;
    });

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

    const pendingAuthAdapter = {
      signOut: async () => {
        await pendingSignOutPromise;
        signOutResolved = true;
      }
    };

    const signOutPromise = session.signOut(pendingAuthAdapter);

    assert.equal(signOutResolved, false, "SignOut promise should still be pending");
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT, "State must be signed-out BEFORE signOut resolves");
    assert.equal(session.getEpoch(), 1, "Epoch must be incremented BEFORE signOut resolves");
    assert.equal(resetGlobalsCalled, true, "onResetGlobals must be called BEFORE signOut resolves");
    assert.equal("mrMorganClassCashDataV5" in mockStorage.items, false, "Legacy storage key must be removed BEFORE signOut resolves");

    resolveSignOutPromise();
    const result = await signOutPromise;
    assert.equal(result.success, true);
    assert.equal(signOutResolved, true);
  });

  test("resetGlobalApplicationState resets every real application global to fresh defaults", () => {
    const globalState = {
      data: { students: [{ id: "st1", name: "Alice" }], settings: { test: 1 } },
      screen: "teacher",
      loginTab: "student",
      showTeacherPasswordLogin: true,
      isTeacher: true,
      loggedInStudentId: "st1",
      teacherProfileStudentId: "st1",
      message: "Active session loaded",
      studentLoginIdDraft: "draft_123",
      studentLoginPending: true,
      studentAuthLogs: [{ time: 100 }],
      studentAuthLogsLoading: true,
      studentAuthLogsError: "Error log",
      studentPinResetPending: true,
      bulkOperationPending: true,
      messageTimeout: 999,
      resolvedClassroom: { id: "c1", name: "Class 1" },
      resolvedTeacher: { uid: "t1", name: "Mr. T" },
      transactionTarget: "st1",
      teacherTransactionFilter: "credit"
    };

    resetGlobalApplicationState(globalState, () => createDefaultGlobalState().data);

    assert.deepEqual(globalState.data, createDefaultGlobalState().data);
    assert.equal(globalState.screen, "login");
    assert.equal(globalState.loginTab, "teacher");
    assert.equal(globalState.showTeacherPasswordLogin, false);
    assert.equal(globalState.isTeacher, false);
    assert.equal(globalState.loggedInStudentId, null);
    assert.equal(globalState.teacherProfileStudentId, null);
    assert.equal(globalState.message, "");
    assert.equal(globalState.studentLoginIdDraft, "");
    assert.equal(globalState.studentLoginPending, false);
    assert.deepEqual(globalState.studentAuthLogs, []);
    assert.equal(globalState.studentAuthLogsLoading, false);
    assert.equal(globalState.studentAuthLogsError, "");
    assert.equal(globalState.studentPinResetPending, false);
    assert.equal(globalState.bulkOperationPending, false);
    assert.equal(globalState.messageTimeout, null);
    assert.equal(globalState.resolvedClassroom, null);
    assert.equal(globalState.resolvedTeacher, null);
    assert.equal(globalState.transactionTarget, "all");
    assert.equal(globalState.teacherTransactionFilter, "all");
  });

  test("requireTeacher enforces strict ready state, current auth UID, teacher role, and classroomId", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, {
      uid: "teacher_uid_123",
      role: "teacher",
      classroomId: "room_123"
    });

    assert.equal(session.requireTeacher("teacher_uid_123"), false);

    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    assert.equal(session.requireTeacher("teacher_uid_123"), true);
    assert.equal(session.requireTeacher("different_auth_uid"), false);

    session.role = "student";
    assert.equal(session.requireTeacher("teacher_uid_123"), false);

    session.role = "teacher";
    session.classroomId = "";
    assert.equal(session.requireTeacher("teacher_uid_123"), false);
  });
});
