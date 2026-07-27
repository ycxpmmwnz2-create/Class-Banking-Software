import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { URL } from 'node:url'

import { buildProductionProjection } from './productionProjection.js'
import {
  PRODUCTION_RECONCILIATION_CATEGORIES,
  PRODUCTION_RECONCILIATION_MODES,
  ProductionReconciliationError,
  assertRetainedSourceEvidence,
  reconcileProductionDryRun,
  reconcileProductionWriteRun,
} from './productionReconciliation.js'

const CLASSROOM_ID = 'classroom-abc123'
const TEACHER_UID = 'teacher-uid-123'

class FakeTimestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds
    this.nanoseconds = nanoseconds
  }

  toMillis() {
    return this.seconds * 1_000 + Math.floor(this.nanoseconds / 1e6)
  }

  isEqual(other) {
    return other instanceof FakeTimestamp &&
      other.seconds === this.seconds &&
      other.nanoseconds === this.nanoseconds
  }
}

function clone(value) {
  if (value instanceof FakeTimestamp) {
    return new FakeTimestamp(value.seconds, value.nanoseconds)
  }
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (Array.isArray(value)) return value.map(clone)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, clone(nested)]),
    )
  }
  return value
}

function envelope(collection, id, data, sequence) {
  return {
    id,
    path: `${collection}/${id}`,
    data,
    updateTime: new FakeTimestamp(1_780_000_000 + sequence, sequence),
  }
}

function sourceFixture() {
  return {
    classroomData: {
      id: 'classroomData',
      path: 'morganBank/classroomData',
      updateTime: new FakeTimestamp(1_780_000_000, 987_654_321),
      data: {
        students: [
          { id: 7, name: 'Ada', balance: 12, frozen: false, pin: '1234' },
          { id: 8, name: 'Blaise', balance: 4, frozen: true, pin: '5678' },
        ],
        transactions: [
          { id: 10, studentId: 7, amount: 5, order: 1 },
          { id: 11, studentId: 8, amount: -2, order: 2 },
        ],
        loginHistory: [
          { id: 20, studentId: 7, result: 'success' },
        ],
        settings: { currencyName: 'Class Cash' },
        lastBackupAt: new FakeTimestamp(1_700_000_000, 222_333_444),
      },
    },
    studentCredentials: [
      envelope('studentCredentials', 'ada-login', {
        classroomId: 'morgan',
        studentId: '7',
        authUid: 'legacy-uid-7',
        active: true,
        pinHash: 'secret-hash-7',
        bytes: new Uint8Array([7, 8]),
      }, 1),
      envelope('studentCredentials', 'blaise-login', {
        classroomId: 'morgan',
        studentId: '8',
        authUid: 'legacy-uid-8',
        active: false,
        pinHash: 'secret-hash-8',
      }, 2),
    ],
    studentAuthLogs: [
      envelope('studentAuthLogs', 'log-a', {
        classroomId: 'morgan',
        studentId: '7',
        success: true,
      }, 3),
    ],
  }
}

function foundationFixture() {
  return {
    teacherUid: TEACHER_UID,
    classroomId: CLASSROOM_ID,
    teacher: envelope('teachers', TEACHER_UID, {
      uid: TEACHER_UID,
      classroomId: CLASSROOM_ID,
      status: 'active',
      displayName: 'Mr. Morgan',
    }, 10),
    classroom: envelope('classrooms', CLASSROOM_ID, {
      ownerUid: TEACHER_UID,
      name: 'Class Banking',
      version: 1,
      createdAt: new FakeTimestamp(1_600_000_000, 1),
      updatedAt: new FakeTimestamp(1_700_000_000, 2),
      nextStudentNumber: 100,
      loginCode: 'ABCDEFGH',
      settings: { old: true },
      lastBackupAt: null,
    }, 11),
  }
}

function destinationEntry(entry, sequence) {
  return {
    id: entry.id,
    path: entry.path,
    data: clone(entry.data),
    updateTime: new FakeTimestamp(1_790_000_000 + sequence, sequence),
  }
}

/**
 * The Release Order step 9 initialization result: the reserved classroom code in
 * both renderings, plus the monotonic student counter.
 */
const CANONICAL_LOGIN_CODE = 'BCDFGHJK'

function initializationFixture(overrides = {}) {
  return {
    canonicalLoginCode: CANONICAL_LOGIN_CODE,
    formattedLoginCode: 'BCDF-GHJK',
    nextStudentNumber: 100,
    ...overrides,
  }
}

function scenario() {
  const source = sourceFixture()
  const foundation = foundationFixture()
  const initialization = initializationFixture()
  const projection = buildProductionProjection({
    classroomId: CLASSROOM_ID,
    ...source,
  })
  const actual = {
    teacher: clone(foundation.teacher),
    classroom: {
      id: CLASSROOM_ID,
      path: `classrooms/${CLASSROOM_ID}`,
      data: {
        ...clone(foundation.classroom.data),
        // Initialization contributes exactly these two fields; every other
        // foundation field is preserved verbatim.
        studentLoginCode: initialization.formattedLoginCode,
        nextStudentNumber: initialization.nextStudentNumber,
        settings: clone(projection.classroom.data.settings),
        lastBackupAt: clone(projection.classroom.data.lastBackupAt),
      },
      updateTime: new FakeTimestamp(1_790_000_000, 1),
    },
    loginCodeIndex: {
      id: CANONICAL_LOGIN_CODE,
      path: `classroomLoginCodes/${CANONICAL_LOGIN_CODE}`,
      data: {
        classroomId: CLASSROOM_ID,
        status: 'active',
        createdAt: new FakeTimestamp(1_790_000_000, 1),
      },
      updateTime: new FakeTimestamp(1_790_000_000, 1),
    },
    legacyClassroomData: clone(source.classroomData),
    flatCredentials: clone(source.studentCredentials).reverse(),
    flatAuthLogs: clone(source.studentAuthLogs),
    students: projection.students.map(destinationEntry),
    transactions: projection.transactions.map(destinationEntry),
    loginHistory: projection.loginHistory.map(destinationEntry),
    scopedCredentials: projection.scopedCredentials.map(destinationEntry),
    scopedAuthLogs: projection.scopedAuthLogs.map(destinationEntry),
  }
  return { source, foundation, projection, actual, initialization }
}

function assertReconciliationError(category, inspect = () => {}) {
  return error => {
    assert.ok(error instanceof ProductionReconciliationError)
    assert.equal(error.code, 'PHASE3_PRODUCTION_RECONCILIATION_ERROR')
    assert.equal(error.category, category)
    assert.equal(error.blocking, true)
    inspect(error)
    return true
  }
}

function writeRun(state) {
  return reconcileProductionWriteRun(state)
}

test('dry-run recomputes and accepts the exact copy-only projection', () => {
  const { source, projection } = scenario()
  const result = reconcileProductionDryRun({
    classroomId: CLASSROOM_ID,
    source,
    projection,
  })

  assert.deepEqual(result, {
    mode: PRODUCTION_RECONCILIATION_MODES.DRY_RUN,
    passed: true,
    counts: {
      students: 2,
      transactions: 2,
      loginHistory: 1,
      scopedCredentials: 2,
      scopedAuthLogs: 1,
      orphanedCredentials: 0,
    },
    equality: { projection: true, uidMappings: true },
  })
})

test('dry-run blocks a caller-supplied projection that drifted from source', () => {
  const { source, projection } = scenario()
  const divergent = { ...projection, counts: { ...projection.counts, students: 1 } }

  assert.throws(
    () => reconcileProductionDryRun({
      classroomId: CLASSROOM_ID,
      source,
      projection: divergent,
    }),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.DRY_RUN_MISMATCH,
      error => {
        assert.deepEqual(error.details.issues, [{
          area: 'projection',
          reason: 'projection-does-not-match-source',
        }])
      },
    ),
  )
})

test('write-run verifies every destination and immutable source surface', () => {
  const state = scenario()
  const result = writeRun(state)

  assert.equal(result.mode, PRODUCTION_RECONCILIATION_MODES.WRITE_RUN)
  assert.equal(result.passed, true)
  assert.deepEqual(result.counts, state.projection.counts)
  assert.deepEqual(result.equality, {
    projection: true,
    uidMappings: true,
    foundation: true,
    classroomMetadata: true,
    loginCodeIndex: true,
    students: true,
    transactions: true,
    loginHistory: true,
    scopedCredentials: true,
    scopedAuthLogs: true,
    legacyClassroomSource: true,
    flatCredentialsSource: true,
    flatAuthLogsSource: true,
  })
})

test('write-run requires the initialized classroom fields and code index', () => {
  // Initialization is reconciled as part of the copy result, so a copy that
  // completed against a classroom missing its reserved code or counter cannot
  // report success.
  for (const mutate of [
    state => { delete state.actual.classroom.data.studentLoginCode },
    state => { delete state.actual.classroom.data.nextStudentNumber },
    state => { state.actual.classroom.data.studentLoginCode = 'WXYZ-WXYZ' },
    state => { state.actual.classroom.data.nextStudentNumber = 1 },
  ]) {
    const state = scenario()
    mutate(state)
    assert.throws(
      () => writeRun(state),
      assertReconciliationError(
        PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
        error => {
          assert.ok(error.details.issues.some(
            issue => issue.area === 'classroom-root',
          ))
        },
      ),
      'a missing or wrong initialized classroom field must block',
    )
  }
})

test('write-run blocks a missing, misdirected, or over-wide code index', () => {
  const cases = [
    ['missing', state => { state.actual.loginCodeIndex = undefined }],
    ['wrong classroom', state => {
      state.actual.loginCodeIndex.data.classroomId = 'another-classroom'
    }],
    ['inactive status', state => {
      state.actual.loginCodeIndex.data.status = 'revoked'
    }],
    ['extra field', state => {
      state.actual.loginCodeIndex.data.note = 'unreviewed'
    }],
    ['wrong document id', state => {
      state.actual.loginCodeIndex.id = 'WXYZWXYZ'
      state.actual.loginCodeIndex.path = 'classroomLoginCodes/WXYZWXYZ'
    }],
  ]
  for (const [label, mutate] of cases) {
    const state = scenario()
    mutate(state)
    assert.throws(
      () => writeRun(state),
      assertReconciliationError(
        PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
        error => {
          assert.ok(error.details.issues.some(
            issue => issue.area === 'login-code-index',
          ))
        },
      ),
      `${label} code index must block`,
    )
  }
})

test('write-run rejects inconsistent initialization inputs', () => {
  const cases = [
    ['non-canonical code', { canonicalLoginCode: 'bcdfghjk' }],
    ['formatted mismatch', { formattedLoginCode: 'WXYZ-WXYZ' }],
    ['invalid code', { canonicalLoginCode: 'BCDF0HJK' }],
    ['zero counter', { nextStudentNumber: 0 }],
    ['non-integer counter', { nextStudentNumber: 1.5 }],
  ]
  for (const [label, override] of cases) {
    const state = scenario()
    state.initialization = { ...state.initialization, ...override }
    assert.throws(
      () => writeRun(state),
      assertReconciliationError(
        PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      ),
      `${label} must be rejected before comparison`,
    )
  }
})

test('write-run attributes caller projection identity drift to foundation', () => {
  const state = scenario()
  state.projection = {
    ...state.projection,
    classroomId: 'different-classroom',
    classroom: {
      ...state.projection.classroom,
      path: 'classrooms/different-classroom',
    },
  }

  assert.throws(
    () => writeRun(state),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'projection' &&
          issue.reason === 'projection-does-not-match-source'))
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'foundation' &&
          issue.reason === 'classroom-identity-mismatch'))
      },
    ),
  )
})

test('write-run blocks missing, extra, and divergent destination documents', () => {
  const cases = [
    {
      name: 'missing student',
      mutate: state => state.actual.students.pop(),
      expectedArea: 'students',
      expectedReason: 'document-count-mismatch',
    },
    {
      name: 'extra transaction',
      mutate: state => state.actual.transactions.push({
        id: 'extra',
        path: `classrooms/${CLASSROOM_ID}/transactions/extra`,
        data: { id: 'extra', studentId: '7', amount: 1 },
      }),
      expectedArea: 'transactions',
      expectedReason: 'document-count-mismatch',
    },
    {
      name: 'divergent history',
      mutate: state => {
        state.actual.loginHistory[0].data.result = 'failure'
      },
      expectedArea: 'login-history',
      expectedReason: 'document-body-mismatch',
    },
    {
      name: 'divergent scoped credential',
      mutate: state => {
        state.actual.scopedCredentials[0].data.active = false
      },
      expectedArea: 'scoped-credentials',
      expectedReason: 'document-body-mismatch',
    },
    {
      name: 'divergent scoped log',
      mutate: state => {
        state.actual.scopedAuthLogs[0].data.success = false
      },
      expectedArea: 'scoped-auth-logs',
      expectedReason: 'document-body-mismatch',
    },
  ]

  for (const current of cases) {
    const state = scenario()
    current.mutate(state)
    assert.throws(
      () => writeRun(state),
      assertReconciliationError(
        PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
        error => {
          assert.ok(
            error.details.issues.some(issue =>
              issue.area === current.expectedArea &&
              issue.reason === current.expectedReason),
            `${current.name} was not attributed correctly`,
          )
        },
      ),
    )
  }
})

test('write-run blocks duplicate and path-only destination divergence', () => {
  const duplicate = scenario()
  duplicate.actual.transactions[1] = clone(duplicate.actual.transactions[0])
  assert.throws(
    () => writeRun(duplicate),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'transactions' &&
          issue.reason === 'duplicate-document-path'))
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'transactions' &&
          issue.reason === 'document-path-set-mismatch'))
      },
    ),
  )

  const pathDrift = scenario()
  pathDrift.actual.loginHistory[0].path =
    `classrooms/${CLASSROOM_ID}/loginHistory/different`
  assert.throws(
    () => writeRun(pathDrift),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'login-history' &&
          issue.reason === 'document-path-set-mismatch'))
      },
    ),
  )
})

test('flat credential bodies and exact update times are immutable', () => {
  const bodyDrift = scenario()
  bodyDrift.actual.flatCredentials[0].data.pinHash = 'changed-secret-hash'
  assert.throws(
    () => writeRun(bodyDrift),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'flat-credentials-source' &&
          issue.reason === 'document-body-mismatch'))
        assert.equal(JSON.stringify(error).includes('secret-hash'), false)
        assert.equal(JSON.stringify(error).includes('changed-secret'), false)
      },
    ),
  )

  const timestampDrift = scenario()
  timestampDrift.actual.flatCredentials[0].updateTime.nanoseconds += 1
  assert.throws(
    () => writeRun(timestampDrift),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'flat-credentials-source' &&
          issue.reason === 'source-update-time-mismatch'))
      },
    ),
  )
})

test('legacy classroom, flat logs, and teacher foundation are immutable', () => {
  const cases = [
    {
      mutate: state => {
        state.actual.legacyClassroomData.data.settings.currencyName = 'Drift'
      },
      area: 'legacy-classroom-source',
    },
    {
      mutate: state => {
        state.actual.flatAuthLogs[0].data.success = false
      },
      area: 'flat-auth-logs-source',
    },
    {
      mutate: state => {
        state.actual.teacher.data.status = 'disabled'
      },
      area: 'foundation-teacher',
    },
  ]

  for (const current of cases) {
    const state = scenario()
    current.mutate(state)
    assert.throws(
      () => writeRun(state),
      assertReconciliationError(
        PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
        error => {
          assert.ok(error.details.issues.some(issue =>
            issue.area === current.area &&
            issue.reason === 'document-body-mismatch'))
        },
      ),
    )
  }
})

test('classroom reconciliation permits only the projected copy fields to change', () => {
  const identityDrift = scenario()
  identityDrift.actual.classroom.data.ownerUid = 'different-teacher'
  assert.throws(
    () => writeRun(identityDrift),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'classroom-root' &&
          issue.reason === 'document-body-mismatch'))
      },
    ),
  )

  const extraField = scenario()
  extraField.actual.classroom.data.unreviewedField = true
  assert.throws(
    () => writeRun(extraField),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
    ),
  )
})

test('UID mappings are independently checked against scoped credential bodies', () => {
  const state = scenario()
  state.actual.scopedCredentials[0].data.authUid = 's_wrong'

  assert.throws(
    () => writeRun(state),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'uid-mappings' &&
          issue.reason === 'identity-mapping-mismatch'))
      },
    ),
  )
})

test('scoped auth logs may not regain a classroomId field', () => {
  const state = scenario()
  state.actual.scopedAuthLogs[0].data.classroomId = CLASSROOM_ID

  assert.throws(
    () => writeRun(state),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'scoped-auth-logs' &&
          issue.reason === 'destination-retains-classroom-id'))
      },
    ),
  )
})

test('student allowlist and total balance are checked independently', () => {
  const forbidden = scenario()
  forbidden.actual.students[0].data.pin = '9999'
  assert.throws(
    () => writeRun(forbidden),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'students' &&
          issue.reason === 'forbidden-or-unlisted-key'))
        assert.equal(JSON.stringify(error).includes('9999'), false)
      },
    ),
  )

  const balance = scenario()
  balance.actual.students[0].data.balance += 1
  assert.throws(
    () => writeRun(balance),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      error => {
        assert.ok(error.details.issues.some(issue =>
          issue.area === 'students' &&
          issue.reason === 'total-balance-mismatch'))
      },
    ),
  )

  for (const invalidBalance of ['12', Number.NaN]) {
    const invalid = scenario()
    invalid.actual.students[0].data.balance = invalidBalance
    assert.throws(
      () => writeRun(invalid),
      assertReconciliationError(
        PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
        error => {
          assert.ok(error.details.issues.some(issue =>
            issue.area === 'students' && issue.reason === 'invalid-balance'))
          assert.ok(error.details.issues.some(issue =>
            issue.area === 'students' &&
            issue.reason === 'total-balance-mismatch'))
        },
      ),
    )
  }
})

test('source collection reconciliation is path-based rather than order-based', () => {
  const state = scenario()
  state.actual.flatCredentials.reverse()
  state.actual.flatAuthLogs.reverse()
  assert.equal(writeRun(state).passed, true)
})

test('retained teacher evidence detects an identical-body rewrite', () => {
  const observed = scenario().actual
  const teacherDigest = teacher => [
    teacher.path,
    teacher.updateTime.seconds,
    teacher.updateTime.nanoseconds,
  ].join(':')
  const retainedEvidence = {
    legacySourceStateSha256: 'legacy-retained',
    foundationBodiesSha256: 'foundation-retained',
    teacherSourceSha256: teacherDigest(observed.teacher),
    watermarkSha256: 'watermark-retained',
    computeLegacySourceDigest: () => 'legacy-retained',
    computeFoundationDigest: () => 'foundation-retained',
    computeTeacherSourceDigest: teacherDigest,
    computeWatermarkDigest: () => 'watermark-retained',
  }
  assert.equal(assertRetainedSourceEvidence({ retainedEvidence, observed }), true)

  // The document body is unchanged; only exact source time moves. A body-only
  // comparison would miss this rewrite, while the retained source digest must
  // block it.
  observed.teacher.updateTime = new FakeTimestamp(
    observed.teacher.updateTime.seconds + 1,
    observed.teacher.updateTime.nanoseconds,
  )
  assert.throws(
    () => assertRetainedSourceEvidence({ retainedEvidence, observed }),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
    ),
  )
})

test('malformed and unknown option surfaces fail before comparison', () => {
  const state = scenario()
  assert.throws(
    () => reconcileProductionDryRun({
      classroomId: CLASSROOM_ID,
      source: state.source,
      projection: state.projection,
      write: true,
    }),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )

  const missing = { ...state.actual }
  delete missing.flatCredentials
  assert.throws(
    () => writeRun({ ...state, actual: missing }),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )

  assert.throws(
    () => writeRun({
      ...state,
      actual: { ...state.actual, scopedCredentials: null },
    }),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )

  const impreciseFoundation = scenario()
  impreciseFoundation.foundation.teacher.updateTime =
    '2026-07-26T00:00:00.000Z'
  assert.throws(
    () => writeRun(impreciseFoundation),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )

  const plainMapFoundationTime = scenario()
  plainMapFoundationTime.foundation.teacher.updateTime = {
    seconds: 1_780_000_010,
    nanoseconds: 10,
  }
  assert.throws(
    () => writeRun(plainMapFoundationTime),
    assertReconciliationError(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
    ),
  )

  const foundationDrifts = [
    state => {
      state.foundation.teacher.data.uid = 'different-teacher'
    },
    state => {
      state.foundation.teacher.data.classroomId = 'different-classroom'
    },
    state => {
      state.foundation.teacher.data.status = 'disabled'
    },
    state => {
      state.foundation.classroom.data.ownerUid = 'different-teacher'
    },
  ]
  for (const mutate of foundationDrifts) {
    const invalidFoundation = scenario()
    mutate(invalidFoundation)
    assert.throws(
      () => writeRun(invalidFoundation),
      assertReconciliationError(
        PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      ),
    )
  }
})

test('module remains local and exposes no reader, writer, or manifest surface', async () => {
  const source = await readFile(
    new URL('./productionReconciliation.js', import.meta.url),
    'utf8',
  )

  assert.match(source, /buildProductionProjection/)
  assert.match(source, /firestoreValuesEqual/)
  assert.doesNotMatch(
    source,
    /firebase-admin|firebase-functions|getFirestore|initializeApp|fetch\s*\(/,
  )
  assert.doesNotMatch(
    source,
    /\.(?:update|create|delete|commit|batch|bulkWriter|runTransaction)\s*\(/,
  )
  assert.doesNotMatch(
    source,
    /\b(?:doc|reference|batch|writer|transaction)\.set\s*\(/,
  )
  assert.doesNotMatch(source, /node:fs|\.state|persistProductionManifest/)
})
