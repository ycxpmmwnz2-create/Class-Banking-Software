import assert from 'node:assert/strict'
import test from 'node:test'

import { FieldValue, Timestamp } from 'firebase-admin/firestore'

import { CLASSROOM_CODE_ALPHABET, hashEmailDigest } from './identityNormalization.js'
import {
  generateClassroomCode,
  onboardTeacherClassroomService,
  resolveTeacherTenantService,
} from './teacherOnboarding.js'


/**
 * Deep-clones plain objects/arrays but passes class instances through by
 * reference, so Firestore `Timestamp` values and `FieldValue` sentinels survive
 * a round trip into the mock store. A JSON clone would silently flatten a
 * Timestamp into `{_seconds,_nanoseconds}` and destroy `toMillis`.
 */
function cloneValue(value) {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(cloneValue)
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return value
  }
  const output = {}
  for (const [key, nested] of Object.entries(value)) {
    output[key] = cloneValue(nested)
  }
  return output
}

function createMockFirestore(initialDocs = {}) {
  const store = new Map()

  for (const [path, data] of Object.entries(initialDocs)) {
    store.set(path, cloneValue(data))
  }

  const reads = []
  const creates = []
  const updates = []
  const deletes = []

  function docRef(path) {
    const parts = path.split('/')
    const id = parts[parts.length - 1]
    return {
      path,
      id,
      async get() {
        reads.push(path)
        const data = store.get(path)
        return {
          exists: data !== undefined,
          id,
          path,
          data: () => (data ? cloneValue(data) : undefined),
        }
      },
    }
  }


  return {
    store,
    reads,
    creates,
    updates,
    deletes,
    collection(collectionName) {
      return {
        doc(docId) {
          const generatedId = docId || `auto-id-${Math.random().toString(36).slice(2, 8)}`
          const path = `${collectionName}/${generatedId}`
          return docRef(path)
        },
        where(field, op, value) {
          return {
            limit(count) {
              return {
                queryInfo: { collectionName, field, op, value, limit: count },
              }
            },
          }
        },
      }
    },
    async runTransaction(callback) {
      const transactionReads = []
      // Writes are buffered and committed all-or-nothing after the callback
      // resolves, so a violated `create` precondition leaves no partial state —
      // the property the onboarding transaction depends on.
      const pending = []

      const transaction = {
        async get(target) {
          if (target.queryInfo) {
            const { collectionName, field, op, value, limit } = target.queryInfo
            const matches = []
            for (const [p, data] of store.entries()) {
              if (p.startsWith(`${collectionName}/`)) {
                if (op === '==' && data[field] === value) {
                  matches.push({ id: p.split('/')[1], path: p, data: () => data })
                }
              }
            }
            const limited = matches.slice(0, limit)
            transactionReads.push(`query:${collectionName}?${field}${op}${value}`)
            return {
              empty: limited.length === 0,
              docs: limited,
              size: limited.length,
            }
          }

          const path = target.path
          transactionReads.push(path)
          reads.push(path)
          const data = store.get(path)
          return {
            exists: data !== undefined,
            id: target.id,
            path,
            data: () => (data ? cloneValue(data) : undefined),
          }
        },
        create(targetRef, data) {
          pending.push({ op: 'create', path: targetRef.path, data })
        },
        update(targetRef, data) {
          pending.push({ op: 'update', path: targetRef.path, data })
        },
        delete(targetRef) {
          pending.push({ op: 'delete', path: targetRef.path })
        },
      }

      const result = await callback(transaction)

      // Commit phase: validate every precondition before applying anything.
      for (const entry of pending) {
        if (entry.op === 'create' && store.has(entry.path)) {
          const error = new Error(`Document already exists at ${entry.path}`)
          error.code = 'already-exists'
          throw error
        }
        if (entry.op === 'update' && !store.has(entry.path)) {
          throw new Error(`Document does not exist at ${entry.path}`)
        }
      }

      for (const entry of pending) {
        if (entry.op === 'create') {
          store.set(entry.path, cloneValue(entry.data))
          creates.push({ path: entry.path, data: entry.data })
        } else if (entry.op === 'update') {
          store.set(entry.path, cloneValue({ ...store.get(entry.path), ...entry.data }))
          updates.push({ path: entry.path, data: entry.data })
        } else {
          store.delete(entry.path)
          deletes.push(entry.path)
        }
      }

      return result
    },
  }
}

function googleAuth(uid = 'teacher-uid-1', email = 'teacher@example.com', name = 'Teacher One') {
  return {
    uid,
    token: {
      email_verified: true,
      email,
      name,
      firebase: { sign_in_provider: 'google.com' },
    },
  }
}

test('onboardTeacherClassroomService: successful atomic creation', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const db = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: {
      email: 'teacher@example.com',
      status: 'active',
    },
  })

  const result = await onboardTeacherClassroomService({
    firestore: db,
    auth: googleAuth(),
    data: { classroomName: 'Algebra 1' },
    codeGenerator: () => '23456789',
    serverTimestamp: () => '2026-07-25T00:00:00Z',
  })

  assert.equal(result.created, true)
  assert.equal(result.teacher.uid, 'teacher-uid-1')
  assert.equal(result.teacher.status, 'active')
  assert.equal(result.teacher.email, 'teacher@example.com')
  assert.equal(result.classroom.name, 'Algebra 1')
  assert.equal(result.classroom.studentLoginCode, '2345-6789')
  assert.ok(result.classroom.id)

  assert.ok(db.store.has(`teachers/teacher-uid-1`))
  assert.ok(db.store.has(`classrooms/${result.classroom.id}`))
  assert.ok(db.store.has(`classroomLoginCodes/23456789`))
  assert.equal(db.store.get(`teacherInvitations/${emailDigest}`).status, 'consumed')
})

test('onboardTeacherClassroomService: rejects unauthenticated or invalid provider/unverified email', async () => {
  const db = createMockFirestore()

  await assert.rejects(
    onboardTeacherClassroomService({ firestore: db, auth: null, data: { classroomName: 'Math' } }),
    err => err.code === 'unauthenticated',
  )

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: { uid: 'u1', token: { email_verified: false, firebase: { sign_in_provider: 'google.com' }, email: 'a@b.com' } },
      data: { classroomName: 'Math' },
    }),
    err => err.code === 'permission-denied',
  )

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: { uid: 'u1', token: { email_verified: true, firebase: { sign_in_provider: 'password' }, email: 'a@b.com' } },
      data: { classroomName: 'Math' },
    }),
    err => err.code === 'permission-denied',
  )
})

test('onboardTeacherClassroomService: rejects unknown fields in request data', async () => {
  const db = createMockFirestore()

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth(),
      data: { classroomName: 'Math', uid: 'forged-uid' },
    }),
    err => err.code === 'invalid-argument',
  )

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth(),
      data: { classroomName: 'Math', email: 'forged@email.com' },
    }),
    err => err.code === 'invalid-argument',
  )
})

test('onboardTeacherClassroomService: rejects uninvited, revoked, expired, and disabled users', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')

  // Uninvited
  const db1 = createMockFirestore()
  await assert.rejects(
    onboardTeacherClassroomService({ firestore: db1, auth: googleAuth(), data: { classroomName: 'Math' } }),
    err => err.code === 'permission-denied',
  )

  // Revoked
  const db2 = createMockFirestore({ [`teacherInvitations/${emailDigest}`]: { status: 'revoked' } })
  await assert.rejects(
    onboardTeacherClassroomService({ firestore: db2, auth: googleAuth(), data: { classroomName: 'Math' } }),
    err => err.code === 'permission-denied',
  )

  // Expired
  const db3 = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: { status: 'active', expiresAt: 1000 },
  })
  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db3,
      auth: googleAuth(),
      data: { classroomName: 'Math' },
      now: () => 2000,
    }),
    err => err.code === 'permission-denied',
  )

  // Disabled teacher
  const db4 = createMockFirestore({
    'teachers/teacher-uid-1': { uid: 'teacher-uid-1', status: 'disabled' },
  })
  await assert.rejects(
    onboardTeacherClassroomService({ firestore: db4, auth: googleAuth(), data: { classroomName: 'Math' } }),
    err => err.code === 'permission-denied',
  )
})

test('onboardTeacherClassroomService: idempotent retry returns existing foundation without writing', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const db = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom-1',
      status: 'active',
    },
    'classrooms/classroom-1': {
      ownerUid: 'teacher-uid-1',
      name: 'Original Name',
      studentLoginCode: '2345-6789',
    },
    'classroomLoginCodes/23456789': {
      classroomId: 'classroom-1',
      status: 'active',
    },
    [`teacherInvitations/${emailDigest}`]: {
      status: 'consumed',
    },
  })

  const result = await onboardTeacherClassroomService({
    firestore: db,
    auth: googleAuth('teacher-uid-1'),
    data: { classroomName: 'Different Submitted Name' },
  })

  assert.equal(result.created, false)
  assert.equal(result.classroom.id, 'classroom-1')
  assert.equal(result.classroom.name, 'Original Name')
  assert.equal(db.creates.length, 0)
  assert.equal(db.updates.length, 0)
})

test('onboardTeacherClassroomService: handles code collision retries up to limit', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const db = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: { status: 'active' },
    'classroomLoginCodes/23456789': { classroomId: 'other-class', status: 'active' },
  })

  let attempts = 0
  const codeGen = () => {
    attempts += 1
    return attempts === 1 ? '23456789' : '3456789A'
  }

  const result = await onboardTeacherClassroomService({
    firestore: db,
    auth: googleAuth(),
    data: { classroomName: 'Math' },
    codeGenerator: codeGen,
  })

  assert.equal(result.created, true)
  assert.equal(result.classroom.studentLoginCode, '3456-789A')
  assert.equal(attempts, 2)
})

test('onboardTeacherClassroomService: throws resource-exhausted if all code generation retries collide', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const db = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: { status: 'active' },
    'classroomLoginCodes/23456789': { classroomId: 'other-class', status: 'active' },
  })

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth(),
      data: { classroomName: 'Math' },
      codeGenerator: () => '23456789',
    }),
    err => err.code === 'resource-exhausted',
  )
})

test('onboardTeacherClassroomService: rejects orphan classroom conflict or consumed invitation', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')

  // Orphan classroom
  const db1 = createMockFirestore({
    'classrooms/orphan-1': { ownerUid: 'teacher-uid-1', name: 'Orphan' },
    [`teacherInvitations/${emailDigest}`]: { status: 'active' },
  })

  await assert.rejects(
    onboardTeacherClassroomService({ firestore: db1, auth: googleAuth(), data: { classroomName: 'Math' } }),
    err => err.code === 'failed-precondition',
  )
  assert.equal(db1.creates.length, 0)

  // Invitation already consumed by another user
  const db2 = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: { status: 'consumed', consumedByUid: 'other-uid' },
  })

  await assert.rejects(
    onboardTeacherClassroomService({ firestore: db2, auth: googleAuth(), data: { classroomName: 'Math' } }),
    err => err.code === 'already-exists',
  )
  assert.equal(db2.creates.length, 0)
})

test('resolveTeacherTenantService: returns active state for existing valid teacher', async () => {
  const db = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom-1',
      status: 'active',
      displayName: 'Teacher One',
      email: 'teacher@example.com',
    },
    'classrooms/classroom-1': {
      ownerUid: 'teacher-uid-1',
      name: "Teacher One's Class",
      studentLoginCode: '2345-6789',
    },
  })

  const res = await resolveTeacherTenantService({
    firestore: db,
    auth: { uid: 'teacher-uid-1' },
  })

  assert.equal(res.state, 'active')
  assert.equal(res.teacher.uid, 'teacher-uid-1')
  assert.equal(res.classroom.id, 'classroom-1')
  assert.equal(res.classroom.studentLoginCode, '2345-6789')
})

test('resolveTeacherTenantService: returns onboarding-required for invited unonboarded user', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const db = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: {
      status: 'active',
    },
  })

  const res = await resolveTeacherTenantService({
    firestore: db,
    auth: googleAuth(),
  })

  assert.equal(res.state, 'onboarding-required')
  assert.equal(res.eligibility, 'invited')
})

test('resolveTeacherTenantService: rejects uninvited user or disabled teacher', async () => {
  const db1 = createMockFirestore()

  await assert.rejects(
    resolveTeacherTenantService({ firestore: db1, auth: googleAuth() }),
    err => err.code === 'permission-denied',
  )

  const db2 = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      status: 'disabled',
    },
  })

  await assert.rejects(
    resolveTeacherTenantService({ firestore: db2, auth: googleAuth() }),
    err => err.code === 'permission-denied',
  )
})

// ---------------------------------------------------------------------------
// Cycle 1 review regression tests
// ---------------------------------------------------------------------------

/**
 * Regression: the default dependencies once used `FieldValue.serverTimestamp`
 * as both the write sentinel and the current-time source. A sentinel is a
 * write-time transform, not a readable clock, so `expiresAt <= now` compared a
 * number against an object, evaluated to NaN-false, and accepted an expired
 * invitation on the production default path. This test injects nothing, so it
 * exercises the real defaults.
 */
test('onboardTeacherClassroomService: production default dependencies reject an expired invitation', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const db = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: {
      status: 'active',
      expiresAt: Timestamp.fromMillis(Date.now() - 3600_000),
    },
  })

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth(),
      data: { classroomName: 'Math' },
      // No `now`, no `serverTimestamp`, no `codeGenerator`: production defaults.
    }),
    err => err.code === 'permission-denied',
  )

  assert.equal(db.creates.length, 0)
  assert.equal(db.updates.length, 0)
  assert.equal(db.store.get(`teacherInvitations/${emailDigest}`).status, 'active')
})

test('onboardTeacherClassroomService: default dependencies accept an unexpired invitation', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const db = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: {
      status: 'active',
      expiresAt: Timestamp.fromMillis(Date.now() + 3600_000),
    },
  })

  const result = await onboardTeacherClassroomService({
    firestore: db,
    auth: googleAuth(),
    data: { classroomName: 'Math' },
  })

  assert.equal(result.created, true)
  assert.equal(db.store.get(`teacherInvitations/${emailDigest}`).status, 'consumed')
})

/**
 * Fail-closed: a serverTimestamp sentinel supplied where a clock is expected
 * must never read as "not expired".
 */
test('onboardTeacherClassroomService: a serverTimestamp sentinel as the clock fails closed', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const db = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: {
      status: 'active',
      expiresAt: Timestamp.fromMillis(Date.now() - 3600_000),
    },
  })

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth(),
      data: { classroomName: 'Math' },
      now: FieldValue.serverTimestamp,
    }),
    err => err.code === 'failed-precondition',
  )

  assert.equal(db.creates.length, 0)
})

test('onboardTeacherClassroomService: unreadable expiresAt values fail closed', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')

  for (const expiresAt of ['not-a-timestamp', Number.NaN, {}, true]) {
    const db = createMockFirestore({
      [`teacherInvitations/${emailDigest}`]: { status: 'active', expiresAt },
    })

    await assert.rejects(
      onboardTeacherClassroomService({
        firestore: db,
        auth: googleAuth(),
        data: { classroomName: 'Math' },
        now: () => Date.now(),
      }),
      err => err.code === 'failed-precondition',
      `expiresAt ${String(expiresAt)} should fail closed`,
    )
    assert.equal(db.creates.length, 0)
  }
})

test('onboardTeacherClassroomService: Date and Timestamp expiry forms are both honoured', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')

  const dbExpiredDate = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: {
      status: 'active',
      expiresAt: new Date(Date.now() - 1000),
    },
  })
  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: dbExpiredDate,
      auth: googleAuth(),
      data: { classroomName: 'Math' },
    }),
    err => err.code === 'permission-denied',
  )

  const dbExpiredNumber = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: { status: 'active', expiresAt: 1000 },
  })
  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: dbExpiredNumber,
      auth: googleAuth(),
      data: { classroomName: 'Math' },
      now: () => 2000,
    }),
    err => err.code === 'permission-denied',
  )
})

/**
 * Regression: classroom codes were drawn from `Math.random`, whose internal
 * state is recoverable from observed output, making live student-facing codes
 * predictable. Stubbing `Math.random` to a constant must not make the generator
 * deterministic.
 */
test('generateClassroomCode: draws from a CSPRNG, not Math.random', () => {
  const originalRandom = Math.random
  Math.random = () => 0
  try {
    const samples = new Set()
    for (let index = 0; index < 200; index += 1) {
      const code = generateClassroomCode()
      assert.equal(code.length, 8)
      for (const character of code) {
        assert.equal(
          CLASSROOM_CODE_ALPHABET.includes(character),
          true,
          `unexpected character ${character}`,
        )
      }
      samples.add(code)
    }
    // With Math.random pinned, a Math.random-based generator emits one value.
    assert.ok(
      samples.size > 190,
      `expected near-unique codes from a CSPRNG, got ${samples.size} distinct of 200`,
    )
  } finally {
    Math.random = originalRandom
  }
})

/**
 * The plan requires the code index be queried by classroomId and contain
 * exactly the one entry named by the classroom root. Reading only the named
 * document leaves a duplicate index undetected.
 */
test('onboardTeacherClassroomService: duplicate login code indexes block instead of resolving', async () => {
  const db = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom-1',
      status: 'active',
    },
    'classrooms/classroom-1': {
      ownerUid: 'teacher-uid-1',
      name: 'Original Name',
      studentLoginCode: '2345-6789',
    },
    'classroomLoginCodes/23456789': { classroomId: 'classroom-1', status: 'active' },
    // Stale duplicate left by a partially completed operation.
    'classroomLoginCodes/3456789A': { classroomId: 'classroom-1', status: 'active' },
  })

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth('teacher-uid-1'),
      data: { classroomName: 'Math' },
    }),
    err => err.code === 'failed-precondition',
  )

  assert.equal(db.creates.length, 0)
  assert.equal(db.updates.length, 0)
})

test('onboardTeacherClassroomService: code index naming a different code than the classroom root blocks', async () => {
  const db = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom-1',
      status: 'active',
    },
    'classrooms/classroom-1': {
      ownerUid: 'teacher-uid-1',
      name: 'Original Name',
      studentLoginCode: '2345-6789',
    },
    // Index exists for the classroom, but under a different code.
    'classroomLoginCodes/3456789A': { classroomId: 'classroom-1', status: 'active' },
  })

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth('teacher-uid-1'),
      data: { classroomName: 'Math' },
    }),
    err => err.code === 'failed-precondition',
  )
  assert.equal(db.creates.length, 0)
})

test('onboardTeacherClassroomService: classroom lacking a login code blocks without repair', async () => {
  const db = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom-1',
      status: 'active',
    },
    'classrooms/classroom-1': { ownerUid: 'teacher-uid-1', name: 'Original Name' },
  })

  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth('teacher-uid-1'),
      data: { classroomName: 'Math' },
    }),
    err => err.code === 'failed-precondition',
  )
  assert.equal(db.creates.length, 0)
  assert.equal(db.updates.length, 0)
})

/**
 * A stored classroomId is untrusted input for path construction. The shared
 * canonical contract must reject it before any read is issued.
 */
test('onboardTeacherClassroomService: malformed stored classroomId never builds a path', async () => {
  for (const classroomId of ['classroom/../evil', '  classroom-1  ', '.', '..', '', 42]) {
    const db = createMockFirestore({
      'teachers/teacher-uid-1': {
        uid: 'teacher-uid-1',
        classroomId,
        status: 'active',
      },
    })

    await assert.rejects(
      onboardTeacherClassroomService({
        firestore: db,
        auth: googleAuth('teacher-uid-1'),
        data: { classroomName: 'Math' },
      }),
      err => err.code === 'failed-precondition',
      `classroomId ${String(classroomId)} should be rejected`,
    )

    assert.equal(
      db.reads.some(path => path !== 'teachers/teacher-uid-1'),
      false,
      `no read beyond the teacher document should occur, saw ${db.reads.join(', ')}`,
    )
    assert.equal(db.creates.length, 0)
  }
})

/**
 * Two simultaneous onboarding calls for one UID serialize on `teachers/{uid}`.
 * Exactly one creates a classroom; the retrying caller resolves the committed
 * foundation idempotently and both callers receive the same tenant.
 */
test('onboardTeacherClassroomService: simultaneous calls for one UID create exactly one classroom', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const db = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: { status: 'active' },
  })

  let codeCounter = 0
  const codeGenerator = () => {
    codeCounter += 1
    return codeCounter === 1 ? '23456789' : '3456789A'
  }

  const settled = await Promise.allSettled([
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth('teacher-uid-1'),
      data: { classroomName: 'First' },
      codeGenerator,
    }),
    onboardTeacherClassroomService({
      firestore: db,
      auth: googleAuth('teacher-uid-1'),
      data: { classroomName: 'Second' },
      codeGenerator,
    }),
  ])

  const fulfilled = settled.filter(entry => entry.status === 'fulfilled')
  assert.equal(fulfilled.length, 2, 'both concurrent calls should resolve idempotently')
  assert.deepEqual(
    fulfilled.map(entry => entry.value.created).sort(),
    [false, true],
  )
  assert.equal(
    fulfilled[0].value.classroom.id,
    fulfilled[1].value.classroom.id,
  )

  const teacherCreates = db.creates.filter(entry => entry.path.startsWith('teachers/'))
  const classroomCreates = db.creates.filter(entry => entry.path.startsWith('classrooms/'))
  const codeCreates = db.creates.filter(entry => entry.path.startsWith('classroomLoginCodes/'))

  assert.equal(teacherCreates.length, 1)
  assert.equal(classroomCreates.length, 1, 'no second classroom may be created')
  assert.equal(codeCreates.length, 1, 'the loser must not leave an orphan code index')

  const invitationUpdates = db.updates.filter(entry =>
    entry.path.startsWith('teacherInvitations/'),
  )
  assert.equal(invitationUpdates.length, 1, 'the invitation is consumed exactly once')
})

test('resolveTeacherTenantService: malformed stored classroomId is a blocking integrity failure', async () => {
  const db = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom/slash',
      status: 'active',
    },
  })

  await assert.rejects(
    resolveTeacherTenantService({ firestore: db, auth: { uid: 'teacher-uid-1' } }),
    err => err.code === 'failed-precondition',
  )
  assert.equal(
    db.reads.some(path => path.includes('classroom/slash')),
    false,
  )
})

test('resolveTeacherTenantService: owner mismatch and unknown status are blocking integrity failures', async () => {
  const dbOwnerMismatch = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom-1',
      status: 'active',
    },
    'classrooms/classroom-1': { ownerUid: 'other-uid', name: 'Other' },
  })
  await assert.rejects(
    resolveTeacherTenantService({ firestore: dbOwnerMismatch, auth: { uid: 'teacher-uid-1' } }),
    err => err.code === 'failed-precondition',
  )

  const dbUnknownStatus = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom-1',
      status: 'pending',
    },
  })
  await assert.rejects(
    resolveTeacherTenantService({ firestore: dbUnknownStatus, auth: { uid: 'teacher-uid-1' } }),
    err => err.code === 'failed-precondition',
  )

  const dbUidMismatch = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'someone-else',
      classroomId: 'classroom-1',
      status: 'active',
    },
  })
  await assert.rejects(
    resolveTeacherTenantService({ firestore: dbUidMismatch, auth: { uid: 'teacher-uid-1' } }),
    err => err.code === 'failed-precondition',
  )
})

test('resolveTeacherTenantService: rejects any request payload, including non-objects', async () => {
  const db = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom-1',
      status: 'active',
    },
    'classrooms/classroom-1': {
      ownerUid: 'teacher-uid-1',
      name: 'Class',
      studentLoginCode: '2345-6789',
    },
  })

  for (const data of [{ classroomId: 'forged' }, { anything: 1 }, 'classroom-2', 42, ['a']]) {
    await assert.rejects(
      resolveTeacherTenantService({ firestore: db, auth: { uid: 'teacher-uid-1' }, data }),
      err => err.code === 'invalid-argument',
      `data ${JSON.stringify(data)} should be rejected`,
    )
  }

  assert.equal(
    db.reads.some(path => path.includes('forged') || path.includes('classroom-2')),
    false,
  )
})

test('resolveTeacherTenantService: classroom missing a student login code blocks', async () => {
  const db = createMockFirestore({
    'teachers/teacher-uid-1': {
      uid: 'teacher-uid-1',
      classroomId: 'classroom-1',
      status: 'active',
    },
    'classrooms/classroom-1': { ownerUid: 'teacher-uid-1', name: 'Class' },
  })

  await assert.rejects(
    resolveTeacherTenantService({ firestore: db, auth: { uid: 'teacher-uid-1' } }),
    err => err.code === 'failed-precondition',
  )
})

test('resolveTeacherTenantService: expired or malformed invitation is never eligible', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')

  for (const invitation of [
    { email: 'teacher@example.com', status: 'active', expiresAt: 1000 },
    { email: 'other@example.com', status: 'active', expiresAt: 3000 },
    { email: 'not-an-email', status: 'active', expiresAt: 3000 },
    { email: 'teacher@example.com', status: 'active', expiresAt: {} },
  ]) {
    const db = createMockFirestore({
      [`teacherInvitations/${emailDigest}`]: invitation,
    })
    await assert.rejects(
      resolveTeacherTenantService({
        firestore: db,
        auth: googleAuth(),
        now: () => 2000,
      }),
      error => ['permission-denied', 'failed-precondition'].includes(error.code),
    )
  }
})

test('onboarding rejects a mismatched invitation body and consumed partial state', async () => {
  const emailDigest = hashEmailDigest('teacher@example.com')
  const mismatched = createMockFirestore({
    [`teacherInvitations/${emailDigest}`]: {
      email: 'other@example.com',
      status: 'active',
    },
  })
  await assert.rejects(
    onboardTeacherClassroomService({
      firestore: mismatched,
      auth: googleAuth(),
      data: { classroomName: 'Math' },
    }),
    error => error.code === 'failed-precondition',
  )
  assert.equal(mismatched.creates.length, 0)

  for (const consumedByUid of ['teacher-uid-1', undefined]) {
    const partial = createMockFirestore({
      [`teacherInvitations/${emailDigest}`]: {
        status: 'consumed',
        consumedByUid,
      },
    })
    await assert.rejects(
      onboardTeacherClassroomService({
        firestore: partial,
        auth: googleAuth(),
        data: { classroomName: 'Math' },
      }),
      error => error.code === 'failed-precondition',
    )
    assert.equal(partial.creates.length, 0)
  }
})

test('onboarding maps exhausted transaction contention without leaking raw failures', async () => {
  for (const [firestoreCode, expectedCode] of [
    ['aborted', 'aborted'],
    ['already-exists', 'resource-exhausted'],
  ]) {
    let attempts = 0
    const firestore = {
      collection() {
        return { doc() {} }
      },
      async runTransaction() {
        attempts += 1
        const error = new Error('sensitive Firestore transaction detail')
        error.code = firestoreCode
        throw error
      },
    }

    await assert.rejects(
      onboardTeacherClassroomService({
        firestore,
        auth: googleAuth(),
        data: { classroomName: 'Math' },
      }),
      error => {
        assert.equal(error.code, expectedCode)
        assert.doesNotMatch(error.message, /sensitive Firestore/)
        return true
      },
    )
    assert.equal(attempts, 5)
  }
})

test('existing and resolved classrooms require canonical login-code display form', async () => {
  for (const studentLoginCode of ['23456789', '2345 6789', '234-56789']) {
    const foundation = {
      'teachers/teacher-uid-1': {
        uid: 'teacher-uid-1',
        classroomId: 'classroom-1',
        status: 'active',
      },
      'classrooms/classroom-1': {
        ownerUid: 'teacher-uid-1',
        name: 'Class',
        studentLoginCode,
      },
      'classroomLoginCodes/23456789': {
        classroomId: 'classroom-1',
        status: 'active',
      },
    }

    await assert.rejects(
      onboardTeacherClassroomService({
        firestore: createMockFirestore(foundation),
        auth: googleAuth(),
        data: { classroomName: 'Ignored' },
      }),
      error => error.code === 'failed-precondition',
    )
    await assert.rejects(
      resolveTeacherTenantService({
        firestore: createMockFirestore(foundation),
        auth: { uid: 'teacher-uid-1' },
      }),
      error => error.code === 'failed-precondition',
    )
  }
})
