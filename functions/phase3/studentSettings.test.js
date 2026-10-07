import assert from 'node:assert/strict'
import test from 'node:test'
import { getStudentSettingsCallable } from './studentSettings.js'
import { database, documents, studentAuth, teacherAuth } from '../../tests/phase3/classroomAccess.fixture.js'
import { DEFAULT_STUDENT_ADD_MONEY_CATEGORIES, LEGACY_DEFAULT_ADD_MONEY_CATEGORIES } from './studentMoney.js'

const fixture = (mode = 'active') => ({ ...documents(mode),
  'classrooms/class-a/students/1': { id: 1, name: 'PRIVATE STUDENT', balance: 25 } })
const settings = { studentRequestsEnabled: true, studentAddRequestsEnabled: false,
  studentSubtractRequestsEnabled: true, addMoneyCategories: ['Custom Credit'], subtractMoneyCategories: ['Custom Debit'] }
const call = (firestore, auth = studentAuth, data = {}) => getStudentSettingsCallable({ auth, data }, { firestore })

test('settings read returns only bound allowlisted settings, no private fields or writes', async () => {
  for (const mode of ['active', 'readOnly']) {
    const docs = fixture(mode)
    docs['classrooms/class-a'].settings = { ...settings, privateTeacherSetting: 'PRIVATE' }
    const db = database([docs])
    assert.deepEqual(await call(db), { protocolVersion: 1, classroomId: 'class-a', studentId: '1', settings })
    assert.equal(db.staged.length, 0)
    assert.equal(db.reads.length, 5)
  }
})
test('missing defaults and historical Add categories use exactly the transaction normalization', async () => {
  for (const raw of [undefined, { addMoneyCategories: [...LEGACY_DEFAULT_ADD_MONEY_CATEGORIES] }]) {
    const docs = fixture(); docs['classrooms/class-a'].settings = raw
    const result = await call(database([docs]))
    assert.deepEqual(result.settings.addMoneyCategories, DEFAULT_STUDENT_ADD_MONEY_CATEGORIES)
    assert.equal(result.settings.studentRequestsEnabled, true)
  }
})
test('empty lists and all disabled flags are preserved', async () => {
  const docs = fixture(); docs['classrooms/class-a'].settings = { studentRequestsEnabled:false,
    studentAddRequestsEnabled:false,studentSubtractRequestsEnabled:false,addMoneyCategories:[],subtractMoneyCategories:[] }
  assert.deepEqual((await call(database([docs]))).settings, docs['classrooms/class-a'].settings)
})
test('anonymous, teacher, forged tenant and extra request fields are denied', async () => {
  for (const [auth, data, code] of [[null,{},'unauthenticated'], [teacherAuth,{},'permission-denied'],
    [{...studentAuth,token:{...studentAuth.token,classroomId:'class-b'}},{},'permission-denied'],
    [studentAuth,{classroomId:'class-b'},'invalid-argument']]) {
    await assert.rejects(call(database([fixture()]),auth,data), {code})
  }
})
for (const [label, change] of [
  ['suspended', d => {d['classrooms/class-a'].accessControl.mode='suspended'}],
  ['missing control', d => {delete d['classrooms/class-a'].accessControl}],
  ['inactive teacher', d => {d['teachers/teacher-a'].status='inactive'}],
  ['foreign teacher mapping', d => {d['teachers/teacher-a'].classroomId='class-b'}],
  ['stale credential', d => {d['classrooms/class-a/studentCredentials/learner1'].pinUpdatedAt=2000}],
  ['inactive credential', d => {d['classrooms/class-a/studentCredentials/learner1'].active=false}],
  ['removed student', d => {delete d['classrooms/class-a/students/1']}],
  ['wrong student', d => {d['classrooms/class-a/students/1'].id=2}],
]) test(`settings read fails closed: ${label}`, async () => {
  const docs=fixture();change(docs);const db=database([docs])
  await assert.rejects(call(db), {code:'permission-denied'});assert.equal(db.staged.length,0)
})
test('malformed settings do not expose private error details or fall back to defaults', async () => {
  const docs=fixture();docs['classrooms/class-a'].settings={studentRequestsEnabled:'PRIVATE'}
  await assert.rejects(call(database([docs])), e=>e.code==='failed-precondition' && !e.message.includes('PRIVATE'))
})
test('retried reads recheck auth/control and use the final settings snapshot', async () => {
  const first=fixture(),last=fixture();last['classrooms/class-a'].settings=settings
  assert.deepEqual((await call(database([first,last]))).settings,settings)
  await assert.rejects(call(database([first,fixture('suspended')])),{code:'permission-denied'})
})
