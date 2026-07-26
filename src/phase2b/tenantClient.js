import { SESSION_STATES } from "./tenantSession.js";

export function mapSafeClientError(error) {
  if (!error) return "An unexpected error occurred. Please try again.";

  const code = error.code || "";
  if (code === "unauthenticated") {
    return "Authentication required. Please sign in again.";
  }
  if (code === "permission-denied") {
    return "Access denied. Your account is not authorized.";
  }
  if (code === "failed-precondition") {
    const correlationId = error.details?.correlationId || error.correlationId;
    if (correlationId) {
      return `Account data is inconsistent. Please contact support with code: ${correlationId}`;
    }
    return "Account configuration is incomplete or inconsistent. Please contact support.";
  }
  if (code === "already-exists") {
    return "Classroom setup has already been completed.";
  }
  if (code === "invalid-argument") {
    return "Invalid classroom input details provided.";
  }
  if (code === "resource-exhausted") {
    return "System is currently busy. Please try again shortly.";
  }
  if (code === "aborted") {
    return "Operation was interrupted. Please try again.";
  }

  return "An unexpected error occurred. Please try again.";
}

export async function orchestrateTeacherResolution(session, callableAdapter) {
  if (!session) throw new Error("Tenant session is required.");
  if (!callableAdapter || typeof callableAdapter !== "function") {
    throw new Error("Callable adapter function is required.");
  }

  const captured = session.captureIdentity();
  session.transitionTo(SESSION_STATES.RESOLVING);

  try {
    const response = await callableAdapter("resolveTeacherTenant", {});
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

    session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, {
      errorMessage: "Unexpected resolution response shape from server."
    });
    session.invalidate("resolution-denied-or-inconsistent", {
      state: SESSION_STATES.DENIED_OR_INCONSISTENT,
      errorMessage: "Unexpected resolution response shape from server."
    });
    return { success: false, reason: "inconsistent-resolution" };

  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { success: false, reason: "stale-epoch-ignored" };
    }

    const safeMessage = mapSafeClientError(err);
    session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, {
      errorMessage: safeMessage,
      correlationId: err?.details?.correlationId || err?.correlationId || null
    });
    session.invalidate("resolution-failed", {
      state: SESSION_STATES.DENIED_OR_INCONSISTENT,
      errorMessage: safeMessage,
      correlationId: err?.details?.correlationId || err?.correlationId || null
    });
    return { success: false, error: safeMessage, rawCode: err?.code };
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
    const response = await callableAdapter("onboardTeacherClassroom", payload);

    if (!session.validateCapturedIdentity(captured)) {
      return { success: false, reason: "stale-epoch-ignored" };
    }

    const res = response?.data || response;
    if (res?.state === "resolving" || res?.success) {
      return orchestrateTeacherResolution(session, callableAdapter);
    }

    const safeMsg = "Onboarding completed but resolution failed to verify.";
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
    return { success: false, error: safeMessage, rawCode: err?.code };
  }
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
