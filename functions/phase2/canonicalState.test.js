import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hashCanonicalState,
  serializeCanonicalState,
} from './canonicalState.js'

test('serializes logically identical state with recursive stable key ordering', () => {
  const firstState = {
    z: 3,
    nested: {
      beta: 2,
      alpha: 1,
    },
    records: [
      { studentId: 'student-1', amount: 5 },
      { studentId: 'student-2', amount: 7 },
    ],
  }
  const secondState = {
    records: [
      { amount: 5, studentId: 'student-1' },
      { amount: 7, studentId: 'student-2' },
    ],
    nested: {
      alpha: 1,
      beta: 2,
    },
    z: 3,
  }

  const expected = '{"nested":{"alpha":1,"beta":2},' +
    '"records":[{"amount":5,"studentId":"student-1"},' +
    '{"amount":7,"studentId":"student-2"}],"z":3}'

  assert.equal(serializeCanonicalState(firstState), expected)
  assert.equal(serializeCanonicalState(secondState), expected)
  assert.equal(hashCanonicalState(firstState), hashCanonicalState(secondState))
})

test('preserves array order while ordering object keys inside arrays', () => {
  assert.equal(
    serializeCanonicalState([{ z: 1, a: 2 }, { b: 3, a: 4 }]),
    '[{"a":2,"z":1},{"a":4,"b":3}]',
  )
  assert.notEqual(
    hashCanonicalState(['first', 'second']),
    hashCanonicalState(['second', 'first']),
  )
})

test('returns a lowercase hexadecimal SHA-256 digest', () => {
  assert.equal(
    hashCanonicalState({ beta: 2, alpha: 1 }),
    '955c071f4fbee40a01b9bc6e8fb3627e81bda84811ae9c29fcc5812ba3a45162',
  )
})

test('rejects non-JSON values instead of silently omitting or coercing them', () => {
  assert.throws(
    () => serializeCanonicalState(undefined),
    /non-JSON value at \$/,
  )
  assert.throws(
    () => serializeCanonicalState({ omitted: undefined }),
    /non-JSON value at \$\["omitted"\]/,
  )
  assert.throws(
    () => serializeCanonicalState({ invalidNumber: Number.NaN }),
    /non-finite number/,
  )
  assert.throws(
    () => serializeCanonicalState([Number.POSITIVE_INFINITY]),
    /non-finite number/,
  )
})

test('rejects cyclic state with a clear error', () => {
  const cyclicState = {}
  cyclicState.self = cyclicState

  assert.throws(
    () => serializeCanonicalState(cyclicState),
    /contains a cycle at \$\["self"\]/,
  )
})
