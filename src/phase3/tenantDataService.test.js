import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { TenantSession, SESSION_STATES } from '../phase2b/tenantSession.js'
import {
  TenantDataServiceError,
  createStudentDataLoader,
  createTenantDataLoader,
  createTenantDataSaver,
} from './tenantDataService.js'
import { projectClassroomData, TenantProjectionError } from './tenantDataProjection.js'

const CLASSROOM = 'classroom-alpha'
const TEACHER_UID = 'teacher-uid-1'
const RENT_AMOUNT = 25
const RENT_UPDATED_AT = '2026-08-19T12:00:00.000Z'

/**
 * A Firestore double with genuine semantics for the surface this service uses:
 * paths are resolved from strings, transactions buffer until commit, and a
 * rejected commit leaves the store untouched. Nothing here echoes an input
 * back — the store is real state the assertions read afterwards.
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
    runTransaction: async (_db, callback) => {
      const buffered = []
      let wrote = false
      const transaction = {
        async get(ref) {
          if (wrote) throw new Error('read after write')
          const body = store.get(ref.path)
          return { exists: () => body !== undefined, data: () => body }
        },
        set(ref, body, options) {
          wrote = true
          buffered.push({ kind: 'set', path: ref.path, body, options })
        },
        delete(ref) {
          wrote = true
          buffered.push({ kind: 'delete', path: ref.path })
        },
      }
      const result = await callback(transaction)
      if (failNextCommit) {
        const error = failNextCommit
        failNextCommit = null
        // Buffered writes are discarded, exactly as a real rejected commit.
        throw error
      }
      for (const op of buffered) {
        if (op.kind === 'delete') store.delete(op.path)
        else if (op.options?.merge === true) {
          store.set(op.path, { ...(store.get(op.path) || {}), ...op.body })
        } else store.set(op.path, op.body)
      }
      commits.push(buffered)
      return result
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

function createResolvingStudentSession({ uid = 'student-uid', classroomId = null } = {}) {
  const session = new TenantSession({ storageAdapter: null, projectId: 'demo-test' })
  session.transitionTo(SESSION_STATES.AUTHENTICATING, { uid, role: 'student' })
  session.transitionTo(SESSION_STATES.RESOLVING, { uid, role: 'student', classroomId })
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

function historyEntry(overrides = {}) {
  return {
    id: 1700000000001,
    date: '1/1/2026, 9:05:00 AM',
    studentId: 1,
    studentName: 'Ada',
    result: 'Success',
    note: '',
    ...overrides,
  }
}

function seededStore() {
  return {
    [`classrooms/${CLASSROOM}`]: { settings: { requireTeacherApproval: true }, lastBackupAt: null },
    [`classrooms/${CLASSROOM}/studentDisplay/rent`]: {
      rentAmount: RENT_AMOUNT,
      updatedAt: RENT_UPDATED_AT,
    },
    [`classrooms/${CLASSROOM}/students/1`]: student({ transactions: [transaction()] }),
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
    assert.equal(result.settings.rentAmount, RENT_AMOUNT)
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

  it('rejects non-canonical resolved or requested classroom ids before any read', async () => {
    for (const classroomId of [
      `${CLASSROOM}/foreign`,
      ` ${CLASSROOM}`,
      '..',
      '__reserved__',
      '\uD83D',
      'a'.repeat(1501),
    ]) {
      let reads = 0
      const double = createFirestoreDouble(seededStore())
      const firestore = {
        ...double.firestore,
        getDoc: async ref => {
          reads += 1
          return double.firestore.getDoc(ref)
        },
        getDocs: async ref => {
          reads += 1
          return double.firestore.getDocs(ref)
        },
      }
      const session = createActiveSession({ classroomId })
      const load = createTenantDataLoader({ db: {}, session, firestore })

      await assert.rejects(
        () => load({}),
        err => err instanceof TenantDataServiceError && err.reason === 'invalid-classroom-id',
      )
      assert.equal(reads, 0)
    }

    let reads = 0
    const double = createFirestoreDouble(seededStore())
    const firestore = {
      ...double.firestore,
      getDoc: async ref => {
        reads += 1
        return double.firestore.getDoc(ref)
      },
    }
    const load = createTenantDataLoader({
      db: {},
      session: createActiveSession(),
      firestore,
    })
    await assert.rejects(
      () => load({ classroomId: `${CLASSROOM}/foreign` }),
      err => err instanceof TenantDataServiceError && err.reason === 'invalid-classroom-id',
    )
    assert.equal(reads, 0)
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

  it('rejects a missing classroom root instead of rendering an empty tenant', async () => {
    const seed = seededStore()
    delete seed[`classrooms/${CLASSROOM}`]
    const { firestore } = createFirestoreDouble(seed)
    const session = createActiveSession()
    const load = createTenantDataLoader({ db: {}, session, firestore })

    await assert.rejects(
      () => load({}),
      err => err instanceof TenantDataServiceError && err.reason === 'classroom-root-missing',
    )
  })

  it('rejects a body identity that disagrees with its Firestore document id', async () => {
    const seed = seededStore()
    seed[`classrooms/${CLASSROOM}/students/99`] = student({ id: 2, name: 'Bea' })
    const { firestore } = createFirestoreDouble(seed)
    const session = createActiveSession()
    const load = createTenantDataLoader({ db: {}, session, firestore })

    await assert.rejects(
      () => load({}),
      err => err instanceof TenantDataServiceError && err.reason === 'document-id-mismatch',
    )
  })

  it('requires the teacher role before listing tenant collections', async () => {
    const { firestore } = createFirestoreDouble(seededStore())
    const session = createActiveSession()
    session.role = 'student'
    const load = createTenantDataLoader({ db: {}, session, firestore })

    await assert.rejects(
      () => load({}),
      err => err instanceof TenantDataServiceError && err.reason === 'role-mismatch',
    )
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
  it('reads exactly the authenticated student document and narrow rent display', async () => {
    const readPaths = []
    const double = createFirestoreDouble(seededStore())
    const spying = {
      ...double.firestore,
      doc: (db, path) => {
        readPaths.push(path)
        return double.firestore.doc(db, path)
      },
    }
    const session = createResolvingStudentSession()
    const load = createStudentDataLoader({ db: {}, session, firestore: spying })

    const result = await load({ uid: 'student-uid', classroomId: CLASSROOM, studentId: '1' })

    assert.deepEqual(readPaths, [
      `classrooms/${CLASSROOM}/students/1`,
      `classrooms/${CLASSROOM}/studentDisplay/rent`,
    ])
    assert.equal(result.students.length, 1)
    assert.deepEqual(result.loginHistory, [])
    assert.equal(result.settings.rentAmount, RENT_AMOUNT)
  })

  it('defaults a missing rent document to zero without widening the read set', async () => {
    const seed = seededStore()
    delete seed[`classrooms/${CLASSROOM}/studentDisplay/rent`]
    const { firestore } = createFirestoreDouble(seed)
    const session = createResolvingStudentSession()
    const load = createStudentDataLoader({ db: {}, session, firestore })

    const result = await load({
      uid: 'student-uid',
      classroomId: CLASSROOM,
      studentId: '1',
    })

    assert.equal(result.settings.rentAmount, 0)
  })

  it('fails closed on incomplete claims', async () => {
    const { firestore } = createFirestoreDouble(seededStore())
    const session = createResolvingStudentSession({ uid: 'u' })
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
    const session = createResolvingStudentSession({ uid: 'u' })
    const load = createStudentDataLoader({ db: {}, session, firestore })

    await assert.rejects(
      () => load({ uid: 'u', classroomId: CLASSROOM, studentId: '99' }),
      err => err instanceof TenantDataServiceError && err.reason === 'student-document-missing',
    )
  })

  it('binds the requested uid and role to the resolving student session', async () => {
    const { firestore } = createFirestoreDouble(seededStore())
    const session = createResolvingStudentSession({ uid: 'student-uid' })
    const load = createStudentDataLoader({ db: {}, session, firestore })

    await assert.rejects(
      () => load({ uid: 'other-uid', classroomId: CLASSROOM, studentId: '1' }),
      err => err instanceof TenantDataServiceError && err.reason === 'identity-mismatch',
    )
    session.role = 'teacher'
    await assert.rejects(
      () => load({ uid: 'student-uid', classroomId: CLASSROOM, studentId: '1' }),
      err => err instanceof TenantDataServiceError && err.reason === 'role-mismatch',
    )
  })

  it('rejects non-canonical student or classroom claims before constructing a Firestore path', async () => {
    let reads = 0
    const double = createFirestoreDouble(seededStore())
    const firestore = {
      ...double.firestore,
      getDoc: async ref => {
        reads += 1
        return double.firestore.getDoc(ref)
      },
    }
    const session = createResolvingStudentSession()
    const load = createStudentDataLoader({ db: {}, session, firestore })

    for (const [claims, reason] of [
      [{ uid: 'student-uid', classroomId: CLASSROOM, studentId: '1/other' }, 'invalid-student-id'],
      [{ uid: 'student-uid', classroomId: `${CLASSROOM}/foreign`, studentId: '1' }, 'invalid-classroom-id'],
      [{ uid: 'student-uid', classroomId: ` ${CLASSROOM}`, studentId: '1' }, 'invalid-classroom-id'],
      [{ uid: 'student-uid', classroomId: '..', studentId: '1' }, 'invalid-classroom-id'],
      [{ uid: ' student-uid', classroomId: CLASSROOM, studentId: '1' }, 'identity-mismatch'],
    ]) {
      await assert.rejects(
        () => load(claims),
        err => err instanceof TenantDataServiceError && err.reason === reason,
      )
    }
    assert.equal(reads, 0)
  })
})

describe('Phase 3 tenant data service — saver', () => {
  function baseData(overrides = {}) {
    return {
      students: [student({ transactions: [transaction()] })],
      transactions: [transaction()],
      loginHistory: [],
      settings: { requireTeacherApproval: true },
      lastBackupAt: null,
      ...overrides,
    }
  }

  function persistedDataStore(data = baseData(), rootOverrides = {}) {
    const rootSettings = { ...(data.settings || {}) }
    delete rootSettings.rentAmount
    const store = {
      [`classrooms/${CLASSROOM}`]: {
        settings: rootSettings,
        lastBackupAt: data.lastBackupAt,
        ...rootOverrides,
      },
    }
    for (const entry of data.students) {
      store[`classrooms/${CLASSROOM}/students/${entry.id}`] = entry
    }
    for (const entry of data.transactions) {
      store[`classrooms/${CLASSROOM}/transactions/${entry.id}`] = entry
    }
    for (const entry of data.loginHistory) {
      store[`classrooms/${CLASSROOM}/loginHistory/${entry.id}`] = entry
    }
    return store
  }

  it('writes each document at its canonical path, overwriting all but the root', async () => {
    const previous = baseData()
    const double = createFirestoreDouble(persistedDataStore(previous))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      previousRef: () => previous,
      nowFn: () => '2026-01-01T00:00:00.000Z',
    })
    const next = baseData({
      students: [student({ balance: 11, transactions: [transaction()] })],
      transactions: [transaction({ status: 'Denied' })],
      settings: { requireTeacherApproval: false },
    })

    const result = await save(next, session.captureIdentity())

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
    const previous = baseData()
    const double = createFirestoreDouble(persistedDataStore(previous, {
      ownerUid: TEACHER_UID,
      status: 'active',
    }))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {}, session, firestore: double.firestore, previousRef: () => previous,
    })

    await save(
      baseData({ settings: { requireTeacherApproval: false } }),
      session.captureIdentity(),
    )

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
    assert.equal(double.store.get(`classrooms/${CLASSROOM}`).ownerUid, TEACHER_UID)
    assert.equal(double.store.get(`classrooms/${CLASSROOM}`).status, 'active')
  })

  it('writes a student body with exactly the five contract fields', async () => {
    const previous = baseData()
    const double = createFirestoreDouble(persistedDataStore(previous))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {}, session, firestore: double.firestore, previousRef: () => previous,
    })

    await save(
      baseData({ students: [student({ balance: 11, transactions: [transaction()] })] }),
      session.captureIdentity(),
    )

    const written = double.store.get(`classrooms/${CLASSROOM}/students/1`)
    assert.deepEqual(Object.keys(written).sort(), ['balance', 'frozen', 'id', 'name', 'transactions'])
  })

  it('writes a classroom root limited to settings, lastBackupAt, and updatedAt', async () => {
    const previous = baseData()
    const double = createFirestoreDouble(persistedDataStore(previous))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      previousRef: () => previous,
      nowFn: () => '2026-01-01T00:00:00.000Z',
    })

    await save(baseData({ lastBackupAt: '2026-01-01T00:00:00.000Z' }), session.captureIdentity())

    const root = double.store.get(`classrooms/${CLASSROOM}`)
    assert.deepEqual(Object.keys(root).sort(), ['lastBackupAt', 'settings', 'updatedAt'])
  })

  it('persists rent only at the student display path with an exact body', async () => {
    const previous = baseData({ settings: { requireTeacherApproval: true, rentAmount: 0 } })
    const double = createFirestoreDouble(persistedDataStore(previous))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      previousRef: () => previous,
      nowFn: () => RENT_UPDATED_AT,
    })

    const result = await save(
      baseData({ settings: { requireTeacherApproval: true, rentAmount: RENT_AMOUNT } }),
      session.captureIdentity(),
    )

    assert.equal(result.written, 1)
    assert.deepEqual(
      double.store.get(`classrooms/${CLASSROOM}/studentDisplay/rent`),
      { rentAmount: RENT_AMOUNT, updatedAt: RENT_UPDATED_AT },
    )
    assert.ok(!Object.prototype.hasOwnProperty.call(
      double.store.get(`classrooms/${CLASSROOM}`).settings,
      'rentAmount',
    ))
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
    const previous = baseData()
    const double = createFirestoreDouble(persistedDataStore(previous))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {}, session, firestore: double.firestore, previousRef: () => previous,
    })

    await save(
      baseData({ students: [student({ balance: 11, transactions: [transaction()] })] }),
      session.captureIdentity(),
    )

    const paths = double.commits.flat().map(op => op.path)
    assert.ok(paths.length > 0)
    assert.ok(paths.every(p => !/[Cc]redential/.test(p)))
    assert.ok(paths.every(p => p.startsWith(`classrooms/${CLASSROOM}`)))
  })

  it('never deletes a student document', async () => {
    const previous = baseData({
      students: [
        student({ id: 1, transactions: [transaction()] }),
        student({ id: 2, name: 'Bea' }),
      ],
    })
    const double = createFirestoreDouble(persistedDataStore(previous))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      previousRef: () => previous,
    })

    await save(
      baseData({
        students: [student({ id: 1, transactions: [transaction()] })],
        settings: { requireTeacherApproval: false },
      }),
      session.captureIdentity(),
    )

    const deletes = double.commits.flat().filter(op => op.kind === 'delete')
    assert.ok(deletes.every(op => !op.path.includes('/students/')))
  })

  it('reloads and subsequently saves after a supported server-side student removal', async () => {
    const seed = seededStore()
    seed[`classrooms/${CLASSROOM}/loginHistory/1700000000001`] = historyEntry()
    const double = createFirestoreDouble(seed)
    const session = createActiveSession()
    const load = createTenantDataLoader({ db: {}, session, firestore: double.firestore })

    const beforeRemoval = await load({})
    assert.equal(beforeRemoval.students.length, 1)

    // removeStudentV2 deletes only the roster document. Its transaction and
    // login-history records are intentionally retained as classroom history.
    double.store.delete(`classrooms/${CLASSROOM}/students/1`)
    const afterRemoval = await load({})
    assert.deepEqual(afterRemoval.students, [])
    assert.equal(afterRemoval.transactions[0].studentId, 1)
    assert.equal(afterRemoval.loginHistory[0].studentId, 1)

    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      previousRef: () => afterRemoval,
      nowFn: () => '2026-01-02T00:00:00.000Z',
    })
    const next = {
      ...afterRemoval,
      settings: { ...afterRemoval.settings, requireTeacherApproval: false },
    }
    const result = await save(next, session.captureIdentity())

    assert.equal(result.skipped, false)
    assert.equal(
      double.store.get(`classrooms/${CLASSROOM}/transactions/1700000000000`).studentId,
      1,
    )
    assert.equal(
      double.store.get(`classrooms/${CLASSROOM}/loginHistory/1700000000001`).studentId,
      1,
    )
    assert.equal(double.store.get(`classrooms/${CLASSROOM}`).settings.requireTeacherApproval, false)
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
    let previous = baseData()
    const double = createFirestoreDouble(persistedDataStore(previous))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {}, session, firestore: double.firestore, previousRef: () => previous,
    })
    const next = baseData({
      students: [student({ balance: 11, transactions: [transaction()] })],
    })

    await save(next, session.captureIdentity())
    const afterFirst = double.store.size
    previous = next
    await save(next, session.captureIdentity())

    assert.equal(double.store.size, afterFirst, 'a retry must overwrite, never duplicate')
  })

  it('aborts a stale teacher save before it can overwrite a newer student transaction', async () => {
    const pendingAdd = transaction({ status: 'Pending', source: 'Student' })
    const previous = baseData({
      students: [student({ balance: 25, transactions: [pendingAdd] })],
      transactions: [pendingAdd],
    })
    const submittedSubtract = transaction({
      id: 1700000000002,
      date: '1/1/2026, 9:10:00 AM',
      type: 'Subtract',
      amount: 4,
      reason: 'Rent',
      status: 'Approved',
      source: 'Student',
    })
    const liveStudent = student({
      balance: 21,
      transactions: [submittedSubtract, pendingAdd],
    })
    const liveStore = persistedDataStore(previous)
    liveStore[`classrooms/${CLASSROOM}/students/1`] = liveStudent
    liveStore[`classrooms/${CLASSROOM}/transactions/${submittedSubtract.id}`] = submittedSubtract
    const double = createFirestoreDouble(liveStore)
    const before = JSON.parse(JSON.stringify(Object.fromEntries(double.store)))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {}, session, firestore: double.firestore, previousRef: () => previous,
    })
    const staleFreeze = baseData({
      students: [student({ balance: 25, frozen: true, transactions: [pendingAdd] })],
      transactions: [pendingAdd],
    })

    await assert.rejects(
      () => save(staleFreeze, session.captureIdentity()),
      error => error instanceof TenantDataServiceError &&
        error.reason === 'concurrent-classroom-change',
    )

    assert.equal(double.commits.length, 0)
    assert.deepEqual(Object.fromEntries(double.store), before)
    const reloaded = projectClassroomData({
      classroomId: CLASSROOM,
      root: double.store.get(`classrooms/${CLASSROOM}`),
      students: [double.store.get(`classrooms/${CLASSROOM}/students/1`)],
      transactions: [
        double.store.get(`classrooms/${CLASSROOM}/transactions/${submittedSubtract.id}`),
        double.store.get(`classrooms/${CLASSROOM}/transactions/${pendingAdd.id}`),
      ],
      loginHistory: [],
    })
    assert.equal(reloaded.students[0].balance, 21)
    assert.deepEqual(reloaded.students[0].transactions.map(entry => entry.id), [
      submittedSubtract.id,
      pendingAdd.id,
    ])
  })

  // Regression: the concurrency guard originally read only student documents,
  // so it could not see a collision in the ledger. Transaction ids come from
  // the submitting client's Date.now() (index.html:2866), which means a
  // student's committed record and a later teacher record for a DIFFERENT
  // student can share an id. The teacher's own student document then passes its
  // check while the overwrite replaces the student's ledger record, leaving
  // that student's mirror pointing at a record the ledger no longer holds —
  // the same divergence that locks the teacher out of every later load.
  it('aborts a stale teacher save whose transaction id collides with a student record', async () => {
    const COLLIDING_ID = 1700000000000
    const studentSubmission = transaction({
      id: COLLIDING_ID, studentId: 1, studentName: 'Ada', type: 'Subtract',
      amount: 4, reason: 'Rent', status: 'Approved', source: 'Student',
    })
    // The teacher's tab loaded before the submission and knows none of it.
    const previous = baseData({
      students: [
        student({ id: 1, transactions: [] }),
        student({ id: 2, name: 'Grace', balance: 30, transactions: [] }),
      ],
      transactions: [],
    })
    const liveStore = persistedDataStore(previous)
    liveStore[`classrooms/${CLASSROOM}/students/1`] =
      student({ id: 1, balance: 6, transactions: [studentSubmission] })
    liveStore[`classrooms/${CLASSROOM}/transactions/${COLLIDING_ID}`] = studentSubmission
    const double = createFirestoreDouble(liveStore)
    const before = JSON.parse(JSON.stringify(Object.fromEntries(double.store)))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {}, session, firestore: double.firestore, previousRef: () => previous,
    })

    // Quick Cash for the OTHER student. Nothing about student 2's own document
    // changed underneath the teacher, so only the ledger check can catch this.
    const collidingGrant = transaction({
      id: COLLIDING_ID, studentId: 2, studentName: 'Grace', type: 'Add',
      amount: 5, reason: 'Quick Cash', source: 'Teacher',
    })
    const staleGrant = baseData({
      students: [
        student({ id: 1, transactions: [] }),
        student({ id: 2, name: 'Grace', balance: 35, transactions: [] }),
      ],
      transactions: [collidingGrant],
    })

    await assert.rejects(
      () => save(staleGrant, session.captureIdentity()),
      error => error instanceof TenantDataServiceError &&
        error.reason === 'concurrent-classroom-change',
    )

    assert.equal(double.commits.length, 0)
    assert.deepEqual(Object.fromEntries(double.store), before)

    // The ledger record and the student's mirror must still describe the same
    // transaction, or the next load throws and the teacher cannot recover.
    const reloaded = projectClassroomData({
      classroomId: CLASSROOM,
      root: double.store.get(`classrooms/${CLASSROOM}`),
      students: [
        double.store.get(`classrooms/${CLASSROOM}/students/1`),
        double.store.get(`classrooms/${CLASSROOM}/students/2`),
      ],
      transactions: [double.store.get(`classrooms/${CLASSROOM}/transactions/${COLLIDING_ID}`)],
      loginHistory: [],
    })
    assert.equal(reloaded.transactions[0].source, 'Student')
    assert.equal(reloaded.students[0].transactions[0].studentName, 'Ada')
  })

  // Regression: the stored mirror keeps the order its writer used — the student
  // callable prepends — while the baseline is re-derived from the loader's
  // id-descending ledger. A record whose id is below one already stored leaves
  // the two permanently ordered differently, and an order-sensitive comparison
  // then read that as a concurrent change on every save from then on, with no
  // second writer and no way out.
  it('accepts a save when the stored mirror is not in ledger order', async () => {
    const LOW = 1700000000000
    const HIGH = 9007199254740000
    const low = transaction({ id: LOW, source: 'Teacher' })
    const high = transaction({ id: HIGH, source: 'Student' })
    const seeded = baseData({
      students: [student({ transactions: [low, high] })],
      transactions: [high, low],
    })
    const double = createFirestoreDouble(persistedDataStore(seeded))
    const session = createActiveSession()
    const load = createTenantDataLoader({ db: {}, session, firestore: double.firestore })
    let previous = null
    const save = createTenantDataSaver({
      db: {}, session, firestore: double.firestore, previousRef: () => previous,
    })

    const data = await load({ classroomId: CLASSROOM })
    previous = JSON.parse(JSON.stringify(data))
    assert.deepEqual(
      data.students[0].transactions.map(entry => entry.id),
      [LOW, HIGH],
      'the stored mirror keeps write order',
    )
    assert.deepEqual(
      data.transactions.map(entry => entry.id),
      [HIGH, LOW],
      'the loader sorts only the top-level ledger',
    )

    const next = JSON.parse(JSON.stringify(data))
    next.students[0].frozen = true
    await save(next, session.captureIdentity())

    assert.equal(double.store.get(`classrooms/${CLASSROOM}/students/1`).frozen, true)
  })

  // Regression: the concurrency guard above compared the stored student
  // document against the raw aggregate student in the baseline. Those are not
  // the same thing — the stored body's `transactions` mirror is re-derived from
  // the authoritative top-level ledger, and no teacher code path updates the
  // aggregate's per-student copy (index.html mutates only `data.transactions`).
  // So the first save wrote an Approved mirror, the client's baseline still
  // said Pending, and the teacher's very next action on that student aborted as
  // a "concurrent" change with no second writer anywhere. Approve-then-anything
  // is the ordinary workflow, so this fired constantly.
  it('accepts a second teacher save after the first changed a transaction status', async () => {
    const pendingAdd = transaction({ status: 'Pending', source: 'Student' })
    let previous = baseData({
      students: [student({ balance: 25, transactions: [pendingAdd] })],
      transactions: [pendingAdd],
    })
    const double = createFirestoreDouble(persistedDataStore(previous))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {}, session, firestore: double.firestore, previousRef: () => previous,
    })

    // Approve: the ledger and the balance move; the mirror is left stale, as
    // the real teacher UI leaves it.
    const approved = transaction({ status: 'Approved', source: 'Student' })
    const afterApprove = baseData({
      students: [student({ balance: 30, transactions: [pendingAdd] })],
      transactions: [approved],
    })
    await save(afterApprove, session.captureIdentity())
    previous = JSON.parse(JSON.stringify(afterApprove))

    assert.deepEqual(
      double.store.get(`classrooms/${CLASSROOM}/students/1`).transactions,
      [approved],
      'the persisted mirror is re-derived from the ledger, not copied from the aggregate',
    )

    // Freeze the same student. Nothing else has written.
    const afterFreeze = baseData({
      students: [student({ balance: 30, frozen: true, transactions: [pendingAdd] })],
      transactions: [approved],
    })
    await save(afterFreeze, session.captureIdentity())

    assert.equal(double.store.get(`classrooms/${CLASSROOM}/students/1`).frozen, true)
    assert.equal(double.commits.length, 2)
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

  it('requires the teacher role before constructing any transaction', async () => {
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    session.role = 'student'
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })

    await assert.rejects(
      () => save(baseData(), session.captureIdentity()),
      err => err instanceof TenantDataServiceError && err.reason === 'role-mismatch',
    )
    assert.equal(double.commits.length, 0)
  })

  it('refuses to split one logical mutation across commits', async () => {
    const many = Array.from({ length: 6 }, (_, i) => transaction({ id: 1700000000000 + i }))
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {},
      session,
      firestore: double.firestore,
      maxBatchSize: 2,
      maxWrites: 100,
    })

    await assert.rejects(
      () => save(baseData({ transactions: many }), session.captureIdentity()),
      err => err instanceof TenantDataServiceError && err.reason === 'mutation-not-atomic',
    )
    assert.equal(double.commits.length, 0, 'an oversized logical mutation must write nothing')
  })

  it('propagates a rejected commit without seeding partial state', async () => {
    const previous = baseData()
    const double = createFirestoreDouble(persistedDataStore(previous))
    const session = createActiveSession()
    const save = createTenantDataSaver({
      db: {}, session, firestore: double.firestore, previousRef: () => previous,
    })
    const failure = new Error('permission denied')
    failure.code = 'permission-denied'
    double.failNextCommitWith(failure)

    await assert.rejects(
      () => save(
        baseData({ students: [student({ balance: 11, transactions: [transaction()] })] }),
        session.captureIdentity(),
      ),
      /permission denied/,
    )
    assert.deepEqual(Object.fromEntries(double.store), persistedDataStore(previous))
  })

  it('bounds the whole mutation separately from the atomic commit limit', async () => {
    // The configured logical ceiling may be stricter than Firestore's atomic
    // commit ceiling; either limit must refuse before the first commit.
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

  it('defaults the logical mutation ceiling to one atomic commit', async () => {
    const many = Array.from({ length: 450 }, (_, i) => transaction({ id: 1700000000000 + i }))
    const double = createFirestoreDouble({})
    const session = createActiveSession()
    const save = createTenantDataSaver({ db: {}, session, firestore: double.firestore })

    await assert.rejects(
      () => save(baseData({ transactions: many }), session.captureIdentity()),
      err => err instanceof TenantProjectionError && err.details.maxWrites === 400,
    )
    assert.equal(double.commits.length, 0)
  })
})
