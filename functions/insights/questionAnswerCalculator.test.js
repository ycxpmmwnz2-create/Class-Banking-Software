import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateQuestionAnswer, InsightQuestionAnswerError } from './questionAnswerCalculator.js'

const evidence = {
  periodDays: 30,
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
  assert.match(result.answer, /approved spending \(Subtract\) transactions/)
  assert.match(result.evidence[0], /approved spending \(Subtract\) transactions/)
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
  for (const text of [result.answer, ...result.evidence]) {
    assert.match(text, /approved spending \(Subtract\) transactions/)
    assert.match(text, /rent payments/)
    assert.match(text, /exactly \$10\.00/)
    assert.match(text, /today \(2026-08-20 in America\/Denver\)/)
    assert.match(text, /all current students/)
  }

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
  assert.match(result.evidence[0], /Included records:/)
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
  assert.match(frozenCount.answer, /current frozen students/)
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
  assert.match(timeResult.answer, /Chronological transaction count results/)
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

test('discloses status, type, time, and current-student filters in the summary and evidence', () => {
  const result = calculateQuestionAnswer({
    kind: 'query',
    plan: plan({
      metric: 'count',
      filters: {
        ...filters,
        transactionType: 'Subtract',
        status: 'Pending',
        timeBucket: 'afternoon',
        studentState: 'frozen',
      },
    }),
    evidence,
  })
  for (const text of [result.answer, ...result.evidence]) {
    assert.match(text, /pending spending \(Subtract\) transactions/)
    assert.match(text, /afternoon \(12:00 PM–4:59 PM\)/)
    assert.match(text, /current frozen students/)
  }
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
  assert.match(noStudents.answer, /No matching students/)
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
  assert.match(noTransactions.answer, /No matching records/)
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
    assert.match(result.answer, /…/)
    assert.match(result.answer, /earning \(Add\) and spending \(Subtract\)/)
    assert.match(result.answer, /all approval statuses/)
    assert.match(result.answer, /afternoon \(12:00 PM–4:59 PM\)/)
    assert.match(result.answer, /current frozen students/)
  }
  assert.match(emptyResult.answer, /No matching records were found/)
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
