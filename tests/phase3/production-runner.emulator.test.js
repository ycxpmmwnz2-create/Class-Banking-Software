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
import { createHash, randomBytes } from 'node:crypto'
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

const {
  runPreflightMain,
  PREFLIGHT_EXIT_CODES,
  parsePreflightArguments,
} =
  await import('../../functions/phase3/preflight.js')
// Commit 5 relocated the shared hash-before-parse, strict-decode, and
// credential helpers into productionEnvironment.js so all three entrypoints
// bind artifacts identically instead of each carrying a near-copy.
const {
  validateExplicitCredential,
  validateRehearsalWriteAuthorization,
} = await import('../../functions/phase3/productionEnvironment.js')
// Admin handles come from a module under functions/, so `firebase-admin`
// resolves from functions/node_modules and never becomes a root dependency —
// the same convention functions/phase2/seedRehearsal.js established.
const {
  PREFLIGHT_ABORT_CATEGORIES,
  createReadOnlyAdminHandles,
  createReadOnlyDataReaders,
  createRawDataReaders,
  toSourceEnvelope,
} = await import(
  '../../functions/phase3/productionPreflight.js'
)
// The real persister and the real state directory — this suite installs an actual
// manifest and then removes only its own, per the amended retention policy.
const {
  PRODUCTION_STATE_DIRECTORY,
  persistProductionManifest,
  readProductionManifest,
  resolveManifestPath,
} = await import('../../functions/phase3/productionManifest.js')
const { serializeCanonicalState } = await import(
  '../../functions/phase2/canonicalState.js'
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

/**
 * The classroom login code this run reserves: canonical, uppercase, unformatted,
 * eight unambiguous characters. `normalizeClassroomCode` would normalize other
 * renderings to the same value, but the authorization requires this exact form.
 */
const CANONICAL_LOGIN_CODE = 'BCDFGHJK'
/**
 * The display rendering stored on the classroom root. The index document ID is
 * the canonical value above; these must remain two renderings of one code.
 */
const FORMATTED_LOGIN_CODE = 'BCDF-GHJK'
assert.equal(
  FORMATTED_LOGIN_CODE,
  `${CANONICAL_LOGIN_CODE.slice(0, 4)}-${CANONICAL_LOGIN_CODE.slice(4)}`,
  'the formatted and canonical login codes must describe the same code',
)

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
    // Commit 5: the classroom login code is chosen and bound BEFORE any write,
    // already in canonical (uppercase, unformatted, 8-character) form.
    studentLoginCode: CANONICAL_LOGIN_CODE,
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
 * Secret-bearing values this suite seeds into the emulator. Distinctive strings so
 * a leak into the retained manifest is unambiguous rather than coincidental.
 */
const SEEDED_PIN_HASHES = Object.freeze({
  ada: 'seededpinhash-ada-1f4b9c2e7d5a8306',
  grace: 'seededpinhash-grace-9c3e6b1a04f7d582',
})

/**
 * Strings that must never appear in a retained manifest: the PIN hashes above,
 * the raw login IDs, and the raw scoped document paths that embed student
 * identity.
 */
function identityBearingSeedStrings() {
  return [
    ...Object.values(SEEDED_PIN_HASHES),
    'studentCredentials/ada',
    'studentCredentials/grace',
    'morganBank/classroomData',
  ]
}

/**
 * Persists through the real persister and records the path for cleanup.
 *
 * Aborting runs never reach this; only the acknowledged-count control does.
 */
async function echoRecord(manifest) {
  const record = await persistProductionManifest(manifest)
  createdManifestPaths.push(record.manifestPath)
  return record
}

/**
 * Enumerates the EXISTING teacher and classroom root documents.
 *
 * `listDocuments()` is used so a phantom parent's subcollections are still
 * reachable, but each reference is then probed with `.get()` and only real
 * documents are reported as roots: a path that holds only subcollections is not a
 * teacher or a classroom, and counting one would invent state that is not there.
 * Data beneath such a parent is accounted for by the destination surfaces instead.
 */
async function enumerateExistingRoots() {
  const roots = { teacherIds: [], classroomIds: [] }
  for (const [collection, key] of [
    ['teachers', 'teacherIds'],
    ['classrooms', 'classroomIds'],
  ]) {
    const refs = await firestore.collection(collection).listDocuments()
    for (const ref of refs) {
      const snapshot = await ref.get()
      if (snapshot.exists) roots[key].push(ref.id)
    }
    roots[key].sort()
  }
  return roots
}

/** Real Firestore/Auth readers from the production data-reader implementation. */
function liveReaders() {
  return {
    ...injectedDeploymentReaders(),
    ...createReadOnlyDataReaders({
      firestore,
      auth,
      teacherUid: TEACHER_UID,
    }),
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
  // pinHash values are seeded deliberately: they are exactly the secret-bearing
  // field that must enter the document hash preimage in memory and never appear
  // in the retained manifest. identityBearingSeedStrings() asserts that.
  await firestore.doc('studentCredentials/ada').set({
    loginId: 'ada', studentId: '1', classroomId: 'morgan', active: true,
    pinHash: SEEDED_PIN_HASHES.ada,
  })
  await firestore.doc('studentCredentials/grace').set({
    loginId: 'grace', studentId: '2', classroomId: 'morgan', active: true,
    pinHash: SEEDED_PIN_HASHES.grace,
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

  test('explicit credential validation returns the Admin credential itself', () => {
    const explicitCredential = Object.freeze({
      getAccessToken: async () => ({ access_token: 'fake-token' }),
    })
    let supplied
    const result = validateExplicitCredential({
      type: 'service_account',
      project_id: 'morgan-bank',
      client_email: 'phase3@example.invalid',
      private_key: 'not-a-real-key',
    }, serviceAccount => {
      supplied = serviceAccount
      return explicitCredential
    })
    assert.strictEqual(result, explicitCredential)
    assert.deepEqual(supplied, {
      projectId: 'morgan-bank',
      clientEmail: 'phase3@example.invalid',
      privateKey: 'not-a-real-key',
    })
  })

  test('production direct wiring binds authorization before handles and closes readers',
    async () => {
      const credentialPath = writeArtifact('production-wiring-credential.json', {
        type: 'service_account',
        project_id: 'morgan-bank',
        client_email: 'phase3@example.invalid',
        private_key: 'not-a-real-key',
      })
      const expectationsPath = writeArtifact(
        'production-wiring-expectations.json',
        expectationsArtifact(),
      )
      const credentialSha = createHash('sha256')
        .update(fs.readFileSync(credentialPath, 'utf8'), 'utf8').digest('hex')
      const expectationsSha = createHash('sha256')
        .update(fs.readFileSync(expectationsPath, 'utf8'), 'utf8').digest('hex')
      const authorizationPath = writeArtifact(
        'production-wiring-authorization.json',
        authorizationArtifact({
          projectId: 'morgan-bank',
          credentialSha256: credentialSha,
          expectationsSha256: expectationsSha,
        }),
      )
      const argv = [
        '--teacher-uid', TEACHER_UID,
        '--authorization-file', authorizationPath,
        '--expectations-file', expectationsPath,
        '--credential-file', credentialPath,
      ]
      const explicitCredential = Object.freeze({
        getAccessToken: async () => ({ access_token: 'fake-token' }),
      })
      let factoryCalls = 0
      let closeCalls = 0
      const outcome = await runPreflightMain(argv, {
        environment: { GCLOUD_PROJECT: 'morgan-bank' },
        credentialFactory: () => explicitCredential,
        productionReaderFactory: options => {
          factoryCalls += 1
          assert.strictEqual(options.credential, explicitCredential)
          assert.equal(options.projectId, 'morgan-bank')
          assert.equal(options.teacherUid, TEACHER_UID)
          return {
            ...liveReaders(),
            close: async () => { closeCalls += 1 },
          }
        },
        logger: { log() {}, error() {} },
        persistManifest: async manifest => ({
          preflightManifestId: manifest.preflightManifestId,
          preflightChecksum: manifest.preflightChecksum,
          manifestPath: '/disposable/unit-manifest.json',
        }),
      })
      assert.equal(outcome.exitCode, PREFLIGHT_EXIT_CODES.SUCCESS,
        `${outcome.error?.category ?? ''} ${outcome.error?.message ?? ''}`)
      assert.equal(factoryCalls, 1)
      assert.equal(closeCalls, 1)

      const unboundAuthorization = writeArtifact(
        'production-wiring-unbound-authorization.json',
        authorizationArtifact({
          projectId: 'morgan-bank',
          credentialSha256: 'f'.repeat(64),
          expectationsSha256: expectationsSha,
        }),
      )
      const rejected = await runPreflightMain([
        ...argv.slice(0, 2),
        '--authorization-file', unboundAuthorization,
        ...argv.slice(4),
      ], {
        environment: { GCLOUD_PROJECT: 'morgan-bank' },
        credentialFactory: () => explicitCredential,
        productionReaderFactory: () => {
          factoryCalls += 1
          throw new Error('authorization must bind before reader construction')
        },
        logger: { log() {}, error() {} },
      })
      assert.equal(rejected.exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
      assert.equal(rejected.error.category,
        PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_UNBOUND)
      assert.equal(factoryCalls, 1,
        'unbound authorization must not construct any Admin reader handle')
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

    // REAL persistence through the real persister and the real, non-overridable
    // state directory. Capturing the manifest instead would leave the atomic
    // install path unexercised end to end.
    let persistedManifest
    let installedPath
    const { exitCode, result, error } = await runPreflightMain([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', authorizationPath,
      '--expectations-file', expectationsPath,
      '--credential-file', credentialPath,
    ], {
      environment: emulatorEnvironment(),
      readers: liveReaders(),
      logger: { log() {}, error() {} },
      persistManifest: async (manifest) => {
        persistedManifest = manifest
        const record = await persistProductionManifest(manifest)
        installedPath = record.manifestPath
        createdManifestPaths.push(record.manifestPath)
        return record
      },
    })

    try {
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

      // The manifest is genuinely on disk, canonical, and re-readable by content
      // address through the real reader.
      assert.equal(installedPath, resolveManifestPath(result.preflightManifestId))
      assert.ok(fs.existsSync(installedPath), 'the manifest must be installed on disk')
      const reread = await readProductionManifest(result.preflightManifestId)
      assert.equal(reread.preflightChecksum, result.preflightChecksum)
      assert.equal(
        fs.readFileSync(installedPath, 'utf8'),
        serializeCanonicalState(persistedManifest),
        'the installed bytes must be the exact canonical serialization',
      )

      // Real per-document hashes of real Firestore documents, with real update
      // times, reached the domains.
      assert.match(persistedManifest.domainChecksums.legacySourceState, /^[0-9a-f]{64}$/)
      assert.match(persistedManifest.domainChecksums.destinationAbsence, /^[0-9a-f]{64}$/)

      // No identity-bearing material is on disk. The seeded PIN hashes and login
      // IDs entered the hash preimages in memory only.
      const onDisk = fs.readFileSync(installedPath, 'utf8')
      for (const forbidden of identityBearingSeedStrings()) {
        assert.ok(
          !onDisk.includes(forbidden),
          `the retained manifest must not contain ${forbidden}`,
        )
      }

      // Immutability holds against the real filesystem: a second install of the
      // same content address is refused rather than silently replacing it.
      await assert.rejects(
        () => persistProductionManifest(persistedManifest),
        rejection => rejection.category === 'manifest-already-exists',
        'a retained manifest must be immutable',
      )

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
    } finally {
      // Cleanup is permitted only for the exact manifest THIS run produced, under
      // the disposable emulator identity. Every guard is asserted before the
      // unlink, so a bug in this suite cannot delete an operator's record: the path
      // must be the canonical one for this run's content address, it must sit
      // inside the module-anchored state directory, and the manifest must name the
      // permitted emulator project rather than production.
      if (installedPath !== undefined) {
        assert.equal(
          installedPath,
          resolveManifestPath(persistedManifest.preflightManifestId),
          'refusing to delete a non-canonical path',
        )
        const directory = PRODUCTION_STATE_DIRECTORY.endsWith(path.sep)
          ? PRODUCTION_STATE_DIRECTORY
          : `${PRODUCTION_STATE_DIRECTORY}${path.sep}`
        assert.ok(
          installedPath.startsWith(directory) &&
            path.dirname(installedPath) === path.resolve(PRODUCTION_STATE_DIRECTORY),
          'refusing to delete outside the canonical state directory',
        )
        assert.equal(
          persistedManifest.projectId,
          EMULATOR_PROJECT_ID,
          'refusing to delete a manifest that does not name the emulator project',
        )
        assert.notEqual(persistedManifest.projectId, 'morgan-bank')
        fs.rmSync(installedPath, { force: true })
        assert.ok(!fs.existsSync(installedPath), 'test-owned manifest must be removed')
      }
    }
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
      persistManifest: async () => {
        persisted += 1
        throw new Error('the persister must not be reached for an aborted preflight')
      },
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
      persistManifest: async () => {
        persisted += 1
        throw new Error('the persister must not be reached for an aborted preflight')
      },
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

  test('scoped auth logs are genuinely enumerated, not reported as zero', async () => {
    // This surface was previously hardcoded to `scopedLogs: 0` with no read at
    // all, so preflight would have reported absence for state nobody examined.
    // Seeded under a phantom parent so the enumeration path is also exercised:
    // studentAuthLogs/{classroomId} holds no document of its own.
    await firestore
      .doc('studentAuthLogs/unexpected-classroom/logs/log-1')
      .set({ studentId: '1', outcome: 'success' })

    const firestoreBefore = await snapshotFirestore()

    // The reader must SEE it.
    const observed = await liveReaders().readDestinationPaths({
      canonicalLoginCode: CANONICAL_LOGIN_CODE,
    })
    assert.equal(observed.counts.scopedLogs, 1, 'the scoped log must be counted')
    assert.equal(
      observed.sourceEntriesBySurface.scopedLogs.length,
      1,
      'the scoped log must carry its own evidence entry',
    )

    const credentialPath = writeArtifact('cred6.json', {
      type: 'service_account', project_id: EMULATOR_PROJECT_ID,
    })
    const expectationsPath = writeArtifact('exp6.json', expectationsArtifact())
    const credentialSha = createHash('sha256')
      .update(fs.readFileSync(credentialPath, 'utf8'), 'utf8').digest('hex')
    const expectationsSha = createHash('sha256')
      .update(fs.readFileSync(expectationsPath, 'utf8'), 'utf8').digest('hex')
    const authorizationPath = writeArtifact('auth6.json', authorizationArtifact({
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
      persistManifest: async () => {
        persisted += 1
        throw new Error('the persister must not be reached for an aborted preflight')
      },
    })

    assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
    assert.equal(
      error.category,
      PREFLIGHT_ABORT_CATEGORIES.DESTINATION_DATA_PRESENT,
      'an unacknowledged scoped auth log must abort',
    )
    assert.equal(persisted, 0)
    assert.equal(await snapshotFirestore(), firestoreBefore)

    await firestore.doc('studentAuthLogs/unexpected-classroom/logs/log-1').delete()
  })

  /**
   * Runs the real entrypoint with self-consistent artifacts against live readers.
   *
   * `expectationOverrides` lets a case acknowledge a destination count, which is
   * what makes the watermark-contribution control possible: an acknowledged record
   * must still raise the watermark.
   */
  async function liveRun(tag, expectationOverrides = {}) {
    const credentialPath = writeArtifact(`cred-${tag}.json`, {
      type: 'service_account', project_id: EMULATOR_PROJECT_ID,
    })
    const expectationsPath = writeArtifact(
      `exp-${tag}.json`, expectationsArtifact(expectationOverrides),
    )
    const credentialSha = createHash('sha256')
      .update(fs.readFileSync(credentialPath, 'utf8'), 'utf8').digest('hex')
    const expectationsSha = createHash('sha256')
      .update(fs.readFileSync(expectationsPath, 'utf8'), 'utf8').digest('hex')
    const authorizationPath = writeArtifact(`auth-${tag}.json`, authorizationArtifact({
      credentialSha256: credentialSha,
      expectationsSha256: expectationsSha,
    }))

    let manifest
    const outcome = await runPreflightMain([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', authorizationPath,
      '--expectations-file', expectationsPath,
      '--credential-file', credentialPath,
    ], {
      environment: emulatorEnvironment(),
      readers: liveReaders(),
      logger: { log() {}, error() {} },
      persistManifest: async (built) => { manifest = built; return echoRecord(built) },
    })
    return { ...outcome, manifest }
  }

  test('a transaction beneath a phantom classroom is visible and blocking', async () => {
    // The exact blind spot: `classrooms/{id}` holds no document of its own, and
    // only a transaction exists beneath it. An enumeration limited to students and
    // credentials would have reported absence for state that is plainly there.
    await firestore
      .doc('classrooms/phantom-txn/transactions/txn-1')
      .set({ id: 100, studentId: 41, type: 'Add', amount: 5 })

    const before = await snapshotFirestore()
    const observed = await liveReaders().readDestinationPaths({
      canonicalLoginCode: CANONICAL_LOGIN_CODE,
    })
    assert.equal(observed.counts.classroomTransactions, 1)
    assert.equal(observed.sourceEntriesBySurface.classroomTransactions.length, 1)
    assert.deepEqual(observed.studentIdsBySurface.destinationTransactions, [41])

    const { exitCode, error } = await liveRun('txn')
    assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
    assert.equal(error.category, PREFLIGHT_ABORT_CATEGORIES.DESTINATION_DATA_PRESENT)
    assert.equal(await snapshotFirestore(), before)

    await firestore.doc('classrooms/phantom-txn/transactions/txn-1').delete()
  })

  test('a login-history record beneath a phantom classroom is visible and blocking', async () => {
    await firestore
      .doc('classrooms/phantom-hist/loginHistory/hist-1')
      .set({ id: 200, studentId: '43', result: 'success' })

    const before = await snapshotFirestore()
    const observed = await liveReaders().readDestinationPaths({
      canonicalLoginCode: CANONICAL_LOGIN_CODE,
    })
    assert.equal(observed.counts.classroomLoginHistory, 1)
    // Raw type preserved: a string reference stays a string.
    assert.deepEqual(observed.studentIdsBySurface.destinationLoginHistory, ['43'])

    const { exitCode, error } = await liveRun('hist')
    assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
    assert.equal(error.category, PREFLIGHT_ABORT_CATEGORIES.DESTINATION_DATA_PRESENT)
    assert.equal(await snapshotFirestore(), before)

    await firestore.doc('classrooms/phantom-hist/loginHistory/hist-1').delete()
  })

  test('an unrelated teacher or an extra classroom root is visible and blocking', async () => {
    for (const [label, docPath, body] of [
      ['unrelated teacher', 'teachers/unrelated-teacher',
        { uid: 'unrelated-teacher', classroomId: 'other', status: 'active' }],
      ['extra classroom root', 'classrooms/extra-root',
        { ownerUid: 'someone-else' }],
    ]) {
      await firestore.doc(docPath).set(body)
      const before = await snapshotFirestore()

      // The reader must SEE it as an existing root document.
      const roots = await enumerateExistingRoots()
      const observed = [...roots.teacherIds, ...roots.classroomIds]
      assert.ok(
        observed.some(id => docPath.endsWith(id)),
        `${label} must be enumerated as an existing root`,
      )

      const { exitCode, error } = await liveRun(`root-${observed.length}`)
      assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
      assert.equal(
        error.category,
        PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
        `${label} must abort as an unauthorized foundation document`,
      )
      assert.equal(await snapshotFirestore(), before)

      await firestore.doc(docPath).delete()
    }
  })

  test('a phantom classroom parent is not counted as an existing classroom root', async () => {
    // The inverse control for the test above: a path holding only a subcollection
    // is NOT a root document, so counting it would invent a classroom that does
    // not exist. Its data is accounted for by the destination surfaces instead.
    await firestore
      .doc('classrooms/phantom-only/students/s1')
      .set({ id: 3, name: 'Ada' })

    const roots = await enumerateExistingRoots()
    assert.ok(
      !roots.classroomIds.includes('phantom-only'),
      'a phantom parent must not be reported as an existing classroom root',
    )
    // But its student IS seen by the destination enumeration.
    const observed = await liveReaders().readDestinationPaths({
      canonicalLoginCode: CANONICAL_LOGIN_CODE,
    })
    assert.equal(observed.counts.classroomStudents, 1)

    await firestore.doc('classrooms/phantom-only/students/s1').delete()
  })

  test('an acknowledged scoped credential still raises the watermark', async () => {
    // Acknowledging a destination count permits the run; it does not erase the
    // historical identity. Student 900 must move the watermark to 901, well above
    // the seeded legacy maximum of 5.
    await firestore
      .doc('classrooms/ack-classroom/studentCredentials/zoe')
      .set({ loginId: 'zoe', studentId: 900, classroomId: 'ack-classroom' })

    const before = await snapshotFirestore()
    let installedPath
    const { exitCode, result, error, manifest } = await liveRun('ack', {
      acknowledgedDestinationCounts: { scopedCredentials: 1 },
    })

    try {
      assert.equal(
        exitCode,
        PREFLIGHT_EXIT_CODES.SUCCESS,
        `an acknowledged count must permit the run; got ${error?.category ?? ''} ${error?.message ?? ''}`,
      )
      assert.equal(
        result.watermark.observedMaximum,
        900,
        'the acknowledged record must contribute its raw ID',
      )
      assert.equal(result.watermark.nextStudentNumber, 901)
      installedPath = manifest === undefined
        ? undefined
        : resolveManifestPath(manifest.preflightManifestId)
      assert.equal(await snapshotFirestore(), before)
    } finally {
      if (installedPath !== undefined && fs.existsSync(installedPath)) {
        assert.equal(manifest.projectId, EMULATOR_PROJECT_ID)
        assert.equal(
          path.dirname(installedPath),
          path.resolve(PRODUCTION_STATE_DIRECTORY),
        )
        fs.rmSync(installedPath, { force: true })
      }
      await firestore
        .doc('classrooms/ack-classroom/studentCredentials/zoe').delete()
    }
  })

  test('acknowledgment cannot hide a missing or path-mismatched student ID', async () => {
    for (const [tag, body] of [
      ['missing', { name: 'Missing ID', balance: 0, frozen: false }],
      ['mismatch', { id: 8, name: 'Wrong ID', balance: 0, frozen: false }],
    ]) {
      const document = firestore.doc(`classrooms/identity-${tag}/students/7`)
      await document.set(body)
      try {
        const observed = await liveReaders().readDestinationPaths({
      canonicalLoginCode: CANONICAL_LOGIN_CODE,
    })
        const coverage = observed.studentIdCoverageBySurface.destinationStudents
        assert.equal(observed.counts.classroomStudents, 1)
        assert.equal(
          tag === 'missing' ? coverage.unassignedCount : coverage.inconsistentCount,
          1,
          `${tag} identity must be classified rather than dropped`,
        )

        const { exitCode, error } = await liveRun(`student-${tag}`, {
          acknowledgedDestinationCounts: { classroomStudents: 1 },
        })
        assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
        assert.equal(error.category, PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID)
      } finally {
        await document.delete()
      }
    }
  })

  test('acknowledgment cannot hide a scoped credential missing studentId', async () => {
    const document = firestore.doc(
      'classrooms/identity-credential/studentCredentials/missing-student',
    )
    await document.set({ classroomId: 'identity-credential', active: true })
    try {
      const observed = await liveReaders().readDestinationPaths({
      canonicalLoginCode: CANONICAL_LOGIN_CODE,
    })
      assert.equal(
        observed.studentIdCoverageBySurface.destinationCredentials.unassignedCount,
        1,
      )
      const { exitCode, error } = await liveRun('credential-missing-id', {
        acknowledgedDestinationCounts: { scopedCredentials: 1 },
      })
      assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
      assert.equal(error.category, PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID)
    } finally {
      await document.delete()
    }
  })

  test('a malformed non-null reference is retained for validation and blocks', async () => {
    const document = firestore.doc(
      'classrooms/identity-reference/transactions/malformed-reference',
    )
    await document.set({ id: 1, studentId: { malformed: true }, amount: 1 })
    try {
      const observed = await liveReaders().readDestinationPaths({
      canonicalLoginCode: CANONICAL_LOGIN_CODE,
    })
      assert.equal(
        observed.studentIdCoverageBySurface.destinationTransactions.referencedCount,
        1,
      )
      assert.deepEqual(
        observed.studentIdsBySurface.destinationTransactions,
        [{ malformed: true }],
      )
      const { exitCode, error } = await liveRun('malformed-reference', {
        acknowledgedDestinationCounts: { classroomTransactions: 1 },
      })
      assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
      assert.equal(error.category, PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID)
    } finally {
      await document.delete()
    }
  })

  test('a Phase 2A-compatible unassigned transaction is classified explicitly', async () => {
    const document = firestore.doc(
      'classrooms/unassigned-reference/transactions/unassigned',
    )
    await document.set({ id: 2, studentId: null, amount: 1 })
    try {
      const observed = await liveReaders().readDestinationPaths({
      canonicalLoginCode: CANONICAL_LOGIN_CODE,
    })
      const coverage = observed.studentIdCoverageBySurface.destinationTransactions
      assert.equal(coverage.referencedCount, 0)
      assert.equal(coverage.unassignedCount, 1)

      const { exitCode, result, error } = await liveRun('unassigned-reference', {
        acknowledgedDestinationCounts: { classroomTransactions: 1 },
      })
      assert.equal(
        exitCode,
        PREFLIGHT_EXIT_CODES.SUCCESS,
        `${error?.category ?? ''} ${error?.message ?? ''}`,
      )
      assert.equal(result.watermark.observedMaximum, 5)
    } finally {
      await document.delete()
    }
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

  test('artifact bytes are hashed before strict UTF-8 decoding', async () => {
    const invalidPath = path.join(temporaryDirectory, 'invalid-utf8.json')
    fs.writeFileSync(invalidPath, Buffer.from([0x7b, 0xff, 0x7d]))
    let readerFactoryCalls = 0
    const { exitCode, error } = await runPreflightMain([
      '--teacher-uid', TEACHER_UID,
      '--authorization-file', invalidPath,
      '--expectations-file', invalidPath,
      '--credential-file', invalidPath,
    ], {
      environment: emulatorEnvironment(),
      createReaders: () => {
        readerFactoryCalls += 1
        throw new Error('invalid bytes must be rejected before readers')
      },
      logger: { log() {}, error() {} },
    })
    assert.equal(exitCode, PREFLIGHT_EXIT_CODES.AUTHORIZATION_REJECTED)
    assert.equal(error.category, 'malformed-artifact')
    assert.equal(readerFactoryCalls, 0)
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
      persistManifest: async () => {
        persisted += 1
        throw new Error('the persister must not be reached for an aborted preflight')
      },
    })
    assert.equal(exitCode, PREFLIGHT_EXIT_CODES.PREFLIGHT_ABORTED)
    assert.equal(persisted, 0)
  })
})

/**
 * Phase 3 Commit 5 — the production writer and re-verifier against live
 * emulators.
 *
 * EVIDENCE LAYER: real Firestore transactions and real Auth reads against the
 * emulators, driven through the actual `runProductionWrite` orchestration and a
 * real on-disk journal in an isolated temporary state root.
 *
 * This proves the two-invocation stage separation, the exact initialization
 * write set, the copy, source immutability, and crash recovery WITHOUT duplicate
 * writes. It does NOT prove production behavior: the control-plane inventories
 * are injected because no emulator exists for Rules/Functions/Hosting releases.
 */
describe('Phase 3 production writer against live emulators', () => {
  const WRITER_TEACHER_UID = 'writer-teacher-uid-0001'
  const WRITER_CLASSROOM_ID = 'writer-classroom-0001'
  const WRITER_CODE = 'MNPQRSTV'
  const WRITER_FORMATTED = 'MNPQ-RSTV'

  let writerState
  let writerModule
  let reconciliationModule
  let Timestamp

  /** Everything this describe block seeded, for exact-mutation assertions. */
  async function seedWriterFoundation() {
    // A reciprocal EXISTING foundation with NO code and NO counter — exactly the
    // state Release Order step 8 leaves behind.
    await firestore.doc(`teachers/${WRITER_TEACHER_UID}`).set({
      uid: WRITER_TEACHER_UID,
      classroomId: WRITER_CLASSROOM_ID,
      status: 'active',
    })
    await firestore.doc(`classrooms/${WRITER_CLASSROOM_ID}`).set({
      ownerUid: WRITER_TEACHER_UID,
      name: 'Writer Period 1',
      settings: { reasons: ['Legacy'] },
    })
  }

  function rawReaders() {
    return createRawDataReaders({
      firestore, teacherUid: WRITER_TEACHER_UID,
    })
  }

  function deployment(gateOn = false) {
    return {
      readInventory: async () => ({
        rules: { release: 'bridge-emulator' },
        gateParameters: {
          MULTI_TEACHER_V2_ENABLED: gateOn ? 'true' : 'false',
        },
        activeWriters: [],
      }),
      initializationExpectations: {
        rules: { release: 'bridge-emulator' },
        acknowledgedWriters: [],
      },
      copyExpectations: {
        rules: { release: 'bridge-emulator' },
        acknowledgedWriters: [],
      },
    }
  }

  async function foundationFor() {
    const readers = rawReaders()
    const teacher = await readers.readTeacher()
    const classroom = await readers.readClassroom(WRITER_CLASSROOM_ID)
    return {
      teacherUid: WRITER_TEACHER_UID,
      classroomId: WRITER_CLASSROOM_ID,
      teacher,
      classroom,
      foundationStateDigest: writerModule.computeFoundationDigest(
        teacher.data, classroom.data,
      ),
    }
  }

  function manifestFor() {
    return {
      schemaVersion: 2,
      preflightManifestId: 'd'.repeat(64),
      projectId: EMULATOR_PROJECT_ID,
      teacherUid: WRITER_TEACHER_UID,
      releaseId: 'phase3-rel-emulator',
      changeId: 'CHG-EMULATOR-001',
      preflightChecksum: 'e'.repeat(64),
      outcome: 'succeeded',
      observations: { watermark: { nextStudentNumber: 6 } },
    }
  }

  function authorizationFor() {
    return {
      authorizationId: 'AUTH-EMULATOR-001',
      snapshotId: 'SNAP-EMULATOR-001',
      writeFreezeProof: 'FREEZE-EMULATOR-001',
      credentialProvenance: 'emulator-harness-no-credential',
      writeAuthorizationSha256: createHash('sha256').update('wa').digest('hex'),
      preflightAuthorizationSha256: createHash('sha256').update('pa').digest('hex'),
      credentialSha256: createHash('sha256').update('cred').digest('hex'),
      initializationExpectationsSha256:
        createHash('sha256').update('init-exp').digest('hex'),
      copyExpectationsSha256:
        createHash('sha256').update('copy-exp').digest('hex'),
    }
  }

  /**
   * The copy projection for this classroom.
   *
   * The flat credentials seeded by the preflight block above reference students
   * 1, 2 and 5 — which the legacy roster also contains — so the strict
   * copy-only contract is satisfied. Envelopes are narrowed to Phase 2B's
   * declared source contract exactly as the writer does.
   */
  async function projectionFor() {
    const readers = rawReaders()
    const source = {
      classroomData: toSourceEnvelope(
        await readers.readLegacyClassroomAggregate(),
      ),
      studentCredentials: (await readers.readFlatCredentials())
        .map(toSourceEnvelope),
      studentAuthLogs: (await readers.readFlatAuthLogs())
        .map(toSourceEnvelope),
    }
    return {
      source,
      projection: writerModule.buildProductionProjection({
        classroomId: WRITER_CLASSROOM_ID,
        ...source,
      }),
    }
  }

  before(async () => {
    writerModule = await import('../../functions/phase3/productionWriter.js')
    reconciliationModule = await import(
      '../../functions/phase3/productionReconciliation.js'
    )
    // `firebase-admin` resolves from functions/node_modules only, so the
    // Timestamp type is reached through a module under functions/ rather than
    // imported directly here — the same convention the handle factory follows.
    Timestamp = writerModule.Timestamp

    writerState = fs.mkdtempSync(
      path.join(os.tmpdir(), `phase3-writer-${RUN_TOKEN}-`),
    )
    await seedWriterFoundation()
  })

  after(() => {
    // Removes ONLY this suite's isolated temporary state root. Operator .state
    // contents are never written or deleted by this suite.
    if (writerState) fs.rmSync(writerState, { recursive: true, force: true })
  })

  test('first invocation writes only the initialization and stops', async () => {
    const journal = writerModule.createWriteJournal({
      preflightManifestId: 'd'.repeat(64),
      stateRoot: writerState,
    })
    const { projection } = await projectionFor()
    const foundation = await foundationFor()
    const initialization = {
      canonicalLoginCode: WRITER_CODE,
      formattedLoginCode: WRITER_FORMATTED,
      nextStudentNumber: 6,
    }
    const plan = writerModule.buildCopyPlan({
      projection, foundation, initialization,
    })

    const before = await snapshotFirestore()
    const outcome = await writerModule.runProductionWrite({
      firestore,
      journal,
      manifest: manifestFor(),
      authorization: authorizationFor(),
      initialization: {
        ...initialization,
        projection,
        planDigest: plan.planDigest,
        batchCount: plan.batches.length,
        countsBySurface: plan.countsBySurface,
      },
      foundation,
      deployment: deployment(),
      rawReaders: rawReaders(),
      nowTimestamp: Timestamp.fromMillis(1_790_000_000_000),
      logger: { log() {}, error() {} },
    })

    assert.equal(outcome.result, 'ACTION_REQUIRED/AWAITING_DEPLOYMENT')
    assert.equal(outcome.migrationRan, false)

    // EXACTLY the two initialization writes occurred.
    const classroom = await firestore
      .doc(`classrooms/${WRITER_CLASSROOM_ID}`).get()
    assert.equal(classroom.data().studentLoginCode, WRITER_FORMATTED)
    assert.equal(classroom.data().nextStudentNumber, 6)
    // Every pre-existing field survived.
    assert.equal(classroom.data().ownerUid, WRITER_TEACHER_UID)
    assert.equal(classroom.data().name, 'Writer Period 1')
    assert.deepEqual(classroom.data().settings, { reasons: ['Legacy'] })

    const index = await firestore
      .doc(`classroomLoginCodes/${WRITER_CODE}`).get()
    assert.equal(index.exists, true)
    assert.deepEqual(Object.keys(index.data()).sort(),
      ['classroomId', 'createdAt', 'status'])
    assert.equal(index.data().classroomId, WRITER_CLASSROOM_ID)

    // COPY REMAINS ABSENT: no student, transaction, history, credential, or log.
    for (const collection of [
      'students', 'transactions', 'loginHistory', 'studentCredentials',
    ]) {
      const docs = await firestore
        .collection(`classrooms/${WRITER_CLASSROOM_ID}/${collection}`).get()
      assert.equal(docs.size, 0, `${collection} must remain absent`)
    }
    const scopedLogs = await firestore
      .collection(`studentAuthLogs/${WRITER_CLASSROOM_ID}/logs`).get()
    assert.equal(scopedLogs.size, 0)

    // The teacher document was never modified.
    const teacher = await firestore.doc(`teachers/${WRITER_TEACHER_UID}`).get()
    assert.deepEqual(Object.keys(teacher.data()).sort(),
      ['classroomId', 'status', 'uid'])

    assert.notEqual(before, await snapshotFirestore(),
      'initialization must have changed observable state')

    // The journal stopped at awaiting-copy-deployment.
    const replay = await journal.replay()
    assert.equal(replay.head.event, 'awaiting-copy-deployment')
    assert.ok(!replay.events.some(e => e.event === 'batch-in-flight'))

    // And the journal itself discloses nothing sensitive.
    for (const name of fs.readdirSync(journal.directory)) {
      const bytes = fs.readFileSync(path.join(journal.directory, name), 'utf8')
      for (const forbidden of [
        WRITER_CODE, WRITER_FORMATTED, WRITER_TEACHER_UID,
        'classrooms/', 'teachers/', 'seededpinhash',
      ]) {
        assert.ok(!bytes.includes(forbidden),
          `journal ${name} must not contain ${forbidden}`)
      }
    }
  })

  test('a second run at copy stage refuses a gate-on inventory', async () => {
    const journal = writerModule.createWriteJournal({
      preflightManifestId: 'd'.repeat(64),
      stateRoot: writerState,
    })
    const { projection } = await projectionFor()
    const foundation = await foundationFor()
    const initialization = {
      canonicalLoginCode: WRITER_CODE,
      formattedLoginCode: WRITER_FORMATTED,
      nextStudentNumber: 6,
    }
    const plan = writerModule.buildCopyPlan({
      projection, foundation, initialization,
    })

    const before = await snapshotFirestore()
    await assert.rejects(
      writerModule.runProductionWrite({
        firestore,
        journal,
        manifest: manifestFor(),
        authorization: authorizationFor(),
        initialization: {
          ...initialization,
          projection,
          planDigest: plan.planDigest,
          batchCount: plan.batches.length,
          countsBySurface: plan.countsBySurface,
        },
        foundation,
        // Gate ON: copying under a live gate would expose a half-migrated
        // classroom to real traffic.
        deployment: deployment(true),
        rawReaders: rawReaders(),
        nowTimestamp: Timestamp.fromMillis(1_790_000_000_000),
        logger: { log() {}, error() {} },
      }),
      error => error.category === 'deployment-drift',
    )
    assert.equal(before, await snapshotFirestore(),
      'a gate-on refusal must write nothing')
  })

  test('initialization is not repeated and the code index is never overwritten',
    async () => {
      // A fresh journal for the SAME already-initialized classroom must not
      // renumber the counter or replace the live code index.
      const journal = writerModule.createWriteJournal({
        preflightManifestId: 'f'.repeat(64),
        stateRoot: writerState,
      })
      const foundation = await foundationFor()
      const before = await snapshotFirestore()
      await assert.rejects(
        writerModule.runInitializationTransaction({
          firestore,
          foundation,
          initialization: {
            canonicalLoginCode: WRITER_CODE,
            formattedLoginCode: WRITER_FORMATTED,
            nextStudentNumber: 99,
          },
          initializedAt: Timestamp.fromMillis(1_790_000_000_000),
          manifest: manifestFor(),
        }),
        error => error.category === 'state-diverged',
      )
      assert.equal(before, await snapshotFirestore())
      assert.ok(journal.directory.startsWith(writerState))
    })

  test('flat credentials, legacy source, teacher, and Auth are never mutated',
    async () => {
      // Captured before this whole describe block's writes and compared now.
      const credential = await firestore.doc('studentCredentials/ada').get()
      assert.equal(credential.data().pinHash, SEEDED_PIN_HASHES.ada)
      const legacy = await firestore.doc('morganBank/classroomData').get()
      assert.equal(legacy.data().students.length, 3)
      const users = await auth.listUsers(1000)
      assert.ok(users.users.some(user => user.uid === 'legacy-student-1'))
    })

  test('reverify reconciles the initialized state without mutating anything',
    async () => {
      const before = await snapshotFirestore()
      const beforeAuth = await snapshotAuth()

      // The read-only reconciliation helper is the same one the writer uses, and
      // it lives in productionReconciliation.js precisely so reverify never has
      // to import the writer.
      await assert.rejects(
        reconciliationModule.readAndReconcileWriteRun({
          rawReaders: rawReaders(),
          foundation: {
            teacherUid: WRITER_TEACHER_UID,
            classroomId: WRITER_CLASSROOM_ID,
            classroom: (await rawReaders().readClassroom(WRITER_CLASSROOM_ID)),
          },
          initialization: {
            canonicalLoginCode: WRITER_CODE,
            formattedLoginCode: WRITER_FORMATTED,
            nextStudentNumber: 6,
          },
        }),
        // The copy has not run in this suite, so reconciliation legitimately
        // reports a mismatch. What matters here is that it MUTATED NOTHING.
        error => error.code === 'PHASE3_PRODUCTION_RECONCILIATION_ERROR',
      )

      assert.equal(before, await snapshotFirestore(),
        'reverification must not change Firestore')
      assert.equal(beforeAuth, await snapshotAuth(),
        'reverification must not change Auth')
    })

  test('a committed transaction with a failed journal event recovers cleanly',
    async () => {
      // The mandatory recovery control. A real emulator transaction commits, the
      // following journal event is deliberately failed, and recovery must
      // reclassify remote state rather than writing again.
      const manifestId = '0'.repeat(64)
      const targetPath =
        `classrooms/${WRITER_CLASSROOM_ID}/students/recovery-probe`
      const body = { id: 4242, name: 'Recovery', balance: 0, frozen: false,
        transactions: [] }

      const batch = {
        batchIndex: 0,
        batchDigest: createHash('sha256').update('recovery').digest('hex'),
        operations: [{
          operationId: 'op-000000',
          surface: 'students',
          type: 'create',
          path: targetPath,
          data: body,
          expectedBefore: 'absent',
        }],
      }

      // Commit for real against the emulator.
      await writerModule.commitCopyBatch({ firestore, batch })
      const committed = await firestore.doc(targetPath).get()
      assert.equal(committed.exists, true)

      // Simulate the crash: the journal event that should follow never lands.
      const journal = writerModule.createWriteJournal({
        preflightManifestId: manifestId,
        stateRoot: writerState,
        fs: {
          link: async () => {
            const error = new Error('injected journal failure')
            error.code = 'EIO'
            throw error
          },
        },
      })
      await assert.rejects(
        journal.append(
          { schemaVersion: 1, kind: 'phase3-production-write-journal',
            event: 'planned' },
          { expectedSequence: 0, expectedPreviousDigest: null },
        ),
        error => error.category === 'journal-write-failed',
      )

      // Recovery reads the batch and classifies it as already applied.
      const observed = new Map([[targetPath, {
        exists: true,
        data: (await firestore.doc(targetPath).get()).data(),
      }]])
      assert.equal(
        writerModule.classifyBatchState(batch, observed),
        'all-expected-after',
      )

      // Re-running the batch performs NO duplicate write.
      const result = await writerModule.commitCopyBatch({ firestore, batch })
      assert.equal(result.applied, 0)
      assert.equal(result.skipped, 1)

      // A divergent target instead blocks rather than being treated as success.
      await firestore.doc(targetPath).set({ ...body, balance: 999 })
      await assert.rejects(
        writerModule.commitCopyBatch({ firestore, batch }),
        error => error.category === 'state-diverged',
      )

      await firestore.doc(targetPath).delete()
    })

  test('a rehearsal write authorization cannot name production', () => {
    assert.throws(
      () => validateRehearsalWriteAuthorization({
        projectId: 'morgan-bank',
        teacherUid: WRITER_TEACHER_UID,
        releaseId: 'phase3-rel-emulator',
        changeId: 'CHG-EMULATOR-001',
        authorizationId: 'AUTH-EMULATOR-001',
        snapshotId: 'SNAP-1',
        writeFreezeProof: 'FREEZE-1',
        credentialProvenance: 'emulator',
        preflightManifestId: 'd'.repeat(64),
        initializationExpectationsSha256: 'b'.repeat(64),
        copyExpectationsSha256: 'c'.repeat(64),
        notBefore: '2020-01-01T00:00:00.000Z',
        notAfter: '2099-01-01T00:00:00.000Z',
      }, {
        environment: emulatorEnvironment(),
        expectedReleaseId: 'phase3-rel-emulator',
        nowMillis: Date.now(),
      }),
      error => error.code === 'PHASE3_PRODUCTION_ENVIRONMENT_ERROR',
    )
  })
})
