// Fictional platform model for tests. Not a live collector, lock or IAM proof.
import { makeFixture } from './fixtures.js'
import { MAINTENANCE_SURFACES } from './maintenanceObserver.js'
import { DEMO_PROJECT, fail, hash } from './common.js'

export function makeMaintenanceFixture() {
  const f = makeFixture(), clone = value => globalThis.structuredClone(value)
  const startCursors = Object.fromEntries(MAINTENANCE_SURFACES.map(key => [key, 0]))
  const artifacts = Object.fromEntries(['rules', 'revisions', 'runtime', 'triggers', 'iam', 'recovery', 'credentialVerifier'].map(key => [key, hash('fictional-' + key)]))
  const writerInventory = [
    { id: 'callable', kind: 'callable' }, { id: 'operator-job', kind: 'operator' },
    { id: 'prior-revision', kind: 'revision' }, { id: 'recordStudentBalanceHistoryV3', kind: 'trigger' },
    { id: 'scheduler', kind: 'scheduler' }, { id: 'task', kind: 'task' }, { id: 'transaction', kind: 'transaction' },
  ]
  const expected = { kind: 'fictional-maintenance-expectation', projectId: DEMO_PROJECT, databaseId: '(default)',
    planDigest: hash(f.plan), collectorId: 'fictional-collector', maintenanceStartedAt: f.plan.notBefore,
    startCursors, artifacts, writerInventory, priorRulesDigest: hash('fictional-prior-rules'), auditVersions: [hash('fictional-version')] }
  f.expectation = expected
  f.rebind = () => { expected.planDigest = hash(f.plan) }
  f.maintenance = { kind: 'fictional-maintenance-snapshot', bindingDigest: '', observedAt: f.now(), cursors: clone(startCursors),
    artifacts: clone(artifacts), globalV2: 'enabled', maintenanceMode: 'closed', profileSync: 'closed', legacyWriters: 'closed',
    writers: writerInventory.map(row => ({ ...row, admission: row.id === 'recordStudentBalanceHistoryV3' ? 'audit-only' : 'closed',
      writeScope: row.id === 'recordStudentBalanceHistoryV3' ? 'balanceHistory-create-only' : 'none', inFlight: 0, queued: 0,
      retrying: 0, drainEvidenceDigest: hash('fictional-drain-' + row.id) })),
    drainedAt: f.plan.notBefore - 10,
    credentials: { status: 'consistent', verifiedAt: f.plan.notBefore, evidenceDigest: hash('fictional-credentials') },
    audit: expected.auditVersions.map(versionDigest => ({ versionDigest, outcome: 'recorded', evidenceDigest: hash('fictional-audit') })),
    canary: { classroomId: f.plan.canaryClassroomId, phase: 'frozen', scopeDigest: hash(f.plan.rooms),
      probes: ['batch', 'rest', 'sdk', 'transaction'].map(kind => {
        const control = { rulesDigest: expected.priorRulesDigest, requestDigest: hash(kind), identityDigest: hash('fictional-identity'), fixtureDigest: hash('fictional-fixture'), outcome: 'succeeded' }
        return { kind, prior: control, maintenance: { ...control, rulesDigest: artifacts.rules, outcome: 'denied' },
          beforeDigest: hash('fictional-probe-state'), afterDigest: hash('fictional-probe-state') }
      }) },
  }
  let active = null
  const used = new Set(), journal = []
  f.collectorCalls = [];f.releaseCount = 0;f.historyAvailable = true
  f.leaseHeld = () => !!active
  f.platformChange = (surface, notify = true) => {
    if (!MAINTENANCE_SURFACES.includes(surface)) throw Error('Unknown fictional surface')
    const sequence = ++f.maintenance.cursors[surface]
    journal.push({ surface, sequence })
    if (notify && active) { active.invalid = true;active.invalidate() }
  }
  const collector = { kind: 'fictional-maintenance-collector', projectId: DEMO_PROJECT, databaseId: '(default)', collectorId: expected.collectorId,
    async open(binding, invalidate) {
      f.collectorCalls.push('open')
      if (active || used.has(binding.runId)) fail('continuity')
      const token = { invalid: false, invalidate, cursors: hash(f.maintenance.cursors) };active = token;used.add(binding.runId)
      const bindingDigest = hash(binding)
      await f.beforeOpen?.()
      return { kind: 'fictional-maintenance-lease', bindingDigest,
        async snapshot(at) {
          f.collectorCalls.push('snapshot');await f.beforeSnapshot?.()
          const value = clone({ ...f.maintenance, bindingDigest, observedAt: at })
          return f.mapSnapshot ? f.mapSnapshot(value) : value
        },
        async history(request) {
          f.collectorCalls.push('history');await f.beforeHistory?.()
          if (!f.historyAvailable) fail('continuity')
          const value = { kind: 'fictional-complete-maintenance-history', bindingDigest,
            intervals: MAINTENANCE_SURFACES.map(surface => ({ surface, fromSequence: request.from[surface],
              throughSequence: request.to[surface], fromTime: request.fromTime, throughTime: request.throughTime,
              events: clone(journal.filter(event => event.surface === surface && event.sequence > request.from[surface] && event.sequence <= request.to[surface])) })) }
          return f.mapHistory ? f.mapHistory(value) : value
        },
        assertHeld() { return active === token && !token.invalid && f.historyAvailable && token.cursors === hash(f.maintenance.cursors) },
        release() {
          if (active !== token) return false
          f.releaseCount++;active = null;f.afterRelease?.();return true
        },
      }
    },
  }
  f.observedDependencies = { collector, reader: f.dependencies.reader, publisher: f.dependencies.publisher,
    clock: f.dependencies.clock, monotonic: f.dependencies.monotonic }
  return f
}
