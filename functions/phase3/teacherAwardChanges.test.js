import assert from 'node:assert/strict'
import test from 'node:test'
import { bindTeacherAwardIntent, buildTeacherAwardChanges } from './teacherAwardChanges.js'
import { TeacherMoneyContractError } from './teacherMoneyContract.js'

const identity = Object.freeze({ projectId: 'demo-integrity', classroomId: 'class-a', teacherUid: 'teacher-a' })
const serverTime = '2026-09-29T18:00:00.000Z'
const request = (extra = {}) => ({ protocolVersion: 1, controlGeneration: 7,
  requestId: '00112233445566778899aabbccddeeff', action: 'award', studentIds: [9, 3],
  amountCents: 110, reason: 'Homework', category: 'Homework', memo: 'Nice work', ...extra })
const student = (id, extra = {}) => ({ id, name: `Fictional student ${id}`,
  balance: 1.10, frozen: false, transactions: [], ...extra })
const history = (studentId, extra = {}) => ({ id: 77, date: '9/1/2026, 1:00:00 PM',
  studentId, studentName: 'Previous name', type: 'Add', amount: 2, reason: 'Homework',
  memo: '', category: 'Homework', status: 'Approved', source: 'Teacher', ...extra })
function inputs(raw = request(), extra = {}) {
  return { identity, students: [student(9), student(3)], serverTime,
    allowedReasons: ['Homework', "Teacher's Choice", 'Quick Cash', 'Classroom Expense'],
    candidateLedgerReads: bindTeacherAwardIntent(raw, identity).ledgerIds.map(({ ledgerId }) => ({ id: ledgerId, exists: false })),
    ...extra }
}
function rejects(fn, code) {
  assert.throws(fn, error => error instanceof TeacherMoneyContractError && error.code === code)
}

test('intent digest matches an independent Python UTF-8 JSON/SHA-256 vector', () => {
  const result = bindTeacherAwardIntent(request(), identity)
  assert.equal(result.digest, 'ec76047e15b7fd61d2dc4d9d5d8f329a3b64be8e62cf8f7bdba119fc406d9cde')
  assert.deepEqual(result.ledgerIds, [
    { targetId: 3, ledgerId: 984157413352987 },
    { targetId: 9, ledgerId: 1679713232233546 },
  ])
  assert.equal(bindTeacherAwardIntent(request({ studentIds: [3, 9, 3] }), identity).digest, result.digest)
})

test('digest binds every intent field and each server-owned identity component', () => {
  const original = bindTeacherAwardIntent(request(), identity)
  for (const change of [{ controlGeneration: 8 }, { requestId: '112233445566778899aabbccddeeff00' },
    { action: 'deduct' }, { studentIds: [3] }, { amountCents: 111 },
    { reason: "Teacher's Choice", category: "Teacher's Choice" }, { category: '' }, { memo: 'Other' }]) {
    assert.notEqual(bindTeacherAwardIntent(request(change), identity).digest, original.digest)
  }
  for (const change of [{ projectId: 'demo-other' }, { teacherUid: 'teacher-b' }, { classroomId: 'class-b' }]) {
    assert.notEqual(bindTeacherAwardIntent(request(), { ...identity, ...change }).digest, original.digest)
  }
  // Generation changes the intent, but not the already specified ledger namespace.
  assert.deepEqual(bindTeacherAwardIntent(request({ controlGeneration: 8 }), identity).ledgerIds, original.ledgerIds)
})

test('exact award/deduct envelope rejects authoritative client fields and unsupported actions', () => {
  for (const field of ['balance', 'ownerUid', 'studentName', 'date', 'status', 'source', 'ledger', 'allowOverdraft', 'allowedReasons']) {
    rejects(() => bindTeacherAwardIntent(request({ [field]: 'untrusted' }), identity), 'invalid-request')
  }
  for (const change of [{ protocolVersion: 2 }, { controlGeneration: 0 }, { action: 'approve' },
    { action: 'adjust' }, { action: 'reset' }, { action: 'createStudent' }]) {
    rejects(() => bindTeacherAwardIntent(request(change), identity), 'invalid-request')
  }
  const missing = request(); delete missing.memo
  rejects(() => bindTeacherAwardIntent(missing, identity), 'invalid-request')
  rejects(() => bindTeacherAwardIntent(request({ requestId: 'bad' }), identity), 'invalid-ledger-context')
  rejects(() => bindTeacherAwardIntent(request(), { ...identity, classroomId: '../other' }), 'invalid-ledger-context')
})

test('accessor and sparse inputs are rejected without evaluating getters', () => {
  let called = false
  const raw = request(); Object.defineProperty(raw, 'memo', { enumerable: true, get() { called = true; return '' } })
  rejects(() => bindTeacherAwardIntent(raw, identity), 'invalid-request')
  const ids = [3]; Object.defineProperty(ids, '0', { enumerable: true, get() { called = true; return 3 } })
  for (const studentIds of [ids, new Array(1), Object.assign([3], { extra: true })]) {
    rejects(() => bindTeacherAwardIntent(request({ studentIds }), identity), 'invalid-targets')
  }
  assert.equal(called, false)
})

test('cent limits and explicit target limits apply before calculating changes', () => {
  for (const amountCents of [0, -1, 1.1, '110', NaN, Infinity, 100_000_001]) {
    rejects(() => bindTeacherAwardIntent(request({ amountCents }), identity), 'amount-out-of-domain')
  }
  for (const studentIds of [[], [0], ['3'], [3.5], Array(101).fill(3)]) {
    rejects(() => bindTeacherAwardIntent(request({ studentIds }), identity), 'invalid-targets')
  }
  assert.equal(bindTeacherAwardIntent(request({ amountCents: 100_000_000 }), identity).intent.amountCents, 100_000_000)
})

test('bounded Unicode text preserves exact intent, rejects malformed scalars and reserved semantics', () => {
  const long = '😀'.repeat(500)
  assert.equal(bindTeacherAwardIntent(request({ memo: long }), identity).intent.memo, long)
  for (const change of [{ memo: long + 'a' }, { memo: '\ud800' }, { reason: ' ' },
    { reason: 'a'.repeat(121) }, { category: 'a'.repeat(121) }]) {
    rejects(() => bindTeacherAwardIntent(request(change), identity), 'invalid-text')
  }
  for (const value of ['Balance adjustment', 'Opening Balance', 'Operator correction', 'Opening balance', 'Compatibility correction']) {
    rejects(() => bindTeacherAwardIntent(request({ reason: value, category: value }), identity), 'invalid-category')
  }
  rejects(() => bindTeacherAwardIntent(request({ category: 'Rent' }), identity), 'invalid-category')
  assert.notEqual(bindTeacherAwardIntent(request({ memo: 'é' }), identity).digest,
    bindTeacherAwardIntent(request({ memo: 'e\u0301' }), identity).digest)
})

test('awards calculate current balances, canonical ledgers and matching mirrors without mutating input', () => {
  const raw = request(), context = inputs(raw)
  const before = globalThis.structuredClone(context)
  const result = buildTeacherAwardChanges(raw, context)
  assert.deepEqual(context, before)
  assert.deepEqual(raw.studentIds, [9, 3])
  assert.deepEqual(result.changes.map(row => row.student.id), [3, 9])
  for (const row of result.changes) {
    assert.equal(row.student.balance, 2.20)
    assert.deepEqual(row.ledger, { id: row.student.id === 3 ? 984157413352987 : 1679713232233546,
      date: serverTime, studentId: row.student.id, studentName: `Fictional student ${row.student.id}`,
      type: 'Add', amount: 1.10, reason: 'Homework', memo: 'Nice work', category: 'Homework', status: 'Approved', source: 'Teacher' })
    assert.deepEqual(row.student.transactions[0], row.ledger)
    assert.equal(row.studentPath, `classrooms/class-a/students/${row.student.id}`)
    assert.equal(row.ledgerPath, `classrooms/class-a/transactions/${row.ledger.id}`)
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.student) && Object.isFrozen(row.student.transactions) && Object.isFrozen(row.ledger))
  }
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.changes))
  assert.equal(result.mutationWriteCount, 4)
  assert.ok(result.estimatedMutationBytes > 0)
})

test('teacher deductions preserve overdrafts and teacher authority on frozen students', () => {
  const raw = request({ action: 'deduct', studentIds: [3], amountCents: 200 })
  const result = buildTeacherAwardChanges(raw, inputs(raw, { students: [student(3, { frozen: true })] }))
  assert.equal(result.changes[0].student.balance, -0.90)
  assert.equal(result.changes[0].student.frozen, true)
  assert.equal(result.changes[0].ledger.type, 'Subtract')
  assert.equal(result.changes[0].ledger.amount, 2)
})

test('whole action rejects an invalid later balance instead of returning a prefix', () => {
  for (const balance of [1.001, NaN, Infinity, '1.10', 1_000_000]) {
    const context = inputs(request(), { students: [student(3), student(9, { balance })] })
    const before = globalThis.structuredClone(context)
    rejects(() => buildTeacherAwardChanges(request(), context), 'amount-out-of-domain')
    assert.deepEqual(context, before)
  }
  const raw = request({ action: 'deduct', amountCents: 1, studentIds: [3] })
  rejects(() => buildTeacherAwardChanges(raw, inputs(raw, { students: [student(3, { balance: -1_000_000 })] })), 'amount-out-of-domain')
})

test('server-read targets must be complete and exact, with no silent subset or foreign target', () => {
  for (const students of [[student(3)], [student(3), student(10)]]) {
    rejects(() => buildTeacherAwardChanges(request(), inputs(request(), { students })), 'incomplete-inputs')
  }
  rejects(() => buildTeacherAwardChanges(request(), inputs(request(), { students: [student(3), student(3)] })), 'invalid-students')
  rejects(() => buildTeacherAwardChanges(request(), inputs(request(), { students: [student(3, { pin: 'fictional' }), student(9)] })), 'invalid-student')
})

test('all candidate ledgers need explicit absence; occupied, duplicate and substituted reads fail', () => {
  const raw = request(), context = inputs(raw)
  rejects(() => buildTeacherAwardChanges(raw, { ...context, candidateLedgerReads: [] }), 'incomplete-inputs')
  const occupied = globalThis.structuredClone(context.candidateLedgerReads); occupied[1].exists = true
  rejects(() => buildTeacherAwardChanges(raw, { ...context, candidateLedgerReads: occupied }), 'ledger-id-collision')
  const wrong = globalThis.structuredClone(context.candidateLedgerReads); wrong[1].id = 55
  rejects(() => buildTeacherAwardChanges(raw, { ...context, candidateLedgerReads: wrong }), 'incomplete-inputs')
  rejects(() => buildTeacherAwardChanges(raw, { ...context, candidateLedgerReads: [wrong[0], wrong[0]] }), 'invalid-ledger-reads')
})

test('orphan candidate IDs in any affected mirror collide even when its ledger is absent', () => {
  const raw = request(), context = inputs(raw)
  // Put student 3's candidate ID in student 9's mirror to catch cross-target checks.
  context.students[0].transactions = [history(9, { id: context.candidateLedgerReads[0].id })]
  rejects(() => buildTeacherAwardChanges(raw, context), 'ledger-id-collision')
})

test('historical names and legacy numeric amounts remain exact without freezing input', () => {
  const raw = request({ studentIds: [3] })
  const old = history(3, { amount: 1_000_000.001 })
  const result = buildTeacherAwardChanges(raw, inputs(raw, { students: [student(3, { transactions: [old] })] }))
  assert.deepEqual(result.changes[0].student.transactions[1], old)
  assert.notEqual(result.changes[0].student.transactions[1], old)
  assert.equal(Object.isFrozen(old), false)
  assert.equal(result.changes[0].ledger.studentName, 'Fictional student 3')
})

test('malformed, duplicate, foreign and sparse existing mirrors are rejected', () => {
  const raw = request({ studentIds: [3] })
  for (const transactions of [[history(9)], [history(3), history(3)], new Array(1),
    [history(3, { amount: Infinity })], [history(3, { status: 'Unknown' })]]) {
    rejects(() => buildTeacherAwardChanges(raw, inputs(raw, { students: [student(3, { transactions })] })), 'invalid-mirror')
  }
})

test('mirror count and byte ceilings both apply; neither permits trimming history', () => {
  const raw = request({ studentIds: [3] })
  const transactions = Array.from({ length: 999 }, (_, i) => history(3, { id: i + 1 }))
  const context = inputs(raw, { students: [student(3, { transactions })] })
  // The conservative byte budget can bind before the count ceiling. A 1000-entry
  // ceiling is not a guarantee that a 999-entry history can accept another entry.
  rejects(() => buildTeacherAwardChanges(raw, context), 'student-size-limit')
  transactions.push(history(3, { id: 1000 }))
  rejects(() => buildTeacherAwardChanges(raw, context), 'mirror-capacity')
  assert.equal(context.students[0].transactions.length, 1000)
})

test('server-approved reasons and strictly canonical server dates are required', () => {
  rejects(() => buildTeacherAwardChanges(request(), inputs(request(), { allowedReasons: ['Rent'] })), 'reason-not-allowed')
  for (const serverTime of ['2026-02-30T00:00:00.000Z', '2026-09-29', '2026-09-29T18:00:00Z',
    '+010000-01-01T00:00:00.000Z', 0, new Date(), 'private-path']) {
    rejects(() => buildTeacherAwardChanges(request(), inputs(request(), { serverTime })), 'invalid-clock')
  }
  const quick = request({ reason: 'Quick Cash', category: '', memo: '$1.10 quick button' })
  assert.equal(buildTeacherAwardChanges(quick, inputs(quick)).changes[0].ledger.category, '')
})

test('recalculation uses fresh balances but preserves intent and ledger mapping', () => {
  const raw = request(), first = buildTeacherAwardChanges(raw, inputs(raw))
  const second = buildTeacherAwardChanges(raw, inputs(raw, { students: [student(3, { balance: 5 }), student(9)] }))
  assert.equal(second.changes[0].student.balance, 6.10)
  assert.equal(first.digest, second.digest)
  assert.deepEqual(first.ledgerIds, second.ledgerIds)
  // This is recalculation, not replay; only the later receipt transaction can prevent reapplication.
})

test('oversize resulting documents and mutation subtotal refuse the complete action', () => {
  const raw = request({ studentIds: [3] })
  rejects(() => buildTeacherAwardChanges(raw, inputs(raw, { students: [student(3, { name: 'x'.repeat(500_000) })] })), 'student-size-limit')
  const many = request({ studentIds: Array.from({ length: 100 }, (_, i) => i + 1) })
  const students = many.studentIds.map(id => student(id, { transactions: [history(id, { memo: 'x'.repeat(50_000) })] }))
  rejects(() => buildTeacherAwardChanges(many, inputs(many, { students })), 'mutation-size-limit')
})
