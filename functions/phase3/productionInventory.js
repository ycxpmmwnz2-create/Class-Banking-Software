import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  EXECUTION_CONTEXT,
  validateExecutionEnvironment,
} from './productionEnvironment.js'
import {
  PRODUCTION_STATE_DIRECTORY,
  assertNoSecretMaterial,
} from './productionManifest.js'
import { serializeCanonicalState } from '../phase2/canonicalState.js'

/**
 * Separately authorized Phase 3 control-plane inventory.
 *
 * This boundary exists only to observe the opaque, server-assigned values needed
 * to prepare a reviewed preflight expectations artifact. It cannot read
 * Firestore application data or Firebase Auth, cannot create an expectations or
 * preflight artifact, and carries no write-eligibility field.
 */

export const PRODUCTION_INVENTORY_SCHEMA_VERSION = 1
export const PRODUCTION_INVENTORY_KIND =
  'phase3-production-control-plane-inventory'
export const PRODUCTION_INVENTORY_MAX_AUTHORIZATION_MS = 2 * 60 * 60 * 1000

export const PRODUCTION_INVENTORY_CATEGORIES = Object.freeze({
  ALREADY_EXISTS: 'inventory-already-exists',
  AUTHORIZATION_EXPIRED: 'inventory-authorization-expired',
  AUTHORIZATION_MISMATCH: 'inventory-authorization-mismatch',
  AUTHORIZATION_UNBOUND: 'inventory-authorization-unbound',
  INCOMPLETE: 'inventory-incomplete',
  INVALID_AUTHORIZATION: 'inventory-invalid-authorization',
  INVALID_IDENTIFIER: 'inventory-invalid-identifier',
  INVALID_SCHEMA: 'inventory-invalid-schema',
  NOT_PRODUCTION: 'inventory-not-production',
  PERSISTENCE_FAILED: 'inventory-persistence-failed',
})

const SHA256_HEX = /^[0-9a-f]{64}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const AUTHORIZATION_FIELDS = Object.freeze([
  'kind',
  'projectId',
  'commitSha',
  'changeId',
  'authorizationId',
  'credentialProvenance',
  'credentialSha256',
  'notBefore',
  'notAfter',
])

const ARTIFACT_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'inventoryId',
  'projectId',
  'commitSha',
  'changeId',
  'authorizationId',
  'credentialProvenance',
  'credentialSha256',
  'authorizationSha256',
  'observedAt',
  'outcome',
  'deployment',
  'activeWriters',
  'inventoryChecksum',
])

const DEPLOYMENT_SURFACES = Object.freeze([
  'rules',
  'functions',
  'hosting',
  'indexes',
  'gateParameters',
])

export class ProductionInventoryError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ProductionInventoryError'
    this.code = 'PHASE3_PRODUCTION_INVENTORY_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new ProductionInventoryError(category, message, details)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireExactKeys(value, expected, label) {
  if (!isPlainObject(value)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_SCHEMA,
      `${label} must be a plain object.`,
    )
  }
  const keys = Object.keys(value)
  const missing = expected.filter(key => !Object.hasOwn(value, key))
  const unexpected = keys.filter(key => !expected.includes(key))
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_SCHEMA,
      `${label} does not have its exact required fields.`,
      { missing, unexpected },
    )
  }
}

function requireCanonicalId(value, field) {
  if (typeof value !== 'string' || !CANONICAL_ID.test(value)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_IDENTIFIER,
      'An inventory identifier is not canonical.',
      { field },
    )
  }
  return value
}

function parseInstant(value, field) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_AUTHORIZATION,
      'An inventory authorization bound must be an ISO-8601 UTC instant.',
      { field },
    )
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) ||
      new Date(milliseconds).toISOString() !== value) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_AUTHORIZATION,
      'An inventory authorization bound is not parseable.',
      { field },
    )
  }
  return milliseconds
}

export function validateInventoryAuthorization({
  authorization,
  projectId,
  commitSha,
  credentialSha256,
  nowMillis,
}) {
  requireExactKeys(authorization, AUTHORIZATION_FIELDS, 'authorization')

  if (authorization.kind !== PRODUCTION_INVENTORY_KIND) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_AUTHORIZATION,
      'The authorization is not for a control-plane inventory.',
    )
  }
  for (const field of [
    'projectId',
    'changeId',
    'authorizationId',
    'credentialProvenance',
  ]) {
    requireCanonicalId(authorization[field], field)
  }
  if (!COMMIT_SHA.test(authorization.commitSha)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_IDENTIFIER,
      'The authorized commit is not a full lowercase Git SHA.',
      { field: 'commitSha' },
    )
  }
  if (!SHA256_HEX.test(authorization.credentialSha256)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_AUTHORIZATION,
      'The authorized credential checksum is malformed.',
      { field: 'credentialSha256' },
    )
  }

  if (authorization.projectId !== projectId ||
      authorization.commitSha !== commitSha) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.AUTHORIZATION_MISMATCH,
      'The inventory authorization names a different project or commit.',
    )
  }
  if (authorization.credentialSha256 !== credentialSha256) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.AUTHORIZATION_UNBOUND,
      'The presented credential is not the authorized credential.',
    )
  }

  const notBefore = parseInstant(authorization.notBefore, 'notBefore')
  const notAfter = parseInstant(authorization.notAfter, 'notAfter')
  if (!(notBefore < notAfter) ||
      notAfter - notBefore > PRODUCTION_INVENTORY_MAX_AUTHORIZATION_MS ||
      !Number.isSafeInteger(nowMillis)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_AUTHORIZATION,
      'The inventory authorization validity interval is invalid.',
    )
  }
  if (nowMillis < notBefore || nowMillis > notAfter) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.AUTHORIZATION_EXPIRED,
      'The inventory authorization is outside its validity interval.',
    )
  }

  return Object.freeze({ ...authorization })
}

function validateDeployment(deployment) {
  requireExactKeys(deployment, DEPLOYMENT_SURFACES, 'deployment')
  for (const surface of DEPLOYMENT_SURFACES) {
    if (!isPlainObject(deployment[surface])) {
      fail(
        PRODUCTION_INVENTORY_CATEGORIES.INCOMPLETE,
        'A control-plane inventory surface is missing or malformed.',
        { surface },
      )
    }
  }
  return deployment
}

function normalizeWriters(writers) {
  if (!Array.isArray(writers) ||
      writers.some(writer => typeof writer !== 'string' || writer === '' ||
        writer !== writer.trim())) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INCOMPLETE,
      'The active-writer inventory is malformed.',
    )
  }
  const normalized = [...writers].sort()
  if (new Set(normalized).size !== normalized.length) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INCOMPLETE,
      'The active-writer inventory contains a duplicate.',
    )
  }
  return Object.freeze(normalized)
}

function inventoryChecksum(deployment, activeWriters) {
  return createHash('sha256')
    .update(serializeCanonicalState({ deployment, activeWriters }), 'utf8')
    .digest('hex')
}

function deriveInventoryId(body) {
  return createHash('sha256')
    .update(serializeCanonicalState(body), 'utf8')
    .digest('hex')
}

export function validateProductionInventoryArtifact(artifact) {
  requireExactKeys(artifact, ARTIFACT_FIELDS, 'inventory artifact')
  if (artifact.schemaVersion !== PRODUCTION_INVENTORY_SCHEMA_VERSION ||
      artifact.kind !== PRODUCTION_INVENTORY_KIND ||
      artifact.outcome !== 'observed') {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_SCHEMA,
      'The control-plane inventory declares an unsupported schema, kind, or outcome.',
    )
  }
  if (artifact.projectId !== 'morgan-bank') {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_SCHEMA,
      'A production inventory must name the exact production project.',
    )
  }
  requireCanonicalId(artifact.projectId, 'projectId')
  requireCanonicalId(artifact.changeId, 'changeId')
  requireCanonicalId(artifact.authorizationId, 'authorizationId')
  requireCanonicalId(artifact.credentialProvenance, 'credentialProvenance')
  if (!COMMIT_SHA.test(artifact.commitSha) ||
      !SHA256_HEX.test(artifact.credentialSha256) ||
      !SHA256_HEX.test(artifact.authorizationSha256) ||
      !SHA256_HEX.test(artifact.inventoryChecksum) ||
      !SHA256_HEX.test(artifact.inventoryId) ||
      typeof artifact.observedAt !== 'string' ||
      !ISO_INSTANT.test(artifact.observedAt)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_SCHEMA,
      'The control-plane inventory has a malformed identity, checksum, or timestamp.',
    )
  }

  const deployment = validateDeployment(artifact.deployment)
  const writers = normalizeWriters(artifact.activeWriters)
  if (artifact.inventoryChecksum !== inventoryChecksum(deployment, writers)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_SCHEMA,
      'The inventory checksum does not match the observed control-plane state.',
    )
  }

  assertNoSecretMaterial(artifact)

  const body = { ...artifact }
  delete body.inventoryId
  if (artifact.inventoryId !== deriveInventoryId(body)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_SCHEMA,
      'The inventory ID is not the content address of this artifact.',
    )
  }

  if (Object.hasOwn(artifact, 'writeEligible') ||
      Object.hasOwn(artifact, 'preflightManifestId') ||
      Object.hasOwn(artifact, 'expectations')) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_SCHEMA,
      'A control-plane inventory cannot carry preflight or write authorization.',
    )
  }
  return artifact
}

export function buildProductionInventoryArtifact({
  authorization,
  authorizationSha256,
  observedAt,
  deployment,
  activeWriters,
}) {
  const normalizedDeployment = validateDeployment(deployment)
  const normalizedWriters = normalizeWriters(activeWriters)
  const body = {
    schemaVersion: PRODUCTION_INVENTORY_SCHEMA_VERSION,
    kind: PRODUCTION_INVENTORY_KIND,
    projectId: authorization.projectId,
    commitSha: authorization.commitSha,
    changeId: authorization.changeId,
    authorizationId: authorization.authorizationId,
    credentialProvenance: authorization.credentialProvenance,
    credentialSha256: authorization.credentialSha256,
    authorizationSha256,
    observedAt,
    outcome: 'observed',
    deployment: normalizedDeployment,
    activeWriters: normalizedWriters,
    inventoryChecksum: inventoryChecksum(normalizedDeployment, normalizedWriters),
  }
  const artifact = { ...body, inventoryId: deriveInventoryId(body) }
  return validateProductionInventoryArtifact(artifact)
}

export function resolveInventoryPath(inventoryId) {
  if (typeof inventoryId !== 'string' || !SHA256_HEX.test(inventoryId)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_IDENTIFIER,
      'An inventory ID must be a lowercase SHA-256 digest.',
    )
  }
  const resolved = path.join(
    PRODUCTION_STATE_DIRECTORY,
    `inventory-${inventoryId}.json`,
  )
  if (path.dirname(resolved) !== path.resolve(PRODUCTION_STATE_DIRECTORY)) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_IDENTIFIER,
      'The inventory path escaped the Phase 3 state directory.',
    )
  }
  return resolved
}

async function syncDirectory(directory) {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS']).has(error?.code)
    const unsupportedOnWindows = process.platform === 'win32' &&
      new Set(['EISDIR', 'EPERM']).has(error?.code)
    if (!unsupported && !unsupportedOnWindows) throw error
  } finally {
    await handle?.close()
  }
}

export async function persistProductionInventory(artifact, dependencies = {}) {
  const validated = validateProductionInventoryArtifact(artifact)
  const targetPath = resolveInventoryPath(validated.inventoryId)
  const serialized = serializeCanonicalState(validated)
  const fs = {
    mkdir: dependencies.mkdir ?? mkdir,
    open: dependencies.open ?? open,
    link: dependencies.link ?? link,
    unlink: dependencies.unlink ?? unlink,
    syncDirectory: dependencies.syncDirectory ?? syncDirectory,
  }
  const temporaryPath = path.join(
    PRODUCTION_STATE_DIRECTORY,
    `inventory-${validated.inventoryId}.${randomUUID()}.tmp`,
  )

  let handle
  let temporaryCreated = false
  try {
    await fs.mkdir(PRODUCTION_STATE_DIRECTORY, { recursive: true, mode: 0o700 })
    let existing
    try {
      existing = await fs.open(targetPath, 'r')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    } finally {
      await existing?.close()
    }
    if (existing !== undefined) {
      fail(
        PRODUCTION_INVENTORY_CATEGORIES.ALREADY_EXISTS,
        'This immutable control-plane inventory already exists.',
      )
    }

    handle = await fs.open(temporaryPath, 'wx', 0o400)
    temporaryCreated = true
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await fs.link(temporaryPath, targetPath)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        fail(
          PRODUCTION_INVENTORY_CATEGORIES.ALREADY_EXISTS,
          'This immutable control-plane inventory already exists.',
        )
      }
      throw error
    }
    await fs.syncDirectory(PRODUCTION_STATE_DIRECTORY)
  } catch (error) {
    try {
      await handle?.close()
    } catch {
      // The original persistence failure remains authoritative.
    }
    if (error instanceof ProductionInventoryError) throw error
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.PERSISTENCE_FAILED,
      'The control-plane inventory could not be durably persisted.',
    )
  } finally {
    if (temporaryCreated) {
      try {
        await fs.unlink(temporaryPath)
      } catch {
        // Temporary files are never read and cannot authorize another action.
      }
    }
  }

  return Object.freeze({
    inventoryId: validated.inventoryId,
    inventoryPath: targetPath,
    inventoryChecksum: validated.inventoryChecksum,
  })
}

export async function captureProductionControlPlaneInventory({
  environment,
  readers,
  authorization,
  authorizationSha256,
  credentialSha256,
  commitSha,
  nowMillis,
  observedAt,
  completionNow = Date.now,
  persistInventory = persistProductionInventory,
}) {
  const validatedEnvironment = validateExecutionEnvironment(environment)
  if (validatedEnvironment.context !== EXECUTION_CONTEXT.PRODUCTION) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.NOT_PRODUCTION,
      'Control-plane inventory is permitted only for the exact production project.',
    )
  }
  if (!SHA256_HEX.test(String(authorizationSha256))) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_AUTHORIZATION,
      'The authorization artifact checksum is required.',
    )
  }
  if (!readers || typeof readers.readDeploymentInventory !== 'function' ||
      typeof readers.readActiveWriters !== 'function') {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INCOMPLETE,
      'The control-plane-only reader set is unavailable.',
    )
  }
  if (typeof persistInventory !== 'function') {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.PERSISTENCE_FAILED,
      'An immutable inventory persister is required.',
    )
  }
  if (typeof completionNow !== 'function') {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INVALID_AUTHORIZATION,
      'A completion-time authorization check is required.',
    )
  }

  const validatedAuthorization = validateInventoryAuthorization({
    authorization,
    projectId: validatedEnvironment.projectId,
    commitSha,
    credentialSha256,
    nowMillis,
  })

  const [deploymentResult, writerResult] = await Promise.all([
    readers.readDeploymentInventory(),
    readers.readActiveWriters(),
  ])
  // A large, completely paginated project may take long enough for its grant to
  // expire. Revalidate after the final remote read; an observation completed
  // outside the authorized interval is never retained.
  validateInventoryAuthorization({
    authorization: validatedAuthorization,
    projectId: validatedEnvironment.projectId,
    commitSha,
    credentialSha256,
    nowMillis: completionNow(),
  })
  if (!isPlainObject(deploymentResult) || deploymentResult.complete !== true ||
      deploymentResult.truncated === true || deploymentResult.nextPageToken ||
      !isPlainObject(writerResult) || writerResult.complete !== true ||
      writerResult.truncated === true || writerResult.nextPageToken) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.INCOMPLETE,
      'A control-plane reader did not complete every page.',
    )
  }
  const deployment = Object.fromEntries(
    DEPLOYMENT_SURFACES.map(surface => [surface, deploymentResult[surface]]),
  )
  const artifact = buildProductionInventoryArtifact({
    authorization: validatedAuthorization,
    authorizationSha256,
    observedAt,
    deployment,
    activeWriters: writerResult.writers,
  })
  const persisted = await persistInventory(artifact)
  if (!isPlainObject(persisted) ||
      persisted.inventoryId !== artifact.inventoryId ||
      persisted.inventoryChecksum !== artifact.inventoryChecksum) {
    fail(
      PRODUCTION_INVENTORY_CATEGORIES.PERSISTENCE_FAILED,
      'The retained inventory does not match the observed inventory.',
    )
  }
  return Object.freeze({ artifact, persisted })
}
