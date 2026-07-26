import { SESSION_STATES } from "./tenantSession.js";

export function normalizeFirebaseErrorCode(error) {
  if (!error) return "";
  let code = typeof error === "string" ? error : error.code || "";
  if (code.startsWith("functions/")) {
    code = code.replace(/^functions\//, "");
  }
  return code;
}

export function mapSafeClientError(error) {
  if (!error) return "An unexpected error occurred. Please try again.";

  const rawCode = normalizeFirebaseErrorCode(error);
  if (rawCode === "unauthenticated") {
    return "Sign in required.";
  }
  if (rawCode === "permission-denied") {
    return "This account is not eligible to complete this action.";
  }
  if (rawCode === "failed-precondition") {
    return "This account cannot be set up automatically. Contact your administrator for assistance.";
  }
  if (rawCode === "already-exists") {
    return "This account is not eligible to complete this action.";
  }
  if (rawCode === "invalid-argument") {
    return "The request was invalid.";
  }
  if (rawCode === "resource-exhausted") {
    return "The request could not be completed. Please try again later.";
  }
  if (rawCode === "aborted") {
    return "The request could not be completed. Please try again.";
  }

  return "An unexpected internal error occurred.";
}

export async function orchestrateTeacherResolution(session, callableAdapter) {
  if (!session) throw new Error("Tenant session is required.");
  if (!callableAdapter || typeof callableAdapter !== "function") {
    throw new Error("Callable adapter function is required.");
  }

  const captured = session.captureIdentity();
  session.transitionTo(SESSION_STATES.RESOLVING);

  try {
    const response = await callableAdapter("resolveTeacherTenantV2", {});
    if (!session.validateCapturedIdentity(captured)) {
      return { success: false, reason: "stale-epoch-ignored" };
    }

    const res = response?.data || response;
    if (res?.state === "onboarding-required") {
      session.transitionTo(SESSION_STATES.ONBOARDING_REQUIRED);
      return { success: true, state: "onboarding-required", eligibility: res.eligibility };
    }

    if (res?.state === "active" && res.classroom?.id) {
      session.transitionTo(SESSION_STATES.ACTIVE, {
        uid: res.teacher?.uid || session.uid,
        role: "teacher",
        classroomId: res.classroom.id,
        teacher: res.teacher,
        classroom: res.classroom
      });
      return { success: true, state: "active", teacher: res.teacher, classroom: res.classroom };
    }

    const safeMessage = "Unexpected server resolution state.";
    session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMessage });
    session.invalidate("resolution-denied-or-inconsistent", {
      state: SESSION_STATES.DENIED_OR_INCONSISTENT,
      errorMessage: safeMessage
    });
    return { success: false, reason: "inconsistent-resolution" };

  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { success: false, reason: "stale-epoch-ignored" };
    }

    const safeMessage = mapSafeClientError(err);
    session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMessage });
    session.invalidate("resolution-failed", {
      state: SESSION_STATES.DENIED_OR_INCONSISTENT,
      errorMessage: safeMessage
    });
    return { success: false, error: safeMessage, rawCode: normalizeFirebaseErrorCode(err) };
  }
}

export async function orchestrateTeacherOnboarding(session, callableAdapter, { classroomName }) {
  if (!session) throw new Error("Tenant session is required.");
  if (!callableAdapter || typeof callableAdapter !== "function") {
    throw new Error("Callable adapter function is required.");
  }
  if (!classroomName || typeof classroomName !== "string" || !classroomName.trim()) {
    throw new Error("Classroom name must be a non-empty string.");
  }

  const captured = session.captureIdentity();
  session.transitionTo(SESSION_STATES.ONBOARDING);

  try {
    const payload = { classroomName: classroomName.trim() };
    const response = await callableAdapter("onboardTeacherClassroomV2", payload);

    if (!session.validateCapturedIdentity(captured)) {
      return { success: false, reason: "stale-epoch-ignored" };
    }

    const res = response?.data || response;
    if (res?.teacher && res?.classroom?.id) {
      session.transitionTo(SESSION_STATES.ACTIVE, {
        uid: res.teacher.uid || session.uid,
        role: "teacher",
        classroomId: res.classroom.id,
        teacher: res.teacher,
        classroom: res.classroom
      });
      return { success: true, state: "active", teacher: res.teacher, classroom: res.classroom, created: Boolean(res.created) };
    }

    const safeMsg = "Onboarding response missing valid teacher or classroom data.";
    session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMsg });
    session.invalidate("onboarding-inconsistent", {
      state: SESSION_STATES.DENIED_OR_INCONSISTENT,
      errorMessage: safeMsg
    });
    return { success: false, reason: "onboarding-inconsistent" };

  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { success: false, reason: "stale-epoch-ignored" };
    }

    const safeMessage = mapSafeClientError(err);
    session.transitionTo(SESSION_STATES.ONBOARDING_REQUIRED, { errorMessage: safeMessage });
    return { success: false, error: safeMessage, rawCode: normalizeFirebaseErrorCode(err) };
  }
}

export async function orchestrateClassroomDataLoad(session, loadFn, applyFn) {
  const captured = session.captureIdentity();
  const loadedData = await loadFn();
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  if (typeof applyFn === "function") {
    applyFn(loadedData);
  }
  return { executed: true, data: loadedData };
}

export async function orchestrateClassroomDataSave(session, saveFn, data) {
  const captured = session.captureIdentity();
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  const result = await saveFn(data);
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored-post-save" };
  }
  return { executed: true, result };
}

export async function orchestrateAuthLogsFetch(session, fetchFn, applyFn) {
  const captured = session.captureIdentity();
  const logs = await fetchFn();
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  if (typeof applyFn === "function") {
    applyFn(logs);
  }
  return { executed: true, logs };
}

export async function orchestrateStudentPinReset(session, resetFn, payload) {
  const captured = session.captureIdentity();
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  const result = await resetFn(payload);
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored-post-reset" };
  }
  return { executed: true, result };
}

export async function orchestrateBulkOperation(session, bulkFn, payload) {
  const captured = session.captureIdentity();
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  const result = await bulkFn(payload);
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored-post-bulk" };
  }
  return { executed: true, result };
}

export async function safeExecuteWithEpochCheck(session, asyncFn, applyFn) {
  const captured = session.captureIdentity();
  const result = await asyncFn();
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  if (typeof applyFn === "function") {
    applyFn(result);
  }
  return { executed: true, result };
}
