// Phase 0 baseline tests for the CURRENT (v1.1) production firestore.rules.
//
// These tests intentionally exercise today's authorization model exactly as
// deployed — a single hardcoded teacher UID and a flat, non-classroom-scoped
// studentAuthLogs collection — so that any future rules change (Phase 2+)
// can be diffed against a known-good baseline. Nothing here changes rules
// behavior; it only pins it down with automated coverage that didn't exist
// before.
//
// Run via `npm run test:rules` from the repo root, which wraps the
// Firestore emulator (`firebase emulators:exec`) around `node --test`.

import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'

const TEACHER_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'
const OTHER_AUTHENTICATED_UID = 'some-other-authenticated-uid'
const CLASSROOM_ID = 'morgan'
const STUDENT_ID = '1'
const OTHER_STUDENT_ID = '2'
const OTHER_CLASSROOM_ID = 'other-classroom'

let testEnv

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'morgan-bank-rules-test',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
})

after(async () => {
  await testEnv?.cleanup()
})

async function seedBaselineData() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await db.doc('morganBank/classroomData').set({
      students: [{ id: STUDENT_ID, name: 'Test Student', balance: 10 }],
      transactions: [],
      loginHistory: [],
      settings: {},
    })
    await db
      .doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`)
      .set({ id: STUDENT_ID, name: 'Test Student', balance: 10, frozen: false, transactions: [] })
    await db
      .doc(`classrooms/${CLASSROOM_ID}/students/${OTHER_STUDENT_ID}`)
      .set({ id: OTHER_STUDENT_ID, name: 'Other Student', balance: 5, frozen: false, transactions: [] })
    await db
      .doc(`classrooms/${OTHER_CLASSROOM_ID}/students/${STUDENT_ID}`)
      .set({ id: STUDENT_ID, name: 'Different Classroom Student', balance: 0, frozen: false, transactions: [] })
    await db.doc('studentAuthLogs/log-1').set({
      loginId: 'test-student',
      success: true,
      timestamp: Date.now(),
    })
    await db.doc('studentCredentials/test-student').set({
      schemaVersion: 1,
      authUid: 'student-auth-uid',
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
      pinHash: 'not-a-real-hash',
      active: true,
      failedAttempts: 0,
      lockedUntil: null,
    })
  })
}

test('seed baseline fixture data (bypassing rules)', seedBaselineData)

describe('Teacher (existing hardcoded TEACHER_UID)', () => {
  test('can read morganBank/classroomData', async () => {
    const db = testEnv.authenticatedContext(TEACHER_UID).firestore()
    await assertSucceeds(db.doc('morganBank/classroomData').get())
  })

  test('can write morganBank/classroomData', async () => {
    const db = testEnv.authenticatedContext(TEACHER_UID).firestore()
    await assertSucceeds(
      db.doc('morganBank/classroomData').set(
        { students: [], transactions: [], loginHistory: [], settings: {} },
        { merge: true },
      ),
    )
  })

  test('can read the classroom student mirror document', async () => {
    const db = testEnv.authenticatedContext(TEACHER_UID).firestore()
    await assertSucceeds(
      db.doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`).get(),
    )
  })

  test('can write the classroom student mirror document', async () => {
    const db = testEnv.authenticatedContext(TEACHER_UID).firestore()
    await assertSucceeds(
      db
        .doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`)
        .set({ id: STUDENT_ID, name: 'Test Student', balance: 15, frozen: false, transactions: [] }),
    )
  })

  test('can read studentAuthLogs', async () => {
    const db = testEnv.authenticatedContext(TEACHER_UID).firestore()
    await assertSucceeds(db.doc('studentAuthLogs/log-1').get())
  })
})

describe('Unauthorized authenticated user (not the teacher, not a student token)', () => {
  test('cannot read morganBank/classroomData', async () => {
    const db = testEnv.authenticatedContext(OTHER_AUTHENTICATED_UID).firestore()
    await assertFails(db.doc('morganBank/classroomData').get())
  })

  test('cannot write morganBank/classroomData', async () => {
    const db = testEnv.authenticatedContext(OTHER_AUTHENTICATED_UID).firestore()
    await assertFails(
      db.doc('morganBank/classroomData').set({ students: [] }, { merge: true }),
    )
  })

  test('cannot read classrooms data', async () => {
    const db = testEnv.authenticatedContext(OTHER_AUTHENTICATED_UID).firestore()
    await assertFails(
      db.doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`).get(),
    )
  })

  test('cannot write classrooms data', async () => {
    const db = testEnv.authenticatedContext(OTHER_AUTHENTICATED_UID).firestore()
    await assertFails(
      db
        .doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`)
        .set({ id: STUDENT_ID, name: 'Hacked', balance: 999999, frozen: false, transactions: [] }),
    )
  })

  test('cannot read studentAuthLogs', async () => {
    const db = testEnv.authenticatedContext(OTHER_AUTHENTICATED_UID).firestore()
    await assertFails(db.doc('studentAuthLogs/log-1').get())
  })

  test('cannot read studentCredentials', async () => {
    const db = testEnv.authenticatedContext(OTHER_AUTHENTICATED_UID).firestore()
    await assertFails(db.doc('studentCredentials/test-student').get())
  })
})

describe('Student (custom-token claims: role/classroomId/studentId)', () => {
  function studentContext(uid, claims) {
    return testEnv.authenticatedContext(uid, claims).firestore()
  }

  test('can read only their own student document when claims match', async () => {
    const db = studentContext('student-auth-uid', {
      role: 'student',
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
    })
    await assertSucceeds(
      db.doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`).get(),
    )
  })

  test('cannot read another student\'s document in the same classroom', async () => {
    const db = studentContext('student-auth-uid', {
      role: 'student',
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
    })
    await assertFails(
      db.doc(`classrooms/${CLASSROOM_ID}/students/${OTHER_STUDENT_ID}`).get(),
    )
  })

  test('cannot read a same-numbered student document in another classroom', async () => {
    const db = studentContext('student-auth-uid', {
      role: 'student',
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
    })
    await assertFails(
      db.doc(`classrooms/${OTHER_CLASSROOM_ID}/students/${STUDENT_ID}`).get(),
    )
  })

  test('cannot write their own student profile document', async () => {
    const db = studentContext('student-auth-uid', {
      role: 'student',
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
    })
    await assertFails(
      db
        .doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`)
        .set({ id: STUDENT_ID, name: 'Test Student', balance: 999999, frozen: false, transactions: [] }),
    )
  })

  test('cannot read teacher-only classroom-level data', async () => {
    const db = studentContext('student-auth-uid', {
      role: 'student',
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
    })
    // The classroom document itself (parent of the students subcollection)
    // is only readable by isTeacher() under current rules.
    await assertFails(db.doc(`classrooms/${CLASSROOM_ID}`).get())
  })

  test('cannot read morganBank/classroomData', async () => {
    const db = studentContext('student-auth-uid', {
      role: 'student',
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
    })
    await assertFails(db.doc('morganBank/classroomData').get())
  })

  test('cannot read studentAuthLogs', async () => {
    const db = studentContext('student-auth-uid', {
      role: 'student',
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
    })
    await assertFails(db.doc('studentAuthLogs/log-1').get())
  })

  test('cannot read studentCredentials', async () => {
    const db = studentContext('student-auth-uid', {
      role: 'student',
      classroomId: CLASSROOM_ID,
      studentId: STUDENT_ID,
    })
    await assertFails(db.doc('studentCredentials/test-student').get())
  })
})

describe('Unauthenticated user', () => {
  test('cannot read morganBank/classroomData', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(db.doc('morganBank/classroomData').get())
  })

  test('cannot write morganBank/classroomData', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(
      db.doc('morganBank/classroomData').set({ students: [] }, { merge: true }),
    )
  })

  test('cannot read classrooms data', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(
      db.doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`).get(),
    )
  })

  test('cannot write classrooms data', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(
      db
        .doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`)
        .set({ id: STUDENT_ID, name: 'Hacked', balance: 999999, frozen: false, transactions: [] }),
    )
  })

  test('cannot read studentAuthLogs', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(db.doc('studentAuthLogs/log-1').get())
  })

  test('cannot read studentCredentials', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(db.doc('studentCredentials/test-student').get())
  })
})
