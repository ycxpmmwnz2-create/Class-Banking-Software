// Offline DOM regression tests: actual application rendering/event handlers,
// fictional ready teacher sessions, and an in-memory save boundary. No Firebase
// startup or network access. These prove form behavior and attempted payloads,
// not server persistence (covered by the existing tenant/emulator suites).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from '@playwright/test';

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
async function saveData() {
  savedSnapshots.push(JSON.parse(JSON.stringify(data)));
  return { executed: true };
}
` + appSource.slice(saveEnd);
// Retain the real module-to-inline-handler exports. Missing window wiring must
// fail these interactions rather than being hidden by classic-script globals.
const handlerNames = [
  'setDashboardMoneyTool', 'setDashboardSectionExpanded', 'setQuickCashStudent',
  'quickCash', 'setCustomTransactionMode', 'toggleTeacherChoiceMemo',
  'updateCustomTransactionDraft', 'setTransactionTarget', 'saveTeacherTransaction',
  'setScreen', 'saveSettingsLists', 'removeStudent', 'addStudent', 'importBackup'
];
const handlerExports = source.split('\n').filter(line =>
  handlerNames.some(name => line === `window.${name} = ${name};`)).join('\n');
const helpers = [
  '../../src/phase2b/tenantSession.js',
  '../../src/phase2b/studentDisplay.js',
  '../../src/phase2b/transactionCategoryDisplay.js',
  '../../src/legacy/backupImport.js'
].map(path => read(path).replace(/^export /gm, '')).join('\n');

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
let sessionNumber = 0;
window.moneyFormTest = {
  newSession() {
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
    screen = 'teacher';
    isTeacher = true;
    savedSnapshots.length = 0;
    render();
  },
  removeStudent(id) { data.students = data.students.filter(s => s.id !== id); render(); },
  identity() { return v2TenantSession.captureIdentity(); },
  snapshots() { return JSON.parse(JSON.stringify(savedSnapshots)); },
  redraw() { render(); }
};
window.moneyFormTest.newSession();
`;

for (const engine of [chromium, webkit]) {
  describe(`teacher money forms (${engine.name()})`, () => {
    let browser;
    before(async () => { browser = await engine.launch({ headless: true }); });
    after(async () => { await browser?.close(); });

    async function openForm(t, { legacy = false } = {}) {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      t.after(async () => {
        await page.close();
        assert.deepEqual(errors, [], 'no browser JavaScript errors');
      });
      await page.route('**/*', route => route.abort());
      await page.setContent('<div id="app"></div>');
      const configuredSetup = legacy
        ? setup.replace('const IS_MULTI_TEACHER_V2_ENABLED = true;', 'const IS_MULTI_TEACHER_V2_ENABLED = false;')
        : setup;
      await page.addScriptTag({ type: 'module', content: helpers + configuredSetup + isolatedAppSource + handlerExports + '\n' + probe });
      assert.deepEqual(errors, [], 'application initialized without JavaScript errors');
      return page;
    }

    async function customForm(page) {
      await page.getByRole('tab', { name: 'Custom Transaction' }).click();
    }

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

    test('Quick Cash keeps the chosen recipient through repeated clicks and unrelated redraws', async t => {
      const page = await openForm(t);
      await page.locator('#quickStudent').selectOption('2');
      await page.evaluate(() => window.moneyFormTest.redraw());
      assert.equal(await page.locator('#quickStudent').inputValue(), '2');
      await page.getByRole('button', { name: '+$5', exact: true }).click();
      assert.equal(await page.locator('#quickStudent').inputValue(), '2');
      await page.getByRole('button', { name: '-$1', exact: true }).click();
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
      const snapshots = await page.evaluate(() => window.moneyFormTest.snapshots());
      assert.equal(snapshots.length, before + 1);
      assert.ok(snapshots.at(-1).transactions.every(tx => tx.reason === 'Homework' && tx.memo === ''));
    });

    test('legacy removal and max-ID allocation do not transfer the Quick Cash selection to a replacement student', async t => {
      const page = await openForm(t, { legacy: true });
      page.on('dialog', dialog => dialog.accept());
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
