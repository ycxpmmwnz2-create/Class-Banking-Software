import { createHash } from 'node:crypto'

import { InsightIdentityError, validateInsightIdentity } from './identity.js'

const EVIDENCE_SCHEMA_VERSION = 1
const STUDENT_KEYS = Object.freeze(['balance', 'frozen', 'id', 'name', 'transactions'])
const TRANSACTION_KEYS = Object.freeze([
  'amount',
  'category',
  'date',
  'id',
  'memo',
  'reason',
  'source',
  'status',
  'studentId',
  'studentName',
  'type',
])
const PERIODS = Object.freeze([7, 30, 90])
const MAX_STUDENTS = 500
const MAX_TRANSACTIONS = 20_000
const MAX_REPORT_OBSERVATIONS = 20
const PSEUDONYMIZED_STUDENT_NAME = 'A student'
const UNSUPPORTED_LIVE_OBSERVATION_CATEGORIES = Object.freeze(new Set([
  'Timing patterns',
]))

export class TenantEvidenceAdapterError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'TenantEvidenceAdapterError'
    this.category = category
  }
}

export function createFirestoreTenantEvidenceLoader({
  firestore,
  calculateReport,
  now = () => new Date(),
}) {
  if (
    !firestore ||
    typeof firestore.collection !== 'function' ||
    typeof firestore.runTransaction !== 'function'
  ) {
    throw new TypeError('firestore with collection and runTransaction methods is required.')
  }
  if (typeof calculateReport !== 'function') {
    throw new TypeError('calculateReport must be a function.')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.')

  return async function loadDeidentifiedTenantEvidence({
    teacherUid,
    classroomId,
    periodDays,
  } = {}) {
    let teacher
    let classroom
    try {
      teacher = validateInsightIdentity(teacherUid, 'teacherUid')
      classroom = validateInsightIdentity(classroomId, 'classroomId')
    } catch (error) {
      if (error instanceof InsightIdentityError) fail('invalid-identity', error.message)
      throw error
    }
    if (!PERIODS.includes(periodDays)) {
      fail('invalid-period', 'The requested evidence period is unsupported.')
    }
    const generatedAt = requireDate(now())
    const teacherRef = firestore.collection('teachers').doc(teacher)
    const classroomRef = firestore.collection('classrooms').doc(classroom)

    const raw = await firestore.runTransaction(async transaction => {
      const teacherSnapshot = await transaction.get(teacherRef)
      const classroomSnapshot = await transaction.get(classroomRef)
      validateFoundation({
        teacherSnapshot,
        classroomSnapshot,
        teacherUid: teacher,
        classroomId: classroom,
      })
      const studentsSnapshot = await transaction.get(
        classroomRef.collection('students').limit(MAX_STUDENTS + 1),
      )
      const transactionsSnapshot = await transaction.get(
        classroomRef.collection('transactions').limit(MAX_TRANSACTIONS + 1),
      )
      if (studentsSnapshot.size > MAX_STUDENTS || transactionsSnapshot.size > MAX_TRANSACTIONS) {
        fail('evidence-too-large', 'Classroom evidence exceeds the bridge read limit.')
      }
      const students = studentsSnapshot.docs
        .map(validateStudentSnapshot)
        .sort((left, right) => left.id - right.id)
      const transactions = transactionsSnapshot.docs
        .map(validateTransactionSnapshot)
        .sort((left, right) => left.id - right.id)
      return Object.freeze({
        students: Object.freeze(students),
        transactions: Object.freeze(transactions),
      })
    })

    const cutoff = generatedAt.getTime() - periodDays * 24 * 60 * 60 * 1000
    const periodTransactions = raw.transactions.filter((transaction) => {
      const timestamp = Date.parse(transaction.date)
      return timestamp >= cutoff && timestamp <= generatedAt.getTime()
    })
    const pseudonymized = pseudonymizeEvidence(raw.students, periodTransactions)
    assertPseudonymizedStudentNames(pseudonymized)
    const providerReport = projectReport(calculateReport({
      students: pseudonymized.students,
      transactions: pseudonymized.transactions,
      days: periodDays,
      mode: 'deep',
      now: generatedAt,
    }))
    const displayReport = projectReport(calculateReport({
      students: raw.students,
      transactions: periodTransactions,
      days: periodDays,
      mode: 'deep',
      now: generatedAt,
    }))
    assertPairedReports(providerReport, displayReport)
    const sensitiveValues = declareSensitiveValues({
      teacherUid: teacher,
      classroomId: classroom,
      students: raw.students,
      transactions: periodTransactions,
    })
    const evidenceSignature = hashEvidence({
      teacherUid: teacher,
      classroomId: classroom,
      periodDays,
      students: raw.students,
      transactions: periodTransactions,
    })

    return Object.freeze({
      analysisEvidence: providerReport,
      displayEvidence: displayReport,
      sensitiveValues,
      evidenceSignature,
    })
  }
}

function validateFoundation({ teacherSnapshot, classroomSnapshot, teacherUid, classroomId }) {
  if (!teacherSnapshot?.exists || !classroomSnapshot?.exists) {
    fail('tenant-invalid', 'The active teacher foundation is incomplete.')
  }
  const teacher = teacherSnapshot.data()
  const classroom = classroomSnapshot.data()
  if (
    !isPlainObject(teacher) ||
    teacher.uid !== teacherUid ||
    teacher.status !== 'active' ||
    teacher.classroomId !== classroomId ||
    !isPlainObject(classroom) ||
    classroom.ownerUid !== teacherUid
  ) {
    fail('tenant-invalid', 'The active teacher foundation is inconsistent.')
  }
}

function validateStudentSnapshot(snapshot) {
  const value = snapshot?.data?.()
  if (!isPlainObject(value) || !hasExactKeys(value, STUDENT_KEYS)) {
    fail('evidence-malformed', 'A student record is malformed.')
  }
  const id = positiveSafeInteger(value.id, 'student id')
  if (snapshot.id !== String(id)) {
    fail('evidence-malformed', 'A student record path is inconsistent.')
  }
  const name = boundedString(value.name, 1, 120, 'student name')
  if (
    typeof value.balance !== 'number' ||
    !Number.isFinite(value.balance) ||
    typeof value.frozen !== 'boolean' ||
    !Array.isArray(value.transactions)
  ) {
    fail('evidence-malformed', 'A student record value is malformed.')
  }
  return Object.freeze({ id, name, balance: value.balance })
}

function validateTransactionSnapshot(snapshot) {
  const value = snapshot?.data?.()
  if (!isPlainObject(value) || !hasExactKeys(value, TRANSACTION_KEYS)) {
    fail('evidence-malformed', 'A transaction record is malformed.')
  }
  const id = positiveSafeInteger(value.id, 'transaction id')
  const studentId = positiveSafeInteger(value.studentId, 'transaction student id')
  if (snapshot.id !== String(id)) {
    fail('evidence-malformed', 'A transaction record path is inconsistent.')
  }
  const date = boundedString(value.date, 1, 40, 'transaction date')
  const parsedDate = new Date(date)
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString() !== date) {
    fail('evidence-malformed', 'A transaction date is not canonical ISO time.')
  }
  if (
    (value.type !== 'Add' && value.type !== 'Subtract') ||
    typeof value.amount !== 'number' ||
    !Number.isFinite(value.amount) ||
    value.amount <= 0 ||
    !['Pending', 'Approved', 'Denied'].includes(value.status)
  ) {
    fail('evidence-malformed', 'A transaction value is malformed.')
  }
  return Object.freeze({
    id,
    studentId,
    studentName: boundedString(value.studentName, 1, 120, 'transaction student name'),
    date,
    type: value.type,
    amount: value.amount,
    reason: boundedString(value.reason, 0, 320, 'transaction reason'),
    memo: boundedString(value.memo, 0, 320, 'transaction memo'),
    category: boundedString(value.category, 0, 120, 'transaction category'),
    status: value.status,
    source: boundedString(value.source, 0, 80, 'transaction source'),
  })
}

function pseudonymizeEvidence(students, transactions) {
  const identities = new Set(students.map(student => String(student.id)))
  for (const transaction of transactions) identities.add(String(transaction.studentId))
  const aliases = new Map(
    [...identities].sort(numericStringCompare).map((id, index) => [id, `anon-${index + 1}`]),
  )
  const reasonAliases = new Map()
  const reasonAlias = (reason) => {
    const key = reason.toLocaleLowerCase('en-US')
    if (!reasonAliases.has(key)) {
      reasonAliases.set(key, `Reason category ${reasonAliases.size + 1}`)
    }
    return reasonAliases.get(key)
  }
  return Object.freeze({
    students: Object.freeze(students.map(student => Object.freeze({
      id: aliases.get(String(student.id)),
      name: PSEUDONYMIZED_STUDENT_NAME,
      balance: student.balance,
    }))),
    transactions: Object.freeze(transactions.map((transaction, index) => Object.freeze({
      id: `txn-${index + 1}`,
      studentId: aliases.get(String(transaction.studentId)),
      studentName: PSEUDONYMIZED_STUDENT_NAME,
      date: transaction.date,
      type: transaction.type,
      amount: transaction.amount,
      reason: reasonAlias(transaction.reason),
      status: transaction.status,
      source: transaction.source,
    }))),
  })
}

function assertPseudonymizedStudentNames({ students, transactions }) {
  const hasRawStudentName = students.some(
    student => student.name !== PSEUDONYMIZED_STUDENT_NAME,
  )
  const hasRawTransactionStudentName = transactions.some(
    transaction => transaction.studentName !== PSEUDONYMIZED_STUDENT_NAME,
  )
  if (hasRawStudentName || hasRawTransactionStudentName) {
    fail('evidence-not-deidentified', 'Pseudonymized evidence contains a raw student name.')
  }
}

function projectReport(report) {
  if (!isPlainObject(report) || !isPlainObject(report.metrics) || !Array.isArray(report.observations)) {
    fail('calculator-invalid', 'The deterministic calculator returned malformed evidence.')
  }
  if (report.observations.length < 1 || report.observations.length > MAX_REPORT_OBSERVATIONS) {
    fail('calculator-invalid', 'The deterministic calculator returned an unsupported observation count.')
  }
  const metrics = {}
  for (const key of [
    'studentCount',
    'transactionCount',
    'approvedCount',
    'pendingCount',
    'totalClassCash',
  ]) {
    const value = report.metrics[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('calculator-invalid', 'A deterministic metric is malformed.')
    }
    metrics[key] = value
  }
  const observations = report.observations
    .filter(observation => !UNSUPPORTED_LIVE_OBSERVATION_CATEGORIES.has(observation?.category))
    .map((observation) => {
      if (!isPlainObject(observation) || !['attention', 'notable', 'context'].includes(observation.priority)) {
        fail('calculator-invalid', 'A deterministic observation is malformed.')
      }
      return Object.freeze({
        priority: observation.priority,
        category: boundedString(observation.category, 1, 60, 'observation category'),
        title: boundedString(observation.title, 1, 120, 'observation title'),
        summary: boundedString(observation.summary, 1, 320, 'observation summary'),
        evidence: Object.freeze([
          boundedString(observation.evidence, 1, 320, 'observation evidence'),
        ]),
      })
    })
  if (observations.length < 1) {
    fail('calculator-invalid', 'No observations remain inside the live provider evidence boundary.')
  }
  return Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generatedAt: requireIsoTimestamp(report.generatedAt),
    metrics: Object.freeze(metrics),
    observations: Object.freeze(observations),
  })
}

function declareSensitiveValues({ teacherUid, classroomId, students, transactions }) {
  const entries = []
  const seen = new Set()
  const add = (kind, value) => {
    const canonical = String(value)
    const key = `${kind}\u0000${canonical}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(Object.freeze({ kind, value: canonical }))
  }
  add('teacher-uid', teacherUid)
  add('classroom-id', classroomId)
  for (const student of students) {
    add('student-id', student.id)
    add('student-name', student.name)
  }
  for (const transaction of transactions) {
    add('student-id', transaction.studentId)
    add('student-name', transaction.studentName)
  }
  return Object.freeze(entries)
}

function hashEvidence(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function assertPairedReports(providerReport, displayReport) {
  if (
    providerReport.generatedAt !== displayReport.generatedAt ||
    JSON.stringify(providerReport.metrics) !== JSON.stringify(displayReport.metrics) ||
    providerReport.observations.length !== displayReport.observations.length
  ) {
    fail('calculator-invalid', 'Provider and display reports are not structurally aligned.')
  }
  for (let index = 0; index < providerReport.observations.length; index += 1) {
    const provider = providerReport.observations[index]
    const display = displayReport.observations[index]
    if (
      provider.priority !== display.priority ||
      provider.category !== display.category ||
      provider.title !== display.title
    ) {
      fail('calculator-invalid', 'Provider and display observations are not aligned.')
    }
  }
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('evidence-malformed', `${label} is malformed.`)
  }
  return value
}

function boundedString(value, minimum, maximum, label) {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    (minimum > 0 && value.trim() !== value)
  ) {
    fail('evidence-malformed', `${label} is malformed.`)
  }
  return value
}

function requireDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) fail('invalid-time', 'The server clock is invalid.')
  return date
}

function requireIsoTimestamp(value) {
  if (typeof value !== 'string') fail('calculator-invalid', 'The report time is malformed.')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail('calculator-invalid', 'The report time is malformed.')
  }
  return value
}

function numericStringCompare(left, right) {
  return Number(left) - Number(right)
}

function fail(category, message) {
  throw new TenantEvidenceAdapterError(category, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
}
