import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setImmediate } from 'node:timers';
import { createApprovalQueue, prepareApprovalDecision } from './approvalQueue.js';
import { orchestrateClassroomDataSave } from './tenantClient.js';
import { writeTeacherCache } from './tenantCache.js';
import { TenantSession, SESSION_STATES } from './tenantSession.js';
import { createTenantDataSaver, createTenantDataLoader } from '../phase3/tenantDataService.js';

const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start); assert.notEqual(a, -1, start);
  const b = source.indexOf(end, a); assert.notEqual(b, -1, end);
  return source.slice(a, b);
}
async function fixture({ fail = false, failReload = false } = {}) {
  const transactions = [1, 2, 3].map(id => ({ id, date: '2026-09-10T12:00:00Z', studentId: 1,
    studentName: 'Fictional Student', type: 'Add', amount: 5, reason: 'Test', memo: '',
    category: '', status: 'Pending', source: 'Student' }));
  const data = { students: [{ id: 1, name: 'Fictional Student', balance: 10, frozen: false, transactions }],
    transactions, settings: { requireTeacherApproval: true }, loginHistory: [], lastBackupAt: null };
  const store = new Map([
    ['classrooms/test-room', { settings: data.settings, lastBackupAt: null }],
    ['classrooms/test-room/students/1', structuredClone(data.students[0])],
    ...transactions.map(t => ['classrooms/test-room/transactions/' + t.id, structuredClone(t)]),
  ]);
  let unlock; const gate = new Promise(resolve => { unlock = resolve; });
  let chain = Promise.resolve(); let commits = 0;
  // Serial execution models a transaction callback retried after an earlier
  // commit: it observes current documents, not stale cached read results.
  const firestore = {
    doc: (_db, path) => ({ path }), collection: (_db, path) => ({ path }),
    getDoc: async ref => ({ exists: () => store.has(ref.path), data: () => store.get(ref.path) }),
    getDocs: async ref => ({ docs: [...store].filter(([p]) => p.startsWith(ref.path + '/') && !p.slice(ref.path.length + 1).includes('/'))
      .map(([p, body]) => ({ id: p.split('/').at(-1), data: () => body })) }),
    runTransaction(_db, callback) {
      const result = chain.then(async () => {
        await gate; const writes = []; let wrote = false;
        await callback({
          get: async ref => { assert.equal(wrote, false); return { exists: () => store.has(ref.path), data: () => store.get(ref.path) }; },
          set: (ref, body, options) => { wrote = true; writes.push([ref.path, body, options]); },
          delete: () => { throw new Error('approvals must not delete'); },
        });
        if (fail) throw new Error('simulated unavailable');
        writes.forEach(([p, body, options]) => store.set(p, options?.merge ? { ...store.get(p), ...body } : body));
        commits++;
      });
      chain = result.catch(() => {}); return result;
    },
  };
  const session = new TenantSession({ storageAdapter: null, projectId: 'demo-approval' });
  session.transitionTo(SESSION_STATES.AUTHENTICATING);session.transitionTo(SESSION_STATES.RESOLVING);
  session.transitionTo(SESSION_STATES.ACTIVE, { uid: 'teacher-test', role: 'teacher', classroomId: 'test-room' });
  session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
  session.transitionTo(SESSION_STATES.READY);
  const interactions = { dropdown: 0, exports: 0 };
  const ctx = vm.createContext({ data: structuredClone(data), v2LastPersistedData: structuredClone(data),
    IS_MULTI_TEACHER_V2_ENABLED: true, v2TenantSession: session, auth: { currentUser: { uid: 'teacher-test' } },
    isTeacher: true, createApprovalQueue: options => { ctx.queueNotify = options.notify;return createApprovalQueue(options); },
    prepareApprovalDecision, orchestrateClassroomDataSave,
    studentLifecyclePending: false, bulkOperationPending: false, studentPinResetPending: false,
    rosterBalanceSaveOperation: null, localStorage: { setItem() {} }, console, message: '',
    writeTeacherCache, v2IsOffline: false, Blob,
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
    document: { getElementById: () => ({ classList: { toggle() { interactions.dropdown++; } } }),
      createElement: () => ({ click() { interactions.exports++; } }) },
    escapeHtml: text => String(text), displayTransactionDate: text => text, dollars: amount => String(amount),
    render() {}, showMessage(text) { ctx.message = text; }, confirm: () => true });
  const loader = createTenantDataLoader({ db: {}, session, firestore });
  ctx.v2SaveTenantData = createTenantDataSaver({ db: {}, session, firestore, previousRef: () => ctx.v2LastPersistedData });
  ctx.v2LoadTenantData = async args => {
    if (failReload) throw new Error('simulated reload unavailable');
    return loader(args);
  };
  vm.runInContext(section('    let activeClassroomSaves =', '    // Phase 1B:') +
    section('    async function saveData()', '    function dollars(') +
    section('    function queueApprovalDecision(', '    async function addStudent()') +
    section('    function transactionTable(', '    function studentTransactionList(') +
    section('function exportTransactionsCsv(', '    async function openStudentAuthLogs('), ctx);
  async function finish() {
    unlock(); for (let i = 0; i < 40; i++) { await new Promise(resolve => setImmediate(resolve)); if (!vm.runInContext('approvalQueue.busy', ctx)) return; }
    assert.fail('queue did not finish');
  }
  return { ctx, store, finish, interactions, get commits() { return commits; } };
}

test('actual UI handlers and tenant saver persist rapid approvals exactly once', async () => {
  const h = await fixture(); h.ctx.approveTransaction(1);h.ctx.approveTransaction(2);h.ctx.approveTransaction(1);
  assert.equal(h.ctx.data.students[0].balance, 10, 'no optimistic credit');
  assert.equal(h.ctx.message, '', 'no unconfirmed success');
  const pendingRow = h.ctx.transactionTable([h.ctx.data.transactions[0]], true);
  assert.match(pendingRow, /role="status">Saving/);
  assert.doesNotMatch(pendingRow, /<button/);
  assert.match(h.ctx.transactionTable([h.ctx.data.transactions[2]], true), /approveTransaction\(3\)/);
  assert.equal(h.ctx.requireTeacher(), false, 'other teacher mutations blocked during queue');
  await h.finish();
  assert.equal(h.commits, 2);
  assert.equal(h.store.get('classrooms/test-room/students/1').balance, 20);
  assert.equal(h.store.get('classrooms/test-room/transactions/1').status, 'Approved');
  assert.equal(h.store.get('classrooms/test-room/transactions/2').status, 'Approved');
  assert.equal(h.ctx.requireTeacher(), true);
  assert.doesNotMatch(h.ctx.transactionTable([h.ctx.data.transactions[0]], true), /Saving|<button/);
  h.ctx.approveTransaction(3); await h.finish();
  assert.equal(h.commits, 3, 'a new drain accepts subsequent approvals');
  assert.equal(h.store.get('classrooms/test-room/students/1').balance, 25);
  assert.equal(h.store.get('classrooms/test-room/transactions/3').status, 'Approved');
});

test('legacy cache only advances after confirmed persistence', async () => {
  for (const fail of [false, true]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const cached = [];
    const ctx = vm.createContext({ IS_MULTI_TEACHER_V2_ENABLED: false, db: {},
      STORAGE_KEY: 'synthetic', localStorage: { setItem: (...args) => cached.push(args) },
      doc: () => ({}), setDoc: async () => { await gate; if (fail) throw new Error('unavailable'); },
      console: { error() {} } });
    vm.runInContext('let activeClassroomSaves = 0;\n' + section('    async function saveData()',
      '    async function reloadV2ClassroomAfterSaveConflict'), ctx);
    const result = ctx.saveClassroomCandidate({ fictional: true });
    assert.equal(cached.length, 0);
    release(); assert.equal((await result).executed, !fail);
    assert.equal(cached.length, fail ? 0 : 1);
  }
});

test('actual Approve All shares queued IDs and deny leaves balances alone', async () => {
  const h = await fixture();h.ctx.approveTransaction(1);h.ctx.denyTransaction(2);h.ctx.approveAllCreditRequests();
  await h.finish();assert.equal(h.commits, 3);
  assert.equal(h.store.get('classrooms/test-room/students/1').balance, 20);
  assert.equal(h.store.get('classrooms/test-room/transactions/2').status, 'Denied');
  assert.equal(h.store.get('classrooms/test-room/transactions/3').status, 'Approved');
});

test('actual failed save retains pending records and requires refresh before any later mutation', async () => {
  const h = await fixture({ fail: true });h.ctx.approveTransaction(1);h.ctx.denyTransaction(2);await h.finish();
  assert.equal(h.commits, 0);assert.equal(h.ctx.data.students[0].balance, 10);
  assert.equal(h.store.get('classrooms/test-room/transactions/1').status, 'Pending');
  assert.equal(h.ctx.requireTeacher(), false);assert.match(h.ctx.message, /Refresh/);
  h.ctx.approveTransaction(3);assert.equal(vm.runInContext('approvalQueue.busy', h.ctx), false);
});

test('real saver still rejects a concurrent server change instead of overwriting its balance', async () => {
  const h = await fixture();h.ctx.approveTransaction(1);h.ctx.approveTransaction(2);
  h.store.get('classrooms/test-room/students/1').balance = 50;
  await h.finish();assert.equal(h.commits, 0);
  assert.equal(h.store.get('classrooms/test-room/students/1').balance, 50);
  assert.equal(h.store.get('classrooms/test-room/transactions/1').status, 'Pending');
  assert.equal(h.ctx.data.students[0].balance, 50, 'conflict reload uses current server state');
});


test('successful conflict reload stops the queue but allows a deliberate new decision', async () => {
  const h = await fixture();h.ctx.approveTransaction(1);h.ctx.approveTransaction(2);
  h.store.get('classrooms/test-room/students/1').balance = 50;
  await h.finish();
  assert.equal(h.commits, 0);
  assert.equal(h.ctx.requireTeacher(), true, 'healed conflict must not latch');
  assert.match(h.ctx.message, /reloaded/);
  h.ctx.approveTransaction(3);await h.finish();
  assert.equal(h.commits, 1);
  assert.equal(h.store.get('classrooms/test-room/students/1').balance, 55);
  assert.equal(h.store.get('classrooms/test-room/transactions/1').status, 'Pending');
  assert.equal(h.store.get('classrooms/test-room/transactions/2').status, 'Pending');
});

test('failed conflict reload still blocks mutations while read-only access keeps auth checks', async () => {
  const h = await fixture({ failReload: true });h.ctx.approveTransaction(1);
  assert.equal(h.ctx.requireTeacher({ readOnly: true }), true, 'reading allowed during save');
  h.store.get('classrooms/test-room/students/1').balance = 50;
  await h.finish();
  assert.equal(h.ctx.requireTeacher(), false);
  assert.equal(h.ctx.requireTeacher({ readOnly: true }), true, 'reading allowed after failure');
  h.ctx.auth.currentUser = { uid: 'someone-else' };
  assert.equal(h.ctx.requireTeacher({ readOnly: true }), false, 'read-only does not bypass authorization');
});

test('empty Approve All explains there are no pending credits', async () => {
  const h = await fixture(); h.ctx.data.transactions = [];
  h.ctx.approveAllCreditRequests();assert.match(h.ctx.message, /No pending credit requests/);
  assert.equal(h.commits, 0);
});


test('actual dropdown and CSV remain usable during saving and after ambiguous failure', async () => {
  const h = await fixture({ fail: true });h.ctx.approveTransaction(1);
  h.ctx.toggleStudentDropdown();h.ctx.exportTransactionsCsv('all');
  assert.deepEqual(h.interactions, { dropdown: 1, exports: 1 });
  await h.finish();
  h.ctx.toggleStudentDropdown();h.ctx.exportTransactionsCsv('all');
  assert.deepEqual(h.interactions, { dropdown: 2, exports: 2 });
  h.ctx.auth.currentUser = { uid: 'someone-else' };
  h.ctx.toggleStudentDropdown();h.ctx.exportTransactionsCsv('all');
  assert.deepEqual(h.interactions, { dropdown: 2, exports: 2 });
  assert.equal(h.commits, 0);
});

test('refresh latch follows explicit metadata, independently of user-facing words', async () => {
  const h = await fixture();
  h.ctx.queueNotify('Refresh is just a word.', { requiresRefresh: false });
  assert.equal(h.ctx.requireTeacher(), true);
  h.ctx.queueNotify('Reload before another decision.', { requiresRefresh: true });
  assert.equal(h.ctx.requireTeacher(), false);
  assert.equal(h.ctx.requireTeacher({ readOnly: true }), true);
});
