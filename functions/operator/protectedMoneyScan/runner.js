import { PROJECTION_DEFAULTS } from './projectionDefaults.js'
import { performance } from 'node:perf_hooks'
import { setTimeout, clearTimeout } from 'node:timers'
import { Buffer } from 'node:buffer'
import { analyzeRoom } from '../../phase3/moneyCompatibility.js'
import { requireClassroomControl } from '../../phase3/classroomAccess.js'
import { projectClassroomData, PROJECTION_CATEGORIES } from '../../../src/phase3/tenantDataProjection.js'
import { DEMO_PROJECT, LIMITS, ScanAbort, fail, hash, same, compare, id, digest, exact, copyData, freeze, timestamp, abortSummary } from './common.js'

const PLAN_KEYS = ['kind', 'projectId', 'databaseId', 'runId', 'sourceCommit', 'notBefore', 'expiresAt', 'rooms', 'canaryClassroomId']
const OWNER_MASK = Object.freeze(['uid', 'status', 'classroomId'])
const ROOT_MASK = Object.freeze(['ownerUid', 'classroomId', 'accessControl'])
const FIXED_PROJECTION = new Set(Object.values(PROJECTION_CATEGORIES))
export function copyScanPlan(input) {
  // Hard stop before reading dependency properties or constructing transport.
  if (!exact(input, PLAN_KEYS)) fail('invalid-plan')
  if (input.projectId !== DEMO_PROJECT) fail('live-unavailable')
  const plan = copyData(input)
  if (plan.kind !== 'protected-money-scan-rehearsal' || plan.databaseId !== '(default)' || !id(plan.runId) ||
      !/^[a-f0-9]{40}$/.test(plan.sourceCommit) || !Number.isSafeInteger(plan.notBefore) ||
      !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= plan.notBefore ||
      plan.expiresAt - plan.notBefore > LIMITS.authorizationMs || !Array.isArray(plan.rooms) ||
      plan.rooms.length < 1 || plan.rooms.length > LIMITS.classrooms) fail('invalid-plan')
  const owners = new Set()
  plan.rooms.forEach((room, index) => {
    if (!exact(room, ['classroomId', 'ownerUid', 'allowSuspended']) || !id(room.classroomId) || !id(room.ownerUid) ||
        typeof room.allowSuspended !== 'boolean' || owners.has(room.ownerUid) ||
        (index && compare(plan.rooms[index - 1].classroomId, room.classroomId) >= 0)) fail('scope')
    owners.add(room.ownerUid)
  })
  if (!plan.rooms.some(room => room.classroomId === plan.canaryClassroomId)) fail('scope')
  return freeze(plan)
}
function entryRecord(raw, planDigest, startedAt) {
  if (!exact(raw, ['kind', 'planDigest', 'startedAt', 'stateDigest', 'throughSequence']) ||
      raw.kind !== 'fictional-observer-entry' || raw.planDigest !== planDigest || raw.startedAt !== startedAt ||
      !digest(raw.stateDigest) || !Number.isSafeInteger(raw.throughSequence) || raw.throughSequence < 0) fail('continuity')
  return freeze(copyData(raw))
}
function exitRecord(raw, entry, boundary) {
  if (!exact(raw, ['kind', 'entryDigest', 'evidenceDigest', 'completedAt', 'coveredThrough', 'throughSequence', 'changes', 'complete']) ||
      raw.kind !== 'fictional-observer-exit' || raw.entryDigest !== hash(entry) || raw.evidenceDigest !== boundary.evidenceDigest ||
      raw.completedAt !== boundary.completedAt || !Number.isSafeInteger(raw.coveredThrough) || raw.coveredThrough < boundary.completedAt ||
      !Number.isSafeInteger(raw.throughSequence) || raw.throughSequence < entry.throughSequence || raw.complete !== true ||
      !Array.isArray(raw.changes) || raw.changes.length !== 0) fail('continuity')
  return freeze(copyData(raw))
}

// Trusted dependency seams are FICTIONAL rehearsals, not provenance/IAM proof.
// This entrypoint can never select production. No external evidence file/flag can
// unlock it; real collectors and approved human-only launcher do not exist yet.
export async function runProtectedMoneyScan(input, dependencies) {
  let publicationAttempted = false
  let settled = false, receiptVerified = false
  try {
    const plan = copyScanPlan(input), planDigest = hash(plan)
    const { reader, observer, publisher, clock = () => Date.now(), monotonic = () => performance.now() } = dependencies
    if (reader?.projectId !== DEMO_PROJECT || reader.databaseId !== '(default)' || reader.kind !== 'loopback-read-only' ||
        typeof reader.listPage !== 'function' || typeof reader.get !== 'function' ||
        observer?.kind !== 'fictional-interval-observer' || typeof observer.begin !== 'function' ||
        typeof observer.finish !== 'function' || typeof observer.hold !== 'function' ||
        typeof publisher?.publish !== 'function') fail('authorization')
    const startedAt = clock(), startTick = monotonic()
    let lastWall = startedAt, lastTick = startTick
    function guard() {
      const now = clock(), tick = monotonic()
      if (!Number.isSafeInteger(now) || !Number.isFinite(tick) || now < lastWall || tick < lastTick) fail('clock')
      if (now < plan.notBefore || now >= plan.expiresAt || now - startedAt >= LIMITS.runMs || tick - startTick >= LIMITS.runMs) fail('expired')
      lastWall = now; lastTick = tick
      return now
    }
    async function call(action, category = 'transport') {
      guard()
      const timeoutMs = Math.max(1, Math.min(plan.expiresAt - lastWall, LIMITS.runMs - (lastTick - startTick), 30000))
      let timer
      try {
        const result = await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ScanAbort('expired')), timeoutMs)
        })])
        guard(); return result
      } catch (error) { if (error instanceof ScanAbort) throw error; fail(category) }
      finally { clearTimeout(timer) }
    }
    guard()
    const entry = entryRecord(await call(() => observer.begin({ planDigest, startedAt }), 'continuity'), planDigest, startedAt)
    const budget = { bytes: 0, nodes: 0 }, versions = [], collections = []
    let documentCount = 0
    function checkCollection(path) {
      if (path === 'classrooms') return
      if (!plan.rooms.some(room => ['students', 'transactions'].some(name => path === `classrooms/${room.classroomId}/${name}`))) fail('scope')
    }
    function checkPath(path) {
      if (!plan.rooms.some(room => path === `teachers/${room.ownerUid}` || path === `classrooms/${room.classroomId}` ||
          path === `classrooms/${room.classroomId}/studentDisplay/rent` || ['students', 'transactions'].some(name => {
            const prefix = `classrooms/${room.classroomId}/${name}/`;return path.startsWith(prefix) && id(path.slice(prefix.length))
          }))) fail('scope')
    }
    async function names(path) {
      checkCollection(path)
      const found = [], tokens = new Set(); let token = ''
      do {
        const page = copyData(await call(() => reader.listPage(path, token)), budget)
        if (!exact(page, ['documents', 'nextPageToken']) || !Array.isArray(page.documents) || page.documents.length > LIMITS.pageSize ||
            typeof page.nextPageToken !== 'string' || page.nextPageToken.length > 4096) fail('transport')
        for (const item of page.documents) {
          if (!exact(item, ['path', 'exists']) || typeof item.path !== 'string' || typeof item.exists !== 'boolean' ||
              !item.path.startsWith(path + '/') || !id(item.path.slice(path.length + 1)) ||
              (found.length && compare(found.at(-1), item.path) >= 0)) fail('scope')
          if (!item.exists) fail('foundation')
          found.push(item.path)
          if (found.length > (path === 'classrooms' ? LIMITS.classrooms : LIMITS.documents)) fail('budget')
        }
        token = page.nextPageToken
        if (token && (!page.documents.length || tokens.has(token))) fail('transport')
        tokens.add(token)
      } while (token)
      return found
    }
    async function get(path, fields = null, retain = false) {
      checkPath(path)
      const row = copyData(await call(() => reader.get(path, fields)), budget)
      if (!exact(row, ['path', 'exists', 'createVersion', 'updateVersion', 'data']) || row.path !== path || typeof row.exists !== 'boolean') fail('transport')
      if (!row.exists) {
        if (row.data !== null || row.createVersion !== null || row.updateVersion !== null) fail('transport')
      } else {
        timestamp(row.createVersion);timestamp(row.updateVersion)
        if (compareVersion(row.createVersion, row.updateVersion) > 0 || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) fail('transport')
        if (fields && Object.keys(row.data).some(key => !fields.includes(key))) fail('transport')
      }
      const version = { path, exists: row.exists, createVersion: row.createVersion, updateVersion: row.updateVersion }
      if (retain) {
        if (++documentCount > LIMITS.documents) fail('budget')
        versions.push(version)
      }
      return { ...row, id: path.split('/').at(-1), version }
    }
    // Inventory stage checks metadata/foundations for ALL rooms before money.
    const rootNames = await names('classrooms')
    if (!same(rootNames, plan.rooms.map(room => `classrooms/${room.classroomId}`))) fail('scope')
    collections.push({ path: 'classrooms', paths: rootNames })
    const inventory = []
    for (const scope of plan.rooms) {
      const root = await get(`classrooms/${scope.classroomId}`, ROOT_MASK)
      const owner = await get(`teachers/${scope.ownerUid}`, OWNER_MASK, true)
      if (!root.exists || !owner.exists || root.data.ownerUid !== scope.ownerUid ||
          (root.data.classroomId !== undefined && root.data.classroomId !== scope.classroomId) ||
          !exact(owner.data, OWNER_MASK) || owner.data.uid !== scope.ownerUid || owner.data.status !== 'active' || owner.data.classroomId !== scope.classroomId) fail('foundation')
      if (root.data.accessControl?.mode === 'suspended' && !scope.allowSuspended) fail('authorization')
      inventory.push({ scope, root })
    }
    const findings = [], capacities = [], rooms = []
    const issue = (severity, reason, row, mirrorIndex) => {
      if (findings.length >= LIMITS.findings) fail('budget')
      findings.push({ severity, reason, path: row.path, updateVersion: row.updateVersion,
        ...(mirrorIndex === undefined ? {} : { mirrorIndex }) })
    }
    async function collection(path) {
      const paths = await names(path), rows = []
      collections.push({ path, paths })
      for (const path of paths) {
        const row = await get(path, null, true)
        if (!row.exists) fail('drift')
        rows.push(row)
      }
      return rows
    }
    for (const { scope, root: prior } of inventory) {
      const root = await get(prior.path, null, true)
      if (!same(prior.version, root.version)) fail('drift')
      const start = findings.length
      if (Object.hasOwn(root.data, 'accessControl')) {
        try { requireClassroomControl(root.data.accessControl) } catch { issue('blocker', 'classroom-control-shape', root) }
      }
      const students = await collection(`${root.path}/students`), ledger = await collection(`${root.path}/transactions`)
      const rent = await get(`${root.path}/studentDisplay/rent`, null, true)
      capacities.push(...analyzeRoom(root, students, ledger, issue))
      try {
        // Same defaults as the actual index.html teacher-loader call site.
        projectClassroomData({ classroomId: scope.classroomId, root: root.data, students: students.map(row => row.data),
          transactions: ledger.map(row => row.data), studentRent: rent.data, loginHistory: [], defaultSettings: PROJECTION_DEFAULTS })
      } catch (error) {
        issue('blocker', `projection-${FIXED_PROJECTION.has(error?.category) ? error.category : 'shape'}`, root)
      }
      rooms.push({ path: root.path, studentCount: students.length, ledgerCount: ledger.length,
        pendingCount: ledger.filter(row => row.data.status === 'Pending').length,
        blocked: findings.slice(start).some(f => f.severity === 'blocker') })
    }
    for (const collection of collections) if (!same(await names(collection.path), collection.paths)) fail('drift')
    for (const version of versions) if (!same((await get(version.path, [])).version, version)) fail('drift')
    const evidence = { planDigest, collections, versions, rooms, findings, capacities }
    const completedAt = guard(), boundary = freeze({ evidenceDigest: hash(evidence), completedAt })
    const exit = exitRecord(await call(() => observer.finish({ entry, boundary }), 'continuity'), entry, boundary)
    if (exit.coveredThrough > guard()) fail('continuity')
    const reasonCounts = {}
    for (const finding of findings) reasonCounts[finding.reason] = (reasonCounts[finding.reason] ?? 0) + 1
    const summary = freeze({ status: 'complete', totalsIncludeFictionalCanary: true,
      classroomCount: rooms.length, studentCount: rooms.reduce((n, r) => n + r.studentCount, 0),
      ledgerCount: rooms.reduce((n, r) => n + r.ledgerCount, 0), pendingCount: rooms.reduce((n, r) => n + r.pendingCount, 0),
      blockedClassroomCount: rooms.filter(r => r.blocked).length, reasonCounts,
      initializationAllowed: false, activationAllowed: false })
    const manifest = { kind: 'protected-money-scan-rehearsal-result', projectId: DEMO_PROJECT, databaseId: '(default)',
      runId: plan.runId, sourceCommit: plan.sourceCommit, startedAt, completedAt, entry, exit,
      observerDigest: hash(exit), ...evidence, summary, artifactAccepted: false, productionEligible: false, initializationAllowed: false, activationAllowed: false }
    const contents = JSON.stringify(manifest)
    if (Buffer.byteLength(contents) > LIMITS.reportBytes) fail('budget')
    // Trusted fictional observer holds publication across async storage. A flag in
    // a data file cannot implement this interface or authorize a production run.
    const result = await call(() => observer.hold(exit, async () => {
      // A timed-out hold can invoke this later; returning a terminal result
      // permanently closes admission to new publication attempts.
      if (settled) fail('expired')
      guard()
      publicationAttempted = true
      const receipt = await publisher.publish({ runId: plan.runId, contents, digest: hash(contents) })
      guard()
      if (!exact(receipt, ['digest', 'durable']) || receipt.digest !== hash(contents) || receipt.durable !== true) fail('storage')
      receiptVerified = true
      return true
    }), 'storage')
    if (result !== true || !receiptVerified) fail('continuity')
    settled = true
    return summary
  } catch (error) {
    settled = true
    return abortSummary(error, publicationAttempted)
  }
}
function compareVersion(a, b) { return a[0] - b[0] || a[1] - b[1] }
