import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASSROOM_CODE_ALPHABET,
  formatClassroomCode,
  hashEmailDigest,
  hashSha256,
  normalizeClassroomCode,
  normalizeClassroomName,
  normalizeDisplayName,
  normalizeEmail,
  normalizeStudentLoginId,
} from './identityNormalization.js'

test('normalizeEmail: handles valid ASCII emails and ASCII uppercase lowering', () => {
  assert.equal(normalizeEmail('Teacher.One@Example.COM'), 'teacher.one@example.com')
  assert.equal(normalizeEmail('  user+tag@domain.co.uk  '), 'user+tag@domain.co.uk')
})

test('normalizeEmail: rejects non-string, empty, malformed, whitespace, and controls', () => {
  assert.throws(() => normalizeEmail(123), TypeError)
  assert.throws(() => normalizeEmail(''), Error)
  assert.throws(() => normalizeEmail('   '), Error)
  assert.throws(() => normalizeEmail('user @example.com'), Error)
  assert.throws(() => normalizeEmail('user\t@example.com'), Error)
  assert.throws(() => normalizeEmail('user\n@example.com'), Error)
  assert.throws(() => normalizeEmail('user@domain'), Error)
  assert.throws(() => normalizeEmail('user@.com'), Error)
  assert.throws(() => normalizeEmail('user@domain.'), Error)
  assert.throws(() => normalizeEmail('user\x00@example.com'), Error)
  assert.throws(() => normalizeEmail('\uD83D@example.com'), Error) // unpaired surrogate
})

test('hashEmailDigest: produces SHA-256 hex digest without raw email in ID', () => {
  const digest1 = hashEmailDigest('Teacher.One@Example.COM')
  const digest2 = hashEmailDigest('teacher.one@example.com')

  assert.equal(digest1.length, 64)
  assert.equal(digest1, digest2)
  assert.equal(/^[0-9a-f]{64}$/.test(digest1), true)
  assert.equal(digest1.includes('teacher'), false)
  assert.equal(digest1.includes('example'), false)
})

test('normalizeClassroomName: handles valid 1-80 code points and collapses whitespace', () => {
  assert.equal(normalizeClassroomName('  Math  Class  101  '), 'Math Class 101')
  assert.equal(normalizeClassroomName('Classroom 🚀'), 'Classroom 🚀')
  assert.equal(normalizeClassroomName('A'.repeat(80)), 'A'.repeat(80))
})

test('normalizeClassroomName: rejects non-string, empty, >80 code points, controls, slash, invalid Unicode', () => {
  assert.throws(() => normalizeClassroomName(null), TypeError)
  assert.throws(() => normalizeClassroomName(''), Error)
  assert.throws(() => normalizeClassroomName('   '), Error)
  assert.throws(() => normalizeClassroomName('A'.repeat(81)), Error)
  assert.throws(() => normalizeClassroomName('Math/Science'), Error)
  assert.throws(() => normalizeClassroomName('Class\x07Room'), Error)
  assert.throws(() => normalizeClassroomName('Class\uD83D'), Error)
})

test('normalizeDisplayName: enforces 100 code point limit and rejects controls/malformed Unicode', () => {
  assert.equal(normalizeDisplayName('  Jane  Doe  '), 'Jane Doe')
  assert.equal(normalizeDisplayName('A'.repeat(100)), 'A'.repeat(100))
  assert.throws(() => normalizeDisplayName('A'.repeat(101)), Error)
  assert.throws(() => normalizeDisplayName('Jane\x00Doe'), Error)
  assert.throws(() => normalizeDisplayName('Jane\uD800Doe'), Error)
  assert.throws(() => normalizeDisplayName(123), TypeError)
})

test('normalizeClassroomCode: formats and normalizes 8-char unambiguous code', () => {
  assert.equal(normalizeClassroomCode('2345-6789'), '23456789')
  assert.equal(normalizeClassroomCode('abcd efgh'), 'ABCDEFGH')
  assert.equal(normalizeClassroomCode('  jkmn-pqrs  '), 'JKMNPQRS')
  assert.equal(formatClassroomCode('23456789'), '2345-6789')
  assert.equal(formatClassroomCode('abcd-efgh'), 'ABCD-EFGH')
})

test('normalizeClassroomCode: rejects ambiguous characters (0, O, 1, I), extra separators, non-ASCII lookalikes, malformed length', () => {
  // Ambiguous characters: 0, O, 1, I
  assert.throws(() => normalizeClassroomCode('23456780'), Error)
  assert.throws(() => normalizeClassroomCode('2345678O'), Error)
  assert.throws(() => normalizeClassroomCode('23456781'), Error)
  assert.throws(() => normalizeClassroomCode('2345678I'), Error)

  // Extra separators / punctuation
  assert.throws(() => normalizeClassroomCode('23-45-67-89'), Error)
  assert.throws(() => normalizeClassroomCode('2345--6789'), Error)
  assert.throws(() => normalizeClassroomCode('2345/6789'), Error)
  assert.throws(() => normalizeClassroomCode('2345.6789'), Error)

  // Lookalikes / non-ASCII
  assert.throws(() => normalizeClassroomCode('2345678О'), Error) // Cyrillic O

  // Malformed length
  assert.throws(() => normalizeClassroomCode('2345677'), Error)
  assert.throws(() => normalizeClassroomCode('234567899'), Error)
})

test('CLASSROOM_CODE_ALPHABET: is frozen and excludes ambiguous characters', () => {
  assert.equal(Object.isFrozen(CLASSROOM_CODE_ALPHABET), true)
  assert.equal(CLASSROOM_CODE_ALPHABET.includes('0'), false)
  assert.equal(CLASSROOM_CODE_ALPHABET.includes('O'), false)
  assert.equal(CLASSROOM_CODE_ALPHABET.includes('1'), false)
  assert.equal(CLASSROOM_CODE_ALPHABET.includes('I'), false)
})

test('normalizeStudentLoginId: handles valid 1-64 lowercase [a-z0-9-]', () => {
  assert.equal(normalizeStudentLoginId('  John-Doe-123  '), 'john-doe-123')
  assert.equal(normalizeStudentLoginId('a'), 'a')
  assert.equal(normalizeStudentLoginId('a'.repeat(64)), 'a'.repeat(64))
})

test('normalizeStudentLoginId: rejects invalid grammar, slashes, leading/trailing/repeated hyphens, controls, lookalikes', () => {
  assert.throws(() => normalizeStudentLoginId(''), Error)
  assert.throws(() => normalizeStudentLoginId('-john'), Error)
  assert.throws(() => normalizeStudentLoginId('john-'), Error)
  assert.throws(() => normalizeStudentLoginId('john--doe'), Error)
  assert.throws(() => normalizeStudentLoginId('john/doe'), Error)
  assert.throws(() => normalizeStudentLoginId('john_doe'), Error)
  assert.throws(() => normalizeStudentLoginId('john.doe'), Error)
  assert.throws(() => normalizeStudentLoginId('jöhndoe'), Error)
  assert.throws(() => normalizeStudentLoginId('a'.repeat(65)), Error)
  assert.throws(() => normalizeStudentLoginId(null), TypeError)
})

test('hashSha256: deterministically hashes strings', () => {
  assert.equal(hashSha256('test'), '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
  assert.throws(() => hashSha256(123), TypeError)
})
