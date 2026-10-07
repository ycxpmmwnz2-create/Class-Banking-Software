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
import { createTeacherMoneyClient, parseTeacherMoneyAmount } from '../phase3/teacherMoneyClient.js';
import { teacherAwardFixture } from '../../tests/phase3/teacherAward.fixture.js';
import { getClassroomAccessService } from '../../functions/phase3/classroomAccess.js';
import { executeTeacherMoneyCallable, planTeacherMoneyCallable, recoverTeacherMoneyCallable } from '../../functions/phase3/teacherMoneyCallables.js';

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
    section('    function changeStudentBalance(', '    function queueApprovalDecision(') +
    section('    function queueApprovalDecision(', '    async function addStudent()') +
    section('    function transactionTable(', '    function studentTransactionList(') +
    section('function exportTransactionsCsv(', '    async function openStudentAuthLogs('), ctx);
  // This exercises the retained generic saver/queue as components. V2 UI
  // approvals below and in browser tests now exercise the server-intent route.
  const enqueueGenericDecision = (ids, status = 'Approved') => {
    if (!ctx.requireTeacher({ allowApprovalQueue: true })) return;
    ctx.genericIds = ids; ctx.genericStatus = status;
    vm.runInContext(`{
      const available = genericIds.filter(id => !approvalQueue.has(id)), decision = genericStatus;
      if (!approvalRefreshRequired) approvalQueue.enqueue(available, snapshot => prepareApprovalDecision(snapshot, available, decision, () => true));
    }`, ctx);
  };
  async function finish() {
    unlock(); for (let i = 0; i < 40; i++) { await new Promise(resolve => setImmediate(resolve)); if (!vm.runInContext('approvalQueue.busy || activeClassroomSaves > 0', ctx)) return; }
    assert.fail('queue did not finish');
  }
  if (persisted) {
    ctx.data = await loader({ uid: 'teacher-test', classroomId: 'test-room' });
    ctx.v2LastPersistedData = JSON.parse(JSON.stringify(ctx.data));
  }
  return { ctx, store, finish, enqueueGenericDecision, interactions, form, get commits() { return commits; }, get draftResets() { return draftResets; },
    reload: () => fixture({ persisted: store }) };
}

test('retained approval queue and tenant saver persist rapid approvals exactly once', async () => {
  const h = await fixture(); h.enqueueGenericDecision([1]);h.enqueueGenericDecision([2]);h.enqueueGenericDecision([1]);
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
  h.enqueueGenericDecision([3]); await h.finish();
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

test('retained generic queue shares IDs and denial leaves balances alone', async () => {
  const h = await fixture();h.enqueueGenericDecision([1]);h.enqueueGenericDecision([2], 'Denied');h.enqueueGenericDecision([1, 2, 3]);
  await h.finish();assert.equal(h.commits, 3);
  assert.equal(h.store.get('classrooms/test-room/students/1').balance, 20);
  assert.equal(h.store.get('classrooms/test-room/transactions/2').status, 'Denied');
  assert.equal(h.store.get('classrooms/test-room/transactions/3').status, 'Approved');
});

test('actual failed save retains pending records and requires refresh before any later mutation', async () => {
  const h = await fixture({ fail: true });h.enqueueGenericDecision([1]);h.enqueueGenericDecision([2], 'Denied');await h.finish();
  assert.equal(h.commits, 0);assert.equal(h.ctx.data.students[0].balance, 10);
  assert.equal(h.store.get('classrooms/test-room/transactions/1').status, 'Pending');
  assert.equal(h.ctx.requireTeacher(), false);assert.match(h.ctx.message, /Refresh/);
  h.enqueueGenericDecision([3]);assert.equal(vm.runInContext('approvalQueue.busy', h.ctx), false);
});

test('real saver still rejects a concurrent server change instead of overwriting its balance', async () => {
  const h = await fixture();h.enqueueGenericDecision([1]);h.enqueueGenericDecision([2]);
  h.store.get('classrooms/test-room/students/1').balance = 50;
  await h.finish();assert.equal(h.commits, 0);
  assert.equal(h.store.get('classrooms/test-room/students/1').balance, 50);
  assert.equal(h.store.get('classrooms/test-room/transactions/1').status, 'Pending');
  assert.equal(h.ctx.data.students[0].balance, 50, 'conflict reload uses current server state');
});


test('successful conflict reload stops the queue but allows a deliberate new decision', async () => {
  const h = await fixture();h.enqueueGenericDecision([1]);h.enqueueGenericDecision([2]);
  h.store.get('classrooms/test-room/students/1').balance = 50;
  await h.finish();
  assert.equal(h.commits, 0);
  assert.equal(h.ctx.requireTeacher(), true, 'healed conflict must not latch');
  assert.match(h.ctx.message, /reloaded/);
  h.enqueueGenericDecision([3]);await h.finish();
  assert.equal(h.commits, 1);
  assert.equal(h.store.get('classrooms/test-room/students/1').balance, 55);
  assert.equal(h.store.get('classrooms/test-room/transactions/1').status, 'Pending');
  assert.equal(h.store.get('classrooms/test-room/transactions/2').status, 'Pending');
});

test('failed conflict reload still blocks mutations while read-only access keeps auth checks', async () => {
  const h = await fixture({ failReload: true });h.enqueueGenericDecision([1]);
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
  const h = await fixture({ fail: true });h.enqueueGenericDecision([1]);
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

// The old V2 handlers calculated replacement balances in the browser. Their
// persistence cases now use the actual intent handlers, client controller and
// server services. Generic saver/queue component coverage above remains independent of V2 routing.
async function moneyFixture({ fail = false, failReload = false, onCommitted = () => {} } = {}) {
  const h = await fixture({ failReload });
  const f = teacherAwardFixture({ uid: 'teacher-test', classroomId: 'test-room', count: 1, store: h.store });
  f.dependencies.projectId = h.ctx.v2TenantSession.projectId;
  h.store.set('classrooms/test-room', { ...h.store.get('classrooms/test-room'), ownerUid: f.uid,
    accessControl: { schemaVersion: 1, mode: 'active', generation: 7, changedAt: f.time, auditId: 'fictional-audit' },
    settings: { ...h.store.get('classrooms/test-room').settings, addMoneyCategories: ['Homework'], subtractMoneyCategories: ['Rent'] } });
  let unlock;
  const gate = new Promise(resolve => { unlock = resolve; });
  const values = new Map(), calls = [], caches = new Map();
  h.ctx.localStorage = { setItem: (key, value) => caches.set(key, JSON.parse(value)) };
  const reloadStart = source.indexOf('        reload: async captured => {', source.indexOf('      v2TeacherMoneyClient = createTeacherMoneyClient'));
  const reloadEnd = source.indexOf('        confirmPlan:', reloadStart);
  assert.ok(reloadStart > 0 && reloadEnd > reloadStart);
  const reload = vm.runInContext('(' + source.slice(reloadStart, reloadEnd).trim().replace(/^reload: /, '').replace(/,$/, '') + ')', h.ctx);
  const count = () => f.commits.filter(writes => writes.some(([, path]) => /\/students\/|\/transactions\//.test(path))).length;
  let requestSequence = 0;
  const client = createTeacherMoneyClient({ session: h.ctx.v2TenantSession, currentUid: () => h.ctx.auth.currentUser?.uid,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    random: { getRandomValues: bytes => { bytes.fill(++requestSequence); return bytes; } }, confirmPlan: () => true,
    notify: () => h.ctx.render(),
    reload,
    call: async (name, data) => {
      calls.push(name);
      const request = { auth: f.dependencies.auth, data };
      if (name === 'getClassroomAccessV2') return getClassroomAccessService({ ...f.dependencies, data });
      if (name === 'planTeacherMoneyV2') return planTeacherMoneyCallable(request, f.dependencies);
      if (name === 'executeTeacherMoneyV2') {
        await gate;
        if (fail === true) throw new Error('fictional transport unavailable');
        f.loseResponse = fail === 'afterCommit';
        const before = count();
        try { return await executeTeacherMoneyCallable(request, f.dependencies); }
        finally { if (count() !== before) onCommitted(); }
      }
      return recoverTeacherMoneyCallable(request, f.dependencies,
        { getTeacherMoneyStatusV2: 'status', cancelTeacherMoneyV2: 'cancel', acknowledgeTeacherMoneyV2: 'acknowledge' }[name]);
    },
  });
  h.ctx.parseTeacherMoneyAmount = parseTeacherMoneyAmount;
  h.ctx.moneyClient = client;
  vm.runInContext('v2TeacherMoneyClient = moneyClient;', h.ctx);
  assert.equal((await client.check()).status, 'idle');
  return { ...h, f, client, values, calls, count, caches,
    get draftResets() { return h.draftResets; },
    async finishMoney() { unlock(); for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); },
  };
}

for (const mode of ['quick', 'custom']) {
  const submit = h => mode === 'quick' ? h.ctx.quickCash('Subtract', 4) : h.ctx.saveTeacherTransaction();

  test(`${mode} V2 intent confirms one server debit and blocks competing mutations until acknowledgment`, async () => {
    const h = await moneyFixture();
    const pending = submit(h);
    assert.equal(h.ctx.data.students[0].balance, 10);
    assert.equal(h.ctx.data.transactions.length, 3);
    assert.equal(h.ctx.requireTeacher(), false);
    await submit(h); h.ctx.approveTransaction(1);
    await h.finishMoney(); await pending;
    assert.equal(h.count(), 1); assert.equal(h.f.student(1).balance, 6);
    assert.equal(h.ctx.data.students[0].balance, 6);
    assert.equal(h.client.getState().status, 'committed');
    assert.equal(h.caches.size, 1, 'the actual reload callback writes a confirmed cache with captured identity');
    const cached = [...h.caches.values()][0];
    assert.equal(cached.projectId, 'demo-approval');
    assert.equal(cached.data.students[0].balance, 6);
    assert.equal(h.ctx.requireTeacher(), false);
    await h.ctx.acknowledgeTeacherMoneySave();
    assert.equal(h.values.size, 0); assert.equal(h.ctx.requireTeacher(), true);
    await h.ctx.approveTransaction(1);
    assert.equal(h.store.get('classrooms/test-room/students/1').balance, 11);
    assert.equal(h.store.get('classrooms/test-room/transactions/1').status, 'Approved');
    if (mode === 'custom') assert.equal(h.draftResets, 1);
  });

  test(`${mode} lost response recovers one debit, while an uncommitted request is cancelled without money`, async () => {
    for (const fail of [true, 'afterCommit']) {
      const h = await moneyFixture({ fail });
      const pending = submit(h); await h.finishMoney(); await pending;
      assert.equal(h.count(), fail === true ? 0 : 1);
      assert.equal(h.ctx.data.students[0].balance, fail === true ? 10 : 6);
      assert.equal(h.calls.filter(name => name === 'executeTeacherMoneyV2').length, 1);
      assert.equal(h.client.getState().status, fail === true ? 'idle' : 'committed');
      if (mode === 'custom') assert.equal(h.draftResets, 0, 'a minimal recovered receipt does not prove the current draft');
    }
  });

  test(`${mode} another device's pending receipt cannot claim the new draft was saved or clear it`, async () => {
    const h = await moneyFixture();
    const auth = h.f.dependencies.auth;
    const preview = await planTeacherMoneyCallable({ auth, data: h.f.request() }, h.f.dependencies);
    await executeTeacherMoneyCallable({ auth, data: { request: preview.request, plan: preview.plan } }, h.f.dependencies);
    await submit(h);
    assert.equal(h.count(), 1); assert.equal(h.ctx.data.students[0].balance, 11);
    assert.equal(h.calls.filter(name => name === 'executeTeacherMoneyV2').length, 0);
    assert.equal(h.draftResets, 0);
    assert.match(h.ctx.message, /saved action was recovered.*draft was kept/);
    assert.doesNotMatch(h.ctx.message, /paid|saved and approved/);
    assert.equal(h.ctx.requireTeacher(), false);
  });

  test(`${mode} receipt-only acknowledgment survives failed reload and retains the refresh block`, async () => {
    const h = await moneyFixture({ failReload: true });
    const pending = submit(h); await h.finishMoney(); await pending;
    assert.equal(h.count(), 1); assert.equal(h.f.student(1).balance, 6);
    assert.equal(h.ctx.data.students[0].balance, 10);
    assert.match(h.ctx.message, /Saved; refresh/);
    await h.ctx.acknowledgeTeacherMoneySave();
    assert.equal(h.values.size, 0); assert.equal(h.ctx.requireTeacher(), false);
    assert.equal(h.draftResets, 0);
  });

  test(`${mode} stale session completion preserves the outgoing marker without publishing or clearing drafts`, async () => {
    let h;
    h = await moneyFixture({ onCommitted: () => {
      h.ctx.v2TenantSession.invalidate('fictional-classroom-switch');
      h.ctx.data = { students: [{ id: 1, balance: 99 }], transactions: [] };
      h.ctx.v2LastPersistedData = structuredClone(h.ctx.data); h.ctx.message = 'Incoming classroom';
    } });
    const pending = submit(h); await h.finishMoney(); await pending;
    assert.equal(h.count(), 1); assert.equal(h.f.student(1).balance, 6);
    assert.equal(h.ctx.data.students[0].balance, 99); assert.equal(h.ctx.message, 'Incoming classroom');
    assert.equal(h.values.size, 1); assert.equal(h.draftResets, 0);
  });

  test(`${mode} local interference keeps the confirmed receipt but cannot overwrite an unconfirmed draft`, async () => {
    const h = await moneyFixture();
    const pending = submit(h);
    h.ctx.data = structuredClone(h.ctx.data); h.ctx.data.students[0].balance = 99;
    await h.finishMoney(); await pending;
    assert.equal(h.count(), 1); assert.equal(h.f.student(1).balance, 6);
    assert.equal(h.ctx.data.students[0].balance, 99); assert.equal(h.draftResets, 0);
    assert.equal(h.ctx.requireTeacher(), false); assert.equal(h.client.getState().status, 'committed');
  });

  test(`${mode} initial render failure releases the operation lock without dispatch or writes`, async () => {
    const h = await moneyFixture(); let renders = 0;
    h.ctx.render = () => { if (++renders === 1) throw new Error('fictional initial render failure'); };
    await submit(h);
    assert.equal(vm.runInContext('teacherMoneySaveOperation', h.ctx), null);
    assert.equal(h.calls.includes('executeTeacherMoneyV2'), false); assert.equal(h.count(), 0);
    assert.equal(h.ctx.data.students[0].balance, 10); assert.equal(h.draftResets, 0);
    assert.equal(h.ctx.requireTeacher(), false);
  });

  test(`${mode} pending operations, a dirty baseline and the approval queue still refuse a new server intent`, async () => {
    for (const flag of ['studentLifecyclePending', 'bulkOperationPending', 'studentPinResetPending',
      'rosterBalanceSaveOperation', 'rentUpdatePending', 'activeClassroomSaves']) {
      const h = await moneyFixture(); vm.runInContext(`${flag} = 1`, h.ctx);
      await submit(h); assert.equal(h.calls.includes('executeTeacherMoneyV2'), false);
      assert.match(h.ctx.message, /Another classroom change is saving/);
    }
    const h = await moneyFixture(); h.ctx.data.students[0].balance = 11;
    await submit(h); assert.match(h.ctx.message, /unconfirmed local changes/);
    const queued = await moneyFixture(); queued.ctx.approveTransaction(1); await submit(queued);
    await queued.finishMoney(); assert.equal(queued.count(), 1); assert.equal(queued.store.get('classrooms/test-room/students/1').balance, 15);
  });
}
