import assert from 'node:assert/strict'
import test from 'node:test'

import { InsightIdentityError, validateInsightIdentity } from './identity.js'

test('accepts bounded canonical server-derived identities', () => {
  assert.equal(validateInsightIdentity('teacher-alpha', 'teacherUid'), 'teacher-alpha')
  assert.equal(validateInsightIdentity('classroom_123', 'classroomId'), 'classroom_123')
})

test('rejects path, whitespace, dot-segment, and length hazards', () => {
  for (const value of ['', ' teacher', 'teacher ', '.', '..', 'bad/path', 'x'.repeat(257)]) {
    assert.throws(
      () => validateInsightIdentity(value, 'identity'),
      error => error instanceof InsightIdentityError && error.category === 'invalid-identity',
    )
  }
})

test('rejects NUL, newline, tab, DEL, and C1 controls used in digest components', () => {
  for (const value of [
    'teacher\u0000classroom',
    'teacher\nclassroom',
    'teacher\tclassroom',
    'teacher\u007fclassroom',
    'teacher\u0085classroom',
  ]) {
    assert.throws(() => validateInsightIdentity(value), InsightIdentityError)
  }
})
