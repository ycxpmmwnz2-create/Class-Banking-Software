import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { hasExactDataKeys, isControlGeneration } from './classroomAccess.js'
import { bindTeacherAwardIntent, copyMoneyStudent } from './teacherAwardChanges.js'
import { applyMoneyDelta, canonicalMoneyTargets, deriveMoneyLedgerIds, requireMoneyCents,
  requirePositiveMoneyCents, storedMoneyToCents, TeacherMoneyContractError,
  TEACHER_MONEY_LIMITS as LIMITS } from './teacherMoneyContract.js'
import { estimateMoneyDocumentBytes } from './moneyDocumentSize.js'

const fail = code => { throw new TeacherMoneyContractError(code) }
export const isDecision = action => action === 'approve' || action === 'deny'
export const isRosterMoney = action => isDecision(action) || action === 'adjust' || action === 'reset'
const common = ['protocolVersion', 'controlGeneration', 'requestId', 'action']

function uniqueIds(values) {
  const ids = canonicalMoneyTargets(values)
  if (ids.length !== values.length || Reflect.ownKeys(values).length !== values.length + 1) fail('invalid-targets')
  return ids
}

// New actions share the actor/receipt namespace, but never reuse an award digest.
export function bindTeacherMoneyIntent(request, identity) {
  if (!isRosterMoney(request?.action)) return bindTeacherAwardIntent(request, identity)
  const decision = isDecision(request.action)
  if (!hasExactDataKeys(request, [...common, ...(decision ? ['transactionIds', 'allowNegative'] : ['adjustments'])]) ||
      request.protocolVersion !== 1 || !isControlGeneration(request.controlGeneration)) fail('invalid-request')
  let payload, ids
  if (decision) {
    if (typeof request.allowNegative !== 'boolean' || (request.action === 'deny' && request.allowNegative)) fail('invalid-request')
    ids = uniqueIds(request.transactionIds)
    payload = { transactionIds: ids, allowNegative: request.allowNegative }
  } else {
    if (!Array.isArray(request.adjustments) || Reflect.ownKeys(request.adjustments).length !== request.adjustments.length + 1) fail('invalid-targets')
    const adjustments = Array.from(request.adjustments, row => {
      if (!hasExactDataKeys(row, ['studentId', 'expectedCents', 'targetCents'])) fail('invalid-request')
      const expectedCents = requireMoneyCents(row.expectedCents), targetCents = requireMoneyCents(row.targetCents)
      requireMoneyCents(targetCents - expectedCents)
      if (expectedCents === targetCents || (request.action === 'reset' && targetCents !== 0)) fail('invalid-adjustment')
      return Object.freeze({ studentId: row.studentId, expectedCents, targetCents })
    }).sort((a, b) => a.studentId - b.studentId)
    ids = uniqueIds(adjustments.map(row => row.studentId))
    payload = { adjustments: Object.freeze(adjustments) }
  }
  // Also validates the authenticated context and canonical request ID.
  const derived = deriveMoneyLedgerIds({ ...identity, protocolVersion: 1, requestId: request.requestId, action: request.action }, ids)
  const ledgerIds = decision ? ids.map(id => ({ targetId: id, ledgerId: id })) : derived
  const intent = Object.freeze({ protocolVersion: 1, controlGeneration: request.controlGeneration,
    requestId: request.requestId, action: request.action, ...payload })
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > LIMITS.requestBytes) fail('request-size-limit')
  const digest = createHash('sha256').update(JSON.stringify(['morgan-bank/teacher-roster-intent', 1,
    identity.projectId, identity.classroomId, identity.teacherUid, intent]), 'utf8').digest('hex')
  return Object.freeze({ intent, digest, ledgerIds })
}

// Complete selected groups only: there is no automatic subset for decisions or resets.
export async function readRosterMoneyChanges(bound, { identity, get, serverTime }) {
  const { intent } = bound, root = `classrooms/${identity.classroomId}`
  const students = new Map(), originals = new Map(), ledgers = [], writes = []
  async function student(id) {
    if (students.has(id)) return students.get(id)
    if (!Number.isSafeInteger(id) || id <= 0) fail('invalid-student')
    const snap = await get(`${root}/students/${id}`)
    if (!snap.exists) fail('missing-student')
    const row = copyMoneyStudent(snap.data(), !isDecision(intent.action))
    if (row.id !== id) fail('student-path-mismatch')
    originals.set(id, globalThis.structuredClone(row)); students.set(id, row)
    return row
  }
  if (isDecision(intent.action)) {
    for (const id of intent.transactionIds) {
      const path = `${root}/transactions/${id}`, snap = await get(path)
      if (!snap.exists) fail('pending-conflict')
      const entry = snap.data(), row = await student(entry?.studentId)
      const mirror = row.transactions.find(item => item.id === id)
      if (entry.id !== id || entry.status !== 'Pending' || !mirror ||
          !hasExactDataKeys(entry, Object.keys(mirror)) ||
          Object.keys(mirror).some(key => entry[key] !== mirror[key])) fail('pending-conflict')
      const amount = requirePositiveMoneyCents(storedMoneyToCents(entry.amount))
      if (intent.action === 'approve') {
        const after = applyMoneyDelta(storedMoneyToCents(row.balance), entry.type === 'Add' ? amount : -amount)
        if (entry.type === 'Subtract' && after < 0 && !intent.allowNegative) fail('negative-confirmation-required')
        row.balance = after / 100
      }
      const updated = { ...entry, status: intent.action === 'approve' ? 'Approved' : 'Denied' }
      // Preserve date, historical name, mirror order and all other stored fields.
      row.transactions = row.transactions.map(item => item.id === id ? updated : item)
      ledgers.push({ path, value: updated, kind: 'update' })
    }
  } else {
    for (const [index, edit] of intent.adjustments.entries()) {
      const row = await student(edit.studentId), before = storedMoneyToCents(row.balance)
      if (before !== edit.expectedCents) fail('balance-conflict')
      const { ledgerId } = bound.ledgerIds[index], path = `${root}/transactions/${ledgerId}`
      if ((await get(path)).exists || [...students.values()].some(s => s.transactions.some(t => t.id === ledgerId))) fail('ledger-id-collision')
      const delta = requireMoneyCents(edit.targetCents - before)
      const entry = { id: ledgerId, date: serverTime, studentId: row.id, studentName: row.name,
        type: delta > 0 ? 'Add' : 'Subtract', amount: Math.abs(delta) / 100,
        reason: intent.action === 'reset' ? 'Balance reset to zero' : 'Roster balance adjustment',
        category: 'Balance adjustment',
        memo: `Balance changed from ${(before / 100).toFixed(2)} to ${(edit.targetCents / 100).toFixed(2)}. This is an adjustment, not earned money or a purchase.`,
        status: 'Approved', source: 'Teacher' }
      row.balance = applyMoneyDelta(before, delta) / 100
      row.transactions = [entry, ...row.transactions]
      ledgers.push({ path, value: entry, kind: 'create' })
    }
    const newIds = new Set(bound.ledgerIds.map(row => row.ledgerId))
    for (const row of originals.values()) if (row.transactions.some(entry => newIds.has(entry.id))) fail('ledger-id-collision')
  }
  let estimatedMutationBytes = 0
  for (const row of students.values()) {
    const path = `${root}/students/${row.id}`, size = estimateMoneyDocumentBytes(path, row)
    if (size > LIMITS.studentBytes) fail('student-size-limit')
    writes.push({ path, value: row, kind: 'update' }); estimatedMutationBytes += size
  }
  for (const row of ledgers) { writes.push(row); estimatedMutationBytes += estimateMoneyDocumentBytes(row.path, row.value) }
  const selected = [...students.values()].sort((a, b) => a.id - b.id).map(row => ({ studentId: row.id,
    name: row.name, balanceCents: storedMoneyToCents(originals.get(row.id).balance), expectedBalanceCents: storedMoneyToCents(row.balance) }))
  return { ...bound, writes, selected, estimatedMutationBytes, mutationWriteCount: writes.length }
}
