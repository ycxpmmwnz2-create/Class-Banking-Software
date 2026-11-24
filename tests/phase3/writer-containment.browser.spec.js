// Real page handlers, SDK/Auth/callable HTTP and Firestore with the reviewed
// strict rules and nonmoney saver. Fictional local fixtures only.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { teacherAwardPaths } from '../../functions/phase3/teacherAwardService.js';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { seedAll, cleanupFixtures, PROJECT_ID, TENANT_A, TENANT_B } from '../browser/phase2b-fixtures.js';

let env;
const room = TENANT_A.classroomId;
const control = (mode = 'active', generation = 1) => ({ schemaVersion: 1, mode, generation,
  changedAt: '2026-10-05T12:00:00.000Z', auditId: 'combined-fictional' });
const privileged = async fn => {
  let result;
  await env.withSecurityRulesDisabled(async c => { result = await fn(c.firestore()); });
  return result;
};
const read = path => privileged(async db => (await db.doc(path).get()).data());
const pupil = id => `classrooms/${room}/students/${id}`;
const rows = collection => privileged(async db => (await db.collection(`classrooms/${room}/${collection}`).get()).docs.map(d => d.data()));

async function ready(page, tenant = TENANT_A) {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.importBackup === 'function' && window.__PHASE2B_TEST__?.ready);
  await page.evaluate(t => window.__PHASE2B_TEST__.signInTeacher(t.email, t.password), tenant);
  await expect(page.locator('body')).toContainText(tenant.classroomName);
  await expect(page.locator('#quickStudent')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.lastError())).toBe(null);
}
async function screen(page, value) { await page.evaluate(value => window.setScreen(value), value); }
async function invoke(page, name, ...args) {
  const result = await page.evaluate(({ name, args }) => window[name](...args), { name, args });
  if (['quickCash', 'adjustStudentBalance', 'addStudent', 'approveTransaction', 'denyTransaction', 'resetBalancesToZero'].includes(name)) {
    await expect(page.getByRole('button', { name: 'Acknowledge saved action', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Acknowledge saved action', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Acknowledge saved action', exact: true })).toHaveCount(0);
  }
  return result;
}
async function balance(id, expected) { await expect.poll(async () => (await read(pupil(id)))?.balance).toBe(expected); }
async function callable(page, name, data) {
  return page.evaluate(async ({ name, data }) => {
    const { invokeCallable } = await import('/tests/browser/writer-containment-probes.js');
    return invokeCallable(name, data);
  }, { name, data });
}

test.beforeAll(async () => {
  // Existing pre-enrollment fixtures wait for real credential trigger completion.
  // Enroll only afterward; enrolled triggers must then remain inert.
  const seeded = await seedAll();
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: {
    host: '127.0.0.1', port: 8080,
    rules: readFileSync(new URL('../../firestore.phase3.money.rules', import.meta.url), 'utf8'),
  } });
  await privileged(async db => {
    for (const [tenant, uid] of [[TENANT_A, seeded.aUid], [TENANT_B, seeded.bUid]]) {
      await db.doc(`classrooms/${tenant.classroomId}`).update({ accessControl: control() });
      const paths = teacherAwardPaths(tenant.classroomId, uid, '0'.repeat(32));
      await db.doc(paths.actor).set({ version: 1, actorUid: uid, unacknowledgedRequestId: null });
      await db.doc(paths.quota).set({ version: 1, count: 0 });
    }
  });
});
test.afterAll(async () => { await env?.cleanup(); await cleanupFixtures(); });
test.describe.configure({ mode: 'serial' });

test('mixed teacher, student, credential and nonmoney writes persist under strict rules', async ({ page, browser }) => {
  page.on('dialog', dialog => dialog.accept());
  await ready(page);
  const foreignBefore = await read(`classrooms/${TENANT_B.classroomId}/students/${TENANT_B.studentId}`);
  await page.locator('#quickStudent').selectOption(TENANT_A.studentId);
  await invoke(page, 'quickCash', 'Add', 2);
  await balance(11, 12);
  await invoke(page, 'quickCash', 'Subtract', 1);
  await balance(11, 11);
  let ledger = await rows('transactions');
  expect(ledger.filter(t => t.source === 'Teacher' && t.studentId === 11)).toHaveLength(3);
  // Freeze/rent/settings still use the reviewed narrow saver under actual rules.
  await invoke(page, 'toggleFreezeStudent', 11);
  await expect.poll(async () => (await read(pupil(11))).frozen).toBe(true);
  await invoke(page, 'toggleFreezeStudent', 11);
  await expect.poll(async () => (await read(pupil(11))).frozen).toBe(false);
  await page.locator('details').filter({ has: page.locator('#teacherRentAmount') }).locator('summary').click();
  await page.locator('#teacherRentAmount').fill('30');
  await invoke(page, 'saveRentAmount');
  await expect.poll(async () => (await read(`classrooms/${room}/studentDisplay/rent`)).rentAmount).toBe(30);
  await screen(page, 'editSettingsLists');
  await page.locator('#addMoneyCategoryList').fill("Teacher's Choice\nCustom Credit");
  await page.locator('#subtractMoneyCategoryList').fill("Teacher's Choice\nCustom Debit");
  await page.locator('#purchaseCategoryList').fill('School Store\nOther\nCombined Fixture');
  await invoke(page, 'saveSettingsLists');
  await expect.poll(async () => (await read(`classrooms/${room}`)).settings.purchaseCategories).toContain('Combined Fixture');
  await screen(page, 'roster');
  await page.locator('#name-11').fill('Fictional Renamed');
  await invoke(page, 'saveStudentName', 11);
  await expect.poll(async () => (await read(pupil(11))).name).toBe('Fictional Renamed');
  await page.locator('#balance-11').fill('14.25');
  await invoke(page, 'adjustStudentBalance', 11);
  await balance(11, 14.25);
  await page.locator('#newStudentName').fill('Combined Pupil');
  await page.locator('#newStudentPin').fill('2468');
  await page.locator('#newStudentBalance').fill('7.50');
  await invoke(page, 'addStudent');
  await balance(13, 7.5);
  ledger = await rows('transactions');
  expect(ledger.some(t => t.studentId === 13 && t.amount === 7.5)).toBe(true);
  const studentContext = await browser.newContext();
  const studentPage = await studentContext.newPage();
  await studentPage.goto('/');
  await studentPage.waitForFunction(() => typeof window.loginStudent === 'function');
  await studentPage.getByRole('button', { name: 'Student Login', exact: true }).click();
  await studentPage.locator('#studentClassroomCode').fill(TENANT_A.studentLoginCode);
  await studentPage.locator('#studentLoginId').fill('combined-pupil');
  await studentPage.locator('#studentPin').fill('2468');
  await studentPage.getByRole('button', { name: 'Login as Student', exact: true }).click();
  await expect(studentPage.locator('#studentAddAmount')).toBeVisible();
  await expect(studentPage.locator('#studentAddReason option')).toHaveText(['Custom Credit']);
  await expect(studentPage.locator('#studentSubtractReason option')).toHaveText(['Custom Debit']);
  await studentPage.locator('#studentAddAmount').fill('3');
  await invoke(studentPage, 'submitStudentAddMoney');
  await expect.poll(async () => (await rows('transactions')).filter(t => t.studentId === 13 && t.status === 'Pending').length).toBe(1);
  await page.reload();
  await expect(page.locator('body')).toContainText('Combined Pupil');
  await expect(page.locator('#quickStudent')).toBeEnabled();
  let pending = (await rows('transactions')).find(t => t.studentId === 13 && t.status === 'Pending');
  await invoke(page, 'approveTransaction', pending.id);
  await balance(13, 10.5);
  await studentPage.reload();
  await expect(studentPage.locator('#studentSubtractAmount')).toBeVisible();
  await studentPage.locator('#studentAddAmount').fill('2');
  await invoke(studentPage, 'submitStudentAddMoney');
  await expect.poll(async () => (await rows('transactions')).filter(t => t.studentId === 13 && t.status === 'Pending').length).toBe(1);
  pending = (await rows('transactions')).find(t => t.studentId === 13 && t.status === 'Pending');
  await page.reload();
  await expect(page.locator('body')).toContainText('Combined Pupil');
  await expect(page.locator('#quickStudent')).toBeEnabled();
  await invoke(page, 'denyTransaction', pending.id);
  await expect.poll(async () => (await read(`classrooms/${room}/transactions/${pending.id}`)).status).toBe('Denied');
  await balance(13, 10.5);
  // A stale/forged disallowed reason is still refused by the authoritative server.
  const access = await callable(studentPage, 'getClassroomAccessV2', {});
  const refused = await callable(studentPage, 'submitStudentTransactionV2', {
    protocolVersion: 1, controlGeneration: access.data.generation, transactionId: Date.now(),
    type: 'Subtract', amountCents: 200, reason: 'Bad Language (Swearing, Racial Slurs, Etc...)' });
  expect(refused.code).toBe('functions/invalid-argument');
  await balance(13, 10.5);
  await studentPage.locator('#studentSubtractReason').selectOption('Custom Debit');
  await studentPage.locator('#studentSubtractAmount').fill('2');
  await invoke(studentPage, 'submitStudentSubtractMoney');
  await balance(13, 8.5);
  expect((await rows('transactions')).some(t => t.studentId === 13 && t.type === 'Subtract' && t.status === 'Approved' && t.amount === 2)).toBe(true);
  await page.reload();
  await expect(page.locator('body')).toContainText('Combined Pupil');
  await expect(page.locator('#quickStudent')).toBeEnabled();
  // Authoritative enablement changes are reflected on the next student load.
  // Fictional settings mutation isolates the read contract from unrelated settings UI.
  for (const flags of [
    { studentRequestsEnabled: true, studentAddRequestsEnabled: false, studentSubtractRequestsEnabled: true },
    { studentRequestsEnabled: true, studentAddRequestsEnabled: true, studentSubtractRequestsEnabled: false },
    { studentRequestsEnabled: false, studentAddRequestsEnabled: true, studentSubtractRequestsEnabled: true },
  ]) {
    await privileged(db => db.doc(`classrooms/${room}`).update(Object.fromEntries(
      Object.entries(flags).map(([key, value]) => [`settings.${key}`, value]))));
    await studentPage.reload();
    await expect(studentPage.locator('body')).toContainText("Combined Pupil's Account");
    await expect(studentPage.locator('#studentAddAmount')).toHaveCount(flags.studentRequestsEnabled && flags.studentAddRequestsEnabled ? 1 : 0);
    await expect(studentPage.locator('#studentSubtractAmount')).toHaveCount(flags.studentRequestsEnabled && flags.studentSubtractRequestsEnabled ? 1 : 0);
  }
  await privileged(db => db.doc(`classrooms/${room}`).update({
    'settings.studentRequestsEnabled': true, 'settings.studentAddRequestsEnabled': true,
    'settings.studentSubtractRequestsEnabled': true }));
  // Real page PIN reset; old credential version loses direct-read access.
  await invoke(page, 'viewStudentProfile', 13);
  await page.locator('#profileNewStudentPin').fill('3579');
  await invoke(page, 'resetProfileStudentPin');
  await expect(page.locator('body')).toContainText('PIN reset successfully');
  const oldLogin = await callable(studentPage, 'studentPinLoginV2', { classroomCode: TENANT_A.studentLoginCode, loginId: 'combined-pupil', pin: '2468' });
  expect(oldLogin.code).toBe('functions/unauthenticated');
  await screen(page, 'settings');
  await invoke(page, 'resetBalancesToZero');
  for (const id of [11, 12, 13]) await balance(id, 0);
  await invoke(page, 'removeStudent', 13);
  await expect.poll(() => read(pupil(13))).toBeUndefined();
  const preserved = (await rows('transactions')).filter(t => t.studentId === 13);
  expect(preserved.length).toBeGreaterThanOrEqual(5);
  // Ledger and student mirrors must remain identical, and real async audit
  // deliveries must eventually witness the final balance change.
  for (const id of [11, 12]) {
    const stored = await read(pupil(id));
    const own = (await rows('transactions')).filter(t => t.studentId === id);
    expect([...stored.transactions].sort((a,b) => a.id-b.id)).toEqual(own.sort((a,b) => a.id-b.id));
    await expect.poll(async () => (await rows('balanceHistory')).some(w => w.studentId === String(id) && w.afterBalance === 0)).toBe(true);
  }
  expect(await read(`classrooms/${TENANT_B.classroomId}/students/${TENANT_B.studentId}`)).toEqual(foreignBefore);
  await page.reload();
  await expect(page.locator('body')).toContainText('Fictional Renamed');
  await expect(page.locator('#quickStudent option[value="13"]')).toHaveCount(0);
  await studentContext.close();
});

async function direct(page, operation, path, body) {
  return page.evaluate(async ({ operation, path, body }) => {
    const { directFirestore } = await import('/tests/browser/writer-containment-probes.js');
    return directFirestore(operation, path, body);
  }, { operation, path, body });
}

test('strict rules block direct money, late tokens and a held saver when control changes', async ({ page, browser }) => {
  page.on('dialog', dialog => dialog.accept());
  await ready(page);
  for (const body of [{ balance: 900 }, { name: 'Bypass' }, { transactions: [] }]) {
    expect(await direct(page, 'write', pupil(11), body)).toEqual({ code: 'permission-denied' });
  }
  expect(await direct(page, 'write', `classrooms/${room}/transactions/${TENANT_A.transactionId}`, { status: 'Denied' }))
    .toEqual({ code: 'permission-denied' });
  expect(await direct(page, 'read', `classrooms/${TENANT_B.classroomId}/students/${TENANT_B.studentId}`))
    .toEqual({ code: 'permission-denied' });
  await invoke(page, 'viewStudentProfile', 11);
  await page.locator('#profileNewStudentPin').fill('4680');
  await invoke(page, 'resetProfileStudentPin');
  // Obtain a genuine local custom token while active, then deliberately delay
  // signing in until after suspension. The token is never logged or persisted.
  const lateContext = await browser.newContext();
  const late = await lateContext.newPage();
  await late.goto('/');
  await late.waitForFunction(() => typeof window.importBackup === 'function');
  const credential = (await rows('studentCredentials')).find(c => c.studentId === '11');
  const login = await callable(late, 'studentPinLoginV2', { classroomCode: TENANT_A.studentLoginCode,
    loginId: credential.loginId, pin: '4680' });
  expect(login.code).toBeUndefined();
  const before = await read(pupil(11));
  await screen(page, 'teacher');
  await page.evaluate(() => window.__PHASE2B_TEST__.hold('classroomSave'));
  const prior = await page.evaluate(() => window.__PHASE2B_TEST__.counters().saveAdapterCalls);
  await invoke(page, 'toggleFreezeStudent', 11);
  await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.counters().saveAdapterCalls)).toBe(prior + 1);
  await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.waiting('classroomSave'))).toBe(1);
  await privileged(db => db.doc(`classrooms/${room}`).update({ accessControl: control('readOnly', 2) }));
  await page.evaluate(() => window.__PHASE2B_TEST__.release('classroomSave'));
  await expect(page.locator('body')).toContainText('This account is not eligible to complete this action.');
  await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.events().filter(e => e.type === 'saveAdapter:failed').at(-1)?.detail.code)).toBe('permission-denied');
  expect(await read(pupil(11))).toEqual(before);
  expect(await direct(page, 'read', pupil(11))).toEqual({ exists: true });
  expect(await direct(page, 'write', pupil(11), { frozen: true })).toEqual({ code: 'permission-denied' });
  const request = { protocolVersion: 1, controlGeneration: 1, requestId: 'de'.repeat(16),
    action: 'award', studentIds: [11], amountCents: 100, reason: 'Custom Credit', category: 'Custom Credit', memo: '' };
  expect((await callable(page, 'planTeacherMoneyV2', request)).code).toBe('functions/permission-denied');
  await privileged(db => db.doc(`classrooms/${room}`).update({ accessControl: control('suspended', 3) }));
  const denied = await late.evaluate(async ({ token, path }) => {
    const { probeLateToken } = await import('/tests/browser/writer-containment-probes.js');
    return probeLateToken(token, path);
  }, { token: login.data.token, path: pupil(11) });
  expect(denied).toEqual({ signedIn: true, code: 'permission-denied' });
  expect(await direct(page, 'read', pupil(11))).toEqual({ code: 'permission-denied' });
  await privileged(db => db.doc(`classrooms/${room}`).update({ accessControl: control('active', 4) }));
  expect((await callable(page, 'planTeacherMoneyV2', request)).code).toBe('functions/permission-denied');
  expect(await read(pupil(11))).toEqual(before);
  expect(await direct(page, 'read', pupil(11))).toEqual({ exists: true });
  const fresh = await callable(page, 'planTeacherMoneyV2', { ...request, controlGeneration: 4 });
  expect(fresh.code).toBeUndefined();
  expect(fresh.data.plan).toBeDefined();
  await lateContext.close();
});

test('a lost execute response recovers one durable save and survives a reload', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await ready(page);
  await page.locator('#quickStudent').selectOption(TENANT_A.studentId);
  const before = await read(pupil(11));
  const oldLedger = await rows('transactions');
  let calls = 0;
  await page.route('**/executeTeacherMoneyV2', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    calls++;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    // Lose only the delivered response AFTER real callable/transaction completion.
    await route.abort('failed');
  });
  await invoke(page, 'quickCash', 'Add', 1);
  expect(calls).toBe(1);
  await balance(11, before.balance + 1);
  expect((await rows('transactions')).length).toBe(oldLedger.length + 1);
  await page.reload();
  await expect(page.locator('#quickStudent')).toBeEnabled();
  expect((await read(pupil(11))).balance).toBe(before.balance + 1);
  expect((await rows('transactions')).length).toBe(oldLedger.length + 1);
});
