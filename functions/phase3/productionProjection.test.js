import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { URL } from 'node:url'

import {
  PRODUCTION_PROJECTION_CATEGORIES,
  PRODUCTION_PROJECTION_SURFACES,
  ProductionProjectionError,
  STUDENT_DESTINATION_FIELDS,
  buildProductionProjection,
} from './productionProjection.js'
import {
  deriveDeterministicStudentAuthUid,
  firestoreValuesEqual,
} from '../phase2b/scopedCredentialProjection.js'

const CLASSROOM_ID = 'classroom-abc123'

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

function envelope(collection, id, data, sequence = 1) {
  return {
    id,
    path: `${collection}/${id}`,
    data,
    updateTime: new FakeTimestamp(1_780_000_000 + sequence, sequence),
  }
}

function fixture() {
  const firstTransaction = {
    id: 10,
    studentId: 7,
    amount: 5,
    metadata: { retained: true },
  }
  const secondTransaction = {
    id: 'tx-2',
    studentId: '8',
    amount: -2,
  }
  return {
    classroomData: {
      id: 'classroomData',
      path: 'morganBank/classroomData',
      updateTime: new FakeTimestamp(1_780_000_000, 987_654_321),
      data: {
        students: [
          {
            id: 7,
            name: 'Ada',
            balance: '12.5',
            frozen: 1,
            pin: '1234',
            loginId: 'ada-login',
            futureField: 'must-not-copy',
          },
          { id: 8, name: 'Blaise', balance: 4, frozen: false },
        ],
        transactions: [firstTransaction, secondTransaction],
        loginHistory: [
          { id: 20, studentId: 7, result: 'success', future: ['kept'] },
        ],
        settings: { currencyName: 'Class Cash', nested: { allowance: 5 } },
      },
    },
    studentCredentials: [
      envelope('studentCredentials', 'blaise-login', {
        classroomId: 'morgan',
        studentId: '8',
        authUid: 'legacy-uid-8',
        active: false,
        pinHash: 'secret-hash-8',
        createdAt: new FakeTimestamp(1_700_000_000, 123_456_789),
        bytes: new Uint8Array([1, 2, 3]),
        futureSecurityField: { retained: true },
      }, 2),
      envelope('studentCredentials', 'ada-login', {
        classroomId: 'morgan',
        studentId: '7',
        authUid: 'legacy-uid-7',
        active: true,
        pinHash: 'secret-hash-7',
        failedAttempts: 2,
      }, 1),
      envelope('studentCredentials', 'withdrawn-login', {
        classroomId: 'morgan',
        studentId: '99',
        authUid: 'legacy-uid-99',
        active: false,
        pinHash: 'secret-hash-99',
      }, 3),
    ],
    studentAuthLogs: [
      envelope('studentAuthLogs', 'log-b', {
        classroomId: 'morgan',
        studentId: '8',
        success: false,
        reason: 'bad-pin',
      }, 5),
      envelope('studentAuthLogs', 'log-a', {
        studentId: '7',
        success: true,
        metadata: { retained: true },
      }, 4),
    ],
  }
}

function build(source = fixture(), overrides = {}) {
  return buildProductionProjection({
    classroomId: CLASSROOM_ID,
    ...source,
    ...overrides,
  })
}

function assertProjectionError(category) {
  return error => {
    assert.ok(error instanceof ProductionProjectionError)
    assert.equal(error.code, 'PHASE3_PRODUCTION_PROJECTION_ERROR')
    assert.equal(error.category, category)
    assert.equal(error.blocking, true)
    return true
  }
}

test('builds the complete Phase 3 projection without a flat destination', () => {
  const source = fixture()
  const projection = build(source)

  assert.equal(projection.classroomId, CLASSROOM_ID)
  assert.deepEqual(projection.classroom, {
    id: CLASSROOM_ID,
    path: `classrooms/${CLASSROOM_ID}`,
    data: {
      settings: source.classroomData.data.settings,
      lastBackupAt: null,
    },
  })
  assert.deepEqual(projection.counts, {
    students: 2,
    transactions: 2,
    loginHistory: 1,
    scopedCredentials: 3,
    scopedAuthLogs: 2,
    orphanedCredentials: 1,
  })
  assert.deepEqual(
    projection.scopedCredentials.map(entry => entry.path),
    [
      `classrooms/${CLASSROOM_ID}/studentCredentials/ada-login`,
      `classrooms/${CLASSROOM_ID}/studentCredentials/blaise-login`,
      `classrooms/${CLASSROOM_ID}/studentCredentials/withdrawn-login`,
    ],
  )
  assert.deepEqual(
    projection.scopedAuthLogs.map(entry => entry.path),
    [
      `studentAuthLogs/${CLASSROOM_ID}/logs/log-a`,
      `studentAuthLogs/${CLASSROOM_ID}/logs/log-b`,
    ],
  )

  for (const surface of PRODUCTION_PROJECTION_SURFACES) {
    for (const entry of projection[surface]) {
      assert.equal(entry.path.startsWith('studentCredentials/'), false)
      assert.equal(typeof entry.write, 'undefined')
      assert.equal(typeof entry.operation, 'undefined')
      assert.equal(typeof entry.sourceIndex, 'undefined')
    }
  }
  assert.equal(Object.hasOwn(projection, 'studentCredentials'), false)
  assert.equal(Object.hasOwn(projection, 'operations'), false)
})

test('preserves every credential field except classroomId and authUid', () => {
  const source = fixture()
  const projection = build(source)

  for (const destination of projection.scopedCredentials) {
    const original = source.studentCredentials.find(
      entry => entry.path === destination.sourcePath,
    )
    assert.equal(destination.sourcePath, original.path)
    assert.strictEqual(destination.sourceUpdateTime, original.updateTime)
    assert.equal(destination.data.classroomId, CLASSROOM_ID)
    assert.equal(
      destination.data.authUid,
      deriveDeterministicStudentAuthUid(CLASSROOM_ID, original.data.studentId),
    )

    const preservedKeys = Object.keys(original.data)
      .filter(key => key !== 'classroomId' && key !== 'authUid')
    for (const key of preservedKeys) {
      assert.equal(
        firestoreValuesEqual(destination.data[key], original.data[key]),
        true,
        `${original.path}.${key} must be preserved`,
      )
    }
  }

  const blaise = projection.scopedCredentials.find(
    credential => credential.id === 'blaise-login',
  )
  assert.equal(blaise.data.active, false)
  assert.equal(blaise.data.pinHash, 'secret-hash-8')
  assert.equal(blaise.data.failedAttempts, undefined)
  assert.equal(
    firestoreValuesEqual(
      blaise.data.createdAt,
      new FakeTimestamp(1_700_000_000, 123_456_789),
    ),
    true,
  )
  assert.deepEqual(blaise.data.bytes, new Uint8Array([1, 2, 3]))
  assert.deepEqual(blaise.data.futureSecurityField, { retained: true })
})

test('records deterministic UID mappings and active/inactive/orphan parity', () => {
  const projection = build()

  assert.equal(projection.uidMappings.length, 3)
  assert.deepEqual(
    projection.uidMappings.map(mapping => mapping.oldAuthUid),
    ['legacy-uid-7', 'legacy-uid-8', 'legacy-uid-99'],
  )
  for (const mapping of projection.uidMappings) {
    assert.equal(mapping.classroomId, CLASSROOM_ID)
    assert.equal(
      mapping.newAuthUid,
      deriveDeterministicStudentAuthUid(CLASSROOM_ID, mapping.studentId),
    )
  }
  assert.deepEqual(projection.orphanedCredentialPaths, [
    `classrooms/${CLASSROOM_ID}/studentCredentials/withdrawn-login`,
  ])
  assert.deepEqual(
    projection.scopedCredentials.map(entry => ({
      id: entry.id,
      active: entry.data.active,
      orphaned: entry.orphaned,
    })),
    [
      { id: 'ada-login', active: true, orphaned: false },
      { id: 'blaise-login', active: false, orphaned: false },
      { id: 'withdrawn-login', active: false, orphaned: true },
    ],
  )
})

test('retains Phase 2A student, transaction, history, and log semantics', () => {
  const source = fixture()
  const projection = build(source)

  assert.deepEqual(
    Object.keys(projection.students[0].data).sort(),
    [...STUDENT_DESTINATION_FIELDS].sort(),
  )
  assert.deepEqual(projection.students[0].data, {
    id: 7,
    name: 'Ada',
    balance: 12.5,
    frozen: true,
    transactions: [source.classroomData.data.transactions[0]],
  })
  assert.deepEqual(
    projection.transactions.map(entry => entry.data),
    source.classroomData.data.transactions,
  )
  assert.deepEqual(
    projection.loginHistory.map(entry => entry.data),
    source.classroomData.data.loginHistory,
  )
  assert.deepEqual(projection.scopedAuthLogs[0].data, {
    studentId: '7',
    success: true,
    metadata: { retained: true },
  })
  assert.deepEqual(projection.scopedAuthLogs[1].data, {
    studentId: '8',
    success: false,
    reason: 'bad-pin',
  })
  assert.equal(
    projection.scopedAuthLogs.some(entry =>
      Object.hasOwn(entry.data, 'classroomId')),
    false,
  )
})

test('does not mutate frozen source envelopes or bodies', () => {
  const source = fixture()
  const originalClassroomId = source.studentCredentials[0].data.classroomId
  const originalAuthUid = source.studentCredentials[0].data.authUid
  const originalLogClassroomId = source.studentAuthLogs[0].data.classroomId

  source.studentCredentials.forEach(entry => {
    Object.freeze(entry.data)
    Object.freeze(entry)
  })
  source.studentAuthLogs.forEach(entry => {
    Object.freeze(entry.data)
    Object.freeze(entry)
  })
  Object.freeze(source.studentCredentials)
  Object.freeze(source.studentAuthLogs)

  const projection = build(source)
  assert.equal(source.studentCredentials[0].data.classroomId, originalClassroomId)
  assert.equal(source.studentCredentials[0].data.authUid, originalAuthUid)
  assert.equal(source.studentAuthLogs[0].data.classroomId, originalLogClassroomId)
  assert.notStrictEqual(
    projection.scopedCredentials[1].data,
    source.studentCredentials[0].data,
  )
})

test('rejects unknown arguments and malformed collection inputs', () => {
  const source = fixture()
  assert.throws(
    () => buildProductionProjection(null),
    assertProjectionError(PRODUCTION_PROJECTION_CATEGORIES.INVALID_ARGUMENTS),
  )
  assert.throws(
    () => build(source, { write: true }),
    assertProjectionError(PRODUCTION_PROJECTION_CATEGORIES.INVALID_ARGUMENTS),
  )
  assert.throws(
    () => build(source, { studentCredentials: {} }),
    assertProjectionError(PRODUCTION_PROJECTION_CATEGORIES.INVALID_ARGUMENTS),
  )
})

test('requires exact source update times before carrying preconditions', () => {
  const cases = [
    source => {
      source.classroomData.updateTime = '2026-07-26T00:00:00.000Z'
    },
    source => {
      source.studentCredentials[0].updateTime.nanoseconds = 1_000_000_000
    },
    source => {
      source.studentAuthLogs[0].updateTime = { seconds: 1 }
    },
  ]

  for (const mutate of cases) {
    const source = fixture()
    mutate(source)
    assert.throws(
      () => build(source),
      assertProjectionError(PRODUCTION_PROJECTION_CATEGORIES.INVALID_ARGUMENTS),
    )
  }
})

test('wraps malformed legacy data without carrying sensitive source values', () => {
  const source = fixture()
  source.classroomData.data.transactions = null

  assert.throws(
    () => build(source),
    error => {
      assertProjectionError(
        PRODUCTION_PROJECTION_CATEGORIES.LEGACY_PROJECTION_REJECTED,
      )(error)
      assert.equal(error.details.sourceCategory, 'invalid-source-field')
      assert.equal(JSON.stringify(error).includes('1234'), false)
      assert.equal(JSON.stringify(error).includes('secret-hash'), false)
      return true
    },
  )
})

test('wraps malformed and duplicate credentials without secret leakage', () => {
  const cases = [
    source => {
      source.studentCredentials[0].data.classroomId = 'other-classroom'
    },
    source => {
      source.studentCredentials.push({
        ...source.studentCredentials[0],
        data: { ...source.studentCredentials[0].data, studentId: '7' },
      })
    },
    source => {
      source.studentCredentials[0].data.studentId = 8
    },
  ]

  for (const mutate of cases) {
    const source = fixture()
    mutate(source)
    assert.throws(
      () => build(source),
      error => {
        assertProjectionError(
          PRODUCTION_PROJECTION_CATEGORIES
            .SCOPED_CREDENTIAL_PROJECTION_REJECTED,
        )(error)
        const serialized = JSON.stringify(error)
        assert.equal(serialized.includes('secret-hash'), false)
        assert.equal(serialized.includes('pinHash'), false)
        return true
      },
    )
  }
})

test('rejects duplicate scoped auth-log paths at the copy boundary', () => {
  const source = fixture()
  source.studentAuthLogs.push({
    ...source.studentAuthLogs[0],
    data: { ...source.studentAuthLogs[0].data },
  })

  assert.throws(
    () => build(source),
    assertProjectionError(
      PRODUCTION_PROJECTION_CATEGORIES.COPY_CONTRACT_VIOLATION,
    ),
  )
})

test('projection output is stable for unordered flat source collections', () => {
  const source = fixture()
  const first = build(source)
  source.studentCredentials.reverse()
  source.studentAuthLogs.reverse()
  const second = build(source)

  assert.deepEqual(first.scopedCredentials, second.scopedCredentials)
  assert.deepEqual(first.scopedAuthLogs, second.scopedAuthLogs)
  assert.deepEqual(first.uidMappings, second.uidMappings)
})

test('module remains pure, local, copy-only, and pinned to proven helpers', async () => {
  const source = await readFile(
    new URL('./productionProjection.js', import.meta.url),
    'utf8',
  )

  assert.match(source, /from '\.\.\/phase2\/projection\.js'/)
  assert.match(
    source,
    /from '\.\.\/phase2b\/scopedCredentialProjection\.js'/,
  )
  assert.match(source, /buildMigrationProjection/)
  assert.match(source, /projectAndReconcileScopedCredentials/)
  assert.doesNotMatch(
    source,
    /firebase-admin|firebase-functions|getFirestore|initializeApp|fetch\s*\(/,
  )
  assert.doesNotMatch(
    source,
    /\.(?:set|update|create|delete|commit|batch|bulkWriter|runTransaction)\s*\(/,
  )
  assert.doesNotMatch(source, /node:fs|\.state|persistProductionManifest/)
})
