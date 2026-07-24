import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOCUMENT_ID_REJECTION_CATEGORIES,
  MAX_FIRESTORE_DOCUMENT_ID_UTF8_BYTES,
  normalizeFirestoreDocumentId,
  validateFirestoreDocumentIds,
} from './firestoreDocumentId.js'

test('normalizes finite numbers and preserves already-canonical strings', () => {
  const composed = '\u00E9'
  const decomposed = 'e\u0301'
  const result = validateFirestoreDocumentIds([
    42,
    -12.5,
    0,
    'student 1',
    '\u03B1-student',
    composed,
    decomposed,
    '\u{1F600}',
  ])

  assert.deepEqual(result, {
    valid: true,
    normalizedValues: [
      '42',
      '-12.5',
      '0',
      'student 1',
      '\u03B1-student',
      composed,
      decomposed,
      '\u{1F600}',
    ],
    rejections: [],
  })
  assert.notEqual(composed, decomposed)
})

test('rejects unsupported values with original value, type, and source index', () => {
  const cases = [
    { value: {}, category: DOCUMENT_ID_REJECTION_CATEGORIES.OBJECT_VALUE,
      type: 'object' },
    { value: [], category: DOCUMENT_ID_REJECTION_CATEGORIES.ARRAY_VALUE,
      type: 'array' },
    { value: true, category: DOCUMENT_ID_REJECTION_CATEGORIES.BOOLEAN_VALUE,
      type: 'boolean' },
    { value: null, category: DOCUMENT_ID_REJECTION_CATEGORIES.NULL_VALUE,
      type: 'null' },
    { value: undefined,
      category: DOCUMENT_ID_REJECTION_CATEGORIES.UNDEFINED_VALUE,
      type: 'undefined' },
    { value: 1n, category: DOCUMENT_ID_REJECTION_CATEGORIES.UNSUPPORTED_TYPE,
      type: 'bigint' },
  ]

  for (const [sourceIndex, entry] of cases.entries()) {
    const result = normalizeFirestoreDocumentId(entry.value, sourceIndex)

    assert.equal(result.valid, false)
    assert.deepEqual(result.rejection, {
      category: entry.category,
      sourceIndex,
      originalValue: entry.value,
      originalType: entry.type,
    })
    assert.equal('normalizedValue' in result.rejection, false)
  }
})

test('rejects every non-finite number and reports its possible normalization', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const result = normalizeFirestoreDocumentId(value, 8)
    const normalizedValue = String(value)

    assert.equal(result.valid, false)
    assert.equal(result.normalizedValue, normalizedValue)
    assert.deepEqual(result.rejection, {
      category: DOCUMENT_ID_REJECTION_CATEGORIES.NON_FINITE_NUMBER,
      sourceIndex: 8,
      originalValue: value,
      originalType: 'number',
      normalizedValue,
    })
  }
})

test('rejects noncanonical and Firestore-forbidden strings as-is', () => {
  const cases = [
    ['', DOCUMENT_ID_REJECTION_CATEGORIES.EMPTY_STRING],
    [' \t\n', DOCUMENT_ID_REJECTION_CATEGORIES.WHITESPACE_ONLY_STRING],
    [' student', DOCUMENT_ID_REJECTION_CATEGORIES.SURROUNDING_WHITESPACE],
    ['student ', DOCUMENT_ID_REJECTION_CATEGORIES.SURROUNDING_WHITESPACE],
    ['students/one', DOCUMENT_ID_REJECTION_CATEGORIES.CONTAINS_SLASH],
    ['.', DOCUMENT_ID_REJECTION_CATEGORIES.DOT_SEGMENT],
    ['..', DOCUMENT_ID_REJECTION_CATEGORIES.DOT_SEGMENT],
    ['__reserved__', DOCUMENT_ID_REJECTION_CATEGORIES.RESERVED_PATTERN],
    ['____', DOCUMENT_ID_REJECTION_CATEGORIES.RESERVED_PATTERN],
    ['__line\nbreak__', DOCUMENT_ID_REJECTION_CATEGORIES.RESERVED_PATTERN],
  ]

  for (const [sourceIndex, [value, category]] of cases.entries()) {
    const result = normalizeFirestoreDocumentId(value, sourceIndex)

    assert.equal(result.valid, false)
    assert.equal(result.normalizedValue, value)
    assert.deepEqual(result.rejection, {
      category,
      sourceIndex,
      originalValue: value,
      originalType: 'string',
      normalizedValue: value,
    })
  }
})

test('rejects every form of unpaired surrogate but accepts valid pairs', () => {
  const invalidValues = [
    '\uD800',
    'before\uD800',
    '\uDC00',
    '\uD800\uD800',
    '\uDC00\uD800',
    '\uD83D\uDE00\uDC00',
  ]

  for (const [sourceIndex, value] of invalidValues.entries()) {
    const result = normalizeFirestoreDocumentId(value, sourceIndex)

    assert.equal(result.valid, false)
    assert.deepEqual(result.rejection, {
      category: DOCUMENT_ID_REJECTION_CATEGORIES.INVALID_UNICODE,
      sourceIndex,
      originalValue: value,
      originalType: 'string',
      normalizedValue: value,
    })
  }

  assert.deepEqual(normalizeFirestoreDocumentId('\uD83D\uDE00', 12), {
    valid: true,
    normalizedValue: '\u{1F600}',
  })
})

test('enforces the 1,500-byte UTF-8 boundary rather than code-unit length', () => {
  const exactlyAsciiLimit = 'a'.repeat(MAX_FIRESTORE_DOCUMENT_ID_UTF8_BYTES)
  const beyondAsciiLimit = `${exactlyAsciiLimit}a`
  const exactlyTwoByteLimit = '\u00E9'.repeat(750)
  const beyondTwoByteLimit = '\u00E9'.repeat(751)
  const exactlyFourByteLimit = '\u{1F600}'.repeat(375)
  const beyondFourByteLimit = '\u{1F600}'.repeat(376)

  for (const value of [
    exactlyAsciiLimit,
    exactlyTwoByteLimit,
    exactlyFourByteLimit,
  ]) {
    assert.deepEqual(normalizeFirestoreDocumentId(value), {
      valid: true,
      normalizedValue: value,
    })
  }

  for (const value of [
    beyondAsciiLimit,
    beyondTwoByteLimit,
    beyondFourByteLimit,
  ]) {
    const result = normalizeFirestoreDocumentId(value, 3)

    assert.equal(result.valid, false)
    assert.equal(result.rejection.category,
      DOCUMENT_ID_REJECTION_CATEGORIES.UTF8_BYTE_LIMIT_EXCEEDED)
    assert.equal(result.rejection.sourceIndex, 3)
    assert.equal(result.rejection.originalValue, value)
    assert.equal(result.rejection.originalType, 'string')
    assert.equal(result.rejection.normalizedValue, value)
  }
})

test('rejects every member of a post-normalization collision', () => {
  const result = validateFirestoreDocumentIds([1, '1', 1])

  assert.equal(result.valid, false)
  assert.deepEqual(result.normalizedValues, ['1', '1', '1'])
  assert.deepEqual(result.rejections, [
    {
      category: DOCUMENT_ID_REJECTION_CATEGORIES.COLLISION,
      sourceIndex: 0,
      originalValue: 1,
      originalType: 'number',
      normalizedValue: '1',
      collisionPartners: [
        {
          sourceIndex: 1,
          originalValue: '1',
          originalType: 'string',
          normalizedValue: '1',
        },
        {
          sourceIndex: 2,
          originalValue: 1,
          originalType: 'number',
          normalizedValue: '1',
        },
      ],
    },
    {
      category: DOCUMENT_ID_REJECTION_CATEGORIES.COLLISION,
      sourceIndex: 1,
      originalValue: '1',
      originalType: 'string',
      normalizedValue: '1',
      collisionPartners: [
        {
          sourceIndex: 0,
          originalValue: 1,
          originalType: 'number',
          normalizedValue: '1',
        },
        {
          sourceIndex: 2,
          originalValue: 1,
          originalType: 'number',
          normalizedValue: '1',
        },
      ],
    },
    {
      category: DOCUMENT_ID_REJECTION_CATEGORIES.COLLISION,
      sourceIndex: 2,
      originalValue: 1,
      originalType: 'number',
      normalizedValue: '1',
      collisionPartners: [
        {
          sourceIndex: 0,
          originalValue: 1,
          originalType: 'number',
          normalizedValue: '1',
        },
        {
          sourceIndex: 1,
          originalValue: '1',
          originalType: 'string',
          normalizedValue: '1',
        },
      ],
    },
  ])
})

test('detects multiple collision groups with deterministic partner order', () => {
  const result = validateFirestoreDocumentIds(['same', -0, 'same', 0])

  assert.equal(result.valid, false)
  assert.deepEqual(result.rejections.map(entry => ({
    sourceIndex: entry.sourceIndex,
    normalizedValue: entry.normalizedValue,
    partnerIndexes: entry.collisionPartners.map(partner => partner.sourceIndex),
  })), [
    { sourceIndex: 0, normalizedValue: 'same', partnerIndexes: [2] },
    { sourceIndex: 1, normalizedValue: '0', partnerIndexes: [3] },
    { sourceIndex: 2, normalizedValue: 'same', partnerIndexes: [0] },
    { sourceIndex: 3, normalizedValue: '0', partnerIndexes: [1] },
  ])
})

test('returns every independent rejection in source order', () => {
  const result = validateFirestoreDocumentIds([
    'valid',
    null,
    'with/slash',
    Infinity,
  ])

  assert.equal(result.valid, false)
  assert.deepEqual(result.normalizedValues, [
    'valid',
    undefined,
    'with/slash',
    'Infinity',
  ])
  assert.deepEqual(result.rejections.map(entry => ({
    category: entry.category,
    sourceIndex: entry.sourceIndex,
  })), [
    { category: DOCUMENT_ID_REJECTION_CATEGORIES.NULL_VALUE, sourceIndex: 1 },
    { category: DOCUMENT_ID_REJECTION_CATEGORIES.CONTAINS_SLASH,
      sourceIndex: 2 },
    { category: DOCUMENT_ID_REJECTION_CATEGORIES.NON_FINITE_NUMBER,
      sourceIndex: 3 },
  ])
})

test('requires an array for collection-level collision validation', () => {
  assert.throws(
    () => validateFirestoreDocumentIds('student-1'),
    /originalValues must be an array/,
  )
})
