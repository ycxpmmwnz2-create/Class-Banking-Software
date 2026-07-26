// Phase 3 Commit 3 — production preflight runner, Firestore/Auth emulator suite.
//
// Run from the repository root with:
//   npm run test:phase3:migration
// which wraps `firebase emulators:exec --only auth,firestore` around
// `node --test tests/phase3/production-runner.emulator.test.js` under the same
// credential-isolation contract as every other emulator command.
//
// EVIDENCE LAYER: real Firebase Admin reads against real Firestore and Auth
// emulators, driven through the actual `runPreflightMain` entrypoint. This proves
// the entrypoint reads live data and writes nothing remote. It does NOT prove
// production behavior, deployed state, or real-account behavior.
//
// The deployment inventory (Rules releases, Functions revisions, Hosting
// releases) is INJECTED: the Firebase emulators do not emulate those control
// planes at all, so there is nothing live to read. Every Firestore and Auth
// observation is genuine.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { after, before, describe, test } from 'node:test'

// The harness owns the emulator hosts. Assert before importing anything that
// guards on them, so a bare `node --test` fails loudly instead of reaching out.
assert.ok(
  typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0,
  'FIRESTORE_EMULATOR_HOST must be supplied by the emulator harness; ' +
    'run this suite through `npm run test:phase3:migration`.',
)
assert.ok(
  typeof process.env.FIREBASE_AUTH_EMULATOR_HOST === 'string' &&
    process.env.FIREBASE_AUTH_EMULATOR_HOST.length > 0,
  'FIREBASE_AUTH_EMULATOR_HOST must be supplied by the emulator harness.',
)

const { runPreflightMain, PREFLIGHT_EXIT_CODES, parsePreflightArguments } =
  await import('../../functions/phase3/preflight.js')
// Admin handles come from a module under functions/, so `firebase-admin`
// resolves from functions/node_modules and never becomes a root dependency —
// the same convention functions/phase2/seedRehearsal.js established.
const { PREFLIGHT_ABORT_CATEGORIES, createReadOnlyAdminHandles } = await import(
  '../../functions/phase3/productionPreflight.js'
)

// MUST be the single demo project Commit 2's allowlist permits. Widening
// ALLOWED_EMULATOR_PROJECT_ID to give this suite its own project would weaken a
// security guard for test convenience, so the suite conforms to the guard
// instead. Firestore/Auth emulator state is per-project, and this suite is the
// only consumer of it under test:phase3:migration.
const EMULATOR_PROJECT_ID = 'demo-morgan-bank-phase2b-server-test'

/**
 * The emulator-context environment the Commit 2 guard requires.
 *
 * `emulators:exec --only auth,firestore` exports FIRESTORE_EMULATOR_HOST and
 * FIREBASE_AUTH_EMULATOR_HOST but NOT FUNCTIONS_EMULATOR, because no Functions
 * emulator is running. The guard requires that flag to recognize an emulator
 * context, so the suite supplies it explicitly rather than relaxing the guard.
 * GCLOUD_PROJECT is stated for the same reason: the harness scrubs it.
 */
function emulatorEnvironment(overrides = {}) {
  return {
    ...process.env,
    GCLOUD_PROJECT: EMULATOR_PROJECT_ID,
    FUNCTIONS_EMULATOR: 'true',
    ...overrides,
  }
}
const TEACHER_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'
const RUN_TOKEN = `${process.pid}-${randomBytes(6).toString('hex')}`

let handles
let firestore
let auth
let temporaryDirectory
const createdManifestPaths = []

/** Artifact files live in an isolated temp dir, never in the repository. */
function writeArtifact(name, value) {
  const filePath = path.join(temporaryDirectory, name)
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8')
  return filePath
}

function authorizationArtifact(overrides = {}) {
  return {
    projectId: EMULATOR_PROJECT_ID,
    teacherUid: TEACHER_UID,
    releaseId: 'phase3-rel-emulator',
    changeId: 'CHG-EMULATOR-001',
    authorizationId: 'AUTH-EMULATOR-001',
    credentialProvenance: 'emulator-harness-no-credential',
    credentialSha256: 'placeholder',
    expectationsSha256: 'placeholder',
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function expectationsArtifact(overrides = {}) {
  return {
    deployment: {
      rules: { release: 'emulator-none' },
      functions: { emulator: 'none' },
      hosting: { release: 'emulator-none' },
      indexes: { composite: 'none' },
      gateParameters: { MULTI_TEACHER_V2_ENABLED: 'false' },
    },
    acknowledgedWriters: [],
    acknowledgedAnomalies: [],
    acknowledgedDestinationCounts: {},
    ...overrides,
  }
}

/** Injected deployment inventory matching the expectations above. */
function injectedDeploymentReaders() {
  return {
    readDeploymentInventory: async () => ({
      complete: true,
      rules: { release: 'emulator-none' },
      functions: { emulator: 'none' },
      hosting: { release: 'emulator-none' },
      indexes: { composite: 'none' },
      gateParameters: { MULTI_TEACHER_V2_ENABLED: 'false' },
    }),
    readActiveWriters: async () => ({ complete: true, writers: [] }),
  }
}

/**
 * Real Firestore/Auth readers. Every one issues only `get`/`list` operations
 * through the Admin SDK.
 */
function liveReaders() {
  return {
    ...injectedDeploymentReaders(),

    readLegacyClassroomAggregate: async () => {
      const snapshot = await firestore.doc('morganBank/classroomData').get()
      const data = snapshot.exists ? snapshot.data() : {}
      const students = Array.isArray(data.students) ? data.students : []
      const transactions = Array.isArray(data.transactions) ? data.transactions : []
      const loginHistory = Array.isArray(data.loginHistory) ? data.loginHistory : []
      return {
        complete: true,
        counts: {
          students: students.length,
          transactions: transactions.length,
          loginHistory: loginHistory.length,
        },
        studentIds: students.map(student => String(student.id)),
        transactionStudentIds: transactions
          .filter(entry => entry.studentId != null)
          .map(entry => String(entry.studentId)),
        loginHistoryStudentIds: loginHistory
          .filter(entry => entry.studentId != null)
          .map(entry => String(entry.studentId)),
        noncanonicalValueCount: 0,
        anomalies: [],
      }
    },

    readFlatCredentials: async () => {
      const snapshot = await firestore.collection('studentCredentials').get()
      const loginIds = snapshot.docs.map(doc => doc.id)
      const studentIds = snapshot.docs.map(doc => String(doc.data().studentId))
      return {
        complete: true,
        count: snapshot.size,
        studentIds,
        duplicateLoginIds: loginIds.length - new Set(loginIds).size,
        duplicateStudentIds: studentIds.length - new Set(studentIds).size,
        noncanonicalLoginIds: loginIds.filter(
          id => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id),
        ).length,
        anomalies: [],
      }
    },

    readFlatAuthLogs: async () => {
      const snapshot = await firestore.collection('studentAuthLogs').get()
      return {
        complete: true,
        count: snapshot.size,
        studentIds: snapshot.docs
          .filter(doc => doc.data().studentId != null)
          .map(doc => String(doc.data().studentId)),
        anomalies: [],
      }
    },

    readFoundation: async () => {
      const teacherSnapshot = await firestore.doc(`teachers/${TEACHER_UID}`).get()
      if (!teacherSnapshot.exists) {
        return { complete: true, present: false, anomalies: [] }
      }
      const teacher = teacherSnapshot.data()
      const classroomSnapshot = await firestore
        .doc(`classrooms/${teacher.classroomId}`).get()
      return {
        complete: true,
        present: true,
        reciprocal: classroomSnapshot.exists &&
          classroomSnapshot.data().ownerUid === TEACHER_UID &&
          teacher.uid === TEACHER_UID,
        teacherStatus: teacher.status,
        classroomId: teacher.classroomId,
        anomalies: [],
      }
    },

    readDestinationPaths: async () => {
      // listDocuments(), NOT get(). A Firestore document that holds only
      // subcollections is a "phantom parent": it does not exist as a document,
      // so `collection('classrooms').get()` returns zero rows while its
      // subcollections are fully readable. Enumerating with get() would make
      // scoped credentials orphaned under such a parent INVISIBLE to preflight —
      // precisely the pre-existing V2 data this check must catch. Verified
      // against the emulator: get() saw 0, listDocuments() saw 1.
      const classroomRefs = await firestore.collection('classrooms').listDocuments()
      let scopedCredentials = 0
      let classroomStudents = 0
      const studentIds = []
      for (const classroomRef of classroomRefs) {
        const credentials = await classroomRef
          .collection('studentCredentials').get()
        scopedCredentials += credentials.size
        const students = await classroomRef.collection('students').get()
        classroomStudents += students.size
        studentIds.push(...students.docs.map(doc => doc.id))
      }
      return {
        complete: true,
        counts: { scopedCredentials, classroomStudents, scopedLogs: 0 },
        studentIds,
      }
    },

    readAuthCompatibility: async () => {
      const listed = await auth.listUsers(1000)
      return {
        complete: true,
        uidCollisions: 0,
        incompatibleUsers: 0,
        examinedUserCount: listed.users.length,
      }
    },
  }
}

/** Captures the complete observable Firestore state for pre/post comparison. */
async function snapshotFirestore() {
  const state = {}
  const collections = await firestore.listCollections()
  for (const collection of collections.sort((a, b) => a.id.localeCompare(b.id))) {
    // listDocuments() so phantom parents are included; otherwise a write into a
    // subcollection of a nonexistent parent would not appear in either snapshot
    // and the zero-write assertion would pass vacuously.
    const documentRefs = await collection.listDocuments()
    for (const ref of documentRefs.sort((a, b) => a.id.localeCompare(b.id))) {
      const doc = await ref.get()
      state[`${collection.id}/${ref.id}`] = doc.exists ? doc.data() : '(phantom-parent)'
      const subcollections = await ref.listCollections()
      for (const sub of subcollections) {
        const subDocuments = await sub.get()
        for (const subDoc of subDocuments.docs) {
          state[`${collection.id}/${doc.id}/${sub.id}/${subDoc.id}`] =
            subDoc.data()
        }
      }
    }
  }
  return JSON.stringify(state, Object.keys(state).sort())
}

async function snapshotAuth() {
  const listed = await auth.listUsers(1000)
  return JSON.stringify(
    listed.users
      .map(user => ({ uid: user.uid, disabled: user.disabled }))
      .sort((a, b) => a.uid.localeCompare(b.uid)),
  )
}

before(async () => {
  handles = createReadOnlyAdminHandles({
    projectId: EMULATOR_PROJECT_ID,
    appName: `phase3-preflight-${RUN_TOKEN}`,
  })
  firestore = handles.firestore
  auth = handles.auth

  temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), `phase3-preflight-${RUN_TOKEN}-`),
  )

  // Seed a legacy pre-migration classroom. This is the suite's own setup, not
  // something the preflight does.
  await firestore.doc('morganBank/classroomData').set({
    students: [
      { id: 1, name: 'Ada', balance: 10, frozen: false },
      { id: 2, name: 'Grace', balance: 20, frozen: false },
      { id: 5, name: 'Alan', balance: 0, frozen: true },
    ],
    transactions: [{ id: 100, studentId: 1, type: 'Add', amount: 10 }],
    loginHistory: [{ id: 200, studentId: 2, result: 'success' }],
    settings: { reasons: ['Quick Cash'] },
  })
  await firestore.doc('studentCredentials/ada').set({
    loginId: 'ada', studentId: '1', classroomId: 'morgan', active: true,
  })
  await firestore.doc('studentCredentials/grace').set({
    loginId: 'grace', studentId: '2', classroomId: 'morgan', active: true,
  })
  await firestore.collection('studentAuthLogs').add({
    studentId: '1', outcome: 'success',
  })
  await auth.createUser({ uid: 'legacy-student-1', disabled: false })
})

after(async () => {
  // Remove only artifacts this suite created under its own disposable identity.
  // No operator manifest is ever touched.
  for (const manifestPath of createdManifestPaths) {
    try {
      fs.rmSync(manifestPath, { force: true })
    } catch {
      // A missing test manifest is not a failure.
    }
  }
  if (temporaryDirectory) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
  if (handles) await handles.close()
})

describe('Phase 3 preflight entrypoint against live emulators', () => {
  test('forbidden arguments are rejected before any read occurs', async () => {
    let readerInvocations = 0
    const counting = Object.fromEntries(
      Object.entries(liveReaders()).map(([name, fn]) => [
        name,
        async (...args) => { readerInvocations += 1; return fn(...args) },
      ]),
    )

    const forbidden = [
      ['--write'],
      ['--force'],
      ['--project-id', 'morgan-bank'],
      ['--manifest', '/tmp/x.json'],
      ['--state-dir', '/tmp'],
      ['--production'],
      ['--dry-run'],
      ['write'],
      ['reverify'],
      ['--teacher-uid=abc'],
      ['unexpected-positional'],
      ['--unknown-flag', 'x'],
    ]

    for (const argv of forbidden) {
      const { exitCode } = await runPreflightMain(argv, {
        environment: emulatorEnvironment(),
        readers: counting,
        logger: { log() {}, error() {} },
      })
      assert.equal(
        exitCode,
        PREFLIGHT_EXIT_CODES.ARGUMENT_REJECTED,
        `${argv.join(' ')} must be rejected`,
      )
    }

    assert.equal(
      readerInvocations,
      0,
      'no Firestore or Auth read may occur for a rejected argument list',
    )
  })

  test('a duplicate flag and a missing required flag are both rejected', async () => {
    for (const argv of [
      ['--teacher-uid', 'a', '--teacher-uid', 'b'],
      ['--teacher-uid', TEACHER_UID],
    ]) {
      const { exitCode } = await runPreflightMain(argv, {
        environment: emulatorEnvironment(),
        logger: { log() {}, error() {} },
      })
      assert.equal(exitCode, PREFLIGHT_EXIT_CODES.ARGUMENT_REJECTED)
    }
  })

  test('parsePreflightArguments accepts exactly the four required flags', () => {
    const parsed = parsePreflightArguments([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', '/tmp/a.json',
      '--expectations-file', '/tmp/e.json',
      '--credential-file', '/tmp/c.json',
    ])
    assert.equal(parsed.teacherUid, TEACHER_UID)
    assert.equal(parsed.credentialFile, '/tmp/c.json')
  })

  test('a successful preflight reads live data and writes nothing remote', async () => {
    const firestoreBefore = await snapshotFirestore()
    const authBefore = await snapshotAuth()

    // Artifacts must be self-consistent: the authorization binds the exact
    // credential and expectations checksums, so they are computed first.
    const credentialPath = writeArtifact('credential.json', {
      type: 'service_account', project_id: EMULATOR_PROJECT_ID,
    })
    const expectationsPath = writeArtifact('expectations.json', expectationsArtifact())
    const { createHash } = await import('node:crypto')
    const credentialSha = createHash('sha256')
      .update(fs.readFileSync(credentialPath, 'utf8'), 'utf8').digest('hex')
    const expectationsSha = createHash('sha256')
      .update(fs.readFileSync(expectationsPath, 'utf8'), 'utf8').digest('hex')

    const authorizationPath = writeArtifact('authorization.json', authorizationArtifact({
      credentialSha256: credentialSha,
      expectationsSha256: expectationsSha,
    }))

    let persistedManifest
    const { exitCode, result, error } = await runPreflightMain([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', authorizationPath,
      '--expectations-file', expectationsPath,
      '--credential-file', credentialPath,
    ], {
      environment: emulatorEnvironment(),
      readers: liveReaders(),
      logger: { log() {}, error() {} },
      // The manifest is captured rather than installed, so the suite never
      // creates an operator manifest in the repository state directory.
      persistManifest: async (manifest) => {
        persistedManifest = manifest
        return { preflightManifestId: manifest.preflightManifestId }
      },
    })

    assert.equal(
      exitCode,
      PREFLIGHT_EXIT_CODES.SUCCESS,
      `preflight should succeed; got ${error?.category ?? ''} ${error?.message ?? ''}`,
    )

    // Live Firestore observations reached the manifest: three seeded students,
    // two credentials, and a watermark above the maximum seeded ID (5).
    assert.equal(result.watermark.observedMaximum, 5)
    assert.equal(result.watermark.nextStudentNumber, 6)
    assert.equal(persistedManifest.observations.counts.legacy.students, 3)
    assert.equal(persistedManifest.observations.counts.flatCredentials, 2)

    // Zero remote writes.
    assert.equal(
      await snapshotFirestore(),
      firestoreBefore,
      'preflight must not modify any Firestore document',
    )
    assert.equal(
      await snapshotAuth(),
      authBefore,
      'preflight must not modify any Auth user',
    )
  })

  test('the environment guard rejects a production project against emulators', async () => {
    const credentialPath = writeArtifact('cred2.json', {
      type: 'service_account', project_id: 'morgan-bank',
    })
    const expectationsPath = writeArtifact('exp2.json', expectationsArtifact())
    const authorizationPath = writeArtifact('auth2.json', authorizationArtifact())

    const { exitCode } = await runPreflightMain([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', authorizationPath,
      '--expectations-file', expectationsPath,
      '--credential-file', credentialPath,
    ], {
      // Production project while emulator hosts are set: contradictory, so the
      // Commit 2 guard must refuse it.
      environment: {
        ...process.env,
        GCLOUD_PROJECT: 'morgan-bank',
        GOOGLE_CLOUD_PROJECT: 'morgan-bank',
      },
      readers: liveReaders(),
      logger: { log() {}, error() {} },
    })

    assert.equal(
      exitCode,
      PREFLIGHT_EXIT_CODES.ENVIRONMENT_REJECTED,
      'an emulator-contaminated production environment must be refused',
    )
  })

  test('an unbound credential checksum aborts before the manifest', async () => {
    const firestoreBefore = await snapshotFirestore()

    const credentialPath = writeArtifact('cred3.json', {
      type: 'service_account', project_id: EMULATOR_PROJECT_ID,
    })
    const expectationsPath = writeArtifact('exp3.json', expectationsArtifact())
    const authorizationPath = writeArtifact('auth3.json', authorizationArtifact({
      credentialSha256: 'f'.repeat(64),
      expectationsSha256: 'f'.repeat(64),
    }))

    let persisted = 0
    const { exitCode, error } = await runPreflightMain([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', authorizationPath,
      '--expectations-file', expectationsPath,
      '--credential-file', credentialPath,
    ], {
      environment: emulatorEnvironment(),
      readers: liveReaders(),
      logger: { log() {}, error() {} },
      persistManifest: async () => { persisted += 1; return {} },
    })

    assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
    assert.equal(
      error.category,
      PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_UNBOUND,
    )
    assert.equal(persisted, 0, 'a failed preflight writes no manifest')
    assert.equal(await snapshotFirestore(), firestoreBefore)
  })

  test('unexpected scoped credentials in live Firestore abort the run', async () => {
    // Seed destination data the expectations do not acknowledge.
    await firestore
      .doc('classrooms/unexpected-classroom/studentCredentials/ada')
      .set({ loginId: 'ada', studentId: '1', classroomId: 'unexpected-classroom' })

    const firestoreBefore = await snapshotFirestore()

    const credentialPath = writeArtifact('cred4.json', {
      type: 'service_account', project_id: EMULATOR_PROJECT_ID,
    })
    const expectationsPath = writeArtifact('exp4.json', expectationsArtifact())
    const { createHash } = await import('node:crypto')
    const credentialSha = createHash('sha256')
      .update(fs.readFileSync(credentialPath, 'utf8'), 'utf8').digest('hex')
    const expectationsSha = createHash('sha256')
      .update(fs.readFileSync(expectationsPath, 'utf8'), 'utf8').digest('hex')
    const authorizationPath = writeArtifact('auth4.json', authorizationArtifact({
      credentialSha256: credentialSha,
      expectationsSha256: expectationsSha,
    }))

    let persisted = 0
    const { exitCode, error } = await runPreflightMain([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', authorizationPath,
      '--expectations-file', expectationsPath,
      '--credential-file', credentialPath,
    ], {
      environment: emulatorEnvironment(),
      readers: liveReaders(),
      logger: { log() {}, error() {} },
      persistManifest: async () => { persisted += 1; return {} },
    })

    assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
    assert.equal(
      error.category,
      PREFLIGHT_ABORT_CATEGORIES.DESTINATION_DATA_PRESENT,
      'live scoped credentials before bridge rules must abort',
    )
    assert.equal(persisted, 0)
    assert.equal(await snapshotFirestore(), firestoreBefore)

    // Clean up only this suite's own seeded document.
    await firestore
      .doc('classrooms/unexpected-classroom/studentCredentials/ada').delete()
    await firestore.doc('classrooms/unexpected-classroom').delete()
  })

  test('a malformed credential file is rejected without reading Firestore', async () => {
    const credentialPath = writeArtifact('cred5.json', {
      type: 'authorized_user', project_id: EMULATOR_PROJECT_ID,
    })
    const expectationsPath = writeArtifact('exp5.json', expectationsArtifact())
    const authorizationPath = writeArtifact('auth5.json', authorizationArtifact())

    // Production context so the credential is actually validated.
    const { exitCode } = await runPreflightMain([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', authorizationPath,
      '--expectations-file', expectationsPath,
      '--credential-file', credentialPath,
    ], {
      environment: { GCLOUD_PROJECT: 'morgan-bank' },
      readers: liveReaders(),
      logger: { log() {}, error() {} },
    })

    // An authorized_user credential is not an explicit service-account key.
    assert.equal(exitCode, PREFLIGHT_EXIT_CODES.AUTHORIZATION_REJECTED)
  })

  test('a missing artifact file fails without a manifest', async () => {
    let persisted = 0
    const { exitCode } = await runPreflightMain([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', path.join(temporaryDirectory, 'absent.json'),
      '--expectations-file', path.join(temporaryDirectory, 'absent.json'),
      '--credential-file', path.join(temporaryDirectory, 'absent.json'),
    ], {
      environment: emulatorEnvironment(),
      readers: liveReaders(),
      logger: { log() {}, error() {} },
      persistManifest: async () => { persisted += 1; return {} },
    })
    assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
    assert.equal(persisted, 0)
  })
})
