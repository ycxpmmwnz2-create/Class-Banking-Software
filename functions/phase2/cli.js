const VALUE_FLAGS = new Map([
  ['--teacher-uid', 'teacherUid'],
  ['--project-id', 'projectId'],
])

const REQUIRED_FLAGS = [...VALUE_FLAGS.keys()]
const WRITE_FLAG = '--write'
const UNSUPPORTED_OVERRIDE_FLAGS = new Set([
  '--manifest',
  '--state-dir',
  '--manifest-dir',
  '--manifest-file',
  '--manifest-filename',
])

export const CLI_MODE = Object.freeze({
  DRY_RUN: 'dry-run',
  WRITE: 'write',
})

export class CliArgumentError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'CliArgumentError'
    this.code = 'CLI_ARGUMENT_ERROR'
    this.category = category
    Object.assign(this, details)
  }
}

function fail(category, message, details) {
  throw new CliArgumentError(category, message, details)
}

function assertUnique(seenFlags, flag, index) {
  if (seenFlags.has(flag)) {
    fail('duplicate-flag', `Duplicate flag: ${flag}.`, { flag, index })
  }

  seenFlags.add(flag)
}

function parseValue(argv, index, flag) {
  const valueIndex = index + 1
  const value = argv[valueIndex]

  if (
    valueIndex >= argv.length ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.startsWith('--')
  ) {
    fail('missing-value', `${flag} requires a value.`, { flag, index })
  }

  if (value.trim() !== value) {
    fail(
      'invalid-value',
      `${flag} must not have leading or trailing whitespace.`,
      { flag, index: valueIndex },
    )
  }

  return value
}

function overrideFlagFor(token) {
  const separatorIndex = token.indexOf('=')
  const flag = separatorIndex === -1 ? token : token.slice(0, separatorIndex)
  return UNSUPPORTED_OVERRIDE_FLAGS.has(flag) ? flag : undefined
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv)) {
    fail('invalid-arguments', 'CLI arguments must be provided as an array.')
  }

  const values = {}
  const seenFlags = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (typeof token !== 'string') {
      fail('invalid-argument', 'Every CLI argument must be a string.', {
        index,
      })
    }

    if (VALUE_FLAGS.has(token)) {
      assertUnique(seenFlags, token, index)
      values[VALUE_FLAGS.get(token)] = parseValue(argv, index, token)
      index += 1
      continue
    }

    if (token === WRITE_FLAG) {
      assertUnique(seenFlags, token, index)
      continue
    }

    const overrideFlag = overrideFlagFor(token)
    if (overrideFlag !== undefined) {
      fail(
        'unsupported-override',
        `${overrideFlag} is unsupported; the canonical manifest slot cannot be overridden.`,
        { flag: overrideFlag, index },
      )
    }

    if (token.startsWith('--')) {
      fail('unknown-flag', `Unknown flag: ${token}.`, { flag: token, index })
    }

    fail('positional-argument', `Positional arguments are not supported: ${token}.`, {
      index,
      token,
    })
  }

  const missingFlags = REQUIRED_FLAGS.filter(flag => !seenFlags.has(flag))
  if (missingFlags.length > 0) {
    fail(
      'missing-required-flag',
      `Missing required flag${missingFlags.length === 1 ? '' : 's'}: ${missingFlags.join(', ')}.`,
      { flags: missingFlags },
    )
  }

  const write = seenFlags.has(WRITE_FLAG)

  return Object.freeze({
    teacherUid: values.teacherUid,
    projectId: values.projectId,
    write,
    mode: write ? CLI_MODE.WRITE : CLI_MODE.DRY_RUN,
  })
}
