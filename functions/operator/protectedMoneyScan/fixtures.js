// FICTIONAL in-memory seams. No live observer or real authority claim.
import { DEMO_PROJECT, hash, freeze } from './common.js'
export function makeFixture() {
  let tick = 10, now = 1790500000000, sequence = 0
  const store = new Map(), calls = [], published = [], changes = []
  const clone = value => globalThis.structuredClone(value)
  const rooms = [{ classroomId: 'canary', ownerUid: 'fictional-owner-a', allowSuspended: false },
    { classroomId: 'room-b', ownerUid: 'fictional-owner-b', allowSuspended: false }]
  const plan = { kind: 'protected-money-scan-rehearsal', projectId: DEMO_PROJECT, databaseId: '(default)',
    runId: 'fictional-run', sourceCommit: 'a'.repeat(40), notBefore: now - 1000, expiresAt: now + 60000,
    rooms, canaryClassroomId: 'canary' }
  const fixture = { store, calls, published, changes, plan, advance(ms) { now += ms }, now: () => now,
    put(path, data) { const prior = store.get(path); store.set(path, { path, exists: true, createVersion: prior?.createVersion ?? [++tick, 0], updateVersion: [++tick, 0], data: clone(data) }) },
    change(kind) { changes.push({ sequence: ++sequence, kind }) },
  }
  for (const room of rooms) {
    fixture.put(`classrooms/${room.classroomId}`, { ownerUid: room.ownerUid, settings: {} })
    fixture.put(`teachers/${room.ownerUid}`, { uid: room.ownerUid, status: 'active', classroomId: room.classroomId, email: 'FICTIONAL_PRIVATE_EMAIL' })
    fixture.put(`classrooms/${room.classroomId}/students/1`, { id: 1, name: 'FICTIONAL_PRIVATE_NAME', balance: 1.1, frozen: false, transactions: [] })
  }
  const reader = { kind: 'loopback-read-only', projectId: DEMO_PROJECT, databaseId: '(default)',
    async listPage(path, token) {
      calls.push(['list', path, token]);await fixture.beforeRead?.('list', path)
      const depth = path.split('/').length
      const paths = [...new Set([...store.keys()].filter(key => key.startsWith(path + '/')).map(key => key.split('/').slice(0, depth + 1).join('/')))].sort()
      const offset = token ? Number(token) : 0
      return { documents: paths.slice(offset, offset + 25).map(path => ({ path, exists: store.has(path) })), nextPageToken: paths.length > offset + 25 ? String(offset + 25) : '' }
    },
    async get(path, mask) {
      calls.push(['get', path, mask]);await fixture.beforeRead?.('get', path, mask)
      const row = store.get(path)
      if (!row) return { path, exists: false, createVersion: null, updateVersion: null, data: null }
      const result = clone(row)
      if (mask !== null) result.data = Object.fromEntries(mask.filter(key => Object.hasOwn(result.data, key)).map(key => [key, result.data[key]]))
      return result
    },
  }
  const observer = { kind: 'fictional-interval-observer',
    async begin({ planDigest, startedAt }) { return freeze({ kind: 'fictional-observer-entry', planDigest, startedAt, stateDigest: hash('fictional-state'), throughSequence: sequence }) },
    async finish({ entry, boundary }) {
      await fixture.beforeFinish?.()
      return { kind: 'fictional-observer-exit', entryDigest: hash(entry), evidenceDigest: boundary.evidenceDigest,
        completedAt: boundary.completedAt, coveredThrough: now, throughSequence: sequence,
        changes: clone(changes.filter(change => change.sequence > entry.throughSequence)), complete: true }
    },
    async hold(exit, action) {
      if (exit.throughSequence !== sequence) throw Error('FICTIONAL_PRIVATE_OBSERVER_ERROR')
      const result = await action()
      if (exit.throughSequence !== sequence) throw Error('FICTIONAL_PRIVATE_OBSERVER_ERROR')
      return result
    },
  }
  const publisher = { async publish(value) { published.push(clone(value));return { digest: value.digest, durable: true } } }
  fixture.dependencies = { reader, observer, publisher, clock: () => now, monotonic: () => now }
  return fixture
}
