import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { URL } from 'node:url'

import {
  LEGACY_CLASSROOM_ID,
  PROJECTION_ERROR_CATEGORIES,
  ProjectionError,
  STUDENT_DESTINATION_FIELDS,
  buildMigrationProjection,
  projectClassroomFields,
  projectCredentialBody,
  projectStudentAuthLogBody,
  projectStudentBody,
} from './projection.js'

const CLASSROOM_ID = 'generated-classroom-1'

function envelope(collection, id, data) {
  return {
    id,
    path: `${collection}/${id}`,
    data,
    updateTime: { token: `${collection}-${id}-update-time` },
  }
}

function fixture() {
  const settings = {
    currencyName: 'Class Cash',
    nested: { weeklyAllowance: 5 },
  }
  const transactions = [
    {
      id: 10,
      studentId: 1,
      amount: 4,
      memo: 'First',
      futureTransactionField: { retained: true },
    },
    {
      id: 'transaction-2',
      studentId: 'student-2',
      amount: -2,
      memo: 'Second',
    },
    {
      id: 'transaction-unassigned',
      studentId: null,
      amount: 1,
    },
  ]
  const classroomData = {
    id: 'classroomData',
    path: 'morganBank/classroomData',
    data: {
      students: [
        {
          id: 1,
          name: 'Ada',
          balance: '12.5',
          frozen: 1,
          pin: 'plaintext-must-not-leak',
          loginId: 'ada',
          credentialActive: true,
          futureStudentField: 'drop-me',
        },
        {
          id: 'student-2',
          name: 42,
          balance: 0,
          frozen: false,
        },
      ],
      transactions,
      loginHistory: [
        {
          id: 20,
          studentId: 1,
          result: 'success',
          futureHistoryField: ['retained'],
        },
        {
          id: 'history-2',
          studentId: 'student-2',
          result: 'failure',
        },
      ],
      settings,
    },
    updateTime: { token: 'legacy-classroom-update-time' },
  }
  const studentCredentials = [
    envelope('studentCredentials', 'ada-login', {
      classroomId: LEGACY_CLASSROOM_ID,
      studentId: '1',
      active: true,
      pinHash: 'secret-active-hash',
      futureCredentialField: { retained: true },
    }),
    envelope('studentCredentials', 'second-login', {
      classroomId: LEGACY_CLASSROOM_ID,
      studentId: 'student-2',
      active: false,
      pinHash: 'secret-inactive-hash',
    }),
    envelope('studentCredentials', 'orphan-login', {
      classroomId: LEGACY_CLASSROOM_ID,
      studentId: 'removed-student',
      active: true,
      pinHash: 'secret-orphan-hash',
    }),
  ]
  const studentAuthLogs = [
    envelope('studentAuthLogs', 'log-a', {
      loginId: 'ada-login',
      success: true,
      futureLogField: { retained: true },
    }),
    envelope('studentAuthLogs', 'log-b', {
      classroomId: LEGACY_CLASSROOM_ID,
      loginId: 'second-login',
      success: false,
      reason: 'bad-pin',
    }),
  ]

  return { classroomData, studentCredentials, studentAuthLogs }
}

function build(source = fixture()) {
  return buildMigrationProjection({
    classroomId: CLASSROOM_ID,
    ...source,
  })
}

function assertProjectionError(category, inspect = () => {}) {
  return error => {
    assert.ok(error instanceof ProjectionError)
    assert.equal(error.code, 'PHASE2A_PROJECTION_ERROR')
    assert.equal(error.category, category)
    assert.equal(error.blocking, true)
    inspect(error)
    return true
  }
}

test('builds every deterministic destination without mutating legacy sources', () => {
  const source = fixture()
  const originalSource = JSON.parse(JSON.stringify(source))
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

  assert.deepEqual(
    projection.students.map(student => ({
      id: student.id,
      normalizedId: student.normalizedId,
      path: student.path,
    })),
    [
      {
        id: '1',
        normalizedId: '1',
        path: `classrooms/${CLASSROOM_ID}/students/1`,
      },
      {
        id: 'student-2',
        normalizedId: 'student-2',
        path: `classrooms/${CLASSROOM_ID}/students/student-2`,
      },
    ],
  )
  assert.deepEqual(
    Object.keys(projection.students[0].data).sort(),
    [...STUDENT_DESTINATION_FIELDS].sort(),
  )
  assert.deepEqual(projection.students[0].data, {
    id: 1,
    name: 'Ada',
    balance: 12.5,
    frozen: true,
    transactions: [source.classroomData.data.transactions[0]],
  })
  assert.deepEqual(projection.students[1].data, {
    id: 'student-2',
    name: 'Student',
    balance: 0,
    frozen: false,
    transactions: [source.classroomData.data.transactions[1]],
  })
  assert.strictEqual(
    projection.students[0].data.transactions[0],
    source.classroomData.data.transactions[0],
  )

  assert.deepEqual(
    projection.transactions.map(transaction => transaction.path),
    [
      `classrooms/${CLASSROOM_ID}/transactions/10`,
      `classrooms/${CLASSROOM_ID}/transactions/transaction-2`,
      `classrooms/${CLASSROOM_ID}/transactions/transaction-unassigned`,
    ],
  )
  assert.deepEqual(
    projection.transactions.map(transaction => transaction.data),
    source.classroomData.data.transactions,
  )
  assert.notStrictEqual(
    projection.transactions[0].data,
    source.classroomData.data.transactions[0],
  )
  assert.deepEqual(
    projection.loginHistory.map(history => history.path),
    [
      `classrooms/${CLASSROOM_ID}/loginHistory/20`,
      `classrooms/${CLASSROOM_ID}/loginHistory/history-2`,
    ],
  )
  assert.deepEqual(
    projection.loginHistory.map(history => history.data),
    source.classroomData.data.loginHistory,
  )

  assert.deepEqual(
    projection.studentCredentials.map(credential => ({
      path: credential.path,
      classroomId: credential.data.classroomId,
      active: credential.data.active,
      pinHash: credential.data.pinHash,
      orphaned: credential.orphaned,
    })),
    [
      {
        path: 'studentCredentials/ada-login',
        classroomId: CLASSROOM_ID,
        active: true,
        pinHash: 'secret-active-hash',
        orphaned: false,
      },
      {
        path: 'studentCredentials/second-login',
        classroomId: CLASSROOM_ID,
        active: false,
        pinHash: 'secret-inactive-hash',
        orphaned: false,
      },
      {
        path: 'studentCredentials/orphan-login',
        classroomId: CLASSROOM_ID,
        active: true,
        pinHash: 'secret-orphan-hash',
        orphaned: true,
      },
    ],
  )
  assert.deepEqual(projection.orphanedCredentialPaths, [
    'studentCredentials/orphan-login',
  ])
  assert.deepEqual(projection.studentCredentials[0].data.futureCredentialField, {
    retained: true,
  })

  assert.deepEqual(
    projection.studentAuthLogs.map(log => ({
      sourcePath: log.sourcePath,
      path: log.path,
      data: log.data,
    })),
    [
      {
        sourcePath: 'studentAuthLogs/log-a',
        path: `studentAuthLogs/${CLASSROOM_ID}/logs/log-a`,
        data: {
          loginId: 'ada-login',
          success: true,
          futureLogField: { retained: true },
        },
      },
      {
        sourcePath: 'studentAuthLogs/log-b',
        path: `studentAuthLogs/${CLASSROOM_ID}/logs/log-b`,
        data: {
          loginId: 'second-login',
          success: false,
          reason: 'bad-pin',
        },
      },
    ],
  )
  assert.equal(
    projection.studentAuthLogs.some(log =>
      Object.hasOwn(log.data, 'classroomId')),
    false,
  )
  assert.deepEqual(source, originalSource)
  assert.equal(source.studentCredentials[0].data.classroomId, 'morgan')
  assert.equal(source.studentAuthLogs[1].data.classroomId, 'morgan')
})

test('normalizes only a missing lastBackupAt and preserves present falsy values', () => {
  const settings = { theme: 'dark' }

  assert.deepEqual(projectClassroomFields({ settings }), {
    settings,
    lastBackupAt: null,
  })
  assert.deepEqual(projectClassroomFields({ settings, lastBackupAt: 0 }), {
    settings,
    lastBackupAt: 0,
  })
  assert.deepEqual(projectClassroomFields({ settings, lastBackupAt: null }), {
    settings,
    lastBackupAt: null,
  })
})

test('student projection applies the exact legacy coercions and transaction filter', () => {
  const matching = { id: 'tx-1', studentId: 7 }
  const other = { id: 'tx-2', studentId: '8' }
  const unassigned = { id: 'tx-3', studentId: null }
  const body = projectStudentBody({
    student: { id: 7, name: null, balance: '', frozen: 'yes', pin: 'drop' },
    normalizedStudentId: '7',
    transactions: [other, matching, unassigned],
  })

  assert.deepEqual(body, {
    id: 7,
    name: 'Student',
    balance: 0,
    frozen: true,
    transactions: [matching],
  })
  assert.deepEqual(Object.keys(body).sort(), [...STUDENT_DESTINATION_FIELDS].sort())
})

test('rejects invalid and colliding IDs with shared detailed rejections', () => {
  const cases = [
    {
      collection: 'students',
      mutate: source => {
        source.classroomData.data.students[1].id = 1
      },
      expectedCategory: 'post-normalization-collision',
      expectedIndexes: [0, 1],
    },
    {
      collection: 'transactions',
      mutate: source => {
        source.classroomData.data.transactions[1].id = ' bad-id '
      },
      expectedCategory: 'leading-or-trailing-whitespace',
      expectedIndexes: [1],
    },
    {
      collection: 'loginHistory',
      mutate: source => {
        source.classroomData.data.loginHistory[0].id = null
      },
      expectedCategory: 'null-value',
      expectedIndexes: [0],
    },
  ]

  for (const currentCase of cases) {
    const source = fixture()
    currentCase.mutate(source)

    assert.throws(
      () => build(source),
      assertProjectionError(
        PROJECTION_ERROR_CATEGORIES.INVALID_DOCUMENT_IDS,
        error => {
          assert.equal(error.details.collection, currentCase.collection)
          assert.deepEqual(
            error.details.rejections.map(rejection => rejection.sourceIndex),
            currentCase.expectedIndexes,
          )
          assert.equal(
            error.details.rejections[0].category,
            currentCase.expectedCategory,
          )
        },
      ),
    )
  }
})

test('blocks missing and unexpected credential classroom IDs without leaking bodies', () => {
  for (const credential of [
    { studentId: '1', pinHash: 'secret-missing' },
    {
      classroomId: CLASSROOM_ID,
      studentId: '1',
      pinHash: 'secret-unexpected',
    },
  ]) {
    assert.throws(
      () => projectCredentialBody(
        credential,
        CLASSROOM_ID,
        'studentCredentials/test',
      ),
      assertProjectionError(
        PROJECTION_ERROR_CATEGORIES.CREDENTIAL_CLASSROOM_ANOMALY,
        error => {
          assert.equal(error.details.path, 'studentCredentials/test')
          assert.equal(JSON.stringify(error.details).includes('pinHash'), false)
          assert.equal(JSON.stringify(error.details).includes('secret-'), false)
        },
      ),
    )
  }
})

test('accepts missing or legacy auth-log classroomId and blocks every other value', () => {
  assert.deepEqual(
    projectStudentAuthLogBody({ loginId: 'a', success: true }),
    { loginId: 'a', success: true },
  )
  assert.deepEqual(
    projectStudentAuthLogBody({
      classroomId: LEGACY_CLASSROOM_ID,
      loginId: 'a',
      unknown: 1,
    }),
    { loginId: 'a', unknown: 1 },
  )
  assert.throws(
    () => projectStudentAuthLogBody(
      { classroomId: 'other-classroom', loginId: 'a' },
      'studentAuthLogs/log-a',
    ),
    assertProjectionError(PROJECTION_ERROR_CATEGORIES.AUTH_LOG_CLASSROOM_ANOMALY),
  )
})

test('fails closed on malformed source shapes and unknown arguments', () => {
  const malformedArray = fixture()
  malformedArray.classroomData.data.transactions = {}
  assert.throws(
    () => build(malformedArray),
    assertProjectionError(PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_FIELD),
  )

  const missingSettings = fixture()
  delete missingSettings.classroomData.data.settings
  assert.throws(
    () => build(missingSettings),
    assertProjectionError(PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_FIELD),
  )

  const malformedEnvelope = fixture()
  malformedEnvelope.studentCredentials[0].path = 'studentCredentials/wrong'
  assert.throws(
    () => build(malformedEnvelope),
    assertProjectionError(PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_DOCUMENT),
  )

  assert.throws(
    () => buildMigrationProjection({
      classroomId: CLASSROOM_ID,
      ...fixture(),
      write: true,
    }),
    assertProjectionError(PROJECTION_ERROR_CATEGORIES.INVALID_ARGUMENTS),
  )
  assert.throws(
    () => buildMigrationProjection({
      classroomId: LEGACY_CLASSROOM_ID,
      ...fixture(),
    }),
    assertProjectionError(PROJECTION_ERROR_CATEGORIES.INVALID_CLASSROOM_ID),
  )
})

test('projection module remains pure and Firestore-free', async () => {
  const source = await readFile(new URL('./projection.js', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /firebase-admin|firebase-functions|getFirestore/)
  assert.doesNotMatch(
    source,
    /\.(?:set|update|create|delete|commit|batch|bulkWriter|runTransaction)\s*\(/,
  )
})
