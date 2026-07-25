import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveDeterministicStudentAuthUid,
  firestoreValuesEqual,
  projectScopedCredential,
  projectAndReconcileScopedCredentials,
  ScopedCredentialProjectionError,
} from './scopedCredentialProjection.js'

const LEGACY_CLASSROOM_ID = 'morgan'
const SOURCE_UPDATE_TIME = new Date('2025-01-01T00:00:00Z')

/**
 * Builds the envelope shape an Admin SDK read of a flat legacy credential
 * produces: canonical document ID, flat path, updateTime metadata, and a
 * credential map still carrying its legacy classroomId.
 */
function flatSource(id, data = {}) {
  return {
    id,
    path: `studentCredentials/${id}`,
    updateTime: SOURCE_UPDATE_TIME,
    data: { classroomId: LEGACY_CLASSROOM_ID, ...data },
  }
}

class FakeTimestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds
    this.nanoseconds = nanoseconds
  }

  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6)
  }

  isEqual(other) {
    return other instanceof FakeTimestamp &&
      other.seconds === this.seconds &&
      other.nanoseconds === this.nanoseconds
  }
}

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
  const sourceEnv = flatSource('alex-smith', {
    studentId: 'student_123',
    pinHash: '$2b$10$hashvalue',
    active: true,
  })

  const projA = projectScopedCredential(sourceEnv, 'classA')
  const projB = projectScopedCredential(sourceEnv, 'classB')

  assert.equal(projA.targetPath, 'classrooms/classA/studentCredentials/alex-smith')
  assert.equal(projB.targetPath, 'classrooms/classB/studentCredentials/alex-smith')
  assert.equal(projA.sourcePath, 'studentCredentials/alex-smith')
  assert.equal(projA.sourceClassroomId, LEGACY_CLASSROOM_ID)
  assert.equal(projA.sourceUpdateTime, SOURCE_UPDATE_TIME)
  assert.notEqual(projA.projectedData.authUid, projB.projectedData.authUid)
  assert.equal(projA.projectedData.classroomId, 'classA')
  assert.equal(projB.projectedData.classroomId, 'classB')
})

test('no mutation of source records', () => {
  const sourceEnvelope = Object.freeze({
    id: 'alex-smith',
    path: 'studentCredentials/alex-smith',
    updateTime: SOURCE_UPDATE_TIME,
    data: Object.freeze({
      studentId: 'student_123',
      classroomId: LEGACY_CLASSROOM_ID,
      pinHash: '$2b$10$hashvalue',
      active: true,
      failedAttempts: 2,
      customField: 'preserved',
    }),
  })

  const projection = projectScopedCredential(sourceEnvelope, 'classTarget')

  assert.notEqual(sourceEnvelope.data, projection.projectedData)
  assert.equal(sourceEnvelope.data.classroomId, LEGACY_CLASSROOM_ID)
  assert.equal(sourceEnvelope.data.authUid, undefined)
  assert.equal(projection.projectedData.classroomId, 'classTarget')
  assert.ok(projection.projectedData.authUid.startsWith('s_'))
})

test('preservation of all security, timestamp, and unknown fields', () => {
  const createdAt = new Date('2025-01-01T00:00:00Z')
  const updatedAt = new Date('2025-01-02T00:00:00Z')

  const sourceEnvelope = flatSource('alex-smith', {
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
  })

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
    flatSource('student-active', { studentId: 'stu_1', active: true, pinHash: 'h1' }),
    flatSource('student-inactive', { studentId: 'stu_2', active: false, pinHash: 'h2' }),
    flatSource('student-orphaned', {
      studentId: 'stu_3',
      active: false,
      pinHash: 'h3',
      isOrphaned: true,
    }),
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

test('orphan detection also flags a source outside the supplied roster', () => {
  const sources = [flatSource('ghost-student', { studentId: 'stu_gone', active: true })]

  const result = projectAndReconcileScopedCredentials({
    sources,
    targetClassroomId: 'classTarget',
    rosterStudentIds: ['stu_1'],
  })

  assert.equal(result.stats.orphaned, 1)
  assert.equal(result.projections[0].isOrphaned, true)
})

test('malformed envelope/source/classroom/student/login rejection', () => {
  const cases = [
    {
      desc: 'null envelope',
      envelope: null,
      code: 'malformed-envelope',
    },
    {
      desc: 'empty envelope',
      envelope: {},
      code: 'malformed-envelope',
    },
    {
      desc: 'array envelope',
      envelope: [],
      code: 'malformed-envelope',
    },
    {
      desc: 'unsupported envelope field',
      envelope: { ...flatSource('alex-smith', { studentId: 'stu1' }), classroomId: 'classA' },
      code: 'malformed-envelope',
    },
    {
      desc: 'invalid login grammar',
      envelope: { ...flatSource('alex-smith', { studentId: 'stu1' }), id: 'INVALID LOGIN' },
      code: 'malformed-envelope',
    },
    {
      desc: 'noncanonical document ID that normalizes to another ID',
      envelope: {
        id: 'Alex-Smith',
        path: 'studentCredentials/Alex-Smith',
        updateTime: SOURCE_UPDATE_TIME,
        data: { studentId: 'stu1', classroomId: LEGACY_CLASSROOM_ID },
      },
      code: 'noncanonical-login-id',
    },
    {
      desc: 'envelope loginId disagreeing with document ID',
      envelope: { ...flatSource('valid-login', { studentId: 'stu1' }), loginId: 'different-login' },
      code: 'noncanonical-login-id',
    },
    {
      desc: 'missing source path',
      envelope: {
        id: 'alex-smith',
        updateTime: SOURCE_UPDATE_TIME,
        data: { studentId: 'stu1', classroomId: LEGACY_CLASSROOM_ID },
      },
      code: 'malformed-source-path',
    },
    {
      desc: 'source path outside studentCredentials',
      envelope: {
        ...flatSource('alex-smith', { studentId: 'stu1' }),
        path: 'classrooms/classA/studentCredentials/alex-smith',
      },
      code: 'malformed-source-path',
    },
    {
      desc: 'source path naming a different document',
      envelope: {
        ...flatSource('alex-smith', { studentId: 'stu1' }),
        path: 'studentCredentials/other-login',
      },
      code: 'malformed-source-path',
    },
    {
      desc: 'missing updateTime metadata',
      envelope: {
        id: 'alex-smith',
        path: 'studentCredentials/alex-smith',
        data: { studentId: 'stu1', classroomId: LEGACY_CLASSROOM_ID },
      },
      code: 'missing-source-update-time',
    },
    {
      desc: 'null data',
      envelope: { ...flatSource('valid-login'), data: null },
      code: 'malformed-envelope',
    },
    {
      desc: 'array-valued data',
      envelope: { ...flatSource('valid-login'), data: [] },
      code: 'malformed-envelope',
    },
    {
      desc: 'non-map data instance',
      envelope: { ...flatSource('valid-login'), data: new Date() },
      code: 'malformed-envelope',
    },
    {
      desc: 'malformed studentId',
      envelope: flatSource('valid-login', { studentId: 'invalid/student' }),
      code: 'malformed-student-id',
    },
    {
      desc: 'missing studentId',
      envelope: flatSource('valid-login', {}),
      code: 'malformed-student-id',
    },
    {
      desc: 'credential body loginId disagreeing with document ID',
      envelope: flatSource('valid-login', { studentId: 'stu1', loginId: 'other-login' }),
      code: 'source-login-id-mismatch',
    },
    {
      desc: 'missing source classroomId',
      envelope: {
        id: 'valid-login',
        path: 'studentCredentials/valid-login',
        updateTime: SOURCE_UPDATE_TIME,
        data: { studentId: 'stu1' },
      },
      code: 'missing-source-classroom-id',
    },
    {
      desc: 'malformed source classroomId',
      envelope: flatSource('valid-login', { studentId: 'stu1', classroomId: 'bad/classroom' }),
      code: 'malformed-classroom-id',
    },
    {
      desc: 'source classroomId already equal to target',
      envelope: flatSource('valid-login', { studentId: 'stu1', classroomId: 'classA' }),
      code: 'source-classroom-mismatch',
    },
    {
      desc: 'non-array rosterStudentIds',
      envelope: flatSource('valid-login', { studentId: 'stu1' }),
      options: { rosterStudentIds: 'stu1' },
      code: 'malformed-roster',
    },
  ]

  for (const { desc, envelope, options, code } of cases) {
    assert.throws(
      () => projectScopedCredential(envelope, 'classA', options ?? {}),
      (error) => {
        assert.ok(
          error instanceof ScopedCredentialProjectionError,
          `${desc}: expected ScopedCredentialProjectionError, got ${error?.name}`,
        )
        assert.equal(error.code, code, `${desc}: unexpected code ${error.code}`)
        return true
      },
      `Failed on ${desc}`,
    )
  }

  assert.throws(
    () => projectScopedCredential(flatSource('valid-login', { studentId: 'stu1' }), 'invalid/classroom'),
    (error) => error instanceof Error && error.message.includes('slashes'),
  )
})

test('duplicate source/target/student identity rejection', () => {
  const duplicateSourceLogin = [
    flatSource('same-login', { studentId: 'stu1', pinHash: 'h1' }),
    flatSource('same-login', { studentId: 'stu2', pinHash: 'h2' }),
  ]
  assert.throws(
    () => projectAndReconcileScopedCredentials({ sources: duplicateSourceLogin, targetClassroomId: 'classA' }),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'duplicate-source-id',
  )

  const duplicateStudentId = [
    flatSource('login1', { studentId: 'same_stu', pinHash: 'h1' }),
    flatSource('login2', { studentId: 'same_stu', pinHash: 'h2' }),
  ]
  assert.throws(
    () => projectAndReconcileScopedCredentials({ sources: duplicateStudentId, targetClassroomId: 'classA' }),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'duplicate-student-id',
  )
})

test('malformed sources/targets/roster collections fail closed instead of being ignored', () => {
  const sources = [flatSource('alex-smith', { studentId: 'stu_1', pinHash: 'h1' })]

  assert.throws(
    () => projectAndReconcileScopedCredentials({ sources: 'not-an-array', targetClassroomId: 'classA' }),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'malformed-sources',
  )

  // A non-array `targets` must never be silently treated as "no targets": that
  // would report an existing scoped credential as absent and invite an
  // overwrite.
  assert.throws(
    () => projectAndReconcileScopedCredentials({
      sources,
      targets: { 'classrooms/classA/studentCredentials/alex-smith': {} },
      targetClassroomId: 'classA',
    }),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'malformed-targets',
  )

  assert.throws(
    () => projectAndReconcileScopedCredentials({
      sources,
      targetClassroomId: 'classA',
      rosterStudentIds: 'stu_1',
    }),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'malformed-roster',
  )

  const malformedTargets = [
    { desc: 'null target', target: null },
    { desc: 'array target', target: [] },
    { desc: 'missing path', target: { data: {} } },
    { desc: 'non-map data', target: { path: 'classrooms/classA/studentCredentials/alex-smith', data: [] } },
    { desc: 'unsupported field', target: { path: 'classrooms/classA/studentCredentials/alex-smith', data: {}, secret: 'x' } },
  ]

  for (const { desc, target } of malformedTargets) {
    assert.throws(
      () => projectAndReconcileScopedCredentials({
        sources,
        targets: [target],
        targetClassroomId: 'classA',
      }),
      (err) => err instanceof ScopedCredentialProjectionError &&
        err.code === 'malformed-target-envelope',
      `Failed on ${desc}`,
    )
  }

  // Two target envelopes for one path are ambiguous; the later one must not
  // silently win the reconciliation comparison.
  const projected = projectScopedCredential(sources[0], 'classA')
  assert.throws(
    () => projectAndReconcileScopedCredentials({
      sources,
      targets: [
        { path: projected.targetPath, data: projected.projectedData },
        { path: projected.targetPath, data: { ...projected.projectedData, pinHash: 'other' } },
      ],
      targetClassroomId: 'classA',
    }),
    (err) => err instanceof ScopedCredentialProjectionError &&
      err.code === 'duplicate-target-envelope',
  )
})

test('exact rerun/idempotency and missing target reconciliation', () => {
  const sources = [
    flatSource('alex-smith', { studentId: 'stu_1', pinHash: '$2b$10$hash1', active: true }),
    flatSource('bob-jones', { studentId: 'stu_2', pinHash: '$2b$10$hash2', active: true }),
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

test('timestamp-bearing credentials rerun as exact parity across Date and Timestamp reads', () => {
  const source = flatSource('alex-smith', {
    studentId: 'stu_1',
    pinHash: '$2b$10$hash1',
    active: true,
    createdAt: new Date('2025-03-04T05:06:07.008Z'),
  })

  const projected = projectScopedCredential(source, 'classA')

  // The scoped read returns an Admin SDK Timestamp for the same instant.
  const timestampTarget = {
    path: projected.targetPath,
    data: {
      ...projected.projectedData,
      createdAt: new FakeTimestamp(
        Math.floor(new Date('2025-03-04T05:06:07.008Z').getTime() / 1000),
        8_000_000,
      ),
    },
  }

  const parity = projectAndReconcileScopedCredentials({
    sources: [source],
    targets: [timestampTarget],
    targetClassroomId: 'classA',
    strict: true,
  })
  assert.equal(parity.stats.exactParity, 1)

  // A genuinely different instant is divergent, not parity.
  const divergentTarget = {
    path: projected.targetPath,
    data: {
      ...projected.projectedData,
      createdAt: new FakeTimestamp(1, 0),
    },
  }
  assert.throws(
    () => projectAndReconcileScopedCredentials({
      sources: [source],
      targets: [divergentTarget],
      targetClassroomId: 'classA',
      strict: true,
    }),
    (err) => err instanceof ScopedCredentialProjectionError && err.code === 'target-divergence',
  )
})

test('firestoreValuesEqual: Firestore value parity does not falsely accept or reject', () => {
  // Timestamps: same instant across representations is equal.
  assert.equal(
    firestoreValuesEqual(new Date('2025-01-01T00:00:00.500Z'), new FakeTimestamp(1735689600, 500_000_000)),
    true,
  )
  assert.equal(firestoreValuesEqual(new FakeTimestamp(1, 2), new FakeTimestamp(1, 2)), true)
  assert.equal(firestoreValuesEqual(new FakeTimestamp(1, 2), new FakeTimestamp(1, 3)), false)

  // A plain map is not a timestamp even with the same fields.
  assert.equal(firestoreValuesEqual({ seconds: 1, nanoseconds: 2 }, new FakeTimestamp(1, 2)), false)

  // Arrays are not maps with numeric keys.
  assert.equal(firestoreValuesEqual([1, 2], { 0: 1, 1: 2 }), false)
  assert.equal(firestoreValuesEqual([1, [2, { a: 3 }]], [1, [2, { a: 3 }]]), true)
  assert.equal(firestoreValuesEqual([1, 2], [2, 1]), false)

  // Bytes compare by content.
  assert.equal(firestoreValuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true)
  assert.equal(firestoreValuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false)

  // Nested maps, null handling, and NaN stability.
  assert.equal(firestoreValuesEqual({ a: { b: null } }, { a: { b: null } }), true)
  assert.equal(firestoreValuesEqual({ a: undefined }, {}), false)
  assert.equal(firestoreValuesEqual(Number.NaN, Number.NaN), true)
  assert.equal(firestoreValuesEqual(0, '0'), false)
})

test('divergence without secret leakage', () => {
  const sources = [
    flatSource('alex-smith', {
      studentId: 'stu_1',
      pinHash: '$2b$10$secret_source_hash',
      active: true,
    }),
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

  // Non-strict reconciliation reports divergence without exposing either body.
  const report = projectAndReconcileScopedCredentials({
    sources,
    targets,
    targetClassroomId: 'classA',
    strict: false,
  })
  assert.equal(report.stats.divergent, 1)
  const serializedReport = JSON.stringify(report.stats)
  assert.ok(!serializedReport.includes('secret_source_hash'))
  assert.ok(!serializedReport.includes('different_target_hash'))
})

test('old/new UID and claims-identity reconciliation', () => {
  const sourceEnvelope = flatSource('alex-smith', {
    studentId: 'stu_99',
    authUid: 'old_legacy_uid_123',
    pinHash: 'h1',
    active: true,
  })

  const projection = projectScopedCredential(sourceEnvelope, 'classA')
  const uidMap = projection.uidMapping

  assert.equal(uidMap.oldAuthUid, 'old_legacy_uid_123')
  assert.equal(uidMap.classroomId, 'classA')
  assert.equal(uidMap.studentId, 'stu_99')

  const expectedNewUid = deriveDeterministicStudentAuthUid('classA', 'stu_99')
  assert.equal(uidMap.newAuthUid, expectedNewUid)
})
