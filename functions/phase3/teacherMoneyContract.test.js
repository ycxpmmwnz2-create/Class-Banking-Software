import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyMoneyDelta, canonicalLedgerTuple, canonicalMoneyTargets, deriveMoneyLedgerIds,
  moneyCentsToStored, parseMoneyDecimal, requireMoneyCents, requirePositiveMoneyCents,
  storedMoneyToCents, TeacherMoneyContractError,
} from './teacherMoneyContract.js'

const context = Object.freeze({
  projectId: 'demo-integrity', classroomId: 'class-a', teacherUid: 'teacher-a',
  requestId: '00112233445566778899aabbccddeeff', protocolVersion: 1, action: 'award',
})
function rejects(fn, code) {
  assert.throws(fn, error => error instanceof TeacherMoneyContractError && error.code === code)
}

test('cent ceilings are inclusive; amount and balance signs are separate', () => {
  for (const value of [-100_000_000, -1, 0, 1, 100_000_000]) assert.equal(requireMoneyCents(value), value)
  assert.equal(requirePositiveMoneyCents(100_000_000), 100_000_000)
  for (const value of [-1, 0, 100_000_001]) rejects(() => requirePositiveMoneyCents(value), 'amount-out-of-domain')
  for (const value of [NaN, Infinity, -Infinity, '100', null, undefined, 1.01, 100_000_001, -100_000_001, Number.MAX_SAFE_INTEGER]) {
    rejects(() => requireMoneyCents(value), 'amount-out-of-domain')
  }
  assert.ok(Object.is(requireMoneyCents(-0), 0))
})

test('stored conversion tolerates binary representation, never substantive fractions', () => {
  for (const [value, cents] of [[1.10, 110], [-1.10, -110], [0.01, 1], [999999.99, 99999999], [-1000000, -100000000]]) {
    assert.equal(storedMoneyToCents(value), cents)
  }
  for (const value of [1.001, -1.001, 1000000.01, -1000000.01, NaN, '1.10', null, Infinity]) {
    rejects(() => storedMoneyToCents(value), 'amount-out-of-domain')
  }
  assert.equal(storedMoneyToCents(1 + 0.0000000005), 100)
  rejects(() => storedMoneyToCents(1 + 0.000000002), 'amount-out-of-domain')
})

test('stored dollar encoding round-trips cents throughout the domain without accumulation', () => {
  const cases = [-100000000, -99999999, -1, 0, 1, 99999999, 100000000]
  for (let value = -100000000; value <= 100000000; value += 7919) cases.push(value)
  for (const value of cases) assert.equal(storedMoneyToCents(moneyCentsToStored(value)), value)
})

test('decimal input is exact and rejects exponents, coercion, whitespace and rounding', () => {
  for (const [value, cents] of [['0', 0], ['-0.00', 0], ['1.1', 110], ['0.01', 1], ['-42.09', -4209], ['1000000.00', 100000000]]) {
    assert.equal(parseMoneyDecimal(value), cents)
  }
  for (const value of ['1.001', '1e2', '+1', '.5', '1.', '01', ' 1', '1 ', '', 'NaN', 1, null]) {
    rejects(() => parseMoneyDecimal(value), 'invalid-decimal')
  }
  for (const value of ['1000000.01', '-1000000.01', '9999999']) {
    rejects(() => parseMoneyDecimal(value), 'amount-out-of-domain')
  }
})

test('integer arithmetic permits teacher overdrafts but rejects excess effect or result', () => {
  assert.equal(applyMoneyDelta(1, -2), -1)
  assert.equal(applyMoneyDelta(-100000000, 100000000), 0)
  assert.equal(applyMoneyDelta(99999999, 1), 100000000)
  for (const args of [[100000000, 1], [-100000000, -1], [0, 100000001], [0.01, 1]]) {
    rejects(() => applyMoneyDelta(...args), 'amount-out-of-domain')
  }
})

test('target indexing is ascending numeric, deduplicated, bounded and immutable', () => {
  const input = [10, 2, 1, 2]
  const result = canonicalMoneyTargets(input)
  assert.deepEqual(result, [1, 2, 10])
  assert.deepEqual(input, [10, 2, 1, 2])
  assert.ok(Object.isFrozen(result))
  assert.equal(canonicalMoneyTargets(Array.from({ length: 100 }, (_, i) => i + 1)).length, 100)
  for (const value of [[], [0], [-1], [1.5], ['1'], [NaN], new Array(1), new Array(101).fill(1), null]) {
    rejects(() => canonicalMoneyTargets(value), 'invalid-targets')
  }
})

// Values independently generated with Python json.dumps(separators=(',', ':'),
// ensure_ascii=False), hashlib.sha256(UTF-8), int(hex[:13], 16)+1.
test('ASCII serialization and first-52-bit IDs match independent known vectors', () => {
  assert.equal(canonicalLedgerTuple(context, 0),
    '["morgan-bank/teacher-money-ledger",1,"demo-integrity","class-a","teacher-a","00112233445566778899aabbccddeeff","award",0]')
  assert.deepEqual(deriveMoneyLedgerIds(context, [9, 3]), [
    { targetId: 3, ledgerId: 984157413352987 },
    { targetId: 9, ledgerId: 1679713232233546 },
  ])
})

test('UTF-8 Unicode tuple is neither ASCII-escaped nor normalized before hashing', () => {
  const unicode = { ...context, classroomId: 'class-é', teacherUid: 'teacher-😀', action: 'createStudent' }
  assert.equal(canonicalLedgerTuple(unicode, 0),
    '["morgan-bank/teacher-money-ledger",1,"demo-integrity","class-é","teacher-😀","00112233445566778899aabbccddeeff","createStudent",0]')
  assert.equal(deriveMoneyLedgerIds(unicode, [1])[0].ledgerId, 4192428278527669)
  assert.notEqual(deriveMoneyLedgerIds({ ...unicode, classroomId: 'class-e\u0301' }, [1])[0].ledgerId, 4192428278527669)
})

test('retries and permuted target input repeat IDs; each namespace component matters', () => {
  const result = deriveMoneyLedgerIds(context, [3, 9])
  assert.deepEqual(deriveMoneyLedgerIds(context, [9, 3, 3]), result)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result[0]))
  for (const changes of [
    { projectId: 'demo-other' }, { classroomId: 'class-b' }, { teacherUid: 'teacher-b' },
    { requestId: '112233445566778899aabbccddeeff00' }, { action: 'deduct' },
  ]) assert.notEqual(deriveMoneyLedgerIds({ ...context, ...changes }, [3, 9])[0].ledgerId, result[0].ledgerId)
  for (const { ledgerId } of result) assert.ok(Number.isSafeInteger(ledgerId) && ledgerId >= 1 && ledgerId <= 2 ** 52)
})

test('ID namespace rejects unknown keys, noncanonical identities and implicit versions', () => {
  for (const changes of [
    { protocolVersion: 2 }, { protocolVersion: undefined }, { requestId: 'short' },
    { requestId: '00112233445566778899AABBCCDDEEFF' }, { action: 'unknown' },
    { classroomId: 'a/b' }, { teacherUid: '\ud800' }, { projectId: ' demo-integrity' },
    { timestamp: 123 }, { attempt: 2 }, { controlGeneration: 1 },
  ]) rejects(() => deriveMoneyLedgerIds({ ...context, ...changes }, [1]), 'invalid-ledger-context')
  for (const index of [-1, 100, 0.5, '0']) rejects(() => canonicalLedgerTuple(context, index), 'invalid-child-index')
  let evaluated = false
  const input = { ...context, get action() { evaluated = true; return 'award' } }
  rejects(() => canonicalLedgerTuple(input, 0), 'invalid-ledger-context')
  assert.equal(evaluated, false)
})
