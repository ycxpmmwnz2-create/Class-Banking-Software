import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateQuestionAnswer, InsightQuestionAnswerError } from './questionAnswerCalculator.js'

const evidence = {
  configuredRentAmount: 10,
  periodDays: 30,
  periodStart: '2026-07-21T18:00:00.000Z',
  timeZone: 'America/Denver',
  asOfDate: '2026-08-20',
  participants: [
    { id: 1, alias: 'student-001', name: 'Genesis' },
    { id: 2, alias: 'student-002', name: 'Sofia' },
    { id: 3, alias: 'student-003', name: 'Mateo' },
  ],
  students: [
    { id: 1, alias: 'student-001', name: 'Genesis', balance: 42, frozen: false },
    { id: 2, alias: 'student-002', name: 'Sofia', balance: 75, frozen: false },
    { id: 3, alias: 'student-003', name: 'Mateo', balance: 75, frozen: true },
  ],
  categories: [
    { alias: 'category-001', label: 'Bathroom break' },
    { alias: 'category-002', label: 'Class job' },
    { alias: 'category-003', label: 'Store' },
  ],
  transactions: [
    { id: 1, studentId: 1, date: '2026-08-19T15:00:00.000Z', type: 'Subtract', amount: 1, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
    { id: 2, studentId: 1, date: '2026-08-19T16:00:00.000Z', type: 'Subtract', amount: 1, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
    { id: 3, studentId: 1, date: '2026-08-19T17:00:00.000Z', type: 'Subtract', amount: 1, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
    { id: 4, studentId: 2, date: '2026-08-19T20:00:00.000Z', type: 'Subtract', amount: 100, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
    { id: 5, studentId: 2, date: '2026-08-19T20:30:00.000Z', type: 'Subtract', amount: 100, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
    { id: 6, studentId: 1, date: '2026-08-19T21:00:00.000Z', type: 'Add', amount: 12, categoryAlias: 'category-002', purpose: 'other', status: 'Approved' },
    { id: 7, studentId: 1, date: '2026-08-19T22:00:00.000Z', type: 'Add', amount: 8, categoryAlias: 'category-002', purpose: 'other', status: 'Approved' },
    { id: 8, studentId: 1, date: '2026-08-19T23:00:00.000Z', type: 'Add', amount: 15, categoryAlias: 'category-003', purpose: 'other', status: 'Approved' },
    { id: 9, studentId: 3, date: '2026-08-19T20:00:00.000Z', type: 'Subtract', amount: 500, categoryAlias: 'category-001', purpose: 'other', status: 'Pending' },
  ],
}

const filters = {
  subjectAliases: [],
  categoryAlias: null,
  transactionType: 'any',
  status: 'Approved',
  dateScope: 'period',
  timeBucket: null,
  studentState: 'any',
}
const plan = overrides => ({
  dataset: 'transactions',
  metric: 'amount-total',
  filters,
  groupBy: 'none',
  order: 'highest',
  limit: 1,
  ...overrides,
})

test('answers from historical transactions after a student leaves the current roster', () => {
  const historicalEvidence = {
    ...evidence,
    participants: [
      ...evidence.participants,
      { id: 4, alias: 'student-004', name: 'Former Student' },
    ],
    transactions: [
      ...evidence.transactions,
      { id: 10, studentId: 4, date: '2026-08-19T16:30:00.000Z', type: 'Subtract', amount: 1, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
      { id: 11, studentId: 4, date: '2026-08-19T17:30:00.000Z', type: 'Subtract', amount: 1, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
      { id: 12, studentId: 4, date: '2026-08-19T18:30:00.000Z', type: 'Subtract', amount: 1, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
      { id: 13, studentId: 4, date: '2026-08-19T19:30:00.000Z', type: 'Subtract', amount: 1, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
    ],
  }
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: { ...filters, categoryAlias: 'category-001', transactionType: 'Subtract' },
      groupBy: 'student',
    }),
    evidence: historicalEvidence,
  })
  assert.match(result.answer, /Former Student.*highest.*4 transactions/)
})

test('answers restroom visits by approved transaction count rather than dollars spent', () => {
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: { ...filters, categoryAlias: 'category-001', transactionType: 'Subtract' },
      groupBy: 'student',
    }),
    evidence,
  })
  assert.match(result.answer, /Genesis.*highest.*transaction count: 3 transactions/)
  assert.doesNotMatch(result.answer, /Sofia.*highest/)
  assert.match(result.evidence[0], /Genesis: 3 transactions/)
  assert.doesNotMatch(result.answer, /approved spending \(Subtract\) transactions/)
  assert.match(result.evidence.join(' '), /approved spending \(Subtract\) transactions/)
})

test('compares submitted transactions across today and yesterday in the classroom time zone', () => {
  const technology = { alias: 'category-004', label: 'Technology' }
  const comparisonEvidence = {
    ...evidence,
    categories: [...evidence.categories, technology],
    transactions: [
      { id: 102, studentId: 1, date: '2026-08-20T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
      { id: 103, studentId: 1, date: '2026-08-18T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
    ],
  }
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: {
        ...filters,
        subjectAliases: ['student-001'],
        categoryAlias: technology.alias,
        transactionType: 'Add',
        status: 'any',
        dateScope: 'today-and-yesterday',
      },
      groupBy: 'calendar-day',
      order: 'highest',
      limit: 2,
    }),
    evidence: comparisonEvidence,
  })

  assert.equal(result.answer, 'Genesis had 1 Technology Add Money transaction (any status) today and none yesterday.')
  assert.match(result.evidence.join(' '), /Yesterday \(Aug 19, 2026\): 0 transactions/)
  assert.match(result.evidence.join(' '), /Today \(Aug 20, 2026\): 1 transaction/)
  assert.doesNotMatch(result.answer, /America\/Denver|all approval statuses|2026/)
  assert.match(result.evidence.join(' '), /all approval statuses/)
  assert.match(result.evidence.join(' '), /today and yesterday/)

  for (const order of ['chronological', 'lowest']) {
    const limited = calculateQuestionAnswer({
      kind: 'query',
      plan: plan({
        metric: 'count',
        filters: {
          ...filters,
          subjectAliases: ['student-001'],
          categoryAlias: technology.alias,
          transactionType: 'Add',
          status: 'any',
          dateScope: 'today-and-yesterday',
        },
        groupBy: 'calendar-day',
        order,
        limit: 1,
      }),
      evidence: comparisonEvidence,
    })
    assert.equal(limited.answer, 'Genesis had 1 Technology Add Money transaction (any status) today and none yesterday.')
  }

  const todayOnly = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: {
        ...filters,
        subjectAliases: ['student-001'],
        categoryAlias: technology.alias,
        transactionType: 'Add',
        status: 'any',
        dateScope: 'today',
      },
      groupBy: 'calendar-day',
      order: 'chronological',
    }),
    evidence: comparisonEvidence,
  })
  assert.equal(todayOnly.answer, 'Genesis had 1 Technology Add Money transaction (any status) today.')
})

test('answers approved today-and-yesterday payments in direct teacher-friendly language', () => {
  const technology = { alias: 'category-004', label: 'Technology' }
  const transactions = [
    { id: 101, studentId: 1, date: '2026-08-19T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
    { id: 102, studentId: 1, date: '2026-08-19T17:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
    { id: 103, studentId: 1, date: '2026-08-20T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
    { id: 104, studentId: 1, date: '2026-08-20T17:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
  ]
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: {
        ...filters,
        subjectAliases: ['student-001'],
        categoryAlias: technology.alias,
        transactionType: 'Add',
        status: 'Approved',
        dateScope: 'today-and-yesterday',
      },
      groupBy: 'calendar-day',
      order: 'chronological',
      limit: 2,
    }),
    evidence: {
      ...evidence,
      categories: [...evidence.categories, technology],
      transactions,
    },
  })

  assert.equal(
    result.answer,
    'Genesis had 2 approved Technology credits yesterday and 2 approved Technology credits today.',
  )
  assert.doesNotMatch(result.answer, /Chronological|Included records|America\/Denver|2026/)
  assert.match(result.evidence.join(' '), /approved earning \(Add\) transactions/)
})

test('answers all elapsed days this week from server dates and includes zero-count days', () => {
  const technology = { alias: 'category-004', label: 'Technology' }
  const weekEvidence = {
    ...evidence,
    asOfDate: '2026-08-26',
    categories: [...evidence.categories, technology],
    transactions: [
      { id: 201, studentId: 1, date: '2026-08-23T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
      { id: 202, studentId: 1, date: '2026-08-24T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
      { id: 203, studentId: 1, date: '2026-08-25T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
      { id: 204, studentId: 1, date: '2026-08-25T17:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
    ],
  }
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: {
        ...filters,
        subjectAliases: ['student-001'],
        categoryAlias: technology.alias,
        transactionType: 'Add',
        status: 'Approved',
        dateScope: 'this-week',
      },
      groupBy: 'calendar-day',
      order: 'highest',
      limit: 1,
    }),
    evidence: weekEvidence,
  })

  assert.equal(
    result.answer,
    'Genesis had 1 approved Technology credit on Monday, 2 yesterday, and none today.',
  )
  assert.doesNotMatch(result.answer, /Aug|2026|America\/Denver|Sunday/)
  assert.match(result.evidence.join(' '), /Monday \(Aug 24, 2026\): 1 transaction/)
  assert.match(result.evidence.join(' '), /Yesterday \(Aug 25, 2026\): 2 transactions/)
  assert.match(result.evidence.join(' '), /Today \(Aug 26, 2026\): 0 transactions/)
  assert.match(result.evidence.join(' '), /this week to date \(2026-08-24 through 2026-08-26 in America\/Denver\)/)
  assert.doesNotMatch(result.evidence.join(' '), /Aug 23/)
})

test('keeps a full current-week answer within bounds when guidance and labels are long', () => {
  const category = { alias: 'category-005', label: "Teacher's Choice" }
  const guidance = (
    'Use private check-ins and consistent earning opportunities to help students set a realistic goal without public comparisons. '
      .repeat(3)
      .slice(0, 236)
      .trimEnd()
  )
  const result = calculateQuestionAnswer({
    kind: 'query-and-guidance',
    guidance,
    plan: plan({
      metric: 'count',
      filters: {
        ...filters,
        categoryAlias: category.alias,
        transactionType: 'Add',
        status: 'any',
        dateScope: 'this-week',
      },
      groupBy: 'calendar-day',
      order: 'highest',
      limit: 1,
    }),
    evidence: {
      ...evidence,
      periodDays: 7,
      periodStart: '2026-08-23T06:30:00.000Z',
      asOfDate: '2026-08-30',
      categories: [...evidence.categories, category],
      transactions: [],
    },
  })

  assert.ok(result.answer.length <= 800)
  assert.match(result.answer, /Counts for Teacher's Choice Add Money transactions \(any status\):/)
  assert.equal(
    result.answer.match(/Teacher's Choice Add Money transactions \(any status\)/gu)?.length,
    1,
  )
  assert.match(result.answer, /on Monday.*yesterday.*today/u)
  assert.match(result.answer, /General Morgan Bank guidance:/)
})

test('keeps the full local week across fall-back DST without widening the rolling period', () => {
  const category = { alias: 'category-005', label: 'Technology' }
  const dstEvidence = {
    ...evidence,
    periodDays: 7,
    periodStart: '2026-10-26T06:30:00.000Z',
    asOfDate: '2026-11-01',
    categories: [...evidence.categories, category],
    transactions: [{
      id: 201,
      studentId: 1,
      date: '2026-10-26T06:20:00.000Z',
      type: 'Add',
      amount: 5,
      categoryAlias: category.alias,
      purpose: 'other',
      status: 'Approved',
    }],
  }
  const commonFilters = {
    ...filters,
    categoryAlias: category.alias,
    transactionType: 'Add',
    status: 'Approved',
  }
  const weekResult = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: { ...commonFilters, dateScope: 'this-week' },
      groupBy: 'calendar-day',
      order: 'chronological',
      limit: 7,
    }),
    evidence: dstEvidence,
  })
  const periodResult = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: { ...commonFilters, dateScope: 'period' },
      groupBy: 'none',
    }),
    evidence: dstEvidence,
  })

  assert.match(weekResult.answer, /^Counts for approved Technology credits: 1 on Monday/)
  assert.equal(periodResult.answer, 'The Technology transaction count is 0 transactions over the last 7 days.')
})

test('uses payment only for approved Subtract records and neutral wording for unresolved statuses', () => {
  const technology = { alias: 'category-004', label: 'Technology' }
  const cases = [
    { transactionType: 'Add', status: 'Pending', noun: 'pending Technology Add Money transaction' },
    { transactionType: 'Add', status: 'Denied', noun: 'denied Technology Add Money transaction' },
    { transactionType: 'Subtract', status: 'Approved', noun: 'approved Technology payment' },
    { transactionType: 'Subtract', status: 'Pending', noun: 'pending Technology Subtract Money transaction' },
    { transactionType: 'Subtract', status: 'Denied', noun: 'denied Technology Subtract Money transaction' },
  ]

  for (const { transactionType, status, noun } of cases) {
    const result = calculateQuestionAnswer({
      kind: 'query',
      plan: plan({
        metric: 'count',
        filters: {
          ...filters,
          subjectAliases: ['student-001'],
          categoryAlias: technology.alias,
          transactionType,
          status,
          dateScope: 'today',
        },
        groupBy: 'calendar-day',
        order: 'chronological',
      }),
      evidence: {
        ...evidence,
        categories: [...evidence.categories, technology],
        transactions: [{
          id: 101,
          studentId: 1,
          date: '2026-08-20T16:00:00.000Z',
          type: transactionType,
          amount: 5,
          categoryAlias: technology.alias,
          purpose: 'other',
          status,
        }],
      },
    })

    assert.equal(result.answer, `Genesis had 1 ${noun} today.`)
  }
})

test('keeps technical dates out of aggregate headlines and capitalizes named-student calendar dates', () => {
  const technology = { alias: 'category-004', label: 'Technology' }
  const answerEvidence = {
    ...evidence,
    categories: [...evidence.categories, technology],
    transactions: [{
      id: 101,
      studentId: 1,
      date: '2026-08-20T16:00:00.000Z',
      type: 'Add',
      amount: 5,
      categoryAlias: technology.alias,
      purpose: 'other',
      status: 'Approved',
    }],
  }
  const aggregate = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: {
        ...filters,
        subjectAliases: ['student-001'],
        categoryAlias: technology.alias,
        transactionType: 'Add',
        dateScope: 'today',
      },
      groupBy: 'none',
    }),
    evidence: answerEvidence,
  })
  const calendarAmount = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'amount-total',
      filters: {
        ...filters,
        subjectAliases: ['student-001'],
        categoryAlias: technology.alias,
        transactionType: 'Add',
        dateScope: 'today',
      },
      groupBy: 'calendar-day',
      order: 'chronological',
    }),
    evidence: answerEvidence,
  })
  const multiDayEvidence = {
    ...answerEvidence,
    transactions: [
      { ...answerEvidence.transactions[0], id: 102, date: '2026-08-18T16:00:00.000Z', amount: 5 },
      { ...answerEvidence.transactions[0], id: 103, date: '2026-08-19T16:00:00.000Z', amount: 7 },
    ],
  }
  const multiDayPlan = plan({
    metric: 'amount-total',
    filters: {
      ...filters,
      subjectAliases: ['student-001'],
      categoryAlias: technology.alias,
      transactionType: 'Add',
      dateScope: 'period',
    },
    groupBy: 'calendar-day',
    order: 'chronological',
    limit: 8,
  })
  const multiDayChronological = calculateQuestionAnswer({
    kind: 'query',
    plan: multiDayPlan,
    evidence: multiDayEvidence,
  })
  const multiDayHighest = calculateQuestionAnswer({
    kind: 'query',
    plan: { ...multiDayPlan, order: 'highest' },
    evidence: multiDayEvidence,
  })
  const tiedCalendarDays = calculateQuestionAnswer({
    kind: 'query',
    plan: { ...multiDayPlan, order: 'highest', limit: 1 },
    evidence: {
      ...multiDayEvidence,
      transactions: multiDayEvidence.transactions.map(transaction => ({ ...transaction, amount: 5 })),
    },
  })

  assert.equal(aggregate.answer, 'The Technology transaction count is 1 transaction today.')
  assert.doesNotMatch(aggregate.answer, /America\/Denver|2026/)
  assert.match(aggregate.evidence.join(' '), /today \(2026-08-20 in America\/Denver\)/)
  assert.match(calendarAmount.answer, /^For Genesis, Aug 20, 2026/)
  assert.doesNotMatch(calendarAmount.answer, /^For Genesis, aug/)
  assert.match(multiDayChronological.answer, /^For Genesis, by day:/)
  assert.match(multiDayHighest.answer, /^For Genesis, highest Technology total amount:/)
  assert.match(tiedCalendarDays.answer, /^For Genesis, Aug 18, 2026 and Aug 19, 2026 are tied/)
})

test('keeps calendar comparisons natural for yesterday-only, neither-day, and filtered class scopes', () => {
  const technology = { alias: 'category-004', label: 'Technology' }
  const comparisonPlan = plan({
    metric: 'count',
    filters: {
      ...filters,
      subjectAliases: ['student-001'],
      categoryAlias: technology.alias,
      transactionType: 'Add',
      status: 'any',
      dateScope: 'today-and-yesterday',
    },
    groupBy: 'calendar-day',
    order: 'chronological',
    limit: 2,
  })
  const answerEvidence = {
    ...evidence,
    categories: [...evidence.categories, technology],
    transactions: [],
  }
  const neither = calculateQuestionAnswer({
    kind: 'query',
    plan: comparisonPlan,
    evidence: answerEvidence,
  })
  const yesterdayOnly = calculateQuestionAnswer({
    kind: 'query',
    plan: comparisonPlan,
    evidence: {
      ...answerEvidence,
      transactions: [{ id: 101, studentId: 1, date: '2026-08-19T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Pending' }],
    },
  })
  const frozenScope = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      ...comparisonPlan,
      filters: {
        ...comparisonPlan.filters,
        subjectAliases: [],
        studentState: 'frozen',
      },
    },
    evidence: answerEvidence,
  })
  const frozenToday = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      ...comparisonPlan,
      filters: {
        ...comparisonPlan.filters,
        subjectAliases: [],
        studentState: 'frozen',
      },
    },
    evidence: {
      ...answerEvidence,
      transactions: [{ id: 102, studentId: 3, date: '2026-08-20T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' }],
    },
  })
  const noSubjectBothDays = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      ...comparisonPlan,
      filters: {
        ...comparisonPlan.filters,
        subjectAliases: [],
        status: 'Approved',
      },
    },
    evidence: {
      ...answerEvidence,
      transactions: [
        { id: 103, studentId: 1, date: '2026-08-19T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
        { id: 104, studentId: 1, date: '2026-08-20T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
        { id: 105, studentId: 2, date: '2026-08-20T17:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
      ],
    },
  })

  assert.equal(neither.answer, 'Genesis had no Technology Add Money transactions (any status) yesterday or today.')
  assert.equal(yesterdayOnly.answer, 'Genesis had 1 Technology Add Money transaction (any status) yesterday and none today.')
  assert.equal(frozenScope.answer, 'There were no Technology Add Money transactions (any status) yesterday or today.')
  assert.equal(frozenToday.answer, 'There was 1 Technology Add Money transaction (any status) today and none yesterday.')
  assert.equal(noSubjectBothDays.answer, 'There was 1 approved Technology credit yesterday and there were 2 approved Technology credits today.')
  assert.doesNotMatch(frozenScope.answer, /The class/)
  assert.match(frozenScope.evidence.join(' '), /current frozen students/)
})

test('lists every current student balance alphabetically in one bounded answer', () => {
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: { operation: 'list-student-balances' },
    evidence,
  })
  assert.equal(
    result.answer,
    'Current balances for all 3 students:\nGenesis: $42.00\nMateo: $75.00\nSofia: $75.00',
  )
  assert.deepEqual(result.evidence, [
    'Current roster students checked: 3; every current balance is included.',
  ])

  const empty = calculateQuestionAnswer({
    kind: 'query',
    plan: { operation: 'list-student-balances' },
    evidence: { ...evidence, participants: [], students: [], transactions: [] },
  })
  assert.equal(empty.answer, 'There are no current students in this classroom.')
  assert.throws(() => calculateQuestionAnswer({
    kind: 'query',
    plan: { operation: 'list-student-balances', limit: 8 },
    evidence,
  }), InsightQuestionAnswerError)
})

test('places combined guidance on its own line after the complete balance list', () => {
  const guidance = 'Review the result privately and help students set one realistic savings goal this week.'
  const result = calculateQuestionAnswer({
    kind: 'query-and-guidance',
    plan: { operation: 'list-student-balances' },
    guidance,
    evidence,
  })
  assert.equal(
    result.answer,
    `Current balances for all 3 students:\nGenesis: $42.00\nMateo: $75.00\nSofia: $75.00\nGeneral Morgan Bank guidance: ${guidance}`,
  )
})

test('full balance list includes the maximum bounded 500-student roster without truncation', () => {
  const students = Array.from({ length: 500 }, (_, index) => {
    const id = index + 1
    const suffix = String(id).padStart(3, '0')
    return {
      id,
      alias: `student-${suffix}`,
      name: `${'Student name '.repeat(9)}${suffix}`.slice(0, 120),
      balance: Number.MAX_SAFE_INTEGER,
      frozen: false,
    }
  })
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: { operation: 'list-student-balances' },
    evidence: {
      ...evidence,
      participants: students.map(({ id, alias, name }) => ({ id, alias, name })),
      students,
      transactions: [],
    },
  })
  assert.match(result.answer, /^Current balances for all 500 students:/)
  assert.ok(result.answer.length > 800)
  assert.ok(result.answer.length <= 80_000)
  for (const student of students) {
    assert.ok(result.answer.includes(`${student.name}: $9,007,199,254,740,991.00`))
  }
})

test('lists current students without an approved exact rent payment today', () => {
  const students = [
    ...evidence.students,
    { id: 4, alias: 'student-004', name: 'Ava', balance: 30, frozen: false },
  ]
  const participants = students.map(({ id, alias, name }) => ({ id, alias, name }))
  const rentCategory = { alias: 'category-004', label: 'Uncategorized' }
  const rentTransactions = [
    { id: 101, studentId: 1, date: '2026-08-20T16:00:00.000Z', type: 'Subtract', amount: 10, categoryAlias: rentCategory.alias, purpose: 'rent', status: 'Approved' },
    { id: 102, studentId: 2, date: '2026-08-20T16:05:00.000Z', type: 'Subtract', amount: 5, categoryAlias: rentCategory.alias, purpose: 'rent', status: 'Approved' },
    { id: 103, studentId: 3, date: '2026-08-19T16:10:00.000Z', type: 'Subtract', amount: 10, categoryAlias: rentCategory.alias, purpose: 'rent', status: 'Approved' },
    { id: 104, studentId: 4, date: '2026-08-20T16:15:00.000Z', type: 'Subtract', amount: 10, categoryAlias: rentCategory.alias, purpose: 'rent', status: 'Pending' },
  ]
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      operation: 'students-without-transactions',
      subjectAliases: [],
      categoryAlias: null,
      purpose: 'rent',
      transactionType: 'Subtract',
      status: 'Approved',
      dateScope: 'today',
      amountExact: 10,
      studentState: 'any',
      limit: 8,
    },
    evidence: {
      ...evidence,
      participants,
      students,
      categories: [...evidence.categories, rentCategory],
      transactions: rentTransactions,
    },
  })
  assert.match(result.answer, /^Yes\. 3 of 4 current students/)
  assert.match(result.answer, /Ava.*Mateo.*Sofia/)
  assert.doesNotMatch(result.answer, /Genesis.*no matching/)
  assert.doesNotMatch(result.answer, /approved spending \(Subtract\) transactions|America\/Denver/)
  const details = result.evidence.join(' ')
  assert.match(details, /approved spending \(Subtract\) transactions/)
  assert.match(details, /rent payments/)
  assert.match(details, /exactly \$10\.00/)
  assert.match(details, /today \(2026-08-20 in America\/Denver\)/)
  assert.match(details, /all current students/)

  const allPaid = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      operation: 'students-without-transactions',
      subjectAliases: [],
      categoryAlias: null,
      purpose: 'rent',
      transactionType: 'Subtract',
      status: 'Approved',
      dateScope: 'today',
      amountExact: 10,
      studentState: 'any',
      limit: 8,
    },
    evidence: {
      ...evidence,
      participants,
      students,
      categories: [...evidence.categories, rentCategory],
      transactions: students.map((student, index) => ({
        id: 201 + index,
        studentId: student.id,
        date: '2026-08-20T17:00:00.000Z',
        type: 'Subtract',
        amount: 10,
        categoryAlias: rentCategory.alias,
        purpose: 'rent',
        status: 'Approved',
      })),
    },
  })
  assert.match(allPaid.answer, /^No\. All 4 current students have a matching rent payment\./)
  assert.match(allPaid.evidence[0], /students without a match: 0/)

  const configuredAmount = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      operation: 'students-without-transactions',
      subjectAliases: [],
      categoryAlias: null,
      purpose: 'rent',
      transactionType: 'Subtract',
      status: 'Approved',
      dateScope: 'today',
      amountExact: null,
      studentState: 'any',
      limit: 8,
    },
    evidence: {
      ...evidence,
      participants,
      students,
      categories: [...evidence.categories, rentCategory],
      transactions: rentTransactions,
    },
  })
  assert.match(configuredAmount.answer, /^Yes\. 3 of 4 current students/)
  assert.doesNotMatch(configuredAmount.answer, /configured rent amount of \$10\.00/)
  assert.match(configuredAmount.evidence.join(' '), /configured rent amount of \$10\.00/)
  assert.doesNotMatch(configuredAmount.answer, /Genesis.*no matching/)
})

test('applies the rolling cutoff consistently to missing-payment and current-week plans', () => {
  const rentCategory = { alias: 'category-004', label: 'Rent' }
  const dstEvidence = {
    ...evidence,
    configuredRentAmount: 10,
    periodDays: 7,
    periodStart: '2026-10-26T06:30:00.000Z',
    asOfDate: '2026-11-01',
    categories: [...evidence.categories, rentCategory],
    transactions: [{
      id: 201,
      studentId: 1,
      date: '2026-10-26T06:20:00.000Z',
      type: 'Subtract',
      amount: 10,
      categoryAlias: rentCategory.alias,
      purpose: 'rent',
      status: 'Approved',
    }],
  }
  const missingPlan = dateScope => ({
    operation: 'students-without-transactions',
    subjectAliases: [],
    categoryAlias: null,
    purpose: 'rent',
    transactionType: 'Subtract',
    status: 'Approved',
    dateScope,
    amountExact: 10,
    studentState: 'any',
    limit: 8,
  })
  const periodResult = calculateQuestionAnswer({
    kind: 'query',
    plan: missingPlan('period'),
    evidence: dstEvidence,
  })
  const weekResult = calculateQuestionAnswer({
    kind: 'query',
    plan: missingPlan('this-week'),
    evidence: dstEvidence,
  })

  assert.match(periodResult.answer, /^Yes\. 3 of 3 current students/)
  assert.match(periodResult.answer, /Genesis.*Mateo.*Sofia/u)
  assert.match(weekResult.answer, /^Yes\. 2 of 3 current students/)
  assert.doesNotMatch(weekResult.answer, /Genesis.*no matching/u)
})

test('calculates a named student category ranking without sending facts to the model', () => {
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      filters: { ...filters, subjectAliases: ['student-001'], transactionType: 'Add' },
      groupBy: 'category',
    }),
    evidence,
  })
  assert.match(result.answer, /class job.*highest total amount.*\$20\.00/i)
  assert.doesNotMatch(result.answer, /Store.*highest/)
})

test('preserves ties, status filters, balance rankings, and grounded unsupported answers', () => {
  const balanceResult = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      dataset: 'students',
      metric: 'current-balance',
      filters: { ...filters, status: 'any' },
      groupBy: 'student',
    }),
    evidence,
  })
  assert.match(balanceResult.answer, /Mateo and Sofia are tied.*\$75\.00/)
  assert.doesNotMatch(JSON.stringify(balanceResult), /\$500/)

  const unsupported = calculateQuestionAnswer({ kind: 'unsupported', plan: null, evidence })
  assert.match(unsupported.answer, /Morgan Bank.*classroom-economy routines/i)
})

test('returns bounded Morgan Bank guidance without claiming it came from classroom records', () => {
  const guidance = 'Use consistent earning categories, invite students to set a savings goal, and review the routine before optional classroom purchases.'
  const result = calculateQuestionAnswer({
    kind: 'guidance',
    plan: null,
    guidance,
    evidence,
  })
  assert.equal(result.answer, guidance)
  assert.deepEqual(result.evidence, [
    'General Morgan Bank guidance; no classroom records were used to make a factual claim.',
  ])
  for (const invalid of [
    'Ask student-001 to save more each week.',
    'Read https://example.com for classroom banking ideas.',
    'Too short.',
  ]) {
    assert.throws(() => calculateQuestionAnswer({
      kind: 'guidance',
      plan: null,
      guidance: invalid,
      evidence,
    }), InsightQuestionAnswerError)
  }
})

test('combines calculated classroom facts with clearly labeled general Morgan Bank guidance', () => {
  const guidance = 'Review the result privately and offer a consistent earning routine so students can choose a realistic next goal.'
  const result = calculateQuestionAnswer({
    kind: 'query-and-guidance',
    plan: plan({
      metric: 'count',
      filters: { ...filters, categoryAlias: 'category-001', transactionType: 'Subtract' },
      groupBy: 'student',
      limit: 1,
    }),
    guidance,
    evidence,
  })
  assert.match(result.answer, /^Genesis has the highest Bathroom break transaction count: 3 transactions\./)
  assert.match(result.answer, /General Morgan Bank guidance: Review the result privately/)
  assert.ok(result.answer.length <= 800)
  assert.match(result.evidence.join(' '), /Records checked:/)
})

test('answers broad roster questions about student count, frozen accounts, and average balance', () => {
  const frozenCount = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      dataset: 'students',
      metric: 'count',
      filters: { ...filters, status: 'any', studentState: 'frozen' },
      groupBy: 'none',
    }),
    evidence,
  })
  assert.match(frozenCount.answer, /frozen student count is 1 student/)
  assert.doesNotMatch(frozenCount.answer, /current frozen students/)
  assert.match(frozenCount.evidence[0], /current frozen students/)

  const average = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      dataset: 'students',
      metric: 'average-balance',
      filters: { ...filters, status: 'any' },
      groupBy: 'none',
    }),
    evidence,
  })
  assert.match(average.answer, /average current balance is \$64\.00/)
  assert.match(average.evidence[0], /across 3 students/)

  const comparison = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      dataset: 'students',
      metric: 'current-balance',
      filters: {
        ...filters,
        subjectAliases: ['student-002', 'student-003'],
        status: 'any',
      },
      groupBy: 'student',
    }),
    evidence,
  })
  assert.match(comparison.answer, /Mateo and Sofia are tied.*\$75\.00/)
  assert.doesNotMatch(comparison.answer, /Genesis/)
})

test('supports time groups, net totals, averages, and chronological output server-side', () => {
  const timeResult = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: { ...filters, transactionType: 'Subtract' },
      groupBy: 'time-of-day',
      order: 'chronological',
      limit: 4,
    }),
    evidence,
  })
  assert.match(timeResult.answer, /^By time of day:/)
  assert.ok(timeResult.evidence.length >= 2)

  const average = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({ metric: 'amount-average' }),
    evidence,
  })
  assert.match(average.answer, /average amount is \$29\.75/)

  const net = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({ metric: 'net-amount' }),
    evidence,
  })
  assert.match(net.answer, /net amount is −\$168\.00/)
})

test('unknown aliases and malformed evidence fail closed', () => {
  assert.throws(() => calculateQuestionAnswer({
    kind: 'query',
    plan: plan({ filters: { ...filters, categoryAlias: 'category-999' } }),
    evidence,
  }), InsightQuestionAnswerError)
  assert.throws(() => calculateQuestionAnswer({
    kind: 'query',
    plan: plan({}),
    evidence: { ...evidence, transactions: [{ ...evidence.transactions[0], studentId: 999 }] },
  }), InsightQuestionAnswerError)
  assert.throws(() => calculateQuestionAnswer({
    kind: 'query',
    plan: plan({}),
    evidence: { ...evidence, transactions: [evidence.transactions[0], { ...evidence.transactions[0] }] },
  }), InsightQuestionAnswerError)
  assert.throws(() => calculateQuestionAnswer({
    kind: 'query',
    plan: plan({}),
    evidence: {
      ...evidence,
      transactions: [
        { ...evidence.transactions[0], amount: Number.MAX_VALUE },
        { ...evidence.transactions[1], amount: Number.MAX_VALUE },
      ],
    },
  }), InsightQuestionAnswerError)
  assert.throws(() => calculateQuestionAnswer({
    kind: 'query',
    plan: plan({}),
    evidence: { ...evidence, configuredRentAmount: 10.5 },
  }), InsightQuestionAnswerError)
})

test('large ties stay explicit without exceeding the public evidence bound', () => {
  const students = Array.from({ length: 9 }, (_, index) => ({
    id: index + 1,
    alias: `student-${String(index + 1).padStart(3, '0')}`,
    name: `Student ${index + 1}`,
    balance: 0,
    frozen: false,
  }))
  const transactions = students.map((student, index) => ({
    id: index + 1,
    studentId: student.id,
    date: '2026-08-19T15:00:00.000Z',
    type: 'Subtract',
    amount: 1,
    categoryAlias: 'category-001',
    purpose: 'other',
    status: 'Approved',
  }))
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: { ...filters, categoryAlias: 'category-001', transactionType: 'Subtract' },
      groupBy: 'student',
    }),
    evidence: {
      ...evidence,
      participants: students.map(({ id, alias, name }) => ({ id, alias, name })),
      students,
      transactions,
    },
  })
  assert.match(result.answer, /1 more are tied at the cutoff/)
  assert.equal(result.evidence.length, 8)
})

test('keeps status, type, time, and current-student filters in details instead of the main answer', () => {
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: {
        ...filters,
        transactionType: 'Subtract',
        status: 'Pending',
        dateScope: 'period',
        timeBucket: 'afternoon',
        studentState: 'frozen',
      },
    }),
    evidence,
  })
  assert.doesNotMatch(result.answer, /pending spending \(Subtract\) transactions|afternoon|current frozen students/)
  const details = result.evidence.join(' ')
  assert.match(details, /pending spending \(Subtract\) transactions/)
  assert.match(details, /afternoon \(12:00 PM–4:59 PM\)/)
  assert.match(details, /current frozen students/)
  assert.equal(result.answer.match(/last 30 days/g)?.length, 1)
})

test('reports no matches instead of synthetic zero-dollar averages', () => {
  const noStudents = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      dataset: 'students',
      metric: 'average-balance',
      filters: {
        ...filters,
        subjectAliases: ['student-001'],
        status: 'any',
        studentState: 'frozen',
      },
    }),
    evidence,
  })
  assert.match(noStudents.answer, /could not find any matching students/)
  assert.doesNotMatch(noStudents.answer, /\$0\.00/)

  const noTransactions = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'amount-average',
      filters: {
        ...filters,
        categoryAlias: 'category-003',
        status: 'Pending',
      },
    }),
    evidence,
  })
  assert.match(noTransactions.answer, /could not find any matching records/)
  assert.doesNotMatch(noTransactions.answer, /\$0\.00/)
})

test('calculator independently enforces the canonical cross-field plan rules', () => {
  for (const invalidPlan of [
    plan({
      dataset: 'students',
      metric: 'average-balance',
      filters: { ...filters, transactionType: 'Add', status: 'any' },
    }),
    plan({ metric: 'net-amount', filters: { ...filters, transactionType: 'Add' } }),
    plan({ order: 'chronological' }),
  ]) {
    assert.throws(() => calculateQuestionAnswer({ kind: 'query', plan: invalidPlan, evidence }), InsightQuestionAnswerError)
  }
})

test('bounds maximum-length ranked labels inside the public response contract', () => {
  const categories = Array.from({ length: 8 }, (_, index) => ({
    alias: `category-${String(index + 1).padStart(3, '0')}`,
    label: `${String(index + 1).padStart(3, '0')}-${'Long category label '.repeat(8)}`.slice(0, 120),
  }))
  const transactions = categories.map((category, index) => ({
    id: index + 100,
    studentId: 1,
    date: '2026-08-19T15:00:00.000Z',
    type: 'Add',
    amount: 100 - index,
    categoryAlias: category.alias,
    purpose: 'other',
    status: 'Approved',
  }))
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      filters: { ...filters, subjectAliases: ['student-001'], transactionType: 'Add' },
      groupBy: 'category',
      limit: 8,
    }),
    evidence: { ...evidence, categories, transactions },
  })
  assert.ok(result.answer.length <= 800)
  assert.equal(result.evidence.length, 8)
  assert.ok(result.evidence.every(line => line.length <= 320))
  assert.match(result.answer, /…/)
})

test('reserves public response space while fitting combined ranked guidance', () => {
  const categories = Array.from({ length: 8 }, (_, index) => ({
    alias: `category-${String(index + 1).padStart(3, '0')}`,
    label: `${String(index + 1).padStart(3, '0')}-${'Long category label '.repeat(8)}`.slice(0, 120),
  }))
  const transactions = categories.map((category, index) => ({
    id: index + 200,
    studentId: 1,
    date: '2026-08-19T15:00:00.000Z',
    type: 'Add',
    amount: 100 - index,
    categoryAlias: category.alias,
    purpose: 'other',
    status: 'Approved',
  }))
  const guidance = 'Review the result privately and use a consistent classroom routine. '.padEnd(240, 'Keep choices predictable. ').slice(0, 240)
  const result = calculateQuestionAnswer({
    kind: 'query-and-guidance',
    plan: plan({
      filters: { ...filters, subjectAliases: ['student-001'], transactionType: 'Add' },
      groupBy: 'category',
      limit: 8,
    }),
    guidance,
    evidence: { ...evidence, categories, transactions },
  })
  assert.ok(result.answer.length <= 800)
  assert.match(result.answer, /General Morgan Bank guidance:/)
  assert.match(result.answer, /…/)
  assert.equal(result.evidence.length, 8)
  assert.ok(result.evidence.every(line => line.length <= 320))
})

test('dynamically fits ranked, aggregate, and empty results with every disclosure filter', () => {
  const students = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    alias: `student-${String(index + 1).padStart(3, '0')}`,
    name: String.fromCharCode(65 + index).repeat(120),
    balance: 10,
    frozen: true,
  }))
  const category = {
    alias: 'category-001',
    label: `Rent ${'R'.repeat(115)}`,
  }
  const transactions = students.map((student, index) => ({
    id: index + 1,
    studentId: student.id,
    date: '2026-08-19T20:00:00.000Z',
    type: index % 2 ? 'Add' : 'Subtract',
    amount: 10,
    categoryAlias: category.alias,
    purpose: 'other',
    status: index % 3 ? 'Approved' : 'Pending',
  }))
  const queryFilters = {
    ...filters,
    subjectAliases: students.map(student => student.alias),
    categoryAlias: category.alias,
    transactionType: 'any',
    status: 'any',
    dateScope: 'period',
    timeBucket: 'afternoon',
    studentState: 'frozen',
  }
  const answerEvidence = {
    ...evidence,
    participants: students.map(({ id, alias, name }) => ({ id, alias, name })),
    students,
    categories: [category],
    transactions,
  }
  const rankedResult = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: queryFilters,
      groupBy: 'student',
      limit: 8,
    }),
    evidence: answerEvidence,
  })
  const aggregateResult = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({ metric: 'count', filters: queryFilters, groupBy: 'none', limit: 1 }),
    evidence: answerEvidence,
  })
  const emptyResult = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({ metric: 'count', filters: queryFilters, groupBy: 'student', limit: 8 }),
    evidence: { ...answerEvidence, transactions: [] },
  })

  assert.equal(rankedResult.evidence.length, 8)
  for (const result of [rankedResult, aggregateResult, emptyResult]) {
    assert.ok(result.answer.length <= 800)
    assert.ok(result.evidence.every(line => line.length <= 320))
    assert.match([result.answer, ...result.evidence].join(' '), /…/)
    assert.doesNotMatch(result.answer, /earning \(Add\) and spending \(Subtract\)|all approval statuses|afternoon|current frozen students/)
    const details = result.evidence.join(' ')
    assert.match(details, /earning \(Add\) and spending \(Subtract\)/)
    assert.match(details, /all approval statuses/)
    assert.match(details, /afternoon \(12:00 PM–4:59 PM\)/)
    assert.match(details, /current frozen students/)
  }
  assert.match(emptyResult.answer, /could not find any matching records/)
})

test('answers distinct-day alternatives without dumping every transaction count', () => {
  const technology = { alias: 'category-004', label: 'Technology' }
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      operation: 'analyze',
      queries: [plan({
        metric: 'distinct-days',
        filters: {
          ...filters,
          subjectAliases: ['student-001'],
          categoryAlias: technology.alias,
          transactionType: 'Add',
          dateScope: 'this-week',
          lookbackDays: null,
          balanceCondition: 'any',
        },
        groupBy: 'none',
        order: 'highest',
        limit: 1,
      })],
    },
    evidence: {
      ...evidence,
      generatedAt: '2026-08-20T18:00:00.000Z',
      categories: [...evidence.categories, technology],
      transactions: [
        { id: 101, studentId: 1, date: '2026-08-18T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
        { id: 102, studentId: 1, date: '2026-08-19T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
        { id: 103, studentId: 1, date: '2026-08-20T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: technology.alias, purpose: 'other', status: 'Approved' },
      ],
    },
  })
  assert.match(result.answer, /3 distinct days this week/)
  assert.match(result.evidence.join(' '), /2026-08-18, 2026-08-19, and 2026-08-20/)
})

test('supports current negative-balance lists and named balance history through general queries', () => {
  const negativeResult = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      operation: 'analyze',
      queries: [plan({
        dataset: 'students',
        metric: 'current-balance',
        filters: {
          ...filters,
          status: 'any',
          lookbackDays: null,
          balanceCondition: 'negative',
        },
        groupBy: 'student',
        order: 'lowest',
        limit: 40,
      })],
    },
    evidence: {
      ...evidence,
      students: [
        { ...evidence.students[0], balance: -5 },
        { ...evidence.students[1], balance: 0 },
        { ...evidence.students[2], balance: -2 },
      ],
    },
  })
  assert.match(negativeResult.answer, /Genesis \(-\$5\.00\).*Mateo \(-\$2\.00\)/)
  assert.doesNotMatch(negativeResult.answer, /Sofia/)

  const historyResult = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      operation: 'analyze',
      queries: [plan({
        dataset: 'balance-history',
        metric: 'closing-balance',
        filters: {
          ...filters,
          subjectAliases: ['student-001'],
          status: 'any',
          lookbackDays: 3,
          balanceCondition: 'any',
        },
        groupBy: 'calendar-day',
        order: 'chronological',
        limit: 3,
      })],
    },
    evidence: {
      ...evidence,
      generatedAt: '2026-08-20T18:00:00.000Z',
      students: [{ ...evidence.students[0], balance: 20 }, ...evidence.students.slice(1)],
      transactions: [
        { id: 201, studentId: 1, date: '2026-08-19T16:00:00.000Z', type: 'Subtract', amount: 2, categoryAlias: 'category-003', purpose: 'other', status: 'Approved' },
        { id: 202, studentId: 1, date: '2026-08-20T16:00:00.000Z', type: 'Add', amount: 5, categoryAlias: 'category-002', purpose: 'other', status: 'Approved' },
      ],
    },
  })
  assert.match(historyResult.answer, /Aug 18, 2026 \(\$17\.00\).*Aug 19, 2026 \(\$15\.00\).*Aug 20, 2026 \(\$20\.00\)/)
})

test('combines unrelated calculations for compound questions without broadening either filter', () => {
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: {
      operation: 'analyze',
      queries: [
        plan({
          metric: 'amount-total',
          filters: { ...filters, transactionType: 'Add', lookbackDays: 10, balanceCondition: 'any' },
        }),
        plan({
          metric: 'amount-total',
          filters: { ...filters, transactionType: 'Subtract', lookbackDays: 10, balanceCondition: 'any' },
        }),
      ],
    },
    evidence: { ...evidence, generatedAt: '2026-08-20T18:00:00.000Z' },
  })
  assert.match(result.answer, /Calculation 1:.*\$35\.00.*Calculation 2:.*\$203\.00/)
  assert.match(result.evidence.join(' '), /approved earning.*last 10 days/i)
  assert.match(result.evidence.join(' '), /approved spending.*last 10 days/i)
})

test('uses a custom rolling window consistently in calendar summaries', () => {
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: { ...filters, lookbackDays: 10, balanceCondition: 'any' },
      groupBy: 'calendar-day',
      order: 'chronological',
      limit: 10,
    }),
    evidence: { ...evidence, generatedAt: '2026-08-20T18:00:00.000Z' },
  })
  assert.match(result.answer, /last 10 days/)
  assert.doesNotMatch(result.answer, /last 30 days/)
  assert.match(result.evidence.join(' '), /last 10 days/)
})

test('discloses ties omitted at a non-leading cutoff', () => {
  const students = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    alias: `student-${String(index + 1).padStart(3, '0')}`,
    name: `Student ${index + 1}`,
    balance: 0,
    frozen: false,
  }))
  const transactions = [
    { id: 1, studentId: 1, date: '2026-08-19T15:00:00.000Z', type: 'Subtract', amount: 1, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
    { id: 2, studentId: 1, date: '2026-08-19T16:00:00.000Z', type: 'Subtract', amount: 1, categoryAlias: 'category-001', purpose: 'other', status: 'Approved' },
    ...students.slice(1).map((student, index) => ({
      id: index + 3,
      studentId: student.id,
      date: '2026-08-19T17:00:00.000Z',
      type: 'Subtract',
      amount: 1,
      categoryAlias: 'category-001',
      purpose: 'other',
      status: 'Approved',
    })),
  ]
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: { ...filters, categoryAlias: 'category-001', transactionType: 'Subtract' },
      groupBy: 'student',
      limit: 2,
    }),
    evidence: {
      ...evidence,
      participants: students.map(({ id, alias, name }) => ({ id, alias, name })),
      students,
      transactions,
    },
  })
  assert.match(result.answer, /And 2 more are tied at the cutoff/)
  assert.equal(result.evidence.length, 8)
})
