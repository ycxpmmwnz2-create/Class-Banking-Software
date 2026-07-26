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

    // The digest must name the receiver's own current tenant, otherwise the
    // message is for a different tenant and is correctly ignored.
    const validMessage = {
      type: "session-invalidated",
      uidDigest: computeSha256Digest("u_recv"),
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

  // ---------------------------------------------------------------------------
  // Item 9 correction: cross-tab invalidation must terminate the receiving tab's
  // own Firebase Auth session, and must apply only to the tenant it names.
  //
  // Before this correction the receiver invalidated its tenant state but left
  // Firebase Auth signed in. Because the app uses browserSessionPersistence, a
  // refresh re-ran onAuthStateChanged with the SAME user and fully re-resolved
  // the supposedly invalidated teacher. These tests pin both halves of the fix.
  // ---------------------------------------------------------------------------

  function readyTeacherSession(uid, classroomId, options = {}) {
    const session = new TenantSession({
      storageAdapter: options.storageAdapter || createMockStorage(),
      cacheModule: { purgeTenantCache, purgeLegacyCache, buildCacheKey },
      projectId: options.projectId || PROJECT_ID
    });
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid, role: "teacher", classroomId });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);
    return session;
  }

  test("a matching cross-tab invalidation purges tenant state AND invokes local Firebase Auth sign-out so a refresh cannot reanimate the account", () => {
    const storage = createMockStorage();
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    const cacheKey = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ legacy: true }));
    assert.notEqual(storage.getItem(cacheKey), null, "Precondition: A cache exists");

    // Records ordering so we can prove the purge is synchronous and happens
    // BEFORE local sign-out is even started, not merely that both occurred.
    const order = [];
    let signOutCalls = 0;
    const session_invalidate = session.invalidate.bind(session);
    session.invalidate = (reason, identity) => {
      order.push(`invalidate:${reason}`);
      return session_invalidate(reason, identity);
    };

    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      localAuthAdapter: {
        signOut: () => {
          signOutCalls++;
          order.push("localAuthSignOut");
          return Promise.resolve();
        }
      }
    });

    const applied = invalidator.receiveMessage({
      type: "session-invalidated",
      uidDigest: computeSha256Digest("teacher_a"),
      epoch: 7
    });

    assert.equal(applied, true, "A matching valid message must be applied");
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(session.uid, null, "Receiving tenant identity must be cleared");
    assert.equal(storage.getItem(cacheKey), null, "Receiver's V2 tenant cache must be purged");
    assert.equal(storage.getItem(LEGACY_STORAGE_KEY), null, "Legacy cache must be purged");

    // THE refresh precondition: local Auth sign-out was actually invoked.
    assert.equal(signOutCalls, 1, "Local Firebase Auth sign-out MUST be invoked exactly once");
    assert.deepEqual(
      order,
      ["invalidate:multi-tab-invalidation", "localAuthSignOut"],
      "Purge/reset must complete synchronously BEFORE local Auth sign-out begins"
    );
  });

  test("a rejected local Auth sign-out is contained and purged state stays purged", async () => {
    const storage = createMockStorage();
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    const cacheKey = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());

    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      localAuthAdapter: { signOut: () => Promise.reject(new Error("network down")) }
    });

    // Must not throw synchronously and must not produce an unhandled rejection.
    assert.doesNotThrow(() => {
      invalidator.receiveMessage({
        type: "session-invalidated",
        uidDigest: computeSha256Digest("teacher_a"),
        epoch: 3
      });
    });

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT, "State stays signed out despite sign-out rejection");
    assert.equal(session.uid, null);
    assert.equal(storage.getItem(cacheKey), null, "Cache stays purged despite sign-out rejection");
  });

  test("a synchronously throwing local Auth sign-out is contained and purged state stays purged", () => {
    const storage = createMockStorage();
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    const cacheKey = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());

    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      localAuthAdapter: { signOut: () => { throw new Error("adapter exploded"); } }
    });

    assert.doesNotThrow(() => {
      invalidator.receiveMessage({
        type: "session-invalidated",
        uidDigest: computeSha256Digest("teacher_a"),
        epoch: 3
      });
    });

    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(storage.getItem(cacheKey), null);
  });

  test("a VALID invalidation naming a DIFFERENT tenant is completely inert on the current tenant", () => {
    const storage = createMockStorage();
    const sessionB = readyTeacherSession("teacher_b", "room_b", { storageAdapter: storage });
    const keyB = buildCacheKey(PROJECT_ID, "teacher_b", "room_b");
    writeTeacherCache(storage, sessionB, PROJECT_ID, { dataB: 2 }, sessionB.captureIdentity());

    let signOutCalls = 0;
    let onInvalidatedCalls = 0;
    const epochBefore = sessionB.getEpoch();

    const invalidator = new MultiTabInvalidator(sessionB, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      onInvalidated: () => { onInvalidatedCalls++; },
      localAuthAdapter: { signOut: () => { signOutCalls++; return Promise.resolve(); } }
    });

    // A well-formed, fully valid message — but for teacher A, not teacher B.
    const applied = invalidator.receiveMessage({
      type: "session-invalidated",
      uidDigest: computeSha256Digest("teacher_a"),
      epoch: 99
    });

    assert.equal(applied, false, "A valid message for another tenant must not be applied");
    assert.equal(sessionB.getState(), SESSION_STATES.READY, "Teacher B must remain ready");
    assert.equal(sessionB.uid, "teacher_b");
    assert.equal(sessionB.getEpoch(), epochBefore, "Teacher B's epoch must not change");
    assert.notEqual(storage.getItem(keyB), null, "Teacher B's cache must survive");
    assert.equal(signOutCalls, 0, "Another tenant's invalidation must NOT sign B out");
    assert.equal(onInvalidatedCalls, 0, "Another tenant's invalidation must not notify B");
  });

  test("a delayed invalidation for the OUTGOING tenant cannot purge or reset the newly established INCOMING tenant", () => {
    const storage = createMockStorage();

    // Tab establishes A, then switches to B (the switch itself invalidates A).
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    let signOutCalls = 0;
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      localAuthAdapter: { signOut: () => { signOutCalls++; return Promise.resolve(); } }
    });

    session.invalidate("switch-A-to-B", { uid: "teacher_b", role: "teacher", state: SESSION_STATES.RESOLVING });
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_b", role: "teacher", classroomId: "room_b" });
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);
    writeTeacherCache(storage, session, PROJECT_ID, { dataB: 2 }, session.captureIdentity());

    const keyB = buildCacheKey(PROJECT_ID, "teacher_b", "room_b");
    const epochAfterSwitch = session.getEpoch();
    assert.notEqual(storage.getItem(keyB), null, "Precondition: B cache established");

    // A's invalidation finally arrives, late. It must not touch B.
    const applied = invalidator.receiveMessage({
      type: "session-invalidated",
      uidDigest: computeSha256Digest("teacher_a"),
      epoch: 1
    });

    assert.equal(applied, false, "Late A invalidation must not apply to B");
    assert.equal(session.getState(), SESSION_STATES.READY, "B must remain ready");
    assert.equal(session.uid, "teacher_b");
    assert.equal(session.getEpoch(), epochAfterSwitch, "B's epoch must not move");
    assert.notEqual(storage.getItem(keyB), null, "B's cache must NOT be purged by a late A invalidation");
    assert.equal(signOutCalls, 0, "A late A invalidation must not sign B out");
  });

  test("a BroadcastChannel delivery followed by its identical storage-event duplicate causes exactly one effective reset, one sign-out, and no rebroadcast", () => {
    const storage = createMockStorage();
    const channel = createMockChannel();
    let posted = 0;
    channel.postMessage = () => { posted++; };

    const mockWindow = {
      listeners: new Set(),
      addEventListener(type, listener) { if (type === "storage") this.listeners.add(listener); },
      removeEventListener(type, listener) { if (type === "storage") this.listeners.delete(listener); }
    };

    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    const cacheKey = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());

    let signOutCalls = 0;
    let onInvalidatedCalls = 0;
    let invalidateCalls = 0;
    const rawInvalidate = session.invalidate.bind(session);
    session.invalidate = (reason, identity) => {
      invalidateCalls++;
      return rawInvalidate(reason, identity);
    };

    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: channel,
      storageAdapter: storage,
      windowAdapter: mockWindow,
      onInvalidated: () => { onInvalidatedCalls++; },
      localAuthAdapter: { signOut: () => { signOutCalls++; return Promise.resolve(); } }
    });
    invalidator.start();

    const message = {
      type: "session-invalidated",
      uidDigest: computeSha256Digest("teacher_a"),
      epoch: 4
    };
    const serialized = JSON.stringify(message);

    // Delivery 1: real BroadcastChannel message event.
    for (const listener of channel.listeners) listener({ data: message });
    // Delivery 2: the identical storage-event fallback for the SAME action.
    for (const listener of mockWindow.listeners) {
      listener({ key: "morganBank:v2:invalidation", newValue: serialized, oldValue: null });
    }

    assert.equal(invalidateCalls, 1, "Duplicate delivery must cause exactly ONE effective invalidation");
    assert.equal(signOutCalls, 1, "Duplicate delivery must cause exactly ONE local Auth sign-out");
    assert.equal(onInvalidatedCalls, 1, "Duplicate delivery must notify exactly once");
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(storage.getItem(cacheKey), null);
    assert.equal(posted, 0, "Receiving either delivery MUST NOT generate an outbound message");

    invalidator.destroy();
  });

  test("a malformed cross-tab message fails closed AND invokes local Auth sign-out so refresh cannot reanimate the account", () => {
    const cases = [
      ["unparseable string", "{not json"],
      ["null payload", null],
      ["short digest", { type: "session-invalidated", uidDigest: "sha256_short", epoch: 1 }],
      ["extra key", { type: "session-invalidated", uidDigest: computeSha256Digest("teacher_a"), epoch: 1, tabId: "t1" }],
      ["wrong type", { type: "something-else", uidDigest: computeSha256Digest("teacher_a"), epoch: 1 }],
      ["negative epoch", { type: "session-invalidated", uidDigest: computeSha256Digest("teacher_a"), epoch: -1 }]
    ];

    for (const [label, payload] of cases) {
      const storage = createMockStorage();
      const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
      const cacheKey = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
      writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());

      let signOutCalls = 0;
      let posted = 0;
      const channel = createMockChannel();
      channel.postMessage = () => { posted++; };

      const invalidator = new MultiTabInvalidator(session, {
        channelAdapter: channel,
        storageAdapter: storage,
        windowAdapter: null,
        localAuthAdapter: { signOut: () => { signOutCalls++; return Promise.resolve(); } }
      });

      const applied = invalidator.receiveMessage(payload);

      assert.equal(applied, false, `${label}: must not report success`);
      assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT, `${label}: must fail closed`);
      assert.equal(session.invalidationReason, "malformed-broadcast-message", `${label}: reason must be malformed`);
      assert.equal(storage.getItem(cacheKey), null, `${label}: cache must be purged`);
      assert.equal(signOutCalls, 1, `${label}: local Auth sign-out MUST be invoked`);
      assert.equal(posted, 0, `${label}: must not rebroadcast`);
    }
  });

  test("cross-tab invalidation with no local Auth adapter still purges and does not throw", () => {
    const storage = createMockStorage();
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    const cacheKey = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());

    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null
    });

    assert.doesNotThrow(() => {
      invalidator.receiveMessage({
        type: "session-invalidated",
        uidDigest: computeSha256Digest("teacher_a"),
        epoch: 2
      });
    });
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(storage.getItem(cacheKey), null);
  });

  test("an invalidation arriving at a signed-out tab with no current tenant is inert", () => {
    const storage = createMockStorage();
    const session = new TenantSession({ storageAdapter: storage, projectId: PROJECT_ID });
    let signOutCalls = 0;

    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      localAuthAdapter: { signOut: () => { signOutCalls++; return Promise.resolve(); } }
    });

    const applied = invalidator.receiveMessage({
      type: "session-invalidated",
      uidDigest: computeSha256Digest("teacher_a"),
      epoch: 5
    });

    assert.equal(applied, false, "No current tenant means nothing to invalidate");
    assert.equal(session.getEpoch(), 0, "An inert message must not bump the epoch");
    assert.equal(signOutCalls, 0);
  });

  // An explicitly-null adapter must stay null. Previously `options.x ?? global`
  // constructed a REAL BroadcastChannel even when the caller passed null, which
  // both broke injected-adapter isolation in tests and left an open handle that
  // prevented the test process from exiting.
  test("explicitly null channel/storage/window adapters are honoured and never fall back to real globals", () => {
    const session = new TenantSession();
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: null,
      windowAdapter: null
    });

    assert.equal(invalidator.channelAdapter, null, "Explicit null channelAdapter MUST NOT become a real BroadcastChannel");
    assert.equal(invalidator.storageAdapter, null, "Explicit null storageAdapter MUST NOT become real localStorage");
    assert.equal(invalidator.windowAdapter, null, "Explicit null windowAdapter MUST NOT become the real window");

    // With no transport at all, publishing must be a silent no-op rather than a throw.
    assert.doesNotThrow(() => invalidator.broadcastInvalidation("teacher_a", 1));
    assert.doesNotThrow(() => invalidator.start());
    assert.doesNotThrow(() => invalidator.destroy());
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
