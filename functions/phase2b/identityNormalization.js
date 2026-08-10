import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

export const CLASSROOM_CODE_ALPHABET = Object.freeze([
  '2', '3', '4', '5', '6', '7', '8', '9',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H',
  'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R',
  'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
])

const CLASSROOM_CODE_ALPHABET_SET = new Set(CLASSROOM_CODE_ALPHABET)
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/

function isWellFormedUnicode(value) {
  if (typeof String.prototype.isWellFormed === 'function') {
    return value.isWellFormed()
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (
        index + 1 >= value.length ||
        nextCodeUnit < 0xDC00 ||
        nextCodeUnit > 0xDFFF
      ) {
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

export function validateCanonicalDocumentId(value, fieldName = 'documentId') {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string.`)
  }
  if (!value) {
    throw new Error(`${fieldName} must not be empty.`)
  }
  if (value.trim() !== value) {
    throw new Error(`${fieldName} must not have surrounding whitespace.`)
  }
  if (value.includes('/')) {
    throw new Error(`${fieldName} must not contain slashes.`)
  }
  if (value === '.' || value === '..') {
    throw new Error(`${fieldName} must not be a dot segment.`)
  }
  if (/^__[\s\S]*__$/.test(value)) {
    throw new Error(`${fieldName} must not use a reserved document ID.`)
  }
  if (!isWellFormedUnicode(value)) {
    throw new Error(`${fieldName} contains invalid Unicode.`)
  }
  if (Buffer.byteLength(value, 'utf8') > 1500) {
    throw new Error(`${fieldName} exceeds the Firestore UTF-8 byte limit.`)
  }
  return value
}

export function validateSha256Digest(value, fieldName = 'digest') {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string.`)
  }
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a lowercase hexadecimal SHA-256 digest.`)
  }
  return value
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if ((code >= 0x00 && code <= 0x1F) || (code >= 0x7F && code <= 0x9F)) {
      return true
    }
  }
  return false
}

function isAsciiPrintable(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7E) {
      return false
    }
  }
  return true
}

export function normalizeEmail(rawEmail) {
  if (typeof rawEmail !== 'string') {
    throw new TypeError('Email must be a string.')
  }
  const trimmed = rawEmail.trim()
  if (!trimmed) {
    throw new Error('Email must not be empty.')
  }
  if (!isWellFormedUnicode(trimmed)) {
    throw new Error('Email contains invalid Unicode.')
  }
  if (/\s/.test(trimmed) || hasControlCharacters(trimmed)) {
    throw new Error('Email must not contain whitespace or control characters.')
  }

  const asciiLowered = trimmed.replace(/[A-Z]/g, char =>
    String.fromCharCode(char.charCodeAt(0) + 32),
  )

  const EMAIL_REGEX =
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

  if (!EMAIL_REGEX.test(asciiLowered)) {
    throw new Error('Email address is malformed.')
  }

  return asciiLowered
}

export function hashSha256(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Input to hashSha256 must be a string.')
  }
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function hashEmailDigest(email) {
  const normalized = normalizeEmail(email)
  return hashSha256(normalized)
}

export function normalizeClassroomName(rawName) {
  if (typeof rawName !== 'string') {
    throw new TypeError('Classroom name must be a string.')
  }
  if (!isWellFormedUnicode(rawName)) {
    throw new Error('Classroom name contains invalid Unicode.')
  }
  if (hasControlCharacters(rawName)) {
    throw new Error('Classroom name must not contain control characters.')
  }
  if (rawName.includes('/')) {
    throw new Error('Classroom name must not contain slashes.')
  }

  const trimmed = rawName.trim()
  const collapsed = trimmed.replace(/[ \t\r\n\f\v]+/g, ' ')
  const codePointCount = [...collapsed].length

  if (codePointCount < 1 || codePointCount > 80) {
    throw new Error('Classroom name must be between 1 and 80 Unicode code points.')
  }

  return collapsed
}

export function normalizeDisplayName(rawDisplayName) {
  if (typeof rawDisplayName !== 'string') {
    throw new TypeError('Display name must be a string.')
  }
  if (!isWellFormedUnicode(rawDisplayName)) {
    throw new Error('Display name contains invalid Unicode.')
  }
  if (hasControlCharacters(rawDisplayName)) {
    throw new Error('Display name must not contain control characters.')
  }

  const trimmed = rawDisplayName.trim()
  const collapsed = trimmed.replace(/[ \t\r\n\f\v]+/g, ' ')
  const codePointCount = [...collapsed].length

  if (codePointCount > 100) {
    throw new Error('Display name must not exceed 100 Unicode code points.')
  }

  return collapsed
}

export function normalizeClassroomCode(rawCode) {
  if (typeof rawCode !== 'string') {
    throw new TypeError('Classroom code must be a string.')
  }
  if (!isWellFormedUnicode(rawCode)) {
    throw new Error('Classroom code contains invalid Unicode.')
  }

  let str = rawCode.trim()
  if (!str) {
    throw new Error('Classroom code cannot be empty.')
  }

  if (!isAsciiPrintable(str)) {
    throw new Error('Classroom code contains invalid characters or lookalikes.')
  }

  const hyphenMatches = str.match(/-/g)
  if (hyphenMatches && hyphenMatches.length > 1) {
    throw new Error('Classroom code contains extra separators.')
  }

  str = str.replace(/[a-z]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 32))

  if (/[^A-Z0-9\s-]/.test(str)) {
    throw new Error('Classroom code contains invalid punctuation.')
  }

  const canonical = str.replace(/[-\s]/g, '')
  if (canonical.length !== 8) {
    throw new Error('Classroom code must be exactly 8 unambiguous characters.')
  }

  for (let index = 0; index < canonical.length; index += 1) {
    if (!CLASSROOM_CODE_ALPHABET_SET.has(canonical[index])) {
      throw new Error(
        `Classroom code contains invalid or ambiguous character: ${canonical[index]}`,
      )
    }
  }

  return canonical
}

export function formatClassroomCode(canonicalCode) {
  const normalized = normalizeClassroomCode(canonicalCode)
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

export function normalizeStudentLoginId(rawLoginId) {
  if (typeof rawLoginId !== 'string') {
    throw new TypeError('Login ID must be a string.')
  }
  if (!isWellFormedUnicode(rawLoginId)) {
    throw new Error('Login ID contains invalid Unicode.')
  }

  let str = rawLoginId.trim()
  if (!str) {
    throw new Error('Login ID cannot be empty.')
  }

  str = str.replace(/[A-Z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 32))

  if (/[^a-z0-9-]/.test(str)) {
    throw new Error('Login ID contains characters outside the grammar [a-z0-9-].')
  }

  if (str.length < 1 || str.length > 64) {
    throw new Error('Login ID must be between 1 and 64 characters.')
  }

  if (str.startsWith('-') || str.endsWith('-')) {
    throw new Error('Login ID must not have a leading or trailing hyphen.')
  }

  if (str.includes('--')) {
    throw new Error('Login ID must not contain repeated hyphens.')
  }

  return str
}
