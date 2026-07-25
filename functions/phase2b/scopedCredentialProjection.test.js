import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveDeterministicStudentAuthUid,
  projectScopedCredential,
  projectAndReconcileScopedCredentials,
  ScopedCredentialProjectionError,
} from './scopedCredentialProjection.js'

test('deriveDeterministicStudentAuthUid: deterministic UID exactness and NUL separation', () => {
  const uid1 = deriveDeterministicStudentAuthUid('classA', 'student1')
  const uid1Again = deriveDeterministicStudentAuthUid('classA', 'student1')
  assert.equal(uid1, uid1Again)
  assert.match(uid1, /^s_[A-Za-z0-9_-]+$/)

  // Test NUL separation: classA + student1 vs classAstudent + 1
  const uid2 = deriveDeterministicStudentAuthUid('classAstudent', '1')
  assert.notEqual(uid1, uid2)

  // Classroom A vs Classroom B with same student ID
  const uidA = deriveDeterministicStudentAuthUid('classA', 'student1')
  const uidB = deriveDeterministicStudentAuthUid('classB', 'student1')
  assert.notEqual(uidA, uidB)
})

test('same login ID in Classroom A and B yields distinct paths and Auth UIDs', () => {
  const sourceEnv = {
    id: 'alex-smith',
    data: {
      studentId: 'student_123',
      pinHash: '$2b$10$hashvalue',
      active: true,
    },
  }

  const projA = projectScopedCredential(sourceEnv, 'classA')
  const projB = projectScopedCredential(sourceEnv, 'classB')

  assert.equal(projA.targetPath, 'classrooms/classA/studentCredentials/alex-smith')
  assert.equal(projB.targetPath, 'classrooms/classB/studentCredentials/alex-smith')
  assert.notEqual(projA.projectedData.authUid, projB.projectedData.authUid)
  assert.equal(projA.projectedData.classroomId, 'classA')
  assert.equal(projB.projectedData.classroomId, 'classB')
})

test('no mutation of source records', () => {
  const sourceEnvelope = Object.freeze({
    id: 'alex-smith',
    data: Object.freeze({
      studentId: 'student_123',
      classroomId: 'morgan',
      pinHash: '$2b$10$hashvalue',
      active: true,
      failedAttempts: 2,
      customField: 'preserved',
    }),
  })

  const projection = projectScopedCredential(sourceEnvelope, 'classTarget')

  assert.notEqual(sourceEnvelope.data, projection.projectedData)
  assert.equal(sourceEnvelope.data.classroomId, 'morgan')
  assert.equal(sourceEnvelope.data.authUid, undefined)
  assert.equal(projection.projectedData.classroomId, 'classTarget')
  assert.ok(projection.projectedData.authUid.startsWith('s_'))
})

test('preservation of all security, timestamp, and unknown fields', () => {
  const createdAt = new Date('2025-01-01T00:00:00Z')
  const updatedAt = new Date('2025-01-02T00:00:00Z')

  const sourceEnvelope = {
    id: 'alex-smith',
    data: {
      studentId: 'student_123',
      pinHash: '$2b$10$secretpin',
      active: false,
      failedAttempts: 3,
      lockedUntil: 1700000000000,
      schemaVersion: 1,
      createdAt,
      updatedAt,
      pinUpdatedAt: 1690000000000,
      unknownMetadata: { foo: 'bar' },
      customSecurityFlag: true,
    },
  }

  const projection = projectScopedCredential(sourceEnvelope, 'classTarget')
  const data = projection.projectedData

  assert.equal(data.pinHash, '$2b$10$secretpin')
  assert.equal(data.active, false)
  assert.equal(data.failedAttempts, 3)
  assert.equal(data.lockedUntil, 1700000000000)
  assert.equal(data.schemaVersion, 1)
  assert.equal(data.createdAt, createdAt)
  assert.equal(data.updatedAt, updatedAt)
  assert.equal(data.pinUpdatedAt, 1690000000000)
  assert.deepEqual(data.unknownMetadata, { foo: 'bar' })
  assert.equal(data.customSecurityFlag, true)
})

test('active, inactive, and orphaned parity', () => {
  const sources = [
    {
      id: 'student-active',
      data: { studentId: 'stu_1', active: true, pinHash: 'h1' },
    },
    {
      id: 'student-inactive',
      data: { studentId: 'stu_2', active: false, pinHash: 'h2' },
    },
    {
      id: 'student-orphaned',
      data: { studentId: 'stu_3', active: false, pinHash: 'h3', isOrphaned: true },
    },
  ]

  const result = projectAndReconcileScopedCredentials({
    sources,
    targetClassroomId: 'classTarget',
    rosterStudentIds: ['stu_1', 'stu_2'],
  })

  assert.equal(result.stats.total, 3)
  assert.equal(result.stats.orphaned, 1)
  assert.deepEqual(result.orphanedCredentialPaths, [
    'classrooms/classTarget/studentCredentials/student-orphaned',
  ])
  assert.equal(result.projections[0].projectedData.active, true)
  assert.equal(result.projections[1].projectedData.active, false)
  assert.equal(result.projections[2].projectedData.active, false)
})

test('malformed envelope/source/classroom/student/login rejection', () => {
  assert.throws(
    () => projectScopedCredential(null, 'classA'),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'malformed-envelope',
  )

  assert.throws(
    () => projectScopedCredential({}, 'classA'),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'malformed-envelope',
  )

  assert.throws(
    () => projectScopedCredential({ id: 'INVALID LOGIN' }, 'classA'),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'malformed-envelope',
  )

  assert.throws(
    () => projectScopedCredential({ id: 'valid-login', loginId: 'different-login', data: { studentId: 'stu1' } }, 'classA'),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'noncanonical-login-id',
  )

  assert.throws(
    () => projectScopedCredential({ id: 'valid-login', data: null }, 'classA'),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'malformed-envelope',
  )

  assert.throws(
    () => projectScopedCredential({ id: 'valid-login', data: { studentId: 'invalid/student' } }, 'classA'),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'malformed-student-id',
  )

  assert.throws(
    () => projectScopedCredential({ id: 'valid-login', data: { studentId: 'stu1' } }, 'invalid/classroom'),
    (err) => err instanceof TypeError || err.message.includes('slashes'),
  )

  assert.throws(
    () => projectScopedCredential({ id: 'valid-login', data: { studentId: 'stu1', classroomId: 'classB' } }, 'classA'),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'source-classroom-mismatch',
  )
})

test('duplicate source/target/student identity rejection', () => {
  const duplicateSourceLogin = [
    { id: 'same-login', data: { studentId: 'stu1', pinHash: 'h1' } },
    { id: 'same-login', data: { studentId: 'stu2', pinHash: 'h2' } },
  ]
  assert.throws(
    () => projectAndReconcileScopedCredentials({ sources: duplicateSourceLogin, targetClassroomId: 'classA' }),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'duplicate-source-id',
  )

  const duplicateStudentId = [
    { id: 'login1', data: { studentId: 'same_stu', pinHash: 'h1' } },
    { id: 'login2', data: { studentId: 'same_stu', pinHash: 'h2' } },
  ]
  assert.throws(
    () => projectAndReconcileScopedCredentials({ sources: duplicateStudentId, targetClassroomId: 'classA' }),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'duplicate-student-id',
  )
})

test('exact rerun/idempotency and missing target reconciliation', () => {
  const sources = [
    { id: 'alex-smith', data: { studentId: 'stu_1', pinHash: '$2b$10$hash1', active: true } },
    { id: 'bob-jones', data: { studentId: 'stu_2', pinHash: '$2b$10$hash2', active: true } },
  ]

  const projectedAlex = projectScopedCredential(sources[0], 'classA')

  // One target already present with exact match, one missing target
  const targets = [
    {
      path: projectedAlex.targetPath,
      data: projectedAlex.projectedData,
    },
  ]

  const result = projectAndReconcileScopedCredentials({
    sources,
    targets,
    targetClassroomId: 'classA',
    strict: true,
  })

  assert.equal(result.stats.total, 2)
  assert.equal(result.stats.absent, 1)
  assert.equal(result.stats.exactParity, 1)
  assert.equal(result.stats.divergent, 0)
  assert.equal(result.projections[0].reconciliationStatus, 'exact_parity')
  assert.equal(result.projections[1].reconciliationStatus, 'absent')
})

test('divergence without secret leakage', () => {
  const sources = [
    { id: 'alex-smith', data: { studentId: 'stu_1', pinHash: '$2b$10$secret_source_hash', active: true } },
  ]

  const projectedAlex = projectScopedCredential(sources[0], 'classA')

  // Target doc has divergent pinHash
  const targets = [
    {
      path: projectedAlex.targetPath,
      data: {
        ...projectedAlex.projectedData,
        pinHash: '$2b$10$different_target_hash',
      },
    },
  ]

  assert.throws(
    () =>
      projectAndReconcileScopedCredentials({
        sources,
        targets,
        targetClassroomId: 'classA',
        strict: true,
      }),
    (err) => {
      assert.ok(err instanceof ScopedCredentialProjectionError)
      assert.equal(err.code, 'target-divergence')
      // Must not leak pinHash values in error message
      assert.ok(!err.message.includes('$2b$10$secret_source_hash'))
      assert.ok(!err.message.includes('$2b$10$different_target_hash'))
      return true
    },
  )
})

test('old/new UID and claims-identity reconciliation', () => {
  const sourceEnvelope = {
    id: 'alex-smith',
    data: {
      studentId: 'stu_99',
      authUid: 'old_legacy_uid_123',
      pinHash: 'h1',
      active: true,
    },
  }

  const projection = projectScopedCredential(sourceEnvelope, 'classA')
  const uidMap = projection.uidMapping

  assert.equal(uidMap.oldAuthUid, 'old_legacy_uid_123')
  assert.equal(uidMap.classroomId, 'classA')
  assert.equal(uidMap.studentId, 'stu_99')

  const expectedNewUid = deriveDeterministicStudentAuthUid('classA', 'stu_99')
  assert.equal(uidMap.newAuthUid, expectedNewUid)
})
