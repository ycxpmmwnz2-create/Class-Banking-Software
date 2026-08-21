import { questionQueryPlanCoherenceError } from './questionContracts.js'

const TIME_BUCKETS = Object.freeze([
  Object.freeze({ id: 'morning', label: 'morning (5:00 AM–11:59 AM)', matches: hour => hour >= 5 && hour < 12 }),
  Object.freeze({ id: 'afternoon', label: 'afternoon (12:00 PM–4:59 PM)', matches: hour => hour >= 12 && hour < 17 }),
  Object.freeze({ id: 'evening', label: 'evening (5:00 PM–8:59 PM)', matches: hour => hour >= 17 && hour < 21 }),
  Object.freeze({ id: 'night', label: 'night (9:00 PM–4:59 AM)', matches: hour => hour >= 21 || hour < 5 }),
])
const DAY_LABELS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
const MAX_ANSWER_LENGTH = 800
const MAX_EVIDENCE_LENGTH = 320
const MAX_DISPLAY_LABEL_LENGTH = 48
const RESPONSE_LABEL_LENGTHS = Object.freeze([48, 40, 32, 24, 16])

export class InsightQuestionAnswerError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightQuestionAnswerError'
    this.category = category
  }
}

export function calculateQuestionAnswer({ kind, plan, evidence } = {}) {
  const context = validateEvidence(evidence)
  if (kind === 'unsupported') {
    if (plan !== null) fail('answer-unavailable', 'An unsupported question cannot contain a query plan.')
    return answer(
      'The available Morgan Bank records do not contain the information needed to answer that question reliably.',
      ['No answer was generated beyond the supported classroom records.'],
    )
  }
  if (kind !== 'query') fail('answer-unavailable', 'The interpreted question is unsupported.')
  validatePlanForCalculation(plan)

  if (plan.dataset === 'students') return calculateStudentQuery(plan, context)
  return calculateTransactionQuery(plan, context)
}

function calculateStudentQuery(plan, context) {
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
  if (plan.metric === 'count') {
    return renderRows({
      rows: [{ key: 'students', label: 'Matching students', value: students.length, count: students.length, chronological: 'students' }],
      plan,
      context,
      noun: plan.filters.studentState === 'any' ? 'student count' : `${plan.filters.studentState} student count`,
    })
  }
  if (plan.metric === 'average-balance') {
    if (!students.length) return renderRows({ rows: [], plan, context, noun: 'average current balance' })
    const average = students.reduce((total, student) => total + student.balance, 0) / students.length
    if (!Number.isFinite(average)) fail('answer-unavailable', 'The average balance exceeds safe precision.')
    return renderRows({
      rows: [{ key: 'students', label: 'Matching students', value: average, count: students.length, chronological: 'students' }],
      plan,
      context,
      noun: 'average current balance',
    })
  }
  const rows = students.map(student => ({
    key: student.alias,
    label: student.name,
    value: student.balance,
    count: 1,
    chronological: student.alias,
  }))
  return renderRows({ rows, plan, context, noun: 'current balance' })
}

function calculateTransactionQuery(plan, context) {
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
    return renderRows({ rows: [], plan, context, noun: metricNoun(plan), subjectNames })
  }

  const grouped = new Map()
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
    value: metricValue(plan.metric, row.transactions),
    count: row.transactions.length,
  }))
  const categoryLabel = filters.categoryAlias === null
    ? null
    : context.categoriesByAlias.get(filters.categoryAlias)?.label
  const noun = categoryLabel ? `${displayLabel(categoryLabel, 80)} ${metricNoun(plan)}` : metricNoun(plan)
  return renderRows({ rows, plan, context, noun, subjectNames })
}

function renderRows({ rows, plan, context, noun, subjectNames = [] }) {
  if (!rows.length) {
    return fitResponseWithinPublicBounds(labelLength => {
      const filterContext = describeQueryFilters(plan, context, Math.min(24, labelLength))
      if (plan.dataset === 'students') {
        return {
          text: `No matching students were found in the current classroom roster. This uses ${filterContext}.`,
          evidence: [`Matching students: 0. Included records: ${filterContext}.`],
        }
      }
      return {
        text: `No matching records were found in the last ${context.periodDays} days. This uses ${filterContext}.`,
        evidence: [`Matching records: 0. Included records: ${filterContext}.`],
      }
    })
  }
  const sorted = sortRows(rows, plan.order)
  const tiedRows = includeTies(sorted, plan.limit)
  const selected = tiedRows.slice(0, 8)
  const omittedTies = tiedRows.length - selected.length
  if (plan.groupBy === 'none') {
    const row = selected[0]
    const periodSuffix = plan.dataset === 'students' ? '' : ` for the last ${context.periodDays} days`
    return fitResponseWithinPublicBounds(labelLength => {
      const filterContext = describeQueryFilters(plan, context, Math.min(24, labelLength))
      return {
        text: `The ${noun} is ${formatMetric(plan, row.value, row.count)}${periodSuffix}. This uses ${filterContext}.`,
        evidence: [`${evidenceLine(row, plan, labelLength)} Included records: ${filterContext}.`],
      }
    })
  }

  const direction = plan.order === 'lowest' ? 'lowest' : plan.order === 'highest' ? 'highest' : null
  const tied = direction && selected.length > 1 && selected.every(row => row.value === selected[0].value)
  return fitResponseWithinPublicBounds(labelLength => {
    const rankedFilterContext = describeQueryFilters(plan, context, Math.min(24, labelLength))
    let summary
    if (tied) {
      const labels = joinLabels(selected.map(row => displayLabel(row.label, labelLength)))
      summary = `${labels} are tied for the ${direction} ${noun} at ${formatMetric(plan, selected[0].value, selected[0].count)}.`
      if (omittedTies) summary += ` And ${omittedTies} more are tied at the cutoff.`
    } else if (selected.length === 1) {
      const row = selected[0]
      summary = `${displayLabel(row.label, labelLength)} has the ${direction ? `${direction} ` : ''}${noun}: ${formatMetric(plan, row.value, row.count)}.`
    } else {
      summary = `${direction ? capitalize(direction) : 'Chronological'} ${noun} results for the last ${context.periodDays} days: ${selected.map(row => `${displayLabel(row.label, labelLength)} (${formatMetric(plan, row.value, row.count)})`).join(', ')}.`
      if (omittedTies) summary += ` And ${omittedTies} more are tied at the cutoff.`
    }
    if (subjectNames.length) {
      const subjectName = summarizeLabels(subjectNames, { labelLength })
      summary = `For ${subjectName}, ${summary.charAt(0).toLocaleLowerCase('en-US')}${summary.slice(1)}`
    }
    summary += ` This uses ${rankedFilterContext}.`
    const evidence = selected.map(row => (
      `${evidenceLine(row, plan, labelLength)} Included records: ${rankedFilterContext}.`
    ))
    return { text: summary, evidence }
  })
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

function metricValue(metric, transactions) {
  if (metric === 'count') return transactions.length
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
  if (plan.dataset === 'students') {
    if (metric === 'count') return `Matching students: ${row.value}.`
    if (metric === 'average-balance') return `Average current balance: ${money(row.value)} across ${row.count} ${row.count === 1 ? 'student' : 'students'}.`
    return `${displayLabel(row.label, labelLength)}: ${money(row.value)} current balance.`
  }
  const count = `${row.count} matching ${row.count === 1 ? 'transaction' : 'transactions'}`
  if (metric === 'current-balance') return `${row.label}: ${money(row.value)} current balance.`
  return `${displayLabel(row.label, labelLength)}: ${formatMetric(plan, row.value, row.count)}; ${count}.`
}

function formatMetric(plan, value, count) {
  const { metric } = plan
  if (metric === 'count') {
    const noun = plan.dataset === 'students' ? 'student' : 'transaction'
    return `${value} ${value === 1 ? noun : `${noun}s`}`
  }
  if (['current-balance', 'average-balance'].includes(metric)) return money(value)
  if (metric === 'net-amount') return `${value < 0 ? '−' : '+'}${money(Math.abs(value))}`
  if (metric === 'amount-average' && count === 0) return money(0)
  return money(value)
}

function timeBucketFor(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' })
  const hour = Number(formatter.formatToParts(new Date(date)).find(part => part.type === 'hour')?.value)
  return TIME_BUCKETS.find(bucket => bucket.matches(hour)) || TIME_BUCKETS[TIME_BUCKETS.length - 1]
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

function validateEvidence(value) {
  if (
    !value || typeof value !== 'object' || !Array.isArray(value.participants) ||
    !Array.isArray(value.students) ||
    !Array.isArray(value.categories) || !Array.isArray(value.transactions) ||
    ![7, 30, 90].includes(value.periodDays) || typeof value.timeZone !== 'string'
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
    participantsById,
    participantsByAlias,
    studentsById,
    studentsByAlias,
    categoriesByAlias,
  })
}

function validatePlanForCalculation(plan) {
  if (
    !isPlainObject(plan) || !hasExactKeys(plan, ['dataset', 'metric', 'filters', 'groupBy', 'order', 'limit']) ||
    !isPlainObject(plan.filters) || !hasExactKeys(
      plan.filters,
      ['subjectAliases', 'categoryAlias', 'transactionType', 'status', 'timeBucket', 'studentState'],
    ) ||
    !['transactions', 'students'].includes(plan.dataset) ||
    !['count', 'amount-total', 'amount-average', 'net-amount', 'current-balance', 'average-balance'].includes(plan.metric) ||
    !['none', 'student', 'category', 'time-of-day', 'day-of-week', 'week'].includes(plan.groupBy) ||
    !['highest', 'lowest', 'chronological'].includes(plan.order) ||
    !Number.isSafeInteger(plan.limit) || plan.limit < 1 || plan.limit > 8 ||
    !Array.isArray(plan.filters.subjectAliases) || plan.filters.subjectAliases.length > 8 ||
    plan.filters.subjectAliases.some(alias => !/^student-[0-9]{3}$/.test(alias)) ||
    new Set(plan.filters.subjectAliases).size !== plan.filters.subjectAliases.length ||
    !(plan.filters.categoryAlias === null || /^category-[0-9]{3}$/.test(plan.filters.categoryAlias)) ||
    !['Add', 'Subtract', 'any'].includes(plan.filters.transactionType) ||
    !['Approved', 'Pending', 'Denied', 'any'].includes(plan.filters.status) ||
    !(plan.filters.timeBucket === null || TIME_BUCKETS.some(bucket => bucket.id === plan.filters.timeBucket)) ||
    !['active', 'frozen', 'any'].includes(plan.filters.studentState)
  ) fail('answer-unavailable', 'The server query plan is malformed.')
  const coherenceError = questionQueryPlanCoherenceError(plan)
  if (coherenceError) fail('answer-unavailable', coherenceError)
}

function describeQueryFilters(plan, context, labelLength = 24) {
  if (plan.dataset === 'students') {
    const state = plan.filters.studentState === 'any'
      ? 'all current students'
      : `current ${plan.filters.studentState} students`
    if (!plan.filters.subjectAliases.length) return state
    const names = plan.filters.subjectAliases.map(alias => context.studentsByAlias.get(alias)?.name || alias)
    return `${state}; selected ${summarizeLabels(names, { maximum: 2, labelLength })}`
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

function answer(text, evidence) {
  if (!responseWithinPublicBounds(text, evidence)) {
    fail('answer-unavailable', 'The calculated answer exceeds the public response bounds.')
  }
  return Object.freeze({ answer: text, evidence: Object.freeze(evidence) })
}

function fitResponseWithinPublicBounds(render) {
  for (const labelLength of RESPONSE_LABEL_LENGTHS) {
    const { text, evidence } = render(labelLength)
    if (responseWithinPublicBounds(text, evidence)) return answer(text, evidence)
  }
  fail('answer-unavailable', 'The calculated answer exceeds the public response bounds.')
}

function responseWithinPublicBounds(text, evidence) {
  return !(
    typeof text !== 'string' || text.length < 1 || text.length > MAX_ANSWER_LENGTH ||
    !Array.isArray(evidence) || evidence.length < 1 || evidence.length > 8 ||
    evidence.some(line => typeof line !== 'string' || line.length < 1 || line.length > MAX_EVIDENCE_LENGTH)
  )
}

function fail(category, message) {
  throw new InsightQuestionAnswerError(category, message)
}
