// Phase 3 Item 9: bridge-rules behavioral contract.
//
// Loads the checksum-pinned bridge artifact explicitly. It never substitutes
// that artifact for firestore.rules and never deploys either file.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'

const BRIDGE_RULES_PATH = 'firestore.phase3.bridge.rules'
const BRIDGE_RULES_SHA256 =
  '4bf76a85e576a1d5b30573c3c3d5eba0d3561fb9d9a19ac14ac6382dced8d7f0'
const PRODUCTION_RULES_SHA256 =
  '0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50'

// Teacher A is the existing hardcoded teacher, so the same fixture proves
// both reciprocal V2 ownership and the narrow legacy bridge exception.
const A_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'
const B_UID = 'teacher-b-uid'
const A_ROOM = 'classroom-a'
const B_ROOM = 'classroom-b'
const A_STUDENT = '1'
const B_STUDENT = '2'
const SHARED_LOGIN_ID = 'shared-login'

const DISABLED_UID = 'teacher-disabled'
const MISSING_TEACHER_UID = 'teacher-missing'
const MISSING_CLASSROOM_UID = 'teacher-missing-classroom'
const UID_MISMATCH_UID = 'teacher-uid-mismatch'
const OWNER_MISMATCH_UID = 'teacher-owner-mismatch'
const INVALID_STATUS_UID = 'teacher-invalid-status'

let testEnv

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-morgan-bank-phase3-rules-test',
    firestore: {
      rules: readFileSync(BRIDGE_RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
})

after(async () => {
  await testEnv?.cleanup()
})

beforeEach(async () => {
  await testEnv.clearFirestore()
  await seed()
})

async function seed() {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore()

    await db.doc(`teachers/${A_UID}`).set({
      uid: A_UID,
      status: 'active',
      classroomId: A_ROOM,
    })
    await db.doc(`teachers/${B_UID}`).set({
      uid: B_UID,
      status: 'active',
      classroomId: B_ROOM,
    })
    await db.doc(`classrooms/${A_ROOM}`).set({ ownerUid: A_UID, marker: 'A' })
    await db.doc(`classrooms/${B_ROOM}`).set({ ownerUid: B_UID, marker: 'B' })

    for (const [room, student, marker] of [
      [A_ROOM, A_STUDENT, 'A'],
      [B_ROOM, B_STUDENT, 'B'],
    ]) {
      await db.doc(`classrooms/${room}/students/${student}`).set({
        id: student,
        name: `${marker} student`,
        balance: 10,
        frozen: false,
        transactions: [],
      })
      await db.doc(`classrooms/${room}/transactions/tx-${marker}`).set({ marker })
      await db.doc(`classrooms/${room}/loginHistory/history-${marker}`).set({ marker })
      await db.doc(`classrooms/${room}/studentCredentials/${SHARED_LOGIN_ID}`)
        .set({ pinHash: `${marker}-secret`, classroomId: room, studentId: student })
      await db.doc(`studentAuthLogs/${room}/logs/log-${marker}`).set({ marker })
      await db.doc(`classrooms/${room}/private/internal-${marker}`).set({ marker })
    }

    await db.doc('morganBank/classroomData').set({ marker: 'legacy' })
    await db.doc('classrooms/morgan/students/legacy-student').set({
      id: 'legacy-student',
      name: 'Legacy student',
    })
    await db.doc('studentAuthLogs/flat-log').set({ marker: 'legacy-flat' })
    await db.doc(`studentCredentials/${SHARED_LOGIN_ID}`).set({ pinHash: 'flat-secret' })

    await db.doc(`teachers/${DISABLED_UID}`).set({
      uid: DISABLED_UID,
      status: 'disabled',
      classroomId: A_ROOM,
    })
    await db.doc(`teachers/${MISSING_CLASSROOM_UID}`).set({
      uid: MISSING_CLASSROOM_UID,
      status: 'active',
      classroomId: 'phantom-room',
    })
    // A subcollection can exist beneath a missing classroom root. This makes
    // the missing-classroom denial non-vacuous.
    await db.doc('classrooms/phantom-room/students/phantom-student').set({
      id: 'phantom-student',
    })
    await db.doc(`teachers/${UID_MISMATCH_UID}`).set({
      uid: 'different-embedded-uid',
      status: 'active',
      classroomId: A_ROOM,
    })
    await db.doc(`teachers/${OWNER_MISMATCH_UID}`).set({
      uid: OWNER_MISMATCH_UID,
      status: 'active',
      classroomId: 'owner-mismatch-room',
    })
    await db.doc('classrooms/owner-mismatch-room').set({ ownerUid: 'someone-else' })
    await db.doc(`teachers/${INVALID_STATUS_UID}`).set({
      uid: INVALID_STATUS_UID,
      status: 'pending',
      classroomId: A_ROOM,
    })

    await db.doc('teacherInvitations/invite').set({ status: 'active' })
    await db.doc('classroomLoginCodes/code').set({ classroomId: A_ROOM })
    await db.doc('studentLoginThrottle/bucket').set({ count: 1 })
    await db.doc('studentAuthUnresolvedLogs/log').set({ reason: 'unknown' })
    await db.doc('unenumerated/path').set({ marker: 'deny' })
  })
}

function teacher(uid) {
  return testEnv.authenticatedContext(uid).firestore()
}

function student(uid, classroomId, studentId) {
  return testEnv.authenticatedContext(uid, {
    role: 'student',
    classroomId,
    studentId,
  }).firestore()
}

const DIRECTIONS = [
  {
    name: 'Teacher A owns Classroom A; Teacher B is foreign',
    owner: A_UID,
    intruder: B_UID,
    room: A_ROOM,
    student: A_STUDENT,
    tx: 'tx-A',
    history: 'history-A',
    log: 'log-A',
  },
  {
    name: 'Teacher B owns Classroom B; Teacher A is foreign',
    owner: B_UID,
    intruder: A_UID,
    room: B_ROOM,
    student: B_STUDENT,
    tx: 'tx-B',
    history: 'history-B',
    log: 'log-B',
  },
]

async function denyAllDocumentVerbs(db, collectionPath, existingId, suffix) {
  const existing = db.doc(`${collectionPath}/${existingId}`)
  const forged = db.doc(`${collectionPath}/forged-${suffix}`)
  await assertFails(existing.get())
  await assertFails(db.collection(collectionPath).get())
  await assertFails(forged.set({ forged: true }))
  await assertFails(existing.update({ forged: true }))
  await assertFails(existing.delete())
}

async function denyAllWrites(db, path, suffix) {
  const existing = db.doc(path)
  const slash = path.lastIndexOf('/')
  const collection = path.slice(0, slash)
  await assertFails(db.doc(`${collection}/forged-${suffix}`).set({ forged: true }))
  await assertFails(existing.update({ forged: true }))
  await assertFails(existing.delete())
}

describe('Phase 3 Item 9 bridge rules', () => {
  test('bridge and production rules artifacts match their pinned checksums', () => {
    const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
    assert.equal(digest(BRIDGE_RULES_PATH), BRIDGE_RULES_SHA256)
    assert.equal(digest('firestore.rules'), PRODUCTION_RULES_SHA256)
  })

  test('bridge structurally removes recursive classroom access and enumerates safe surfaces', () => {
    const executable = readFileSync(BRIDGE_RULES_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    assert.doesNotMatch(executable, /match\s+\/classrooms\/\{\s*document\s*=\s*\*\*\s*\}/)
    for (const surface of ['students', 'transactions', 'loginHistory', 'studentCredentials']) {
      assert.match(executable, new RegExp(`match\\s+/${surface}/\\{`))
    }
    assert.match(executable, /match \/studentAuthLogs\/\{logId\}/)
    assert.match(executable, /match \/studentAuthLogs\/\{classroomId\}\/logs\/\{logId\}/)
  })

  for (const direction of DIRECTIONS) {
    describe(direction.name, () => {
      test('active reciprocal owner can read only their scoped verification surfaces', async () => {
        const db = teacher(direction.owner)
        await assertSucceeds(db.doc(`teachers/${direction.owner}`).get())
        await assertSucceeds(db.doc(`classrooms/${direction.room}`).get())
        for (const [collection, id] of [
          ['students', direction.student],
          ['transactions', direction.tx],
          ['loginHistory', direction.history],
        ]) {
          await assertSucceeds(db.doc(`classrooms/${direction.room}/${collection}/${id}`).get())
          await assertSucceeds(db.collection(`classrooms/${direction.room}/${collection}`).get())
        }
        await assertSucceeds(db.doc(`studentAuthLogs/${direction.room}/logs/${direction.log}`).get())
        await assertSucceeds(db.collection(`studentAuthLogs/${direction.room}/logs`).get())
      })

      test('foreign teacher is denied every scoped read and list', async () => {
        const db = teacher(direction.intruder)
        await assertFails(db.doc(`teachers/${direction.owner}`).get())
        await assertFails(db.doc(`classrooms/${direction.room}`).get())
        await assertFails(db.collection('classrooms').get())
        await assertFails(db.collection('teachers').get())
        for (const [collection, id] of [
          ['students', direction.student],
          ['transactions', direction.tx],
          ['loginHistory', direction.history],
        ]) {
          await assertFails(db.doc(`classrooms/${direction.room}/${collection}/${id}`).get())
          await assertFails(db.collection(`classrooms/${direction.room}/${collection}`).get())
        }
        await assertFails(db.doc(`studentAuthLogs/${direction.room}/logs/${direction.log}`).get())
        await assertFails(db.collection(`studentAuthLogs/${direction.room}/logs`).get())
      })

      test('bridge denies every scoped browser mutation, including student create and delete', async () => {
        const db = teacher(direction.owner)
        await assertFails(db.doc(`teachers/${direction.owner}`).update({ classroomId: B_ROOM }))
        await assertFails(db.doc(`teachers/${direction.owner}`).delete())
        await assertFails(db.doc(`teachers/forged-${direction.room}`).set({
          uid: direction.owner,
          status: 'active',
          classroomId: direction.room,
        }))
        await assertFails(db.doc(`classrooms/${direction.room}`).update({ ownerUid: direction.intruder }))
        await assertFails(db.doc(`classrooms/${direction.room}`).delete())
        await assertFails(db.doc(`classrooms/forged-${direction.room}`).set({ ownerUid: direction.owner }))
        await denyAllWrites(
          db,
          `classrooms/${direction.room}/students/${direction.student}`,
          `${direction.room}-student`,
        )
        await denyAllWrites(
          db,
          `classrooms/${direction.room}/transactions/${direction.tx}`,
          `${direction.room}-tx`,
        )
        await denyAllWrites(
          db,
          `classrooms/${direction.room}/loginHistory/${direction.history}`,
          `${direction.room}-history`,
        )
        await denyAllWrites(
          db,
          `studentAuthLogs/${direction.room}/logs/${direction.log}`,
          `${direction.room}-log`,
        )
      })
    })
  }

  test('legacy hardcoded teacher keeps only required aggregate and flat-log access', async () => {
    const legacy = teacher(A_UID)
    const other = teacher(B_UID)
    await assertSucceeds(legacy.doc('morganBank/classroomData').get())
    await assertSucceeds(legacy.doc('morganBank/classroomData').update({ marker: 'updated' }))
    await assertSucceeds(legacy.doc('morganBank/maintenance-note').set({ marker: 'created' }))
    await assertSucceeds(legacy.doc('morganBank/maintenance-note').delete())
    await assertSucceeds(legacy.doc('studentAuthLogs/flat-log').get())
    await assertSucceeds(legacy.collection('studentAuthLogs').get())
    await assertFails(legacy.doc('studentAuthLogs/flat-log').update({ marker: 'tampered' }))
    await assertFails(legacy.doc('studentAuthLogs/flat-log').delete())
    await assertFails(legacy.doc('studentAuthLogs/forged-flat').set({ marker: 'forged' }))

    await assertFails(other.doc('morganBank/classroomData').get())
    await assertFails(other.doc('morganBank/classroomData').set({ marker: 'forged' }))
    await assertFails(other.doc('studentAuthLogs/flat-log').get())
    await assertFails(other.collection('studentAuthLogs').get())

    // The broad legacy classrooms/** teacher grant is intentionally gone.
    await assertFails(legacy.doc('classrooms/morgan/students/legacy-student').get())
  })

  test('students retain exact self-read and no list or write permission', async () => {
    const identities = [
      student('student-auth-a', A_ROOM, A_STUDENT),
      student('student-auth-b', B_ROOM, B_STUDENT),
      student('legacy-student-auth', 'morgan', 'legacy-student'),
    ]
    const ownPaths = [
      `classrooms/${A_ROOM}/students/${A_STUDENT}`,
      `classrooms/${B_ROOM}/students/${B_STUDENT}`,
      'classrooms/morgan/students/legacy-student',
    ]

    for (let index = 0; index < identities.length; index += 1) {
      const db = identities[index]
      await assertSucceeds(db.doc(ownPaths[index]).get())
      await assertFails(db.doc(ownPaths[index]).update({ balance: 999 }))
      await assertFails(db.doc(ownPaths[index]).delete())
      const collection = ownPaths[index].slice(0, ownPaths[index].lastIndexOf('/'))
      await assertFails(db.collection(collection).get())
      await assertFails(db.doc(`${collection}/forged`).set({ id: 'forged' }))
      for (const foreignPath of ownPaths.filter((_, pathIndex) => pathIndex !== index)) {
        await assertFails(db.doc(foreignPath).get())
      }
    }
  })

  test('students cannot read either authentication-log shape', async () => {
    const students = [
      student('student-auth-a', A_ROOM, A_STUDENT),
      student('student-auth-b', B_ROOM, B_STUDENT),
    ]
    for (const db of students) {
      await assertFails(db.doc('studentAuthLogs/flat-log').get())
      await assertFails(db.collection('studentAuthLogs').get())
      for (const [room, log] of [[A_ROOM, 'log-A'], [B_ROOM, 'log-B']]) {
        await assertFails(db.doc(`studentAuthLogs/${room}/logs/${log}`).get())
        await assertFails(db.collection(`studentAuthLogs/${room}/logs`).get())
      }
    }
  })

  test('disabled, missing, mismatched, and invalid foundations fail closed independently', async () => {
    await assertFails(teacher(DISABLED_UID).doc(`classrooms/${A_ROOM}`).get())
    await assertFails(teacher(DISABLED_UID).doc(`teachers/${DISABLED_UID}`).get())
    await assertFails(teacher(MISSING_TEACHER_UID).doc(`classrooms/${A_ROOM}`).get())
    await assertFails(
      teacher(MISSING_CLASSROOM_UID)
        .doc('classrooms/phantom-room/students/phantom-student')
        .get(),
    )
    await assertFails(teacher(UID_MISMATCH_UID).doc(`teachers/${UID_MISMATCH_UID}`).get())
    await assertFails(teacher(UID_MISMATCH_UID).doc(`classrooms/${A_ROOM}`).get())
    await assertFails(
      teacher(OWNER_MISMATCH_UID).doc('classrooms/owner-mismatch-room').get(),
    )
    await assertFails(teacher(INVALID_STATUS_UID).doc(`classrooms/${A_ROOM}`).get())
  })

  test('flat and scoped credentials deny every verb to every client identity', async () => {
    const identities = [
      teacher(A_UID),
      teacher(B_UID),
      student('student-auth-a', A_ROOM, A_STUDENT),
      student('student-auth-b', B_ROOM, B_STUDENT),
      testEnv.unauthenticatedContext().firestore(),
    ]
    for (const db of identities) {
      await denyAllDocumentVerbs(db, 'studentCredentials', SHARED_LOGIN_ID, 'flat')
      for (const room of [A_ROOM, B_ROOM]) {
        await denyAllDocumentVerbs(
          db,
          `classrooms/${room}/studentCredentials`,
          SHARED_LOGIN_ID,
          room,
        )
      }
    }
  })

  test('invitations, code indexes, throttles, unresolved logs, and unenumerated paths deny all clients', async () => {
    const paths = [
      'teacherInvitations/invite',
      'classroomLoginCodes/code',
      'studentLoginThrottle/bucket',
      'studentAuthUnresolvedLogs/log',
      'unenumerated/path',
      `classrooms/${A_ROOM}/private/internal-A`,
      `classrooms/${B_ROOM}/private/internal-B`,
    ]
    const identities = [
      teacher(A_UID),
      teacher(B_UID),
      student('student-auth-a', A_ROOM, A_STUDENT),
      testEnv.unauthenticatedContext().firestore(),
    ]
    for (const db of identities) {
      for (const path of paths) {
        const slash = path.lastIndexOf('/')
        await denyAllDocumentVerbs(
          db,
          path.slice(0, slash),
          path.slice(slash + 1),
          'sensitive',
        )
      }
    }
  })

  test('anonymous clients are denied all representative legacy and scoped access', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    for (const path of [
      'morganBank/classroomData',
      'studentAuthLogs/flat-log',
      `teachers/${A_UID}`,
      `classrooms/${A_ROOM}`,
      `classrooms/${A_ROOM}/students/${A_STUDENT}`,
      `classrooms/${A_ROOM}/transactions/tx-A`,
      `classrooms/${A_ROOM}/loginHistory/history-A`,
      `studentAuthLogs/${A_ROOM}/logs/log-A`,
    ]) {
      await assertFails(db.doc(path).get())
    }
  })
})
