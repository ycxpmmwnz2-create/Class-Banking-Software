import test from 'node:test'
import assert from 'node:assert/strict'
import {
  verifyStudentCredentialV2,
  studentPinLoginV2CallableHandler,
  StudentVerifierError,
  STUDENT_LOGIN_DUMMY_PIN_HASH,
  STUDENT_LOGIN_OUTCOMES,
} from './studentCredentialVerifier.js'
import { deriveDeterministicStudentAuthUid } from './scopedCredentialProjection.js'
import { formatClassroomCode } from './identityNormalization.js'

const CLASS_A_CODE = '23456789'
const CLASS_B_CODE = '3456789A'
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Firestore double that enforces the Admin SDK transaction rules the real
 * backend enforces and the Cycle 2 mocks did not:
 *
 * - a transaction read after the transaction's first write throws, exactly as
 *   `Transaction.get()` does against real Firestore;
 * - writes stay buffered until commit, so a retried callback cannot observe
 *   its own discarded writes;
 * - `abortAttempts` replays the callback like a contention (ABORTED) retry so
 *   side effects that must happen once can be counted;
 * - `update` on a missing document fails, as it does in production.
 */
function createMockFirestore(initialDocs = {}, { abortAttempts = 0 } = {}) {
  const store = new Map()
  for (const [path, data] of Object.entries(initialDocs)) {
    store.set(path, clone(data))
  }

  let autoIdCounter = 0
  let transactionAttempts = 0
  const attemptOperations = []

  function docRef(path) {
    return { path, id: path.split('/').pop() }
  }

  function collectionRef(collectionPath) {
    return {
      path: collectionPath,
      doc(id) {
        autoIdCounter += 1
        return docRef(`${collectionPath}/${id ?? `auto_${autoIdCounter}`}`)
      },
    }
  }

  return {
    store,
    attemptOperations,
    get transactionAttempts() {
      return transactionAttempts
    },
    doc: docRef,
    collection: collectionRef,
    async runTransaction(updateFunction) {
      for (;;) {
        transactionAttempts += 1
        const operations = []
        const writes = []
        let hasWritten = false

        const transaction = {
          async get(refOrPath) {
            const path = typeof refOrPath === 'string' ? refOrPath : refOrPath.path
            if (hasWritten) {
              throw new Error(
                'Firestore transactions require all reads to be executed before all writes.',
              )
            }
            operations.push({ kind: 'read', path })
            const data = store.get(path)
            return {
              exists: data !== undefined,
              id: path.split('/').pop(),
              ref: docRef(path),
              data: () => clone(data),
            }
          },
          set(refOrPath, data) {
            const path = typeof refOrPath === 'string' ? refOrPath : refOrPath.path
            hasWritten = true
            operations.push({ kind: 'set', path })
            writes.push({ kind: 'set', path, data: clone(data) })
          },
          update(refOrPath, data) {
            const path = typeof refOrPath === 'string' ? refOrPath : refOrPath.path
            hasWritten = true
            operations.push({ kind: 'update', path })
            writes.push({ kind: 'update', path, data: clone(data) })
          },
        }

        const result = await updateFunction(transaction)
        attemptOperations.push(operations)

        if (transactionAttempts <= abortAttempts) {
          // Buffered writes are discarded, mirroring an aborted transaction.
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

function tokenFactory() {
  const calls = []
  return {
    calls,
    createCustomToken: async (uid, claims) => {
      calls.push({ uid, claims })
      return `token_for_${uid}_${claims.studentId}`
    },
  }
}

function classroomFixture(classroomId, teacherUid, code) {
  return {
    [`classroomLoginCodes/${code}`]: { status: 'active', classroomId },
    [`classrooms/${classroomId}`]: {
      ownerUid: teacherUid,
      studentLoginCode: formatClassroomCode(code),
    },
    [`teachers/${teacherUid}`]: {
      uid: teacherUid,
      classroomId,
      status: 'active',
    },
  }
}

function credentialFixture(classroomId, loginId, studentId, overrides = {}) {
  return {
    [`classrooms/${classroomId}/studentCredentials/${loginId}`]: {
      loginId,
      classroomId,
      studentId,
      authUid: deriveDeterministicStudentAuthUid(classroomId, studentId),
      schemaVersion: 1,
      active: true,
      pinHash: '$2b$10$storedhash',
      pinUpdatedAt: 1000,
      failedAttempts: 0,
      lockedUntil: null,
      ...overrides,
    },
  }
}

function logEntries(firestore, prefix) {
  return Array.from(firestore.store.entries())
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, data]) => ({ path, data }))
}

test('successful student verification: exact claims, authUid, and token output', async () => {
  const authUidA = deriveDeterministicStudentAuthUid('classA', 'stu123')
  const initialDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu123'),
  }

  const firestore = createMockFirestore(initialDocs)
  const factory = tokenFactory()

  const result = await verifyStudentCredentialV2(
    { classroomCode: '2345-6789', loginId: 'alex-smith', pin: '1234' },
    {
      firestore,
      verifyPin: async () => true,
      createCustomToken: factory.createCustomToken,
    },
  )

  assert.equal(result.authUid, authUidA)
  assert.deepEqual(result.claims, {
    role: 'student',
    classroomId: 'classA',
    studentId: 'stu123',
    loginId: 'alex-smith',
    credentialVersion: 1000,
  })
  assert.equal(result.token, `token_for_${authUidA}_stu123`)
  assert.equal(factory.calls.length, 1)

  // Verify callable adapter returns only { token }
  const callableResult = await studentPinLoginV2CallableHandler(
    { classroomCode: '2345-6789', loginId: 'alex-smith', pin: '1234' },
    {},
    {
      firestore,
      verifyPin: async () => true,
      createCustomToken: factory.createCustomToken,
    },
  )

  assert.deepEqual(callableResult, { token: `token_for_${authUidA}_stu123` })
})

test('same login ID succeeds independently in A and B only with matching code', async () => {
  const authUidA = deriveDeterministicStudentAuthUid('classA', 'stu_a')
  const authUidB = deriveDeterministicStudentAuthUid('classB', 'stu_b')

  const initialDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...classroomFixture('classB', 'teacherB', CLASS_B_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu_a', { pinHash: 'hashA' }),
    ...credentialFixture('classB', 'alex-smith', 'stu_b', { pinHash: 'hashB' }),
  }

  const firestore = createMockFirestore(initialDocs)
  const factory = tokenFactory()
  const dependencies = {
    firestore,
    verifyPin: async () => true,
    createCustomToken: factory.createCustomToken,
  }

  const resA = await verifyStudentCredentialV2(
    { classroomCode: '2345-6789', loginId: 'alex-smith', pin: '1234' },
    dependencies,
  )
  assert.equal(resA.claims.classroomId, 'classA')
  assert.equal(resA.claims.studentId, 'stu_a')
  assert.equal(resA.authUid, authUidA)

  const resB = await verifyStudentCredentialV2(
    { classroomCode: '3456-789A', loginId: 'alex-smith', pin: '1234' },
    dependencies,
  )
  assert.equal(resB.claims.classroomId, 'classB')
  assert.equal(resB.claims.studentId, 'stu_b')
  assert.equal(resB.authUid, authUidB)
  assert.notEqual(resA.authUid, resB.authUid)

  // Cross-classroom writes never happen: each attempt logged only in its own
  // scoped collection.
  assert.equal(logEntries(firestore, 'studentAuthLogs/classA/logs/').length, 1)
  assert.equal(logEntries(firestore, 'studentAuthLogs/classB/logs/').length, 1)
  assert.equal(logEntries(firestore, 'studentAuthUnresolvedLogs/').length, 0)
})

test('same studentId in A and B creates distinct auth UIDs', () => {
  const uidA = deriveDeterministicStudentAuthUid('classA', 'same_student_id')
  const uidB = deriveDeterministicStudentAuthUid('classB', 'same_student_id')
  assert.notEqual(uidA, uidB)
})

test('every transaction read precedes the first transaction write in all paths', async () => {
  const initialDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1'),
  }

  const requests = [
    { desc: 'success', req: { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '1234' }, verify: async () => true },
    { desc: 'wrong pin', req: { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '0000' }, verify: async () => false },
    { desc: 'unknown login', req: { classroomCode: CLASS_A_CODE, loginId: 'nobody', pin: '1234' }, verify: async () => false },
    { desc: 'unknown code', req: { classroomCode: 'FFFFFFFF', loginId: 'alex-smith', pin: '1234' }, verify: async () => false },
    { desc: 'malformed code', req: { classroomCode: 'nope', loginId: 'alex-smith', pin: '1234' }, verify: async () => false },
    { desc: 'malformed shape', req: { classroomCode: CLASS_A_CODE, loginId: 'alex-smith' }, verify: async () => false },
  ]

  for (const { desc, req, verify } of requests) {
    const firestore = createMockFirestore(initialDocs)
    const factory = tokenFactory()
    try {
      await verifyStudentCredentialV2(req, {
        firestore,
        verifyPin: verify,
        createCustomToken: factory.createCustomToken,
      })
    } catch (error) {
      assert.ok(
        error instanceof StudentVerifierError,
        `${desc}: unexpected error ${error?.message}`,
      )
    }

    for (const operations of firestore.attemptOperations) {
      const firstWriteIndex = operations.findIndex(op => op.kind !== 'read')
      const lastReadIndex = operations.reduce(
        (last, op, index) => (op.kind === 'read' ? index : last),
        -1,
      )
      if (firstWriteIndex !== -1) {
        assert.ok(
          lastReadIndex < firstWriteIndex,
          `${desc}: read at ${lastReadIndex} follows first write at ${firstWriteIndex}`,
        )
      }
    }
  }
})

test('custom token is created once after commit, never inside a retried transaction', async () => {
  const initialDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1'),
  }

  // Two aborted attempts before the committing one.
  const firestore = createMockFirestore(initialDocs, { abortAttempts: 2 })
  const factory = tokenFactory()

  const result = await verifyStudentCredentialV2(
    { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '1234' },
    {
      firestore,
      verifyPin: async () => true,
      createCustomToken: factory.createCustomToken,
    },
  )

  assert.equal(firestore.transactionAttempts, 3)
  assert.equal(factory.calls.length, 1)
  assert.equal(result.token, `token_for_${result.authUid}_stu1`)

  // Only the committed attempt's writes are visible.
  assert.equal(logEntries(firestore, 'studentAuthLogs/classA/logs/').length, 1)

  // A failed login creates no token at all.
  const failing = createMockFirestore(initialDocs)
  const failingFactory = tokenFactory()
  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '0000' },
        {
          firestore: failing,
          verifyPin: async () => false,
          createCustomToken: failingFactory.createCustomToken,
        },
      ),
    StudentVerifierError,
  )
  assert.equal(failingFactory.calls.length, 0)
})

test('error indistinguishability: all failure modes return generic unauthenticated error', async () => {
  const baseDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1', { pinHash: 'hash' }),
  }

  const failureRequests = [
    { desc: 'malformed code', req: { classroomCode: 'bad', loginId: 'alex-smith', pin: '1234' } },
    { desc: 'unknown code', req: { classroomCode: 'FFFFFFFF', loginId: 'alex-smith', pin: '1234' } },
    { desc: 'missing login', req: { classroomCode: CLASS_A_CODE, loginId: 'nonexistent', pin: '1234' } },
    { desc: 'malformed login', req: { classroomCode: CLASS_A_CODE, loginId: '--bad--', pin: '1234' } },
    { desc: 'unknown field', req: { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '1234', extra: 'x' } },
    { desc: 'missing pin', req: { classroomCode: CLASS_A_CODE, loginId: 'alex-smith' } },
    { desc: 'non-object request', req: 'not-an-object' },
    { desc: 'wrong pin', req: { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '0000' }, customVerify: async () => false },
  ]

  for (const { desc, req, customVerify } of failureRequests) {
    const firestore = createMockFirestore(baseDocs)
    const factory = tokenFactory()
    await assert.rejects(
      async () =>
        verifyStudentCredentialV2(req, {
          firestore,
          verifyPin: customVerify || (async () => false),
          createCustomToken: factory.createCustomToken,
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

test('dummy hash timing defense runs exactly once per attempt', async () => {
  assert.match(STUDENT_LOGIN_DUMMY_PIN_HASH, /^\$2b\$12\$/)

  const initialDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1', { pinHash: 'storedhash' }),
  }

  const cases = [
    { desc: 'unresolved code', req: { classroomCode: CLASS_A_CODE, loginId: 'missing', pin: '1234' }, matches: false, expectDummy: 1, expectStored: 0 },
    { desc: 'malformed request', req: { classroomCode: 'bad', loginId: 'alex', pin: '1234' }, matches: false, expectDummy: 1, expectStored: 0 },
    { desc: 'wrong pin', req: { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '0000' }, matches: false, expectDummy: 0, expectStored: 1 },
  ]

  for (const { desc, req, matches, expectDummy, expectStored } of cases) {
    const firestore = createMockFirestore(initialDocs)
    const factory = tokenFactory()
    let dummyCalls = 0
    let storedCalls = 0
    const verifyPin = async (pin, hash) => {
      if (hash === STUDENT_LOGIN_DUMMY_PIN_HASH) {
        dummyCalls += 1
      } else {
        storedCalls += 1
      }
      return matches
    }

    await assert.rejects(
      () =>
        verifyStudentCredentialV2(req, {
          firestore,
          verifyPin,
          createCustomToken: factory.createCustomToken,
        }),
      StudentVerifierError,
      `Failed on ${desc}`,
    )

    assert.equal(dummyCalls, expectDummy, `${desc}: dummy compare count`)
    assert.equal(storedCalls, expectStored, `${desc}: stored compare count`)
  }
})

test('wrong PINs never create a victim-controlled lockout and a correct PIN remains usable', async () => {
  const initialDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1', {
      pinHash: 'hash',
      failedAttempts: 4,
      lockedUntil: null,
    }),
  }

  const firestore = createMockFirestore(initialDocs)
  const factory = tokenFactory()
  let currentTime = 1000000

  // A fifth failed attempt caps the diagnostic counter without locking the
  // shared credential. Abuse is controlled by source/identifier throttles.
  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: 'wrong' },
        {
          firestore,
          verifyPin: async () => false,
          now: () => currentTime,
          createCustomToken: factory.createCustomToken,
        },
      ),
    StudentVerifierError,
  )

  const lockedCred = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.equal(lockedCred.failedAttempts, 5)
  assert.equal(lockedCred.lockedUntil, null)

  // Further failures do not grow the victim-owned counter.
  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: 'wrong' },
        {
          firestore,
          verifyPin: async () => false,
          now: () => currentTime + 1000,
          createCustomToken: factory.createCustomToken,
        },
      ),
    StudentVerifierError,
  )
  const stillLocked = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.equal(stillLocked.failedAttempts, 5)

  // A correct PIN remains usable before the throttle boundary is reached.
  currentTime += 2000
  const successRes = await verifyStudentCredentialV2(
    { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: 'correct' },
    {
      firestore,
      verifyPin: async () => true,
      now: () => currentTime,
      createCustomToken: factory.createCustomToken,
    },
  )
  assert.ok(successRes)

  const unlockedCred = firestore.store.get('classrooms/classA/studentCredentials/alex-smith')
  assert.equal(unlockedCred.failedAttempts, 0)
  assert.equal(unlockedCred.lockedUntil, null)
})

test('ten-attempt throttle boundary and window reset', async () => {
  const initialDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1', { pinHash: 'hash' }),
  }

  const firestore = createMockFirestore(initialDocs)
  const factory = tokenFactory()
  let currentTime = 1000000

  // Ten failed attempts fill the rolling window.
  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(
      () =>
        verifyStudentCredentialV2(
          { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: 'wrong' },
          {
            firestore,
            verifyPin: async () => false,
            now: () => currentTime,
            createCustomToken: factory.createCustomToken,
          },
        ),
      StudentVerifierError,
    )
  }

  const throttleDocs = logEntries(firestore, 'studentLoginThrottle/')
  assert.equal(throttleDocs.length, 3)
  assert.equal(throttleDocs.every(entry => entry.data.attempts.length === 10), true)

  // An attacker can fill the identifier bucket, but the victim's correct PIN
  // still works while the independent source/global budgets remain available.
  const recovered = await verifyStudentCredentialV2(
    { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: 'correct' },
    {
      firestore,
      verifyPin: async () => true,
      now: () => currentTime + 1000,
      createCustomToken: factory.createCustomToken,
    },
  )
  assert.ok(recovered)
  assert.equal(factory.calls.length, 1)
  assert.deepEqual(
    logEntries(firestore, 'studentLoginThrottle/')
      .map(entry => entry.data.attempts.length).sort((a, b) => a - b),
    [0, 10, 10],
  )

  // Fast forward past the window: another failure starts all three rolling
  // budgets at one rather than preserving stale timestamps.
  currentTime += 6 * 60 * 1000
  await assert.rejects(
    verifyStudentCredentialV2(
      { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: 'wrong' },
      {
        firestore,
        verifyPin: async () => false,
        now: () => currentTime,
        createCustomToken: factory.createCustomToken,
      },
    ),
    StudentVerifierError,
  )
  assert.equal(
    logEntries(firestore, 'studentLoginThrottle/')
      .every(entry => entry.data.attempts.length === 1),
    true,
  )
})

test('repeated malformed and unknown-code attempts reach the digest throttle', async () => {
  const scenarios = [
    {
      desc: 'malformed classroom code',
      req: { classroomCode: 'not-a-code', loginId: 'alex-smith', pin: '1234' },
    },
    {
      desc: 'malformed request shape',
      req: { classroomCode: CLASS_A_CODE, loginId: 'alex-smith' },
    },
    {
      desc: 'unknown but well-formed code',
      req: { classroomCode: 'FFFFFFFF', loginId: 'alex-smith', pin: '1234' },
    },
  ]

  for (const { desc, req } of scenarios) {
    const firestore = createMockFirestore(
      classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    )
    const factory = tokenFactory()
    const dependencies = {
      firestore,
      verifyPin: async () => false,
      now: () => 5000,
      createCustomToken: factory.createCustomToken,
    }

    for (let i = 0; i < 10; i += 1) {
      await assert.rejects(
        () => verifyStudentCredentialV2(req, dependencies),
        StudentVerifierError,
        `${desc}: attempt ${i + 1}`,
      )
    }

    const throttleDocs = logEntries(firestore, 'studentLoginThrottle/')
    assert.equal(throttleDocs.length, 3, `${desc}: identifier, source, and global buckets`)
    assert.equal(
      throttleDocs.every(entry => entry.data.attempts.length === 10),
      true,
      `${desc}: ten counted in each bounded layer`,
    )
    assert.equal(
      throttleDocs.every(entry => /^studentLoginThrottle\/[a-f0-9]{64}$/.test(entry.path)),
      true,
    )

    // The 11th attempt is rejected by the throttle itself.
    await assert.rejects(
      () => verifyStudentCredentialV2(req, dependencies),
      StudentVerifierError,
    )

    const throttledLogs = logEntries(firestore, 'studentAuthUnresolvedLogs/')
      .filter(entry => entry.data.outcome === STUDENT_LOGIN_OUTCOMES.THROTTLED)
    assert.equal(throttledLogs.length, 0, `${desc}: throttled floods create no new logs`)
  }
})

test('identifier-throttled failures create no further durable auth logs', async () => {
  const initialDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1', { pinHash: 'hash' }),
  }

  const firestore = createMockFirestore(initialDocs)
  const factory = tokenFactory()
  const dependencies = {
    firestore,
    verifyPin: async () => false,
    now: () => 7000,
    createCustomToken: factory.createCustomToken,
  }
  const request = { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: 'wrong' }

  for (let i = 0; i < 11; i += 1) {
    await assert.rejects(
      () => verifyStudentCredentialV2(request, dependencies),
      StudentVerifierError,
    )
  }

  const scopedLogs = logEntries(firestore, 'studentAuthLogs/classA/logs/')
  const throttled = scopedLogs.filter(
    entry => entry.data.outcome === STUDENT_LOGIN_OUTCOMES.THROTTLED,
  )
  assert.equal(throttled.length, 0)
  assert.equal(scopedLogs.length, 10)
  assert.equal(logEntries(firestore, 'studentAuthUnresolvedLogs/').length, 0)
})

test('rotating identifiers cannot bypass the bounded source budget', async () => {
  const firestore = createMockFirestore(
    classroomFixture('classA', 'teacherA', CLASS_A_CODE),
  )
  const factory = tokenFactory()
  let bcryptCalls = 0
  const dependencies = {
    firestore,
    sourceKey: 'same-network-source',
    verifyPin: async () => { bcryptCalls += 1; return false },
    now: () => 9000,
    createCustomToken: factory.createCustomToken,
  }

  for (let index = 0; index < 30; index += 1) {
    await assert.rejects(
      verifyStudentCredentialV2(
        { classroomCode: 'FFFFFFFF', loginId: `rotating-${index}`, pin: '1234' },
        dependencies,
      ),
      StudentVerifierError,
    )
  }
  const logsBeforeThrottle = logEntries(firestore, 'studentAuthUnresolvedLogs/').length
  const writesBeforeThrottle = firestore.store.size

  await assert.rejects(
    verifyStudentCredentialV2(
      { classroomCode: 'FFFFFFFF', loginId: 'rotating-31', pin: '1234' },
      dependencies,
    ),
    StudentVerifierError,
  )

  assert.equal(bcryptCalls, 30, 'the source-throttled request must skip bcrypt')
  assert.equal(logEntries(firestore, 'studentAuthUnresolvedLogs/').length, logsBeforeThrottle)
  assert.equal(firestore.store.size, writesBeforeThrottle, 'the throttled request must create no document')
})

test('resolved versus unresolved log paths and redacted bodies', async () => {
  const initialDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1', { pinHash: 'hash' }),
  }

  const firestore = createMockFirestore(initialDocs)
  const factory = tokenFactory()

  // Unresolved code log
  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: 'FFFFFFFF', loginId: 'alex-smith', pin: 'secret-pin' },
        { firestore, verifyPin: async () => false, createCustomToken: factory.createCustomToken },
      ),
    StudentVerifierError,
  )

  const unresolvedLogs = logEntries(firestore, 'studentAuthUnresolvedLogs/')
  assert.equal(unresolvedLogs.length, 1)
  const logData = unresolvedLogs[0].data
  assert.equal(logData.studentId, undefined)
  assert.ok(typeof logData.identifierDigest === 'string')

  // Resolved log
  await verifyStudentCredentialV2(
    { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: 'secret-pin' },
    { firestore, verifyPin: async () => true, createCustomToken: factory.createCustomToken },
  )

  const resolvedLogs = logEntries(firestore, 'studentAuthLogs/classA/logs/')
  assert.equal(resolvedLogs.length, 1)
  assert.equal(resolvedLogs[0].data.studentId, 'stu1')
  assert.equal(resolvedLogs[0].data.success, true)

  // No raw identifier or secret in any throttle/log document ID or body.
  const auditedPrefixes = [
    'studentAuthLogs/',
    'studentAuthUnresolvedLogs/',
    'studentLoginThrottle/',
  ]
  const forbidden = ['secret-pin', 'alex-smith', 'FFFFFFFF', CLASS_A_CODE, '2345-6789', 'hash']
  for (const prefix of auditedPrefixes) {
    for (const { path, data } of logEntries(firestore, prefix)) {
      const serialized = `${path} ${JSON.stringify(data)}`
      for (const secret of forbidden) {
        assert.ok(
          !serialized.includes(secret),
          `${prefix} entry leaked ${secret}: ${serialized}`,
        )
      }
    }
  }
})

test('forged credential identity fails closed for every mismatched field', async () => {
  const validAuthUid = deriveDeterministicStudentAuthUid('classA', 'stu1')

  const forgedCases = [
    { desc: 'forged classroomId', overrides: { classroomId: 'classB' } },
    { desc: 'forged authUid', overrides: { authUid: 'forged_uid' } },
    { desc: 'missing authUid', overrides: { authUid: undefined } },
    { desc: 'authUid of another student', overrides: { authUid: deriveDeterministicStudentAuthUid('classA', 'stu2') } },
    { desc: 'unsupported schemaVersion', overrides: { schemaVersion: 99 } },
    { desc: 'missing schemaVersion', overrides: { schemaVersion: undefined } },
    { desc: 'inactive credential', overrides: { active: false } },
    { desc: 'missing studentId', overrides: { studentId: undefined, authUid: validAuthUid } },
    { desc: 'malformed studentId', overrides: { studentId: 'bad/student' } },
    { desc: 'forged body loginId', overrides: { loginId: 'someone-else' } },
    { desc: 'missing pinHash', overrides: { pinHash: undefined } },
    { desc: 'non-string pinHash', overrides: { pinHash: 12345 } },
    { desc: 'empty pinHash', overrides: { pinHash: '' } },
    { desc: 'missing credential version', overrides: { pinUpdatedAt: undefined } },
    { desc: 'zero credential version', overrides: { pinUpdatedAt: 0 } },
    { desc: 'fractional credential version', overrides: { pinUpdatedAt: 1.5 } },
  ]

  for (const { desc, overrides } of forgedCases) {
    const credentials = credentialFixture('classA', 'alex-smith', 'stu1')
    const credPath = 'classrooms/classA/studentCredentials/alex-smith'
    credentials[credPath] = { ...credentials[credPath], ...overrides }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete credentials[credPath][key]
      }
    }

    const firestore = createMockFirestore({
      ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
      ...credentials,
    })
    const factory = tokenFactory()

    await assert.rejects(
      () =>
        verifyStudentCredentialV2(
          { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '1234' },
          {
            firestore,
            // A permissive verifier proves the identity checks, not the PIN
            // comparison, are what reject these credentials.
            verifyPin: async () => true,
            createCustomToken: factory.createCustomToken,
          },
        ),
      (err) => err instanceof StudentVerifierError,
      `Failed on ${desc}`,
    )
    assert.equal(factory.calls.length, 0, `${desc}: token must not be created`)
  }
})

test('forged or inactive classroom code index cannot resolve a tenant', async () => {
  const validDocs = {
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...classroomFixture('classB', 'teacherB', CLASS_B_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1'),
  }

  const cases = [
    {
      desc: 'code index pointing at a classroom that names another code',
      docs: {
        ...validDocs,
        [`classroomLoginCodes/${CLASS_A_CODE}`]: { status: 'active', classroomId: 'classB' },
      },
    },
    {
      desc: 'revoked code index',
      docs: {
        ...validDocs,
        [`classroomLoginCodes/${CLASS_A_CODE}`]: { status: 'revoked', classroomId: 'classA' },
      },
    },
    {
      desc: 'classroom root missing its login code',
      docs: {
        ...validDocs,
        'classrooms/classA': { ownerUid: 'teacherA' },
      },
    },
    {
      desc: 'classroom root naming a different code',
      docs: {
        ...validDocs,
        'classrooms/classA': {
          ownerUid: 'teacherA',
          studentLoginCode: formatClassroomCode(CLASS_B_CODE),
        },
      },
    },
    {
      desc: 'malformed indexed classroom ID',
      docs: {
        ...validDocs,
        [`classroomLoginCodes/${CLASS_A_CODE}`]: { status: 'active', classroomId: 'bad/class' },
      },
    },
  ]

  for (const { desc, docs } of cases) {
    const firestore = createMockFirestore(docs)
    const factory = tokenFactory()
    await assert.rejects(
      () =>
        verifyStudentCredentialV2(
          { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '1234' },
          { firestore, verifyPin: async () => true, createCustomToken: factory.createCustomToken },
        ),
      (err) => err instanceof StudentVerifierError,
      `Failed on ${desc}`,
    )

    // A code that never resolved a valid tenant must not write into any
    // classroom's scoped log space.
    assert.equal(
      logEntries(firestore, 'studentAuthLogs/').length,
      0,
      `${desc}: wrote a scoped log for an unresolved code`,
    )
    assert.equal(logEntries(firestore, 'studentAuthUnresolvedLogs/').length, 1, desc)
  }
})

test('disabled or reciprocal mismatch teacher foundation rejected', async () => {
  const cases = [
    {
      desc: 'disabled teacher',
      teacher: { uid: 'teacherA', classroomId: 'classA', status: 'disabled' },
    },
    {
      desc: 'missing status',
      teacher: { uid: 'teacherA', classroomId: 'classA' },
    },
    {
      desc: 'teacher classroom mismatch',
      teacher: { uid: 'teacherA', classroomId: 'classB', status: 'active' },
    },
    {
      desc: 'teacher uid mismatch',
      teacher: { uid: 'teacherZ', classroomId: 'classA', status: 'active' },
    },
  ]

  for (const { desc, teacher } of cases) {
    const firestore = createMockFirestore({
      ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
      'teachers/teacherA': teacher,
      ...credentialFixture('classA', 'alex-smith', 'stu1'),
    })
    const factory = tokenFactory()

    await assert.rejects(
      () =>
        verifyStudentCredentialV2(
          { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '1234' },
          { firestore, verifyPin: async () => true, createCustomToken: factory.createCustomToken },
        ),
      StudentVerifierError,
      `Failed on ${desc}`,
    )
    assert.equal(factory.calls.length, 0, desc)
  }
})

test('callable adapter raises generic HttpsError codes only', async () => {
  const firestore = createMockFirestore({
    ...classroomFixture('classA', 'teacherA', CLASS_A_CODE),
    ...credentialFixture('classA', 'alex-smith', 'stu1'),
  })
  const factory = tokenFactory()

  await assert.rejects(
    () =>
      studentPinLoginV2CallableHandler(
        { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: 'wrong' },
        {},
        { firestore, verifyPin: async () => false, createCustomToken: factory.createCustomToken },
      ),
    (error) => {
      assert.equal(error.code, 'unauthenticated')
      assert.equal(error.message, 'Invalid student credentials.')
      assert.equal(error.httpErrorCode?.status, 401)
      assert.equal(error.details, undefined)
      return true
    },
  )

  // An unexpected internal failure is not forwarded to the client.
  const exploding = {
    doc: firestore.doc,
    collection: firestore.collection,
    runTransaction: async () => {
      throw new Error('internal detail: projectId morgan-bank secret path')
    },
  }
  await assert.rejects(
    () =>
      studentPinLoginV2CallableHandler(
        { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '1234' },
        {},
        { firestore: exploding, verifyPin: async () => true, createCustomToken: factory.createCustomToken },
      ),
    (error) => {
      assert.equal(error.code, 'internal')
      assert.ok(!error.message.includes('morgan-bank'))
      return true
    },
  )
})

test('missing custom-token factory fails fast before any Firestore access', async () => {
  const firestore = createMockFirestore(
    classroomFixture('classA', 'teacherA', CLASS_A_CODE),
  )

  await assert.rejects(
    () =>
      verifyStudentCredentialV2(
        { classroomCode: CLASS_A_CODE, loginId: 'alex-smith', pin: '1234' },
        { firestore, verifyPin: async () => true },
      ),
    TypeError,
  )
  assert.equal(firestore.transactionAttempts, 0)
})
