import { questionQueryPlanCoherenceError } from './questionContracts.js'

const TIME_BUCKETS = Object.freeze([
  Object.freeze({ id: 'morning', label: 'morning (5:00 AM–11:59 AM)', matches: hour => hour >= 5 && hour < 12 }),
  Object.freeze({ id: 'afternoon', label: 'afternoon (12:00 PM–4:59 PM)', matches: hour => hour >= 12 && hour < 17 }),
  Object.freeze({ id: 'evening', label: 'evening (5:00 PM–8:59 PM)', matches: hour => hour >= 17 && hour < 21 }),
  Object.freeze({ id: 'night', label: 'night (9:00 PM–4:59 AM)', matches: hour => hour >= 21 || hour < 5 }),
])
const DAY_LABELS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
const MAX_ANSWER_LENGTH = 800
const MAX_ANALYSIS_ANSWER_LENGTH = 3_200
const MAX_STUDENT_BALANCE_LIST_ANSWER_LENGTH = 80_000
const MAX_EVIDENCE_LENGTH = 320
const MAX_DISPLAY_LABEL_LENGTH = 48
const RESPONSE_LABEL_LENGTHS = Object.freeze([48, 40, 32, 24, 16])
const GUIDANCE_ALIAS_PATTERN = /(?:student|category)-[0-9]{3}/iu
const GUIDANCE_PLACEHOLDER_PATTERN = /\[(?:student|category)(?:-[0-9]{3})?\]/iu
const GUIDANCE_URL_PATTERN = /(?:https?:\/\/|www\.)/iu

export class InsightQuestionAnswerError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightQuestionAnswerError'
    this.category = category
  }
}

export function calculateQuestionAnswer({ kind, plan, guidance = null, evidence } = {}) {
  const context = validateEvidence(evidence)
  if (kind === 'guidance') {
    if (plan !== null) fail('answer-unavailable', 'Morgan Bank guidance cannot contain a query plan.')
    return answer(
      validateGuidanceForCalculation(guidance),
      ['General Morgan Bank guidance; no classroom records were used to make a factual claim.'],
    )
  }
  if (kind === 'unsupported') {
    if (plan !== null || guidance !== null) {
      fail('answer-unavailable', 'An unsupported question cannot contain a plan or guidance.')
    }
    return answer(
      'I can help with Morgan Bank, classroom-economy routines, and the available classroom records, but not that request.',
      ['No answer was generated outside the Morgan Bank classroom-assistant scope.'],
    )
  }
  if (kind === 'query-and-guidance') {
    const guidanceText = validateGuidanceForCalculation(guidance, 240)
    validatePlanForCalculation(plan)
    return calculateQueryAnswer(
      plan,
      context,
      ` General Morgan Bank guidance: ${guidanceText}`,
    )
  }
  if (kind !== 'query') fail('answer-unavailable', 'The interpreted question is unsupported.')
  if (guidance !== null) fail('answer-unavailable', 'A classroom query cannot contain guidance text.')
  validatePlanForCalculation(plan)
  return calculateQueryAnswer(plan, context)
}

function calculateQueryAnswer(plan, context, answerSuffix = '') {
  if (plan.operation === 'analyze') {
    const results = plan.queries.map(query => calculateQueryAnswer(query, context))
    const text = results.map((result, index) => (
      results.length === 1 ? result.answer : `Calculation ${index + 1}: ${result.answer}`
    )).join(' ')
    const evidence = results.flatMap((result, index) => result.evidence.map(item => (
      results.length === 1 ? item : `Calculation ${index + 1}: ${item}`
    ))).slice(0, 8)
    const combined = `${text}${answerSuffix}`
    return answer(combined, evidence.length ? evidence : ['The requested calculations completed.'], MAX_ANALYSIS_ANSWER_LENGTH)
  }
  if (plan.operation === 'list-student-balances') {
    return calculateStudentBalanceList(context, answerSuffix)
  }
  if (plan.operation === 'students-without-transactions') {
    return calculateStudentsWithoutTransactions(plan, context, answerSuffix)
  }
  if (plan.dataset === 'students') return calculateStudentQuery(plan, context, answerSuffix)
  if (plan.dataset === 'balance-history') return calculateBalanceHistoryQuery(plan, context, answerSuffix)
  return calculateTransactionQuery(plan, context, answerSuffix)
}

function calculateStudentBalanceList(context, answerSuffix) {
  const separatedSuffix = answerSuffix ? `\n${answerSuffix.trim()}` : ''
  const students = [...context.students].sort((left, right) => (
    left.name.localeCompare(right.name, 'en-US') || left.id - right.id
  ))
  if (!students.length) {
    return answer(
      `There are no current students in this classroom.${separatedSuffix}`,
      ['Current roster students checked: 0.'],
    )
  }
  const balances = students.map(student => (
    `${displayLabel(student.name, 120)}: ${money(student.balance)}`
  )).join('\n')
  return answer(
    `Current balances for all ${students.length} ${students.length === 1 ? 'student' : 'students'}:\n${balances}${separatedSuffix}`,
    [`Current roster students checked: ${students.length}; every current balance is included.`],
    MAX_STUDENT_BALANCE_LIST_ANSWER_LENGTH,
  )
}

function validateGuidanceForCalculation(value, maximum = 480) {
  const hasControl = typeof value === 'string' && [...value].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint === 127 || codePoint < 32
  })
  if (
    typeof value !== 'string' || value.length < 20 || value.length > maximum ||
    value.trim() !== value || hasControl ||
    GUIDANCE_ALIAS_PATTERN.test(value) ||
    GUIDANCE_PLACEHOLDER_PATTERN.test(value) ||
    GUIDANCE_URL_PATTERN.test(value)
  ) fail('answer-unavailable', 'The Morgan Bank guidance is malformed.')
  return value
}

function calculateStudentsWithoutTransactions(plan, context, answerSuffix) {
  let students = context.students
  if (plan.subjectAliases.length) {
    students = plan.subjectAliases.map(alias => {
      const selected = context.studentsByAlias.get(alias)
      if (!selected) fail('answer-unavailable', 'A selected current student is unavailable.')
      return selected
    })
  }
  if (plan.studentState !== 'any') {
    const frozen = plan.studentState === 'frozen'
    students = students.filter(student => student.frozen === frozen)
  }

  let transactions = context.transactions
  if (plan.categoryAlias !== null) {
    if (!context.categoriesByAlias.has(plan.categoryAlias)) {
      fail('answer-unavailable', 'The selected category is unavailable.')
    }
    transactions = transactions.filter(transaction => transaction.categoryAlias === plan.categoryAlias)
  }
  if (plan.purpose !== 'any') {
    transactions = transactions.filter(transaction => transaction.purpose === plan.purpose)
  }
  if (plan.transactionType !== 'any') {
    transactions = transactions.filter(transaction => transaction.type === plan.transactionType)
  }
  if (plan.status !== 'any') {
    transactions = transactions.filter(transaction => transaction.status === plan.status)
  }
  transactions = transactions.filter(transaction => (
    matchesDateScope(transaction, plan.dateScope, context, plan.lookbackDays ?? null)
  ))
  const amount = plan.amountExact ?? (
    plan.purpose === 'rent' && context.configuredRentAmount > 0
      ? context.configuredRentAmount
      : null
  )
  if (amount !== null) {
    transactions = transactions.filter(transaction => transaction.amount === amount)
  }

  const matchingStudentIds = new Set(transactions.map(transaction => transaction.studentId))
  const missing = students
    .filter(student => !matchingStudentIds.has(student.id))
    .sort((left, right) => left.name.localeCompare(right.name, 'en-US') || left.id - right.id)
  return renderStudentsWithoutTransactions({ plan, context, students, missing, answerSuffix })
}

function renderStudentsWithoutTransactions({ plan, context, students, missing, answerSuffix }) {
  return fitResponseWithinPublicBounds(labelLength => {
    const filterContext = describeMissingTransactionFilters(plan, context, Math.min(24, labelLength))
    const matchLabel = plan.purpose === 'rent' ? 'rent payment' : 'transaction'
    if (!students.length) {
      return {
        text: 'There are no current students to check.',
        evidence: [`Students checked: 0. Checked: ${filterContext}.`],
      }
    }
    if (!missing.length) {
      return {
        text: `No. All ${students.length} current ${students.length === 1 ? 'student has' : 'students have'} a matching ${matchLabel}.`,
        evidence: [`Students checked: ${students.length}; students without a match: 0. Checked: ${filterContext}.`],
      }
    }
    const selected = missing.slice(0, plan.limit)
    const omitted = missing.length - selected.length
    const labels = joinLabels(selected.map(student => displayLabel(student.name, labelLength)))
    const omittedText = omitted ? ` and ${omitted} ${omitted === 1 ? 'other' : 'others'}` : ''
    return {
      text: `Yes. ${missing.length} of ${students.length} current students do not have a matching ${matchLabel}: ${labels}${omittedText}.`,
      evidence: evidenceWithFilter(
        selected.map(student => `${displayLabel(student.name, labelLength)}: no matching ${matchLabel}.`),
        filterContext,
        'Checked',
      ),
    }
  }, answerSuffix)
}

function calculateStudentQuery(plan, context, answerSuffix) {
  let students = context.students
  if (plan.filters.subjectAliases.length) {
    students = plan.filters.subjectAliases.map(alias => {
      const selected = context.studentsByAlias.get(alias)
      if (!selected) fail('answer-unavailable', 'A selected student is unavailable.')
      return selected
    })
  }
  if (plan.filters.studentState !== 'any') {
    const frozen = plan.filters.studentState === 'frozen'
    students = students.filter(student => student.frozen === frozen)
  }
  const balanceCondition = plan.filters.balanceCondition ?? 'any'
  if (balanceCondition !== 'any') {
    students = students.filter(student => matchesBalanceCondition(
      student.balance,
      balanceCondition,
    ))
  }
  if (plan.metric === 'count') {
    return renderRows({
      rows: [{ key: 'students', label: 'Matching students', value: students.length, count: students.length, chronological: 'students' }],
      plan,
      context,
      noun: plan.filters.studentState === 'any' ? 'student count' : `${plan.filters.studentState} student count`,
      answerSuffix,
    })
  }
  if (plan.metric === 'average-balance') {
    if (!students.length) return renderRows({ rows: [], plan, context, noun: 'average current balance', answerSuffix })
    const average = students.reduce((total, student) => total + student.balance, 0) / students.length
    if (!Number.isFinite(average)) fail('answer-unavailable', 'The average balance exceeds safe precision.')
    return renderRows({
      rows: [{ key: 'students', label: 'Matching students', value: average, count: students.length, chronological: 'students' }],
      plan,
      context,
      noun: 'average current balance',
      answerSuffix,
    })
  }
  const rows = students.map(student => ({
    key: student.alias,
    label: student.name,
    value: student.balance,
    count: 1,
    chronological: student.alias,
  }))
  return renderRows({ rows, plan, context, noun: 'current balance', answerSuffix })
}

function calculateTransactionQuery(plan, context, answerSuffix) {
  let transactions = context.transactions
  const filters = plan.filters
  let subjectNames = []
  if (filters.subjectAliases.length) {
    const selectedStudents = filters.subjectAliases.map(alias => {
      const student = context.participantsByAlias.get(alias)
      if (!student) fail('answer-unavailable', 'A selected student is unavailable.')
      return student
    })
    const selectedIds = new Set(selectedStudents.map(student => student.id))
    transactions = transactions.filter(transaction => selectedIds.has(transaction.studentId))
    subjectNames = selectedStudents.map(student => student.name)
  }
  if (filters.categoryAlias !== null) {
    if (!context.categoriesByAlias.has(filters.categoryAlias)) {
      fail('answer-unavailable', 'The selected category is unavailable.')
    }
    transactions = transactions.filter(transaction => transaction.categoryAlias === filters.categoryAlias)
  }
  if (filters.transactionType !== 'any') {
    transactions = transactions.filter(transaction => transaction.type === filters.transactionType)
  }
  if (filters.status !== 'any') {
    transactions = transactions.filter(transaction => transaction.status === filters.status)
  }
  transactions = transactions.filter(transaction => (
    matchesDateScope(transaction, filters.dateScope, context, filters.lookbackDays ?? null)
  ))
  if (filters.studentState !== 'any') {
    const frozen = filters.studentState === 'frozen'
    transactions = transactions.filter(transaction => (
      context.studentsById.get(transaction.studentId)?.frozen === frozen
    ))
  }
  if (filters.timeBucket !== null) {
    transactions = transactions.filter(transaction => (
      timeBucketFor(transaction.date, context.timeZone).id === filters.timeBucket
    ))
  }
  if (plan.metric === 'amount-average' && transactions.length === 0) {
    return renderRows({ rows: [], plan, context, noun: metricNoun(plan), subjectNames, answerSuffix })
  }

  const grouped = new Map()
  if (plan.groupBy === 'calendar-day' && plan.metric === 'count') {
    for (const group of calendarDayGroupsForScope(filters.dateScope, context)) {
      grouped.set(group.key, { ...group, transactions: [] })
    }
  }
  for (const transaction of transactions) {
    const group = groupFor(transaction, plan.groupBy, context)
    const row = grouped.get(group.key) || {
      key: group.key,
      label: group.label,
      chronological: group.chronological,
      transactions: [],
    }
    row.transactions.push(transaction)
    grouped.set(group.key, row)
  }
  if (plan.groupBy === 'none' && !grouped.size) {
    grouped.set('all', { key: 'all', label: 'Matching records', chronological: 'all', transactions: [] })
  }
  const rows = [...grouped.values()].map(row => ({
    ...row,
    value: metricValue(plan.metric, row.transactions, context),
    count: row.transactions.length,
    dateKeys: plan.metric === 'distinct-days'
      ? [...new Set(row.transactions.map(transaction => localDateKey(transaction.date, context.timeZone)))].sort()
      : undefined,
  }))
  const categoryLabel = filters.categoryAlias === null
    ? null
    : context.categoriesByAlias.get(filters.categoryAlias)?.label
  const noun = categoryLabel ? `${displayLabel(categoryLabel, 80)} ${metricNoun(plan)}` : metricNoun(plan)
  return renderRows({ rows, plan, context, noun, subjectNames, answerSuffix })
}

function calculateBalanceHistoryQuery(plan, context, answerSuffix) {
  const student = context.studentsByAlias.get(plan.filters.subjectAliases[0])
  if (!student) fail('answer-unavailable', 'The selected current student is unavailable.')
  const startKey = shiftDateKey(context.asOfDate, -(plan.filters.lookbackDays - 1))
  const rows = dateKeysBetween(startKey, context.asOfDate).map(dateKey => {
    const laterApprovedChange = context.transactions.reduce((sum, transaction) => {
      if (
        transaction.studentId !== student.id || transaction.status !== 'Approved' ||
        localDateKey(transaction.date, context.timeZone) <= dateKey
      ) return sum
      return sum + (transaction.type === 'Add' ? transaction.amount : -transaction.amount)
    }, 0)
    const value = student.balance - laterApprovedChange
    if (!Number.isFinite(value)) fail('answer-unavailable', 'The historical balance exceeds safe precision.')
    const group = calendarDayGroup(dateKey)
    return { ...group, value, count: 1 }
  })
  return renderRows({
    rows,
    plan,
    context,
    noun: 'end-of-day balance',
    subjectNames: [student.name],
    answerSuffix,
  })
}

function renderRows({ rows, plan, context, noun, subjectNames = [], answerSuffix = '' }) {
  if (!rows.length) {
    return fitResponseWithinPublicBounds(labelLength => {
      const filterContext = describeQueryFilters(plan, context, Math.min(24, labelLength))
      if (plan.dataset === 'students') {
        return {
          text: 'I could not find any matching students in the current classroom roster.',
          evidence: [`Matching students: 0. Included records: ${filterContext}.`],
        }
      }
      return {
        text: `I could not find any matching records for ${friendlyDateScope(plan.filters.dateScope, context, plan.filters.lookbackDays)}.`,
        evidence: [`Matching records: 0. Included records: ${filterContext}.`],
      }
    }, answerSuffix)
  }
  if (
    plan.groupBy === 'calendar-day' &&
    plan.metric === 'count' &&
    plan.filters.dateScope === 'period'
  ) {
    return renderPeriodCalendarCountSummary({
      rows,
      plan,
      context,
      subjectNames,
      answerSuffix,
    })
  }
  const sorted = sortRows(rows, plan.order)
  const scopeBoundCalendarDays = plan.groupBy === 'calendar-day' && plan.filters.dateScope !== 'period'
  const tiedRows = scopeBoundCalendarDays ? sorted : includeTies(sorted, plan.limit)
  const answerRowLimit = ['students', 'balance-history'].includes(plan.dataset)
    ? 40
    : 8
  const selected = tiedRows.slice(0, answerRowLimit)
  const omittedTies = tiedRows.length - selected.length
  if (plan.groupBy === 'none') {
    const row = selected[0]
    const periodSuffix = plan.dataset === 'students'
      ? ''
      : ` ${friendlyAggregateDateScope(plan.filters.dateScope, context, plan.filters.lookbackDays)}`
    return fitResponseWithinPublicBounds(labelLength => {
      const filterContext = describeQueryFilters(plan, context, Math.min(24, labelLength))
      return {
        text: `The ${noun} is ${formatMetric(plan, row.value, row.count)}${periodSuffix}.`,
        evidence: [`${evidenceLine(row, plan, labelLength)} Included records: ${filterContext}.`],
      }
    }, answerSuffix)
  }

  if (scopeBoundCalendarDays && plan.metric === 'count') {
    return fitResponseWithinPublicBounds(labelLength => {
      const filterContext = describeQueryFilters(plan, context, Math.min(24, labelLength))
      return {
        text: friendlyCalendarDaySummary({ selected, plan, context, subjectNames, labelLength }),
        evidence: evidenceWithFilter(selected.map(row => {
          const relativeDay = plan.filters.dateScope === 'this-week'
            ? friendlyThisWeekDayLabel(row.key, context).replace(/^on /u, '')
            : friendlyCalendarDayLabel(row.key, context)
          return `${capitalize(relativeDay)} (${displayLabel(row.label, labelLength)}): ${formatMetric(plan, row.value, row.count)}.`
        }), filterContext),
      }
    }, answerSuffix)
  }

  const direction = plan.order === 'lowest' ? 'lowest' : plan.order === 'highest' ? 'highest' : null
  const tied = direction && selected.length > 1 && selected.every(row => row.value === selected[0].value)
  return fitResponseWithinPublicBounds(labelLength => {
    const rankedFilterContext = describeQueryFilters(plan, context, Math.min(24, labelLength))
    let summary
    let startsWithCalendarLabel = false
    if (tied) {
      const labels = joinLabels(selected.map(row => displayLabel(row.label, labelLength)))
      summary = `${labels} are tied for the ${direction} ${noun} at ${formatMetric(plan, selected[0].value, selected[0].count)}.`
      startsWithCalendarLabel = plan.groupBy === 'calendar-day'
      if (omittedTies) summary += ` And ${omittedTies} more are tied at the cutoff.`
    } else if (selected.length === 1) {
      const row = selected[0]
      summary = `${displayLabel(row.label, labelLength)} has the ${direction ? `${direction} ` : ''}${noun}: ${formatMetric(plan, row.value, row.count)}.`
      startsWithCalendarLabel = plan.groupBy === 'calendar-day'
    } else {
      const heading = direction
        ? `${capitalize(direction)} ${noun}`
        : friendlyGroupHeading(plan.groupBy)
      summary = `${heading}: ${selected.map(row => `${displayLabel(row.label, labelLength)} (${formatMetric(plan, row.value, row.count)})`).join(', ')}.`
      if (omittedTies) summary += ` And ${omittedTies} more are tied at the cutoff.`
    }
    if (subjectNames.length) {
      const subjectName = summarizeLabels(subjectNames, { labelLength })
      const subjectSummary = startsWithCalendarLabel
        ? summary
        : `${summary.charAt(0).toLocaleLowerCase('en-US')}${summary.slice(1)}`
      summary = `For ${subjectName}, ${subjectSummary}`
    }
    const evidence = evidenceWithFilter(
      selected.slice(0, 8).map(row => evidenceLine(row, plan, labelLength)),
      rankedFilterContext,
    )
    return { text: summary, evidence }
  }, answerSuffix)
}

function renderPeriodCalendarCountSummary({ rows, plan, context, subjectNames, answerSuffix }) {
  const chronological = [...rows].sort((left, right) => (
    left.key.localeCompare(right.key, 'en-US') || left.label.localeCompare(right.label, 'en-US')
  ))
  const matchingDays = chronological.filter(row => row.value > 0)
  const yesterdayKey = shiftDateKey(context.asOfDate, -1)
  const includesYesterday = matchingDays.some(row => row.key === yesterdayKey)
  const subject = subjectNames.length ? summarizeLabels(subjectNames) : null

  return fitResponseWithinPublicBounds(labelLength => {
    const countNoun = friendlyCalendarCountNoun(plan, context, labelLength)
    const dayCount = matchingDays.length
    const period = `the last ${plan.filters.lookbackDays ?? context.periodDays} days`
    const yesterdayConclusion = includesYesterday ? 'including yesterday' : 'but not yesterday'
    const text = subject
      ? `${subject} had ${countNoun.plural} on ${dayCount} ${dayCount === 1 ? 'day' : 'days'} in ${period}, ${yesterdayConclusion}.`
      : `There were ${countNoun.plural} on ${dayCount} ${dayCount === 1 ? 'day' : 'days'} in ${period}, ${yesterdayConclusion}.`
    const filterContext = describeQueryFilters(plan, context, Math.min(24, labelLength))
    const recentRows = matchingDays.slice(-6)
    const evidence = evidenceWithFilter([
      `Matching calendar days: ${dayCount}; yesterday included: ${includesYesterday ? 'yes' : 'no'}.`,
      ...recentRows.map(row => (
        `${displayLabel(row.label, labelLength)}: ${formatMetric(plan, row.value, row.count)}.`
      )),
    ], filterContext)
    return { text, evidence }
  }, answerSuffix)
}

function friendlyCalendarDaySummary({ selected, plan, context, subjectNames, labelLength }) {
  const rowsByKey = new Map(selected.map(row => [row.key, row]))
  const today = rowsByKey.get(context.asOfDate)
  const yesterday = rowsByKey.get(shiftDateKey(context.asOfDate, -1))
  const subject = subjectNames.length
    ? summarizeLabels(subjectNames, { labelLength })
    : null
  const countNoun = friendlyCalendarCountNoun(plan, context, labelLength)

  if (plan.filters.dateScope === 'this-week') {
    const ordered = [...selected].sort((left, right) => left.key.localeCompare(right.key, 'en-US'))
    const clauses = ordered.map((row, index) => {
      const day = friendlyThisWeekDayLabel(row.key, context)
      const bareCount = row.value === 0 ? 'none' : String(row.value)
      const count = index === 0 && subject
        ? friendlyCount(row.value, countNoun)
        : bareCount
      return `${count} ${day}`
    })
    const summary = joinLabels(clauses)
    return subject
      ? `${subject} had ${summary}.`
      : `Counts for ${countNoun.plural}: ${summary}.`
  }

  if (plan.filters.dateScope === 'today-and-yesterday' && today && yesterday) {
    if (yesterday.value === 0 && today.value === 0) {
      return `${friendlyCalendarClause(subject, 0, countNoun)} yesterday or today.`
    }
    if (yesterday.value === 0) {
      return `${friendlyCalendarClause(subject, today.value, countNoun)} today and none yesterday.`
    }
    if (today.value === 0) {
      return `${friendlyCalendarClause(subject, yesterday.value, countNoun)} yesterday and none today.`
    }
    if (subject) {
      return `${subject} had ${friendlyCount(yesterday.value, countNoun)} yesterday and ${friendlyCount(today.value, countNoun)} today.`
    }
    return `${friendlyCalendarClause(null, yesterday.value, countNoun)} yesterday and ${friendlyCalendarClause(null, today.value, countNoun, true)} today.`
  }

  const row = selected[0]
  const day = friendlyCalendarDayLabel(row.key, context)
  return `${friendlyCalendarClause(subject, row.value, countNoun)} ${day}.`
}

function friendlyCalendarCountNoun(plan, context, labelLength) {
  const category = plan.filters.categoryAlias === null
    ? null
    : context.categoriesByAlias.get(plan.filters.categoryAlias)?.label
  const categoryLabel = category ? `${displayLabel(category, labelLength)} ` : ''
  if (plan.filters.transactionType === 'Add') {
    if (plan.filters.status === 'Approved') {
      return { singular: `approved ${categoryLabel}credit`, plural: `approved ${categoryLabel}credits` }
    }
    const qualifier = plan.filters.status === 'any'
      ? ''
      : `${plan.filters.status.toLocaleLowerCase('en-US')} `
    const statusLabel = plan.filters.status === 'any' ? ' (any status)' : ''
    return {
      singular: `${qualifier}${categoryLabel}Add Money transaction${statusLabel}`,
      plural: `${qualifier}${categoryLabel}Add Money transactions${statusLabel}`,
    }
  }
  const qualifier = plan.filters.status === 'any'
    ? null
    : `${plan.filters.status.toLocaleLowerCase('en-US')} `
  if (plan.filters.transactionType === 'Subtract') {
    if (plan.filters.status === 'Approved') {
      return { singular: `approved ${categoryLabel}payment`, plural: `approved ${categoryLabel}payments` }
    }
    const statusLabel = plan.filters.status === 'any' ? ' (any status)' : ''
    return {
      singular: `${qualifier ?? ''}${categoryLabel}Subtract Money transaction${statusLabel}`,
      plural: `${qualifier ?? ''}${categoryLabel}Subtract Money transactions${statusLabel}`,
    }
  }
  if (qualifier === null) {
    return {
      singular: `${categoryLabel}transaction (any status)`,
      plural: `${categoryLabel}transactions (any status)`,
    }
  }
  return {
    singular: `${qualifier}${categoryLabel}transaction`,
    plural: `${qualifier}${categoryLabel}transactions`,
  }
}

function friendlyCount(value, noun) {
  if (value === 0) return `no ${noun.plural}`
  return `${value} ${value === 1 ? noun.singular : noun.plural}`
}

function friendlyCalendarClause(subject, value, noun, lowercase = false) {
  if (subject) return `${subject} had ${friendlyCount(value, noun)}`
  const there = lowercase ? 'there' : 'There'
  return `${there} ${value === 1 ? 'was' : 'were'} ${friendlyCount(value, noun)}`
}

function friendlyCalendarDayLabel(key, context) {
  if (key === context.asOfDate) return 'today'
  if (key === shiftDateKey(context.asOfDate, -1)) return 'yesterday'
  return key
}

function friendlyThisWeekDayLabel(key, context) {
  if (key === context.asOfDate) return 'today'
  if (key === shiftDateKey(context.asOfDate, -1)) return 'yesterday'
  const day = new Date(`${key}T00:00:00.000Z`).getUTCDay()
  return `on ${DAY_LABELS[day]}`
}

function friendlyGroupHeading(groupBy) {
  if (groupBy === 'time-of-day') return 'By time of day'
  if (groupBy === 'calendar-day') return 'By day'
  if (groupBy === 'day-of-week') return 'By day of the week'
  if (groupBy === 'week') return 'By week'
  return 'Results'
}

function evidenceWithFilter(lines, filterContext, verb = 'Records checked') {
  if (lines.length < 8) return [...lines, `${verb}: ${filterContext}.`]
  return lines.map((line, index) => index === 0 ? `${line} ${verb}: ${filterContext}.` : line)
}

function groupFor(transaction, groupBy, context) {
  if (groupBy === 'none') return { key: 'all', label: 'Matching records', chronological: 'all' }
  if (groupBy === 'student') {
    const student = context.participantsById.get(transaction.studentId)
    if (!student) fail('answer-unavailable', 'A transaction references an unknown student.')
    return { key: student.alias, label: student.name, chronological: student.alias }
  }
  if (groupBy === 'category') {
    const category = context.categoriesByAlias.get(transaction.categoryAlias)
    if (!category) fail('answer-unavailable', 'A transaction references an unknown category.')
    return { key: category.alias, label: category.label, chronological: category.alias }
  }
  if (groupBy === 'time-of-day') {
    const bucket = timeBucketFor(transaction.date, context.timeZone)
    return { key: bucket.id, label: bucket.label, chronological: String(TIME_BUCKETS.findIndex(item => item.id === bucket.id)) }
  }
  const date = localDateParts(transaction.date, context.timeZone)
  if (groupBy === 'calendar-day') {
    const key = localDateKey(transaction.date, context.timeZone)
    return calendarDayGroup(key)
  }
  if (groupBy === 'day-of-week') {
    const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
    return { key: String(day), label: DAY_LABELS[day], chronological: String((day + 6) % 7).padStart(2, '0') }
  }
  if (groupBy === 'week') {
    const local = new Date(Date.UTC(date.year, date.month - 1, date.day))
    const mondayOffset = (local.getUTCDay() + 6) % 7
    local.setUTCDate(local.getUTCDate() - mondayOffset)
    const key = local.toISOString().slice(0, 10)
    return {
      key,
      label: `Week of ${local.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })}`,
      chronological: key,
    }
  }
  fail('answer-unavailable', 'The requested grouping is unsupported.')
}

function metricValue(metric, transactions, context) {
  if (metric === 'count') return transactions.length
  if (metric === 'distinct-days') {
    return new Set(transactions.map(transaction => (
      localDateKey(transaction.date, context.timeZone)
    ))).size
  }
  const total = transactions.reduce((sum, transaction) => sum + transaction.amount, 0)
  if (!Number.isFinite(total)) fail('answer-unavailable', 'The requested transaction total exceeds safe precision.')
  if (metric === 'amount-total') return total
  if (metric === 'amount-average') return transactions.length ? total / transactions.length : 0
  if (metric === 'net-amount') {
    const net = transactions.reduce((sum, transaction) => (
      sum + (transaction.type === 'Add' ? transaction.amount : -transaction.amount)
    ), 0)
    if (!Number.isFinite(net)) fail('answer-unavailable', 'The requested net amount exceeds safe precision.')
    return net
  }
  fail('answer-unavailable', 'The requested transaction metric is unsupported.')
}

function metricNoun(plan) {
  if (plan.metric === 'count') return 'transaction count'
  if (plan.metric === 'distinct-days') return 'distinct day count'
  if (plan.metric === 'amount-total') return 'total amount'
  if (plan.metric === 'amount-average') return 'average amount'
  if (plan.metric === 'net-amount') return 'net amount'
  return plan.metric
}

function sortRows(rows, order) {
  return [...rows].sort((left, right) => {
    if (order === 'chronological') {
      return left.chronological.localeCompare(right.chronological, 'en-US') || left.label.localeCompare(right.label, 'en-US')
    }
    const difference = order === 'lowest' ? left.value - right.value : right.value - left.value
    return difference || right.count - left.count || left.label.localeCompare(right.label, 'en-US')
  })
}

function includeTies(rows, limit) {
  const selected = rows.slice(0, limit)
  if (!selected.length) return selected
  const cutoff = selected[selected.length - 1].value
  for (const row of rows.slice(limit)) {
    if (row.value !== cutoff) break
    selected.push(row)
  }
  return selected
}

function evidenceLine(row, plan, labelLength = MAX_DISPLAY_LABEL_LENGTH) {
  const metric = plan.metric
  if (plan.dataset === 'balance-history') {
    return `${displayLabel(row.label, labelLength)}: ${money(row.value)} end-of-day balance.`
  }
  if (plan.dataset === 'students') {
    if (metric === 'count') return `Matching students: ${row.value}.`
    if (metric === 'average-balance') return `Average current balance: ${money(row.value)} across ${row.count} ${row.count === 1 ? 'student' : 'students'}.`
    return `${displayLabel(row.label, labelLength)}: ${money(row.value)} current balance.`
  }
  const count = `${row.count} matching ${row.count === 1 ? 'transaction' : 'transactions'}`
  if (metric === 'distinct-days') {
    const dates = row.dateKeys?.length ? ` on ${joinLabels(row.dateKeys)}` : ''
    return `${displayLabel(row.label, labelLength)}: ${row.value} distinct ${row.value === 1 ? 'day' : 'days'}${dates}; ${count}.`
  }
  if (metric === 'current-balance') return `${row.label}: ${money(row.value)} current balance.`
  return `${displayLabel(row.label, labelLength)}: ${formatMetric(plan, row.value, row.count)}; ${count}.`
}

function formatMetric(plan, value, count) {
  const { metric } = plan
  if (metric === 'count') {
    const noun = plan.dataset === 'students' ? 'student' : 'transaction'
    return `${value} ${value === 1 ? noun : `${noun}s`}`
  }
  if (metric === 'distinct-days') return `${value} distinct ${value === 1 ? 'day' : 'days'}`
  if (['current-balance', 'average-balance'].includes(metric)) return money(value)
  if (metric === 'closing-balance') return money(value)
  if (metric === 'net-amount') return `${value < 0 ? '−' : '+'}${money(Math.abs(value))}`
  if (metric === 'amount-average' && count === 0) return money(0)
  return money(value)
}

function timeBucketFor(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' })
  const hour = Number(formatter.formatToParts(new Date(date)).find(part => part.type === 'hour')?.value)
  return TIME_BUCKETS.find(bucket => bucket.matches(hour)) || TIME_BUCKETS[TIME_BUCKETS.length - 1]
}

function matchesDateScope(transaction, dateScope, context, lookbackDays = null) {
  if (dateScope === 'period') {
    const start = lookbackDays === null
      ? Date.parse(context.periodStart)
      : Date.parse(context.generatedAt) - lookbackDays * 24 * 60 * 60 * 1000
    return Date.parse(transaction.date) >= start
  }
  const transactionDate = localDateKey(transaction.date, context.timeZone)
  if (dateScope === 'today') return transactionDate === context.asOfDate
  const yesterday = shiftDateKey(context.asOfDate, -1)
  if (dateScope === 'yesterday') return transactionDate === yesterday
  if (dateScope === 'today-and-yesterday') {
    return transactionDate === context.asOfDate || transactionDate === yesterday
  }
  if (dateScope === 'this-week') {
    return transactionDate >= startOfWeekDateKey(context.asOfDate) &&
      transactionDate <= context.asOfDate
  }
  fail('answer-unavailable', 'The requested date scope is unsupported.')
}

function calendarDayGroupsForScope(dateScope, context) {
  if (dateScope === 'today') return [calendarDayGroup(context.asOfDate)]
  const yesterday = shiftDateKey(context.asOfDate, -1)
  if (dateScope === 'yesterday') return [calendarDayGroup(yesterday)]
  if (dateScope === 'today-and-yesterday') {
    return [calendarDayGroup(yesterday), calendarDayGroup(context.asOfDate)]
  }
  if (dateScope === 'this-week') {
    return dateKeysBetween(startOfWeekDateKey(context.asOfDate), context.asOfDate)
      .map(calendarDayGroup)
  }
  return []
}

function calendarDayGroup(key) {
  const label = new Date(`${key}T00:00:00.000Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  return { key, label, chronological: key }
}

function describeDateScope(dateScope, context, lookbackDays = null) {
  if (dateScope === 'period') return `the last ${lookbackDays ?? context.periodDays} days`
  if (dateScope === 'today') return `today (${context.asOfDate} in ${context.timeZone})`
  const yesterday = shiftDateKey(context.asOfDate, -1)
  if (dateScope === 'yesterday') return `yesterday (${yesterday} in ${context.timeZone})`
  if (dateScope === 'today-and-yesterday') {
    return `today and yesterday (${yesterday} and ${context.asOfDate} in ${context.timeZone})`
  }
  if (dateScope === 'this-week') {
    return `this week to date (${startOfWeekDateKey(context.asOfDate)} through ${context.asOfDate} in ${context.timeZone})`
  }
  fail('answer-unavailable', 'The requested date scope is unsupported.')
}

function friendlyDateScope(dateScope, context, lookbackDays = null) {
  if (dateScope === 'period') return `the last ${lookbackDays ?? context.periodDays} days`
  if (dateScope === 'today') return 'today'
  if (dateScope === 'yesterday') return 'yesterday'
  if (dateScope === 'today-and-yesterday') return 'yesterday or today'
  if (dateScope === 'this-week') return 'this week'
  fail('answer-unavailable', 'The requested date scope is unsupported.')
}

function friendlyAggregateDateScope(dateScope, context, lookbackDays = null) {
  if (dateScope === 'period') return `over the last ${lookbackDays ?? context.periodDays} days`
  if (dateScope === 'today') return 'today'
  if (dateScope === 'yesterday') return 'yesterday'
  if (dateScope === 'today-and-yesterday') return 'across yesterday and today'
  if (dateScope === 'this-week') return 'this week'
  fail('answer-unavailable', 'The requested date scope is unsupported.')
}

function shiftDateKey(dateKey, days) {
  const shifted = new Date(`${dateKey}T00:00:00.000Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

function startOfWeekDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00.000Z`)
  const mondayOffset = (date.getUTCDay() + 6) % 7
  return shiftDateKey(dateKey, -mondayOffset)
}

function dateKeysBetween(startKey, endKey) {
  const keys = []
  for (let key = startKey; key <= endKey; key = shiftDateKey(key, 1)) keys.push(key)
  return keys
}

function localDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(new Date(date)).map(part => [part.type, part.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
}

function localDateKey(date, timeZone) {
  const parts = localDateParts(date, timeZone)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function matchesBalanceCondition(balance, condition) {
  if (condition === 'any') return true
  if (condition === 'negative') return balance < 0
  if (condition === 'zero') return balance === 0
  if (condition === 'positive') return balance > 0
  if (condition === 'nonpositive') return balance <= 0
  fail('answer-unavailable', 'The requested balance condition is unsupported.')
}

function validateEvidence(value) {
  if (
    !value || typeof value !== 'object' || !Array.isArray(value.participants) ||
    !Array.isArray(value.students) ||
    !Array.isArray(value.categories) || !Array.isArray(value.transactions) ||
    !Number.isSafeInteger(value.configuredRentAmount) ||
    value.configuredRentAmount < 0 || value.configuredRentAmount > 1_000_000 ||
    ![7, 30, 90].includes(value.periodDays) || typeof value.timeZone !== 'string' ||
    !(value.generatedAt === undefined || (
      typeof value.generatedAt === 'string' && Number.isFinite(Date.parse(value.generatedAt))
    )) ||
    typeof value.periodStart !== 'string' || !Number.isFinite(Date.parse(value.periodStart)) ||
    typeof value.asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOfDate)
  ) fail('answer-unavailable', 'The server answer evidence is malformed.')

  const participantsById = new Map()
  const participantsByAlias = new Map()
  for (const participant of value.participants) {
    if (
      !participant || !Number.isSafeInteger(participant.id) || participant.id < 1 ||
      !/^student-[0-9]{3}$/.test(participant.alias) || typeof participant.name !== 'string' ||
      !participant.name || participantsById.has(participant.id) || participantsByAlias.has(participant.alias)
    ) fail('answer-unavailable', 'The server participant evidence is malformed.')
    participantsById.set(participant.id, participant)
    participantsByAlias.set(participant.alias, participant)
  }
  const studentsById = new Map()
  const studentsByAlias = new Map()
  for (const student of value.students) {
    const participant = participantsById.get(student.id)
    if (
      !student || !Number.isSafeInteger(student.id) || student.id < 1 ||
      !/^student-[0-9]{3}$/.test(student.alias) || typeof student.name !== 'string' ||
      !Number.isFinite(student.balance) || typeof student.frozen !== 'boolean' ||
      studentsById.has(student.id) || studentsByAlias.has(student.alias) ||
      !participant || participant.alias !== student.alias || participant.name !== student.name
    ) fail('answer-unavailable', 'The server student evidence is malformed.')
    studentsById.set(student.id, student)
    studentsByAlias.set(student.alias, student)
  }
  const categoriesByAlias = new Map()
  for (const category of value.categories) {
    if (
      !category || !/^category-[0-9]{3}$/.test(category.alias) ||
      typeof category.label !== 'string' || !category.label || categoriesByAlias.has(category.alias)
    ) fail('answer-unavailable', 'The server category evidence is malformed.')
    categoriesByAlias.set(category.alias, category)
  }
  const transactionIds = new Set()
  for (const transaction of value.transactions) {
    if (
      !transaction || !Number.isSafeInteger(transaction.id) || transaction.id < 1 ||
      !participantsById.has(transaction.studentId) || !categoriesByAlias.has(transaction.categoryAlias) ||
      !['Add', 'Subtract'].includes(transaction.type) || !['Approved', 'Pending', 'Denied'].includes(transaction.status) ||
      !['rent', 'other'].includes(transaction.purpose) ||
      !Number.isFinite(transaction.amount) || transaction.amount <= 0 || transactionIds.has(transaction.id) ||
      !Number.isFinite(Date.parse(transaction.date))
    ) fail('answer-unavailable', 'The server transaction evidence is malformed.')
    transactionIds.add(transaction.id)
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(new Date())
  } catch {
    fail('answer-unavailable', 'The server time zone evidence is malformed.')
  }
  return Object.freeze({
    ...value,
    generatedAt: value.generatedAt ?? `${value.asOfDate}T23:59:59.999Z`,
    participantsById,
    participantsByAlias,
    studentsById,
    studentsByAlias,
    categoriesByAlias,
  })
}

function validatePlanForCalculation(plan) {
  if (isPlainObject(plan) && Object.hasOwn(plan, 'operation')) {
    if (plan.operation === 'analyze') {
      if (
        !hasExactKeys(plan, ['operation', 'queries']) || !Array.isArray(plan.queries) ||
        plan.queries.length < 1 || plan.queries.length > 4
      ) fail('answer-unavailable', 'The analysis plan is malformed.')
      for (const query of plan.queries) validatePlanForCalculation(query)
      return
    }
    if (plan.operation === 'list-student-balances') {
      if (!hasExactKeys(plan, ['operation'])) {
        fail('answer-unavailable', 'The student balance list plan is malformed.')
      }
      return
    }
    validateMissingTransactionPlanForCalculation(plan)
    return
  }
  if (
    !isPlainObject(plan) || !hasExactKeys(plan, ['dataset', 'metric', 'filters', 'groupBy', 'order', 'limit']) ||
    !hasQueryFilterKeys(plan.filters) ||
    !['transactions', 'students', 'balance-history'].includes(plan.dataset) ||
    !['count', 'distinct-days', 'amount-total', 'amount-average', 'net-amount', 'current-balance', 'average-balance', 'closing-balance'].includes(plan.metric) ||
    !['none', 'student', 'category', 'time-of-day', 'calendar-day', 'day-of-week', 'week'].includes(plan.groupBy) ||
    !['highest', 'lowest', 'chronological'].includes(plan.order) ||
    !Number.isSafeInteger(plan.limit) || plan.limit < 1 || plan.limit > 40 ||
    !Array.isArray(plan.filters.subjectAliases) || plan.filters.subjectAliases.length > 8 ||
    plan.filters.subjectAliases.some(alias => !/^student-[0-9]{3}$/.test(alias)) ||
    new Set(plan.filters.subjectAliases).size !== plan.filters.subjectAliases.length ||
    !(plan.filters.categoryAlias === null || /^category-[0-9]{3}$/.test(plan.filters.categoryAlias)) ||
    !['Add', 'Subtract', 'any'].includes(plan.filters.transactionType) ||
    !['Approved', 'Pending', 'Denied', 'any'].includes(plan.filters.status) ||
    !['period', 'today', 'yesterday', 'today-and-yesterday', 'this-week'].includes(plan.filters.dateScope) ||
    !(plan.filters.lookbackDays === undefined || plan.filters.lookbackDays === null || (
      Number.isSafeInteger(plan.filters.lookbackDays) &&
      plan.filters.lookbackDays >= 1 && plan.filters.lookbackDays <= 90
    )) ||
    !(plan.filters.timeBucket === null || TIME_BUCKETS.some(bucket => bucket.id === plan.filters.timeBucket)) ||
    !['active', 'frozen', 'any'].includes(plan.filters.studentState) ||
    !(plan.filters.balanceCondition === undefined ||
      ['any', 'negative', 'zero', 'positive', 'nonpositive'].includes(plan.filters.balanceCondition))
  ) fail('answer-unavailable', 'The server query plan is malformed.')
  const coherenceError = questionQueryPlanCoherenceError(plan)
  if (coherenceError) fail('answer-unavailable', coherenceError)
}

function validateMissingTransactionPlanForCalculation(plan) {
  if (
    !hasMissingTransactionKeys(plan) ||
    plan.operation !== 'students-without-transactions' ||
    !Array.isArray(plan.subjectAliases) || plan.subjectAliases.length > 8 ||
    plan.subjectAliases.some(alias => !/^student-[0-9]{3}$/.test(alias)) ||
    new Set(plan.subjectAliases).size !== plan.subjectAliases.length ||
    !(plan.categoryAlias === null || /^category-[0-9]{3}$/.test(plan.categoryAlias)) ||
    !['any', 'rent'].includes(plan.purpose) ||
    !['Add', 'Subtract', 'any'].includes(plan.transactionType) ||
    !['Approved', 'Pending', 'Denied', 'any'].includes(plan.status) ||
    !['period', 'today', 'yesterday', 'today-and-yesterday', 'this-week'].includes(plan.dateScope) ||
    !(plan.lookbackDays === undefined || plan.lookbackDays === null || (
      Number.isSafeInteger(plan.lookbackDays) && plan.lookbackDays >= 1 && plan.lookbackDays <= 90
    )) ||
    !(plan.amountExact === null || (
      typeof plan.amountExact === 'number' && Number.isFinite(plan.amountExact) &&
      plan.amountExact > 0 && plan.amountExact <= 1_000_000
    )) ||
    !['active', 'frozen', 'any'].includes(plan.studentState) ||
    !Number.isSafeInteger(plan.limit) || plan.limit < 1 || plan.limit > 8 ||
    (plan.purpose === 'rent' && (plan.categoryAlias !== null || plan.transactionType !== 'Subtract'))
  ) fail('answer-unavailable', 'The missing transaction plan is malformed.')
}

function describeMissingTransactionFilters(plan, context, labelLength = 24) {
  const type = plan.transactionType === 'Add'
    ? 'earning (Add) transactions'
    : plan.transactionType === 'Subtract'
      ? 'spending (Subtract) transactions'
      : 'earning (Add) and spending (Subtract) transactions'
  const parts = [plan.status === 'any'
    ? `${type} across all approval statuses`
    : `${plan.status.toLocaleLowerCase('en-US')} ${type}`]
  if (plan.purpose === 'rent') parts.push('rent payments')
  if (plan.categoryAlias !== null) {
    const category = context.categoriesByAlias.get(plan.categoryAlias)
    parts.push(`category ${displayLabel(category?.label || plan.categoryAlias, labelLength)}`)
  }
  if (plan.amountExact !== null) {
    parts.push(`exactly ${money(plan.amountExact)}`)
  } else if (plan.purpose === 'rent' && context.configuredRentAmount > 0) {
    parts.push(`the configured rent amount of ${money(context.configuredRentAmount)}`)
  }
  parts.push(describeDateScope(plan.dateScope, context, plan.lookbackDays ?? null))
  parts.push(plan.studentState === 'any'
    ? 'all current students'
    : `current ${plan.studentState} students`)
  if (plan.subjectAliases.length) {
    const names = plan.subjectAliases.map(alias => context.studentsByAlias.get(alias)?.name || alias)
    parts.push(`selected ${summarizeLabels(names, { maximum: 2, labelLength })}`)
  }
  return parts.join('; ')
}

function describeQueryFilters(plan, context, labelLength = 24) {
  if (plan.dataset === 'balance-history') {
    const student = context.studentsByAlias.get(plan.filters.subjectAliases[0])
    return `end-of-day balances for ${displayLabel(student?.name || plan.filters.subjectAliases[0], labelLength)}; ${describeDateScope('period', context, plan.filters.lookbackDays)}`
  }
  if (plan.dataset === 'students') {
    const state = plan.filters.studentState === 'any'
      ? 'all current students'
      : `current ${plan.filters.studentState} students`
    const balanceCondition = plan.filters.balanceCondition ?? 'any'
    const balance = balanceCondition === 'any'
      ? ''
      : `; ${balanceCondition} current balances`
    if (!plan.filters.subjectAliases.length) return `${state}${balance}`
    const names = plan.filters.subjectAliases.map(alias => context.studentsByAlias.get(alias)?.name || alias)
    return `${state}${balance}; selected ${summarizeLabels(names, { maximum: 2, labelLength })}`
  }
  const type = plan.filters.transactionType === 'Add'
    ? 'earning (Add) transactions'
    : plan.filters.transactionType === 'Subtract'
      ? 'spending (Subtract) transactions'
      : 'earning (Add) and spending (Subtract) transactions'
  const parts = [plan.filters.status === 'any'
    ? `${type} across all approval statuses`
    : `${plan.filters.status.toLocaleLowerCase('en-US')} ${type}`]
  if (plan.filters.subjectAliases.length) {
    const names = plan.filters.subjectAliases.map(alias => context.participantsByAlias.get(alias)?.name || alias)
    parts.push(`selected ${summarizeLabels(names, { maximum: 2, labelLength })}`)
  }
  if (plan.filters.categoryAlias !== null) {
    const category = context.categoriesByAlias.get(plan.filters.categoryAlias)
    parts.push(`category ${displayLabel(category?.label || plan.filters.categoryAlias, labelLength)}`)
  }
  if (plan.filters.timeBucket !== null) {
    parts.push(TIME_BUCKETS.find(bucket => bucket.id === plan.filters.timeBucket)?.label || plan.filters.timeBucket)
  }
  parts.push(describeDateScope(plan.filters.dateScope, context, plan.filters.lookbackDays))
  if (plan.filters.studentState !== 'any') {
    parts.push(`current ${plan.filters.studentState} students`)
  }
  return parts.join('; ')
}

function summarizeLabels(labels, { maximum = 2, labelLength = MAX_DISPLAY_LABEL_LENGTH } = {}) {
  const selected = labels.slice(0, maximum).map(label => displayLabel(label, labelLength))
  const omitted = labels.length - selected.length
  return `${joinLabels(selected)}${omitted ? ` and ${omitted} ${omitted === 1 ? 'other' : 'others'}` : ''}`
}

function displayLabel(value, maximum = MAX_DISPLAY_LABEL_LENGTH) {
  const characters = [...String(value).replace(/\s+/gu, ' ').trim()]
  if (characters.length <= maximum) return characters.join('')
  return `${characters.slice(0, maximum - 1).join('')}…`
}

function money(value) {
  return Number(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function joinLabels(labels) {
  if (labels.length < 2) return labels[0] || ''
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index])
}

function hasQueryFilterKeys(value) {
  if (!isPlainObject(value)) return false
  const required = ['subjectAliases', 'categoryAlias', 'transactionType', 'status', 'dateScope', 'timeBucket', 'studentState']
  const allowed = new Set([...required, 'lookbackDays', 'balanceCondition'])
  return required.every(field => Object.hasOwn(value, field)) &&
    Object.keys(value).every(field => allowed.has(field))
}

function hasMissingTransactionKeys(value) {
  if (!isPlainObject(value)) return false
  const required = [
    'operation', 'subjectAliases', 'categoryAlias', 'purpose', 'transactionType',
    'status', 'dateScope', 'amountExact', 'studentState', 'limit',
  ]
  const allowed = new Set([...required, 'lookbackDays'])
  return required.every(field => Object.hasOwn(value, field)) &&
    Object.keys(value).every(field => allowed.has(field))
}

function answer(text, evidence, maximumAnswerLength = MAX_ANSWER_LENGTH) {
  if (!responseWithinPublicBounds(text, evidence, maximumAnswerLength)) {
    fail('answer-unavailable', 'The calculated answer exceeds the public response bounds.')
  }
  return Object.freeze({ answer: text, evidence: Object.freeze(evidence) })
}

function fitResponseWithinPublicBounds(render, answerSuffix = '') {
  for (const labelLength of RESPONSE_LABEL_LENGTHS) {
    const { text, evidence } = render(labelLength)
    const combinedText = `${text}${answerSuffix}`
    if (responseWithinPublicBounds(combinedText, evidence)) return answer(combinedText, evidence)
  }
  fail('answer-unavailable', 'The calculated answer exceeds the public response bounds.')
}

function responseWithinPublicBounds(text, evidence, maximumAnswerLength = MAX_ANSWER_LENGTH) {
  return !(
    typeof text !== 'string' || text.length < 1 || text.length > maximumAnswerLength ||
    !Array.isArray(evidence) || evidence.length < 1 || evidence.length > 8 ||
    evidence.some(line => typeof line !== 'string' || line.length < 1 || line.length > MAX_EVIDENCE_LENGTH)
  )
}

function fail(category, message) {
  throw new InsightQuestionAnswerError(category, message)
}
