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
// The normal Phase 2B browser gate loads firestore.phase2b.proposed.rules, so
// it continues to exercise the historical rules contract. Boundary 11's
// explicitly selected release rehearsal loads the checksum-pinned Phase 3
// final candidate instead. Neither path copies over firestore.rules or deploys
// anything.

import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

export const EMULATOR_HOST = "127.0.0.1";
export const FIRESTORE_PORT = 8080;
export const AUTH_PORT = 9099;

// Shared with the Phase 2B server suite's gate-on project so the existing
// .env/project contract that activates V2 Functions applies here too.
export const PROJECT_ID = "demo-morgan-bank-phase2b-server-test";

export const PROPOSED_RULES_PATH = "firestore.phase2b.proposed.rules";
export const FINAL_RULES_PATH = "firestore.phase3.final.rules";
export const BROWSER_RULES_PATH = process.env.PHASE3_REHEARSAL_MODE === "release"
  ? FINAL_RULES_PATH
  : PROPOSED_RULES_PATH;

// resolveTeacherTenantV2 REQUIRES classrooms/{id}.studentLoginCode to be a
// nonempty, canonical, display-formatted code
// (functions/phase2b/teacherOnboarding.js:645-665). Without it the resolver
// throws failed-precondition, the client lands in DENIED_OR_INCONSISTENT, no
// cache envelope is written, and every downstream assertion fails on its
// precondition. That was the single root cause of the 19 browser failures.
//
// Canonical form: exactly 8 characters from the unambiguous alphabet
// (2-9 A-Z minus I/O/0/1), displayed as XXXX-XXXX.
// Phase 3 Commit 7: student IDs are the server-allocated numeric student
// numbers Section 5 defines, not free-form slugs. The production tenant data
// projection now validates identity strictly (a non-canonical ID would let two
// document IDs map onto one student), so these fixtures must carry the real
// contract rather than the looser pre-Phase-3 shapes. Values stay distinct
// across tenants so a cross-tenant render still fails loudly.
export const TENANT_A = {
  label: "A",
  email: "teacher-a@example.test",
  password: "test-password-a",
  classroomId: "classroom-a",
  studentId: "11",
  sharedStudentId: "12",
  // Transaction/login-history IDs are the legacy Date.now() millisecond values.
  transactionId: "1700000000011",
  historyId: "1700000000012",
  classroomName: "Room A Morning",
  studentLoginCode: "AAAA-2345",
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
  studentId: "21",
  sharedStudentId: "22",
  transactionId: "1700000000021",
  historyId: "1700000000022",
  classroomName: "Room B Afternoon",
  studentLoginCode: "BBBB-6789",
  classroomMarker: "B_ONLY_CLASSROOM",
  studentMarker: "B_ONLY_STUDENT",
  transactionMarker: "B-only-transaction",
  historyMarker: "B-only-history",
  authLogMarker: "B-only-authlog"
};

// The syncStudentProfiles trigger derives the scoped credential's loginId from
// the STUDENT'S NAME. Each tenant therefore has a second student with this same
// name, making the same normalized loginId arise naturally in both classrooms.
// The primary students keep distinct visible names so the browser can positively
// prove which tenant rendered instead of relying on an unused document field.
//
// Credentials are deliberately NOT hand-seeded: pre-seeding one races the real
// trigger and makes it throw "Credential already exists for this student; a
// recycled studentId is rejected."
export const SHARED_STUDENT_NAME = "Shared Name";
export const SHARED_LOGIN_ID = "shared-name";

// The injected load adapter returns the V2 data contract directly; unlike the
// legacy load path, the application does not run it through normalizeData().
// Keep every renderer-required setting present so the harness proves real data
// behavior instead of crashing on a deliberately partial fixture.
const COMPLETE_SETTINGS = {
  studentRequestsEnabled: true,
  studentAddRequestsEnabled: true,
  studentSubtractRequestsEnabled: true,
  purchaseRequestsEnabled: true,
  requireTeacherApproval: true,
  reasons: ["Weekly payday", "Class job", "Other"],
  purchaseCategories: ["School Store", "Other"],
  addMoneyCategories: ["Homework", "Teacher's Choice"],
  subtractMoneyCategories: ["Rent", "Teacher's Choice"]
};

const AUTH_BASE = `http://${EMULATOR_HOST}:${AUTH_PORT}/identitytoolkit.googleapis.com/v1`;
// The Auth emulator accepts any non-empty API key.
const API_KEY = "fake-api-key";

let testEnv = null;

async function env() {
  if (!testEnv) {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(BROWSER_RULES_PATH, "utf8"),
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

// Creates a real Auth-emulator account and applies student custom claims, so
// the student-session test does not use a teacher session mislabeled as one.
export async function createStudentIdentity({ classroomId, studentId }) {
  const requestedUid = `student-auth-${classroomId}-${studentId}`;
  const res = await fetch(`${AUTH_BASE}/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${requestedUid}@example.test`,
      password: "test-password-student",
      returnSecureToken: true
    })
  });
  if (!res.ok) {
    throw new Error(`fixtures: student signUp -> ${res.status}: ${await res.text()}`);
  }
  // Patch the identity allocated by the emulator, never the email label.
  const created = await res.json();
  const uid = created.localId;
  if (typeof uid !== "string" || !uid) {
    throw new Error("fixtures: student signUp returned no localId");
  }

  // Apply the student claims the app's V2 path reads.
  const claims = { role: "student", classroomId, studentId };
  const upd = await fetch(
    `${AUTH_BASE}/projects/${PROJECT_ID}/accounts:update?key=${API_KEY}`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer owner",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        localId: uid,
        customAttributes: JSON.stringify(claims)
      })
    }
  );
  if (!upd.ok) {
    throw new Error(`fixtures: student claims -> ${upd.status}: ${await upd.text()}`);
  }
  return {
    uid,
    email: `${requestedUid}@example.test`,
    password: "test-password-student",
    claims
  };
}

export async function readClassroomWithRulesDisabled(classroomId) {
  const te = await env();
  let result = null;
  await te.withSecurityRulesDisabled(async (context) => {
    const snap = await context.firestore().doc(`classrooms/${classroomId}`).get();
    if (snap.exists) result = snap.data();
  });
  return result;
}

async function seedTenantDocs(db, tenant, uid) {
  const transaction = {
    id: Number(tenant.transactionId),
    date: "1/1/2026, 9:00:00 AM",
    studentId: Number(tenant.studentId),
    studentName: tenant.studentMarker,
    type: "Add",
    amount: 5,
    reason: "Weekly payday",
    memo: tenant.transactionMarker,
    category: "",
    status: "Approved",
    source: "Teacher"
  };

  // teachers/{uid}.uid is required by the proposed rules, so it must be seeded.
  await db.doc(`teachers/${uid}`).set({
    uid,
    status: "active",
    classroomId: tenant.classroomId
  });

  await db.doc(`classrooms/${tenant.classroomId}`).set({
    ownerUid: uid,
    name: tenant.classroomName,
    // Required by resolveTeacherTenantV2 in canonical display form.
    studentLoginCode: tenant.studentLoginCode,
    schemaVersion: 1,
    marker: tenant.classroomMarker,
    settings: { ...COMPLETE_SETTINGS, label: tenant.classroomMarker },
    lastBackupAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  // The login-code index the server maintains for code -> classroom lookup.
  await db.doc(`classroomLoginCodes/${tenant.studentLoginCode.replace("-", "")}`).set({
    classroomId: tenant.classroomId,
    ownerUid: uid,
    status: "active"
  });

  // Exactly the five-field student contract from Section 4. The `transactions`
  // mirror is required, so it is seeded rather than omitted.
  await db.doc(`classrooms/${tenant.classroomId}/students/${tenant.studentId}`).set({
    id: Number(tenant.studentId),
    name: tenant.studentMarker,
    balance: 10,
    frozen: false,
    transactions: [transaction]
  });

  await db.doc(`classrooms/${tenant.classroomId}/students/${tenant.sharedStudentId}`).set({
    id: Number(tenant.sharedStudentId),
    name: SHARED_STUDENT_NAME,
    balance: 5,
    frozen: false,
    transactions: []
  });

  // Transactions and login history carry their exact field contracts. The
  // per-tenant marker rides in `memo`/`note` — a real contract field — so the
  // cross-tenant render assertions keep working without an extra key that the
  // projection would (correctly) reject.
  await db.doc(`classrooms/${tenant.classroomId}/transactions/${tenant.transactionId}`).set(transaction);

  await db.doc(`classrooms/${tenant.classroomId}/loginHistory/${tenant.historyId}`).set({
    id: Number(tenant.historyId),
    date: "1/1/2026, 9:05:00 AM",
    studentId: Number(tenant.studentId),
    studentName: tenant.studentMarker,
    result: "Success",
    note: tenant.historyMarker
  });

  // Classroom-scoped auth logs use studentAuthLogs/{classroomId}/logs/{logId}.
  await db.doc(`studentAuthLogs/${tenant.classroomId}/logs/log-1`).set({
    marker: tenant.authLogMarker,
    studentId: tenant.studentId
  });

  // Scoped credentials are deliberately NOT seeded here. The real
  // syncStudentProfiles trigger creates them from the student write above, and a
  // hand-seeded document races it into
  // "Credential already exists for this student; a recycled studentId is
  // rejected." Callers that need the credential must await
  // waitForScopedCredential() below.
}

// Waits for the syncStudentProfiles trigger to finish creating the scoped
// credential, so the fixture depends on observable trigger completion rather
// than a sleep. Read with rules disabled, since the proposed rules deny scoped
// credentials to every client identity — including the active owner.
export async function waitForScopedCredential(
  tenant,
  studentId = tenant.studentId,
  { timeoutMs = 20000 } = {}
) {
  const te = await env();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let found = null;
    await te.withSecurityRulesDisabled(async (context) => {
      const snap = await context
        .firestore()
        .collection(`classrooms/${tenant.classroomId}/studentCredentials`)
        .where("studentId", "==", studentId)
        .limit(1)
        .get();
      if (!snap.empty) found = { id: snap.docs[0].id, ...snap.docs[0].data() };
    });
    if (found) return found;

    if (Date.now() > deadline) {
      throw new Error(
        `fixtures: scoped credential for ${tenant.classroomId}/${studentId} was not created within ${timeoutMs}ms`
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
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
      name: "Owner Mismatch Room",
      studentLoginCode: "CCCC-2345",
      schemaVersion: 1,
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
    await db.doc(`studentCredentials/${SHARED_LOGIN_ID}`).set({ hash: "flat-legacy" });
  });

  // All four student-create triggers must settle before the browser starts.
  // This prevents trigger work from racing the suite or fixture cleanup.
  const [aPrimaryCredential, aSharedCredential, bPrimaryCredential, bSharedCredential] =
    await Promise.all([
      waitForScopedCredential(TENANT_A, TENANT_A.studentId),
      waitForScopedCredential(TENANT_A, TENANT_A.sharedStudentId),
      waitForScopedCredential(TENANT_B, TENANT_B.studentId),
      waitForScopedCredential(TENANT_B, TENANT_B.sharedStudentId)
    ]);

  if (aSharedCredential.id !== SHARED_LOGIN_ID || bSharedCredential.id !== SHARED_LOGIN_ID) {
    throw new Error("fixtures: shared-name students did not receive the expected scoped loginId");
  }

  return {
    aUid,
    bUid,
    credentials: {
      aPrimaryCredential,
      aSharedCredential,
      bPrimaryCredential,
      bSharedCredential
    },
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
