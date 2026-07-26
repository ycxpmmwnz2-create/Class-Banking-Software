import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildCacheKey,
  createEnvelope,
  validateEnvelope,
  writeTeacherCache,
  readTeacherCache,
  purgeTenantCache,
  purgeLegacyCache,
  computeSha256Digest,
  createBroadcastMessage,
  validateBroadcastMessage,
  MultiTabInvalidator,
  LEGACY_STORAGE_KEY,
  CACHE_SCHEMA_VERSION
} from "./tenantCache.js";
import { TenantSession, SESSION_STATES } from "./tenantSession.js";

function createMockStorage() {
  const store = new Map();
  const listeners = new Set();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, val) => {
      const oldVal = store.get(key) || null;
      store.set(key, String(val));
      for (const listener of listeners) {
        listener({ key, newValue: String(val), oldValue: oldVal });
      }
    },
    removeItem: (key) => {
      const oldVal = store.get(key) || null;
      store.delete(key);
      for (const listener of listeners) {
        listener({ key, newValue: null, oldValue: oldVal });
      }
    },
    addEventListener: (type, listener) => {
      if (type === "storage") listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === "storage") listeners.delete(listener);
    },
    clear: () => store.clear(),
    store,
    listeners
  };
}

function createMockChannel() {
  const listeners = new Set();
  let closed = false;
  return {
    postMessage: (msg) => {
      if (closed) return;
      for (const listener of listeners) {
        listener({ data: msg });
      }
    },
    addEventListener: (type, listener) => {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === "message") listeners.delete(listener);
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    isClosed: () => closed,
    listeners
  };
}

describe("TenantCache Module Specifications", () => {
  const PROJECT_ID = "demo-morgan-bank";
  const TEACHER_SESSION = {
    uid: "teacher_uid_1",
    role: "teacher",
    classroomId: "room_1",
    epoch: 5,
    state: "ready",
    getState() { return "ready"; },
    validateCapturedIdentity(cap) {
      return cap && cap.epoch === 5 && cap.uid === "teacher_uid_1" && cap.role === "teacher" && cap.classroomId === "room_1";
    }
  };

  test("computeSha256Digest matches standard SHA-256 known-answer test vectors", () => {
    const digestAbc = computeSha256Digest("abc");
    assert.equal(
      digestAbc,
      "sha256_ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "Detects incorrect SHA-256 digest computation for 'abc'"
    );

    const digestEmpty = computeSha256Digest("");
    assert.equal(digestEmpty, "");
  });

  // The browser digest is a hand-rolled SHA-256 (no node:crypto in production
  // code), so its message-schedule, padding, and UTF-8 encoding paths need
  // real known-answer vectors. 'abc' alone exercises only the single-block,
  // single-byte-per-character path; these vectors additionally cover the
  // length-field/two-block padding boundary, exact block multiples, genuine
  // multi-block input, and non-ASCII UTF-8 (multi-byte) input.
  test("computeSha256Digest matches known-answer vectors across padding boundaries, multi-block input, and non-ASCII UTF-8 input", () => {
    const VECTORS = [
      // 56 bytes: forces the second padding block (l % 64 >= 56). NIST vector.
      [
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "sha256_248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
      ],
      // Exactly one block: k must wrap to a full extra block of padding.
      [
        "a".repeat(64),
        "sha256_ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
      ],
      // Genuine multi-block input (two compression rounds).
      [
        "a".repeat(119),
        "sha256_31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb"
      ],
      // Non-ASCII UTF-8: 2-, 3-, and 4-byte code points, including an
      // astral-plane emoji (surrogate pair). 24 chars but 36 UTF-8 bytes, so a
      // length-in-characters bug would produce a different digest here.
      [
        "Mr. Morgan’s Café — 教室 🎓",
        "sha256_9e70fcd0accbcd73162ca6f4a1f5e4e321e417d1de6db053fe0ed4c5dadf4c64"
      ],
      // Latin-1 supplement characters, the realistic shape of a non-ASCII UID.
      [
        "üñïçødé-teacher-uid",
        "sha256_7ef87a089248f4233bfa8ae256c76246c163d2e1e201a94ab4b7d3f385e5193b"
      ]
    ];

    for (const [input, expected] of VECTORS) {
      const actual = computeSha256Digest(input);
      assert.equal(
        actual,
        expected,
        `SHA-256 known-answer mismatch for ${JSON.stringify(input.slice(0, 24))} (${input.length} chars)`
      );
      // Strict wire format: lowercase "sha256_" prefix plus exactly 64
      // lowercase hexadecimal characters, and nothing else.
      assert.match(actual, /^sha256_[0-9a-f]{64}$/);
      assert.equal(actual.length, "sha256_".length + 64);
      assert.equal(actual, actual.toLowerCase(), "Digest must be lowercase hex");
    }
  });

  test("digest failure prevents BOTH the BroadcastChannel and the storage-event transport from publishing", () => {
    // A UID that cannot be digested (null/empty) must abort publication
    // entirely rather than broadcast an undigested or placeholder identity.
    assert.equal(createBroadcastMessage("", 4), null);
    assert.equal(createBroadcastMessage(null, 4), null);

    const channel = createMockChannel();
    let posted = 0;
    channel.postMessage = () => { posted++; };

    const storage = createMockStorage();
    const session = new TenantSession();
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: channel,
      storageAdapter: storage,
      windowAdapter: null
    });

    invalidator.broadcastInvalidation("", 4);
    invalidator.broadcastInvalidation(null, 4);

    assert.equal(posted, 0, "BroadcastChannel MUST NOT publish when the UID digest cannot be computed");
    assert.equal(storage.store.size, 0, "Storage-event fallback MUST NOT publish when the UID digest cannot be computed");
    assert.equal(storage.getItem("morganBank:v2:invalidation"), null);

    // A valid UID still publishes on both transports, proving the assertions
    // above detect suppression rather than a permanently broken invalidator.
    invalidator.broadcastInvalidation("teacher_valid", 4);
    assert.equal(posted, 1);
    assert.equal(storage.store.size, 1);
  });

  test("receiving an invalidation does NOT rebroadcast, so two tabs cannot loop", () => {
    const channel = createMockChannel();
    let posted = 0;
    channel.postMessage = () => { posted++; };
    const storage = createMockStorage();

    const receiverSession = new TenantSession();
    receiverSession.transitionTo(SESSION_STATES.AUTHENTICATING);
    receiverSession.transitionTo(SESSION_STATES.RESOLVING);
    receiverSession.transitionTo(SESSION_STATES.ACTIVE, { uid: "u_recv", role: "teacher", classroomId: "c_recv" });

    const receiverInvalidator = new MultiTabInvalidator(receiverSession, {
      channelAdapter: channel,
      storageAdapter: storage,
      windowAdapter: null
    });
    receiverSession.multiTabInvalidator = receiverInvalidator;
    receiverInvalidator.start();

    const validMessage = {
      type: "session-invalidated",
      uidDigest: computeSha256Digest("u_other_tab").slice(0),
      epoch: 9
    };

    receiverInvalidator.receiveMessage(validMessage);

    assert.equal(receiverSession.getState(), SESSION_STATES.SIGNED_OUT, "Receiver must invalidate synchronously");
    assert.equal(posted, 0, "Receiving an invalidation MUST NOT re-post to the channel (self-loop)");
    assert.equal(storage.getItem("morganBank:v2:invalidation"), null, "Receiving an invalidation MUST NOT re-publish via storage");

    // A malformed message also invalidates (fail closed) and also must not echo.
    receiverInvalidator.receiveMessage({ type: "session-invalidated", uidDigest: "sha256_short", epoch: 1 });
    assert.equal(posted, 0, "Malformed-message invalidation MUST NOT rebroadcast");
    assert.equal(storage.getItem("morganBank:v2:invalidation"), null);

    receiverInvalidator.destroy();
  });

  test("sign-out, UID change, role change, and resolved-classroom change each publish exactly one multi-tab invalidation", () => {
    const published = [];
    const recordingInvalidator = {
      broadcastInvalidation(uid, epoch) { published.push({ uid, epoch }); }
    };

    function freshReadySession() {
      const session = new TenantSession({
        storageAdapter: createMockStorage(),
        cacheModule: { purgeTenantCache, purgeLegacyCache, buildCacheKey },
        projectId: PROJECT_ID,
        multiTabInvalidator: recordingInvalidator
      });
      session.transitionTo(SESSION_STATES.AUTHENTICATING);
      session.transitionTo(SESSION_STATES.RESOLVING);
      session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });
      session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
      session.transitionTo(SESSION_STATES.READY);
      return session;
    }

    // 1. Sign-out
    published.length = 0;
    freshReadySession().signOut();
    assert.equal(published.length, 1, "Sign-out MUST publish invalidation");
    assert.equal(published[0].uid, "teacher_a", "Broadcast must carry the outgoing UID");

    // 2. UID change (teacher A -> teacher B)
    published.length = 0;
    freshReadySession().invalidate("uid-change", { uid: "teacher_b", role: "teacher", state: SESSION_STATES.RESOLVING });
    assert.equal(published.length, 1, "UID change MUST publish invalidation");

    // 3. Role change (teacher -> student, same UID)
    published.length = 0;
    freshReadySession().invalidate("role-change", { uid: "teacher_a", role: "student", state: SESSION_STATES.AUTHENTICATING });
    assert.equal(published.length, 1, "Role change MUST publish invalidation");

    // 4. Resolved-classroom change (same UID and role, classroom A -> B)
    published.length = 0;
    freshReadySession().invalidate("resolved-classroom-changed", {
      uid: "teacher_a",
      role: "teacher",
      classroomId: "room_b",
      state: SESSION_STATES.RESOLVING
    });
    assert.equal(published.length, 1, "Resolved-classroom change MUST publish invalidation");

    // 5. A received multi-tab invalidation is the one reason that must NOT publish.
    published.length = 0;
    freshReadySession().invalidate("multi-tab-invalidation", { state: SESSION_STATES.SIGNED_OUT });
    assert.equal(published.length, 0, "Multi-tab-originated invalidation MUST NOT rebroadcast");
  });

  test("createBroadcastMessage produces exact payload with only type, uidDigest, and epoch", () => {
    const msg = createBroadcastMessage("user_abc", 3);
    assert.deepEqual(Object.keys(msg).sort(), ["epoch", "type", "uidDigest"]);
    assert.equal(msg.type, "session-invalidated");
    assert.equal(msg.epoch, 3);
    assert.equal("tabId" in msg, false);
  });

  test("validateBroadcastMessage enforces exact sha256_ prefix plus 64 lowercase hexadecimal chars and rejects tabId or extra keys", () => {
    const validMsg = {
      type: "session-invalidated",
      uidDigest: "sha256_ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      epoch: 5
    };
    assert.equal(validateBroadcastMessage(validMsg), true);

    const msgWithTabId = {
      ...validMsg,
      tabId: "tab_123"
    };
    assert.equal(validateBroadcastMessage(msgWithTabId), false, "Rejects extra tabId key in payload");

    const invalidDigestMsg = {
      type: "session-invalidated",
      uidDigest: "sha256_invalid123",
      epoch: 5
    };
    assert.equal(validateBroadcastMessage(invalidDigestMsg), false);
  });

  test("builds exact cache key format", () => {
    const key = buildCacheKey("demo-project", "teacher_a", "room_x");
    assert.equal(key, "morganBank:v2:demo-project:teacher:teacher_a:classroom:room_x:data:v1");
  });

  test("creates exact envelope format and validates envelope directly", () => {
    const data = { students: [], settings: {} };
    const envelope = createEnvelope(PROJECT_ID, "teacher_uid_1", "room_1", data);

    assert.equal(envelope.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.equal(envelope.projectId, PROJECT_ID);
    assert.equal(envelope.ownerUid, "teacher_uid_1");
    assert.equal(envelope.classroomId, "room_1");
    assert.equal(typeof envelope.updatedAt, "number");
    assert.deepEqual(envelope.data, data);

    assert.equal(validateEnvelope(envelope, TEACHER_SESSION, PROJECT_ID), true);
    assert.equal(validateEnvelope(envelope, { ...TEACHER_SESSION, role: "student" }, PROJECT_ID), false);
  });

  test("strictly validates envelope rejecting unknown fields, non-integer timestamps, and arrays", () => {
    const validEnvelope = createEnvelope(PROJECT_ID, "teacher_uid_1", "room_1", { ok: 1 });

    assert.equal(validateEnvelope({ ...validEnvelope, extraField: "forbidden" }, TEACHER_SESSION, PROJECT_ID), false);
    assert.equal(validateEnvelope([], TEACHER_SESSION, PROJECT_ID), false);
    assert.equal(validateEnvelope({ ...validEnvelope, updatedAt: 1234.567 }, TEACHER_SESSION, PROJECT_ID), false);
  });

  test("writeTeacherCache requires state to be EXACT ready and rejects active state", () => {
    const storage = createMockStorage();
    const data = { students: [{ id: "s1" }] };
    const captured = { uid: "teacher_uid_1", role: "teacher", classroomId: "room_1", epoch: 5 };

    const activeSession = {
      ...TEACHER_SESSION,
      state: "active",
      getState() { return "active"; }
    };

    const activeWriteRes = writeTeacherCache(storage, activeSession, PROJECT_ID, data, captured);
    assert.equal(activeWriteRes.success, false, "Detects failure to reject write in ACTIVE state prior to READY");
    assert.equal(activeWriteRes.reason, "session-not-ready");

    const readyWriteRes = writeTeacherCache(storage, TEACHER_SESSION, PROJECT_ID, data, captured);
    assert.equal(readyWriteRes.success, true);
  });

  test("cache may NOT be read prior to authoritative tenant resolution (e.g. in SIGNED_OUT or RESOLVING state)", () => {
    const storage = createMockStorage();
    const data = { students: [{ id: "s1" }] };
    const captured = { uid: "teacher_uid_1", role: "teacher", classroomId: "room_1", epoch: 5 };
    writeTeacherCache(storage, TEACHER_SESSION, PROJECT_ID, data, captured);

    const unresolvedSession = {
      ...TEACHER_SESSION,
      state: "resolving",
      getState() { return "resolving"; }
    };

    const readRes = readTeacherCache(storage, unresolvedSession, PROJECT_ID);
    assert.equal(readRes, null);
  });

  test("integration test: V2 cache and legacy cache are synchronously purged on A->B, B->A, role change, and sign-out", () => {
    const storage = createMockStorage();

    const cacheModule = { purgeTenantCache, purgeLegacyCache, buildCacheKey };
    const session = new TenantSession({
      storageAdapter: storage,
      cacheModule,
      projectId: PROJECT_ID
    });

    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);

    writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ legacy: true }));

    const keyA = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    assert.notEqual(storage.getItem(keyA), null);
    assert.notEqual(storage.getItem(LEGACY_STORAGE_KEY), null);

    session.invalidate("switch-A-to-B", { uid: "teacher_b", role: "teacher", state: SESSION_STATES.RESOLVING });
    assert.equal(storage.getItem(keyA), null, "Teacher A V2 cache must be purged on switch to B");
    assert.equal(storage.getItem(LEGACY_STORAGE_KEY), null, "Legacy cache must be purged on switch to B");

    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_b", role: "teacher", classroomId: "room_b" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);
    writeTeacherCache(storage, session, PROJECT_ID, { dataB: 2 }, session.captureIdentity());

    const keyB = buildCacheKey(PROJECT_ID, "teacher_b", "room_b");
    assert.notEqual(storage.getItem(keyB), null);

    session.invalidate("switch-B-to-A", { uid: "teacher_a", role: "teacher", state: SESSION_STATES.RESOLVING });
    assert.equal(storage.getItem(keyB), null, "Teacher B V2 cache must be purged on switch back to A");

    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);
    writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());

    session.invalidate("role-change-to-student", { uid: "student_1", role: "student", state: SESSION_STATES.AUTHENTICATING });
    assert.equal(storage.getItem(keyA), null, "V2 cache must be purged on role change to student");

    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_a", role: "teacher", classroomId: "room_a" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);
    writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());

    session.signOut();
    assert.equal(storage.getItem(keyA), null, "V2 cache must be purged on signOut");
  });

  test("distinct sender/receiver BroadcastChannel test for multi-tab invalidation", () => {
    const channelSender = createMockChannel();
    const channelReceiver = createMockChannel();
    channelSender.postMessage = (msg) => {
      for (const listener of channelReceiver.listeners) {
        listener({ data: msg });
      }
    };

    const receiverSession = new TenantSession();
    receiverSession.transitionTo(SESSION_STATES.AUTHENTICATING);
    receiverSession.transitionTo(SESSION_STATES.RESOLVING);
    receiverSession.transitionTo(SESSION_STATES.ACTIVE, { uid: "u1", role: "teacher", classroomId: "c1" });

    let receiverInvalidated = false;
    const receiverInvalidator = new MultiTabInvalidator(receiverSession, {
      channelAdapter: channelReceiver,
      onInvalidated: () => {
        receiverInvalidated = true;
      }
    });
    receiverInvalidator.start();

    const senderSession = new TenantSession();
    senderSession.transitionTo(SESSION_STATES.AUTHENTICATING);
    senderSession.transitionTo(SESSION_STATES.RESOLVING);
    senderSession.transitionTo(SESSION_STATES.ACTIVE, { uid: "u1", role: "teacher", classroomId: "c1" });

    const senderInvalidator = new MultiTabInvalidator(senderSession, {
      channelAdapter: channelSender
    });
    senderInvalidator.start();

    senderInvalidator.broadcastInvalidation("u1", 5);

    assert.equal(receiverSession.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(receiverInvalidated, true);

    receiverInvalidator.destroy();
    senderInvalidator.destroy();
  });

  test("distinct sender-storage / receiver-window-storage-event test for multi-tab invalidation fallback", () => {
    const storage = createMockStorage();
    const mockWindow = {
      listeners: new Set(),
      addEventListener(type, listener) {
        if (type === "storage") this.listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === "storage") this.listeners.delete(listener);
      }
    };

    const receiverSession = new TenantSession();
    receiverSession.transitionTo(SESSION_STATES.AUTHENTICATING);
    receiverSession.transitionTo(SESSION_STATES.RESOLVING);
    receiverSession.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_stor", role: "teacher", classroomId: "c_stor" });

    let receiverInvalidated = false;
    const receiverInvalidator = new MultiTabInvalidator(receiverSession, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: mockWindow,
      onInvalidated: () => { receiverInvalidated = true; }
    });
    receiverInvalidator.start();

    const senderSession = new TenantSession();
    senderSession.transitionTo(SESSION_STATES.AUTHENTICATING);
    senderSession.transitionTo(SESSION_STATES.RESOLVING);
    senderSession.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_stor", role: "teacher", classroomId: "c_stor" });

    const senderInvalidator = new MultiTabInvalidator(senderSession, {
      channelAdapter: null,
      storageAdapter: storage
    });
    senderInvalidator.start();

    // Attach storage event listener trigger to simulate multi-window storage event
    storage.addEventListener("storage", (evt) => {
      for (const listener of mockWindow.listeners) {
        listener(evt);
      }
    });

    senderInvalidator.broadcastInvalidation("teacher_stor", 2);

    assert.equal(receiverSession.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(receiverInvalidated, true);

    receiverInvalidator.destroy();
    senderInvalidator.destroy();
  });

  test("MultiTabInvalidator teardown assertions verify destroy unregisters listeners and closes channel", () => {
    const mockChannel = createMockChannel();
    const mockStorage = createMockStorage();
    const mockWindow = {
      listeners: new Set(),
      addEventListener(type, listener) {
        if (type === "storage") this.listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === "storage") this.listeners.delete(listener);
      }
    };

    const session = new TenantSession();
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: mockChannel,
      storageAdapter: mockStorage,
      windowAdapter: mockWindow
    });

    invalidator.start();
    assert.equal(invalidator.isSubscribed, true);
    assert.equal(mockChannel.listeners.size, 1);
    assert.equal(mockWindow.listeners.size, 1);

    invalidator.destroy();
    assert.equal(invalidator.isSubscribed, false);
    assert.equal(mockChannel.isClosed(), true);
    assert.equal(mockChannel.listeners.size, 0);
    assert.equal(mockWindow.listeners.size, 0);
  });
});
