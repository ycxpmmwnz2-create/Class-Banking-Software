import { Buffer } from 'node:buffer'

export const MAX_FIRESTORE_DOCUMENT_ID_UTF8_BYTES = 1500

export const DOCUMENT_ID_REJECTION_CATEGORIES = Object.freeze({
  ARRAY_VALUE: 'array-value',
  BOOLEAN_VALUE: 'boolean-value',
  COLLISION: 'post-normalization-collision',
  CONTAINS_SLASH: 'contains-slash',
  DOT_SEGMENT: 'dot-segment',
  EMPTY_STRING: 'empty-string',
  INVALID_UNICODE: 'invalid-unicode',
  NON_FINITE_NUMBER: 'non-finite-number',
  NULL_VALUE: 'null-value',
  OBJECT_VALUE: 'object-value',
  RESERVED_PATTERN: 'reserved-pattern',
  SURROUNDING_WHITESPACE: 'leading-or-trailing-whitespace',
  UNDEFINED_VALUE: 'undefined-value',
  UNSUPPORTED_TYPE: 'unsupported-type',
  UTF8_BYTE_LIMIT_EXCEEDED: 'utf8-byte-limit-exceeded',
  WHITESPACE_ONLY_STRING: 'whitespace-only-string',
})

function originalType(value) {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return 'array'
  }

  return typeof value
}

function rejection(category, sourceIndex, originalValue, normalizedValue) {
  const result = {
    category,
    sourceIndex,
    originalValue,
    originalType: originalType(originalValue),
  }

  if (normalizedValue !== undefined) {
    result.normalizedValue = normalizedValue
  }

  return result
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)

    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1)

      if (index + 1 >= value.length ||
          nextCodeUnit < 0xDC00 || nextCodeUnit > 0xDFFF) {
        return false
      }

      index += 1
      continue
    }

    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false
    }
  }

  return true
}

function validateNormalizedString(originalValue, normalizedValue, sourceIndex) {
  if (normalizedValue.length === 0) {
    return rejection(
      DOCUMENT_ID_REJECTION_CATEGORIES.EMPTY_STRING,
      sourceIndex,
      originalValue,
      normalizedValue,
    )
  }

  const trimmedValue = normalizedValue.trim()

  if (trimmedValue.length === 0) {
    return rejection(
      DOCUMENT_ID_REJECTION_CATEGORIES.WHITESPACE_ONLY_STRING,
      sourceIndex,
      originalValue,
      normalizedValue,
    )
  }

  if (trimmedValue !== normalizedValue) {
    return rejection(
      DOCUMENT_ID_REJECTION_CATEGORIES.SURROUNDING_WHITESPACE,
      sourceIndex,
      originalValue,
      normalizedValue,
    )
  }

  if (normalizedValue.includes('/')) {
    return rejection(
      DOCUMENT_ID_REJECTION_CATEGORIES.CONTAINS_SLASH,
      sourceIndex,
      originalValue,
      normalizedValue,
    )
  }

  if (normalizedValue === '.' || normalizedValue === '..') {
    return rejection(
      DOCUMENT_ID_REJECTION_CATEGORIES.DOT_SEGMENT,
      sourceIndex,
      originalValue,
      normalizedValue,
    )
  }

  if (/^__[\s\S]*__$/.test(normalizedValue)) {
    return rejection(
      DOCUMENT_ID_REJECTION_CATEGORIES.RESERVED_PATTERN,
      sourceIndex,
      originalValue,
      normalizedValue,
    )
  }

  if (!isWellFormedUnicode(normalizedValue)) {
    return rejection(
      DOCUMENT_ID_REJECTION_CATEGORIES.INVALID_UNICODE,
      sourceIndex,
      originalValue,
      normalizedValue,
    )
  }

  if (Buffer.byteLength(normalizedValue, 'utf8') >
      MAX_FIRESTORE_DOCUMENT_ID_UTF8_BYTES) {
    return rejection(
      DOCUMENT_ID_REJECTION_CATEGORIES.UTF8_BYTE_LIMIT_EXCEEDED,
      sourceIndex,
      originalValue,
      normalizedValue,
    )
  }

  return null
}

/**
 * Validates and normalizes one legacy identifier without accessing Firestore.
 *
 * A valid result contains the canonical `normalizedValue`. An invalid result
 * contains one structured rejection. Strings are never trimmed or Unicode
 * normalized.
 */
export function normalizeFirestoreDocumentId(originalValue, sourceIndex = 0) {
  if (originalValue === null) {
    return {
      valid: false,
      rejection: rejection(
        DOCUMENT_ID_REJECTION_CATEGORIES.NULL_VALUE,
        sourceIndex,
        originalValue,
      ),
    }
  }

  if (originalValue === undefined) {
    return {
      valid: false,
      rejection: rejection(
        DOCUMENT_ID_REJECTION_CATEGORIES.UNDEFINED_VALUE,
        sourceIndex,
        originalValue,
      ),
    }
  }

  if (Array.isArray(originalValue)) {
    return {
      valid: false,
      rejection: rejection(
        DOCUMENT_ID_REJECTION_CATEGORIES.ARRAY_VALUE,
        sourceIndex,
        originalValue,
      ),
    }
  }

  if (typeof originalValue === 'object') {
    return {
      valid: false,
      rejection: rejection(
        DOCUMENT_ID_REJECTION_CATEGORIES.OBJECT_VALUE,
        sourceIndex,
        originalValue,
      ),
    }
  }

  if (typeof originalValue === 'boolean') {
    return {
      valid: false,
      rejection: rejection(
        DOCUMENT_ID_REJECTION_CATEGORIES.BOOLEAN_VALUE,
        sourceIndex,
        originalValue,
      ),
    }
  }

  if (typeof originalValue === 'number' && !Number.isFinite(originalValue)) {
    const normalizedValue = String(originalValue)

    return {
      valid: false,
      normalizedValue,
      rejection: rejection(
        DOCUMENT_ID_REJECTION_CATEGORIES.NON_FINITE_NUMBER,
        sourceIndex,
        originalValue,
        normalizedValue,
      ),
    }
  }

  if (typeof originalValue !== 'number' && typeof originalValue !== 'string') {
    return {
      valid: false,
      rejection: rejection(
        DOCUMENT_ID_REJECTION_CATEGORIES.UNSUPPORTED_TYPE,
        sourceIndex,
        originalValue,
      ),
    }
  }

  const normalizedValue = typeof originalValue === 'number'
    ? String(originalValue)
    : originalValue
  const validationRejection = validateNormalizedString(
    originalValue,
    normalizedValue,
    sourceIndex,
  )

  if (validationRejection) {
    return {
      valid: false,
      normalizedValue,
      rejection: validationRejection,
    }
  }

  return {
    valid: true,
    normalizedValue,
  }
}

function collisionPartner(result) {
  return {
    sourceIndex: result.sourceIndex,
    originalValue: result.originalValue,
    originalType: originalType(result.originalValue),
    normalizedValue: result.normalizedValue,
  }
}

/**
 * Validates a complete legacy identifier collection and detects collisions.
 * Every otherwise-valid member of a collision group receives its own
 * rejection with the remaining group members identified as partners.
 */
export function validateFirestoreDocumentIds(originalValues) {
  if (!Array.isArray(originalValues)) {
    throw new TypeError('originalValues must be an array.')
  }

  const results = originalValues.map((originalValue, sourceIndex) => {
    const normalized = normalizeFirestoreDocumentId(originalValue, sourceIndex)

    return {
      ...normalized,
      sourceIndex,
      originalValue,
    }
  })
  const rejections = results
    .filter(result => !result.valid)
    .map(result => result.rejection)
  const resultsByNormalizedValue = new Map()

  for (const result of results) {
    if (!result.valid) {
      continue
    }

    const matchingResults = resultsByNormalizedValue.get(result.normalizedValue)

    if (matchingResults) {
      matchingResults.push(result)
    } else {
      resultsByNormalizedValue.set(result.normalizedValue, [result])
    }
  }

  for (const matchingResults of resultsByNormalizedValue.values()) {
    if (matchingResults.length < 2) {
      continue
    }

    for (const result of matchingResults) {
      const collisionRejection = rejection(
        DOCUMENT_ID_REJECTION_CATEGORIES.COLLISION,
        result.sourceIndex,
        result.originalValue,
        result.normalizedValue,
      )
      collisionRejection.collisionPartners = matchingResults
        .filter(partner => partner.sourceIndex !== result.sourceIndex)
        .map(collisionPartner)
      rejections.push(collisionRejection)
    }
  }

  rejections.sort((left, right) => left.sourceIndex - right.sourceIndex)

  return {
    valid: rejections.length === 0,
    normalizedValues: results.map(result => result.normalizedValue),
    rejections,
  }
}
