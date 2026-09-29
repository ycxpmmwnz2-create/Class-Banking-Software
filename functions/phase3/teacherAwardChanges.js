import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { hasExactDataKeys, isControlGeneration } from './classroomAccess.js'
import {
  applyMoneyDelta, canonicalMoneyTargets, deriveMoneyLedgerIds, moneyCentsToStored,
  requirePositiveMoneyCents, storedMoneyToCents, TeacherMoneyContractError,
  TEACHER_MONEY_LIMITS, TEACHER_MONEY_PROTOCOL,
} from './teacherMoneyContract.js'
import { estimateMoneyDocumentBytes } from './moneyCompatibility.js'

const REQUEST_KEYS = ['protocolVersion', 'controlGeneration', 'requestId', 'action',
  'studentIds', 'amountCents', 'reason', 'category', 'memo']
const STUDENT_KEYS = ['id', 'name', 'balance', 'frozen', 'transactions']
const ENTRY_KEYS = ['id', 'date', 'studentId', 'studentName', 'type', 'amount',
  'reason', 'memo', 'category', 'status', 'source']
const RESERVED = new Set(['Balance adjustment', 'Opening Balance', 'Operator correction',
  'Opening balance', 'Compatibility correction'])
const fail = code => { throw new TeacherMoneyContractError(code) }
const positiveId = value => Number.isSafeInteger(value) && value > 0

function dataArray(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) fail(code)
  for (let i = 0; i < value.length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i))
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) fail(code)
  }
  return value
}

function text(value, maximum, nonBlank = false) {
  if (typeof value !== 'string' || value.length > maximum * 2 || !value.isWellFormed() ||
      [...value].length > maximum || (nonBlank && !value.trim())) fail('invalid-text')
  return value
}

// A canonical intent is not authorization, a reservation, or a terminal receipt.
// Bind identity only from the authenticated transaction's reciprocal foundation.
export function bindTeacherAwardIntent(request, identity) {
  if (!hasExactDataKeys(request, REQUEST_KEYS) ||
      request.protocolVersion !== TEACHER_MONEY_PROTOCOL ||
      !isControlGeneration(request.controlGeneration) ||
      !['award', 'deduct'].includes(request.action)) fail('invalid-request')
  if (!hasExactDataKeys(identity, ['projectId', 'classroomId', 'teacherUid'])) fail('invalid-ledger-context')
  const studentIds = canonicalMoneyTargets(dataArray(request.studentIds,
    TEACHER_MONEY_LIMITS.targets, 'invalid-targets'))
  const context = { ...identity, protocolVersion: request.protocolVersion,
    requestId: request.requestId, action: request.action }
  const ledgerIds = deriveMoneyLedgerIds(context, studentIds)
  const intent = Object.freeze({ protocolVersion: request.protocolVersion,
    controlGeneration: request.controlGeneration, requestId: request.requestId,
    action: request.action, studentIds, amountCents: requirePositiveMoneyCents(request.amountCents),
    reason: text(request.reason, 120, true), category: text(request.category, 120),
    memo: text(request.memo, 500) })
  if (RESERVED.has(intent.reason) || RESERVED.has(intent.category) ||
      (intent.category !== '' && intent.category !== intent.reason)) fail('invalid-category')
  // Validate raw wire size too: duplicate target IDs still occupy request bytes.
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > TEACHER_MONEY_LIMITS.requestBytes) fail('request-size-limit')
  // Versioned compact JSON array, UTF-8, no normalization. Identity is server-bound.
  const tuple = ['morgan-bank/teacher-award-intent', TEACHER_MONEY_PROTOCOL,
    identity.projectId, identity.classroomId, identity.teacherUid, intent.requestId,
    intent.controlGeneration, intent.action, studentIds, intent.amountCents,
    intent.reason, intent.category, intent.memo]
  const digest = createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')
  return Object.freeze({ intent, digest, ledgerIds })
}

function serverDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid-clock')
  return value
}

function copyStudent(student) {
  if (!hasExactDataKeys(student, STUDENT_KEYS) || !positiveId(student.id) ||
      typeof student.name !== 'string' || !student.name.trim() ||
      typeof student.frozen !== 'boolean') fail('invalid-student')
  storedMoneyToCents(student.balance)
  const entries = dataArray(student.transactions, TEACHER_MONEY_LIMITS.mirrorEntries, 'invalid-mirror')
  if (entries.length === TEACHER_MONEY_LIMITS.mirrorEntries) fail('mirror-capacity')
  const seen = new Set()
  const transactions = entries.map(entry => {
    if (!hasExactDataKeys(entry, ENTRY_KEYS) || !positiveId(entry.id) ||
        entry.studentId !== student.id || seen.has(entry.id) ||
        !['date', 'studentName', 'reason', 'memo', 'category', 'source'].every(key => typeof entry[key] === 'string') ||
        !entry.date.trim() || !entry.studentName.trim() || !entry.source.trim() ||
        !['Add', 'Subtract'].includes(entry.type) || !['Pending', 'Approved', 'Denied'].includes(entry.status) ||
        typeof entry.amount !== 'number' || !Number.isFinite(entry.amount) || entry.amount <= 0) fail('invalid-mirror')
    seen.add(entry.id)
    // Historical names/amounts are retained, not converted or tied to today's name.
    return Object.freeze({ ...entry })
  })
  return { ...student, transactions }
}

// Pure, dormant calculation component, NOT planTeacherMoneyV2 or an executable
// Firestore plan. Does no reads/writes and authenticates nobody. A future service
// must read these inputs in EACH transaction attempt, authorize owner/control,
// check the receipt/actor/quota BEFORE using this for a NEW action, enforce the
// complete read/write budget, then commit all money and recovery metadata together.
export function buildTeacherAwardChanges(request, { identity, students, candidateLedgerReads,
  allowedReasons, serverTime }) {
  const bound = bindTeacherAwardIntent(request, identity)
  const { intent, ledgerIds } = bound
  const date = serverDate(serverTime)
  // This is server-owned policy input, never a client-provided allowlist.
  if (!Array.isArray(allowedReasons) || !allowedReasons.includes(intent.reason)) fail('reason-not-allowed')
  dataArray(students, TEACHER_MONEY_LIMITS.targets, 'invalid-students')
  dataArray(candidateLedgerReads, TEACHER_MONEY_LIMITS.targets, 'invalid-ledger-reads')
  if (students.length !== ledgerIds.length || candidateLedgerReads.length !== ledgerIds.length) fail('incomplete-inputs')
  const byStudent = new Map()
  for (const row of students) {
    const student = copyStudent(row)
    if (byStudent.has(student.id)) fail('invalid-students')
    byStudent.set(student.id, student)
  }
  const checkedLedger = new Set()
  for (const row of candidateLedgerReads) {
    if (!hasExactDataKeys(row, ['id', 'exists']) || !positiveId(row.id) ||
        typeof row.exists !== 'boolean' || checkedLedger.has(row.id)) fail('invalid-ledger-reads')
    if (row.exists) fail('ledger-id-collision')
    checkedLedger.add(row.id)
  }
  const newIds = new Set(ledgerIds.map(row => row.ledgerId))
  for (const student of byStudent.values()) {
    if (student.transactions.some(entry => newIds.has(entry.id))) fail('ledger-id-collision')
  }
  let estimatedMutationBytes = 0
  const changes = ledgerIds.map(({ targetId, ledgerId }) => {
    const student = byStudent.get(targetId)
    if (!student || !checkedLedger.has(ledgerId)) fail('incomplete-inputs')
    const delta = intent.action === 'award' ? intent.amountCents : -intent.amountCents
    const balance = moneyCentsToStored(applyMoneyDelta(storedMoneyToCents(student.balance), delta))
    const ledger = Object.freeze({ id: ledgerId, date, studentId: targetId, studentName: student.name,
      type: intent.action === 'award' ? 'Add' : 'Subtract', amount: moneyCentsToStored(intent.amountCents),
      reason: intent.reason, memo: intent.memo, category: intent.category, status: 'Approved', source: 'Teacher' })
    const updatedStudent = Object.freeze({ ...student, balance,
      transactions: Object.freeze([ledger, ...student.transactions]) })
    const studentPath = `classrooms/${identity.classroomId}/students/${targetId}`
    const ledgerPath = `classrooms/${identity.classroomId}/transactions/${ledgerId}`
    const bytes = estimateMoneyDocumentBytes(studentPath, updatedStudent)
    if (bytes > TEACHER_MONEY_LIMITS.studentBytes) fail('student-size-limit')
    estimatedMutationBytes += bytes + estimateMoneyDocumentBytes(ledgerPath, ledger)
    if (estimatedMutationBytes > TEACHER_MONEY_LIMITS.transactionBytes) fail('mutation-size-limit')
    return Object.freeze({ studentPath, ledgerPath, student: updatedStudent, ledger })
  })
  // This subtotal excludes reads, receipt, actor and quota. It cannot certify the
  // final transaction size or satisfy the separate 60-second preview contract.
  return Object.freeze({ ...bound, changes: Object.freeze(changes),
    estimatedMutationBytes, mutationWriteCount: changes.length * 2 })
}
