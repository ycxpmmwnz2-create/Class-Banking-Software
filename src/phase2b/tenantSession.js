export const SESSION_STATES = Object.freeze({
  SIGNED_OUT: "signed-out",
  AUTHENTICATING: "authenticating",
  RESOLVING: "resolving",
  ONBOARDING_REQUIRED: "onboarding-required",
  ONBOARDING: "onboarding",
  ACTIVE: "active",
  CLASSROOM_LOADING: "classroom-loading",
  READY: "ready",
  DENIED_OR_INCONSISTENT: "denied-or-inconsistent"
});

const VALID_TRANSITIONS = {
  [SESSION_STATES.SIGNED_OUT]: [SESSION_STATES.AUTHENTICATING, SESSION_STATES.RESOLVING],
  [SESSION_STATES.AUTHENTICATING]: [SESSION_STATES.RESOLVING, SESSION_STATES.SIGNED_OUT, SESSION_STATES.DENIED_OR_INCONSISTENT],
  [SESSION_STATES.RESOLVING]: [
    SESSION_STATES.ONBOARDING_REQUIRED,
    SESSION_STATES.ACTIVE,
    SESSION_STATES.DENIED_OR_INCONSISTENT,
    SESSION_STATES.SIGNED_OUT
  ],
  [SESSION_STATES.ONBOARDING_REQUIRED]: [SESSION_STATES.ONBOARDING, SESSION_STATES.SIGNED_OUT],
  [SESSION_STATES.ONBOARDING]: [
    SESSION_STATES.RESOLVING,
    SESSION_STATES.ACTIVE,
    SESSION_STATES.ONBOARDING_REQUIRED,
    SESSION_STATES.DENIED_OR_INCONSISTENT,
    SESSION_STATES.SIGNED_OUT
  ],
  [SESSION_STATES.ACTIVE]: [
    SESSION_STATES.CLASSROOM_LOADING,
    SESSION_STATES.DENIED_OR_INCONSISTENT,
    SESSION_STATES.SIGNED_OUT
  ],
  [SESSION_STATES.CLASSROOM_LOADING]: [
    SESSION_STATES.READY,
    SESSION_STATES.DENIED_OR_INCONSISTENT,
    SESSION_STATES.SIGNED_OUT
  ],
  [SESSION_STATES.READY]: [
    SESSION_STATES.CLASSROOM_LOADING,
    SESSION_STATES.RESOLVING,
    SESSION_STATES.SIGNED_OUT,
    SESSION_STATES.DENIED_OR_INCONSISTENT
  ],
  [SESSION_STATES.DENIED_OR_INCONSISTENT]: [SESSION_STATES.SIGNED_OUT, SESSION_STATES.AUTHENTICATING, SESSION_STATES.RESOLVING]
};

export function createDefaultGlobalState() {
  return {
    data: {
      students: [],
      transactions: [],
      loginHistory: [],
      settings: {
        studentRequestsEnabled: true,
        studentAddRequestsEnabled: true,
        studentSubtractRequestsEnabled: true,
        purchaseRequestsEnabled: true,
        requireTeacherApproval: true,
        reasons: [],
        purchaseCategories: [],
        addMoneyCategories: [],
        subtractMoneyCategories: []
      },
      lastBackupAt: null
    },
    screen: "login",
    loginTab: "teacher",
    showTeacherPasswordLogin: false,
    isTeacher: false,
    loggedInStudentId: null,
    teacherProfileStudentId: null,
    message: "",
    studentClassroomCodeDraft: "",
    studentLoginIdDraft: "",
    studentLoginPending: false,
    studentMoneySubmissionPending: false,
    studentAuthLogs: [],
    studentAuthLogsLoading: false,
    studentAuthLogsError: "",
    studentPinResetPending: false,
    bulkOperationPending: false,
    studentLifecyclePending: false,
    messageTimeout: null,
    resolvedClassroom: null,
    resolvedTeacher: null,
    transactionTarget: "selected",
    teacherTransactionFilter: "all"
  };
}

export function resetGlobalApplicationState(stateObj, defaultDataFn = null) {
  if (!stateObj || typeof stateObj !== "object") return;

  const defaults = createDefaultGlobalState();
  if (typeof defaultDataFn === "function") {
    defaults.data = defaultDataFn();
  }

  stateObj.data = defaults.data;
  stateObj.screen = defaults.screen;
  stateObj.loginTab = defaults.loginTab;
  stateObj.showTeacherPasswordLogin = defaults.showTeacherPasswordLogin;
  stateObj.isTeacher = defaults.isTeacher;
  stateObj.loggedInStudentId = defaults.loggedInStudentId;
  stateObj.teacherProfileStudentId = defaults.teacherProfileStudentId;
  stateObj.message = defaults.message;
  stateObj.studentClassroomCodeDraft = defaults.studentClassroomCodeDraft;
  stateObj.studentLoginIdDraft = defaults.studentLoginIdDraft;
  stateObj.studentLoginPending = defaults.studentLoginPending;
  stateObj.studentMoneySubmissionPending = defaults.studentMoneySubmissionPending;
  stateObj.studentAuthLogs = defaults.studentAuthLogs;
  stateObj.studentAuthLogsLoading = defaults.studentAuthLogsLoading;
  stateObj.studentAuthLogsError = defaults.studentAuthLogsError;
  stateObj.studentPinResetPending = defaults.studentPinResetPending;
  stateObj.bulkOperationPending = defaults.bulkOperationPending;
  stateObj.studentLifecyclePending = defaults.studentLifecyclePending;

  if (stateObj.messageTimeout !== null && stateObj.messageTimeout !== undefined) {
    try {
      clearTimeout(stateObj.messageTimeout);
    } catch {
      // ignore
    }
  }
  stateObj.messageTimeout = null;
  stateObj.resolvedClassroom = defaults.resolvedClassroom;
  stateObj.resolvedTeacher = defaults.resolvedTeacher;
  stateObj.transactionTarget = defaults.transactionTarget;
  stateObj.teacherTransactionFilter = defaults.teacherTransactionFilter;

  return stateObj;
}

export class TenantSession {
  constructor(options = {}) {
    this.storageAdapter = options.storageAdapter || (typeof localStorage !== "undefined" ? localStorage : null);
    this.cacheModule = options.cacheModule || null;
    this.onResetGlobals = options.onResetGlobals || null;
    this.onStateChange = options.onStateChange || null;
    this.authAdapter = options.authAdapter || null;
    this.multiTabInvalidator = options.multiTabInvalidator || null;
    this.projectId = options.projectId || "morgan-bank";

    this.state = SESSION_STATES.SIGNED_OUT;
    this.epoch = 0;
    this.uid = null;
    this.role = null;
    this.classroomId = null;
    this.studentId = null;
    this.teacher = null;
    this.classroom = null;
    this.errorMessage = "";
    this.correlationId = null;
    this.invalidationReason = null;

    this.listeners = new Set();
    this.abortControllers = new Set();
    this.timeouts = new Set();
    this.pendingTokens = new Set();
  }

  getState() {
    return this.state;
  }

  getEpoch() {
    return this.epoch;
  }

  getContext() {
    return {
      uid: this.uid,
      role: this.role,
      classroomId: this.classroomId,
      studentId: this.studentId,
      epoch: this.epoch,
      state: this.state
    };
  }

  captureIdentity() {
    return {
      uid: this.uid,
      role: this.role,
      classroomId: this.classroomId,
      studentId: this.studentId,
      epoch: this.epoch
    };
  }

  validateCapturedIdentity(captured) {
    if (!captured || typeof captured !== "object" || Array.isArray(captured)) return false;
    if (typeof captured.epoch !== "number" || !Number.isInteger(captured.epoch) || captured.epoch < 0) {
      return false;
    }
    return (
      captured.epoch === this.epoch &&
      captured.uid === this.uid &&
      captured.role === this.role &&
      captured.classroomId === this.classroomId &&
      captured.studentId === this.studentId
    );
  }

  registerListener(unsubscribeFn) {
    if (typeof unsubscribeFn === "function") {
      this.listeners.add(unsubscribeFn);
    }
  }

  registerAbortController(controller) {
    if (controller && typeof controller.abort === "function") {
      this.abortControllers.add(controller);
    }
  }

  registerTimeout(timeoutId) {
    if (timeoutId !== null && timeoutId !== undefined) {
      this.timeouts.add(timeoutId);
    }
  }

  registerPendingToken(token) {
    if (token) {
      this.pendingTokens.add(token);
    }
  }

  clearResources() {
    for (const unsubscribeFn of this.listeners) {
      try {
        unsubscribeFn();
      } catch (err) {
        console.error("Error running listener unsubscribe:", err);
      }
    }
    this.listeners.clear();

    for (const controller of this.abortControllers) {
      try {
        controller.abort();
      } catch (err) {
        console.error("Error aborting controller:", err);
      }
    }
    this.abortControllers.clear();

    for (const timeoutId of this.timeouts) {
      try {
        clearTimeout(timeoutId);
      } catch (err) {
        console.error("Error clearing timeout:", err);
      }
    }
    this.timeouts.clear();

    this.pendingTokens.clear();
  }

  canTransitionTo(nextState) {
    const allowed = VALID_TRANSITIONS[this.state];
    return Array.isArray(allowed) && allowed.includes(nextState);
  }

  transitionTo(nextState, context = {}) {
    if (!this.canTransitionTo(nextState)) {
      throw new Error(`Invalid state transition from ${this.state} to ${nextState}`);
    }

    this.state = nextState;

    if (context.uid !== undefined) this.uid = context.uid;
    if (context.role !== undefined) this.role = context.role;
    if (context.classroomId !== undefined) this.classroomId = context.classroomId;
    if (context.studentId !== undefined) this.studentId = context.studentId;
    if (context.teacher !== undefined) this.teacher = context.teacher;
    if (context.classroom !== undefined) this.classroom = context.classroom;
    if (context.errorMessage !== undefined) this.errorMessage = context.errorMessage;
    if (context.correlationId !== undefined) this.correlationId = context.correlationId;

    if (typeof this.onStateChange === "function") {
      try {
        this.onStateChange(this.state);
      } catch (err) {
        console.error("onStateChange callback failed:", err);
      }
    }

    return this.getState();
  }

  invalidate(reason = "session-invalidated", newIdentity = {}) {
    const oldUid = this.uid;
    const oldRole = this.role;
    const oldClassroomId = this.classroomId;

    this.epoch += 1;
    this.invalidationReason = reason;

    this.clearResources();

    if (this.cacheModule && oldUid && oldClassroomId && typeof this.cacheModule.purgeTenantCache === "function") {
      try {
        this.cacheModule.purgeTenantCache(this.storageAdapter, this.projectId, oldUid, oldClassroomId);
      } catch (err) {
        console.error("Cache purge failed during invalidation:", err);
      }
    }

    if (this.storageAdapter && typeof this.storageAdapter.removeItem === "function") {
      try {
        this.storageAdapter.removeItem("mrMorganClassCashDataV5");
      } catch (err) {
        console.error("Legacy cache purge failed during invalidation:", err);
      }
    }

    if (typeof this.onResetGlobals === "function") {
      try {
        this.onResetGlobals();
      } catch (err) {
        console.error("Reset globals callback failed during invalidation:", err);
      }
    }

    const newUid = newIdentity.uid || null;
    const newRole = newIdentity.role || null;
    const newClassroomId = newIdentity.classroomId || null;
    const newStudentId = newIdentity.studentId || null;

    this.uid = newUid;
    this.role = newRole;
    this.classroomId = newClassroomId;
    this.studentId = newStudentId;
    this.teacher = newIdentity.teacher || null;
    this.classroom = newIdentity.classroom || null;
    this.errorMessage = newIdentity.errorMessage || "";
    this.correlationId = newIdentity.correlationId || null;

    this.state = newIdentity.state || SESSION_STATES.SIGNED_OUT;

    if (typeof this.onStateChange === "function") {
      try {
        this.onStateChange(this.state);
      } catch (err) {
        console.error("onStateChange callback failed:", err);
      }
    }

    // A transport message always invalidates an OUTGOING tenant. During an
    // initial Auth observation the observer stages uid/role in more than one
    // invalidate() call before any classroom is resolved. Sending the incoming
    // UID from either staging call makes an established same-account tab sign
    // itself out merely because a new tab signed in.
    const hadOutgoingTenant = Boolean(oldUid && oldClassroomId);
    const shouldBroadcast =
      reason !== "multi-tab-invalidation" &&
      reason !== "malformed-broadcast-message" &&
      hadOutgoingTenant &&
      (reason === "sign-out" || oldUid !== newUid || oldRole !== newRole || oldClassroomId !== newClassroomId);

    if (shouldBroadcast && this.multiTabInvalidator && typeof this.multiTabInvalidator.broadcastInvalidation === "function") {
      try {
        this.multiTabInvalidator.broadcastInvalidation(oldUid, this.epoch);
      } catch (err) {
        console.error("MultiTab invalidation broadcast failed:", err);
      }
    }

    return this.getState();
  }

  async signOut(authAdapter = null) {
    const adapter = authAdapter || this.authAdapter;

    // Invalidation and global reset happen synchronously BEFORE awaiting Firebase signOut
    this.invalidate("sign-out", { state: SESSION_STATES.SIGNED_OUT });

    let signOutError = null;
    if (adapter && typeof adapter.signOut === "function") {
      try {
        await adapter.signOut();
      } catch (err) {
        signOutError = err;
      }
    }

    if (signOutError) {
      return { success: true, warning: "Local adapter signOut rejected, tenant state purged successfully." };
    }
    return { success: true };
  }

  requireTeacher(currentAuthUid) {
    const isReady = this.state === SESSION_STATES.READY;
    const hasMatchingUid = Boolean(this.uid && currentAuthUid === this.uid);
    const hasClassroom = Boolean(typeof this.classroomId === "string" && this.classroomId.length > 0);
    const isTeacherRole = this.role === "teacher";
    return isReady && hasMatchingUid && hasClassroom && isTeacherRole;
  }
}
