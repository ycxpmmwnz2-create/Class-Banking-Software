import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resetStudentPinV2,
  resetStudentPinV2CallableHandler,
  ResetStudentPinError,
} from './resetStudentPin.js'
import { TeacherTenantResolverError } from './teacherTenantResolver.js'

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
            // Ensure exact collection level match (no deep nested slash matches)
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

test('Teacher A and B reset only their resolved tenant with bidirectional isolation', async () => {
  const initialDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/students/stu1': { name: 'Alex' },
    'classrooms/classA/studentCredentials/alex-smith': {
      studentId: 'stu1',
      classroomId: 'classA',
      authUid: 's_authA',
      pinHash: 'oldHashA',
      active: false,
      failedAttempts: 3,
      lockedUntil: 10000,
      createdAt: 500,
      unknownProp: 'keepMe',
    },
    'teachers/teacherB': { uid: 'teacherB', classroomId: 'classB', status: 'active' },
    'classrooms/classB': { ownerUid: 'teacherB' },
    'classrooms/classB/students/stu2': { name: 'Bob' },
    'classrooms/classB/studentCredentials/bob-jones': {
      studentId: 'stu2',
      classroomId: 'classB',
      authUid: 's_authB',
      pinHash: 'oldHashB',
      active: true,
    },
  }

  const firestore = createMockFirestore(initialDocs)
  const mockHashPin = async (pin) => `hashed_${pin}`

  // Teacher A resets student 1 in classroom A
  const resA = await resetStudentPinV2(
    { studentId: 'stu1', newPin: '5678' },
    {
      firestore,
      auth: { uid: 'teacherA' },
      hashPin: mockHashPin,
      now: () => 2000,
    },
  )
  assert.equal(resA.classroomId, 'classA')
  assert.equal(resA.studentId, 'stu1')

  const credA = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.equal(credA.pinHash, 'hashed_5678')
  assert.equal(credA.active, true)
  assert.equal(credA.pinUpdatedAt, 2000)
  assert.equal(credA.failedAttempts, 0)
  assert.equal(credA.lockedUntil, null)
  assert.equal(credA.updatedAt, 2000)
  // Identity and unknown props preserved
  assert.equal(credA.authUid, 's_authA')
  assert.equal(credA.classroomId, 'classA')
  assert.equal(credA.studentId, 'stu1')
  assert.equal(credA.createdAt, 500)
  assert.equal(credA.unknownProp, 'keepMe')

  // Teacher B's credential document remains untouched
  const credB = firestore.store.get('classrooms/classB/studentCredentials/bob-jones')
  assert.equal(credB.pinHash, 'oldHashB')

  // Teacher A cannot reset student 2 (which belongs to classroom B)
  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu2', newPin: '9999' },
        {
          firestore,
          auth: { uid: 'teacherA' },
          hashPin: mockHashPin,
        },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'not-found',
  )
})

test('rejection of unknown fields including classroomId', async () => {
  const firestore = createMockFirestore()

  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu1', newPin: '1234', classroomId: 'classA' },
        { firestore, auth: { uid: 'teacherA' } },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'invalid-argument',
  )

  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu1', newPin: '1234', extraKey: 'val' },
        { firestore, auth: { uid: 'teacherA' } },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'invalid-argument',
  )
})

test('validation of PIN: exactly four ASCII digits required', async () => {
  const invalidPins = ['123', '12345', 'abcd', '123a', '١٢٣٤', '１２３４', '']

  for (const newPin of invalidPins) {
    const firestore = createMockFirestore()
    await assert.rejects(
      () =>
        resetStudentPinV2(
          { studentId: 'stu1', newPin },
          { firestore, auth: { uid: 'teacherA' } },
        ),
      (err) => err instanceof ResetStudentPinError && err.code === 'invalid-argument',
      `Failed to reject PIN: ${newPin}`,
    )
  }
})

test('unauthenticated, disabled, missing, and owner-mismatch teacher foundation errors', async () => {
  // Missing auth
  await assert.rejects(
    () => resetStudentPinV2({ studentId: 'stu1', newPin: '1234' }, { firestore: createMockFirestore() }),
    (err) => err instanceof TeacherTenantResolverError && err.code === 'unauthenticated',
  )

  // Disabled teacher
  const firestoreDisabled = createMockFirestore({
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'disabled' },
    'classrooms/classA': { ownerUid: 'teacherA' },
  })
  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu1', newPin: '1234' },
        { firestore: firestoreDisabled, auth: { uid: 'teacherA' } },
      ),
    (err) => err instanceof TeacherTenantResolverError && err.code === 'teacher-disabled',
  )
})

test('zero and two credential matches handling', async () => {
  const baseDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/students/stu1': { name: 'Alex' },
  }

  // Zero matches
  const firestoreZero = createMockFirestore(baseDocs)
  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu1', newPin: '1234' },
        { firestore: firestoreZero, auth: { uid: 'teacherA' } },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'not-found',
  )

  // Two matches
  const firestoreTwo = createMockFirestore({
    ...baseDocs,
    'classrooms/classA/studentCredentials/cred1': { studentId: 'stu1', classroomId: 'classA' },
    'classrooms/classA/studentCredentials/cred2': { studentId: 'stu1', classroomId: 'classA' },
  })
  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu1', newPin: '1234' },
        { firestore: firestoreTwo, auth: { uid: 'teacherA' } },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'failed-precondition',
  )
})

test('missing student document in classroom fails reset', async () => {
  const initialDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    // Student credential exists, but student document missing!
    'classrooms/classA/studentCredentials/alex-smith': { studentId: 'stu1', classroomId: 'classA' },
  }

  const firestore = createMockFirestore(initialDocs)
  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu1', newPin: '1234' },
        { firestore, auth: { uid: 'teacherA' } },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'not-found',
  )
})

test('callable adapter maps errors to canonical HttpsError codes', async () => {
  const firestore = createMockFirestore({
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/students/stu1': { name: 'Alex' },
    'classrooms/classA/studentCredentials/alex-smith': { studentId: 'stu1', classroomId: 'classA' },
  })

  // Successful call returns { success: true }
  const res = await resetStudentPinV2CallableHandler(
    { studentId: 'stu1', newPin: '1234' },
    { auth: { uid: 'teacherA' } },
    { firestore, hashPin: async (p) => `hash_${p}` },
  )
  assert.deepEqual(res, { success: true })

  // Invalid argument (unknown key) throws HttpsError invalid-argument
  await assert.rejects(
    () =>
      resetStudentPinV2CallableHandler(
        { studentId: 'stu1', newPin: '1234', classroomId: 'classA' },
        { auth: { uid: 'teacherA' } },
        { firestore },
      ),
    (err) => err.code === 'invalid-argument',
  )
})
