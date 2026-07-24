import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { URL } from 'node:url'

import {
  FOUNDATION_VALIDATION_CATEGORIES,
  FoundationValidationError,
  LEGACY_CLASSROOM_ID,
  REQUIRED_CLASSROOM_FIELDS,
  validateTeacherClassroomFoundation,
} from './foundationValidator.js'

const TEACHER_UID = 'teacher-1'
const CLASSROOM_ID = 'generated-classroom-1'
const TEACHER_UPDATE_TIME = { seconds: 10, nanoseconds: 1 }
const CLASSROOM_UPDATE_TIME = { seconds: 11, nanoseconds: 2 }
const CREATED_AT = { seconds: 1, nanoseconds: 0 }
const UPDATED_AT = { seconds: 2, nanoseconds: 0 }
const MISSING_DOCUMENT = Symbol('missing-document')

function validTeacher(overrides = {}) {
  return {
    uid: TEACHER_UID,
    classroomId: CLASSROOM_ID,
    status: 'active',
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    displayName: 'Morgan Teacher',
    email: 'teacher@example.com',
    ...overrides,
  }
}

function validClassroom(overrides = {}) {
  return {
    ownerUid: TEACHER_UID,
    name: 'Period 1',
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    version: 1,
    settings: { currencyName: 'Class Cash' },
    ...overrides,
  }
}

function fakeSnapshot(reference, entry) {
  if (entry === MISSING_DOCUMENT) {
    return {
      exists: false,
      id: reference.id,
      ref: reference,
      data: () => undefined,
      updateTime: undefined,
    }
  }

  return {
    exists: true,
    id: reference.id,
    ref: reference,
    data: () => entry.data,
    updateTime: entry.updateTime,
  }
}

function fakeFirestore({
  teacher = validTeacher(),
  classroom = validClassroom(),
  teacherUpdateTime = TEACHER_UPDATE_TIME,
  classroomUpdateTime = CLASSROOM_UPDATE_TIME,
  readErrorPath,
} = {}) {
  const documents = new Map([
    [`teachers/${TEACHER_UID}`, teacher === MISSING_DOCUMENT
      ? MISSING_DOCUMENT
      : { data: teacher, updateTime: teacherUpdateTime }],
    [`classrooms/${CLASSROOM_ID}`, classroom === MISSING_DOCUMENT
      ? MISSING_DOCUMENT
      : { data: classroom, updateTime: classroomUpdateTime }],
  ])
  const state = {
    reads: [],
    writes: [],
  }

  function recordWrite(kind, path, data) {
    state.writes.push({ kind, path, data })
    throw new Error(`Unexpected ${kind} write to ${path}.`)
  }

  function documentReference(collectionName, id) {
    const path = `${collectionName}/${id}`
    const reference = {
      id,
      path,
      async get() {
        state.reads.push(path)

        if (path === readErrorPath) {
          throw new Error(`read failed: ${path}`)
        }

        return fakeSnapshot(
          reference,
          documents.has(path) ? documents.get(path) : MISSING_DOCUMENT,
        )
      },
      create(data) {
        return recordWrite('create', path, data)
      },
      delete() {
        return recordWrite('delete', path)
      },
      set(data) {
        return recordWrite('set', path, data)
      },
      update(data) {
        return recordWrite('update', path, data)
      },
    }

    return reference
  }

  const firestore = {
    collection(collectionName) {
      return {
        doc(id) {
          return documentReference(collectionName, id)
        },
        add(data) {
          return recordWrite('add', collectionName, data)
        },
      }
    },
    batch() {
      return recordWrite('batch', '<database>')
    },
    bulkWriter() {
      return recordWrite('bulkWriter', '<database>')
    },
    runTransaction() {
      return recordWrite('transaction', '<database>')
    },
  }

  return { firestore, state }
}

function assertReadOnly(testStore, expectedReads) {
  assert.deepEqual(testStore.state.reads, expectedReads)
  assert.deepEqual(testStore.state.writes, [])
}

async function expectBlockingError({
  testStore,
  category,
  expectedReads,
  verifyDetails,
  teacherUid = TEACHER_UID,
}) {
  await assert.rejects(
    validateTeacherClassroomFoundation({
      firestore: testStore.firestore,
      teacherUid,
    }),
    error => {
      assert.equal(error instanceof FoundationValidationError, true)
      assert.equal(error.name, 'FoundationValidationError')
      assert.equal(error.code, 'PHASE2A_FOUNDATION_VALIDATION_ERROR')
      assert.equal(error.category, category)
      assert.equal(error.blocking, true)
      assert.equal(Object.isFrozen(error.details), true)
      verifyDetails?.(error.details)
      return true
    },
  )
  assertReadOnly(testStore, expectedReads)
}

test('returns linked foundation envelopes and exact snapshot metadata', async () => {
  const teacher = validTeacher()
  const classroom = validClassroom()
  const testStore = fakeFirestore({ teacher, classroom })

  const result = await validateTeacherClassroomFoundation({
    firestore: testStore.firestore,
    teacherUid: TEACHER_UID,
  })

  assert.deepEqual(result, {
    teacherUid: TEACHER_UID,
    classroomId: CLASSROOM_ID,
    teacher: {
      id: TEACHER_UID,
      path: `teachers/${TEACHER_UID}`,
      data: teacher,
      updateTime: TEACHER_UPDATE_TIME,
    },
    classroom: {
      id: CLASSROOM_ID,
      path: `classrooms/${CLASSROOM_ID}`,
      data: classroom,
      updateTime: CLASSROOM_UPDATE_TIME,
    },
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.teacher), true)
  assert.equal(Object.isFrozen(result.classroom), true)
  assert.equal(result.teacher.data, teacher)
  assert.equal(result.classroom.data, classroom)
  assert.equal(result.teacher.updateTime, TEACHER_UPDATE_TIME)
  assert.equal(result.classroom.updateTime, CLASSROOM_UPDATE_TIME)
  assertReadOnly(testStore, [
    `teachers/${TEACHER_UID}`,
    `classrooms/${CLASSROOM_ID}`,
  ])
})

test('accepts unknown fields and preserves the exact classroom preimage', async () => {
  const teacher = validTeacher({
    futureTeacherField: { retained: true },
  })
  const classroom = validClassroom({
    lastBackupAt: null,
    futureClassroomField: { retained: true },
  })
  const testStore = fakeFirestore({ teacher, classroom })

  const result = await validateTeacherClassroomFoundation({
    firestore: testStore.firestore,
    teacherUid: TEACHER_UID,
  })

  assert.equal(result.teacher.data, teacher)
  assert.equal(result.classroom.data, classroom)
  assert.equal(Object.hasOwn(result.classroom.data, 'lastBackupAt'), true)
  assert.equal(result.classroom.data.lastBackupAt, null)
  assert.deepEqual(result.teacher.data.futureTeacherField, { retained: true })
  assert.deepEqual(result.classroom.data.futureClassroomField, {
    retained: true,
  })
  assertReadOnly(testStore, [
    `teachers/${TEACHER_UID}`,
    `classrooms/${CLASSROOM_ID}`,
  ])
})

test('rejects missing Firestore dependency and invalid teacher IDs before reads', async () => {
  await assert.rejects(
    validateTeacherClassroomFoundation({
      firestore: null,
      teacherUid: TEACHER_UID,
    }),
    /firestore with a collection method is required/,
  )

  for (const teacherUid of [
    '',
    ' teacher-1',
    'teacher-1 ',
    'teachers/teacher-1',
    '.',
    '__reserved__',
    42,
    null,
  ]) {
    const testStore = fakeFirestore()

    await expectBlockingError({
      testStore,
      teacherUid,
      category: FOUNDATION_VALIDATION_CATEGORIES.INVALID_TEACHER_UID,
      expectedReads: [],
      verifyDetails(details) {
        assert.equal(details.teacherUid, teacherUid)
      },
    })
  }
})

test('blocks when the teacher document does not exist', async () => {
  const testStore = fakeFirestore({ teacher: MISSING_DOCUMENT })

  await expectBlockingError({
    testStore,
    category: FOUNDATION_VALIDATION_CATEGORIES.TEACHER_NOT_FOUND,
    expectedReads: [`teachers/${TEACHER_UID}`],
    verifyDetails(details) {
      assert.deepEqual(details, {
        teacherUid: TEACHER_UID,
        path: `teachers/${TEACHER_UID}`,
      })
    },
  })
})

test('blocks a teacher uid field that does not equal the document ID', async () => {
  for (const actualUid of ['different-teacher', undefined, null]) {
    const teacher = validTeacher()

    if (actualUid === undefined) {
      delete teacher.uid
    } else {
      teacher.uid = actualUid
    }

    const testStore = fakeFirestore({ teacher })

    await expectBlockingError({
      testStore,
      category: FOUNDATION_VALIDATION_CATEGORIES.TEACHER_UID_MISMATCH,
      expectedReads: [`teachers/${TEACHER_UID}`],
      verifyDetails(details) {
        assert.deepEqual(details, {
          path: `teachers/${TEACHER_UID}`,
          expectedUid: TEACHER_UID,
          actualUid,
        })
      },
    })
  }
})

test('blocks every teacher status except the exact active value', async () => {
  for (const actualStatus of ['disabled', 'ACTIVE', '', null, undefined]) {
    const teacher = validTeacher()

    if (actualStatus === undefined) {
      delete teacher.status
    } else {
      teacher.status = actualStatus
    }

    const testStore = fakeFirestore({ teacher })

    await expectBlockingError({
      testStore,
      category: FOUNDATION_VALIDATION_CATEGORIES.TEACHER_NOT_ACTIVE,
      expectedReads: [`teachers/${TEACHER_UID}`],
      verifyDetails(details) {
        assert.deepEqual(details, {
          path: `teachers/${TEACHER_UID}`,
          expectedStatus: 'active',
          actualStatus,
        })
      },
    })
  }
})

test('distinguishes a missing classroomId field from an invalid value', async () => {
  const teacherWithoutClassroom = validTeacher()
  delete teacherWithoutClassroom.classroomId
  const missingStore = fakeFirestore({ teacher: teacherWithoutClassroom })

  await expectBlockingError({
    testStore: missingStore,
    category: FOUNDATION_VALIDATION_CATEGORIES.MISSING_CLASSROOM_ID,
    expectedReads: [`teachers/${TEACHER_UID}`],
    verifyDetails(details) {
      assert.deepEqual(details, {
        path: `teachers/${TEACHER_UID}`,
        field: 'classroomId',
      })
    },
  })

  for (const classroomId of [
    '',
    ' generated-classroom-1',
    'generated-classroom-1 ',
    'classrooms/generated-classroom-1',
    '.',
    '__reserved__',
    '\uD800',
    'a'.repeat(1501),
    1,
    null,
    undefined,
  ]) {
    const testStore = fakeFirestore({
      teacher: validTeacher({ classroomId }),
    })

    await expectBlockingError({
      testStore,
      category: FOUNDATION_VALIDATION_CATEGORIES.INVALID_CLASSROOM_ID,
      expectedReads: [`teachers/${TEACHER_UID}`],
      verifyDetails(details) {
        assert.equal(details.path, `teachers/${TEACHER_UID}`)
        assert.equal(details.classroomId, classroomId)
      },
    })
  }
})

test('blocks the legacy morgan literal before reading a V2 classroom', async () => {
  const testStore = fakeFirestore({
    teacher: validTeacher({ classroomId: LEGACY_CLASSROOM_ID }),
  })

  await expectBlockingError({
    testStore,
    category: FOUNDATION_VALIDATION_CATEGORIES.LEGACY_CLASSROOM_ID,
    expectedReads: [`teachers/${TEACHER_UID}`],
    verifyDetails(details) {
      assert.deepEqual(details, {
        path: `teachers/${TEACHER_UID}`,
        classroomId: LEGACY_CLASSROOM_ID,
      })
    },
  })
})

test('blocks when the referenced classroom document does not exist', async () => {
  const testStore = fakeFirestore({ classroom: MISSING_DOCUMENT })

  await expectBlockingError({
    testStore,
    category: FOUNDATION_VALIDATION_CATEGORIES.CLASSROOM_NOT_FOUND,
    expectedReads: [
      `teachers/${TEACHER_UID}`,
      `classrooms/${CLASSROOM_ID}`,
    ],
    verifyDetails(details) {
      assert.deepEqual(details, {
        classroomId: CLASSROOM_ID,
        path: `classrooms/${CLASSROOM_ID}`,
      })
    },
  })
})

test('reports every missing required classroom field before value checks', async () => {
  for (const field of REQUIRED_CLASSROOM_FIELDS) {
    const classroom = validClassroom()
    delete classroom[field]
    const testStore = fakeFirestore({ classroom })

    await expectBlockingError({
      testStore,
      category: FOUNDATION_VALIDATION_CATEGORIES.MISSING_CLASSROOM_FIELDS,
      expectedReads: [
        `teachers/${TEACHER_UID}`,
        `classrooms/${CLASSROOM_ID}`,
      ],
      verifyDetails(details) {
        assert.deepEqual(details, {
          path: `classrooms/${CLASSROOM_ID}`,
          missingFields: [field],
        })
      },
    })
  }
})

test('reports all required fields missing for a malformed classroom body', async () => {
  for (const classroom of [null, [], 'not-a-map']) {
    const testStore = fakeFirestore({ classroom })

    await expectBlockingError({
      testStore,
      category: FOUNDATION_VALIDATION_CATEGORIES.MISSING_CLASSROOM_FIELDS,
      expectedReads: [
        `teachers/${TEACHER_UID}`,
        `classrooms/${CLASSROOM_ID}`,
      ],
      verifyDetails(details) {
        assert.deepEqual(details.missingFields, REQUIRED_CLASSROOM_FIELDS)
      },
    })
  }
})

test('blocks a classroom owner mismatch', async () => {
  for (const ownerUid of ['different-teacher', '', null]) {
    const testStore = fakeFirestore({
      classroom: validClassroom({ ownerUid }),
    })

    await expectBlockingError({
      testStore,
      category: FOUNDATION_VALIDATION_CATEGORIES.CLASSROOM_OWNER_MISMATCH,
      expectedReads: [
        `teachers/${TEACHER_UID}`,
        `classrooms/${CLASSROOM_ID}`,
      ],
      verifyDetails(details) {
        assert.deepEqual(details, {
          path: `classrooms/${CLASSROOM_ID}`,
          expectedOwnerUid: TEACHER_UID,
          actualOwnerUid: ownerUid,
        })
      },
    })
  }
})

test('blocks every classroom version except exact numeric version 1', async () => {
  for (const version of [0, 2, '1', null]) {
    const testStore = fakeFirestore({
      classroom: validClassroom({ version }),
    })

    await expectBlockingError({
      testStore,
      category: FOUNDATION_VALIDATION_CATEGORIES.CLASSROOM_VERSION_MISMATCH,
      expectedReads: [
        `teachers/${TEACHER_UID}`,
        `classrooms/${CLASSROOM_ID}`,
      ],
      verifyDetails(details) {
        assert.deepEqual(details, {
          path: `classrooms/${CLASSROOM_ID}`,
          expectedVersion: 1,
          actualVersion: version,
        })
      },
    })
  }
})

test('blocks invalid values for required Phase 1 classroom fields', async () => {
  const cases = [
    ['name', '', 'must be a non-empty canonical string'],
    ['name', ' Period 1', 'must be a non-empty canonical string'],
    ['name', 'Period 1 ', 'must be a non-empty canonical string'],
    ['name', null, 'must be a non-empty canonical string'],
    ['createdAt', null, 'must be non-null'],
    ['updatedAt', null, 'must be non-null'],
    ['settings', null, 'must be a map-like object'],
    ['settings', [], 'must be a map-like object'],
    ['settings', 'not-a-map', 'must be a map-like object'],
    ['settings', new Date(0), 'must be a map-like object'],
  ]

  for (const [field, value, reason] of cases) {
    const testStore = fakeFirestore({
      classroom: validClassroom({ [field]: value }),
    })

    await expectBlockingError({
      testStore,
      category: FOUNDATION_VALIDATION_CATEGORIES.INVALID_CLASSROOM_FIELD,
      expectedReads: [
        `teachers/${TEACHER_UID}`,
        `classrooms/${CLASSROOM_ID}`,
      ],
      verifyDetails(details) {
        assert.deepEqual(details, {
          path: `classrooms/${CLASSROOM_ID}`,
          field,
          value,
          reason,
        })
      },
    })
  }
})

test('propagates Firestore read failures without continuing or writing', async () => {
  const teacherReadStore = fakeFirestore({
    readErrorPath: `teachers/${TEACHER_UID}`,
  })

  await assert.rejects(
    validateTeacherClassroomFoundation({
      firestore: teacherReadStore.firestore,
      teacherUid: TEACHER_UID,
    }),
    /read failed: teachers\/teacher-1/,
  )
  assertReadOnly(teacherReadStore, [`teachers/${TEACHER_UID}`])

  const classroomReadStore = fakeFirestore({
    readErrorPath: `classrooms/${CLASSROOM_ID}`,
  })

  await assert.rejects(
    validateTeacherClassroomFoundation({
      firestore: classroomReadStore.firestore,
      teacherUid: TEACHER_UID,
    }),
    /read failed: classrooms\/generated-classroom-1/,
  )
  assertReadOnly(classroomReadStore, [
    `teachers/${TEACHER_UID}`,
    `classrooms/${CLASSROOM_ID}`,
  ])
})

test('validator source remains independent and strictly read-only', async () => {
  const source = await readFile(
    new URL('./foundationValidator.js', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(source, /teacherClassroomProvisioner/)
  assert.doesNotMatch(source, /runTransaction/)
  assert.doesNotMatch(source, /\.create\s*\(/)
  assert.doesNotMatch(source, /\.set\s*\(/)
  assert.doesNotMatch(source, /\.update\s*\(/)
  assert.doesNotMatch(source, /\.delete\s*\(/)
  assert.doesNotMatch(source, /\.batch\s*\(/)
  assert.doesNotMatch(source, /\.bulkWriter\s*\(/)
})
