import { createHash } from "node:crypto";

export const CACHE_SCHEMA_VERSION = "v1";
export const LEGACY_STORAGE_KEY = "mrMorganClassCashDataV5";

export function computeSha256Digest(str) {
  if (!str || typeof str !== "string") return "";

  if (typeof createHash === "function") {
    try {
      return "sha256_" + createHash("sha256").update(str, "utf8").digest("hex");
    } catch {
      // fallback below
    }
  }

  return "sha256_0000000000000000000000000000000000000000000000000000000000000000";
}

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
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;

  const allowedKeys = ["schemaVersion", "projectId", "ownerUid", "classroomId", "updatedAt", "data"];
  const keys = Object.keys(envelope);
  if (keys.length !== allowedKeys.length) return false;
  for (const k of keys) {
    if (!allowedKeys.includes(k)) return false;
  }

  if (envelope.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
  if (envelope.projectId !== expectedProjectId) return false;
  if (!activeSession || envelope.ownerUid !== activeSession.uid) return false;
  if (envelope.classroomId !== activeSession.classroomId) return false;
  if (
    typeof envelope.updatedAt !== "number" ||
    !Number.isFinite(envelope.updatedAt) ||
    envelope.updatedAt <= 0 ||
    !Number.isInteger(envelope.updatedAt)
  ) {
    return false;
  }
  if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) return false;
  if (activeSession.role !== "teacher") return false;

  return true;
}

export function writeTeacherCache(storage, activeSession, expectedProjectId, data, capturedIdentity) {
  if (!activeSession || activeSession.role !== "teacher") {
    return { success: false, reason: "student-session-no-persist" };
  }

  const currentState = typeof activeSession.getState === "function" ? activeSession.getState() : activeSession.state;
  if (currentState !== "ready") {
    return { success: false, reason: "session-not-ready" };
  }

  if (typeof activeSession.validateCapturedIdentity === "function") {
    if (!activeSession.validateCapturedIdentity(capturedIdentity)) {
      return { success: false, reason: "stale-epoch" };
    }
  } else if (capturedIdentity !== activeSession.epoch) {
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
  if (!activeSession || activeSession.role !== "teacher") return null;

  const allowedStates = ["active", "classroom-loading", "ready"];
  const currentState = typeof activeSession.getState === "function" ? activeSession.getState() : activeSession.state;
  if (!allowedStates.includes(currentState)) {
    return null;
  }

  if (!storage || typeof storage.getItem !== "function") return null;

  const key = buildCacheKey(expectedProjectId, activeSession.uid, activeSession.classroomId);
  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!validateEnvelope(parsed, activeSession, expectedProjectId)) {
      if (typeof storage.removeItem === "function") storage.removeItem(key);
      return null;
    }
    return {
      ...parsed,
      isOfflineView: true
    };
  } catch {
    if (typeof storage.removeItem === "function") storage.removeItem(key);
    return null;
  }
}

export function purgeTenantCache(storage, projectId, uid, classroomId) {
  if (storage && projectId && uid && classroomId) {
    try {
      const key = buildCacheKey(projectId, uid, classroomId);
      if (typeof storage.removeItem === "function") storage.removeItem(key);
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
  const rawCode = String(error.code || "").replace(/^functions\//, "");
  const msg = String(error.message || "").toLowerCase();

  if (
    rawCode === "permission-denied" ||
    rawCode === "failed-precondition" ||
    rawCode === "unauthenticated" ||
    rawCode === "invalid-argument" ||
    rawCode === "already-exists"
  ) {
    return false;
  }

  if (
    rawCode === "unavailable" ||
    rawCode === "deadline-exceeded" ||
    msg.includes("offline") ||
    msg.includes("network") ||
    msg.includes("failed to fetch")
  ) {
    return true;
  }

  return false;
}

export function createBroadcastMessage(uid, epoch, tabId = null) {
  const msg = {
    type: "session-invalidated",
    uidDigest: computeSha256Digest(uid),
    epoch
  };
  if (tabId) msg.tabId = tabId;
  return msg;
}

export function validateBroadcastMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;

  const allowedKeys = ["type", "uidDigest", "epoch", "tabId"];
  const keys = Object.keys(msg);
  for (const k of keys) {
    if (!allowedKeys.includes(k)) return false;
  }

  if (msg.type !== "session-invalidated") return false;
  if (typeof msg.epoch !== "number" || !Number.isInteger(msg.epoch) || msg.epoch < 0) return false;
  if (typeof msg.uidDigest !== "string" || !/^sha256_[0-9a-f]{64}$/.test(msg.uidDigest)) return false;

  return true;
}

export class MultiTabInvalidator {
  constructor(session, options = {}) {
    this.session = session;
    this.channelAdapter = options.channelAdapter || null;
    this.storageAdapter = options.storageAdapter || null;
    this.tabId = options.tabId || "tab_" + Math.random().toString(36).slice(2, 10);
    this.onInvalidated = options.onInvalidated || null;
    this.isSubscribed = false;

    this.onMessageListener = (event) => this.handleChannelMessage(event);
    this.onStorageListener = (event) => this.handleStorageEvent(event);
  }

  start() {
    if (this.isSubscribed) return;
    if (this.channelAdapter) {
      if (typeof this.channelAdapter.addEventListener === "function") {
        this.channelAdapter.addEventListener("message", this.onMessageListener);
      } else if ("onmessage" in this.channelAdapter) {
        this.channelAdapter.onmessage = this.onMessageListener;
      }
    }
    if (this.storageAdapter && typeof this.storageAdapter.addEventListener === "function") {
      this.storageAdapter.addEventListener("storage", this.onStorageListener);
    }
    this.isSubscribed = true;
  }

  destroy() {
    if (!this.isSubscribed) return;
    if (this.channelAdapter) {
      if (typeof this.channelAdapter.removeEventListener === "function") {
        this.channelAdapter.removeEventListener("message", this.onMessageListener);
      } else if (this.channelAdapter.onmessage === this.onMessageListener) {
        this.channelAdapter.onmessage = null;
      }
      if (typeof this.channelAdapter.close === "function") {
        try {
          this.channelAdapter.close();
        } catch {
          // ignore
        }
      }
    }
    if (this.storageAdapter && typeof this.storageAdapter.removeEventListener === "function") {
      this.storageAdapter.removeEventListener("storage", this.onStorageListener);
    }
    this.isSubscribed = false;
  }

  broadcastInvalidation(uid, epoch) {
    const msg = createBroadcastMessage(uid, epoch, this.tabId);
    if (this.channelAdapter && typeof this.channelAdapter.postMessage === "function") {
      try {
        this.channelAdapter.postMessage(msg);
      } catch (err) {
        console.error("BroadcastChannel postMessage failed:", err);
      }
    }
    if (this.storageAdapter && typeof this.storageAdapter.setItem === "function") {
      try {
        this.storageAdapter.setItem("morganBank:v2:invalidation", JSON.stringify(msg));
      } catch (err) {
        console.error("Storage event fallback failed:", err);
      }
    }
  }

  handleChannelMessage(event) {
    const payload = event?.data || event;
    if (payload?.tabId && payload.tabId === this.tabId) {
      return; // prevent self-echo
    }
    this.receiveMessage(payload);
  }

  handleStorageEvent(event) {
    if (event?.key !== "morganBank:v2:invalidation") return;
    if (!event.newValue) return;

    let payload;
    try {
      payload = JSON.parse(event.newValue);
    } catch {
      this.receiveMessage(null);
      return;
    }

    if (payload?.tabId && payload.tabId === this.tabId) {
      return; // prevent self-echo
    }
    this.receiveMessage(payload);
  }

  receiveMessage(rawMsg) {
    let msg = rawMsg;
    if (typeof rawMsg === "string") {
      try {
        msg = JSON.parse(rawMsg);
      } catch {
        this.session.invalidate("malformed-broadcast-message");
        if (typeof this.onInvalidated === "function") this.onInvalidated();
        return false;
      }
    }

    if (!validateBroadcastMessage(msg)) {
      this.session.invalidate("malformed-broadcast-message");
      if (typeof this.onInvalidated === "function") this.onInvalidated();
      return false;
    }

    this.session.invalidate("multi-tab-invalidation", { state: "signed-out" });
    if (typeof this.onInvalidated === "function") this.onInvalidated();
    return true;
  }
}
