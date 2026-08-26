import { createHash } from 'node:crypto'

import { INSIGHT_QUERY_PLAN_SCHEMA_VERSION } from './questionContracts.js'
import { InsightIdentityError, validateInsightIdentity } from './identity.js'
import { normalizeStoredTransactionDate } from './storedTransactionDate.js'

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
const RENT_KEYS = Object.freeze(['rentAmount', 'updatedAt'])
const MAX_STUDENTS = 500
const MAX_TRANSACTIONS = 20_000
const MAX_CATEGORIES = 128
const MAX_RENT_AMOUNT = 1_000_000
const EMAIL_OR_URL_PATTERN = /(?:\bhttps?:\/\/|\bwww\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{7,}\d)/
const RESERVED_PLACEHOLDER_PATTERN = /\[\s*(?:student|category)/iu

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
    if (
      EMAIL_OR_URL_PATTERN.test(question) ||
      PHONE_PATTERN.test(question) ||
      RESERVED_PLACEHOLDER_PATTERN.test(question)
    ) {
      fail(
        'question-sensitive',
        'Remove email addresses, links, phone numbers, and bracketed student or category placeholders before asking.',
      )
    }
    const generatedAt = requireDate(now())
    const asOfDate = localDateKey(generatedAt, timeZone)
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
      const rentSnapshot = await transaction.get(
        classroomRef.collection('studentDisplay').doc('rent'),
      )
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
        configuredRentAmount: validateRentSnapshot(rentSnapshot),
        students: Object.freeze(studentsSnapshot.docs.map(validateStudentSnapshot)
          .sort((left, right) => left.id - right.id)),
        transactions: Object.freeze(transactionsSnapshot.docs.map(snapshot => (
          validateTransactionSnapshot(snapshot, timeZone)
        ))
          .sort((left, right) => left.id - right.id)),
      })
    })

    const cutoff = generatedAt.getTime() - periodDays * 24 * 60 * 60 * 1000
    const historyCutoff = generatedAt.getTime() - 90 * 24 * 60 * 60 * 1000
    const periodStart = new Date(cutoff).toISOString()
    const generatedAtTime = generatedAt.getTime()
    const availableTransactions = raw.transactions.filter(transaction => {
      const timestamp = Date.parse(transaction.date)
      return timestamp <= generatedAtTime && timestamp >= historyCutoff
    })
    const participants = buildParticipants(raw.students, availableTransactions)
    const studentIdentities = buildStudentIdentities(raw.students, availableTransactions)
    const aliasesByStudentId = new Map(participants.map((student, index) => (
      [student.id, `student-${String(index + 1).padStart(3, '0')}`]
    )))
    const categoryCatalog = buildCategoryCatalog(availableTransactions, studentIdentities)
    const resolvedSubjects = resolveMentionedStudents(
      question,
      studentIdentities,
      categoryCatalog,
    )
    const subjectStudentIds = [...new Set([
      ...resolvedSubjects.directStudentIds,
      ...resolvedSubjects.subjectHints.map(hint => hint.studentId),
    ])].sort((left, right) => left - right)
    if (subjectStudentIds.length > 8 || resolvedSubjects.subjectHints.length > 8) {
      fail('question-ambiguous', 'Ask about no more than eight named students at a time.')
    }
    const mentionedAliases = subjectStudentIds.map(id => aliasesByStudentId.get(id))
    const sanitizedQuestion = sanitizeQuestion({
      question,
      students: studentIdentities,
      aliasesByStudentId,
      mentionedStudentIds: resolvedSubjects.directStudentIds,
    })
    assertNoRosterNameLeak(sanitizedQuestion, studentIdentities)

    const categoryAliasByKey = new Map(categoryCatalog.map(category => [category.key, category.alias]))
    const answerEvidence = Object.freeze({
      configuredRentAmount: raw.configuredRentAmount,
      participants: Object.freeze(participants.map(student => Object.freeze({
        id: student.id,
        alias: aliasesByStudentId.get(student.id),
        name: student.name,
      }))),
      students: Object.freeze(raw.students.map(student => Object.freeze({
        id: student.id,
        alias: aliasesByStudentId.get(student.id),
        name: student.name,
        balance: student.balance,
        frozen: student.frozen,
      }))),
      categories: Object.freeze(categoryCatalog.map(category => Object.freeze({
        alias: category.alias,
        label: category.label,
      }))),
      transactions: Object.freeze(availableTransactions.map(transaction => Object.freeze({
        id: transaction.id,
        studentId: transaction.studentId,
        date: transaction.date,
        type: transaction.type,
        amount: transaction.amount,
        categoryAlias: categoryAliasByKey.get(categoryKey(transaction.category)),
        purpose: transactionPurpose(transaction),
        status: transaction.status,
      }))),
      periodDays,
      periodStart,
      generatedAt: generatedAt.toISOString(),
      timeZone,
      asOfDate,
    })
    const providerInput = Object.freeze({
      schemaVersion: INSIGHT_QUERY_PLAN_SCHEMA_VERSION,
      question: sanitizedQuestion,
      subjectAliases: Object.freeze(mentionedAliases),
      subjectHints: Object.freeze(resolvedSubjects.subjectHints.map(hint => Object.freeze({
        text: hint.text,
        studentAlias: aliasesByStudentId.get(hint.studentId),
      }))),
      categoryCatalog: Object.freeze(categoryCatalog.map(category => Object.freeze({
        alias: category.alias,
        label: category.label,
        transactionTypes: category.transactionTypes,
      }))),
      periodDays,
    })
    return Object.freeze({
      generatedAt: generatedAt.toISOString(),
      providerInput,
      answerEvidence,
      allowedAliases: Object.freeze({
        studentAliases: Object.freeze(mentionedAliases),
        categoryAliases: Object.freeze(categoryCatalog.map(category => category.alias)),
      }),
      sensitiveValues: Object.freeze([
        Object.freeze({ kind: 'teacher-uid', value: teacher }),
        Object.freeze({ kind: 'classroom-id', value: classroom }),
        ...buildSensitiveStudentValues(raw.students, availableTransactions),
      ]),
      evidenceSignature: createHash('sha256').update(JSON.stringify({
        teacherUid: teacher,
        classroomId: classroom,
        question,
        periodDays,
        timeZone,
        asOfDate,
        configuredRentAmount: raw.configuredRentAmount,
        students: raw.students,
        transactions: availableTransactions.map(transaction => ({
          ...transaction,
          insideRollingPeriod: Date.parse(transaction.date) >= cutoff,
        })),
      })).digest('hex'),
    })
  }
}

function transactionPurpose(transaction) {
  const labels = [transaction.category, transaction.reason].map(value => (
    normalizeDisplayCategory(value).normalize('NFKC').toLocaleLowerCase('en-US')
  ))
  return labels.some(label => /(^|[^\p{L}\p{N}])rent(?=$|[^\p{L}\p{N}])/u.test(label))
    ? 'rent'
    : 'other'
}

function localDateKey(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function buildParticipants(students, transactions) {
  const currentById = new Map(students.map(student => [student.id, student]))
  const historicalById = new Map()
  for (const transaction of transactions) {
    if (currentById.has(transaction.studentId) || !transaction.studentName.trim()) continue
    const existing = historicalById.get(transaction.studentId)
    if (
      !existing ||
      transaction.date > existing.date ||
      (transaction.date === existing.date && transaction.id > existing.id)
    ) {
      historicalById.set(transaction.studentId, {
        id: transaction.id,
        date: transaction.date,
        name: transaction.studentName.trim(),
      })
    }
  }
  const ids = new Set([
    ...students.map(student => student.id),
    ...transactions.map(transaction => transaction.studentId),
  ])
  if (ids.size > MAX_STUDENTS) {
    fail('evidence-too-large', 'Classroom participant evidence exceeds the question read limit.')
  }
  return [...ids].sort((left, right) => left - right).map((id, index) => Object.freeze({
    id,
    name: currentById.get(id)?.name || historicalById.get(id)?.name ||
      `Archived student ${String(index + 1).padStart(3, '0')}`,
  }))
}

function buildStudentIdentities(students, transactions) {
  const identities = new Map(students.map(student => [`${student.id}\u0000${student.name}`, {
    id: student.id,
    name: student.name,
  }]))
  for (const transaction of transactions) {
    const name = transaction.studentName.trim()
    if (name) identities.set(`${transaction.studentId}\u0000${name}`, {
      id: transaction.studentId,
      name,
    })
  }
  if (identities.size > MAX_STUDENTS * 4) {
    fail('evidence-too-large', 'Classroom identity evidence exceeds the question read limit.')
  }
  return [...identities.values()].sort((left, right) => (
    left.id - right.id || left.name.localeCompare(right.name, 'en-US')
  ))
}

function buildSensitiveStudentValues(students, transactions) {
  const ids = new Set(students.map(student => String(student.id)))
  const names = new Set(students.map(student => student.name))
  for (const transaction of transactions) {
    ids.add(String(transaction.studentId))
    if (transaction.studentName) names.add(transaction.studentName)
  }
  if (ids.size > MAX_STUDENTS || names.size > MAX_STUDENTS * 2) {
    fail('evidence-too-large', 'Classroom identity evidence exceeds the question read limit.')
  }
  return [
    ...[...ids].sort().map(value => Object.freeze({ kind: 'student-id', value })),
    ...[...names].sort((left, right) => left.localeCompare(right, 'en-US'))
      .map(value => Object.freeze({ kind: 'student-name', value })),
  ]
}

function buildCategoryCatalog(transactions, students) {
  const byKey = new Map()
  for (const transaction of transactions) {
    const label = normalizeDisplayCategory(transaction.category)
    const key = categoryKey(label)
    const current = byKey.get(key) || { key, label, transactionTypes: new Set() }
    current.transactionTypes.add(transaction.type)
    byKey.set(key, current)
  }
  if (byKey.size > MAX_CATEGORIES) {
    fail('evidence-too-large', 'Classroom evidence exceeds the category read limit.')
  }
  return [...byKey.values()]
    .sort((left, right) => left.key.localeCompare(right.key, 'en-US'))
    .map((category, index) => {
      const aliasNumber = String(index + 1).padStart(3, '0')
      return Object.freeze({
        key: category.key,
        alias: `category-${aliasNumber}`,
        label: isProviderSafeCategoryLabel(category.label, students)
          ? category.label
          : neutralCategoryLabel(aliasNumber, students),
        transactionTypes: Object.freeze([...category.transactionTypes].sort()),
      })
    })
}

function neutralCategoryLabel(aliasNumber, students) {
  for (const prefix of ['Private category', 'Restricted label', 'Hidden entry', 'Opaque item']) {
    const candidate = `${prefix} ${aliasNumber}`
    if (isProviderSafeCategoryLabel(candidate, students)) return candidate
  }
  const encodedAlias = Number(aliasNumber).toString(2).replaceAll('0', '◇').replaceAll('1', '◆')
  return `◆${encodedAlias}`
}

function isProviderSafeCategoryLabel(label, students) {
  if (hasDisallowedControl(label) || EMAIL_OR_URL_PATTERN.test(label) || PHONE_PATTERN.test(label)) {
    return false
  }
  try {
    assertNoRosterNameLeak(label, students)
    return true
  } catch (error) {
    if (error instanceof InsightQuestionEvidenceError && error.category === 'evidence-not-deidentified') {
      return false
    }
    throw error
  }
}

function hasDisallowedControl(value) {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint === 127 || codePoint < 32
  })
}

function categoryKey(value) {
  return normalizeDisplayCategory(value).normalize('NFKC').toLocaleLowerCase('en-US')
}

function resolveMentionedStudents(question, students, categories) {
  const normalizedQuestion = normalize(question)
  const fullMatches = students.filter(student => (
    containsPhrase(normalizedQuestion, normalize(student.name))
  ))
  const directMatches = new Set()
  if (fullMatches.length) {
    const ownersByName = new Map()
    for (const student of fullMatches) {
      const name = normalize(student.name)
      if (!ownersByName.has(name)) ownersByName.set(name, new Set())
      ownersByName.get(name).add(student.id)
    }
    if ([...ownersByName.values()].some(owners => owners.size > 1)) {
      fail('question-ambiguous', 'More than one student has that name.')
    }
    for (const student of fullMatches) directMatches.add(student.id)
  }

  const questionTokens = new Set(tokens(question))
  const categoryLabelsByToken = new Map()
  for (const category of categories) {
    for (const token of new Set(tokens(category.label))) {
      if (!categoryLabelsByToken.has(token)) categoryLabelsByToken.set(token, [])
      categoryLabelsByToken.get(token).push(category.label)
    }
  }
  const tokenOwners = new Map()
  for (const student of students) {
    for (const token of new Set(tokens(student.name).filter(value => value.length >= 3))) {
      if (!tokenOwners.has(token)) tokenOwners.set(token, new Set())
      tokenOwners.get(token).add(student.id)
    }
  }
  const subjectHints = []
  for (const token of questionTokens) {
    const owners = tokenOwners.get(token)
    if (!owners) continue
    const studentRole = isStrongStudentTokenReference(question, token)
    if (owners.size === 1) {
      const studentId = [...owners][0]
      if (categoryLabelsByToken.has(token) && !studentRole) {
        subjectHints.push(Object.freeze({ text: token, studentId }))
      } else {
        directMatches.add(studentId)
      }
    } else if (studentRole) {
      fail('question-ambiguous', "Use the student's full name so Morgan Bank can identify one account.")
    }
  }
  for (const student of students) {
    const nameTokens = [...new Set(tokens(student.name))]
    if (nameTokens.length >= 2 && nameTokens.every(token => questionTokens.has(token))) {
      directMatches.add(student.id)
    }
  }
  return Object.freeze({
    directStudentIds: Object.freeze([...directMatches].sort((left, right) => left - right)),
    subjectHints: Object.freeze(subjectHints.filter(hint => !directMatches.has(hint.studentId))),
  })
}

function isStrongStudentTokenReference(question, token) {
  const word = escapeRegExp(token)
  const boundaryBefore = '(^|[^\\p{L}\\p{N}])'
  const boundaryAfter = '(?=$|[^\\p{L}\\p{N}])'
  const studentPredicate = '(?:account|balance|balances|transactions?|earn|earns|earned|earning|submit|submits|submitted|request|requests|requested|pay|pays|paid|spend|spends|spent|receive|receives|received|owe|owes|owed|make|makes|made|deposit|deposits|deposited|withdraw|withdraws|withdrew|have|has|had|frozen|freeze|lowest|highest|top|bottom|negative|positive|overdrawn)'
  const normalizedQuestion = normalize(question)
  return [
    `${boundaryBefore}${word}(?:['’]s)?(?:\\s+[\\p{L}\\p{N}]+){0,2}\\s+${studentPredicate}${boundaryAfter}`,
    `${boundaryBefore}(?:student|account|balance|history|transactions?)\\s+(?:for|of|belonging\\s+to)\\s+${word}${boundaryAfter}`,
  ].some(pattern => new RegExp(pattern, 'u').test(normalizedQuestion))
}

function sanitizeQuestion({ question, students, aliasesByStudentId, mentionedStudentIds }) {
  let result = question.normalize('NFKC')
  const placeholders = new Map()
  const mentioned = new Set(mentionedStudentIds)
  for (const student of [...students].sort((a, b) => b.name.length - a.name.length)) {
    if (!mentioned.has(student.id)) continue
    const placeholder = `MBOPAQUEALIAS${String(student.id).padStart(6, '0')}`
    placeholders.set(placeholder, aliasesByStudentId.get(student.id))
    result = result.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(student.name)}(?=$|[^\\p{L}\\p{N}])`, 'giu'),
      `$1${placeholder}`,
    )
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
    if (owners.length !== 1 || !mentioned.has(owners[0])) continue
    const replacement = `MBOPAQUEALIAS${String(owners[0]).padStart(6, '0')}`
    result = result.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(token)}(?=$|[^\\p{L}\\p{N}])`, 'giu'),
      `$1${replacement}`,
    )
  }
  for (const [placeholder, alias] of placeholders) result = result.replaceAll(placeholder, `[${alias}]`)
  return result.replace(/\s+/g, ' ').trim()
}

function assertNoRosterNameLeak(question, students) {
  const questionWithoutAliases = question.replace(/\[student(?:-[0-9]{3})?\]/giu, '')
  const normalizedQuestion = normalize(questionWithoutAliases)
  const questionTokens = new Set(tokens(questionWithoutAliases))
  for (const student of students) {
    if (containsPhrase(normalizedQuestion, normalize(student.name))) {
      fail('evidence-not-deidentified', 'The sanitized question contains a student name.')
    }
    if (containsSeparatorObscuredName(questionWithoutAliases, student.name)) {
      fail('evidence-not-deidentified', 'The sanitized question contains an obscured student name.')
    }
    const nameTokens = [...new Set(tokens(student.name))]
    if (nameTokens.length >= 2 && nameTokens.every(token => questionTokens.has(token))) {
      fail('evidence-not-deidentified', 'The sanitized question reconstructs a student name.')
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
  if (typeof value.frozen !== 'boolean') fail('evidence-malformed', 'A student record is malformed.')
  return Object.freeze({
    id,
    name: boundedString(value.name, 1, 120, 'student name'),
    balance: value.balance,
    frozen: value.frozen,
  })
}

function validateRentSnapshot(snapshot) {
  if (!snapshot?.exists) return 0
  const value = snapshot.data?.()
  if (
    !isPlainObject(value) || !hasExactKeys(value, RENT_KEYS) ||
    !Number.isSafeInteger(value.rentAmount) ||
    value.rentAmount < 0 || value.rentAmount > MAX_RENT_AMOUNT ||
    typeof value.updatedAt !== 'string' ||
    value.updatedAt.length < 1 || value.updatedAt.length > 80 ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) fail('evidence-malformed', 'The classroom rent record is malformed.')
  return value.rentAmount
}

function validateTransactionSnapshot(snapshot, timeZone) {
  const value = snapshot?.data?.()
  if (!isPlainObject(value) || !hasExactKeys(value, TRANSACTION_KEYS)) fail('evidence-malformed', 'A transaction record is malformed.')
  const id = positiveInteger(value.id, 'transaction id')
  const studentId = positiveInteger(value.studentId, 'transaction student id')
  const date = normalizeStoredTransactionDate(value.date, { timeZone })
  if (
    snapshot.id !== String(id) ||
    !date ||
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
    date,
    type: value.type,
    amount: value.amount,
    category: boundedString(value.category, 0, 120, 'category'),
    reason: boundedString(value.reason, 0, 320, 'reason'),
    studentName: boundedString(value.studentName, 0, 120, 'transaction student name'),
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

function containsSeparatorObscuredName(value, name) {
  const nameTokens = tokens(name).map(collapseSensitiveText).filter(Boolean)
  if (nameTokens.length === 0) return false
  const maximumCandidateLength = nameTokens.reduce((total, token) => total + token.length, 0)
  const runs = normalize(value).match(/[\p{L}\p{N}]+/gu) ?? []
  for (let start = 0; start < runs.length; start += 1) {
    let candidate = ''
    for (let end = start; end < runs.length; end += 1) {
      candidate += collapseSensitiveText(runs[end])
      if (candidate.length > maximumCandidateLength) break
      if (matchesSensitiveNameCombination(candidate, nameTokens, end - start + 1)) return true
    }
  }
  return false
}

function matchesSensitiveNameCombination(candidate, nameTokens, runCount) {
  const uniqueTokens = [...new Set(nameTokens)]
  if (runCount >= 2 && uniqueTokens.includes(candidate)) return true
  if (uniqueTokens.length === 1) {
    return runCount >= 2 && candidate === uniqueTokens[0]
  }
  const segmentCounts = Array(candidate.length + 1).fill(-1)
  segmentCounts[0] = 0
  for (let index = 0; index < candidate.length; index += 1) {
    if (segmentCounts[index] < 0) continue
    for (const token of uniqueTokens) {
      if (!candidate.startsWith(token, index)) continue
      const nextIndex = index + token.length
      segmentCounts[nextIndex] = Math.max(segmentCounts[nextIndex], segmentCounts[index] + 1)
    }
  }
  const usedCount = segmentCounts[candidate.length]
  return usedCount >= 2
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
