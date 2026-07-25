import assert from 'node:assert/strict'
import test from 'node:test'

import { hashEmailDigest } from './identityNormalization.js'
import {
  onboardTeacherClassroomService,
  resolveTeacherTenantService,
} from './teacherOnboarding.js'


function createMockFirestore(initialDocs = {}) {
  const store = new Map()

  for (const [path, data] of Object.entries(initialDocs)) {
    store.set(path, JSON.parse(JSON.stringify(data)))
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
          data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
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
      const transactionCreates = []
      const transactionUpdates = []
      const transactionDeletes = []

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
            data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
          }
        },
        create(targetRef, data) {
          if (store.has(targetRef.path)) {
            throw new Error(`Document already exists at ${targetRef.path}`)
          }
          store.set(targetRef.path, JSON.parse(JSON.stringify(data)))
          transactionCreates.push({ path: targetRef.path, data })
          creates.push({ path: targetRef.path, data })
        },
        update(targetRef, data) {
          if (!store.has(targetRef.path)) {
            throw new Error(`Document does not exist at ${targetRef.path}`)
          }
          const current = store.get(targetRef.path)
          const updated = { ...current, ...data }
          store.set(targetRef.path, JSON.parse(JSON.stringify(updated)))
          transactionUpdates.push({ path: targetRef.path, data })
          updates.push({ path: targetRef.path, data })
        },
        delete(targetRef) {
          store.delete(targetRef.path)
          transactionDeletes.push(targetRef.path)
          deletes.push(targetRef.path)
        },
      }

      return callback(transaction)
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
    clock: () => '2026-07-25T00:00:00Z',
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
      clock: () => 2000,
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
