// Phase 3 Item 10: rollback-safe-rules behavioral contract.
//
// Loads the checksum-pinned rollback candidate explicitly. It proves the
// recorded default-off client contract without restoring recursive classroom
// access over scoped credentials left behind by migration.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'

const ROLLBACK_RULES_PATH = 'firestore.phase3.rollback.rules'
const ROLLBACK_RULES_SHA256 =
  'c81a058e260502fe31c4240d547dcd731f130eb85be3a3c185caae681e4ef19d'
const PRODUCTION_RULES_SHA256 =
  '0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50'

const LEGACY_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'
const OTHER_UID = 'teacher-b-uid'
const SCOPED_ROOM = 'classroom-a'
const SHARED_LOGIN_ID = 'shared-login'

let testEnv

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-morgan-bank-phase3-rules-test',
    firestore: {
      rules: readFileSync(ROLLBACK_RULES_PATH, 'utf8'),
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
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore()
    await db.doc('morganBank/classroomData').set({ marker: 'legacy' })
    await db.doc('morganBank/archive/notes/note').set({ marker: 'nested' })
    await db.doc('classrooms/morgan/students/1').set({
      id: 1,
      name: 'Legacy student',
      balance: 10,
      frozen: false,
      transactions: [],
    })
    await db.doc('studentAuthLogs/flat-log').set({ marker: 'legacy-flat' })

    await db.doc(`teachers/${LEGACY_UID}`).set({
      uid: LEGACY_UID,
      status: 'active',
      classroomId: SCOPED_ROOM,
    })
    await db.doc(`classrooms/${SCOPED_ROOM}`).set({ ownerUid: LEGACY_UID })
    await db.doc(`classrooms/${SCOPED_ROOM}/students/1`).set({ id: 1, marker: 'scoped' })
    await db.doc(`classrooms/${SCOPED_ROOM}/transactions/1001`).set({ id: 1001 })
    await db.doc(`classrooms/${SCOPED_ROOM}/loginHistory/2001`).set({ id: 2001 })
    await db.doc(`classrooms/${SCOPED_ROOM}/studentCredentials/${SHARED_LOGIN_ID}`).set({
      pinHash: 'scoped-secret',
    })
    await db.doc(`studentCredentials/${SHARED_LOGIN_ID}`).set({ pinHash: 'flat-secret' })
    await db.doc(`studentAuthLogs/${SCOPED_ROOM}/logs/scoped-log`).set({ marker: 'scoped' })

    await db.doc('teacherInvitations/invite').set({ status: 'active' })
    await db.doc('classroomLoginCodes/code').set({ classroomId: SCOPED_ROOM })
    await db.doc('studentLoginThrottle/bucket').set({ count: 1 })
    await db.doc('studentAuthUnresolvedLogs/log').set({ reason: 'unknown' })
    await db.doc('unenumerated/path').set({ marker: 'deny' })
  })
})

function authenticated(uid) {
  return testEnv.authenticatedContext(uid).firestore()
}

function student(uid, classroomId, studentId) {
  return testEnv.authenticatedContext(uid, {
    role: 'student',
    classroomId,
    studentId,
  }).firestore()
}

async function denyAllDocumentVerbs(db, collectionPath, existingId, suffix) {
  const existing = db.doc(`${collectionPath}/${existingId}`)
  await assertFails(existing.get())
  await assertFails(db.collection(collectionPath).get())
  await assertFails(db.doc(`${collectionPath}/forged-${suffix}`).set({ forged: true }))
  await assertFails(existing.update({ forged: true }))
  await assertFails(existing.delete())
}

describe('Phase 3 Item 10 rollback-safe rules', () => {
  test('rollback and production artifacts match their pins and the recursive baseline is absent', () => {
    const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
    assert.equal(digest(ROLLBACK_RULES_PATH), ROLLBACK_RULES_SHA256)
    assert.equal(digest('firestore.rules'), PRODUCTION_RULES_SHA256)

    const executable = readFileSync(ROLLBACK_RULES_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    assert.doesNotMatch(executable, /match\s+\/classrooms\/\{\s*document\s*=\s*\*\*\s*\}/)
    assert.match(executable, /match \/classrooms\/\{classroomId\}/)
    assert.match(executable, /match \/classrooms\/morgan\/students\/\{studentId\}/)
    assert.match(executable, /match \/studentAuthLogs\/\{logId\}/)
    assert.match(executable, /match \/studentAuthLogs\/\{classroomId\}\/logs\/\{logId\}/)
    assert.match(executable, /match \/studentCredentials\/\{loginId\}/)
    assert.match(
      executable,
      /match \/classrooms\/\{classroomId\}[\s\S]*match \/studentCredentials\/\{loginId\}/
    )
  })

  test('hardcoded teacher retains only the default-off blob, flat-log, and exact mirror reads', async () => {
    const db = authenticated(LEGACY_UID)
    await assertSucceeds(db.doc('morganBank/classroomData').get())
    await assertSucceeds(db.collection('morganBank').get())
    await assertSucceeds(db.doc('morganBank/classroomData').update({ marker: 'updated' }))
    await assertSucceeds(db.doc('morganBank/new-document').set({ marker: 'new' }))
    await assertSucceeds(db.doc('morganBank/archive/notes/note').delete())

    await assertSucceeds(db.doc('studentAuthLogs/flat-log').get())
    await assertSucceeds(db.collection('studentAuthLogs').get())
    await assertFails(db.doc('studentAuthLogs/flat-log').update({ marker: 'changed' }))
    await assertFails(db.doc('studentAuthLogs/flat-log').delete())
    await assertFails(db.doc('studentAuthLogs/forged-flat').set({ marker: 'new' }))

    await assertSucceeds(db.doc('classrooms/morgan/students/1').get())
    await assertFails(db.collection('classrooms/morgan/students').get())
    await assertFails(db.doc('classrooms/morgan/students/1').update({ balance: 99 }))
    await assertFails(db.doc('classrooms/morgan/students/1').delete())
    await assertFails(db.doc('classrooms/morgan/students/2').set({ id: 2 }))
  })

  test('other teachers receive none of the hardcoded rollback exception', async () => {
    const db = authenticated(OTHER_UID)
    await assertFails(db.doc('morganBank/classroomData').get())
    await assertFails(db.doc('morganBank/classroomData').update({ marker: 'forged' }))
    await assertFails(db.doc('studentAuthLogs/flat-log').get())
    await assertFails(db.collection('studentAuthLogs').get())
    await assertFails(db.doc('classrooms/morgan/students/1').get())
  })

  test('legacy students retain only exact morgan self-read', async () => {
    const legacy = student('legacy-student-auth', 'morgan', '1')
    await assertSucceeds(legacy.doc('classrooms/morgan/students/1').get())
    await assertFails(legacy.collection('classrooms/morgan/students').get())
    await assertFails(legacy.doc('classrooms/morgan/students/1').update({ balance: 999 }))
    await assertFails(legacy.doc('classrooms/morgan/students/2').get())
    await assertFails(legacy.doc(`classrooms/${SCOPED_ROOM}/students/1`).get())
    await assertFails(legacy.doc('morganBank/classroomData').get())

    const v2 = student('v2-student-auth', SCOPED_ROOM, '1')
    await assertFails(v2.doc(`classrooms/${SCOPED_ROOM}/students/1`).get())
    await assertFails(v2.doc('classrooms/morgan/students/1').get())
  })

  test('scoped classroom data and both authentication-log shapes are explicitly bounded', async () => {
    const db = authenticated(LEGACY_UID)
    for (const path of [
      `teachers/${LEGACY_UID}`,
      `classrooms/${SCOPED_ROOM}`,
      `classrooms/${SCOPED_ROOM}/students/1`,
      `classrooms/${SCOPED_ROOM}/transactions/1001`,
      `classrooms/${SCOPED_ROOM}/loginHistory/2001`,
      `studentAuthLogs/${SCOPED_ROOM}/logs/scoped-log`,
    ]) {
      await assertFails(db.doc(path).get())
    }
    for (const path of [
      `classrooms/${SCOPED_ROOM}`,
      `classrooms/${SCOPED_ROOM}/students/1`,
      `classrooms/${SCOPED_ROOM}/transactions/1001`,
      `classrooms/${SCOPED_ROOM}/loginHistory/2001`,
    ]) {
      await assertFails(db.doc(path).update({ forged: true }))
    }
    await assertFails(db.collection(`studentAuthLogs/${SCOPED_ROOM}/logs`).get())
    await assertFails(db.doc(`studentAuthLogs/${SCOPED_ROOM}/logs/scoped-log`).update({ marker: 'x' }))
  })

  test('flat and scoped credentials deny every verb to every identity', async () => {
    const identities = [
      authenticated(LEGACY_UID),
      authenticated(OTHER_UID),
      student('legacy-student-auth', 'morgan', '1'),
      testEnv.unauthenticatedContext().firestore(),
    ]
    for (const db of identities) {
      await denyAllDocumentVerbs(db, 'studentCredentials', SHARED_LOGIN_ID, 'flat')
      await denyAllDocumentVerbs(
        db,
        `classrooms/${SCOPED_ROOM}/studentCredentials`,
        SHARED_LOGIN_ID,
        'scoped',
      )
    }
  })

  test('ownership, sensitive collections, unenumerated paths, and anonymous access fail closed', async () => {
    const db = authenticated(LEGACY_UID)
    for (const path of [
      'teacherInvitations/invite',
      'classroomLoginCodes/code',
      'studentLoginThrottle/bucket',
      'studentAuthUnresolvedLogs/log',
      'unenumerated/path',
    ]) {
      const slash = path.lastIndexOf('/')
      await denyAllDocumentVerbs(db, path.slice(0, slash), path.slice(slash + 1), 'sensitive')
    }
    await assertFails(db.doc(`teachers/${LEGACY_UID}`).update({ status: 'active' }))

    const anon = testEnv.unauthenticatedContext().firestore()
    await assertFails(anon.doc('morganBank/classroomData').get())
    await assertFails(anon.doc('studentAuthLogs/flat-log').get())
    await assertFails(anon.doc('classrooms/morgan/students/1').get())
  })
})
