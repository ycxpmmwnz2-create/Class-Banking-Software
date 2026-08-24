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
  CACHE_SCHEMA_VERSION,
  PENDING_INVALIDATION_KEY,
  MAX_PENDING_DIGESTS,
  readPendingInvalidation,
  isUidQuarantined,
  classifyOfflineFailure
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

  test("classifyOfflineFailure recognizes only transport-shaped Firestore Lite unknown failures", () => {
    assert.equal(
      classifyOfflineFailure({
        code: "unknown",
        message: "Request failed with error: undefined"
      }),
      true
    );
    assert.equal(
      classifyOfflineFailure({ code: "unknown", message: "Unexpected application failure" }),
      false
    );
    assert.equal(
      classifyOfflineFailure({
        code: "permission-denied",
        message: "Request failed with error: denied"
      }),
      false
    );
  });

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

  test("initial null -> teacher authentication does not invalidate an established same-account tab", () => {
    const published = [];
    const session = new TenantSession({
      storageAdapter: createMockStorage(),
      cacheModule: { purgeTenantCache, purgeLegacyCache, buildCacheKey },
      projectId: PROJECT_ID,
      multiTabInvalidator: {
        broadcastInvalidation(uid, epoch) { published.push({ uid, epoch }); }
      }
    });

    // Mirrors index.html's staged initial observer flow: first the UID before
    // token lookup, then the resolved teacher role. Neither state has an
    // outgoing classroom tenant to invalidate.
    session.invalidate("auth-observer-change", {
      uid: "teacher_a",
      state: SESSION_STATES.AUTHENTICATING
    });
    session.invalidate("auth-observer-change", {
      uid: "teacher_a",
      role: "teacher",
      state: SESSION_STATES.AUTHENTICATING
    });

    assert.deepEqual(
      published,
      [],
      "Opening a second same-account tab must not evict the already-established tab"
    );
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

  // NOTE ON TITLES: these unit tests assert adapter INVOCATION and quarantine
  // bookkeeping. They cannot prove that Firebase browser persistence was
  // actually cleared or that a real refresh fails to reanimate the account —
  // that proof belongs to Item 10's browser suite.
  test("a matching cross-tab invalidation purges tenant state AND invokes the local Firebase Auth sign-out adapter", () => {
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

  test("a stale tenant session cannot sign out a different live Firebase identity", () => {
    const storage = createMockStorage();
    const quarantine = createMockStorage();
    const staleSessionA = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    let signOutCalls = 0;

    const invalidator = new MultiTabInvalidator(staleSessionA, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: {
        // Auth has already advanced to B, but the asynchronous observer has not
        // yet replaced the TenantSession fields that still describe A.
        currentUid: () => "teacher_b",
        signOut: () => { signOutCalls += 1; return Promise.resolve(); }
      }
    });

    const applied = invalidator.receiveMessage({
      type: "session-invalidated",
      uidDigest: computeSha256Digest("teacher_a"),
      epoch: 5
    });

    assert.equal(applied, true, "the stale A tenant state must still be purged");
    assert.equal(staleSessionA.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(staleSessionA.uid, null);
    assert.equal(signOutCalls, 0, "the live B Firebase identity must not be signed out by A's message");
  });

  // ---------------------------------------------------------------------------
  // Item 9 correction, round 2: a valid invalidation must not be LOST when it
  // arrives before onAuthStateChanged has established session.uid, and must not
  // be lost when the local Auth sign-out rejects. Both are closed by a per-tab
  // quarantine marker the Auth observer consumes before resolving any data.
  // ---------------------------------------------------------------------------

  test("a valid invalidation arriving BEFORE the Auth observer establishes identity is quarantined, not discarded", () => {
    const storage = createMockStorage();
    const quarantine = createMockStorage();

    // Session exists but has no identity yet: the invalidator starts before the
    // first onAuthStateChanged callback, while Auth persistence still holds A.
    const session = new TenantSession({
      storageAdapter: storage,
      cacheModule: { purgeTenantCache, purgeLegacyCache, buildCacheKey },
      projectId: PROJECT_ID
    });
    assert.equal(session.uid, null, "Precondition: no identity established yet");

    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: { signOut: () => Promise.resolve() }
    });

    const applied = invalidator.receiveMessage({
      type: "session-invalidated",
      uidDigest: computeSha256Digest("teacher_a"),
      epoch: 5
    });

    assert.equal(applied, false, "Nothing to purge yet, so the message is not applied inline");
    const entry = readPendingInvalidation(quarantine);
    assert.deepEqual(
      entry,
      { scope: "digest", uidDigests: [computeSha256Digest("teacher_a")] },
      "The invalidation MUST be retained as a digest-scoped quarantine"
    );
  });

  test("the Auth observer gate applies a quarantined invalidation to the matching UID instead of resolving it", () => {
    const storage = createMockStorage();
    const quarantine = createMockStorage();
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    const cacheKey = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    writeTeacherCache(storage, session, PROJECT_ID, { dataA: 1 }, session.captureIdentity());

    let signOutCalls = 0;
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: { signOut: () => { signOutCalls++; return Promise.resolve(); } }
    });

    quarantine.setItem(
      PENDING_INVALIDATION_KEY,
      JSON.stringify({ scope: "digest", uidDigests: [computeSha256Digest("teacher_a")] })
    );

    // Simulates onAuthStateChanged firing with the quarantined teacher A.
    const blocked = invalidator.consumeQuarantineForObservedUid("teacher_a");

    assert.equal(blocked, true, "The observer MUST be told to stop before resolving classroom data");
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT, "Quarantined identity must be purged");
    assert.equal(storage.getItem(cacheKey), null, "Quarantined tenant's cache must be purged");
    assert.equal(signOutCalls, 1, "Local Auth sign-out must be retried at observation time");
    assert.notEqual(
      readPendingInvalidation(quarantine),
      null,
      "Marker must persist while Auth is still signed in, so a refresh stays protected"
    );
  });

  test("a quarantine for teacher A does NOT block teacher B, and is cleared once B is observed", () => {
    const storage = createMockStorage();
    const quarantine = createMockStorage();
    const sessionB = readyTeacherSession("teacher_b", "room_b", { storageAdapter: storage });
    const keyB = buildCacheKey(PROJECT_ID, "teacher_b", "room_b");
    writeTeacherCache(storage, sessionB, PROJECT_ID, { dataB: 2 }, sessionB.captureIdentity());

    let signOutCalls = 0;
    const invalidator = new MultiTabInvalidator(sessionB, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: { signOut: () => { signOutCalls++; return Promise.resolve(); } }
    });

    quarantine.setItem(
      PENDING_INVALIDATION_KEY,
      JSON.stringify({ scope: "digest", uidDigests: [computeSha256Digest("teacher_a")] })
    );

    const blocked = invalidator.consumeQuarantineForObservedUid("teacher_b");

    assert.equal(blocked, false, "A's quarantine must not block B");
    assert.equal(sessionB.getState(), SESSION_STATES.READY, "B must remain ready");
    assert.notEqual(storage.getItem(keyB), null, "B's cache must survive A's quarantine");
    assert.equal(signOutCalls, 0, "B must not be signed out by A's quarantine");
    assert.notEqual(
      readPendingInvalidation(quarantine),
      null,
      "A's digest is still owed to A and must NOT be discarded just because B was observed"
    );
  });

  // -------------------------------------------------------------------------
  // Delta: concurrent pre-Auth invalidations must not overwrite one another.
  // A single replaceable slot lost A's invalidation as soon as a legitimate
  // second tab broadcast for B, reopening the startup window.
  // -------------------------------------------------------------------------

  function preAuthInvalidator(quarantine, onSignOut) {
    const session = new TenantSession({
      storageAdapter: createMockStorage(),
      cacheModule: { purgeTenantCache, purgeLegacyCache, buildCacheKey },
      projectId: PROJECT_ID
    });
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: createMockStorage(),
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: { signOut: () => { if (onSignOut) onSignOut(); return Promise.resolve(); } }
    });
    return { session, invalidator };
  }

  function preAuthMessage(uid, epoch) {
    return { type: "session-invalidated", uidDigest: computeSha256Digest(uid), epoch };
  }

  for (const [first, second] of [["teacher_a", "teacher_b"], ["teacher_b", "teacher_a"]]) {
    test(`pre-Auth invalidations arriving ${first} then ${second} both remain pending, in either order`, () => {
      const quarantine = createMockStorage();
      const { invalidator } = preAuthInvalidator(quarantine);

      invalidator.receiveMessage(preAuthMessage(first, 1));
      invalidator.receiveMessage(preAuthMessage(second, 2));

      const entry = readPendingInvalidation(quarantine);
      assert.equal(entry.scope, "digest");
      assert.equal(entry.uidDigests.length, 2, "Both digests must be retained");
      assert.ok(isUidQuarantined(entry, first), `${first} must still be quarantined`);
      assert.ok(isUidQuarantined(entry, second), `${second} must still be quarantined`);
    });
  }

  test("whichever of two pending pre-Auth identities Auth actually observes is blocked", () => {
    for (const observed of ["teacher_a", "teacher_b"]) {
      const quarantine = createMockStorage();
      let signOuts = 0;
      const { session, invalidator } = preAuthInvalidator(quarantine, () => { signOuts++; });

      invalidator.receiveMessage(preAuthMessage("teacher_a", 1));
      invalidator.receiveMessage(preAuthMessage("teacher_b", 2));
      const signOutsBefore = signOuts;

      // Auth resolves one of them; the pending set must still cover it.
      session.transitionTo(SESSION_STATES.AUTHENTICATING);
      const blocked = invalidator.consumeQuarantineForObservedUid(observed);

      assert.equal(blocked, true, `Observing ${observed} must be blocked, not resolved`);
      assert.equal(signOuts, signOutsBefore + 1, "Sign-out must be invoked for the observed identity");
    }
  });

  test("an unrelated identity C is not blocked, and the pending A/B digests survive it", () => {
    const quarantine = createMockStorage();
    let signOuts = 0;
    const { invalidator } = preAuthInvalidator(quarantine, () => { signOuts++; });

    invalidator.receiveMessage(preAuthMessage("teacher_a", 1));
    invalidator.receiveMessage(preAuthMessage("teacher_b", 2));
    const signOutsBefore = signOuts;

    const blocked = invalidator.consumeQuarantineForObservedUid("teacher_c");

    assert.equal(blocked, false, "C was never invalidated and must resolve normally");
    assert.equal(signOuts, signOutsBefore, "C must not be signed out");

    const entry = readPendingInvalidation(quarantine);
    assert.ok(isUidQuarantined(entry, "teacher_a"), "A's digest must survive an unrelated C observation");
    assert.ok(isUidQuarantined(entry, "teacher_b"), "B's digest must survive an unrelated C observation");
  });

  test("duplicate BroadcastChannel/storage delivery of the same pre-Auth message does not grow the pending set", () => {
    const quarantine = createMockStorage();
    const { invalidator } = preAuthInvalidator(quarantine);

    const msg = preAuthMessage("teacher_a", 1);
    invalidator.receiveMessage(msg);
    invalidator.receiveMessage({ ...msg });
    invalidator.receiveMessage(JSON.stringify(msg));

    const entry = readPendingInvalidation(quarantine);
    assert.deepEqual(
      entry,
      { scope: "digest", uidDigests: [computeSha256Digest("teacher_a")] },
      "Deduplicated: three deliveries of one invalidation are one pending digest"
    );
  });

  test("overflowing the bounded pending set degrades to a generic quarantine rather than dropping a digest", () => {
    const quarantine = createMockStorage();
    const { invalidator } = preAuthInvalidator(quarantine);

    for (let i = 0; i < MAX_PENDING_DIGESTS; i++) {
      invalidator.receiveMessage(preAuthMessage(`teacher_${i}`, i));
    }
    // At exactly the bound the set is still precise, so the assertions below
    // detect eviction rather than a set that was already generic.
    const atBound = readPendingInvalidation(quarantine);
    assert.equal(atBound.scope, "digest", "At the bound the set must still be digest-scoped");
    assert.equal(atBound.uidDigests.length, MAX_PENDING_DIGESTS);
    assert.ok(isUidQuarantined(atBound, "teacher_0"), "The earliest digest must still be present at the bound");

    // One more overflows it.
    invalidator.receiveMessage(preAuthMessage("teacher_overflow", 99));

    const entry = readPendingInvalidation(quarantine);
    assert.deepEqual(entry, { scope: "generic" }, "Overflow must fail closed, not silently evict");
    // The critical property: the OLDEST digest must not have been dropped to make
    // room. Silent eviction would leave teacher_0 unquarantined and resolvable.
    assert.ok(isUidQuarantined(entry, "teacher_0"), "Overflow must not drop the oldest pending digest");
    assert.ok(isUidQuarantined(entry, "teacher_overflow"), "The overflowing digest must also be covered");
    // Failing closed means every identity is blocked, including one never named.
    assert.equal(isUidQuarantined(entry, "teacher_never_seen"), true);
  });

  test("an oversized or non-digest pending set read from storage degrades to generic quarantine", () => {
    const quarantine = createMockStorage();

    quarantine.setItem(
      PENDING_INVALIDATION_KEY,
      JSON.stringify({ scope: "digest", uidDigests: new Array(MAX_PENDING_DIGESTS + 1).fill(computeSha256Digest("x")) })
    );
    assert.deepEqual(readPendingInvalidation(quarantine), { scope: "generic" }, "Oversized set must degrade closed");

    quarantine.setItem(PENDING_INVALIDATION_KEY, JSON.stringify({ scope: "digest", uidDigests: [] }));
    assert.deepEqual(readPendingInvalidation(quarantine), { scope: "generic" }, "Empty set is ambiguous, degrade closed");

    quarantine.setItem(
      PENDING_INVALIDATION_KEY,
      JSON.stringify({ scope: "digest", uidDigests: [computeSha256Digest("teacher_a"), "bogus"] })
    );
    assert.deepEqual(readPendingInvalidation(quarantine), { scope: "generic" }, "A malformed member degrades the whole set");
  });

  // Codex suggested also signing out eagerly on a pre-Auth valid message to
  // narrow the window. Rejected: with session.uid null this branch cannot
  // distinguish "about to resolve the named teacher" from "legitimately signed
  // out" or "about to resolve a DIFFERENT teacher", so an unconditional sign-out
  // terminates Auth for tabs the message never named. The durable set already
  // closes the window at the observer, where a real identity exists to match.
  test("a pre-Auth message quarantines WITHOUT signing out a tab whose identity is not yet known", () => {
    const quarantine = createMockStorage();
    let signOuts = 0;
    const { invalidator } = preAuthInvalidator(quarantine, () => { signOuts++; });

    invalidator.receiveMessage(preAuthMessage("teacher_a", 1));

    assert.equal(signOuts, 0, "A tab with no established identity must not have Auth terminated speculatively");
    assert.ok(
      isUidQuarantined(readPendingInvalidation(quarantine), "teacher_a"),
      "The durable quarantine is what closes the window, and must be recorded"
    );
  });

  test("a rejected local Auth sign-out leaves a durable quarantine that re-applies on the next observation", async () => {
    const storage = createMockStorage();
    const quarantine = createMockStorage();
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });

    let signOutCalls = 0;
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: {
        signOut: () => { signOutCalls++; return Promise.reject(new Error("network down")); }
      }
    });

    invalidator.receiveMessage({
      type: "session-invalidated",
      uidDigest: computeSha256Digest("teacher_a"),
      epoch: 3
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(signOutCalls, 1, "First sign-out attempt happened and rejected");
    assert.notEqual(
      readPendingInvalidation(quarantine),
      null,
      "A rejected sign-out MUST leave the quarantine in place"
    );

    // Refresh: Auth persistence still resolves teacher A.
    const blocked = invalidator.consumeQuarantineForObservedUid("teacher_a");
    assert.equal(blocked, true, "The still-signed-in quarantined teacher must be blocked again");
    assert.equal(signOutCalls, 2, "Sign-out must be retried, not abandoned after one rejection");
  });

  test("an explicit same-tab logout quarantines only its UID until Auth confirms sign-out", () => {
    const storage = createMockStorage();
    const quarantine = createMockStorage();
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    let signOutCalls = 0;
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: {
        signOut: () => { signOutCalls++; return Promise.resolve(); }
      }
    });

    assert.equal(invalidator.quarantineUid("teacher_a"), true);
    const pending = readPendingInvalidation(quarantine);
    assert.equal(isUidQuarantined(pending, "teacher_a"), true);
    assert.equal(isUidQuarantined(pending, "teacher_b"), false);

    assert.equal(invalidator.consumeQuarantineForObservedUid("teacher_a"), true);
    assert.equal(signOutCalls, 1);
    assert.notEqual(readPendingInvalidation(quarantine), null);

    assert.equal(invalidator.consumeQuarantineForObservedUid(null), false);
    assert.equal(readPendingInvalidation(quarantine), null);
  });

  test("an explicit logout reports when its durable quarantine could not be stored", () => {
    const storage = createMockStorage();
    const quarantine = {
      getItem: () => null,
      setItem: () => { throw new Error("session storage unavailable"); },
      removeItem: () => {}
    };
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: { signOut: () => Promise.reject(new Error("network down")) }
    });

    assert.equal(
      invalidator.quarantineUid("teacher_a"),
      false,
      "the caller must not be told a durable quarantine exists when storage rejected it"
    );
    assert.equal(readPendingInvalidation(quarantine), null);
  });

  test("the quarantine is cleared only once the Auth observer confirms a signed-out state", () => {
    const storage = createMockStorage();
    const quarantine = createMockStorage();
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });

    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: { signOut: () => Promise.resolve() }
    });

    quarantine.setItem(PENDING_INVALIDATION_KEY, JSON.stringify({ scope: "generic" }));

    const blocked = invalidator.consumeQuarantineForObservedUid(null);
    assert.equal(blocked, false, "A confirmed signed-out observation is not blocked");
    assert.equal(readPendingInvalidation(quarantine), null, "Quarantine must be cleared once Auth is signed out");
  });

  test("a malformed message records a fail-closed generic quarantine that blocks the next observed identity", () => {
    const storage = createMockStorage();
    const quarantine = createMockStorage();
    const session = readyTeacherSession("teacher_a", "room_a", { storageAdapter: storage });

    let signOutCalls = 0;
    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter: null,
      storageAdapter: storage,
      windowAdapter: null,
      sessionStorageAdapter: quarantine,
      localAuthAdapter: { signOut: () => { signOutCalls++; return Promise.resolve(); } }
    });

    invalidator.receiveMessage({ type: "session-invalidated", uidDigest: "not-a-digest", epoch: 1 });

    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT, "Malformed message still fails closed");
    assert.equal(signOutCalls, 1, "Malformed message still terminates local Auth");
    assert.deepEqual(
      readPendingInvalidation(quarantine),
      { scope: "generic" },
      "A payload naming no tenant must quarantine generically"
    );

    // Documented consequence of failing closed: a generic marker blocks whatever
    // identity appears next, including a different teacher.
    assert.equal(isUidQuarantined({ scope: "generic" }, "teacher_b"), true);
  });

  test("an unreadable quarantine marker is treated as a generic quarantine, never as 'no quarantine'", () => {
    const quarantine = createMockStorage();
    quarantine.setItem(PENDING_INVALIDATION_KEY, "{not json");
    assert.deepEqual(readPendingInvalidation(quarantine), { scope: "generic" });

    quarantine.setItem(PENDING_INVALIDATION_KEY, JSON.stringify({ scope: "digest", uidDigest: "bogus" }));
    assert.deepEqual(
      readPendingInvalidation(quarantine),
      { scope: "generic" },
      "A digest marker failing shape validation must degrade closed"
    );
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
