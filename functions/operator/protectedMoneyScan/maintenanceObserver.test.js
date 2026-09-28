import assert from 'node:assert/strict'
import test from 'node:test'
import { makeMaintenanceFixture } from './maintenanceFixtures.js'
import { createMaintenanceObserver, MAINTENANCE_SURFACES } from './maintenanceObserver.js'
import { runObservedMoneyScan } from './observedRunner.js'
import { hash, ScanAbort } from './common.js'
const run = f => runObservedMoneyScan(f.plan, f.expectation, f.observedDependencies)
const barrier = () => { let resolve;const promise = new Promise(r => { resolve = r });return { promise, resolve } }

test('real projects refuse before collector, expectation or dependency access', async () => {
  const f = makeMaintenanceFixture();f.plan.projectId = 'morgan-bank'
  const forbidden = new Proxy({}, { get() { assert.fail('private dependency accessed') } })
  assert.equal((await runObservedMoneyScan(f.plan, forbidden, forbidden)).category, 'live-unavailable')
  assert.throws(() => createMaintenanceObserver(f.plan, forbidden, forbidden), error => error.category === 'live-unavailable')
})
test('complete fictional evidence runs the real scanner, retains the lease through acknowledgement and consumes the run', async () => {
  const f = makeMaintenanceFixture(), publish = f.observedDependencies.publisher.publish
  const before = globalThis.structuredClone([...f.store])
  f.observedDependencies.publisher.publish = async value => { assert.equal(f.leaseHeld(), true);return publish(value) }
  const result = await run(f)
  assert.equal(result.status, 'complete');assert.equal(f.published.length, 1)
  assert.equal(f.collectorCalls.filter(c => c === 'history').length, 4)
  assert.deepEqual([...f.store], before);assert.equal(f.releaseCount, 1);assert.equal(f.leaseHeld(), false)
  assert.equal(JSON.parse(f.published[0].contents).artifactAccepted, false)
  assert.equal((await run(f)).category, 'continuity');assert.equal(f.published.length, 1)
})
const unsafeStates = [
  ['global-off', s => { s.globalV2 = 'disabled' }], ['verification mode', s => { s.maintenanceMode = 'verification' }],
  ['profile sync', s => { s.profileSync = 'normal' }], ['legacy admission', s => { s.legacyWriters = 'normal' }],
  ['unclassified writer', s => { s.writers.push({ ...s.writers[0], id: 'unknown' }) }],
  ['missing writer', s => { s.writers.pop() }], ['in-flight transaction', s => { s.writers.at(-1).inFlight = 1 }],
  ['queued task', s => { s.writers.find(w => w.kind === 'task').queued = 1 }],
  ['retrying old revision', s => { s.writers.find(w => w.kind === 'revision').retrying = 1 }],
  ['admitted scheduler', s => { s.writers.find(w => w.kind === 'scheduler').admission = 'normal' }],
  ['audit writes money', s => { s.writers.find(w => w.admission === 'audit-only').writeScope = 'students' }],
  ['disabled audit recorder', s => { s.writers.find(w => w.admission === 'audit-only').admission = 'closed' }],
  ['missing drain evidence', s => { s.writers[0].drainEvidenceDigest = '' }],
  ['unverified credentials', s => { s.credentials.status = 'unknown' }],
  ['credentials predate drain', s => { s.credentials.verifiedAt = s.drainedAt - 1 }],
  ['pending witness', s => { s.audit[0].outcome = 'pending' }], ['retrying witness', s => { s.audit[0].outcome = 'retrying' }],
  ['missing witness outcome', s => { s.audit = [] }], ['unknown witness version', s => { s.audit[0].versionDigest = hash('other') }],
  ['canary cleanup', s => { s.canary.phase = 'cleanup' }], ['foreign canary', s => { s.canary.classroomId = 'other' }],
  ['missing batch probe', s => { s.canary.probes.shift() }], ['invalid positive control', s => { s.canary.probes[0].prior.outcome = 'denied' }],
  ['changed probe payload', s => { s.canary.probes[0].maintenance.requestDigest = hash('other') }],
  ['changed probe identity', s => { s.canary.probes[0].maintenance.identityDigest = hash('other') }],
  ['successful denial probe', s => { s.canary.probes[0].maintenance.outcome = 'succeeded' }],
  ['probe changed data', s => { s.canary.probes[0].afterDigest = hash('other') }],
]
for (const [name, mutate] of unsafeStates) test(`entry refuses ${name} with zero data reads`, async () => {
  const f = makeMaintenanceFixture();mutate(f.maintenance)
  const result = await run(f)
  assert.equal(result.status, 'aborted');assert.equal(result.category, 'continuity')
  assert.equal(result.publication, 'not-attempted');assert.equal(f.calls.length, 0);assert.equal(f.published.length, 0)
  assert.equal(f.leaseHeld(), false)
})
test('reconciled terminal historical gaps stay allowed but pending retries never age into gaps', async () => {
  const f = makeMaintenanceFixture();f.maintenance.audit[0].outcome = 'terminal-gap'
  assert.equal((await run(f)).status, 'complete')
  const pending = makeMaintenanceFixture();pending.maintenance.audit[0].outcome = 'pending';pending.advance(1000)
  assert.equal((await run(pending)).category, 'continuity');assert.equal(pending.calls.length, 0)
})
for (const artifact of ['rules', 'revisions', 'runtime', 'triggers', 'iam', 'recovery', 'credentialVerifier']) test(`unreviewed ${artifact} artifact blocks entry`, async () => {
  const f = makeMaintenanceFixture();f.maintenance.artifacts[artifact] = hash('other')
  assert.equal((await run(f)).category, 'continuity');assert.equal(f.calls.length, 0)
})
for (const surface of MAINTENANCE_SURFACES) test(`${surface} change invalidates the next data batch`, async () => {
  const f = makeMaintenanceFixture();f.beforeRead = () => { f.platformChange(surface) }
  assert.equal((await run(f)).category, 'continuity')
  assert.equal(f.calls.length, 1);assert.equal(f.published.length, 0);assert.equal(f.leaseHeld(), false)
})
test('reopen and reclose with equal final state still aborts from sequence history', async () => {
  const f = makeMaintenanceFixture();let changed = false
  f.beforeRead = () => {
    if (changed) return
    changed = true;f.maintenance.maintenanceMode = 'normal';f.platformChange('revisions', false)
    f.maintenance.maintenanceMode = 'closed';f.platformChange('revisions', false)
  }
  const result = await run(f)
  assert.equal(result.category, 'continuity');assert.equal(f.published.length, 0)
})
const badHistories = [
  ['missing surface', h => { h.intervals.pop() }], ['duplicate surface', h => { h.intervals[1] = h.intervals[0] }],
  ['stale coverage', h => { h.intervals[0].throughTime-- }], ['wrong start', h => { h.intervals[0].fromTime++ }],
  ['wrong cursor', h => { h.intervals[0].throughSequence++ }], ['another run', h => { h.bindingDigest = hash('other') }],
  ['missing history', h => { h.complete = true;delete h.intervals }], ['event in interval', h => { h.intervals[0].events.push({ sequence: 1 }) }],
]
for (const [name, mutate] of badHistories) test(`${name} cannot stand in for complete history`, async () => {
  const f = makeMaintenanceFixture();f.mapHistory = h => { mutate(h);return h }
  assert.equal((await run(f)).category, 'continuity');assert.equal(f.calls.length, 0);assert.equal(f.published.length, 0)
})
test('history lost after revalidation blocks before publishing', async () => {
  const f = makeMaintenanceFixture();let histories = 0
  f.beforeHistory = () => { if (++histories === 2) f.historyAvailable = false }
  assert.equal((await run(f)).category, 'continuity');assert.ok(f.calls.length > 0);assert.equal(f.published.length, 0)
})
test('evidence change without notification or cursor advance fails immutable snapshot comparison', async () => {
  const f = makeMaintenanceFixture();f.beforeRead = () => { f.maintenance.credentials.evidenceDigest = hash('replacement') }
  assert.equal((await run(f)).category, 'continuity');assert.equal(f.published.length, 0)
})
test('loss during publishing leaves unconfirmed artifact and never reopens maintenance', async () => {
  const f = makeMaintenanceFixture(), publish = f.observedDependencies.publisher.publish
  f.observedDependencies.publisher.publish = async value => { const receipt = await publish(value);f.platformChange('rules');return receipt }
  const result = await run(f)
  assert.equal(result.status, 'aborted');assert.equal(result.publication, 'unconfirmed')
  assert.equal(f.published.length, 1);assert.equal(JSON.parse(f.published[0].contents).artifactAccepted, false)
  assert.equal(f.maintenance.maintenanceMode, 'closed');assert.equal(f.leaseHeld(), false)
})
test('post-publication history is checked through durable acknowledgement', async () => {
  const f = makeMaintenanceFixture();let histories = 0
  f.mapHistory = h => { if (++histories === 4) h.intervals[0].throughTime--;return h }
  const result = await run(f)
  assert.equal(result.status, 'aborted');assert.equal(result.publication, 'unconfirmed');assert.equal(f.published.length, 1)
})
test('change between final snapshot and history cannot hide behind the earlier cursor', async () => {
  const f = makeMaintenanceFixture();let histories = 0
  f.beforeHistory = () => { if (++histories === 4) f.platformChange('operators', false) }
  const result = await run(f)
  assert.equal(result.status, 'aborted');assert.equal(result.publication, 'unconfirmed')
  assert.equal(f.published.length, 1);assert.equal(f.leaseHeld(), false)
})
test('failed lease release cannot return completion', async () => {
  const f = makeMaintenanceFixture(), open = f.observedDependencies.collector.open
  f.observedDependencies.collector.open = async (...args) => ({ ...await open(...args), release() { return false } })
  const result = await run(f)
  assert.equal(result.status, 'aborted');assert.equal(result.publication, 'unconfirmed');assert.equal(result.category, 'continuity')
  assert.equal(f.leaseHeld(), true);assert.equal(f.published.length, 1)
})
test('overlapping runs refuse while the first lease spans publication, and used IDs cannot restart', async () => {
  const f = makeMaintenanceFixture(), gate = barrier(), entered = barrier(), publish = f.observedDependencies.publisher.publish
  f.observedDependencies.publisher.publish = async value => { entered.resolve();await gate.promise;return publish(value) }
  const first = run(f);await entered.promise
  const secondPlan = { ...f.plan, runId: 'different-run' }, secondExpected = { ...f.expectation, planDigest: hash(secondPlan) }
  const second = await runObservedMoneyScan(secondPlan, secondExpected, f.observedDependencies)
  assert.equal(second.category, 'continuity');assert.equal(f.leaseHeld(), true)
  gate.resolve();assert.equal((await first).status, 'complete');assert.equal(f.releaseCount, 1)
})
test('timeout while opening cancels admission and releases the late lease without reading data', async () => {
  const f = makeMaintenanceFixture(), gate = barrier(), opened = barrier(), released = barrier()
  f.afterRelease = released.resolve
  f.plan.expiresAt = f.now() + 25;f.rebind()
  f.beforeOpen = () => gate.promise
  const open = f.observedDependencies.collector.open
  let late
  f.observedDependencies.collector.open = (...args) => { late = open(...args);late.then(() => opened.resolve());return late }
  const result = await run(f)
  assert.equal(result.category, 'expired');assert.equal(result.publication, 'not-attempted')
  assert.equal(f.leaseHeld(), true)
  gate.resolve();await opened.promise;await late;await released.promise
  assert.equal(f.leaseHeld(), false);assert.equal(f.calls.length, 0);assert.equal(f.published.length, 0)
})
test('publication timeout retains the lease until already-started work settles', async () => {
  const f = makeMaintenanceFixture(), gate = barrier(), ended = barrier(), released = barrier(), publish = f.observedDependencies.publisher.publish
  f.afterRelease = released.resolve
  f.plan.expiresAt = f.now() + 25;f.rebind()
  f.observedDependencies.publisher.publish = async value => { await gate.promise;const receipt = await publish(value);ended.resolve();return receipt }
  const result = await run(f)
  assert.equal(result.category, 'expired');assert.equal(result.publication, 'unconfirmed');assert.equal(f.leaseHeld(), true)
  gate.resolve();await ended.promise;await released.promise
  assert.equal(f.leaseHeld(), false);assert.equal(f.published.length, 1);assert.equal(result.status, 'aborted')
})
test('collector diagnostics never appear in public result', async () => {
  const f = makeMaintenanceFixture();f.observedDependencies.collector.open = async () => { throw Error('FICTIONAL_PRIVATE_PLATFORM_DATA') }
  const result = await run(f)
  assert.equal(result.status, 'aborted');assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.equal(f.calls.length, 0)
})
test('advancing clocks permit the asynchronous entry handshake without exact-time equality', async () => {
  const f = makeMaintenanceFixture()
  f.observedDependencies.clock = () => { f.advance(1);return f.now() }
  assert.equal((await run(f)).status, 'complete');assert.equal(f.published.length, 1)
})
test('caller changes to plan and expectations cannot change the detached binding during reads', async () => {
  const f = makeMaintenanceFixture()
  f.beforeRead = () => { f.plan.runId = 'replacement';f.expectation.artifacts.rules = hash('replacement') }
  assert.equal((await run(f)).status, 'complete')
  assert.equal(f.published[0].runId, 'fictional-run')
})
test('unknown expectation keys and foreign bindings refuse before opening a collector', async () => {
  for (const mutate of [e => { e.force = true }, e => { e.planDigest = hash('other') }, e => { e.databaseId = 'other' },
    e => { e.writerInventory = [] }, e => { e.collectorId = 'other' }, e => { e.auditVersions.push(e.auditVersions[0]) }]) {
    const f = makeMaintenanceFixture();mutate(f.expectation)
    const result = await run(f)
    assert.equal(result.category, 'authorization');assert.equal(f.collectorCalls.length, 0);assert.equal(f.calls.length, 0)
  }
})

function assertAuthorizationRefusal(f, result) {
  assert.deepEqual(result, { status: 'aborted', category: 'authorization', publication: 'not-attempted',
    initializationAllowed: false, activationAllowed: false })
  assert.equal(f.collectorCalls.length, 0);assert.equal(f.calls.length, 0);assert.equal(f.published.length, 0)
  assert.equal(f.leaseHeld(), false)
}
const isAuthorizationAbort = error => error instanceof ScanAbort && error.category === 'authorization' &&
  error.message === 'Protected money scan aborted.'

test('identical prior and maintenance rules refuse contradictory canary evidence before collector access', async () => {
  const f = makeMaintenanceFixture()
  f.expectation.priorRulesDigest = f.expectation.artifacts.rules
  for (const probe of f.maintenance.canary.probes) probe.prior.rulesDigest = f.expectation.artifacts.rules
  assertAuthorizationRefusal(f, await run(f))
  assert.throws(() => createMaintenanceObserver(f.plan, f.expectation, f.observedDependencies), isAuthorizationAbort)
  assert.equal(f.collectorCalls.length, 0);assert.equal(f.calls.length, 0)
})
test('empty audit inventory with empty outcomes refuses before collector access', async () => {
  const f = makeMaintenanceFixture();f.expectation.auditVersions = [];f.maintenance.audit = []
  assertAuthorizationRefusal(f, await run(f))
})
test('direct observer rejects an empty audit inventory before opening a collector', () => {
  const f = makeMaintenanceFixture();f.expectation.auditVersions = []
  assert.throws(() => createMaintenanceObserver(f.plan, f.expectation, f.observedDependencies), isAuthorizationAbort)
  assert.equal(f.collectorCalls.length, 0);assert.equal(f.calls.length, 0)
})
for (const [name, dependencies] of [['null', null], ['undefined', undefined], ['primitive', 42], ['array', []]]) {
  test(`direct observer rejects ${name} dependencies with a bounded authorization error`, () => {
    const f = makeMaintenanceFixture()
    assert.throws(() => createMaintenanceObserver(f.plan, f.expectation, dependencies), isAuthorizationAbort)
    assert.equal(f.collectorCalls.length, 0);assert.equal(f.calls.length, 0)
  })
  test(`composed scan rejects ${name} dependencies before collector access`, async () => {
    const f = makeMaintenanceFixture()
    assertAuthorizationRefusal(f, await runObservedMoneyScan(f.plan, f.expectation, dependencies))
  })
}
for (const [name, change] of [
  ['null', d => { d.reader = null }], ['undefined', d => { delete d.reader }],
  ['empty', d => { d.reader = {} }], ['missing listPage', d => { delete d.reader.listPage }],
  ['missing get', d => { delete d.reader.get }], ['foreign kind', d => { d.reader.kind = 'other' }],
  ['foreign project', d => { d.reader.projectId = 'other' }], ['foreign database', d => { d.reader.databaseId = 'other' }],
]) test(`composed scan rejects ${name} reader before collector access`, async () => {
  const f = makeMaintenanceFixture();change(f.observedDependencies)
  assertAuthorizationRefusal(f, await run(f))
})
