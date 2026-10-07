import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { teacherAwardPaths } from '../../functions/phase3/teacherAwardService.js'

// Fictional optimistic storage with atomic staging, create/update preconditions,
// read-before-write assertions and a lost-response barrier. No SDK/network.
export function teacherAwardFixture({ uid = 'teacher-a', classroomId = 'class-a', count = 2, store = null } = {}) {
  const time = '2026-10-01T18:00:00.000Z'
  const paths = teacherAwardPaths(classroomId, uid, '0'.repeat(32))
  const defaults = new Map(Object.entries({
    [`teachers/${uid}`]: { uid, status: 'active', classroomId },
    [`classrooms/${classroomId}`]: { ownerUid: uid, accessControl: {
      schemaVersion: 1, mode: 'active', generation: 7, changedAt: time, auditId: 'fictional-audit',
    }, settings: { addMoneyCategories: ['Homework', "Teacher's Choice"], subtractMoneyCategories: ['Rent', "Teacher's Choice"] } },
    [paths.actor]: { version: 1, actorUid: uid, unacknowledgedRequestId: null },
    [paths.quota]: { version: 1, count: 0 },
  }))
  const data = store ?? new Map()
  for (const [path, value] of defaults) if (!data.has(path)) data.set(path, value)
  for (let id = 1; id <= count; id++) if (!data.has(`classrooms/${classroomId}/students/${id}`)) data.set(`classrooms/${classroomId}/students/${id}`, {
    id, name: id === 1 ? 'Fictional Avery' : 'Fictional Blake', balance: 20, frozen: false, transactions: [],
  })
  let revision = 0
  const f = { uid, classroomId, time, paths, data, commits: [], reads: [], loseResponse: false, beforeCommit: null }
  f.dependencies = { auth: { uid, token: { role: 'teacher' } }, projectId: 'demo-money-client', now: () => time,
    firestore: { doc: path => ({ path }), async runTransaction(callback) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const initial = revision, values = new Map([...data].map(([key, value]) => [key, structuredClone(value)])), writes = []
        const result = await callback({
          async get(ref) {
            assert.equal(writes.length, 0, 'all reads precede staged writes')
            f.reads.push(ref.path)
            return { exists: values.has(ref.path), data: () => structuredClone(values.get(ref.path)),
              updateTime: { seconds: 1, nanoseconds: Number.parseInt(createHash('sha256')
                .update(JSON.stringify(values.get(ref.path) ?? null)).digest('hex').slice(0, 7), 16) } }
          },
          create(ref, value) { writes.push(['create', ref.path, structuredClone(value)]) },
          update(ref, value) { writes.push(['update', ref.path, structuredClone(value)]) },
        })
        if (f.beforeCommit) { const hook = f.beforeCommit; f.beforeCommit = null; await hook(data); revision++ }
        if (initial !== revision) continue
        for (const [kind, path] of writes) assert.equal(data.has(path), kind === 'update', 'write precondition')
        for (const [kind, path, value] of writes) data.set(path, kind === 'update' ? { ...data.get(path), ...value } : value)
        if (writes.length) { revision++; f.commits.push(writes) }
        if (writes.length && f.loseResponse) { f.loseResponse = false; throw new Error('PRIVATE lost SDK response') }
        return result
      }
      throw new Error('fictional contention exhausted')
    } },
  }
  f.student = id => data.get(`classrooms/${classroomId}/students/${id}`)
  f.request = extra => ({ protocolVersion: 1, controlGeneration: 7, requestId: '00112233445566778899aabbccddeeff',
    action: 'award', studentIds: [1], amountCents: 100, reason: 'Homework', category: 'Homework', memo: '', ...extra })
  return f
}
