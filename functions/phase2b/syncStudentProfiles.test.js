import test from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import {
  buildCandidateLoginId,
  defaultHashPin,
  deriveBaseLoginId,
  syncStudentProfilesV2Handler,
  SyncStudentProfilesError,
  DEFAULT_STUDENT_PIN,
  STUDENT_PIN_BCRYPT_COST,
} from './syncStudentProfiles.js'
import { deriveDeterministicStudentAuthUid } from './scopedCredentialProjection.js'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Firestore double enforcing the Admin SDK transaction contract:
 *
 * - reads must precede every write in an attempt;
 * - writes stay buffered until commit;
 * - `create` carries a does-not-exist precondition and fails with an
 *   ALREADY_EXISTS-shaped error when the document appeared meanwhile;
 * - `update` on a missing document fails;
 * - `beforeCommit` lets a test interleave another transaction and/or abort the
 *   attempt so retry behavior is exercised rather than assumed.
 */
function createMockFirestore(initialDocs = {}, { beforeCommit } = {}) {
  const store = new Map()
  for (const [path, data] of Object.entries(initialDocs)) {
    store.set(path, clone(data))
  }

  let transactionAttempts = 0
  const attemptOperations = []

  function getDocRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      collection(subCollection) {
        return getCollectionRef(`${path}/${subCollection}`)
      },
      async get() {
        const data = store.get(path)
        return {
          exists: data !== undefined,
          id: path.split('/').pop(),
          ref: getDocRef(path),
          data: () => clone(data),
        }
      },
    }
  }

  function getCollectionRef(collectionPath) {
    return {
      path: collectionPath,
      doc(id) {
        return getDocRef(`${collectionPath}/${id ?? `auto_${store.size + 1}`}`)
      },
      where(field, op, value) {
        return {
          limit(max) {
            return {
              _matchingPaths() {
                const matches = []
                for (const [path, data] of store.entries()) {
                  if (!path.startsWith(`${collectionPath}/`)) {
                    continue
                  }
                  const relative = path.slice(collectionPath.length + 1)
                  if (relative.includes('/')) {
                    continue
                  }
                  if (op === '==' && data[field] === value) {
                    matches.push(path)
                  }
                }
                return matches.slice(0, max)
              },
            }
          },
        }
      },
    }
  }

  return {
    store,
    attemptOperations,
    get transactionAttempts() {
      return transactionAttempts
    },
    doc: getDocRef,
    collection: getCollectionRef,
    async runTransaction(updateFunction) {
      for (;;) {
        transactionAttempts += 1
        const attemptNumber = transactionAttempts
        const operations = []
        const writes = []
        let hasWritten = false

        function assertReadPhase(target) {
          if (hasWritten) {
            throw new Error(
              'Firestore transactions require all reads to be executed before all writes.',
            )
          }
          operations.push({ kind: 'read', path: target })
        }

        const transaction = {
          async get(refOrQuery) {
            if (refOrQuery && typeof refOrQuery._matchingPaths === 'function') {
              const paths = refOrQuery._matchingPaths()
              assertReadPhase(`query:${paths.join(',')}`)
              return {
                empty: paths.length === 0,
                docs: paths.map(path => ({
                  path,
                  id: path.split('/').pop(),
                  ref: getDocRef(path),
                  data: () => clone(store.get(path)),
                })),
              }
            }
            const path = typeof refOrQuery === 'string' ? refOrQuery : refOrQuery.path
            assertReadPhase(path)
            const data = store.get(path)
            return {
              exists: data !== undefined,
              id: path.split('/').pop(),
              ref: getDocRef(path),
              data: () => clone(data),
            }
          },
          create(ref, data) {
            hasWritten = true
            operations.push({ kind: 'create', path: ref.path })
            writes.push({ kind: 'create', path: ref.path, data: clone(data) })
          },
          set(ref, data) {
            hasWritten = true
            operations.push({ kind: 'set', path: ref.path })
            writes.push({ kind: 'set', path: ref.path, data: clone(data) })
          },
          update(ref, data) {
            hasWritten = true
            operations.push({ kind: 'update', path: ref.path })
            writes.push({ kind: 'update', path: ref.path, data: clone(data) })
          },
        }

        const result = await updateFunction(transaction)
        attemptOperations.push(operations)

        const directive = beforeCommit
          ? await beforeCommit({ attemptNumber, writes })
          : undefined
        if (directive === 'abort') {
          continue
        }

        for (const write of writes) {
          if (write.kind === 'create') {
            if (store.has(write.path)) {
              const error = new Error(
                `6 ALREADY_EXISTS: Document already exists: ${write.path}`,
              )
              error.code = 6
              throw error
            }
            store.set(write.path, write.data)
            continue
          }
          if (write.kind === 'set') {
            store.set(write.path, write.data)
            continue
          }
          if (!store.has(write.path)) {
            throw new Error(`NOT_FOUND: no document to update at ${write.path}`)
          }
          store.set(write.path, { ...store.get(write.path), ...write.data })
        }
        return result
      }
    },
  }
}

function foundation(classroomId, teacherUid) {
  return {
    [`classrooms/${classroomId}`]: { ownerUid: teacherUid },
    [`teachers/${teacherUid}`]: {
      uid: teacherUid,
      classroomId,
      status: 'active',
    },
  }
}

function documentSnapshot(path, data) {
  return {
    exists: data !== undefined,
    id: path.split('/').pop(),
    ref: { path, id: path.split('/').pop() },
    data: () => clone(data),
  }
}

/**
 * Representative Firestore Functions v2 `onDocumentWritten` event: the change
 * arrives as the CloudEvent payload `event.data`, with both snapshots always
 * present and `exists` false for the missing side.
 */
function v2WrittenEvent({ classroomId, studentId, before, after }) {
  const documentPath = `classrooms/${classroomId}/students/${studentId}`
  return {
    id: 'a1b2c3-d4e5f6',
    type: 'google.cloud.firestore.document.v1.written',
    specversion: '1.0',
    source: '//firestore.googleapis.com/projects/demo-test/databases/(default)',
    subject: `documents/${documentPath}`,
    time: '2026-07-25T00:00:00.000Z',
    location: 'us-central1',
    project: 'demo-test',
    database: '(default)',
    namespace: '(default)',
    document: documentPath,
    params: { classroomId, studentId },
    data: {
      before: documentSnapshot(documentPath, before),
      after: documentSnapshot(documentPath, after),
    },
  }
}

function scopedCredential(classroomId, loginId, studentId, overrides = {}) {
  return {
    loginId,
    classroomId,
    studentId,
    authUid: deriveDeterministicStudentAuthUid(classroomId, studentId),
    schemaVersion: 1,
    active: true,
    pinHash: 'secret_hash',
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  }
}

const stubHashPin = async (pin) => `hashed_${pin}`

test('slug behavior: NFKD/combining-mark/punctuation/empty-name/truncation', () => {
  assert.equal(deriveBaseLoginId('Alex Smith'), 'alex-smith')
  assert.equal(deriveBaseLoginId("Renée O'Connor"), 'renee-o-connor')
  assert.equal(deriveBaseLoginId('  !!!  '), 'student')
  assert.equal(deriveBaseLoginId(''), 'student')
  assert.equal(deriveBaseLoginId(null), 'student')

  const longName = 'a'.repeat(100)
  assert.equal(deriveBaseLoginId(longName), 'a'.repeat(48))
})

test('collision candidates stay canonical and inside the 64-character maximum', () => {
  assert.equal(buildCandidateLoginId('alex-smith', 1), 'alex-smith')
  assert.equal(buildCandidateLoginId('alex-smith', 2), 'alex-smith-2')
  assert.equal(buildCandidateLoginId('alex-smith', 137), 'alex-smith-137')

  // A maximum-length base plus any suffix stays inside the login maximum and
  // never ends up with a trailing or doubled hyphen.
  const base = 'a'.repeat(48)
  for (const candidateNumber of [2, 10, 100, 1000, 1000000]) {
    const candidate = buildCandidateLoginId(base, candidateNumber)
    assert.ok(candidate.length <= 64, `${candidate.length} exceeded 64`)
    assert.ok(!candidate.endsWith('-'))
    assert.ok(!candidate.includes('--'))
  }

  // An oversized base is shortened to make room for the suffix.
  const oversized = `${'b'.repeat(70)}`
  const shortened = buildCandidateLoginId(oversized, 5)
  assert.equal(shortened.length, 64)
  assert.ok(shortened.endsWith('-5'))

  // Trailing hyphens exposed by the shortening are trimmed.
  const trailing = `${'c'.repeat(61)}-dd`
  const trimmed = buildCandidateLoginId(trailing, 9)
  assert.ok(!trimmed.includes('--'))
  assert.ok(trimmed.length <= 64)
})

test('student creation: same name in A and B creates distinct auth UIDs and local suffix collisions', async () => {
  const firestore = createMockFirestore({
    ...foundation('classA', 'teacherA'),
    ...foundation('classB', 'teacherB'),
  })

  const resA1 = await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'Alex Smith' } }),
    { firestore, now: () => 1000, hashPin: stubHashPin },
  )
  assert.equal(resA1.loginId, 'alex-smith')
  assert.equal(resA1.authUid, deriveDeterministicStudentAuthUid('classA', 'stu1'))

  // Second same-name student in classroom A takes the local suffix.
  const resA2 = await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classA', studentId: 'stu2', after: { name: 'Alex Smith' } }),
    { firestore, now: () => 1000, hashPin: stubHashPin },
  )
  assert.equal(resA2.loginId, 'alex-smith-2')

  // Third one keeps counting.
  const resA3 = await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classA', studentId: 'stu3', after: { name: 'Alex Smith' } }),
    { firestore, now: () => 1000, hashPin: stubHashPin },
  )
  assert.equal(resA3.loginId, 'alex-smith-3')

  // Classroom B is a separate namespace.
  const resB1 = await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classB', studentId: 'stu1', after: { name: 'Alex Smith' } }),
    { firestore, now: () => 1000, hashPin: stubHashPin },
  )
  assert.equal(resB1.loginId, 'alex-smith')
  assert.equal(resB1.authUid, deriveDeterministicStudentAuthUid('classB', 'stu1'))
  assert.notEqual(resA1.authUid, resB1.authUid)

  const created = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.equal(created.active, false)
  assert.equal(created.schemaVersion, 1)
  assert.equal(created.classroomId, 'classA')
  assert.equal(created.studentId, 'stu1')
  assert.equal(created.loginId, 'alex-smith')

  // No student document is ever written back onto the trigger path.
  const studentWrites = Array.from(firestore.store.keys()).filter(path =>
    path.includes('/students/'),
  )
  assert.deepEqual(studentWrites, [])

  // Creation used a create precondition, not a blind set.
  const createOps = firestore.attemptOperations
    .flat()
    .filter(op => op.kind === 'create')
  assert.equal(createOps.length, 4)
  assert.equal(
    firestore.attemptOperations.flat().filter(op => op.kind === 'set').length,
    0,
  )
})

test('new credential receives a freshly hashed default PIN at cost 12', async () => {
  assert.equal(STUDENT_PIN_BCRYPT_COST, 12)
  assert.equal(DEFAULT_STUDENT_PIN, '1234')

  const productionHash = await defaultHashPin(DEFAULT_STUDENT_PIN)
  assert.match(productionHash, /^\$2[aby]\$12\$/)
  assert.equal(await bcrypt.compare(DEFAULT_STUDENT_PIN, productionHash), true)

  const firestore = createMockFirestore(foundation('classA', 'teacherA'))
  await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'Alex Smith' } }),
    { firestore },
  )

  const created = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.match(created.pinHash, /^\$2[aby]\$12\$/)
  assert.equal(await bcrypt.compare(DEFAULT_STUDENT_PIN, created.pinHash), true)
  // The shared timing-defense dummy hash is never stored as a live credential.
  assert.notEqual(
    created.pinHash,
    '$2b$10$Ds5wfuAE9LT3Xe4vdygSMu1VUq0m8830nB5uQauQ0105kP4WDUR.a',
  )
})

test('default PIN hashing happens once, outside the retriable transaction', async () => {
  let hashCalls = 0
  const countingHash = async (pin) => {
    hashCalls += 1
    return `hashed_${pin}`
  }

  // Abort the first attempt so the transaction callback runs twice.
  let aborted = false
  const firestore = createMockFirestore(foundation('classA', 'teacherA'), {
    beforeCommit: ({ attemptNumber }) => {
      if (attemptNumber === 1 && !aborted) {
        aborted = true
        return 'abort'
      }
      return undefined
    },
  })

  await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'Alex Smith' } }),
    { firestore, hashPin: countingHash },
  )

  assert.equal(firestore.transactionAttempts, 2)
  assert.equal(hashCalls, 1)
})

test('student update: rename keeps login ID stable and update allowlist preserves identity/lock fields', async () => {
  const firestore = createMockFirestore({
    ...foundation('classA', 'teacherA'),
    'classrooms/classA/studentCredentials/alex-smith': scopedCredential(
      'classA',
      'alex-smith',
      'stu1',
      { failedAttempts: 2, lockedUntil: 9999, createdAt: 500 },
    ),
  })

  const res = await syncStudentProfilesV2Handler(
    v2WrittenEvent({
      classroomId: 'classA',
      studentId: 'stu1',
      before: { name: 'Alex Smith' },
      after: { name: 'Alexander Smith Jr' },
    }),
    { firestore, now: () => 2000, hashPin: stubHashPin },
  )
  assert.equal(res.action, 'updated')

  const cred = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.equal(cred.loginId, 'alex-smith')
  assert.equal(cred.studentId, 'stu1')
  assert.equal(cred.authUid, deriveDeterministicStudentAuthUid('classA', 'stu1'))
  assert.equal(cred.pinHash, 'secret_hash')
  assert.equal(cred.failedAttempts, 2)
  assert.equal(cred.lockedUntil, 9999)
  assert.equal(cred.schemaVersion, 1)
  assert.equal(cred.createdAt, 500)
  assert.equal(cred.updatedAt, 2000)
  assert.equal(cred.active, true)

  // Verify NO student document was written back to classrooms/classA/students/stu1!
  assert.equal(firestore.store.get('classrooms/classA/students/stu1'), undefined)
})

test('student delete: deactivates credential without deleting document; state-idempotent', async () => {
  const firestore = createMockFirestore({
    ...foundation('classA', 'teacherA'),
    ...foundation('classB', 'teacherB'),
    'classrooms/classA/studentCredentials/alex-smith': scopedCredential('classA', 'alex-smith', 'stu1'),
    'classrooms/classB/studentCredentials/alex-smith': scopedCredential('classB', 'alex-smith', 'stu1'),
  })

  const deleteEvent = v2WrittenEvent({
    classroomId: 'classA',
    studentId: 'stu1',
    before: { name: 'Alex Smith' },
  })

  const res1 = await syncStudentProfilesV2Handler(deleteEvent, {
    firestore,
    now: () => 3000,
    hashPin: stubHashPin,
  })
  assert.equal(res1.action, 'deactivated')

  const cred = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.ok(cred !== undefined)
  assert.equal(cred.active, false)
  assert.equal(cred.updatedAt, 3000)

  // Classroom B's identically named credential is untouched.
  const credB = firestore.store.get('classrooms/classB/studentCredentials/alex-smith')
  assert.equal(credB.active, true)
  assert.equal(credB.updatedAt, undefined)

  // Repeated delete is state-idempotent
  const res2 = await syncStudentProfilesV2Handler(deleteEvent, {
    firestore,
    now: () => 4000,
    hashPin: stubHashPin,
  })
  assert.equal(res2.action, 'deactivated')

  // A delete with no credential at all is a no-op rather than an error.
  const res3 = await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classA', studentId: 'stu404', before: { name: 'Ghost' } }),
    { firestore, hashPin: stubHashPin },
  )
  assert.equal(res3.action, 'deleted_noop')
})

test('recycled studentId is rejected (fail closed) without echoing the identifier', async () => {
  const firestore = createMockFirestore({
    ...foundation('classA', 'teacherA'),
    'classrooms/classA/studentCredentials/old-student': scopedCredential(
      'classA',
      'old-student',
      'stu_recycled',
      { active: false, pinHash: 'old_secret_pin_hash' },
    ),
  })

  await assert.rejects(
    () =>
      syncStudentProfilesV2Handler(
        v2WrittenEvent({
          classroomId: 'classA',
          studentId: 'stu_recycled',
          after: { name: 'New Student' },
        }),
        { firestore, hashPin: stubHashPin },
      ),
    (err) => {
      assert.ok(err instanceof SyncStudentProfilesError)
      assert.equal(err.code, 'failed-precondition')
      assert.ok(err.message.includes('recycled studentId'))
      // Identifiers stay out of error text.
      assert.ok(!err.message.includes('stu_recycled'))
      return true
    },
  )

  // Verify old credential was NOT repurposed/overwritten
  const cred = firestore.store.get('classrooms/classA/studentCredentials/old-student')
  assert.equal(cred.pinHash, 'old_secret_pin_hash')
  assert.equal(cred.loginId, 'old-student')
  assert.equal(cred.active, false)
})

test('malformed event params, payload, or foundation rejected', async () => {
  const cases = [
    {
      desc: 'malformed classroom param',
      event: v2WrittenEvent({ classroomId: 'invalid/class', studentId: 'stu1', after: { name: 'A' } }),
      docs: {},
      code: 'invalid-argument',
    },
    {
      desc: 'missing params',
      event: { data: { before: documentSnapshot('p'), after: documentSnapshot('p', {}) } },
      docs: {},
      code: 'invalid-argument',
    },
    {
      desc: 'missing change payload',
      event: { params: { classroomId: 'classA', studentId: 'stu1' } },
      docs: foundation('classA', 'teacherA'),
      code: 'invalid-argument',
    },
    {
      desc: 'missing classroom foundation',
      event: v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'A' } }),
      docs: {},
      code: 'failed-precondition',
    },
    {
      desc: 'classroom without owner',
      event: v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'A' } }),
      docs: { 'classrooms/classA': {} },
      code: 'failed-precondition',
    },
    {
      desc: 'missing teacher document',
      event: v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'A' } }),
      docs: { 'classrooms/classA': { ownerUid: 'teacherA' } },
      code: 'failed-precondition',
    },
    {
      desc: 'disabled teacher',
      event: v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'A' } }),
      docs: {
        'classrooms/classA': { ownerUid: 'teacherA' },
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'disabled' },
      },
      code: 'failed-precondition',
    },
    {
      desc: 'teacher owning another classroom',
      event: v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'A' } }),
      docs: {
        'classrooms/classA': { ownerUid: 'teacherA' },
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'classB', status: 'active' },
      },
      code: 'failed-precondition',
    },
  ]

  for (const { desc, event, docs, code } of cases) {
    const firestore = createMockFirestore(docs)
    await assert.rejects(
      () => syncStudentProfilesV2Handler(event, { firestore, hashPin: stubHashPin }),
      (err) => {
        assert.ok(err instanceof SyncStudentProfilesError, `${desc}: ${err?.name}`)
        assert.equal(err.code, code, `${desc}: unexpected code ${err.code}`)
        assert.ok(!err.message.includes('stu1'), `${desc}: leaked studentId`)
        return true
      },
      `Failed on ${desc}`,
    )

    // Nothing was written for a rejected event.
    const credentialWrites = Array.from(firestore.store.keys()).filter(path =>
      path.includes('/studentCredentials/'),
    )
    assert.deepEqual(credentialWrites, [], desc)
  }
})

test('v1-compatible event.change alias remains accepted', async () => {
  const firestore = createMockFirestore(foundation('classA', 'teacherA'))
  const documentPath = 'classrooms/classA/students/stu1'

  const res = await syncStudentProfilesV2Handler(
    {
      params: { classroomId: 'classA', studentId: 'stu1' },
      change: {
        before: documentSnapshot(documentPath),
        after: documentSnapshot(documentPath, { name: 'Alex Smith' }),
      },
    },
    { firestore, hashPin: stubHashPin },
  )

  assert.equal(res.action, 'created')
  assert.equal(res.loginId, 'alex-smith')
})

test('foundation is validated inside the credential transaction, blocking a mid-flight change', async () => {
  // The teacher is disabled after the first attempt's reads; that attempt is
  // aborted (as real Firestore aborts when a document it read changed), and the
  // retry must see the disabled foundation and refuse to write.
  let disabled = false
  const firestore = createMockFirestore(foundation('classA', 'teacherA'), {
    beforeCommit: ({ attemptNumber }) => {
      if (attemptNumber === 1 && !disabled) {
        disabled = true
        firestore.store.set('teachers/teacherA', {
          uid: 'teacherA',
          classroomId: 'classA',
          status: 'disabled',
        })
        return 'abort'
      }
      return undefined
    },
  })

  await assert.rejects(
    () =>
      syncStudentProfilesV2Handler(
        v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'Alex Smith' } }),
        { firestore, hashPin: stubHashPin },
      ),
    (err) => err instanceof SyncStudentProfilesError && err.code === 'failed-precondition',
  )

  assert.equal(firestore.transactionAttempts, 2)
  assert.equal(firestore.store.get('classrooms/classA/studentCredentials/alex-smith'), undefined)

  // Both the classroom and teacher reads happen inside every attempt, before
  // any write in that attempt.
  for (const operations of firestore.attemptOperations) {
    const readPaths = operations.filter(op => op.kind === 'read').map(op => op.path)
    assert.ok(readPaths.includes('classrooms/classA'), 'classroom read inside transaction')
    assert.ok(readPaths.includes('teachers/teacherA'), 'teacher read inside transaction')
    const firstWrite = operations.findIndex(op => op.kind !== 'read')
    const lastRead = operations.reduce(
      (last, op, index) => (op.kind === 'read' ? index : last),
      -1,
    )
    if (firstWrite !== -1) {
      assert.ok(lastRead < firstWrite, 'transaction read followed a write')
    }
  }
})

test('concurrent same-name creates cannot overwrite or share one scoped login ID', async () => {
  const firestore = createMockFirestore(foundation('classA', 'teacherA'))

  // While the first handler call holds its (already scanned) create for
  // `alex-smith`, a second call for a different student commits the same login
  // ID first. The create precondition must reject the loser, which then retries
  // and takes the next suffix.
  let interleaved = false
  const interleavingFirestore = createMockFirestore(foundation('classA', 'teacherA'), {
    beforeCommit: async ({ attemptNumber }) => {
      if (attemptNumber === 1 && !interleaved) {
        interleaved = true
        await syncStudentProfilesV2Handler(
          v2WrittenEvent({ classroomId: 'classA', studentId: 'stu2', after: { name: 'Alex Smith' } }),
          { firestore: interleavingFirestore, now: () => 10, hashPin: stubHashPin },
        )
      }
      return undefined
    },
  })

  const first = await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'Alex Smith' } }),
    { firestore: interleavingFirestore, now: () => 20, hashPin: stubHashPin },
  )

  const credentials = Array.from(interleavingFirestore.store.entries())
    .filter(([path]) => path.includes('/studentCredentials/'))

  assert.equal(credentials.length, 2)
  const byStudent = new Map(credentials.map(([path, data]) => [data.studentId, { path, data }]))

  // The interleaved student kept `alex-smith`; the retried one took the suffix.
  assert.equal(byStudent.get('stu2').path, 'classrooms/classA/studentCredentials/alex-smith')
  assert.equal(byStudent.get('stu1').path, 'classrooms/classA/studentCredentials/alex-smith-2')
  assert.equal(first.loginId, 'alex-smith-2')

  // Distinct login IDs and distinct deterministic Auth UIDs: no aliasing.
  assert.notEqual(byStudent.get('stu1').data.authUid, byStudent.get('stu2').data.authUid)
  assert.equal(
    byStudent.get('stu2').data.authUid,
    deriveDeterministicStudentAuthUid('classA', 'stu2'),
  )
  assert.equal(
    byStudent.get('stu1').data.authUid,
    deriveDeterministicStudentAuthUid('classA', 'stu1'),
  )

  // Sanity: the non-interleaved store behaves the same way sequentially.
  await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', after: { name: 'Alex Smith' } }),
    { firestore, hashPin: stubHashPin },
  )
  assert.ok(firestore.store.has('classrooms/classA/studentCredentials/alex-smith'))
})

test('malformed or forged existing credential is never updated or deactivated', async () => {
  const baseDocs = foundation('classA', 'teacherA')

  const identityCases = [
    { desc: 'mismatched classroomId', path: 'classrooms/classA/studentCredentials/alex-smith', overrides: { classroomId: 'classB' } },
    { desc: 'missing classroomId', path: 'classrooms/classA/studentCredentials/alex-smith', overrides: { classroomId: undefined } },
    { desc: 'forged authUid', path: 'classrooms/classA/studentCredentials/alex-smith', overrides: { authUid: 's_forged' } },
    { desc: 'missing authUid', path: 'classrooms/classA/studentCredentials/alex-smith', overrides: { authUid: undefined } },
    { desc: 'unsupported schemaVersion', path: 'classrooms/classA/studentCredentials/alex-smith', overrides: { schemaVersion: 7 } },
    { desc: 'body loginId disagreeing with document ID', path: 'classrooms/classA/studentCredentials/alex-smith', overrides: { loginId: 'other-login' } },
    { desc: 'noncanonical credential document ID', path: 'classrooms/classA/studentCredentials/Alex-Smith', overrides: { loginId: undefined } },
  ]

  for (const { desc, path, overrides } of identityCases) {
    for (const operation of ['update', 'delete']) {
      const credential = scopedCredential('classA', 'alex-smith', 'stu1', overrides)
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete credential[key]
        }
      }

      const firestore = createMockFirestore({ ...baseDocs, [path]: credential })
      const event = operation === 'update'
        ? v2WrittenEvent({
            classroomId: 'classA',
            studentId: 'stu1',
            before: { name: 'Alex' },
            after: { name: 'Alex Renamed' },
          })
        : v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', before: { name: 'Alex' } })

      await assert.rejects(
        () => syncStudentProfilesV2Handler(event, { firestore, now: () => 9000, hashPin: stubHashPin }),
        (err) => {
          assert.ok(err instanceof SyncStudentProfilesError, `${desc}/${operation}`)
          assert.equal(err.code, 'failed-precondition', `${desc}/${operation}`)
          return true
        },
        `Failed on ${desc}/${operation}`,
      )

      const stored = firestore.store.get(path)
      assert.equal(stored.updatedAt, undefined, `${desc}/${operation}: mutated`)
      assert.equal(stored.active, true, `${desc}/${operation}: deactivated`)
    }
  }

  // Two credentials for one studentId block instead of picking one.
  const duplicated = createMockFirestore({
    ...baseDocs,
    'classrooms/classA/studentCredentials/alex-smith': scopedCredential('classA', 'alex-smith', 'stu1'),
    'classrooms/classA/studentCredentials/alex-smith-2': scopedCredential('classA', 'alex-smith-2', 'stu1'),
  })
  await assert.rejects(
    () =>
      syncStudentProfilesV2Handler(
        v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', before: { name: 'A' }, after: { name: 'B' } }),
        { firestore: duplicated, hashPin: stubHashPin },
      ),
    (err) => err instanceof SyncStudentProfilesError && err.code === 'failed-precondition',
  )

  // An update with no credential at all fails closed rather than creating one.
  const missing = createMockFirestore(baseDocs)
  await assert.rejects(
    () =>
      syncStudentProfilesV2Handler(
        v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1', before: { name: 'A' }, after: { name: 'B' } }),
        { firestore: missing, hashPin: stubHashPin },
      ),
    (err) => err instanceof SyncStudentProfilesError && err.code === 'failed-precondition',
  )
  assert.equal(
    Array.from(missing.store.keys()).filter(p => p.includes('/studentCredentials/')).length,
    0,
  )
})

test('a write with neither snapshot present is an inert no-op', async () => {
  const firestore = createMockFirestore(foundation('classA', 'teacherA'))

  const res = await syncStudentProfilesV2Handler(
    v2WrittenEvent({ classroomId: 'classA', studentId: 'stu1' }),
    { firestore, hashPin: stubHashPin },
  )

  assert.deepEqual(res, { success: true, action: 'none' })
  assert.equal(
    Array.from(firestore.store.keys()).filter(p => p.includes('/studentCredentials/')).length,
    0,
  )
})
