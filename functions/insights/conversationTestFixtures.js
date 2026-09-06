import assert from 'node:assert/strict'
// In-memory Firestore semantics used by the real tenant resolver, snapshot
// loader and usage ledger. No Firebase SDK initialization, network or data.
export function database() {
  const initial = {}
  for (const tenant of ['a', 'b']) {
    initial[`teachers/teacher-${tenant}`] = { uid: `teacher-${tenant}`, status: 'active', classroomId: `class-${tenant}` }
    initial[`classrooms/class-${tenant}`] = { ownerUid: `teacher-${tenant}` }
    initial[`classrooms/class-${tenant}/studentDisplay/rent`] = { rentAmount: 10, updatedAt: '2026-08-27T17:00:00.000Z' }
    for (const id of [1, 2]) initial[`classrooms/class-${tenant}/students/${id}`] = {
      id, name: tenant === 'a' ? 'Avery Morgan' : 'Blake Smith', balance: tenant === 'a' ? id : id * 10,
      frozen: false, transactions: [],
    }
  }
  const store = new Map(Object.entries(globalThis.structuredClone(initial)))
  const reads = [], writes = []
  function snapshot(path) { return { exists: store.has(path), id: path.split('/').at(-1), data: () => globalThis.structuredClone(store.get(path)) } }
  function get(reference) {
    reads.push(reference.path)
    if (reference.kind !== 'query') return snapshot(reference.path)
    const prefix = reference.path + '/'
    const docs = [...store.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .sort().slice(0, reference.limitCount ?? undefined).map(snapshot)
    return { size: docs.length, docs }
  }
  function doc(path) { return { path, id: path.split('/').at(-1), get: async () => get({ path }), collection: name => query(`${path}/${name}`) } }
  function query(path) { return { path, kind: 'query', doc: id => doc(`${path}/${id}`), limit(count) { return { ...this, limitCount: count } } } }
  let tail = Promise.resolve()
  return {
    initial, store, reads, writes,
    firestore: {
      collection: query,
      runTransaction(callback) {
        const execute = async () => {
        const pending = new Map()
        const result = await callback({
          get: async reference => get(reference),
          set(reference, value) { pending.set(reference.path, globalThis.structuredClone(value)) },
          create(reference, value) {
            assert.equal(store.has(reference.path) || pending.has(reference.path), false)
            pending.set(reference.path, globalThis.structuredClone(value))
          },
        })
        for (const [path, value] of pending) { writes.push(path); store.set(path, value) }
        return result
        }
        const next = tail.then(execute); tail = next.catch(() => {})
        return next
      },
    },
  }
}

