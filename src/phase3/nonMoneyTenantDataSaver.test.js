import assert from 'node:assert/strict';
import test from 'node:test';
import { TenantSession, SESSION_STATES } from '../phase2b/tenantSession.js';
import { assertNonMoneyClassroomChange, createNonMoneyTenantDataSaver } from './nonMoneyTenantDataSaver.js';

const fixture = () => ({ students: [{ id: 1, name: 'Fictional', balance: 12, frozen: false, transactions: [] }],
  transactions: [], loginHistory: [], settings: {}, lastBackupAt: null });
const denied = error => error.reason === 'server-money-required';

for (const [name, change] of [
  ['balance', d => { d.students[0].balance++; }],
  ['name', d => { d.students[0].name = 'Changed'; }],
  ['mirror', d => { d.students[0].transactions.push({ id: 7 }); }],
  ['ledger create', d => { d.transactions.push({ id: 7 }); }],
  ['remove student', d => { d.students = []; }],
  ['replace student', d => { d.students[0].id = 2; }],
  ['duplicate student', d => { d.students.push(d.students[0]); }],
  ['new property', d => { d.students[0].pin = 'fictional'; }],
]) test(`generic candidate refuses ${name} before any database call`, async () => {
  const previous = fixture(), next = structuredClone(previous); change(next);
  let touched = false;
  const save = createNonMoneyTenantDataSaver({ previousRef: () => previous,
    firestore: { runTransaction() { touched = true; throw new Error('Unexpected DB call'); } } });
  await assert.rejects(save(next), denied);
  assert.equal(touched, false);
});

test('ledger status, deletion and historical name edits also require server actions', () => {
  const previous = fixture(); previous.transactions = [{ id: 7, status: 'Pending', studentName: 'Fictional' }];
  for (const change of [d => { d.transactions = []; }, d => { d.transactions[0].status = 'Approved'; },
    d => { d.transactions[0].studentName = 'Changed'; }]) {
    const next = structuredClone(previous); change(next);
    assert.throws(() => assertNonMoneyClassroomChange(next, previous), denied);
  }
});

test('no baseline is never permission to initialize money or roster', () => {
  for (const previous of [undefined, null, {}, { students: [], transactions: [] }]) {
    assert.throws(() => assertNonMoneyClassroomChange(fixture(), previous), denied);
  }
});

test('freeze uses real saver with narrow write and unchanged balance/history', async () => {
  const previous = fixture(), next = structuredClone(previous); next.students[0].frozen = true;
  const session = new TenantSession({ storageAdapter: null, projectId: 'demo-test' });
  session.transitionTo(SESSION_STATES.AUTHENTICATING);
  session.transitionTo(SESSION_STATES.RESOLVING);
  session.transitionTo(SESSION_STATES.ACTIVE, { uid: 'owner', role: 'teacher', classroomId: 'room' });
  const writes = [];
  const firestore = { doc: (_db, path) => ({ path }), runTransaction: async (_db, callback) => callback({
    get: async () => ({ exists: () => true, data: () => previous.students[0] }),
    update: (ref, body) => writes.push({ path: ref.path, body }),
    set: () => assert.fail('No full student replacement allowed'),
  }) };
  const save = createNonMoneyTenantDataSaver({ db: {}, session, firestore, previousRef: () => previous });
  assert.equal((await save(next, session.captureIdentity())).written, 1);
  assert.deepEqual(writes, [{ path: 'classrooms/room/students/1', body: { frozen: true } }]);
  assert.deepEqual(previous, fixture());
});

test('snapshot mismatch still refuses a freeze before writing', async () => {
  const previous = fixture(), next = structuredClone(previous); next.students[0].frozen = true;
  const session = new TenantSession({ storageAdapter: null, projectId: 'demo-test' });
  session.transitionTo(SESSION_STATES.AUTHENTICATING);
  session.transitionTo(SESSION_STATES.RESOLVING);
  session.transitionTo(SESSION_STATES.ACTIVE, { uid: 'owner', role: 'teacher', classroomId: 'room' });
  const firestore = { doc: (_db, path) => ({ path }), runTransaction: async (_db, callback) => callback({
    get: async () => ({ exists: () => true, data: () => ({ ...previous.students[0], balance: 99 }) }),
    update: () => assert.fail('No stale write'), set: () => assert.fail('No stale write'),
  }) };
  const save = createNonMoneyTenantDataSaver({ db: {}, session, firestore, previousRef: () => previous });
  await assert.rejects(save(next), error => error.reason === 'concurrent-classroom-change');
});

test('mutating the draft or baseline during an await cannot change the captured write', async () => {
  const previous = fixture(), next = structuredClone(previous); next.students[0].frozen = true;
  const session = new TenantSession({ storageAdapter: null, projectId: 'demo-test' });
  session.transitionTo(SESSION_STATES.AUTHENTICATING);
  session.transitionTo(SESSION_STATES.RESOLVING);
  session.transitionTo(SESSION_STATES.ACTIVE, { uid: 'owner', role: 'teacher', classroomId: 'room' });
  const writes = [];
  const firestore = { doc: (_db, path) => ({ path }), runTransaction: async (_db, callback) => callback({
    get: async () => {
      next.students[0].balance = 999; next.students[0].frozen = false;
      previous.students[0].balance = 888;
      return { exists: () => true, data: () => fixture().students[0] };
    },
    update: (_ref, body) => writes.push(body), set: () => assert.fail('No full replacement'),
  }) };
  const save = createNonMoneyTenantDataSaver({ db: {}, session, firestore, previousRef: () => previous });
  await save(next);
  assert.deepEqual(writes, [{ frozen: true }]);
});
