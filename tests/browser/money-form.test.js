// Offline DOM regression tests: actual application rendering/event handlers,
// fictional ready teacher sessions, the actual money client/server services,
// and optimistic in-memory storage. No Firebase startup or external network.
// These prove DOM-to-service behavior, separately from Firestore SDK/emulator
// persistence and callable HTTP/Auth checks.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from '@playwright/test';
import { attachTeacherMoneyHarness } from './teacherMoneyHarness.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../../index.html');
const start = source.indexOf('    const defaultSettings =');
const end = source.indexOf('    async function submitV2Onboarding()');
assert.ok(start > 0 && end > start, 'application render/reset source boundaries exist');
const appSource = source.slice(start, end);
const saveStart = appSource.indexOf('    async function saveData() {');
const saveEnd = appSource.indexOf('    async function reloadV2ClassroomAfterSaveConflict()');
assert.ok(saveStart > 0 && saveEnd > saveStart, 'external save boundary exists');
const isolatedAppSource = appSource.slice(0, saveStart) + `
async function saveData() { return saveClassroomCandidate(data); }
async function saveClassroomCandidate(candidate) {
  const captured = v2TenantSession.captureIdentity();
  savedSnapshots.push(JSON.parse(JSON.stringify(candidate)));
  if (saveGate) await saveGate;
  if (IS_MULTI_TEACHER_V2_ENABLED && !v2TenantSession.validateCapturedIdentity(captured)) return { executed: false, reason: 'stale-epoch-ignored' };
  if (rejectSave) return { executed: false, reason: 'save-failed' };
  v2LastPersistedData = JSON.parse(JSON.stringify(candidate));
  return { executed: true };
}
` + appSource.slice(saveEnd);
// Retain the real module-to-inline-handler exports. Missing window wiring must
// fail these interactions rather than being hidden by classic-script globals.
const handlerNames = [
  'setDashboardMoneyTool', 'setDashboardSectionExpanded', 'setQuickCashStudent',
  'quickCash', 'setCustomTransactionMode', 'toggleTeacherChoiceMemo',
  'updateCustomTransactionDraft', 'setTransactionTarget', 'saveTeacherTransaction',
  'setScreen', 'saveSettingsLists', 'removeStudent', 'addStudent', 'importBackup',
  'checkTeacherMoneySave', 'acknowledgeTeacherMoneySave', 'saveStudentName', 'adjustStudentBalance',
  'updateRosterDraft', 'resetBalancesToZero', 'approveTransaction', 'denyTransaction', 'approveAllCreditRequests'
];
const handlerExports = source.split('\n').filter(line =>
  handlerNames.some(name => line === `window.${name} = ${name};`)).join('\n');
const helpers = [
  '../../src/phase2b/tenantSession.js',
  '../../src/phase2b/approvalQueue.js',
  '../../src/phase2b/studentDisplay.js',
  '../../src/phase2b/transactionCategoryDisplay.js',
  '../../src/legacy/backupImport.js'
].map(path => read(path).replace(/^export /gm, '')).join('\n');
const moneyHelpers = 'const {createTeacherMoneyClient, parseTeacherMoneyAmount, parseTeacherMoneyBalance, teacherMoneyBalanceCents} = (() => {\n' +
  read('../../src/phase3/teacherMoneyClient.js').replace(/^export /gm, '') +
  '\nreturn {createTeacherMoneyClient, parseTeacherMoneyAmount, parseTeacherMoneyBalance, teacherMoneyBalanceCents}; })();';

const setup = `
const IS_MULTI_TEACHER_V2_ENABLED = true;
const TEACHER_UID = 'fictional-legacy-teacher';
const MAX_RENT_AMOUNT = 1000000;
const auth = { currentUser: null };
const v2TenantSession = new TenantSession({
  projectId: 'demo-money-form', storageAdapter: {},
  onResetGlobals: () => resetAllGlobalState()
});
let v2LastPersistedData = null;
`;

const probe = `
const savedSnapshots = [];
let saveGate = null;
let releaseSave;
let rejectSave = false;
let rejectReload = false;
let sessionNumber = 0;
window.moneyFormTest = {
  async newSession() {
    sessionNumber += 1;
    const uid = IS_MULTI_TEACHER_V2_ENABLED ? 'fictional-teacher-' + sessionNumber : TEACHER_UID;
    auth.currentUser = { uid };
    v2TenantSession.invalidate('auth-observer-change', { uid, state: SESSION_STATES.RESOLVING });
    v2TenantSession.transitionTo(SESSION_STATES.ACTIVE, {
      uid, role: 'teacher', classroomId: 'fictional-room-' + sessionNumber,
      classroom: { name: 'Fictional Classroom ' + sessionNumber }, teacher: { displayName: uid }
    });
    v2TenantSession.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    v2TenantSession.transitionTo(SESSION_STATES.READY);
    data = cloneDefault();
    data.students = [
      { id: 1, name: 'Fictional Avery', balance: 20, frozen: false, transactions: [] },
      { id: 2, name: 'Fictional Blake', balance: 20, frozen: false, transactions: [] }
    ];
    v2LastPersistedData = JSON.parse(JSON.stringify(data));
    screen = 'teacher';
    isTeacher = true;
    savedSnapshots.length = 0;
    rejectReload = false;
    if (IS_MULTI_TEACHER_V2_ENABLED) {
      const stored = new Map();
      v2TeacherMoneyClient = createTeacherMoneyClient({ session: v2TenantSession,
        currentUid: () => auth.currentUser?.uid,
        storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
        call: async (name, payload) => {
          const captured = v2TenantSession.captureIdentity();
          if (name === 'executeTeacherMoneyV2') {
            savedSnapshots.push({ pending: true });
            if (saveGate) await saveGate;
            if (rejectSave) throw new Error('fictional transport failure');
          }
          return window.__moneyTestServer({ name, data: payload, uid: captured.uid, classroomId: captured.classroomId });
        },
        reload: async captured => {
          if (rejectReload) throw new Error('fictional classroom refresh failure');
          const loaded = await window.__moneyTestServer({ name: 'load', uid: captured.uid, classroomId: captured.classroomId });
          if (!v2TenantSession.validateCapturedIdentity(captured)) return false;
          data = { ...data, ...loaded };
          v2LastPersistedData = JSON.parse(JSON.stringify(data));
          if (savedSnapshots.length) savedSnapshots[savedSnapshots.length - 1] = JSON.parse(JSON.stringify(data));
          return true;
        },
        confirmPlan: preview => { window.lastMoneyPreview = preview; return confirmTeacherMoneyPlan(preview); }, notify: () => render()
      });
      await v2TeacherMoneyClient.check();
    }
    render();
  },
  holdSave(fail = false) { rejectSave = fail; saveGate = new Promise(resolve => { releaseSave = resolve; }); },
  failReload(fail = true) { rejectReload = fail; },
  releaseSave() { releaseSave(); saveGate = null; },
  balances() { return data.students.map(student => student.balance); },
  async pendingRequests() {
    const identity = { uid: v2TenantSession.uid, classroomId: v2TenantSession.classroomId };
    await window.__moneyTestServer({ name: 'seedPending', ...identity });
    data = { ...data, ...await window.__moneyTestServer({ name: 'load', ...identity }) };
    v2LastPersistedData = JSON.parse(JSON.stringify(data)); render();
  },
  async heavyClass() {
    const identity = { uid: v2TenantSession.uid, classroomId: v2TenantSession.classroomId };
    await window.__moneyTestServer({ name: 'heavyClass', ...identity });
    data = { ...data, ...await window.__moneyTestServer({ name: 'load', ...identity }) };
    v2LastPersistedData = JSON.parse(JSON.stringify(data)); render();
  },
  async withoutMoneyMetadata() {
    await window.__moneyTestServer({ name: 'removeMoneyMetadata',
      uid: v2TenantSession.uid, classroomId: v2TenantSession.classroomId });
    v2TeacherMoneyClient.reset();
    await checkTeacherMoneySave();
    render();
  },
  async removeStudent(id) {
    await window.__moneyTestServer({ name: 'remove', data: { studentId: id }, uid: v2TenantSession.uid, classroomId: v2TenantSession.classroomId });
    data.students = data.students.filter(s => s.id !== id); v2LastPersistedData = JSON.parse(JSON.stringify(data)); render();
  },
  state() { return { ...(v2TeacherMoneyClient?.getState() || { status: 'legacy' }), operationBusy: Boolean(teacherMoneySaveOperation) }; },
  async settle() {
    if (v2TeacherMoneyClient?.getState().status === 'committed') await acknowledgeTeacherMoneySave();
    render();
  },
  identity() { return v2TenantSession.captureIdentity(); },
  snapshots() { return JSON.parse(JSON.stringify(savedSnapshots)); },
  redraw() { render(); }
};
await window.moneyFormTest.newSession();
`;

for (const engine of [chromium, webkit]) {
  describe(`teacher money forms (${engine.name()})`, () => {
    let browser;
    before(async () => { browser = await engine.launch({ headless: true }); });
    after(async () => { await browser?.close(); });

    async function openForm(t, { legacy = false, confirmMoney = true } = {}) {
      const page = await browser.newPage();
      page.moneyConfirmations = [];
      page.on('dialog', async dialog => {
        if (dialog.message().startsWith('Apply ')) page.moneyConfirmations.push(dialog.message());
        if (confirmMoney) await dialog.accept(); else await dialog.dismiss();
      });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      t.after(async () => {
        await page.close();
        assert.deepEqual(errors, [], 'no browser JavaScript errors');
      });
      await page.route('**/*', route => route.abort());
      await attachTeacherMoneyHarness(page);
      await page.setContent('<div id="teacherMoneyRecovery" hidden></div><div id="app"></div>');
      const configuredSetup = legacy
        ? setup.replace('const IS_MULTI_TEACHER_V2_ENABLED = true;', 'const IS_MULTI_TEACHER_V2_ENABLED = false;')
        : setup;
      await page.addScriptTag({ type: 'module', content: helpers + moneyHelpers + configuredSetup + isolatedAppSource + handlerExports + '\n' + probe });
      await page.waitForFunction(() => window.moneyFormTest && !document.querySelector('#customTransactionButton, .quick-btn')?.disabled);
      assert.deepEqual(errors, [], 'application initialized without JavaScript errors');
      return page;
    }

    async function customForm(page) {
      await page.getByRole('tab', { name: 'Custom Transaction' }).click();
    }

    async function finishMoneySave(page) {
      await page.waitForFunction(() => ['committed', 'idle', 'legacy'].includes(window.moneyFormTest.state().status)
        && !window.moneyFormTest.state().operationBusy);
      await page.evaluate(() => window.moneyFormTest.settle());
    }

    test('V2 actual approval and denial buttons save server decisions and matching balances', async t => {
      const page = await openForm(t);
      await page.evaluate(() => window.moneyFormTest.pendingRequests());
      await page.locator('details').filter({ has: page.locator('button[onclick="approveTransaction(11)"]') }).locator('summary').click();
      await page.locator('button[onclick="approveTransaction(11)"]').first().click();
      await finishMoneySave(page);
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [23, 20]);
      await page.locator('button[onclick="denyTransaction(12)"]').first().click();
      await finishMoneySave(page);
      const identity = await page.evaluate(() => window.moneyFormTest.identity());
      const stored = await page.evaluate(identity => window.__moneyTestServer({ name: 'load', ...identity }), identity);
      assert.deepEqual(stored.transactions.map(row => row.status), ['Approved', 'Denied']);
      for (const student of stored.students) assert.deepEqual(student.transactions[0], stored.transactions.find(row => row.studentId === student.id));
    });

    test('removed-student pending records stay visible and outside the explicit current-roster approval group', async t => {
      const page = await openForm(t);
      await page.evaluate(() => window.moneyFormTest.pendingRequests());
      // Fictional legacy orphan: no new removal operation is claimed here.
      await page.evaluate(() => window.moneyFormTest.removeStudent(2));
      await page.evaluate(() => window.setScreen('approvals'));
      assert.equal(await page.getByRole('heading', {name:'Pending records for removed students'}).count(), 1);
      assert.equal(await page.locator('button[onclick="approveTransaction(12)"]').count(), 0);
      await page.getByRole('button', {name:'Approve All Credits', exact:true}).click();
      await finishMoneySave(page);
      const identity = await page.evaluate(() => window.moneyFormTest.identity());
      const stored = await page.evaluate(identity => window.__moneyTestServer({name:'load', ...identity}), identity);
      assert.equal(stored.transactions.find(row => row.id === 11).status, 'Approved');
      assert.equal(stored.transactions.find(row => row.id === 12).status, 'Pending');
      assert.deepEqual(await page.evaluate(() => window.lastMoneyPreview.request.transactionIds), [11]);
    });

    test('V2 failed adjustment keeps its typed draft, then clears it on a new tenant session', async t => {
      const page = await openForm(t);
      await page.evaluate(() => window.setScreen('roster'));
      await page.locator('#balance-1').fill('12.34');
      await page.evaluate(() => window.moneyFormTest.holdSave(true));
      await page.locator('button[onclick="adjustStudentBalance(1)"]').click();
      assert.equal(await page.locator('#balance-1').inputValue(), '12.34');
      await page.evaluate(() => window.moneyFormTest.releaseSave());
      await finishMoneySave(page);
      assert.equal(await page.locator('#balance-1').inputValue(), '12.34');
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [20, 20]);
      await page.evaluate(() => window.moneyFormTest.newSession());
      await page.evaluate(() => window.setScreen('roster'));
      assert.equal(await page.locator('#balance-1').inputValue(), '20');
    });

    test('V2 roster buttons separate name from balance; reset records each confirmed adjustment', async t => {
      const page = await openForm(t);
      await page.evaluate(() => window.moneyFormTest.pendingRequests());
      await page.evaluate(() => window.setScreen('roster'));
      await page.locator('#name-1').fill('Fictional Renamed');
      await page.locator('#balance-1').fill('99');
      await page.locator('button[onclick="saveStudentName(1)"]').click();
      await page.waitForFunction(() => !window.moneyFormTest.state().operationBusy && document.querySelector('#name-1')?.value === 'Fictional Renamed');
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [20, 20]);
      await page.locator('#balance-1').fill('-1.25');
      await page.locator('button[onclick="adjustStudentBalance(1)"]').click();
      await finishMoneySave(page);
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [-1.25, 20]);
      await page.evaluate(() => window.setScreen('settings'));
      await page.getByRole('button', { name: 'Reset All Balances to $0', exact: true }).click();
      await finishMoneySave(page);
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [0, 0]);
      const identity = await page.evaluate(() => window.moneyFormTest.identity());
      const stored = await page.evaluate(identity => window.__moneyTestServer({ name: 'load', ...identity }), identity);
      assert.equal(stored.transactions.find(row => row.id === 11).studentName, 'Fictional Avery');
      assert.equal(stored.transactions.filter(row => row.category === 'Balance adjustment').length, 3);
    });

    async function enterDebit(page) {
      await customForm(page);
      await page.locator('#subtractModeButton').click();
      await page.locator('#transactionAmount').fill('7');
      await page.locator('#transactionReason').selectOption("Teacher's Choice");
      await page.locator('#teacherChoiceMemo').fill('Rent "September" <classroom>');
    }

    async function assertDebitDraft(page) {
      assert.equal(await page.locator('#transactionType').inputValue(), 'Subtract');
      assert.equal(await page.locator('#transactionAmount').inputValue(), '7');
      assert.equal(await page.locator('#transactionReason').inputValue(), "Teacher's Choice");
      assert.equal(await page.locator('#teacherChoiceMemo').inputValue(), 'Rent "September" <classroom>');
      assert.equal(await page.locator('#customTransactionButton').innerText(), 'Subtract Money');
    }

    for (const legacy of [false, true]) {
      test(`${legacy ? 'legacy' : 'V2'} session reset prevents an outgoing save from clearing the new draft`, async t => {
        const page = await openForm(t, { legacy });
        await enterDebit(page);
        await page.locator('.student-check[value="2"]').check();
        await page.evaluate(() => window.moneyFormTest.holdSave());
        await page.locator('#customTransactionButton').click();
        await page.evaluate(() => window.moneyFormTest.newSession());
        await enterDebit(page);
        await page.locator('#transactionAmount').fill('9');
        await page.locator('.student-check[value="1"]').check();
        await page.evaluate(() => window.moneyFormTest.releaseSave());
        assert.equal(await page.locator('#transactionAmount').inputValue(), '9');
        assert.equal(await page.locator('.student-check[value="1"]').isChecked(), true);
        assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [20, 20]);
        assert.doesNotMatch(await page.locator('body').innerText(), /saved and approved/);
      });

      for (const tool of ['quick', 'custom']) {
        for (const fail of [false, true]) {
          test(`${legacy ? 'legacy' : 'V2'} ${tool} waits for ${fail ? 'rejected' : 'confirmed'} save without losing its draft`, async t => {
            const page = await openForm(t, { legacy });
            if (tool === 'custom') {
              await enterDebit(page);
              await page.locator('.student-check[value="2"]').check();
            } else {
              await page.locator('#quickStudent').selectOption('2');
            }
            await page.evaluate(fail => window.moneyFormTest.holdSave(fail), fail);
            const button = tool === 'custom'
              ? page.locator('#customTransactionButton')
              : page.getByRole('button', { name: '-$1', exact: true });
            await button.click();
            await page.waitForFunction(() => window.moneyFormTest.snapshots().length === 1);
            assert.equal(await button.isDisabled(), true);
            assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [20, 20]);
            assert.match(await page.locator('body').innerText(), /Saving transaction/);
            // A duplicate handler invocation bypasses the disabled DOM button;
            // the runtime guard must still prevent a second save.
            await page.evaluate(tool => {
              if (tool === 'custom') window.saveTeacherTransaction();
              else window.quickCash('Subtract', 1);
            }, tool);
            assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, 1);
            if (tool === 'custom') {
              assert.equal(await page.locator('#transactionAmount').isDisabled(), true);
              await assertDebitDraft(page);
            }
            await page.evaluate(() => window.moneyFormTest.releaseSave());
            if (!fail && !legacy) {
              await page.waitForFunction(() => window.moneyFormTest.state().status === 'committed' && !window.moneyFormTest.state().operationBusy);
              assert.match(await page.locator('body').innerText(), tool === 'custom' ? /saved and approved/ : /paid/);
              assert.equal(await button.isDisabled(), true, 'receipt acknowledgment blocks the next money action');
              assert.equal(await page.getByRole('button', { name: 'Acknowledge saved action', exact: true }).count(), 1);
            }
            await finishMoneySave(page);
            await page.waitForFunction(() => !document.querySelector('#customTransactionButton, .quick-btn')?.disabled);
            if (fail) {
              assert.match(await page.locator('body').innerText(), legacy ? /could not be confirmed.*Refresh/ : /cancelled without applying money.*Refresh/);
              assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [20, 20]);
              if (tool === 'custom') {
                await assertDebitDraft(page);
                assert.equal(await page.locator('.student-check[value="2"]').isChecked(), true);
              }
              if (legacy) {
                await button.click();
                assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, 1);
              }
            } else {
              assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [20, tool === 'custom' ? 13 : 19]);
              assert.match(await page.locator('body').innerText(), legacy ? (tool === 'custom' ? /saved and approved/ : /paid/) : /Saved action acknowledged/);
              if (tool === 'custom') {
                assert.equal(await page.locator('#transactionAmount').inputValue(), '1');
                assert.equal(await page.locator('.student-check[value="2"]').isChecked(), false);
              }
            }
          });
        }
      }
    }

    test('the actual confirmation can decline a money action without dispatch or draft loss', async t => {
      const page = await openForm(t, { confirmMoney: false });
      await page.locator('#quickStudent').selectOption('2');
      await page.getByRole('button', { name: '+$5', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.snapshots()), []);
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [20, 20]);
      assert.equal(await page.locator('#quickStudent').inputValue(), '2');
      assert.match(page.moneyConfirmations[0], /Apply \+\$5 to these 1 students/);
      assert.match(page.moneyConfirmations[0], /Fictional Blake: \$20 → \$25/);
      assert.match(await page.locator('body').innerText(), /cancelled before saving/);
    });

    for (const type of ['Add', 'Subtract']) test('history-heavy Whole Class ' + type + ' keeps the exact unpaid remainder for separately confirmed saves', async t => {
      const page = await openForm(t);
      await page.evaluate(() => window.moneyFormTest.heavyClass());
      await customForm(page);
      if (type === 'Subtract') {
        await page.locator('#subtractModeButton').click();
        await page.locator('#transactionReason').selectOption('Rent');
      }
      await page.locator('#transactionTarget').selectOption('whole');
      await page.locator('#customTransactionButton').click();
      await page.waitForFunction(() => window.moneyFormTest.state().status === 'committed' && !window.moneyFormTest.state().operationBusy);
      const preview = await page.evaluate(() => window.lastMoneyPreview);
      assert.ok(preview.selected.length > 0 && preview.selected.length < 30);
      assert.equal(preview.selected.length + preview.notYetPlanned.length, 30);
      assert.match(page.moneyConfirmations[0], new RegExp(`${preview.notYetPlanned.length} other selected students are not included`));
      assert.match(await page.locator('body').innerText(), new RegExp(`${preview.notYetPlanned.length} selected students were not included`));
      for (const id of preview.notYetPlanned) {
        assert.ok(page.moneyConfirmations[0].includes('Fictional student ' + id), 'confirmation names every excluded student');
        assert.ok((await page.locator('body').innerText()).includes('Fictional student ' + id), 'result names every remaining student');
      }
      assert.equal(await page.locator('#transactionTarget').inputValue(), 'selected');
      assert.deepEqual(await page.locator('.student-check:checked').evaluateAll(inputs => inputs.map(input => Number(input.value)).sort((a, b) => a - b)), preview.notYetPlanned);
      assert.equal(await page.locator('#transactionType').inputValue(), type);
      const balances = await page.evaluate(() => window.moneyFormTest.balances());
      const paidBalance = type === 'Add' ? 21 : 19;
      assert.deepEqual(balances, balances.map((_, i) => i < preview.selected.length ? paidBalance : 20));
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, 1);
      await finishMoneySave(page);
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, 1);
      assert.equal(page.moneyConfirmations.length, 1);
      let remainder = preview.notYetPlanned;
      const paid = new Set(preview.selected.map(row => row.studentId));
      let saves = 1;
      while (remainder.length) {
        assert.deepEqual(await page.locator('.student-check:checked').evaluateAll(inputs => inputs.map(input => Number(input.value)).sort((a, b) => a - b)), remainder);
        await page.locator('#customTransactionButton').click();
        await page.waitForFunction(() => window.moneyFormTest.state().status === 'committed' && !window.moneyFormTest.state().operationBusy);
        const next = await page.evaluate(() => window.lastMoneyPreview);
        assert.deepEqual([...next.selected.map(row => row.studentId), ...next.notYetPlanned], remainder, 'fresh preview covers only the prior unpaid IDs');
        for (const row of next.selected) {
          assert.equal(paid.has(row.studentId), false, 'a previously paid student is never selected again');
          paid.add(row.studentId);
        }
        remainder = next.notYetPlanned;
        saves++;
        assert.equal(page.moneyConfirmations.length, saves, 'every group receives its own native confirmation');
        await finishMoneySave(page);
        assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, saves, 'acknowledgment never submits another group');
      }
      const final = (await page.evaluate(() => window.moneyFormTest.snapshots())).at(-1);
      assert.equal(paid.size, 30);
      assert.deepEqual(final.students.map(s => s.balance), Array(30).fill(paidBalance));
      assert.equal(final.transactions.length, 30);
      for (const student of final.students) {
        assert.equal(final.transactions.filter(tx => tx.studentId === student.id).length, 1);
        assert.equal(student.transactions.length, 201, 'each student receives exactly one new mirror entry');
      }
      assert.equal(await page.locator('#transactionTarget').inputValue(), 'selected');
      assert.equal(await page.locator('.student-check:checked').count(), 0);
    });

    test('a confirmed partial save keeps only the unpaid draft after failed refresh and status recovery', async t => {
      const page = await openForm(t);
      await page.evaluate(() => window.moneyFormTest.heavyClass());
      await customForm(page);
      await page.locator('#transactionTarget').selectOption('whole');
      await page.evaluate(() => window.moneyFormTest.failReload());
      await page.locator('#customTransactionButton').click();
      await page.waitForFunction(() => window.moneyFormTest.state().status === 'committed' && !window.moneyFormTest.state().operationBusy);
      const preview = await page.evaluate(() => window.lastMoneyPreview);
      assert.ok(preview.notYetPlanned.length > 0);
      assert.equal((await page.evaluate(() => window.moneyFormTest.state())).refreshed, false);
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), Array(30).fill(20), 'no optimistic classroom money publication');
      assert.equal(await page.locator('#transactionTarget').inputValue(), 'selected');
      assert.deepEqual(await page.locator('.student-check:checked').evaluateAll(inputs => inputs.map(input => Number(input.value)).sort((a, b) => a - b)), preview.notYetPlanned);
      assert.equal(await page.locator('#customTransactionButton').isDisabled(), true);
      assert.equal(page.moneyConfirmations.length, 1);
      await page.evaluate(async () => { window.moneyFormTest.failReload(false); await window.checkTeacherMoneySave(); });
      assert.equal((await page.evaluate(() => window.moneyFormTest.state())).refreshed, true);
      await finishMoneySave(page);
      assert.deepEqual(await page.locator('.student-check:checked').evaluateAll(inputs => inputs.map(input => Number(input.value)).sort((a, b) => a - b)), preview.notYetPlanned);
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, 1);
      assert.equal(page.moneyConfirmations.length, 1, 'refresh/status/acknowledgment never submits the next group');
    });

    test('missing money metadata locks money and classroom edits with an accurate status message', async t => {
      const page = await openForm(t);
      await page.evaluate(() => window.moneyFormTest.withoutMoneyMetadata());
      assert.equal((await page.evaluate(() => window.moneyFormTest.state())).status, 'unresolved');
      assert.match(await page.locator('#teacherMoneyRecovery').innerText(), /Money status could not be checked/);
      assert.match(await page.locator('#teacherMoneyRecovery').innerText(), /Classroom changes stay locked/);
      assert.doesNotMatch(await page.locator('#teacherMoneyRecovery').innerText(), /Check the previous money save/);
      assert.doesNotMatch(await page.locator('body').innerText(), /The save is still not confirmed/);
      assert.equal(await page.getByRole('button', { name: '+$5', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Roster', exact: true }).click();
      await page.locator('#newStudentName').fill('Fictional Casey');
      await page.getByRole('button', { name: 'Add Student', exact: true }).click();
      assert.match(await page.locator('body').innerText(), /Money status must be confirmed before classroom changes can continue/);
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.snapshots()), []);
      assert.deepEqual(await page.evaluate(() => window.moneyFormTest.balances()), [20, 20]);
      assert.equal(page.moneyConfirmations.length, 0);
    });

    test('Quick Cash keeps the chosen recipient through repeated clicks and unrelated redraws', async t => {
      const page = await openForm(t);
      await page.locator('#quickStudent').selectOption('2');
      await page.evaluate(() => window.moneyFormTest.redraw());
      assert.equal(await page.locator('#quickStudent').inputValue(), '2');
      await page.getByRole('button', { name: '+$5', exact: true }).click();
      await finishMoneySave(page);
      assert.equal(await page.locator('#quickStudent').inputValue(), '2');
      await page.getByRole('button', { name: '-$1', exact: true }).click();
      await finishMoneySave(page);
      const snapshots = await page.evaluate(() => window.moneyFormTest.snapshots());
      assert.equal(snapshots.length, 2);
      assert.deepEqual(snapshots[1].students.map(s => s.balance), [20, 24]);
      assert.deepEqual(snapshots[1].transactions.map(tx => tx.studentId), [2, 2]);
    });

    test('switching to Whole Class retains the debit, amount, category and memo in the submitted payload', async t => {
      const page = await openForm(t);
      await enterDebit(page);
      await page.locator('#transactionTarget').selectOption('whole');
      await assertDebitDraft(page);
      await page.locator('#customTransactionButton').click();
      await finishMoneySave(page);
      const snapshots = await page.evaluate(() => window.moneyFormTest.snapshots());
      assert.equal(snapshots.length, 1);
      assert.deepEqual(snapshots[0].students.map(s => s.balance), [13, 13]);
      assert.ok(snapshots[0].transactions.every(tx =>
        tx.type === 'Subtract' && tx.amount === 7 && tx.reason === "Teacher's Choice"
        && tx.memo === 'Rent "September" <classroom>'));
    });

    test('Selected Students opens the student picker without an extra click', async t => {
      const page = await openForm(t);
      await customForm(page);
      const studentPicker = page.locator('[data-testid="dashboard-student-picker"]');
      assert.equal(await studentPicker.evaluate(details => details.open), true);
      await studentPicker.locator('summary').click();
      await page.locator('#transactionTarget').selectOption('whole');
      await page.locator('#transactionTarget').selectOption('selected');
      assert.equal(await studentPicker.evaluate(details => details.open), true);
    });

    test('checked recipients and the draft survive target round trips and switching money tools', async t => {
      const page = await openForm(t);
      await enterDebit(page);
      await page.locator('.student-check[value="2"]').check();
      await page.locator('#transactionTarget').selectOption('whole');
      await page.locator('#transactionTarget').selectOption('selected');
      await page.getByRole('tab', { name: 'Quick Cash' }).click();
      await customForm(page);
      await assertDebitDraft(page);
      assert.equal(await page.locator('.student-check[value="2"]').isChecked(), true);
      assert.equal(await page.locator('.student-check[value="1"]').isChecked(), false);
      await page.locator('#customTransactionButton').click();
      await finishMoneySave(page);
      const snapshots = await page.evaluate(() => window.moneyFormTest.snapshots());
      assert.equal(snapshots.length, 1);
      assert.deepEqual(snapshots[0].students.map(s => s.balance), [20, 13]);
      assert.deepEqual(snapshots[0].transactions.map(tx => tx.studentId), [2]);
    });

    test('validation and notification redraws retain an unfinished custom transaction', async t => {
      const page = await openForm(t);
      await enterDebit(page);
      await page.locator('#customTransactionButton').click();
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, 0);
      await assertDebitDraft(page);
      await page.evaluate(() => window.moneyFormTest.redraw());
      await assertDebitDraft(page);
    });

    test('a removed Quick Cash recipient is not replaced with the first remaining student', async t => {
      const page = await openForm(t);
      await page.locator('#quickStudent').selectOption('2');
      await page.evaluate(() => window.moneyFormTest.removeStudent(2));
      assert.equal(await page.locator('#quickStudent').inputValue(), '');
      await page.getByRole('button', { name: '+$5', exact: true }).click();
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, 0);
      await page.locator('#quickStudent').selectOption('1');
      await page.getByRole('button', { name: '+$5', exact: true }).click();
      await finishMoneySave(page);
      const snapshots = await page.evaluate(() => window.moneyFormTest.snapshots());
      assert.equal(snapshots.length, 1);
      assert.deepEqual(snapshots[0].students.map(s => s.balance), [25]);
    });

    test('the production global reset clears drafts even when the next classroom reuses student IDs', async t => {
      const page = await openForm(t);
      await page.locator('#quickStudent').selectOption('2');
      await enterDebit(page);
      await page.locator('.student-check[value="2"]').check();
      await page.locator('#transactionTarget').selectOption('whole');
      const previous = await page.evaluate(() => window.moneyFormTest.identity());
      await page.evaluate(() => window.moneyFormTest.newSession());
      const next = await page.evaluate(() => window.moneyFormTest.identity());
      assert.notEqual(next.uid, previous.uid);
      assert.notEqual(next.classroomId, previous.classroomId);
      assert.ok(next.epoch > previous.epoch);
      assert.notEqual(await page.locator('#quickStudent').inputValue(), '2');
      await customForm(page);
      assert.equal(await page.locator('#transactionType').inputValue(), 'Add');
      assert.equal(await page.locator('#transactionAmount').inputValue(), '1');
      assert.equal(await page.locator('#transactionTarget').inputValue(), 'selected');
      assert.equal(await page.locator('#teacherChoiceMemo').inputValue(), '');
      assert.equal(await page.locator('.student-check:checked').count(), 0);
    });

    test('a submitted selected-student or whole-class transaction cannot be submitted a second time without new recipients', async t => {
      const page = await openForm(t);
      for (const scope of ['selected', 'whole']) {
        await page.evaluate(() => window.moneyFormTest.newSession());
        await enterDebit(page);
        if (scope === 'selected') {
          await page.locator('.student-check[value="2"]').check();
          await page.locator('[data-testid="dashboard-student-picker"] summary').click();
        } else {
          await page.locator('#transactionTarget').selectOption('whole');
        }
        await page.locator('#customTransactionButton').click();
        await finishMoneySave(page);
        await page.locator('#customTransactionButton').click();
        const snapshots = await page.evaluate(() => window.moneyFormTest.snapshots());
        assert.equal(snapshots.length, 1, `${scope}: second press must not submit another transaction`);
        assert.deepEqual(snapshots[0].students.map(s => s.balance), scope === 'whole' ? [13, 13] : [20, 13]);
        assert.equal(await page.locator('#transactionTarget').inputValue(), 'selected');
        assert.equal(await page.locator('.student-check:checked').count(), 0);
        assert.equal(await page.locator('#teacherChoiceMemo').inputValue(), '');
      }
    });

    test('deleting a drafted category in Manage Lists clears its memo and requires an explicit replacement', async t => {
      const page = await openForm(t);
      await customForm(page);
      await page.locator('#transactionReason').selectOption("Teacher's Choice");
      await page.locator('#teacherChoiceMemo').fill('Late to class');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Manage Lists', exact: true }).click();
      await page.locator('#addMoneyCategoryList').fill('Homework\nClass Job');
      await page.getByRole('button', { name: 'Save Lists', exact: true }).click();
      await page.evaluate(() => window.setScreen('teacher'));
      await customForm(page);
      assert.equal(await page.locator('#transactionReason').inputValue(), '');
      assert.equal(await page.locator('#teacherChoiceMemo').inputValue(), '');
      assert.equal(await page.locator('#teacherChoiceMemoWrap').evaluate(el => el.classList.contains('visible')), false);
      await page.locator('#transactionTarget').selectOption('whole');
      const before = (await page.evaluate(() => window.moneyFormTest.snapshots())).length;
      await page.locator('#customTransactionButton').click();
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, before);
      await page.locator('#subtractModeButton').click();
      assert.equal(await page.locator('#transactionReason').inputValue(), '');
      await page.locator('#customTransactionButton').click();
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, before);
      await page.locator('#addModeButton').click();
      assert.equal(await page.locator('#transactionReason').inputValue(), '');
      await page.locator('#customTransactionButton').click();
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, before);
      await page.locator('#transactionReason').selectOption('Homework');
      await page.locator('#customTransactionButton').click();
      await finishMoneySave(page);
      const snapshots = await page.evaluate(() => window.moneyFormTest.snapshots());
      assert.equal(snapshots.length, before + 1);
      assert.ok(snapshots.at(-1).transactions.every(tx => tx.reason === 'Homework' && tx.memo === ''));
    });

    test('legacy removal and max-ID allocation do not transfer the Quick Cash selection to a replacement student', async t => {
      const page = await openForm(t, { legacy: true });
      await page.locator('#quickStudent').selectOption('2');
      await page.getByRole('button', { name: 'Roster', exact: true }).click();
      await page.evaluate(() => window.removeStudent(2));
      await page.locator('#newStudentName').fill('Fictional Casey');
      await page.locator('#newStudentPin').fill('1234');
      await page.getByRole('button', { name: 'Add Student', exact: true }).click();
      const snapshots = await page.evaluate(() => window.moneyFormTest.snapshots());
      assert.equal(snapshots.at(-1).students.find(s => s.name === 'Fictional Casey').id, 2);
      await page.evaluate(() => window.setScreen('teacher'));
      assert.equal(await page.locator('#quickStudent').inputValue(), '');
      await page.getByRole('button', { name: '+$5', exact: true }).click();
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, snapshots.length);
    });

    test('a legacy backup roster replacement clears every money-form recipient and draft', async t => {
      const page = await openForm(t, { legacy: true });
      await page.locator('#quickStudent').selectOption('2');
      await enterDebit(page);
      await page.locator('.student-check[value="2"]').check();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.locator('#backupFileSettings').setInputFiles({
        name: 'fictional-backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
          students: [{
            id: 2,
            name: 'Imported Eli',
            pin: '1234',
            balance: 0,
            frozen: false
          }],
          transactions: [],
          settings: {
            studentRequestsEnabled: true,
            studentAddRequestsEnabled: true,
            studentSubtractRequestsEnabled: true,
            purchaseRequestsEnabled: true,
            requireTeacherApproval: true,
            reasons: ['Weekly payday'],
            purchaseCategories: ['School Store'],
            addMoneyCategories: ['Homework', 'Class Job', "Teacher's Choice"],
            subtractMoneyCategories: ['Rent', "Teacher's Choice"]
          },
          loginHistory: [],
          exportedAt: '2026-09-06T12:00:00.000Z'
        }))
      });
      await page.waitForFunction(() =>
        window.moneyFormTest.snapshots().some(snapshot =>
          snapshot.students.length === 1 && snapshot.students[0].name === 'Imported Eli'));
      const afterImportCount = (await page.evaluate(() => window.moneyFormTest.snapshots())).length;
      await page.evaluate(() => window.setScreen('teacher'));
      assert.equal(await page.locator('#quickStudent').inputValue(), '');
      await page.getByRole('button', { name: '+$5', exact: true }).click();
      assert.equal((await page.evaluate(() => window.moneyFormTest.snapshots())).length, afterImportCount);
      await customForm(page);
      assert.equal(await page.locator('#transactionType').inputValue(), 'Add');
      assert.equal(await page.locator('#transactionAmount').inputValue(), '1');
      assert.equal(await page.locator('#transactionTarget').inputValue(), 'selected');
      assert.equal(await page.locator('#teacherChoiceMemo').inputValue(), '');
      assert.equal(await page.locator('.student-check:checked').count(), 0);
    });
  });
}
