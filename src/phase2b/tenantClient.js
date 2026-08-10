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

export function mapSafeInvitationAdminError(error) {
  const rawCode = normalizeFirebaseErrorCode(error);
  if (rawCode === "unauthenticated") return "Sign in required.";
  if (rawCode === "permission-denied") return "Platform administrator access is required.";
  if (rawCode === "invalid-argument") return "Enter a valid teacher email and invitation expiration.";
  if (rawCode === "failed-precondition") return "This invitation cannot be changed automatically.";
  if (rawCode === "aborted") return "The invitation could not be changed. Please try again.";
  return "An unexpected internal error occurred.";
}

export function mapSafeStudentTransactionError(error) {
  const rawCode = normalizeFirebaseErrorCode(error);
  if (rawCode === "unauthenticated") return "Sign in required.";
  if (rawCode === "permission-denied") return "This account cannot submit student transactions.";
  if (rawCode === "invalid-argument") return "The transaction request was invalid.";
  if (rawCode === "not-found") return "Your student account is not available.";
  if (rawCode === "failed-precondition") {
    return "This transaction cannot be completed right now. Refresh and try again.";
  }
  if (rawCode === "already-exists") {
    return "This request conflicts with an existing transaction. Refresh before trying again.";
  }
  if (rawCode === "resource-exhausted") {
    return "The transaction could not be completed. Please try again later.";
  }
  if (rawCode === "aborted") return "The transaction could not be completed. Please try again.";
  return "An unexpected internal error occurred.";
}

export async function orchestrateProductionLogout(session, authAdapter, onRender) {
  if (!session) throw new Error("Tenant session is required for logout.");
  if (typeof onRender === "function") {
    session.onStateChange = onRender;
  }
  return session.signOut(authAdapter);
}

/**
 * Removes a locally persisted Firebase Auth identity before completing sign-out.
 *
 * Either a successful persistence downgrade or a successful Firebase sign-out
 * is enough to prevent the identity from being restored after the browser is
 * reopened. Both operations are still attempted, and sign-out is retried once
 * when the first attempt fails. A rejection is returned only when Firebase
 * could not confirm the current in-memory session ended; callers must surface
 * that warning instead of reporting an unconditional logout.
 */
export async function terminateDurableAuthSession(authAdapter) {
  if (!authAdapter || typeof authAdapter.setMemoryPersistence !== "function") {
    throw new Error("A memory-persistence adapter is required.");
  }
  if (typeof authAdapter.signOut !== "function") {
    throw new Error("A Firebase sign-out adapter is required.");
  }

  let durablePersistenceRemoved = false;
  try {
    await authAdapter.setMemoryPersistence();
    durablePersistenceRemoved = true;
  } catch {
    // Sign-out is still attempted below. A successful sign-out clears the
    // durable Firebase identity even when changing persistence was unavailable.
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await authAdapter.signOut();
      return { success: true, durablePersistenceRemoved };
    } catch {
      // Retry once. Raw Firebase errors are deliberately not returned to the UI.
    }
  }

  throw new Error(
    durablePersistenceRemoved
      ? "Firebase sign-out did not finish after durable persistence was removed."
      : "Firebase durable authentication could not be cleared."
  );
}

function exactObject(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isWellFormedUnicode(value) {
  if (typeof String.prototype.isWellFormed === "function") {
    return value.isWellFormed();
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xDC00 || nextCodeUnit > 0xDFFF) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function isCanonicalClassroomId(value) {
  return typeof value === "string" && value.length > 0 &&
    value === value.trim() && value !== "." && value !== ".." &&
    !value.includes("/") && !/^__[\s\S]*__$/.test(value) &&
    isWellFormedUnicode(value) && new TextEncoder().encode(value).length <= 1500;
}

/**
 * Runs the unauthenticated V2 student-login handoff without admitting a stale
 * custom token. Authorization still comes only from the token's server-minted
 * claims and the subsequent student data loader; this function validates only
 * the callable response envelope and the session epoch before Auth consumes it.
 */
export async function orchestrateStudentLogin(
  session,
  callableAdapter,
  signInAdapter,
  { classroomCode, loginId, pin }
) {
  if (!session || typeof session.captureIdentity !== "function") {
    throw new Error("Tenant session is required.");
  }
  if (typeof callableAdapter !== "function" || typeof signInAdapter !== "function") {
    throw new Error("Callable and custom-token sign-in adapters are required.");
  }

  const payload = { classroomCode, loginId, pin };
  if (!exactObject(payload, ["classroomCode", "loginId", "pin"]) ||
      !Object.values(payload).every(value => typeof value === "string" && value.length > 0)) {
    return { executed: false, reason: "invalid-login-request" };
  }

  const captured = session.captureIdentity();
  try {
    const response = await callableAdapter("studentPinLoginV2", payload);
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }

    const result = response?.data;
    if (!exactObject(result, ["token"]) ||
        typeof result.token !== "string" || !result.token.trim()) {
      return { executed: false, reason: "malformed-login-response" };
    }

    // Last possible synchronous epoch check before Firebase Auth consumes the
    // token. The auth observer owns every effect after authentication begins.
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    const credential = await signInAdapter(result.token);
    return { executed: true, credential };
  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    return {
      executed: false,
      reason: "student-login-failed",
      error: mapSafeClientError(err),
      rawCode: normalizeFirebaseErrorCode(err)
    };
  }
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

    if (res?.state === "active") {
      const classroomId = res.classroom?.id;
      if (!isCanonicalClassroomId(classroomId)) {
        const safeMessage = "Server classroom identity missing or invalid.";
        session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMessage });
        session.invalidate("resolution-invalid-classroom-id", {
          state: SESSION_STATES.DENIED_OR_INCONSISTENT,
          errorMessage: safeMessage
        });
        return { success: false, reason: "invalid-server-classroom-id" };
      }

      const teacherUid = typeof res.teacher?.uid === "string" ? res.teacher.uid.trim() : "";
      if (!teacherUid || (session.uid && teacherUid !== session.uid)) {
        const safeMessage = "Server teacher identity missing or mismatched.";
        session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMessage });
        session.invalidate("resolution-mismatched-server-uid", {
          state: SESSION_STATES.DENIED_OR_INCONSISTENT,
          errorMessage: safeMessage
        });
        return { success: false, reason: "mismatched-server-uid" };
      }

      // If resolved classroom identity changes for the same UID/role, invalidate first
      if (session.classroomId && session.classroomId !== classroomId) {
        session.invalidate("resolved-classroom-changed", {
          uid: teacherUid,
          role: "teacher",
          state: SESSION_STATES.RESOLVING
        });
      }

      session.transitionTo(SESSION_STATES.ACTIVE, {
        uid: teacherUid,
        role: "teacher",
        classroomId,
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
      const teacherUid = typeof res.teacher?.uid === "string" ? res.teacher.uid.trim() : "";
      if (!teacherUid || (session.uid && teacherUid !== session.uid)) {
        const safeMsg = "Onboarding server identity missing or mismatched.";
        session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMsg });
        session.invalidate("onboarding-mismatched-server-uid", {
          state: SESSION_STATES.DENIED_OR_INCONSISTENT,
          errorMessage: safeMsg
        });
        return { success: false, reason: "mismatched-server-uid" };
      }

      // Perform a fresh authoritative resolution after onboarding
      const resolutionRes = await orchestrateTeacherResolution(session, callableAdapter);
      if (resolutionRes.success && session.getState() === SESSION_STATES.ACTIVE) {
        return { success: true, state: "active", teacher: resolutionRes.teacher, classroom: resolutionRes.classroom, created: Boolean(res.created) };
      }
      return resolutionRes;
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

  if (!loadNetworkFn || typeof loadNetworkFn !== "function") {
    const safeMsg = "V2 tenant data adapter is required.";
    session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMsg });
    session.invalidate("missing-v2-data-adapter", {
      state: SESSION_STATES.DENIED_OR_INCONSISTENT,
      errorMessage: safeMsg
    });
    return { executed: false, reason: "missing-v2-data-adapter" };
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

export async function handleAuthTransition(session, user, tokenResult, { callAdapter, loadNetworkFn, loadStudentNetworkFn, storageAdapter, projectId }) {
  const uid = user?.uid || null;
  const claims = tokenResult?.claims;
  const claimedRole = claims?.role;
  const role = claimedRole === undefined ? (user ? "teacher" : null) : claimedRole;

  // Compare the complete resolved identity to prevent redundant invalidations.
  // A same-UID student token can legitimately carry a newly minted classroom or
  // student identity; ignoring that observer event would retain the old tenant.
  const claimsMatchResolvedIdentity = role === "student"
    ? claims?.classroomId === session.classroomId && claims?.studentId === session.studentId
    : role === "teacher"
      ? claims?.classroomId === undefined && claims?.studentId === undefined
      : false;
  if (session.uid === uid && session.role === role && claimsMatchResolvedIdentity &&
      session.state !== SESSION_STATES.SIGNED_OUT) {
    return { state: session.getState(), ignored: true };
  }

  // Synchronously invalidate before processing identity change
  session.invalidate("auth-observer-change", { uid, role, state: user ? SESSION_STATES.AUTHENTICATING : SESSION_STATES.SIGNED_OUT });

  if (!user) {
    return { state: SESSION_STATES.SIGNED_OUT };
  }

  const roleIsValid = role === "teacher" || role === "student";
  const teacherClaimsAreConsistent = role !== "teacher" ||
    (claims?.classroomId === undefined && claims?.studentId === undefined);
  if (!roleIsValid || !teacherClaimsAreConsistent) {
    const safeMsg = "The authenticated role or identity claims are invalid.";
    session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMsg });
    session.invalidate("auth-claims-invalid", {
      state: SESSION_STATES.DENIED_OR_INCONSISTENT,
      errorMessage: safeMsg
    });
    return { success: false, reason: "auth-claims-invalid", error: safeMsg };
  }

  if (role === "student") {
    const rawClassroomId = claims?.classroomId;
    const rawStudentId = claims?.studentId;
    const classroomId = typeof rawClassroomId === "string" ? rawClassroomId : "";
    const studentId = typeof rawStudentId === "string" ? rawStudentId : "";
    const canonicalClassroomId = classroomId.length > 0 && classroomId === classroomId.trim() &&
      classroomId !== "." && classroomId !== ".." && !classroomId.includes("/");
    const canonicalStudentId = /^[1-9][0-9]*$/.test(studentId) &&
      Number.isSafeInteger(Number(studentId));

    if (!canonicalClassroomId || !canonicalStudentId || !uid) {
      const safeMsg = "Student identity or classroom claim is missing or invalid.";
      session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMsg });
      session.invalidate("student-claims-invalid", {
        state: SESSION_STATES.DENIED_OR_INCONSISTENT,
        errorMessage: safeMsg
      });
      return { success: false, reason: "student-claims-invalid", error: safeMsg };
    }

    if (typeof loadStudentNetworkFn !== "function") {
      const safeMsg = "V2 student access is unavailable or unsupported.";
      session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMsg });
      session.invalidate("v2-student-unsupported", {
        state: SESSION_STATES.DENIED_OR_INCONSISTENT,
        errorMessage: safeMsg
      });
      return { success: false, reason: "student-access-unavailable" };
    }

    session.transitionTo(SESSION_STATES.RESOLVING);
    const captured = session.captureIdentity();

    try {
      const studentData = await loadStudentNetworkFn({ uid, classroomId, studentId, claims: tokenResult?.claims });
      if (!session.validateCapturedIdentity(captured)) {
        return { executed: false, reason: "stale-epoch-ignored" };
      }
      session.transitionTo(SESSION_STATES.ACTIVE, { uid, role: "student", classroomId, studentId });
      session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
      session.transitionTo(SESSION_STATES.READY);
      return { executed: true, data: studentData, role: "student", classroomId, studentId };
    } catch (err) {
      if (!session.validateCapturedIdentity(captured)) {
        return { executed: false, reason: "stale-epoch-ignored" };
      }
      const safeMsg = mapSafeClientError(err);
      session.transitionTo(SESSION_STATES.DENIED_OR_INCONSISTENT, { errorMessage: safeMsg });
      session.invalidate("student-load-failed", {
        state: SESSION_STATES.DENIED_OR_INCONSISTENT,
        errorMessage: safeMsg
      });
      return { success: false, reason: "student-load-failed", error: safeMsg };
    }
  }

  const resolutionRes = await orchestrateTeacherResolution(session, callAdapter);

  if (resolutionRes.success && session.getState() === SESSION_STATES.ACTIVE) {
    return loadClassroomDataWithCacheFallback(session, { loadNetworkFn, storageAdapter, projectId });
  }

  return resolutionRes;
}

export async function orchestrateClassroomDataLoad(session, loadFn, applyFn) {
  const captured = session.captureIdentity();
  let loadedData;
  try {
    loadedData = await loadFn();
  } catch (err) {
    // A rejected operation must never escape to the caller: the V2 call sites
    // set pending/loading flags and a progress message before awaiting, and an
    // escaping rejection would leave them set forever with no render. Report a
    // structured failure instead, still gated on the captured identity so a
    // stale rejection cannot repaint the current tenant's UI.
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    return { executed: false, reason: "load-failed", error: mapSafeClientError(err) };
  }
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  if (typeof applyFn === "function") {
    applyFn(loadedData);
  }
  return { executed: true, data: loadedData };
}

export async function orchestrateClassroomDataSave(session, saveAdapter, data, options = {}) {
  if (!saveAdapter || typeof saveAdapter !== "function") {
    return { executed: false, reason: "missing-v2-save-adapter" };
  }

  const storageAdapter = options?.storageAdapter || (options?.setItem ? options : null);
  const projectId = options?.projectId || "morgan-bank";

  const captured = session.captureIdentity();

  let result;
  try {
    result = await saveAdapter(data, captured);
  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored-post-save" };
    }
    // A failed server save must never seed the tenant cache: the cache is only
    // ever allowed to mirror data the server accepted.
    if (err?.reason === "concurrent-classroom-change") {
      return {
        executed: false,
        reason: "concurrent-classroom-change",
        error: "Your classroom changed while you were working. Reload and try again."
      };
    }
    return { executed: false, reason: "save-failed", error: mapSafeClientError(err) };
  }

  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored-post-save" };
  }

  if (storageAdapter) {
    writeTeacherCache(storageAdapter, session, projectId, data, captured);
  }

  return { executed: true, result };
}

export async function orchestrateAuthLogsFetch(session, fetchFn, applyFn) {
  const captured = session.captureIdentity();
  let logs;
  try {
    logs = await fetchFn();
  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    return { executed: false, reason: "auth-logs-fetch-failed", error: mapSafeClientError(err) };
  }
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  if (typeof applyFn === "function") {
    applyFn(logs);
  }
  return { executed: true, logs };
}

/**
 * Validates a teacher PIN-directory response before any of it reaches the UI.
 *
 * Every entry must be an exact { studentId, pin } pair with a canonical student
 * ID and exactly four ASCII digits. A malformed entry drops the WHOLE response
 * rather than being filtered out: a partially trusted PIN list could show one
 * child's PIN against another child's name, which is worse than showing none.
 */
export function validateStudentPinDirectoryResponse(response) {
  const result = response?.data || response;
  if (!exactObject(result, ["pins"])) return null;
  if (!Array.isArray(result.pins)) return null;

  const seen = new Set();
  const pins = [];
  for (const entry of result.pins) {
    if (!exactObject(entry, ["studentId", "pin"])) return null;
    if (typeof entry.studentId !== "string" || !/^[1-9][0-9]{0,17}$/.test(entry.studentId)) {
      return null;
    }
    if (typeof entry.pin !== "string" || !/^[0-9]{4}$/.test(entry.pin)) return null;
    if (seen.has(entry.studentId)) return null;
    seen.add(entry.studentId);
    pins.push({ studentId: entry.studentId, pin: entry.pin });
  }
  return pins;
}

function isTeacherPinDirectoryIdentity(identity) {
  return exactObject(identity, ["uid", "role", "classroomId", "studentId", "epoch"]) &&
    typeof identity.uid === "string" && identity.uid.length > 0 &&
    identity.role === "teacher" &&
    isCanonicalClassroomId(identity.classroomId) &&
    identity.studentId === null &&
    Number.isSafeInteger(identity.epoch) && identity.epoch >= 0;
}

function sameTeacherPinDirectoryIdentity(left, right) {
  return isTeacherPinDirectoryIdentity(left) &&
    isTeacherPinDirectoryIdentity(right) &&
    left.uid === right.uid &&
    left.role === right.role &&
    left.classroomId === right.classroomId &&
    left.studentId === right.studentId &&
    left.epoch === right.epoch;
}

/**
 * Reconciles a directory response with successful resets that completed after
 * that request began.
 *
 * The callable response is authoritative for everything visible when the
 * request started. A later successful reset is newer than that snapshot, so its
 * submitted PIN remains an in-memory override until a subsequent request begins
 * after the reset and can authoritatively confirm it. Tenant identity is part of
 * the reconciliation input because student IDs restart in every classroom.
 */
export function reconcileStudentPinDirectory({
  directoryPins,
  pendingResets,
  requestResetVersion,
  requestIdentity,
  currentIdentity
}) {
  if (!sameTeacherPinDirectoryIdentity(requestIdentity, currentIdentity)) return null;
  if (!Number.isSafeInteger(requestResetVersion) || requestResetVersion < 0) return null;
  if (!(pendingResets instanceof Map)) return null;

  const validatedPins = validateStudentPinDirectoryResponse({ pins: directoryPins });
  if (validatedPins === null) return null;

  const pins = new Map(validatedPins.map(entry => [entry.studentId, entry.pin]));
  const remainingResets = new Map();

  for (const [studentId, reset] of pendingResets) {
    if (typeof studentId !== "string" || !/^[1-9][0-9]{0,17}$/.test(studentId)) return null;
    if (!exactObject(reset, ["pin", "version", "identity"]) ||
        typeof reset.pin !== "string" || !/^[0-9]{4}$/.test(reset.pin) ||
        !Number.isSafeInteger(reset.version) || reset.version < 1 ||
        !isTeacherPinDirectoryIdentity(reset.identity)) {
      return null;
    }

    // A reset retained from another identity can never override this tenant's
    // response, even when both classrooms use the same student ID.
    if (!sameTeacherPinDirectoryIdentity(reset.identity, currentIdentity)) continue;
    if (reset.version <= requestResetVersion) continue;

    pins.set(studentId, reset.pin);
    remainingResets.set(studentId, {
      pin: reset.pin,
      version: reset.version,
      identity: { ...reset.identity }
    });
  }

  return { pins, pendingResets: remainingResets };
}

export async function orchestrateStudentPinDirectoryFetch(session, fetchFn) {
  const captured = session.captureIdentity();
  let response;
  try {
    response = await fetchFn();
  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    return {
      executed: false,
      reason: "student-pin-directory-fetch-failed",
      error: mapSafeClientError(err)
    };
  }
  // The epoch is rechecked BEFORE the response is validated or returned, so a
  // PIN list that arrives after a tenant switch can never be rendered against
  // the incoming teacher's roster.
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  const pins = validateStudentPinDirectoryResponse(response);
  if (pins === null) {
    return { executed: false, reason: "student-pin-directory-malformed" };
  }
  return { executed: true, pins };
}

export async function orchestrateStudentPinReset(session, resetFn, payload) {
  const captured = session.captureIdentity();
  let result;
  try {
    result = await resetFn(payload);
  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored-post-reset" };
    }
    return { executed: false, reason: "pin-reset-failed", error: mapSafeClientError(err) };
  }
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored-post-reset" };
  }
  return { executed: true, result };
}

function validateStudentTransactionResponse(response, captured, payload) {
  const result = response?.data || response;
  if (!exactObject(result, ["transaction", "balance"])) return null;
  const transaction = result.transaction;
  if (!exactObject(transaction, [
    "id", "date", "studentId", "studentName", "type", "amount",
    "reason", "memo", "category", "status", "source"
  ])) return null;
  const expectedStudentId = Number(captured?.studentId);
  const validStatus = payload?.type === "Add"
    ? ["Pending", "Approved", "Denied"].includes(transaction.status)
    : transaction.status === "Approved";
  if (
    !Number.isSafeInteger(payload?.transactionId) || payload.transactionId < 1 ||
    (payload.type !== "Add" && payload.type !== "Subtract") ||
    !Number.isSafeInteger(payload.amount) || payload.amount < 1 ||
    typeof payload.reason !== "string" || !payload.reason ||
    transaction.id !== payload.transactionId ||
    transaction.studentId !== expectedStudentId ||
    typeof transaction.studentName !== "string" || !transaction.studentName ||
    transaction.type !== payload.type ||
    transaction.amount !== payload.amount ||
    transaction.reason !== payload.reason ||
    transaction.memo !== "" || transaction.category !== "" ||
    transaction.source !== "Student" || !validStatus ||
    typeof transaction.date !== "string" ||
    Number.isNaN(new Date(transaction.date).getTime()) ||
    typeof result.balance !== "number" || !Number.isFinite(result.balance)
  ) return null;
  return result;
}

export async function orchestrateStudentTransaction(session, callableAdapter, payload) {
  if (!session) throw new Error("Tenant session is required.");
  if (typeof callableAdapter !== "function") {
    throw new Error("Callable adapter function is required.");
  }
  const captured = session.captureIdentity();
  const readyStudent = session.getState() === SESSION_STATES.READY &&
    captured.role === "student" &&
    typeof captured.uid === "string" && Boolean(captured.uid) &&
    typeof captured.classroomId === "string" && Boolean(captured.classroomId) &&
    typeof captured.studentId === "string" && /^[1-9][0-9]*$/.test(captured.studentId) &&
    Number.isSafeInteger(Number(captured.studentId));
  if (!readyStudent) {
    return {
      executed: false,
      reason: "student-transaction-not-ready",
      error: "Student sign-in is required."
    };
  }

  try {
    const response = await callableAdapter("submitStudentTransactionV2", payload);
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    const result = validateStudentTransactionResponse(response, captured, payload);
    if (!result) {
      return {
        executed: false,
        reason: "malformed-student-transaction-response",
        error: "An unexpected internal error occurred."
      };
    }
    return { executed: true, result };
  } catch (error) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    const rawCode = normalizeFirebaseErrorCode(error);
    return {
      executed: false,
      reason: "student-transaction-failed",
      error: mapSafeStudentTransactionError(error),
      rawCode
    };
  }
}

function validateCreatedStudentResponse(response) {
  const result = response?.data || response;
  if (!exactObject(result, ["student", "loginId"])) return null;
  if (!exactObject(result.student, ["id", "name", "balance", "frozen"])) return null;
  if (
    !Number.isSafeInteger(result.student.id) || result.student.id < 1 ||
    typeof result.student.name !== "string" || !result.student.name.trim() ||
    typeof result.student.balance !== "number" || !Number.isFinite(result.student.balance) ||
    typeof result.student.frozen !== "boolean" ||
    typeof result.loginId !== "string" ||
    !/^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$|^[a-z0-9]$/.test(result.loginId)
  ) {
    return null;
  }
  return result;
}

async function orchestrateLifecycleCall(session, callableAdapter, functionName, payload, validate) {
  if (!session) throw new Error("Tenant session is required.");
  if (typeof callableAdapter !== "function") {
    throw new Error("Callable adapter function is required.");
  }
  const captured = session.captureIdentity();
  try {
    const response = await callableAdapter(functionName, payload);
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    const result = validate(response);
    if (!result) {
      return {
        executed: false,
        reason: "malformed-lifecycle-response",
        error: "An unexpected internal error occurred."
      };
    }
    return { executed: true, result };
  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    return { executed: false, reason: "lifecycle-call-failed", error: mapSafeClientError(err) };
  }
}

export async function orchestrateCreateStudent(session, callableAdapter, payload) {
  return orchestrateLifecycleCall(
    session,
    callableAdapter,
    "createStudentV2",
    payload,
    validateCreatedStudentResponse
  );
}

export async function orchestrateRemoveStudent(session, callableAdapter, payload) {
  return orchestrateLifecycleCall(
    session,
    callableAdapter,
    "removeStudentV2",
    payload,
    response => {
      const result = response?.data || response;
      return exactObject(result, ["success"]) && result.success === true ? result : null;
    }
  );
}

export async function orchestrateBulkOperation(session, bulkFn, payload) {
  const captured = session.captureIdentity();
  let result;
  try {
    result = await bulkFn(payload, captured);
  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored-post-bulk" };
    }
    return { executed: false, reason: "bulk-operation-failed", error: mapSafeClientError(err) };
  }
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored-post-bulk" };
  }
  return { executed: true, result };
}

export async function safeExecuteWithEpochCheck(session, asyncFn, applyFn) {
  const captured = session.captureIdentity();
  let result;
  try {
    result = await asyncFn();
  } catch (err) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    return { executed: false, reason: "operation-failed", error: mapSafeClientError(err) };
  }
  if (!session.validateCapturedIdentity(captured)) {
    return { executed: false, reason: "stale-epoch-ignored" };
  }
  if (typeof applyFn === "function") {
    applyFn(result);
  }
  return { executed: true, result };
}

export async function orchestrateTeacherInvitationAdmin(
  session,
  callableAdapter,
  action,
  payload
) {
  if (!session || typeof session.captureIdentity !== "function") {
    throw new Error("Tenant session is required.");
  }
  if (typeof callableAdapter !== "function") {
    throw new Error("Callable adapter function is required.");
  }
  if (action !== "create" && action !== "revoke") {
    throw new Error("Invitation action must be create or revoke.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invitation payload is required.");
  }

  const expectedKeys = action === "create"
    ? ["email", "expiresInHours"]
    : ["email"];
  if (!exactObject(payload, expectedKeys)) {
    throw new Error("Invitation payload shape is invalid.");
  }
  if (typeof payload.email !== "string" || !payload.email.trim()) {
    throw new Error("Invitation email is required.");
  }
  if (
    action === "create" &&
    (!Number.isInteger(payload.expiresInHours) ||
      payload.expiresInHours < 1 ||
      payload.expiresInHours > 168)
  ) {
    throw new Error("Invitation expiration is invalid.");
  }

  const captured = session.captureIdentity();
  const functionName = action === "create"
    ? "createTeacherInvitationV2"
    : "revokeTeacherInvitationV2";

  try {
    const response = await callableAdapter(functionName, payload);
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }

    const result = response?.data || response;
    const validCreate = action === "create" &&
      exactObject(result, ["success", "status", "created"]) &&
      result.success === true &&
      result.status === "active" &&
      typeof result.created === "boolean";
    const validRevoke = action === "revoke" &&
      exactObject(result, ["success", "status", "revoked"]) &&
      result.success === true &&
      ["revoked", "not-found"].includes(result.status) &&
      typeof result.revoked === "boolean" &&
      (result.status !== "not-found" || result.revoked === false);

    if (!validCreate && !validRevoke) {
      return {
        executed: false,
        reason: "invalid-server-response",
        error: "The invitation service returned an invalid response.",
      };
    }

    return { executed: true, result };
  } catch (error) {
    if (!session.validateCapturedIdentity(captured)) {
      return { executed: false, reason: "stale-epoch-ignored" };
    }
    return {
      executed: false,
      reason: "invitation-call-failed",
      error: mapSafeInvitationAdminError(error),
    };
  }
}
