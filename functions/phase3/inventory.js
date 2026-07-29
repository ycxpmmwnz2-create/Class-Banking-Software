import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { cert } from 'firebase-admin/app'

import {
  EXECUTION_CONTEXT,
  ProductionEnvironmentError,
  parseJsonArtifact,
  readHashedArtifact,
  redactEnvironmentError,
  validateExecutionEnvironment,
  validateExplicitCredential,
  verifyReviewedCheckout,
} from './productionEnvironment.js'
import {
  ProductionInventoryError,
  captureProductionControlPlaneInventory,
  validateInventoryAuthorization,
} from './productionInventory.js'
import {
  PREFLIGHT_ABORT_CATEGORIES,
  PRODUCTION_GOOGLE_API_ORIGINS,
  PreflightAbortError,
  createProductionControlPlaneReaders,
} from './productionPreflight.js'

export { verifyReviewedCheckout } from './productionEnvironment.js'

/**
 * Separately authorized control-plane-only inventory entrypoint.
 *
 * There is no preflight, writer, re-verifier, Firestore data reader, or Auth
 * reader import. The only remote methods exposed by the reader factory enumerate
 * Rules, Functions, Hosting, indexes, gate parameters, and active writer names.
 */

export const INVENTORY_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  ARGUMENT_REJECTED: 1,
  ENVIRONMENT_REJECTED: 2,
  CHECKOUT_REJECTED: 3,
  AUTHORIZATION_REJECTED: 4,
  INVENTORY_ABORTED: 5,
  PERSISTENCE_FAILED: 6,
})

const SAFE_PREFLIGHT_ABORT_CATEGORIES = Object.freeze(
  Object.values(PREFLIGHT_ABORT_CATEGORIES),
)
const SAFE_CONTROL_PLANE_SERVICES = Object.freeze(
  Object.keys(PRODUCTION_GOOGLE_API_ORIGINS),
)

const VALUE_FLAGS = new Map([
  ['--commit-sha', 'commitSha'],
  ['--authorization-file', 'authorizationFile'],
  ['--credential-file', 'credentialFile'],
])

const FORBIDDEN_FLAGS = Object.freeze(new Set([
  '--write',
  '--force',
  '--project',
  '--project-id',
  '--teacher-uid',
  '--expectations-file',
  '--manifest',
  '--manifest-path',
  '--manifest-file',
  '--manifest-dir',
  '--state-dir',
  '--production',
  '--production-override',
  '--allow-production',
  '--preflight',
  '--reverify',
  '--migrate',
  '--deploy',
  '--bypass',
]))

function formatPreflightAbortDiagnostic(error) {
  const category = SAFE_PREFLIGHT_ABORT_CATEGORIES.includes(error.category)
    ? error.category
    : 'unknown'
  const safeDetails = []
  const service = error.details?.service
  if (SAFE_CONTROL_PLANE_SERVICES.includes(service)) {
    safeDetails.push(`service=${service}`)
    if (Number.isInteger(error.details?.status) &&
        error.details.status >= 100 && error.details.status <= 599) {
      safeDetails.push(`status=${error.details.status}`)
    }
  }
  const suffix = safeDetails.length > 0
    ? ` (${safeDetails.join(', ')})`
    : ''
  return `Inventory aborted [${category}]${suffix}.`
}

const FORBIDDEN_SUBCOMMANDS = Object.freeze(new Set([
  'inventory', 'preflight', 'write', 'reverify', 'migrate', 'deploy',
]))

export class InventoryArgumentError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'InventoryArgumentError'
    this.code = 'PHASE3_INVENTORY_ARGUMENT_ERROR'
    this.category = category
    this.details = Object.freeze({ ...details })
  }
}

function rejectArgument(category, message, details) {
  throw new InventoryArgumentError(category, message, details)
}

export function parseInventoryArguments(argv) {
  if (!Array.isArray(argv)) {
    rejectArgument('invalid-arguments', 'Arguments must be provided as an array.')
  }
  const values = {}
  const seen = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (typeof token !== 'string') {
      rejectArgument('invalid-argument', 'Every argument must be a string.', { index })
    }
    if (token.startsWith('--') && token.includes('=')) {
      rejectArgument(
        'inline-value-rejected',
        'Inventory flags require a separate value.',
        { index },
      )
    }
    if (FORBIDDEN_FLAGS.has(token)) {
      rejectArgument(
        'forbidden-flag',
        `${token} is not accepted by the inventory entrypoint.`,
        { flag: token, index },
      )
    }
    if (FORBIDDEN_SUBCOMMANDS.has(token)) {
      rejectArgument(
        'forbidden-subcommand',
        `${token} is not a subcommand; inventory is a separate executable.`,
        { token, index },
      )
    }
    if (VALUE_FLAGS.has(token)) {
      if (seen.has(token)) {
        rejectArgument('duplicate-flag', `Duplicate flag: ${token}.`, {
          flag: token,
          index,
        })
      }
      seen.add(token)
      const value = argv[index + 1]
      if (typeof value !== 'string' || value === '' || value.trim() === '' ||
          value.startsWith('--')) {
        rejectArgument('missing-value', `${token} requires a value.`, {
          flag: token,
          index,
        })
      }
      if (value !== value.trim()) {
        rejectArgument('invalid-value', `${token} must be canonical.`, {
          flag: token,
          index,
        })
      }
      values[VALUE_FLAGS.get(token)] = value
      index += 1
      continue
    }
    if (token.startsWith('--')) {
      rejectArgument('unknown-flag', `Unknown flag: ${token}.`, {
        flag: token,
        index,
      })
    }
    rejectArgument(
      'positional-argument',
      `Positional arguments are not supported: ${token}.`,
      { index },
    )
  }

  const missing = [...VALUE_FLAGS.keys()].filter(flag => !seen.has(flag))
  if (missing.length > 0) {
    rejectArgument(
      'missing-required-flag',
      `Missing required flag${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
      { flags: missing },
    )
  }
  return Object.freeze({ ...values })
}

export async function runInventoryMain(argv = process.argv.slice(2), dependencies = {}) {
  const logger = dependencies.logger ?? globalThis.console
  const environment = dependencies.environment ?? process.env

  let parsed
  try {
    parsed = parseInventoryArguments(argv)
  } catch (error) {
    logger.error(`Inventory rejected arguments: ${error.message}`)
    return { exitCode: INVENTORY_EXIT_CODES.ARGUMENT_REJECTED, error }
  }

  let validatedEnvironment
  try {
    validatedEnvironment = validateExecutionEnvironment(environment)
    if (validatedEnvironment.context !== EXECUTION_CONTEXT.PRODUCTION) {
      throw new ProductionInventoryError(
        'inventory-not-production',
        'Control-plane inventory is permitted only for production.',
      )
    }
  } catch (error) {
    const redacted = error instanceof ProductionEnvironmentError
      ? redactEnvironmentError(error)
      : { category: error?.category ?? 'unknown' }
    logger.error(`Inventory rejected the environment [${redacted.category}].`)
    return { exitCode: INVENTORY_EXIT_CODES.ENVIRONMENT_REJECTED, error }
  }

  try {
    const checkoutVerifier = dependencies.verifyCheckout ??
      verifyReviewedCheckout
    await checkoutVerifier({
      expectedCommitSha: parsed.commitSha,
      runGit: dependencies.runGit,
    })
  } catch (error) {
    logger.error(`Inventory rejected the checkout [${
      error?.category ?? 'checkout-unverifiable'
    }].`)
    return { exitCode: INVENTORY_EXIT_CODES.CHECKOUT_REJECTED, error }
  }

  try {
    const authorizationArtifact = await readHashedArtifact(
      parsed.authorizationFile,
      dependencies,
    )
    const credentialArtifact = await readHashedArtifact(
      parsed.credentialFile,
      dependencies,
    )
    const authorization = parseJsonArtifact(
      authorizationArtifact.contents,
      'The inventory authorization file',
    )
    const nowMillis = dependencies.nowMillis ?? Date.now()

    // Bind the authorization to every local artifact before constructing even
    // the local credential wrapper, much less a remote reader.
    validateInventoryAuthorization({
      authorization,
      projectId: validatedEnvironment.projectId,
      commitSha: parsed.commitSha,
      credentialSha256: credentialArtifact.sha256,
      nowMillis,
    })
    const credential = validateExplicitCredential(
      parseJsonArtifact(credentialArtifact.contents, 'The credential file'),
      dependencies.credentialFactory ?? cert,
    )

    const readerFactory = dependencies.createReaders ??
      createProductionControlPlaneReaders
    const readers = await readerFactory({
      projectId: validatedEnvironment.projectId,
      credential,
    })
    const result = await captureProductionControlPlaneInventory({
      environment,
      readers,
      authorization,
      authorizationSha256: authorizationArtifact.sha256,
      credentialSha256: credentialArtifact.sha256,
      commitSha: parsed.commitSha,
      nowMillis,
      observedAt: dependencies.observedAt ?? new Date().toISOString(),
      completionNow: dependencies.clock ?? Date.now,
      persistInventory: dependencies.persistInventory,
    })
    logger.log(`Control-plane inventory ${result.artifact.inventoryId} retained.`)
    return { exitCode: INVENTORY_EXIT_CODES.SUCCESS, result }
  } catch (error) {
    if (error instanceof ProductionEnvironmentError) {
      const redacted = redactEnvironmentError(error)
      logger.error(`Inventory rejected an artifact [${redacted.category}].`)
      return { exitCode: INVENTORY_EXIT_CODES.AUTHORIZATION_REJECTED, error }
    }
    if (error instanceof ProductionInventoryError) {
      logger.error(`Inventory aborted [${error.category}]: ${error.message}`)
      const persistence = error.category === 'inventory-persistence-failed' ||
        error.category === 'inventory-already-exists'
      return {
        exitCode: persistence
          ? INVENTORY_EXIT_CODES.PERSISTENCE_FAILED
          : INVENTORY_EXIT_CODES.INVENTORY_ABORTED,
        error,
      }
    }
    if (error instanceof PreflightAbortError) {
      // The control-plane readers deliberately use the shared fail-closed
      // preflight error type. Its provider-facing message and arbitrary details
      // remain hidden; only fixed categories, fixed service keys, and an HTTP
      // status in the valid wire range are safe for operator diagnosis.
      logger.error(formatPreflightAbortDiagnostic(error))
      return { exitCode: INVENTORY_EXIT_CODES.INVENTORY_ABORTED, error }
    }
    // Unknown dependency errors can originate in credential or HTTP libraries.
    // Their messages are not part of this contract and may contain provider
    // diagnostics, so never copy them into operator-visible output.
    logger.error('Inventory failed [unexpected].')
    return { exitCode: INVENTORY_EXIT_CODES.INVENTORY_ABORTED, error }
  }
}

const isDirectExecution = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectExecution) {
  runInventoryMain().then(({ exitCode }) => {
    process.exitCode = exitCode
  }).catch(() => {
    process.exitCode = INVENTORY_EXIT_CODES.INVENTORY_ABORTED
  })
}
