// Fixed demo project + loopback only. No accounts, ADC, Admin SDK or production.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'

const rooms = ['maintenance-a', 'maintenance-b']
const prefix = room => `classrooms/${room}`
const tx = id => ({ id, date: '2026-09-25', studentId: 1, studentName: 'Fictional',
  type: 'Add', amount: 10, reason: 'Test', memo: '', category: 'Class', status: 'Pending', source: 'Teacher' })
const history = id => ({ id, date: '2026-09-25', studentId: 1, studentName: 'Fictional', result: 'Success', note: '' })
const student = id => ({ id, name: 'Fictional', balance: 10, frozen: false, transactions: [] })
const rent = { rentAmount: 25, updatedAt: '2026-09-25' }
let env
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-morgan-bank-maintenance-rules',
    firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.phase3.maintenance.rules', 'utf8') },
  })
})
after(async () => { await env?.cleanup() })
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore()
    const batch = db.batch()
    for (const room of rooms) {
      const put = (path, data) => batch.set(db.doc(path), data)
      put(`teachers/${room}`, { uid: room, status: 'active', classroomId: room })
      put(prefix(room), { ownerUid: room, name: 'Fictional', version: 1, settings: {}, lastBackupAt: null, updatedAt: 'original' })
      put(`${prefix(room)}/students/1`, student(1))
      put(`${prefix(room)}/students/2`, student(2))
      put(`${prefix(room)}/transactions/1001`, tx(1001))
      put(`${prefix(room)}/loginHistory/2001`, history(2001))
      put(`${prefix(room)}/studentDisplay/rent`, rent)
      put(`${prefix(room)}/studentCredentials/shared`, { active: true, classroomId: room, studentId: '1', authUid: `student-${room}`, pinUpdatedAt: 1000 })
      put(`studentAuthLogs/${room}/logs/1`, { marker: room })
      for (const path of privatePaths(room)) put(path, { marker: 'private-fictional' })
    }
    await batch.commit()
  })
})

const owner = room => env.authenticatedContext(room).firestore()
const pupil = (room, extra = {}, uid = `student-${room}`) => env.authenticatedContext(uid, {
  role: 'student', classroomId: room, studentId: '1', loginId: 'shared', credentialVersion: 1000, ...extra,
}).firestore()
function privatePaths(room) {
  return [`${prefix(room)}/accessControlAudits/onboarding`, `${prefix(room)}/private/internal`,
    `${prefix(room)}/operationReceipts/op`, `${prefix(room)}/balanceHistory/version`,
    'studentCredentials/flat', 'teacherInvitations/invite', 'classroomLoginCodes/code',
    'studentLoginThrottle/throttle', 'studentAuthUnresolvedLogs/log', 'studentAuthLogs/flat',
    'morganBank/classroomData', 'unknown/document']
}
async function snapshot(paths) {
  return env.withSecurityRulesDisabled(async context => Promise.all(paths.map(async path => {
    const doc = await context.firestore().doc(path).get()
    return { path, exists: doc.exists, data: doc.data() }
  })))
}
async function denyUnchanged(paths, action) {
  const beforeState = await snapshot(paths)
  await assertFails(action())
  assert.deepEqual(await snapshot(paths), beforeState)
}

test('reciprocal teachers retain scoped gets and lists; cross-tenant reads deny both directions', async () => {
  for (const room of rooms) {
    const db = owner(room)
    const foreign = rooms.find(value => value !== room)
    for (const [ownPath, foreignPath] of [
      [`teachers/${room}`, `teachers/${foreign}`], [prefix(room), prefix(foreign)],
      [`${prefix(room)}/studentDisplay/rent`, `${prefix(foreign)}/studentDisplay/rent`],
    ]) {
      await assertSucceeds(db.doc(ownPath).get())
      await assertFails(db.doc(foreignPath).get())
    }
    for (const [suffix, id] of [['students', '1'], ['transactions', '1001'], ['loginHistory', '2001']]) {
      await assertSucceeds(db.doc(`${prefix(room)}/${suffix}/${id}`).get())
      await assertSucceeds(db.collection(`${prefix(room)}/${suffix}`).get())
      await assertFails(db.doc(`${prefix(foreign)}/${suffix}/${id}`).get())
      await assertFails(db.collection(`${prefix(foreign)}/${suffix}`).get())
    }
    await assertSucceeds(db.collection(`studentAuthLogs/${room}/logs`).get())
    await assertFails(db.collection(`studentAuthLogs/${foreign}/logs`).get())
    for (const collection of ['teachers', 'classrooms', `${prefix(room)}/studentDisplay`]) {
      await assertFails(db.collection(collection).get())
    }
  }
})

test('current students retain only self and rent reads, including same login ID in another tenant', async () => {
  for (const room of rooms) {
    const db = pupil(room)
    for (const path of [`${prefix(room)}/students/1`, `${prefix(room)}/studentDisplay/rent`]) {
      await assertSucceeds(db.doc(path).get())
    }
    const foreign = rooms.find(value => value !== room)
    for (const path of [prefix(room), `${prefix(room)}/students/2`, `${prefix(foreign)}/students/1`, `${prefix(foreign)}/studentDisplay/rent`]) {
      await assertFails(db.doc(path).get())
    }
    for (const collection of ['students', 'transactions', 'loginHistory', 'studentDisplay']) {
      await assertFails(db.collection(`${prefix(room)}/${collection}`).get())
    }
  }
})

test('stale, malformed and wrongly bound student identities cannot read', async () => {
  for (const room of rooms) {
    for (const db of [pupil(room, { credentialVersion: 999 }), pupil(room, { credentialVersion: '1000' }),
      pupil(room, { studentId: '2' }), pupil(room, {}, 'wrong-auth'), env.unauthenticatedContext().firestore()]) {
      await assertFails(db.doc(`${prefix(room)}/students/1`).get())
      await assertFails(db.doc(`${prefix(room)}/studentDisplay/rent`).get())
    }
  }
})

for (const [name, path, data] of [
  ['inactive credential', 'studentCredentials/shared', { active: false }],
  ['wrong credential classroom', 'studentCredentials/shared', { classroomId: 'different' }],
]) {
  test(`${name} denies student reads`, async () => {
    for (const room of rooms) {
      await env.withSecurityRulesDisabled(c => c.firestore().doc(`${prefix(room)}/${path}`).update(data))
      await assertFails(pupil(room).doc(`${prefix(room)}/students/1`).get())
      await assertFails(pupil(room).doc(`${prefix(room)}/studentDisplay/rent`).get())
    }
  })
}

test('disabled or broken reciprocal teacher foundation denies teacher and student reads', async () => {
  for (const data of [{ status: 'disabled' }, { status: 'active', classroomId: 'different' }]) {
    for (const room of rooms) {
      await env.withSecurityRulesDisabled(c => c.firestore().doc(`teachers/${room}`).update(data))
      await assertFails(owner(room).doc(prefix(room)).get())
      await assertFails(pupil(room).doc(`${prefix(room)}/students/1`).get())
    }
  }
})

// Each of these bodies is accepted by the pinned pre-maintenance rules. Running
// this same suite against that artifact must fail these denial assertions.
for (const [name, suffix, method, body] of [
  ['root settings update', '', 'update', { settings: { theme: 'new' }, updatedAt: 'new' }],
  ['student balance update', '/students/1', 'update', { balance: 20 }],
  ['student profile update', '/students/1', 'update', { name: 'Changed', frozen: true }],
  ['transaction creation', '/transactions/1002', 'set', tx(1002)],
  ['transaction approval', '/transactions/1001', 'update', { status: 'Approved' }],
  ['rent update', '/studentDisplay/rent', 'set', { ...rent, rentAmount: 50 }],
  ['history creation', '/loginHistory/2002', 'set', history(2002)],
  ['history update', '/loginHistory/2001', 'update', { note: 'Changed' }],
  ['history deletion', '/loginHistory/2001', 'delete', undefined],
]) {
  test(`maintenance denies otherwise-valid ${name} in both tenants without mutation`, async () => {
    for (const room of rooms) {
      const path = `${prefix(room)}${suffix}`
      await denyUnchanged([path], () => body === undefined ? owner(room).doc(path)[method]() : owner(room).doc(path)[method](body))
    }
  })
}

test('maintenance also denies otherwise-valid creation of missing rent projection', async () => {
  for (const room of rooms) {
    const path = `${prefix(room)}/studentDisplay/rent`
    await env.withSecurityRulesDisabled(c => c.firestore().doc(path).delete())
    await denyUnchanged([path], () => owner(room).doc(path).set(rent))
  }
})

test('atomic valid batch denies with no partial change', async () => {
  for (const room of rooms) {
    const db = owner(room)
    const paths = [`${prefix(room)}/students/1`, `${prefix(room)}/transactions/1002`]
    await denyUnchanged(paths, () => db.batch().update(db.doc(paths[0]), { balance: 20 }).set(db.doc(paths[1]), tx(1002)).commit())
  }
})

test('valid read-then-write transaction denies with no partial change', async () => {
  for (const room of rooms) {
    const db = owner(room)
    const paths = [`${prefix(room)}/students/1`, `${prefix(room)}/transactions/1002`]
    await denyUnchanged(paths, () => db.runTransaction(async transaction => {
      const doc = await transaction.get(db.doc(paths[0]))
      assert.equal(doc.data().balance, 10)
      transaction.update(db.doc(paths[0]), { balance: 20 })
      transaction.set(db.doc(paths[1]), tx(1002))
    }))
  }
})

test('students, foreign teachers and anonymous clients cannot mutate any public surface', async () => {
  for (const room of rooms) {
    for (const db of [pupil(room), owner(rooms.find(value => value !== room)), env.unauthenticatedContext().firestore()]) {
      for (const path of [prefix(room), `${prefix(room)}/students/1`, `${prefix(room)}/transactions/1001`, `${prefix(room)}/studentDisplay/rent`, `${prefix(room)}/loginHistory/2001`]) {
        await denyUnchanged([path], () => db.doc(path).set({ forged: true }))
        await denyUnchanged([path], () => db.doc(path).update({ forged: true }))
        await denyUnchanged([path], () => db.doc(path).delete())
      }
    }
  }
})

test('private, unmatched and legacy surfaces stay unreadable and unwritable', async () => {
  for (const room of rooms) {
    for (const db of [owner(room), pupil(room), env.unauthenticatedContext().firestore()]) {
      for (const path of [...privatePaths(room), `${prefix(room)}/studentCredentials/shared`]) {
        await assertFails(db.doc(path).get())
        await assertFails(db.collection(path.slice(0, path.lastIndexOf('/'))).get())
        await denyUnchanged([path], () => db.doc(path).set({ forged: true }))
        await denyUnchanged([path], () => db.doc(path).update({ forged: true }))
        await denyUnchanged([path], () => db.doc(path).delete())
      }
    }
  }
})

test('maintenance preserves baseline reads without claiming accessControl enforcement', async () => {
  // Absent controls are already exercised above. This interim artifact is not
  // the future strict control-aware rules and must not invent those semantics.
  for (const mode of ['readOnly', 'suspended']) {
    for (const room of rooms) {
      await env.withSecurityRulesDisabled(c => c.firestore().doc(prefix(room)).update({ accessControl: { mode, generation: 1 } }))
      await assertSucceeds(owner(room).doc(prefix(room)).get())
      await assertSucceeds(pupil(room).doc(`${prefix(room)}/students/1`).get())
      await denyUnchanged([prefix(room)], () => owner(room).doc(prefix(room)).update({ settings: {} }))
    }
  }
})
