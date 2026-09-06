import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'

export const STRUCTURED_ANSWER_CONTRACT = 'structured-v1'
export const STRUCTURED_ANSWER_VIEWS = Object.freeze({
  get_balances: 'student-balances',
  find_students_without_transactions: 'students-without-transactions',
  list_transactions: 'transaction-list',
  aggregate_transactions: 'transaction-summary',
  get_balance_history: 'balance-history',
  compare_periods: 'period-comparison',
  describe_schema: 'capabilities',
  compare_student_earnings: 'student-earnings',
})

// Fixed internal vocabulary only: never put answer text, keys, IDs, or values
// from a rejected response into a diagnostic.
export const STRUCTURED_ANSWER_FAILURE_CODES = Object.freeze([
  'non-string', 'invalid-json', 'envelope-type', 'envelope-keys',
  'schema-version', 'sections-shape', 'section-type', 'section-keys',
  'result-id-type', 'duplicate-result', 'unknown-result', 'view-mismatch',
  'answer-too-large', 'render-value',
])

export class StructuredClassroomAnswerError extends Error {
  constructor(code = 'render-value') {
    super('The selected classroom result cannot be verified.')
    this.name = 'StructuredClassroomAnswerError'
    this.category = 'answer-unverified'
    this.diagnostic = Object.freeze({
      structuredAnswerCode: STRUCTURED_ANSWER_FAILURE_CODES.includes(code) ? code : 'render-value',
    })
  }
}

// Construct this once inside a single answer invocation, never on a shared
// assistant instance. The toolbox is already bound to the authenticated
// evidence snapshot. Neither caller nor provider can insert result objects.
export function createStructuredAnswerRegistry(toolbox) {
  const context = freezeCopy(toolbox.context)
  const prefix = randomBytes(16).toString('hex')
  const results = new Map()
  let callCount = 0
  return Object.freeze({
    execute(name, args = {}) {
      if (++callCount > 8) fail()
      const suppliedArgs = freezeCopy(args)
      const result = freezeCopy(toolbox.execute(name, suppliedArgs))
      if (result.ok !== true) return Object.freeze({ resultId: null, output: result })
      const view = STRUCTURED_ANSWER_VIEWS[name]
      if (!view) return Object.freeze({ resultId: null, output: result })
      const resultId = `${prefix}-${callCount}`
      const record = Object.freeze({
        name, result, context, args: normalizeArguments(name, suppliedArgs, result, context),
      })
      results.set(resultId, record)
      return Object.freeze({ resultId, view, output: result })
    },
    isEarningsSelection(selection) {
      return selection?.sections?.length === 1 && results.get(selection.sections[0].resultId)?.name === 'compare_student_earnings'
    },
    render(selection) {
      if (!isPlainObject(selection)) fail('envelope-type')
      if (!exactKeys(selection, ['schemaVersion', 'sections'])) fail('envelope-keys')
      if (selection.schemaVersion !== 1) fail('schema-version')
      if (!Array.isArray(selection.sections) || selection.sections.length < 1 || selection.sections.length > 8) fail('sections-shape')
      const seen = new Set()
      const sections = selection.sections.map(section => {
        if (!isPlainObject(section)) fail('section-type')
        if (!exactKeys(section, ['resultId', 'view'])) fail('section-keys')
        if (typeof section.resultId !== 'string') fail('result-id-type')
        if (seen.has(section.resultId)) fail('duplicate-result')
        seen.add(section.resultId)
        const record = results.get(section.resultId)
        if (!record) fail('unknown-result')
        if (section.view !== STRUCTURED_ANSWER_VIEWS[record.name]) fail('view-mismatch')
        return renderResult(record)
      })
      const answer = sections.map(section => section.answer).join('\n\n')
      // The usage ledger permits 64 KiB for the entire completed result.
      // Leave room for evidence and usage; never trim a factual sentence.
      if (Buffer.byteLength(answer, 'utf8') > 48 * 1024) fail('answer-too-large')
      return Object.freeze({ answer, evidence: Object.freeze(sections.map(section => section.evidence)) })
    },
  })
}

function normalizeArguments(name, args, result, context) {
  const studentRefs = [...new Set(args.studentRefs ?? [])]
  if (name === 'describe_schema' || name === 'compare_student_earnings') return Object.freeze({})
  if (name === 'get_balances') return freezeCopy({
    studentRefs, condition: args.condition ?? 'any', frozen: args.frozen ?? 'any',
    sort: args.sort ?? 'name', limit: args.limit ?? 100,
  })
  if (name === 'get_balance_history') return freezeCopy({
    studentRefs, startDate: result.startDate, endDate: result.endDate,
    limitDays: result.limitDays,
  })
  return freezeCopy({
    studentRefs,
    transactionType: args.transactionType ?? 'any', status: args.status ?? 'any',
    purpose: args.purpose ?? 'any', categoryContains: args.categoryContains?.toLocaleLowerCase('en-US') ?? null,
    minimumAmount: args.minimumAmount ?? null, maximumAmount: args.maximumAmount ?? null,
    startDate: result.windowStartDate, endDate: result.windowEndDate,
    // A missing start applies the exact rolling timestamp even when endDate
    // was explicit. It is not a whole-calendar-day window.
    rollingStart: args.startDate === undefined,
    defaultedWindow: args.startDate === undefined && args.endDate === undefined,
    selectedPeriodDays: context.selectedPeriodDays,
    sort: args.sort ?? (name === 'aggregate_transactions' ? 'highest' : name === 'list_transactions' ? 'newest' : 'name'),
    limit: args.limit ?? (name === 'aggregate_transactions' ? 20 : name === 'list_transactions' ? 50 : 25),
    includeMemos: args.includeMemos ?? false,
    groupBy: args.groupBy ?? [], metric: args.metric ?? null, minimumResult: args.minimumResult ?? null,
  })
}

function renderResult(record) {
  if (record.name === 'compare_student_earnings') return renderEarnings(record)
  if (record.name === 'get_balances') return renderBalances(record)
  if (record.name === 'find_students_without_transactions') return renderAbsence(record)
  if (record.name === 'list_transactions') return renderTransactions(record)
  if (record.name === 'aggregate_transactions') return renderAggregate(record)
  if (record.name === 'compare_periods') return renderComparison(record)
  if (record.name === 'get_balance_history') return renderHistory(record)
  return renderCapabilities(record)
}

function renderEarnings({ result, context }) {
  const names = refs => refs.map(ref => studentName(ref, context)).join(', ')
  let summary
  if (!result.complete) summary = 'I cannot determine who received the most or least money added because the retained history does not cover the full requested period.'
  else if (!result.currentStudentCount) summary = 'There are no current students to compare.'
  else if (result.allTied) summary = `Everyone is tied at ${money(result.highestAmount)} in approved money added per student.`
  else summary = `Most money added: ${names(result.highestRefs)} — ${money(result.highestAmount)} each. Least: ${names(result.lowestRefs)} — ${money(result.lowestAmount)} each.`
  return rendered([
    summary,
    `${result.windowStartDate} through ${result.windowEndDate} (${context.timeZone}).`,
    `Current classroom roster: ${result.currentStudentCount} students, including students with no approved money added.`,
    'Approved money added (USD), for any purpose. Subtractions are not deducted from these totals.',
    ...(result.rollingStart ? [`Exact rolling period begins at ${result.rollingStart}.`] : []),
    ...(result.throughSnapshot ? [`The last date is covered only through the snapshot on ${context.classroomDate}.`] : []),
    ...(!result.complete ? [`Retained history begins at ${context.retainedFrom}; full-period totals and rankings are unavailable.`] : []),
  ], 'Current-roster earnings comparison', context)
}

function renderTransactions({ args, result, context }) {
  const lines = [
    `${result.matchedCount} matching ${plural(result.matchedCount, 'transaction')} from ${result.distinctParticipantCount} ${plural(result.distinctParticipantCount, 'participant')} (${result.distinctCurrentStudentCount} current ${plural(result.distinctCurrentStudentCount, 'student')}).`,
    studentScope(args, context, false), transactionScope(args), dateScope(args, context),
    page(result, result.matchedCount, 'transactions', enumText(args.sort, { newest: 'newest first', oldest: 'oldest first' })),
  ]
  for (const row of result.transactions) {
    lines.push(`• ${studentName(row.studentRef, context)} — ${row.classroomDate}; ${enumText(row.type, { Add: 'add', Subtract: 'subtract' })} ${money(row.amount)}; category ${label(row.category)}; ${row.status}; purpose ${row.purpose}.`)
    if (args.includeMemos) {
      lines.push(`  Memo (redacted${row.memoTruncated ? ', truncated excerpt' : ''}): ${label(row.memo)}.`)
    }
  }
  return rendered(lines, 'Matching transaction records', context)
}

const METRIC_LABELS = Object.freeze({
  count: 'Transaction count', amountTotal: 'Total transaction amounts', amountAverage: 'Average transaction amount',
  amountMinimum: 'Smallest transaction amount', amountMaximum: 'Largest transaction amount', amountMedian: 'Median transaction amount',
  distinctStudents: 'Distinct participants (including former students)', distinctCurrentStudents: 'Distinct current students',
  distinctDays: 'Distinct classroom dates', distinctCategories: 'Distinct categories',
})
const GROUP_LABELS = Object.freeze({
  student: 'student', category: 'category', transactionType: 'transaction type', status: 'status',
  calendarDay: 'classroom date', dayOfWeek: 'day of week', timeOfDay: 'time of day', amount: 'amount', purpose: 'purpose',
})

function renderAggregate({ args, result, context }) {
  const metric = enumText(result.metric, METRIC_LABELS)
  const sort = enumText(args.sort, { highest: 'value, highest first', lowest: 'value, lowest first', alphabetical: 'group label', chronological: 'group key' })
  const lines = [
    `${metric}: ${result.groupBy.length === 0 && result.rows.length === 1 ? metricValue(result.metric, result.rows[0].value, result.rows[0].transactionCount) : `${result.resultCount} matching groups`}.`,
    studentScope(args, context, false), transactionScope(args), dateScope(args, context),
    `Calculated from ${result.matchedTransactionCount} matching transactions.`,
  ]
  if (result.metric.startsWith('amount')) lines.push('Amounts use recorded transaction amounts; adds and subtracts are not netted against each other.')
  if (args.minimumResult !== null) lines.push(`Only results with ${metric.toLowerCase()} at least ${metricValue(result.metric, args.minimumResult, 1)} are included.`)
  lines.push(page(result, result.resultCount, 'groups', sort))
  if (result.truncated && ['highest', 'lowest'].includes(args.sort)) lines.push('Ties may continue beyond this page; no unique winner is implied.')
  for (const row of result.rows) {
    const groups = Object.entries(row.group).map(([key, value]) => {
      if (key === 'student') {
        const student = context.students.find(item => item.name === value)
        if (!student) fail()
        return `student ${studentName(student.ref, context)}`
      }
      return `${enumText(key, GROUP_LABELS)} ${key === 'amount' ? money(value) : label(value)}`
    })
    lines.push(`• ${groups.join('; ') || 'All matching records'} — ${metricValue(result.metric, row.value, row.transactionCount)} (${row.transactionCount} transactions).`)
  }
  return rendered(lines, metric, context)
}

function renderComparison({ args, result, context }) {
  const metric = enumText(result.metric, METRIC_LABELS)
  const lines = [metric + ' by period.', studentScope(args, context, false), transactionScope(args)]
  for (const [index, period] of result.periods.entries()) {
    lines.push(`Period ${index + 1}: ${period.startDate} through ${period.endDate} (${context.timeZone}) — ${metricValue(result.metric, period.value, period.transactionCount)} (${period.transactionCount} transactions).`)
  }
  const nonemptyRequired = isEmptyStatistic(result.metric) && result.periods.some(period => period.transactionCount === 0)
  lines.push(`Second minus first: ${nonemptyRequired ? 'unavailable' : metricValue(result.metric, result.difference, 1)}.`)
  lines.push(`Percent change: ${nonemptyRequired || result.percentChange === null ? 'unavailable' : `${result.percentChange}%`}.`)
  if (result.metric.startsWith('amount')) lines.push('Amounts use recorded transaction amounts; adds and subtracts are not netted against each other.')
  return rendered(lines, 'Period comparison', context)
}

function renderHistory({ args, result, context }) {
  if (!Number.isInteger(args.limitDays) || args.limitDays < 1 || args.limitDays > 90) fail()
  const dates = [...new Set(result.rows.map(row => row.date))].sort()
  const totalDates = Math.round((Date.parse(args.endDate) - Date.parse(args.startDate)) / 86_400_000) + 1
  const lines = [
    'Reconstructed balances from current balances and retained Approved transactions.',
    studentScope(args, context, false),
    `Requested dates: ${args.startDate} through ${args.endDate} (${context.timeZone}).`,
    `Showing ${dates.length} of ${totalDates} requested dates, up to the latest ${args.limitDays} dates per available student.`,
    `Today's value reflects the snapshot on ${context.classroomDate}, not a future end-of-day balance.`,
  ]
  for (const ref of args.studentRefs) {
    if (!result.rows.some(row => row.studentRef === ref)) lines.push(`Balance history unavailable for ${studentName(ref, context)}.`)
  }
  for (const row of result.rows) lines.push(`• ${studentName(row.studentRef, context)} — ${row.date}: ${money(row.closingBalance)}.`)
  return rendered(lines, 'Balance reconstruction', context)
}

function renderCapabilities({ context }) {
  return rendered([
    'I can check balances, frozen accounts, transaction totals and lists, rent-payment records, date comparisons, and reconstructed balance history.',
    'For a more specific answer, include the student display name, transaction status, category, or dates you mean.',
    'I can show redacted memos on selected transactions. Searching or filtering by memo text is unavailable, including within the selected period.',
    'Predicting behavior, changing accounts, and accessing other classrooms are unavailable.',
    `Available recorded history: ${context.availableDateRange.start} through ${context.availableDateRange.end} (${context.timeZone}); records begin at ${context.retainedFrom}.`,
  ], 'Available read-only capabilities', context)
}

function isEmptyStatistic(metric) {
  return ['amountAverage', 'amountMinimum', 'amountMaximum', 'amountMedian'].includes(metric)
}

function metricValue(metric, value, transactionCount) {
  if (transactionCount === 0 && isEmptyStatistic(metric)) return 'unavailable (no matching transactions)'
  if (metric.startsWith('amount')) return money(value)
  if (!Number.isFinite(value)) fail()
  return String(value)
}

function renderBalances({ args, result, context }) {
  const condition = enumText(args.condition, {
    any: 'any balance', positive: 'positive balances', negative: 'negative balances',
    zero: 'zero balances', nonpositive: 'zero or negative balances',
  })
  const frozen = enumText(args.frozen, { any: 'any account status', frozen: 'frozen accounts', unfrozen: 'unfrozen accounts' })
  const sort = enumText(args.sort, { name: 'name', lowest: 'balance, lowest first', highest: 'balance, highest first' })
  const lines = [
    `${result.matchedCount} current ${plural(result.matchedCount, 'student')} ${result.matchedCount === 1 ? 'matches' : 'match'}: ${condition}; ${frozen}.`,
    studentScope(args, context, true),
    `Balances as of ${context.classroomDate} (${context.timeZone}).`,
    page(result, result.matchedCount, 'students', sort),
  ]
  if (args.sort !== 'name' && result.truncated) lines.push('Ties may continue beyond this page; no unique winner is implied.')
  // These full-population summaries are nullable when any selected balance
  // is unknown. Never derive a total from the displayed page.
  lines.push(`Total balance: ${money(result.totalBalance)}. Average: ${money(result.averageBalance)}.`)
  lines.push(...result.students.map(row => studentBalanceRow(row, context)))
  return rendered(lines, 'Current balances', context)
}

function renderAbsence({ args, result, context }) {
  const sort = enumText(args.sort, { name: 'name', lowestBalance: 'balance, lowest first', highestBalance: 'balance, highest first' })
  const lines = [
    `${result.studentsWithoutCount} of ${result.consideredStudentCount} considered current ${plural(result.consideredStudentCount, 'student')} ${result.studentsWithoutCount === 1 ? 'has' : 'have'} no matching transactions.`,
    studentScope(args, context, true),
    transactionScope(args, context),
    dateScope(args, context),
    page(result, result.studentsWithoutCount, 'students', sort),
    ...result.students.map(row => studentBalanceRow(row, context)),
  ]
  return rendered(lines, 'Students without matching transactions', context)
}

function studentScope(args, context, currentOnly) {
  if (args.studentRefs.length === 0) return currentOnly
    ? 'Population: current classroom roster.'
    : 'Population: all recorded participants, including former students.'
  return `Selected students${currentOnly ? ' (current roster only)' : ''}: ${args.studentRefs.map(ref => studentName(ref, context)).join(', ')}.`
}

function transactionScope(args) {
  const status = enumText(args.status, { any: 'any status (Approved, Pending, Denied)', Approved: 'Approved', Pending: 'Pending', Denied: 'Denied' })
  const type = enumText(args.transactionType, { any: 'adds and subtracts', Add: 'adds', Subtract: 'subtracts' })
  const purpose = enumText(args.purpose, { any: 'any purpose', rent: 'rent', other: 'other purposes' })
  const parts = [`Filters: ${status}; ${type}; ${purpose}`]
  if (args.categoryContains !== null) parts.push(`category contains ${label(args.categoryContains)} (case-insensitive)`)
  if (args.minimumAmount !== null) parts.push(`amount at least ${money(args.minimumAmount)}`)
  if (args.maximumAmount !== null) parts.push(`amount at most ${money(args.maximumAmount)}`)
  return `${parts.join('; ')}.`
}

function dateScope(args, context) {
  const window = `Dates: ${args.startDate} through ${args.endDate} (${context.timeZone})`
  return args.rollingStart
    ? `${window}; starts at the selected ${args.selectedPeriodDays}-day rolling cutoff (${context.selectedPeriodStart}).`
    : `${window}; calendar-date filter within retained history (records begin at ${context.retainedFrom}).`
}

function studentBalanceRow(row, context) {
  const frozen = row.frozen === null ? 'status unavailable' : row.frozen ? 'frozen' : 'unfrozen'
  return `• ${studentName(row.studentRef, context)} — ${money(row.currentBalance)}; ${frozen}.`
}

function studentName(ref, context) {
  const student = context.students.find(item => item.ref === ref)
  if (!student) fail()
  return `${label(student.name)}${student.current ? '' : ' (former student)'}`
}

function page(result, total, noun, sort) {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(result.returnedCount) ||
    result.returnedCount < 0 || result.returnedCount > total || result.truncated !== (result.returnedCount < total)) fail()
  return `Showing ${result.returnedCount} of ${total} ${noun}; sorted by ${sort}.`
}

function rendered(lines, description, context) {
  return { answer: lines.join('\n'), evidence: `${description}; one classroom snapshot, ${context.classroomDate} (${context.timeZone}).` }
}

function money(value) {
  if (value === null) return 'unavailable'
  if (!Number.isFinite(value)) fail()
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

function plural(count, singular) { return count === 1 ? singular : `${singular}s` }

// Quoted data never becomes a heading, markup, or a factual template. The
// existing client renders plain text. Escape newlines and direction controls
// so a category/memo cannot visually impersonate an additional answer line.
function label(value) {
  if (typeof value !== 'string') fail()
  return JSON.stringify(value).replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function enumText(value, catalog) {
  if (!Object.hasOwn(catalog, value)) fail()
  return catalog[value]
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function freezeCopy(value) {
  const copy = globalThis.structuredClone(value)
  function freeze(item) {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze)
      Object.freeze(item)
    }
    return item
  }
  return freeze(copy)
}

function fail(code) { throw new StructuredClassroomAnswerError(code) }
