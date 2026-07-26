// Phase 2B Item 10 browser fixtures.
//
// Seeds two fully independent active tenants plus the negative-path identities,
// directly against the Firestore and Auth emulators over their REST APIs. REST
// is used deliberately: it needs no Java-side admin SDK and no service account,
// and it keeps seeding independent of the application's own client code so a
// client-side isolation bug cannot also corrupt the fixture.
//
// Every tenant-distinguishing value is a unique sentinel string, so a spec can
// assert "no A data is present" by scanning for A's sentinels rather than by
// inspecting internal state.

export const EMULATOR_HOST = "127.0.0.1";
export const FIRESTORE_PORT = 8080;
export const AUTH_PORT = 9099;
export const PROJECT_ID = "demo-morgan-bank-phase2b-browser-test";

export const TENANT_A = {
  label: "A",
  email: "teacher-a@example.test",
  password: "test-password-a",
  classroomId: "classroom-a",
  studentId: "student-a-1",
  classroomMarker: "A_ONLY_CLASSROOM",
  studentMarker: "A_ONLY_STUDENT",
  transactionMarker: "A-only-transaction",
  historyMarker: "A-only-history",
  authLogMarker: "A-only-authlog"
};

export const TENANT_B = {
  label: "B",
  email: "teacher-b@example.test",
  password: "test-password-b",
  classroomId: "classroom-b",
  studentId: "student-b-1",
  classroomMarker: "B_ONLY_CLASSROOM",
  studentMarker: "B_ONLY_STUDENT",
  transactionMarker: "B-only-transaction",
  historyMarker: "B-only-history",
  authLogMarker: "B-only-authlog"
};

// Both tenants use the SAME normalized login id, proving scoping is per
// classroom rather than per globally-unique credential.
export const SHARED_LOGIN_ID = "room1-student1";

const FS_BASE = `http://${EMULATOR_HOST}:${FIRESTORE_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const AUTH_BASE = `http://${EMULATOR_HOST}:${AUTH_PORT}/identitytoolkit.googleapis.com/v1`;

// The Auth emulator accepts any non-empty API key.
const API_KEY = "fake-api-key";

function encodeValue(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
  throw new Error(`fixtures: unsupported value type ${typeof v}`);
}

function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeValue(v);
  return fields;
}

async function req(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fixtures: ${init?.method || "GET"} ${url} -> ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function clearFirestore() {
  await fetch(
    `http://${EMULATOR_HOST}:${FIRESTORE_PORT}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" }
  );
}

export async function clearAuth() {
  await fetch(`http://${EMULATOR_HOST}:${AUTH_PORT}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: "DELETE"
  });
}

export async function setDoc(path, data) {
  // Firestore REST createDocument needs parent + documentId.
  const parts = path.split("/");
  const docId = parts.pop();
  const parent = parts.join("/");
  const url = parent
    ? `${FS_BASE}/${parent}?documentId=${encodeURIComponent(docId)}`
    : `${FS_BASE}?documentId=${encodeURIComponent(docId)}`;
  return req(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: encodeFields(data) })
  });
}

export async function createUser(email, password) {
  const out = await req(`${AUTH_BASE}/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  return out.localId;
}

// Seeds one tenant and returns its resolved UID.
export async function seedTenant(tenant) {
  const uid = await createUser(tenant.email, tenant.password);

  await setDoc(`teachers/${uid}`, { status: "active", classroomId: tenant.classroomId });

  await setDoc(`classrooms/${tenant.classroomId}`, {
    ownerUid: uid,
    marker: tenant.classroomMarker,
    settings: { label: tenant.classroomMarker }
  });

  await setDoc(`classrooms/${tenant.classroomId}/students/${tenant.studentId}`, {
    id: tenant.studentId,
    name: tenant.studentMarker,
    balance: 10,
    frozen: false,
    loginId: SHARED_LOGIN_ID
  });

  await setDoc(`classrooms/${tenant.classroomId}/transactions/tx-1`, {
    marker: tenant.transactionMarker,
    amount: 5,
    studentId: tenant.studentId
  });

  await setDoc(`classrooms/${tenant.classroomId}/loginHistory/h-1`, {
    marker: tenant.historyMarker,
    studentId: tenant.studentId
  });

  await setDoc(`classrooms/${tenant.classroomId}/studentAuthLogs/log-1`, {
    marker: tenant.authLogMarker,
    studentId: tenant.studentId
  });

  await setDoc(`classrooms/${tenant.classroomId}/studentCredentials/${SHARED_LOGIN_ID}`, {
    hash: `${tenant.label}-credential-hash`,
    studentId: tenant.studentId
  });

  return uid;
}

// Negative-path identities, each failing for a distinct reason.
export async function seedNegativePathFixtures() {
  const disabledUid = await createUser("disabled@example.test", "test-password-d");
  await setDoc(`teachers/${disabledUid}`, { status: "disabled", classroomId: TENANT_A.classroomId });

  // Deliberately NO teachers/ document written for this account.
  const missingDocUid = await createUser("missing-doc@example.test", "test-password-m");

  const missingClassroomUid = await createUser("missing-classroom@example.test", "test-password-c");
  await setDoc(`teachers/${missingClassroomUid}`, {
    status: "active",
    classroomId: "classroom-that-does-not-exist"
  });

  const ownerMismatchUid = await createUser("owner-mismatch@example.test", "test-password-o");
  await setDoc(`teachers/${ownerMismatchUid}`, {
    status: "active",
    classroomId: "classroom-owner-mismatch"
  });
  await setDoc("classrooms/classroom-owner-mismatch", {
    ownerUid: "somebody-else-entirely",
    marker: "OWNER_MISMATCH_CLASSROOM"
  });

  const invalidStatusUid = await createUser("invalid-status@example.test", "test-password-i");
  await setDoc(`teachers/${invalidStatusUid}`, {
    status: "pending-review",
    classroomId: TENANT_A.classroomId
  });

  return { disabledUid, missingDocUid, missingClassroomUid, ownerMismatchUid, invalidStatusUid };
}

export async function seedAll() {
  await clearFirestore();
  await clearAuth();
  const aUid = await seedTenant(TENANT_A);
  const bUid = await seedTenant(TENANT_B);
  const negative = await seedNegativePathFixtures();
  return { aUid, bUid, negative };
}

// Cache-poison envelope builders. Each returns a V2 cache envelope that must be
// REJECTED and removed by the client, for a different structural reason.
export function cacheKey(projectId, uid, classroomId) {
  return `morganBank:v2:${projectId}:teacher:${uid}:classroom:${classroomId}:data:v1`;
}

export function poisonEnvelopes({ projectId, uid, classroomId, foreignUid, foreignClassroomId }) {
  const valid = {
    schemaVersion: "v1",
    projectId,
    ownerUid: uid,
    classroomId,
    updatedAt: Date.now(),
    data: { students: [{ id: "poison", name: "POISONED_STUDENT" }], transactions: [], loginHistory: [], settings: {} }
  };
  return {
    wrongProject: { ...valid, projectId: "demo-some-other-project" },
    wrongOwner: { ...valid, ownerUid: foreignUid },
    wrongClassroom: { ...valid, classroomId: foreignClassroomId },
    wrongSchema: { ...valid, schemaVersion: "v0" },
    extraField: { ...valid, injected: "EXTRA_FIELD_MARKER" },
    malformed: "{ this is not valid json"
  };
}
