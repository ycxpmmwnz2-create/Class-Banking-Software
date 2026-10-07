import assert from 'node:assert/strict'
import test from 'node:test'
import { teacherAwardFixture } from '../../tests/phase3/teacherAward.fixture.js'
import { editTeacherProfileService } from './teacherProfile.js'
const copy = value => globalThis.structuredClone(value)
const code = value => error => error.code === value
function fixture() {
  const f = teacherAwardFixture()
  f.seed = () => {
    const row = { id: 11, studentId: 1, studentName: 'Recorded former name', date: f.time,
      type: 'Add', amount: 2.35, status: 'Pending', source: 'Student', reason: 'Homework', category: '', memo: '' }
    f.student(1).transactions.push(copy(row)); f.data.set('classrooms/class-a/transactions/11', row)
    return row
  }
  f.rename = extra => editTeacherProfileService({ protocolVersion: 1, controlGeneration: 7,
    classroomId: f.classroomId, studentId: 1, expectedName: 'Fictional Avery', name: 'Fictional Renamed', ...extra }, f.dependencies)
  return f
}

test('profile compare-and-set preserves all history and balance; exact desired-name retry is a successful no-op', async () => {
  const f = fixture(); const old = f.seed(); const before = copy(f.student(1)); await f.rename()
  assert.deepEqual(f.student(1), { ...before, name: 'Fictional Renamed' })
  assert.deepEqual(f.data.get('classrooms/class-a/transactions/11'), old)
  assert.deepEqual(f.commits[0], [['update', 'classrooms/class-a/students/1', { name: 'Fictional Renamed' }]])
  await f.rename(); assert.equal(f.commits.length, 1)
  await assert.rejects(f.rename({ name: 'Different' }), code('failed-precondition'))
})
test('profile lost response can safely retry; unchanged desired name still checks current authority/generation', async () => {
  const f = fixture(); f.loseResponse = true; await assert.rejects(f.rename(), /lost SDK/)
  await f.rename(); assert.equal(f.commits.length, 1)
  f.data.get('classrooms/class-a').accessControl.generation++
  await assert.rejects(f.rename()); assert.equal(f.commits.length, 1)
})
test('profile transaction retry rejects pause, owner transfer and changed expected name', async () => {
  for (const mutate of [
    data => { data.get('classrooms/class-a').accessControl.mode = 'suspended' },
    data => { data.get('classrooms/class-a').ownerUid = 'other' },
    data => { data.get('classrooms/class-a/students/1').name = 'New name' },
  ]) {
    const f = fixture(); f.beforeCommit = mutate; await assert.rejects(f.rename()); assert.equal(f.commits.length, 0)
  }
})

test('profile refuses a captured classroom mismatch even with matching generation, student ID and name', async () => {
  const f = fixture();
  await assert.rejects(f.rename({ classroomId: 'other-classroom' }), code('failed-precondition'));
  assert.equal(f.commits.length, 0);
});
