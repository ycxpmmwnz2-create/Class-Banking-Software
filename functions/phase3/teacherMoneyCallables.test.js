import assert from 'node:assert/strict'
import test from 'node:test'
import { teacherAwardFixture } from '../../tests/phase3/teacherAward.fixture.js'
import { executeTeacherMoneyCallable, planTeacherMoneyCallable, recoverTeacherMoneyCallable } from './teacherMoneyCallables.js'

test('callables plan, execute once, recover and explicitly acknowledge the same server action', async () => {
  const f = teacherAwardFixture(), auth = f.dependencies.auth
  const preview = await planTeacherMoneyCallable({ auth, data: f.request() }, f.dependencies)
  const result = await executeTeacherMoneyCallable({ auth, data: { request: preview.request, plan: preview.plan } }, f.dependencies)
  assert.equal(f.student(1).balance, 21)
  assert.equal(result.acknowledged, false)
  assert.deepEqual(await executeTeacherMoneyCallable({ auth, data: { request: preview.request, plan: preview.plan } }, f.dependencies), result)
  assert.equal(f.commits.length, 1)
  const data = { protocolVersion: 1, classroomId: f.classroomId, requestId: result.requestId }
  assert.equal((await recoverTeacherMoneyCallable({ auth, data }, f.dependencies, 'status')).status, 'committed')
  assert.equal((await recoverTeacherMoneyCallable({ auth, data }, f.dependencies, 'acknowledge')).acknowledged, true)
  assert.equal(f.data.get(f.paths.actor).unacknowledgedRequestId, null)
  assert.equal(f.student(1).balance, 21)
})

test('unplanned requests, student roles and missing auth never enter an executable service', async () => {
  const f = teacherAwardFixture()
  for (const auth of [null, { uid: f.uid, token: { role: 'student' } }]) {
    await assert.rejects(planTeacherMoneyCallable({ auth, data: f.request() }, f.dependencies))
    await assert.rejects(executeTeacherMoneyCallable({ auth, data: f.request() }, f.dependencies))
    assert.deepEqual(f.reads, [])
  }
  await assert.rejects(executeTeacherMoneyCallable({ auth: f.dependencies.auth, data: f.request() }, f.dependencies))
  assert.deepEqual(f.commits, [])
})

test('stale preview returns a bound refusal; cancellation fences the key and never changes money', async () => {
  const f = teacherAwardFixture(), auth = f.dependencies.auth
  const preview = await planTeacherMoneyCallable({ auth, data: f.request() }, f.dependencies)
  f.student(1).balance = 22
  const result = await executeTeacherMoneyCallable({ auth, data: { request: preview.request, plan: preview.plan } }, f.dependencies)
  assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'stale-plan')
  assert.equal(result.digest, preview.plan.digest); assert.equal(result.wroteNothing, true)
  assert.equal(f.commits.length, 0)
  const data = { protocolVersion: 1, classroomId: f.classroomId, requestId: preview.request.requestId }
  assert.equal((await recoverTeacherMoneyCallable({ auth, data }, f.dependencies, 'cancel')).status, 'cancelled')
  assert.equal((await executeTeacherMoneyCallable({ auth, data: { request: preview.request, plan: preview.plan } }, f.dependencies)).reason, 'request-cancelled')
  assert.equal(f.student(1).balance, 22)
})

test('lost SDK response is ambiguous and redacted; fresh status establishes the committed outcome', async () => {
  const f = teacherAwardFixture(), auth = f.dependencies.auth
  const preview = await planTeacherMoneyCallable({ auth, data: f.request() }, f.dependencies)
  f.loseResponse = true
  await assert.rejects(executeTeacherMoneyCallable({ auth, data: { request: preview.request, plan: preview.plan } }, f.dependencies), error => {
    assert.equal(error.code, 'internal'); assert.equal(error.message.includes('PRIVATE'), false)
    assert.equal(error.details, undefined); return true
  })
  assert.equal(f.student(1).balance, 21)
  const data = { protocolVersion: 1, classroomId: f.classroomId, requestId: preview.request.requestId }
  assert.equal((await recoverTeacherMoneyCallable({ auth, data }, f.dependencies, 'status')).status, 'committed')
})

test('recovery forbids client operation overrides and foreign classroom binding', async () => {
  const f = teacherAwardFixture(), auth = f.dependencies.auth
  for (const data of [
    { protocolVersion: 1, classroomId: 'foreign', requestId: null },
    { protocolVersion: 1, classroomId: f.classroomId, requestId: null, operation: 'cancel' },
  ]) await assert.rejects(recoverTeacherMoneyCallable({ auth, data }, f.dependencies, 'status'))
  assert.equal(f.commits.length, 0)
})
