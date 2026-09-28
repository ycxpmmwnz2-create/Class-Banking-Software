import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { URL } from 'node:url'
import { DEFAULT_ADD_MONEY_CATEGORIES } from '../../../src/phase2b/transactionCategoryDisplay.js'
import { PROJECTION_DEFAULTS } from './projectionDefaults.js'
import { runProtectedMoneyScan } from './runner.js'
import { makeFixture } from './fixtures.js'
import { hash } from './common.js'
const run = f => runProtectedMoneyScan(f.plan, f.dependencies)
const report = f => JSON.parse(f.published[0].contents)

test('real projects and unknown plan keys deny before dependencies or any reads', async () => {
  const f = makeFixture(); f.plan.projectId = 'morgan-bank'
  const deps = new Proxy({}, { get() { assert.fail('dependency touched before production rejection') } })
  assert.equal((await runProtectedMoneyScan(f.plan, deps)).category, 'live-unavailable')
  for (const mutate of [p => { p.force = true }, p => { p.rooms.push(p.rooms[0]) }, p => { p.canaryClassroomId = 'missing' },
    p => { p.databaseId = 'other' }, p => { p.expiresAt = p.notBefore + 1800001 }]) {
    const f = makeFixture();mutate(f.plan);assert.equal((await run(f)).status, 'aborted');assert.equal(f.calls.length, 0)
  }
})
test('two tenants, overlapping student IDs, masked owners, complete private report and unchanged bytes', async () => {
  const f = makeFixture(), before = globalThis.structuredClone([...f.store])
  const summary = await run(f)
  assert.equal(summary.status, 'complete');assert.equal(summary.classroomCount, 2);assert.equal(summary.studentCount, 2)
  assert.equal(summary.blockedClassroomCount, 0);assert.equal(summary.totalsIncludeFictionalCanary, true)
  assert.equal(summary.initializationAllowed, false);assert.equal(summary.activationAllowed, false)
  assert.deepEqual([...f.store], before)
  assert.ok(!JSON.stringify(summary).includes('FICTIONAL_PRIVATE'));assert.ok(!JSON.stringify(summary).includes('room-b'))
  assert.ok(!f.published[0].contents.includes('FICTIONAL_PRIVATE'))
  assert.equal(report(f).versions.length, 8);assert.equal(report(f).observerDigest, hash(report(f).exit))
  for (const call of f.calls.filter(call => call[0] === 'get' && call[1].startsWith('teachers/'))) {
    assert.ok(call[2].every(key => ['uid', 'status', 'classroomId'].includes(key)))
  }
  assert.ok(f.calls.every(call => !/balanceHistory|studentPins|studentCredentials|loginHistory/.test(call[1])))
})
test('phantom witness-only root blocks metadata inventory before money or publication', async () => {
  const f = makeFixture();f.put('classrooms/missing/balanceHistory/witness', { private: 'FICTIONAL_PRIVATE' })
  assert.equal((await run(f)).category, 'foundation')
  assert.equal(f.published.length, 0);assert.equal(f.calls.filter(c => c[0] === 'get').length, 0)
})
test('foreign owner, omitted room, suspended scope and malformed controls cannot bypass gates', async () => {
  for (const mutate of [f => f.put('classrooms/canary', { ownerUid: 'foreign' }), f => f.plan.rooms.pop(),
    f => f.put('classrooms/canary', { ownerUid: 'fictional-owner-a', accessControl: { mode: 'suspended' } })]) {
    const f = makeFixture();mutate(f);assert.equal((await run(f)).status, 'aborted');assert.equal(f.published.length, 0)
    assert.ok(!f.calls.some(c => /students|transactions/.test(c[1])))
  }
  const f = makeFixture();f.put('classrooms/canary', { ownerUid: 'fictional-owner-a', accessControl: { mode: 'active' } })
  assert.equal((await run(f)).reasonCounts['classroom-control-shape'], 1)
})
test('actual projection rejects nested credentials, root tenant, lastBackupAt and rent; optional defaults pass', async () => {
  for (const mutate of [f => f.put('classrooms/canary', { ownerUid: 'fictional-owner-a', settings: { nested: { token: 'FICTIONAL_PRIVATE' } } }),
    f => f.put('classrooms/canary', { ownerUid: 'fictional-owner-a', lastBackupAt: 123 }),
    f => f.put('classrooms/canary/studentDisplay/rent', { rentAmount: -1, updatedAt: 'now' })]) {
    const f = makeFixture();mutate(f);const result = await run(f)
    assert.equal(result.status, 'complete');assert.ok(result.blockedClassroomCount > 0)
    assert.ok(Object.keys(result.reasonCounts).some(key => key.startsWith('projection-')))
    assert.ok(!f.published[0].contents.includes('FICTIONAL_PRIVATE'))
  }
  const f = makeFixture();f.put('classrooms/canary', { ownerUid: 'fictional-owner-a', classroomId: 'foreign' })
  assert.equal((await run(f)).category, 'foundation')
  for (const settings of [null, {}, undefined]) {
    const f = makeFixture();f.put('classrooms/canary', { ownerUid: 'fictional-owner-a', ...(settings === undefined ? {} : { settings }) })
    assert.equal((await run(f)).blockedClassroomCount, 0)
  }
})
test('shared Stage9 money logic catches fractions and exact mirror parity without changing records', async () => {
  const f = makeFixture(), path = 'classrooms/canary/students/1'
  f.put(path, { ...f.store.get(path).data, balance: 1.001 })
  f.put('classrooms/canary/transactions/1', { id: 1, studentId: 1, studentName: 'Fictional', date: 'then',
    amount: 1.1, type: 'Add', status: 'Approved', source: 'Teacher', reason: '', memo: '', category: '' })
  const before = globalThis.structuredClone([...f.store]), result = await run(f)
  assert.equal(result.reasonCounts['balance-out-of-domain'], 1);assert.equal(result.reasonCounts['missing-ledger-mirror'], 1)
  assert.deepEqual([...f.store], before)
})
test('paginated reads include every record; malformed/repeating namespace pages abort', async () => {
  const f = makeFixture()
  for (let n = 2; n <= 30; n++) f.put(`classrooms/canary/students/${n}`, { id: n, name: 'Fictional', balance: 0, frozen: false, transactions: [] })
  assert.equal((await run(f)).studentCount, 31)
  assert.ok(f.calls.some(c => c[0] === 'list' && c[2] === '25'))
  for (const page of [ { documents: [{ path: 'classrooms/canary', exists: true }, { path: 'classrooms/canary', exists: true }], nextPageToken: '' },
    { documents: [], nextPageToken: 'again' }, { documents: [{ path: 'classrooms/canary/foreign', exists: true }], nextPageToken: '' }]) {
    const f = makeFixture();f.dependencies.reader.listPage = async () => page
    assert.equal((await run(f)).status, 'aborted');assert.equal(f.published.length, 0)
  }
})
test('edit/restore, new rent, deleted/recreated student and scope mutation during revalidation abort', async () => {
  for (const mutate of [f => f.put('classrooms/canary/students/1', f.store.get('classrooms/canary/students/1').data),
    f => f.put('classrooms/canary/studentDisplay/rent', { rentAmount: 0, updatedAt: 'now' }),
    f => { f.store.delete('classrooms/canary/students/1');f.put('classrooms/canary/students/1', { id: 1, name: 'Fictional', balance: 0, frozen: false, transactions: [] }) }]) {
    const f = makeFixture();let done = false
    f.beforeRead = (kind, path, mask) => { if (!done && kind === 'get' && mask?.length === 0) { done = true;mutate(f) } }
    assert.equal((await run(f)).category, 'drift');assert.equal(f.published.length, 0)
  }
  const f = makeFixture();let rootLists = 0
  f.beforeRead = (kind, path) => { if (kind === 'list' && path === 'classrooms' && ++rootLists === 2) f.put('classrooms/extra', { ownerUid: 'x' }) }
  assert.equal((await run(f)).category, 'drift')
})
test('observer interval rejects reopen/reclose and incomplete, misbound or stale records', async () => {
  const f = makeFixture();f.beforeFinish = () => { f.change('reopen');f.change('reclose') }
  assert.equal((await run(f)).category, 'continuity');assert.equal(f.published.length, 0)
  for (const patch of [{ complete: false }, { evidenceDigest: 'f'.repeat(64) }, { entryDigest: 'f'.repeat(64) }, { coveredThrough: 0 }]) {
    const f = makeFixture(), finish = f.dependencies.observer.finish
    f.dependencies.observer.finish = async args => ({ ...await finish(args), ...patch })
    assert.equal((await run(f)).category, 'continuity');assert.equal(f.published.length, 0)
  }
})
test('caller plan mutation during await does not change frozen scope or report binding', async () => {
  const f = makeFixture(), prior = hash(f.plan)
  f.beforeRead = () => { f.plan.rooms[0].ownerUid = 'foreign';f.plan.sourceCommit = 'f'.repeat(40) }
  assert.equal((await run(f)).status, 'complete');assert.equal(report(f).planDigest, prior)
})
test('expiry, backwards clock and redacted transport errors fail without leaking data', async () => {
  for (const mutate of [f => f.advance(61000), f => f.advance(-100), () => { throw Error('FICTIONAL_PRIVATE_TOKEN') }]) {
    const f = makeFixture();f.beforeRead = () => mutate(f)
    const result = await run(f);assert.equal(result.status, 'aborted');assert.equal(result.publication, 'not-attempted')
    assert.equal(f.published.length, 0);assert.ok(!JSON.stringify(result).includes('FICTIONAL_PRIVATE'))
  }
})
test('unacknowledged publication never claims no file was written or invites reuse', async () => {
  const f = makeFixture();f.dependencies.publisher.publish = async () => { throw Error('FICTIONAL_PRIVATE_PATH') }
  const result = await run(f);assert.equal(result.status, 'aborted');assert.equal(result.publication, 'unconfirmed')
  assert.ok(!JSON.stringify(result).includes('FICTIONAL_PRIVATE'))
})
test('timed-out hold cannot start publication after the aborted result', async () => {
  const f = makeFixture();f.plan.expiresAt = f.now() + 25
  let release, held
  const gate = new Promise(resolve => { release = resolve })
  f.dependencies.observer.hold = (_exit, action) => {
    held = gate.then(action)
    return held
  }
  const result = await run(f)
  assert.ok(held, 'the hold was reached before the real dependency timer fired')
  assert.equal(result.status, 'aborted');assert.equal(result.category, 'expired')
  assert.equal(result.publication, 'not-attempted');assert.equal(f.published.length, 0)
  release()
  const lateResult = await held.catch(error => error)
  assert.equal(f.published.length, 0, 'late callback must not start a publisher')
  assert.equal(lateResult.category, 'expired')
})
test('publication already started at timeout stays unconfirmed even if it later writes', async () => {
  const f = makeFixture();f.plan.expiresAt = f.now() + 25
  const publish = f.dependencies.publisher.publish, hold = f.dependencies.observer.hold
  let release, held, started = false
  const gate = new Promise(resolve => { release = resolve })
  f.dependencies.publisher.publish = async value => { started = true;await gate;return publish(value) }
  f.dependencies.observer.hold = (...args) => { held = hold(...args);return held }
  const result = await run(f)
  assert.equal(started, true);assert.equal(result.category, 'expired')
  assert.equal(result.status, 'aborted');assert.equal(result.publication, 'unconfirmed')
  assert.equal(f.published.length, 0)
  release();await held.catch(() => {})
  assert.equal(f.published.length, 1)
  for (const key of ['artifactAccepted', 'productionEligible', 'initializationAllowed', 'activationAllowed']) assert.equal(report(f)[key], false)
  assert.equal(result.status, 'aborted');assert.equal(result.publication, 'unconfirmed')
})
test('observer success without invoking publication cannot manufacture completion', async () => {
  const f = makeFixture()
  f.dependencies.observer.hold = async () => true
  const result = await run(f)
  assert.equal(result.status, 'aborted');assert.equal(result.category, 'continuity')
  assert.equal(result.publication, 'not-attempted');assert.equal(f.published.length, 0)
})
test('completed run rejects a retained publication callback', async () => {
  const f = makeFixture();let retainedAction
  f.dependencies.observer.hold = async (_exit, action) => { retainedAction = action;return action() }
  assert.equal((await run(f)).status, 'complete');assert.equal(f.published.length, 1)
  await assert.rejects(retainedAction(), error => error.category === 'expired')
  assert.equal(f.published.length, 1)
})
test('projection defaults equal the actual teacher-loader call site in index.html', async () => {
  const source = await readFile(new URL('../../../index.html', import.meta.url), 'utf8')
  const block = source.match(/const defaultSettings = (\{[\s\S]*?\n {4}\});/)[1]
  const expected = vm.runInNewContext('(' + block + ')', { DEFAULT_ADD_MONEY_CATEGORIES })
  assert.deepEqual(JSON.parse(JSON.stringify(PROJECTION_DEFAULTS)), JSON.parse(JSON.stringify(expected)))
  assert.match(source, /createTenantDataLoader\(\{[\s\S]*?defaultSettings\s*\}\)/)
})
test('getters, cycles, excess nesting and byte budget cannot be converted to a successful prefix', async () => {
  const f = makeFixture();let accessed = false
  Object.defineProperty(f.plan, 'projectId', { enumerable: true, get() { accessed = true;return 'demo-morgan-bank-protected-scan' } })
  assert.equal((await run(f)).category, 'invalid-plan');assert.equal(accessed, false)
  for (const value of [(() => { const x = {};x.self = x;return x })(),
    Array.from({ length: 34 }).reduce(a => ({ child: a }), {}), 'x'.repeat(33 * 1024 * 1024)]) {
    const f = makeFixture()
    f.dependencies.reader.get = async () => value
    assert.equal((await run(f)).status, 'aborted');assert.equal(f.published.length, 0)
  }
})
test('observer future coverage cannot manufacture a completed interval', async () => {
  const f = makeFixture(), finish = f.dependencies.observer.finish
  f.dependencies.observer.finish = async args => ({ ...await finish(args), coveredThrough: f.now() + 1 })
  assert.equal((await run(f)).category, 'continuity');assert.equal(f.published.length, 0)
})
test('maintenance loss during storage leaves an explicitly unaccepted artifact and aborts', async () => {
  const f = makeFixture(), publish = f.dependencies.publisher.publish
  f.dependencies.publisher.publish = async value => {
    const receipt = await publish(value);f.change('reopen');return receipt
  }
  const result = await run(f)
  assert.equal(result.status, 'aborted');assert.equal(result.publication, 'unconfirmed')
  assert.equal(report(f).artifactAccepted, false)
  assert.equal(report(f).productionEligible, false)
})
