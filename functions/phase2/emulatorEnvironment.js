import process from 'node:process'
import { URL } from 'node:url'

const ENVIRONMENT_VARIABLE = 'FIRESTORE_EMULATOR_HOST'

export const EMULATOR_ENVIRONMENT_ERROR_CODES = Object.freeze({
  MISSING: 'FIRESTORE_EMULATOR_HOST_MISSING',
  INVALID: 'FIRESTORE_EMULATOR_HOST_INVALID',
})

export class EmulatorEnvironmentError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EmulatorEnvironmentError'
    this.code = code
  }
}

function invalidHost(message) {
  throw new EmulatorEnvironmentError(
    EMULATOR_ENVIRONMENT_ERROR_CODES.INVALID,
    `${ENVIRONMENT_VARIABLE} ${message}`,
  )
}

export function validateFirestoreEmulatorHost(value) {
  if (typeof value !== 'string' || value.length === 0) {
    invalidHost('must be a nonempty host:port value.')
  }

  if (value.trim() !== value || /\s/u.test(value)) {
    invalidHost('must not contain whitespace.')
  }

  if (/[\\/?#@]/u.test(value) || value.includes('://')) {
    invalidHost('must be a host:port value, not a URL, path, or credential.')
  }

  const portSeparatorIndex = value.lastIndexOf(':')
  const rawPort = value.slice(portSeparatorIndex + 1)

  if (portSeparatorIndex === -1 || !/^\d+$/u.test(rawPort)) {
    invalidHost('must include a numeric port.')
  }

  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    invalidHost('must use a port from 1 through 65535.')
  }

  let parsed
  try {
    parsed = new URL(`http://${value}`)
  } catch {
    invalidHost('must contain a valid hostname or bracketed IPv6 address and port.')
  }

  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    invalidHost('must contain only a hostname or bracketed IPv6 address and port.')
  }

  return value
}

export function requireFirestoreEmulatorHost() {
  const value = process.env[ENVIRONMENT_VARIABLE]

  if (value === undefined) {
    throw new EmulatorEnvironmentError(
      EMULATOR_ENVIRONMENT_ERROR_CODES.MISSING,
      `${ENVIRONMENT_VARIABLE} is required; Phase 2A is emulator-only.`,
    )
  }

  return validateFirestoreEmulatorHost(value)
}

export const FIRESTORE_EMULATOR_HOST = requireFirestoreEmulatorHost()
