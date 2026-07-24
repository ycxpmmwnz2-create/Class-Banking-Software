import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import test from 'node:test'
import { URL } from 'node:url'

const ENVIRONMENT_VARIABLE = 'FIRESTORE_EMULATOR_HOST'
const moduleUrl = new URL('./emulatorEnvironment.js', import.meta.url)

const previousHost = process.env[ENVIRONMENT_VARIABLE]
let emulatorEnvironment

try {
  process.env[ENVIRONMENT_VARIABLE] = 'localhost:8080'
  emulatorEnvironment = await import(moduleUrl)
} finally {
  if (previousHost === undefined) {
    delete process.env[ENVIRONMENT_VARIABLE]
  } else {
    process.env[ENVIRONMENT_VARIABLE] = previousHost
  }
}

const {
  EMULATOR_ENVIRONMENT_ERROR_CODES,
  FIRESTORE_EMULATOR_HOST,
  EmulatorEnvironmentError,
  requireFirestoreEmulatorHost,
  validateFirestoreEmulatorHost,
} = emulatorEnvironment

function importInChild(host) {
  const environment = { ...process.env }

  if (host === undefined) {
    delete environment[ENVIRONMENT_VARIABLE]
  } else {
    environment[ENVIRONMENT_VARIABLE] = host
  }

  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(moduleUrl.href)})`,
    ],
    { encoding: 'utf8', env: environment },
  )
}

function withHost(host, callback) {
  const originalHost = process.env[ENVIRONMENT_VARIABLE]

  try {
    if (host === undefined) {
      delete process.env[ENVIRONMENT_VARIABLE]
    } else {
      process.env[ENVIRONMENT_VARIABLE] = host
    }

    callback()
  } finally {
    if (originalHost === undefined) {
      delete process.env[ENVIRONMENT_VARIABLE]
    } else {
      process.env[ENVIRONMENT_VARIABLE] = originalHost
    }
  }
}

test('refuses to load without FIRESTORE_EMULATOR_HOST', () => {
  const result = importInChild(undefined)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /FIRESTORE_EMULATOR_HOST is required/u)
})

test('refuses to load with an unusable FIRESTORE_EMULATOR_HOST', () => {
  const result = importInChild('https://localhost:8080')

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /FIRESTORE_EMULATOR_HOST/u)
})

test('loads with hostname, IPv4, and bracketed IPv6 host:port values', () => {
  for (const host of [
    'localhost:8080',
    '127.0.0.1:8080',
    '[::1]:8080',
    'firestore-emulator:9090',
  ]) {
    const result = importInChild(host)

    assert.equal(result.status, 0, result.stderr)
  }
})

test('validates usable host:port values without restricting the hostname', () => {
  for (const host of [
    'localhost:8080',
    '127.0.0.1:8080',
    '[2001:db8::1]:8080',
    'emulator.internal:80',
    'firestore.internal:65535',
  ]) {
    assert.equal(validateFirestoreEmulatorHost(host), host)
  }

  assert.equal(FIRESTORE_EMULATOR_HOST, 'localhost:8080')
})

test('rejects malformed, URL-like, credentialed, or portless values', () => {
  const invalidHosts = [
    undefined,
    null,
    8080,
    '',
    ' ',
    ' localhost:8080',
    'localhost:8080 ',
    'local host:8080',
    'http://localhost:8080',
    'https://localhost:8080',
    'localhost',
    'localhost:',
    ':8080',
    'localhost:0',
    'localhost:65536',
    'localhost:not-a-port',
    'user@localhost:8080',
    'localhost:8080/path',
    'localhost:8080?query=yes',
    'localhost:8080#fragment',
    '::1:8080',
    '[::1]',
  ]

  for (const host of invalidHosts) {
    assert.throws(
      () => validateFirestoreEmulatorHost(host),
      error => {
        assert.ok(error instanceof EmulatorEnvironmentError)
        assert.equal(error.code, EMULATOR_ENVIRONMENT_ERROR_CODES.INVALID)
        return true
      },
      String(host),
    )
  }
})

test('requires the real process environment and offers no override parameter', () => {
  withHost(undefined, () => {
    assert.throws(
      () => requireFirestoreEmulatorHost(),
      error => {
        assert.ok(error instanceof EmulatorEnvironmentError)
        assert.equal(error.code, EMULATOR_ENVIRONMENT_ERROR_CODES.MISSING)
        return true
      },
    )
  })

  withHost('emulator:8080', () => {
    assert.equal(requireFirestoreEmulatorHost(), 'emulator:8080')
  })

  assert.equal(requireFirestoreEmulatorHost.length, 0)
})
