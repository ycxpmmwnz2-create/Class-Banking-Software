import test from 'node:test'
import assert from 'node:assert/strict'
import { inventoryClassrooms, reportProviderClaims } from './reports.js'
import { qualificationStatus, refuseLiveQualification } from './capabilities.js'
import { createQualificationReader } from './reader.js'
import { DEMO_PROJECT as projectId, LIMITS, hash } from './common.js'

const now = Date.parse('2026-10-07T12:00:00.000Z')
const clone = value => JSON.parse(JSON.stringify(value))
const document = (path, data, n = 1) => ({ path, exists: data !== null, createVersion: data === null ? null : [100, 0],
  updateVersion: data === null ? null : [100 + n, 0], data: clone(data) })
function fixture(profile, initial = []) {
  const store = new Map(initial.map(doc => [doc.path, doc])), calls = []
  const reader = { kind: 'cutover-loopback-reader', profile, projectId, databaseId: '(default)',
    async listPage(path, token = '') {
      calls.push({ path, token })
      const all = [...store.values()].filter(doc => doc.path.startsWith(path + '/') && doc.path.split('/').length === path.split('/').length + 1)
        .sort((a, b) => a.path.localeCompare(b.path, 'en'))
      const start = Number(token || 0), docs = clone(all.slice(start, start + 25))
      if (path === 'classrooms') for (const doc of docs) if (doc.exists) doc.data = {}
      return { documents: docs, nextPageToken: start + 25 < all.length ? String(start + 25) : '' }
    },
    async get(path) { calls.push({ path }); return clone(store.get(path) ?? document(path, null)) },
  }
  return { store, calls, reader, run: (extra = {}) => (profile === 'inventory' ? inventoryClassrooms : reportProviderClaims)({ projectId, reader, clock: () => now, ...extra }) }
}
function classroom(n, mode) {
  const id = `room-${String(n).padStart(3, '0')}`, uid = `owner-${n}`, root = { ownerUid: uid }
  if (mode) root.accessControl = { schemaVersion: 1, mode, generation: 3, changedAt: '2026-10-01T12:00:00.000Z', auditId: 'prior' }
  return [document(`classrooms/${id}`, root), document(`teachers/${uid}`, { uid, classroomId: id, status: 'active' })]
}
function reservation(n, status = 'reserved', monthKey = '2026-10', schemaVersion = 4) {
  const scopeDigest = hash('scope'), requestIdDigest = hash(`request-${n}`), rateLimitLedgerId = hash(`${scopeDigest}\0${monthKey}`)
  const key = hash(`${rateLimitLedgerId}\0${requestIdDigest}`)
  const data = { schemaVersion, scopeDigest, requestIdDigest, rateLimitLedgerId, ledgerId: hash(`application\0${monthKey}`),
    monthKey, status, reservedAtMs: now - 100000 }
  if (schemaVersion === 4) data.controlGeneration = 1
  return document(`insightUsageReservations/${key}`, data)
}
function dispatch(parent, index, status = 'finished') {
  const p = parent.data
  return document(`${parent.path}/dispatches/${index}`, { schemaVersion: 1, reservationId: parent.path.split('/')[1],
    requestIdDigest: p.requestIdDigest, scopeDigest: p.scopeDigest, controlGeneration: p.controlGeneration,
    dispatchIndex: index, status, claimedAtMs: now - 90000 + index,
    finishedAtMs: status === 'finished' ? now - 80000 + index : null,
    outcome: status === 'finished' ? 'returned' : status === 'uncertain' ? 'failed' : null })
}
function unknown(result, category) {
  assert.equal(result.completion, 'UNKNOWN'); assert.equal(result.coverage, 'UNKNOWN'); assert.equal(result.counts, null)
  if (category) assert.equal(result.category, category)
  assert.equal(result.productionEligible, false)
}

test('live refusal precedes dependency access; all capability records remain unverified and immutable', async () => {
  for (const run of [inventoryClassrooms, reportProviderClaims]) {
    unknown(await run({ projectId: 'morgan-bank', get reader() { throw Error('PRIVATE DEPENDENCY') } }), 'live-unavailable')
  }
  assert.throws(() => createQualificationReader({ projectId: 'morgan-bank', profile: 'inventory' }), { category: 'live-unavailable' })
  assert.throws(() => refuseLiveQualification({ verified: true }), { category: 'live-unavailable' })
  const status = qualificationStatus({ verified: true })
  assert.equal(status.decision, 'NO-GO'); assert.ok(status.capabilities.every(row => row.status === 'UNVERIFIED'))
  assert.throws(() => { status.capabilities[0].status = 'SUPPORTED' }, TypeError)
})

test('inventory pages all classrooms, preserves mixed modes, rereads owners and performs no writes', async () => {
  const f = fixture('inventory', Array.from({ length: 26 }, (_, n) => classroom(n, [undefined, 'active', 'readOnly', 'suspended'][n % 4])).flat())
  const before = clone([...f.store]), result = await f.run()
  assert.equal(result.completion, 'COMPLETE'); assert.equal(result.counts.classrooms, 26)
  assert.equal(result.counts.absentControls, 7); assert.equal(result.snapshotConsistent, false)
  assert.ok(f.calls.filter(call => call.path === 'classrooms' && call.token === '25').length === 2)
  assert.deepEqual([...f.store], before); assert.ok(Object.isFrozen(result.rooms[0]))
})

test('empty/oversized scopes, phantom parents, duplicate owners, missing teachers and malformed controls fail without a prefix', async () => {
  const cases = [[], Array.from({ length: 101 }, (_, n) => classroom(n)).flat(),
    [document('classrooms/orphan', null)], [classroom(0), classroom(1)].flat(), classroom(0), classroom(0)]
  cases[3][2].data.ownerUid = 'owner-0'
  cases[4].pop()
  cases[5][0].data.accessControl = { mode: 'active' }
  for (const initial of cases) unknown(await fixture('inventory', initial).run())
})

test('inventory detects owner version drift and a new root during revalidation', async () => {
  for (const mode of ['owner', 'root']) {
    const f = fixture('inventory', classroom(0)), list = f.reader.listPage.bind(f.reader)
    let enumerations = 0
    f.reader.listPage = async (...args) => {
      if (++enumerations === 2) {
        if (mode === 'owner') f.store.get('teachers/owner-0').updateVersion = [555, 0]
        else f.store.set('classrooms/phantom', document('classrooms/phantom', null))
      }
      return list(...args)
    }
    unknown(await f.run(), 'drift')
  }
})

test('provider report includes old months, reserved/uncertain states, legacy records and orphan parents', async () => {
  const a = reservation(1, 'reserved', '2025-11'), b = reservation(2, 'uncertain'), c = reservation(3, 'completed', '2024-01', 3)
  const orphan = reservation(4), missing = document(orphan.path, null)
  const f = fixture('provider-claims', [a, dispatch(a, 1, 'claimed'), b, dispatch(b, 1, 'uncertain'), c, missing, dispatch(orphan, 1)])
  const before = clone([...f.store]), result = await f.run()
  assert.equal(result.coverage, 'COMPLETE'); assert.equal(result.recordState, 'UNKNOWN'); assert.equal(result.providerDrain, 'UNKNOWN')
  assert.equal(result.counts.reservations, 4); assert.equal(result.counts.claimed, 1); assert.equal(result.counts.uncertainDispatches, 1)
  assert.equal(result.counts.legacyWithoutDispatch, 1); assert.equal(result.counts.orphanParents, 1); assert.equal(result.counts.malformedRecords, 1)
  assert.deepEqual([...f.store], before)
})

test('finished records and empty inventory never certify provider drain or production readiness', async () => {
  const p = reservation(1, 'completed')
  for (const docs of [[], [p, dispatch(p, 1), dispatch(p, 2)]]) {
    const result = await fixture('provider-claims', docs).run()
    assert.equal(result.recordState, 'NO_UNRESOLVED_METADATA_OBSERVED'); assert.equal(result.providerDrain, 'UNKNOWN')
    assert.equal(result.activationAllowed, false); assert.equal(result.initializationAllowed, false)
  }
  const result = await fixture('provider-claims', [p]).run()
  assert.equal(result.counts.missingDispatchEvidence, 1); assert.equal(result.recordState, 'UNKNOWN')
})

test('unknown schema, wrong binding, sequence gaps, extra dispatch, unfinished predecessor and malformed state stay UNKNOWN', async () => {
  const cases = [
    (p, d) => { p.data.schemaVersion = 99; return [p, d] },
    (p, d) => { d.data.scopeDigest = hash('foreign'); return [p, d] },
    p => [p, dispatch(p, 2)],
    p => [p, ...[1, 2, 3, 4, 5].map(n => dispatch(p, n))],
    p => [p, dispatch(p, 1, 'claimed'), dispatch(p, 2)],
    (p, d) => { d.data.finishedAtMs = null; return [p, d] },
    (p, d) => { p.data.rateLimitLedgerId = hash('wrong'); return [p, d] },
  ]
  for (const build of cases) {
    const p = reservation(7), result = await fixture('provider-claims', build(p, dispatch(p, 1))).run()
    assert.equal(result.recordState, 'UNKNOWN'); assert.ok(result.counts.malformedRecords > 0)
  }
})

test('provider revalidation detects changed versions, new dispatch and parent disappearance', async () => {
  for (const mode of ['version', 'new', 'missing']) {
    const p = reservation(1), d = dispatch(p, 1), f = fixture('provider-claims', [p, d]), list = f.reader.listPage.bind(f.reader)
    let queries = 0
    f.reader.listPage = async (...args) => {
      if (++queries === 3) {
        if (mode === 'version') f.store.get(d.path).updateVersion = [888, 0]
        if (mode === 'new') { const second = dispatch(p, 2); f.store.set(second.path, second) }
        if (mode === 'missing') f.store.set(p.path, document(p.path, null))
      }
      return list(...args)
    }
    unknown(await f.run(), 'drift')
  }
})

test('pagination refuses duplicated/foreign/unsorted paths, repeated tokens and empty continuing pages', async () => {
  for (const build of [
    docs => ({ documents: [docs[0], docs[0]], nextPageToken: '' }),
    docs => ({ documents: [{ ...docs[0], path: 'foreign/other' }], nextPageToken: '' }),
    docs => ({ documents: docs.reverse(), nextPageToken: '' }),
    () => ({ documents: [], nextPageToken: 'more' }),
  ]) {
    const f = fixture('provider-claims', [reservation(1), reservation(2)]), list = f.reader.listPage.bind(f.reader)
    f.reader.listPage = async (...args) => build((await list(...args)).documents)
    unknown(await f.run())
  }
  const f = fixture('provider-claims'); let n = 0
  f.reader.listPage = async () => ({ documents: [document(`insightUsageReservations/${String(++n).padStart(64, '0')}`, null)], nextPageToken: 'same' })
  unknown(await f.run(), 'transport')
})

test('deadlines, clock rollback and read failures produce fixed errors without partial counts or raw diagnostics', async () => {
  for (const mode of ['deadline', 'rollback', 'failure']) {
    const f = fixture('inventory', classroom(0)); let tick = 0
    f.reader.listPage = async () => { tick = mode === 'deadline' ? LIMITS.durationMs + 1 : -1; if (mode === 'failure') throw Error('PRIVATE SDK VALUE'); return { documents: [], nextPageToken: '' } }
    const result = await f.run({ monotonic: () => tick })
    unknown(result); assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  }
})

test('metadata privacy rejects unexpected masked fields and never returns their values', async () => {
  const p = reservation(1); p.data.result = 'PRIVATE ANSWER SENTINEL'
  const result = await fixture('provider-claims', [p]).run()
  assert.equal(result.recordState, 'UNKNOWN'); assert.equal(result.counts.malformedRecords, 1)
  assert.ok(!JSON.stringify(result).includes('PRIVATE'))
})

test('inventory rejects foreign root tenant tag and tolerates harmless field ordering on reread', async () => {
  const f = fixture('inventory', classroom(0))
  f.store.get('classrooms/room-000').data.classroomId = 'foreign'
  unknown(await f.run(), 'foundation')
  delete f.store.get('classrooms/room-000').data.classroomId
  const get = f.reader.get.bind(f.reader); let calls = 0
  f.reader.get = async path => {
    const doc = await get(path)
    if (++calls > 2) doc.data = Object.fromEntries(Object.entries(doc.data).reverse())
    return doc
  }
  assert.equal((await f.run()).completion, 'COMPLETE')
})
