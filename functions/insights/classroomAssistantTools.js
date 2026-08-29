const TOOL_NAMES = Object.freeze([
  'list_transactions',
  'aggregate_transactions',
  'find_students_without_transactions',
  'get_balances',
  'get_balance_history',
  'compare_periods',
  'describe_schema',
])

const TRANSACTION_TYPES = Object.freeze(['Add', 'Subtract', 'any'])
const TRANSACTION_STATUSES = Object.freeze(['Approved', 'Pending', 'Denied', 'any'])
const PURPOSES = Object.freeze(['rent', 'other', 'any'])
const GROUP_FIELDS = Object.freeze([
  'student',
  'category',
  'transactionType',
  'status',
  'calendarDay',
  'dayOfWeek',
  'timeOfDay',
  'amount',
  'purpose',
])
const METRICS = Object.freeze([
  'count',
  'amountTotal',
  'amountAverage',
  'amountMinimum',
  'amountMaximum',
  'amountMedian',
  'distinctStudents',
  'distinctDays',
  'distinctCategories',
])
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const CLASSROOM_ASSISTANT_TOOL_DECLARATIONS = Object.freeze([
  declaration('list_transactions', 'List matching read-only classroom transactions. Use includeMemos only when memo wording is necessary to answer the question.', transactionFilterSchema({
    includeMemos: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    sort: { type: 'string', enum: ['newest', 'oldest'] },
  })),
  declaration('aggregate_transactions', 'Group and calculate classroom transactions. This handles broad questions including duplicates, timing patterns, totals, averages, and comparisons.', transactionFilterSchema({
    groupBy: {
      type: 'array',
      minItems: 0,
      maxItems: 8,
      items: { type: 'string', enum: GROUP_FIELDS },
    },
    metric: { type: 'string', enum: METRICS },
    minimumResult: { type: 'number', minimum: 0, maximum: 1_000_000 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    sort: { type: 'string', enum: ['highest', 'lowest', 'alphabetical', 'chronological'] },
  }, ['groupBy', 'metric'])),
  declaration('find_students_without_transactions', 'Find current students who have no transactions matching the supplied filters. Use this for questions such as who has not paid rent, who has not earned a category, or who has no activity in a date range. A truncated result is partial and must be disclosed.', transactionFilterSchema({
    limit: { type: 'integer', minimum: 1, maximum: 25 },
    sort: { type: 'string', enum: ['name', 'lowestBalance', 'highestBalance'] },
  })),
  declaration('get_balances', 'Read current student balances and frozen status.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      studentRefs: studentRefsSchema(),
      condition: { type: 'string', enum: ['any', 'negative', 'zero', 'positive', 'nonpositive'] },
      sort: { type: 'string', enum: ['lowest', 'highest', 'name'] },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  }),
  declaration('get_balance_history', 'Calculate end-of-day balances for one or more students from the supplied current balance and approved transaction history.', {
    type: 'object',
    additionalProperties: false,
    required: ['studentRefs'],
    properties: {
      studentRefs: studentRefsSchema(1),
      startDate: dateSchema(),
      endDate: dateSchema(),
      limitDays: { type: 'integer', minimum: 1, maximum: 90 },
    },
  }),
  declaration('compare_periods', 'Compare the same transaction metric across two date ranges.', transactionFilterSchema({
    firstStartDate: dateSchema(),
    firstEndDate: dateSchema(),
    secondStartDate: dateSchema(),
    secondEndDate: dateSchema(),
    metric: { type: 'string', enum: METRICS },
  }, ['firstStartDate', 'firstEndDate', 'secondStartDate', 'secondEndDate', 'metric'], [
    'startDate',
    'endDate',
  ])),
  declaration('describe_schema', 'Describe the exact read-only classroom fields and date limits available to the assistant.', {
    type: 'object',
    additionalProperties: false,
    properties: {},
  }),
])
const TOOL_DECLARATION_BY_NAME = new Map(
  CLASSROOM_ASSISTANT_TOOL_DECLARATIONS.map(item => [item.name, item]),
)

export class ClassroomAssistantToolError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'ClassroomAssistantToolError'
    this.category = category
  }
}

export function createClassroomAssistantToolbox(evidence, { memoResolver } = {}) {
  if (memoResolver !== undefined && typeof memoResolver !== 'function') {
    fail('invalid-evidence', 'The classroom memo resolver is malformed.')
  }
  const data = validateEvidence(evidence)
  const studentsByRef = new Map(data.students.map(student => [student.ref, student]))
  const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: data.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: data.timeZone,
    weekday: 'long',
  })
  const hourFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: data.timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
  const transactions = data.transactions.map(transaction => Object.freeze({
    ...transaction,
    calendarDay: localDateKey(transaction.date, dateKeyFormatter),
    dayOfWeek: weekdayFormatter.format(new Date(transaction.date)),
    timeOfDay: timeOfDay(transaction.date, hourFormatter),
  }))

  const context = Object.freeze({
    assistantVersion: 1,
    classroomDate: data.asOfDate,
    timeZone: data.timeZone,
    availableDateRange: Object.freeze({
      start: localDateKey(data.historyStart, dateKeyFormatter),
      end: data.asOfDate,
    }),
    retainedFrom: data.historyStart,
    selectedDateRange: Object.freeze({
      start: localDateKey(data.periodStart, dateKeyFormatter),
      end: data.asOfDate,
    }),
    selectedPeriodDays: data.periodDays,
    configuredRentAmount: data.configuredRentAmount,
    students: Object.freeze(data.students.map(student => Object.freeze({
      ref: student.ref,
      name: student.displayName,
      current: student.current,
      currentBalance: student.balance,
      frozen: student.frozen,
    }))),
    categories: data.categories,
    recordCounts: Object.freeze({
      students: data.students.filter(student => student.current).length,
      transactions: transactions.length,
    }),
  })

  return Object.freeze({
    context,
    declarations: CLASSROOM_ASSISTANT_TOOL_DECLARATIONS,
    execute(name, args = {}) {
      try {
        if (!TOOL_NAMES.includes(name)) fail('unknown-tool', 'The requested classroom tool is unavailable.')
        if (!isPlainObject(args)) return toolError('Tool arguments must be an object.')
        const schema = TOOL_DECLARATION_BY_NAME.get(name).parametersJsonSchema
        const allowedFields = new Set(Object.keys(schema.properties ?? {}))
        if (Object.keys(args).some(field => !allowedFields.has(field))) {
          return toolError('Tool arguments contain an unsupported field.')
        }
        if ((schema.required ?? []).some(field => !Object.hasOwn(args, field))) {
          return toolError('Tool arguments are missing a required field.')
        }
        if (name === 'describe_schema') return describeSchema(context)
        if (name === 'get_balances') return getBalances(args, data.students)
        if (name === 'get_balance_history') {
          return getBalanceHistory(args, data, transactions, studentsByRef)
        }
        if (name === 'compare_periods') {
          return comparePeriods(args, data, transactions, studentsByRef)
        }
        const filtered = filterTransactions(args, data, transactions, studentsByRef)
        if (name === 'find_students_without_transactions') {
          return findStudentsWithoutTransactions(args, data.students, filtered)
        }
        return name === 'list_transactions'
          ? listTransactions(args, filtered, studentsByRef, memoResolver)
          : aggregateTransactions(args, filtered, studentsByRef)
      } catch (error) {
        if (error instanceof ClassroomAssistantToolError) return toolError(error.message)
        throw error
      }
    },
  })
}

function findStudentsWithoutTransactions(args, students, filteredTransactions) {
  const requestedRefs = studentRefs(args.studentRefs, students)
  const matchingStudentRefs = new Set(filteredTransactions.transactions.map(transaction => transaction.studentRef))
  const currentStudents = students.filter(student => student.current)
  const selectedStudents = requestedRefs.length === 0
    ? currentStudents
    : currentStudents.filter(student => requestedRefs.includes(student.ref))
  const withoutTransactions = selectedStudents.filter(student => !matchingStudentRefs.has(student.ref))
  const sort = enumeration(args.sort ?? 'name', ['name', 'lowestBalance', 'highestBalance'])
  withoutTransactions.sort((left, right) => {
    if (sort === 'lowestBalance') {
      return nullableBalance(left.balance, Number.POSITIVE_INFINITY) - nullableBalance(right.balance, Number.POSITIVE_INFINITY) ||
        left.displayName.localeCompare(right.displayName, 'en-US')
    }
    if (sort === 'highestBalance') {
      return nullableBalance(right.balance, Number.NEGATIVE_INFINITY) - nullableBalance(left.balance, Number.NEGATIVE_INFINITY) ||
        left.displayName.localeCompare(right.displayName, 'en-US')
    }
    return left.displayName.localeCompare(right.displayName, 'en-US')
  })
  const limit = integer(args.limit, 1, 25, 25)
  return Object.freeze({
    ok: true,
    windowStartDate: filteredTransactions.windowStartDate,
    windowEndDate: filteredTransactions.windowEndDate,
    windowDays: filteredTransactions.windowDays,
    currentStudentCount: currentStudents.length,
    consideredStudentCount: selectedStudents.length,
    matchedTransactionCount: filteredTransactions.transactions.length,
    studentsWithoutCount: withoutTransactions.length,
    returnedCount: Math.min(limit, withoutTransactions.length),
    truncated: withoutTransactions.length > limit,
    students: Object.freeze(withoutTransactions.slice(0, limit).map(student => Object.freeze({
      studentRef: student.ref,
      student: student.displayName,
      currentBalance: student.balance,
      frozen: student.frozen,
    }))),
  })
}

function listTransactions(args, filtered, studentsByRef, memoResolver) {
  const limit = integer(args.limit, 1, 100, 50)
  const includeMemos = boolean(args.includeMemos, false)
  const sort = enumeration(args.sort ?? 'newest', ['newest', 'oldest'])
  const ordered = [...filtered.transactions].sort((left, right) => (
    (sort === 'oldest' ? 1 : -1) * left.date.localeCompare(right.date)
  ))
  return Object.freeze({
    ok: true,
    windowStartDate: filtered.windowStartDate,
    windowEndDate: filtered.windowEndDate,
    windowDays: filtered.windowDays,
    matchedCount: ordered.length,
    returnedCount: Math.min(limit, ordered.length),
    truncated: ordered.length > limit,
    transactions: Object.freeze(ordered.slice(0, limit).map(transaction => {
      const row = {
        transactionRef: transaction.ref,
        studentRef: transaction.studentRef,
        student: studentsByRef.get(transaction.studentRef)?.displayName ?? 'Archived student',
        timestamp: transaction.date,
        classroomDate: transaction.calendarDay,
        type: transaction.type,
        amount: transaction.amount,
        category: transaction.category,
        status: transaction.status,
        purpose: transaction.purpose,
      }
      if (includeMemos) {
        const memo = resolveMemo(transaction.ref, memoResolver)
        row.memo = memo.text
        row.memoTruncated = memo.truncated
      }
      return Object.freeze(row)
    })),
  })
}

function resolveMemo(transactionRef, memoResolver) {
  if (typeof memoResolver !== 'function') {
    fail('memo-unavailable', 'Memo text is unavailable.')
  }
  const memo = memoResolver(transactionRef)
  if (
    !isPlainObject(memo) ||
    Object.keys(memo).length !== 2 ||
    !Object.hasOwn(memo, 'text') ||
    !Object.hasOwn(memo, 'truncated') ||
    typeof memo.text !== 'string' ||
    [...memo.text].length > 501 ||
    typeof memo.truncated !== 'boolean'
  ) {
    fail('memo-unavailable', 'Memo text is unavailable.')
  }
  return memo
}

function aggregateTransactions(args, filtered, studentsByRef) {
  const groupBy = stringArray(args.groupBy, GROUP_FIELDS, 0, 8, [])
  const metric = enumeration(args.metric, METRICS)
  const minimumResult = optionalNumber(args.minimumResult, 0, 1_000_000)
  const limit = integer(args.limit, 1, 50, 20)
  const groups = new Map()
  for (const transaction of filtered.transactions) {
    const values = groupBy.map(field => groupValue(field, transaction, studentsByRef))
    const key = JSON.stringify(values)
    const group = groups.get(key) ?? { values, transactions: [] }
    group.transactions.push(transaction)
    groups.set(key, group)
  }
  if (groupBy.length === 0 && groups.size === 0) groups.set('[]', { values: [], transactions: [] })
  const denominator = metric === 'count'
    ? filtered.transactions.length
    : metric === 'amountTotal'
      ? metricValue('amountTotal', filtered.transactions)
      : null
  let rows = [...groups.values()].map(group => {
    const value = metricValue(metric, group.transactions)
    return Object.freeze({
      group: Object.freeze(Object.fromEntries(groupBy.map((field, index) => [field, group.values[index]]))),
      value,
      transactionCount: group.transactions.length,
      sharePercent: denominator && denominator > 0 ? roundPercent(value / denominator * 100) : null,
    })
  })
  if (minimumResult !== null) rows = rows.filter(row => row.value >= minimumResult)
  rows.sort(rowSorter(args.sort))
  return Object.freeze({
    ok: true,
    windowStartDate: filtered.windowStartDate,
    windowEndDate: filtered.windowEndDate,
    windowDays: filtered.windowDays,
    metric,
    groupBy: Object.freeze(groupBy),
    matchedTransactionCount: filtered.transactions.length,
    resultCount: rows.length,
    returnedCount: Math.min(limit, rows.length),
    truncated: rows.length > limit,
    rows: Object.freeze(rows.slice(0, limit)),
  })
}

function getBalances(args, students) {
  const refs = studentRefs(args.studentRefs, students)
  const currentStudents = students.filter(student => student.current)
  const selected = refs.length === 0
    ? currentStudents
    : currentStudents.filter(student => refs.includes(student.ref))
  const condition = enumeration(args.condition ?? 'any', ['any', 'negative', 'zero', 'positive', 'nonpositive'])
  const limit = integer(args.limit, 1, 500, 100)
  const filtered = selected.filter(student => balanceMatches(student.balance, condition))
  const sort = enumeration(args.sort ?? 'name', ['lowest', 'highest', 'name'])
  filtered.sort((left, right) => {
    if (sort === 'lowest') return left.balance - right.balance || left.displayName.localeCompare(right.displayName)
    if (sort === 'highest') return right.balance - left.balance || left.displayName.localeCompare(right.displayName)
    return left.displayName.localeCompare(right.displayName, 'en-US')
  })
  return Object.freeze({
    ok: true,
    matchedCount: filtered.length,
    currentStudentCount: currentStudents.length,
    matchedPercent: currentStudents.length > 0 ? roundPercent(filtered.length / currentStudents.length * 100) : 0,
    totalBalance: roundMoney(filtered.reduce((sum, student) => sum + (student.balance ?? 0), 0)),
    averageBalance: filtered.length > 0
      ? roundMoney(filtered.reduce((sum, student) => sum + (student.balance ?? 0), 0) / filtered.length)
      : null,
    lowestBalance: filtered.length > 0 ? Math.min(...filtered.map(student => student.balance ?? 0)) : null,
    highestBalance: filtered.length > 0 ? Math.max(...filtered.map(student => student.balance ?? 0)) : null,
    returnedCount: Math.min(limit, filtered.length),
    truncated: filtered.length > limit,
    students: Object.freeze(filtered.slice(0, limit).map(student => Object.freeze({
      studentRef: student.ref,
      student: student.displayName,
      currentBalance: student.balance,
      frozen: student.frozen,
    }))),
  })
}

function getBalanceHistory(args, data, transactions, studentsByRef) {
  const refs = studentRefs(args.studentRefs, data.students, 1)
  const endDate = validatedDate(args.endDate ?? data.asOfDate, 'endDate')
  const limitDays = integer(args.limitDays, 1, 90, data.periodDays)
  const defaultStart = shiftDate(endDate, -(limitDays - 1))
  const startDate = validatedDate(args.startDate ?? defaultStart, 'startDate')
  assertDateRange(startDate, endDate)
  assertAvailableDateRange(startDate, endDate, data)
  const dates = dateKeys(startDate, endDate).slice(-limitDays)
  const rows = []
  for (const ref of refs) {
    const student = studentsByRef.get(ref)
    if (!student || student.balance === null) continue
    let closing = student.balance
    const byDate = new Map([[data.asOfDate, closing]])
    const approved = transactions
      .filter(transaction => transaction.studentRef === ref && transaction.status === 'Approved')
      .sort((left, right) => right.date.localeCompare(left.date))
    let cursorDate = data.asOfDate
    for (const transaction of approved) {
      while (cursorDate > transaction.calendarDay) {
        cursorDate = shiftDate(cursorDate, -1)
        byDate.set(cursorDate, closing)
      }
      closing -= transaction.type === 'Add' ? transaction.amount : -transaction.amount
      byDate.set(shiftDate(transaction.calendarDay, -1), closing)
    }
    for (const date of dates) {
      const knownDates = [...byDate.keys()].filter(key => key <= date).sort()
      rows.push(Object.freeze({
        studentRef: ref,
        student: student.displayName,
        date,
        closingBalance: byDate.get(knownDates.at(-1)) ?? closing,
      }))
    }
  }
  return Object.freeze({ ok: true, startDate, endDate, rows: Object.freeze(rows) })
}

function comparePeriods(args, data, transactions, studentsByRef) {
  const metric = enumeration(args.metric, METRICS)
  const periods = [
    [validatedDate(args.firstStartDate, 'firstStartDate'), validatedDate(args.firstEndDate, 'firstEndDate')],
    [validatedDate(args.secondStartDate, 'secondStartDate'), validatedDate(args.secondEndDate, 'secondEndDate')],
  ]
  periods.forEach(([start, end]) => assertDateRange(start, end))
  const values = periods.map(([startDate, endDate]) => {
    const filtered = filterTransactions({ ...args, startDate, endDate }, data, transactions, studentsByRef)
    return Object.freeze({
      startDate: filtered.windowStartDate,
      endDate: filtered.windowEndDate,
      windowDays: filtered.windowDays,
      value: metricValue(metric, filtered.transactions),
      transactionCount: filtered.transactions.length,
    })
  })
  return Object.freeze({
    ok: true,
    metric,
    periods: Object.freeze(values),
    difference: values[1].value - values[0].value,
    percentChange: values[0].value === 0
      ? null
      : roundPercent((values[1].value - values[0].value) / Math.abs(values[0].value) * 100),
  })
}

function filterTransactions(args, data, transactions, studentsByRef) {
  assertOnlyKnownStudentRefs(args.studentRefs, studentsByRef)
  const refs = Array.isArray(args.studentRefs) ? args.studentRefs : []
  const startDate = validatedDate(
    args.startDate ?? localDateKey(data.periodStart, data.timeZone),
    'startDate',
  )
  const endDate = validatedDate(args.endDate ?? data.asOfDate, 'endDate')
  assertDateRange(startDate, endDate, args.startDate === undefined ? 91 : 90)
  assertAvailableDateRange(startDate, endDate, data)
  const transactionType = enumeration(args.transactionType ?? 'any', TRANSACTION_TYPES)
  const status = enumeration(args.status ?? 'any', TRANSACTION_STATUSES)
  const purpose = enumeration(args.purpose ?? 'any', PURPOSES)
  const categoryContains = optionalString(args.categoryContains, 120)?.toLocaleLowerCase('en-US') ?? null
  const minimumAmount = optionalNumber(args.minimumAmount, 0, 1_000_000)
  const maximumAmount = optionalNumber(args.maximumAmount, 0, 1_000_000)
  if (minimumAmount !== null && maximumAmount !== null && minimumAmount > maximumAmount) {
    fail('invalid-tool-arguments', 'minimumAmount cannot be greater than maximumAmount.')
  }
  const filtered = transactions.filter(transaction => (
    transaction.calendarDay >= startDate &&
    transaction.calendarDay <= endDate &&
    (args.startDate !== undefined || Date.parse(transaction.date) >= Date.parse(data.periodStart)) &&
    (refs.length === 0 || refs.includes(transaction.studentRef)) &&
    (transactionType === 'any' || transaction.type === transactionType) &&
    (status === 'any' || transaction.status === status) &&
    (purpose === 'any' || transaction.purpose === purpose) &&
    (categoryContains === null || transaction.category.toLocaleLowerCase('en-US').includes(categoryContains)) &&
    (minimumAmount === null || transaction.amount >= minimumAmount) &&
    (maximumAmount === null || transaction.amount <= maximumAmount)
  ))
  return Object.freeze({
    transactions: Object.freeze(filtered),
    windowStartDate: startDate,
    windowEndDate: endDate,
    windowDays: daysBetweenInclusive(startDate, endDate),
  })
}

function describeSchema(context) {
  return Object.freeze({
    ok: true,
    scope: 'One authenticated classroom. Read only.',
    classroomDate: context.classroomDate,
    timeZone: context.timeZone,
    availableDateRange: context.availableDateRange,
    retainedFrom: context.retainedFrom,
    selectedDateRange: context.selectedDateRange,
    selectedPeriodDays: context.selectedPeriodDays,
    studentFields: Object.freeze(['studentRef', 'first name or first name plus last initial', 'currentBalance', 'frozen']),
    transactionFields: Object.freeze(['transactionRef', 'studentRef', 'timestamp', 'type', 'amount', 'category', 'status', 'purpose']),
    memoPolicy: 'Memos are returned only when includeMemos is true. Contact details are removed and each memo is capped at 500 characters with a truncation marker.',
    unavailable: Object.freeze(['credentials', 'PINs', 'emails', 'phone numbers', 'links', 'Firebase IDs', 'teacher IDs', 'classroom IDs', 'other classrooms', 'write operations']),
  })
}

function transactionFilterSchema(extraProperties = {}, required = [], omitted = []) {
  const properties = {
    studentRefs: studentRefsSchema(),
    categoryContains: { type: 'string', maxLength: 120 },
    transactionType: { type: 'string', enum: TRANSACTION_TYPES },
    status: { type: 'string', enum: TRANSACTION_STATUSES },
    purpose: { type: 'string', enum: PURPOSES },
    startDate: dateSchema(),
    endDate: dateSchema(),
    minimumAmount: { type: 'number', minimum: 0, maximum: 1_000_000 },
    maximumAmount: { type: 'number', minimum: 0, maximum: 1_000_000 },
    ...extraProperties,
  }
  for (const field of omitted) delete properties[field]
  return { type: 'object', additionalProperties: false, required, properties }
}

function declaration(name, description, parametersJsonSchema) {
  return Object.freeze({ name, description, parametersJsonSchema: Object.freeze(parametersJsonSchema) })
}

function studentRefsSchema(minItems = 0) {
  return { type: 'array', minItems, maxItems: 8, items: { type: 'string', pattern: '^student-[0-9]{3}$' } }
}

function dateSchema() {
  return { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
}

function groupValue(field, transaction, studentsByRef) {
  if (field === 'student') return studentsByRef.get(transaction.studentRef)?.displayName ?? 'Archived student'
  if (field === 'category') return transaction.category
  if (field === 'transactionType') return transaction.type
  if (field === 'status') return transaction.status
  if (field === 'calendarDay') return transaction.calendarDay
  if (field === 'dayOfWeek') return transaction.dayOfWeek
  if (field === 'timeOfDay') return transaction.timeOfDay
  if (field === 'amount') return transaction.amount
  if (field === 'purpose') return transaction.purpose
  fail('invalid-tool-arguments', 'An unsupported group field was requested.')
}

function metricValue(metric, transactions) {
  if (metric === 'count') return transactions.length
  if (metric === 'amountTotal') return roundMoney(transactions.reduce((sum, item) => sum + item.amount, 0))
  if (metric === 'amountAverage') {
    return transactions.length === 0 ? 0 : roundMoney(transactions.reduce((sum, item) => sum + item.amount, 0) / transactions.length)
  }
  if (metric === 'amountMinimum') return transactions.length === 0 ? 0 : Math.min(...transactions.map(item => item.amount))
  if (metric === 'amountMaximum') return transactions.length === 0 ? 0 : Math.max(...transactions.map(item => item.amount))
  if (metric === 'amountMedian') {
    if (transactions.length === 0) return 0
    const values = transactions.map(item => item.amount).sort((left, right) => left - right)
    const middle = Math.floor(values.length / 2)
    return roundMoney(values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2)
  }
  if (metric === 'distinctStudents') return new Set(transactions.map(item => item.studentRef)).size
  if (metric === 'distinctDays') return new Set(transactions.map(item => item.calendarDay)).size
  if (metric === 'distinctCategories') return new Set(transactions.map(item => item.category)).size
  fail('invalid-tool-arguments', 'An unsupported metric was requested.')
}

function rowSorter(sort = 'highest') {
  if (sort === 'chronological') return (left, right) => JSON.stringify(left.group).localeCompare(JSON.stringify(right.group))
  if (sort === 'alphabetical') return (left, right) => JSON.stringify(left.group).localeCompare(JSON.stringify(right.group), 'en-US')
  if (sort === 'lowest') return (left, right) => left.value - right.value || JSON.stringify(left.group).localeCompare(JSON.stringify(right.group))
  if (sort !== undefined && sort !== 'highest') fail('invalid-tool-arguments', 'The requested sort is unsupported.')
  return (left, right) => right.value - left.value || JSON.stringify(left.group).localeCompare(JSON.stringify(right.group))
}

function balanceMatches(balance, condition) {
  if (balance === null) return condition === 'any'
  if (condition === 'negative') return balance < 0
  if (condition === 'zero') return balance === 0
  if (condition === 'positive') return balance > 0
  if (condition === 'nonpositive') return balance <= 0
  return true
}

function nullableBalance(value, fallback) {
  return value === null ? fallback : value
}

function studentRefs(value, students, minimum = 0) {
  if (value === undefined && minimum === 0) return []
  const refs = stringArray(value, students.map(student => student.ref), minimum, 8)
  return [...new Set(refs)]
}

function assertOnlyKnownStudentRefs(value, studentsByRef) {
  if (value === undefined) return
  stringArray(value, [...studentsByRef.keys()], 0, 8)
}

function validateEvidence(value) {
  if (!isPlainObject(value) || !Array.isArray(value.students) || !Array.isArray(value.transactions) || !Array.isArray(value.categories)) {
    fail('invalid-evidence', 'Classroom assistant evidence is malformed.')
  }
  if (
    !DATE_PATTERN.test(value.asOfDate) ||
    !Number.isFinite(Date.parse(value.periodStart)) ||
    !Number.isFinite(Date.parse(value.historyStart)) ||
    Date.parse(value.historyStart) > Date.parse(value.periodStart) ||
    typeof value.timeZone !== 'string' ||
    ![7, 30, 90].includes(value.periodDays)
  ) {
    fail('invalid-evidence', 'Classroom assistant evidence is malformed.')
  }
  const refs = new Set()
  for (const student of value.students) {
    if (
      !isPlainObject(student) ||
      !/^student-\d{3}$/.test(student.ref) ||
      refs.has(student.ref) ||
      typeof student.displayName !== 'string' ||
      typeof student.current !== 'boolean'
    ) {
      fail('invalid-evidence', 'Classroom student evidence is malformed.')
    }
    if (student.balance !== null && (!Number.isFinite(student.balance) || Math.abs(student.balance) > 1_000_000)) {
      fail('invalid-evidence', 'Classroom balance evidence is malformed.')
    }
    if (student.frozen !== null && typeof student.frozen !== 'boolean') fail('invalid-evidence', 'Classroom student evidence is malformed.')
    refs.add(student.ref)
  }
  for (const transaction of value.transactions) {
    if (
      !isPlainObject(transaction) ||
      !/^transaction-\d{5}$/.test(transaction.ref) ||
      !refs.has(transaction.studentRef) ||
      !Number.isFinite(Date.parse(transaction.date)) ||
      !['Add', 'Subtract'].includes(transaction.type) ||
      !Number.isFinite(transaction.amount) ||
      !TRANSACTION_STATUSES.slice(0, 3).includes(transaction.status) ||
      typeof transaction.category !== 'string'
    ) fail('invalid-evidence', 'Classroom transaction evidence is malformed.')
  }
  return value
}

function validatedDate(value, field) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    fail('invalid-tool-arguments', `${field} must be a calendar date.`)
  }
  return value
}

function assertDateRange(start, end, maximumCalendarDays = 90) {
  if (start > end) fail('invalid-tool-arguments', 'The start date must not be after the end date.')
  const calendarDays = daysBetweenInclusive(start, end)
  if (calendarDays > maximumCalendarDays) fail('invalid-tool-arguments', 'A tool date range cannot exceed 90 days.')
}

function daysBetweenInclusive(start, end) {
  return Math.floor(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  ) + 1
}

function assertAvailableDateRange(start, end, data) {
  const firstAvailableDate = localDateKey(data.historyStart, data.timeZone)
  if (start < firstAvailableDate || end > data.asOfDate) {
    fail('invalid-tool-arguments', 'The requested dates are outside the retained classroom history.')
  }
}

function dateKeys(start, end) {
  const output = []
  let cursor = start
  while (cursor <= end && output.length <= 90) {
    output.push(cursor)
    cursor = shiftDate(cursor, 1)
  }
  return output
}

function shiftDate(value, days) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function localDateKey(value, formatterOrTimeZone) {
  const formatter = typeof formatterOrTimeZone === 'string'
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: formatterOrTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    : formatterOrTimeZone
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function timeOfDay(value, formatter) {
  const hour = Number(formatter
    .formatToParts(new Date(value)).find(part => part.type === 'hour')?.value)
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

function enumeration(value, allowed) {
  if (!allowed.includes(value)) fail('invalid-tool-arguments', 'A tool option is unsupported.')
  return value
}

function integer(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail('invalid-tool-arguments', 'A tool integer is outside its allowed range.')
  return value
}

function optionalNumber(value, minimum, maximum) {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail('invalid-tool-arguments', 'A tool number is outside its allowed range.')
  return value
}

function optionalString(value, maximum) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) fail('invalid-tool-arguments', 'A tool string is malformed.')
  return value
}

function boolean(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail('invalid-tool-arguments', 'A tool boolean is malformed.')
  return value
}

function stringArray(value, allowed, minimum, maximum, fallback) {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some(item => !allowed.includes(item))) {
    fail('invalid-tool-arguments', 'A tool list is malformed.')
  }
  return value
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function roundPercent(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10
}

function toolError(message) {
  return Object.freeze({ ok: false, error: message })
}

function fail(category, message) {
  throw new ClassroomAssistantToolError(category, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
