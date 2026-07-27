import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { TenantSession, SESSION_STATES } from '../phase2b/tenantSession.js'
import {
  TenantDataServiceError,
  createStudentDataLoader,
  createTenantDataLoader,
  createTenantDataSaver,
} from './tenantDataService.js'
import { TenantProjectionError } from './tenantDataProjection.js'

const CLASSROOM = 'classroom-alpha'
const TEACHER_UID = 'teacher-uid-1'

/**
 * A Firestore double with genuine semantics for the surface this service uses:
 * paths are resolved from strings, batches buffer until commit, and a rejected
 * commit leaves the store untouched. Nothing here echoes an input back — the
 * store is real state the assertions read afterwards.
 */
function createFirestoreDouble(seed = {}) {
  const store = new Map(Object.entries(seed))
  const commits = []
  let failNextCommit = null

  const firestore = {
    doc: (_db, path) => ({ path }),
    collection: (_db, path) => ({ path }),
    getDoc: async ref => {
      const body = store.get(ref.path)
      return { exists: () => body !== undefined, data: () => body }
    },
    getDocs: async ref => {
      const prefix = `${ref.path}/`
      const docs = [...store.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, body]) => ({ id: path.slice(prefix.length), data: () => body }))
      return { docs }
    },
    writeBatch: () => {
      const buffered = []
      return {
        set(ref, body, options) {
          buffered.push({ kind: 'set', path: ref.path, body, options })
        },
        delete(ref) {
          buffered.push({ kind: 'delete', path: ref.path })
        },
        async commit() {
          if (failNextCommit) {
            const error = failNextCommit
            failNextCommit = null
            // Buffered writes are discarded, exactly as a real rejected commit.
            throw error
          }
          for (const op of buffered) {
            if (op.kind === 'delete') store.delete(op.path)
            else store.set(op.path, op.body)
          }
          commits.push(buffered)
        },
      }
    },
  }

  return {
    firestore,
    store,
    commits,
    failNextCommitWith(error) {
      failNextCommit = error
    },
  }
}

function createActiveSession({ uid = TEACHER_UID, classroomId = CLASSROOM } = {}) {
  const session = new TenantSession({ storageAdapter: null, projectId: 'demo-test' })
  session.transitionTo(SESSION_STATES.AUTHENTICATING)
  session.transitionTo(SESSION_STATES.RESOLVING)
  session.transitionTo(SESSION_STATES.ACTIVE, { uid, role: 'teacher', classroomId })
  return session
}

function student(overrides = {}) {
  return { id: 1, name: 'Ada', balance: 10, frozen: false, transactions: [], ...overrides }
}

function transaction(overrides = {}) {
  return {
    id: 1700000000000,
    date: '1/1/2026, 9:00:00 AM',
    studentId: 1,
    studentName: 'Ada',
    type: 'Add',
    amount: 5,
    reason: 'Quick Cash',
    memo: '',
    category: '',
    status: 'Approved',
    source: 'Teacher',
    ...overrides,
  }
}

function seededStore() {
  return {
    [`classrooms/${CLASSROOM}`]: { settings: { requireTeacherApproval: true }, lastBackupAt: null },
    [`classrooms/${CLASSROOM}/students/1`]: student(),
    [`classrooms/${CLASSROOM}/transactions/1700000000000`]: transaction(),
    // A credential document deliberately present in the store. Nothing the
    // service reads may ever surface it.
    [`classrooms/${CLASSROOM}/studentCredentials/ada-1`]: { pinHash: 'HASH', loginId: 'ada-1' },
  }
}

describe('Phase 3 tenant data service — loader', () => {
  it('reads only the resolved classroom and returns the projected aggregate', async () => {
    const { firestore } = createFirestoreDouble(seededStore())
    const session = createActiveSession()
    const load = createTenantDataLoader({ db: {}, session, firestore })

    const result = await load({ uid: TEACHER_UID, classroomId: CLASSROOM })

    assert.equal(result.students.length, 1)
    assert.equal(result.students[0].name, 'Ada')
    assert.equal(result.transactions.length, 1)
    assert.equal(result.settings.requireTeacherApproval, true)
  })

  it('never reads a credential path', async () => {
    const readPaths = []
    const double = createFirestoreDouble(seededStore())
    const spying = {
      ...double.firestore,
      doc: (db, path) => {
        readPaths.push(path)
        return double.firestore.doc(db, path)
      },
      collection: (db, path) => {
        readPaths.push(path)
        return double.firestore.collection(db, path)
      },
    }
    const session = createActiveSession()
    const load = createTenantDataLoader({ db: {}, session, firestore: spying })

    const result = await load({})

    assert.ok(readPaths.length > 0)
    assert.ok(readPaths.every(p => !/[Cc]redential/.test(p)), readPaths.join(', '))
    assert.ok(readPaths.every(p => p.startsWith(`classrooms/${CLASSROOM}`)))
    assert.ok(!JSON.stringify(result).includes('HASH'))
  })

  it('fails closed when the caller requests a different classroom', async () => {
    const { firestore } = createFirestoreDouble(seededStore())
    const session = createActiveSession()
    const load = createTenantDataLoader({ db: {}, session, firestore })

    await assert.rejects(
      () => load({ uid: TEACHER_UID, classroomId: 'classroom-beta' }),
      err => err instanceof TenantDataServiceError && err.reason === 'tenant-mismatch',
    )
  })

  it('fails closed when the caller identity differs from the session identity', async () => {
    const { firestore } = createFirestoreDouble(seededStore())
    const session = createActiveSession()
    const load = createTenantDataLoader({ db: {}, session, firestore })

    await assert.rejects(
      () => load({ uid: 'someone-else', classroomId: CLASSROOM }),
      err => err instanceof TenantDataServiceError && err.reason === 'identity-mismatch',
    )
  })

  it('fails closed when the session has no resolved classroom', async () => {
    const { firestore } = createFirestoreDouble(seededStore())
    const session = new TenantSession({ storageAdapter: null, projectId: 'demo-test' })
    const load = createTenantDataLoader({ db: {}, session, firestore })

    await assert.rejects(
      () => load({}),
      err => err instanceof TenantDataServiceError && err.reason === 'unresolved-tenant',
    )
  })

  it('discards a read that completed after the tenant changed', async () => {
    const double = createFirestoreDouble(seededStore())
    const session = createActiveSession()
    let switched = false
    const racing = {
      ...double.firestore,
      getDocs: async ref => {
        if (!switched) {
          switched = true
          // The teacher signs out mid-read; the in-flight read must not be
          // projected or returned to the new session.
          session.invalidate('auth-observer-change', { uid: null })
        }
        return double.firestore.getDocs(ref)
      },
    }
    const load = createTenantDataLoader({ db: {}, session, firestore: racing })

    await assert.rejects(
      () => load({}),
      err => err instanceof TenantDataServiceError && err.reason === 'stale-identity',
    )
  })

  it('surfaces a projection failure rather than a partial classroom', async () => {
    const corrupt = seededStore()
    corrupt[`classrooms/${CLASSROOM}/students/2`] = { id: 2, name: 'Bea', balance: 1, frozen: false, transactions: [], pin: '9999' }
    const { firestore } = createFirestoreDouble(corrupt)
    const session = createActiveSession()
    const load = createTenantDataLoader({ db: {}, session, firestore })

    const error = await load({}).then(() => null, err => err)
    assert.ok(error instanceof TenantProjectionError)
    assert.equal(error.category, 'credential')
    assert.ok(!error.message.includes('9999'))
  })

  it('requires every Firestore adapter to be supplied', () => {
    const session = createActiveSession()
    assert.throws(
      () => createTenantDataLoader({ db: {}, session, firestore: { doc: () => {} } }),
      err => err instanceof TenantDataServiceError && err.reason === 'missing-firestore-adapter',
    )
  })
})

describe('Phase 3 tenant data service — student loader', () => {
  it('reads exactly the authenticated student document', async () => {
    const readPaths = []
    const double = createFirestoreDouble(seededStore())
    const spying = {
      ...double.firestore,
      doc: (db, path) => {
        readPaths.push(path)
        return double.firestore.doc(db, path)
      },
    }
    const session = new TenantSession({ storageAdapter: null, projectId: 'demo-test' })
    const load = createStudentDataLoader({ db: {}, session, firestore: spying })

    const result = await load({ uid: 'student-uid', classroomId: CLASSROOM, studentId: '1' })

    assert.deepEqual(readPaths, [`classrooms/${CLASSROOM}/students/1`])
    assert.equal(result.students.length, 1)
    assert.deepEqual(result.loginHistory, [])
  })

  it('fails closed on incomplete claims', async () => {
    const { firestore } = createFirestoreDouble(seededStore())
    const session = new TenantSession({ storageAdapter: null, projectId: 'demo-test' })
    const load = createStudentDataLoader({ db: {}, session, firestore })

    for (const claims of [
      { uid: '', classroomId: CLASSROOM, studentId: '1' },
      { uid: 'u', classroomId: '', studentId: '1' },
      { uid: 'u', classroomId: CLASSROOM, studentId: '' },
    ]) {
      await assert.rejects(
        () => load(claims),
        err => err instanceof TenantDataServiceError && err.reason === 'incomplete-student-claims',
      )
    }
  })

  it('fails closed when the student has no record', async () => {
    const { firestore } = createFirestoreDouble(seededStore())
    const session = new TenantSession({ storageAdapter: null, projectId: 'demo-test' })
    const load = createStudentDataLoader({ db: {}, session, firestore })

    await assert.rejects(
      () => load({ uid: 'u', classroomId: CLASSROOM, studentId: '99' }),
      err => err instanceof TenantDataServiceError && err.reason === 'student-document-missing',
    )
  })
})

describe('Phase 3 tenant data service — saver', () => {
  function baseData(overrides = {}) {
    return {
      students: [student()],
      transactions: [transaction()],
      loginHistory: [],
      settings: { requireTeacherApproval: true },
      lastBackupAt: null,
      ...overrides,
    }
  }

  it('writes each document at its canonical path, overwriting all but the root', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      nowFn: () => '2026-01-01T00:00:00.000Z',
    })

    const result = await save(baseData(), session.captureIdentity())

    assert.equal(result.batches, 1)
    assert.equal(double.store.get(`classrooms/${CLASSROOM}/students/1`).name, 'Ada')
    assert.equal(double.store.get(`classrooms/${CLASSROOM}`).updatedAt, '2026-01-01T00:00:00.000Z')

    // Per-collection document contracts depend on overwrite semantics, so a
    // field removed from the aggregate must not survive server-side.
    for (const op of double.commits[0]) {
      if (op.kind !== 'set') continue
      if (op.path === `classrooms/${CLASSROOM}`) continue
      assert.deepEqual(op.options, { merge: false }, `${op.path} must overwrite`)
    }
  })

  // Regression: the classroom root previously used merge:false like every other
  // document. That overwrote server-owned tenant fields (ownerUid, name,
  // activation state) and was denied outright by
  // firestore.phase2b.proposed.rules, whose root update rule requires
  // affectedKeys() ⊆ {settings, lastBackupAt, updatedAt} — an overwrite reports
  // every dropped field as affected. The unit suite could not see it because no
  // rules layer runs against injected primitives; the Item 10 browser suite
  // caught it.
  it('merges the classroom root so server-owned tenant fields survive', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })

    await save(baseData(), session.captureIdentity())

    const rootOps = double.commits
      .flat()
      .filter(op => op.kind === 'set' && op.path === `classrooms/${CLASSROOM}`)

    assert.equal(rootOps.length, 1, 'the classroom root is written exactly once')
    assert.deepEqual(
      rootOps[0].options,
      { merge: true },
      'the classroom root must be merged, never overwritten'
    )

    // And the merged body must stay confined to the client-writable fields the
    // rules allow, so merging cannot become a loophole for writing others.
    // Subset rather than exact: the planner omits an absent lastBackupAt, and
    // the rules constrain which keys MAY be written, not which must be.
    const ALLOWED_ROOT_KEYS = ['lastBackupAt', 'settings', 'updatedAt']
    for (const key of Object.keys(rootOps[0].body)) {
      assert.ok(
        ALLOWED_ROOT_KEYS.includes(key),
        `root write must not include non-client-writable field "${key}"`
      )
    }
  })

  it('writes a student body with exactly the five contract fields', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })

    await save(baseData(), session.captureIdentity())

    const written = double.store.get(`classrooms/${CLASSROOM}/students/1`)
    assert.deepEqual(Object.keys(written).sort(), ['balance', 'frozen', 'id', 'name', 'transactions'])
  })

  it('writes a classroom root limited to settings, lastBackupAt, and updatedAt', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      nowFn: () => '2026-01-01T00:00:00.000Z',
    })

    await save(baseData({ lastBackupAt: '2026-01-01T00:00:00.000Z' }), session.captureIdentity())

    const root = double.store.get(`classrooms/${CLASSROOM}`)
    assert.deepEqual(Object.keys(root).sort(), ['lastBackupAt', 'settings', 'updatedAt'])
  })

  it('refuses to persist an aggregate carrying a plaintext pin', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })

    const error = await save(
      baseData({ students: [{ ...student(), pin: '1234' }] }),
      session.captureIdentity(),
    ).then(() => null, err => err)

    assert.ok(error instanceof TenantProjectionError)
    assert.equal(error.category, 'credential')
    // Nothing at all was written: the decomposition throws before any commit.
    assert.equal(double.commits.length, 0)
    assert.equal(double.store.size, 0)
  })

  it('never writes a credential path', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })

    await save(baseData(), session.captureIdentity())

    const paths = double.commits.flat().map(op => op.path)
    assert.ok(paths.length > 0)
    assert.ok(paths.every(p => !/[Cc]redential/.test(p)))
    assert.ok(paths.every(p => p.startsWith(`classrooms/${CLASSROOM}`)))
  })

  it('never deletes a student document', async () => {
    const previous = baseData({ students: [student({ id: 1 }), student({ id: 2, name: 'Bea' })] })
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      previousRef: () => previous,
    })

    await save(baseData({ students: [student({ id: 1 })] }), session.captureIdentity())

    const deletes = double.commits.flat().filter(op => op.kind === 'delete')
    assert.ok(deletes.every(op => !op.path.includes('/students/')))
  })

  it('skips the write entirely when nothing changed', async () => {
    const data = baseData()
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      previousRef: () => data,
    })

    const result = await save(data, session.captureIdentity())

    assert.equal(result.skipped, true)
    assert.equal(result.written, 0)
    assert.equal(double.commits.length, 0)
  })

  it('is idempotent across a retry because record ids are deterministic', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })

    await save(baseData(), session.captureIdentity())
    const afterFirst = double.store.size
    await save(baseData(), session.captureIdentity())

    assert.equal(double.store.size, afterFirst, 'a retry must overwrite, never duplicate')
  })

  it('refuses to write under a stale identity captured before the tenant changed', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })

    const captured = session.captureIdentity()
    session.invalidate('auth-observer-change', { uid: 'other-teacher' })

    await assert.rejects(
      () => save(baseData(), captured),
      err => err instanceof TenantDataServiceError && err.reason === 'stale-identity',
    )
    assert.equal(double.commits.length, 0)
  })

  it('stops committing further batches when the tenant changes mid-write', async () => {
    // Force multiple batches so there is a real gap between commits.
    const many = Array.from({ length: 6 }, (_, i) => transaction({ id: 1700000000000 + i }))
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    let commitCount = 0
    const racing = {
      ...double.firestore,
      writeBatch: db => {
        const batch = double.firestore.writeBatch(db)
        const originalCommit = batch.commit.bind(batch)
        batch.commit = async () => {
          await originalCommit()
          commitCount += 1
          if (commitCount === 1) session.invalidate('auth-observer-change', { uid: 'other-teacher' })
        }
        return batch
      },
    }
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: racing,
      maxBatchSize: 2,
      maxWrites: 100,
    })

    await assert.rejects(
      () => save(baseData({ transactions: many }), session.captureIdentity()),
      err => err instanceof TenantDataServiceError && err.reason === 'stale-identity',
    )
    assert.equal(commitCount, 1, 'only the first batch may commit')
  })

  it('propagates a rejected commit without seeding partial state', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })
    const failure = new Error('permission denied')
    failure.code = 'permission-denied'
    double.failNextCommitWith(failure)

    await assert.rejects(() => save(baseData(), session.captureIdentity()), /permission denied/)
    assert.equal(double.store.size, 0)
  })

  it('splits a large mutation into bounded batches', async () => {
    const many = Array.from({ length: 9 }, (_, i) => transaction({ id: 1700000000000 + i }))
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      maxBatchSize: 4,
      maxWrites: 100,
    })

    const result = await save(baseData({ transactions: many }), session.captureIdentity())

    assert.equal(result.batches, Math.ceil(result.written / 4))
    assert.ok(double.commits.every(batch => batch.length <= 4))
  })

  it('bounds the whole mutation separately from the per-batch limit', async () => {
    // The two limits are independent. A mutation under the total ceiling must
    // still split into batches; one over the ceiling must be refused outright.
    const many = Array.from({ length: 9 }, (_, i) => transaction({ id: 1700000000000 + i }))
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      maxBatchSize: 4,
      maxWrites: 5,
    })

    const error = await save(baseData({ transactions: many }), session.captureIdentity())
      .then(() => null, err => err)

    assert.ok(error instanceof TenantProjectionError)
    assert.equal(error.details.maxWrites, 5)
    assert.equal(double.commits.length, 0, 'an over-budget mutation must write nothing')
  })

  it('defaults the mutation ceiling above the per-batch limit', async () => {
    // Regression guard for the defect this suite caught: defaulting maxWrites
    // to maxBatchSize made the batching loop unreachable, because any mutation
    // large enough to need a second batch was rejected before reaching it.
    const many = Array.from({ length: 450 }, (_, i) => transaction({ id: 1700000000000 + i }))
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })

    const result = await save(baseData({ transactions: many }), session.captureIdentity())

    assert.ok(result.batches > 1, 'a >400-write mutation must split rather than be refused')
    assert.ok(double.commits.every(batch => batch.length <= 400))
  })
})
