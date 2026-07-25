import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASSROOM_DOCUMENT_VERSION,
  FIRESTORE_COLLECTIONS,
  TEACHER_STATUS,
} from './firestoreSchema.js'
import {
  buildClassroomDocument,
  buildTeacherDocument,
} from './teacherClassroomModels.js'
import {
  provisionTeacherClassroom,
  TeacherClassroomFoundationError,
} from './teacherClassroomProvisioner.js'

const TIMESTAMP = { serverTimestamp: true }

function documentRef(collectionName, id) {
  return {
    collectionName,
    id,
    path: `${collectionName}/${id}`,
  }
}

function snapshot(data) {
  return {
    exists: data !== undefined,
    data: () => data,
  }
}

function testFirestore({
  teacher,
  classrooms = {},
  generatedClassroomId = 'generated-classroom',
} = {}) {
  const state = {
    creates: [],
    reads: [],
  }

  const firestore = {
    collection(collectionName) {
      return {
        doc(id = generatedClassroomId) {
          return documentRef(collectionName, id)
        },
      }
    },
    async runTransaction(callback) {
      return callback({
        async get(ref) {
          state.reads.push(ref.path)

          if (ref.collectionName === FIRESTORE_COLLECTIONS.TEACHERS) {
            return snapshot(teacher)
          }

          return snapshot(classrooms[ref.id])
        },
        create(ref, data) {
          state.creates.push({ ref, data })
        },
      })
    },
  }

  return { firestore, state }
}

test('teacher document builder returns the exact Phase 1 shape', () => {
  assert.deepEqual(buildTeacherDocument({
    uid: ' teacher-1 ',
    classroomId: ' classroom-1 ',
    displayName: ' Morgan Teacher ',
    email: ' teacher@example.com ',
    timestamp: TIMESTAMP,
  }), {
    uid: 'teacher-1',
    classroomId: 'classroom-1',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    status: TEACHER_STATUS.ACTIVE,
    displayName: 'Morgan Teacher',
    email: 'teacher@example.com',
  })
})

test('classroom document builder returns the exact Phase 1 shape', () => {
  assert.deepEqual(buildClassroomDocument({
    ownerUid: ' teacher-1 ',
    name: ' Period 1 ',
    timestamp: TIMESTAMP,
  }), {
    ownerUid: 'teacher-1',
    name: 'Period 1',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    version: CLASSROOM_DOCUMENT_VERSION,
    settings: {},
  })
})

test('classroom document builder accepts only canonical optional login codes', () => {
  assert.deepEqual(buildClassroomDocument({
    ownerUid: 'teacher-1',
    name: 'Period 1',
    timestamp: TIMESTAMP,
    studentLoginCode: '2345-6789',
  }), {
    ownerUid: 'teacher-1',
    name: 'Period 1',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    version: CLASSROOM_DOCUMENT_VERSION,
    settings: {},
    studentLoginCode: '2345-6789',
  })

  for (const studentLoginCode of [
    '',
    '23456789',
    '2345-6780',
    '2345-678O',
    ' 2345-6789 ',
    23456789,
  ]) {
    assert.throws(
      () => buildClassroomDocument({
        ownerUid: 'teacher-1',
        name: 'Period 1',
        timestamp: TIMESTAMP,
        studentLoginCode,
      }),
      /canonical XXXX-XXXX/,
    )
  }
})

test('document builders reject missing identity fields', () => {
  assert.throws(
    () => buildTeacherDocument({
      uid: '',
      classroomId: 'classroom-1',
      timestamp: TIMESTAMP,
    }),
    /uid is required/,
  )
  assert.throws(
    () => buildClassroomDocument({
      ownerUid: 'teacher-1',
      name: ' ',
      timestamp: TIMESTAMP,
    }),
    /name is required/,
  )
})

test('provisions linked teacher and classroom documents atomically', async () => {
  const testStore = testFirestore()

  const result = await provisionTeacherClassroom({
    firestore: testStore.firestore,
    uid: ' teacher-1 ',
    displayName: 'Morgan Teacher',
    email: 'teacher@example.com',
    classroomName: 'Period 1',
    timestampFactory: () => TIMESTAMP,
  })

  assert.deepEqual(result, {
    created: true,
    teacherUid: 'teacher-1',
    classroomId: 'generated-classroom',
  })
  assert.deepEqual(testStore.state.reads, ['teachers/teacher-1'])
  assert.deepEqual(testStore.state.creates, [
    {
      ref: documentRef('classrooms', 'generated-classroom'),
      data: {
        ownerUid: 'teacher-1',
        name: 'Period 1',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        version: 1,
        settings: {},
      },
    },
    {
      ref: documentRef('teachers', 'teacher-1'),
      data: {
        uid: 'teacher-1',
        classroomId: 'generated-classroom',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        status: 'active',
        displayName: 'Morgan Teacher',
        email: 'teacher@example.com',
      },
    },
  ])
})

test('rejects an invalid teacher document ID before starting a transaction', async () => {
  const testStore = testFirestore()

  await assert.rejects(
    provisionTeacherClassroom({
      firestore: testStore.firestore,
      uid: 'teachers/teacher-1',
      classroomName: 'Period 1',
      timestampFactory: () => TIMESTAMP,
    }),
    /uid must be a non-empty Firestore document ID/,
  )
  assert.deepEqual(testStore.state.reads, [])
  assert.deepEqual(testStore.state.creates, [])
})

test('returns an existing valid foundation without writing', async () => {
  const testStore = testFirestore({
    teacher: {
      uid: 'teacher-1',
      classroomId: 'classroom-1',
      status: 'active',
    },
    classrooms: {
      'classroom-1': {
        ownerUid: 'teacher-1',
        name: 'Period 1',
      },
    },
  })

  const result = await provisionTeacherClassroom({
    firestore: testStore.firestore,
    uid: 'teacher-1',
    classroomName: 'Ignored for an existing foundation',
    timestampFactory: () => TIMESTAMP,
  })

  assert.deepEqual(result, {
    created: false,
    teacherUid: 'teacher-1',
    classroomId: 'classroom-1',
  })
  assert.deepEqual(testStore.state.reads, [
    'teachers/teacher-1',
    'classrooms/classroom-1',
  ])
  assert.deepEqual(testStore.state.creates, [])
})

test('rejects an existing teacher whose classroom is missing', async () => {
  const testStore = testFirestore({
    teacher: {
      uid: 'teacher-1',
      classroomId: 'missing-classroom',
      status: 'active',
    },
  })

  await assert.rejects(
    provisionTeacherClassroom({
      firestore: testStore.firestore,
      uid: 'teacher-1',
      classroomName: 'Period 1',
      timestampFactory: () => TIMESTAMP,
    }),
    error => {
      assert.equal(error instanceof TeacherClassroomFoundationError, true)
      assert.equal(error.code, 'missing-classroom-document')
      return true
    },
  )
  assert.deepEqual(testStore.state.creates, [])
})

test('rejects an existing classroom owned by another teacher', async () => {
  const testStore = testFirestore({
    teacher: {
      uid: 'teacher-1',
      classroomId: 'classroom-1',
      status: 'active',
    },
    classrooms: {
      'classroom-1': {
        ownerUid: 'teacher-2',
        name: 'Another Class',
      },
    },
  })

  await assert.rejects(
    provisionTeacherClassroom({
      firestore: testStore.firestore,
      uid: 'teacher-1',
      classroomName: 'Period 1',
      timestampFactory: () => TIMESTAMP,
    }),
    error => {
      assert.equal(error instanceof TeacherClassroomFoundationError, true)
      assert.equal(error.code, 'classroom-owner-mismatch')
      return true
    },
  )
  assert.deepEqual(testStore.state.creates, [])
})
