export const CACHE_SCHEMA_VERSION = "v1";
export const LEGACY_STORAGE_KEY = "mrMorganClassCashDataV5";

export function computeSha256Digest(str) {
  if (!str || typeof str !== "string") return "";

  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const K = [];
  const H = [];

  const isPrime = (n) => {
    for (let factor = 2; factor <= Math.sqrt(n); factor++) {
      if (n % factor === 0) return false;
    }
    return true;
  };

  let candidate = 2;
  while (H.length < 8) {
    if (isPrime(candidate)) {
      H.push((mathPow(candidate, 1 / 2) * maxWord) | 0);
      K.push((mathPow(candidate, 1 / 3) * maxWord) | 0);
    }
    candidate++;
  }

  const words = [];
  const asciiBitLength = str.length * 8;
  for (let i = 0; i < str.length; i++) {
    words[i >> 2] |= (str.charCodeAt(i) & 0xff) << ((3 - (i % 4)) * 8);
  }
  words[asciiBitLength >> 5] |= 0x80 << (24 - (asciiBitLength % 32));
  words[(((asciiBitLength + 64) >> 9) << 4) + 15] = asciiBitLength;

  for (let i = 0; i < words.length; i += 16) {
    const w = words.slice(i, i + 16);
    const oldH = H.slice(0);
    for (let j = 0; j < 64; j++) {
      const w15 = w[j - 15];
      const w2 = w[j - 2];
      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      if (j >= 16) {
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }

      const temp1 =
        (H[7] +
          (rightRotate(H[4], 6) ^ rightRotate(H[4], 11) ^ rightRotate(H[4], 25)) +
          ((H[4] & H[5]) ^ (~H[4] & H[6])) +
          K[j] +
          (w[j] | 0)) |
        0;
      const temp2 =
        ((rightRotate(H[0], 2) ^ rightRotate(H[0], 13) ^ rightRotate(H[0], 22)) +
          ((H[0] & H[1]) ^ (H[0] & H[2]) ^ (H[1] & H[2]))) |
        0;

      H[7] = H[6];
      H[6] = H[5];
      H[5] = H[4];
      H[4] = (H[3] + temp1) | 0;
      H[3] = H[2];
      H[2] = H[1];
      H[1] = H[0];
      H[0] = (temp1 + temp2) | 0;
    }
    for (let j = 0; j < 8; j++) {
      H[j] = (H[j] + oldH[j]) | 0;
    }
  }

  let result = "";
  for (let i = 0; i < 8; i++) {
    for (let j = 3; j >= 0; j--) {
      const b = (H[i] >> (j * 8)) & 0xff;
      result += (b < 16 ? "0" : "") + b.toString(16);
    }
  }
  return "sha256_" + result;
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
  if (currentState !== "ready" && currentState !== "active") {
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

export function createBroadcastMessage(uid, epoch) {
  return {
    type: "session-invalidated",
    uidDigest: computeSha256Digest(uid),
    epoch
  };
}

export function validateBroadcastMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;

  const allowedKeys = ["type", "uidDigest", "epoch"];
  const keys = Object.keys(msg);
  if (keys.length !== allowedKeys.length) return false;
  for (const k of keys) {
    if (!allowedKeys.includes(k)) return false;
  }

  if (msg.type !== "session-invalidated") return false;
  if (typeof msg.epoch !== "number" || !Number.isInteger(msg.epoch) || msg.epoch < 0) return false;
  if (typeof msg.uidDigest !== "string" || !msg.uidDigest || !msg.uidDigest.startsWith("sha256_")) return false;

  return true;
}

export class MultiTabInvalidator {
  constructor(session, options = {}) {
    this.session = session;
    this.channelAdapter = options.channelAdapter || null;
    this.storageAdapter = options.storageAdapter || null;
    this.onInvalidated = options.onInvalidated || null;
  }

  broadcastInvalidation(uid, epoch) {
    const msg = createBroadcastMessage(uid, epoch);
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

  receiveMessage(rawMsg) {
    let msg = rawMsg;
    if (typeof rawMsg === "string") {
      try {
        msg = JSON.parse(rawMsg);
      } catch {
        // fail closed on malformed JSON
        this.session.invalidate("malformed-broadcast-message");
        if (typeof this.onInvalidated === "function") this.onInvalidated();
        return false;
      }
    }

    if (!validateBroadcastMessage(msg)) {
      // fail closed on malformed message
      this.session.invalidate("malformed-broadcast-message");
      if (typeof this.onInvalidated === "function") this.onInvalidated();
      return false;
    }

    // Valid invalidation received -> invalidate session
    this.session.invalidate("multi-tab-invalidation", { state: "signed-out" });
    if (typeof this.onInvalidated === "function") this.onInvalidated();
    return true;
  }
}
