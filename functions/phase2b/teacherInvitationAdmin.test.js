import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpsError } from 'firebase-functions/v2/https'

import {
  createTeacherInvitationCallable,
  createTeacherInvitationService,
  revokeTeacherInvitationCallable,
  revokeTeacherInvitationService,
  FOUNDING_PLATFORM_ADMIN_UID,
  TeacherInvitationAdminError,
} from './teacherInvitationAdmin.js'
import { hashEmailDigest } from './identityNormalization.js'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createMockFirestore(initial = {}) {
  const store = new Map(Object.entries(initial).map(([path, value]) => [path, clone(value)]))
  const refFor = path => ({ path })

  const firestore = {
    store,
    collection(name) {
      return {
        doc(id) {
          return refFor(`${name}/${id}`)
        },
      }
    },
    async runTransaction(callback) {
      const writes = []
      const transaction = {
        async get(ref) {
          return {
            exists: store.has(ref.path),
            data: () => clone(store.get(ref.path)),
          }
        },
        create(ref, value) {
          if (store.has(ref.path)) {
            const error = new Error('already exists')
            error.code = 'already-exists'
            throw error
          }
          writes.push(['set', ref.path, clone(value)])
        },
        set(ref, value) {
          writes.push(['set', ref.path, clone(value)])
        },
        update(ref, value) {
          if (!store.has(ref.path)) throw new Error('missing update target')
          writes.push(['update', ref.path, clone(value)])
        },
      }
      const result = await callback(transaction)
      for (const [kind, path, value] of writes) {
        store.set(
          path,
          kind === 'update' ? { ...store.get(path), ...value } : value,
        )
      }
      return result
    },
  }

  return firestore
}

const adminAuth = {
  uid: 'platform-admin-1',
  token: { platformAdmin: true },
}

const testTime = 1_700_000_000_000
const serviceOptions = {
  now: () => testTime,
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  timestampFromMillis: millis => millis,
}

function invitationPath(email) {
  return `teacherInvitations/${hashEmailDigest(email)}`
}

test('createTeacherInvitationService creates the exact active invitation schema', async () => {
  const firestore = createMockFirestore()
  const result = await createTeacherInvitationService({
    firestore,
    auth: adminAuth,
    data: { email: ' Friend@School.org ', expiresInHours: 24 },
    ...serviceOptions,
  })

  assert.deepEqual(result, { success: true, status: 'active', created: true })
  assert.deepEqual(firestore.store.get(invitationPath('friend@school.org')), {
    email: 'friend@school.org',
    status: 'active',
    createdAt: 'SERVER_TIMESTAMP',
    expiresAt: testTime + (24 * 60 * 60 * 1000),
  })
})

test('createTeacherInvitationService defaults to 48 hours and is idempotent while active', async () => {
  const path = invitationPath('active@school.org')
  const existing = {
    email: 'active@school.org',
    status: 'active',
    createdAt: testTime - 5_000,
    expiresAt: testTime + 5_000,
  }
  const firestore = createMockFirestore({ [path]: existing })

  const result = await createTeacherInvitationService({
    firestore,
    auth: adminAuth,
    data: { email: 'active@school.org' },
    ...serviceOptions,
  })

  assert.deepEqual(result, { success: true, status: 'active', created: false })
  assert.deepEqual(firestore.store.get(path), existing)
})

test('createTeacherInvitationService safely reissues expired and revoked invitations', async () => {
  for (const [email, existing] of [
    ['expired@school.org', {
      email: 'expired@school.org',
      status: 'active',
      createdAt: testTime - 5_000,
      expiresAt: testTime,
    }],
    ['revoked@school.org', {
      email: 'revoked@school.org',
      status: 'revoked',
      createdAt: testTime - 5_000,
      expiresAt: testTime + 1,
    }],
  ]) {
    const path = invitationPath(email)
    const firestore = createMockFirestore({ [path]: existing })
    const result = await createTeacherInvitationService({
      firestore,
      auth: adminAuth,
      data: { email, expiresInHours: 72 },
      ...serviceOptions,
    })

    assert.equal(result.created, true)
    assert.deepEqual(Object.keys(firestore.store.get(path)).sort(), [
      'createdAt', 'email', 'expiresAt', 'status',
    ])
    assert.equal(firestore.store.get(path).expiresAt, testTime + (72 * 60 * 60 * 1000))
  }
})

test('createTeacherInvitationService never reactivates a consumed invitation', async () => {
  const email = 'consumed@school.org'
  const path = invitationPath(email)
  const consumed = {
    email,
    status: 'consumed',
    createdAt: 'ORIGINAL',
    expiresAt: testTime + 5_000,
    consumedAt: 'CONSUMED_AT',
    consumedByUid: 'teacher-2',
  }
  const firestore = createMockFirestore({ [path]: consumed })

  await assert.rejects(
    createTeacherInvitationService({
      firestore,
      auth: adminAuth,
      data: { email },
      ...serviceOptions,
    }),
    error => error instanceof TeacherInvitationAdminError && error.code === 'failed-precondition',
  )
  assert.deepEqual(firestore.store.get(path), consumed)
})

test('invitation services deny absent, ordinary, and request-forged administrator authority before data access', async () => {
  let collectionCalls = 0
  const firestore = {
    collection() {
      collectionCalls += 1
      throw new Error('must not access Firestore')
    },
    async runTransaction() {
      throw new Error('must not transact')
    },
  }

  for (const auth of [
    null,
    { uid: 'teacher-1', token: {} },
    {
      uid: 'student-1',
      token: {
        role: 'student',
        classroomId: 'classroom-1',
        studentId: '1',
        platformAdmin: true,
      },
    },
  ]) {
    await assert.rejects(
      createTeacherInvitationService({
        firestore,
        auth,
        data: { email: 'friend@school.org', platformAdmin: true },
      }),
      error => error instanceof TeacherInvitationAdminError &&
        ['unauthenticated', 'permission-denied'].includes(error.code),
    )
  }
  assert.equal(collectionCalls, 0)
})

test('founding platform administrator UID is authorized without a custom claim', async () => {
  const firestore = createMockFirestore()
  const result = await createTeacherInvitationService({
    firestore,
    auth: { uid: FOUNDING_PLATFORM_ADMIN_UID, token: {} },
    data: { email: 'friend@school.org', expiresInHours: 48 },
    ...serviceOptions,
  })

  assert.deepEqual(result, { success: true, status: 'active', created: true })
  assert.equal(firestore.store.get(invitationPath('friend@school.org')).status, 'active')
})

test('createTeacherInvitationService rejects malformed shape, email, and expiration without writes', async () => {
  const cases = [
    null,
    [],
    { email: 'not-an-email' },
    { email: 'friend@school.org', expiresInHours: 0 },
    { email: 'friend@school.org', expiresInHours: 169 },
    { email: 'friend@school.org', expiresInHours: 1.5 },
    { email: 'friend@school.org', uid: 'forged' },
  ]

  for (const data of cases) {
    const firestore = createMockFirestore()
    await assert.rejects(
      createTeacherInvitationService({
        firestore,
        auth: adminAuth,
        data,
        ...serviceOptions,
      }),
      error => error instanceof TeacherInvitationAdminError && error.code === 'invalid-argument',
    )
    assert.equal(firestore.store.size, 0)
  }
})

test('createTeacherInvitationService fails closed on malformed or mismatched stored identity', async () => {
  const requestedEmail = 'right@school.org'
  for (const existing of [
    { status: 'active', expiresAt: testTime + 5_000 },
    { email: 'wrong@school.org', status: 'active', createdAt: testTime, expiresAt: testTime + 5_000 },
    { email: requestedEmail, status: 'unknown', createdAt: testTime, expiresAt: testTime + 5_000 },
    { email: requestedEmail, status: 'active', createdAt: testTime, expiresAt: 'not-a-time' },
    { email: requestedEmail, status: 'active', createdAt: testTime, expiresAt: testTime + 5_000, injected: true },
  ]) {
    const path = invitationPath(requestedEmail)
    const firestore = createMockFirestore({ [path]: existing })
    await assert.rejects(
      createTeacherInvitationService({
        firestore,
        auth: adminAuth,
        data: { email: requestedEmail },
        ...serviceOptions,
      }),
      error => error instanceof TeacherInvitationAdminError && error.code === 'failed-precondition',
    )
    assert.deepEqual(firestore.store.get(path), existing)
  }
})

test('revokeTeacherInvitationService is idempotent and never creates a missing document', async () => {
  const activeEmail = 'active@school.org'
  const activePath = invitationPath(activeEmail)
  const firestore = createMockFirestore({
    [activePath]: {
      email: activeEmail,
      status: 'active',
      createdAt: testTime - 5_000,
      expiresAt: testTime + 5_000,
    },
  })

  assert.deepEqual(
    await revokeTeacherInvitationService({
      firestore,
      auth: adminAuth,
      data: { email: activeEmail },
    }),
    { success: true, status: 'revoked', revoked: true },
  )
  assert.equal(firestore.store.get(activePath).status, 'revoked')

  assert.deepEqual(
    await revokeTeacherInvitationService({
      firestore,
      auth: adminAuth,
      data: { email: activeEmail },
    }),
    { success: true, status: 'revoked', revoked: false },
  )

  assert.deepEqual(
    await revokeTeacherInvitationService({
      firestore,
      auth: adminAuth,
      data: { email: 'missing@school.org' },
    }),
    { success: true, status: 'not-found', revoked: false },
  )
  assert.equal(firestore.store.has(invitationPath('missing@school.org')), false)
})

test('revokeTeacherInvitationService refuses consumed invitations without mutation', async () => {
  const email = 'used@school.org'
  const path = invitationPath(email)
  const existing = {
    email,
    status: 'consumed',
    consumedByUid: 'teacher-1',
  }
  const firestore = createMockFirestore({ [path]: existing })

  await assert.rejects(
    revokeTeacherInvitationService({ firestore, auth: adminAuth, data: { email } }),
    error => error instanceof TeacherInvitationAdminError && error.code === 'failed-precondition',
  )
  assert.deepEqual(firestore.store.get(path), existing)
})

test('callable boundary returns only fixed messages and never service details', async () => {
  const secretMessage = 'teacher@example.org and teacherInvitations/secret leaked'
  for (const [callable, serviceKey] of [
    [createTeacherInvitationCallable, 'createTeacherInvitationService'],
    [revokeTeacherInvitationCallable, 'revokeTeacherInvitationService'],
  ]) {
    await assert.rejects(
      callable(
        { auth: adminAuth, data: { email: 'teacher@example.org' } },
        {
          firestore: {},
          async [serviceKey]() {
            throw new TeacherInvitationAdminError('failed-precondition', secretMessage)
          },
        },
      ),
      error => {
        assert.ok(error instanceof HttpsError)
        assert.equal(error.code, 'failed-precondition')
        assert.equal(error.message, 'This invitation cannot be changed automatically.')
        assert.equal(error.message.includes('teacher@example.org'), false)
        assert.equal(error.details, undefined)
        return true
      },
    )
  }
})

test('callable boundary preserves successful exact service responses', async () => {
  const createResult = await createTeacherInvitationCallable(
    { auth: adminAuth, data: { email: 'friend@school.org' } },
    {
      firestore: {},
      async createTeacherInvitationService() {
        return { success: true, status: 'active', created: true }
      },
    },
  )
  assert.deepEqual(createResult, { success: true, status: 'active', created: true })

  const revokeResult = await revokeTeacherInvitationCallable(
    { auth: adminAuth, data: { email: 'friend@school.org' } },
    {
      firestore: {},
      async revokeTeacherInvitationService() {
        return { success: true, status: 'revoked', revoked: true }
      },
    },
  )
  assert.deepEqual(revokeResult, { success: true, status: 'revoked', revoked: true })
})
