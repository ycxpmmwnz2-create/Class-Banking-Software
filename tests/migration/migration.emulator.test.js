// Phase 2A Item 9 — end-to-end Firestore emulator rehearsal.
//
// Run from the repository root with:
//   npm run test:migration
// which wraps `firebase emulators:exec --only firestore` around
// `node --test tests/migration`. The emulator harness supplies
// FIRESTORE_EMULATOR_HOST itself; this suite never assumes a developer
// exported it in another terminal, and never contacts a real project.
//
// Every scenario gets its own disposable emulator project ID, which in the
// Firestore emulator is a fully separate database. That gives per-scenario
// isolation of the flat legacy collections (`morganBank/classroomData`,
// `studentCredentials`, `studentAuthLogs`) and, because the project ID is part
// of the canonical manifest slot hash, a distinct manifest file per scenario.
//
// This suite exercises the real reader, foundation validator, projection,
// destination preflight, manifest state machine, batch writer, restart
// recovery, reconciliation, and CLI/orchestrator contracts against real
// Firebase Admin Firestore behavior. It does not re-implement the focused
// unit coverage that already lives in functions/phase2/*.test.js.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PHASE2_DIRECTORY = path.join(REPO_ROOT, 'functions', 'phase2')

// Step 2: the emulator harness owns FIRESTORE_EMULATOR_HOST. Assert it is
// present before importing anything that guards on it at module load.
assert.ok(
  typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0,
  'FIRESTORE_EMULATOR_HOST must be supplied by the emulator harness; ' +
    'run this suite through `npm run test:migration`.',
)

const { runMain, EXIT_CODES } = await import(
  '../../functions/phase2/run.js'
)
const {
  CANONICAL_STATE_DIRECTORY,
  deriveCanonicalManifestSlot,
} = await import('../../functions/phase2/manifestSlot.js')
const { serializeCanonicalState } = await import(
  '../../functions/phase2/canonicalState.js'
)
const {
  MANIFEST_BATCH_STATES,
  MANIFEST_MODES,
  MANIFEST_OPERATION_STATES,
  MANIFEST_RUN_STATES,
} = await import('../../functions/phase2/manifest.js')
const {
  LEGACY_CLASSROOM_ID,
  STUDENT_DESTINATION_FIELDS,
  projectStudentBody,
} = await import('../../functions/phase2/projection.js')
const {
  INVALID_DOCUMENT_ID_TARGETS,
  REHEARSAL_FIXTURE_SIZES,
  SECRET_BEARING_FIELD_NAMES,
  SYNTHETIC_PIN_HASH_PREFIX,
  SYNTHETIC_PLAINTEXT_PINS,
  buildClassroomSettingsMutation,
  buildCorrectedStudentBalanceMutation,
  buildCredentialInvariantMutation,
  buildDivergentAuthLogDocument,
  buildDivergentStudentDocument,
  buildRehearsalFixture,
} = await import('../../functions/phase2/rehearsalFixture.js')
const {
  RehearsalSeedError,
  REHEARSAL_SEED_ERROR_CATEGORIES,
  Timestamp,
  closeRehearsalAdminApps,
  requireDisposableProjectId,
  seedRehearsal,
} = await import('../../functions/phase2/seedRehearsal.js')

const PROJECT_BASE = 'morgan-bank-migration-rehearsal'
const TEST_RUN_TOKEN = `${process.pid}-${randomBytes(6).toString('hex')}`

// Every manifest slot this suite creates, so cleanup can remove exactly those
// files and nothing else.
const testIdentities = []

// Every seeded scenario and its initial document paths. The final invariant
// check proves no source/foundation document disappeared anywhere in the
// rehearsal, including scenarios that intentionally stop on an error.
const seededScenarios = []

// Every line the CLI logged anywhere in this suite, for the secret-leak scan.
const capturedOutput = []

// The `.state` directory contents that existed before this suite ran. Cleanup
// must leave every one of them byte-for-byte intact — an operator's unresolved
// canonical manifest may well be sitting there.
let preexistingStateFiles = new Map()

function scenarioIdentity(key) {
  const projectId = `${PROJECT_BASE}-${key}`
  // The per-process token prevents a prior interrupted test run from ever
  // colliding with this run's canonical manifest slot. Project IDs remain
  // stable so scenario names stay legible in emulator diagnostics; identity
  // uniqueness comes from the teacher UID, which is also part of the slot.
  const teacherUid = `rehearsal-teacher-${TEST_RUN_TOKEN}-${key}`
  const slot = deriveCanonicalManifestSlot({
    emulatorProjectId: projectId,
    teacherUid,
  })

  testIdentities.push({ projectId, teacherUid, slot })
  return { projectId, teacherUid, slot }
}

async function setupScenario(key, fixtureOptions = {}) {
  const { projectId, teacherUid, slot } = scenarioIdentity(key)
  const fixture = buildRehearsalFixture(fixtureOptions)
  const seeded = await seedRehearsal({ projectId, teacherUid, fixture })
  const initialPaths = await documentPathSnapshot(
    seeded.firestore,
    seeded.classroomId,
  )

  seededScenarios.push({
    key,
    firestore: seeded.firestore,
    classroomId: seeded.classroomId,
    initialPaths,
  })

  return { ...seeded, slot }
}

function recordingLogger() {
  const lines = []

  return {
    lines,
    log(...args) {
      lines.push(args.join(' '))
    },
    error(...args) {
      lines.push(args.join(' '))
    },
  }
}

function cliArguments({ projectId, teacherUid }, { write = false } = {}) {
  const argv = [
    '--teacher-uid', teacherUid,
    '--project-id', projectId,
  ]

  return write ? [...argv, '--write'] : argv
}

async function runCli(scenario, { write = false, ...dependencies } = {}) {
  const logger = recordingLogger()
  const outcome = await runMain(
    cliArguments(scenario, { write }),
    { logger, ...dependencies },
  )

  capturedOutput.push(...logger.lines)
  return { ...outcome, output: logger.lines.join('\n') }
}

function readManifestFile(slot) {
  return JSON.parse(fs.readFileSync(slot.manifestPath, 'utf8'))
}

function rewriteManifestFile(slot, mutate) {
  const manifest = readManifestFile(slot)
  mutate(manifest)
  fs.writeFileSync(slot.manifestPath, serializeCanonicalState(manifest))
  return manifest
}

/**
 * Rewrites a genuinely-planned canonical manifest into the one crash state a
 * live process cannot be stopped inside deterministically: writePhaseStarted
 * durably true, but no batch yet in flight or committed. Everything after this
 * point — discovery, recovery, monotonicity — is real production behavior.
 */
function simulateCrashAfterWritePhaseStarted(slot) {
  return rewriteManifestFile(slot, manifest => {
    manifest.mode = MANIFEST_MODES.WRITE
    manifest.runState = MANIFEST_RUN_STATES.WRITING
    manifest.writePhaseStarted = true
    manifest.inFlightBatchId = null
  })
}

/** Turns a retained planned manifest into a zero-write failed manifest. */
function simulateZeroWriteFailure(slot) {
  return rewriteManifestFile(slot, manifest => {
    manifest.runState = MANIFEST_RUN_STATES.FAILED
    manifest.writePhaseStarted = false
  })
}

/**
 * Wraps a real Firestore instance so a chosen batch commit reaches Firestore
 * and then reports an uncertain outcome. Document references, reads, and
 * transactions all pass through to the real SDK untouched.
 */
function withUncertainCommit(firestore, { failAfterCommitNumber }) {
  let commits = 0

  return {
    doc: docPath => firestore.doc(docPath),
    collection: collectionPath => firestore.collection(collectionPath),
    runTransaction: (...args) => firestore.runTransaction(...args),
    batch() {
      const batch = firestore.batch()

      return {
        create: (reference, data) => batch.create(reference, data),
        update: (reference, data, precondition) =>
          batch.update(reference, data, precondition),
        async commit() {
          const result = await batch.commit()
          commits += 1

          if (commits === failAfterCommitNumber) {
            // DEADLINE_EXCEEDED is not a clear rejection, so the writer must
            // treat the committed batch as an uncertain outcome.
            const error = new Error(
              'simulated deadline exceeded after a successful commit',
            )
            error.code = 4
            throw error
          }

          return result
        },
      }
    },
  }
}

/**
 * Wraps a real Firestore instance so a raw, out-of-band mutation lands between
 * preflight and the first batch commit — a genuine stale precondition.
 */
function withMutationBeforeFirstCommit(firestore, { docPath, data }) {
  let mutated = false

  return {
    doc: p => firestore.doc(p),
    collection: p => firestore.collection(p),
    runTransaction: (...args) => firestore.runTransaction(...args),
    batch() {
      const batch = firestore.batch()

      return {
        create: (reference, value) => batch.create(reference, value),
        update: (reference, value, precondition) =>
          batch.update(reference, value, precondition),
        async commit() {
          if (!mutated) {
            mutated = true
            await firestore.doc(docPath).update(data)
          }
          return batch.commit()
        },
      }
    },
  }
}

const RETAINED_DRIFT_CASES = Object.freeze([
  { key: 'source', label: 'immutable source' },
  { key: 'foundation', label: 'foundation invariant' },
  { key: 'classroom', label: 'classroom identity' },
  { key: 'plan', label: 'plan projection' },
])

/**
 * Applies exactly one retained-manifest drift to an otherwise untouched
 * scenario. Callers use a fresh scenario for every case because Firestore
 * updateTime is monotonic: writing an old body back cannot truly revert a
 * precondition or checksum envelope.
 */
async function applyRetainedDrift(scenario, driftKey) {
  const { firestore, teacherUid, classroomId, fixture } = scenario

  if (driftKey === 'source') {
    await firestore
      .doc('morganBank/classroomData')
      .update(buildCorrectedStudentBalanceMutation(fixture))
    return
  }

  if (driftKey === 'foundation') {
    await firestore
      .doc(`classrooms/${classroomId}`)
      .update({ name: 'Drifted Rehearsal Classroom' })
    return
  }

  if (driftKey === 'classroom') {
    const alternateClassroomId = `alternate-${TEST_RUN_TOKEN}`
    await firestore.doc(`classrooms/${alternateClassroomId}`).create({
      ownerUid: teacherUid,
      name: 'Alternate Rehearsal Classroom',
      createdAt: new Timestamp(1_700_000_000, 0),
      updatedAt: new Timestamp(1_700_000_000, 0),
      version: 1,
      settings: {},
    })
    await firestore
      .doc(`teachers/${teacherUid}`)
      .update({ classroomId: alternateClassroomId })
    return
  }

  if (driftKey === 'plan') {
    await firestore
      .doc('studentCredentials/bailey-cruz')
      .update({ failedAttempts: 7 })
    return
  }

  throw new TypeError(`Unknown retained drift case: ${driftKey}.`)
}

async function readDocument(firestore, documentPath) {
  const snapshot = await firestore.doc(documentPath).get()

  if (!snapshot.exists) {
    return null
  }

  return {
    data: snapshot.data(),
    updateTimeMillis: snapshot.updateTime.toMillis(),
  }
}

async function collectionPaths(firestore, collectionPath) {
  const snapshot = await firestore.collection(collectionPath).get()
  return snapshot.docs.map(document => document.ref.path)
}

/**
 * Every document path that matters to the migration, so a later comparison can
 * prove nothing was ever deleted.
 */
async function documentPathSnapshot(firestore, classroomId) {
  const collections = [
    'morganBank',
    'studentCredentials',
    'studentAuthLogs',
    'teachers',
    'classrooms',
    `classrooms/${classroomId}/students`,
    `classrooms/${classroomId}/transactions`,
    `classrooms/${classroomId}/loginHistory`,
    `studentAuthLogs/${classroomId}/logs`,
  ]
  const paths = new Set()

  for (const collection of collections) {
    for (const documentPath of await collectionPaths(firestore, collection)) {
      paths.add(documentPath)
    }
  }

  return paths
}

function assertNoDeletions(before_, after_, label) {
  const missing = [...before_].filter(entry => !after_.has(entry))
  assert.deepEqual(missing, [], `${label}: documents disappeared`)
}

/** Every destination path in a manifest's operation plan. */
function manifestOperationPaths(manifest) {
  return manifest.operations.map(operation => operation.path)
}

function collectObjectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectObjectKeys(entry, keys)
    }
    return keys
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key)
      collectObjectKeys(nested, keys)
    }
  }

  return keys
}

function collectStringValues(value, values = []) {
  if (typeof value === 'string') {
    values.push(value)
    return values
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringValues(entry, values)
    }
    return values
  }

  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectStringValues(nested, values)
    }
  }

  return values
}

function assertManifestCarriesNoSecrets(manifest, label) {
  const keys = collectObjectKeys(manifest)

  for (const forbidden of SECRET_BEARING_FIELD_NAMES) {
    assert.ok(
      !keys.has(forbidden),
      `${label}: manifest must not contain a "${forbidden}" field`,
    )
  }

  for (const value of collectStringValues(manifest)) {
    assert.ok(
      !value.includes(SYNTHETIC_PIN_HASH_PREFIX),
      `${label}: manifest must not contain PIN hash material`,
    )
  }
}

function readStateDirectoryFiles() {
  if (!fs.existsSync(CANONICAL_STATE_DIRECTORY)) {
    return new Map()
  }

  return new Map(fs.readdirSync(CANONICAL_STATE_DIRECTORY).map(name => [
    name,
    fs.readFileSync(path.join(CANONICAL_STATE_DIRECTORY, name)),
  ]))
}

/**
 * Removes only this suite's own manifest files, addressed by their exact
 * canonical filenames, plus any crash artifact sharing that exact filename
 * prefix. No globs, no recursion, no wildcard sweep of `.state`.
 */
function cleanupTestManifests() {
  const removed = []

  for (const { slot } of testIdentities) {
    if (fs.existsSync(slot.manifestPath)) {
      fs.unlinkSync(slot.manifestPath)
      removed.push(slot.filename)
    }

    const temporaryPrefix = `${slot.filename}.`
    for (const name of fs.readdirSync(slot.stateDirectory)) {
      if (name.startsWith(temporaryPrefix)) {
        fs.unlinkSync(path.join(slot.stateDirectory, name))
        removed.push(name)
      }
    }
  }

  return removed
}

function gitCheckIgnore(relativePath) {
  try {
    execFileSync('git', ['check-ignore', '-q', relativePath], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function readModuleSource(fileName) {
  return fs.readFileSync(path.join(PHASE2_DIRECTORY, fileName), 'utf8')
}

before(() => {
  preexistingStateFiles = readStateDirectoryFiles()
})

after(async () => {
  cleanupTestManifests()
  await closeRehearsalAdminApps()
})

// ---------------------------------------------------------------------------
// Steps 3, 9, 20 — canonical slot, CLI safety, and repository hygiene. None of
// this touches Firestore.
// ---------------------------------------------------------------------------

describe('canonical slot, CLI safety, and module boundaries', () => {
  test('the canonical slot is module-anchored and identity-derived', () => {
    const identity = {
      emulatorProjectId: `${PROJECT_BASE}-slot`,
      teacherUid: 'rehearsal-teacher-slot',
    }
    const slot = deriveCanonicalManifestSlot(identity)

    assert.equal(slot.stateDirectory, CANONICAL_STATE_DIRECTORY)
    assert.equal(
      path.resolve(slot.stateDirectory),
      path.resolve(path.join(PHASE2_DIRECTORY, '.state')),
    )
    assert.equal(slot.manifestPath, path.join(slot.stateDirectory, slot.filename))

    // Step 9: a different project or teacher resolves a different slot.
    const otherProject = deriveCanonicalManifestSlot({
      ...identity,
      emulatorProjectId: `${identity.emulatorProjectId}-other`,
    })
    const otherTeacher = deriveCanonicalManifestSlot({
      ...identity,
      teacherUid: `${identity.teacherUid}-other`,
    })

    assert.notEqual(otherProject.manifestPath, slot.manifestPath)
    assert.notEqual(otherTeacher.manifestPath, slot.manifestPath)
    assert.equal(otherProject.stateDirectory, slot.stateDirectory)

    // The slot cannot be steered by an override input.
    assert.throws(
      () => deriveCanonicalManifestSlot({ ...identity, stateDirectory: os.tmpdir() }),
      TypeError,
    )
  })

  test('canonical slot resolution ignores the current working directory', () => {
    const identity = {
      emulatorProjectId: `${PROJECT_BASE}-cwd`,
      teacherUid: 'rehearsal-teacher-cwd',
    }
    const fromRepositoryRoot = deriveCanonicalManifestSlot(identity)
    const originalCwd = process.cwd()
    const temporaryCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'phase2a-rehearsal-cwd-'),
    )

    try {
      process.chdir(temporaryCwd)
      assert.notEqual(process.cwd(), originalCwd)
      assert.deepEqual(
        deriveCanonicalManifestSlot(identity),
        fromRepositoryRoot,
      )
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(temporaryCwd, { recursive: true, force: true })
    }
  })

  test('every manifest and state override flag is rejected before Firestore access', async () => {
    for (const override of [
      '--manifest',
      '--state-dir',
      '--manifest-dir',
      '--manifest-file',
      '--manifest-filename',
    ]) {
      for (const argv of [
        [override, path.join(os.tmpdir(), 'bypass.manifest.json')],
        [`${override}=${path.join(os.tmpdir(), 'bypass.manifest.json')}`],
      ]) {
        let firestoreFactoryCalls = 0
        const logger = recordingLogger()
        const { exitCode, error } = await runMain(
          [
            '--teacher-uid', 'rehearsal-teacher-override',
            '--project-id', `${PROJECT_BASE}-override`,
            ...argv,
          ],
          {
            logger,
            firestoreFactory() {
              firestoreFactoryCalls += 1
              return {}
            },
          },
        )

        capturedOutput.push(...logger.lines)
        assert.equal(exitCode, EXIT_CODES.VALIDATION_FAILURE)
        assert.equal(error.name, 'CliArgumentError')
        assert.equal(error.category, 'unsupported-override')
        assert.equal(firestoreFactoryCalls, 0)
      }
    }
  })

  test('the rehearsal seeder refuses production and non-disposable project IDs', () => {
    assert.throws(
      () => requireDisposableProjectId('morgan-bank'),
      error => {
        assert.ok(error instanceof RehearsalSeedError)
        assert.equal(
          error.category,
          REHEARSAL_SEED_ERROR_CATEGORIES.PROHIBITED_PROJECT_ID,
        )
        return true
      },
    )

    assert.throws(
      () => requireDisposableProjectId('some-real-production-project'),
      error => {
        assert.equal(
          error.category,
          REHEARSAL_SEED_ERROR_CATEGORIES.NON_DISPOSABLE_PROJECT_ID,
        )
        return true
      },
    )

    assert.equal(requireDisposableProjectId(PROJECT_BASE), PROJECT_BASE)
  })

  test('the rehearsal seeder refuses to start without the emulator host', () => {
    const childEnvironment = { ...process.env }
    delete childEnvironment.FIRESTORE_EMULATOR_HOST

    assert.throws(
      () => execFileSync(
        process.execPath,
        [
          path.join(PHASE2_DIRECTORY, 'seedRehearsal.js'),
          '--project-id', PROJECT_BASE,
          '--teacher-uid', 'rehearsal-emulator-guard',
        ],
        {
          cwd: REPO_ROOT,
          env: childEnvironment,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      ),
      error => {
        assert.equal(error.status, 1)
        assert.match(
          `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
          /FIRESTORE_EMULATOR_HOST/,
        )
        return true
      },
    )
  })

  test('step 20: the repository ignores runtime manifest state without tracking it', () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
    const lines = gitignore.split('\n').map(line => line.trim())

    assert.ok(
      lines.includes('functions/phase2/.state/'),
      '.gitignore must contain the exact functions/phase2/.state/ entry',
    )
    assert.ok(
      !lines.some(line => line.includes('**/.state')),
      '.gitignore must not introduce a broad **/.state rule',
    )
    assert.ok(gitCheckIgnore('functions/phase2/.state/example.manifest.json'))

    const trackedStateFiles = execFileSync(
      'git',
      ['ls-files', 'functions/phase2/.state/'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim()
    assert.equal(trackedStateFiles, '')

    if (fs.existsSync(CANONICAL_STATE_DIRECTORY)) {
      assert.ok(
        !fs.readdirSync(CANONICAL_STATE_DIRECTORY).includes('.gitkeep'),
        'no .gitkeep may be introduced inside the runtime state directory',
      )
    }
  })

  test('module boundaries hold: one writer, no deletes, independent validator', () => {
    const runtimeModules = [
      'canonicalState.js',
      'cli.js',
      'destinationPreflight.js',
      'emulatorEnvironment.js',
      'firestoreDocumentId.js',
      'foundationValidator.js',
      'manifest.js',
      'manifestSlot.js',
      'migrateClassroomData.js',
      'projection.js',
      'reconciliation.js',
      'run.js',
      'sourceReader.js',
      'batchWriter.js',
    ]

    for (const moduleName of runtimeModules) {
      const source = readModuleSource(moduleName)

      for (const forbidden of [
        'recursiveDelete',
        'bulkWriter',
        'FieldValue.delete',
        'batch.delete',
      ]) {
        assert.ok(
          !source.includes(forbidden),
          `${moduleName} must not reference ${forbidden}`,
        )
      }

      assert.ok(
        !source.includes('seedRehearsal.js'),
        `${moduleName} must not import the rehearsal seeder`,
      )
      assert.ok(
        !source.includes('rehearsalFixture.js'),
        `${moduleName} must not import the rehearsal fixture`,
      )

      if (moduleName !== 'batchWriter.js') {
        assert.ok(
          !/\.batch\s*\(/.test(source),
          `${moduleName} must not open a Firestore write batch`,
        )
      }
    }

    // The independent validator must never reuse the Phase 1 provisioner.
    assert.ok(
      !readModuleSource('foundationValidator.js')
        .includes('teacherClassroomProvisioner'),
      'foundationValidator.js must remain independent of the Phase 1 provisioner',
    )

    // The seeder is the only module allowed to call the provisioner, and it
    // does so strictly before the migration runtime starts.
    assert.ok(
      readModuleSource('seedRehearsal.js')
        .includes('teacherClassroomProvisioner.js'),
    )
    assert.ok(
      readModuleSource('batchWriter.js').includes('batch.create'),
      'batchWriter.js remains the only migration destination writer',
    )
  })
})

// ---------------------------------------------------------------------------
// Steps 4-12 — the primary rehearsal lifecycle on the full fixture.
// ---------------------------------------------------------------------------

describe('primary rehearsal lifecycle', () => {
  let scenario
  let pathsBeforeDryRun
  let plannedRunId
  let plannedManifest
  let destinationStateAfterWrite

  before(async () => {
    // Steps 4 and 5: seed the synthetic legacy fixture, then provision the
    // Phase 1 foundation, both strictly before any migration planning.
    scenario = await setupScenario('s01')
  })

  test('steps 4-5: the fixture and Phase 1 foundation are seeded', async () => {
    const { firestore, fixture, classroomId, teacherUid } = scenario

    assert.notEqual(classroomId, LEGACY_CLASSROOM_ID)

    const legacy = await readDocument(firestore, 'morganBank/classroomData')
    assert.ok(legacy)
    assert.equal(
      legacy.data.students.length,
      fixture.expected.studentIds.length,
    )

    const teacher = await readDocument(firestore, `teachers/${teacherUid}`)
    assert.equal(teacher.data.classroomId, classroomId)
    assert.equal(teacher.data.status, 'active')

    const classroom = await readDocument(firestore, `classrooms/${classroomId}`)
    assert.equal(classroom.data.ownerUid, teacherUid)
    assert.deepEqual(classroom.data.settings, {})

    assert.equal(
      (await collectionPaths(firestore, 'studentCredentials')).length,
      fixture.expected.credentialIds.length,
    )
    assert.equal(
      (await collectionPaths(firestore, 'studentAuthLogs')).length,
      fixture.expected.authLogIds.length,
    )

    pathsBeforeDryRun = await documentPathSnapshot(firestore, classroomId)
  })

  test('step 6: a dry run displays and creates the canonical manifest', async () => {
    // A deliberately small injected page size forces multiple paginated pages
    // for studentCredentials (10 documents) and studentAuthLogs (8) — the only
    // two paginated sources. `morganBank/classroomData` is one document whose
    // embedded arrays are read whole.
    assert.equal(fs.existsSync(scenario.slot.manifestPath), false)

    const { exitCode, result, canonicalPath, output } = await runCli(scenario, {
      pageSize: 4,
    })

    assert.equal(exitCode, EXIT_CODES.SUCCESS)
    assert.equal(canonicalPath, scenario.slot.manifestPath)
    assert.ok(
      output.includes(scenario.slot.manifestPath),
      'the CLI must display the resolved canonical manifest path',
    )
    assert.equal(result.mode, MANIFEST_MODES.DRY_RUN)
    assert.equal(result.writesApplied, 0)
    assert.ok(fs.existsSync(scenario.slot.manifestPath))

    plannedManifest = readManifestFile(scenario.slot)
    plannedRunId = plannedManifest.runId

    assert.equal(plannedManifest.runState, MANIFEST_RUN_STATES.PLANNED)
    assert.equal(plannedManifest.writePhaseStarted, false)
    assert.equal(plannedManifest.mode, MANIFEST_MODES.DRY_RUN)
    assert.equal(plannedManifest.emulatorProjectId, scenario.projectId)
    assert.equal(plannedManifest.teacherUid, scenario.teacherUid)
    assert.equal(plannedManifest.classroomId, scenario.classroomId)
    assert.equal(plannedManifest.inFlightBatchId, null)
    assert.ok(plannedRunId.length > 0)

    // Item 6 assigns exactly one operation per deterministic batch, so the
    // batch count equals the operation count.
    assert.equal(
      plannedManifest.operations.length,
      scenario.fixture.expected.operationCount,
    )
    assert.equal(
      plannedManifest.batches.length,
      scenario.fixture.expected.operationCount,
    )
    for (const batch of plannedManifest.batches) {
      assert.equal(batch.operationIds.length, 1)
    }

    assert.deepEqual(
      plannedManifest.orphanedCredentialPaths,
      [...scenario.fixture.expected.orphanedCredentialPaths],
    )
    assert.equal(plannedManifest.orphanedCredentialPaths.length, 4)

    // Every paginated source document reached the plan despite pageSize 4.
    const planPaths = new Set(manifestOperationPaths(plannedManifest))
    for (const credentialId of scenario.fixture.expected.credentialIds) {
      assert.ok(planPaths.has(`studentCredentials/${credentialId}`))
    }
    for (const logId of scenario.fixture.expected.authLogIds) {
      assert.ok(
        planPaths.has(
          `studentAuthLogs/${scenario.classroomId}/logs/${logId}`,
        ),
      )
    }

    assertManifestCarriesNoSecrets(plannedManifest, 'planned manifest')
  })

  test('step 7: the dry run performed zero destination writes', async () => {
    const { firestore, classroomId } = scenario

    for (const operationPath of manifestOperationPaths(plannedManifest)) {
      const document = await readDocument(firestore, operationPath)

      if (operationPath === `classrooms/${classroomId}`) {
        // The classroom root pre-exists; it must be untouched.
        assert.deepEqual(document.data.settings, {})
        assert.equal(Object.hasOwn(document.data, 'lastBackupAt'), false)
        continue
      }

      if (operationPath.startsWith('studentCredentials/')) {
        assert.equal(document.data.classroomId, LEGACY_CLASSROOM_ID)
        continue
      }

      assert.equal(document, null, `${operationPath} must not exist yet`)
    }

    const pathsAfterDryRun = await documentPathSnapshot(firestore, classroomId)
    assert.deepEqual(
      [...pathsAfterDryRun].sort(),
      [...pathsBeforeDryRun].sort(),
    )
  })

  test('step 8: another working directory resolves the same slot and runId', async () => {
    const originalCwd = process.cwd()
    const temporaryCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'phase2a-rehearsal-cwd-'),
    )

    try {
      process.chdir(temporaryCwd)

      // Default page size this time: paginated reads must produce an
      // identical plan, so the retained runId is kept rather than replaced.
      const { exitCode, canonicalPath, result } = await runCli(scenario)

      assert.equal(exitCode, EXIT_CODES.SUCCESS)
      assert.equal(canonicalPath, scenario.slot.manifestPath)
      assert.equal(result.manifest.runId, plannedRunId)
      assert.equal(result.manifest.runState, MANIFEST_RUN_STATES.PLANNED)
      assert.equal(result.writesApplied, 0)

      // CLI-level proof: a real child process with a different cwd resolves
      // the same canonical path and still consumes the retained plan.
      const childOutput = execFileSync(
        process.execPath,
        [
          path.join(PHASE2_DIRECTORY, 'run.js'),
          ...cliArguments(scenario),
        ],
        { cwd: temporaryCwd, encoding: 'utf8', env: process.env },
      )

      capturedOutput.push(childOutput)
      assert.ok(childOutput.includes(scenario.slot.manifestPath))
      assert.ok(childOutput.includes('finished successfully'))
      assert.equal(readManifestFile(scenario.slot).runId, plannedRunId)
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(temporaryCwd, { recursive: true, force: true })
    }
  })

  test('step 20: a retained plan cannot be bypassed with a path override', async () => {
    const before_ = fs.readFileSync(scenario.slot.manifestPath)

    for (const override of ['--manifest', '--state-dir', '--manifest-filename']) {
      const logger = recordingLogger()
      const { exitCode, error } = await runMain(
        [
          ...cliArguments(scenario, { write: true }),
          override,
          path.join(os.tmpdir(), 'bypass.manifest.json'),
        ],
        { logger },
      )

      capturedOutput.push(...logger.lines)
      assert.equal(exitCode, EXIT_CODES.VALIDATION_FAILURE)
      assert.equal(error.category, 'unsupported-override')
    }

    assert.deepEqual(fs.readFileSync(scenario.slot.manifestPath), before_)
  })

  test('step 10: --write consumes the retained canonical manifest', async () => {
    const { firestore, classroomId } = scenario
    const { exitCode, result } = await runCli(scenario, { write: true })

    assert.equal(exitCode, EXIT_CODES.SUCCESS)
    assert.equal(result.mode, MANIFEST_MODES.WRITE)
    assert.equal(result.manifest.runId, plannedRunId)
    assert.equal(result.manifest.runState, MANIFEST_RUN_STATES.COMPLETED)
    assert.equal(result.manifest.writePhaseStarted, true)
    assert.equal(
      result.writesApplied,
      scenario.fixture.expected.operationCount,
    )

    const durable = readManifestFile(scenario.slot)
    assert.equal(durable.runState, MANIFEST_RUN_STATES.COMPLETED)
    assert.equal(durable.mode, MANIFEST_MODES.WRITE)
    for (const batch of durable.batches) {
      assert.equal(batch.state, MANIFEST_BATCH_STATES.VERIFIED)
    }
    for (const operation of durable.operations) {
      assert.equal(operation.state, MANIFEST_OPERATION_STATES.VERIFIED)
    }
    assertManifestCarriesNoSecrets(durable, 'completed manifest')

    // Capture every destination's body and updateTime so step 12 can prove
    // read-only idempotency.
    destinationStateAfterWrite = new Map()
    for (const operationPath of manifestOperationPaths(durable)) {
      destinationStateAfterWrite.set(
        operationPath,
        await readDocument(firestore, operationPath),
      )
    }

    assertNoDeletions(
      pathsBeforeDryRun,
      await documentPathSnapshot(firestore, classroomId),
      'after write run',
    )
  })

  test('step 11: post-write reconciliation and destination invariants hold', async () => {
    const { firestore, fixture, classroomId, teacherUid } = scenario
    const durable = readManifestFile(scenario.slot)
    const summary = durable.reconciliationSummary

    assert.equal(summary.mode, MANIFEST_MODES.WRITE)
    assert.equal(summary.passed, true)
    for (const [key, value] of Object.entries(summary.equality)) {
      assert.equal(value, true, `reconciliation equality.${key} must hold`)
    }
    assert.deepEqual(summary.counts, {
      students: fixture.expected.studentIds.length,
      transactions: fixture.expected.transactionIds.length,
      loginHistory: fixture.expected.loginHistoryIds.length,
      studentCredentials: fixture.expected.credentialIds.length,
      studentAuthLogs: fixture.expected.authLogIds.length,
      orphanedCredentials: fixture.expected.orphanedCredentialPaths.length,
    })

    // Destination student documents carry exactly the allowlisted fields.
    const allowedStudentFields = [...STUDENT_DESTINATION_FIELDS].sort()
    for (const studentId of fixture.expected.studentIds) {
      const student = await readDocument(
        firestore,
        `classrooms/${classroomId}/students/${studentId}`,
      )
      assert.ok(student, `student ${studentId} must exist`)
      assert.deepEqual(
        Object.keys(student.data).sort(),
        allowedStudentFields,
        `student ${studentId} destination keys must be exactly the allowlist`,
      )
    }

    // Transactions are filtered per student; the withdrawn-student
    // transaction still migrates as its own document but belongs to nobody.
    const avery = await readDocument(
      firestore,
      `classrooms/${classroomId}/students/s1`,
    )
    assert.deepEqual(
      avery.data.transactions.map(entry => entry.id),
      ['t1', 't2'],
    )
    const casey = await readDocument(
      firestore,
      `classrooms/${classroomId}/students/s3`,
    )
    assert.deepEqual(casey.data.transactions, [])

    for (const transactionId of fixture.expected.transactionIds) {
      assert.ok(await readDocument(
        firestore,
        `classrooms/${classroomId}/transactions/${transactionId}`,
      ))
    }
    for (const historyId of fixture.expected.loginHistoryIds) {
      assert.ok(await readDocument(
        firestore,
        `classrooms/${classroomId}/loginHistory/${historyId}`,
      ))
    }

    // Classroom root: only settings and lastBackupAt changed.
    const classroom = await readDocument(firestore, `classrooms/${classroomId}`)
    assert.deepEqual(
      classroom.data.settings,
      fixture.classroomData.data.settings,
    )
    assert.deepEqual(
      classroom.data.lastBackupAt,
      fixture.classroomData.data.lastBackupAt,
    )
    assert.equal(classroom.data.ownerUid, teacherUid)
    assert.equal(classroom.data.version, 1)
    assert.equal(classroom.data.name, 'Rehearsal Classroom')

    // Credentials: only classroomId changed; every state survived.
    for (const credential of fixture.studentCredentials) {
      const stored = await readDocument(firestore, credential.path)
      assert.equal(stored.data.classroomId, classroomId)
      assert.notEqual(stored.data.classroomId, LEGACY_CLASSROOM_ID)

      const expectedInvariant = { ...credential.data }
      delete expectedInvariant.classroomId
      const actualInvariant = { ...stored.data }
      delete actualInvariant.classroomId
      assert.deepEqual(actualInvariant, expectedInvariant, credential.path)
    }

    // Auth logs: classroom-scoped copies never retain classroomId, and the
    // original flat documents are untouched.
    for (const log of fixture.studentAuthLogs) {
      const migrated = await readDocument(
        firestore,
        `studentAuthLogs/${classroomId}/logs/${log.id}`,
      )
      assert.ok(migrated)
      assert.equal(Object.hasOwn(migrated.data, 'classroomId'), false)

      const expectedBody = { ...log.data }
      delete expectedBody.classroomId
      assert.deepEqual(migrated.data, expectedBody)

      const original = await readDocument(firestore, log.path)
      assert.deepEqual(original.data, log.data)
    }

    // The legacy source document is never touched.
    const legacy = await readDocument(firestore, 'morganBank/classroomData')
    assert.deepEqual(legacy.data, fixture.classroomData.data)

    // The literal legacy classroom ID never appears as a V2 classroomId.
    assert.equal(
      await readDocument(firestore, `classrooms/${LEGACY_CLASSROOM_ID}`),
      null,
    )
    for (const operationPath of manifestOperationPaths(durable)) {
      assert.ok(
        !operationPath.startsWith(`classrooms/${LEGACY_CLASSROOM_ID}/`),
        `no destination may live under the legacy classroom: ${operationPath}`,
      )
    }
  })

  test('step 12: a second --write is read-only reverification', async () => {
    const { firestore, classroomId } = scenario
    const manifestBefore = fs.readFileSync(scenario.slot.manifestPath)
    const { exitCode, result } = await runCli(scenario, { write: true })

    assert.equal(exitCode, EXIT_CODES.SUCCESS)
    assert.equal(result.reverified, true)
    assert.equal(result.writesApplied, 0)
    assert.equal(result.manifest.runId, plannedRunId)
    assert.equal(result.manifest.runState, MANIFEST_RUN_STATES.COMPLETED)

    // A completed manifest is read-only: not one byte changes.
    assert.deepEqual(
      fs.readFileSync(scenario.slot.manifestPath),
      manifestBefore,
    )

    // No destination write was reapplied: bodies and updateTimes are identical.
    for (const [operationPath, expected] of destinationStateAfterWrite) {
      const actual = await readDocument(firestore, operationPath)
      assert.deepEqual(actual.data, expected.data, operationPath)
      assert.equal(
        actual.updateTimeMillis,
        expected.updateTimeMillis,
        `${operationPath} must not be rewritten`,
      )
    }

    assertNoDeletions(
      pathsBeforeDryRun,
      await documentPathSnapshot(firestore, classroomId),
      'after idempotent write run',
    )
  })

  test('step 15: drift blocks a completed manifest under reverification', async () => {
    const { firestore, teacherUid, classroomId } = scenario
    const manifestBefore = fs.readFileSync(scenario.slot.manifestPath)

    await firestore
      .doc(`teachers/${teacherUid}`)
      .update({ displayName: 'Renamed After Completion' })

    const { exitCode, error } = await runCli(scenario, { write: true })

    assert.equal(exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(error.category, 'stale-manifest-drift')
    assert.deepEqual(
      fs.readFileSync(scenario.slot.manifestPath),
      manifestBefore,
      'a completed manifest is never rewritten by a blocked run',
    )

    // Reverting the content does NOT unblock it: the foundation invariant
    // checksum covers the whole teacher snapshot envelope, `updateTime`
    // included, so any write to that document is permanently visible as
    // drift. Reverification is read-only, so the conservative choice here
    // costs nothing but an explicit operator decision.
    await firestore
      .doc(`teachers/${teacherUid}`)
      .update({ displayName: 'Rehearsal Teacher' })

    const reverted = await runCli(scenario, { write: true })
    assert.equal(reverted.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(reverted.error.category, 'stale-manifest-drift')
    assert.deepEqual(
      fs.readFileSync(scenario.slot.manifestPath),
      manifestBefore,
      'a completed manifest stays byte-for-byte intact through both blocks',
    )

    assertNoDeletions(
      pathsBeforeDryRun,
      await documentPathSnapshot(firestore, classroomId),
      'after completed-manifest drift',
    )
  })
})

// ---------------------------------------------------------------------------
// Preflight classification: blocking-divergent, then skipped_identical.
// ---------------------------------------------------------------------------

describe('destination preflight classification', () => {
  let scenario
  let expectedStudentBody
  let expectedLogBody

  before(async () => {
    scenario = await setupScenario('s02', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
      includeLastBackupAt: false,
    })

    const legacy = scenario.fixture.classroomData.data
    expectedStudentBody = projectStudentBody({
      student: legacy.students[0],
      normalizedStudentId: 's1',
      transactions: legacy.transactions,
    })
    expectedLogBody = { ...scenario.fixture.studentAuthLogs[0].data }
    delete expectedLogBody.classroomId
  })

  test('a pre-seeded divergent destination is a blocking conflict', async () => {
    const { firestore, classroomId } = scenario

    await firestore
      .doc(`classrooms/${classroomId}/students/s1`)
      .create(buildDivergentStudentDocument())
    await firestore
      .doc(`studentAuthLogs/${classroomId}/logs/log-01`)
      .create(buildDivergentAuthLogDocument())

    const { exitCode, error } = await runCli(scenario)

    assert.equal(exitCode, EXIT_CODES.PREFLIGHT_CONFLICT)
    assert.equal(error.category, 'preflight-conflict')
    assert.equal(
      fs.existsSync(scenario.slot.manifestPath),
      false,
      'a blocked plan must not leave a manifest behind',
    )

    const conflicts = error.cause?.details?.conflicts ?? []
    assert.deepEqual(
      conflicts.map(conflict => conflict.reason).sort(),
      ['existing-create-body-differs', 'existing-create-body-differs'],
    )
  })

  test('correcting the divergence yields skipped_identical operations', async () => {
    const { firestore, classroomId, fixture } = scenario

    await firestore
      .doc(`classrooms/${classroomId}/students/s1`)
      .set(expectedStudentBody)
    await firestore
      .doc(`studentAuthLogs/${classroomId}/logs/log-01`)
      .set(expectedLogBody)

    const preseeded = new Map([
      [`classrooms/${classroomId}/students/s1`,
        await readDocument(firestore, `classrooms/${classroomId}/students/s1`)],
      [`studentAuthLogs/${classroomId}/logs/log-01`,
        await readDocument(
          firestore,
          `studentAuthLogs/${classroomId}/logs/log-01`,
        )],
    ])

    const dryRun = await runCli(scenario)
    assert.equal(dryRun.exitCode, EXIT_CODES.SUCCESS)

    const planned = readManifestFile(scenario.slot)
    const skipped = planned.operations.filter(operation =>
      operation.state === MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL)
    assert.deepEqual(
      skipped.map(operation => operation.path).sort(),
      [
        `classrooms/${classroomId}/students/s1`,
        `studentAuthLogs/${classroomId}/logs/log-01`,
      ].sort(),
    )
    assert.equal(
      planned.operations.filter(operation =>
        operation.state === MANIFEST_OPERATION_STATES.PLANNED).length,
      fixture.expected.operationCount - 2,
    )

    // A batch whose only operation is already identical is already verified.
    const skippedBatchIds = new Set(skipped.map(operation => operation.batchId))
    for (const batch of planned.batches) {
      assert.equal(
        batch.state,
        skippedBatchIds.has(batch.batchId)
          ? MANIFEST_BATCH_STATES.VERIFIED
          : MANIFEST_BATCH_STATES.PENDING,
      )
    }

    const writeRun = await runCli(scenario, { write: true })
    assert.equal(writeRun.exitCode, EXIT_CODES.SUCCESS)
    assert.equal(
      writeRun.result.writesApplied,
      fixture.expected.operationCount - 2,
    )
    assert.equal(
      writeRun.result.manifest.runState,
      MANIFEST_RUN_STATES.COMPLETED,
    )

    // The identical pre-seeded documents were never rewritten.
    for (const [documentPath, expected] of preseeded) {
      const actual = await readDocument(firestore, documentPath)
      assert.equal(actual.updateTimeMillis, expected.updateTimeMillis)
      assert.deepEqual(actual.data, expected.data)
    }

    // lastBackupAt was absent from the legacy source, so it normalizes to null.
    const classroom = await readDocument(firestore, `classrooms/${classroomId}`)
    assert.equal(classroom.data.lastBackupAt, null)
  })
})

// ---------------------------------------------------------------------------
// Stale preconditions.
// ---------------------------------------------------------------------------

describe('stale precondition handling', () => {
  test('a mutated credential invariant blocks write mode as retained drift', async () => {
    const scenario = await setupScenario('s03', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })
    const { firestore, classroomId } = scenario

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const planned = readManifestFile(scenario.slot)
    const credentialPath = 'studentCredentials/avery-diaz'
    const retainedPrecondition = planned.operations
      .find(operation => operation.path === credentialPath)
      .updateTimePrecondition
    const pathsBefore = await documentPathSnapshot(firestore, classroomId)

    // A raw update outside the migration tooling advances updateTime and
    // changes the credential invariant.
    await firestore
      .doc(credentialPath)
      .update(buildCredentialInvariantMutation())

    // Preflight cannot see this as a destination conflict: it rebuilds the
    // projection from the same freshly-read source, so the projected and
    // stored invariants agree. The retained manifest is what catches it —
    // its recorded credential invariant hash no longer matches.
    const blocked = await runCli(scenario, { write: true })
    assert.equal(blocked.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(blocked.error.category, 'stale-manifest-drift')
    assert.match(blocked.error.message, /checksum does not match/)

    // Nothing was written and the retained plan is intact.
    assert.equal(readManifestFile(scenario.slot).runId, planned.runId)
    assert.equal(
      await readDocument(firestore, `classrooms/${classroomId}/students/s1`),
      null,
    )

    // Restoring the value restores the invariant hash but not the update
    // time, so the retained precondition alone is now stale — and the write
    // is still refused rather than silently reapplied over the change.
    await firestore.doc(credentialPath).update({ failedAttempts: 0 })

    const stillBlocked = await runCli(scenario, { write: true })
    assert.equal(stillBlocked.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(stillBlocked.error.category, 'stale-manifest-drift')
    assert.match(
      stillBlocked.error.message,
      /does not match the current destination plan/,
    )
    // The retained precondition is untouched, while the live document has
    // moved past it — that gap is exactly what was refused.
    const retained = readManifestFile(scenario.slot)
    assert.equal(retained.runId, planned.runId)
    assert.deepEqual(
      retained.operations.find(operation => operation.path === credentialPath)
        .updateTimePrecondition,
      retainedPrecondition,
    )
    const liveCredential = await readDocument(firestore, credentialPath)
    const preconditionMillis = Math.round(
      retainedPrecondition.$phase2aFirestoreValue.seconds * 1000 +
        retainedPrecondition.$phase2aFirestoreValue.nanoseconds / 1e6,
    )
    assert.ok(liveCredential.updateTimeMillis > preconditionMillis)
    assertNoDeletions(
      pathsBefore,
      await documentPathSnapshot(firestore, classroomId),
      'after stale credential precondition',
    )
  })

  test('a mutated classroom root blocks write mode as retained-plan drift', async () => {
    const scenario = await setupScenario('s04', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })
    const { firestore, classroomId } = scenario

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const plannedRunId = readManifestFile(scenario.slot).runId

    await firestore
      .doc(`classrooms/${classroomId}`)
      .update(buildClassroomSettingsMutation())

    const blocked = await runCli(scenario, { write: true })
    assert.equal(blocked.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(blocked.error.category, 'stale-manifest-drift')

    // The out-of-band change survives; the migration never overwrote it.
    const classroom = await readDocument(firestore, `classrooms/${classroomId}`)
    assert.equal(classroom.data.settings.currencyName, 'Mutated Bucks')
    assert.equal(readManifestFile(scenario.slot).runId, plannedRunId)
    assert.equal(
      await readDocument(firestore, `classrooms/${classroomId}/students/s1`),
      null,
    )
  })

  test('a precondition that goes stale mid-write is rejected at commit', async () => {
    const scenario = await setupScenario('s05', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })
    const { firestore, classroomId } = scenario

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const pathsBefore = await documentPathSnapshot(firestore, classroomId)

    // The classroom-root update is batch-000001 (destination paths are sorted,
    // and the classroom document sorts before its subcollections). Mutating it
    // immediately before that commit makes the retained lastUpdateTime
    // precondition stale.
    const blocked = await runCli(scenario, {
      write: true,
      firestore: withMutationBeforeFirstCommit(firestore, {
        docPath: `classrooms/${classroomId}`,
        data: buildClassroomSettingsMutation(),
      }),
    })

    assert.equal(blocked.exitCode, EXIT_CODES.WRITE_FAILURE)
    assert.equal(blocked.error.category, 'write-failed')

    // The out-of-band write was not clobbered.
    const classroom = await readDocument(firestore, `classrooms/${classroomId}`)
    assert.equal(classroom.data.settings.currencyName, 'Mutated Bucks')

    const failed = readManifestFile(scenario.slot)
    assert.equal(failed.runState, MANIFEST_RUN_STATES.FAILED)
    assert.equal(failed.writePhaseStarted, true)
    assert.equal(failed.batches[0].state, MANIFEST_BATCH_STATES.FAILED)

    // Restart recovery finds the classroom root in neither the expected
    // before nor after state, so it blocks for human review.
    const divergent = await runCli(scenario, { write: true })
    assert.equal(divergent.exitCode, EXIT_CODES.PREFLIGHT_CONFLICT)
    assert.equal(divergent.error.category, 'recovery-divergent')
    assert.equal(readManifestFile(scenario.slot).writePhaseStarted, true)

    assertNoDeletions(
      pathsBefore,
      await documentPathSnapshot(firestore, classroomId),
      'after commit-time precondition failure',
    )
  })
})

// ---------------------------------------------------------------------------
// Blocking source anomalies: zero writes, zero manifest, in every case.
// ---------------------------------------------------------------------------

describe('blocking source anomalies', () => {
  test('an unexpected auth-log classroomId blocks the run', async () => {
    const scenario = await setupScenario('s06', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
      unexpectedAuthLogClassroomId: 'some-other-classroom',
    })
    const { firestore, classroomId } = scenario
    const pathsBefore = await documentPathSnapshot(firestore, classroomId)

    const { exitCode, error } = await runCli(scenario)

    assert.equal(exitCode, EXIT_CODES.VALIDATION_FAILURE)
    assert.equal(error.name, 'ProjectionError')
    assert.equal(error.category, 'auth-log-classroom-anomaly')
    assert.equal(fs.existsSync(scenario.slot.manifestPath), false)
    assert.deepEqual(
      [...await documentPathSnapshot(firestore, classroomId)].sort(),
      [...pathsBefore].sort(),
    )
  })

  test('a credential outside the legacy classroom blocks the run', async () => {
    const scenario = await setupScenario('s07', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
      invalidCredentialClassroomId: 'not-morgan',
    })
    const { exitCode, error } = await runCli(scenario)

    assert.equal(exitCode, EXIT_CODES.VALIDATION_FAILURE)
    assert.equal(error.category, 'credential-classroom-id-invalid')
    assert.equal(fs.existsSync(scenario.slot.manifestPath), false)
  })

  for (const [key, target] of [
    ['s08', INVALID_DOCUMENT_ID_TARGETS.STUDENTS],
    ['s09', INVALID_DOCUMENT_ID_TARGETS.TRANSACTIONS],
    ['s10', INVALID_DOCUMENT_ID_TARGETS.LOGIN_HISTORY],
  ]) {
    test(`invalid ${target} document IDs block the run with detailed rejections`, async () => {
      const scenario = await setupScenario(key, {
        size: REHEARSAL_FIXTURE_SIZES.SMALL,
        invalidDocumentIdTarget: target,
      })
      const { firestore, classroomId } = scenario
      const pathsBefore = await documentPathSnapshot(firestore, classroomId)

      const { exitCode, error } = await runCli(scenario)

      assert.equal(exitCode, EXIT_CODES.VALIDATION_FAILURE)
      assert.equal(error.name, 'ProjectionError')
      assert.equal(error.category, 'invalid-document-ids')
      assert.equal(error.details.collection, target)

      const categories = new Set(
        error.details.rejections.map(rejection => rejection.category),
      )
      for (const expected of [
        'undefined-value',
        'null-value',
        'empty-string',
        'whitespace-only-string',
        'leading-or-trailing-whitespace',
        'contains-slash',
        'dot-segment',
        'reserved-pattern',
        'utf8-byte-limit-exceeded',
        'boolean-value',
        'non-finite-number',
        'object-value',
        'array-value',
        'post-normalization-collision',
      ]) {
        assert.ok(
          categories.has(expected),
          `${target}: expected a ${expected} rejection`,
        )
      }

      // The numeric/string collision reports both members with partners.
      const collisions = error.details.rejections.filter(rejection =>
        rejection.category === 'post-normalization-collision')
      assert.equal(collisions.length, 2)
      assert.deepEqual(
        collisions.map(rejection => rejection.originalType).sort(),
        ['number', 'string'],
      )
      for (const collision of collisions) {
        assert.equal(collision.normalizedValue, '1')
        assert.equal(collision.collisionPartners.length, 1)
      }

      assert.equal(fs.existsSync(scenario.slot.manifestPath), false)
      assert.deepEqual(
        [...await documentPathSnapshot(firestore, classroomId)].sort(),
        [...pathsBefore].sort(),
      )
    })
  }
})

// ---------------------------------------------------------------------------
// Steps 13-15 — zero-write failed-manifest replacement and blocking rules.
// ---------------------------------------------------------------------------

describe('zero-write failed-manifest replacement', () => {
  test('step 13: a corrected source produces new checksums, plan, and runId', async () => {
    const scenario = await setupScenario('s11', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })
    const { firestore, classroomId } = scenario

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const original = readManifestFile(scenario.slot)
    simulateZeroWriteFailure(scenario.slot)

    // Correct the legacy source so the immutable-source checksum and the
    // projected plan both change.
    await firestore
      .doc('morganBank/classroomData')
      .update(buildCorrectedStudentBalanceMutation(scenario.fixture))

    const replaced = await runCli(scenario)
    assert.equal(replaced.exitCode, EXIT_CODES.SUCCESS)

    const fresh = readManifestFile(scenario.slot)
    assert.equal(fresh.runState, MANIFEST_RUN_STATES.PLANNED)
    assert.equal(fresh.writePhaseStarted, false)
    assert.notEqual(fresh.runId, original.runId)
    assert.notEqual(
      fresh.immutableSourceChecksum,
      original.immutableSourceChecksum,
    )
    assert.notEqual(fresh.planChecksum, original.planChecksum)
    assert.notDeepEqual(fresh.operations, original.operations)
    assert.equal(fresh.classroomId, classroomId)

    // Replacement still reruns the complete brand-new validation, including
    // the credential classroomId === "morgan" requirement.
    simulateZeroWriteFailure(scenario.slot)
    const failedBytes = fs.readFileSync(scenario.slot.manifestPath)
    await firestore
      .doc('studentCredentials/avery-diaz')
      .update({ classroomId: 'not-morgan' })

    const rejected = await runCli(scenario)
    assert.equal(rejected.exitCode, EXIT_CODES.VALIDATION_FAILURE)
    assert.equal(rejected.error.category, 'credential-classroom-id-invalid')
    assert.deepEqual(
      fs.readFileSync(scenario.slot.manifestPath),
      failedBytes,
      'a rejected replacement leaves the failed manifest byte-for-byte intact',
    )
  })

  test('step 14: replacement waits for a foundation that passes every validator', async () => {
    const scenario = await setupScenario('s12', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })
    const { firestore, teacherUid, classroomId } = scenario

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const original = readManifestFile(scenario.slot)
    simulateZeroWriteFailure(scenario.slot)
    const failedBytes = fs.readFileSync(scenario.slot.manifestPath)

    // Break the foundation behind the zero-write failure.
    await firestore.doc(`teachers/${teacherUid}`).update({ status: 'disabled' })

    const blocked = await runCli(scenario)
    assert.equal(blocked.exitCode, EXIT_CODES.VALIDATION_FAILURE)
    assert.equal(blocked.error.name, 'FoundationValidationError')
    assert.equal(blocked.error.category, 'teacher-not-active')
    assert.deepEqual(fs.readFileSync(scenario.slot.manifestPath), failedBytes)

    // Correct the foundation: replacement now succeeds.
    await firestore.doc(`teachers/${teacherUid}`).update({ status: 'active' })
    const replaced = await runCli(scenario)
    assert.equal(replaced.exitCode, EXIT_CODES.SUCCESS)

    const fresh = readManifestFile(scenario.slot)
    assert.notEqual(fresh.runId, original.runId)
    assert.notEqual(
      fresh.foundationInvariantChecksum,
      original.foundationInvariantChecksum,
    )
    assert.equal(fresh.classroomId, classroomId)

    // Force a different validation failure and prove the old failed manifest
    // survives byte-for-byte rather than being partially replaced.
    simulateZeroWriteFailure(scenario.slot)
    const secondFailedBytes = fs.readFileSync(scenario.slot.manifestPath)
    await firestore.doc(`classrooms/${classroomId}`).update({ version: 99 })

    const rejected = await runCli(scenario)
    assert.equal(rejected.exitCode, EXIT_CODES.VALIDATION_FAILURE)
    assert.equal(rejected.error.category, 'classroom-version-mismatch')
    assert.deepEqual(
      fs.readFileSync(scenario.slot.manifestPath),
      secondFailedBytes,
    )
  })

  test('step 15: drift blocks a retained planned manifest in every direction', async () => {
    const scenario = await setupScenario('s13', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })
    const { firestore, teacherUid, classroomId, fixture } = scenario

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const plannedRunId = readManifestFile(scenario.slot).runId

    // A second, valid classroom this teacher owns, so classroom identity can
    // drift while the foundation still validates.
    const alternateClassroomId = 'rehearsal-alternate-classroom'
    await firestore.doc(`classrooms/${alternateClassroomId}`).create({
      ownerUid: teacherUid,
      name: 'Alternate Rehearsal Classroom',
      createdAt: new Timestamp(1_700_000_000, 0),
      updatedAt: new Timestamp(1_700_000_000, 0),
      version: 1,
      settings: {},
    })

    const driftCases = [
      {
        label: 'immutable source drift',
        async apply() {
          await firestore
            .doc('morganBank/classroomData')
            .update({ settings: { ...fixture.classroomData.data.settings, payDay: 'monday' } })
        },
        async revert() {
          await firestore
            .doc('morganBank/classroomData')
            .update({ settings: fixture.classroomData.data.settings })
        },
      },
      {
        label: 'foundation invariant drift',
        async apply() {
          await firestore
            .doc(`classrooms/${classroomId}`)
            .update({ name: 'Renamed Classroom' })
        },
        async revert() {
          await firestore
            .doc(`classrooms/${classroomId}`)
            .update({ name: 'Rehearsal Classroom' })
        },
      },
      {
        label: 'classroom identity drift',
        async apply() {
          await firestore
            .doc(`teachers/${teacherUid}`)
            .update({ classroomId: alternateClassroomId })
        },
        async revert() {
          await firestore
            .doc(`teachers/${teacherUid}`)
            .update({ classroomId })
        },
      },
    ]

    for (const driftCase of driftCases) {
      await driftCase.apply()

      for (const write of [false, true]) {
        const blocked = await runCli(scenario, { write })
        assert.equal(
          blocked.exitCode,
          EXIT_CODES.STALE_MANIFEST_MISMATCH,
          `${driftCase.label} (write=${write}) must block`,
        )
        assert.equal(blocked.error.category, 'stale-manifest-drift')
        assert.equal(
          readManifestFile(scenario.slot).runId,
          plannedRunId,
          `${driftCase.label}: the retained plan must never be replaced`,
        )
      }

      await driftCase.revert()
    }

    // Plan/projection drift: a new legacy student changes the plan itself.
    await firestore.doc('morganBank/classroomData').update({
      students: [
        ...fixture.classroomData.data.students,
        { id: 's-added', name: 'Added Student', balance: 1, frozen: false },
      ],
    })
    const planDrift = await runCli(scenario, { write: true })
    assert.equal(planDrift.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(planDrift.error.category, 'stale-manifest-drift')
    assert.equal(readManifestFile(scenario.slot).runId, plannedRunId)
  })

  test('step 15: each drift independently blocks planned and completed manifests', async () => {
    for (const lifecycle of ['planned', 'completed']) {
      for (const driftCase of RETAINED_DRIFT_CASES) {
        // A fresh project/teacher identity for every case is essential here.
        // Firestore updateTime cannot be restored by writing the old body, so
        // reusing one scenario would let an earlier drift mask later cases.
        const scenario = await setupScenario(
          `s13-${lifecycle}-${driftCase.key}`,
          { size: REHEARSAL_FIXTURE_SIZES.SMALL },
        )

        const planned = await runCli(scenario)
        assert.equal(planned.exitCode, EXIT_CODES.SUCCESS)

        if (lifecycle === 'completed') {
          const completed = await runCli(scenario, { write: true })
          assert.equal(completed.exitCode, EXIT_CODES.SUCCESS)
          assert.equal(
            completed.result.manifest.runState,
            MANIFEST_RUN_STATES.COMPLETED,
          )
        }

        const retainedBefore = fs.readFileSync(scenario.slot.manifestPath)
        const retainedRunId = readManifestFile(scenario.slot).runId
        await applyRetainedDrift(scenario, driftCase.key)

        for (const write of [false, true]) {
          const blocked = await runCli(scenario, { write })
          assert.equal(
            blocked.exitCode,
            EXIT_CODES.STALE_MANIFEST_MISMATCH,
            `${lifecycle} + ${driftCase.label} (write=${write}) must block`,
          )
          assert.equal(blocked.error.category, 'stale-manifest-drift')
          assert.equal(readManifestFile(scenario.slot).runId, retainedRunId)
          assert.deepEqual(
            fs.readFileSync(scenario.slot.manifestPath),
            retainedBefore,
            `${lifecycle} + ${driftCase.label} must not rewrite the manifest`,
          )
        }
      }
    }
  })

  test('step 15: malformed, unreadable, and mismatched manifests never qualify', async () => {
    const scenario = await setupScenario('s14', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const validBytes = fs.readFileSync(scenario.slot.manifestPath)

    // Malformed JSON.
    fs.writeFileSync(scenario.slot.manifestPath, '{ not json')
    let blocked = await runCli(scenario)
    assert.equal(blocked.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(blocked.error.name, 'ManifestError')
    assert.equal(blocked.error.category, 'read-failed')

    // Schema-valid JSON that fails structural validation.
    const structurallyInvalid = JSON.parse(validBytes.toString('utf8'))
    delete structurallyInvalid.planChecksum
    fs.writeFileSync(
      scenario.slot.manifestPath,
      JSON.stringify(structurallyInvalid),
    )
    blocked = await runCli(scenario)
    assert.equal(blocked.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(blocked.error.category, 'read-failed')

    // Non-canonical serialization of an otherwise valid manifest.
    fs.writeFileSync(
      scenario.slot.manifestPath,
      JSON.stringify(JSON.parse(validBytes.toString('utf8')), null, 4),
    )
    blocked = await runCli(scenario)
    assert.equal(blocked.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(blocked.error.category, 'read-failed')

    // A manifest whose fixed identity does not match its canonical slot.
    fs.writeFileSync(scenario.slot.manifestPath, validBytes)
    rewriteManifestFile(scenario.slot, manifest => {
      manifest.teacherUid = `${manifest.teacherUid}-someone-else`
      manifest.runState = MANIFEST_RUN_STATES.FAILED
      manifest.writePhaseStarted = false
    })
    blocked = await runCli(scenario)
    assert.equal(blocked.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
    assert.equal(blocked.error.category, 'read-failed')

    // Unreadable file.
    fs.writeFileSync(scenario.slot.manifestPath, validBytes)
    fs.chmodSync(scenario.slot.manifestPath, 0o000)
    try {
      blocked = await runCli(scenario)
      assert.equal(blocked.exitCode, EXIT_CODES.STALE_MANIFEST_MISMATCH)
      assert.equal(blocked.error.category, 'read-failed')
    } finally {
      fs.chmodSync(scenario.slot.manifestPath, 0o600)
    }

    // In every case the file was left for the operator, never replaced.
    assert.deepEqual(fs.readFileSync(scenario.slot.manifestPath), validBytes)
  })
})

// ---------------------------------------------------------------------------
// Steps 16-19 — crash, restart recovery, and unresolved-run protection.
// ---------------------------------------------------------------------------

describe('crash and restart recovery', () => {
  test('step 16: a crash after writePhaseStarted recovers the same manifest', async () => {
    const scenario = await setupScenario('s15', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })
    const { firestore, classroomId } = scenario

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const planned = readManifestFile(scenario.slot)
    const pathsBefore = await documentPathSnapshot(firestore, classroomId)

    const crashed = simulateCrashAfterWritePhaseStarted(scenario.slot)
    assert.equal(crashed.writePhaseStarted, true)
    assert.equal(crashed.inFlightBatchId, null)
    for (const batch of crashed.batches) {
      assert.equal(batch.state, MANIFEST_BATCH_STATES.PENDING)
    }

    // Nothing was written before the crash.
    assert.deepEqual(
      [...await documentPathSnapshot(firestore, classroomId)].sort(),
      [...pathsBefore].sort(),
    )

    // A dry-run restart discovers the unresolved run and refuses to guess.
    const dryRestart = await runCli(scenario)
    assert.equal(dryRestart.exitCode, EXIT_CODES.INDETERMINATE_RECOVERY_REQUIRED)
    assert.equal(
      dryRestart.error.category,
      'indeterminate-recovery-required',
    )
    assert.equal(readManifestFile(scenario.slot).writePhaseStarted, true)

    // A write restart recovers the same canonical manifest and completes.
    const recovered = await runCli(scenario, { write: true })
    assert.equal(recovered.exitCode, EXIT_CODES.SUCCESS)
    assert.equal(recovered.canonicalPath, scenario.slot.manifestPath)
    assert.equal(recovered.result.manifest.runId, planned.runId)
    assert.equal(
      recovered.result.manifest.runState,
      MANIFEST_RUN_STATES.COMPLETED,
    )
    assert.equal(recovered.result.manifest.writePhaseStarted, true)
    assert.equal(
      recovered.result.writesApplied,
      scenario.fixture.expected.operationCount,
    )

    assertNoDeletions(
      pathsBefore,
      await documentPathSnapshot(firestore, classroomId),
      'after write-phase crash recovery',
    )
  })

  test('steps 17-18: an uncertain commit outcome recovers to the same terminal state', async () => {
    const scenario = await setupScenario('s16', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })
    const { firestore, classroomId } = scenario

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const planned = readManifestFile(scenario.slot)
    const pathsBefore = await documentPathSnapshot(firestore, classroomId)

    // Step 17: batch 2 reaches Firestore, then its outcome is reported as
    // uncertain — the commit landed, but no verified manifest state did.
    const interrupted = await runCli(scenario, {
      write: true,
      firestore: withUncertainCommit(firestore, { failAfterCommitNumber: 2 }),
    })

    assert.equal(
      interrupted.exitCode,
      EXIT_CODES.INDETERMINATE_RECOVERY_REQUIRED,
    )
    assert.equal(interrupted.error.category, 'indeterminate-recovery-required')

    const unresolved = readManifestFile(scenario.slot)
    assert.equal(unresolved.writePhaseStarted, true)
    assert.equal(unresolved.runId, planned.runId)
    assert.equal(unresolved.batches[0].state, MANIFEST_BATCH_STATES.VERIFIED)
    assert.equal(
      unresolved.batches[1].state,
      MANIFEST_BATCH_STATES.INDETERMINATE,
    )
    assert.equal(unresolved.inFlightBatchId, unresolved.batches[1].batchId)

    // The second batch's write really did land in Firestore.
    const committedPath = unresolved.operations
      .find(operation => operation.batchId === unresolved.batches[1].batchId)
      .path
    assert.ok(await readDocument(firestore, committedPath))

    // Step 18: restart with nothing but the same project/teacher identity.
    const recovered = await runCli(scenario, { write: true })
    assert.equal(recovered.exitCode, EXIT_CODES.SUCCESS)
    assert.equal(recovered.canonicalPath, scenario.slot.manifestPath)
    assert.equal(recovered.result.manifest.runId, planned.runId)
    assert.equal(
      recovered.result.manifest.runState,
      MANIFEST_RUN_STATES.COMPLETED,
    )
    assert.equal(recovered.result.manifest.writePhaseStarted, true)

    const durable = readManifestFile(scenario.slot)
    for (const batch of durable.batches) {
      assert.equal(batch.state, MANIFEST_BATCH_STATES.VERIFIED)
    }
    assert.equal(durable.reconciliationSummary.passed, true)
    assertManifestCarriesNoSecrets(durable, 'recovered manifest')

    // The uninterrupted terminal state is reached: every destination exists
    // exactly once with the projected body.
    for (const operation of durable.operations) {
      assert.ok(
        await readDocument(firestore, operation.path),
        `${operation.path} must exist after recovery`,
      )
    }
    assertNoDeletions(
      pathsBefore,
      await documentPathSnapshot(firestore, classroomId),
      'after uncertain-commit recovery',
    )
  })

  test('step 19: an unresolved write-started run is never replaced by a new run', async () => {
    const scenario = await setupScenario('s17', {
      size: REHEARSAL_FIXTURE_SIZES.SMALL,
    })
    const { firestore, teacherUid, classroomId, fixture } = scenario

    assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
    const planned = readManifestFile(scenario.slot)

    // Leave an unresolved writePhaseStarted === true manifest behind.
    const interrupted = await runCli(scenario, {
      write: true,
      firestore: withUncertainCommit(firestore, { failAfterCommitNumber: 1 }),
    })
    assert.equal(
      interrupted.exitCode,
      EXIT_CODES.INDETERMINATE_RECOVERY_REQUIRED,
    )
    assert.equal(readManifestFile(scenario.slot).writePhaseStarted, true)

    const alternateClassroomId = 'rehearsal-alternate-unresolved-classroom'
    await firestore.doc(`classrooms/${alternateClassroomId}`).create({
      ownerUid: teacherUid,
      name: 'Alternate Unresolved Classroom',
      createdAt: new Timestamp(1_700_000_000, 0),
      updatedAt: new Timestamp(1_700_000_000, 0),
      version: 1,
      settings: {},
    })

    const driftCases = [
      {
        label: 'classroom identity',
        apply: () => firestore
          .doc(`teachers/${teacherUid}`)
          .update({ classroomId: alternateClassroomId }),
        revert: () => firestore
          .doc(`teachers/${teacherUid}`)
          .update({ classroomId }),
      },
      {
        label: 'foundation invariant',
        apply: () => firestore
          .doc(`classrooms/${classroomId}`)
          .update({ name: 'Renamed Unresolved Classroom' }),
        revert: () => firestore
          .doc(`classrooms/${classroomId}`)
          .update({ name: 'Rehearsal Classroom' }),
      },
      {
        label: 'immutable source',
        apply: () => firestore
          .doc('morganBank/classroomData')
          .update({
            settings: {
              ...fixture.classroomData.data.settings,
              payDay: 'tuesday',
            },
          }),
        revert: () => firestore
          .doc('morganBank/classroomData')
          .update({ settings: fixture.classroomData.data.settings }),
      },
      {
        label: 'plan projection',
        apply: () => firestore
          .doc('studentCredentials/bailey-cruz')
          .update({ failedAttempts: 7 }),
        revert: () => firestore
          .doc('studentCredentials/bailey-cruz')
          .update({ failedAttempts: 0 }),
      },
    ]

    const blockingExitCodes = new Set([
      EXIT_CODES.STALE_MANIFEST_MISMATCH,
      EXIT_CODES.PREFLIGHT_CONFLICT,
      EXIT_CODES.INDETERMINATE_RECOVERY_REQUIRED,
    ])

    for (const driftCase of driftCases) {
      await driftCase.apply()

      for (const write of [false, true]) {
        const blocked = await runCli(scenario, { write })
        assert.ok(
          blockingExitCodes.has(blocked.exitCode),
          `${driftCase.label} (write=${write}) must block, got exit ` +
            `${blocked.exitCode}`,
        )

        // No new run was created and the write phase never rewound.
        const retained = readManifestFile(scenario.slot)
        assert.equal(
          retained.runId,
          planned.runId,
          `${driftCase.label}: a new run must never replace the unresolved one`,
        )
        assert.equal(retained.writePhaseStarted, true)
      }

      await driftCase.revert()
    }

    // Path overrides cannot sidestep the unresolved run either.
    for (const override of ['--manifest', '--state-dir', '--manifest-file']) {
      const logger = recordingLogger()
      const { exitCode, error } = await runMain(
        [
          ...cliArguments(scenario, { write: true }),
          override,
          path.join(os.tmpdir(), 'bypass.manifest.json'),
        ],
        { logger },
      )

      capturedOutput.push(...logger.lines)
      assert.equal(exitCode, EXIT_CODES.VALIDATION_FAILURE)
      assert.equal(error.category, 'unsupported-override')
      assert.equal(readManifestFile(scenario.slot).runId, planned.runId)
    }
  })

  test('step 19: each unresolved-run drift is independently non-bypassable', async () => {
    for (const driftCase of RETAINED_DRIFT_CASES) {
      const scenario = await setupScenario(
        `s17-${driftCase.key}`,
        { size: REHEARSAL_FIXTURE_SIZES.SMALL },
      )

      assert.equal((await runCli(scenario)).exitCode, EXIT_CODES.SUCCESS)
      const plannedRunId = readManifestFile(scenario.slot).runId

      const interrupted = await runCli(scenario, {
        write: true,
        firestore: withUncertainCommit(scenario.firestore, {
          failAfterCommitNumber: 1,
        }),
      })
      assert.equal(
        interrupted.exitCode,
        EXIT_CODES.INDETERMINATE_RECOVERY_REQUIRED,
      )
      assert.equal(readManifestFile(scenario.slot).writePhaseStarted, true)

      await applyRetainedDrift(scenario, driftCase.key)

      for (const write of [false, true]) {
        const blocked = await runCli(scenario, { write })
        assert.notEqual(
          blocked.exitCode,
          EXIT_CODES.SUCCESS,
          `${driftCase.label} (write=${write}) must block recovery`,
        )

        const retained = readManifestFile(scenario.slot)
        assert.equal(
          retained.runId,
          plannedRunId,
          `${driftCase.label}: the unresolved run must never be replaced`,
        )
        assert.equal(retained.writePhaseStarted, true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Step 21 — whole-rehearsal invariants and isolated cleanup.
// ---------------------------------------------------------------------------

describe('whole-rehearsal invariants', () => {
  test('no seeded Firestore document disappeared in any scenario', async () => {
    assert.ok(seededScenarios.length > 0)

    for (const scenario of seededScenarios) {
      const currentPaths = await documentPathSnapshot(
        scenario.firestore,
        scenario.classroomId,
      )
      assertNoDeletions(
        scenario.initialPaths,
        currentPaths,
        `whole rehearsal scenario ${scenario.key}`,
      )
    }
  })

  test('no secret material reached any manifest or console output', () => {
    const secrets = [SYNTHETIC_PIN_HASH_PREFIX, ...SYNTHETIC_PLAINTEXT_PINS]
    const output = capturedOutput.join('\n')

    assert.ok(output.length > 0, 'the rehearsal must have produced CLI output')
    for (const secret of secrets) {
      assert.ok(
        !output.includes(secret),
        'console output must never contain secret material',
      )
    }

    let inspectedManifests = 0
    for (const { slot } of testIdentities) {
      if (!fs.existsSync(slot.manifestPath)) {
        continue
      }

      let manifest
      try {
        manifest = readManifestFile(slot)
      } catch {
        // A deliberately malformed manifest from step 15.
        continue
      }

      inspectedManifests += 1
      assertManifestCarriesNoSecrets(manifest, slot.filename)
    }

    assert.ok(inspectedManifests > 0)
  })

  test('cleanup removes only this suite\'s own manifest files', () => {
    const ownFilenames = new Set(
      testIdentities.map(identity => identity.slot.filename),
    )

    // No pre-existing file may share a canonical filename with this suite.
    for (const filename of ownFilenames) {
      assert.equal(
        preexistingStateFiles.has(filename),
        false,
        `${filename} collided with pre-existing state`,
      )
    }

    cleanupTestManifests()

    for (const { slot } of testIdentities) {
      assert.equal(fs.existsSync(slot.manifestPath), false)
    }

    const remaining = readStateDirectoryFiles()

    // Every unrelated file — including any operator's unresolved canonical
    // manifest — is still present and byte-for-byte unchanged.
    for (const [filename, bytes] of preexistingStateFiles) {
      assert.ok(
        remaining.has(filename),
        `cleanup must not remove the unrelated file ${filename}`,
      )
      assert.deepEqual(
        remaining.get(filename),
        bytes,
        `cleanup must not modify the unrelated file ${filename}`,
      )
    }

    // And cleanup left no stray temporary artifacts of its own behind.
    for (const filename of remaining.keys()) {
      assert.ok(
        preexistingStateFiles.has(filename),
        `unexpected leftover state file: ${filename}`,
      )
    }
  })
})
