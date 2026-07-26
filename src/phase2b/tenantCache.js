export const CACHE_SCHEMA_VERSION = "v1";
export const LEGACY_STORAGE_KEY = "mrMorganClassCashDataV5";

function sha256Bytes(bytes) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  let H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];

  const l = bytes.length;
  const bitLen = l * 8;

  const k = (55 - (l % 64) + 64) % 64;
  const paddedLen = l + 1 + k + 8;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes, 0);
  padded[l] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3));
      const s1 = (rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10));
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += (H[i] >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

export function computeSha256Digest(str) {
  if (!str || typeof str !== "string") return "";
  try {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const hex = sha256Bytes(bytes);
    return "sha256_" + hex;
  } catch {
    return "";
  }
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

export function createBroadcastMessage(uid, epoch) {
  const digest = computeSha256Digest(uid);
  if (!digest || !/^sha256_[0-9a-f]{64}$/.test(digest)) return null;
  return {
    type: "session-invalidated",
    uidDigest: digest,
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
  if (typeof msg.uidDigest !== "string" || !/^sha256_[0-9a-f]{64}$/.test(msg.uidDigest)) return false;

  return true;
}

export class MultiTabInvalidator {
  constructor(session, options = {}) {
    this.session = session;
    // An adapter key that is PRESENT but null/undefined means "explicitly no
    // transport" and must not fall back to a real global. `??` alone would
    // still construct a live BroadcastChannel for an explicit null, which both
    // defeats injected-adapter isolation and leaves an open handle behind.
    const hasOption = (key) => Object.prototype.hasOwnProperty.call(options, key);
    this.channelAdapter = hasOption("channelAdapter")
      ? (options.channelAdapter || null)
      : (typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("morgan_bank_v2_invalidation") : null);
    this.storageAdapter = hasOption("storageAdapter")
      ? (options.storageAdapter || null)
      : (typeof localStorage !== "undefined" ? localStorage : null);
    this.windowAdapter = hasOption("windowAdapter")
      ? (options.windowAdapter || null)
      : (typeof window !== "undefined" ? window : null);
    this.onInvalidated = options.onInvalidated || null;
    // Terminating the receiving tab's own Firebase Auth session is what stops a
    // refresh from re-resolving the invalidated teacher. It is deliberately a
    // separate injected adapter rather than session.signOut(), because
    // session.signOut() invalidates with reason "sign-out", which rebroadcasts.
    this.localAuthAdapter = options.localAuthAdapter || null;
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
    if (this.windowAdapter && typeof this.windowAdapter.addEventListener === "function") {
      this.windowAdapter.addEventListener("storage", this.onStorageListener);
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
    if (this.windowAdapter && typeof this.windowAdapter.removeEventListener === "function") {
      this.windowAdapter.removeEventListener("storage", this.onStorageListener);
    }
    this.isSubscribed = false;
  }

  broadcastInvalidation(uid, epoch) {
    const msg = createBroadcastMessage(uid, epoch);
    if (!msg) return;

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
    this.receiveMessage(payload);
  }

  // Terminates this tab's own Firebase Auth session after the tenant state has
  // already been purged synchronously. Never invalidates again and never
  // broadcasts, so one inbound message cannot become an outbound one. A
  // rejected sign-out is contained: the purge above has already happened and
  // must stay purged.
  terminateLocalAuth() {
    const adapter = this.localAuthAdapter;
    if (!adapter || typeof adapter.signOut !== "function") return;
    try {
      const result = adapter.signOut();
      if (result && typeof result.catch === "function") {
        result.catch((err) => {
          console.error("Local Firebase sign-out after cross-tab invalidation rejected:", err);
        });
      }
    } catch (err) {
      console.error("Local Firebase sign-out after cross-tab invalidation threw:", err);
    }
  }

  // Fail closed: an unparseable or invalid payload purges this tenant AND ends
  // the local Auth session, so a malformed message can never leave a
  // refresh-reanimatable account behind.
  invalidateAsMalformed() {
    this.session.invalidate("malformed-broadcast-message");
    this.terminateLocalAuth();
    if (typeof this.onInvalidated === "function") this.onInvalidated();
    return false;
  }

  receiveMessage(rawMsg) {
    let msg = rawMsg;
    if (typeof rawMsg === "string") {
      try {
        msg = JSON.parse(rawMsg);
      } catch {
        return this.invalidateAsMalformed();
      }
    }

    if (!validateBroadcastMessage(msg)) {
      return this.invalidateAsMalformed();
    }

    // A valid message applies ONLY to the tenant it names. Without this check a
    // delayed invalidation for teacher A would reset a freshly established
    // teacher B session, and the BroadcastChannel delivery plus its identical
    // storage-event fallback would each reset the tenant a second time. Matching
    // on the digest makes the duplicate inert: the first delivery clears
    // session.uid, so the second no longer matches any current identity.
    const currentUid = this.session?.uid;
    if (!currentUid) return false;

    const currentDigest = computeSha256Digest(currentUid);
    if (!currentDigest || currentDigest !== msg.uidDigest) return false;

    // Purge/reset happens synchronously BEFORE local Auth sign-out begins.
    this.session.invalidate("multi-tab-invalidation", { state: "signed-out" });
    this.terminateLocalAuth();
    if (typeof this.onInvalidated === "function") this.onInvalidated();
    return true;
  }
}
