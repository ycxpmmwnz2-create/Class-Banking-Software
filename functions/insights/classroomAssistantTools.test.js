import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import {
  CLASSROOM_ASSISTANT_TOOL_DECLARATIONS,
  createClassroomAssistantToolbox,
} from './classroomAssistantTools.js'

function evidence() {
  return {
    question: 'Are there duplicate technology transactions today?',
    generatedAt: '2026-08-27T18:00:00.000Z',
    asOfDate: '2026-08-27',
    timeZone: 'America/Denver',
    periodDays: 7,
    periodStart: '2026-08-20T18:00:00.000Z',
    historyStart: '2026-05-29T18:00:00.000Z',
    configuredRentAmount: 10,
    students: [
      { ref: 'student-001', displayName: 'Ava R.', current: true, balance: 8, frozen: false },
      { ref: 'student-002', displayName: 'Ava S.', current: true, balance: -2, frozen: false },
    ],
    categories: [{ label: 'Technology', transactionTypes: ['Add'] }],
    transactions: [
      transaction('transaction-00001', 'student-001', '2026-08-27T15:00:00.000Z', 5),
      transaction('transaction-00002', 'student-001', '2026-08-27T15:02:00.000Z', 5),
      transaction('transaction-00003', 'student-002', '2026-08-26T16:00:00.000Z', 3),
    ],
  }
}

function transaction(ref, studentRef, date, amount) {
  return {
    ref,
    studentRef,
    date,
    type: 'Add',
    amount,
    category: 'Technology',
    purpose: 'other',
    status: 'Approved',
  }
}

test('publishes the read-only classroom tools including full-roster earnings', () => {
  assert.deepEqual(CLASSROOM_ASSISTANT_TOOL_DECLARATIONS.map(item => item.name), [
    'list_transactions',
    'aggregate_transactions',
    'find_students_without_transactions',
    'get_balances',
    'get_balance_history',
    'compare_periods',
    'compare_student_earnings',
    'describe_schema',
  ])
})

test('finds broad duplicate groups without exposing opaque refs in the group label', () => {
  const toolbox = createClassroomAssistantToolbox(evidence())
  const result = toolbox.execute('aggregate_transactions', {
    startDate: '2026-08-27',
    endDate: '2026-08-27',
    groupBy: ['student', 'category', 'transactionType', 'amount', 'status', 'purpose', 'calendarDay'],
    metric: 'count',
    minimumResult: 2,
  })
  assert.equal(result.ok, true)
  assert.equal(result.resultCount, 1)
  assert.equal(result.returnedCount, 1)
  assert.deepEqual(result.rows[0], {
    group: {
      student: 'Ava R.',
      category: 'Technology',
      transactionType: 'Add',
      amount: 5,
      status: 'Approved',
      purpose: 'other',
      calendarDay: '2026-08-27',
    },
    value: 2,
    transactionCount: 2,
    sharePercent: 100,
  })
})

test('keeps memos out by default and returns them only on explicit bounded requests', () => {
  let memoResolutions = 0
  const toolbox = createClassroomAssistantToolbox(evidence(), {
    memoResolver(transactionRef) {
      memoResolutions += 1
      assert.equal(transactionRef, 'transaction-00002')
      return { text: 'Technology helper', truncated: false }
    },
  })
  const ordinary = toolbox.execute('list_transactions', { limit: 1 })
  assert.equal(Object.hasOwn(ordinary.transactions[0], 'memo'), false)
  assert.equal(memoResolutions, 0)
  const withMemo = toolbox.execute('list_transactions', { includeMemos: true, limit: 1 })
  assert.equal(withMemo.transactions[0].memo, 'Technology helper')
  assert.equal(withMemo.transactions[0].memoTruncated, false)
  assert.equal(memoResolutions, 1)

  const unsafeMemo = createClassroomAssistantToolbox(evidence(), { memoResolver: () => null })
  assert.deepEqual(unsafeMemo.execute('list_transactions', { includeMemos: true, limit: 1 }), {
    ok: false,
    error: 'Memo text is unavailable.',
  })
})

test('answers current negative-balance and balance-history questions', () => {
  const toolbox = createClassroomAssistantToolbox(evidence())
  const negatives = toolbox.execute('get_balances', { condition: 'negative' })
  assert.deepEqual(negatives.students, [{
    studentRef: 'student-002',
    student: 'Ava S.',
    currentBalance: -2,
    frozen: false,
  }])
  assert.equal(negatives.matchedPercent, 50)
  assert.equal(negatives.averageBalance, -2)
  assert.equal(negatives.returnedCount, 1)
  const history = toolbox.execute('get_balance_history', {
    studentRefs: ['student-001'],
    startDate: '2026-08-26',
    endDate: '2026-08-27',
  })
  assert.deepEqual(history.rows, [
    { studentRef: 'student-001', student: 'Ava R.', date: '2026-08-26', closingBalance: -2 },
    { studentRef: 'student-001', student: 'Ava R.', date: '2026-08-27', closingBalance: 8 },
  ])
})

test('finds the exact current students without matching transactions', () => {
  const data = evidence()
  data.students.push({ ref: 'student-003', displayName: 'Liam', current: true, balance: 4, frozen: false })
  const result = createClassroomAssistantToolbox(data).execute('find_students_without_transactions', {
    startDate: '2026-08-27',
    endDate: '2026-08-27',
    categoryContains: 'Technology',
  })
  assert.deepEqual(result, {
    ok: true,
    windowStartDate: '2026-08-27',
    windowEndDate: '2026-08-27',
    windowDays: 1,
    currentStudentCount: 3,
    consideredStudentCount: 3,
    matchedTransactionCount: 2,
    studentsWithoutCount: 2,
    returnedCount: 2,
    truncated: false,
    students: [
      { studentRef: 'student-002', student: 'Ava S.', currentBalance: -2, frozen: false },
      { studentRef: 'student-003', student: 'Liam', currentBalance: 4, frozen: false },
    ],
  })
})

test('honestly truncates a 500-student complement while keeping output below the assistant cap', () => {
  const data = evidence()
  data.students = Array.from({ length: 500 }, (_, index) => ({
    ref: `student-${String(index + 1).padStart(3, '0')}`,
    displayName: `Learner ${String(index + 1).padStart(3, '0')}`,
    current: true,
    balance: index,
    frozen: false,
  }))
  data.transactions = []
  const result = createClassroomAssistantToolbox(data).execute('find_students_without_transactions', {
    startDate: '2026-08-27',
    endDate: '2026-08-27',
  })
  assert.equal(result.studentsWithoutCount, 500)
  assert.equal(result.returnedCount, 25)
  assert.equal(result.students.length, 25)
  assert.equal(result.truncated, true)
  assert.equal(Buffer.byteLength(JSON.stringify(result), 'utf8') < 32 * 1024, true)
})

test('default period filtering honors the exact rolling cutoff while explicit dates use classroom days', () => {
  const data = evidence()
  data.transactions = [
    transaction('transaction-00001', 'student-001', '2026-08-20T17:59:00.000Z', 4),
    transaction('transaction-00002', 'student-001', '2026-08-20T18:01:00.000Z', 5),
  ]
  const toolbox = createClassroomAssistantToolbox(data)
  const defaultWindow = toolbox.execute('aggregate_transactions', {
    groupBy: [],
    metric: 'count',
  })
  assert.equal(defaultWindow.matchedTransactionCount, 1)
  assert.deepEqual(
    [defaultWindow.windowStartDate, defaultWindow.windowEndDate, defaultWindow.windowDays],
    ['2026-08-20', '2026-08-27', 8],
  )
  assert.equal(defaultWindow.selectedPeriodDays, 7)
  assert.equal(toolbox.execute('list_transactions', {}).selectedPeriodDays, 7)
  assert.equal(toolbox.execute('find_students_without_transactions', {}).selectedPeriodDays, 7)
  const explicitWindow = toolbox.execute('aggregate_transactions', {
    startDate: '2026-08-20',
    endDate: '2026-08-20',
    groupBy: [],
    metric: 'count',
  })
  assert.equal(explicitWindow.matchedTransactionCount, 2)
  assert.deepEqual(
    [explicitWindow.windowStartDate, explicitWindow.windowEndDate, explicitWindow.windowDays],
    ['2026-08-20', '2026-08-20', 1],
  )
  assert.equal(Object.hasOwn(explicitWindow, 'selectedPeriodDays'), false)

  const ninetyDays = { ...data, periodDays: 90, periodStart: data.historyStart }
  assert.equal(createClassroomAssistantToolbox(ninetyDays).execute('aggregate_transactions', {
    groupBy: [],
    metric: 'count',
  }).ok, true)
})

test('supports open-ended summaries beyond the named example questions', () => {
  const toolbox = createClassroomAssistantToolbox(evidence())
  const median = toolbox.execute('aggregate_transactions', {
    groupBy: [],
    metric: 'amountMedian',
  })
  assert.equal(median.rows[0].value, 5)

  const shares = toolbox.execute('aggregate_transactions', {
    groupBy: ['student'],
    metric: 'count',
  })
  assert.deepEqual(shares.rows.map(row => row.sharePercent), [66.7, 33.3])

  const comparison = toolbox.execute('compare_periods', {
    firstStartDate: '2026-08-26',
    firstEndDate: '2026-08-26',
    secondStartDate: '2026-08-27',
    secondEndDate: '2026-08-27',
    metric: 'amountTotal',
  })
  assert.equal(comparison.difference, 7)
  assert.equal(comparison.percentChange, 233.3)
  assert.deepEqual(comparison.periods.map(period => period.windowDays), [1, 1])
  assert.equal(comparison.periods.some(period => Object.hasOwn(period, 'selectedPeriodDays')), false)
  assert.equal(toolbox.execute('describe_schema', {}).selectedPeriodDays, 7)
})

test('rejects unknown students and invalid ranges inside a safe tool error', () => {
  const toolbox = createClassroomAssistantToolbox(evidence())
  assert.deepEqual(toolbox.execute('get_balances', { studentRefs: ['student-999'] }), {
    ok: false,
    error: 'A tool list is malformed.',
  })
  assert.deepEqual(toolbox.execute('get_balances', { classroomId: 'another-classroom' }), {
    ok: false,
    error: 'Tool arguments contain an unsupported field.',
  })
  assert.deepEqual(toolbox.execute('compare_periods', {}), {
    ok: false,
    error: 'Tool arguments are missing a required field.',
  })
  assert.deepEqual(toolbox.execute('list_transactions', {
    startDate: '2026-08-27',
    endDate: '2026-08-20',
  }), { ok: false, error: 'The start date must not be after the end date.' })
  assert.deepEqual(toolbox.execute('list_transactions', { sort: 'ascending' }), {
    ok: false,
    error: 'A tool option is unsupported.',
  })
  assert.deepEqual(
    toolbox.execute('list_transactions', { sort: 'oldest', limit: 1 }).transactions.map(row => row.transactionRef),
    ['transaction-00003'],
  )
})

// The counts must describe the whole matched set, not the page that came back.
// Counting distinct names off a truncated row list is exactly the mistake these
// fields exist to remove, so a truncated result is the case that matters.
test('list_transactions counts distinct students across the whole matched set', () => {
  const students = [1, 2, 3].map(index => ({
    ref: `student-00${index}`,
    displayName: `Student ${index}`,
    current: true,
    balance: 10,
    frozen: false,
  }))
  const toolbox = createClassroomAssistantToolbox({
    ...evidence(),
    students,
    transactions: [1, 2, 3, 4, 5, 6].map(index => transaction(
      `transaction-0000${index}`,
      `student-00${(index % 3) + 1}`,
      `2026-08-27T15:0${index}:00.000Z`,
      5,
    )),
  })
  const truncated = toolbox.execute('list_transactions', { limit: 1 })
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.returnedCount, 1)
  assert.equal(truncated.matchedCount, 6)
  // One row came back, but three distinct students matched.
  assert.equal(truncated.distinctCurrentStudentCount, 3)
  assert.equal(truncated.distinctParticipantCount, 3)
  assert.equal(toolbox.execute('list_transactions', {}).distinctCurrentStudentCount, 3)
})

// A transaction from a student who has left the class still matches a filter,
// so the two counts describe different populations and must not be equal here.
// Reporting one number for both is what let a participant total be read as a
// statement about the current class.
test('the two distinct-student counts separate the current roster from all participants', () => {
  const data = {
    ...evidence(),
    students: [
      { ref: 'student-001', displayName: 'Ava R.', current: true, balance: 10, frozen: false },
      { ref: 'student-002', displayName: 'Ava S.', current: true, balance: 4, frozen: false },
      { ref: 'student-003', displayName: 'Ava T.', current: false, balance: 0, frozen: false },
    ],
    transactions: [
      transaction('transaction-00001', 'student-001', '2026-08-27T15:01:00.000Z', 5),
      transaction('transaction-00002', 'student-003', '2026-08-27T15:02:00.000Z', 5),
    ],
  }
  const toolbox = createClassroomAssistantToolbox(data)
  const listed = toolbox.execute('list_transactions', {})
  assert.equal(listed.matchedCount, 2)
  assert.equal(listed.distinctParticipantCount, 2)
  assert.equal(listed.distinctCurrentStudentCount, 1)
  // The row for the former student is still returned, so the historical answer
  // remains available -- only the headcount claim is constrained.
  assert.equal(listed.transactions.length, 2)

  const participants = toolbox.execute('aggregate_transactions', { groupBy: [], metric: 'distinctStudents' })
  const currentOnly = toolbox.execute('aggregate_transactions', { groupBy: [], metric: 'distinctCurrentStudents' })
  assert.equal(participants.rows[0].value, 2)
  assert.equal(currentOnly.rows[0].value, 1)

  const compared = toolbox.execute('compare_periods', {
    firstStartDate: '2026-08-26',
    firstEndDate: '2026-08-26',
    secondStartDate: '2026-08-27',
    secondEndDate: '2026-08-27',
    metric: 'distinctCurrentStudents',
  })
  assert.deepEqual(compared.periods.map(period => period.value), [0, 1])
})
