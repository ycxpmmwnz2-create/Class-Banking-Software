import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, runTransaction } from 'firebase/firestore';
import { createNonMoneyTenantDataSaver } from '../../src/phase3/nonMoneyTenantDataSaver.js';
import { TenantSession, SESSION_STATES } from '../../src/phase2b/tenantSession.js';

let env;
const rooms = ['room-a', 'room-b'];
const prefix = room => `classrooms/${room}`;
const control = changes => ({ schemaVersion: 1, mode: 'active', generation: 3,
  changedAt: '2026-10-02T12:00:00.000Z', auditId: 'fictional-op', ...changes });
const student = id => ({ id, name: 'Fictional', balance: 10, frozen: false, transactions: [] });
const ledger = { id: 7, date: '2026-10-02T12:00:00.000Z', studentId: 1, studentName: 'Fictional',
  type: 'Add', amount: 10, reason: 'Work', memo: '', category: 'Class', status: 'Pending', source: 'Student' };
const history = id => ({ id, date: '2026-10-02', studentId: 1, studentName: 'Fictional', result: 'Success', note: '' });
before(async () => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
  env = await initializeTestEnvironment({ projectId: 'demo-morgan-bank-money-rules',
    firestore: { host: '127.0.0.1', port: 8080,
      rules: readFileSync(new URL('../../firestore.phase3.money.rules', import.meta.url), 'utf8') } });
});
after(async () => { await env?.cleanup(); });
const privileged = callback => env.withSecurityRulesDisabled(c => callback(c.firestore()));
const owner = (room = rooms[0], token = {}) => env.authenticatedContext(room, token).firestore();
const pupil = (room = rooms[0], token = {}, uid = `student-${room}`) => env.authenticatedContext(uid,
  { role: 'student', classroomId: room, studentId: '1', loginId: 'shared', credentialVersion: 1000, ...token }).firestore();
const privatePaths = room => ['studentCredentials/shared', 'studentPins/1', 'teacherMoneyReceipts/r',
  'teacherMoneyActors/a', 'teacherMoneyMetadata/receiptQuota', 'accessControlAudits/a',
  'insightUsageLedgers/u', 'insightUsageRateLimits/r', 'insightUsageReservations/r', 'balanceHistory/1-version',
  'balanceHistory/1/nested/private', 'unknown/private'].map(p => `${prefix(room)}/${p}`);
beforeEach(async () => {
  await env.clearFirestore();
  await privileged(async db => {
    const batch = db.batch();
    for (const room of rooms) {
      const put = (path, body) => batch.set(db.doc(path), body);
      put(`teachers/${room}`, { uid: room, status: 'active', classroomId: room });
      put(prefix(room), { ownerUid: room, accessControl: control(), settings: {}, lastBackupAt: null, updatedAt: 'original' });
      put(`${prefix(room)}/students/1`, student(1));
      put(`${prefix(room)}/students/2`, student(2));
      put(`${prefix(room)}/transactions/7`, ledger);
      put(`${prefix(room)}/loginHistory/8`, history(8));
      put(`${prefix(room)}/studentDisplay/rent`, { rentAmount: 25, updatedAt: 'original' });
      put(`studentAuthLogs/${room}/logs/1`, { marker: 'fictional' });
      for (const path of privatePaths(room)) put(path, { marker: 'private' });
      put(`${prefix(room)}/studentCredentials/shared`, { active: true, classroomId: room, studentId: '1',
        authUid: `student-${room}`, pinUpdatedAt: 1000 });
    }
    await batch.commit();
  });
});
const setControl = value => privileged(db => db.doc(prefix(rooms[0])).update({ accessControl: value }));

for (const mode of ['active', 'readOnly', 'suspended']) test(`current ${mode} control governs existing teacher/student tokens`, async () => {
  const teacher = owner(), child = pupil();
  await assertSucceeds(child.doc(`${prefix(rooms[0])}/students/1`).get());
  await setControl(control({ mode, generation: 4 }));
  const read = mode === 'suspended' ? assertFails : assertSucceeds;
  for (const path of [`teachers/${rooms[0]}`, prefix(rooms[0]), `${prefix(rooms[0])}/students/1`,
    `${prefix(rooms[0])}/transactions/7`, `studentAuthLogs/${rooms[0]}/logs/1`]) await read(teacher.doc(path).get());
  await read(teacher.collection(`${prefix(rooms[0])}/students`).get());
  await read(child.doc(`${prefix(rooms[0])}/students/1`).get());
  await read(child.doc(`${prefix(rooms[0])}/studentDisplay/rent`).get());
  const write = mode === 'active' ? assertSucceeds : assertFails;
  await write(teacher.doc(`${prefix(rooms[0])}/students/1`).update({ frozen: true }));
  await write(teacher.doc(prefix(rooms[0])).update({ settings: { enabled: true }, updatedAt: 'changed' }));
  await write(teacher.doc(`${prefix(rooms[0])}/studentDisplay/rent`).set({ rentAmount: 30, updatedAt: 'changed' }));
  await write(teacher.doc(`${prefix(rooms[0])}/loginHistory/9`).set(history(9)));
  await write(teacher.doc(`${prefix(rooms[0])}/loginHistory/8`).delete());
});

test('direct balances, names, mirrors and every ledger transition deny, including atomic piggyback', async () => {
  const db = owner(), p = prefix(rooms[0]);
  for (const patch of [{ balance: 11 }, { balance: 9007199254740991 }, { name: 'Changed' },
    { transactions: [ledger] }, { frozen: true, balance: 11 }, { frozen: true, name: 'Changed' }]) {
    await assertFails(db.doc(`${p}/students/1`).update(patch));
  }
  for (const body of [{ ...ledger, id: 9 }, { ...ledger, id: 9, status: 'Approved' }]) {
    await assertFails(db.doc(`${p}/transactions/9`).set(body));
  }
  for (const status of ['Approved', 'Denied']) await assertFails(db.doc(`${p}/transactions/7`).update({ status }));
  await assertFails(db.doc(`${p}/transactions/7`).delete());
  await assertFails(db.doc(`${p}/students/3`).set(student(3)));
  await assertFails(db.doc(`${p}/students/1`).delete());
  const batch = db.batch();
  batch.update(db.doc(`${p}/students/1`), { frozen: true });
  batch.update(db.doc(`${p}/students/2`), { balance: 100 });
  await assertFails(batch.commit());
  await privileged(async db => {
    assert.deepEqual((await db.doc(`${p}/students/1`).get()).data(), student(1));
    assert.deepEqual((await db.doc(`${p}/students/2`).get()).data(), student(2));
    assert.deepEqual((await db.doc(`${p}/transactions/7`).get()).data(), ledger);
  });
});

test('control and owner changes cannot be smuggled through settings or a batch', async () => {
  const db = owner(), ref = db.doc(prefix(rooms[0]));
  for (const patch of [{ accessControl: control({ generation: 4 }) }, { accessControl: null },
    { settings: {}, ownerUid: rooms[1] }, { settings: {}, accessControl: control({ mode: 'readOnly' }) }]) {
    await assertFails(ref.update(patch));
  }
  await assertFails(ref.set({ ownerUid: rooms[0], settings: {}, lastBackupAt: null, updatedAt: 'new' }));
});

test('foreign, anonymous, student and unexpected roles cannot acquire teacher authority', async () => {
  const path = `${prefix(rooms[0])}/students/1`;
  for (const db of [owner(rooms[1]), env.unauthenticatedContext().firestore(), owner(rooms[0], { role: 'student' }),
    owner(rooms[0], { role: 'admin' }), pupil(rooms[1])]) {
    await assertFails(db.doc(path).get());
    await assertFails(db.doc(path).update({ frozen: true }));
  }
  await assertSucceeds(owner(rooms[0], { role: 'teacher' }).doc(path).get());
  await assertFails(pupil().doc(path).update({ frozen: true }));
  await assertFails(pupil().doc(`${prefix(rooms[0])}/students/2`).get());
  await assertFails(pupil().collection(`${prefix(rooms[0])}/students`).get());
  await assertFails(pupil().doc(prefix(rooms[0])).get());
});

test('student role never becomes teacher even with a forged teacher foundation', async () => {
  await privileged(async db => {
    await db.doc('teachers/student-room-a').set({ uid: 'student-room-a', status: 'active', classroomId: rooms[0] });
    await db.doc(prefix(rooms[0])).update({ ownerUid: 'student-room-a' });
  });
  await assertFails(pupil().doc(`teachers/student-room-a`).get());
  await assertFails(pupil().collection(`${prefix(rooms[0])}/students`).get());
});

test('missing, malformed and calendar-invalid controls fail closed', async () => {
  for (const value of [null, {}, control({ schemaVersion: 2 }), control({ generation: 0 }),
    control({ generation: 1.5 }), control({ generation: 9007199254740992 }), control({ mode: 'other' }),
    control({ changedAt: '2026-02-30T00:00:00.000Z' }), control({ changedAt: '2100-02-29T00:00:00.000Z' }),
    control({ changedAt: '2026-10-02T24:00:00.000Z' }), control({ auditId: '../bad' }), control({ auditId: '\u00a0op' }),
    control({ auditId: ' op\n' }), control({ auditId: '__a\nb__' }), control({ auditId: '😀'.repeat(376) }), control({ extra: true })]) {
    await setControl(value);
    await assertFails(owner().doc(`${prefix(rooms[0])}/students/1`).get());
    await assertFails(pupil().doc(`${prefix(rooms[0])}/students/1`).get());
  }
  await privileged(db => db.doc(prefix(rooms[0])).set({ ownerUid: rooms[0] }));
  await assertFails(owner().doc(prefix(rooms[0])).get());
  for (const changedAt of ['2000-02-29T23:59:59.999Z', '2024-02-29T00:00:00.000Z']) {
    await setControl(control({ changedAt }));
    await assertSucceeds(owner().doc(prefix(rooms[0])).get());
  }
});

test('revoked credential, old version and broken reciprocal owner deny reads', async () => {
  for (const changes of [{ credentialVersion: 999 }, { credentialVersion: '1000' }, { studentId: '2' }, { loginId: 'absent' }]) {
    await assertFails(pupil(rooms[0], changes).doc(`${prefix(rooms[0])}/students/1`).get());
  }
  await assertFails(pupil(rooms[0], {}, 'wrong-uid').doc(`${prefix(rooms[0])}/students/1`).get());
  await privileged(db => db.doc(`${prefix(rooms[0])}/studentCredentials/shared`).update({ active: false }));
  await assertFails(pupil().doc(`${prefix(rooms[0])}/students/1`).get());
  await privileged(db => db.doc(`teachers/${rooms[0]}`).update({ status: 'disabled' }));
  await assertFails(owner().doc(prefix(rooms[0])).get());
  await assertFails(pupil().doc(`${prefix(rooms[0])}/students/1`).get());
});

test('private metadata, PINs, accounting, audit and unknown paths deny every client', async () => {
  for (const db of [owner(), pupil(), env.unauthenticatedContext().firestore()]) {
    for (const path of privatePaths(rooms[0])) {
      await assertFails(db.doc(path).get());
      await assertFails(db.doc(path).set({ marker: 'changed' }));
    }
    await assertFails(db.doc('morganBank/classroomData').get());
    await assertFails(db.doc('morganBank/classroomData').set({ students: [] }));
  }
});

test('application usage reservations and dispatch claims deny every client in every mode', async () => {
  const paths = ['insightUsageLedgers/fixture', 'insightUsageRateLimits/fixture',
    'insightUsageReservations/fixture', 'insightUsageReservations/fixture/dispatches/1'];
  await privileged(async db => {
    for (const path of paths) await db.doc(path).set({ marker: 'fictional-private' });
  });
  for (const mode of ['active', 'readOnly', 'suspended']) {
    await setControl(control({ mode }));
    for (const db of [owner(), owner(rooms[1]), pupil(), env.unauthenticatedContext().firestore()]) {
      for (const path of paths) {
        await assertFails(db.doc(path).get());
        await assertFails(db.doc(path).set({ marker: 'changed' }));
        await assertFails(db.doc(path).delete());
      }
    }
  }
});

test('400 same-class freeze updates succeed within real rules lookup limits', async () => {
  await privileged(async db => {
    const batch = db.batch();
    for (let id = 1; id <= 400; id++) batch.set(db.doc(`${prefix(rooms[0])}/students/${id}`), student(id));
    await batch.commit();
  });
  const db = owner(), batch = db.batch();
  for (let id = 1; id <= 400; id++) batch.update(db.doc(`${prefix(rooms[0])}/students/${id}`), { frozen: true });
  await assertSucceeds(batch.commit());
});

test('real non-money saver works against candidate rules and preserves server history order', async () => {
  const second = { ...ledger, id: 9 };
  const previous = { students: [{ ...student(1), transactions: [ledger, second] }], transactions: [second, ledger],
    loginHistory: [], settings: {}, lastBackupAt: null };
  await privileged(async db => {
    await db.doc(`${prefix(rooms[0])}/students/1`).set(previous.students[0]);
    await db.doc(`${prefix(rooms[0])}/transactions/9`).set(second);
  });
  const session = new TenantSession({ storageAdapter: null, projectId: 'demo-morgan-bank-money-rules' });
  session.transitionTo(SESSION_STATES.AUTHENTICATING);
  session.transitionTo(SESSION_STATES.RESOLVING);
  session.transitionTo(SESSION_STATES.ACTIVE, { uid: rooms[0], role: 'teacher', classroomId: rooms[0] });
  const save = createNonMoneyTenantDataSaver({ db: owner(), session, firestore: { doc, runTransaction }, previousRef: () => previous });
  const next = structuredClone(previous); next.students[0].frozen = true;
  await assertSucceeds(save(next, session.captureIdentity()));
  await privileged(async db => assert.deepEqual((await db.doc(`${prefix(rooms[0])}/students/1`).get()).data(),
    { ...previous.students[0], frozen: true }));
});

test('a pause after saver reads prevents the pending freeze from committing', async () => {
  const previous = { students: [student(1)], transactions: [], loginHistory: [], settings: {}, lastBackupAt: null };
  const session = new TenantSession({ storageAdapter: null, projectId: 'demo-morgan-bank-money-rules' });
  session.transitionTo(SESSION_STATES.AUTHENTICATING);
  session.transitionTo(SESSION_STATES.RESOLVING);
  session.transitionTo(SESSION_STATES.ACTIVE, { uid: rooms[0], role: 'teacher', classroomId: rooms[0] });
  const save = createNonMoneyTenantDataSaver({ db: owner(), session, previousRef: () => previous,
    firestore: { doc, runTransaction: (db, callback) => runTransaction(db, async transaction => {
      const result = await callback(transaction);
      // Test-only barrier after staged writes and before commit; represents the
      // separately authorized operator. No such side effect exists in the saver.
      await setControl(control({ mode: 'readOnly', generation: 4 }));
      return result;
    }) } });
  const next = structuredClone(previous); next.students[0].frozen = true;
  await assertFails(save(next));
  await privileged(async db => assert.deepEqual((await db.doc(`${prefix(rooms[0])}/students/1`).get()).data(), student(1)));
});

test('regression proof: pinned old rules allow the balance bypass that the candidate denies', async () => {
  const rules = name => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
  const load = source => initializeTestEnvironment({ projectId: 'demo-morgan-bank-money-rules',
    firestore: { host: '127.0.0.1', port: 8080, rules: source } });
  let old;
  try {
    old = await load(rules('firestore.phase3.final.rules'));
    const db = old.authenticatedContext(rooms[0]).firestore();
    await assertSucceeds(db.doc(`${prefix(rooms[0])}/students/1`).update({ balance: 9007199254740991 }));
    await assertSucceeds(db.doc(`${prefix(rooms[0])}/transactions/7`).update({ status: 'Approved' }));
  } finally {
    await old?.cleanup();
    const restored = await load(rules('firestore.phase3.money.rules'));
    await restored.cleanup();
  }
  await assertFails(owner().doc(`${prefix(rooms[0])}/students/1`).update({ balance: 12 }));
  await assertFails(owner().doc(`${prefix(rooms[0])}/transactions/7`).update({ status: 'Denied' }));
});
