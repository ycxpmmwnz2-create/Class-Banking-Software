// Phase 2B Item 10 browser fixtures.
//
// Seeds two fully independent active tenants plus the negative-path identities.
//
// SEEDING MECHANISM — this matters and was corrected after an empirical check.
// Firestore writes go through @firebase/rules-unit-testing's
// withSecurityRulesDisabled(), NOT plain REST. Unauthenticated REST writes
// against the emulator are rejected once the proposed rules are loaded:
//
//     POST .../documents/things?documentId=x
//     -> 403 {"error":{"code":403,"message":"No matching allow statements"}}
//
// (Verified directly against the Firestore emulator.) The privileged
// rules-disabled channel is the correct emulator-only mechanism, and it also
// keeps seeding independent of the application's own client code, so a
// client-side isolation bug cannot silently corrupt the fixture.
//
// Auth user creation stays on REST: the Auth emulator has no rules layer, and
// its REST signUp endpoint is the documented way to mint local accounts.
//
// The browser emulator loads firestore.phase2b.proposed.rules, so the browser
// suite exercises the SAME rules the rules contract asserts.

import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

export const EMULATOR_HOST = "127.0.0.1";
export const FIRESTORE_PORT = 8080;
export const AUTH_PORT = 9099;

// Shared with the Phase 2B server suite's gate-on project so the existing
// .env/project contract that activates V2 Functions applies here too.
export const PROJECT_ID = "demo-morgan-bank-phase2b-server-test";

export const PROPOSED_RULES_PATH = "firestore.phase2b.proposed.rules";

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

const AUTH_BASE = `http://${EMULATOR_HOST}:${AUTH_PORT}/identitytoolkit.googleapis.com/v1`;
// The Auth emulator accepts any non-empty API key.
const API_KEY = "fake-api-key";

let testEnv = null;

async function env() {
  if (!testEnv) {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(PROPOSED_RULES_PATH, "utf8"),
        host: EMULATOR_HOST,
        port: FIRESTORE_PORT
      }
    });
  }
  return testEnv;
}

export async function cleanupFixtures() {
  await testEnv?.cleanup();
  testEnv = null;
}

export async function clearAuth() {
  await fetch(`http://${EMULATOR_HOST}:${AUTH_PORT}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: "DELETE"
  });
}

export async function createUser(email, password) {
  const res = await fetch(`${AUTH_BASE}/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  if (!res.ok) {
    throw new Error(`fixtures: signUp ${email} -> ${res.status}: ${await res.text()}`);
  }
  const out = await res.json();
  return out.localId;
}

// Mints a student custom token via the Auth emulator, so the student-session
// test uses a REAL student identity with role/classroomId/studentId claims
// rather than a teacher session mislabeled as a student.
export async function createStudentToken({ classroomId, studentId }) {
  const uid = `student-auth-${classroomId}-${studentId}`;
  // The Auth emulator honors custom claims supplied at account creation.
  const res = await fetch(`${AUTH_BASE}/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      localId: uid,
      email: `${uid}@example.test`,
      password: "test-password-student",
      returnSecureToken: true
    })
  });
  if (!res.ok && res.status !== 400) {
    throw new Error(`fixtures: student signUp -> ${res.status}: ${await res.text()}`);
  }

  // Apply the student claims the app's V2 path reads.
  const claims = { role: "student", classroomId, studentId };
  const upd = await fetch(
    `http://${EMULATOR_HOST}:${AUTH_PORT}/emulator/v1/projects/${PROJECT_ID}/accounts/${uid}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customAttributes: JSON.stringify(claims) })
    }
  );
  if (!upd.ok) {
    throw new Error(`fixtures: student claims -> ${upd.status}: ${await upd.text()}`);
  }
  return { uid, email: `${uid}@example.test`, password: "test-password-student", claims };
}

async function seedTenantDocs(db, tenant, uid) {
  // teachers/{uid}.uid is required by the proposed rules, so it must be seeded.
  await db.doc(`teachers/${uid}`).set({
    uid,
    status: "active",
    classroomId: tenant.classroomId
  });

  await db.doc(`classrooms/${tenant.classroomId}`).set({
    ownerUid: uid,
    marker: tenant.classroomMarker,
    settings: { label: tenant.classroomMarker }
  });

  await db.doc(`classrooms/${tenant.classroomId}/students/${tenant.studentId}`).set({
    id: tenant.studentId,
    name: tenant.studentMarker,
    balance: 10,
    frozen: false,
    loginId: SHARED_LOGIN_ID
  });

  await db.doc(`classrooms/${tenant.classroomId}/transactions/tx-1`).set({
    marker: tenant.transactionMarker,
    amount: 5,
    studentId: tenant.studentId
  });

  await db.doc(`classrooms/${tenant.classroomId}/loginHistory/h-1`).set({
    marker: tenant.historyMarker,
    studentId: tenant.studentId
  });

  // Classroom-scoped auth logs use studentAuthLogs/{classroomId}/logs/{logId}.
  await db.doc(`studentAuthLogs/${tenant.classroomId}/logs/log-1`).set({
    marker: tenant.authLogMarker,
    studentId: tenant.studentId
  });

  await db.doc(`classrooms/${tenant.classroomId}/studentCredentials/${SHARED_LOGIN_ID}`).set({
    hash: `${tenant.label}-credential-hash`,
    studentId: tenant.studentId
  });
}

export async function seedAll() {
  const te = await env();
  await te.clearFirestore();
  await clearAuth();

  const aUid = await createUser(TENANT_A.email, TENANT_A.password);
  const bUid = await createUser(TENANT_B.email, TENANT_B.password);

  const disabledUid = await createUser("disabled@example.test", "test-password-d");
  const missingDocUid = await createUser("missing-doc@example.test", "test-password-m");
  const missingClassroomUid = await createUser("missing-classroom@example.test", "test-password-c");
  const ownerMismatchUid = await createUser("owner-mismatch@example.test", "test-password-o");
  const invalidStatusUid = await createUser("invalid-status@example.test", "test-password-i");
  const uidMismatchUid = await createUser("uid-mismatch@example.test", "test-password-u");

  await te.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await seedTenantDocs(db, TENANT_A, aUid);
    await seedTenantDocs(db, TENANT_B, bUid);

    // --- negative-path identities, each failing for a DIFFERENT reason ---

    await db.doc(`teachers/${disabledUid}`).set({
      uid: disabledUid,
      status: "disabled",
      classroomId: TENANT_A.classroomId
    });

    // missingDocUid: deliberately NO teachers/ document.

    await db.doc(`teachers/${missingClassroomUid}`).set({
      uid: missingClassroomUid,
      status: "active",
      classroomId: "classroom-that-does-not-exist"
    });

    await db.doc(`teachers/${ownerMismatchUid}`).set({
      uid: ownerMismatchUid,
      status: "active",
      classroomId: "classroom-owner-mismatch"
    });
    await db.doc("classrooms/classroom-owner-mismatch").set({
      ownerUid: "somebody-else-entirely",
      marker: "OWNER_MISMATCH_CLASSROOM"
    });

    await db.doc(`teachers/${invalidStatusUid}`).set({
      uid: invalidStatusUid,
      status: "pending-review",
      classroomId: TENANT_A.classroomId
    });

    // Teacher doc whose embedded uid does NOT match its document id.
    await db.doc(`teachers/${uidMismatchUid}`).set({
      uid: "some-other-uid-entirely",
      status: "active",
      classroomId: TENANT_A.classroomId
    });

    // --- server-only collections ---
    await db.doc("teacherInvitations/invite-1").set({ email: "x@y.z" });
    await db.doc("classroomLoginCodes/code-1").set({ classroomId: TENANT_A.classroomId });
    await db.doc("studentLoginThrottle/throttle-1").set({ count: 1 });
    await db.doc("studentAuthUnresolvedLogs/unresolved-1").set({ marker: "unresolved" });
    await db.doc(`studentCredentials/${SHARED_LOGIN_ID}`).set({ hash: "flat" });
  });

  return {
    aUid,
    bUid,
    negative: {
      disabledUid,
      missingDocUid,
      missingClassroomUid,
      ownerMismatchUid,
      invalidStatusUid,
      uidMismatchUid
    }
  };
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
    data: {
      students: [{ id: "poison", name: "POISONED_STUDENT" }],
      transactions: [],
      loginHistory: [],
      settings: {}
    }
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
