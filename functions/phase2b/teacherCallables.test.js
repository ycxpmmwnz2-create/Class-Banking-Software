import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpsError } from 'firebase-functions/v2/https'

import {
  onboardTeacherClassroomCallable,
  resolveTeacherTenantCallable,
} from './teacherCallables.js'
import { TeacherOnboardingError } from './teacherOnboarding.js'

test('onboardTeacherClassroomCallable: maps successful response', async () => {
  const result = await onboardTeacherClassroomCallable(
    { auth: { uid: 'teacher-1' }, data: { classroomName: 'Math' } },
    {
      firestore: {},
      async onboardTeacherClassroomService() {
        return {
          created: true,
          teacher: { uid: 'teacher-1', status: 'active', displayName: 'Teacher', email: 't@example.com' },
          classroom: { id: 'class-1', name: 'Math', studentLoginCode: '2345-6789' },
        }
      },
    },
  )

  assert.equal(result.created, true)
  assert.equal(result.classroom.id, 'class-1')
})

test('onboardTeacherClassroomCallable: never forwards the raw service message', async () => {
  await assert.rejects(
    onboardTeacherClassroomCallable(
      { auth: { uid: 'teacher-1' }, data: { classroomName: 'Math' } },
      {
        firestore: {},
        async onboardTeacherClassroomService() {
          throw new TeacherOnboardingError('permission-denied', 'No invitation found for email.')
        },
      },
    ),
    err => {
      assert.ok(err instanceof HttpsError)
      assert.equal(err.code, 'permission-denied')
      assert.notEqual(err.message, 'No invitation found for email.')
      assert.equal(err.message, 'This account is not eligible to complete this action.')
      assert.equal(err.details, undefined)
      return true
    },
  )
})

/**
 * The plan forbids invitation-state enumeration. A caller who was never
 * invited, whose invitation was revoked, and whose invitation expired must
 * receive byte-identical client errors.
 */
test('onboardTeacherClassroomCallable: uninvited, revoked, and expired are client-indistinguishable', async () => {
  const serviceMessages = [
    'No invitation found for email.',
    'Invitation has been revoked.',
    'Invitation has expired.',
    'Invitation is not active.',
  ]

  const observed = []
  for (const message of serviceMessages) {
    await assert.rejects(
      onboardTeacherClassroomCallable(
        { auth: { uid: 'teacher-1' }, data: { classroomName: 'Math' } },
        {
          firestore: {},
          async onboardTeacherClassroomService() {
            throw new TeacherOnboardingError('permission-denied', message)
          },
        },
      ),
      err => {
        observed.push(`${err.code}|${err.message}`)
        return true
      },
    )
  }

  assert.equal(new Set(observed).size, 1, `expected one indistinguishable error, got ${[...new Set(observed)].join(' / ')}`)
})

test('onboardTeacherClassroomCallable: integrity failures leak no paths, state, or field names', async () => {
  const leakyServiceErrors = [
    ['failed-precondition', 'Existing classroom login code index mismatch.'],
    ['failed-precondition', 'Classroom owner UID mismatch.'],
    ['failed-precondition', 'Teacher document has a missing or malformed classroom ID.'],
    ['failed-precondition', 'Existing classroom has multiple login code indexes.'],
    ['invalid-argument', 'Unknown request field: ownerUid'],
    ['already-exists', 'Invitation has already been consumed.'],
  ]

  const forbiddenSubstrings = [
    'classroomLoginCodes',
    'teacherInvitations',
    'teachers/',
    'classrooms/',
    'ownerUid',
    'Invitation',
    'invitation',
    'index',
    'mismatch',
    'consumed',
  ]

  for (const [code, message] of leakyServiceErrors) {
    await assert.rejects(
      onboardTeacherClassroomCallable(
        { auth: { uid: 'teacher-1' }, data: { classroomName: 'Math' } },
        {
          firestore: {},
          async onboardTeacherClassroomService() {
            throw new TeacherOnboardingError(code, message)
          },
        },
      ),
      err => {
        assert.equal(err.code, code)
        for (const forbidden of forbiddenSubstrings) {
          assert.equal(
            err.message.includes(forbidden),
            false,
            `client message leaked "${forbidden}": ${err.message}`,
          )
        }
        return true
      },
    )
  }
})

test('mapToHttpsError: unknown error codes and non-service errors collapse to internal', async () => {
  await assert.rejects(
    onboardTeacherClassroomCallable(
      { auth: { uid: 'teacher-1' }, data: {} },
      {
        firestore: {},
        async onboardTeacherClassroomService() {
          throw new TeacherOnboardingError('not-a-real-code', 'teacher@example.com leaked')
        },
      },
    ),
    err => {
      assert.equal(err.code, 'internal')
      assert.equal(err.message, 'An unexpected internal error occurred.')
      return true
    },
  )

  await assert.rejects(
    onboardTeacherClassroomCallable(
      { auth: { uid: 'teacher-1' }, data: {} },
      {
        firestore: {},
        async onboardTeacherClassroomService() {
          throw new Error('bcrypt hash $2b$10$abcdef and PIN 1234')
        },
      },
    ),
    err => {
      assert.equal(err.code, 'internal')
      assert.equal(err.message, 'An unexpected internal error occurred.')
      return true
    },
  )
})

test('resolveTeacherTenantCallable: integrity failure message is generic', async () => {
  await assert.rejects(
    resolveTeacherTenantCallable(
      { auth: { uid: 'teacher-1' }, data: {} },
      {
        firestore: {},
        async resolveTeacherTenantService() {
          throw new TeacherOnboardingError(
            'failed-precondition',
            'Teacher foundation records are inconsistent.',
          )
        },
      },
    ),
    err => {
      assert.equal(err.code, 'failed-precondition')
      assert.equal(
        err.message,
        'This account cannot be set up automatically. Contact your administrator for assistance.',
      )
      return true
    },
  )
})

test('resolveTeacherTenantCallable: maps successful response', async () => {
  const result = await resolveTeacherTenantCallable(
    { auth: { uid: 'teacher-1' }, data: {} },
    {
      firestore: {},
      async resolveTeacherTenantService() {
        return {
          state: 'active',
          teacher: { uid: 'teacher-1', displayName: 'Teacher', email: 't@example.com' },
          classroom: { id: 'class-1', name: 'Math', studentLoginCode: '2345-6789' },
        }
      },
    },
  )

  assert.equal(result.state, 'active')
  assert.equal(result.classroom.studentLoginCode, '2345-6789')
})

test('resolveTeacherTenantCallable: maps unauthenticated error cleanly', async () => {
  await assert.rejects(
    resolveTeacherTenantCallable(
      { auth: null, data: {} },
      {
        firestore: {},
        async resolveTeacherTenantService() {
          throw new TeacherOnboardingError('unauthenticated', 'Authentication required.')
        },
      },
    ),
    err => {
      assert.ok(err instanceof HttpsError)
      assert.equal(err.code, 'unauthenticated')
      assert.equal(err.message, 'Sign in required.')
      return true
    },
  )
})
