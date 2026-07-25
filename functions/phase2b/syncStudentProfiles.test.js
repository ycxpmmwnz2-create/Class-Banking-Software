import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveBaseLoginId,
  syncStudentProfilesV2Handler,
  SyncStudentProfilesError,
} from './syncStudentProfiles.js'
import { deriveDeterministicStudentAuthUid } from './scopedCredentialProjection.js'

function createMockFirestore(initialDocs = {}) {
  const store = new Map()

  for (const [path, data] of Object.entries(initialDocs)) {
    store.set(path, JSON.parse(JSON.stringify(data)))
  }

  function getDocRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      collection(subColl) {
        return getCollectionRef(`${path}/${subColl}`)
      },
      async get() {
        const data = store.get(path)
        return {
          exists: data !== undefined,
          id: path.split('/').pop(),
          data: () => (data !== undefined ? JSON.parse(JSON.stringify(data)) : undefined),
        }
      },
    }
  }

  function getCollectionRef(collPath) {
    return {
      path: collPath,
      doc(id) {
        const autoId = id || `auto_${Math.random().toString(36).slice(2)}`
        return getDocRef(`${collPath}/${autoId}`)
      },
      where(field, op, val) {
        const matchingDocs = []
        for (const [p, d] of store.entries()) {
          if (p.startsWith(`${collPath}/`)) {
            const relative = p.slice(collPath.length + 1)
            if (!relative.includes('/') && op === '==' && d[field] === val) {
              matchingDocs.push({
                path: p,
                id: p.split('/').pop(),
                data: () => JSON.parse(JSON.stringify(d)),
                ref: getDocRef(p),
              })
            }
          }
        }
        return {
          limit(n) {
            const sliced = matchingDocs.slice(0, n)
            return {
              _queryDocs: sliced,
            }
          },
        }
      },
    }
  }

  return {
    store,
    doc(path) {
      return getDocRef(path)
    },
    collection(collPath) {
      return getCollectionRef(collPath)
    },
    async runTransaction(updateFunction) {
      const transactionStore = new Map()
      for (const [p, d] of store.entries()) {
        transactionStore.set(p, JSON.parse(JSON.stringify(d)))
      }

      const transaction = {
        async get(refOrQuery) {
          if (refOrQuery && refOrQuery._queryDocs) {
            return {
              empty: refOrQuery._queryDocs.length === 0,
              docs: refOrQuery._queryDocs.map(d => ({
                path: d.path,
                id: d.id,
                ref: d.ref,
                data: () => {
                  const current = transactionStore.get(d.path)
                  return current ? JSON.parse(JSON.stringify(current)) : d.data()
                },
              })),
            }
          }

          const path = typeof refOrQuery === 'string' ? refOrQuery : refOrQuery.path
          const data = transactionStore.get(path)
          return {
            exists: data !== undefined,
            data: () => (data !== undefined ? JSON.parse(JSON.stringify(data)) : undefined),
            id: path.split('/').pop(),
          }
        },
        set(docRef, data) {
          const path = typeof docRef === 'string' ? docRef : docRef.path
          transactionStore.set(path, JSON.parse(JSON.stringify(data)))
        },
        update(docRef, data) {
          const path = typeof docRef === 'string' ? docRef : docRef.path
          const existing = transactionStore.get(path) || {}
          const merged = { ...existing, ...data }
          transactionStore.set(path, JSON.parse(JSON.stringify(merged)))
        },
      }

      const result = await updateFunction(transaction)

      for (const [p, d] of transactionStore.entries()) {
        store.set(p, d)
      }

      return result
    },
  }
}

test('slug behavior: NFKD/combining-mark/punctuation/empty-name/truncation', () => {
  assert.equal(deriveBaseLoginId('Alex Smith'), 'alex-smith')
  assert.equal(deriveBaseLoginId("Renée O'Connor"), 'renee-o-connor')
  assert.equal(deriveBaseLoginId('  !!!  '), 'student')
  assert.equal(deriveBaseLoginId(''), 'student')
  assert.equal(deriveBaseLoginId(null), 'student')

  const longName = 'a'.repeat(100)
  assert.equal(deriveBaseLoginId(longName), 'a'.repeat(48))
})

test('student creation: same name in A and B creates distinct auth UIDs and local suffix collisions', async () => {
  const initialDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'teachers/teacherB': { uid: 'teacherB', classroomId: 'classB', status: 'active' },
    'classrooms/classB': { ownerUid: 'teacherB' },
  }

  const firestore = createMockFirestore(initialDocs)

  // Student 1 in Class A: Alex Smith
  const eventA1 = {
    params: { classroomId: 'classA', studentId: 'stu1' },
    change: { before: null, after: { exists: true, data: () => ({ name: 'Alex Smith' }) } },
  }

  const resA1 = await syncStudentProfilesV2Handler(eventA1, { firestore, now: () => 1000 })
  assert.equal(resA1.loginId, 'alex-smith')
  assert.equal(resA1.authUid, deriveDeterministicStudentAuthUid('classA', 'stu1'))

  // Student 2 in Class A: Alex Smith (suffix collision inside classroom A)
  const eventA2 = {
    params: { classroomId: 'classA', studentId: 'stu2' },
    change: { before: null, after: { exists: true, data: () => ({ name: 'Alex Smith' }) } },
  }

  const resA2 = await syncStudentProfilesV2Handler(eventA2, { firestore, now: () => 1000 })
  assert.equal(resA2.loginId, 'alex-smith-2')

  // Student 1 in Class B: Alex Smith (no suffix collision across classrooms)
  const eventB1 = {
    params: { classroomId: 'classB', studentId: 'stu1' },
    change: { before: null, after: { exists: true, data: () => ({ name: 'Alex Smith' }) } },
  }

  const resB1 = await syncStudentProfilesV2Handler(eventB1, { firestore, now: () => 1000 })
  assert.equal(resB1.loginId, 'alex-smith')
  assert.equal(resB1.authUid, deriveDeterministicStudentAuthUid('classB', 'stu1'))
  assert.notEqual(resA1.authUid, resB1.authUid)
})

test('student update: rename keeps login ID stable and update allowlist preserves identity/lock fields', async () => {
  const initialDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/studentCredentials/alex-smith': {
      loginId: 'alex-smith',
      classroomId: 'classA',
      studentId: 'stu1',
      authUid: deriveDeterministicStudentAuthUid('classA', 'stu1'),
      active: true,
      pinHash: 'secret_hash',
      failedAttempts: 2,
      lockedUntil: 9999,
      schemaVersion: 1,
      createdAt: 500,
    },
  }

  const firestore = createMockFirestore(initialDocs)

  const updateEvent = {
    params: { classroomId: 'classA', studentId: 'stu1' },
    change: {
      before: { exists: true, data: () => ({ name: 'Alex Smith' }) },
      after: { exists: true, data: () => ({ name: 'Alexander Smith Jr' }) },
    },
  }

  const res = await syncStudentProfilesV2Handler(updateEvent, { firestore, now: () => 2000 })
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

  // Verify NO student document was written back to classrooms/classA/students/stu1!
  assert.equal(firestore.store.get('classrooms/classA/students/stu1'), undefined)
})

test('student delete: deactivates credential without deleting document; state-idempotent', async () => {
  const initialDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/studentCredentials/alex-smith': {
      loginId: 'alex-smith',
      classroomId: 'classA',
      studentId: 'stu1',
      active: true,
    },
  }

  const firestore = createMockFirestore(initialDocs)

  const deleteEvent = {
    params: { classroomId: 'classA', studentId: 'stu1' },
    change: {
      before: { exists: true, data: () => ({ name: 'Alex Smith' }) },
      after: null,
    },
  }

  const res1 = await syncStudentProfilesV2Handler(deleteEvent, { firestore, now: () => 3000 })
  assert.equal(res1.action, 'deactivated')

  const cred = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.ok(cred !== undefined)
  assert.equal(cred.active, false)
  assert.equal(cred.updatedAt, 3000)

  // Repeated delete is state-idempotent
  const res2 = await syncStudentProfilesV2Handler(deleteEvent, { firestore, now: () => 4000 })
  assert.equal(res2.action, 'deactivated')
})

test('recycled studentId is rejected (fail closed)', async () => {
  const initialDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/studentCredentials/old-student': {
      loginId: 'old-student',
      classroomId: 'classA',
      studentId: 'stu_recycled',
      active: false,
      pinHash: 'old_secret_pin_hash',
    },
  }

  const firestore = createMockFirestore(initialDocs)

  // Create student with recycled studentId "stu_recycled"
  const createRecycledEvent = {
    params: { classroomId: 'classA', studentId: 'stu_recycled' },
    change: { before: null, after: { exists: true, data: () => ({ name: 'New Student' }) } },
  }

  await assert.rejects(
    () => syncStudentProfilesV2Handler(createRecycledEvent, { firestore }),
    (err) => {
      assert.ok(err instanceof SyncStudentProfilesError)
      assert.equal(err.code, 'failed-precondition')
      assert.ok(err.message.includes('recycled studentId'))
      return true
    },
  )

  // Verify old credential was NOT repurposed/overwritten
  const cred = firestore.store.get('classrooms/classA/studentCredentials/old-student')
  assert.equal(cred.pinHash, 'old_secret_pin_hash')
  assert.equal(cred.loginId, 'old-student')
})

test('malformed event params or missing foundation rejected', async () => {
  const firestore = createMockFirestore()

  // Malformed event params
  await assert.rejects(
    () => syncStudentProfilesV2Handler({ params: { classroomId: 'invalid/class', studentId: 'stu1' } }, { firestore }),
    (err) => err instanceof SyncStudentProfilesError && err.code === 'invalid-argument',
  )

  // Missing classroom foundation
  await assert.rejects(
    () => syncStudentProfilesV2Handler({ params: { classroomId: 'classA', studentId: 'stu1' } }, { firestore }),
    (err) => err instanceof SyncStudentProfilesError && err.code === 'failed-precondition',
  )
})
