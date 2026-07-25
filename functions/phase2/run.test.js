import process from 'node:process'
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

import { Timestamp } from 'firebase-admin/firestore'

import { deriveCanonicalManifestSlot } from './manifestSlot.js'
import { CliArgumentError } from './cli.js'
import { FoundationValidationError } from './foundationValidator.js'
import {
  DestinationPreflightError,
  DESTINATION_PREFLIGHT_ERROR_CATEGORIES,
} from './destinationPreflight.js'
import { ManifestError, MANIFEST_ERROR_CATEGORIES } from './manifest.js'
import {
  BatchWriterError,
  BATCH_WRITER_ERROR_CATEGORIES,
} from './batchWriter.js'
import { ReconciliationError } from './reconciliation.js'
import { MigrateClassroomDataError, MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES } from './migrateClassroomData.js'

const { runMain, EXIT_CODES, classifyErrorToExitCode } = await import('./run.js')
const { EmulatorEnvironmentError } = await import('./emulatorEnvironment.js')

const PROJECT_ID = 'cli-test-project-id'
const CLASSROOM_ID = 'cli-test-classroom'

function cleanManifestFile(teacherUid) {
  const slot = deriveCanonicalManifestSlot({ emulatorProjectId: PROJECT_ID, teacherUid })
  if (fs.existsSync(slot.manifestPath)) {
    fs.unlinkSync(slot.manifestPath)
  }
}

function envelope(collection, id, data, second = 10) {
  return {
    id,
    path: `${collection}/${id}`,
    data,
    updateTime: new Timestamp(second, 100000000),
  }
}

function fixtureData(teacherUid = 'cli-test-teacher-uid') {
  const teacher = envelope('teachers', teacherUid, {
    uid: teacherUid,
    classroomId: CLASSROOM_ID,
    status: 'active',
  }, 1)

  const classroom = envelope('classrooms', CLASSROOM_ID, {
    ownerUid: teacherUid,
    name: 'CLI Test Class',
    createdAt: new Timestamp(10, 0),
    updatedAt: new Timestamp(20, 0),
    version: 1,
    settings: {},
  }, 2)

  const legacyClassroomData = envelope('morganBank', 'classroomData', {
    students: [
      { id: 's1', name: 'Alice', balance: 10, frozen: false },
    ],
    transactions: [],
    loginHistory: [],
    settings: { currencyName: 'Bucks' },
    lastBackupAt: new Timestamp(30, 0),
  }, 3)

  const studentCredentials = [
    envelope('studentCredentials', 's1-login', {
      classroomId: 'morgan',
      studentId: 's1',
      active: true,
      pinHash: 'hash-s1-pin',
    }, 4),
  ]

  const studentAuthLogs = []

  return {
    teacher,
    classroom,
    legacyClassroomData,
    studentCredentials,
    studentAuthLogs,
  }
}

class FakeQuery {
  constructor(firestore, path, cursorId = null, limitVal = null) {
    this.firestore = firestore
    this.path = path
    this.cursorId = cursorId
    this.limitVal = limitVal
  }

  doc(docId) {
    return this.firestore.doc(`${this.path}/${docId}`)
  }

  orderBy() {
    return this
  }

  startAfter(snapshot) {
    const id = typeof snapshot === 'object' && snapshot !== null ? snapshot.id : snapshot
    return new FakeQuery(this.firestore, this.path, id, this.limitVal)
  }

  limit(val) {
    return new FakeQuery(this.firestore, this.path, this.cursorId, val)
  }

  async get() {
    const all = []
    for (const [p, doc] of this.firestore.docsMap.entries()) {
      if (p.startsWith(`${this.path}/`) && p.split('/').length === this.path.split('/').length + 1) {
        all.push({
          exists: true,
          id: doc.id ?? p.split('/').pop(),
          ref: this.firestore.doc(p),
          data: () => doc.data,
          updateTime: doc.updateTime ?? new Timestamp(100, 0),
        })
      }
    }
    all.sort((a, b) => a.id.localeCompare(b.id))
    let filtered = all
    if (this.cursorId !== null) {
      const idx = all.findIndex(d => d.id === this.cursorId)
      if (idx !== -1) {
        filtered = all.slice(idx + 1)
      }
    }
    if (this.limitVal !== null) {
      filtered = filtered.slice(0, this.limitVal)
    }
    return {
      docs: filtered,
      empty: filtered.length === 0,
      size: filtered.length,
    }
  }
}

function fakeFirestore(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs))
  const writeHistory = []

  const self = {
    docsMap: docs,
    writeHistory,
    doc(path) {
      return {
        id: path.split('/').pop(),
        path,
        async get() {
          if (!docs.has(path)) {
            return { exists: false, id: path.split('/').pop(), ref: self.doc(path), data: () => undefined }
          }
          const entry = docs.get(path)
          return {
            exists: true,
            id: entry.id ?? path.split('/').pop(),
            ref: self.doc(path),
            data: () => entry.data,
            updateTime: entry.updateTime ?? new Timestamp(100, 0),
          }
        },
        async set(data, options) {
          writeHistory.push({ type: 'set', path, data, options })
          docs.set(path, { id: path.split('/').pop(), path, data, updateTime: new Timestamp(200, 0) })
        },
        async update(data) {
          writeHistory.push({ type: 'update', path, data })
          const existing = docs.get(path)?.data ?? {}
          docs.set(path, { id: path.split('/').pop(), path, data: { ...existing, ...data }, updateTime: new Timestamp(200, 0) })
        },
      }
    },
    collection(collectionPath) {
      return new FakeQuery(self, collectionPath)
    },
    batch() {
      const batchWrites = []
      return {
        create(docRef, data) {
          batchWrites.push({ type: 'create', ref: docRef, data })
        },
        set(docRef, data, options) {
          batchWrites.push({ type: 'set', ref: docRef, data, options })
        },
        update(docRef, data, options) {
          batchWrites.push({ type: 'update', ref: docRef, data, options })
        },
        async commit() {
          for (const op of batchWrites) {
            if (op.type === 'create') {
              await op.ref.set(op.data)
            } else if (op.type === 'set') {
              await op.ref.set(op.data, op.options)
            } else if (op.type === 'update') {
              await op.ref.update(op.data)
            }
          }
        },
      }
    },
  }

  return self
}

function buildFirestoreMap(fix) {
  const map = {}
  map[fix.teacher.path] = fix.teacher
  map[fix.classroom.path] = fix.classroom
  map[fix.legacyClassroomData.path] = fix.legacyClassroomData
  for (const cred of fix.studentCredentials) {
    map[cred.path] = cred
  }
  for (const log of fix.studentAuthLogs) {
    map[log.path] = log
  }
  return map
}

function mockLogger() {
  const logs = []
  const errors = []
  return {
    log(...args) { logs.push(args.join(' ')) },
    error(...args) { errors.push(args.join(' ')) },
    logs,
    errors,
  }
}

test('CLI classifies errors into distinct exit codes correctly', () => {
  assert.equal(classifyErrorToExitCode(new CliArgumentError('unknown-flag', 'test')), EXIT_CODES.VALIDATION_FAILURE)
  assert.equal(classifyErrorToExitCode(new EmulatorEnvironmentError('MISSING', 'test')), EXIT_CODES.VALIDATION_FAILURE)
  assert.equal(classifyErrorToExitCode(new FoundationValidationError('MISSING', 'test')), EXIT_CODES.VALIDATION_FAILURE)

  assert.equal(
    classifyErrorToExitCode(new DestinationPreflightError(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.DIVERGENT_DESTINATIONS,
      'test',
    )),
    EXIT_CODES.PREFLIGHT_CONFLICT,
  )
  assert.equal(
    classifyErrorToExitCode(new DestinationPreflightError(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_SNAPSHOT,
      'test',
    )),
    EXIT_CODES.VALIDATION_FAILURE,
  )
  assert.equal(classifyErrorToExitCode(new MigrateClassroomDataError(MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.PREFLIGHT_CONFLICT, 'test')), EXIT_CODES.PREFLIGHT_CONFLICT)
  assert.equal(classifyErrorToExitCode(new MigrateClassroomDataError(MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.RECOVERY_DIVERGENT, 'test')), EXIT_CODES.PREFLIGHT_CONFLICT)

  assert.equal(classifyErrorToExitCode(new ManifestError('DRIFT', 'test')), EXIT_CODES.STALE_MANIFEST_MISMATCH)
  assert.equal(classifyErrorToExitCode(new MigrateClassroomDataError(MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT, 'test')), EXIT_CODES.STALE_MANIFEST_MISMATCH)

  assert.equal(classifyErrorToExitCode(new BatchWriterError('WRITE_FAIL', 'test')), EXIT_CODES.WRITE_FAILURE)
  assert.equal(classifyErrorToExitCode(new MigrateClassroomDataError(MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.WRITE_FAILED, 'test')), EXIT_CODES.WRITE_FAILURE)

  for (const category of [
    BATCH_WRITER_ERROR_CATEGORIES.COMMIT_INDETERMINATE,
    BATCH_WRITER_ERROR_CATEGORIES.MANIFEST_PERSISTENCE_INDETERMINATE,
    BATCH_WRITER_ERROR_CATEGORIES.VERIFICATION_INDETERMINATE,
  ]) {
    assert.equal(
      classifyErrorToExitCode(new BatchWriterError(category, 'test')),
      EXIT_CODES.INDETERMINATE_RECOVERY_REQUIRED,
    )
  }

  assert.equal(
    classifyErrorToExitCode(new ManifestError(MANIFEST_ERROR_CATEGORIES.WRITE_FAILED, 'test')),
    EXIT_CODES.WRITE_FAILURE,
  )

  assert.equal(classifyErrorToExitCode(new ReconciliationError('RECON_FAIL', 'test')), EXIT_CODES.RECONCILIATION_FAILURE)
  assert.equal(classifyErrorToExitCode(new MigrateClassroomDataError(MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.RECONCILIATION_FAILED, 'test')), EXIT_CODES.RECONCILIATION_FAILURE)
})

test('runMain refuses execution without FIRESTORE_EMULATOR_HOST', async () => {
  const originalEnv = process.env.FIRESTORE_EMULATOR_HOST
  delete process.env.FIRESTORE_EMULATOR_HOST

  try {
    const logger = mockLogger()
    const { exitCode, error } = await runMain(['--teacher-uid', 'run-test-teacher-1', '--project-id', PROJECT_ID], { logger })

    assert.equal(exitCode, EXIT_CODES.VALIDATION_FAILURE)
    assert.ok(error instanceof EmulatorEnvironmentError)
  } finally {
    if (originalEnv) {
      process.env.FIRESTORE_EMULATOR_HOST = originalEnv
    }
  }
})

test('runMain displays canonical manifest path and succeeds on valid dry run', async () => {
  const teacherUid = 'run-test-teacher-2'
  cleanManifestFile(teacherUid)
  const fix = fixtureData(teacherUid)
  const firestore = fakeFirestore(buildFirestoreMap(fix))
  const logger = mockLogger()
  const slot = deriveCanonicalManifestSlot({ emulatorProjectId: PROJECT_ID, teacherUid })

  const { exitCode, canonicalPath, result } = await runMain(
    ['--teacher-uid', teacherUid, '--project-id', PROJECT_ID],
    { logger, firestore },
  )

  assert.equal(exitCode, EXIT_CODES.SUCCESS)
  assert.equal(canonicalPath, slot.manifestPath)
  assert.equal(result.mode, 'dry-run')
  assert.ok(logger.logs.some(line => line.includes(slot.manifestPath)))
})

test('runMain rejects override flags before accessing Firestore', async () => {
  for (const override of [
    '--manifest',
    '--state-dir',
    '--manifest-dir',
    '--manifest-file',
    '--manifest-filename',
  ]) {
    const logger = mockLogger()
    let firestoreAccesses = 0

    const { exitCode, error } = await runMain(
      ['--teacher-uid', 'run-test-teacher-3', '--project-id', PROJECT_ID, override, '/tmp/override.json'],
      {
        logger,
        firestoreFactory() {
          firestoreAccesses += 1
          return fakeFirestore()
        },
      },
    )

    assert.equal(exitCode, EXIT_CODES.VALIDATION_FAILURE)
    assert.ok(error instanceof CliArgumentError)
    assert.equal(error.category, 'unsupported-override')
    assert.equal(firestoreAccesses, 0)
  }
})

test('runMain returns every distinct operational exit path', async () => {
  const cases = [
    [
      new MigrateClassroomDataError(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.PREFLIGHT_CONFLICT,
        'preflight',
      ),
      EXIT_CODES.PREFLIGHT_CONFLICT,
    ],
    [
      new MigrateClassroomDataError(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT,
        'stale',
      ),
      EXIT_CODES.STALE_MANIFEST_MISMATCH,
    ],
    [
      new MigrateClassroomDataError(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.WRITE_FAILED,
        'clear write failure',
      ),
      EXIT_CODES.WRITE_FAILURE,
    ],
    [
      new MigrateClassroomDataError(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.INDETERMINATE_RECOVERY_REQUIRED,
        'uncertain write outcome',
      ),
      EXIT_CODES.INDETERMINATE_RECOVERY_REQUIRED,
    ],
    [
      new MigrateClassroomDataError(
        MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.RECONCILIATION_FAILED,
        'reconciliation',
      ),
      EXIT_CODES.RECONCILIATION_FAILURE,
    ],
  ]

  for (const [injectedError, expectedExitCode] of cases) {
    const result = await runMain(
      ['--teacher-uid', 'run-test-exit-paths', '--project-id', PROJECT_ID],
      {
        logger: mockLogger(),
        firestore: fakeFirestore(),
        async migrateClassroomData() {
          throw injectedError
        },
      },
    )

    assert.equal(result.exitCode, expectedExitCode)
    assert.equal(result.error, injectedError)
  }
})
