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

test('onboardTeacherClassroomCallable: maps TeacherOnboardingError to HttpsError with generic message', async () => {
  await assert.rejects(
    onboardTeacherClassroomCallable(
      { auth: { uid: 'teacher-1' }, data: { classroomName: 'Math' } },
      {
        firestore: {},
        async onboardTeacherClassroomService() {
          throw new TeacherOnboardingError('permission-denied', 'No invitation found.')
        },
      },
    ),
    err => {
      assert.ok(err instanceof HttpsError)
      assert.equal(err.code, 'permission-denied')
      assert.equal(err.message, 'No invitation found.')
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
      assert.equal(err.message, 'Authentication required.')
      return true
    },
  )
})
