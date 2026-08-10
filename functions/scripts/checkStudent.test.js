import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import test from 'node:test'

const ENVIRONMENT_VARIABLE = 'FIRESTORE_EMULATOR_HOST'
const moduleUrl = new URL('./checkStudent.js', import.meta.url)

process.env[ENVIRONMENT_VARIABLE] = '127.0.0.1:8080'
const checkStudent = await import(moduleUrl)

const {
  CHECK_STUDENT_APP_PREFIX,
  CheckStudentArgumentError,
  closeOwnedCheckStudentApp,
  createCheckStudentFirestore,
  parseCheckStudentArguments,
  readAndReportCheckStudent,
  runCheckStudent,
} = checkStudent

const VALID_ARGUMENTS = [
  '--project-id', 'check-student-test',
  '--teacher-uid', 'teacher-1',
  '--classroom-id', 'classroom-1',
]

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

function executeInChild(host, args = VALID_ARGUMENTS) {
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

function snapshot(exists, data) {
  return { exists, data: () => data }
}

function fakeFirestore(documents, failurePath) {
  const reads = []
  return {
    reads,
    firestore: {
      doc(path) {
        reads.push(path)
        return {
          async get() {
            if (path === failurePath) {
              throw new Error('secret-bearing-firestore-error')
            }
            return documents[path] ?? snapshot(false)
          },
        }
      },
    },
  }
}

function captureLogger() {
  const lines = []
  return { lines, logger: { log: line => lines.push(line) } }
}

test('direct execution refuses a missing or malformed emulator host', () => {
  for (const host of [undefined, 'https://localhost:8080']) {
    const result = executeInChild(host)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FIRESTORE_EMULATOR_HOST/u)
    assert.equal(result.stdout, '')
  }
})

test('direct execution reaches strict parsing without contacting Firestore', () => {
  const result = executeInChild('127.0.0.1:8080', [])

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Missing required flags/u)
  assert.equal(result.stdout, '')
})

test('safety validation precedes parsing, Admin, Firestore, reads, and logging', async () => {
  for (const host of [undefined, 'localhost:not-a-port']) {
    const calls = []
    const logger = { log: () => calls.push('logger') }
    const firestoreFactory = () => {
      calls.push('firestoreFactory')
      return { firestore: fakeFirestore({}).firestore }
    }

    await assert.rejects(
      withHost(host, () => runCheckStudent([], { logger, firestoreFactory })),
      /FIRESTORE_EMULATOR_HOST/u,
    )
    assert.deepEqual(calls, [])

    const guardedFirestore = {
      doc() {
        calls.push('doc')
        return { get: async () => snapshot(false) }
      },
    }
    await assert.rejects(
      withHost(host, () => readAndReportCheckStudent({
        firestore: guardedFirestore,
        teacherUid: 'teacher-1',
        classroomId: 'classroom-1',
        logger,
      })),
      /FIRESTORE_EMULATOR_HOST/u,
    )
    assert.deepEqual(calls, [])
  }

  const adminCalls = []
  assert.throws(
    () => withHost(undefined, () => createCheckStudentFirestore('test-project', {
      getApps: () => adminCalls.push('getApps'),
      initializeApp: () => adminCalls.push('initializeApp'),
      getFirestore: () => adminCalls.push('getFirestore'),
    })),
    /FIRESTORE_EMULATOR_HOST/u,
  )
  assert.deepEqual(adminCalls, [])
})

test('source removes cached credentials, temporary ADC, production ID, and writes', () => {
  const source = fs.readFileSync(moduleUrl, 'utf8')

  for (const forbidden of [
    /firebase-tools\.json/u,
    /temp_adc/u,
    /GOOGLE_APPLICATION_CREDENTIALS/u,
    /refresh_token/u,
    /client_secret/u,
    /\.homedir\s*\(/u,
    /['"]morgan-bank['"]/u,
    /\.\s*(?:set|create|update|delete|batch|runTransaction)\s*\(/u,
  ]) {
    assert.doesNotMatch(source, forbidden)
  }
})

test('direct execution redacts non-argument failure and cleanup detail', () => {
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/\s+/gu, ' ')

  assert.match(
    source,
    /error instanceof CheckStudentArgumentError \? error\.message : 'Diagnostic execution failed\.'/u,
  )
  assert.match(
    source,
    /catch \{ globalThis\.console\.error\('checkStudent cleanup failed\.'\)/u,
  )
})

test('parses the three explicit required inputs into an immutable result', () => {
  const parsed = parseCheckStudentArguments(VALID_ARGUMENTS)

  assert.deepEqual(parsed, {
    projectId: 'check-student-test',
    teacherUid: 'teacher-1',
    classroomId: 'classroom-1',
  })
  assert.ok(Object.isFrozen(parsed))
})

test('accepts required flags in any order', () => {
  assert.deepEqual(parseCheckStudentArguments([
    '--classroom-id', 'classroom-1',
    '--project-id', 'check-student-test',
    '--teacher-uid', 'teacher-1',
  ]), {
    projectId: 'check-student-test',
    teacherUid: 'teacher-1',
    classroomId: 'classroom-1',
  })
})

test('rejects every missing required flag', () => {
  for (const flag of ['--project-id', '--teacher-uid', '--classroom-id']) {
    const index = VALID_ARGUMENTS.indexOf(flag)
    const argv = VALID_ARGUMENTS.filter((_, itemIndex) =>
      itemIndex !== index && itemIndex !== index + 1)

    assert.throws(
      () => parseCheckStudentArguments(argv),
      error => error instanceof CheckStudentArgumentError &&
        error.category === 'missing-required-flag' &&
        error.flags.includes(flag),
      flag,
    )
  }
})

test('rejects missing, blank, and whitespace-padded flag values', () => {
  const cases = [
    ['--project-id'],
    ['--project-id', ''],
    ['--project-id', '   '],
    ['--project-id', ' padded'],
    ['--project-id', 'padded '],
    ['--project-id', '--teacher-uid'],
  ]

  for (const argv of cases) {
    assert.throws(
      () => parseCheckStudentArguments(argv),
      error => error instanceof CheckStudentArgumentError &&
        ['missing-value', 'invalid-value'].includes(error.category),
      JSON.stringify(argv),
    )
  }
})

test('rejects duplicate, unknown, positional, assignment, and non-string arguments', () => {
  const cases = [
    [[...VALID_ARGUMENTS, '--project-id', 'other'], 'duplicate-flag'],
    [[...VALID_ARGUMENTS, '--write'], 'unknown-flag'],
    [['--project-id=value'], 'unknown-flag'],
    [['positional'], 'positional-argument'],
    [[123], 'invalid-argument'],
  ]

  for (const [argv, category] of cases) {
    assert.throws(
      () => parseCheckStudentArguments(argv),
      error => error instanceof CheckStudentArgumentError &&
        error.category === category,
      JSON.stringify(argv),
    )
  }

  for (const value of [undefined, null, {}, 'arguments']) {
    assert.throws(
      () => parseCheckStudentArguments(value),
      error => error instanceof CheckStudentArgumentError &&
        error.category === 'invalid-arguments',
    )
  }
})

test('rejects invalid teacher and classroom Firestore document IDs', () => {
  for (const [flag, value] of [
    ['--teacher-uid', 'teachers/one'],
    ['--teacher-uid', '.'],
    ['--classroom-id', 'classrooms/one'],
    ['--classroom-id', '__reserved__'],
  ]) {
    const argv = [...VALID_ARGUMENTS]
    argv[argv.indexOf(flag) + 1] = value

    assert.throws(
      () => parseCheckStudentArguments(argv),
      error => error instanceof CheckStudentArgumentError &&
        error.category === 'invalid-document-id' && error.flag === flag,
      value,
    )
  }
})

test('passes the explicit project ID to an isolated Admin app and Firestore', () => {
  withHost('127.0.0.1:8080', () => {
    const calls = []
    const app = { name: `${CHECK_STUDENT_APP_PREFIX}explicit-test-project` }
    const firestore = { kind: 'fake-firestore' }
    const resources = createCheckStudentFirestore('explicit-test-project', {
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
      ['initializeApp', { projectId: 'explicit-test-project' }, app.name],
      ['getFirestore', app],
    ])
    assert.equal(resources.firestore, firestore)
    assert.equal(resources.ownsApp, true)
  })
})

test('reads exact ownership and credential paths and emits only an allowlisted summary', async () => {
  const secretValues = [
    'pin-hash-secret',
    'refresh-token-secret',
    'auth-token-secret',
    'future-secret',
  ]
  const documents = {
    'teachers/teacher-1': snapshot(true, {
      uid: 'teacher-1',
      classroomId: 'classroom-1',
      email: 'private@example.test',
    }),
    'classrooms/classroom-1': snapshot(true, {
      ownerUid: 'teacher-1',
      settings: { privateValue: secretValues[3] },
    }),
    'studentCredentials/edge-test': snapshot(true, {
      classroomId: 'classroom-1',
      studentId: 'student-1',
      active: true,
      pinHash: secretValues[0],
      refreshToken: secretValues[1],
      authToken: secretValues[2],
      futureCredentialSecret: secretValues[3],
    }),
  }
  const { firestore, reads } = fakeFirestore(documents)
  const { logger, lines } = captureLogger()

  const report = await readAndReportCheckStudent({
    firestore,
    teacherUid: 'teacher-1',
    classroomId: 'classroom-1',
    logger,
  })

  assert.deepEqual(reads, [
    'teachers/teacher-1',
    'classrooms/classroom-1',
    'studentCredentials/edge-test',
  ])
  assert.deepEqual(report, {
    teacher: {
      path: 'teachers/teacher-1',
      exists: true,
      uidMatches: true,
      classroomIdMatches: true,
    },
    classroom: {
      path: 'classrooms/classroom-1',
      exists: true,
      ownerUidMatches: true,
    },
    credential: {
      path: 'studentCredentials/edge-test',
      exists: true,
      classroomIdMatches: true,
      studentId: 'student-1',
      active: true,
    },
  })
  assert.deepEqual(lines, [JSON.stringify(report, null, 2)])

  const output = lines.join('\n')
  assert.doesNotMatch(output, /pinHash|refreshToken|authToken|futureCredentialSecret/u)
  for (const secret of secretValues) {
    assert.equal(output.includes(secret), false)
  }
})

test('reports missing documents and ownership mismatches without exposing bodies', async () => {
  const { firestore } = fakeFirestore({
    'teachers/teacher-1': snapshot(true, {
      uid: 'other-teacher',
      classroomId: 'other-classroom',
    }),
    'classrooms/classroom-1': snapshot(true, { ownerUid: 'other-teacher' }),
  })
  const { logger, lines } = captureLogger()

  const report = await readAndReportCheckStudent({
    firestore,
    teacherUid: 'teacher-1',
    classroomId: 'classroom-1',
    logger,
  })

  assert.equal(report.teacher.uidMatches, false)
  assert.equal(report.teacher.classroomIdMatches, false)
  assert.equal(report.classroom.ownerUidMatches, false)
  assert.deepEqual(report.credential, {
    path: 'studentCredentials/edge-test',
    exists: false,
    classroomIdMatches: false,
    studentId: null,
    active: null,
  })
  assert.deepEqual(lines, [JSON.stringify(report, null, 2)])
})

test('propagates read failures without logging partial output', async () => {
  const { firestore } = fakeFirestore({}, 'classrooms/classroom-1')
  const { logger, lines } = captureLogger()

  await assert.rejects(
    readAndReportCheckStudent({
      firestore,
      teacherUid: 'teacher-1',
      classroomId: 'classroom-1',
      logger,
    }),
    /secret-bearing-firestore-error/u,
  )
  assert.deepEqual(lines, [])
})

test('runCheckStudent passes parsed identities through construction and reads', async () => {
  await withHost('127.0.0.1:8080', async () => {
    const { firestore, reads } = fakeFirestore({})
    const { logger } = captureLogger()
    const projects = []
    const execution = await runCheckStudent(VALID_ARGUMENTS, {
      logger,
      firestoreFactory(projectId) {
        projects.push(projectId)
        return { firestore, ownsApp: false }
      },
    })

    assert.deepEqual(projects, ['check-student-test'])
    assert.deepEqual(reads, [
      'teachers/teacher-1',
      'classrooms/classroom-1',
      'studentCredentials/edge-test',
    ])
    assert.deepEqual(execution.parsed, {
      projectId: 'check-student-test',
      teacherUid: 'teacher-1',
      classroomId: 'classroom-1',
    })
  })
})

test('importing with a valid host has no diagnostic or credential side effects', () => {
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

test('reuses only its own named Admin app', () => {
  withHost('127.0.0.1:8080', () => {
    const unrelatedApp = { name: '[DEFAULT]' }
    const ownedApp = { name: `${CHECK_STUDENT_APP_PREFIX}shared-test-project` }
    let initializeCalls = 0
    const resources = createCheckStudentFirestore('shared-test-project', {
      getApps: () => [unrelatedApp, ownedApp],
      initializeApp: () => {
        initializeCalls += 1
      },
      getFirestore: app => ({ app }),
    })

    assert.equal(initializeCalls, 0)
    assert.equal(resources.app, ownedApp)
    assert.equal(resources.ownsApp, false)
  })
})

test('cleanup releases only an app created by this script', async () => {
  const calls = []
  const resources = {
    app: { name: `${CHECK_STUDENT_APP_PREFIX}owned` },
    firestore: { name: 'firestore' },
    ownsApp: true,
  }
  const dependencies = {
    terminate: async firestore => calls.push(['terminate', firestore]),
    deleteApp: async app => calls.push(['deleteApp', app]),
  }

  assert.equal(await closeOwnedCheckStudentApp(resources, dependencies), true)
  assert.deepEqual(calls, [
    ['terminate', resources.firestore],
    ['deleteApp', resources.app],
  ])

  calls.length = 0
  assert.equal(
    await closeOwnedCheckStudentApp({ ...resources, ownsApp: false }, dependencies),
    false,
  )
  assert.deepEqual(calls, [])
})
