import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TeacherTenantResolverError,
  resolveActiveTeacherTenant,
} from './teacherTenantResolver.js'

function createMockFirestore(documents = {}) {
  const readPaths = []
  const writes = []

  const store = new Map(Object.entries(documents))

  return {
    readPaths,
    writes,
    collection(collectionName) {
      return {
        doc(docId) {
          const path = `${collectionName}/${docId}`
          return {
            path,
            id: docId,
            async get() {
              readPaths.push(path)
              const data = store.get(path)
              return {
                exists: data !== undefined,
                id: docId,
                data: () => data,
              }
            },
            async set() {
              writes.push({ type: 'set', path })
            },
            async update() {
              writes.push({ type: 'update', path })
            },
            async delete() {
              writes.push({ type: 'delete', path })
            },
          }
        },
      }
    },
  }
}

test('resolveActiveTeacherTenant: resolves two valid independent tenants', async () => {
  const db = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'teacher-a',
      classroomId: 'classroom-a',
      status: 'active',
      displayName: 'Teacher A',
    },
    'classrooms/classroom-a': {
      ownerUid: 'teacher-a',
      name: "Teacher A's Class",
    },
    'teachers/teacher-b': {
      uid: 'teacher-b',
      classroomId: 'classroom-b',
      status: 'active',
      displayName: 'Teacher B',
    },
    'classrooms/classroom-b': {
      ownerUid: 'teacher-b',
      name: "Teacher B's Class",
    },
  })

  const tenantA = await resolveActiveTeacherTenant({
    firestore: db,
    auth: { uid: 'teacher-a' },
  })

  assert.equal(tenantA.teacherUid, 'teacher-a')
  assert.equal(tenantA.classroomId, 'classroom-a')
  assert.equal(tenantA.teacher.data.displayName, 'Teacher A')
  assert.equal(tenantA.classroom.data.name, "Teacher A's Class")
  assert.equal(Object.isFrozen(tenantA), true)

  const tenantB = await resolveActiveTeacherTenant({
    firestore: db,
    auth: { uid: 'teacher-b' },
  })

  assert.equal(tenantB.teacherUid, 'teacher-b')
  assert.equal(tenantB.classroomId, 'classroom-b')
  assert.equal(tenantB.teacher.data.displayName, 'Teacher B')

  assert.deepEqual(db.readPaths, [
    'teachers/teacher-a',
    'classrooms/classroom-a',
    'teachers/teacher-b',
    'classrooms/classroom-b',
  ])
  assert.equal(db.writes.length, 0)
})

test('rejects unauthenticated caller', async () => {
  const db = createMockFirestore()

  await assert.rejects(
    resolveActiveTeacherTenant({ firestore: db, auth: null }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'unauthenticated')
      return true
    },
  )

  await assert.rejects(
    resolveActiveTeacherTenant({ firestore: db, auth: {} }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'unauthenticated')
      return true
    },
  )

  assert.equal(db.writes.length, 0)
})

test('rejects malformed auth UID', async () => {
  const db = createMockFirestore()

  await assert.rejects(
    resolveActiveTeacherTenant({ firestore: db, auth: { uid: 'invalid/uid' } }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'invalid-auth-uid')
      return true
    },
  )

  await assert.rejects(
    resolveActiveTeacherTenant({ firestore: db, auth: { uid: '  teacher-a  ' } }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'invalid-auth-uid')
      return true
    },
  )

  assert.equal(db.writes.length, 0)
})

test('rejects missing teacher document', async () => {
  const db = createMockFirestore()

  await assert.rejects(
    resolveActiveTeacherTenant({ firestore: db, auth: { uid: 'teacher-a' } }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'teacher-not-found')
      return true
    },
  )
  assert.equal(db.writes.length, 0)
})

test('rejects teacher UID mismatch', async () => {
  const db = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'other-uid',
      classroomId: 'classroom-a',
      status: 'active',
    },
  })

  await assert.rejects(
    resolveActiveTeacherTenant({ firestore: db, auth: { uid: 'teacher-a' } }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'teacher-uid-mismatch')
      return true
    },
  )
  assert.equal(db.writes.length, 0)
})

test('rejects disabled teacher', async () => {
  const db = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'teacher-a',
      classroomId: 'classroom-a',
      status: 'disabled',
    },
  })

  await assert.rejects(
    resolveActiveTeacherTenant({ firestore: db, auth: { uid: 'teacher-a' } }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'teacher-disabled')
      return true
    },
  )
  assert.equal(db.writes.length, 0)
})

test('rejects missing or invalid status', async () => {
  const dbMissingStatus = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'teacher-a',
      classroomId: 'classroom-a',
    },
  })

  await assert.rejects(
    resolveActiveTeacherTenant({
      firestore: dbMissingStatus,
      auth: { uid: 'teacher-a' },
    }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'invalid-teacher-status')
      return true
    },
  )

  const dbUnknownStatus = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'teacher-a',
      classroomId: 'classroom-a',
      status: 'pending',
    },
  })

  await assert.rejects(
    resolveActiveTeacherTenant({
      firestore: dbUnknownStatus,
      auth: { uid: 'teacher-a' },
    }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'invalid-teacher-status')
      return true
    },
  )
})

test('rejects malformed or missing classroomId', async () => {
  const dbMissingClassroom = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'teacher-a',
      status: 'active',
    },
  })

  await assert.rejects(
    resolveActiveTeacherTenant({
      firestore: dbMissingClassroom,
      auth: { uid: 'teacher-a' },
    }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'invalid-classroom-id')
      return true
    },
  )

  const dbMalformedClassroom = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'teacher-a',
      classroomId: 'classroom/slash',
      status: 'active',
    },
  })

  await assert.rejects(
    resolveActiveTeacherTenant({
      firestore: dbMalformedClassroom,
      auth: { uid: 'teacher-a' },
    }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'invalid-classroom-id')
      return true
    },
  )
})

test('rejects missing classroom document', async () => {
  const db = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'teacher-a',
      classroomId: 'classroom-a',
      status: 'active',
    },
  })

  await assert.rejects(
    resolveActiveTeacherTenant({ firestore: db, auth: { uid: 'teacher-a' } }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'classroom-not-found')
      return true
    },
  )
})

test('rejects owner mismatch', async () => {
  const db = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'teacher-a',
      classroomId: 'classroom-a',
      status: 'active',
    },
    'classrooms/classroom-a': {
      ownerUid: 'teacher-b',
    },
  })

  await assert.rejects(
    resolveActiveTeacherTenant({ firestore: db, auth: { uid: 'teacher-a' } }),
    err => {
      assert.ok(err instanceof TeacherTenantResolverError)
      assert.equal(err.code, 'classroom-owner-mismatch')
      return true
    },
  )
})

test('ignores forged client-supplied classroomId or extra fields in auth', async () => {
  const db = createMockFirestore({
    'teachers/teacher-a': {
      uid: 'teacher-a',
      classroomId: 'classroom-a',
      status: 'active',
    },
    'classrooms/classroom-a': {
      ownerUid: 'teacher-a',
      name: 'Real Classroom',
    },
  })

  const tenant = await resolveActiveTeacherTenant({
    firestore: db,
    auth: {
      uid: 'teacher-a',
      classroomId: 'forged-classroom-id',
      role: 'admin',
    },
  })

  assert.equal(tenant.classroomId, 'classroom-a')
  assert.equal(db.readPaths.includes('classrooms/forged-classroom-id'), false)
  assert.equal(db.writes.length, 0)
})
