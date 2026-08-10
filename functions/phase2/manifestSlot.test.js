import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath, URL } from 'node:url'

import {
  CANONICAL_STATE_DIRECTORY,
  deriveCanonicalManifestSlot,
  MANIFEST_SCHEMA_VERSION,
  PHASE2A_MIGRATION_ID,
} from './manifestSlot.js'

const IDENTITY = {
  emulatorProjectId: 'class-banking-emulator',
  teacherUid: 'teacher-1',
}

const PHASE2_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(PHASE2_DIRECTORY, '../..')

test('owns the fixed Phase 2A manifest identity and module-anchored directory', () => {
  assert.equal(
    PHASE2A_MIGRATION_ID,
    'class-banking-phase2a-legacy-classroom-migration',
  )
  assert.equal(MANIFEST_SCHEMA_VERSION, 1)
  assert.equal(
    CANONICAL_STATE_DIRECTORY,
    fileURLToPath(new URL('./.state/', import.meta.url)),
  )
})

test('repository policy ignores a nonexistent representative manifest path', () => {
  const relativeManifestPath =
    'functions/phase2/.state/example.manifest.json'
  const representativeManifestPath = path.join(
    REPOSITORY_ROOT,
    relativeManifestPath,
  )
  const stateDirectoryInitiallyExists = existsSync(CANONICAL_STATE_DIRECTORY)

  assert.equal(existsSync(representativeManifestPath), false)

  const result = spawnSync(
    'git',
    ['check-ignore', '--quiet', relativeManifestPath],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(representativeManifestPath), false)
  assert.equal(
    existsSync(CANONICAL_STATE_DIRECTORY),
    stateDirectoryInitiallyExists,
  )
})

test('derives the filename from exactly the canonical fixed identity', () => {
  const canonicalIdentity = '{"emulatorProjectId":"class-banking-emulator",' +
    '"migrationId":"class-banking-phase2a-legacy-classroom-migration",' +
    '"schemaVersion":1,"teacherUid":"teacher-1"}'
  const expectedHash = createHash('sha256')
    .update(canonicalIdentity, 'utf8')
    .digest('hex')
  const expectedFilename = `${expectedHash}.manifest.json`

  assert.deepEqual(deriveCanonicalManifestSlot(IDENTITY), {
    stateDirectory: CANONICAL_STATE_DIRECTORY,
    filename: expectedFilename,
    manifestPath: path.join(CANONICAL_STATE_DIRECTORY, expectedFilename),
  })
  assert.match(expectedFilename, /^[a-f0-9]{64}\.manifest\.json$/)
})

test('derivation is independent of the current working directory', () => {
  const originalWorkingDirectory = process.cwd()

  try {
    const initialSlot = deriveCanonicalManifestSlot(IDENTITY)
    process.chdir(tmpdir())
    const slotFromAnotherDirectory = deriveCanonicalManifestSlot(IDENTITY)

    assert.deepEqual(slotFromAnotherDirectory, initialSlot)
  } finally {
    process.chdir(originalWorkingDirectory)
  }
})

test('returns immutable path information', () => {
  const slot = deriveCanonicalManifestSlot(IDENTITY)

  assert.equal(Object.isFrozen(slot), true)
  assert.throws(() => {
    slot.filename = 'other.manifest.json'
  }, TypeError)
})

test('project and teacher identities select different canonical slots', () => {
  const originalSlot = deriveCanonicalManifestSlot(IDENTITY)
  const differentProjectSlot = deriveCanonicalManifestSlot({
    ...IDENTITY,
    emulatorProjectId: 'another-emulator',
  })
  const differentTeacherSlot = deriveCanonicalManifestSlot({
    ...IDENTITY,
    teacherUid: 'teacher-2',
  })

  assert.notEqual(differentProjectSlot.manifestPath, originalSlot.manifestPath)
  assert.notEqual(differentTeacherSlot.manifestPath, originalSlot.manifestPath)
  assert.notEqual(differentProjectSlot.manifestPath, differentTeacherSlot.manifestPath)
})

test('rejects missing identity and every override-like input', () => {
  assert.throws(
    () => deriveCanonicalManifestSlot({ teacherUid: 'teacher-1' }),
    /emulatorProjectId must be a non-empty canonical string/,
  )
  assert.throws(
    () => deriveCanonicalManifestSlot({
      ...IDENTITY,
      teacherUid: ' teacher-1 ',
    }),
    /teacherUid must be a non-empty canonical string/,
  )

  for (const override of [
    { stateDirectory: '/tmp/other-state' },
    { filename: 'other.manifest.json' },
    { checksum: 'checksum' },
    { classroomId: 'classroom-1' },
  ]) {
    assert.throws(
      () => deriveCanonicalManifestSlot({ ...IDENTITY, ...override }),
      /does not accept override inputs/,
    )
  }
})
