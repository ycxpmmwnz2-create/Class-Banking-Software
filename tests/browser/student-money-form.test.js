import { resetStudentPinV2CallableHandler } from '../../functions/phase2b/resetStudentPin.js';
import { teacherAwardPaths, recoverTeacherAwardService } from '../../functions/phase3/teacherAwardService.js';
// Actual page handlers and orchestrators against actual services over fictional
// atomic storage. Browser network is blocked; this is not Firebase/live proof.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { before, after, describe, test } from 'node:test';
import { chromium, webkit } from '@playwright/test';
import { submitStudentTransactionV2CallableHandler } from '../../functions/phase3/studentMoney.js';
import { createStudentV2CallableHandler, removeStudentV2CallableHandler } from '../../functions/phase3/studentLifecycle.js';
import { getClassroomAccessService } from '../../functions/phase3/classroomAccess.js';
import { deriveDeterministicStudentAuthUid } from '../../functions/phase2b/scopedCredentialProjection.js';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../../index.html');
const app = source.slice(source.indexOf('    const defaultSettings ='), source.indexOf('    async function submitV2Onboarding()'));
const plain = path => read(path).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const helpers = ['tenantSession', 'approvalQueue', 'studentDisplay', 'transactionCategoryDisplay']
  .map(name => plain(`../../src/phase2b/${name}.js`)).join('\n');
const client = 'const {orchestrateStudentTransaction, orchestrateRemoveStudent, orchestrateStudentPinReset, orchestrateBulkOperation} = (() => {\n' + plain('../../src/phase2b/tenantClient.js') + '\nreturn {orchestrateStudentTransaction, orchestrateRemoveStudent, orchestrateStudentPinReset, orchestrateBulkOperation};})();';
const exports = ['submitStudentAddMoney', 'submitStudentSubtractMoney', 'removeStudent', 'addStudent', 'acknowledgeTeacherMoneySave', 'setScreen', 'resetProfileStudentPin', 'activateStudent', 'bulkActivateStudents']
  .map(name => source.split('\n').find(line => line === `window.${name} = ${name};`)).join('\n');

function fixture() {
  const classroomId = 'fictional-room', teacherUid = 'fictional-teacher';
  const uid = deriveDeterministicStudentAuthUid(classroomId, '1');
  const studentAuth = { uid, token: { role: 'student', classroomId, studentId: '1', loginId: 'avery', credentialVersion: 1000 } };
  const teacherAuth = { uid: teacherUid, token: { role: 'teacher' } };
  const rows = new Map(Object.entries({
    [`teachers/${teacherUid}`]: { uid: teacherUid, status: 'active', classroomId },
    [`classrooms/${classroomId}`]: { ownerUid: teacherUid, accessControl: { schemaVersion: 1, mode: 'active', generation: 1, changedAt: '2026-10-04T00:00:00.000Z', auditId: 'fictional' } },
    [`classrooms/${classroomId}/students/1`]: { id: 1, name: 'Fictional Avery', balance: 20, frozen: false, transactions: [] },
    [`classrooms/${classroomId}/studentCredentials/avery`]: { loginId: 'avery', classroomId, studentId: '1', authUid: uid, active: true, schemaVersion: 1, pinUpdatedAt: 1000 },
  }));
  const paths = teacherAwardPaths(classroomId, teacherUid, '0'.repeat(32));
  rows.get(`classrooms/${classroomId}`).nextStudentNumber = 2;
  rows.set(paths.actor, {version:1, actorUid:teacherUid, unacknowledgedRequestId:null});
  rows.set(paths.quota, {version:1, count:0});
  const ref = path => ({ path, id: path.split('/').at(-1), collection: name => collection(`${path}/${name}`),
    get: async () => snap(path) });
  const snap = path => ({ id: ref(path).id, ref: ref(path), exists: rows.has(path), data: () => structuredClone(rows.get(path)) });
  function collection(path, filters = []) {
    return { doc: id => ref(`${path}/${id}`), where: (key, op, value) => {
      assert.equal(op, '=='); return collection(path, [...filters, [key, value]]);
    }, limit: max => ({ query: () => [...rows].filter(([p, v]) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/') && filters.every(([k, x]) => v[k] === x)).slice(0, max).map(([p]) => snap(p)) }) };
  }
  const firestore = { doc: ref, collection, async runTransaction(callback) {
    const writes = [];
    const result = await callback({
      get: async r => { assert.equal(writes.length, 0); return r.query ? { docs: r.query() } : snap(r.path); },
      create: (r, v) => { assert.equal(rows.has(r.path), false); writes.push(['set', r.path, v]); },
      set: (r, v) => writes.push(['set', r.path, v]),
      update: (r, v) => writes.push(['set', r.path, { ...rows.get(r.path), ...v }]),
      delete: r => writes.push(['delete', r.path]),
    });
    for (const [kind, p, v] of writes) { if (kind === 'delete') rows.delete(p); else rows.set(p, structuredClone(v)); }
    return result;
  } };
  return { rows, firestore, uid, studentAuth, teacherAuth, classroomId };
}

for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) describe(`student and removal page — ${name}`, () => {
  let browser;
  before(async () => { browser = await engine.launch({ headless: true }); });
  after(async () => { await browser?.close(); });
  async function open(t) {
    const f = fixture(), calls = [];
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept(d.type() === 'prompt' ? '0427' : undefined));
    t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    await page.route('**/*', route => route.abort());
    let loseResponse = false, afterAccess = null, afterReset = null;
    f.revocations = 0;
    await page.exposeFunction('__call', async ({ name, data, role }) => {
      calls.push({ name, data });
      const auth = role === 'teacher' ? f.teacherAuth : f.studentAuth;
      try {
        let result;
        if (name === 'getClassroomAccessV2') { result = await getClassroomAccessService({ firestore: f.firestore, auth, data }); if(afterAccess) await afterAccess(); }
        else if (name === 'resetStudentPinV2') { result = await resetStudentPinV2CallableHandler(data, {auth}, {firestore:f.firestore,hashPin:async()=> 'fictional-new-hash',adminAuth:{revokeRefreshTokens:async()=>{f.revocations++;}}}); if(afterReset) await afterReset(); }
        else if (name === 'removeStudentV2') result = await removeStudentV2CallableHandler(data, { auth }, { firestore: f.firestore });
        else if (name === 'createStudentV2') result = await createStudentV2CallableHandler(data, {auth}, {firestore:f.firestore, projectId:'demo-student-form', keyRing:{currentVersion:'v1',keys:{v1:'ab'.repeat(32)}}, hashPin:async () => 'fictional-hash'});
        else if (['getTeacherMoneyStatusV2','acknowledgeTeacherMoneyV2','cancelTeacherMoneyV2'].includes(name)) result = await recoverTeacherAwardService({...data,operation:{getTeacherMoneyStatusV2:'status',acknowledgeTeacherMoneyV2:'acknowledge',cancelTeacherMoneyV2:'cancel'}[name]}, {firestore:f.firestore,auth,projectId:'demo-student-form'});
        else result = await submitStudentTransactionV2CallableHandler(data, { auth }, { firestore: f.firestore });
        if (['createStudentV2','submitStudentTransactionV2'].includes(name) && loseResponse) { loseResponse = false; throw new Error('fictional lost response'); }
        return { data: result };
      } catch (e) { return { error: { code: e.code || 'unavailable', details: e.details } }; }
    });
    await page.exposeFunction('__load', () => ({ students: [...f.rows].filter(([p]) => p.includes('/students/')).map(([,v]) => v), transactions: [...f.rows].filter(([p]) => p.includes('/transactions/')).map(([,v]) => v) }));
    await page.setContent('<div id="teacherMoneyRecovery" hidden></div><div id="app"></div>');
    await page.addScriptTag({ type: 'module', content: helpers + client + '\nconst {createTeacherMoneyClient,parseTeacherMoneyBalance} = (() => {\n' + plain('../../src/phase3/teacherMoneyClient.js') + '\nreturn {createTeacherMoneyClient,parseTeacherMoneyBalance};})();\n' + `
const IS_MULTI_TEACHER_V2_ENABLED = true, TEACHER_UID = 'fictional-teacher', MAX_RENT_AMOUNT = 1000000;
const auth = {currentUser: {uid: ${JSON.stringify(f.uid)}}}, functions = {};
let v2LastPersistedData = null;
const v2TenantSession = new TenantSession({projectId:'demo-student-form', storageAdapter:{}, onResetGlobals: () => resetAllGlobalState()});
const httpsCallable = (ignored, name) => async data => { const response = await window.__call({name, data, role:v2TenantSession.role}); if(response.error) throw response.error; return response; };
const writeTeacherCache = () => {};
const v2LoadTenantData = async () => ({...data, ...await window.__load()});
` + app + exports + `
window.studentTest = {
  async ready(role = 'student') {
    auth.currentUser = {uid: role === 'teacher' ? 'fictional-teacher' : ${JSON.stringify(f.uid)}};
    v2TenantSession.invalidate('test-switch', {uid: auth.currentUser.uid, state: SESSION_STATES.RESOLVING});
    v2TenantSession.transitionTo(SESSION_STATES.ACTIVE, {uid:auth.currentUser.uid, role, classroomId:'fictional-room', studentId:'1', classroom:{name:'Fictional class'}});
    v2TenantSession.transitionTo(SESSION_STATES.CLASSROOM_LOADING); v2TenantSession.transitionTo(SESSION_STATES.READY);
    if (role === 'teacher') {
      const markers = new Map();
      v2TeacherMoneyClient = createTeacherMoneyClient({session:v2TenantSession,currentUid:()=>auth.currentUser.uid,
        storage:{getItem:k=>markers.get(k)??null,setItem:(k,v)=>markers.set(k,v),removeItem:k=>markers.delete(k)},
        call:async (name,payload)=>(await httpsCallable(functions,name)(payload)).data,
        reload:async ()=>{data={...data,...await window.__load()};v2LastPersistedData=JSON.parse(JSON.stringify(data));return true;},
        random:{getRandomValues:b=>{b.fill(42);return b;}}, notify:()=>render()});
      await v2TeacherMoneyClient.check();
    }
    data = {...cloneDefault(), ...await window.__load()}; v2LastPersistedData = JSON.parse(JSON.stringify(data)); screen = role === 'student' ? 'student' : 'roster'; render();
  },
  profile: () => { teacherProfileStudentId=1; screen='studentProfile'; render(); },
  state: () => ({pinBusy:studentPinResetPending,bulkBusy:bulkOperationPending,busy:studentMoneySubmissionPending, removalBusy:studentLifecyclePending, retry:studentMoneyRetryPayload, data, message}),
};
await window.studentTest.ready();
` });
    await page.waitForFunction(() => document.querySelector('#studentAddAmount'));
    return { page, f, calls, afterAccess: fn => { afterAccess = fn; }, afterReset: fn => { afterReset = fn; }, lose: () => { loseResponse = true; } };
  }
  for (const entry of ['profile','activate','bulk']) test(`PIN ${entry} sends captured control and updates only after save`, async t => {
    const {page,f,calls} = await open(t);
    await page.evaluate(() => window.studentTest.ready('teacher'));
    if(entry==='profile') {
      await page.evaluate(()=>window.studentTest.profile());
      await page.locator('#profileNewStudentPin').fill('0427');
      await page.evaluate(()=>window.resetProfileStudentPin());
    } else if(entry==='activate') await page.evaluate(()=>window.activateStudent('1'));
    else {
      await page.evaluate(()=>{ const section=document.createElement('section'); section.innerHTML='<input id="bulkActivatePin" value="0427"><input type="checkbox" class="bulk-activate-check" value="1" checked>';document.body.append(section); });
      await page.evaluate(()=>window.bulkActivateStudents());
    }
    const sent=calls.filter(c=>c.name==='resetStudentPinV2');
    assert.equal(sent.length,1);assert.deepEqual(sent[0].data,{studentId:'1',newPin:'0427',classroomId:f.classroomId,protocolVersion:1,controlGeneration:1});
    assert.equal(f.rows.get(`classrooms/${f.classroomId}/studentPins/1`).pin,'0427');
    assert.equal(f.revocations,1);
    const state=await page.evaluate(()=>window.studentTest.state());
    assert.equal(state.pinBusy,false);assert.equal(state.bulkBusy,false);
  });
  test('bulk PIN changes keep one generation across a pause/resume',async t=>{
    const {page,f,calls,afterReset}=await open(t);
    f.rows.set(`classrooms/${f.classroomId}/students/2`,{id:2,name:'Fictional Second',balance:0,transactions:[]});
    f.rows.set(`classrooms/${f.classroomId}/studentCredentials/second`,{loginId:'second',classroomId:f.classroomId,studentId:'2',authUid:deriveDeterministicStudentAuthUid(f.classroomId,'2'),active:false,schemaVersion:1,pinUpdatedAt:1000});
    await page.evaluate(()=>window.studentTest.ready('teacher'));
    afterReset(()=>{ f.rows.get(`classrooms/${f.classroomId}`).accessControl.generation++; });
    await page.evaluate(()=>{const section=document.createElement('section');section.innerHTML='<input id="bulkActivatePin" value="0427"><input type="checkbox" class="bulk-activate-check" value="1" checked><input type="checkbox" class="bulk-activate-check" value="2" checked>';document.body.append(section);});
    await page.evaluate(()=>window.bulkActivateStudents());
    assert.equal(f.rows.get(`classrooms/${f.classroomId}/studentPins/1`).pin,'0427');
    assert.equal(f.rows.has(`classrooms/${f.classroomId}/studentPins/2`),false);
    assert.deepEqual(calls.filter(c=>c.name==='resetStudentPinV2').map(c=>c.data.controlGeneration),[1,1]);
    assert.equal(calls.filter(c=>c.name==='getClassroomAccessV2').length,1);
    assert.equal(f.revocations,1);
    const state=await page.evaluate(()=>window.studentTest.state());assert.equal(state.bulkBusy,false);assert.match(state.message,/1 succeeded, 1 failed/);
  });
  for(const change of ['readOnly','resume','session']) test(`PIN profile refuses ${change} after access capture`,async t=>{
    const {page,f,calls,afterAccess}=await open(t);
    await page.evaluate(()=>window.studentTest.ready('teacher'));
    await page.evaluate(()=>window.studentTest.profile());
    await page.locator('#profileNewStudentPin').fill('0427');
    afterAccess(async()=>{
      if(change==='session') await page.evaluate(()=>window.studentTest.ready('student'));
      else {const c=f.rows.get(`classrooms/${f.classroomId}`).accessControl;if(change==='resume')c.generation++;else c.mode='readOnly';}
    });
    await page.evaluate(()=>window.resetProfileStudentPin());
    assert.equal(f.rows.has(`classrooms/${f.classroomId}/studentPins/1`),false);assert.equal(f.revocations,0);
    assert.equal(calls.filter(c=>c.name==='resetStudentPinV2').length,change==='session'?0:1);
    assert.equal((await page.evaluate(()=>window.studentTest.state())).pinBusy,false);
  });
  for (const lost of [false, true]) test(`Add Student records opening history and recovers a lost response (${lost})`, async t => {
    const { page, f, calls, lose } = await open(t);
    await page.evaluate(() => window.studentTest.ready('teacher'));
    await page.locator('#newStudentName').fill('Fictional New');
    await page.locator('#newStudentPin').fill('0427');
    await page.locator('#newStudentBalance').fill('12.34');
    if (lost) lose();
    await page.evaluate(() => window.addStudent());
    const student = f.rows.get(`classrooms/${f.classroomId}/students/2`);
    assert.equal(student.balance, 12.34); assert.equal(student.transactions.length, 1);
    assert.equal(student.transactions[0].source, 'Opening Balance');
    const state = await page.evaluate(() => window.studentTest.state());
    assert.equal(state.removalBusy, false);
    assert.deepEqual(state.data.students.find(s=>s.id===2).transactions, student.transactions);
    assert.equal(calls.filter(c=>c.name==='createStudentV2').length, 1);
    assert.equal(await page.locator('#teacherMoneyRecovery').isVisible(), true);
    assert.match(await page.locator('#teacherMoneyRecovery').innerText(), /Login ID: fictional-new/);
    await page.evaluate(() => window.acknowledgeTeacherMoneySave());
    assert.equal(await page.locator('#teacherMoneyRecovery').isVisible(), false);
    assert.equal(f.rows.get(`classrooms/${f.classroomId}`).nextStudentNumber, 3);
  });
  test('actual Add/Subtract buttons send versioned cents and publish confirmed ledger/balance', async t => {
    const {page, f, calls} = await open(t);
    await page.locator('#studentAddAmount').fill('3');
    await page.getByRole('button', {name:'Submit Add Money', exact:true}).click();
    await page.waitForFunction(() => !window.studentTest.state().busy && window.studentTest.state().data.transactions.length === 1);
    await page.locator('#studentSubtractAmount').fill('2');
    await page.getByRole('button', {name:'Submit Subtract Money', exact:true}).click();
    await page.waitForFunction(() => !window.studentTest.state().busy && window.studentTest.state().data.transactions.length === 2);
    assert.equal(f.rows.get('classrooms/fictional-room/students/1').balance, 18);
    assert.deepEqual(calls.filter(c => c.name === 'submitStudentTransactionV2').map(c => [c.data.amountCents,c.data.protocolVersion,c.data.controlGeneration]), [[300,1,1],[200,1,1]]);
    assert.equal(calls.some(c => Object.hasOwn(c.data,'amount')), false);
  });
  test('lost response retry retains original generation and ID; a later generation cannot write again', async t => {
    const {page, f, calls, lose} = await open(t); lose();
    await page.locator('#studentAddAmount').fill('3');
    await page.getByRole('button', {name:'Submit Add Money',exact:true}).click();
    await page.waitForFunction(() => !window.studentTest.state().busy && window.studentTest.state().retry);
    f.rows.get('classrooms/fictional-room').accessControl.generation = 3;
    await page.locator('#studentAddAmount').fill('3');
    await page.getByRole('button', {name:'Submit Add Money',exact:true}).click();
    await page.waitForFunction(() => !window.studentTest.state().busy);
    const submissions = calls.filter(c => c.name === 'submitStudentTransactionV2');
    assert.equal(submissions.length,2); assert.deepEqual(submissions[0].data,submissions[1].data);
    assert.equal(calls.filter(c => c.name === 'getClassroomAccessV2').length,1);
    assert.equal(f.rows.get('classrooms/fictional-room/students/1').transactions.length,1);
  });
  test('removal button refuses pending requests, then reloads confirmed removal preserving history', async t => {
    const {page, f} = await open(t);
    await page.locator('#studentAddAmount').fill('3');
    await page.getByRole('button', {name:'Submit Add Money',exact:true}).click();
    await page.waitForFunction(() => !window.studentTest.state().busy && window.studentTest.state().data.transactions.length === 1);
    await page.evaluate(() => window.studentTest.ready('teacher'));
    await page.locator('button[onclick="removeStudent(1)"]').click();
    await page.waitForFunction(() => !window.studentTest.state().removalBusy);
    assert.match((await page.evaluate(() => window.studentTest.state())).message,/pending requests/);
    assert.equal(f.rows.has('classrooms/fictional-room/students/1'),true);
    const ledger = [...f.rows].find(([p]) => p.includes('/transactions/'));
    ledger[1].status = 'Denied'; f.rows.get('classrooms/fictional-room/students/1').transactions[0].status = 'Denied';
    await page.locator('button[onclick="removeStudent(1)"]').click();
    await page.waitForFunction(() => !window.studentTest.state().removalBusy);
    assert.equal(f.rows.has('classrooms/fictional-room/students/1'),false);
    assert.equal(f.rows.get(ledger[0]).status,'Denied');
    assert.equal((await page.evaluate(() => window.studentTest.state())).data.students.length,0);
  });
});
