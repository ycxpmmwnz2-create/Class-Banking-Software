// Phase 2B Item 10: proposed multi-teacher rules contract.
//
// Loads firestore.phase2b.proposed.rules as an explicit FIXTURE via
// initializeTestEnvironment. It never copies, deploys, or substitutes that file
// over firestore.rules, and it pins the checked-in rules by content hash so an
// accidental edit to production rules fails here loudly.
//
// Every tenant-scoped row runs in BOTH directions (A as owner / B as intruder,
// then B as owner / A as intruder) because a one-directional test cannot
// distinguish real per-tenant authorization from a rule that happens to favor
// whichever tenant was seeded first.
//
// Run via `npm run test:phase2b:rules`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";

// The checked-in production rules must remain byte-identical during Item 10.
const BASELINE_RULES_SHA256 =
  "0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50";

const PROPOSED_RULES_PATH = "firestore.phase2b.proposed.rules";

const A_UID = "teacher-a-uid";
const B_UID = "teacher-b-uid";
const A_ROOM = "classroom-a";
const B_ROOM = "classroom-b";
const A_STUDENT = "student-a-1";
const B_STUDENT = "student-b-1";

// Both tenants intentionally use the SAME normalized login id, to prove
// scoping is by classroom rather than by a globally unique credential.
const SHARED_LOGIN_ID = "room1-student1";

const DISABLED_UID = "teacher-disabled-uid";
const NO_TEACHER_DOC_UID = "teacher-missing-doc-uid";
const NO_CLASSROOM_UID = "teacher-missing-classroom-uid";
const MISMATCH_UID = "teacher-uid-mismatch-uid";
const OWNER_MISMATCH_UID = "teacher-owner-mismatch-uid";
const INVALID_STATUS_UID = "teacher-invalid-status-uid";

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-morgan-bank-phase2b-rules-test",
    firestore: {
      // The proposed fixture, loaded explicitly. NOT firestore.rules.
      rules: readFileSync(PROPOSED_RULES_PATH, "utf8"),
      host: "127.0.0.1",
      port: 8080
    }
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed();
});

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    // --- two fully independent, active tenants ---
    await db.doc(`teachers/${A_UID}`).set({ uid: A_UID, status: "active", classroomId: A_ROOM });
    await db.doc(`teachers/${B_UID}`).set({ uid: B_UID, status: "active", classroomId: B_ROOM });

    await db.doc(`classrooms/${A_ROOM}`).set({
      ownerUid: A_UID,
      marker: "A_ONLY_CLASSROOM",
      settings: { theme: "a" }
    });
    await db.doc(`classrooms/${B_ROOM}`).set({
      ownerUid: B_UID,
      marker: "B_ONLY_CLASSROOM",
      settings: { theme: "b" }
    });

    await db.doc(`classrooms/${A_ROOM}/students/${A_STUDENT}`)
      .set({ name: "A_ONLY_STUDENT", balance: 10, loginId: SHARED_LOGIN_ID });
    await db.doc(`classrooms/${B_ROOM}/students/${B_STUDENT}`)
      .set({ name: "B_ONLY_STUDENT", balance: 20, loginId: SHARED_LOGIN_ID });

    await db.doc(`classrooms/${A_ROOM}/transactions/tx-a`).set({ marker: "A-only", amount: 1 });
    await db.doc(`classrooms/${B_ROOM}/transactions/tx-b`).set({ marker: "B-only", amount: 2 });

    await db.doc(`classrooms/${A_ROOM}/loginHistory/h-a`).set({ marker: "A-only" });
    await db.doc(`classrooms/${B_ROOM}/loginHistory/h-b`).set({ marker: "B-only" });

    await db.doc(`studentAuthLogs/${A_ROOM}/logs/log-a`).set({ marker: "A-only" });
    await db.doc(`studentAuthLogs/${B_ROOM}/logs/log-b`).set({ marker: "B-only" });

    await db.doc(`classrooms/${A_ROOM}/studentCredentials/${SHARED_LOGIN_ID}`)
      .set({ hash: "a-hash" });
    await db.doc(`classrooms/${B_ROOM}/studentCredentials/${SHARED_LOGIN_ID}`)
      .set({ hash: "b-hash" });

    // --- negative-path identities, each failing for a DIFFERENT reason ---

    // Teacher doc present but disabled.
    await db.doc(`teachers/${DISABLED_UID}`).set({ uid: DISABLED_UID, status: "disabled", classroomId: A_ROOM });

    // No teacher doc at all for NO_TEACHER_DOC_UID (deliberately not written).

    // Teacher doc active, but the classroom root does not exist.
    await db.doc(`teachers/${NO_CLASSROOM_UID}`)
      .set({ uid: NO_CLASSROOM_UID, status: "active", classroomId: "classroom-that-does-not-exist" });

    // Embedded uid does NOT match the document id: teachers/{uid}.uid == uid fails.
    await db.doc(`teachers/${MISMATCH_UID}`).set({ uid: "some-other-uid-entirely", status: "active", classroomId: A_ROOM });

    // Classroom exists and teacher doc points at it, but ownerUid is someone else.
    await db.doc(`teachers/${OWNER_MISMATCH_UID}`)
      .set({ uid: OWNER_MISMATCH_UID, status: "active", classroomId: "classroom-owner-mismatch" });
    await db.doc("classrooms/classroom-owner-mismatch")
      .set({ ownerUid: "somebody-else-entirely", marker: "MISMATCH" });

    // Status is neither active nor a recognized value.
    await db.doc(`teachers/${INVALID_STATUS_UID}`)
      .set({ uid: INVALID_STATUS_UID, status: "pending-review", classroomId: A_ROOM });

    // Server-only collections.
    await db.doc("teacherInvitations/invite-1").set({ email: "x@y.z" });
    await db.doc("classroomLoginCodes/code-1").set({ classroomId: A_ROOM });
    await db.doc("studentLoginThrottle/throttle-1").set({ count: 1 });
    await db.doc("studentAuthUnresolvedLogs/unresolved-1").set({ marker: "unresolved" });
    await db.doc(`studentCredentials/${SHARED_LOGIN_ID}`).set({ hash: "flat" });
  });
}

function teacherCtx(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}

function studentCtx(uid, classroomId, studentId) {
  return testEnv
    .authenticatedContext(uid, { role: "student", classroomId, studentId })
    .firestore();
}

// Each tenant paired with its counterpart, so every row runs A→B and B→A.
const DIRECTIONS = [
  { name: "A owns, B intrudes", owner: A_UID, room: A_ROOM, student: A_STUDENT, intruder: B_UID, otherRoom: B_ROOM },
  { name: "B owns, A intrudes", owner: B_UID, room: B_ROOM, student: B_STUDENT, intruder: A_UID, otherRoom: A_ROOM }
];

describe("Phase 2B Item 10: proposed multi-teacher rules contract", () => {
  test("the checked-in production firestore.rules is byte-identical to its pinned hash", () => {
    const actual = createHash("sha256").update(readFileSync("firestore.rules")).digest("hex");
    assert.equal(
      actual,
      BASELINE_RULES_SHA256,
      "firestore.rules changed during Item 10. Item 10 is tests-only; production rules must not be edited."
    );
  });

  test("STRUCTURAL: the proposed fixture contains no recursive classrooms/{document=**} client allow", () => {
    // Comments in the fixture legitimately DISCUSS the recursive match that was
    // removed, so a naive scan of the raw text produces a false positive. Strip
    // comments first and scan only executable rule statements.
    const stripComments = (text) =>
      text
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");

    const RECURSIVE_CLASSROOMS = /match\s+\/classrooms\/\{\s*document\s*=\s*\*\*\s*\}/;

    const src = stripComments(readFileSync(PROPOSED_RULES_PATH, "utf8"));

    // The exact hole the multi-teacher gate requires removing. The checked-in
    // baseline has it at firestore.rules:21-23; the proposal must not.
    assert.ok(
      !RECURSIVE_CLASSROOMS.test(src),
      "The proposed rules must NOT contain a recursive classrooms/{document=**} match"
    );

    // Every classrooms subcollection must be matched explicitly, so the absence
    // above cannot be satisfied by simply having no classroom rules at all.
    for (const sub of ["students", "transactions", "loginHistory", "studentCredentials"]) {
      assert.ok(
        new RegExp(`match\\s+/${sub}/\\{`).test(src),
        `The proposed rules must match /classrooms/{classroomId}/${sub} explicitly`
      );
    }

    // And prove the assertion above is meaningful by confirming the baseline
    // really does contain what we are asserting the proposal lacks.
    const baseline = stripComments(readFileSync("firestore.rules", "utf8"));
    assert.ok(
      RECURSIVE_CLASSROOMS.test(baseline),
      "Baseline rules were expected to contain the recursive classrooms allow this contract removes"
    );
  });

  for (const d of DIRECTIONS) {
    describe(d.name, () => {
      test("owner reads own teacher document; the other teacher cannot", async () => {
        await assertSucceeds(teacherCtx(d.owner).doc(`teachers/${d.owner}`).get());
        await assertFails(teacherCtx(d.intruder).doc(`teachers/${d.owner}`).get());
      });

      test("teacher documents are never client-writable, even by their owner", async () => {
        await assertFails(
          teacherCtx(d.owner).doc(`teachers/${d.owner}`).set({ status: "active", classroomId: d.room })
        );
        await assertFails(
          teacherCtx(d.owner).doc(`teachers/${d.owner}`).update({ status: "active" })
        );
        await assertFails(teacherCtx(d.owner).doc(`teachers/${d.owner}`).delete());
      });

      test("owner reads owned classroom root; the other teacher is denied", async () => {
        await assertSucceeds(teacherCtx(d.owner).doc(`classrooms/${d.room}`).get());
        await assertFails(teacherCtx(d.intruder).doc(`classrooms/${d.room}`).get());
      });

      test("classroom create and delete are denied even for the owner", async () => {
        await assertFails(
          teacherCtx(d.owner).doc("classrooms/brand-new-room").set({ ownerUid: d.owner })
        );
        await assertFails(teacherCtx(d.owner).doc(`classrooms/${d.room}`).delete());
      });

      test("classroom-root update allows only settings, lastBackupAt, updatedAt", async () => {
        await assertSucceeds(
          teacherCtx(d.owner).doc(`classrooms/${d.room}`).update({
            settings: { theme: "changed" },
            lastBackupAt: "2026-07-25T00:00:00Z",
            updatedAt: "2026-07-25T00:00:00Z"
          })
        );
        // Ownership must not be self-reassignable.
        await assertFails(
          teacherCtx(d.owner).doc(`classrooms/${d.room}`).update({ ownerUid: d.intruder })
        );
        await assertFails(
          teacherCtx(d.owner).doc(`classrooms/${d.room}`).update({ marker: "TAMPERED" })
        );
        // A permitted field mixed with a forbidden one must still deny.
        await assertFails(
          teacherCtx(d.owner).doc(`classrooms/${d.room}`).update({
            settings: { theme: "ok" },
            ownerUid: d.intruder
          })
        );
      });

      test("owner reads and writes owned students, transactions, and login history; other teacher denied", async () => {
        const own = teacherCtx(d.owner);
        const other = teacherCtx(d.intruder);

        await assertSucceeds(own.doc(`classrooms/${d.room}/students/${d.student}`).get());
        await assertSucceeds(
          own.doc(`classrooms/${d.room}/students/${d.student}`).update({ balance: 99 })
        );
        await assertFails(other.doc(`classrooms/${d.room}/students/${d.student}`).get());
        await assertFails(
          other.doc(`classrooms/${d.room}/students/${d.student}`).update({ balance: 1 })
        );

        await assertSucceeds(own.collection(`classrooms/${d.room}/transactions`).get());
        await assertSucceeds(
          own.doc(`classrooms/${d.room}/transactions/tx-new`).set({ amount: 5 })
        );
        await assertFails(other.collection(`classrooms/${d.room}/transactions`).get());

        await assertSucceeds(own.collection(`classrooms/${d.room}/loginHistory`).get());
        await assertFails(other.collection(`classrooms/${d.room}/loginHistory`).get());
      });

      test("owner reads only their scoped auth logs; all client auth-log writes are denied", async () => {
        await assertSucceeds(teacherCtx(d.owner).collection(`studentAuthLogs/${d.room}/logs`).get());
        await assertFails(teacherCtx(d.intruder).collection(`studentAuthLogs/${d.room}/logs`).get());

        await assertFails(
          teacherCtx(d.owner).doc(`studentAuthLogs/${d.room}/logs/forged`).set({ marker: "forged" })
        );
        await assertFails(
          teacherCtx(d.owner).doc(`studentAuthLogs/${d.room}/logs/log-a`).delete()
        );
      });

      test("the active owner is denied read AND write on their own scoped credentials", async () => {
        await assertFails(
          teacherCtx(d.owner).doc(`classrooms/${d.room}/studentCredentials/${SHARED_LOGIN_ID}`).get()
        );
        await assertFails(
          teacherCtx(d.owner).doc(`classrooms/${d.room}/studentCredentials/${SHARED_LOGIN_ID}`).set({ hash: "x" })
        );
      });

      test("LIST/QUERY denials: no cross-tenant enumeration of any subcollection", async () => {
        const other = teacherCtx(d.intruder);
        await assertFails(other.collection(`classrooms/${d.room}/students`).get());
        await assertFails(other.collection(`classrooms/${d.room}/transactions`).get());
        await assertFails(other.collection(`classrooms/${d.room}/loginHistory`).get());
        await assertFails(other.collection(`studentAuthLogs/${d.room}/logs`).get());
      });
    });
  }

  test("collection-level enumeration of teachers and classrooms is denied for every identity", async () => {
    for (const uid of [A_UID, B_UID]) {
      await assertFails(teacherCtx(uid).collection("teachers").get());
      await assertFails(teacherCtx(uid).collection("classrooms").get());
    }
  });

  test("each student reads only their own exact claimed document, and never writes", async () => {
    const aStudent = studentCtx("auth-a-student", A_ROOM, A_STUDENT);
    const bStudent = studentCtx("auth-b-student", B_ROOM, B_STUDENT);

    await assertSucceeds(aStudent.doc(`classrooms/${A_ROOM}/students/${A_STUDENT}`).get());
    await assertSucceeds(bStudent.doc(`classrooms/${B_ROOM}/students/${B_STUDENT}`).get());

    // Cross-tenant, despite identical normalized login ids in both classrooms.
    await assertFails(aStudent.doc(`classrooms/${B_ROOM}/students/${B_STUDENT}`).get());
    await assertFails(bStudent.doc(`classrooms/${A_ROOM}/students/${A_STUDENT}`).get());

    // Writes always denied.
    await assertFails(
      aStudent.doc(`classrooms/${A_ROOM}/students/${A_STUDENT}`).update({ balance: 9999 })
    );

    // Students may not enumerate their classmates.
    await assertFails(aStudent.collection(`classrooms/${A_ROOM}/students`).get());
  });

  test("disabled, missing-teacher-doc, missing-classroom, UID mismatch, owner mismatch, and invalid status each deny independently", async () => {
    // Disabled status.
    await assertFails(teacherCtx(DISABLED_UID).doc(`classrooms/${A_ROOM}`).get());
    await assertFails(teacherCtx(DISABLED_UID).doc(`teachers/${DISABLED_UID}`).get());

    // No teacher document at all.
    await assertFails(teacherCtx(NO_TEACHER_DOC_UID).doc(`classrooms/${A_ROOM}`).get());

    // Teacher doc active, classroom root absent — a DIFFERENT get() branch than
    // the missing-teacher-doc case above.
    await assertFails(
      teacherCtx(NO_CLASSROOM_UID).doc("classrooms/classroom-that-does-not-exist").get()
    );

    // teachers/{uid}.uid does not equal the document id.
    await assertFails(teacherCtx(MISMATCH_UID).doc(`classrooms/${A_ROOM}`).get());
    await assertFails(teacherCtx(MISMATCH_UID).doc(`teachers/${MISMATCH_UID}`).get());

    // Classroom exists, pointer matches, but ownerUid is a third party.
    await assertFails(
      teacherCtx(OWNER_MISMATCH_UID).doc("classrooms/classroom-owner-mismatch").get()
    );

    // Unrecognized status value is not treated as active.
    await assertFails(teacherCtx(INVALID_STATUS_UID).doc(`classrooms/${A_ROOM}`).get());
  });

  test("unauthenticated access is denied everywhere", async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(anon.doc(`classrooms/${A_ROOM}`).get());
    await assertFails(anon.doc(`teachers/${A_UID}`).get());
    await assertFails(anon.collection(`classrooms/${A_ROOM}/students`).get());
  });

  test("server-only collections deny every client identity", async () => {
    const paths = [
      "teacherInvitations/invite-1",
      "classroomLoginCodes/code-1",
      "studentLoginThrottle/throttle-1",
      "studentAuthUnresolvedLogs/unresolved-1",
      `studentCredentials/${SHARED_LOGIN_ID}`
    ];
    for (const uid of [A_UID, B_UID]) {
      const ctx = teacherCtx(uid);
      for (const p of paths) {
        await assertFails(ctx.doc(p).get());
        await assertFails(ctx.doc(p).set({ tampered: true }));
      }
    }
  });
  test("teachers/{uid}.uid must equal the document id, or the identity confers nothing", async () => {
    // Seeded with uid: "some-other-uid-entirely" at document id MISMATCH_UID.
    await assertFails(teacherCtx(MISMATCH_UID).doc(`teachers/${MISMATCH_UID}`).get());
    await assertFails(teacherCtx(MISMATCH_UID).doc(`classrooms/${A_ROOM}`).get());
    await assertFails(teacherCtx(MISMATCH_UID).collection(`classrooms/${A_ROOM}/students`).get());
  });

  test("scoped classroom credentials deny the ACTIVE OWNER, both read and write, in both directions", async () => {
    // This is the specific assertion MULTI_TEACHER_ARCHITECTURE_PLAN.md calls
    // out: it is what the deleted recursive classrooms/** allow would have
    // granted, and it defeats the login lockout if it regresses.
    for (const [uid, room] of [[A_UID, A_ROOM], [B_UID, B_ROOM]]) {
      const ctx = teacherCtx(uid);
      await assertFails(ctx.doc(`classrooms/${room}/studentCredentials/${SHARED_LOGIN_ID}`).get());
      await assertFails(ctx.collection(`classrooms/${room}/studentCredentials`).get());
      await assertFails(
        ctx.doc(`classrooms/${room}/studentCredentials/${SHARED_LOGIN_ID}`).set({ pinHash: "x" })
      );
      await assertFails(
        ctx.doc(`classrooms/${room}/studentCredentials/${SHARED_LOGIN_ID}`).update({ failedAttempts: 0 })
      );
      await assertFails(
        ctx.doc(`classrooms/${room}/studentCredentials/${SHARED_LOGIN_ID}`).delete()
      );
    }
  });

  test("students cannot read scoped credentials or auth logs in their own or another classroom", async () => {
    const aStudent = studentCtx("auth-a-student", A_ROOM, A_STUDENT);
    await assertFails(aStudent.doc(`classrooms/${A_ROOM}/studentCredentials/${SHARED_LOGIN_ID}`).get());
    await assertFails(aStudent.collection(`studentAuthLogs/${A_ROOM}/logs`).get());
    await assertFails(aStudent.collection(`studentAuthLogs/${B_ROOM}/logs`).get());
    await assertFails(aStudent.doc(`classrooms/${A_ROOM}`).get());
    await assertFails(aStudent.doc(`teachers/${A_UID}`).get());
  });

  test("the legacy morganBank store stays restricted to the original hardcoded teacher", async () => {
    // Deliberately NOT broadened to all active teachers.
    await assertFails(teacherCtx(A_UID).doc("morganBank/classroomData").get());
    await assertFails(teacherCtx(B_UID).doc("morganBank/classroomData").get());
    await assertSucceeds(
      teacherCtx("YkYUzIzy0aW7roolM1VaLcIJPuN2").doc("morganBank/classroomData").get()
    );
  });
});
