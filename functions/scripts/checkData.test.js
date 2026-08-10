import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import test from 'node:test'

const ENVIRONMENT_VARIABLE = 'FIRESTORE_EMULATOR_HOST'
const moduleUrl = new URL('./checkData.js', import.meta.url)

process.env[ENVIRONMENT_VARIABLE] = '127.0.0.1:8080'
const checkData = await import(moduleUrl)

const {
  CHECK_DATA_APP_PREFIX,
  CHECK_DATA_PATHS,
  CheckDataArgumentError,
  closeOwnedCheckDataApp,
  createCheckDataFirestore,
  parseCheckDataArguments,
  readAndReportCheckData,
  runCheckData,
} = checkData

function withHost(host, callback) {
  const originalHost = process.env[ENVIRONMENT_VARIABLE]

  try {
    if (host === undefined) {
      delete process.env[ENVIRONMENT_VARIABLE]
    } else {
      process.env[ENVIRONMENT_VARIABLE] = host
    }

    return callback()
  } finally {
    if (originalHost === undefined) {
      delete process.env[ENVIRONMENT_VARIABLE]
    } else {
      process.env[ENVIRONMENT_VARIABLE] = originalHost
    }
  }
}

function executeInChild(host, args = ['--project-id', 'check-data-test']) {
  const environment = { ...process.env }

  if (host === undefined) {
    delete environment[ENVIRONMENT_VARIABLE]
  } else {
    environment[ENVIRONMENT_VARIABLE] = host
  }

  return spawnSync(process.execPath, [moduleUrl.pathname, ...args], {
    encoding: 'utf8',
    env: environment,
  })
}

function fakeSnapshot(exists, data) {
  return { exists, data: () => data }
}

function fakeFirestore(snapshots, error) {
  const reads = []
  const firestore = {
    doc(path) {
      reads.push(path)
      return {
        async get() {
          if (error) {
            throw error
          }
          return snapshots[path]
        },
      }
    },
  }

  return { firestore, reads }
}

function captureLogger() {
  const lines = []
  return {
    lines,
    logger: { log: value => lines.push(value) },
  }
}

test('direct execution refuses a missing or malformed emulator host', () => {
  for (const host of [undefined, 'https://localhost:8080']) {
    const result = executeInChild(host)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FIRESTORE_EMULATOR_HOST/u)
    assert.doesNotMatch(result.stdout, /ROSTER STUDENTS|CREDENTIAL edge-test/u)
  }
})

test('direct execution runs the entry point and reports failure without partial output', () => {
  const result = executeInChild('127.0.0.1:8080', [])

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /checkData failed: Missing required flag: --project-id\./u)
  assert.doesNotMatch(result.stdout, /ROSTER STUDENTS|CREDENTIAL edge-test/u)
})

test('safety validation occurs before parsing, Admin, Firestore, reads, or logging', async () => {
  for (const host of [undefined, 'localhost:not-a-port']) {
    const calls = []
    const logger = { log: () => calls.push('logger') }
    const firestoreFactory = () => {
      calls.push('firestoreFactory')
      return { firestore: fakeFirestore({}).firestore }
    }

    await assert.rejects(
      withHost(host, () => runCheckData([], { logger, firestoreFactory })),
      /FIRESTORE_EMULATOR_HOST/u,
    )
    assert.deepEqual(calls, [])

    const guardedFirestore = {
      doc() {
        calls.push('doc')
        return { get: async () => fakeSnapshot(false) }
      },
    }
    await assert.rejects(
      withHost(host, () => readAndReportCheckData({
        firestore: guardedFirestore,
        logger,
      })),
      /FIRESTORE_EMULATOR_HOST/u,
    )
    assert.deepEqual(calls, [])
  }

  const adminCalls = []
  assert.throws(
    () => withHost(undefined, () => createCheckDataFirestore('test-project', {
      getApps: () => adminCalls.push('getApps'),
      initializeApp: () => adminCalls.push('initializeApp'),
      getFirestore: () => adminCalls.push('getFirestore'),
    })),
    /FIRESTORE_EMULATOR_HOST/u,
  )
  assert.deepEqual(adminCalls, [])
})

test('source has no hardcoded production initialization or Firestore writes', () => {
  const source = fs.readFileSync(moduleUrl, 'utf8')

  assert.doesNotMatch(source, /initializeApp\s*\(\s*\{\s*projectId:\s*['"]morgan-bank['"]/u)
  assert.doesNotMatch(source, /\.\s*(?:set|create|update|delete|batch|runTransaction)\s*\(/u)
})

test('parses exactly one explicit project ID into an immutable result', () => {
  const parsed = parseCheckDataArguments(['--project-id', 'disposable-test-project'])

  assert.deepEqual(parsed, { projectId: 'disposable-test-project' })
  assert.ok(Object.isFrozen(parsed))
})

test('rejects missing flags and missing or blank values', () => {
  const cases = [
    [[], 'missing-required-flag'],
    [['--project-id'], 'missing-value'],
    [['--project-id', ''], 'missing-value'],
    [['--project-id', '   '], 'missing-value'],
    [['--project-id', '--other'], 'missing-value'],
  ]

  for (const [argv, category] of cases) {
    assert.throws(
      () => parseCheckDataArguments(argv),
      error => error instanceof CheckDataArgumentError && error.category === category,
      JSON.stringify(argv),
    )
  }
})

test('rejects noncanonical, duplicate, unknown, positional, and assignment arguments', () => {
  const cases = [
    [['--project-id', ' leading'], 'invalid-value'],
    [['--project-id', 'trailing '], 'invalid-value'],
    [['--project-id', 'one', '--project-id', 'two'], 'duplicate-flag'],
    [['--unknown', 'value'], 'unknown-flag'],
    [['project-id'], 'positional-argument'],
    [['--project-id=value'], 'unknown-flag'],
  ]

  for (const [argv, category] of cases) {
    assert.throws(
      () => parseCheckDataArguments(argv),
      error => error instanceof CheckDataArgumentError && error.category === category,
      JSON.stringify(argv),
    )
  }
})

test('rejects invalid parser input types and non-string tokens', () => {
  for (const value of [undefined, null, {}, 'arguments']) {
    assert.throws(
      () => parseCheckDataArguments(value),
      error => error instanceof CheckDataArgumentError &&
        error.category === 'invalid-arguments',
    )
  }

  assert.throws(
    () => parseCheckDataArguments(['--project-id', 123]),
    error => error instanceof CheckDataArgumentError &&
      error.category === 'missing-value',
  )
  assert.throws(
    () => parseCheckDataArguments([123]),
    error => error instanceof CheckDataArgumentError &&
      error.category === 'invalid-argument',
  )
})

test('passes the explicit project ID to a narrowly named Admin app and Firestore', () => {
  withHost('127.0.0.1:8080', () => {
    const calls = []
    const app = { name: `${CHECK_DATA_APP_PREFIX}explicit-test-project` }
    const firestore = { kind: 'fake-firestore' }

    const resources = createCheckDataFirestore('explicit-test-project', {
      getApps: () => [],
      initializeApp(options, name) {
        calls.push(['initializeApp', options, name])
        return app
      },
      getFirestore(receivedApp) {
        calls.push(['getFirestore', receivedApp])
        return firestore
      },
    })

    assert.deepEqual(calls, [
      [
        'initializeApp',
        { projectId: 'explicit-test-project' },
        `${CHECK_DATA_APP_PREFIX}explicit-test-project`,
      ],
      ['getFirestore', app],
    ])
    assert.equal(resources.firestore, firestore)
    assert.equal(resources.ownsApp, true)
  })
})

test('reads exactly the two fixed documents and emits controlled existing-data output', async () => {
  const snapshots = {
    [CHECK_DATA_PATHS.ROSTER]: fakeSnapshot(true, {
      students: [{ id: 'student-1', name: 'Ada' }],
      settings: { hidden: true },
    }),
    [CHECK_DATA_PATHS.CREDENTIAL]: fakeSnapshot(true, {
      studentId: 'student-1',
      active: true,
    }),
  }
  const { firestore, reads } = fakeFirestore(snapshots)
  const { logger, lines } = captureLogger()

  await readAndReportCheckData({ firestore, logger })

  assert.deepEqual(reads, [
    'morganBank/classroomData',
    'studentCredentials/edge-test',
  ])
  assert.deepEqual(lines, [
    '--- ROSTER STUDENTS ---',
    JSON.stringify([{ id: 'student-1', name: 'Ada' }], null, 2),
    '--- CREDENTIAL edge-test ---',
    JSON.stringify({ studentId: 'student-1', active: true }, null, 2),
  ])
})

test('reports missing documents deterministically without reading undefined data', async () => {
  const { firestore } = fakeFirestore({
    [CHECK_DATA_PATHS.ROSTER]: fakeSnapshot(false),
    [CHECK_DATA_PATHS.CREDENTIAL]: fakeSnapshot(false),
  })
  const { logger, lines } = captureLogger()

  await readAndReportCheckData({ firestore, logger })

  assert.deepEqual(lines, [
    '--- ROSTER STUDENTS ---',
    '(document missing)',
    '--- CREDENTIAL edge-test ---',
    '(document missing)',
  ])
})

test('propagates Firestore read failures without logging partial diagnostics', async () => {
  const failure = new Error('controlled Firestore read failure')
  const { firestore } = fakeFirestore({}, failure)
  const { logger, lines } = captureLogger()

  await assert.rejects(
    readAndReportCheckData({ firestore, logger }),
    error => error === failure,
  )
  assert.deepEqual(lines, [])
})

test('runCheckData parses before construction and performs read-only diagnostics', async () => {
  await withHost('127.0.0.1:8080', async () => {
    const snapshots = {
      [CHECK_DATA_PATHS.ROSTER]: fakeSnapshot(true, { students: [] }),
      [CHECK_DATA_PATHS.CREDENTIAL]: fakeSnapshot(true, { active: true }),
    }
    const { firestore, reads } = fakeFirestore(snapshots)
    const { logger } = captureLogger()
    const factoryProjects = []

    const execution = await runCheckData(
      ['--project-id', 'run-check-data-test'],
      {
        logger,
        firestoreFactory(projectId) {
          factoryProjects.push(projectId)
          return { firestore, ownsApp: false }
        },
      },
    )

    assert.deepEqual(factoryProjects, ['run-check-data-test'])
    assert.deepEqual(reads, Object.values(CHECK_DATA_PATHS))
    assert.equal(execution.parsed.projectId, 'run-check-data-test')
  })
})

test('importing with a valid emulator host does not execute the diagnostic', () => {
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

test('reuses its own named app without colliding with unrelated Admin apps', () => {
  withHost('127.0.0.1:8080', () => {
    const unrelatedApp = { name: '[DEFAULT]' }
    const ownedApp = { name: `${CHECK_DATA_APP_PREFIX}shared-test-project` }
    let initializeCalls = 0
    const getFirestoreCalls = []

    const resources = createCheckDataFirestore('shared-test-project', {
      getApps: () => [unrelatedApp, ownedApp],
      initializeApp: () => {
        initializeCalls += 1
      },
      getFirestore(app) {
        getFirestoreCalls.push(app)
        return { app }
      },
    })

    assert.equal(initializeCalls, 0)
    assert.deepEqual(getFirestoreCalls, [ownedApp])
    assert.equal(resources.app, ownedApp)
    assert.equal(resources.ownsApp, false)
  })
})

test('cleanup releases only an app created by this script', async () => {
  const calls = []
  const resources = {
    app: { name: `${CHECK_DATA_APP_PREFIX}owned` },
    firestore: { name: 'firestore' },
    ownsApp: true,
  }
  const dependencies = {
    terminate: async firestore => calls.push(['terminate', firestore]),
    deleteApp: async app => calls.push(['deleteApp', app]),
  }

  assert.equal(await closeOwnedCheckDataApp(resources, dependencies), true)
  assert.deepEqual(calls, [
    ['terminate', resources.firestore],
    ['deleteApp', resources.app],
  ])

  calls.length = 0
  assert.equal(
    await closeOwnedCheckDataApp({ ...resources, ownsApp: false }, dependencies),
    false,
  )
  assert.deepEqual(calls, [])
})
