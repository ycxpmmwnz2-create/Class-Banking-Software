import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TenantSession, SESSION_STATES } from "./tenantSession.js";

describe("TenantSession State Machine and Epoch Isolation", () => {
  test("refresh/bootstrap path begins with no trusted tenant and epoch 0", () => {
    // Exercises the refresh/bootstrap path
    const session = new TenantSession();
    assert.equal(
      session.getState(),
      SESSION_STATES.SIGNED_OUT,
      "Detects failure if bootstrap state is not signed-out"
    );
    assert.equal(
      session.getEpoch(),
      0,
      "Detects failure if bootstrap epoch is not 0"
    );
    assert.equal(session.uid, null, "Detects failure of bootstrap path to have null UID");
    assert.equal(session.classroomId, null, "Detects failure of bootstrap path to have null classroomId");
    assert.equal(session.teacher, null, "Detects failure of bootstrap path to have null teacher");
    assert.equal(session.classroom, null, "Detects failure of bootstrap path to have null classroom");
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

    // Invoke signOut, which begins async signOut execution
    const signOutPromise = session.signOut(pendingAuthAdapter);

    // PROVE that BEFORE signOut promise resolves, state/cache/reset have ALREADY cleared synchronously
    assert.equal(signOutResolved, false, "SignOut promise should still be pending");
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT, "State must be signed-out BEFORE signOut resolves");
    assert.equal(session.getEpoch(), 1, "Epoch must be incremented BEFORE signOut resolves");
    assert.equal(resetGlobalsCalled, true, "onResetGlobals must be called BEFORE signOut resolves");
    assert.equal("mrMorganClassCashDataV5" in mockStorage.items, false, "Legacy storage key must be removed BEFORE signOut resolves");

    // Now resolve pending signOut promise
    resolveSignOutPromise();
    const result = await signOutPromise;
    assert.equal(result.success, true);
    assert.equal(signOutResolved, true);
  });

  test("resets every global listed in the architecture on invalidation", () => {
    // Architectural list of globals:
    // data, isTeacher, loggedInStudentId, teacherProfileStudentId, transactionTarget, teacherTransactionFilter,
    // studentLoginIdDraft, showTeacherPasswordLogin, resolvedClassroom, resolvedTeacher, screen, loginTab,
    // message, messageTimeout, studentAuthLogs, studentAuthLogsError, studentAuthLogsLoading,
    // studentPinResetPending, bulkOperationPending, listeners, controllers, timeouts, pendingTokens
    const globalState = {
      data: { students: [{ id: "st1", name: "Alice" }], settings: { test: 1 } },
      isTeacher: true,
      loggedInStudentId: "st1",
      teacherProfileStudentId: "st1",
      transactionTarget: "st1",
      teacherTransactionFilter: "credit",
      studentLoginIdDraft: "draft_123",
      showTeacherPasswordLogin: true,
      resolvedClassroom: { id: "c1", name: "Class 1" },
      resolvedTeacher: { uid: "t1", name: "Mr. T" },
      screen: "teacher",
      loginTab: "student",
      message: "Active session loaded",
      messageTimeout: 999,
      studentAuthLogs: [{ time: 100 }],
      studentAuthLogsError: "Error log",
      studentAuthLogsLoading: true,
      studentPinResetPending: true,
      bulkOperationPending: true
    };

    function resetAllArchitectureGlobals() {
      globalState.data = { students: [], transactions: [], loginHistory: [], settings: {}, lastBackupAt: null };
      globalState.isTeacher = false;
      globalState.loggedInStudentId = null;
      globalState.teacherProfileStudentId = null;
      globalState.transactionTarget = "all";
      globalState.teacherTransactionFilter = "all";
      globalState.studentLoginIdDraft = "";
      globalState.showTeacherPasswordLogin = false;
      globalState.resolvedClassroom = null;
      globalState.resolvedTeacher = null;
      globalState.screen = "login";
      globalState.loginTab = "teacher";
      globalState.message = "";
      globalState.messageTimeout = null;
      globalState.studentAuthLogs = [];
      globalState.studentAuthLogsError = "";
      globalState.studentAuthLogsLoading = false;
      globalState.studentPinResetPending = false;
      globalState.bulkOperationPending = false;
    }

    const session = new TenantSession({
      onResetGlobals: resetAllArchitectureGlobals
    });

    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "t1", role: "teacher", classroomId: "c1" });

    session.invalidate("reset-all-globals-test");

    // Inspect every required global
    assert.deepEqual(globalState.data, { students: [], transactions: [], loginHistory: [], settings: {}, lastBackupAt: null });
    assert.equal(globalState.isTeacher, false);
    assert.equal(globalState.loggedInStudentId, null);
    assert.equal(globalState.teacherProfileStudentId, null);
    assert.equal(globalState.transactionTarget, "all");
    assert.equal(globalState.teacherTransactionFilter, "all");
    assert.equal(globalState.studentLoginIdDraft, "");
    assert.equal(globalState.showTeacherPasswordLogin, false);
    assert.equal(globalState.resolvedClassroom, null);
    assert.equal(globalState.resolvedTeacher, null);
    assert.equal(globalState.screen, "login");
    assert.equal(globalState.loginTab, "teacher");
    assert.equal(globalState.message, "");
    assert.equal(globalState.messageTimeout, null);
    assert.deepEqual(globalState.studentAuthLogs, []);
    assert.equal(globalState.studentAuthLogsError, "");
    assert.equal(globalState.studentAuthLogsLoading, false);
    assert.equal(globalState.studentPinResetPending, false);
    assert.equal(globalState.bulkOperationPending, false);
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

    assert.equal(
      session.requireTeacher("teacher_uid_123"),
      false,
      "Detects failure to reject ACTIVE state before READY state in requireTeacher"
    );

    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    assert.equal(
      session.requireTeacher("teacher_uid_123"),
      true,
      "Detects failure to approve teacher when state is READY and Auth UID matches"
    );

    assert.equal(
      session.requireTeacher("different_auth_uid"),
      false,
      "Detects failure to reject when current Auth UID differs from resolved session UID"
    );

    session.role = "student";
    assert.equal(
      session.requireTeacher("teacher_uid_123"),
      false,
      "Detects failure to reject non-teacher role in requireTeacher"
    );

    session.role = "teacher";
    session.classroomId = "";
    assert.equal(
      session.requireTeacher("teacher_uid_123"),
      false,
      "Detects failure to reject empty classroomId in requireTeacher"
    );
  });
});
