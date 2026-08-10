import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { URL } from 'node:url'

import { hashCanonicalState } from './canonicalState.js'
import { buildMigrationProjection } from './projection.js'
import {
  RECONCILIATION_ERROR_CATEGORIES,
  RECONCILIATION_MODES,
  ReconciliationError,
  reconcileDryRun,
  reconcileWriteRun,
} from './reconciliation.js'

const CLASSROOM_ID = 'generated-classroom-1'
const TEACHER_UID = 'teacher-uid-1'

function envelope(path, data, updateTime = { token: `${path}-time` }) {
  return {
    id: path.split('/').at(-1),
    path,
    data,
    updateTime,
  }
}

function sourceFixture() {
  return {
    classroomData: envelope('morganBank/classroomData', {
      students: [
        {
          id: 1,
          name: 'Ada',
          balance: '12.5',
          frozen: false,
          pin: 'plaintext-source-only',
          loginId: 'ada-login',
          credentialActive: true,
          unknownStudentField: 'must-not-migrate',
        },
        {
          id: 'student-2',
          name: 'Grace',
          balance: -2.5,
          frozen: true,
        },
      ],
      transactions: [
        {
          id: 'transaction-1',
          studentId: 1,
          amount: 4,
          unknownTransactionField: { retained: true },
        },
        {
          id: 2,
          studentId: 'student-2',
          amount: -2,
        },
      ],
      loginHistory: [
        {
          id: 'history-1',
          studentId: 1,
          result: 'success',
          unknownHistoryField: ['retained'],
        },
      ],
      settings: {
        currencyName: 'Class Cash',
        nested: { allowance: 5 },
      },
    }),
    studentCredentials: [
      envelope('studentCredentials/ada-login', {
        classroomId: 'morgan',
        studentId: '1',
        active: true,
        pinHash: 'secret-active-hash',
        unknownCredentialField: { retained: true },
      }),
      envelope('studentCredentials/inactive-login', {
        classroomId: 'morgan',
        studentId: 'student-2',
        active: false,
        pinHash: 'secret-inactive-hash',
      }),
      envelope('studentCredentials/orphan-login', {
        classroomId: 'morgan',
        studentId: 'removed-student',
        active: true,
        pinHash: 'secret-orphan-hash',
      }),
    ],
    studentAuthLogs: [
      envelope('studentAuthLogs/log-a', {
        loginId: 'ada-login',
        success: true,
        unknownLogField: { retained: true },
      }),
      envelope('studentAuthLogs/log-b', {
        classroomId: 'morgan',
        loginId: 'inactive-login',
        success: false,
      }),
    ],
  }
}

function foundationFixture() {
  return {
    teacherUid: TEACHER_UID,
    classroomId: CLASSROOM_ID,
    teacher: envelope(`teachers/${TEACHER_UID}`, {
      uid: TEACHER_UID,
      classroomId: CLASSROOM_ID,
      status: 'active',
      createdAt: { seconds: 1 },
      updatedAt: { seconds: 1 },
      displayName: 'Teacher',
    }),
    classroom: envelope(`classrooms/${CLASSROOM_ID}`, {
      ownerUid: TEACHER_UID,
      name: 'Classroom',
      createdAt: { seconds: 2 },
      updatedAt: { seconds: 2 },
      version: 1,
      settings: {},
      foundationUnknownField: { mustRemain: true },
    }),
  }
}

function checksumBundle(projection, salt = 'stable') {
  return {
    immutableSourceChecksum: hashCanonicalState({ salt, type: 'source' }),
    foundationInvariantChecksum: hashCanonicalState({
      salt,
      type: 'foundation',
    }),
    planChecksum: hashCanonicalState({ salt, type: 'plan' }),
    credentialInvariantHashes: Object.fromEntries(
      projection.studentCredentials.map(credential => [
        credential.path,
        hashCanonicalState({ salt, path: credential.path }),
      ]),
    ),
  }
}

function copyDestinationEntry(entry) {
  return {
    id: entry.id,
    path: entry.path,
    data: { ...entry.data },
    updateTime: { token: `${entry.path}-actual-time` },
  }
}

function actualFixture(source, foundation, projection) {
  return {
    teacher: envelope(
      foundation.teacher.path,
      { ...foundation.teacher.data },
      foundation.teacher.updateTime,
    ),
    classroom: envelope(projection.classroom.path, {
      ...foundation.classroom.data,
      settings: projection.classroom.data.settings,
      lastBackupAt: projection.classroom.data.lastBackupAt,
    }),
    legacyClassroomData: envelope(
      source.classroomData.path,
      source.classroomData.data,
      source.classroomData.updateTime,
    ),
    students: projection.students.map(copyDestinationEntry),
    transactions: projection.transactions.map(copyDestinationEntry),
    loginHistory: projection.loginHistory.map(copyDestinationEntry),
    studentCredentials: projection.studentCredentials.map(copyDestinationEntry),
    studentAuthLogs: projection.studentAuthLogs.map(copyDestinationEntry),
    originalStudentAuthLogs: source.studentAuthLogs.map(log => envelope(
      log.path,
      { ...log.data },
      log.updateTime,
    )),
  }
}

function scenario() {
  const source = sourceFixture()
  const foundation = foundationFixture()
  const projection = buildMigrationProjection({
    classroomId: CLASSROOM_ID,
    ...source,
  })
  const expectedChecksums = checksumBundle(projection)
  const observedChecksums = {
    ...expectedChecksums,
    credentialInvariantHashes: {
      ...expectedChecksums.credentialInvariantHashes,
    },
  }

  return {
    source,
    foundation,
    projection,
    expectedChecksums,
    observedChecksums,
    actual: actualFixture(source, foundation, projection),
  }
}

function assertReconciliationError(category, area = null) {
  return error => {
    assert.ok(error instanceof ReconciliationError)
    assert.equal(error.code, 'PHASE2A_RECONCILIATION_ERROR')
    assert.equal(error.category, category)
    assert.equal(error.blocking, true)

    if (area !== null) {
      assert.equal(
        error.details.issues.some(current => current.area === area),
        true,
      )
    }

    return true
  }
}

test('dry-run reconciliation verifies the complete projection and checksums', () => {
  const current = scenario()
  const summary = reconcileDryRun({
    source: current.source,
    foundation: current.foundation,
    projection: current.projection,
    expectedChecksums: current.expectedChecksums,
    observedChecksums: current.observedChecksums,
  })

  assert.deepEqual(summary, {
    mode: RECONCILIATION_MODES.DRY_RUN,
    passed: true,
    counts: {
      students: 2,
      transactions: 2,
      loginHistory: 1,
      studentCredentials: 3,
      studentAuthLogs: 2,
      orphanedCredentials: 1,
    },
    equality: {
      foundation: true,
      classroomMetadata: true,
      students: true,
      transactions: true,
      loginHistory: true,
      studentCredentials: true,
      studentAuthLogs: true,
      originalSources: true,
      checksums: true,
    },
  })
  assert.equal(Object.isFrozen(summary), true)
  assert.equal(Object.isFrozen(summary.counts), true)
})

test('dry-run reconciliation blocks a projection with leaked student fields', () => {
  const current = scenario()
  const projection = {
    ...current.projection,
    students: current.projection.students.map((student, index) => index === 0
      ? {
          ...student,
          data: { ...student.data, pin: 'leaked-plaintext' },
        }
      : student),
  }

  assert.throws(
    () => reconcileDryRun({
      source: current.source,
      foundation: current.foundation,
      projection,
      expectedChecksums: current.expectedChecksums,
      observedChecksums: current.observedChecksums,
    }),
    assertReconciliationError(
      RECONCILIATION_ERROR_CATEGORIES.DRY_RUN_MISMATCH,
      'projection',
    ),
  )
})

test('dry-run reconciliation blocks every checksum class mismatch', () => {
  const mutations = [
    observed => {
      observed.immutableSourceChecksum = hashCanonicalState({ changed: 'source' })
    },
    observed => {
      observed.foundationInvariantChecksum = hashCanonicalState({
        changed: 'foundation',
      })
    },
    observed => {
      observed.planChecksum = hashCanonicalState({ changed: 'plan' })
    },
    observed => {
      observed.credentialInvariantHashes['studentCredentials/ada-login'] =
        hashCanonicalState({ changed: 'credential' })
    },
  ]

  for (const mutate of mutations) {
    const current = scenario()
    mutate(current.observedChecksums)

    assert.throws(
      () => reconcileDryRun({
        source: current.source,
        foundation: current.foundation,
        projection: current.projection,
        expectedChecksums: current.expectedChecksums,
        observedChecksums: current.observedChecksums,
      }),
      assertReconciliationError(
        RECONCILIATION_ERROR_CATEGORIES.DRY_RUN_MISMATCH,
        'checksums',
      ),
    )
  }
})

test('write-run reconciliation verifies all destinations and unchanged sources', () => {
  const current = scenario()
  const summary = reconcileWriteRun(current)

  assert.equal(summary.mode, RECONCILIATION_MODES.WRITE)
  assert.equal(summary.passed, true)
  assert.equal(summary.counts.studentCredentials, 3)
  assert.equal(summary.counts.orphanedCredentials, 1)
  assert.equal(summary.equality.originalSources, true)
  assert.equal(
    current.actual.studentCredentials.every(credential =>
      credential.data.classroomId === CLASSROOM_ID),
    true,
  )
  assert.equal(
    current.actual.studentAuthLogs.some(log =>
      Object.hasOwn(log.data, 'classroomId')),
    false,
  )
})

test('write-run blocks foundation and classroom-root drift', () => {
  const cases = [
    {
      area: 'foundation-teacher',
      mutate: current => {
        current.actual.teacher.data.status = 'changed'
      },
    },
    {
      area: 'classroom-root',
      mutate: current => {
        current.actual.classroom.data.ownerUid = 'other-teacher'
      },
    },
    {
      area: 'classroom-root',
      mutate: current => {
        current.actual.classroom.data.settings = { wrong: true }
      },
    },
    {
      area: 'classroom-root',
      mutate: current => {
        delete current.actual.classroom.data.foundationUnknownField
      },
    },
  ]

  for (const currentCase of cases) {
    const current = scenario()
    currentCase.mutate(current)

    assert.throws(
      () => reconcileWriteRun(current),
      assertReconciliationError(
        RECONCILIATION_ERROR_CATEGORIES.WRITE_RUN_MISMATCH,
        currentCase.area,
      ),
    )
  }
})

test('write-run blocks student count, path, body, key, order, and balance drift', () => {
  const cases = [
    current => {
      current.actual.students.pop()
    },
    current => {
      current.actual.students[0].path =
        `classrooms/${CLASSROOM_ID}/students/wrong`
    },
    current => {
      current.actual.students[0].data.name = 'Changed'
    },
    current => {
      current.actual.students[0].data.pin = 'forbidden'
    },
    current => {
      current.actual.students[0].data.transactions = [
        ...current.actual.students[0].data.transactions,
      ].reverse()
      current.actual.students[0].data.transactions.push({ id: 'extra' })
    },
    current => {
      current.actual.students[0].data.balance = 999
    },
  ]

  for (const mutate of cases) {
    const current = scenario()
    mutate(current)

    assert.throws(
      () => reconcileWriteRun(current),
      assertReconciliationError(
        RECONCILIATION_ERROR_CATEGORIES.WRITE_RUN_MISMATCH,
        'students',
      ),
    )
  }
})

test('write-run blocks transaction and login-history count, path, and body drift', () => {
  const cases = [
    {
      area: 'transactions',
      mutate: current => {
        current.actual.transactions[0].data.unknownTransactionField = 'changed'
      },
    },
    {
      area: 'transactions',
      mutate: current => {
        current.actual.transactions[0].path =
          `classrooms/${CLASSROOM_ID}/transactions/wrong`
      },
    },
    {
      area: 'login-history',
      mutate: current => {
        current.actual.loginHistory = []
      },
    },
    {
      area: 'login-history',
      mutate: current => {
        current.actual.loginHistory[0].data.unknownHistoryField = []
      },
    },
  ]

  for (const currentCase of cases) {
    const current = scenario()
    currentCase.mutate(current)

    assert.throws(
      () => reconcileWriteRun(current),
      assertReconciliationError(
        RECONCILIATION_ERROR_CATEGORIES.WRITE_RUN_MISMATCH,
        currentCase.area,
      ),
    )
  }
})

test('write-run blocks missing or modified credentials without leaking secrets', () => {
  const missing = scenario()
  missing.actual.studentCredentials.pop()
  assert.throws(
    () => reconcileWriteRun(missing),
    assertReconciliationError(
      RECONCILIATION_ERROR_CATEGORIES.WRITE_RUN_MISMATCH,
      'student-credentials',
    ),
  )

  const modified = scenario()
  modified.actual.studentCredentials[0].data.pinHash = 'changed-secret-hash'
  assert.throws(
    () => reconcileWriteRun(modified),
    error => {
      assertReconciliationError(
        RECONCILIATION_ERROR_CATEGORIES.WRITE_RUN_MISMATCH,
        'student-credentials',
      )(error)
      const serialized = `${error.message} ${JSON.stringify(error.details)}`
      assert.equal(serialized.includes('pinHash'), false)
      assert.equal(serialized.includes('changed-secret-hash'), false)
      assert.equal(serialized.includes('secret-active-hash'), false)
      return true
    },
  )
})

test('write-run blocks auth-log destination and original-source drift', () => {
  const destination = scenario()
  destination.actual.studentAuthLogs[0].data.classroomId = CLASSROOM_ID
  assert.throws(
    () => reconcileWriteRun(destination),
    assertReconciliationError(
      RECONCILIATION_ERROR_CATEGORIES.WRITE_RUN_MISMATCH,
      'student-auth-logs',
    ),
  )

  const original = scenario()
  original.actual.originalStudentAuthLogs[0].data.success = false
  assert.throws(
    () => reconcileWriteRun(original),
    assertReconciliationError(
      RECONCILIATION_ERROR_CATEGORIES.WRITE_RUN_MISMATCH,
      'original-student-auth-logs',
    ),
  )

  const classroomSource = scenario()
  classroomSource.actual.legacyClassroomData.data = {
    ...classroomSource.actual.legacyClassroomData.data,
    unexpectedMutation: true,
  }
  assert.throws(
    () => reconcileWriteRun(classroomSource),
    assertReconciliationError(
      RECONCILIATION_ERROR_CATEGORIES.WRITE_RUN_MISMATCH,
      'legacy-classroom-source',
    ),
  )
})

test('fails closed on malformed checksum sets, missing write state, and unknown args', () => {
  const missingCredentialHash = scenario()
  delete missingCredentialHash.observedChecksums
    .credentialInvariantHashes['studentCredentials/orphan-login']
  assert.throws(
    () => reconcileDryRun({
      source: missingCredentialHash.source,
      foundation: missingCredentialHash.foundation,
      projection: missingCredentialHash.projection,
      expectedChecksums: missingCredentialHash.expectedChecksums,
      observedChecksums: missingCredentialHash.observedChecksums,
    }),
    assertReconciliationError(
      RECONCILIATION_ERROR_CATEGORIES.DRY_RUN_MISMATCH,
      'checksums',
    ),
  )

  const malformedExpected = scenario()
  malformedExpected.expectedChecksums.planChecksum = 'not-a-hash'
  assert.throws(
    () => reconcileDryRun({
      source: malformedExpected.source,
      foundation: malformedExpected.foundation,
      projection: malformedExpected.projection,
      expectedChecksums: malformedExpected.expectedChecksums,
      observedChecksums: malformedExpected.observedChecksums,
    }),
    assertReconciliationError(
      RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )

  const missingActual = scenario()
  delete missingActual.actual
  assert.throws(
    () => reconcileWriteRun(missingActual),
    assertReconciliationError(
      RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )

  const unknown = scenario()
  unknown.write = true
  assert.throws(
    () => reconcileWriteRun(unknown),
    assertReconciliationError(
      RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )
})

test('reconciliation module remains pure, read-only, and Firestore-free', async () => {
  const source = await readFile(
    new URL('./reconciliation.js', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(source, /firebase-admin|firebase-functions|getFirestore/)
  assert.doesNotMatch(
    source,
    /\.(?:update|create|commit|batch|bulkWriter|runTransaction)\s*\(/,
  )
  assert.doesNotMatch(source, /\.(?:collection|doc)\s*\(/)
})
