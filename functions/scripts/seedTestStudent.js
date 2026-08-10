import process from 'node:process'
import { pathToFileURL } from 'node:url'

import bcrypt from 'bcryptjs'
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

import { requireFirestoreEmulatorHost } from '../phase2/emulatorEnvironment.js'
import { normalizeFirestoreDocumentId } from '../phase2/firestoreDocumentId.js'

export const SEED_TEST_STUDENT_APP_PREFIX = 'phase2a-seed-test-student-'
export const TEST_STUDENT_NAMES = Object.freeze(['Andrew Test', 'Edge Test'])
export const TEST_PIN = '1234'
export const BCRYPT_COST = 12

const VALUE_FLAGS = new Map([
  ['--project-id', 'projectId'],
  ['--teacher-uid', 'teacherUid'],
  ['--classroom-id', 'classroomId'],
])

export class SeedTestStudentError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'SeedTestStudentError'
    this.code = 'SEED_TEST_STUDENT_ERROR'
    this.category = category
    Object.assign(this, details)
  }
}

function fail(category, message, details) {
  throw new SeedTestStudentError(category, message, details)
}

function parseValue(argv, index, flag) {
  const value = argv[index + 1]

  if (
    index + 1 >= argv.length ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.startsWith('--')
  ) {
    fail('missing-value', `${flag} requires a value.`, { flag, index })
  }

  if (value.trim() !== value) {
    fail('invalid-value', `${flag} must not have surrounding whitespace.`, {
      flag,
      index: index + 1,
    })
  }

  return value
}

function requireDocumentId(value, flag, index) {
  const validation = normalizeFirestoreDocumentId(value, index)

  if (!validation.valid) {
    fail('invalid-document-id', `${flag} must be a valid Firestore document ID.`, {
      flag,
      index,
      reason: validation.rejection.category,
    })
  }

  return validation.normalizedValue
}

export function parseSeedTestStudentArguments(argv) {
  if (!Array.isArray(argv)) {
    fail('invalid-arguments', 'Arguments must be provided as an array.')
  }

  const values = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (typeof token !== 'string') {
      fail('invalid-argument', 'Every argument must be a string.', { index })
    }

    const field = VALUE_FLAGS.get(token)
    if (field === undefined) {
      if (token.startsWith('--')) {
        fail('unknown-flag', `Unknown flag: ${token}.`, { token, index })
      }
      fail('positional-argument', `Positional arguments are unsupported: ${token}.`, {
        token,
        index,
      })
    }

    if (Object.hasOwn(values, field)) {
      fail('duplicate-flag', `Duplicate flag: ${token}.`, { token, index })
    }

    const value = parseValue(argv, index, token)
    values[field] = field === 'projectId'
      ? value
      : requireDocumentId(value, token, index + 1)
    index += 1
  }

  const missingFlags = [...VALUE_FLAGS]
    .filter(([, field]) => !Object.hasOwn(values, field))
    .map(([flag]) => flag)

  if (missingFlags.length > 0) {
    fail(
      'missing-required-flag',
      `Missing required flag${missingFlags.length === 1 ? '' : 's'}: ${missingFlags.join(', ')}.`,
      { flags: missingFlags },
    )
  }

  if (values.classroomId === 'morgan') {
    fail(
      'legacy-classroom-id',
      '--classroom-id must identify a generated Version 2 classroom, not the legacy classroom.',
      { flag: '--classroom-id' },
    )
  }

  return Object.freeze({ ...values })
}

export function createSeedTestStudentFirestore(projectId, dependencies = {}) {
  requireFirestoreEmulatorHost()

  const listApps = dependencies.getApps ?? getApps
  const initialize = dependencies.initializeApp ?? initializeApp
  const createFirestore = dependencies.getFirestore ?? getFirestore
  const appName = `${SEED_TEST_STUDENT_APP_PREFIX}${projectId}`
  const existingApp = listApps().find(app => app.name === appName)
  const app = existingApp ?? initialize({ projectId }, appName)

  return Object.freeze({
    app,
    appName,
    firestore: createFirestore(app),
    ownsApp: existingApp === undefined,
  })
}

export function selectTestStudent(rosterStudents) {
  if (!Array.isArray(rosterStudents)) {
    fail('invalid-roster', 'The legacy classroom roster is missing or invalid.')
  }

  const student = TEST_STUDENT_NAMES
    .map(name => rosterStudents.find(candidate => candidate?.name === name))
    .find(Boolean)

  if (!student || !['string', 'number'].includes(typeof student.id)) {
    fail('test-student-missing', 'Andrew Test or Edge Test was not found in the roster.')
  }

  const studentId = requireDocumentId(String(student.id), 'student.id', 0)
  const loginIdSource = typeof student.loginId === 'string' && student.loginId.trim()
    ? student.loginId
    : student.name.replaceAll(' ', '-')
  const loginId = requireDocumentId(
    loginIdSource.trim().toLowerCase(),
    'student.loginId',
    0,
  )

  return Object.freeze({ studentId, loginId })
}

export async function resolveSeedTarget({ firestore, teacherUid, classroomId }) {
  requireFirestoreEmulatorHost()

  const teacherPath = `teachers/${teacherUid}`
  const classroomPath = `classrooms/${classroomId}`
  const rosterPath = 'morganBank/classroomData'
  const teacher = await firestore.doc(teacherPath).get()
  const classroom = await firestore.doc(classroomPath).get()
  const roster = await firestore.doc(rosterPath).get()

  if (!teacher.exists || teacher.data()?.uid !== teacherUid ||
      teacher.data()?.classroomId !== classroomId) {
    fail('teacher-ownership-mismatch', 'The teacher does not reference the requested classroom.')
  }

  if (!classroom.exists || classroom.data()?.ownerUid !== teacherUid) {
    fail('classroom-ownership-mismatch', 'The classroom is not owned by the requested teacher.')
  }

  if (!roster.exists) {
    fail('roster-missing', 'The legacy classroom roster does not exist.')
  }

  const selected = selectTestStudent(roster.data()?.students)
  return Object.freeze({
    ...selected,
    credentialPath: `studentCredentials/${selected.loginId}`,
  })
}

export async function seedTestStudentCredential({
  firestore,
  teacherUid,
  classroomId,
  hashPin = bcrypt.hash,
  serverTimestamp = FieldValue.serverTimestamp,
}) {
  requireFirestoreEmulatorHost()

  const target = await resolveSeedTarget({ firestore, teacherUid, classroomId })
  const pinHash = await hashPin(TEST_PIN, BCRYPT_COST)
  const credentialRef = firestore.doc(target.credentialPath)

  await firestore.runTransaction(async transaction => {
    const snapshot = await transaction.get(credentialRef)
    const existingCredential = snapshot.data()
    const timestamp = serverTimestamp()

    transaction.set(credentialRef, {
      schemaVersion: 1,
      authUid: target.loginId,
      classroomId,
      studentId: target.studentId,
      pinHash,
      active: true,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: timestamp,
      pinUpdatedAt: timestamp,
      ...(!existingCredential?.createdAt ? { createdAt: timestamp } : {}),
    }, { merge: true })
  })

  return Object.freeze({
    credentialPath: target.credentialPath,
    classroomId,
    studentId: target.studentId,
    loginId: target.loginId,
  })
}

export async function runSeedTestStudent(argv = process.argv.slice(2), dependencies = {}) {
  requireFirestoreEmulatorHost()

  const parsed = parseSeedTestStudentArguments(argv)
  const logger = dependencies.logger ?? globalThis.console
  const firestoreFactory = dependencies.firestoreFactory ?? createSeedTestStudentFirestore
  const resources = dependencies.firestore === undefined
    ? firestoreFactory(parsed.projectId)
    : Object.freeze({
      app: undefined,
      appName: undefined,
      firestore: dependencies.firestore,
      ownsApp: false,
    })

  dependencies.onResources?.(resources)

  const result = await seedTestStudentCredential({
    firestore: resources.firestore,
    teacherUid: parsed.teacherUid,
    classroomId: parsed.classroomId,
    hashPin: dependencies.hashPin,
    serverTimestamp: dependencies.serverTimestamp,
  })

  logger.log(
    `Seeded ${result.credentialPath} for classroom ${result.classroomId} ` +
    `and student ${result.studentId}.`,
  )
  return Object.freeze({ parsed, resources, result })
}

export async function closeOwnedSeedTestStudentApp(resources, dependencies = {}) {
  if (!resources?.ownsApp) {
    return false
  }

  const terminate = dependencies.terminate ??
    (firestore => firestore.terminate())
  const removeApp = dependencies.deleteApp ?? deleteApp

  try {
    await terminate(resources.firestore)
  } finally {
    await removeApp(resources.app)
  }

  return true
}

const isDirectExecution = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectExecution) {
  let ownedResources

  try {
    await runSeedTestStudent(undefined, {
      onResources(resources) {
        ownedResources = resources
      },
    })
  } catch (error) {
    const message = error instanceof SeedTestStudentError
      ? error.message
      : 'Seeder execution failed.'
    globalThis.console.error(`seedTestStudent failed: ${message}`)
    process.exitCode = 1
  } finally {
    if (ownedResources?.ownsApp) {
      try {
        await closeOwnedSeedTestStudentApp(ownedResources)
      } catch {
        globalThis.console.error('seedTestStudent cleanup failed.')
        process.exitCode = 1
      }
    }
  }
}
