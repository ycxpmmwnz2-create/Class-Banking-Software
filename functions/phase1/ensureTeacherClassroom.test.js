import assert from 'node:assert/strict'
import test from 'node:test'

import { ensureTeacherClassroomForCaller } from './ensureTeacherClassroom.js'

const TEACHER_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'

function request(overrides = {}) {
  return {
    auth: {
      uid: TEACHER_UID,
      token: { name: 'Mr. Morgan', email: 'teacher@example.com' },
    },
    ...overrides,
  }
}

async function assertHttpsError(promise, expectedCode) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, expectedCode)
    return true
  })
}

test('requires an authenticated caller', async () => {
  await assertHttpsError(
    ensureTeacherClassroomForCaller(request({ auth: undefined })),
    'unauthenticated',
  )
})

test('rejects a caller who is not the authorized teacher', async () => {
  await assertHttpsError(
    ensureTeacherClassroomForCaller(request({
      auth: { uid: 'some-other-uid', token: {} },
    })),
    'permission-denied',
  )
})

test('delegates to the injected provisioner with the caller uid and profile fields', async () => {
  const calls = []
  const fakeFirestore = { marker: 'fake-firestore' }

  const result = await ensureTeacherClassroomForCaller(request(), {
    firestore: fakeFirestore,
    async provisionTeacherClassroom(args) {
      calls.push(args)
      return { created: false, teacherUid: args.uid, classroomId: 'classroom-1' }
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].firestore, fakeFirestore)
  assert.equal(calls[0].uid, TEACHER_UID)
  assert.equal(calls[0].displayName, 'Mr. Morgan')
  assert.equal(calls[0].email, 'teacher@example.com')
  assert.equal(typeof calls[0].classroomName, 'string')
  assert.ok(calls[0].classroomName.length > 0)
  assert.deepEqual(result, {
    created: false,
    teacherUid: TEACHER_UID,
    classroomId: 'classroom-1',
  })
})

test('defaults displayName/email to empty strings when token claims are absent', async () => {
  const calls = []

  await ensureTeacherClassroomForCaller(
    request({ auth: { uid: TEACHER_UID, token: {} } }),
    {
      firestore: {},
      async provisionTeacherClassroom(args) {
        calls.push(args)
        return { created: true, teacherUid: args.uid, classroomId: 'classroom-2' }
      },
    },
  )

  assert.equal(calls[0].displayName, '')
  assert.equal(calls[0].email, '')
})
