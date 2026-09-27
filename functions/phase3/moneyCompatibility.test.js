import assert from 'node:assert/strict'
import test from 'node:test'
import { projectClassroomData } from '../../src/phase3/tenantDataProjection.js'
import { MONEY_COMPATIBILITY_DEMO_PROJECT as projectId, scanMoneyCompatibilityRehearsal,
  estimateMoneyDocumentBytes } from './moneyCompatibility.js'

const environment = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }
const clock = () => '2026-09-25T12:00:00.000Z'
const copy = value => globalThis.structuredClone(value)
const transaction = (id = 1, extra = {}) => ({ id, date: 'historical local date', studentId: 1, studentName: 'PRIVATE OLD NAME',
  type: 'Add', amount: 1.1, reason: 'Homework', memo: 'PRIVATE MEMO', category: 'Homework', status: 'Approved', source: 'Teacher', ...extra })
function fixture() {
  let tick = 10
  const store = new Map()
  const db = { projectId, databaseId: '(default)', store, reads: 0, queries: [],
    put(path, data) { store.set(path, { data: copy(data), version: { seconds: ++tick, nanoseconds: 3 } }) },
    snapshot(path) {
      const value = store.get(path)
      return { id: path.split('/').at(-1), ref: { path }, exists: !!value, updateTime: value?.version, data: () => copy(value?.data) }
    },
    doc(path) { return { path, async get() { db.reads++; db.beforeGet?.(path); return db.snapshot(path) } } },
    collection(path) {
      return { path, size: 25, cursor: '',
        orderBy(field) { assert.equal(field, '__name__'); return this },
        limit(size) { assert.equal(size, 25); this.size = size; return this },
        startAfter(doc) { this.cursor = doc.id; return this },
        async listDocuments() {
          db.reads++; db.beforeList?.(path)
          const prefix = path + '/', depth = path.split('/').length
          const ids = [...new Set([...store.keys()].filter(key => key.startsWith(prefix)).map(key => key.split('/')[depth]))]
          return ids.map(id => ({ id, path: `${path}/${id}` }))
        },
        async get() {
          db.reads++; db.queries.push(path); db.beforeQuery?.(path)
          const paths = [...store.keys()].filter(key => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1)
            .sort().filter(key => key.split('/').at(-1) > this.cursor).slice(0, this.size)
          const docs = paths.map(key => db.snapshot(key))
          return { docs: db.badPage ? [docs[0], docs[0]] : docs }
        },
      }
    },
    // A production write accidentally introduced in the scanner must fail.
    runTransaction() { assert.fail('scanner must not open a writing transaction') },
    batch() { assert.fail('scanner must not write') },
  }
  db.put('classrooms/room-a', { ownerUid: 'owner-a', settings: {}, privateField: 'PRIVATE ROOT' })
  db.put('teachers/owner-a', { uid: 'owner-a', status: 'active', classroomId: 'room-a', name: 'PRIVATE TEACHER' })
  setHistory(db, [transaction()])
  return db
}
function setHistory(db, entries, extra = {}) {
  for (const key of [...db.store.keys()]) if (key.startsWith('classrooms/room-a/transactions/')) db.store.delete(key)
  db.put('classrooms/room-a/students/1', { id: 1, name: 'PRIVATE NEW NAME', balance: 1.1, frozen: false, transactions: entries, ...extra })
  for (const entry of entries) db.put(`classrooms/room-a/transactions/${entry.id}`, entry)
}
const scan = (db, extra = {}) => scanMoneyCompatibilityRehearsal({ firestore: db, projectId, classroomIds: ['room-a'], environment, clock, ...extra })
const reasons = result => result.summary.reasonCounts
const rejects = code => error => error.category === code && error.message === 'Money compatibility scan is unavailable.'

test('hard demo, default database and declared host checks fail before any read', async () => {
  for (const extra of [{ projectId: 'morgan-bank' }, { projectId: undefined }, { environment: {} },
    { environment: { FIRESTORE_EMULATOR_HOST: 'other:8080' } }, { classroomIds: ['room-a', 'room-a'] },
    { classroomIds: [] }, { classroomIds: new Array(1) }, { classroomIds: ['bad/path'] }, { clock: () => 'bad' }]) {
    const db = fixture(); await assert.rejects(scan(db, extra)); assert.equal(db.reads, 0)
  }
  for (const field of ['projectId', 'databaseId']) {
    const db = fixture(); db[field] = 'different'; await assert.rejects(scan(db), rejects('rehearsal-only')); assert.equal(db.reads, 0)
  }
})

test('compatible scan preserves all bytes/versions and emits only counts/reasons publicly, restricted versions privately', async () => {
  const db = fixture(), before = copy([...db.store])
  const result = await scan(db)
  assert.equal(result.summary.blockerCount, 0)
  assert.equal(result.restrictedManifest.classrooms[0].compatibility, 'compatible-observed')
  assert.equal(result.restrictedManifest.productionEligible, false); assert.equal(result.restrictedManifest.activationAllowed, false)
  assert.equal(result.restrictedManifest.documents.length, 4)
  assert.deepEqual([...db.store], before)
  assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  assert.ok(!JSON.stringify(result.summary).includes('room-a'))
  assert.ok(Object.isFrozen(result.restrictedManifest.findings))
  assert.equal((await scan(db)).restrictedManifest.digest, result.restrictedManifest.digest)
  assert.notEqual((await scan(db, { clock: () => '2026-09-25T13:00:00.000Z' })).restrictedManifest.digest, result.restrictedManifest.digest)
  assert.throws(() => { result.restrictedManifest.documents[0].updateVersion[0]++ }, TypeError)
})

test('balance numeric domain accepts exact boundaries and floating representation, refuses substantive fractions without rewriting', async () => {
  for (const balance of [0, -1.1, 1.1, -1000000, 1000000, 1 + 0.0000000005]) {
    const db = fixture(); setHistory(db, [], { balance }); assert.equal((await scan(db)).summary.blockerCount, 0)
  }
  for (const balance of [1.001, -1.001, 1000000.01, -1000000.01, NaN, Infinity, '1.1', null]) {
    const db = fixture(); setHistory(db, [], { balance }); const before = copy([...db.store])
    assert.equal(reasons(await scan(db))['balance-out-of-domain'], 1); assert.deepEqual([...db.store], before)
  }
})

test('Pending fractions or excessive amounts block; finite positive Approved/Denied history stays legacy-only including mirror', async () => {
  for (const amount of [1.001, 1000000.01, 0.001]) {
    for (const status of ['Pending', 'Approved', 'Denied']) {
      const db = fixture(); setHistory(db, [transaction(1, { amount, status })])
      const result = await scan(db)
      assert.equal(result.summary.blockerCount, status === 'Pending' ? 2 : 0)
      assert.equal(result.summary.legacyOnlyCount, status === 'Pending' ? 0 : 2)
      assert.equal(result.summary.pendingCount, status === 'Pending' ? 1 : 0)
    }
  }
  for (const amount of [0, -1, NaN, Infinity, '1']) {
    const db = fixture(); setHistory(db, [transaction(1, { amount })])
    assert.ok(reasons(await scan(db))['ledger-shape-or-id']); assert.ok(reasons(await scan(db))['mirror-shape-or-owner'])
  }
})

test('full exact mirror parity, IDs, duplicates and ownership are checked, not current student name', async () => {
  const mutations = [
    db => db.store.delete('classrooms/room-a/transactions/1'),
    db => db.put('classrooms/room-a/transactions/1', transaction(1, { amount: 9 })),
    db => db.put('classrooms/room-a/transactions/2', transaction(2)),
    db => setHistory(db, [transaction(), transaction()]),
    db => setHistory(db, [transaction(1, { studentId: 2 })]),
    db => db.put('classrooms/room-a/transactions/01', transaction()),
    db => db.put('classrooms/room-a/students/1', { id: 2, name: 'X', balance: 0, frozen: false, transactions: [] }),
    db => setHistory(db, [transaction(1, { unexpected: 'secret' })]),
  ]
  for (const mutate of mutations) { const db = fixture(); mutate(db); assert.ok((await scan(db)).summary.blockerCount > 0) }
  assert.equal((await scan(fixture())).summary.blockerCount, 0, 'historical name may differ from current name')
})

test('removed-student Approved/Denied ledger remains history, but orphan Pending blocks', async () => {
  for (const status of ['Approved', 'Denied', 'Pending']) {
    const db = fixture(); setHistory(db, [transaction(1, { status })]); db.store.delete('classrooms/room-a/students/1')
    const result = await scan(db)
    assert.equal(result.summary.blockerCount, status === 'Pending' ? 1 : 0)
    assert.equal(reasons(result)[status === 'Pending' ? 'pending-student-absent' : 'historical-student-absent'], 1)
  }
})

test('reserved new source/category semantics and configurable category collisions block, existing Teacher adjustments survive', async () => {
  for (const entry of [transaction(1, { source: 'Opening Balance' }), transaction(1, { source: 'Operator correction' }),
    transaction(1, { source: 'Student', category: 'Balance adjustment' })]) {
    const db = fixture(); setHistory(db, [entry]); assert.equal(reasons(await scan(db))['reserved-source-category'], 2)
  }
  const db = fixture(); setHistory(db, [transaction(1, { category: 'Balance adjustment' })]); assert.equal((await scan(db)).summary.blockerCount, 0)
  db.put('classrooms/room-a', { ownerUid: 'owner-a', settings: { addMoneyCategories: ['Balance adjustment'] } })
  assert.equal(reasons(await scan(db))['reserved-category-setting'], 1)
})

test('mirror headroom has inclusive 100-slot boundary; 80 percent gives migration warning; oversized history is never truncated', async () => {
  for (const count of [799, 800, 900, 901, 1001]) {
    const db = fixture(); setHistory(db, Array.from({ length: count }, (_, n) => transaction(n + 1, { memo: '', studentName: 'x', date: 'x', reason: '', category: '', source: 'Teacher' })))
    const result = await scan(db), capacity = result.restrictedManifest.capacities[0]
    assert.equal(capacity.mirrorSlotsRemaining, 1000 - count)
    assert.equal(!!reasons(result)['mirror-slot-headroom'], count > 900)
    assert.equal(!!reasons(result)['history-migration-slot-threshold'], count >= 800)
    assert.equal(db.store.get('classrooms/room-a/students/1').data.transactions.length, count)
  }
})

test('conservative byte headroom uses UTF8 and 100KiB boundary neighbors, encoding hazards fail', async () => {
  const path = 'classrooms/room-a/students/1'
  const db = fixture(); setHistory(db, [], { name: 'x' })
  const student = copy(db.store.get(path).data)
  const base = estimateMoneyDocumentBytes(path, student)
  const target = 800 * 1024 - 1 // Fixed boolean overhead makes these estimates odd.
  assert.equal((target - base) % 2, 0)
  student.name += 'x'.repeat((target - base) / 2)
  assert.equal(estimateMoneyDocumentBytes(path, student), target)
  db.put(path, student); assert.equal(!!reasons(await scan(db))['student-byte-headroom'], false)
  student.name += 'x'; db.put(path, student); assert.equal(reasons(await scan(db))['student-byte-headroom'], 1)
  assert.ok(estimateMoneyDocumentBytes(path, { x: '💰' }) > estimateMoneyDocumentBytes(path, { x: 'a' }))
  const cycle = {}; cycle.self = cycle
  for (const value of [cycle, new Date(), { get x() { return assert.fail('getter invoked') } }, [undefined], new Array(1)]) {
    assert.throws(() => estimateMoneyDocumentBytes(path, value), rejects('unsupported-encoding'))
  }
})

test('all collections paginate to completion and empty roster/ledger are explicit, large roster needs batches', async () => {
  const db = fixture()
  for (let n = 2; n <= 101; n++) db.put(`classrooms/room-a/students/${n}`, { id: n, name: 'Fictional', balance: 0, frozen: false, transactions: [] })
  const result = await scan(db)
  assert.equal(result.summary.studentCount, 101); assert.equal(reasons(result)['roster-requires-explicit-batches'], 1)
  assert.equal(db.queries.filter(path => path.endsWith('/students')).length, 10)
  const empty = fixture(); empty.store.delete('classrooms/room-a/students/1'); empty.store.delete('classrooms/room-a/transactions/1')
  assert.equal((await scan(empty)).summary.studentCount, 0)
})

test('complete explicit project scope, reciprocal foundation and phantom roots/students/ledger fail whole scan', async () => {
  for (const mutate of [db => db.store.delete('classrooms/room-a'), db => db.store.delete('teachers/owner-a'),
    db => db.put('teachers/owner-a', { uid: 'owner-a', classroomId: 'foreign', status: 'active' }),
    db => db.put('classrooms/room-b', { ownerUid: 'owner-a' }),
    db => db.put('classrooms/room-a/students/99/children/x', { x: true }),
    db => db.put('classrooms/room-a/transactions/99/children/x', { x: true }),
    db => { db.badPage = true }]) {
    const db = fixture(); mutate(db); await assert.rejects(scan(db))
  }
  await assert.rejects(scan(fixture(), { classroomIds: ['foreign'] }), rejects('scope-mismatch'))
})

test('document changes including value restoration and namespace changes invalidate instead of returning partial report', async () => {
  for (const target of ['classrooms/room-a', 'classrooms/room-a/students/1', 'classrooms/room-a/transactions/1']) {
    const db = fixture(); let calls = 0
    db.beforeQuery = path => {
      if (path === target.split('/').slice(0, -1).join('/') && ++calls === 2) {
        const old = copy(db.store.get(target).data); db.put(target, { ...old, changed: true }); db.put(target, old)
      }
    }
    await assert.rejects(scan(db), rejects('changed-since-scan'))
  }
  const owner = fixture(); let reads = 0
  owner.beforeGet = path => { if (++reads === 2) owner.put(path, owner.store.get(path).data) }
  await assert.rejects(scan(owner), rejects('changed-since-scan'))
  const newDoc = fixture(); let lists = 0
  newDoc.beforeList = path => { if (path.endsWith('/students') && ++lists === 3) newDoc.put(path + '/2', { id: 2 }) }
  await assert.rejects(scan(newDoc))
})

test('SDK and getter failures never leak raw records or error causes', async () => {
  const db = fixture(); db.beforeQuery = () => { throw new Error('PRIVATE SDK PATH credential') }
  await assert.rejects(scan(db), error => rejects('scan-failed')(error) && !String(error.stack).includes('PRIVATE'))
  const db2 = fixture(); Object.defineProperty(db2, 'projectId', { get() { throw new Error('PRIVATE') } })
  await assert.rejects(scan(db2), rejects('scan-failed')); assert.equal(db2.reads, 0)
})

test('matching numeric IDs in separate classrooms never cross-match mirrors or ledger rows', async () => {
  const db = fixture()
  db.put('classrooms/room-b', { ownerUid: 'owner-b', settings: {} })
  db.put('teachers/owner-b', { uid: 'owner-b', classroomId: 'room-b', status: 'active' })
  db.put('classrooms/room-b/students/1', { id: 1, name: 'Other fictional', balance: 2, frozen: false, transactions: [transaction(1, { amount: 2 })] })
  db.put('classrooms/room-b/transactions/1', transaction(1, { amount: 2 }))
  let result = await scan(db, { classroomIds: ['room-b', 'room-a'], mode: 'final', activationAllowed: true })
  assert.equal(result.summary.classroomCount, 2); assert.equal(result.summary.blockerCount, 0)
  assert.equal(result.restrictedManifest.activationAllowed, false)
  assert.match(result.restrictedManifest.kind, /advisory/)
  db.store.delete('classrooms/room-b/transactions/1')
  result = await scan(db, { classroomIds: ['room-a', 'room-b'] })
  assert.equal(result.summary.blockedClassroomCount, 1)
  assert.equal(result.restrictedManifest.findings.find(row => row.reason === 'mirror-ledger-mismatch').path, 'classrooms/room-b/students/1')
})

test('resource cap and invalid snapshot versions abort with no prefix result', async () => {
  const db = fixture()
  db.store.get('classrooms/room-a/students/1').version.nanoseconds = 1e9
  await assert.rejects(scan(db), rejects('invalid-version'))
  const huge = fixture()
  for (let n = 2; n <= 20000; n++) huge.put(`classrooms/room-a/students/${n}`, { id: n })
  await assert.rejects(scan(huge), rejects('scan-limit'))
})


function projectFixture(db) {
  return projectClassroomData({ classroomId: 'room-a', root: db.store.get('classrooms/room-a').data,
    students: [...db.store].filter(([path]) => /^classrooms\/room-a\/students\/[^/]+$/.test(path)).map(([, row]) => row.data),
    transactions: [...db.store].filter(([path]) => /^classrooms\/room-a\/transactions\/[^/]+$/.test(path)).map(([, row]) => row.data),
    loginHistory: [] })
}

test('projection-compatible required text rejects empty and whitespace-only ledger and mirror fields', async () => {
  for (const field of ['date', 'studentName', 'source']) {
    for (const value of ['', ' ', '\t\n', '\u00a0']) {
      const db = fixture(); setHistory(db, [transaction(1, { [field]: value })])
      const before = copy([...db.store])
      assert.throws(() => projectFixture(db), error => error.category === 'shape')
      const result = await scan(db)
      assert.equal(reasons(result)['ledger-shape-or-id'], 1, field)
      assert.equal(reasons(result)['mirror-shape-or-owner'], 1, field)
      assert.equal(result.summary.blockedClassroomCount, 1)
      assert.deepEqual([...db.store], before)
    }
  }
  const db = fixture(); setHistory(db, [transaction(1, { date: ' historical date ', studentName: ' Former name ', source: ' Teacher ', reason: '', category: '', memo: '' })])
  assert.doesNotThrow(() => projectFixture(db))
  const before = copy([...db.store]); assert.equal((await scan(db)).summary.blockerCount, 0)
  assert.deepEqual([...db.store], before, 'check nonblank without trimming stored values')
})

test('projection-compatible student names reject empty and whitespace-only text', async () => {
  for (const name of ['', ' ', '\t\n', '\u00a0']) {
    const db = fixture(); setHistory(db, [], { name })
    assert.throws(() => projectFixture(db), error => error.category === 'shape')
    assert.equal(reasons(await scan(db))['student-shape-or-id'], 1)
  }
  const db = fixture(); setHistory(db, [], { name: ' Fictional name ' })
  assert.doesNotThrow(() => projectFixture(db)); assert.equal((await scan(db)).summary.blockerCount, 0)
})

test('projection-compatible settings reject non-map containers while absent or null defaults remain valid', async () => {
  for (const settings of ['x', '', 1, 0, true, false, [], ['Homework']]) {
    const db = fixture(); db.put('classrooms/room-a', { ownerUid: 'owner-a', settings })
    assert.throws(() => projectFixture(db), error => error.category === 'shape')
    const result = await scan(db)
    assert.equal(reasons(result)['category-settings-shape'], 1)
    assert.equal(result.summary.blockedClassroomCount, 1)
  }
  for (const settings of [undefined, null, {}, { addMoneyCategories: ['Homework'] }]) {
    const db = fixture(); db.put('classrooms/room-a', { ownerUid: 'owner-a', ...(settings === undefined ? {} : { settings }) })
    assert.doesNotThrow(() => projectFixture(db)); assert.equal((await scan(db)).summary.blockerCount, 0)
  }
})
