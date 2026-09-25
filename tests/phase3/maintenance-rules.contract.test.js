import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(path, 'utf8')
const baseline = read('firestore.phase3.final.rules')
const candidate = read('firestore.phase3.maintenance.rules')
const sha = value => createHash('sha256').update(value).digest('hex')
const withoutComments = value => value.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim()

// This is a byte-derived contract for the pinned artifact, not a Rules parser.
// Emulator compilation and behavior are verified separately.
function check(source) {
  const expected = baseline.replace(/allow ([a-z, ]+): if [^;]+;/g, (whole, operations) => {
    const names = operations.split(',').map(name => name.trim())
    return names.some(name => ['write', 'create', 'update', 'delete'].includes(name))
      ? `allow ${operations}: if false;` : whole
  })
  assert.equal(withoutComments(source), withoutComments(expected), 'exact read-preserving write denial')
}

test('maintenance is only the pinned final artifact with every client write denied', () => {
  assert.equal(sha(baseline), 'f071377d7abf8d1d0009e5b9083a42f3cc7c69cdc6b501f6ea6eaf8bc4791702')
  check(candidate)
})

for (const [name, mutate] of [
  ['conditional write restored', s => s.replace('allow update: if false;', 'allow update: if isActiveOwner(classroomId);')],
  ['broad recursive write added', s => s.replace('function isSignedIn()', 'match /{path=**} { allow write: if true; } function isSignedIn()')],
  ['read broadened', s => s.replace('allow get: if isActiveTeacher(teacherUid);', 'allow get: if true;')],
  ['read removed', s => s.replace('allow get: if isActiveTeacher(teacherUid);', '')],
  ['write hidden in read list', s => s.replace('allow get: if isActiveTeacher(teacherUid);', 'allow get, write: if isActiveTeacher(teacherUid);')],
  ['private mixed read/write enabled', s => s.replace('allow read, write: if false;', 'allow read, write: if true;')],
]) {
  test(`contract rejects ${name}`, () => {
    check(candidate)
    const changed = mutate(candidate)
    assert.notEqual(changed, candidate)
    assert.throws(() => check(changed), { code: 'ERR_ASSERTION', message: /exact read-preserving write denial/ })
  })
}

test('default release configuration and legacy rules remain unchanged', () => {
  assert.equal(JSON.parse(read('firebase.json')).firestore.rules, 'firestore.phase3.final.rules')
  assert.equal(sha(read('firestore.rules')), '0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50')
})
