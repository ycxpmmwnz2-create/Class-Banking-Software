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
  classifyOfflineFailure,
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
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    store
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

  test("builds exact cache key format", () => {
    const key = buildCacheKey("demo-project", "teacher_a", "room_x");
    assert.equal(
      key,
      "morganBank:v2:demo-project:teacher:teacher_a:classroom:room_x:data:v1",
      "Detects failure to construct exact required cache key format"
    );
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
    assert.equal(computeSha256Digest("test_uid_123").startsWith("sha256_"), true);
  });

  test("strictly validates envelope rejecting unknown fields, non-integer timestamps, and arrays", () => {
    const validEnvelope = createEnvelope(PROJECT_ID, "teacher_uid_1", "room_1", { ok: 1 });

    // Unknown extra field
    const unknownFieldEnvelope = { ...validEnvelope, extraField: "forbidden" };
    assert.equal(validateEnvelope(unknownFieldEnvelope, TEACHER_SESSION, PROJECT_ID), false);

    // Array envelope
    assert.equal(validateEnvelope([], TEACHER_SESSION, PROJECT_ID), false);

    // Negative/non-finite/fractional timestamp
    const fractionalTsEnvelope = { ...validEnvelope, updatedAt: 1234.567 };
    assert.equal(validateEnvelope(fractionalTsEnvelope, TEACHER_SESSION, PROJECT_ID), false);
  });

  test("valid same-tenant cache admission after authoritative resolution", () => {
    const storage = createMockStorage();
    const data = { students: [{ id: "s1" }] };
    const captured = { uid: "teacher_uid_1", role: "teacher", classroomId: "room_1", epoch: 5 };

    const writeRes = writeTeacherCache(storage, TEACHER_SESSION, PROJECT_ID, data, captured);
    assert.equal(writeRes.success, true);

    const readRes = readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID);
    assert.notEqual(readRes, null);
    assert.equal(readRes.isOfflineView, true);
    assert.deepEqual(readRes.data, data);
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
    assert.equal(
      readRes,
      null,
      "Detects failure to block cache read prior to authoritative tenant resolution"
    );
  });

  test("rejects and purges cross-project, cross-UID, and cross-classroom cache entries", () => {
    const storage = createMockStorage();
    const key = buildCacheKey(PROJECT_ID, TEACHER_SESSION.uid, TEACHER_SESSION.classroomId);

    // Cross-project
    const crossProjEnv = createEnvelope("other-project", TEACHER_SESSION.uid, TEACHER_SESSION.classroomId, { test: 1 });
    storage.setItem(key, JSON.stringify(crossProjEnv));
    assert.equal(readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID), null);
    assert.equal(storage.getItem(key), null);

    // Cross-UID
    const crossUidEnv = createEnvelope(PROJECT_ID, "other_uid", TEACHER_SESSION.classroomId, { test: 1 });
    storage.setItem(key, JSON.stringify(crossUidEnv));
    assert.equal(readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID), null);
    assert.equal(storage.getItem(key), null);

    // Cross-classroom
    const crossClassEnv = createEnvelope(PROJECT_ID, TEACHER_SESSION.uid, "other_room", { test: 1 });
    storage.setItem(key, JSON.stringify(crossClassEnv));
    assert.equal(readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID), null);
    assert.equal(storage.getItem(key), null);
  });

  test("removes legacy cache and never migrates it to V2", () => {
    const storage = createMockStorage();
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ students: [{ id: "legacy" }] }));

    purgeLegacyCache(storage);
    assert.equal(storage.getItem(LEGACY_STORAGE_KEY), null);

    const readRes = readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID);
    assert.equal(readRes, null);
  });

  test("purges previous tenant cache before account switch", () => {
    const storage = createMockStorage();
    const keyA = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    storage.setItem(keyA, JSON.stringify(createEnvelope(PROJECT_ID, "teacher_a", "room_a", { data: 1 })));

    purgeTenantCache(storage, PROJECT_ID, "teacher_a", "room_a");
    assert.equal(storage.getItem(keyA), null);
  });

  test("student session cannot persist to V2 teacher cache", () => {
    const storage = createMockStorage();
    const studentSession = {
      uid: "student_uid_1",
      role: "student",
      classroomId: "room_1",
      epoch: 1,
      state: "ready",
      getState() { return "ready"; }
    };

    const res = writeTeacherCache(storage, studentSession, PROJECT_ID, { test: 1 }, { uid: "student_uid_1", role: "student", classroomId: "room_1", epoch: 1 });
    assert.equal(res.success, false);
    assert.equal(res.reason, "student-session-no-persist");
  });

  test("stale epoch or identity change cannot persist cache", () => {
    const storage = createMockStorage();
    const staleCaptured = { uid: "teacher_uid_1", role: "teacher", classroomId: "room_1", epoch: 4 };

    const res = writeTeacherCache(storage, TEACHER_SESSION, PROJECT_ID, { test: 1 }, staleCaptured);
    assert.equal(res.success, false);
    assert.equal(res.reason, "stale-epoch");
  });

  test("classifies transient network failure and rejects permission/authentication/integrity errors from fallback", () => {
    const unavailableErr = { code: "functions/unavailable", message: "Failed to connect" };
    const permDeniedErr = { code: "functions/permission-denied", message: "Missing permissions" };
    const unauthErr = { code: "functions/unauthenticated", message: "No auth token" };
    const precondErr = { code: "functions/failed-precondition", message: "Inconsistent state" };

    assert.equal(classifyOfflineFailure(unavailableErr), true);
    assert.equal(classifyOfflineFailure(permDeniedErr), false);
    assert.equal(classifyOfflineFailure(unauthErr), false);
    assert.equal(classifyOfflineFailure(precondErr), false);
  });

  test("multi-tab invalidation publishes SHA-256 digest and epoch without leaking classroom data or raw UID", () => {
    let publishedMessage = null;
    const channelAdapter = {
      postMessage(msg) {
        publishedMessage = msg;
      }
    };
    const storageAdapter = createMockStorage();
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "teacher_secret_uid", role: "teacher", classroomId: "secret_room" });

    const invalidator = new MultiTabInvalidator(session, {
      channelAdapter,
      storageAdapter
    });

    invalidator.broadcastInvalidation("teacher_secret_uid", 12);

    assert.notEqual(publishedMessage, null);
    assert.equal(publishedMessage.type, "session-invalidated");
    assert.equal(publishedMessage.epoch, 12);
    assert.equal(publishedMessage.uidDigest.startsWith("sha256_"), true);

    // Verify absence of sensitive data
    assert.equal("uid" in publishedMessage, false);
    assert.equal("rawUid" in publishedMessage, false);
    assert.equal("classroomId" in publishedMessage, false);
    assert.equal("classroomCode" in publishedMessage, false);
    assert.equal("classroomData" in publishedMessage, false);
    assert.equal("studentData" in publishedMessage, false);
    assert.equal("tokens" in publishedMessage, false);
    assert.equal("email" in publishedMessage, false);
  });

  test("multi-tab invalidator receives valid message, invalidates session, and rejects malformed messages", () => {
    const session = new TenantSession();
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "u1", role: "teacher", classroomId: "c1" });

    let callbackFired = false;
    const invalidator = new MultiTabInvalidator(session, {
      onInvalidated: () => {
        callbackFired = true;
      }
    });

    const validMsg = createBroadcastMessage("u1", 5);
    const result = invalidator.receiveMessage(validMsg);

    assert.equal(result, true);
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT);
    assert.equal(callbackFired, true);

    // Malformed message test (extra forbidden key)
    session.transitionTo(SESSION_STATES.AUTHENTICATING);
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE, { uid: "u1", role: "teacher", classroomId: "c1" });
    let malformedCallbackFired = false;
    const malformedInvalidator = new MultiTabInvalidator(session, {
      onInvalidated: () => {
        malformedCallbackFired = true;
      }
    });

    const malformedMsg = {
      type: "session-invalidated",
      uidDigest: computeSha256Digest("u1"),
      epoch: 6,
      classroomId: "illegal_leak"
    };

    assert.equal(validateBroadcastMessage(malformedMsg), false);
    const malformedResult = malformedInvalidator.receiveMessage(malformedMsg);
    assert.equal(malformedResult, false);
    assert.equal(malformedCallbackFired, true);
    assert.equal(session.getState(), SESSION_STATES.SIGNED_OUT, "Fails closed on malformed message");
  });
});
