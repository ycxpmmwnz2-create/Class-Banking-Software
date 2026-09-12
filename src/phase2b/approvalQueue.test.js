import test from 'node:test';
import { setImmediate } from 'node:timers';
import assert from 'node:assert/strict';
import { createApprovalQueue, prepareApprovalDecision } from './approvalQueue.js';

const initial = () => ({ students: [{ id: 1, name: 'Fictional Student', balance: 10 }],
  transactions: [1, 2, 3].map(id => ({ id, studentId: 1, status: 'Pending', type: 'Add', amount: 5 })) });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled(queue) { for (let n = 0; n < 30 && queue.busy; n++) await tick(); assert.equal(queue.busy, false); }
function harness(saveImpl) {
  let data = initial(), epoch = 1;
  const messages = [], notifications = [], saves = [];
  const queue = createApprovalQueue({ capture: () => epoch, isCurrent: id => id === epoch,
    getData: () => data, save: async candidate => { saves.push(structuredClone(candidate)); return saveImpl ? saveImpl(candidate) : { executed: true }; },
    publish: next => { data = next; }, notify: (text, options) => { messages.push(text); notifications.push(options); }, changed() {} });
  return { queue, messages, notifications, saves, get data() { return data; }, switchSession() { epoch++; data = initial(); },
    mutate() { data.students[0].balance = 50; },
    decide(ids, status = 'Approved') { return queue.enqueue(ids, copy => prepareApprovalDecision(copy, ids, status)); } };
}

test('rapid decisions wait for confirmed state; duplicate click cannot credit twice', async () => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const h = harness(async () => { if (++calls === 1) await first; return { executed: true }; });
  h.decide([1]); h.decide([2]);
  assert.equal(h.decide([1]), false);
  assert.equal(h.saves.length, 1);
  assert.equal(h.data.students[0].balance, 10);
  assert.equal(h.data.transactions[0].status, 'Pending');
  assert.deepEqual(h.messages, []);
  release(); await settled(h.queue);
  assert.equal(h.saves.length, 2);
  assert.equal(h.saves[1].students[0].balance, 20);
  assert.equal(h.data.students[0].balance, 20);
  assert.equal(h.data.transactions[0].status, 'Approved');
  assert.equal(h.data.transactions[1].status, 'Approved');
});

test('approve, deny and bulk decisions share one ordered queue', async () => {
  const h = harness(); h.decide([1]); h.decide([2], 'Denied'); h.decide([3]);
  await settled(h.queue);
  assert.equal(h.data.students[0].balance, 20);
  assert.deepEqual(h.data.transactions.map(t => t.status), ['Approved', 'Denied', 'Approved']);
  h.decide([1, 2, 3]); await settled(h.queue);
  assert.equal(h.saves.length, 3, 'already decided requests do not produce another save');
});

for (const failure of ['rejected', 'throws', 'conflict']) test(`${failure} save leaves requests pending and stops later decisions`, async () => {
  const h = harness(async () => {
    if (failure === 'throws') throw new Error('offline');
    return { executed: false, reason: failure === 'conflict' ? 'concurrent-classroom-change' : 'save-failed' };
  });
  h.decide([1, 2]); h.decide([3]); await settled(h.queue);
  assert.equal(h.saves.length, 1);
  assert.deepEqual(h.data, initial());
  assert.equal(h.queue.has(1), false);
  assert.match(h.messages[0], /Refresh/);
  assert.equal(h.notifications[0].requiresRefresh, true);
  assert.equal(h.messages.some(m => m.includes('approved.')), false);
});

test('stale session cannot publish a completed save or execute queued decisions', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const h = harness(async () => { await pending; return { executed: true }; });
  h.decide([1]); h.decide([2]); h.switchSession();
  assert.equal(h.queue.has(1), false);
  assert.equal(h.decide([3]), false);
  release(); await settled(h.queue);
  assert.deepEqual(h.data, initial()); assert.deepEqual(h.messages, []); assert.equal(h.saves.length, 1);
});

test('a competing local change is not overwritten by a completed approval', async () => {
  let release;const pending = new Promise(resolve => { release = resolve; });
  const h = harness(async () => { await pending; return { executed: true }; });
  h.decide([1]);h.decide([2]);h.mutate();release();await settled(h.queue);
  assert.equal(h.data.students[0].balance, 50);assert.equal(h.saves.length, 1);assert.match(h.messages[0], /Refresh/);
});

test('failure after one confirmed approval preserves that credit and stops later jobs', async () => {
  let attempts = 0;
  const h = harness(async () => ({ executed: ++attempts === 1 }));
  h.decide([1]); h.decide([2]); h.decide([3]); await settled(h.queue);
  assert.equal(h.data.students[0].balance, 15);
  assert.deepEqual(h.data.transactions.map(t => t.status), ['Approved', 'Pending', 'Pending']);
  assert.equal(h.saves.length, 2);
  assert.equal(h.messages.filter(m => m.includes('approved.')).length, 1);
});

test('negative-balance consent and malformed bulk requests do not mutate source data', () => {
  const data = initial(); data.transactions[0].type = 'Subtract'; data.transactions[0].amount = 20;
  const copy = structuredClone(data);
  assert.equal(prepareApprovalDecision(copy, [1], 'Approved', () => false), null);
  assert.deepEqual(copy, data);
  const approved = prepareApprovalDecision(structuredClone(data), [1], 'Approved', () => true);
  assert.equal(approved.data.students[0].balance, -10);
  data.transactions[1].studentId = 999;
  assert.throws(() => prepareApprovalDecision(structuredClone(data), [1, 2], 'Approved', () => true));
  assert.equal(data.students[0].balance, 10);
});


test('only an explicitly confirmed conflict reload avoids the refresh requirement', async () => {
  for (const reloaded of [true, false, undefined]) {
    const h = harness(async () => ({ executed: false, reason: 'concurrent-classroom-change', reloaded }));
    h.decide([1]);h.decide([2]);await settled(h.queue);
    assert.equal(h.notifications[0].requiresRefresh, reloaded !== true);
    assert.equal(h.saves.length, 1);
    assert.equal(h.messages[0].includes('was reloaded'), reloaded === true);
  }
});

for (const fault of ['publish', 'notify']) test(`a post-commit ${fault} failure reports the confirmed save without replay`, async () => {
  let data = initial(), attempts = 0;
  const notifications = [];
  const queue = createApprovalQueue({ capture: () => 1, isCurrent: () => true, getData: () => data,
    save: async () => { attempts++;return { executed: true }; },
    publish: next => { if (fault === 'publish') throw new Error('display failed');data = next; },
    notify: (text, options) => {
      if (fault === 'notify' && text.includes('approved.')) throw new Error('message failed');
      notifications.push({ text, options });
    }, changed() {} });
  queue.enqueue([1], copy => prepareApprovalDecision(copy, [1], 'Approved'));
  queue.enqueue([2], copy => prepareApprovalDecision(copy, [2], 'Approved'));
  await settled(queue);
  assert.equal(attempts, 1);
  assert.match(notifications[0].text, /decision was saved/);
  assert.doesNotMatch(notifications[0].text, /could not be confirmed/);
  assert.equal(notifications[0].options.requiresRefresh, true);
});
