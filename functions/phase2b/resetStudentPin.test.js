import test from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import {
  defaultHashPin,
  resetStudentPinV2,
  resetStudentPinV2CallableHandler,
  ResetStudentPinError,
  STUDENT_PIN_BCRYPT_COST,
} from './resetStudentPin.js'
import { TeacherTenantResolverError } from './teacherTenantResolver.js'
import { deriveDeterministicStudentAuthUid } from './scopedCredentialProjection.js'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Firestore double that enforces the Admin SDK transaction rules: reads must
 * precede every write, buffered writes are invisible until commit, an aborted
 * attempt discards its writes, and `update` on a missing document fails.
 */
function createMockFirestore(initialDocs = {}, { abortAttempts = 0 } = {}) {
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
          set(refOrQuery, data) {
            hasWritten = true
            const path = typeof refOrQuery === 'string' ? refOrQuery : refOrQuery.path
            operations.push({ kind: 'set', path })
            writes.push({ kind: 'set', path, data: clone(data) })
          },
          update(refOrQuery, data) {
            hasWritten = true
            const path = typeof refOrQuery === 'string' ? refOrQuery : refOrQuery.path
            operations.push({ kind: 'update', path })
            writes.push({ kind: 'update', path, data: clone(data) })
          },
        }

        const result = await updateFunction(transaction)
        attemptOperations.push(operations)

        if (transactionAttempts <= abortAttempts) {
          continue
        }

        for (const write of writes) {
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

function scopedCredential(classroomId, loginId, studentId, overrides = {}) {
  return {
    loginId,
    classroomId,
    studentId,
    authUid: deriveDeterministicStudentAuthUid(classroomId, studentId),
    schemaVersion: 1,
    active: false,
    pinHash: 'oldHash',
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  }
}

const mockHashPin = async (pin) => `hashed_${pin}`

test('Teacher A and B reset only their resolved tenant with bidirectional isolation', async () => {
  const initialDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/students/stu1': { name: 'Alex' },
    'classrooms/classA/studentCredentials/alex-smith': scopedCredential(
      'classA',
      'alex-smith',
      'stu1',
      {
        failedAttempts: 3,
        lockedUntil: 10000,
        createdAt: 500,
        unknownProp: 'keepMe',
      },
    ),
    'teachers/teacherB': { uid: 'teacherB', classroomId: 'classB', status: 'active' },
    'classrooms/classB': { ownerUid: 'teacherB' },
    'classrooms/classB/students/stu2': { name: 'Bob' },
    'classrooms/classB/studentCredentials/bob-jones': scopedCredential(
      'classB',
      'bob-jones',
      'stu2',
      { pinHash: 'oldHashB', active: true },
    ),
  }

  const firestore = createMockFirestore(initialDocs)

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
  assert.equal(credA.authUid, deriveDeterministicStudentAuthUid('classA', 'stu1'))
  assert.equal(credA.classroomId, 'classA')
  assert.equal(credA.studentId, 'stu1')
  assert.equal(credA.loginId, 'alex-smith')
  assert.equal(credA.schemaVersion, 1)
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

  // And Teacher B cannot reset student 1 in classroom A.
  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu1', newPin: '9999' },
        {
          firestore,
          auth: { uid: 'teacherB' },
          hashPin: mockHashPin,
        },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'not-found',
  )
  assert.equal(
    firestore.store.get('classrooms/classA/studentCredentials/alex-smith').pinHash,
    'hashed_5678',
  )
})

test('production default hash uses bcrypt cost 12 and verifies the PIN', async () => {
  assert.equal(STUDENT_PIN_BCRYPT_COST, 12)

  const hash = await defaultHashPin('4821')
  assert.match(hash, /^\$2[aby]\$12\$/)
  assert.equal(await bcrypt.compare('4821', hash), true)
  assert.equal(await bcrypt.compare('4822', hash), false)

  // The handler's default dependency — not just an injected stub — produces the
  // cost-12 hash that is written to the credential.
  const firestore = createMockFirestore({
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/students/stu1': { name: 'Alex' },
    'classrooms/classA/studentCredentials/alex-smith': scopedCredential('classA', 'alex-smith', 'stu1'),
  })

  await resetStudentPinV2(
    { studentId: 'stu1', newPin: '4821' },
    { firestore, auth: { uid: 'teacherA' } },
  )

  const stored = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.match(stored.pinHash, /^\$2[aby]\$12\$/)
  assert.equal(await bcrypt.compare('4821', stored.pinHash), true)
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
  const cases = [
    {
      desc: 'missing auth',
      auth: undefined,
      docs: {},
      code: 'unauthenticated',
    },
    {
      desc: 'malformed auth uid',
      auth: { uid: 'bad/uid' },
      docs: {},
      code: 'invalid-auth-uid',
    },
    {
      desc: 'unknown teacher',
      auth: { uid: 'teacherA' },
      docs: {},
      code: 'teacher-not-found',
    },
    {
      desc: 'disabled teacher',
      auth: { uid: 'teacherA' },
      docs: {
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'disabled' },
        'classrooms/classA': { ownerUid: 'teacherA' },
      },
      code: 'teacher-disabled',
    },
    {
      desc: 'unknown status',
      auth: { uid: 'teacherA' },
      docs: {
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'pending' },
        'classrooms/classA': { ownerUid: 'teacherA' },
      },
      code: 'invalid-teacher-status',
    },
    {
      desc: 'teacher uid mismatch',
      auth: { uid: 'teacherA' },
      docs: {
        'teachers/teacherA': { uid: 'teacherZ', classroomId: 'classA', status: 'active' },
        'classrooms/classA': { ownerUid: 'teacherA' },
      },
      code: 'teacher-uid-mismatch',
    },
    {
      desc: 'malformed classroom id',
      auth: { uid: 'teacherA' },
      docs: {
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'bad/class', status: 'active' },
      },
      code: 'invalid-classroom-id',
    },
    {
      desc: 'missing classroom',
      auth: { uid: 'teacherA' },
      docs: {
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
      },
      code: 'classroom-not-found',
    },
    {
      desc: 'classroom owner mismatch',
      auth: { uid: 'teacherA' },
      docs: {
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
        'classrooms/classA': { ownerUid: 'teacherB' },
      },
      code: 'classroom-owner-mismatch',
    },
  ]

  for (const { desc, auth, docs, code } of cases) {
    await assert.rejects(
      () =>
        resetStudentPinV2(
          { studentId: 'stu1', newPin: '1234' },
          { firestore: createMockFirestore(docs), auth, hashPin: mockHashPin },
        ),
      (err) => {
        assert.ok(
          err instanceof TeacherTenantResolverError,
          `${desc}: unexpected error type ${err?.name}`,
        )
        assert.equal(err.code, code, `${desc}: unexpected code ${err.code}`)
        return true
      },
      `Failed on ${desc}`,
    )
  }
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
        { firestore: firestoreZero, auth: { uid: 'teacherA' }, hashPin: mockHashPin },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'not-found',
  )

  // Two matches
  const firestoreTwo = createMockFirestore({
    ...baseDocs,
    'classrooms/classA/studentCredentials/cred-one': scopedCredential('classA', 'cred-one', 'stu1'),
    'classrooms/classA/studentCredentials/cred-two': scopedCredential('classA', 'cred-two', 'stu1'),
  })
  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu1', newPin: '1234' },
        { firestore: firestoreTwo, auth: { uid: 'teacherA' }, hashPin: mockHashPin },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'failed-precondition',
  )
})

test('missing student document in classroom fails reset', async () => {
  const initialDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    // Student credential exists, but student document missing!
    'classrooms/classA/studentCredentials/alex-smith': scopedCredential('classA', 'alex-smith', 'stu1'),
  }

  const firestore = createMockFirestore(initialDocs)
  await assert.rejects(
    () =>
      resetStudentPinV2(
        { studentId: 'stu1', newPin: '1234' },
        { firestore, auth: { uid: 'teacherA' }, hashPin: mockHashPin },
      ),
    (err) => err instanceof ResetStudentPinError && err.code === 'not-found',
  )
})

test('malformed or forged scoped credential identity fails closed before mutation', async () => {
  const baseDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/students/stu1': { name: 'Alex' },
  }

  const cases = [
    {
      desc: 'missing classroomId',
      path: 'classrooms/classA/studentCredentials/alex-smith',
      overrides: { classroomId: undefined },
    },
    {
      desc: 'mismatched classroomId',
      path: 'classrooms/classA/studentCredentials/alex-smith',
      overrides: { classroomId: 'classB' },
    },
    {
      desc: 'forged authUid',
      path: 'classrooms/classA/studentCredentials/alex-smith',
      overrides: { authUid: 's_forged' },
    },
    {
      desc: 'missing authUid',
      path: 'classrooms/classA/studentCredentials/alex-smith',
      overrides: { authUid: undefined },
    },
    {
      desc: 'authUid of another student',
      path: 'classrooms/classA/studentCredentials/alex-smith',
      overrides: { authUid: deriveDeterministicStudentAuthUid('classA', 'stu9') },
    },
    {
      desc: 'unsupported schemaVersion',
      path: 'classrooms/classA/studentCredentials/alex-smith',
      overrides: { schemaVersion: 2 },
    },
    {
      desc: 'body loginId disagreeing with document ID',
      path: 'classrooms/classA/studentCredentials/alex-smith',
      overrides: { loginId: 'someone-else' },
    },
    {
      desc: 'noncanonical credential document ID',
      path: 'classrooms/classA/studentCredentials/Alex-Smith',
      overrides: { loginId: undefined },
    },
  ]

  for (const { desc, path, overrides } of cases) {
    const credential = scopedCredential('classA', 'alex-smith', 'stu1', overrides)
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete credential[key]
      }
    }

    const firestore = createMockFirestore({ ...baseDocs, [path]: credential })

    await assert.rejects(
      () =>
        resetStudentPinV2(
          { studentId: 'stu1', newPin: '1234' },
          { firestore, auth: { uid: 'teacherA' }, hashPin: mockHashPin },
        ),
      (err) => {
        assert.ok(err instanceof ResetStudentPinError, `${desc}: ${err?.name}`)
        assert.equal(err.code, 'failed-precondition', desc)
        return true
      },
      `Failed on ${desc}`,
    )

    // Nothing was mutated.
    assert.equal(firestore.store.get(path).pinHash, 'oldHash', desc)
    assert.equal(firestore.store.get(path).active, false, desc)
  }
})

test('retry and contention keep the reset identity-stable and allowlisted', async () => {
  const initialDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/students/stu1': { name: 'Alex' },
    'classrooms/classA/studentCredentials/alex-smith': scopedCredential('classA', 'alex-smith', 'stu1', {
      createdAt: 100,
    }),
  }

  // One aborted attempt before the committing one.
  const firestore = createMockFirestore(initialDocs, { abortAttempts: 1 })

  await resetStudentPinV2(
    { studentId: 'stu1', newPin: '1234' },
    { firestore, auth: { uid: 'teacherA' }, hashPin: mockHashPin, now: () => 3000 },
  )
  assert.equal(firestore.transactionAttempts, 2)

  const first = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')

  // Repeating the same reset replaces the hash without changing identity.
  await resetStudentPinV2(
    { studentId: 'stu1', newPin: '1234' },
    { firestore, auth: { uid: 'teacherA' }, hashPin: mockHashPin, now: () => 4000 },
  )
  const second = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')

  assert.deepEqual(
    { ...second, pinUpdatedAt: first.pinUpdatedAt, updatedAt: first.updatedAt },
    first,
  )
  assert.equal(second.pinUpdatedAt, 4000)
  assert.equal(second.updatedAt, 4000)
  assert.equal(second.authUid, deriveDeterministicStudentAuthUid('classA', 'stu1'))

  // Every transaction attempt read before it wrote.
  for (const operations of firestore.attemptOperations) {
    const firstWrite = operations.findIndex(op => op.kind !== 'read')
    const lastRead = operations.reduce(
      (last, op, index) => (op.kind === 'read' ? index : last),
      -1,
    )
    if (firstWrite !== -1) {
      assert.ok(lastRead < firstWrite, 'read followed a write inside the transaction')
    }
  }
})

test('callable adapter maps every error category to a generic HttpsError', async () => {
  const validDocs = {
    'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'active' },
    'classrooms/classA': { ownerUid: 'teacherA' },
    'classrooms/classA/students/stu1': { name: 'Alex' },
    'classrooms/classA/studentCredentials/alex-smith': scopedCredential('classA', 'alex-smith', 'stu1'),
  }

  // Successful call returns { success: true }
  const res = await resetStudentPinV2CallableHandler(
    { studentId: 'stu1', newPin: '1234' },
    { auth: { uid: 'teacherA' } },
    { firestore: createMockFirestore(validDocs), hashPin: mockHashPin },
  )
  assert.deepEqual(res, { success: true })

  const cases = [
    {
      desc: 'unknown field',
      data: { studentId: 'stu1', newPin: '1234', classroomId: 'classA' },
      context: { auth: { uid: 'teacherA' } },
      docs: validDocs,
      code: 'invalid-argument',
    },
    {
      desc: 'unauthenticated',
      data: { studentId: 'stu1', newPin: '1234' },
      context: {},
      docs: validDocs,
      code: 'unauthenticated',
    },
    {
      desc: 'malformed auth uid',
      data: { studentId: 'stu1', newPin: '1234' },
      context: { auth: { uid: 'bad/uid' } },
      docs: validDocs,
      code: 'unauthenticated',
    },
    {
      desc: 'unknown teacher',
      data: { studentId: 'stu1', newPin: '1234' },
      context: { auth: { uid: 'teacherZ' } },
      docs: validDocs,
      code: 'permission-denied',
    },
    {
      desc: 'disabled teacher',
      data: { studentId: 'stu1', newPin: '1234' },
      context: { auth: { uid: 'teacherA' } },
      docs: {
        ...validDocs,
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'disabled' },
      },
      code: 'permission-denied',
    },
    {
      desc: 'invalid teacher status',
      data: { studentId: 'stu1', newPin: '1234' },
      context: { auth: { uid: 'teacherA' } },
      docs: {
        ...validDocs,
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'classA', status: 'pending' },
      },
      code: 'failed-precondition',
    },
    {
      desc: 'teacher uid mismatch',
      data: { studentId: 'stu1', newPin: '1234' },
      context: { auth: { uid: 'teacherA' } },
      docs: {
        ...validDocs,
        'teachers/teacherA': { uid: 'teacherZ', classroomId: 'classA', status: 'active' },
      },
      code: 'failed-precondition',
    },
    {
      desc: 'malformed classroom id',
      data: { studentId: 'stu1', newPin: '1234' },
      context: { auth: { uid: 'teacherA' } },
      docs: {
        ...validDocs,
        'teachers/teacherA': { uid: 'teacherA', classroomId: 'bad/class', status: 'active' },
      },
      code: 'failed-precondition',
    },
    {
      desc: 'classroom owner mismatch',
      data: { studentId: 'stu1', newPin: '1234' },
      context: { auth: { uid: 'teacherA' } },
      docs: { ...validDocs, 'classrooms/classA': { ownerUid: 'teacherB' } },
      code: 'failed-precondition',
    },
    {
      desc: 'credential not found',
      data: { studentId: 'stu404', newPin: '1234' },
      context: { auth: { uid: 'teacherA' } },
      docs: validDocs,
      code: 'not-found',
    },
    {
      desc: 'forged credential identity',
      data: { studentId: 'stu1', newPin: '1234' },
      context: { auth: { uid: 'teacherA' } },
      docs: {
        ...validDocs,
        'classrooms/classA/studentCredentials/alex-smith': scopedCredential('classA', 'alex-smith', 'stu1', {
          authUid: 's_forged',
        }),
      },
      code: 'failed-precondition',
    },
  ]

  const allowedMessages = new Set([
    'Sign in required.',
    'This account is not eligible to complete this action.',
    'The request was invalid.',
    'That student was not found in your classroom.',
    'This student record cannot be updated automatically. Contact your administrator for assistance.',
    'The request could not be completed. Please try again.',
    'An unexpected internal error occurred.',
  ])

  for (const { desc, data, context, docs, code } of cases) {
    await assert.rejects(
      () =>
        resetStudentPinV2CallableHandler(data, context, {
          firestore: createMockFirestore(docs),
          hashPin: mockHashPin,
        }),
      (error) => {
        assert.equal(error.code, code, `${desc}: unexpected code ${error.code}`)
        assert.ok(allowedMessages.has(error.message), `${desc}: leaked message ${error.message}`)
        assert.equal(error.details, undefined, `${desc}: attached details`)
        return true
      },
      `Failed on ${desc}`,
    )
  }

  // An unexpected internal failure never reaches the client verbatim.
  await assert.rejects(
    () =>
      resetStudentPinV2CallableHandler(
        { studentId: 'stu1', newPin: '1234' },
        { auth: { uid: 'teacherA' } },
        {
          firestore: {
            collection: () => {
              throw new Error('internal detail: bcrypt hash $2b$12$abcdef for PIN 1234')
            },
          },
          hashPin: mockHashPin,
        },
      ),
    (error) => {
      assert.equal(error.code, 'internal')
      assert.equal(error.message, 'An unexpected internal error occurred.')
      assert.ok(!error.message.includes('1234'))
      return true
    },
  )
})
