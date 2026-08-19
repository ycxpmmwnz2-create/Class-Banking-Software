import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  CLASSROOM_ROOT_FIELDS,
  DEFAULT_RENT_AMOUNT,
  FORBIDDEN_CREDENTIAL_FIELDS,
  LOGIN_HISTORY_LIMIT,
  PROJECTION_CATEGORIES,
  STUDENT_DOCUMENT_FIELDS,
  STUDENT_RENT_DOCUMENT_FIELDS,
  TenantProjectionError,
  decomposeClassroomMutation,
  projectBackupExport,
  projectClassroomData,
  projectStudentSelfData,
} from './tenantDataProjection.js'

const CLASSROOM = 'classroom-alpha'

function student(overrides = {}) {
  return { id: 1, name: 'Ada', balance: 10, frozen: false, transactions: [], ...overrides }
}

function transaction(overrides = {}) {
  return {
    id: 1700000000000,
    date: '1/1/2026, 9:00:00 AM',
    studentId: 1,
    studentName: 'Ada',
    type: 'Add',
    amount: 5,
    reason: 'Quick Cash',
    memo: '',
    category: '',
    status: 'Approved',
    source: 'Teacher',
    ...overrides,
  }
}

function historyEntry(overrides = {}) {
  return {
    id: 1700000000001,
    date: '1/1/2026, 9:00:00 AM',
    studentId: 1,
    studentName: 'Ada',
    result: 'Success',
    note: '',
    ...overrides,
  }
}

function load(overrides = {}) {
  const transactions = overrides.transactions ?? [transaction()]
  const students = overrides.students ?? [student({
    transactions: transactions.filter(entry => Number(entry.studentId) === 1),
  })]
  return projectClassroomData({
    classroomId: CLASSROOM,
    root: { settings: {}, lastBackupAt: null },
    students,
    transactions,
    loginHistory: [historyEntry()],
    ...overrides,
  })
}

function expectRejection(fn, category) {
  let error = null
  try {
    fn()
  } catch (thrown) {
    error = thrown
  }
  assert.ok(error, 'expected the call to throw')
  assert.ok(error instanceof TenantProjectionError, `expected TenantProjectionError, got ${error?.name}`)
  assert.equal(error.category, category, `expected category ${category}, got ${error.category}`)
  return error
}

describe('Phase 3 tenant data projection — load', () => {
  it('reconstructs the aggregate view from per-path documents', () => {
    const result = load({
      root: { settings: { requireTeacherApproval: false }, lastBackupAt: '2026-01-01T00:00:00.000Z' },
    })

    assert.deepEqual(result.students, [student({ transactions: [transaction()] })])
    assert.equal(result.transactions.length, 1)
    assert.equal(result.loginHistory.length, 1)
    assert.equal(result.lastBackupAt, '2026-01-01T00:00:00.000Z')
    assert.equal(result.settings.requireTeacherApproval, false)
  })

  it('projects rent from the narrow student display document, never from teacher settings', () => {
    const result = load({
      root: { settings: { rentAmount: 999 }, lastBackupAt: null },
      studentRent: { rentAmount: 25, updatedAt: '2026-08-19T12:00:00.000Z' },
    })

    assert.equal(result.settings.rentAmount, 25)
  })

  it('defaults missing rent to zero and rejects malformed display documents', () => {
    assert.equal(load({ studentRent: null }).settings.rentAmount, DEFAULT_RENT_AMOUNT)

    for (const studentRent of [
      { rentAmount: -1, updatedAt: '2026-08-19T12:00:00.000Z' },
      { rentAmount: 1.5, updatedAt: '2026-08-19T12:00:00.000Z' },
      { rentAmount: 1_000_001, updatedAt: '2026-08-19T12:00:00.000Z' },
      { rentAmount: 25 },
      { rentAmount: 25, updatedAt: '2026-08-19T12:00:00.000Z', extra: true },
    ]) {
      expectRejection(() => load({ studentRent }), PROJECTION_CATEGORIES.SHAPE)
    }
  })

  it('normalizes a migrated Firestore lastBackupAt Timestamp to the ISO view model', () => {
    const result = load({
      root: {
        settings: {},
        lastBackupAt: {
          seconds: 1_767_225_600,
          nanoseconds: 0,
          toDate: () => new Date('2026-01-01T00:00:00.000Z'),
        },
      },
    })

    assert.equal(result.lastBackupAt, '2026-01-01T00:00:00.000Z')
  })

  it('rejects an invalid Timestamp-like lastBackupAt value', () => {
    expectRejection(
      () => load({ root: { settings: {}, lastBackupAt: { toDate: () => new Date('invalid') } } }),
      PROJECTION_CATEGORIES.SHAPE,
    )
  })

  it('normalizes a canonical string student id to a number', () => {
    const mirrored = transaction({ studentId: '7' })
    const result = load({
      students: [student({ id: '7', transactions: [mirrored] })],
      transactions: [mirrored],
      loginHistory: [historyEntry({ studentId: 7 })],
    })
    assert.equal(result.students[0].id, 7)
    assert.equal(result.transactions[0].studentId, 7)
    assert.equal(result.loginHistory[0].studentId, 7)
  })

  it('rejects a non-canonical student id rather than merging two documents', () => {
    // "07" and "7" would be two distinct Firestore document IDs mapping onto
    // one student. Coercing them would silently merge two records.
    for (const id of ['07', ' 7', '7.0', '7e0', '', '-1', '0']) {
      expectRejection(() => load({ students: [student({ id })] }), PROJECTION_CATEGORIES.SHAPE)
    }
  })

  it('rejects duplicate student ids', () => {
    expectRejection(
      () => load({
        students: [
          student({ transactions: [transaction()] }),
          student({ id: '1', name: 'Bea', transactions: [transaction()] }),
        ],
      }),
      PROJECTION_CATEGORIES.DUPLICATE,
    )
  })

  it('rejects duplicate transaction and login-history record ids', () => {
    expectRejection(
      () => load({ transactions: [transaction({ id: 5 }), transaction({ id: '5' })] }),
      PROJECTION_CATEGORIES.DUPLICATE,
    )
    expectRejection(
      () => load({ loginHistory: [historyEntry({ id: 5 }), historyEntry({ id: 5 })] }),
      PROJECTION_CATEGORIES.DUPLICATE,
    )
  })

  it('rejects a document tagged with a foreign classroom', () => {
    expectRejection(
      () => load({ students: [student({ classroomId: 'classroom-beta' })] }),
      PROJECTION_CATEGORIES.TENANT,
    )
    expectRejection(
      () => load({ transactions: [transaction({ classroomId: 'classroom-beta' })] }),
      PROJECTION_CATEGORIES.TENANT,
    )
    expectRejection(
      () => load({ root: { classroomId: 'classroom-beta', settings: {} } }),
      PROJECTION_CATEGORIES.TENANT,
    )
  })

  it('rejects even a same-tenant extra key on the exact student body', () => {
    expectRejection(
      () => load({ students: [student({ classroomId: CLASSROOM })] }),
      PROJECTION_CATEGORIES.SHAPE,
    )
  })

  it('retains canonical same-tenant history after a student is removed from the roster', () => {
    const result = load({
      students: [],
      transactions: [transaction({ studentId: 99, studentName: 'Removed Student' })],
      loginHistory: [historyEntry({ studentId: 99, studentName: 'Removed Student' })],
    })

    assert.deepEqual(result.students, [])
    assert.equal(result.transactions[0].studentId, 99)
    assert.equal(result.loginHistory[0].studentId, 99)
  })

  it('still rejects malformed historical student references', () => {
    expectRejection(
      () => load({ students: [], transactions: [transaction({ studentId: '099' })] }),
      PROJECTION_CATEGORIES.SHAPE,
    )
    expectRejection(
      () => load({ students: [], loginHistory: [historyEntry({ studentId: '0' })] }),
      PROJECTION_CATEGORIES.SHAPE,
    )
  })

  it('allows a login-history entry with no student, which a failed login produces', () => {
    const result = load({
      loginHistory: [historyEntry({ studentId: null, studentName: 'Unknown student', result: 'Failed' })],
    })
    assert.equal(result.loginHistory[0].studentId, null)
  })

  it('refuses to load any document carrying a credential field', () => {
    for (const field of FORBIDDEN_CREDENTIAL_FIELDS) {
      const error = expectRejection(
        () => load({ students: [student({ [field]: 'secret-value' })] }),
        PROJECTION_CATEGORIES.CREDENTIAL,
      )
      // The field name may be reported; the value never may.
      assert.ok(!error.message.includes('secret-value'))
      assert.ok(!JSON.stringify(error.details).includes('secret-value'))
    }
  })

  it('refuses credential material nested in the required transaction mirror', () => {
    const error = expectRejection(
      () => load({
        students: [student({ transactions: [{ ...transaction(), pinHash: 'nested-secret' }] })],
      }),
      PROJECTION_CATEGORIES.CREDENTIAL,
    )
    assert.ok(!error.message.includes('nested-secret'))
    assert.ok(!JSON.stringify(error.details).includes('nested-secret'))
  })

  it('rejects a student transaction mirror that disagrees with the authoritative ledger', () => {
    for (const transactions of [
      [],
      [transaction({ amount: 99 })],
      [transaction(), transaction({ id: 1700000000002 })],
    ]) {
      expectRejection(
        () => load({ students: [student({ transactions })] }),
        PROJECTION_CATEGORIES.REFERENCE,
      )
    }
  })

  it('rejects an active student mirror that references a different or removed student', () => {
    expectRejection(
      () => load({
        students: [student({ transactions: [transaction({ studentId: 99 })] })],
        transactions: [],
      }),
      PROJECTION_CATEGORIES.REFERENCE,
    )
  })

  it('rejects malformed student field types', () => {
    for (const overrides of [
      { name: 42 },
      { name: '   ' },
      { balance: '10' },
      { balance: Number.NaN },
      { frozen: 'false' },
      { transactions: null },
    ]) {
      expectRejection(() => load({ students: [student(overrides)] }), PROJECTION_CATEGORIES.SHAPE)
    }
  })

  it('rejects a transaction that adds or omits a field', () => {
    const extra = { ...transaction(), unexpected: true }
    expectRejection(() => load({ transactions: [extra] }), PROJECTION_CATEGORIES.SHAPE)

    const missing = transaction()
    delete missing.memo
    expectRejection(() => load({ transactions: [missing] }), PROJECTION_CATEGORIES.SHAPE)
  })

  it('sorts records newest-first regardless of read order', () => {
    const result = load({
      transactions: [transaction({ id: 10 }), transaction({ id: 30 }), transaction({ id: 20 })],
      loginHistory: [historyEntry({ id: 10 }), historyEntry({ id: 30 })],
    })
    assert.deepEqual(result.transactions.map(t => t.id), [30, 20, 10])
    assert.deepEqual(result.loginHistory.map(h => h.id), [30, 10])
  })

  it('caps login history at the documented limit', () => {
    const entries = Array.from({ length: LOGIN_HISTORY_LIMIT + 25 }, (_, i) =>
      historyEntry({ id: 1_000_000 + i }))
    const result = load({ loginHistory: entries })
    assert.equal(result.loginHistory.length, LOGIN_HISTORY_LIMIT)
  })

  it('requires a resolved classroom id', () => {
    expectRejection(() => load({ classroomId: '' }), PROJECTION_CATEGORIES.TENANT)
    expectRejection(
      () => projectClassroomData({ students: [], transactions: [], loginHistory: [] }),
      PROJECTION_CATEGORIES.TENANT,
    )
  })

  it('requires arrays for each collection rather than coercing', () => {
    for (const key of ['students', 'transactions', 'loginHistory']) {
      expectRejection(() => load({ [key]: null }), PROJECTION_CATEGORIES.SHAPE)
    }
  })

  it('tolerates an absent classroom root by falling back to default settings', () => {
    const result = load({ root: null, defaultSettings: { requireTeacherApproval: true, reasons: ['a'] } })
    assert.equal(result.settings.requireTeacherApproval, true)
    assert.deepEqual(result.settings.reasons, ['a'])
    assert.equal(result.lastBackupAt, null)
  })

  it('drops unknown settings keys but keeps known ones type-checked', () => {
    const result = load({
      root: { settings: { requireTeacherApproval: 'yes', reasons: ['a', 7], unknownKey: 1 } },
      defaultSettings: { requireTeacherApproval: true, reasons: [] },
    })
    // A wrong-typed known key keeps the default rather than rendering a string
    // where the UI expects a boolean.
    assert.equal(result.settings.requireTeacherApproval, true)
    assert.deepEqual(result.settings.reasons, ['a'])
    assert.ok(!('unknownKey' in result.settings))
  })
})

describe('Phase 3 tenant data projection — mutation decomposition', () => {
  const data = {
    students: [student({ transactions: [transaction()] })],
    transactions: [transaction()],
    loginHistory: [historyEntry()],
    settings: { requireTeacherApproval: true },
    lastBackupAt: null,
  }

  it('writes each record at its canonical deterministic path', () => {
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data })

    assert.equal(plan.root.path, `classrooms/${CLASSROOM}`)
    assert.deepEqual(plan.students.map(w => w.path), [`classrooms/${CLASSROOM}/students/1`])
    assert.deepEqual(plan.transactions.map(w => w.path), [`classrooms/${CLASSROOM}/transactions/1700000000000`])
    assert.deepEqual(plan.loginHistory.map(w => w.path), [`classrooms/${CLASSROOM}/loginHistory/1700000000001`])
  })

  it('emits student bodies with exactly the five contract fields', () => {
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data })
    assert.deepEqual(Object.keys(plan.students[0].body).sort(), [...STUDENT_DOCUMENT_FIELDS].sort())
  })

  it('emits a classroom root patch limited to the allowed keys', () => {
    const plan = decomposeClassroomMutation({
      classroomId: CLASSROOM,
      data: { ...data, lastBackupAt: '2026-01-01T00:00:00.000Z' },
    })
    for (const key of Object.keys(plan.root.body)) {
      assert.ok(CLASSROOM_ROOT_FIELDS.includes(key), `root key ${key} must be allowed`)
    }
    assert.ok(!('students' in plan.root.body))
    assert.ok(!('transactions' in plan.root.body))
  })

  it('writes a rent-only change only to the exact student display path', () => {
    const previous = { ...data, settings: { ...data.settings, rentAmount: 0 } }
    const next = { ...data, settings: { ...data.settings, rentAmount: 25 } }
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data: next, previous })

    assert.equal(plan.root, null)
    assert.equal(plan.studentRent.path, `classrooms/${CLASSROOM}/studentDisplay/rent`)
    assert.deepEqual(plan.studentRent.body, { rentAmount: 25 })
    assert.equal(plan.totalWrites, 1)
  })

  it('keeps rent out of the teacher-only classroom root patch', () => {
    const plan = decomposeClassroomMutation({
      classroomId: CLASSROOM,
      data: {
        ...data,
        settings: { ...data.settings, rentAmount: 25, requireTeacherApproval: false },
      },
      previous: {
        ...data,
        settings: { ...data.settings, rentAmount: 25 },
      },
    })

    assert.ok(plan.root)
    assert.ok(!Object.prototype.hasOwnProperty.call(plan.root.body.settings, 'rentAmount'))
    assert.equal(plan.studentRent, null)
  })

  it('rejects invalid outgoing rent values before creating a write plan', () => {
    for (const rentAmount of [-1, 2.5, 1_000_001, '25']) {
      expectRejection(
        () => decomposeClassroomMutation({
          classroomId: CLASSROOM,
          data: { ...data, settings: { ...data.settings, rentAmount } },
          previous: data,
        }),
        PROJECTION_CATEGORIES.SHAPE,
      )
    }
  })

  it('aborts the whole mutation when a student carries a plaintext pin', () => {
    // This is the exact legacy roster object shape. It must abort rather than
    // be silently stripped, so a leak cannot pass unnoticed.
    const legacy = { ...student(), pin: '1234' }
    const error = expectRejection(
      () => decomposeClassroomMutation({ classroomId: CLASSROOM, data: { ...data, students: [legacy] } }),
      PROJECTION_CATEGORIES.CREDENTIAL,
    )
    assert.ok(!error.message.includes('1234'))
  })

  it('rejects a student body carrying any extra field', () => {
    expectRejection(
      () => decomposeClassroomMutation({
        classroomId: CLASSROOM,
        data: { ...data, students: [{ ...student(), nickname: 'A' }] },
      }),
      PROJECTION_CATEGORIES.SHAPE,
    )
  })

  it('skips documents that did not change', () => {
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data, previous: data })
    assert.equal(plan.root, null)
    assert.equal(plan.students.length, 0)
    assert.equal(plan.transactions.length, 0)
    assert.equal(plan.loginHistory.length, 0)
    assert.equal(plan.totalWrites, 0)
  })

  it('writes only the student that actually changed', () => {
    const previous = {
      ...data,
      students: [
        student({ id: 1, transactions: [transaction()] }),
        student({ id: 2, name: 'Bea' }),
      ],
    }
    const next = {
      ...previous,
      students: [
        student({ id: 1, transactions: [transaction()] }),
        student({ id: 2, name: 'Bea', balance: 99 }),
      ],
    }
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data: next, previous })
    assert.deepEqual(plan.students.map(w => w.id), ['2'])
  })

  it('detects a change confined to the transaction mirror', () => {
    const previous = { ...data, students: [student({ transactions: [] })] }
    const next = { ...data, students: [student({ transactions: [transaction()] })] }
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data: next, previous })
    assert.equal(plan.students.length, 1)
  })

  it('derives the persisted transaction mirror from the authoritative collection', () => {
    const staleMirror = { ...data, students: [student({ transactions: [] })] }
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data: staleMirror })
    assert.deepEqual(plan.students[0].body.transactions, [transaction()])
  })

  it('accepts retained transaction and login history for a removed student', () => {
    const plan = decomposeClassroomMutation({
      classroomId: CLASSROOM,
      data: {
        ...data,
        students: [],
        transactions: [transaction()],
        loginHistory: [historyEntry()],
      },
    })

    assert.deepEqual(plan.students, [])
    assert.deepEqual(plan.transactions.map(write => write.id), ['1700000000000'])
    assert.deepEqual(plan.loginHistory.map(write => write.id), ['1700000000001'])
  })

  it('sorts login history newest-first before applying the retention limit', () => {
    const oldestFirst = Array.from({ length: LOGIN_HISTORY_LIMIT + 2 }, (_, index) =>
      historyEntry({ id: 1_000_000 + index }))
    const plan = decomposeClassroomMutation({
      classroomId: CLASSROOM,
      data: {
        ...data,
        students: [],
        transactions: [],
        loginHistory: oldestFirst,
      },
      maxWrites: LOGIN_HISTORY_LIMIT + 10,
    })

    assert.equal(plan.loginHistory.length, LOGIN_HISTORY_LIMIT)
    assert.equal(plan.loginHistory[0].id, String(1_000_000 + LOGIN_HISTORY_LIMIT + 1))
    assert.equal(plan.loginHistory.at(-1).id, '1000002')
    assert.ok(!plan.loginHistory.some(write => write.id === '1000000' || write.id === '1000001'))
  })

  it('deletes login-history records trimmed beyond the cap', () => {
    const previous = { ...data, loginHistory: [historyEntry({ id: 1 }), historyEntry({ id: 2 })] }
    const next = { ...data, loginHistory: [historyEntry({ id: 2 })] }
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data: next, previous })
    assert.deepEqual(plan.deletes.map(d => d.path), [`classrooms/${CLASSROOM}/loginHistory/1`])
  })

  it('never emits a student delete, because deletion is server-only', () => {
    const previous = { ...data, students: [student({ id: 1 }), student({ id: 2, name: 'Bea' })] }
    const next = { ...data, students: [student({ id: 1 })] }
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data: next, previous })
    assert.ok(plan.deletes.every(d => !d.path.includes('/students/')))
  })

  it('never emits a credential path', () => {
    const plan = decomposeClassroomMutation({ classroomId: CLASSROOM, data })
    const paths = [
      plan.root?.path,
      ...plan.students.map(w => w.path),
      ...plan.transactions.map(w => w.path),
      ...plan.loginHistory.map(w => w.path),
      ...plan.deletes.map(d => d.path),
    ].filter(Boolean)
    assert.ok(paths.every(p => p.startsWith(`classrooms/${CLASSROOM}`)))
    assert.ok(paths.every(p => !/[Cc]redential/.test(p)))
  })

  it('enforces the bounded write budget', () => {
    const many = Array.from({ length: 40 }, (_, i) => transaction({ id: 2_000_000 + i }))
    expectRejection(
      () => decomposeClassroomMutation({
        classroomId: CLASSROOM,
        data: { ...data, transactions: many },
        maxWrites: 10,
      }),
      PROJECTION_CATEGORIES.SHAPE,
    )
  })

  it('rejects duplicate ids in the outgoing payload', () => {
    expectRejection(
      () => decomposeClassroomMutation({
        classroomId: CLASSROOM,
        data: { ...data, students: [student({ id: 1 }), student({ id: 1 })] },
      }),
      PROJECTION_CATEGORIES.DUPLICATE,
    )
  })

  it('requires a resolved classroom and an aggregate object', () => {
    expectRejection(
      () => decomposeClassroomMutation({ classroomId: '', data }),
      PROJECTION_CATEGORIES.TENANT,
    )
    expectRejection(
      () => decomposeClassroomMutation({ classroomId: CLASSROOM, data: null }),
      PROJECTION_CATEGORIES.SHAPE,
    )
  })
})

describe('Phase 3 tenant data projection — backup export', () => {
  it('produces a PIN-free backup body', () => {
    const backup = projectBackupExport({
      data: {
        students: [student()],
        transactions: [transaction()],
        loginHistory: [historyEntry()],
        settings: { requireTeacherApproval: true },
      },
      exportedAt: '2026-01-01T00:00:00.000Z',
    })
    const serialized = JSON.stringify(backup)
    for (const field of FORBIDDEN_CREDENTIAL_FIELDS) {
      assert.ok(!serialized.includes(`"${field}"`), `backup must not contain ${field}`)
    }
    assert.deepEqual(Object.keys(backup.students[0]).sort(), [...STUDENT_DOCUMENT_FIELDS].sort())
  })

  it('throws rather than silently stripping a credential field', () => {
    expectRejection(
      () => projectBackupExport({
        data: { students: [{ ...student(), pin: '1234' }] },
        exportedAt: '2026-01-01T00:00:00.000Z',
      }),
      PROJECTION_CATEGORIES.CREDENTIAL,
    )
  })

  it('rejects credential fields on every nested export surface without reporting values', () => {
    const cases = [
      {
        students: [student({
          transactions: [{ ...transaction(), metadata: [{ pinHash: 'mirror-secret' }] }],
        })],
      },
      { transactions: [{ ...transaction(), metadata: { authUid: 'transaction-secret' } }] },
      { loginHistory: [{ ...historyEntry(), metadata: [{ token: 'history-secret' }] }] },
      { settings: { nested: { password: 'settings-secret' } } },
    ]

    for (const [index, surface] of cases.entries()) {
      const secret = [
        'mirror-secret',
        'transaction-secret',
        'history-secret',
        'settings-secret',
      ][index]
      const error = expectRejection(
        () => projectBackupExport({
          data: {
            students: [student()],
            transactions: [transaction()],
            loginHistory: [historyEntry()],
            settings: {},
            ...surface,
          },
          exportedAt: '2026-01-01T00:00:00.000Z',
        }),
        PROJECTION_CATEGORIES.CREDENTIAL,
      )
      assert.ok(!error.message.includes(secret))
      assert.ok(!JSON.stringify(error.details).includes(secret))
    }
  })

  it('requires an exportedAt stamp', () => {
    expectRejection(
      () => projectBackupExport({ data: { students: [] } }),
      PROJECTION_CATEGORIES.SHAPE,
    )
  })
})

describe('Phase 3 tenant data projection — student self view', () => {
  it('projects only the authenticated student', () => {
    const result = projectStudentSelfData({
      classroomId: CLASSROOM,
      studentId: '1',
      student: student({ transactions: [transaction()] }),
    })
    assert.equal(result.students.length, 1)
    assert.equal(result.students[0].id, 1)
    assert.deepEqual(result.loginHistory, [])
  })

  it('projects only the exact rent document into the student settings view', () => {
    const studentRent = { rentAmount: 30, updatedAt: '2026-08-19T12:00:00.000Z' }
    const result = projectStudentSelfData({
      classroomId: CLASSROOM,
      studentId: '1',
      student: student(),
      studentRent,
      defaultSettings: { rentAmount: 0, studentRequestsEnabled: true },
    })

    assert.equal(result.settings.rentAmount, 30)
    assert.deepEqual(Object.keys(studentRent).sort(), [...STUDENT_RENT_DOCUMENT_FIELDS].sort())
  })

  it('fails closed when the document does not match the claim', () => {
    expectRejection(
      () => projectStudentSelfData({ classroomId: CLASSROOM, studentId: '1', student: student({ id: 2 }) }),
      PROJECTION_CATEGORIES.TENANT,
    )
  })

  it('fails closed when the document belongs to another classroom', () => {
    expectRejection(
      () => projectStudentSelfData({
        classroomId: CLASSROOM,
        studentId: '1',
        student: student({ classroomId: 'classroom-beta' }),
      }),
      PROJECTION_CATEGORIES.TENANT,
    )
  })

  it('refuses a student document carrying a credential field', () => {
    expectRejection(
      () => projectStudentSelfData({
        classroomId: CLASSROOM,
        studentId: '1',
        student: { ...student(), pinHash: 'x' },
      }),
      PROJECTION_CATEGORIES.CREDENTIAL,
    )
  })
})
