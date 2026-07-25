import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { deleteApp, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

import { requireFirestoreEmulatorHost } from '../phase2/emulatorEnvironment.js'
import { normalizeFirestoreDocumentId } from '../phase2/firestoreDocumentId.js'

export const CHECK_STUDENT_APP_PREFIX = 'phase2a-check-student-'
export const CHECK_STUDENT_CREDENTIAL_ID = 'edge-test'

const VALUE_FLAGS = new Map([
  ['--project-id', 'projectId'],
  ['--teacher-uid', 'teacherUid'],
  ['--classroom-id', 'classroomId'],
])

export class CheckStudentArgumentError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'CheckStudentArgumentError'
    this.code = 'CHECK_STUDENT_ARGUMENT_ERROR'
    this.category = category
    Object.assign(this, details)
  }
}

function failArgument(category, message, details) {
  throw new CheckStudentArgumentError(category, message, details)
}

function parseCanonicalValue(argv, index, flag) {
  const valueIndex = index + 1
  const value = argv[valueIndex]

  if (
    valueIndex >= argv.length ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.startsWith('--')
  ) {
    failArgument('missing-value', `${flag} requires a value.`, { flag, index })
  }

  if (value.trim() !== value) {
    failArgument(
      'invalid-value',
      `${flag} must not have leading or trailing whitespace.`,
      { flag, index: valueIndex },
    )
  }

  return value
}

function requireDocumentId(value, flag, index) {
  const result = normalizeFirestoreDocumentId(value, index)

  if (!result.valid) {
    failArgument(
      'invalid-document-id',
      `${flag} must be a valid Firestore document ID.`,
      { flag, index, reason: result.rejection.category },
    )
  }

  return result.normalizedValue
}

export function parseCheckStudentArguments(argv) {
  if (!Array.isArray(argv)) {
    failArgument('invalid-arguments', 'Arguments must be provided as an array.')
  }

  const values = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (typeof token !== 'string') {
      failArgument('invalid-argument', 'Every argument must be a string.', { index })
    }

    const field = VALUE_FLAGS.get(token)
    if (field === undefined) {
      if (token.startsWith('--')) {
        failArgument('unknown-flag', `Unknown flag: ${token}.`, { index, token })
      }

      failArgument(
        'positional-argument',
        `Positional arguments are not supported: ${token}.`,
        { index, token },
      )
    }

    if (Object.hasOwn(values, field)) {
      failArgument('duplicate-flag', `Duplicate flag: ${token}.`, { index, token })
    }

    const value = parseCanonicalValue(argv, index, token)
    values[field] = field === 'projectId'
      ? value
      : requireDocumentId(value, token, index + 1)
    index += 1
  }

  const missingFlags = [...VALUE_FLAGS]
    .filter(([, field]) => !Object.hasOwn(values, field))
    .map(([flag]) => flag)

  if (missingFlags.length > 0) {
    failArgument(
      'missing-required-flag',
      `Missing required flag${missingFlags.length === 1 ? '' : 's'}: ${missingFlags.join(', ')}.`,
      { flags: missingFlags },
    )
  }

  return Object.freeze({ ...values })
}

export function createCheckStudentFirestore(projectId, dependencies = {}) {
  requireFirestoreEmulatorHost()

  const listApps = dependencies.getApps ?? getApps
  const initialize = dependencies.initializeApp ?? initializeApp
  const createFirestore = dependencies.getFirestore ?? getFirestore
  const appName = `${CHECK_STUDENT_APP_PREFIX}${projectId}`
  const existingApp = listApps().find(app => app.name === appName)
  const app = existingApp ?? initialize({ projectId }, appName)

  return Object.freeze({
    app,
    appName,
    firestore: createFirestore(app),
    ownsApp: existingApp === undefined,
  })
}

function summarizeTeacher(snapshot, teacherUid, classroomId) {
  const data = snapshot.exists ? snapshot.data() : undefined

  return Object.freeze({
    path: `teachers/${teacherUid}`,
    exists: snapshot.exists,
    uidMatches: snapshot.exists && data?.uid === teacherUid,
    classroomIdMatches: snapshot.exists && data?.classroomId === classroomId,
  })
}

function summarizeClassroom(snapshot, teacherUid, classroomId) {
  const data = snapshot.exists ? snapshot.data() : undefined

  return Object.freeze({
    path: `classrooms/${classroomId}`,
    exists: snapshot.exists,
    ownerUidMatches: snapshot.exists && data?.ownerUid === teacherUid,
  })
}

function summarizeCredential(snapshot, classroomId) {
  const data = snapshot.exists ? snapshot.data() : undefined

  return Object.freeze({
    path: `studentCredentials/${CHECK_STUDENT_CREDENTIAL_ID}`,
    exists: snapshot.exists,
    classroomIdMatches: snapshot.exists && data?.classroomId === classroomId,
    studentId: snapshot.exists && typeof data?.studentId === 'string'
      ? data.studentId
      : null,
    active: snapshot.exists && typeof data?.active === 'boolean'
      ? data.active
      : null,
  })
}

export async function readAndReportCheckStudent({
  firestore,
  teacherUid,
  classroomId,
  logger,
}) {
  requireFirestoreEmulatorHost()

  const teacherPath = `teachers/${teacherUid}`
  const classroomPath = `classrooms/${classroomId}`
  const credentialPath = `studentCredentials/${CHECK_STUDENT_CREDENTIAL_ID}`
  const teacher = await firestore.doc(teacherPath).get()
  const classroom = await firestore.doc(classroomPath).get()
  const credential = await firestore.doc(credentialPath).get()
  const report = Object.freeze({
    teacher: summarizeTeacher(teacher, teacherUid, classroomId),
    classroom: summarizeClassroom(classroom, teacherUid, classroomId),
    credential: summarizeCredential(credential, classroomId),
  })

  logger.log(JSON.stringify(report, null, 2))
  return report
}

export async function runCheckStudent(argv = process.argv.slice(2), dependencies = {}) {
  requireFirestoreEmulatorHost()

  const parsed = parseCheckStudentArguments(argv)
  const logger = dependencies.logger ?? globalThis.console
  const firestoreFactory = dependencies.firestoreFactory ?? createCheckStudentFirestore
  const resources = dependencies.firestore === undefined
    ? firestoreFactory(parsed.projectId)
    : Object.freeze({
      app: undefined,
      appName: undefined,
      firestore: dependencies.firestore,
      ownsApp: false,
    })

  dependencies.onResources?.(resources)

  const report = await readAndReportCheckStudent({
    firestore: resources.firestore,
    teacherUid: parsed.teacherUid,
    classroomId: parsed.classroomId,
    logger,
  })

  return Object.freeze({ parsed, resources, report })
}

export async function closeOwnedCheckStudentApp(resources, dependencies = {}) {
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
    await runCheckStudent(undefined, {
      onResources(resources) {
        ownedResources = resources
      },
    })
  } catch (error) {
    const message = error instanceof CheckStudentArgumentError
      ? error.message
      : 'Diagnostic execution failed.'
    globalThis.console.error(`checkStudent failed: ${message}`)
    process.exitCode = 1
  } finally {
    if (ownedResources?.ownsApp) {
      try {
        await closeOwnedCheckStudentApp(ownedResources)
      } catch {
        globalThis.console.error('checkStudent cleanup failed.')
        process.exitCode = 1
      }
    }
  }
}
