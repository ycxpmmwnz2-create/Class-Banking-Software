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
  computeSimpleUidDigest,
  createBroadcastMessage,
  validateBroadcastMessage,
  LEGACY_STORAGE_KEY,
  CACHE_SCHEMA_VERSION
} from "./tenantCache.js";

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
    state: "ready"
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

    assert.equal(envelope.schemaVersion, CACHE_SCHEMA_VERSION, "Detects schemaVersion mismatch");
    assert.equal(envelope.projectId, PROJECT_ID, "Detects projectId mismatch");
    assert.equal(envelope.ownerUid, "teacher_uid_1", "Detects ownerUid mismatch");
    assert.equal(envelope.classroomId, "room_1", "Detects classroomId mismatch");
    assert.equal(typeof envelope.updatedAt, "number", "Detects missing updatedAt timestamp");
    assert.deepEqual(envelope.data, data, "Detects corrupted data payload");

    assert.equal(
      validateEnvelope(envelope, TEACHER_SESSION, PROJECT_ID),
      true,
      "Detects failure of validateEnvelope on matching valid envelope"
    );
    assert.equal(
      validateEnvelope(envelope, { ...TEACHER_SESSION, role: "student" }, PROJECT_ID),
      false,
      "Detects failure of validateEnvelope to reject student session"
    );
    assert.equal(
      computeSimpleUidDigest("test_uid_123").startsWith("digest_"),
      true,
      "Detects failure of computeSimpleUidDigest format"
    );
  });

  test("valid same-tenant cache admission", () => {
    const storage = createMockStorage();
    const data = { students: [{ id: "s1" }] };

    const writeRes = writeTeacherCache(storage, TEACHER_SESSION, PROJECT_ID, data, TEACHER_SESSION.epoch);
    assert.equal(writeRes.success, true, "Detects failure to write valid teacher cache");

    const readRes = readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID);
    assert.notEqual(readRes, null, "Detects failure to read matching teacher cache");
    assert.equal(readRes.isOfflineView, true, "Detects failure to label matching cache as offline view");
    assert.deepEqual(readRes.data, data, "Detects data mismatch from cached read");
  });

  test("rejects and purges cross-project cache entries", () => {
    const storage = createMockStorage();
    const envelope = createEnvelope("other-project", TEACHER_SESSION.uid, TEACHER_SESSION.classroomId, { test: 1 });
    const key = buildCacheKey(PROJECT_ID, TEACHER_SESSION.uid, TEACHER_SESSION.classroomId);
    storage.setItem(key, JSON.stringify(envelope));

    const readRes = readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID);
    assert.equal(readRes, null, "Detects failure to reject cross-project cache envelope");
    assert.equal(storage.getItem(key), null, "Detects failure to purge invalid cross-project cache entry");
  });

  test("rejects and purges cross-UID cache entries", () => {
    const storage = createMockStorage();
    const envelope = createEnvelope(PROJECT_ID, "other_uid", TEACHER_SESSION.classroomId, { test: 1 });
    const key = buildCacheKey(PROJECT_ID, TEACHER_SESSION.uid, TEACHER_SESSION.classroomId);
    storage.setItem(key, JSON.stringify(envelope));

    const readRes = readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID);
    assert.equal(readRes, null, "Detects failure to reject cross-UID cache envelope");
    assert.equal(storage.getItem(key), null, "Detects failure to purge invalid cross-UID cache entry");
  });

  test("rejects and purges cross-classroom cache entries", () => {
    const storage = createMockStorage();
    const envelope = createEnvelope(PROJECT_ID, TEACHER_SESSION.uid, "different_room", { test: 1 });
    const key = buildCacheKey(PROJECT_ID, TEACHER_SESSION.uid, TEACHER_SESSION.classroomId);
    storage.setItem(key, JSON.stringify(envelope));

    const readRes = readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID);
    assert.equal(readRes, null, "Detects failure to reject cross-classroom cache envelope");
    assert.equal(storage.getItem(key), null, "Detects failure to purge invalid cross-classroom cache entry");
  });

  test("rejects and purges schema mismatch, malformed JSON, and missing-field entries", () => {
    const storage = createMockStorage();
    const key = buildCacheKey(PROJECT_ID, TEACHER_SESSION.uid, TEACHER_SESSION.classroomId);

    // Schema mismatch
    storage.setItem(key, JSON.stringify({ schemaVersion: "v0_old", projectId: PROJECT_ID, ownerUid: TEACHER_SESSION.uid, classroomId: TEACHER_SESSION.classroomId, data: {} }));
    assert.equal(readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID), null);
    assert.equal(storage.getItem(key), null, "Detects failure to purge old-schema entry");

    // Malformed JSON
    storage.setItem(key, "{ invalid_json: ");
    assert.equal(readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID), null);
    assert.equal(storage.getItem(key), null, "Detects failure to purge malformed JSON entry");

    // Missing field
    storage.setItem(key, JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, projectId: PROJECT_ID }));
    assert.equal(readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID), null);
    assert.equal(storage.getItem(key), null, "Detects failure to purge missing-field entry");
  });

  test("removes legacy cache and never migrates it to V2", () => {
    const storage = createMockStorage();
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ students: [{ id: "legacy_student" }] }));

    purgeLegacyCache(storage);
    assert.equal(
      storage.getItem(LEGACY_STORAGE_KEY),
      null,
      "Detects failure to remove legacy storage key mrMorganClassCashDataV5"
    );

    const readRes = readTeacherCache(storage, TEACHER_SESSION, PROJECT_ID);
    assert.equal(readRes, null, "Detects failure to reject legacy cache migration");
  });

  test("purges previous tenant cache before switch", () => {
    const storage = createMockStorage();
    const keyA = buildCacheKey(PROJECT_ID, "teacher_a", "room_a");
    storage.setItem(keyA, JSON.stringify(createEnvelope(PROJECT_ID, "teacher_a", "room_a", { data: 1 })));

    purgeTenantCache(storage, PROJECT_ID, "teacher_a", "room_a");
    assert.equal(storage.getItem(keyA), null, "Detects failure to purge previous tenant cache before switch");
  });

  test("student session cannot persist to V2 teacher cache", () => {
    const storage = createMockStorage();
    const studentSession = {
      uid: "student_uid_1",
      role: "student",
      classroomId: "room_1",
      epoch: 1,
      state: "ready"
    };

    const res = writeTeacherCache(storage, studentSession, PROJECT_ID, { test: 1 }, studentSession.epoch);
    assert.equal(res.success, false, "Detects failure to block student session cache write");
    assert.equal(res.reason, "student-session-no-persist");
    assert.equal(storage.store.size, 0, "Detects storage pollution from student session");
  });

  test("stale epoch cannot persist cache", () => {
    const storage = createMockStorage();
    const res = writeTeacherCache(storage, TEACHER_SESSION, PROJECT_ID, { test: 1 }, TEACHER_SESSION.epoch - 1);
    assert.equal(res.success, false, "Detects failure to block stale epoch cache write");
    assert.equal(res.reason, "stale-epoch");
  });

  test("classifies transient network failure for labeled matching offline view", () => {
    const unavailableErr = { code: "unavailable", message: "Failed to connect to server" };
    const permDeniedErr = { code: "permission-denied", message: "Missing permissions" };

    assert.equal(
      classifyOfflineFailure(unavailableErr),
      true,
      "Detects failure to classify network unavailable error as transient"
    );
    assert.equal(
      classifyOfflineFailure(permDeniedErr),
      false,
      "Detects failure to reject permission-denied error from offline fallback"
    );
  });

  test("multi-tab broadcast message contains only non-sensitive digest and epoch", () => {
    const msg = createBroadcastMessage("teacher_secret_uid_123", 14);
    assert.equal(msg.type, "session-invalidated");
    assert.equal(msg.epoch, 14);
    assert.notEqual(msg.uidDigest, "");
    assert.equal("uid" in msg, false, "Detects raw uid leak in broadcast message");
    assert.equal("classroomId" in msg, false, "Detects raw classroomId leak in broadcast message");

    assert.equal(validateBroadcastMessage(msg), true, "Detects failure to validate valid broadcast message");
  });

  test("fails closed on malformed or sensitive broadcast messages", () => {
    const sensitiveMsg = {
      type: "session-invalidated",
      uidDigest: "abc",
      epoch: 1,
      classroomId: "room_secret"
    };
    assert.equal(
      validateBroadcastMessage(sensitiveMsg),
      false,
      "Detects failure to reject broadcast message containing classroomId"
    );

    const malformedMsg = { type: "other-type" };
    assert.equal(
      validateBroadcastMessage(malformedMsg),
      false,
      "Detects failure to reject malformed broadcast message type"
    );
  });
});
