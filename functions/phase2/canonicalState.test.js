import assert from 'node:assert/strict'
import test from 'node:test'
import { GeoPoint, Timestamp } from 'firebase-admin/firestore'

import {
  decodeCanonicalFirestoreValue,
  encodeCanonicalFirestoreValue,
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

test('encodes and exactly reconstructs Firestore Timestamps', () => {
  const timestamps = [
    new Timestamp(0, 0),
    new Timestamp(-1, 0),
    new Timestamp(-62135596800, 999999999),
    new Timestamp(253402300799, 999999999),
  ]
  const encoded = encodeCanonicalFirestoreValue(timestamps)
  const persisted = serializeCanonicalState(encoded)
  const decoded = decodeCanonicalFirestoreValue(JSON.parse(persisted))

  assert.deepEqual(encoded, {
    $phase2aFirestoreValue: {
      version: 1,
      type: 'array',
      values: timestamps.map(timestamp => ({
        $phase2aFirestoreValue: {
          version: 1,
          type: 'timestamp',
          seconds: timestamp.seconds,
          nanoseconds: timestamp.nanoseconds,
        },
      })),
    },
  })
  assert.equal(decoded.length, timestamps.length)

  for (let index = 0; index < timestamps.length; index += 1) {
    assert.equal(decoded[index] instanceof Timestamp, true)
    assert.equal(decoded[index].isEqual(timestamps[index]), true)
  }
})

test('recursively wraps containers so tag-like map fields cannot collide', () => {
  const tagLikeMap = {
    $phase2aFirestoreValue: {
      version: 1,
      type: 'timestamp',
      seconds: -1,
      nanoseconds: 999999999,
    },
    type: 'map',
    version: 'ordinary-user-field',
    seconds: 3,
    nanoseconds: 4,
    nested: [new Timestamp(12, 345678901)],
  }
  Object.defineProperty(tagLikeMap, '__proto__', {
    value: { retained: true },
    enumerable: true,
    writable: true,
    configurable: true,
  })

  const encoded = encodeCanonicalFirestoreValue(tagLikeMap)
  const payload = encoded.$phase2aFirestoreValue
  const decoded = decodeCanonicalFirestoreValue(
    JSON.parse(serializeCanonicalState(encoded)),
  )

  assert.equal(payload.type, 'map')
  assert.deepEqual(
    payload.entries.map(([key]) => key),
    [
      '$phase2aFirestoreValue',
      '__proto__',
      'nanoseconds',
      'nested',
      'seconds',
      'type',
      'version',
    ],
  )
  assert.deepEqual(decoded.$phase2aFirestoreValue, {
    version: 1,
    type: 'timestamp',
    seconds: -1,
    nanoseconds: 999999999,
  })
  assert.deepEqual(decoded.__proto__, { retained: true })
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype)
  assert.equal(decoded.nested[0].isEqual(tagLikeMap.nested[0]), true)
})

test('decoder rejects malformed, unknown, colliding, and imprecise wrappers', () => {
  const wrapper = payload => ({ $phase2aFirestoreValue: payload })

  for (const malformed of [
    wrapper({
      version: 2,
      type: 'timestamp',
      seconds: 0,
      nanoseconds: 0,
    }),
    wrapper({ version: 1, type: 'unknown' }),
    wrapper({
      version: 1,
      type: 'timestamp',
      seconds: -0,
      nanoseconds: 0,
    }),
    wrapper({
      version: 1,
      type: 'timestamp',
      seconds: 0,
      nanoseconds: -0,
    }),
    wrapper({
      version: 1,
      type: 'timestamp',
      seconds: 0,
      nanoseconds: 1000000000,
    }),
    wrapper({
      version: 1,
      type: 'timestamp',
      seconds: 253402300800,
      nanoseconds: 0,
    }),
    wrapper({
      version: 1,
      type: 'timestamp',
      seconds: 0,
      nanoseconds: 0,
      extra: true,
    }),
    wrapper({
      version: 1,
      type: 'map',
      entries: [['z', 1], ['a', 2]],
    }),
    wrapper({
      version: 1,
      type: 'map',
      entries: [['same', 1], ['same', 2]],
    }),
    wrapper({
      version: 1,
      type: 'array',
      values: new Array(1),
    }),
  ]) {
    assert.throws(
      () => decodeCanonicalFirestoreValue(malformed),
      /Canonical Firestore value/,
    )
  }

  assert.throws(
    () => decodeCanonicalFirestoreValue({ ordinary: 'raw map' }),
    /unexpected object shape/,
  )
  assert.throws(
    () => decodeCanonicalFirestoreValue([]),
    /malformed object/,
  )
})

test('Firestore encoder rejects unsupported values without implicit coercion', () => {
  class UnsupportedValue {
    toJSON() {
      return { silently: 'coerced' }
    }
  }

  const cyclic = {}
  cyclic.self = cyclic
  const accessor = {}
  Object.defineProperty(accessor, 'secret', {
    get() {
      return 'not-called'
    },
    enumerable: true,
  })
  const symbolKey = { [Symbol('hidden')]: true }
  const sparse = new Array(1)
  const extendedArray = [1]
  extendedArray.extra = true

  for (const unsupported of [
    undefined,
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    new Timestamp(-0, 0),
    new Timestamp(0, -0),
    new GeoPoint(40, -111),
    new Date(),
    new UnsupportedValue(),
    cyclic,
    accessor,
    symbolKey,
    sparse,
    extendedArray,
  ]) {
    assert.throws(
      () => encodeCanonicalFirestoreValue(unsupported),
      /Canonical Firestore value/,
    )
  }
})

test('existing JSON-only canonical functions still reject raw Timestamp values', () => {
  const timestamp = new Timestamp(123, 456789123)

  assert.throws(
    () => serializeCanonicalState(timestamp),
    /non-JSON object at \$/,
  )
  assert.throws(
    () => hashCanonicalState({ timestamp }),
    /non-JSON object at \$\["timestamp"\]/,
  )
})
