import { estimateMoneyDocumentBytes as estimateDocumentBytes, MoneyDocumentSizeError } from './moneyDocumentSize.js'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { hasExactDataKeys } from './classroomAccess.js'
import { validateCanonicalDocumentId } from '../phase2b/identityNormalization.js'
import { storedMoneyToCents, TEACHER_MONEY_LIMITS } from './teacherMoneyContract.js'

// Read-only, dormant advisory rehearsal. No SDK creation, callable or live override.
export const MONEY_COMPATIBILITY_DEMO_PROJECT = 'demo-morgan-bank-money-compatibility'
const KIND = 'money-compatibility-advisory-rehearsal'
const PAGE_SIZE = 25
const MAX_CLASSROOMS = 100
const MAX_DOCUMENTS = 20_000 // Fail whole scan, never silently return a prefix.
const STUDENT_KEYS = ['id', 'name', 'balance', 'frozen', 'transactions']
const TRANSACTION_KEYS = ['id', 'date', 'studentId', 'studentName', 'type', 'amount', 'reason', 'memo', 'category', 'status', 'source']
const TEXT_KEYS = ['date', 'studentName', 'reason', 'memo', 'category', 'source']
const RESERVED_SOURCES = new Set(['Opening Balance', 'Operator correction'])
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const positiveId = value => Number.isSafeInteger(value) && value > 0
const nonBlank = value => typeof value === 'string' && value.trim().length > 0

export class MoneyCompatibilityError extends Error {
  constructor(category) {
    super('Money compatibility scan is unavailable.')
    this.name = 'MoneyCompatibilityError'
    this.category = category
  }
}
const fail = category => { throw new MoneyCompatibilityError(category) }
function canonicalId(value) {
  try { return validateCanonicalDocumentId(value) } catch { return fail('invalid-scope') }
}
function version(snapshot) {
  const stamp = snapshot.updateTime
  if (!Number.isSafeInteger(stamp?.seconds) || stamp.seconds < 0 || !Number.isInteger(stamp.nanoseconds) ||
      stamp.nanoseconds < 0 || stamp.nanoseconds >= 1e9) fail('invalid-version')
  return [stamp.seconds, stamp.nanoseconds]
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function inDomain(value, positive = false) {
  try { const cents = storedMoneyToCents(value); return !positive || cents > 0 } catch { return false }
}

// Compatibility export preserves the existing scanner error contract.
export function estimateMoneyDocumentBytes(path, value) {
  try { return estimateDocumentBytes(path, value) } catch (error) {
    if (error instanceof MoneyDocumentSizeError) fail('unsupported-encoding')
    throw error
  }
}

function transactionShape(data) {
  return hasExactDataKeys(data, TRANSACTION_KEYS) && positiveId(data.id) && positiveId(data.studentId) &&
    TEXT_KEYS.every(key => typeof data[key] === 'string') && ['date', 'studentName', 'source'].every(key => nonBlank(data[key])) &&
    ['Add', 'Subtract'].includes(data.type) && ['Pending', 'Approved', 'Denied'].includes(data.status) &&
    typeof data.amount === 'number' && Number.isFinite(data.amount) && data.amount > 0
}
function transactionEqual(a, b) {
  return TRANSACTION_KEYS.every(key => a[key] === b[key])
}

// Pure analysis shared by the separate operator rehearsal; performs no I/O.
export function analyzeRoom(room, students, ledger, issue) {
  const capacities = []
  if (students.length > TEACHER_MONEY_LIMITS.targets) issue('warning', 'roster-requires-explicit-batches', room)
  const root = room.data
  // Projection and studentMoney treat null/missing settings as defaults. Other
  // present containers must be plain data maps, not strings, scalars or arrays.
  const settings = root.settings ?? {}
  const validSettings = hasExactDataKeys(settings, Object.keys(settings))
  if (!validSettings) issue('blocker', 'category-settings-shape', room)
  for (const key of validSettings ? ['addMoneyCategories', 'subtractMoneyCategories'] : []) {
    const categories = settings[key]
    if (categories !== undefined && (!Array.isArray(categories) || categories.some(item => typeof item !== 'string'))) {
      issue('blocker', 'category-settings-shape', room)
    } else if (categories?.some(item => item === 'Balance adjustment' || RESERVED_SOURCES.has(item))) {
      issue('blocker', 'reserved-category-setting', room)
    }
  }
  const studentIds = new Set(students.map(row => row.id))
  const byId = new Map(), byStudent = new Map()
  function checkAmount(row, data, mirrorIndex) {
    if (!inDomain(data.amount, true)) {
      issue(data.status === 'Pending' ? 'blocker' : 'legacy-only',
        data.status === 'Pending' ? 'pending-amount-out-of-domain' : 'historical-amount-legacy-only', row, mirrorIndex)
    }
    if (RESERVED_SOURCES.has(data.source) || (data.category === 'Balance adjustment' && data.source !== 'Teacher')) {
      issue('blocker', 'reserved-source-category', row, mirrorIndex)
    }
  }
  for (const row of ledger) {
    const data = row.data
    if (!transactionShape(data) || String(data.id) !== row.id) {
      issue('blocker', 'ledger-shape-or-id', row); continue
    }
    if (byId.has(data.id)) issue('blocker', 'duplicate-ledger-id', row)
    byId.set(data.id, row)
    if (!byStudent.has(data.studentId)) byStudent.set(data.studentId, new Map())
    byStudent.get(data.studentId).set(data.id, row)
    checkAmount(row, data)
    if (!studentIds.has(String(data.studentId))) {
      // Removal intentionally retains ledger history. Pending without a current
      // student cannot be decided; Approved/Denied history need not be invented.
      issue(data.status === 'Pending' ? 'blocker' : 'warning',
        data.status === 'Pending' ? 'pending-student-absent' : 'historical-student-absent', row)
    }
    try {
      if (estimateMoneyDocumentBytes(row.path, data) > TEACHER_MONEY_LIMITS.studentBytes) issue('blocker', 'ledger-size-limit', row)
    } catch { issue('blocker', 'unsupported-encoding', row) }
  }
  for (const row of students) {
    const data = row.data
    if (!hasExactDataKeys(data, STUDENT_KEYS) || !positiveId(data.id) || String(data.id) !== row.id ||
        !nonBlank(data.name) || typeof data.frozen !== 'boolean' || !Array.isArray(data.transactions)) {
      issue('blocker', 'student-shape-or-id', row); continue
    }
    if (!inDomain(data.balance)) issue('blocker', 'balance-out-of-domain', row)
    const seen = new Set(), authoritative = byStudent.get(data.id) ?? new Map()
    for (let index = 0; index < data.transactions.length; index++) {
      const mirror = data.transactions[index]
      if (!transactionShape(mirror) || mirror.studentId !== data.id) {
        issue('blocker', 'mirror-shape-or-owner', row, index); continue
      }
      checkAmount(row, mirror, index)
      if (seen.has(mirror.id)) issue('blocker', 'duplicate-mirror-id', row, index)
      seen.add(mirror.id)
      const canonical = byId.get(mirror.id)
      if (!canonical || !transactionEqual(mirror, canonical.data)) issue('blocker', 'mirror-ledger-mismatch', row, index)
    }
    if ([...authoritative.keys()].some(id => !seen.has(id))) issue('blocker', 'missing-ledger-mirror', row)
    // Historical names bind mirror to ledger, not to today's roster name.
    const slots = TEACHER_MONEY_LIMITS.mirrorEntries - data.transactions.length
    let bytes = null, headroom = null
    try {
      bytes = estimateMoneyDocumentBytes(row.path, data)
      headroom = TEACHER_MONEY_LIMITS.studentBytes - bytes
      if (headroom < 100 * 1024) issue('blocker', 'student-byte-headroom', row)
      if (bytes >= TEACHER_MONEY_LIMITS.studentBytes * 0.8) issue('warning', 'history-migration-byte-threshold', row)
    } catch { issue('blocker', 'unsupported-encoding', row) }
    if (slots < 100) issue('blocker', 'mirror-slot-headroom', row)
    if (data.transactions.length >= TEACHER_MONEY_LIMITS.mirrorEntries * 0.8) issue('warning', 'history-migration-slot-threshold', row)
    capacities.push({ path: row.path, updateVersion: row.updateVersion, mirrorSlotsRemaining: slots,
      estimatedDocumentBytes: bytes, estimatedByteHeadroom: headroom })
  }
  return capacities
}

export async function scanMoneyCompatibilityRehearsal({ firestore, projectId, classroomIds,
  environment = process.env, clock = () => new Date().toISOString() }) {
  try {
    if (projectId !== MONEY_COMPATIBILITY_DEMO_PROJECT || firestore?.projectId !== projectId ||
        firestore.databaseId !== '(default)' || environment?.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080') fail('rehearsal-only')
    if (!Array.isArray(classroomIds) || classroomIds.length < 1 || classroomIds.length > MAX_CLASSROOMS ||
        Object.keys(classroomIds).length !== classroomIds.length) fail('invalid-scope')
    const scope = classroomIds.map(canonicalId).sort(compare)
    if (new Set(scope).size !== scope.length) fail('invalid-scope')
    const scannedAt = clock()
    if (typeof scannedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(scannedAt) ||
        !Number.isFinite(Date.parse(scannedAt)) || new Date(scannedAt).toISOString() !== scannedAt) fail('invalid-clock')
    const documents = [], collections = []
    const findings = [], capacities = [], classrooms = []
    const issue = (severity, reason, row, mirrorIndex) => {
      if (findings.length >= 100_000) fail('scan-limit')
      findings.push({ severity, reason, path: row.path, updateVersion: row.updateVersion,
        ...(mirrorIndex === undefined ? {} : { mirrorIndex }) })
    }
    async function namespace(path) {
      const refs = await firestore.collection(path).listDocuments()
      if (!Array.isArray(refs) || refs.length > MAX_DOCUMENTS) fail('scan-limit')
      const ids = refs.map(ref => {
        const id = canonicalId(ref.id)
        if (ref.path !== `${path}/${id}`) fail('incomplete-read')
        return id
      }).sort(compare)
      if (new Set(ids).size !== ids.length) fail('incomplete-read')
      return ids
    }
    function snapshotRow(doc, path) {
      if (doc?.exists !== true || doc.ref?.path !== path || doc.id !== path.split('/').at(-1)) fail('incomplete-read')
      return { id: doc.id, path, updateVersion: version(doc), data: doc.data() }
    }
    function retain(row) {
      if (documents.length >= MAX_DOCUMENTS) fail('scan-limit')
      documents.push({ path: row.path, updateVersion: row.updateVersion })
    }
    async function readCollection(path, verify) {
      const before = await namespace(path), rows = []
      let cursor
      while (true) {
        let query = firestore.collection(path).orderBy('__name__').limit(PAGE_SIZE)
        if (cursor) query = query.startAfter(cursor)
        const page = await query.get()
        if (!Array.isArray(page.docs) || page.docs.length > PAGE_SIZE) fail('incomplete-read')
        for (const doc of page.docs) {
          const row = snapshotRow(doc, `${path}/${canonicalId(doc.id)}`)
          if (rows.length && compare(rows.at(-1).id, row.id) >= 0) fail('incomplete-read')
          if (rows.length >= MAX_DOCUMENTS) fail('scan-limit')
          if (!verify) retain(row)
          rows.push(verify ? { id: row.id, path: row.path, updateVersion: row.updateVersion } : row)
        }
        if (page.docs.length < PAGE_SIZE) break
        cursor = page.docs.at(-1)
      }
      if (!equal(rows.map(row => row.id), before) || !equal(before, await namespace(path))) fail('changed-or-incomplete')
      if (verify) {
        if (!equal(rows.map(({ path, updateVersion }) => ({ path, updateVersion })), verify)) fail('changed-since-scan')
      } else collections.push({ path, rows: rows.map(({ path, updateVersion }) => ({ path, updateVersion })) })
      return rows
    }
    const roots = await readCollection('classrooms')
    if (!equal(roots.map(row => row.id), scope)) fail('scope-mismatch')
    const owners = new Set()
    for (const room of roots) {
      const owner = canonicalId(room.data?.ownerUid)
      if (owners.has(owner)) fail('foundation-conflict')
      owners.add(owner)
      const teacher = snapshotRow(await firestore.doc(`teachers/${owner}`).get(), `teachers/${owner}`)
      if (teacher.data?.uid !== owner || teacher.data.status !== 'active' || teacher.data.classroomId !== room.id) fail('foundation-conflict')
      retain(teacher)
      const students = await readCollection(`${room.path}/students`)
      const ledger = await readCollection(`${room.path}/transactions`)
      const start = findings.length
      capacities.push(...analyzeRoom(room, students, ledger, issue))
      classrooms.push({ path: room.path, studentCount: students.length, ledgerCount: ledger.length,
        pendingCount: ledger.filter(row => row.data?.status === 'Pending').length,
        compatibility: findings.slice(start).some(item => item.severity === 'blocker') ? 'blocked' : 'compatible-observed' })
    }
    // Re-enumerate every collection and re-read every version before publishing
    // ANY result. Still advisory: no caller flag can assert an external write fence.
    for (const collection of collections) await readCollection(collection.path, collection.rows)
    for (const owner of owners) {
      const path = `teachers/${owner}`
      const current = snapshotRow(await firestore.doc(path).get(), path)
      if (!equal(current.updateVersion, documents.find(row => row.path === path).updateVersion)) fail('changed-since-scan')
    }
    const reasonCounts = {}
    for (const finding of findings) reasonCounts[finding.reason] = (reasonCounts[finding.reason] ?? 0) + 1
    const summary = { classroomCount: classrooms.length, studentCount: classrooms.reduce((n, room) => n + room.studentCount, 0),
      ledgerCount: classrooms.reduce((n, room) => n + room.ledgerCount, 0), pendingCount: classrooms.reduce((n, room) => n + room.pendingCount, 0),
      blockedClassroomCount: classrooms.filter(room => room.compatibility === 'blocked').length,
      blockerCount: findings.filter(row => row.severity === 'blocker').length,
      legacyOnlyCount: findings.filter(row => row.severity === 'legacy-only').length, reasonCounts }
    const manifest = { kind: KIND, projectId, databaseId: '(default)', scannedAt, classroomIds: scope,
      documents, classrooms, findings, capacities, productionEligible: false, activationAllowed: false }
    const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    return freeze({ summary, restrictedManifest: { ...manifest, digest } })
  } catch (error) {
    if (error instanceof MoneyCompatibilityError) throw error
    throw new MoneyCompatibilityError('scan-failed')
  }
}
