// Phase 3 Item 10: final-rules behavioral contract.
//
// Loads the checksum-pinned final candidate explicitly. It never substitutes
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

const FINAL_RULES_PATH = 'firestore.phase3.final.rules'
const FINAL_RULES_SHA256 =
  '414ab5cad328b4b254fe4397ec891f0b7639548c324d2ae0ee74c8db0a9639f3'
const PRODUCTION_RULES_SHA256 =
  '0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50'

const A_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'
const B_UID = 'teacher-b-uid'
const A_ROOM = 'classroom-a'
const B_ROOM = 'classroom-b'
const A_STUDENT = '1'
const B_STUDENT = '2'
const A_TX = '1001'
const B_TX = '1002'
const A_HISTORY = '2001'
const B_HISTORY = '2002'
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
      rules: readFileSync(FINAL_RULES_PATH, 'utf8'),
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

function studentBody(id, marker) {
  return {
    id: Number(id),
    name: `${marker} student`,
    balance: 10,
    frozen: false,
    transactions: [transactionBody(marker === 'A' ? A_TX : B_TX, id, marker)],
  }
}

function transactionBody(id, studentId, marker) {
  return {
    id: Number(id),
    date: '2026-07-27T12:00:00.000Z',
    studentId: Number(studentId),
    studentName: `${marker} student`,
    type: 'Add',
    amount: 10,
    reason: 'Work',
    memo: '',
    category: 'Class',
    status: 'Pending',
    source: 'Teacher',
  }
}

function historyBody(id, studentId, marker) {
  return {
    id: Number(id),
    date: '2026-07-27T12:00:00.000Z',
    studentId: studentId === null ? null : Number(studentId),
    studentName: studentId === null ? 'Unknown student' : `${marker} student`,
    result: 'Success',
    note: '',
  }
}

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

    for (const [room, owner, student, tx, history, marker] of [
      [A_ROOM, A_UID, A_STUDENT, A_TX, A_HISTORY, 'A'],
      [B_ROOM, B_UID, B_STUDENT, B_TX, B_HISTORY, 'B'],
    ]) {
      await db.doc(`classrooms/${room}`).set({
        ownerUid: owner,
        name: `${marker} classroom`,
        version: 1,
        settings: { theme: marker.toLowerCase() },
        lastBackupAt: null,
        updatedAt: 'server-owned-original',
      })
      await db.doc(`classrooms/${room}/students/${student}`).set(
        studentBody(student, marker),
      )
      await db.doc(`classrooms/${room}/transactions/${tx}`).set(
        transactionBody(tx, student, marker),
      )
      await db.doc(`classrooms/${room}/loginHistory/${history}`).set(
        historyBody(history, student, marker),
      )
      await db.doc(`classrooms/${room}/studentCredentials/${SHARED_LOGIN_ID}`).set({
        classroomId: room,
        studentId: student,
        pinHash: `${marker}-secret`,
      })
      await db.doc(`studentAuthLogs/${room}/logs/log-${marker}`).set({ marker })
      await db.doc(`classrooms/${room}/private/internal-${marker}`).set({ marker })
    }

    await db.doc('morganBank/classroomData').set({ marker: 'legacy' })
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
    await db.doc('classrooms/phantom-room/students/3').set(studentBody('3', 'phantom'))
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
    owner: A_UID,
    intruder: B_UID,
    room: A_ROOM,
    student: A_STUDENT,
    tx: A_TX,
    history: A_HISTORY,
    marker: 'A',
  },
  {
    owner: B_UID,
    intruder: A_UID,
    room: B_ROOM,
    student: B_STUDENT,
    tx: B_TX,
    history: B_HISTORY,
    marker: 'B',
  },
]

async function denyAllDocumentVerbs(db, collectionPath, existingId, suffix) {
  const existing = db.doc(`${collectionPath}/${existingId}`)
  await assertFails(existing.get())
  await assertFails(db.collection(collectionPath).get())
  await assertFails(db.doc(`${collectionPath}/forged-${suffix}`).set({ forged: true }))
  await assertFails(existing.update({ forged: true }))
  await assertFails(existing.delete())
}

describe('Phase 3 Item 10 final rules', () => {
  test('final and production artifacts match their pins and no recursive classroom allow exists', () => {
    const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
    assert.equal(digest(FINAL_RULES_PATH), FINAL_RULES_SHA256)
    assert.equal(digest('firestore.rules'), PRODUCTION_RULES_SHA256)

    const executable = readFileSync(FINAL_RULES_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    assert.doesNotMatch(executable, /match\s+\/classrooms\/\{\s*document\s*=\s*\*\*\s*\}/)
    for (const surface of ['students', 'transactions', 'loginHistory', 'studentCredentials']) {
      assert.match(executable, new RegExp(`match\\s+/${surface}/\\{`))
    }
    assert.match(executable, /match \/studentAuthLogs\/\{logId\}/)
    assert.match(executable, /match \/studentAuthLogs\/\{classroomId\}\/logs\/\{logId\}/)
    assert.doesNotMatch(executable, /\bexists\s*\(/)
  })

  for (const direction of DIRECTIONS) {
    test(`${direction.marker}: reciprocal owner reads only their tenant; foreign teacher is denied`, async () => {
      const own = teacher(direction.owner)
      const other = teacher(direction.intruder)

      await assertSucceeds(own.doc(`teachers/${direction.owner}`).get())
      await assertSucceeds(own.doc(`classrooms/${direction.room}`).get())
      await assertSucceeds(own.doc(`classrooms/${direction.room}/students/${direction.student}`).get())
      await assertSucceeds(own.collection(`classrooms/${direction.room}/students`).get())
      await assertSucceeds(own.doc(`classrooms/${direction.room}/transactions/${direction.tx}`).get())
      await assertSucceeds(own.collection(`classrooms/${direction.room}/transactions`).get())
      await assertSucceeds(own.doc(`classrooms/${direction.room}/loginHistory/${direction.history}`).get())
      await assertSucceeds(own.collection(`classrooms/${direction.room}/loginHistory`).get())

      await assertFails(other.doc(`teachers/${direction.owner}`).get())
      await assertFails(other.doc(`classrooms/${direction.room}`).get())
      await assertFails(other.collection(`classrooms/${direction.room}/students`).get())
      await assertFails(other.collection(`classrooms/${direction.room}/transactions`).get())
      await assertFails(other.collection(`classrooms/${direction.room}/loginHistory`).get())
      await assertFails(other.collection(`studentAuthLogs/${direction.room}/logs`).get())
      await assertFails(other.doc(`classrooms/${direction.room}`).update({
        settings: { theme: 'foreign' },
      }))
      await assertFails(other.doc(
        `classrooms/${direction.room}/students/${direction.student}`,
      ).update({ balance: 999 }))
      const foreignTransactionId = direction.marker === 'A' ? '1301' : '1302'
      await assertFails(other.doc(
        `classrooms/${direction.room}/transactions/${foreignTransactionId}`,
      ).set(transactionBody(foreignTransactionId, direction.student, direction.marker)))
      const foreignHistoryId = direction.marker === 'A' ? '2301' : '2302'
      await assertFails(other.doc(
        `classrooms/${direction.room}/loginHistory/${foreignHistoryId}`,
      ).set(historyBody(foreignHistoryId, direction.student, direction.marker)))
      await assertFails(other.doc(
        `classrooms/${direction.room}/loginHistory/${direction.history}`,
      ).delete())
    })

    test(`${direction.marker}: root writes preserve required mutable fields and their types`, async () => {
      const own = teacher(direction.owner)
      await assertSucceeds(own.doc(`classrooms/${direction.room}`).update({
        settings: { theme: 'changed' },
        lastBackupAt: '2026-07-27T13:00:00.000Z',
        updatedAt: '2026-07-27T13:00:00.000Z',
      }))
      await assertSucceeds(own.doc(`classrooms/${direction.room}`).update({
        lastBackupAt: new Date('2026-07-27T13:30:00.000Z'),
        updatedAt: '2026-07-27T13:30:00.000Z',
      }))

      const completeRoot = {
        ownerUid: direction.owner,
        name: `${direction.marker} classroom`,
        version: 1,
        settings: { theme: 'changed' },
        lastBackupAt: null,
        updatedAt: '2026-07-27T14:00:00.000Z',
      }
      for (const field of ['settings', 'lastBackupAt', 'updatedAt']) {
        const missingField = { ...completeRoot }
        delete missingField[field]
        await assertFails(own.doc(`classrooms/${direction.room}`).set(missingField))
      }
      await assertFails(own.doc(`classrooms/${direction.room}`).update({ settings: 'not-a-map' }))
      await assertFails(own.doc(`classrooms/${direction.room}`).update({ lastBackupAt: 123 }))
      await assertFails(own.doc(`classrooms/${direction.room}`).update({ updatedAt: false }))
      await assertFails(own.doc(`classrooms/${direction.room}`).update({ ownerUid: direction.intruder }))
      await assertFails(own.doc(`classrooms/${direction.room}`).update({ name: 'renamed' }))
      await assertFails(own.doc(`classrooms/${direction.room}`).delete())
      await assertFails(own.doc(`classrooms/forged-${direction.room}`).set({ ownerUid: direction.owner }))
    })

    test(`${direction.marker}: student update has exact keys, immutable id, and no create/delete`, async () => {
      const own = teacher(direction.owner)
      const path = `classrooms/${direction.room}/students/${direction.student}`
      await assertSucceeds(own.doc(path).update({
        name: `${direction.marker} renamed`,
        balance: 25,
        frozen: true,
        transactions: [transactionBody(direction.tx, direction.student, direction.marker)],
      }))
      await assertFails(own.doc(path).update({ id: 999 }))
      await assertFails(own.doc(path).update({ nickname: 'extra' }))
      await assertFails(own.doc(path).set({
        id: Number(direction.student),
        name: 'missing fields',
      }))
      await assertFails(own.doc(`classrooms/${direction.room}/students/99`).set(
        studentBody('99', 'new'),
      ))
      await assertFails(own.doc(path).delete())
    })

    test(`${direction.marker}: transactions enforce exact creates and identity-safe minimal updates`, async () => {
      const own = teacher(direction.owner)
      const existing = own.doc(`classrooms/${direction.room}/transactions/${direction.tx}`)
      const newId = direction.marker === 'A' ? '1101' : '1102'

      await assertSucceeds(own.doc(`classrooms/${direction.room}/transactions/${newId}`).set(
        transactionBody(newId, direction.student, direction.marker),
      ))
      await assertSucceeds(existing.update({
        studentName: `${direction.marker} renamed`,
        status: 'Approved',
      }))
      await assertFails(existing.update({ id: 9999 }))
      await assertFails(existing.update({ studentId: 999 }))
      await assertFails(existing.update({ amount: 999 }))
      await assertFails(existing.update({ extra: true }))

      const missing = transactionBody('1201', direction.student, direction.marker)
      delete missing.memo
      await assertFails(own.doc(`classrooms/${direction.room}/transactions/1201`).set(missing))
      await assertFails(own.doc(`classrooms/${direction.room}/transactions/1202`).set(
        transactionBody('9999', direction.student, direction.marker),
      ))
      await assertFails(existing.delete())
    })

    test(`${direction.marker}: login history enforces exact bodies and immutable identity while owner deletion stays available`, async () => {
      const own = teacher(direction.owner)
      const existing = own.doc(`classrooms/${direction.room}/loginHistory/${direction.history}`)
      const newId = direction.marker === 'A' ? '2101' : '2102'

      await assertSucceeds(own.doc(`classrooms/${direction.room}/loginHistory/${newId}`).set(
        historyBody(newId, null, direction.marker),
      ))
      await assertSucceeds(existing.update({
        studentName: `${direction.marker} renamed`,
        result: 'Reviewed',
        note: 'Checked',
      }))
      await assertFails(existing.update({ id: 9999 }))
      await assertFails(existing.update({ studentId: 999 }))
      await assertFails(existing.update({ date: 'changed' }))
      await assertFails(existing.update({ extra: true }))
      await assertFails(own.doc(`classrooms/${direction.room}/loginHistory/2201`).set(
        historyBody('9999', direction.student, direction.marker),
      ))
      await assertSucceeds(existing.delete())
    })
  }

  test('student, transaction, and login-history body ids are positive integers matching canonical numeric paths', async () => {
    const own = teacher(A_UID)
    const invalidIdentities = [
      { pathId: 'not-numeric', bodyId: 'not-numeric' },
      { pathId: '0301', bodyId: 301 },
      { pathId: '0', bodyId: 0 },
      { pathId: '-1', bodyId: -1 },
      { pathId: '301', bodyId: 302 },
      { pathId: '302', bodyId: '302' },
    ]

    for (const { pathId, bodyId } of invalidIdentities) {
      await assertFails(own.doc(`classrooms/${A_ROOM}/transactions/${pathId}`).set({
        ...transactionBody('301', A_STUDENT, 'A'),
        id: bodyId,
      }))
      await assertFails(own.doc(`classrooms/${A_ROOM}/loginHistory/${pathId}`).set({
        ...historyBody('301', A_STUDENT, 'A'),
        id: bodyId,
      }))
    }

    await testEnv.withSecurityRulesDisabled(async context => {
      const db = context.firestore()
      for (const { pathId, bodyId } of invalidIdentities.slice(0, 4)) {
        await db.doc(`classrooms/${A_ROOM}/students/${pathId}`).set({
          id: bodyId,
          name: 'invalid identity fixture',
          balance: 0,
          frozen: false,
          transactions: [],
        })
      }
    })
    for (const { pathId } of invalidIdentities.slice(0, 4)) {
      await assertFails(own.doc(`classrooms/${A_ROOM}/students/${pathId}`).update({
        name: 'must remain denied',
      }))
    }
  })

  test('students retain exact self-read and receive no list, cross-student, or write permission', async () => {
    for (const [room, ownId, otherRoom, otherId] of [
      [A_ROOM, A_STUDENT, B_ROOM, B_STUDENT],
      [B_ROOM, B_STUDENT, A_ROOM, A_STUDENT],
    ]) {
      const db = student(`auth-${room}`, room, ownId)
      const ownPath = `classrooms/${room}/students/${ownId}`
      await assertSucceeds(db.doc(ownPath).get())
      await assertFails(db.collection(`classrooms/${room}/students`).get())
      await assertFails(db.doc(ownPath).update({ balance: 999 }))
      await assertFails(db.doc(ownPath).delete())
      await assertFails(db.doc(`classrooms/${otherRoom}/students/${otherId}`).get())
      await assertFails(db.doc(`classrooms/${room}`).get())
    }
  })

  test('disabled, missing, mismatched, and invalid foundations fail closed independently', async () => {
    await assertFails(teacher(DISABLED_UID).doc(`classrooms/${A_ROOM}`).get())
    await assertFails(teacher(DISABLED_UID).doc(`teachers/${DISABLED_UID}`).get())
    await assertFails(teacher(MISSING_TEACHER_UID).doc(`classrooms/${A_ROOM}`).get())
    await assertFails(teacher(MISSING_CLASSROOM_UID).doc('classrooms/phantom-room/students/3').get())
    await assertFails(teacher(UID_MISMATCH_UID).doc(`teachers/${UID_MISMATCH_UID}`).get())
    await assertFails(teacher(UID_MISMATCH_UID).doc(`classrooms/${A_ROOM}`).get())
    await assertFails(teacher(OWNER_MISMATCH_UID).doc('classrooms/owner-mismatch-room').get())
    await assertFails(teacher(INVALID_STATUS_UID).doc(`classrooms/${A_ROOM}`).get())
  })

  test('scoped logs are owner-read-only while flat logs and the legacy blob are final-denied', async () => {
    for (const direction of DIRECTIONS) {
      const own = teacher(direction.owner)
      const other = teacher(direction.intruder)
      const path = `studentAuthLogs/${direction.room}/logs/log-${direction.marker}`
      await assertSucceeds(own.doc(path).get())
      await assertSucceeds(own.collection(`studentAuthLogs/${direction.room}/logs`).get())
      await assertFails(other.doc(path).get())
      await assertFails(own.doc(path).update({ marker: 'changed' }))
      await assertFails(own.doc(path).delete())
      await assertFails(own.doc(`studentAuthLogs/${direction.room}/logs/forged`).set({ marker: 'x' }))
    }
    await assertFails(teacher(A_UID).doc('studentAuthLogs/flat-log').get())
    await assertFails(teacher(A_UID).collection('studentAuthLogs').get())
    await assertFails(teacher(A_UID).doc('morganBank/classroomData').get())
    await assertFails(teacher(A_UID).doc('morganBank/classroomData').update({ marker: 'x' }))
  })

  test('both credential shapes deny every verb to every client identity', async () => {
    const identities = [
      teacher(A_UID),
      teacher(B_UID),
      student('student-a-auth', A_ROOM, A_STUDENT),
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

  test('ownership writes, sensitive collections, unenumerated paths, and anonymous access fail closed', async () => {
    const paths = [
      'teacherInvitations/invite',
      'classroomLoginCodes/code',
      'studentLoginThrottle/bucket',
      'studentAuthUnresolvedLogs/log',
      'unenumerated/path',
      `classrooms/${A_ROOM}/private/internal-A`,
    ]
    for (const db of [teacher(A_UID), student('student-a-auth', A_ROOM, A_STUDENT)]) {
      await assertFails(db.doc(`teachers/${A_UID}`).update({ classroomId: B_ROOM }))
      for (const path of paths) {
        const slash = path.lastIndexOf('/')
        await denyAllDocumentVerbs(db, path.slice(0, slash), path.slice(slash + 1), 'sensitive')
      }
    }

    const anon = testEnv.unauthenticatedContext().firestore()
    for (const path of [
      `teachers/${A_UID}`,
      `classrooms/${A_ROOM}`,
      `classrooms/${A_ROOM}/students/${A_STUDENT}`,
      `classrooms/${A_ROOM}/transactions/${A_TX}`,
      `classrooms/${A_ROOM}/loginHistory/${A_HISTORY}`,
      `studentAuthLogs/${A_ROOM}/logs/log-A`,
      'morganBank/classroomData',
    ]) {
      await assertFails(anon.doc(path).get())
    }
  })
})
