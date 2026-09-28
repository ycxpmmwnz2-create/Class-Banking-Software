import { performance } from 'node:perf_hooks'
import { copyScanPlan } from './runner.js'
import { DEMO_PROJECT, LIMITS, copyData, exact, freeze, hash, same, digest, id, fail } from './common.js'

// These are rehearsal evidence contracts, not claims about Cloud API completeness.
// No production collector exists. This module cannot make one by accepting a flag.
export const MAINTENANCE_SURFACES = Object.freeze(['audit', 'canary', 'credentials', 'iam', 'operators', 'revisions', 'rules', 'triggers', 'writers'])
const ARTIFACTS = ['rules', 'revisions', 'runtime', 'triggers', 'iam', 'recovery', 'credentialVerifier']
const WRITER_KINDS = ['callable', 'trigger', 'revision', 'scheduler', 'task', 'operator', 'transaction']
const PROBES = ['batch', 'rest', 'sdk', 'transaction']
const natural = value => Number.isSafeInteger(value) && value >= 0
const instant = value => natural(value)
function ids(values) {
  return Array.isArray(values) && values.length > 0 && values.length <= 200 &&
    values.every((value, n) => id(value) && (!n || values[n - 1] < value))
}
function cursors(value) {
  return exact(value, MAINTENANCE_SURFACES) && MAINTENANCE_SURFACES.every(key => natural(value[key]))
}
function artifacts(value) { return exact(value, ARTIFACTS) && ARTIFACTS.every(key => digest(value[key])) }

function expectationCopy(raw, plan) {
  const value = copyData(raw)
  if (!exact(value, ['kind', 'projectId', 'databaseId', 'planDigest', 'collectorId', 'maintenanceStartedAt',
    'startCursors', 'artifacts', 'writerInventory', 'priorRulesDigest', 'auditVersions']) ||
      value.kind !== 'fictional-maintenance-expectation' || value.projectId !== DEMO_PROJECT ||
      value.databaseId !== '(default)' || value.planDigest !== hash(plan) || !id(value.collectorId) ||
      !instant(value.maintenanceStartedAt) || value.maintenanceStartedAt > plan.notBefore ||
      plan.expiresAt - value.maintenanceStartedAt > LIMITS.authorizationMs || !cursors(value.startCursors) ||
      !artifacts(value.artifacts) || !digest(value.priorRulesDigest) || value.priorRulesDigest === value.artifacts.rules ||
      !Array.isArray(value.writerInventory) || !ids(value.writerInventory.map(row => row?.id)) ||
      value.writerInventory.some(row => !exact(row, ['id', 'kind']) || !WRITER_KINDS.includes(row.kind)) ||
      !value.writerInventory.some(row => row.id === 'recordStudentBalanceHistoryV3' && row.kind === 'trigger') ||
      !Array.isArray(value.auditVersions) || value.auditVersions.length < 1 || value.auditVersions.length > 10000 ||
      value.auditVersions.some((version, n) => !digest(version) || (n && value.auditVersions[n - 1] >= version))) fail('authorization')
  return freeze(value)
}

// The collector is a trusted fictional capability, separate from the data reader.
// A production implementation must independently establish provenance, coverage,
// IAM and the external fence; this validator supplies none of those by itself.
export function createMaintenanceObserver(input, rawExpectation, dependencies) {
  const plan = copyScanPlan(input) // real-project refusal before dependency access
  const expected = expectationCopy(rawExpectation, plan)
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) fail('authorization')
  const { collector, clock = () => Date.now(), monotonic = () => performance.now() } = dependencies
  if (collector?.kind !== 'fictional-maintenance-collector' || collector.projectId !== DEMO_PROJECT ||
      collector.databaseId !== '(default)' || collector.collectorId !== expected.collectorId ||
      typeof collector.open !== 'function' || typeof clock !== 'function' || typeof monotonic !== 'function') fail('authorization')
  const binding = freeze({ runId: plan.runId, projectId: DEMO_PROJECT, databaseId: '(default)',
    planDigest: hash(plan), expectationDigest: hash(expected), collectorId: expected.collectorId })
  const bindingDigest = hash(binding), evidenceBudget = { bytes: 0, nodes: 0 }
  let state = 'new', lease, entry, exit, startWall, startTick, lastWall, lastTick
  let baselineStateDigest
  let closeRequested = false, operations = 0, released = false, releaseFailed = false
  function release() {
    if (!closeRequested || operations || !lease || released) return
    released = true
    try { if (lease.release() !== true) releaseFailed = true } catch { releaseFailed = true }
  }
  function stop() { state = 'aborted';closeRequested = true;release() }
  function checkClock() {
    const now = clock(), tick = monotonic()
    if (!instant(now) || !Number.isFinite(tick) || (lastWall !== undefined && (now < lastWall || tick < lastTick))) fail('clock')
    if (now < plan.notBefore || now >= plan.expiresAt ||
        (startWall !== undefined && (now - startWall >= LIMITS.runMs || tick - startTick >= LIMITS.runMs))) fail('expired')
    lastWall = now;lastTick = tick
    return now
  }
  function assertCurrent() {
    if (closeRequested || !['reading', 'finishing', 'ready', 'publishing'].includes(state)) fail('continuity')
    checkClock()
    if (lease.assertHeld() !== true) fail('continuity')
  }
  async function operation(action) {
    operations++
    try { return await action() } catch (error) { stop();throw error }
    finally { operations--;release() }
  }
  function snapshot(raw, at) {
    const value = copyData(raw, evidenceBudget)
    if (!exact(value, ['kind', 'bindingDigest', 'observedAt', 'cursors', 'artifacts', 'globalV2', 'maintenanceMode',
      'profileSync', 'legacyWriters', 'writers', 'drainedAt', 'credentials', 'audit', 'canary']) ||
        value.kind !== 'fictional-maintenance-snapshot' || value.bindingDigest !== bindingDigest ||
        value.observedAt !== at || !cursors(value.cursors) || !artifacts(value.artifacts) ||
        !same(value.artifacts, expected.artifacts) || value.globalV2 !== 'enabled' || value.maintenanceMode !== 'closed' ||
        value.profileSync !== 'closed' || value.legacyWriters !== 'closed' ||
        !instant(value.drainedAt) || value.drainedAt > expected.maintenanceStartedAt ||
        !Array.isArray(value.writers) || value.writers.length !== expected.writerInventory.length) fail('continuity')
    for (let n = 0; n < value.writers.length; n++) {
      const writer = value.writers[n], prior = expected.writerInventory[n]
      if (!exact(writer, ['id', 'kind', 'admission', 'writeScope', 'inFlight', 'queued', 'retrying', 'drainEvidenceDigest']) ||
          writer.id !== prior.id || writer.kind !== prior.kind || writer.inFlight !== 0 || writer.queued !== 0 || writer.retrying !== 0 ||
          !digest(writer.drainEvidenceDigest)) fail('continuity')
      const audit = writer.id === 'recordStudentBalanceHistoryV3' && writer.kind === 'trigger'
      if (writer.admission !== (audit ? 'audit-only' : 'closed') ||
          writer.writeScope !== (audit ? 'balanceHistory-create-only' : 'none')) fail('continuity')
    }
    const credentials = value.credentials
    if (!exact(credentials, ['status', 'verifiedAt', 'evidenceDigest']) || credentials.status !== 'consistent' ||
        !instant(credentials.verifiedAt) || credentials.verifiedAt < value.drainedAt ||
        credentials.verifiedAt > expected.maintenanceStartedAt || !digest(credentials.evidenceDigest)) fail('continuity')
    if (!Array.isArray(value.audit) || value.audit.length !== expected.auditVersions.length) fail('continuity')
    value.audit.forEach((row, n) => {
      if (!exact(row, ['versionDigest', 'outcome', 'evidenceDigest']) || row.versionDigest !== expected.auditVersions[n] ||
          !['recorded', 'terminal-gap'].includes(row.outcome) || !digest(row.evidenceDigest)) fail('continuity')
    })
    const canary = value.canary
    if (!exact(canary, ['classroomId', 'phase', 'scopeDigest', 'probes']) || canary.classroomId !== plan.canaryClassroomId ||
        canary.phase !== 'frozen' || canary.scopeDigest !== hash(plan.rooms) || !Array.isArray(canary.probes) ||
        canary.probes.length !== PROBES.length) fail('continuity')
    canary.probes.forEach((probe, n) => {
      if (!exact(probe, ['kind', 'prior', 'maintenance', 'beforeDigest', 'afterDigest']) || probe.kind !== PROBES[n] ||
          !exact(probe.prior, ['rulesDigest', 'requestDigest', 'identityDigest', 'fixtureDigest', 'outcome']) ||
          !exact(probe.maintenance, ['rulesDigest', 'requestDigest', 'identityDigest', 'fixtureDigest', 'outcome']) ||
          probe.prior.rulesDigest !== expected.priorRulesDigest || probe.maintenance.rulesDigest !== expected.artifacts.rules ||
          probe.prior.outcome !== 'succeeded' || probe.maintenance.outcome !== 'denied' ||
          !digest(probe.beforeDigest) || probe.beforeDigest !== probe.afterDigest ||
          ['requestDigest', 'identityDigest', 'fixtureDigest'].some(key => !digest(probe.prior[key]) || probe.prior[key] !== probe.maintenance[key])) fail('continuity')
    })
    const stateDigest = hash({ ...value, observedAt: 0 })
    if (baselineStateDigest !== undefined && stateDigest !== baselineStateDigest) fail('continuity')
    baselineStateDigest = stateDigest
    return freeze(value)
  }
  async function observe(from, fromTime) {
    const at = checkClock()
    const current = snapshot(await lease.snapshot(at), at)
    if (closeRequested || lease.assertHeld() !== true) fail('continuity')
    const history = copyData(await lease.history({ from, to: current.cursors, fromTime, throughTime: at }), evidenceBudget)
    if (!exact(history, ['kind', 'bindingDigest', 'intervals']) || history.kind !== 'fictional-complete-maintenance-history' ||
        history.bindingDigest !== bindingDigest || !Array.isArray(history.intervals) || history.intervals.length !== MAINTENANCE_SURFACES.length) fail('continuity')
    history.intervals.forEach((row, n) => {
      const surface = MAINTENANCE_SURFACES[n]
      if (!exact(row, ['surface', 'fromSequence', 'throughSequence', 'fromTime', 'throughTime', 'events']) ||
          row.surface !== surface || row.fromSequence !== from[surface] || row.throughSequence !== current.cursors[surface] ||
          row.fromTime !== fromTime || row.throughTime !== at || !Array.isArray(row.events) || row.events.length !== 0 ||
          row.fromSequence !== row.throughSequence) fail('continuity')
    })
    if (closeRequested || lease.assertHeld() !== true) fail('continuity')
    checkClock()
    return freeze({ current, history })
  }
  return Object.freeze({ kind: 'fictional-interval-observer', assertCurrent,
    begin(args) {
      return operation(async () => {
        if (state !== 'new' || closeRequested || !exact(args, ['planDigest', 'startedAt']) || args.planDigest !== binding.planDigest) fail('continuity')
        state = 'opening'
        const now = checkClock();startTick = lastTick
        if (!instant(args.startedAt) || args.startedAt < plan.notBefore || args.startedAt > now) fail('continuity')
        startWall = args.startedAt
        const opened = await collector.open(binding, stop)
        if (!opened || opened.kind !== 'fictional-maintenance-lease' || opened.bindingDigest !== bindingDigest ||
            typeof opened.snapshot !== 'function' || typeof opened.history !== 'function' ||
            typeof opened.assertHeld !== 'function' || typeof opened.release !== 'function') fail('continuity')
        lease = opened
        if (closeRequested || lease.assertHeld() !== true) fail('continuity')
        const observed = await observe(expected.startCursors, expected.maintenanceStartedAt)
        entry = freeze({ kind: 'fictional-observer-entry', planDigest: binding.planDigest, startedAt: startWall,
          stateDigest: hash(observed), throughSequence: 0 })
        state = 'reading'
        return entry
      })
    },
    finish(args) {
      return operation(async () => {
        assertCurrent()
        if (state !== 'reading' || !exact(args, ['entry', 'boundary']) || !same(args.entry, entry) ||
            !exact(args.boundary, ['evidenceDigest', 'completedAt']) || !digest(args.boundary.evidenceDigest) ||
            !instant(args.boundary.completedAt) || args.boundary.completedAt < startWall || args.boundary.completedAt > checkClock()) fail('continuity')
        state = 'finishing'
        const observed = await observe(expected.startCursors, expected.maintenanceStartedAt)
        exit = freeze({ kind: 'fictional-observer-exit', entryDigest: hash(entry), evidenceDigest: args.boundary.evidenceDigest,
          completedAt: args.boundary.completedAt, coveredThrough: observed.current.observedAt, throughSequence: 0, changes: [], complete: true })
        state = 'ready'
        return exit
      })
    },
    hold(record, action) {
      return operation(async () => {
        assertCurrent()
        if (state !== 'ready' || !same(record, exit) || typeof action !== 'function') fail('continuity')
        state = 'publishing'
        await observe(expected.startCursors, expected.maintenanceStartedAt)
        assertCurrent()
        const result = await action()
        assertCurrent()
        await observe(expected.startCursors, expected.maintenanceStartedAt)
        assertCurrent();state = 'complete'
        return result
      })
    },
    close() {
      closeRequested = true
      if (state !== 'complete') state = 'aborted'
      release()
      return !operations && !releaseFailed && (!lease || released)
    },
  })
}
