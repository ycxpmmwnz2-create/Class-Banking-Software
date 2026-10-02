import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { hasExactDataKeys, isControlGeneration, readTeacherClassroomAccess, requireClassroomAccess } from './classroomAccess.js'
import { bindTeacherAwardIntent, buildTeacherAwardChanges } from './teacherAwardChanges.js'
import { estimateMoneyDocumentBytes } from './moneyDocumentSize.js'
import { createPlannerReadBudget } from './plannerReadBudget.js'
import { TEACHER_MONEY_LIMITS as LIMITS, deriveMoneyLedgerIds, storedMoneyToCents } from './teacherMoneyContract.js'
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
async function runAward(request, { firestore, auth, projectId, now = () => new Date().toISOString() } = {}, mode = 'execute', plan = null) {
  validateCanonicalDocumentId(projectId)
  // Snapshot plain wire input before the asynchronous callback/retries. Validate
  // with a placeholder canonical classroom; final binding uses current ownership.
  const initial = bindTeacherAwardIntent(request, { projectId, teacherUid: auth?.uid, classroomId: 'validation-only' })
  const wire = initial.intent
  return firestore.runTransaction(async transaction => {
    let bytes = 0
    const planning = mode === 'plan'
    const budget = createPlannerReadBudget({ overheadBytes: 0 })
    const snapshots = new Map()
    // A Firestore document is <= 1 MiB; add path/wire headroom before each read.
    // Foundation reads retain that full charge (they may contain SDK timestamps).
    // Scalar money reads settle to the shared conservative estimate. This is
    // bounded accounting, not an SDK/index-size guarantee or preview planner.
    const readBound = 1024 * 1024 + 32 * 1024
    async function get(ref, foundation = false) {
      if (snapshots.has(ref.path)) return snapshots.get(ref.path)
      if (bytes + readBound > LIMITS.transactionBytes) fail('transaction-size-limit')
      if (!budget.tryReserveGroup([{ key: ref.path, maxBytes: readBound }])) fail('transaction-size-limit')
      const snap = await transaction.get(ref)
      if (typeof snap?.exists !== 'boolean') fail('invalid-snapshot')
      const data = snap.exists ? snap.data() : null
      const actual = foundation ? readBound : estimateMoneyDocumentBytes(ref.path, data)
      if (actual > readBound) fail('read-size-limit')
      bytes += actual
      budget.settleRead(ref.path, actual)
      const stable = { exists: snap.exists, data: () => data, updateTime: snap.updateTime, estimatedBytes: actual }
      snapshots.set(ref.path, stable)
      return stable
    }
    const foundation = await readTeacherClassroomAccess({
      transaction: { get: ref => get(ref, true) }, firestore, auth, policy: { operation: 'recovery' },
    })
    const identity = { projectId, classroomId: foundation.classroomId, teacherUid: foundation.teacherUid }
    const bound = bindTeacherAwardIntent(wire, identity)
    if (plan && (plan.projectId !== projectId || plan.classroomId !== identity.classroomId ||
        plan.teacherUid !== identity.teacherUid || plan.digest !== bound.digest)) fail('stale-plan')
    const paths = teacherAwardPaths(identity.classroomId, identity.teacherUid, wire.requestId)
    const receiptSnap = await get(firestore.doc(paths.receipt))
    const actorSnap = await get(firestore.doc(paths.actor))
    const quotaSnap = await get(firestore.doc(paths.quota))
    const actor = actorState(actorSnap.data(), identity.teacherUid)
    const count = receiptCount(quotaSnap.data())
    if (receiptSnap.exists) {
      if (planning) fail('request-already-used')
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
    const students = [], candidateLedgerReads = []
    const basePaths = [...snapshots.keys()]
    const selectedPaths = [...basePaths]
    let lastPlan = null, stopReason = null
    const serverTime = now()
    if (!validTime(serverTime)) fail('invalid-clock')
    const createdAt = Date.parse(serverTime)
    for (const { targetId, ledgerId } of bound.ledgerIds) {
      const studentPath = `classrooms/${identity.classroomId}/students/${targetId}`
      const ledgerPath = `classrooms/${identity.classroomId}/transactions/${ledgerId}`
      // Reserve BOTH worst-case dependencies before fetching either. An existing
      // document may be legacy-sized; never use the new-write cap as a read bound.
      if (planning && !budget.tryReserveGroup([studentPath, ledgerPath].map(key => ({ key, maxBytes: readBound })))) {
        stopReason = 'planning-read-limit'; break
      }
      const student = await get(firestore.doc(studentPath))
      if (!student.exists) fail('missing-student')
      if (student.data()?.id !== targetId) fail('student-path-mismatch')
      students.push(student.data())
      const ledger = await get(firestore.doc(ledgerPath))
      candidateLedgerReads.push({ id: ledgerId, exists: ledger.exists })
      selectedPaths.push(studentPath, ledgerPath)
      if (planning) {
        const subset = { ...wire, studentIds: students.map(row => row.id) }
        try {
          const candidate = awardMutation(subset, { identity, students, candidateLedgerReads, allowedReasons, serverTime }, paths, actor, count,
            selectedPaths.reduce((sum, path) => sum + snapshots.get(path).estimatedBytes, 0))
          const next = { protocolVersion: 1, projectId, classroomId: identity.classroomId, teacherUid: identity.teacherUid,
            digest: candidate.calculated.digest, createdAt, expiresAt: createdAt + 60000,
            versions: snapshotVersions(selectedPaths, snapshots) }
          const result = { plan: next, request: subset, selected: candidate.calculated.changes.map(change => ({
            studentId: change.student.id, name: change.student.name, balanceCents: storedMoneyToCents(students.find(row => row.id === change.student.id).balance),
            expectedBalanceCents: storedMoneyToCents(change.student.balance) })),
            notYetPlanned: wire.studentIds.slice(students.length), reason: 'transaction-size-limit' }
          if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LIMITS.replyBytes) { stopReason = 'reply-size-limit'; break }
          lastPlan = result
        } catch (error) {
          if (!['receipt-size-limit', 'transaction-size-limit', 'mutation-size-limit', 'student-size-limit', 'mirror-capacity'].includes(error.code)) throw error
          stopReason = error.code; break
        }
      }
    }
    if (planning) {
      const result = lastPlan ?? { plan: null, request: null, selected: [], notYetPlanned: wire.studentIds }
      // Keep fetched-but-excluded targets in the remainder. Never read again to
      // service it, concatenate snapshots, or advertise the remainder as verified.
      return { ...result, reason: stopReason ?? null }
    }
    const { calculated, receipt, nextActor, nextQuota } = awardMutation(wire,
      { identity, students, candidateLedgerReads, allowedReasons, serverTime }, paths, actor, count, bytes)
    if (plan) {
      const currentTime = now()
      if (!validTime(currentTime) || Date.parse(currentTime) < plan.createdAt || Date.parse(currentTime) >= plan.expiresAt ||
          JSON.stringify(plan.versions) !== JSON.stringify(snapshotVersions([...snapshots.keys()], snapshots))) fail('stale-plan')
    }
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


function awardMutation(wire, inputs, paths, actor, count, readBytes) {
  const calculated = buildTeacherAwardChanges(wire, inputs)
  const receipt = { version: 2, actorUid: inputs.identity.teacherUid, requestId: wire.requestId,
    generation: wire.controlGeneration, status: 'committed', serverTime: inputs.serverTime,
    digest: calculated.digest, action: wire.action, itemCount: calculated.ledgerIds.length,
    ledgerIds: compactLedgerMapping(calculated.ledgerIds), acknowledged: false }
  const nextActor = { ...actor, unacknowledgedRequestId: wire.requestId }, nextQuota = { version: 1, count: count + 1 }
  const receiptBytes = estimateMoneyDocumentBytes(paths.receipt, receipt)
  if (receiptBytes > LIMITS.receiptBytes) fail('receipt-size-limit')
  const bytes = readBytes + calculated.estimatedMutationBytes + receiptBytes +
    estimateMoneyDocumentBytes(paths.actor, nextActor) + estimateMoneyDocumentBytes(paths.quota, nextQuota)
  if (bytes > LIMITS.transactionBytes || calculated.mutationWriteCount + 3 > LIMITS.writes) fail('transaction-size-limit')
  return { calculated, receipt, nextActor, nextQuota }
}

function snapshotVersions(paths, snapshots) {
  return [...paths].sort().map(path => {
    const snap = snapshots.get(path), time = snap.updateTime
    if (!snap.exists) return [path, null]
    if (!Number.isSafeInteger(time?.seconds) || !Number.isInteger(time?.nanoseconds) || time.nanoseconds < 0 || time.nanoseconds >= 1000000000) fail('missing-document-version')
    return [path, `${time.seconds}:${time.nanoseconds}`]
  })
}

export function executeTeacherAwardService(request, dependencies) {
  return runAward(request, dependencies)
}
export function planTeacherAwardService(request, dependencies) {
  return runAward(request, dependencies, 'plan')
}
export function executePlannedTeacherAwardService(envelope, dependencies) {
  if (!hasExactDataKeys(envelope, ['request', 'plan'])) fail('invalid-plan')
  const { plan } = envelope
  if (!hasExactDataKeys(plan, ['protocolVersion', 'projectId', 'classroomId', 'teacherUid', 'digest', 'createdAt', 'expiresAt', 'versions']) ||
      plan.protocolVersion !== 1 || !Number.isSafeInteger(plan.createdAt) || !Number.isSafeInteger(plan.expiresAt) ||
      plan.expiresAt !== plan.createdAt + 60000 || !Array.isArray(plan.versions) || plan.versions.length > 205 ||
      Buffer.byteLength(JSON.stringify(envelope), 'utf8') > LIMITS.requestBytes) fail('invalid-plan')
  // Snapshot untrusted transport data once. Versions confer no authority; all
  // identity, money, capacity and receipt checks still execute on current state.
  return runAward(envelope.request, dependencies, 'planned', globalThis.structuredClone(plan))
}

function recoveryReceipt(data, identity, id) {
  const common = ['version', 'actorUid', 'requestId', 'generation', 'status', 'serverTime']
  const keys = data?.status === 'cancelled' ? common : [...common, 'digest', 'action', 'itemCount', 'ledgerIds', 'acknowledged']
  if (!hasExactDataKeys(data, keys) || data.actorUid !== identity.teacherUid || data.requestId !== id ||
      !isControlGeneration(data.generation) || !validTime(data.serverTime)) fail('invalid-receipt')
  if (data.status === 'cancelled') {
    if (data.version !== 1) fail('invalid-receipt')
    return data
  }
  if (data.status !== 'committed' || ![1, 2].includes(data.version) || !['award', 'deduct'].includes(data.action) ||
      typeof data.acknowledged !== 'boolean' || typeof data.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.digest) ||
      !Number.isInteger(data.itemCount) || data.itemCount < 1 || data.itemCount > LIMITS.targets) fail('invalid-receipt')
  let mapping = data.ledgerIds
  if (data.version === 2) {
    if (typeof mapping !== 'string' || !mapping.startsWith('b36:1:') || mapping.length > 2405) fail('invalid-receipt')
    mapping = mapping.slice(6).split(',').map(pair => {
      const words = pair.split(':')
      if (words.length !== 2) fail('invalid-receipt')
      const numbers = words.map(word => {
        const value = Number.parseInt(word, 36)
        if (!Number.isSafeInteger(value) || value <= 0 || value.toString(36) !== word) fail('invalid-receipt')
        return value
      })
      return { targetId: numbers[0], ledgerId: numbers[1] }
    })
  }
  if (!Array.isArray(mapping) || mapping.length !== data.itemCount || mapping.some((row, index) =>
    !hasExactDataKeys(row, ['targetId', 'ledgerId']) || !Number.isSafeInteger(row.targetId) || row.targetId <= 0 ||
    !Number.isSafeInteger(row.ledgerId) || row.ledgerId <= 0 || (index > 0 && mapping[index - 1].targetId >= row.targetId))) fail('invalid-receipt')
  const expected = deriveMoneyLedgerIds({ ...identity, protocolVersion: 1, requestId: id, action: data.action }, mapping.map(row => row.targetId))
  if (!expected.every((row, index) => row.ledgerId === mapping[index].ledgerId)) fail('invalid-receipt')
  return data
}

// Metadata-only recovery. Expected classroom binding prevents an old marker from
// being interpreted in a newly rebound classroom. No input payload is retained.
export async function recoverTeacherAwardService(input, { firestore, auth, projectId, now = () => new Date().toISOString() } = {}) {
  if (!hasExactDataKeys(input, ['protocolVersion', 'classroomId', 'requestId', 'operation']) || input.protocolVersion !== 1 ||
      !['status', 'acknowledge', 'cancel'].includes(input.operation) ||
      !(requestId(input.requestId) || (input.operation === 'status' && input.requestId === null))) fail('invalid-recovery')
  validateCanonicalDocumentId(projectId); validateCanonicalDocumentId(input.classroomId)
  const wire = { ...input }
  return firestore.runTransaction(async transaction => {
    const foundation = await readTeacherClassroomAccess({ transaction, firestore, auth, policy: { operation: 'recovery' } })
    if (foundation.classroomId !== wire.classroomId) fail('invalid-recovery')
    const identity = { projectId, teacherUid: foundation.teacherUid, classroomId: foundation.classroomId }
    const rootPaths = teacherAwardPaths(identity.classroomId, identity.teacherUid, wire.requestId ?? '0'.repeat(32))
    const actor = actorState((await transaction.get(firestore.doc(rootPaths.actor))).data(), identity.teacherUid)
    const count = receiptCount((await transaction.get(firestore.doc(rootPaths.quota))).data())
    const id = wire.requestId ?? actor.unacknowledgedRequestId
    const unconfirmed = { protocolVersion: 1, requestId: id, status: 'unconfirmed', requiresRefresh: false }
    if (id === null) return unconfirmed
    const paths = teacherAwardPaths(identity.classroomId, identity.teacherUid, id)
    const snap = await transaction.get(firestore.doc(paths.receipt))
    if (snap.exists) {
      const receipt = recoveryReceipt(snap.data(), identity, id)
      if (estimateMoneyDocumentBytes(paths.receipt, receipt) > LIMITS.receiptBytes || count < 1 ||
          (receipt.status === 'committed' && ((!receipt.acknowledged && actor.unacknowledgedRequestId !== id) ||
          (receipt.acknowledged && actor.unacknowledgedRequestId === id))) ||
          (receipt.status === 'cancelled' && actor.unacknowledgedRequestId === id)) fail('invalid-receipt-state')
      if (receipt.status === 'cancelled') {
        if (wire.operation === 'acknowledge') fail('request-cancelled')
        return { protocolVersion: 1, requestId: id, status: 'cancelled', action: 'cancel', itemCount: 0, serverTime: receipt.serverTime, requiresRefresh: false }
      }
      if (wire.operation === 'acknowledge' && !receipt.acknowledged) {
        transaction.update(firestore.doc(paths.receipt), { ...receipt, acknowledged: true })
        transaction.update(firestore.doc(paths.actor), { ...actor, unacknowledgedRequestId: null })
        return reply({ ...receipt, acknowledged: true }, count)
      }
      return reply(receipt, count)
    }
    if (actor.unacknowledgedRequestId === id) fail('invalid-receipt-state')
    if (wire.operation === 'status') return unconfirmed
    if (wire.operation === 'acknowledge') fail('unconfirmed-request')
    if (count >= LIMITS.receipts) fail('receipt-quota-exhausted')
    const serverTime = now()
    if (!validTime(serverTime)) fail('invalid-clock')
    const receipt = { version: 1, actorUid: identity.teacherUid, requestId: id, generation: foundation.control.generation, status: 'cancelled', serverTime }
    if (estimateMoneyDocumentBytes(paths.receipt, receipt) > LIMITS.receiptBytes) fail('receipt-size-limit')
    transaction.create(firestore.doc(paths.receipt), receipt)
    transaction.update(firestore.doc(paths.quota), { version: 1, count: count + 1 })
    return { protocolVersion: 1, requestId: id, status: 'cancelled', action: 'cancel', itemCount: 0, serverTime, requiresRefresh: false }
  })
}
