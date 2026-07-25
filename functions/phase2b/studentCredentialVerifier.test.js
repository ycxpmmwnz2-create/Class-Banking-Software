import test from 'node:test'
import assert from 'node:assert/strict'
import {
  verifyStudentCredentialV2,
  studentPinLoginV2CallableHandler,
  StudentVerifierError,
} from './studentCredentialVerifier.js'
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
    }
  }

  return {
    store,
    doc(path) {
      return getDocRef(path)
    },
    collection(collPath) {
      return {
        path: collPath,
        doc(id) {
          const autoId = id || `auto_${Math.random().toString(36).slice(2)}`
          return getDocRef(`${collPath}/${autoId}`)
        },
      }
    },
    async runTransaction(updateFunction) {
      const transactionStore = new Map()
      for (const [p, d] of store.entries()) {
        transactionStore.set(p, JSON.parse(JSON.stringify(d)))
      }

      const writtenDocs = new Map()

      const transaction = {
        async get(docRef) {
          const path = typeof docRef === 'string' ? docRef : docRef.path
          const data = transactionStore.get(path)
          return {
            exists: data !== undefined,
            data: () => (data !== undefined ? JSON.parse(JSON.stringify(data)) : undefined),
            id: path.split('/').pop(),
          }
        },
        set(docRef, data) {
          const path = typeof docRef === 'string' ? docRef : docRef.path
          writtenDocs.set(path, JSON.parse(JSON.stringify(data)))
          transactionStore.set(path, JSON.parse(JSON.stringify(data)))
        },
        update(docRef, data) {
          const path = typeof docRef === 'string' ? docRef : docRef.path
          const existing = transactionStore.get(path) || {}
          const merged = { ...existing, ...data }
          writtenDocs.set(path, JSON.parse(JSON.stringify(merged)))
          transactionStore.set(path, JSON.parse(JSON.stringify(merged)))
        },
      }

      const result = await updateFunction(transaction)

      // Commit changes to main store
      for (const [p, d] of transactionStore.entries()) {
        store.set(p, d)
      }

      return result
    },
  }
}



test('successful student verification: exact claims, authUid, and token output', async () => {
  const authUidA = deriveDeterministicStudentAuthUid('classA', 'stu123')
  const initialDocs = {
    'classroomLoginCodes/23456789': { status: 'active', classroomId: 'classA' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA/studentCredentials/alex-smith': {
      active: true,
      classroomId: 'classA',
      studentId: 'stu123',
      authUid: authUidA,
      schemaVersion: 1,
      pinHash: '$2b$10$validhash',
    },
  }

  const firestore = createMockFirestore(initialDocs)
  const mockCreateToken = async (uid, claims) => `token_for_${uid}_${claims.studentId}`

  const result = await verifyStudentCredentialV2(
    { classroomCode: '2345-6789', loginId: 'alex-smith', pin: '1234' },
    {
      firestore,
      verifyPin: async () => true,
      createCustomToken: mockCreateToken,
    },
  )

  assert.equal(result.authUid, authUidA)
  assert.deepEqual(result.claims, {
    role: 'student',
    classroomId: 'classA',
    studentId: 'stu123',
  })
  assert.equal(result.token, `token_for_${authUidA}_stu123`)

  // Verify callable adapter returns only { token }
  const callableResult = await studentPinLoginV2CallableHandler(
    { classroomCode: '2345-6789', loginId: 'alex-smith', pin: '1234' },
    {},
    {
      firestore,
      verifyPin: async () => true,
      createCustomToken: mockCreateToken,
    },
  )

  assert.deepEqual(callableResult, { token: `token_for_${authUidA}_stu123` })
})

test('same login ID succeeds independently in A and B only with matching code', async () => {
  const authUidA = deriveDeterministicStudentAuthUid('classA', 'stu_a')
  const authUidB = deriveDeterministicStudentAuthUid('classB', 'stu_b')

  const initialDocs = {
    'classroomLoginCodes/23456789': { status: 'active', classroomId: 'classA' },
    'classroomLoginCodes/3456789A': { status: 'active', classroomId: 'classB' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classB': { ownerUid: 'teacherB' },
    'teachers/teacherB': { uid: 'teacherB', classroomId: 'classB', status: 'active' },
    'classrooms/classA/studentCredentials/alex-smith': {
      active: true,
      classroomId: 'classA',
      studentId: 'stu_a',
      authUid: authUidA,
      schemaVersion: 1,
      pinHash: 'hashA',
    },
    'classrooms/classB/studentCredentials/alex-smith': {
      active: true,
      classroomId: 'classB',
      studentId: 'stu_b',
      authUid: authUidB,
      schemaVersion: 1,
      pinHash: 'hashB',
    },
  }

  const firestore = createMockFirestore(initialDocs)

  const resA = await verifyStudentCredentialV2(
    { classroomCode: '2345-6789', loginId: 'alex-smith', pin: '1234' },
    { firestore, verifyPin: async () => true },
  )
  assert.equal(resA.claims.classroomId, 'classA')
  assert.equal(resA.claims.studentId, 'stu_a')
  assert.equal(resA.authUid, authUidA)

  const resB = await verifyStudentCredentialV2(
    { classroomCode: '3456-789A', loginId: 'alex-smith', pin: '1234' },
    { firestore, verifyPin: async () => true },
  )
  assert.equal(resB.claims.classroomId, 'classB')
  assert.equal(resB.claims.studentId, 'stu_b')
  assert.equal(resB.authUid, authUidB)
  assert.notEqual(resA.authUid, resB.authUid)
})

test('same studentId in A and B creates distinct auth UIDs', () => {
  const uidA = deriveDeterministicStudentAuthUid('classA', 'same_student_id')
  const uidB = deriveDeterministicStudentAuthUid('classB', 'same_student_id')
  assert.notEqual(uidA, uidB)
})

test('error indistinguishability: all failure modes return generic unauthenticated error', async () => {
  const authUid = deriveDeterministicStudentAuthUid('classA', 'stu1')
  const baseDocs = {
    'classroomLoginCodes/23456789': { status: 'active', classroomId: 'classA' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA/studentCredentials/alex-smith': {
      active: true,
      classroomId: 'classA',
      studentId: 'stu1',
      authUid,
      schemaVersion: 1,
      pinHash: 'hash',
    },
  }

  const failureRequests = [
    { desc: 'malformed code', req: { classroomCode: 'bad', loginId: 'alex-smith', pin: '1234' } },
    { desc: 'unknown code', req: { classroomCode: 'FFFFFFFF', loginId: 'alex-smith', pin: '1234' } },
    { desc: 'missing login', req: { classroomCode: '23456789', loginId: 'nonexistent', pin: '1234' } },
    { desc: 'wrong pin', req: { classroomCode: '23456789', loginId: 'alex-smith', pin: '0000' }, customVerify: async () => false },
  ]

  for (const { desc, req, customVerify } of failureRequests) {
    const firestore = createMockFirestore(baseDocs)
    await assert.rejects(
      async () =>
        verifyStudentCredentialV2(req, {
          firestore,
          verifyPin: customVerify || (async () => false),
        }),
      (err) => {
        assert.ok(err instanceof StudentVerifierError, `Failed on ${desc}`)
        assert.equal(err.code, 'unauthenticated')
        assert.equal(err.message, 'Invalid student credentials.')
        return true
      },
      `Failed on ${desc}`,
    )
  }
})

test('dummy hash timing defense is exercised on missing credential or unresolved code', async () => {
  const firestore = createMockFirestore()

  let dummyCallCount = 0
  const verifyPin = async (pin, hash) => {
    if (hash === '$2b$10$Ds5wfuAE9LT3Xe4vdygSMu1VUq0m8830nB5uQauQ0105kP4WDUR.a') {
      dummyCallCount += 1
    }
    return false
  }

  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: '23456789', loginId: 'missing', pin: '1234' },
        { firestore, verifyPin },
      ),
    StudentVerifierError,
  )

  assert.equal(dummyCallCount, 1)
})

test('five-attempt credential lock boundary and expired lock reset', async () => {
  const authUid = deriveDeterministicStudentAuthUid('classA', 'stu1')
  const initialDocs = {
    'classroomLoginCodes/23456789': { status: 'active', classroomId: 'classA' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA/studentCredentials/alex-smith': {
      active: true,
      classroomId: 'classA',
      studentId: 'stu1',
      authUid,
      schemaVersion: 1,
      pinHash: 'hash',
      failedAttempts: 4,
      lockedUntil: null,
    },
  }

  const firestore = createMockFirestore(initialDocs)
  let currentTime = 1000000

  // 5th failed attempt -> locks credential
  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: '23456789', loginId: 'alex-smith', pin: 'wrong' },
        { firestore, verifyPin: async () => false, now: () => currentTime },
      ),
    StudentVerifierError,
  )

  const lockedCred = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.equal(lockedCred.failedAttempts, 5)
  assert.equal(lockedCred.lockedUntil, currentTime + 5 * 60 * 1000)

  // 6th attempt while locked -> rejects as locked
  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: '23456789', loginId: 'alex-smith', pin: 'wrong' },
        { firestore, verifyPin: async () => false, now: () => currentTime + 1000 },
      ),
    StudentVerifierError,
  )

  // Fast forward past lockout duration (5 mins) -> expired lock allows attempt
  currentTime += 6 * 60 * 1000
  const successRes = await verifyStudentCredentialV2(
    { classroomCode: '23456789', loginId: 'alex-smith', pin: 'correct' },
    { firestore, verifyPin: async () => true, now: () => currentTime },
  )
  assert.ok(successRes)

  const unlockedCred = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.equal(unlockedCred.failedAttempts, 0)
  assert.equal(unlockedCred.lockedUntil, null)
})

test('ten-attempt throttle boundary and window reset', async () => {
  const authUid = deriveDeterministicStudentAuthUid('classA', 'stu1')
  const initialDocs = {
    'classroomLoginCodes/23456789': { status: 'active', classroomId: 'classA' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA/studentCredentials/alex-smith': {
      active: true,
      classroomId: 'classA',
      studentId: 'stu1',
      authUid,
      schemaVersion: 1,
      pinHash: 'hash',
    },
  }

  const firestore = createMockFirestore(initialDocs)
  let currentTime = 1000000

  // Execute 9 failed attempts
  for (let i = 0; i < 9; i += 1) {
    await assert.rejects(
      () =>
        verifyStudentCredentialV2(
          { classroomCode: '23456789', loginId: 'alex-smith', pin: 'wrong' },
          { firestore, verifyPin: async () => false, now: () => currentTime },
        ),
      StudentVerifierError,
    )
  }

  // 10th attempt succeeds throttle check (reaches 10 entries)
  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: '23456789', loginId: 'alex-smith', pin: 'wrong' },
        { firestore, verifyPin: async () => false, now: () => currentTime },
      ),
    StudentVerifierError,
  )

  // 11th attempt within 5 minutes -> rejected at throttle check
  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: '23456789', loginId: 'alex-smith', pin: 'correct' },
        { firestore, verifyPin: async () => true, now: () => currentTime + 1000 },
      ),
    StudentVerifierError,
  )

  // Fast forward past 5-minute throttle window -> reset allows successful login
  currentTime += 6 * 60 * 1000
  const successRes = await verifyStudentCredentialV2(
    { classroomCode: '23456789', loginId: 'alex-smith', pin: 'correct' },
    { firestore, verifyPin: async () => true, now: () => currentTime },
  )
  assert.ok(successRes)
})

test('resolved versus unresolved log paths and redacted bodies', async () => {
  const authUid = deriveDeterministicStudentAuthUid('classA', 'stu1')
  const initialDocs = {
    'classroomLoginCodes/23456789': { status: 'active', classroomId: 'classA' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA/studentCredentials/alex-smith': {
      active: true,
      classroomId: 'classA',
      studentId: 'stu1',
      authUid,
      schemaVersion: 1,
      pinHash: 'hash',
    },
  }

  const firestore = createMockFirestore(initialDocs)

  // Unresolved code log
  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: 'FFFFFFFF', loginId: 'alex-smith', pin: '1234' },
        { firestore, verifyPin: async () => false },
      ),
    StudentVerifierError,
  )

  // Check unresolved logs store
  const unresolvedLogs = Array.from(firestore.store.entries()).filter(([k]) =>
    k.startsWith('studentAuthUnresolvedLogs/'),
  )
  assert.ok(unresolvedLogs.length > 0)
  const logData = unresolvedLogs[0][1]
  assert.equal(logData.rawCode, undefined)
  assert.equal(logData.pin, undefined)
  assert.equal(logData.loginId, undefined)
  assert.ok(typeof logData.identifierDigest === 'string')

  // Resolved log
  await verifyStudentCredentialV2(
    { classroomCode: '23456789', loginId: 'alex-smith', pin: '1234' },
    { firestore, verifyPin: async () => true },
  )

  const resolvedLogs = Array.from(firestore.store.entries()).filter(([k]) =>
    k.startsWith('studentAuthLogs/classA/logs/'),
  )
  assert.ok(resolvedLogs.length > 0)
  const resLogData = resolvedLogs[0][1]
  assert.equal(resLogData.studentId, 'stu1')
  assert.equal(resLogData.success, true)
  assert.equal(resLogData.pin, undefined)
  assert.equal(resLogData.pinHash, undefined)
})

test('forged credential data, schemaVersion, or authUid fails validation', async () => {
  const authUid = deriveDeterministicStudentAuthUid('classA', 'stu1')

  const forgedCases = [
    { desc: 'forged classroomId', cred: { active: true, classroomId: 'classB', studentId: 'stu1', authUid, schemaVersion: 1 } },
    { desc: 'forged authUid', cred: { active: true, classroomId: 'classA', studentId: 'stu1', authUid: 'forged_uid', schemaVersion: 1 } },
    { desc: 'unsupported schemaVersion', cred: { active: true, classroomId: 'classA', studentId: 'stu1', authUid, schemaVersion: 99 } },
    { desc: 'inactive credential', cred: { active: false, classroomId: 'classA', studentId: 'stu1', authUid, schemaVersion: 1 } },
  ]

  for (const { desc, cred } of forgedCases) {
    const firestore = createMockFirestore({
      'classroomLoginCodes/23456789': { status: 'active', classroomId: 'classA' },
      'classrooms/classA': { ownerUid: 'teacherA' },
      'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
      'classrooms/classA/studentCredentials/alex-smith': cred,
    })

    await assert.rejects(
      () =>
        verifyStudentCredentialV2(
          { classroomCode: '23456789', loginId: 'alex-smith', pin: '1234' },
          { firestore, verifyPin: async () => true },
        ),
      (err) => err instanceof StudentVerifierError,
      `Failed on ${desc}`,
    )
  }
})

test('disabled or reciprocal mismatch teacher foundation rejected', async () => {
  const authUid = deriveDeterministicStudentAuthUid('classA', 'stu1')

  // Teacher status disabled
  const firestoreDisabled = createMockFirestore({
    'classroomLoginCodes/23456789': { status: 'active', classroomId: 'classA' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'disabled' },
    'classrooms/classA/studentCredentials/alex-smith': { active: true, classroomId: 'classA', studentId: 'stu1', authUid, schemaVersion: 1 },
  })

  await assert.rejects(
    () => verifyStudentCredentialV2({ classroomCode: '23456789', loginId: 'alex-smith', pin: '1234' }, { firestore: firestoreDisabled, verifyPin: async () => true }),
    StudentVerifierError,
  )

  // Reciprocal classroom ID mismatch
  const firestoreMismatch = createMockFirestore({
    'classroomLoginCodes/23456789': { status: 'active', classroomId: 'classA' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classB', status: 'active' },
    'classrooms/classA/studentCredentials/alex-smith': { active: true, classroomId: 'classA', studentId: 'stu1', authUid, schemaVersion: 1 },
  })

  await assert.rejects(
    () => verifyStudentCredentialV2({ classroomCode: '23456789', loginId: 'alex-smith', pin: '1234' }, { firestore: firestoreMismatch, verifyPin: async () => true }),
    StudentVerifierError,
  )
})
