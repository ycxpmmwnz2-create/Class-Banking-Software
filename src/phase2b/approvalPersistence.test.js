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
async function fixture({ fail = false, failReload = false, persisted = null, onCommitted = () => {} } = {}) {
  const transactions = [1, 2, 3].map(id => ({ id, date: '2026-09-10T12:00:00Z', studentId: 1,
    studentName: 'Fictional Student', type: 'Add', amount: 5, reason: 'Test', memo: '',
    category: '', status: 'Pending', source: 'Student' }));
  const data = { students: [{ id: 1, name: 'Fictional Student', balance: 10, frozen: false, transactions }],
    transactions, settings: { requireTeacherApproval: true }, loginHistory: [], lastBackupAt: null };
  const store = persisted || new Map([
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
        if (fail === true) throw new Error('simulated unavailable');
        writes.forEach(([p, body, options]) => store.set(p, options?.merge ? { ...store.get(p), ...body } : body));
        commits++;
        onCommitted();
        if (fail === 'afterCommit') throw new Error('simulated lost acknowledgment');
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
  let draftResets = 0;
  const form = { quickStudent: { value: '1' }, transactionTarget: { value: 'selected' },
    transactionType: { value: 'Subtract' }, transactionAmount: { value: '4' },
    transactionReason: { value: 'Rent' }, teacherChoiceMemo: { value: 'Fictional debit' } };
  const ctx = vm.createContext({ data: structuredClone(data), v2LastPersistedData: structuredClone(data),
    IS_MULTI_TEACHER_V2_ENABLED: true, v2TenantSession: session, auth: { currentUser: { uid: 'teacher-test' } },
    isTeacher: true, createApprovalQueue: options => { ctx.queueNotify = options.notify;return createApprovalQueue(options); },
    prepareApprovalDecision, orchestrateClassroomDataSave,
    studentLifecyclePending: false, bulkOperationPending: false, studentPinResetPending: false,
    rentUpdatePending: false, rosterBalanceSaveOperation: null, localStorage: { setItem() {} }, console, message: '',
    writeTeacherCache, v2IsOffline: false, Blob,
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
    quickCashStudentId: '',
    updateCustomTransactionDraft() {}, resetCustomTransactionDraft() { draftResets++; },
    document: { getElementById: id => form[id] || ({ classList: { toggle() { interactions.dropdown++; } } }),
      querySelectorAll: () => [{ value: '1' }],
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
    section('    function changeStudentBalance(', '    function submitStudentRequest()') +
    section('    function queueApprovalDecision(', '    async function addStudent()') +
    section('    function transactionTable(', '    function studentTransactionList(') +
    section('function exportTransactionsCsv(', '    async function openStudentAuthLogs('), ctx);
  async function finish() {
    unlock(); for (let i = 0; i < 40; i++) { await new Promise(resolve => setImmediate(resolve)); if (!vm.runInContext('approvalQueue.busy || activeClassroomSaves > 0', ctx)) return; }
    assert.fail('queue did not finish');
  }
  if (persisted) {
    ctx.data = await loader({ uid: 'teacher-test', classroomId: 'test-room' });
    ctx.v2LastPersistedData = JSON.parse(JSON.stringify(ctx.data));
  }
  return { ctx, store, finish, interactions, form, get commits() { return commits; }, get draftResets() { return draftResets; },
    reload: () => fixture({ persisted: store }) };
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


for (const mode of ['quick', 'custom']) {
  const submit = h => mode === 'quick' ? h.ctx.quickCash('Subtract', 4) : h.ctx.saveTeacherTransaction();

  test(`${mode} teacher debit publishes success only after balance and ledger persist`, async () => {
    const h = await fixture();
    const pending = submit(h);
    assert.equal(h.ctx.data.students[0].balance, 10, 'no optimistic debit');
    assert.equal(h.ctx.data.transactions.length, 3, 'no unconfirmed ledger entry');
    assert.doesNotMatch(h.ctx.message, /paid|saved and approved/);
    assert.equal(h.ctx.requireTeacher(), false, 'competing mutation blocked');
    submit(h); h.ctx.approveTransaction(1);
    await h.finish(); await pending;
    assert.equal(h.commits, 1, 'duplicate submit and competing approval do not write');
    assert.equal(h.ctx.data.students[0].balance, 6);
    assert.equal(h.store.get('classrooms/test-room/students/1').balance, 6);
    const fresh = await h.reload();
    assert.equal(fresh.ctx.data.students[0].balance, 6);
    assert.equal(fresh.ctx.data.transactions.filter(t => t.type === 'Subtract').length, 1);
    fresh.ctx.approveTransaction(1); await fresh.finish();
    assert.equal(fresh.store.get('classrooms/test-room/students/1').balance, 11);
    const reloaded = await fresh.reload();
    assert.equal(reloaded.ctx.data.students[0].balance, 11);
    assert.equal(reloaded.ctx.data.transactions.find(t => t.id === 1).status, 'Approved');
    if (mode === 'custom') assert.equal(h.draftResets, 1);
  });

  test(`${mode} rejected teacher debit retains confirmed state and gives refresh guidance`, async () => {
    const h = await fixture({ fail: true });
    const pending = submit(h); await h.finish(); await pending;
    assert.equal(h.commits, 0);
    assert.equal(h.ctx.data.students[0].balance, 10, 'failed debit never enters displayed data');
    assert.equal(h.ctx.data.transactions.length, 3);
    assert.match(h.ctx.message, /could not be confirmed.*Refresh/i);
    assert.doesNotMatch(h.ctx.message, /saved and approved/);
    assert.equal(h.ctx.requireTeacher(), false, 'ambiguous failures require fresh server state');
    h.ctx.approveTransaction(1); await h.finish();
    assert.equal(h.commits, 0);
    if (mode === 'custom') assert.equal(h.draftResets, 0, 'keep unsuccessful draft');
    const fresh = await h.reload();
    assert.equal(fresh.ctx.data.students[0].balance, 10);
    assert.equal(fresh.ctx.data.transactions.filter(t => t.type === 'Subtract').length, 0);
    fresh.ctx.approveTransaction(1); await fresh.finish();
    assert.equal(fresh.store.get('classrooms/test-room/students/1').balance, 15);
  });

  test(`${mode} lost save acknowledgment reloads one debit without automatic replay`, async () => {
    const h = await fixture({ fail: 'afterCommit' });
    const pending = submit(h); await h.finish(); await pending;
    assert.equal(h.commits, 1);
    assert.equal(h.ctx.data.students[0].balance, 10, 'do not present unconfirmed outcome');
    assert.match(h.ctx.message, /could not be confirmed.*Refresh/i);
    submit(h); await h.finish();
    assert.equal(h.commits, 1, 'no automatic or duplicate retry while outcome is unknown');
    const fresh = await h.reload();
    assert.equal(fresh.ctx.data.students[0].balance, 6);
    assert.equal(fresh.ctx.data.transactions.filter(t => t.type === 'Subtract').length, 1);
    fresh.ctx.approveTransaction(1); await fresh.finish();
    const reloaded = await fresh.reload();
    assert.equal(reloaded.ctx.data.students[0].balance, 11);
    assert.equal(reloaded.ctx.data.transactions.filter(t => t.type === 'Subtract').length, 1);
  });
}

for (const mode of ['quick', 'custom']) {
  const submit = h => mode === 'quick' ? h.ctx.quickCash('Subtract', 4) : h.ctx.saveTeacherTransaction();

  test(`${mode} conflict reload permits deliberate retry from the newer balance`, async () => {
    const h = await fixture();
    const pending = submit(h);
    h.store.get('classrooms/test-room/students/1').balance = 50;
    await h.finish(); await pending;
    assert.equal(h.commits, 0);
    assert.equal(h.ctx.data.students[0].balance, 50);
    assert.match(h.ctx.message, /reloaded/);
    assert.equal(h.ctx.requireTeacher(), true);
    if (mode === 'custom') assert.equal(h.draftResets, 0);
    await submit(h);
    assert.equal(h.commits, 1);
    assert.equal((await h.reload()).ctx.data.students[0].balance, 46);
  });

  test(`${mode} conflict with failed reload requires refresh and keeps the draft`, async () => {
    const h = await fixture({ failReload: true });
    const pending = submit(h);
    h.store.get('classrooms/test-room/students/1').balance = 50;
    await h.finish(); await pending;
    assert.equal(h.commits, 0);
    assert.equal(h.ctx.data.students[0].balance, 10);
    assert.match(h.ctx.message, /could not be confirmed.*Refresh/);
    assert.equal(h.ctx.requireTeacher(), false);
    assert.equal(h.draftResets, 0);
  });

  for (const fail of [false, true]) {
    test(`${mode} stale ${fail ? 'failure' : 'completion'} cannot publish into another classroom`, async () => {
      const h = await fixture({ fail });
      const pending = submit(h);
      h.ctx.v2TenantSession.invalidate('test-classroom-switch');
      h.ctx.data = { students: [{ id: 1, balance: 99 }], transactions: [] };
      h.ctx.v2LastPersistedData = structuredClone(h.ctx.data);
      h.ctx.message = 'New classroom';
      await h.finish(); await pending;
      assert.equal(h.ctx.data.students[0].balance, 99);
      assert.equal(h.ctx.v2LastPersistedData.students[0].balance, 99);
      assert.equal(h.ctx.message, 'New classroom');
      assert.equal(h.draftResets, 0);
      assert.equal(vm.runInContext('approvalRefreshRequired', h.ctx), false);
    });
  }

  test(`${mode} confirmed save with local interference requests refresh without overwriting it`, async () => {
    const h = await fixture();
    const pending = submit(h);
    h.ctx.data = structuredClone(h.ctx.data);
    h.ctx.data.students[0].balance = 99;
    await h.finish(); await pending;
    assert.equal(h.commits, 1);
    assert.equal(h.ctx.data.students[0].balance, 99);
    assert.equal(h.store.get('classrooms/test-room/students/1').balance, 6);
    assert.match(h.ctx.message, /was saved.*Refresh/);
    assert.equal(h.ctx.requireTeacher(), false);
    assert.equal(h.draftResets, 0);
  });

  test(`${mode} cannot start alongside pending operations or an unconfirmed baseline`, async () => {
    for (const flag of ['studentLifecyclePending', 'bulkOperationPending', 'studentPinResetPending',
      'rosterBalanceSaveOperation', 'rentUpdatePending', 'activeClassroomSaves']) {
      const h = await fixture();
      vm.runInContext(`${flag} = 1`, h.ctx);
      await submit(h);
      assert.match(h.ctx.message, /Another classroom change is saving/, flag);
      assert.equal(h.ctx.data.students[0].balance, 10);
      assert.equal(h.commits, 0);
    }
    const h = await fixture();
    h.ctx.data.students[0].balance = 11;
    await submit(h);
    assert.match(h.ctx.message, /unconfirmed local changes/);
    assert.equal(h.commits, 0);
    const queued = await fixture();
    queued.ctx.approveTransaction(1);
    await submit(queued);
    await queued.finish();
    assert.equal(queued.commits, 1, 'only the approval writes');
    assert.equal(queued.ctx.data.students[0].balance, 15);
    assert.equal(queued.ctx.data.transactions.filter(t => t.type === 'Subtract').length, 0);
  });
}

for (const fail of [false, 'afterCommit']) {
  test(`accepted outgoing debit with ${fail ? 'lost acknowledgement' : 'success'} cannot enter the incoming session`, async () => {
    let h;
    h = await fixture({ fail, onCommitted: () => {
      h.ctx.v2TenantSession.invalidate('test-same-user-new-classroom');
      h.ctx.data = { students: [{ id: 1, balance: 99 }], transactions: [] };
      h.ctx.v2LastPersistedData = structuredClone(h.ctx.data);
      h.ctx.message = 'Incoming classroom';
    } });
    const pending = h.ctx.saveTeacherTransaction();
    await h.finish(); await pending;
    assert.equal(h.commits, 1, 'outgoing write was accepted; client cancellation is not server rollback');
    assert.equal(h.store.get('classrooms/test-room/students/1').balance, 6);
    assert.equal(h.ctx.data.students[0].balance, 99);
    assert.equal(h.ctx.v2LastPersistedData.students[0].balance, 99);
    assert.equal(h.ctx.message, 'Incoming classroom');
    assert.equal(h.draftResets, 0);
  });
}

for (const mode of ['quick', 'custom']) {
  test(`${mode} successful debit permits the next approval without refreshing`, async () => {
    const h = await fixture();
    const pending = mode === 'quick' ? h.ctx.quickCash('Subtract', 4) : h.ctx.saveTeacherTransaction();
    await h.finish(); await pending;
    h.ctx.approveTransaction(1); await h.finish();
    assert.equal(h.commits, 2);
    assert.equal(h.ctx.data.students[0].balance, 11);
    const reloaded = await h.reload();
    assert.equal(reloaded.ctx.data.students[0].balance, 11);
    assert.equal(reloaded.ctx.data.transactions.find(t => t.id === 1).status, 'Approved');
    assert.equal(reloaded.ctx.data.transactions.filter(t => t.type === 'Subtract').length, 1);
  });
}

for (const mode of ['quick', 'custom']) {
  test(`${mode} initial render failure releases the money-save lock without writing`, async () => {
    const h = await fixture();
    let renders = 0;
    h.ctx.render = () => {
      if (++renders === 1) throw new Error('synthetic initial render failure');
    };
    const pending = mode === 'quick' ? h.ctx.quickCash('Subtract', 4) : h.ctx.saveTeacherTransaction();
    const error = await pending.then(() => null, failure => failure);
    assert.equal(vm.runInContext('teacherMoneySaveOperation', h.ctx), null, 'saving lock always clears');
    assert.equal(error, null, 'a one-time render failure is handled');
    assert.equal(renders, 2, 'finally redraws the unlocked controls');
    assert.equal(vm.runInContext('activeClassroomSaves', h.ctx), 0);
    assert.equal(h.commits, 0);
    assert.equal(h.ctx.data.students[0].balance, 10);
    assert.equal(h.ctx.data.transactions.length, 3);
    assert.equal(h.draftResets, 0);
    assert.match(h.ctx.message, /could not be confirmed.*Refresh/);
    assert.equal(h.ctx.requireTeacher(), false, 'existing refresh policy remains in force');
    assert.match(h.ctx.message, /Refresh/);
    assert.doesNotMatch(h.ctx.message, /Please wait/);
  });
}
