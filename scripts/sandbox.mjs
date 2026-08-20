/**
 * Interactive sandbox runner.
 *
 * Serves the real application with the multi-teacher V2 gate ON, against the
 * emulator suite and a seeded demo classroom, so the V2 experience can be used
 * by hand rather than only asserted by Playwright. The browser suite already
 * builds exactly this environment; it just tears it down when the assertions
 * finish. This keeps it up.
 *
 * Nothing here can reach a real project. It runs only under
 * `firebase emulators:exec --project demo-...` (see `npm run sandbox`), which
 * supplies the emulator hosts this script and the seeder require, and the demo
 * project id is fixed by tests/browser/vite.phase2b.config.js. There is no
 * deploy, migration, or production code path in this file.
 */

import { createServer } from "vite";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  signInWithEmailAndPassword
} from "firebase/auth";
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable
} from "firebase/functions";

import phase2bViteConfig, {
  PHASE2B_BROWSER_PORT,
  PHASE2B_EMULATOR_CONFIG
} from "../tests/browser/vite.phase2b.config.js";
import {
  PROJECT_ID,
  SANDBOX_STUDENT_PIN,
  SHARED_LOGIN_ID,
  TENANT_A,
  TENANT_B,
  cleanupFixtures,
  seedAll
} from "../tests/browser/phase2b-fixtures.js";

// The seeder and the served app both talk to the emulators through these. A
// missing one means this was started outside `firebase emulators:exec`, where
// the fixture writes would have nowhere safe to land.
for (const variable of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) {
  if (!process.env[variable]) {
    console.error(
      `Refusing to start: ${variable} is not set.\n` +
      "Run this through `npm run sandbox`, which starts the emulators first."
    );
    process.exit(1);
  }
}

async function activateSandboxStudent() {
  const app = initializeApp(
    { projectId: PROJECT_ID, apiKey: "fake-api-key" },
    "morgan-bank-interactive-sandbox"
  );

  try {
    const auth = getAuth(app);
    connectAuthEmulator(
      auth,
      `http://${PHASE2B_EMULATOR_CONFIG.host}:${PHASE2B_EMULATOR_CONFIG.authPort}`,
      { disableWarnings: true }
    );

    const functions = getFunctions(app, "us-central1");
    connectFunctionsEmulator(
      functions,
      PHASE2B_EMULATOR_CONFIG.host,
      PHASE2B_EMULATOR_CONFIG.functionsPort
    );

    await signInWithEmailAndPassword(auth, TENANT_A.email, TENANT_A.password);
    const reset = await httpsCallable(functions, "resetStudentPinV2")({
      studentId: TENANT_A.sharedStudentId,
      newPin: SANDBOX_STUDENT_PIN
    });
    if (reset.data?.success !== true) {
      throw new Error("Sandbox student PIN activation did not report success.");
    }
  } finally {
    await deleteApp(app);
  }
}

console.log(`Seeding the demo classroom into ${PROJECT_ID} ...`);
const seeded = await seedAll();
console.log("Activating the synthetic sandbox student through resetStudentPinV2 ...");
await activateSandboxStudent();

const server = await createServer({
  ...phase2bViteConfig,
  configFile: false,
  server: { ...(phase2bViteConfig.server || {}), port: PHASE2B_BROWSER_PORT }
});
await server.listen();

const url = `http://127.0.0.1:${PHASE2B_BROWSER_PORT}/`;

console.log(`
────────────────────────────────────────────────────────────────────────
  Morgan Bank sandbox is running.

      ${url}

  Everything below lives in the emulator only. No real classroom, no real
  student, and no real balance can be reached from this page, and nothing
  you do here is saved when you stop it.

  Sign in as a teacher
      Email     ${TENANT_A.email}
      Password  ${TENANT_A.password}
      Classroom ${TENANT_A.classroomName}

  A second, separate teacher — useful for checking that one classroom
  cannot see the other
      Email     ${TENANT_B.email}
      Password  ${TENANT_B.password}
      Classroom ${TENANT_B.classroomName}

  Sign in as a student, on the Student tab
      Classroom code  ${TENANT_A.studentLoginCode}
      Login ID        ${SHARED_LOGIN_ID}
      PIN             ${SANDBOX_STUDENT_PIN}

  To try the thing that was broken: sign in as the student, submit Add
  Money, then sign in as teacher A and open Approvals. The request has to
  be sitting there. Submit Subtract Money and the balance has to move at
  once. Open two browser windows and it keeps working with both at the
  same time.

  Press Ctrl-C to stop. The emulators shut down with it.
────────────────────────────────────────────────────────────────────────
`);

// Seeded uids are logged only under an explicit opt-in: they are noise for the
// ordinary case and useful only when debugging the fixture itself.
if (process.env.SANDBOX_VERBOSE === "true") {
  console.log("Seeded teacher uids:", { a: seeded.aUid, b: seeded.bUid });
}

let shuttingDown = false;
const shutDown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nStopping the sandbox ...");
  try {
    await server.close();
    await cleanupFixtures();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
