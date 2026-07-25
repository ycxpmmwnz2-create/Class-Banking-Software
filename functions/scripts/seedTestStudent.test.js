import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import test from 'node:test'

const ENVIRONMENT_VARIABLE = 'FIRESTORE_EMULATOR_HOST'
const moduleUrl = new URL('./seedTestStudent.js', import.meta.url)

process.env[ENVIRONMENT_VARIABLE] = '127.0.0.1:8080'
const module = await import(moduleUrl)

const {
  BCRYPT_COST,
  SEED_TEST_STUDENT_APP_PREFIX,
  TEST_PIN,
  SeedTestStudentError,
  closeOwnedSeedTestStudentApp,
  createSeedTestStudentFirestore,
  parseSeedTestStudentArguments,
  resolveSeedTarget,
  runSeedTestStudent,
  seedTestStudentCredential,
  selectTestStudent,
} = module

const VALID_ARGUMENTS = [
  '--project-id', 'seed-test-project',
  '--teacher-uid', 'teacher-1',
  '--classroom-id', 'generated-classroom-1',
]

function withHost(host, callback) {
  const original = process.env[ENVIRONMENT_VARIABLE]
  try {
    if (host === undefined) delete process.env[ENVIRONMENT_VARIABLE]
    else process.env[ENVIRONMENT_VARIABLE] = host
    return callback()
  } finally {
    if (original === undefined) delete process.env[ENVIRONMENT_VARIABLE]
    else process.env[ENVIRONMENT_VARIABLE] = original
  }
}

function executeInChild(host, args = VALID_ARGUMENTS) {
  const env = { ...process.env }
  if (host === undefined) delete env[ENVIRONMENT_VARIABLE]
  else env[ENVIRONMENT_VARIABLE] = host
  return spawnSync(process.execPath, [moduleUrl.pathname, ...args], {
    encoding: 'utf8',
    env,
  })
}

function snapshot(exists, data) {
  return { exists, data: () => data }
}

function buildFakeFirestore(documents = {}) {
  const reads = []
  const writes = []
  const firestore = {
    doc(path) {
      return {
        path,
        async get() {
          reads.push(path)
          return documents[path] ?? snapshot(false)
        },
      }
    },
    async runTransaction(callback) {
      const transaction = {
        async get(reference) {
          reads.push(reference.path)
          return documents[reference.path] ?? snapshot(false)
        },
        set(reference, data, options) {
          writes.push({ path: reference.path, data, options })
        },
      }
      return callback(transaction)
    },
  }
  return { firestore, reads, writes }
}

function validDocuments(overrides = {}) {
  return {
    'teachers/teacher-1': snapshot(true, {
      uid: 'teacher-1',
      classroomId: 'generated-classroom-1',
    }),
    'classrooms/generated-classroom-1': snapshot(true, {
      ownerUid: 'teacher-1',
    }),
    'morganBank/classroomData': snapshot(true, {
      students: [{ id: 42, name: 'Edge Test', balance: 10 }],
    }),
    ...overrides,
  }
}

test('direct execution refuses a missing or malformed emulator host', () => {
  for (const host of [undefined, 'https://localhost:8080']) {
    const result = executeInChild(host)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FIRESTORE_EMULATOR_HOST/u)
    assert.equal(result.stdout, '')
  }
})

test('direct execution reaches strict parsing before Admin or Firestore', () => {
  const result = executeInChild('127.0.0.1:8080', [])
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Missing required flags/u)
  assert.equal(result.stdout, '')
})

test('safety guard precedes parsing, Admin, hashing, reads, writes, and logging', async () => {
  for (const host of [undefined, 'localhost:not-a-port']) {
    const calls = []
    await assert.rejects(
      withHost(host, () => runSeedTestStudent([], {
        logger: { log: () => calls.push('log') },
        firestoreFactory: () => calls.push('factory'),
        hashPin: () => calls.push('hash'),
      })),
      /FIRESTORE_EMULATOR_HOST/u,
    )
    assert.deepEqual(calls, [])
  }

  for (const host of [undefined, 'localhost:not-a-port']) {
    const { firestore, reads, writes } = buildFakeFirestore(validDocuments())
    let hashes = 0

    await assert.rejects(
      withHost(host, () => seedTestStudentCredential({
        firestore,
        teacherUid: 'teacher-1',
        classroomId: 'generated-classroom-1',
        hashPin: async () => {
          hashes += 1
          return 'hash'
        },
        serverTimestamp: () => 'now',
      })),
      /FIRESTORE_EMULATOR_HOST/u,
    )
    await assert.rejects(
      withHost(host, () => resolveSeedTarget({
        firestore,
        teacherUid: 'teacher-1',
        classroomId: 'generated-classroom-1',
      })),
      /FIRESTORE_EMULATOR_HOST/u,
    )

    assert.deepEqual(reads, [])
    assert.deepEqual(writes, [])
    assert.equal(hashes, 0)
  }

  const adminCalls = []
  assert.throws(
    () => withHost(undefined, () => createSeedTestStudentFirestore('test', {
      getApps: () => adminCalls.push('apps'),
      initializeApp: () => adminCalls.push('initialize'),
      getFirestore: () => adminCalls.push('firestore'),
    })),
    /FIRESTORE_EMULATOR_HOST/u,
  )
  assert.deepEqual(adminCalls, [])
})

test('source has no hardcoded production project or legacy classroom assignment', () => {
  const source = fs.readFileSync(moduleUrl, 'utf8')
  assert.doesNotMatch(source, /initializeApp\s*\(\s*\{\s*projectId:\s*['"]morgan-bank/u)
  assert.doesNotMatch(source, /(?:CLASSROOM_ID|classroomId:)\s*=*\s*['"]morgan['"]/u)
  assert.doesNotMatch(source, /\.\s*(?:delete|update|create|batch)\s*\(/u)
})

test('direct execution redacts non-argument failure and cleanup detail', () => {
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/\s+/gu, ' ')

  assert.match(
    source,
    /error instanceof SeedTestStudentError \? error\.message : 'Seeder execution failed\.'/u,
  )
  assert.match(
    source,
    /catch \{ globalThis\.console\.error\('seedTestStudent cleanup failed\.'\)/u,
  )
})

test('parses all explicit required inputs in any order into a frozen result', () => {
  const parsed = parseSeedTestStudentArguments([
    '--classroom-id', 'generated-classroom-1',
    '--project-id', 'seed-test-project',
    '--teacher-uid', 'teacher-1',
  ])
  assert.deepEqual(parsed, {
    projectId: 'seed-test-project',
    teacherUid: 'teacher-1',
    classroomId: 'generated-classroom-1',
  })
  assert.ok(Object.isFrozen(parsed))
})

test('rejects each missing flag and missing, blank, or padded values', () => {
  for (const flag of ['--project-id', '--teacher-uid', '--classroom-id']) {
    const index = VALID_ARGUMENTS.indexOf(flag)
    const argv = VALID_ARGUMENTS.filter((_, i) => i !== index && i !== index + 1)
    assert.throws(
      () => parseSeedTestStudentArguments(argv),
      error => error instanceof SeedTestStudentError &&
        error.category === 'missing-required-flag' && error.flags.includes(flag),
    )
  }

  for (const argv of [
    ['--project-id'],
    ['--project-id', ''],
    ['--project-id', '  '],
    ['--project-id', ' padded'],
    ['--project-id', 'padded '],
  ]) {
    assert.throws(
      () => parseSeedTestStudentArguments(argv),
      error => error instanceof SeedTestStudentError &&
        ['missing-value', 'invalid-value'].includes(error.category),
    )
  }
})

test('rejects duplicates, unknown flags, positions, assignments, and invalid types', () => {
  const cases = [
    [[...VALID_ARGUMENTS, '--teacher-uid', 'other'], 'duplicate-flag'],
    [[...VALID_ARGUMENTS, '--write'], 'unknown-flag'],
    [['--project-id=value'], 'unknown-flag'],
    [['positional'], 'positional-argument'],
    [[123], 'invalid-argument'],
  ]
  for (const [argv, category] of cases) {
    assert.throws(
      () => parseSeedTestStudentArguments(argv),
      error => error instanceof SeedTestStudentError && error.category === category,
    )
  }
  for (const value of [undefined, null, {}, 'arguments']) {
    assert.throws(
      () => parseSeedTestStudentArguments(value),
      error => error instanceof SeedTestStudentError &&
        error.category === 'invalid-arguments',
    )
  }
})

test('rejects path-injecting IDs and the legacy classroom ID', () => {
  for (const [flag, value, category] of [
    ['--teacher-uid', 'teachers/one', 'invalid-document-id'],
    ['--classroom-id', '../classroom', 'invalid-document-id'],
    ['--classroom-id', 'morgan', 'legacy-classroom-id'],
  ]) {
    const argv = [...VALID_ARGUMENTS]
    argv[argv.indexOf(flag) + 1] = value
    assert.throws(
      () => parseSeedTestStudentArguments(argv),
      error => error instanceof SeedTestStudentError && error.category === category,
    )
  }
})

test('constructs Firestore with the explicit project and isolated app name', () => {
  withHost('127.0.0.1:8080', () => {
    const calls = []
    const app = { name: `${SEED_TEST_STUDENT_APP_PREFIX}seed-test-project` }
    const firestore = { fake: true }
    const result = createSeedTestStudentFirestore('seed-test-project', {
      getApps: () => [],
      initializeApp(options, name) {
        calls.push(['initialize', options, name])
        return app
      },
      getFirestore(received) {
        calls.push(['firestore', received])
        return firestore
      },
    })
    assert.deepEqual(calls, [
      ['initialize', { projectId: 'seed-test-project' }, app.name],
      ['firestore', app],
    ])
    assert.equal(result.firestore, firestore)
    assert.equal(result.ownsApp, true)
  })
})

test('selects Andrew before Edge and validates derived IDs', () => {
  assert.deepEqual(selectTestStudent([
    { id: 2, name: 'Edge Test' },
    { id: 1, name: 'Andrew Test', loginId: 'Andrew-Login' },
  ]), { studentId: '1', loginId: 'andrew-login' })

  assert.throws(
    () => selectTestStudent([{ id: 1, name: 'Andrew Test', loginId: '../bad' }]),
    error => error instanceof SeedTestStudentError &&
      error.category === 'invalid-document-id',
  )
})

test('validates Version 2 ownership and resolves the fixed legacy roster target', async () => {
  const { firestore, reads } = buildFakeFirestore(validDocuments())
  const target = await resolveSeedTarget({
    firestore,
    teacherUid: 'teacher-1',
    classroomId: 'generated-classroom-1',
  })
  assert.deepEqual(reads, [
    'teachers/teacher-1',
    'classrooms/generated-classroom-1',
    'morganBank/classroomData',
  ])
  assert.deepEqual(target, {
    studentId: '42',
    loginId: 'edge-test',
    credentialPath: 'studentCredentials/edge-test',
  })
})

test('ownership or roster failures occur before hashing or writes', async () => {
  const cases = [
    [{ 'teachers/teacher-1': snapshot(false) }, 'teacher-ownership-mismatch'],
    [{ 'classrooms/generated-classroom-1': snapshot(false) }, 'classroom-ownership-mismatch'],
    [{ 'morganBank/classroomData': snapshot(false) }, 'roster-missing'],
    [{ 'morganBank/classroomData': snapshot(true, { students: [] }) }, 'test-student-missing'],
  ]
  for (const [overrides, category] of cases) {
    const { firestore, writes } = buildFakeFirestore(validDocuments(overrides))
    let hashes = 0
    await assert.rejects(
      seedTestStudentCredential({
        firestore,
        teacherUid: 'teacher-1',
        classroomId: 'generated-classroom-1',
        hashPin: async () => {
          hashes += 1
          return 'hash'
        },
      }),
      error => error instanceof SeedTestStudentError && error.category === category,
    )
    assert.equal(hashes, 0)
    assert.deepEqual(writes, [])
  }
})

test('hashes the fixed PIN and writes one generated-classroom credential', async () => {
  const { firestore, reads, writes } = buildFakeFirestore(validDocuments())
  const timestamp = { kind: 'server-timestamp' }
  const hashCalls = []
  const result = await seedTestStudentCredential({
    firestore,
    teacherUid: 'teacher-1',
    classroomId: 'generated-classroom-1',
    hashPin: async (pin, cost) => {
      hashCalls.push([pin, cost])
      return 'controlled-pin-hash'
    },
    serverTimestamp: () => timestamp,
  })

  assert.deepEqual(hashCalls, [[TEST_PIN, BCRYPT_COST]])
  assert.deepEqual(reads, [
    'teachers/teacher-1',
    'classrooms/generated-classroom-1',
    'morganBank/classroomData',
    'studentCredentials/edge-test',
  ])
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], {
    path: 'studentCredentials/edge-test',
    data: {
      schemaVersion: 1,
      authUid: 'edge-test',
      classroomId: 'generated-classroom-1',
      studentId: '42',
      pinHash: 'controlled-pin-hash',
      active: true,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: timestamp,
      pinUpdatedAt: timestamp,
      createdAt: timestamp,
    },
    options: { merge: true },
  })
  assert.deepEqual(result, {
    credentialPath: 'studentCredentials/edge-test',
    classroomId: 'generated-classroom-1',
    studentId: '42',
    loginId: 'edge-test',
  })
})

test('preserves existing createdAt while refreshing test credential fields', async () => {
  const existingCreatedAt = { seconds: 1 }
  const documents = validDocuments({
    'studentCredentials/edge-test': snapshot(true, { createdAt: existingCreatedAt }),
  })
  const { firestore, writes } = buildFakeFirestore(documents)
  await seedTestStudentCredential({
    firestore,
    teacherUid: 'teacher-1',
    classroomId: 'generated-classroom-1',
    hashPin: async () => 'hash',
    serverTimestamp: () => 'now',
  })
  assert.equal(Object.hasOwn(writes[0].data, 'createdAt'), false)
})

test('run wrapper logs identifiers only and never the PIN or hash', async () => {
  const { firestore } = buildFakeFirestore(validDocuments())
  const lines = []
  await runSeedTestStudent(VALID_ARGUMENTS, {
    firestore,
    logger: { log: line => lines.push(line) },
    hashPin: async () => 'must-not-be-logged-hash',
    serverTimestamp: () => 'now',
  })
  const output = lines.join('\n')
  assert.match(output, /studentCredentials\/edge-test/u)
  assert.match(output, /generated-classroom-1/u)
  assert.equal(output.includes(TEST_PIN), false)
  assert.equal(output.includes('must-not-be-logged-hash'), false)
  assert.doesNotMatch(output, /pinHash/u)
})

test('importing with valid host does not seed or log', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(moduleUrl.href)})`],
    {
      encoding: 'utf8',
      env: { ...process.env, [ENVIRONMENT_VARIABLE]: '127.0.0.1:8080' },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('reuses only its own app and cleanup removes only an owned app', async () => {
  await withHost('127.0.0.1:8080', async () => {
    const unrelated = { name: '[DEFAULT]' }
    const owned = { name: `${SEED_TEST_STUDENT_APP_PREFIX}seed-test-project` }
    let initializes = 0
    const resources = createSeedTestStudentFirestore('seed-test-project', {
      getApps: () => [unrelated, owned],
      initializeApp: () => { initializes += 1 },
      getFirestore: app => ({ app }),
    })
    assert.equal(initializes, 0)
    assert.equal(resources.app, owned)
    assert.equal(resources.ownsApp, false)

    const calls = []
    const ownedResources = { app: owned, firestore: {}, ownsApp: true }
    assert.equal(await closeOwnedSeedTestStudentApp(ownedResources, {
      terminate: async db => calls.push(['terminate', db]),
      deleteApp: async app => calls.push(['delete', app]),
    }), true)
    assert.deepEqual(calls, [
      ['terminate', ownedResources.firestore],
      ['delete', owned],
    ])
    assert.equal(await closeOwnedSeedTestStudentApp(resources), false)
  })
})
