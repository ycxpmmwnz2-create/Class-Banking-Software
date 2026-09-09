import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { applyRosterBalanceEdits } from './rosterBalanceAdjustments.js';

const now = Date.parse('2026-09-08T18:00:00Z');
const initial = () => ({ students: [
  { id: 1, name: 'Fictional Avery', balance: -10, frozen: false, transactions: [] },
  { id: 2, name: 'Fictional Blake', balance: 12.34, frozen: true, transactions: [] },
  { id: 3, name: 'Fictional Casey', balance: 0, frozen: false, transactions: [] }
], transactions: [], settings: {}, loginHistory: [] });

test('negative roster reset records exactly the forgiven amount without mutating input', () => {
  const data = initial(), before = structuredClone(data);
  const next = applyRosterBalanceEdits(data, [{ studentId: 1, balance: 0 }], { now });
  assert.deepEqual(data, before);
  assert.equal(next.students[0].balance, 0);
  assert.equal(next.students[1], data.students[1]);
  assert.deepEqual(next.transactions.map(tx => [tx.type, tx.amount, tx.studentId, tx.status]), [['Add', 10, 1, 'Approved']]);
  assert.equal(next.transactions[0].date, '2026-09-08T18:00:00.000Z');
  assert.match(next.transactions[0].memo, /from -10.00 to 0.00/u);
  assert.equal(next.transactions[0].source, 'Teacher');
});
test('reset all preserves sign, cents, and zero-delta omission', () => {
  const data = initial();
  const next = applyRosterBalanceEdits(data, data.students.map(s => ({ studentId: s.id, balance: 0 })), { now });
  assert.deepEqual(next.students.map(s => s.balance), [0, 0, 0]);
  assert.deepEqual(next.transactions.map(tx => [tx.type, tx.amount]), [['Add', 10], ['Subtract', 12.34]]);
  assert.equal(new Set(next.transactions.map(tx => tx.id)).size, 2);
  assert.deepEqual(applyRosterBalanceEdits(next, [{ studentId: 1, balance: 0 }], { now }), next);
});
test('loaded-ledger collisions are avoided without replacing existing records', () => {
  const data = initial(); data.transactions = [{ id: now + 10 }];
  const next = applyRosterBalanceEdits(data, [{ studentId: 1, balance: 0 }], { now });
  assert.equal(next.transactions[0].id, now + 11);
  assert.equal(next.transactions[1], data.transactions[0]);
});
test('all edits are validated before returning a mutation', () => {
  const data = initial(), before = structuredClone(data);
  for (const balance of [NaN, Infinity, '0', null, 1.001, 1_000_001]) {
    assert.throws(() => applyRosterBalanceEdits(data, [{ studentId: 1, balance: 0 }, { studentId: 2, balance }], { now }));
  }
  assert.throws(() => applyRosterBalanceEdits(data, [{ studentId: 999, balance: 0 }], { now }));
  assert.throws(() => applyRosterBalanceEdits(data, [{ studentId: 1, balance: 0 }, { studentId: 1, balance: 0 }], { now }));
  assert.deepEqual(data, before);
});

// Execute the actual inline production handlers with DOM/save seams, not a
// copied implementation. Firestore atomic behavior is covered in saver tests.
const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
function handler(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n    }', start) + 6);
}
function ui({ legacy = false, allowed = true, confirmed = true, save } = {}) {
  const inputs = { 'name-1': { value: 'Renamed Avery' }, 'balance-1': { value: '0' }, 'pin-1': { value: '1234' } };
  let epoch = 1, calls = 0, renders = 0;
  const context = vm.createContext({
    data: initial(), message: '', rosterBalanceSaveOperation: null,
    IS_MULTI_TEACHER_V2_ENABLED: !legacy, applyRosterBalanceEdits,
    document: { getElementById: id => { if (!legacy && id.startsWith('pin-')) throw new Error('PIN read'); return inputs[id]; } },
    requireTeacher: () => allowed, confirm: () => confirmed,
    v2TenantSession: { captureIdentity: () => ({ epoch }), validateCapturedIdentity: capture => capture.epoch === epoch },
    saveData: async () => { calls++; return save ? save(context) : { executed: true }; },
    render: () => { renders++; }, showMessage: text => { context.message = text; },
  });
  vm.runInContext(`${handler('updateStudent')}\n${handler('resetBalancesToZero')}`, context);
  return { context, inputs, calls: () => calls, renders: () => renders, switchTenant: () => { epoch++; context.message = 'new tenant'; context.data = initial(); } };
}
test('real roster handler records the delta, renames the ledger and never reads V2 PINs', async () => {
  const u = ui(); await u.context.updateStudent(1);
  assert.equal(u.context.data.students[0].balance, 0);
  assert.equal(u.context.data.transactions[0].studentName, 'Renamed Avery');
  assert.equal(u.context.data.transactions[0].amount, 10);
  assert.equal(u.calls(), 1);
  assert.match(u.context.message, /Student updated/u);
  assert.equal(Object.hasOwn(u.context.data.students[0], 'pin'), false);
});
test('real roster handler preserves legacy PIN editing', async () => {
  const u = ui({ legacy: true }); await u.context.updateStudent(1);
  assert.equal(u.context.data.students[0].pin, '1234');
  assert.equal(u.context.data.transactions[0].amount, 10);
});
test('real handlers block unauthorized, cancelled, invalid and name-only balance changes', async () => {
  const denied = ui({ allowed: false }); await denied.context.updateStudent(1); await denied.context.resetBalancesToZero();
  assert.equal(denied.calls(), 0);
  const cancelled = ui({ confirmed: false }); await cancelled.context.resetBalancesToZero(); assert.equal(cancelled.calls(), 0);
  const invalid = ui(); invalid.inputs['balance-1'].value = ''; await invalid.context.updateStudent(1); assert.equal(invalid.calls(), 0);
  const rename = ui(); rename.inputs['balance-1'].value = '-10'; await rename.context.updateStudent(1); assert.equal(rename.context.data.transactions.length, 0);
});
test('pending duplicate clicks do not duplicate a delta; success waits for confirmation', async () => {
  let complete;
  const u = ui({ save: () => new Promise(resolve => { complete = resolve; }) });
  const pending = u.context.updateStudent(1);
  await u.context.updateStudent(1); await u.context.resetBalancesToZero();
  assert.equal(u.calls(), 1); assert.equal(u.context.message, '');
  complete({ executed: true }); await pending;
  assert.equal(u.context.data.transactions.length, 1);
});
test('failed and thrown saves cannot announce success; retry retains one adjustment', async () => {
  for (const save of [async context => { context.message = 'Save failed'; return { executed: false }; }, async () => { throw new Error('offline'); }]) {
    const u = ui({ save }); await u.context.updateStudent(1); await u.context.updateStudent(1);
    assert.doesNotMatch(u.context.message, /Student updated/u);
    assert.equal(u.context.data.transactions.length, 1);
    assert.equal(u.context.rosterBalanceSaveOperation, null);
  }
});
test('late completions never overwrite a new tenant message or redraw it', async () => {
  let complete;
  const u = ui({ save: () => new Promise(resolve => { complete = resolve; }) });
  const pending = u.context.updateStudent(1); u.switchTenant();
  complete({ executed: true }); await pending;
  assert.equal(u.context.message, 'new tenant'); assert.equal(u.renders(), 0);
  assert.equal(u.context.data.transactions.length, 0);
});
test('real reset-all handler records only nonzero balances', async () => {
  const u = ui(); await u.context.resetBalancesToZero();
  assert.equal(u.context.data.transactions.length, 2);
  assert.equal(u.calls(), 1); assert.match(u.context.message, /All balances reset/u);
});
