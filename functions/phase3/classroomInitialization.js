import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { hasExactDataKeys } from './classroomAccess.js'
import { validateCanonicalDocumentId } from '../phase2b/identityNormalization.js'

// Deliberately unreachable from deployed exports and incapable of selecting a
// real project. This is a foundation-only REHEARSAL, not a production cutover.
export const INITIALIZATION_DEMO_PROJECT = 'demo-morgan-bank-classroom-init'
const KIND = 'classroom-initialization-rehearsal'
const MAX_ROOMS = 100
const PAGE_SIZE = 25
const PLAN_KEYS = ['kind', 'projectId', 'databaseId', 'operationId', 'changedAt', 'rows', 'scopeDigest']
const ROW_KEYS = ['classroomId', 'ownerUid', 'rootVersion', 'ownerVersion']

export class ClassroomInitializationError extends Error {
  constructor(category) {
    super('Classroom initialization rehearsal is unavailable.')
    this.name = 'ClassroomInitializationError'
    this.category = category
  }
}
const fail = category => { throw new ClassroomInitializationError(category) }
async function safe(action) {
  try { return await action() } catch (error) {
    if (error instanceof ClassroomInitializationError) throw error
    // No SDK data, paths, credential errors, cause or input values in diagnostics.
    throw new ClassroomInitializationError(error?.code === 10 ? 'retryable-conflict' : 'rehearsal-failed')
  }
}
function bind(firestore, projectId, environment) {
  if (projectId !== INITIALIZATION_DEMO_PROJECT ||
      environment?.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' ||
      firestore?.projectId !== projectId || firestore.databaseId !== '(default)') fail('rehearsal-only')
}
function id(value) {
  try { return validateCanonicalDocumentId(value) } catch { return fail('invalid-plan') }
}
function version(value) {
  if (!Number.isSafeInteger(value?.seconds) || value.seconds < 0 ||
      !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds >= 1e9) fail('invalid-version')
  return [value.seconds, value.nanoseconds]
}
function versionTuple(value) {
  if (!Array.isArray(value) || value.length !== 2 || Object.keys(value).length !== 2) fail('invalid-plan')
  return version({ seconds: value[0], nanoseconds: value[1] })
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
const compareIds = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid-plan')
  return value
}
function digest(plan) {
  return createHash('sha256').update(JSON.stringify([
    KIND, plan.projectId, plan.databaseId, plan.operationId, plan.changedAt,
    plan.rows.map(row => [row.classroomId, row.ownerUid, row.rootVersion, row.ownerVersion]),
  ])).digest('hex')
}
function freeze(plan) {
  for (const row of plan.rows) {
    Object.freeze(row.rootVersion); Object.freeze(row.ownerVersion); Object.freeze(row)
  }
  Object.freeze(plan.rows)
  return Object.freeze(plan)
}
function validatePlan(input) {
  if (!hasExactDataKeys(input, PLAN_KEYS) || input.kind !== KIND || input.projectId !== INITIALIZATION_DEMO_PROJECT ||
      input.databaseId !== '(default)' || typeof input.operationId !== 'string' || !/^[a-f0-9]{32}$/.test(input.operationId) ||
      !Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > MAX_ROOMS ||
      Object.keys(input.rows).length !== input.rows.length) fail('invalid-plan')
  const rows = []
  for (const row of input.rows) {
    if (!hasExactDataKeys(row, ROW_KEYS)) fail('invalid-plan')
    rows.push({ classroomId: id(row.classroomId), ownerUid: id(row.ownerUid),
      rootVersion: versionTuple(row.rootVersion), ownerVersion: versionTuple(row.ownerVersion) })
  }
  if (rows.some((row, index) => index > 0 && compareIds(rows[index - 1].classroomId, row.classroomId) >= 0) ||
      new Set(rows.map(row => row.ownerUid)).size !== rows.length) fail('invalid-plan')
  const plan = { kind: KIND, projectId: input.projectId, databaseId: '(default)', operationId: input.operationId,
    changedAt: instant(input.changedAt), rows, scopeDigest: input.scopeDigest }
  if (plan.scopeDigest !== digest(plan)) fail('invalid-plan')
  return freeze(plan) // Detached immutable snapshot, not the caller's mutable plan.
}
const rootPath = row => `classrooms/${row.classroomId}`
const auditPath = (plan, row) => `${rootPath(row)}/accessControlAudits/${plan.operationId}`
const runPath = plan => `classroomInitializationRuns/${plan.operationId}`
const control = plan => ({ schemaVersion: 1, mode: 'readOnly', generation: 1, changedAt: plan.changedAt, auditId: plan.operationId })
const header = (plan, completedCount) => ({ kind: KIND, projectId: plan.projectId, scopeDigest: plan.scopeDigest,
  operationId: plan.operationId, changedAt: plan.changedAt, classroomCount: plan.rows.length, completedCount })
const auditBody = (plan, row) => ({ kind: KIND, schemaVersion: 1, operationId: plan.operationId,
  scopeDigest: plan.scopeDigest, classroomId: row.classroomId, ownerUid: row.ownerUid,
  rootVersion: row.rootVersion, ownerVersion: row.ownerVersion, control: control(plan) })
function equalObject(actual, expected, category) {
  if (!hasExactDataKeys(actual, Object.keys(expected)) ||
      Object.keys(expected).some(key => !same(actual[key], expected[key]))) fail(category)
}

// listDocuments includes missing parents with descendants. Query pagination alone
// would silently omit those phantom classrooms. The two passes still require a
// real external write fence for future production use; they are NOT proof of one.
async function namespace(firestore) {
  const refs = await firestore.collection('classrooms').listDocuments()
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > MAX_ROOMS) fail('inventory-limit')
  const ids = refs.map(ref => {
    const value = id(ref.id)
    if (ref.path !== `classrooms/${value}`) fail('inventory-incomplete')
    return value
  }).sort(compareIds)
  if (new Set(ids).size !== ids.length) fail('inventory-incomplete')
  return ids
}
async function roots(transaction, firestore) {
  const found = []
  let cursor
  while (true) {
    let query = firestore.collection('classrooms').orderBy('__name__').limit(PAGE_SIZE)
    if (cursor) query = query.startAfter(cursor)
    const page = await transaction.get(query)
    if (!Array.isArray(page.docs) || page.docs.length > PAGE_SIZE) fail('inventory-incomplete')
    for (const doc of page.docs) {
      if (!doc.exists || doc.ref.path !== `classrooms/${id(doc.id)}` ||
          (found.length && compareIds(found.at(-1).id, doc.id) >= 0)) fail('inventory-incomplete')
      found.push(doc)
      if (found.length > MAX_ROOMS) fail('inventory-limit')
    }
    if (page.docs.length < PAGE_SIZE) return found
    cursor = page.docs.at(-1)
  }
}
function foundation(root, owner, row) {
  const teacher = owner.exists ? owner.data() : null
  if (!root.exists || root.data()?.ownerUid !== row.ownerUid || teacher?.uid !== row.ownerUid ||
      teacher.status !== 'active' || teacher.classroomId !== row.classroomId) fail('foundation-conflict')
  if (!same(version(owner.updateTime), row.ownerVersion)) fail('version-conflict')
}

export async function planClassroomInitializationRehearsal({ firestore, projectId, operationId,
  clock = () => new Date().toISOString(), environment = process.env }) {
  return safe(async () => {
    bind(firestore, projectId, environment)
    if (typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId)) fail('invalid-plan')
    const changedAt = instant(clock())
    const before = await namespace(firestore)
    const plan = await firestore.runTransaction(async transaction => {
      const found = await roots(transaction, firestore)
      if (!same(found.map(doc => doc.id), before)) fail('inventory-incomplete')
      const rows = []
      for (const root of found) {
        const ownerUid = id(root.data()?.ownerUid)
        const row = { classroomId: root.id, ownerUid, rootVersion: version(root.updateTime) }
        const owner = await transaction.get(firestore.doc(`teachers/${ownerUid}`))
        if (!owner.exists) fail('foundation-conflict')
        row.ownerVersion = version(owner.updateTime)
        foundation(root, owner, row)
        if (Object.hasOwn(root.data(), 'accessControl')) fail('existing-control')
        const priorAudits = await transaction.get(firestore.collection(`${rootPath(row)}/accessControlAudits`).limit(1))
        if (priorAudits.docs.length) fail('journal-conflict')
        rows.push(row)
      }
      const result = { kind: KIND, projectId, databaseId: '(default)', operationId, changedAt, rows }
      result.scopeDigest = digest(result)
      if ((await transaction.get(firestore.doc(runPath(result)))).exists) fail('journal-conflict')
      return validatePlan(result)
    }, { readOnly: true })
    if (!same(await namespace(firestore), before)) fail('inventory-incomplete')
    return plan // Restricted local artifact: IDs/versions only, no classroom contents.
  })
}

// Read every foundation and journal before EACH write transaction. This stops
// the whole rehearsal on any drift, not just when the changed room is reached.
async function inspect(transaction, firestore, plan) {
  const found = await roots(transaction, firestore)
  if (!same(found.map(doc => doc.id), plan.rows.map(row => row.classroomId))) fail('inventory-incomplete')
  const run = await transaction.get(firestore.doc(runPath(plan)))
  const completed = []
  for (const [index, row] of plan.rows.entries()) {
    const root = found[index]
    const owner = await transaction.get(firestore.doc(`teachers/${row.ownerUid}`))
    foundation(root, owner, row)
    const audits = await transaction.get(firestore.collection(`${rootPath(row)}/accessControlAudits`).limit(2))
    if (audits.docs.length > 1 || (audits.docs.length === 1 && audits.docs[0].id !== plan.operationId)) fail('journal-conflict')
    const witness = audits.docs[0] ?? { exists: false }
    const data = root.data()
    if (!Object.hasOwn(data, 'accessControl')) {
      if (witness.exists || !same(version(root.updateTime), row.rootVersion)) fail('version-conflict')
      continue
    }
    if (!run.exists || !witness.exists) fail('journal-conflict')
    equalObject(data.accessControl, control(plan), 'control-conflict')
    const audit = witness.data()
    equalObject(audit, auditBody(plan, row), 'journal-conflict')
    // Database-assigned update versions of the atomic pair, not a transform
    // timestamp (REQUEST_TIME can have different precision from updateTime).
    if (!same(version(root.updateTime), version(witness.updateTime))) fail('version-conflict')
    completed.push(row.classroomId)
  }
  if (run.exists) equalObject(run.data(), header(plan, completed.length), 'journal-conflict')
  else if (completed.length) fail('journal-conflict')
  return { runExists: run.exists, completed }
}

export async function initializeClassroomControlsRehearsal({ firestore, projectId, plan: input, environment = process.env }) {
  return safe(async () => {
    bind(firestore, projectId, environment)
    const plan = validatePlan(input)
    const ids = plan.rows.map(row => row.classroomId)
    const checkNamespace = async () => { if (!same(await namespace(firestore), ids)) fail('inventory-incomplete') }
    await checkNamespace()
    await firestore.runTransaction(async transaction => {
      const state = await inspect(transaction, firestore, plan)
      if (!state.runExists) transaction.create(firestore.doc(runPath(plan)), header(plan, 0))
    })
    for (const row of plan.rows) {
      await checkNamespace()
      await firestore.runTransaction(async transaction => {
        const state = await inspect(transaction, firestore, plan)
        if (!state.runExists) fail('journal-conflict')
        if (state.completed.includes(row.classroomId)) return
        transaction.update(firestore.doc(rootPath(row)), { accessControl: control(plan) })
        transaction.create(firestore.doc(auditPath(plan, row)), auditBody(plan, row))
        transaction.update(firestore.doc(runPath(plan)), header(plan, state.completed.length + 1))
      })
    }
    await checkNamespace()
    const state = await firestore.runTransaction(transaction => inspect(transaction, firestore, plan), { readOnly: true })
    if (state.completed.length !== plan.rows.length) fail('journal-conflict')
    await checkNamespace()
    return Object.freeze({ kind: KIND, classroomCount: plan.rows.length, completedCount: state.completed.length,
      mode: 'readOnly', productionEligible: false, activationAllowed: false })
  })
}
