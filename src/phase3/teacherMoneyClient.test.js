import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherMoneyClient, parseTeacherMoneyAmount } from './teacherMoneyClient.js';
import { teacherAwardFixture } from '../../tests/phase3/teacherAward.fixture.js';
import { editTeacherProfileCallable } from '../../functions/phase3/teacherProfile.js';
import { getClassroomAccessService } from '../../functions/phase3/classroomAccess.js';
import { executeTeacherMoneyCallable, planTeacherMoneyCallable, recoverTeacherMoneyCallable } from '../../functions/phase3/teacherMoneyCallables.js';

function fixture(options) {
  const f = teacherAwardFixture(options);
  let epoch = 1, uid = f.uid, sequence = 0;
  const session = { projectId: f.dependencies.projectId, role: 'teacher', classroomId: f.classroomId,
    captureIdentity: () => ({ uid, classroomId: f.classroomId, role: 'teacher', epoch }),
    validateCapturedIdentity: captured => captured.uid === uid && captured.epoch === epoch };
  const values = new Map(), calls = [], states = [];
  const storage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const h = { f, session, values, storage, calls, states, refreshed: true, confirm: true,
    intercepted: null, reloads: 0, changeIdentity() { uid = 'teacher-b'; epoch++; } };
  async function call(name, data) {
    calls.push({ name, data: structuredClone(data) });
    if (h.intercepted) await h.intercepted(name, data);
    const request = { auth: f.dependencies.auth, data };
    if (name === 'editStudentProfileV2') return editTeacherProfileCallable(request, f.dependencies);
    if (name === 'getClassroomAccessV2') return getClassroomAccessService({ ...f.dependencies, data });
    if (name === 'planTeacherMoneyV2') {
      const preview = await planTeacherMoneyCallable(request, f.dependencies);
      return h.previewResponse ? h.previewResponse(preview) : preview;
    }
    if (name === 'executeTeacherMoneyV2') return executeTeacherMoneyCallable(request, f.dependencies);
    const operation = { getTeacherMoneyStatusV2: 'status', cancelTeacherMoneyV2: 'cancel', acknowledgeTeacherMoneyV2: 'acknowledge' }[name];
    return recoverTeacherMoneyCallable(request, f.dependencies, operation);
  }
  h.create = () => createTeacherMoneyClient({ session, currentUid: () => uid, storage, call,
    random: { getRandomValues(bytes) { bytes.fill(++sequence); return bytes; } },
    confirmPlan: async preview => { h.preview = preview; return h.confirm; },
    reload: async () => { h.reloads++; if (!h.refreshed) throw new Error('offline'); return true; },
    notify: state => { states.push(state); if (h.renderThrows) throw new Error('render'); } });
  h.client = h.create();
  h.intent = { action: 'award', studentIds: [1, 2], amountCents: 110, reason: 'Homework', category: 'Homework', memo: 'fictional memo' };
  h.start = async () => { assert.equal((await h.client.check()).status, 'idle'); return h.client.run(h.intent); };
  return h;
}

test('decimal parsing accepts cents exactly and refuses exponents, rounding and excessive amounts', () => {
  assert.equal(parseTeacherMoneyAmount('1.10'), 110);
  assert.equal(parseTeacherMoneyAmount('1000000'), 100000000);
  for (const input of ['0', '-1', '1.001', ' 1', '1e2', '1000000.01', '01', NaN]) {
    assert.throws(() => parseTeacherMoneyAmount(input));
  }
});

test('real client and services atomically save a confirmed group; a durable minimal marker blocks until explicit acknowledgment', async () => {
  const h = fixture();
  h.intercepted = name => {
    if (name === 'executeTeacherMoneyV2') {
      assert.equal(h.values.size, 1, 'marker exists before dispatch');
      const marker = JSON.parse([...h.values.values()][0]);
      assert.deepEqual(Object.keys(marker).sort(), ['version', 'projectId', 'uid', 'classroomId', 'requestId'].sort());
      assert.equal(JSON.stringify(marker).includes('memo'), false);
      assert.equal(h.f.student(1).balance, 20, 'no optimistic balance publication');
    }
  };
  const result = await h.start();
  assert.equal(result.status, 'committed'); assert.equal(result.intentConfirmed, true);
  assert.equal(h.f.student(1).balance, 21.1); assert.equal(h.f.student(2).balance, 21.1);
  assert.equal(h.client.isBlocked(), true); assert.equal((await h.client.run(h.intent)).status, 'blocked');
  assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 1);
  assert.equal((await h.client.acknowledge()).status, 'acknowledged');
  assert.equal(h.values.size, 0); assert.equal(h.client.isBlocked(), false);
});

test('lost response recovers the committed receipt without resubmitting or applying money twice', async () => {
  const h = fixture(); h.f.loseResponse = true;
  const result = await h.start();
  assert.equal(result.status, 'committed'); assert.equal(result.intentConfirmed, false);
  assert.equal(h.f.student(1).balance, 21.1);
  assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 1);
  assert.equal(h.calls.filter(c => c.name === 'cancelTeacherMoneyV2').length, 0);
});

test('ambiguous dispatch with absent receipt is fenced; failed fencing preserves the marker and makes exactly one recovery attempt', async () => {
  for (const failFence of [false, true]) {
    const h = fixture();
    h.intercepted = name => {
      if (name === 'executeTeacherMoneyV2' || (failFence && name === 'cancelTeacherMoneyV2')) throw new Error('transport');
    };
    assert.equal((await h.start()).status, failFence ? 'unresolved' : 'cancelled');
    assert.equal(h.f.student(1).balance, 20);
    assert.equal(h.calls.filter(c => c.name === 'cancelTeacherMoneyV2').length, 1);
    assert.equal(h.values.size, failFence ? 1 : 0);
    assert.equal(h.client.isBlocked(), failFence);
  }
});

test('stale preview refusal is recovered/fenced once and preserves its original reason', async () => {
  for (const failFence of [false, true]) {
    const h = fixture();
    h.intercepted = name => {
      if (name === 'executeTeacherMoneyV2') h.f.student(1).balance = 22;
      if (failFence && name === 'cancelTeacherMoneyV2') throw new Error('transport');
    };
    const result = await h.start();
    assert.equal(result.status, failFence ? 'unresolved' : 'cancelled');
    assert.equal(result.reason, 'stale-plan');
    assert.equal(h.client.getState().reason, 'stale-plan');
    assert.equal(h.f.student(1).balance, 22);
    assert.equal(h.calls.filter(c => c.name === 'cancelTeacherMoneyV2').length, 1);
    if (failFence) {
      assert.equal((await h.client.check()).reason, 'stale-plan');
      assert.equal(h.client.getState().reason, 'stale-plan');
    }
  }
});

test('a history-sized prefix requires its own confirmation and acknowledgment; the remainder is never submitted automatically', async () => {
  const h = fixture({ count: 30 });
  const ids = Array.from({ length: 30 }, (_, i) => i + 1);
  for (const id of ids) h.f.student(id).transactions = Array.from({ length: 200 }, (_, i) => ({
    id: i + 1, date: h.f.time, studentId: id, studentName: h.f.student(id).name,
    type: 'Add', amount: 1, reason: 'Homework', memo: '', category: 'Homework', status: 'Approved', source: 'Teacher',
  }));
  h.intent.studentIds = [...ids].reverse();
  const result = await h.start();
  assert.equal(result.status, 'committed');
  const selected = h.preview.selected.map(row => row.studentId);
  assert.ok(selected.length > 0 && selected.length < 30);
  assert.deepEqual(selected, ids.slice(0, selected.length));
  assert.deepEqual(h.preview.notYetPlanned, ids.slice(selected.length));
  assert.deepEqual(result.notYetPlanned, ids.slice(selected.length));
  assert.equal(h.client.getState().receipt.itemCount, selected.length);
  for (const id of ids) assert.equal(h.f.student(id).balance, selected.includes(id) ? 21.1 : 20);
  await h.client.acknowledge();
  assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 1);
  assert.equal(h.calls.filter(c => c.name === 'planTeacherMoneyV2').length, 1);
});

test('a preview cannot supply a missing or unrelated remainder for the next deliberate group', async () => {
  for (const remainder of [undefined, null, [1], [999]]) {
    const h = fixture();
    h.previewResponse = preview => ({ ...preview, notYetPlanned: remainder });
    assert.equal((await h.start()).status, 'unavailable');
    assert.equal(h.preview, undefined, 'invalid remainder is refused before confirmation');
    assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 0);
    assert.equal(h.f.commits.length, 0);
    assert.deepEqual([h.f.student(1).balance, h.f.student(2).balance], [20, 20]);
  }
});

test('missing actor and quota keep the real client blocked without creating metadata or money', async () => {
  const h = fixture();
  h.f.data.delete(h.f.paths.actor);
  h.f.data.delete(h.f.paths.quota);
  assert.equal((await h.client.check()).status, 'unresolved');
  assert.equal(h.client.isBlocked(), true);
  assert.equal((await h.client.run(h.intent)).status, 'blocked');
  assert.equal(h.f.commits.length, 0);
  assert.equal(h.f.data.has(h.f.paths.actor), false);
  assert.equal(h.f.data.has(h.f.paths.quota), false);
  assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 0);
});

test('failed acknowledgment and failed marker removal retain the receipt; checking status never reapplies money', async () => {
  for (const loseResponse of [false, true]) {
    const h = fixture(); await h.start();
    if (loseResponse) h.f.loseResponse = true;
    else h.storage.removeItem = () => { throw new Error('storage unavailable'); };
    assert.equal((await h.client.acknowledge()).status, 'unresolved');
    assert.equal(h.client.getState().status, 'committed'); assert.equal(h.values.size, 1);
    assert.equal((await h.client.check()).status, 'committed');
    assert.equal(h.client.getState().receipt.acknowledged, true);
    h.storage.removeItem = key => h.values.delete(key);
    assert.equal((await h.client.acknowledge()).status, 'acknowledged');
    assert.equal(h.values.size, 0); assert.equal(h.f.student(1).balance, 21.1);
    assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 1);
  }
});

test('a late acknowledgment cannot remove a different pending marker, and status checking can fence that key', async () => {
  const h = fixture(); await h.start();
  const [key, oldValue] = [...h.values][0], newer = { ...JSON.parse(oldValue), requestId: 'c'.repeat(32) };
  h.values.set(key, JSON.stringify(newer));
  assert.equal((await h.client.acknowledge()).status, 'unresolved');
  assert.equal(JSON.parse(h.values.get(key)).requestId, newer.requestId);
  assert.equal(h.client.isBlocked(), true);
  assert.equal((await h.client.check()).status, 'cancelled');
  assert.equal(h.values.size, 0); assert.equal(h.f.student(1).balance, 21.1);
  assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 1);
});

test('another tab fences a delayed save, then a late completion preserves the newer marker and cannot apply the old money', async () => {
  const h = fixture(); await h.client.check();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.intercepted = async (name, data) => {
    if (name === 'executeTeacherMoneyV2' && data.request.requestId === '01'.repeat(16)) { entered(); await gate; }
  };
  const pending = h.client.run(h.intent); await started;
  const other = h.create();
  assert.equal((await other.check()).status, 'cancelled');
  assert.equal((await other.run({ ...h.intent, action: 'deduct', amountCents: 100, reason: 'Rent', category: 'Rent' })).status, 'committed');
  const marker = [...h.values.values()][0];
  release(); assert.equal((await pending).status, 'unresolved');
  assert.equal([...h.values.values()][0], marker, 'old completion cannot remove the new tab marker');
  assert.equal(h.f.student(1).balance, 19); assert.equal(h.f.student(2).balance, 19);
  const recovered = await h.client.check();
  assert.equal(recovered.status, 'committed'); assert.equal(recovered.intentConfirmed, false);
  assert.equal(recovered.receipt.action, 'deduct');
  assert.equal((await h.client.acknowledge()).status, 'acknowledged');
  assert.equal(h.values.size, 0); assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 2);
});

test('storage failure or corrupt marker refuses dispatch; no marker is cleared on an ordinary error', async () => {
  const h = fixture(); await h.client.check();
  h.storage.setItem = () => { throw new Error('full'); };
  assert.equal((await h.client.run(h.intent)).status, 'unavailable');
  assert.equal(h.calls.some(c => c.name === 'executeTeacherMoneyV2'), false);
  const other = fixture(); await other.client.check();
  other.values.set('morganBank:teacher-money-pending:v1:' + JSON.stringify(['demo-money-client', 'teacher-a', 'class-a']), '{bad');
  assert.equal((await other.client.run(other.intent)).status, 'unresolved');
  assert.equal(other.calls.some(c => c.name === 'executeTeacherMoneyV2'), false);
  assert.equal(other.values.size, 1);
});

test('reload failure retains a server-confirmed receipt and permits explicit receipt-only acknowledgment', async () => {
  const h = fixture(); h.refreshed = false;
  const result = await h.start();
  assert.equal(result.status, 'committed'); assert.equal(result.refreshed, false);
  assert.equal(h.client.getState().receipt.itemCount, 2);
  assert.equal((await h.client.acknowledge()).status, 'acknowledged');
  assert.equal(h.client.getState().refreshed, false);
  assert.equal(h.values.size, 0); assert.equal(h.f.student(1).balance, 21.1);
});

test('new client resolves server pointer after local-storage loss; logout reset retains a dispatched marker', async () => {
  const h = fixture(); await h.start();
  h.client.reset(); assert.equal(h.values.size, 1);
  h.values.clear(); h.client = h.create();
  assert.equal((await h.client.check()).status, 'committed');
  assert.equal(h.values.size, 1); assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 1);
});

test('account switch during dispatch never publishes a receipt or clears the outgoing marker', async () => {
  const h = fixture();
  h.intercepted = name => { if (name === 'executeTeacherMoneyV2') { h.changeIdentity(); h.client.reset(); } };
  assert.equal((await h.start()).status, 'stale');
  assert.equal(h.client.getState().status, 'unchecked'); assert.equal(h.values.size, 1);
  assert.equal(h.calls.filter(c => c.name === 'cancelTeacherMoneyV2').length, 0);
});

test('declined confirmation, unavailable capacity and rendering exceptions never duplicate or silently split saves', async () => {
  const h = fixture(); h.confirm = false;
  assert.equal((await h.start()).status, 'declined'); assert.equal(h.values.size, 0);
  assert.equal(h.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 0);
  const heavy = fixture();
  heavy.f.student(1).transactions = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1,
    date: heavy.f.time, studentId: 1, studentName: 'Fictional Avery', type: 'Add', amount: 1,
    reason: 'Homework', memo: '', category: 'Homework', status: 'Approved', source: 'Teacher' }));
  assert.equal((await heavy.start()).status, 'capacity');
  assert.equal(heavy.calls.filter(c => c.name === 'executeTeacherMoneyV2').length, 0);
  const rendered = fixture(); rendered.renderThrows = true;
  assert.equal((await rendered.start()).status, 'committed');
  assert.equal(rendered.client.isBlocked(), true); assert.equal(rendered.f.student(1).balance, 21.1);
});

for (const action of ['approve', 'deny', 'adjust', 'reset']) {
  test(`real client plans, saves and recovers ${action} without generic saver or re-dispatch`, async () => {
    for (const lost of [false, true]) {
      const h = fixture();
      const entry = { id: 11, studentId: 1, studentName: 'Old recorded name', date: h.f.time,
        type: 'Add', amount: 1.25, reason: 'Homework', memo: '', category: '', status: 'Pending', source: 'Student' };
      h.f.data.set('classrooms/class-a/transactions/11', entry);
      h.f.student(1).transactions.push(structuredClone(entry));
      h.intent = ['approve', 'deny'].includes(action) ? { action, transactionIds: [11], allowNegative: false }
        : { action, adjustments: [{ studentId: 1, expectedCents: 2000, targetCents: 0 }] };
      h.f.loseResponse = lost;
      const result = await h.start();
      assert.equal(result.status, 'committed'); assert.equal(result.intentConfirmed, !lost);
      assert.equal(h.f.student(1).balance, action === 'approve' ? 21.25 : action === 'deny' ? 20 : 0);
      assert.equal(h.calls.filter(row => row.name === 'executeTeacherMoneyV2').length, 1);
      assert.equal((await h.client.acknowledge()).status, 'acknowledged');
    }
  });
}
test('profile client binds generation, reloads only current identity, and does not invent a money receipt', async () => {
  const h = fixture(); await h.client.check();
  assert.deepEqual(await h.client.rename({ studentId: 1, expectedName: 'Fictional Avery', name: 'New name' }), { status: 'saved', refreshed: true });
  assert.equal(h.f.student(1).name, 'New name'); assert.equal(h.f.student(1).balance, 20);
  assert.equal(h.values.size, 0); assert.equal(h.f.data.get(h.f.paths.quota).count, 0);
});

function creationClientFixture() {
  const values = new Map(), calls = [];
  let epoch = 1;
  const h = { values, calls, saved: null, lost: false, refreshed: true, denyStorage: false, staleOnAccess: false };
  const client = createTeacherMoneyClient({
    session: { projectId: 'demo-create-client', captureIdentity: () => ({uid:'teacher',classroomId:'class-a',role:'teacher',epoch}),
      validateCapturedIdentity: value => value.epoch === epoch }, currentUid: () => 'teacher',
    storage: {getItem:key=>values.get(key)??null,setItem:(key,value)=>{if(h.denyStorage)throw new Error('storage');values.set(key,value);},removeItem:key=>values.delete(key)},
    random: {getRandomValues: bytes => {bytes.fill(1);return bytes;}},
    reload: async () => h.refreshed,
    call: async (name, input) => {
      calls.push({name,input});
      if(name==='getClassroomAccessV2'){if(h.staleOnAccess)epoch++;return {protocolVersion:1,mode:'active',generation:7};}
      if(name==='getTeacherMoneyStatusV2')return h.saved??{protocolVersion:1,requestId:input.requestId,status:'unconfirmed'};
      if(name==='createStudentV2'){
        assert.equal(values.size,1,'durable marker precedes dispatch');
        for(const text of values.values())assert.doesNotMatch(text,/Fictional|0427|startingBalance|Hmac|digest/);
        h.saved={protocolVersion:1,requestId:input.requestId,status:'committed',action:'createStudent',itemCount:1,
          studentId:8,loginId:'fictional',acknowledged:false,requiresRefresh:true,serverTime:'2026-10-05T00:00:00.000Z',receiptCapacityWarning:null};
        if(h.lost)throw new Error('lost response');return h.saved;
      }
      if(name==='acknowledgeTeacherMoneyV2')return {...h.saved,acknowledged:true};
      throw new Error('unexpected call');
    },
  });
  return {...h, state:h, client, draft:{name:'Fictional',startingBalanceCents:123,pin:'0427'}};
}

test('creation uses minimal durable recovery; lost response plus failed reload remains acknowledgeable without resubmission', async () => {
  const h=creationClientFixture();h.state.lost=true;h.state.refreshed=false;
  await h.client.check();
  const result=await h.client.createStudent(h.draft);
  assert.equal(result.status,'committed');assert.equal(result.intentConfirmed,false);assert.equal(result.refreshed,false);
  assert.equal(h.calls.filter(row=>row.name==='createStudentV2').length,1);
  assert.equal(h.client.isBlocked(),true);assert.equal(h.values.size,1);
  assert.equal((await h.client.acknowledge()).status,'acknowledged');assert.equal(h.values.size,0);
});

test('creation blocks dispatch when marker storage fails or identity changes during access lookup', async () => {
  for(const flag of ['denyStorage','staleOnAccess']){
    const h=creationClientFixture();await h.client.check();h.state[flag]=true;
    await h.client.createStudent(h.draft);
    assert.equal(h.calls.some(row=>row.name==='createStudentV2'),false);
  }
});
