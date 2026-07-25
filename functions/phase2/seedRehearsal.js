// Phase 2A Item 9 — emulator-only rehearsal SETUP helper.
//
// This module is an explicitly isolated exception to the migration-runtime
// read-only boundary: it writes the synthetic legacy fixture and calls the
// Phase 1 provisioner, but it does so strictly BEFORE the migration runtime
// starts. It is never imported by `migrateClassroomData.js`, `batchWriter.js`,
// or anything they invoke, and it never runs concurrently with planning or
// writing. `batchWriter.js` remains the only migration-runtime module that
// writes migration destinations.
//
// Safety rules enforced here:
//   * `FIRESTORE_EMULATOR_HOST` must be present and valid.
//   * The project ID must be supplied explicitly, must not be a production
//     project ID, and must carry a disposable marker.
//   * Only the Firebase Admin SDK is used (never the client SDK, never
//     `@firebase/rules-unit-testing`).
//   * Admin app names are distinct from the ones `run.js` creates.
//   * Nothing is ever deleted, and no credential body or secret material is
//     ever logged.

import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { deleteApp, getApps, initializeApp } from 'firebase-admin/app'
import { Timestamp, getFirestore } from 'firebase-admin/firestore'

import { requireFirestoreEmulatorHost } from './emulatorEnvironment.js'
import { provisionTeacherClassroom } from '../phase1/teacherClassroomProvisioner.js'
import {
  LEGACY_AUTH_LOGS_COLLECTION,
  LEGACY_CREDENTIALS_COLLECTION,
  buildRehearsalFixture,
} from './rehearsalFixture.js'

// Re-exported so the repository-root rehearsal suite can build and inspect
// real Firestore values without adding `firebase-admin` to the root package.
// The production modules resolve it from `functions/node_modules`; so does
// this module, because it lives beside them.
export { Timestamp }

export const REHEARSAL_SEED_APP_PREFIX = 'phase2a-rehearsal-seed-'
export const CLI_APP_PREFIX = 'phase2a-cli-'

/** Project IDs that must never be seeded, under any circumstances. */
export const PROHIBITED_PROJECT_IDS = Object.freeze(['morgan-bank'])

/**
 * A disposable project ID must announce itself. This is belt-and-braces on
 * top of the emulator-host guard: even a misconfigured environment cannot aim
 * the seeder at a project that does not look throwaway.
 */
export const DISPOSABLE_PROJECT_ID_MARKERS = Object.freeze([
  'rehearsal',
  'emulator',
  'test',
  'demo',
  'local',
  'fake',
  'scratch',
])

export const REHEARSAL_SEED_ERROR_CATEGORIES = Object.freeze({
  ALREADY_SEEDED: 'already-seeded',
  INVALID_ARGUMENTS: 'invalid-arguments',
  PROHIBITED_PROJECT_ID: 'prohibited-project-id',
  NON_DISPOSABLE_PROJECT_ID: 'non-disposable-project-id',
})

export class RehearsalSeedError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'RehearsalSeedError'
    this.code = 'PHASE2A_REHEARSAL_SEED_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new RehearsalSeedError(category, message, details)
}

function requireCanonicalString(value, label) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.trim() !== value) {
    fail(
      REHEARSAL_SEED_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      `${label} must be a non-empty canonical string.`,
      { field: label },
    )
  }

  return value
}

/**
 * Validates that a project ID is explicit, non-production, and disposable.
 * There is deliberately no default value.
 */
export function requireDisposableProjectId(projectId) {
  const value = requireCanonicalString(projectId, 'projectId')
  const normalized = value.toLowerCase()

  if (PROHIBITED_PROJECT_IDS.includes(normalized)) {
    fail(
      REHEARSAL_SEED_ERROR_CATEGORIES.PROHIBITED_PROJECT_ID,
      'The rehearsal seeder refuses to run against a production project ID.',
      { projectId: value },
    )
  }

  if (!DISPOSABLE_PROJECT_ID_MARKERS.some(marker =>
    normalized.includes(marker),
  )) {
    fail(
      REHEARSAL_SEED_ERROR_CATEGORIES.NON_DISPOSABLE_PROJECT_ID,
      'The rehearsal project ID must identify itself as disposable ' +
        `(one of: ${DISPOSABLE_PROJECT_ID_MARKERS.join(', ')}).`,
      { projectId: value },
    )
  }

  return value
}

/**
 * Creates (or reuses) an Admin app dedicated to rehearsal setup.
 *
 * The app name is deliberately distinct from the `phase2a-cli-*` names
 * `run.js` uses, so the seeder and the migration CLI never collide when both
 * run inside one Node process.
 */
export function createRehearsalFirestore({ projectId }) {
  requireFirestoreEmulatorHost()
  const disposableProjectId = requireDisposableProjectId(projectId)
  const appName = `${REHEARSAL_SEED_APP_PREFIX}${disposableProjectId}`
  const app = getApps().find(existing => existing.name === appName) ??
    initializeApp({ projectId: disposableProjectId }, appName)

  return { app, appName, firestore: getFirestore(app) }
}

/**
 * Releases every Admin app this process created for the rehearsal — both the
 * seeder's apps and the ones `run.js` created — so `node --test` can exit.
 * Nothing in Firestore is deleted.
 */
export async function closeRehearsalAdminApps() {
  const closed = []

  for (const app of [...getApps()]) {
    if (!app.name.startsWith(REHEARSAL_SEED_APP_PREFIX) &&
        !app.name.startsWith(CLI_APP_PREFIX)) {
      continue
    }

    try {
      await getFirestore(app).terminate()
    } catch {
      // A never-used client has nothing to terminate.
    }

    try {
      await deleteApp(app)
      closed.push(app.name)
    } catch {
      // Already released.
    }
  }

  return closed
}

async function assertNotAlreadySeeded(firestore, fixture) {
  const existing = await firestore.doc(fixture.classroomData.path).get()

  if (existing.exists) {
    fail(
      REHEARSAL_SEED_ERROR_CATEGORIES.ALREADY_SEEDED,
      'The legacy source fixture already exists in this emulator project; ' +
        'use a fresh disposable project ID instead of overwriting it.',
      { path: fixture.classroomData.path },
    )
  }
}

/**
 * Writes the synthetic legacy source fixture. Uses `create()` throughout so a
 * second seed of the same project fails loudly rather than overwriting.
 */
export async function seedRehearsalSource({ firestore, fixture }) {
  await assertNotAlreadySeeded(firestore, fixture)

  await firestore
    .doc(fixture.classroomData.path)
    .create(fixture.classroomData.data)

  for (const entry of fixture.studentCredentials) {
    await firestore
      .collection(LEGACY_CREDENTIALS_COLLECTION)
      .doc(entry.id)
      .create(entry.data)
  }

  for (const entry of fixture.studentAuthLogs) {
    await firestore
      .collection(LEGACY_AUTH_LOGS_COLLECTION)
      .doc(entry.id)
      .create(entry.data)
  }

  return Object.freeze({
    classroomDataPath: fixture.classroomData.path,
    credentialCount: fixture.studentCredentials.length,
    authLogCount: fixture.studentAuthLogs.length,
  })
}

/**
 * Creates the Phase 1 teacher/classroom foundation using the real Phase 1
 * provisioner. `foundationValidator.js` deliberately never imports this
 * provisioner; the rehearsal seeder is the only caller.
 */
export async function provisionRehearsalFoundation({
  firestore,
  teacherUid,
  displayName = 'Rehearsal Teacher',
  email = 'rehearsal-teacher@example.invalid',
  classroomName = 'Rehearsal Classroom',
}) {
  requireCanonicalString(teacherUid, 'teacherUid')

  return provisionTeacherClassroom({
    firestore,
    uid: teacherUid,
    displayName,
    email,
    classroomName,
  })
}

/**
 * One-call rehearsal setup: fixture writes first, then the Phase 1
 * foundation. Both complete before any migration planning begins.
 */
export async function seedRehearsal({
  projectId,
  teacherUid,
  fixture = buildRehearsalFixture(),
  classroomName = 'Rehearsal Classroom',
}) {
  const { app, appName, firestore } = createRehearsalFirestore({ projectId })
  const source = await seedRehearsalSource({ firestore, fixture })
  const foundation = await provisionRehearsalFoundation({
    firestore,
    teacherUid,
    classroomName,
  })

  return Object.freeze({
    app,
    appName,
    firestore,
    fixture,
    projectId,
    teacherUid,
    classroomId: foundation.classroomId,
    source,
  })
}

const SUPPORTED_SEED_FLAGS = new Map([
  ['--project-id', 'projectId'],
  ['--teacher-uid', 'teacherUid'],
])

/** Argument parsing for direct script execution. No path overrides exist. */
export function parseSeedArguments(argv) {
  if (!Array.isArray(argv)) {
    fail(
      REHEARSAL_SEED_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      'Seed arguments must be provided as an array.',
    )
  }

  const values = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const field = typeof token === 'string'
      ? SUPPORTED_SEED_FLAGS.get(token)
      : undefined

    if (field === undefined) {
      fail(
        REHEARSAL_SEED_ERROR_CATEGORIES.INVALID_ARGUMENTS,
        `Unsupported rehearsal seed argument: ${String(token)}.`,
        { index },
      )
    }

    if (Object.hasOwn(values, field)) {
      fail(
        REHEARSAL_SEED_ERROR_CATEGORIES.INVALID_ARGUMENTS,
        `Duplicate flag: ${token}.`,
        { index },
      )
    }

    const value = requireCanonicalString(argv[index + 1], token)
    if (value.startsWith('--')) {
      fail(
        REHEARSAL_SEED_ERROR_CATEGORIES.INVALID_ARGUMENTS,
        `${token} requires a value.`,
        { flag: token, index },
      )
    }

    values[field] = value
    index += 1
  }

  for (const [flag, field] of SUPPORTED_SEED_FLAGS) {
    if (!Object.hasOwn(values, field)) {
      fail(
        REHEARSAL_SEED_ERROR_CATEGORIES.INVALID_ARGUMENTS,
        `Missing required flag: ${flag}.`,
        { flag },
      )
    }
  }

  return Object.freeze({ ...values })
}

const isDirectExecution = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectExecution) {
  const parsed = parseSeedArguments(process.argv.slice(2))
  const seeded = await seedRehearsal(parsed)

  // Counts and identifiers only — never credential bodies or secrets.
  globalThis.console.log(
    `Seeded rehearsal project ${seeded.projectId}: ` +
    `${seeded.source.credentialCount} credentials, ` +
    `${seeded.source.authLogCount} auth logs, ` +
    `classroomId ${seeded.classroomId}.`,
  )
  await closeRehearsalAdminApps()
}
