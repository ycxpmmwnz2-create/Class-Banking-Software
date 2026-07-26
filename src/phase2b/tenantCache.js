export const CACHE_SCHEMA_VERSION = "v1";
export const LEGACY_STORAGE_KEY = "mrMorganClassCashDataV5";

export function buildCacheKey(projectId, uid, classroomId) {
  if (!projectId || !uid || !classroomId) {
    throw new Error("Missing required parameters for V2 teacher cache key.");
  }
  return `morganBank:v2:${projectId}:teacher:${uid}:classroom:${classroomId}:data:v1`;
}

export function createEnvelope(projectId, uid, classroomId, data) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    projectId,
    ownerUid: uid,
    classroomId,
    updatedAt: Date.now(),
    data
  };
}

export function validateEnvelope(envelope, activeSession, expectedProjectId) {
  if (!envelope || typeof envelope !== "object") return false;
  if (envelope.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
  if (envelope.projectId !== expectedProjectId) return false;
  if (envelope.ownerUid !== activeSession.uid) return false;
  if (envelope.classroomId !== activeSession.classroomId) return false;
  if (typeof envelope.updatedAt !== "number" || isNaN(envelope.updatedAt)) return false;
  if (!envelope.data || typeof envelope.data !== "object") return false;
  if (activeSession.role !== "teacher") return false;
  return true;
}

export function writeTeacherCache(storage, activeSession, expectedProjectId, data, capturedEpoch) {
  if (!activeSession || activeSession.role !== "teacher") {
    return { success: false, reason: "student-session-no-persist" };
  }
  if (capturedEpoch !== activeSession.epoch) {
    return { success: false, reason: "stale-epoch" };
  }

  const key = buildCacheKey(expectedProjectId, activeSession.uid, activeSession.classroomId);
  const envelope = createEnvelope(expectedProjectId, activeSession.uid, activeSession.classroomId, data);
  try {
    storage.setItem(key, JSON.stringify(envelope));
    return { success: true, key };
  } catch (err) {
    return { success: false, reason: "storage-write-failed", error: err };
  }
}

export function readTeacherCache(storage, activeSession, expectedProjectId) {
  if (!activeSession || activeSession.role !== "teacher") {
    return null;
  }
  const key = buildCacheKey(expectedProjectId, activeSession.uid, activeSession.classroomId);
  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!validateEnvelope(parsed, activeSession, expectedProjectId)) {
      storage.removeItem(key);
      return null;
    }
    return {
      ...parsed,
      isOfflineView: true
    };
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function purgeTenantCache(storage, projectId, uid, classroomId) {
  if (storage && projectId && uid && classroomId) {
    try {
      const key = buildCacheKey(projectId, uid, classroomId);
      storage.removeItem(key);
    } catch {
      // ignore storage errors
    }
  }
  purgeLegacyCache(storage);
}

export function purgeLegacyCache(storage) {
  if (storage && typeof storage.removeItem === "function") {
    try {
      storage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }
}

export function classifyOfflineFailure(error) {
  if (!error) return false;
  const code = error.code || "";
  const msg = String(error.message || "").toLowerCase();

  if (code === "permission-denied" || code === "failed-precondition" || code === "unauthenticated") {
    return false;
  }

  if (
    code === "unavailable" ||
    code === "deadline-exceeded" ||
    msg.includes("offline") ||
    msg.includes("network") ||
    msg.includes("failed to fetch")
  ) {
    return true;
  }

  return false;
}

export function computeSimpleUidDigest(uid) {
  if (!uid || typeof uid !== "string") return "";
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    const char = uid.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return "digest_" + Math.abs(hash).toString(16);
}

export function createBroadcastMessage(uid, epoch) {
  return {
    type: "session-invalidated",
    uidDigest: computeSimpleUidDigest(uid),
    epoch
  };
}

export function validateBroadcastMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type !== "session-invalidated") return false;
  if (typeof msg.epoch !== "number") return false;
  if (typeof msg.uidDigest !== "string" || !msg.uidDigest) return false;

  const forbiddenKeys = ["uid", "rawUid", "classroomId", "classroomCode", "classroomData", "studentData", "tokens", "email"];
  for (const key of forbiddenKeys) {
    if (key in msg) return false;
  }
  return true;
}
