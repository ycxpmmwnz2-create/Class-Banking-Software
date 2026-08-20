const TIME_BUCKETS = Object.freeze([
  Object.freeze({ id: 'morning', label: 'morning (5:00 AM–11:59 AM)', matches: hour => hour >= 5 && hour < 12 }),
  Object.freeze({ id: 'afternoon', label: 'afternoon (12:00 PM–4:59 PM)', matches: hour => hour >= 12 && hour < 17 }),
  Object.freeze({ id: 'evening', label: 'evening (5:00 PM–8:59 PM)', matches: hour => hour >= 17 && hour < 21 }),
  Object.freeze({ id: 'night', label: 'night (9:00 PM–4:59 AM)', matches: hour => hour >= 21 || hour < 5 }),
])

export class InsightQuestionAnswerError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightQuestionAnswerError'
    this.category = category
  }
}

export function calculateQuestionAnswer({ intent, subjectAlias, evidence } = {}) {
  validateEvidence(evidence)
  const subject = subjectAlias === null
    ? null
    : evidence.students.find(student => student.alias === subjectAlias)
  if (subjectAlias !== null && !subject) fail('answer-unavailable', 'The selected student is unavailable.')

  const approved = evidence.transactions.filter(transaction => transaction.status === 'Approved')
  const subjectApproved = subject
    ? approved.filter(transaction => transaction.studentId === subject.id)
    : approved
  const periodLabel = `the last ${evidence.periodDays} days`

  switch (intent) {
    case 'student-top-earning-category':
      return categoryAnswer(subject, subjectApproved, 'Add', periodLabel)
    case 'student-top-spending-category':
      return categoryAnswer(subject, subjectApproved, 'Subtract', periodLabel)
    case 'class-top-earning-category':
      return categoryAnswer(null, approved, 'Add', periodLabel)
    case 'class-top-spending-category':
      return categoryAnswer(null, approved, 'Subtract', periodLabel)
    case 'student-peak-earning-time':
      return timeAnswer(subject, subjectApproved, 'Add', periodLabel, evidence.timeZone)
    case 'student-peak-spending-time':
      return timeAnswer(subject, subjectApproved, 'Subtract', periodLabel, evidence.timeZone)
    case 'class-peak-earning-time':
      return timeAnswer(null, approved, 'Add', periodLabel, evidence.timeZone)
    case 'class-peak-spending-time':
      return timeAnswer(null, approved, 'Subtract', periodLabel, evidence.timeZone)
    case 'student-current-balance':
      return answer(
        `${subject.name}’s current balance is ${money(subject.balance)}.`,
        [`Current classroom balance for ${subject.name}: ${money(subject.balance)}.`],
      )
    case 'highest-current-balance':
      return balanceExtremeAnswer(evidence.students, 'highest')
    case 'lowest-current-balance':
      return balanceExtremeAnswer(evidence.students, 'lowest')
    case 'student-total-earned':
      return totalAnswer(subject, subjectApproved, 'Add', periodLabel)
    case 'student-total-spent':
      return totalAnswer(subject, subjectApproved, 'Subtract', periodLabel)
    case 'student-net-change':
      return netAnswer(subject, subjectApproved, periodLabel)
    case 'class-total-earned':
      return totalAnswer(null, approved, 'Add', periodLabel)
    case 'class-total-spent':
      return totalAnswer(null, approved, 'Subtract', periodLabel)
    case 'class-net-change':
      return netAnswer(null, approved, periodLabel)
    case 'pending-request-count': {
      const pending = evidence.transactions.filter(transaction => transaction.status === 'Pending')
      const total = sum(pending)
      return answer(
        `There ${pending.length === 1 ? 'is' : 'are'} ${pending.length} pending ${pending.length === 1 ? 'request' : 'requests'} in ${periodLabel}, totaling ${money(total)}.`,
        [`Pending requests: ${pending.length}.`, `Pending amount: ${money(total)}.`],
      )
    }
    case 'unsupported':
      return answer(
        'I can answer factual questions about balances, totals, categories, pending requests, and transaction times, but the available records do not support that question.',
        ['No factual answer was generated beyond the supported Morgan Bank records.'],
      )
    default:
      fail('answer-unavailable', 'The interpreted question is unsupported.')
  }
}

function categoryAnswer(subject, transactions, type, periodLabel) {
  const matching = transactions.filter(transaction => transaction.type === type)
  const action = type === 'Add' ? 'earning' : 'spending'
  const owner = subject ? subject.name : 'The class'
  if (!matching.length) {
    return answer(
      `${owner} has no approved ${action} transactions in ${periodLabel}.`,
      [`Approved ${action} transactions: 0.`],
    )
  }
  const totals = aggregate(matching, transaction => transaction.category)
  const winner = ranked(totals)[0]
  return answer(
    `${owner} ${subject ? 'is' : 'is'} ${action} the most money in “${winner.key}” during ${periodLabel}: ${money(winner.amount)}.`,
    [
      `${winner.key}: ${money(winner.amount)} across ${winner.count} approved ${winner.count === 1 ? 'transaction' : 'transactions'}.`,
      `Compared ${matching.length} approved ${action} ${matching.length === 1 ? 'transaction' : 'transactions'}.`,
    ],
  )
}

function timeAnswer(subject, transactions, type, periodLabel, timeZone) {
  const matching = transactions.filter(transaction => transaction.type === type)
  const action = type === 'Add' ? 'earning' : 'spending'
  const owner = subject ? subject.name : 'Students'
  if (!matching.length) {
    return answer(
      `${owner} had no approved ${action} transactions in ${periodLabel}.`,
      [`Approved ${action} transactions: 0.`],
    )
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
  const totals = aggregate(matching, transaction => {
    const hour = Number(formatter.formatToParts(new Date(transaction.date))
      .find(part => part.type === 'hour')?.value)
    return TIME_BUCKETS.find(bucket => bucket.matches(hour))?.id || 'night'
  })
  const winner = ranked(totals)[0]
  const bucket = TIME_BUCKETS.find(candidate => candidate.id === winner.key)
  return answer(
    `${owner} ${subject ? 'is' : 'are'} ${action} the most money during the ${bucket.label} in ${timeZone}: ${money(winner.amount)} in ${periodLabel}.`,
    [
      `${bucket.label}: ${money(winner.amount)} across ${winner.count} approved ${winner.count === 1 ? 'transaction' : 'transactions'}.`,
      `Times were grouped using ${timeZone}.`,
    ],
  )
}

function totalAnswer(subject, transactions, type, periodLabel) {
  const matching = transactions.filter(transaction => transaction.type === type)
  const total = sum(matching)
  const action = type === 'Add' ? 'earned' : 'spent'
  const owner = subject ? subject.name : 'The class'
  return answer(
    `${owner} ${action} ${money(total)} in ${periodLabel}.`,
    [`${matching.length} approved ${matching.length === 1 ? 'transaction' : 'transactions'} totaling ${money(total)}.`],
  )
}

function netAnswer(subject, transactions, periodLabel) {
  const earned = sum(transactions.filter(transaction => transaction.type === 'Add'))
  const spent = sum(transactions.filter(transaction => transaction.type === 'Subtract'))
  const net = earned - spent
  const owner = subject ? subject.name : 'The class'
  return answer(
    `${owner} had a net ${net >= 0 ? 'gain' : 'loss'} of ${money(Math.abs(net))} in ${periodLabel}.`,
    [`Approved earnings: ${money(earned)}.`, `Approved spending: ${money(spent)}.`],
  )
}

function balanceExtremeAnswer(students, direction) {
  if (!students.length) return answer('There are no students in this classroom.', ['Student count: 0.'])
  const sorted = [...students].sort((left, right) => (
    direction === 'highest' ? right.balance - left.balance : left.balance - right.balance
  ) || left.name.localeCompare(right.name, 'en-US'))
  const selected = sorted[0]
  return answer(
    `${selected.name} has the ${direction} current balance at ${money(selected.balance)}.`,
    [`${direction === 'highest' ? 'Highest' : 'Lowest'} current classroom balance: ${money(selected.balance)}.`],
  )
}

function aggregate(transactions, keyFor) {
  const values = new Map()
  for (const transaction of transactions) {
    const key = keyFor(transaction)
    const current = values.get(key) || { key, amount: 0, count: 0 }
    current.amount += transaction.amount
    current.count += 1
    values.set(key, current)
  }
  return values
}

function ranked(values) {
  return [...values.values()].sort((left, right) => (
    right.amount - left.amount || right.count - left.count || left.key.localeCompare(right.key, 'en-US')
  ))
}

function sum(transactions) {
  return transactions.reduce((total, transaction) => total + transaction.amount, 0)
}

function money(value) {
  return Number(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function answer(text, evidence) {
  return Object.freeze({ answer: text, evidence: Object.freeze(evidence) })
}

function validateEvidence(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.students) ||
    !Array.isArray(value.transactions) ||
    ![7, 30, 90].includes(value.periodDays) ||
    typeof value.timeZone !== 'string'
  ) {
    fail('answer-unavailable', 'The server answer evidence is malformed.')
  }
}

function fail(category, message) {
  throw new InsightQuestionAnswerError(category, message)
}
