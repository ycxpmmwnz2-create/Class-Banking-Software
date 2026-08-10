import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLI_MODE,
  CliArgumentError,
  parseCliArguments,
} from './cli.js'

function assertCliError(argv, expectedCategory) {
  assert.throws(
    () => parseCliArguments(argv),
    error => {
      assert.ok(error instanceof CliArgumentError)
      assert.equal(error.code, 'CLI_ARGUMENT_ERROR')
      assert.equal(error.category, expectedCategory)
      return true
    },
  )
}

test('parses the required identity as dry-run mode by default', () => {
  const result = parseCliArguments([
    '--teacher-uid',
    'teacher-123',
    '--project-id',
    'demo-class-banking',
  ])

  assert.deepEqual(result, {
    teacherUid: 'teacher-123',
    projectId: 'demo-class-banking',
    write: false,
    mode: CLI_MODE.DRY_RUN,
  })
  assert.equal(Object.isFrozen(result), true)
})

test('parses --write in any flag position as explicit write mode', () => {
  const result = parseCliArguments([
    '--project-id',
    'demo-class-banking',
    '--write',
    '--teacher-uid',
    'teacher-123',
  ])

  assert.deepEqual(result, {
    teacherUid: 'teacher-123',
    projectId: 'demo-class-banking',
    write: true,
    mode: CLI_MODE.WRITE,
  })
})

test('requires both identifying flags', () => {
  assertCliError([], 'missing-required-flag')
  assertCliError(['--teacher-uid', 'teacher-123'], 'missing-required-flag')
  assertCliError(['--project-id', 'demo-class-banking'], 'missing-required-flag')
  assertCliError(['--write'], 'missing-required-flag')
})

test('rejects missing, blank, and non-canonical flag values', () => {
  assertCliError(['--teacher-uid'], 'missing-value')
  assertCliError(['--teacher-uid', '--project-id', 'project'], 'missing-value')
  assertCliError(['--teacher-uid', '', '--project-id', 'project'], 'missing-value')
  assertCliError(['--teacher-uid', ' ', '--project-id', 'project'], 'missing-value')
  assertCliError(
    ['--teacher-uid', ' teacher ', '--project-id', 'project'],
    'invalid-value',
  )
})

test('rejects every duplicate flag, even when values agree', () => {
  assertCliError(
    [
      '--teacher-uid',
      'teacher-123',
      '--teacher-uid',
      'teacher-123',
      '--project-id',
      'project',
    ],
    'duplicate-flag',
  )
  assertCliError(
    [
      '--teacher-uid',
      'teacher-123',
      '--project-id',
      'project',
      '--project-id',
      'other-project',
    ],
    'duplicate-flag',
  )
  assertCliError(
    [
      '--teacher-uid',
      'teacher-123',
      '--project-id',
      'project',
      '--write',
      '--write',
    ],
    'duplicate-flag',
  )
})

test('explicitly rejects manifest and state-path overrides', () => {
  for (const overrideFlag of [
    '--manifest',
    '--state-dir',
    '--manifest-dir',
    '--manifest-file',
    '--manifest-filename',
  ]) {
    assertCliError(
      [
        '--teacher-uid',
        'teacher-123',
        '--project-id',
        'project',
        overrideFlag,
        '/tmp/other-manifest',
      ],
      'unsupported-override',
    )

    assertCliError(
      [
        '--teacher-uid',
        'teacher-123',
        '--project-id',
        'project',
        `${overrideFlag}=/tmp/other-manifest`,
      ],
      'unsupported-override',
    )
  }
})

test('rejects unknown, production, confirmation, and bypass flags', () => {
  for (const flag of [
    '--unknown',
    '--dry-run',
    '--production',
    '--force',
    '--yes',
    '--confirm',
    '--emulator-host',
    '--state-directory',
    '--manifest-path',
  ]) {
    assertCliError(
      [
        '--teacher-uid',
        'teacher-123',
        '--project-id',
        'project',
        flag,
      ],
      'unknown-flag',
    )
  }
})

test('rejects positional arguments and contradictory mode input', () => {
  assertCliError(
    [
      'positional',
      '--teacher-uid',
      'teacher-123',
      '--project-id',
      'project',
    ],
    'positional-argument',
  )
  assertCliError(
    [
      '--teacher-uid',
      'teacher-123',
      '--project-id',
      'project',
      '--write',
      'false',
    ],
    'positional-argument',
  )
  assertCliError(
    [
      '--teacher-uid',
      'teacher-123',
      '--project-id',
      'project',
      '--write',
      '--dry-run',
    ],
    'unknown-flag',
  )
})

test('rejects assignment syntax because it is outside the exact allowlist', () => {
  assertCliError(
    ['--teacher-uid=teacher-123', '--project-id', 'project'],
    'unknown-flag',
  )
  assertCliError(
    ['--teacher-uid', 'teacher-123', '--project-id=project'],
    'unknown-flag',
  )
  assertCliError(
    ['--teacher-uid', 'teacher-123', '--project-id', 'project', '--write=true'],
    'unknown-flag',
  )
})

test('rejects non-array input and non-string tokens', () => {
  assertCliError(undefined, 'invalid-arguments')
  assertCliError('not-an-array', 'invalid-arguments')
  assertCliError(
    ['--teacher-uid', 'teacher-123', '--project-id', 123],
    'missing-value',
  )
  assertCliError(
    ['--teacher-uid', 'teacher-123', '--project-id', 'project', null],
    'invalid-argument',
  )
})
