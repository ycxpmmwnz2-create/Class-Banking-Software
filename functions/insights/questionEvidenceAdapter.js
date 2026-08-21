import { createHash } from 'node:crypto'

import { INSIGHT_QUESTION_SCHEMA_VERSION } from './questionContracts.js'
import { InsightIdentityError, validateInsightIdentity } from './identity.js'

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
const MAX_STUDENTS = 500
const MAX_TRANSACTIONS = 20_000
const EMAIL_OR_URL_PATTERN = /(?:\bhttps?:\/\/|\bwww\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{7,}\d)/

export class InsightQuestionEvidenceError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'InsightQuestionEvidenceError'
    this.category = category
  }
}

export function createFirestoreQuestionEvidenceLoader({
  firestore,
  now = () => new Date(),
} = {}) {
  if (
    !firestore ||
    typeof firestore.collection !== 'function' ||
    typeof firestore.runTransaction !== 'function'
  ) {
    throw new TypeError('firestore with collection and runTransaction methods is required.')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.')

  return async function loadQuestionEvidence({
    teacherUid,
    classroomId,
    periodDays,
    timeZone,
    question,
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
    if (![7, 30, 90].includes(periodDays)) fail('invalid-period', 'The question period is unsupported.')
    if (EMAIL_OR_URL_PATTERN.test(question) || PHONE_PATTERN.test(question)) {
      fail('question-sensitive', 'Remove email addresses, links, and phone numbers before asking.')
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
        fail('evidence-too-large', 'Classroom evidence exceeds the question read limit.')
      }
      return Object.freeze({
        students: Object.freeze(studentsSnapshot.docs.map(validateStudentSnapshot)
          .sort((left, right) => left.id - right.id)),
        transactions: Object.freeze(transactionsSnapshot.docs.map(validateTransactionSnapshot)
          .sort((left, right) => left.id - right.id)),
      })
    })

    const aliasesByStudentId = new Map(raw.students.map((student, index) => (
      [student.id, `student-${String(index + 1).padStart(3, '0')}`]
    )))
    const mentionedStudentIds = resolveMentionedStudents(question, raw.students)
    if (mentionedStudentIds.length > 1) {
      fail('question-ambiguous', 'Ask about one student at a time and use the student’s full name.')
    }
    const mentionedAliases = mentionedStudentIds.map(id => aliasesByStudentId.get(id))
    const sanitizedQuestion = sanitizeQuestion({
      question,
      students: raw.students,
      aliasesByStudentId,
      mentionedStudentIds,
    })
    assertNoRosterNameLeak(sanitizedQuestion, raw.students)

    const cutoff = generatedAt.getTime() - periodDays * 24 * 60 * 60 * 1000
    const periodTransactions = raw.transactions.filter(transaction => {
      const timestamp = Date.parse(transaction.date)
      return timestamp >= cutoff && timestamp <= generatedAt.getTime()
    })
    const answerEvidence = Object.freeze({
      students: Object.freeze(raw.students.map(student => Object.freeze({
        id: student.id,
        alias: aliasesByStudentId.get(student.id),
        name: student.name,
        balance: student.balance,
      }))),
      transactions: Object.freeze(periodTransactions.map(transaction => Object.freeze({
        id: transaction.id,
        studentId: transaction.studentId,
        date: transaction.date,
        type: transaction.type,
        amount: transaction.amount,
        category: normalizeDisplayCategory(transaction.category || transaction.reason),
        status: transaction.status,
      }))),
      periodDays,
      timeZone,
    })
    const providerInput = Object.freeze({
      schemaVersion: INSIGHT_QUESTION_SCHEMA_VERSION,
      question: sanitizedQuestion,
      subjectAliases: Object.freeze(mentionedAliases),
      periodDays,
    })
    return Object.freeze({
      generatedAt: generatedAt.toISOString(),
      providerInput,
      answerEvidence,
      allowedAliases: Object.freeze(mentionedAliases),
      sensitiveValues: Object.freeze([
        Object.freeze({ kind: 'teacher-uid', value: teacher }),
        Object.freeze({ kind: 'classroom-id', value: classroom }),
        ...raw.students.flatMap(student => [
          Object.freeze({ kind: 'student-id', value: String(student.id) }),
          Object.freeze({ kind: 'student-name', value: student.name }),
        ]),
      ]),
      evidenceSignature: createHash('sha256').update(JSON.stringify({
        teacherUid: teacher,
        classroomId: classroom,
        question,
        periodDays,
        timeZone,
        students: raw.students,
        transactions: periodTransactions,
      })).digest('hex'),
    })
  }
}

function resolveMentionedStudents(question, students) {
  const normalizedQuestion = normalize(question)
  const fullMatches = students.filter(student => (
    containsPhrase(normalizedQuestion, normalize(student.name))
  ))
  if (fullMatches.length) return fullMatches.map(student => student.id)

  const questionTokens = new Set(tokens(question))
  const tokenOwners = new Map()
  for (const student of students) {
    for (const token of new Set(tokens(student.name).filter(value => value.length >= 3))) {
      if (!tokenOwners.has(token)) tokenOwners.set(token, new Set())
      tokenOwners.get(token).add(student.id)
    }
  }
  const matches = new Set()
  for (const token of questionTokens) {
    const owners = tokenOwners.get(token)
    if (owners?.size === 1) matches.add([...owners][0])
    if (owners?.size > 1) {
      fail('question-ambiguous', 'Use the student’s full name so Morgan Bank can identify one account.')
    }
  }
  return [...matches]
}

function sanitizeQuestion({ question, students, aliasesByStudentId, mentionedStudentIds }) {
  let result = question
  const placeholders = new Map()
  const mentioned = new Set(mentionedStudentIds)
  for (const student of [...students].sort((a, b) => b.name.length - a.name.length)) {
    const placeholder = mentioned.has(student.id)
      ? `MBOPAQUEALIAS${String(student.id).padStart(6, '0')}`
      : 'MBREDACTEDSTUDENT'
    if (mentioned.has(student.id)) placeholders.set(placeholder, aliasesByStudentId.get(student.id))
    result = result.replace(new RegExp(escapeRegExp(student.name), 'giu'), placeholder)
  }
  const tokenOwners = new Map()
  for (const student of students) {
    for (const token of new Set(tokens(student.name).filter(value => value.length >= 2))) {
      if (!tokenOwners.has(token)) tokenOwners.set(token, new Set())
      tokenOwners.get(token).add(student.id)
    }
  }
  const nameTokens = [...tokenOwners.keys()].sort((left, right) => right.length - left.length)
  for (const token of nameTokens) {
    const owners = [...tokenOwners.get(token)]
    const replacement = owners.length === 1 && mentioned.has(owners[0])
      ? `MBOPAQUEALIAS${String(owners[0]).padStart(6, '0')}`
      : 'MBREDACTEDSTUDENT'
    result = result.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(token)}(?=$|[^\\p{L}\\p{N}])`, 'giu'),
      `$1${replacement}`,
    )
  }
  result = result.replaceAll('MBREDACTEDSTUDENT', '[student]')
  for (const [placeholder, alias] of placeholders) result = result.replaceAll(placeholder, `[${alias}]`)
  return result.replace(/\s+/g, ' ').trim()
}

function assertNoRosterNameLeak(question, students) {
  const normalizedQuestion = normalize(question)
  const collapsedQuestion = collapseSensitiveText(
    question.replace(/\[student(?:-[0-9]{3})?\]/giu, ''),
  )
  for (const student of students) {
    if (containsPhrase(normalizedQuestion, normalize(student.name))) {
      fail('evidence-not-deidentified', 'The sanitized question contains a student name.')
    }
    const nameTokens = tokens(student.name)
    for (const token of nameTokens.filter(value => value.length >= 2)) {
      if (tokens(question).includes(token)) {
        fail('evidence-not-deidentified', 'The sanitized question contains a student name token.')
      }
    }
    const collapsedSensitiveValues = [
      collapseSensitiveText(student.name),
      ...nameTokens
        .map(collapseSensitiveText)
        .filter(value => value.length >= 4),
    ].filter(Boolean)
    if (collapsedSensitiveValues.some(value => collapsedQuestion.includes(value))) {
      fail('evidence-not-deidentified', 'The sanitized question contains an obscured student name.')
    }
  }
}

function validateFoundation({ teacherSnapshot, classroomSnapshot, teacherUid, classroomId }) {
  if (!teacherSnapshot?.exists || !classroomSnapshot?.exists) fail('tenant-invalid', 'The teacher tenant is incomplete.')
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
    fail('tenant-invalid', 'The teacher tenant is inconsistent.')
  }
}

function validateStudentSnapshot(snapshot) {
  const value = snapshot?.data?.()
  if (!isPlainObject(value) || !hasExactKeys(value, STUDENT_KEYS)) fail('evidence-malformed', 'A student record is malformed.')
  const id = positiveInteger(value.id, 'student id')
  if (snapshot.id !== String(id) || typeof value.balance !== 'number' || !Number.isFinite(value.balance)) {
    fail('evidence-malformed', 'A student record is malformed.')
  }
  return Object.freeze({ id, name: boundedString(value.name, 1, 120, 'student name'), balance: value.balance })
}

function validateTransactionSnapshot(snapshot) {
  const value = snapshot?.data?.()
  if (!isPlainObject(value) || !hasExactKeys(value, TRANSACTION_KEYS)) fail('evidence-malformed', 'A transaction record is malformed.')
  const id = positiveInteger(value.id, 'transaction id')
  const studentId = positiveInteger(value.studentId, 'transaction student id')
  const parsedDate = new Date(value.date)
  if (
    snapshot.id !== String(id) ||
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString() !== value.date ||
    !['Add', 'Subtract'].includes(value.type) ||
    !['Pending', 'Approved', 'Denied'].includes(value.status) ||
    typeof value.amount !== 'number' ||
    !Number.isFinite(value.amount) ||
    value.amount <= 0
  ) {
    fail('evidence-malformed', 'A transaction record is malformed.')
  }
  return Object.freeze({
    id,
    studentId,
    date: value.date,
    type: value.type,
    amount: value.amount,
    category: boundedString(value.category, 0, 120, 'category'),
    reason: boundedString(value.reason, 0, 320, 'reason'),
    status: value.status,
  })
}

function tokens(value) {
  return normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function normalize(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('en-US')
}

function collapseSensitiveText(value) {
  return normalize(value).replace(/[^\p{L}\p{N}]/gu, '')
}

function containsPhrase(haystack, needle) {
  if (!needle) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(haystack)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function boundedString(value, minimum, maximum, label) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    fail('evidence-malformed', `${label} is malformed.`)
  }
  return value
}

function normalizeDisplayCategory(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 120) : 'Uncategorized'
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('evidence-malformed', `${label} is malformed.`)
  return value
}

function requireDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) fail('invalid-time', 'The server clock is invalid.')
  return date
}

function fail(category, message) {
  throw new InsightQuestionEvidenceError(category, message)
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
