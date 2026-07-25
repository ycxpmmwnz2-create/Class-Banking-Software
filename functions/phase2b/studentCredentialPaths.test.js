import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STUDENT_CREDENTIAL_COLLECTIONS,
  classroomLoginCodePath,
  studentAuthLogPath,
  studentAuthLogsCollectionPath,
  studentAuthUnresolvedLogPath,
  studentAuthUnresolvedLogsCollectionPath,
  studentCredentialPath,
  studentLoginThrottlePath,
  teacherInvitationPath,
} from './studentCredentialPaths.js'

test('STUDENT_CREDENTIAL_COLLECTIONS: is frozen object', () => {
  assert.equal(Object.isFrozen(STUDENT_CREDENTIAL_COLLECTIONS), true)
  assert.equal(STUDENT_CREDENTIAL_COLLECTIONS.CLASSROOMS, 'classrooms')
})

test('studentCredentialPath: constructs exact path when given canonical classroomId and loginId', () => {
  const path = studentCredentialPath('classroom-1', 'john-doe')
  assert.equal(path, 'classrooms/classroom-1/studentCredentials/john-doe')
})

test('studentCredentialPath: allows duplicate loginId across different classrooms', () => {
  const pathA = studentCredentialPath('classroom-a', 'john-doe')
  const pathB = studentCredentialPath('classroom-b', 'john-doe')

  assert.equal(pathA, 'classrooms/classroom-a/studentCredentials/john-doe')
  assert.equal(pathB, 'classrooms/classroom-b/studentCredentials/john-doe')
  assert.notEqual(pathA, pathB)
})

test('studentCredentialPath: rejects un-canonical loginId or invalid classroomId', () => {
  assert.throws(() => studentCredentialPath('classroom-1', 'John-Doe'), Error)
  assert.throws(() => studentCredentialPath('classroom-1', '  john-doe  '), Error)
  assert.throws(() => studentCredentialPath('classroom/1', 'john-doe'), Error)
  assert.throws(() => studentCredentialPath('  classroom-1  ', 'john-doe'), Error)
  assert.throws(() => studentCredentialPath('.', 'john-doe'), Error)
})

test('studentAuthLogsCollectionPath & studentAuthLogPath: construct valid log paths', () => {
  assert.equal(studentAuthLogsCollectionPath('classroom-1'), 'studentAuthLogs/classroom-1/logs')
  assert.equal(studentAuthLogPath('classroom-1', 'log-123'), 'studentAuthLogs/classroom-1/logs/log-123')
  assert.throws(() => studentAuthLogPath('classroom-1', 'log/123'), Error)
})

test('studentLoginThrottlePath & teacherInvitationPath: construct valid digest paths', () => {
  assert.equal(studentLoginThrottlePath('digest-123'), 'studentLoginThrottle/digest-123')
  assert.equal(teacherInvitationPath('abc123hex'), 'teacherInvitations/abc123hex')
  assert.throws(() => studentLoginThrottlePath('digest/123'), Error)
})

test('studentAuthUnresolvedLogPath & CollectionPath: construct valid unresolved log paths', () => {
  assert.equal(studentAuthUnresolvedLogsCollectionPath(), 'studentAuthUnresolvedLogs')
  assert.equal(studentAuthUnresolvedLogPath('log-999'), 'studentAuthUnresolvedLogs/log-999')
})

test('classroomLoginCodePath: requires already canonical 8-char code', () => {
  assert.equal(classroomLoginCodePath('23456789'), 'classroomLoginCodes/23456789')
  assert.throws(() => classroomLoginCodePath('2345-6789'), Error)
  assert.throws(() => classroomLoginCodePath('23456780'), Error)
})
