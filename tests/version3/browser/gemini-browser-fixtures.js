import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

export const PROJECT_ID = "demo-morgan-bank-version3-gemini-callable-browser";
export const EMULATOR_HOST = "127.0.0.1";
export const AUTH_PORT = 9099;
export const FIRESTORE_PORT = 8080;

export const TENANT_A = Object.freeze({
  email: "browser-teacher-a@example.test",
  password: "Synthetic!Browser1",
  classroomId: "class-browser-a",
  classroomName: "Synthetic Browser Room A",
  studentLoginCode: "AAAA-2345",
  studentName: "Avery Browser",
  foreignName: "Bailey Browser",
  reason: "Synthetic robotics reward",
});

export const TENANT_B = Object.freeze({
  email: "browser-teacher-b@example.test",
  password: "Synthetic!Browser2",
  classroomId: "class-browser-b",
  classroomName: "Synthetic Browser Room B",
  studentLoginCode: "BBBB-6789",
  studentName: "Bailey Browser",
  foreignName: "Avery Browser",
  reason: "Synthetic library reward",
});

const AUTH_BASE = `http://${EMULATOR_HOST}:${AUTH_PORT}/identitytoolkit.googleapis.com/v1`;
const COMPLETE_SETTINGS = Object.freeze({
  studentRequestsEnabled: true,
  studentAddRequestsEnabled: true,
  studentSubtractRequestsEnabled: true,
  purchaseRequestsEnabled: true,
  requireTeacherApproval: true,
  reasons: ["Weekly payday", "Class job", "Other"],
  purchaseCategories: ["School Store", "Other"],
  addMoneyCategories: ["Homework", "Teacher's Choice"],
  subtractMoneyCategories: ["Rent", "Teacher's Choice"],
});

let testEnvironment;

async function environment() {
  if (!testEnvironment) {
    testEnvironment = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync("firestore.phase3.final.rules", "utf8"),
        host: EMULATOR_HOST,
        port: FIRESTORE_PORT,
      },
    });
  }
  return testEnvironment;
}

async function clearAuth() {
  const response = await fetch(
    `http://${EMULATOR_HOST}:${AUTH_PORT}/emulator/v1/projects/${PROJECT_ID}/accounts`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(`Version 3 browser fixture Auth cleanup failed: ${response.status}`);
}

async function createUser(email, password) {
  const response = await fetch(`${AUTH_BASE}/accounts:signUp?key=synthetic-emulator-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!response.ok) {
    throw new Error(`Version 3 browser fixture user creation failed: ${response.status}`);
  }
  return (await response.json()).localId;
}

async function seedTenant(db, tenant, uid, studentId, transactionId) {
  const transaction = {
    id: transactionId,
    date: new Date(Date.now() - 60_000).toISOString(),
    studentId,
    studentName: tenant.studentName,
    type: "Add",
    amount: 25,
    reason: tenant.reason,
    memo: "",
    category: "",
    status: "Pending",
    source: "Student",
  };
  await db.doc(`teachers/${uid}`).set({
    uid,
    status: "active",
    classroomId: tenant.classroomId,
  });
  await db.doc(`classrooms/${tenant.classroomId}`).set({
    ownerUid: uid,
    name: tenant.classroomName,
    studentLoginCode: tenant.studentLoginCode,
    schemaVersion: 1,
    nextStudentNumber: studentId + 1,
    settings: { ...COMPLETE_SETTINGS },
    lastBackupAt: null,
    updatedAt: new Date().toISOString(),
  });
  await db.doc(`classroomLoginCodes/${tenant.studentLoginCode.replace("-", "")}`).set({
    classroomId: tenant.classroomId,
    ownerUid: uid,
    status: "active",
  });
  await db.doc(`classrooms/${tenant.classroomId}/students/${studentId}`).set({
    id: studentId,
    name: tenant.studentName,
    balance: 45,
    frozen: false,
    transactions: [transaction],
  });
  await db.doc(`classrooms/${tenant.classroomId}/transactions/${transactionId}`).set(transaction);
}

export async function seedBrowserFixtures() {
  const testEnv = await environment();
  await testEnv.clearFirestore();
  await clearAuth();
  const [uidA, uidB] = await Promise.all([
    createUser(TENANT_A.email, TENANT_A.password),
    createUser(TENANT_B.email, TENANT_B.password),
  ]);
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await seedTenant(db, TENANT_A, uidA, 1, 1700000000001);
    await seedTenant(db, TENANT_B, uidB, 2, 1700000000002);
  });
  return { uidA, uidB };
}

export async function clearInsightUsageState() {
  const testEnv = await environment();
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const collectionName of [
      "insightUsageLedgers",
      "insightUsageRateLimits",
      "insightUsageReservations",
    ]) {
      const snapshot = await db.collection(collectionName).get();
      await Promise.all(snapshot.docs.map(document => document.ref.delete()));
    }
  });
}

export async function cleanupBrowserFixtures() {
  await testEnvironment?.cleanup();
  testEnvironment = undefined;
}
