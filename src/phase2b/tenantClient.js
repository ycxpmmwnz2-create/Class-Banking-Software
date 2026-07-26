import { SESSION_STATES } from "./tenantSession.js";
import { classifyOfflineFailure, readTeacherCache, writeTeacherCache } from "./tenantCache.js";

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

export async function loadClassroomDataWithCacheFallback(session, { loadNetworkFn, storageAdapter, projectId }) {
  if (session.getState() !== SESSION_STATES.ACTIVE) {
    throw new Error("Data load requires ACTIVE session state following authoritative resolution.");
  }

  session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
  const captured = session.captureIdentity();

  try {
    const networkData = await loadNetworkFn();

    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }

    session.transitionTo(SESSION_STATES.READY);
    writeTeacherCache(storageAdapter, session, projectId, networkData, captured);

    return { executed: true, data: networkData, isOffline: false };
  } catch (error) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }

    const isTransient = classifyOfflineFailure(error);
    if (!isTransient) {
      const safeMsg = mapSafeClientError(error);
      session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMsg });
      session.invalidate("non-transient-network-load-failure", {
        state: SESSION_STATES.DENIED_OR_INCONSISTENT,
        errorMessage: safeMsg
      });
      return { executed: false, reason: "non-transient-network-failure", error: safeMsg };
    }

    // Transient network failure -> attempt fallback to matching tenant cache
    const cached = readTeacherCache(storageAdapter, session, projectId);
    if (cached && cached.data) {
      session.transitionTo(SESSION_STATES.READY);
      return { executed: true, data: cached.data, isOffline: true };
    }

    const safeMsg = "Network unavailable and no cached classroom data exists.";
    session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMsg });
    session.invalidate("transient-load-failure-no-cache", {
      state: SESSION_STATES.DENIED_OR_INCONSISTENT,
      errorMessage: safeMsg
    });
    return { executed: false, reason: "transient-load-failure-no-cache" };
  }
}

export async function handleAuthTransition(session, user, tokenResult, { callAdapter, loadNetworkFn, storageAdapter, projectId }) {
  const uid = user?.uid || null;
  const role = tokenResult?.claims?.role || (user ? "teacher" : null);

  // Compare with current resolved identity to prevent redundant invalidations
  if (session.uid === uid && session.role === role && session.state !== SESSION_STATES.SIGNED_OUT) {
    return { state: session.getState(), ignored: true };
  }

  // Synchronously invalidate before processing identity change
  session.invalidate("auth-observer-change", { uid, role, state: user ? SESSION_STATES.AUTHENTICATING : SESSION_STATES.SIGNED_OUT });

  if (!user) {
    return { state: SESSION_STATES.SIGNED_OUT };
  }

  if (role === "student") {
    // V2 student session handling
    return { state: SESSION_STATES.AUTHENTICATING, role: "student" };
  }

  const resolutionRes = await orchestrateTeacherResolution(session, callAdapter);

  if (resolutionRes.success && session.getState() === SESSION_STATES.ACTIVE) {
    return loadClassroomDataWithCacheFallback(session, { loadNetworkFn, storageAdapter, projectId });
  }

  return resolutionRes;
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

export async function orchestrateClassroomDataSave(session, saveFn, data, storageSpy = null) {
  const captured = session.captureIdentity();
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  const result = await saveFn(data);
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored-post-save" };
  }
  if (storageSpy && typeof storageSpy.setItem === "function") {
    storageSpy.setItem("morganBank:saveData", JSON.stringify(data));
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
