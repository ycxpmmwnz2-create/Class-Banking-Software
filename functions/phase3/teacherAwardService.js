import { createHash } from 'node:crypto'
import { hasExactDataKeys, isControlGeneration, readTeacherClassroomAccess, requireClassroomAccess } from './classroomAccess.js'
import { bindTeacherAwardIntent, buildTeacherAwardChanges } from './teacherAwardChanges.js'
import { estimateMoneyDocumentBytes } from './moneyDocumentSize.js'
import { TEACHER_MONEY_LIMITS as LIMITS } from './teacherMoneyContract.js'
import { validateCanonicalDocumentId } from '../phase2b/identityNormalization.js'

export class TeacherAwardServiceError extends Error {
  constructor(code) { super('The teacher money action is unavailable.'); this.name = 'TeacherAwardServiceError'; this.code = code }
}
const fail = code => { throw new TeacherAwardServiceError(code) }
const requestId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const hash = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const validTime = value => typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

// Server-only metadata. Hash tuples avoid delimiter ambiguity and oversized IDs;
// the exact actor and request are checked in the stored receipt as well.
export function teacherAwardPaths(classroomId, teacherUid, id) {
  validateCanonicalDocumentId(classroomId)
  validateCanonicalDocumentId(teacherUid)
  if (!requestId(id)) fail('invalid-request')
  const root = `classrooms/${classroomId}`
  return Object.freeze({
    receipt: `${root}/teacherMoneyReceipts/${hash(['teacher-money-receipt', 1, teacherUid, id])}`,
    actor: `${root}/teacherMoneyActors/${hash(['teacher-money-actor', 1, teacherUid])}`,
    quota: `${root}/teacherMoneyMetadata/receiptQuota`,
  })
}

function actorState(data, uid) {
  if (!hasExactDataKeys(data, ['version', 'actorUid', 'unacknowledgedRequestId']) || data.version !== 1 ||
      data.actorUid !== uid || (data.unacknowledgedRequestId !== null && !requestId(data.unacknowledgedRequestId))) fail('invalid-actor-state')
  return data
}
function receiptCount(data) {
  if (!hasExactDataKeys(data, ['version', 'count']) || data.version !== 1 ||
      !Number.isSafeInteger(data.count) || data.count < 0 || data.count > LIMITS.receipts) fail('invalid-quota')
  return data.count
}
// Receipt v2 keeps the complete ordered mapping as canonical lowercase base36
// pairs. Both IDs are positive safe integers; ':' and ',' cannot occur in them.
// Replay compares to the freshly derived encoding, never parses stored input.
const compactLedgerMapping = ledgerIds => 'b36:1:' + ledgerIds
  .map(({ targetId, ledgerId }) => `${targetId.toString(36)}:${ledgerId.toString(36)}`).join(',')

function storedReceipt(data, bound, uid) {
  const common = ['version', 'actorUid', 'requestId', 'generation', 'status', 'serverTime']
  const keys = data?.status === 'cancelled' ? common : [...common, 'digest', 'action', 'itemCount', 'ledgerIds', 'acknowledged']
  if (!hasExactDataKeys(data, keys) ||
      (data.version !== 1 && !(data.version === 2 && data.status === 'committed')) || data.actorUid !== uid ||
      data.requestId !== bound.intent.requestId || !isControlGeneration(data.generation) || !validTime(data.serverTime)) fail('invalid-receipt')
  if (data.status === 'cancelled') fail('request-cancelled')
  if (data.status !== 'committed' || typeof data.acknowledged !== 'boolean' ||
      typeof data.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.digest)) fail('invalid-receipt')
  if (data.digest !== bound.digest) fail('request-conflict')
  const mappingMatches = data.version === 2 ? data.ledgerIds === compactLedgerMapping(bound.ledgerIds) :
    Array.isArray(data.ledgerIds) && data.ledgerIds.length === bound.ledgerIds.length &&
    bound.ledgerIds.every((expected, i) =>
        hasExactDataKeys(data.ledgerIds[i], ['targetId', 'ledgerId']) &&
        data.ledgerIds[i].targetId === expected.targetId && data.ledgerIds[i].ledgerId === expected.ledgerId)
  if (data.generation !== bound.intent.controlGeneration || data.action !== bound.intent.action ||
      data.itemCount !== bound.ledgerIds.length || !mappingMatches) fail('invalid-receipt')
  return data
}
function reply(receipt, count) {
  return Object.freeze({ protocolVersion: 1, requestId: receipt.requestId, status: 'committed',
    action: receipt.action, itemCount: receipt.itemCount, serverTime: receipt.serverTime,
    requiresRefresh: true, acknowledged: receipt.acknowledged,
    receiptCapacityWarning: count >= 95000 ? '95-percent' : count >= 80000 ? '80-percent' : null })
}

// Dormant service, no callable or SDK creation. Only an authenticated server
// caller may supply these dependencies. Metadata must be initialized by a future
// reviewed initializer; missing counters/actor state NEVER silently reset to zero.
export async function executeTeacherAwardService(request, { firestore, auth, projectId, now = () => new Date().toISOString() } = {}) {
  validateCanonicalDocumentId(projectId)
  // Snapshot plain wire input before the asynchronous callback/retries. Validate
  // with a placeholder canonical classroom; final binding uses current ownership.
  const initial = bindTeacherAwardIntent(request, { projectId, teacherUid: auth?.uid, classroomId: 'validation-only' })
  const wire = initial.intent
  return firestore.runTransaction(async transaction => {
    let bytes = 0
    const snapshots = new Map()
    // A Firestore document is <= 1 MiB; add path/wire headroom before each read.
    // Foundation reads retain that full charge (they may contain SDK timestamps).
    // Scalar money reads settle to the shared conservative estimate. This is
    // bounded accounting, not an SDK/index-size guarantee or preview planner.
    const readBound = 1024 * 1024 + 32 * 1024
    async function get(ref, foundation = false) {
      if (snapshots.has(ref.path)) return snapshots.get(ref.path)
      if (bytes + readBound > LIMITS.transactionBytes) fail('transaction-size-limit')
      const snap = await transaction.get(ref)
      if (typeof snap?.exists !== 'boolean') fail('invalid-snapshot')
      const data = snap.exists ? snap.data() : null
      const actual = foundation ? readBound : estimateMoneyDocumentBytes(ref.path, data)
      if (actual > readBound) fail('read-size-limit')
      bytes += actual
      const stable = { exists: snap.exists, data: () => data }
      snapshots.set(ref.path, stable)
      return stable
    }
    const foundation = await readTeacherClassroomAccess({
      transaction: { get: ref => get(ref, true) }, firestore, auth, policy: { operation: 'recovery' },
    })
    const identity = { projectId, classroomId: foundation.classroomId, teacherUid: foundation.teacherUid }
    const bound = bindTeacherAwardIntent(wire, identity)
    const paths = teacherAwardPaths(identity.classroomId, identity.teacherUid, wire.requestId)
    const receiptSnap = await get(firestore.doc(paths.receipt))
    const actorSnap = await get(firestore.doc(paths.actor))
    const quotaSnap = await get(firestore.doc(paths.quota))
    const actor = actorState(actorSnap.data(), identity.teacherUid)
    const count = receiptCount(quotaSnap.data())
    if (receiptSnap.exists) {
      const receipt = storedReceipt(receiptSnap.data(), bound, identity.teacherUid)
      if (estimateMoneyDocumentBytes(paths.receipt, receipt) > LIMITS.receiptBytes || count < 1 ||
          (!receipt.acknowledged && actor.unacknowledgedRequestId !== wire.requestId) ||
          (receipt.acknowledged && actor.unacknowledgedRequestId === wire.requestId)) fail('invalid-receipt-state')
      return reply(receipt, count)
    }
    requireClassroomAccess(foundation.control, { operation: 'mutate', protocolVersion: wire.protocolVersion, controlGeneration: wire.controlGeneration })
    if (actor.unacknowledgedRequestId !== null) fail('acknowledgment-required')
    if (count >= LIMITS.receipts) fail('receipt-quota-exhausted')
    const classroom = snapshots.get(`classrooms/${identity.classroomId}`).data()
    const categories = classroom.settings?.[wire.action === 'award' ? 'addMoneyCategories' : 'subtractMoneyCategories']
    if (!Array.isArray(categories) || categories.some(value => typeof value !== 'string')) fail('invalid-reason-policy')
    const allowedReasons = [...categories, wire.action === 'award' ? 'Quick Cash' : 'Classroom Expense']
    const students = []
    const candidateLedgerReads = []
    for (const { targetId, ledgerId } of bound.ledgerIds) {
      const student = await get(firestore.doc(`classrooms/${identity.classroomId}/students/${targetId}`))
      if (!student.exists) fail('missing-student')
      if (student.data()?.id !== targetId) fail('student-path-mismatch')
      students.push(student.data())
      const ledger = await get(firestore.doc(`classrooms/${identity.classroomId}/transactions/${ledgerId}`))
      candidateLedgerReads.push({ id: ledgerId, exists: ledger.exists })
    }
    const serverTime = now()
    if (!validTime(serverTime)) fail('invalid-clock')
    const calculated = buildTeacherAwardChanges(wire, { identity, students, candidateLedgerReads, allowedReasons, serverTime })
    const receipt = { version: 2, actorUid: identity.teacherUid, requestId: wire.requestId,
      generation: wire.controlGeneration, status: 'committed', serverTime, digest: bound.digest,
      action: wire.action, itemCount: bound.ledgerIds.length, ledgerIds: compactLedgerMapping(bound.ledgerIds), acknowledged: false }
    const nextActor = { ...actor, unacknowledgedRequestId: wire.requestId }
    const nextQuota = { version: 1, count: count + 1 }
    const receiptBytes = estimateMoneyDocumentBytes(paths.receipt, receipt)
    if (receiptBytes > LIMITS.receiptBytes) fail('receipt-size-limit')
    bytes += calculated.estimatedMutationBytes + receiptBytes + estimateMoneyDocumentBytes(paths.actor, nextActor) + estimateMoneyDocumentBytes(paths.quota, nextQuota)
    if (bytes > LIMITS.transactionBytes || calculated.mutationWriteCount + 3 > LIMITS.writes) fail('transaction-size-limit')
    // No validation, reads, or externally visible side effects after staging writes.
    for (const change of calculated.changes) {
      transaction.update(firestore.doc(change.studentPath), change.student)
      transaction.create(firestore.doc(change.ledgerPath), change.ledger)
    }
    transaction.create(firestore.doc(paths.receipt), receipt)
    transaction.update(firestore.doc(paths.actor), nextActor)
    transaction.update(firestore.doc(paths.quota), nextQuota)
    return reply(receipt, count + 1)
  })
}
