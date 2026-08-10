import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

import {
  encodeCanonicalFirestoreValue,
  serializeCanonicalState,
} from '../phase2/canonicalState.js'
import { ALLOWED_EMULATOR_PROJECT_ID } from './productionEnvironment.js'

/**
 * Phase 3 Commit 3 — production preflight manifest.
 *
 * A successful preflight manifest is the durable, immutable record a later write
 * authorization depends on. It is content-addressed, strictly schema-validated,
 * atomically installed without overwriting, and never contains secret material.
 *
 * Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Section 8 as amended.
 *
 * Boundaries this module holds:
 *
 *  - The state directory is module-anchored with NO CLI or environment override,
 *    mirroring Phase 2A's `manifestSlot.js` while staying in a distinct
 *    directory so Phase 3 journals never mix with preserved Phase 2A evidence.
 *  - No cleanup, prune, or delete operation is exported. Retention is indefinite;
 *    any future pruning is a separate reviewed decision.
 *  - Manifests are discoverable by `preflightManifestId` only, never by a
 *    caller-supplied path.
 *  - Canonical encoding is imported from Phase 2A rather than vendored. A pinned
 *    fixture test guards against encoder drift invalidating retained checksums.
 */

/**
 * Schema version 2.
 *
 * Incremented because the RETAINED CONTRACT changed, not merely because code
 * changed: v2 manifests bind a sixth destination surface (the root login-code
 * index), the selected code's absence classification and digests, and an
 * explicit `writeEligible` determination. A v1 manifest cannot express any of
 * those, so it must never authorize a Commit 5 write — a writer that accepted one
 * would be proceeding on evidence that never examined the login-code index at
 * all. The version check is an equality test, so v1 files are rejected outright
 * rather than upgraded in place.
 */
export const PRODUCTION_MANIFEST_SCHEMA_VERSION = 2

/** The only production project a manifest may name. */
export const PRODUCTION_PROJECT_ID = 'morgan-bank'
export const PRODUCTION_PREFLIGHT_KIND = 'phase3-production-preflight'

/**
 * The exact project IDs a retained manifest may name — no prefix matching. The
 * emulator project is included so the rehearsal exercises the real validation and
 * install path; see `validateProductionManifest` for why that cannot authorize a
 * production write.
 */
export const ALLOWED_MANIFEST_PROJECT_IDS = Object.freeze(new Set([
  PRODUCTION_PROJECT_ID,
  ALLOWED_EMULATOR_PROJECT_ID,
]))

/**
 * Module-anchored state directory. Deliberately not configurable: a
 * `--state-dir` style override is exactly how an operator could be induced to
 * write an authorization record somewhere a later writer would not look, or to
 * read a forged one.
 */
export const PRODUCTION_STATE_DIRECTORY = fileURLToPath(
  new URL('./.state/', import.meta.url),
)

/**
 * The separate checksum domains. Keeping them distinct means a divergence can be
 * attributed to a specific area of production state instead of collapsing into
 * one opaque mismatch, and a later writer can compare domains independently.
 */
/**
 * The exact destination surfaces a v2 manifest must count.
 *
 * Declared here rather than imported from `productionPreflight.js`: that module
 * imports the Admin SDK at module scope, and the manifest reader must stay free
 * of it. A contract test pins these two lists to the same value.
 */
export const DESTINATION_COUNT_SURFACES = Object.freeze([
  'classroomStudents',
  'classroomTransactions',
  'classroomLoginHistory',
  'scopedCredentials',
  'scopedLogs',
  'loginCodeIndex',
])

export const CHECKSUM_DOMAINS = Object.freeze([
  'deploymentInventory',
  'legacySourceState',
  'foundationState',
  'destinationAbsence',
  'authCompatibility',
  'identityWatermark',
  'expectationsArtifact',
  'authorizationArtifact',
])

/** Exact top-level manifest keys. Any extra or missing key is a hard failure. */
const MANIFEST_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'preflightManifestId',
  'projectId',
  'teacherUid',
  'releaseId',
  'changeId',
  'authorizationId',
  'observedAt',
  'outcome',
  'domainChecksums',
  'preflightChecksum',
  'observations',
])

/**
 * Key names that must never appear anywhere in a manifest, at any depth. This is
 * a structural backstop, not the primary control: the observation builders emit
 * only counts, classifications, and hashes. It exists because a future
 * observation could accidentally carry a raw record through.
 */
const FORBIDDEN_KEYS = Object.freeze(new Set([
  'pin', 'pins', 'pinhash', 'pinhashes', 'password', 'passwords',
  'secret', 'secrets', 'token', 'tokens',
  'privatekey', 'private_key', 'publickey_unused',
  'email', 'emails', 'emailaddress', 'email_address',
  'authrecord', 'authrecords', 'auth_record',
  'apikey', 'api_key', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'clientsecret', 'client_secret',
  'credentialbody', 'credential_body', 'credentialbodies',
  'credentialfile', 'credential_file', 'credentialpath', 'credential_path',
  'credentialcontents', 'credential_contents',
  'rawcredential', 'raw_credential', 'rawcredentials',
]))

/**
 * Substrings that make any containing key forbidden. Deliberately narrower than
 * "contains the word credential": a `credentials` COUNT is legitimate and
 * expected in this manifest, while a path, body, or raw dump never is. Blocking
 * the bare word would have rejected `counts.credentials`, so the check targets
 * the dangerous compounds instead.
 */
const FORBIDDEN_KEY_SUBSTRINGS = Object.freeze([
  'pinhash', 'privatekey', 'private_key', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'clientsecret', 'client_secret',
  'credentialpath', 'credential_path', 'credentialfile', 'credential_file',
  'credentialbody', 'credential_body', 'credentialcontents',
  'rawcredential', 'raw_credential',
  'serviceaccount', 'service_account',
])

function isForbiddenKey(key) {
  const normalized = key.toLowerCase()
  if (FORBIDDEN_KEYS.has(normalized)) return true
  return FORBIDDEN_KEY_SUBSTRINGS.some(fragment => normalized.includes(fragment))
}

/**
 * Value shapes that indicate leaked secret material regardless of key name — a
 * PEM block, a bearer/JWT-looking string, a filesystem path to a key file, or a
 * bare four-digit PIN.
 */
const FORBIDDEN_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\bya29\.[A-Za-z0-9_-]{10,}/,
  /[^\s]*service[-_]?account[^\s]*\.json\b/i,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/i,
])

const SHA256_HEX = /^[0-9a-f]{64}$/
const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

export const PRODUCTION_MANIFEST_CATEGORIES = Object.freeze({
  ALREADY_EXISTS: 'manifest-already-exists',
  INVALID_IDENTIFIER: 'manifest-invalid-identifier',
  INVALID_SCHEMA: 'manifest-invalid-schema',
  NOT_CANONICAL: 'manifest-not-canonical',
  NOT_FOUND: 'manifest-not-found',
  SECRET_MATERIAL: 'manifest-secret-material',
  WRITE_FAILED: 'manifest-write-failed',
  JOURNAL_CORRUPT: 'journal-corrupt',
  NOT_ELIGIBLE: 'manifest-not-eligible',
})

export class ProductionManifestError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ProductionManifestError'
    this.code = 'PHASE3_PRODUCTION_MANIFEST_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new ProductionManifestError(category, message, details)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireCanonicalIdentifier(value, field) {
  if (typeof value !== 'string' || !CANONICAL_ID.test(value)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A manifest identifier is not a canonical string.',
      { field },
    )
  }
  return value
}

function requireSha256(value, field) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A manifest checksum is not a lowercase SHA-256 hex digest.',
      { field },
    )
  }
  return value
}

/**
 * Walks a candidate manifest for secret material. Runs before serialization so a
 * leak can never reach the filesystem, and is also applied on read so a manually
 * tampered file cannot reintroduce one.
 */
export function assertNoSecretMaterial(value, pathLabel = '$') {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        fail(
          PRODUCTION_MANIFEST_CATEGORIES.SECRET_MATERIAL,
          'A manifest value matches a secret-material pattern.',
          { path: pathLabel },
        )
      }
    }
    // A bare four-digit string is a student PIN shape. Checksums are 64 hex
    // characters and counts are numbers, so no legitimate manifest string is
    // exactly four digits.
    if (/^\d{4}$/.test(value)) {
      fail(
        PRODUCTION_MANIFEST_CATEGORIES.SECRET_MATERIAL,
        'A manifest value has the shape of a student PIN.',
        { path: pathLabel },
      )
    }
    return
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretMaterial(entry, `${pathLabel}[${index}]`))
    return
  }

  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (isForbiddenKey(key)) {
        fail(
          PRODUCTION_MANIFEST_CATEGORIES.SECRET_MATERIAL,
          'A manifest key is forbidden because it names secret material.',
          { path: `${pathLabel}.${key}`, key },
        )
      }
      assertNoSecretMaterial(value[key], `${pathLabel}.${key}`)
    }
  }
}

/**
 * Computes the final preflight checksum over the domain checksums.
 *
 * Deliberately derived from the domain digests rather than the whole document:
 * the final checksum then means "these exact observations of these exact
 * domains", and a later writer can verify one domain without recomputing
 * everything.
 */
export function computePreflightChecksum(domainChecksums) {
  if (!isPlainObject(domainChecksums)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'domainChecksums must be a plain object.',
    )
  }

  const keys = Object.keys(domainChecksums)
  if (keys.length !== CHECKSUM_DOMAINS.length ||
      CHECKSUM_DOMAINS.some(domain => !keys.includes(domain))) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'domainChecksums must contain exactly the defined checksum domains.',
      { expected: [...CHECKSUM_DOMAINS] },
    )
  }

  for (const domain of CHECKSUM_DOMAINS) {
    requireSha256(domainChecksums[domain], `domainChecksums.${domain}`)
  }

  // Domains are hashed in a fixed declared order, not object-key order, so the
  // final checksum cannot change because a builder emitted keys differently.
  const ordered = CHECKSUM_DOMAINS.map(
    domain => `${domain}:${domainChecksums[domain]}`,
  ).join('\n')

  return createHash('sha256').update(ordered, 'utf8').digest('hex')
}

/** Hashes an arbitrary observation payload into a domain checksum. */
export function hashDomain(value) {
  assertNoSecretMaterial(value)
  return createHash('sha256')
    .update(serializeCanonicalState(value), 'utf8')
    .digest('hex')
}

/**
 * Content-addressed identity. Derived from the canonical serialization of the
 * manifest body with the identity fields themselves excluded, so the ID is a
 * function of what was observed rather than of a caller-chosen name.
 */
export function deriveManifestId(body) {
  const addressable = {}
  for (const key of MANIFEST_KEYS) {
    if (key === 'preflightManifestId') continue
    if (Object.hasOwn(body, key)) addressable[key] = body[key]
  }
  return createHash('sha256')
    .update(serializeCanonicalState(addressable), 'utf8')
    .digest('hex')
}

/**
 * Validates a manifest against the exact schema. Applied before writing and
 * again after reading, so a hand-edited file is rejected rather than trusted.
 */
export function validateProductionManifest(manifest) {
  if (!isPlainObject(manifest)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A manifest must be a plain object.',
    )
  }

  const keys = Object.keys(manifest)
  const unexpected = keys.filter(key => !MANIFEST_KEYS.includes(key))
  if (unexpected.length > 0) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A manifest contains unsupported fields.',
      { unexpected },
    )
  }
  const missing = MANIFEST_KEYS.filter(key => !Object.hasOwn(manifest, key))
  if (missing.length > 0) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A manifest is missing required fields.',
      { missing },
    )
  }

  if (manifest.schemaVersion !== PRODUCTION_MANIFEST_SCHEMA_VERSION) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A manifest declares an unsupported schema version.',
    )
  }
  if (manifest.kind !== PRODUCTION_PREFLIGHT_KIND) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A manifest declares an unsupported kind.',
    )
  }
  // Only a successful preflight is ever persisted; a failure has no manifest.
  if (manifest.outcome !== 'succeeded') {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'Only a succeeded preflight may be persisted.',
    )
  }

  for (const field of [
    'teacherUid', 'releaseId', 'changeId', 'authorizationId',
  ]) {
    requireCanonicalIdentifier(manifest[field], field)
  }

  // The project is pinned in the manifest itself so a retained record cannot be
  // reinterpreted against a different project later.
  //
  // Exactly two values are accepted: the production project, and the single
  // permitted emulator project so the rehearsal exercises this exact validation
  // and persistence path rather than a weaker variant. A `demo-` PREFIX test was
  // rejected as too broad — it admitted an unbounded project family for no
  // rehearsal benefit, since the rehearsal only ever uses one project.
  //
  // Accepting the emulator project does not let a rehearsal manifest authorize a
  // production write: the future writer requires
  // `projectId === PRODUCTION_PROJECT_ID`, which a rehearsal manifest never has.
  if (!ALLOWED_MANIFEST_PROJECT_IDS.has(manifest.projectId)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A preflight manifest must name the production project or the permitted emulator project.',
    )
  }
  if (!CANONICAL_ID.test(manifest.projectId)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A preflight manifest project ID is not canonical.',
    )
  }

  if (typeof manifest.observedAt !== 'string' ||
      !ISO_INSTANT.test(manifest.observedAt)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'observedAt must be an ISO-8601 UTC instant.',
    )
  }

  const expectedPreflightChecksum = computePreflightChecksum(
    manifest.domainChecksums,
  )
  requireSha256(manifest.preflightChecksum, 'preflightChecksum')
  if (manifest.preflightChecksum !== expectedPreflightChecksum) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'preflightChecksum does not match the recorded domain checksums.',
    )
  }

  if (!isPlainObject(manifest.observations)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'observations must be a plain object.',
    )
  }

  // The v2 write-eligibility observations are strictly typed. Booleans are
  // required to BE booleans: a truthy string like "false" would otherwise read as
  // eligible, and this is the field a writer consults before touching production.
  for (const field of [
    'foundationPresent', 'writeEligible', 'selectedCodePresent',
  ]) {
    if (typeof manifest.observations[field] !== 'boolean') {
      fail(
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'A v2 manifest must classify write eligibility with booleans.',
        { field },
      )
    }
  }
  if (!Number.isInteger(manifest.observations.acknowledgedAnomalyCount) ||
      manifest.observations.acknowledgedAnomalyCount < 0) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'acknowledgedAnomalyCount must be a non-negative integer.',
    )
  }
  if (!isPlainObject(manifest.observations.destinationCounts)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A v2 manifest must record per-surface destination counts.',
    )
  }
  // EXACTLY the declared surfaces — no missing surface, no extra one, every
  // value a non-negative integer. A manifest that counts fewer surfaces than
  // preflight declares has not observed the destination, and the eligibility
  // conjunction below would otherwise pass it on an incomplete observation.
  {
    const counts = manifest.observations.destinationCounts
    const keys = Object.keys(counts)
    if (keys.length !== DESTINATION_COUNT_SURFACES.length ||
        DESTINATION_COUNT_SURFACES.some(surface => !Object.hasOwn(counts, surface))) {
      fail(
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'destinationCounts must contain exactly the declared destination surfaces.',
        { expected: [...DESTINATION_COUNT_SURFACES] },
      )
    }
    for (const surface of DESTINATION_COUNT_SURFACES) {
      if (!Number.isInteger(counts[surface]) || counts[surface] < 0) {
        fail(
          PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
          'Each destination count must be a non-negative integer.',
          { surface },
        )
      }
    }
  }

  // Internal consistency: a manifest cannot claim write eligibility while also
  // recording an absent foundation, a present code, an acknowledged anomaly, or a
  // nonzero destination surface. Recomputing the conjunction here means a
  // hand-edited `writeEligible: true` is caught on read, not trusted.
  if (manifest.observations.writeEligible === true) {
    const countsAllZero = Object.values(
      manifest.observations.destinationCounts,
    ).every(count => count === 0)
    if (manifest.observations.foundationPresent !== true ||
        manifest.observations.selectedCodePresent !== false ||
        manifest.observations.acknowledgedAnomalyCount !== 0 ||
        !countsAllZero) {
      fail(
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'A manifest claims write eligibility that its own observations contradict.',
      )
    }
  }

  assertNoSecretMaterial(manifest)

  requireSha256(manifest.preflightManifestId, 'preflightManifestId')
  const expectedId = deriveManifestId(manifest)
  if (manifest.preflightManifestId !== expectedId) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'preflightManifestId is not the content address of this manifest.',
    )
  }

  // Canonical round-trip: proves the document survives serialization unchanged,
  // so the stored bytes and the in-memory value cannot diverge.
  const serialized = serializeCanonicalState(manifest)
  if (serializeCanonicalState(JSON.parse(serialized)) !== serialized) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_CANONICAL,
      'A manifest is not stable under canonical serialization.',
    )
  }

  return manifest
}

/**
 * Builds a complete, validated manifest from observation domains.
 *
 * The caller supplies observations; this function owns every derived field, so a
 * caller cannot choose its own manifest ID or checksum.
 */
export function buildProductionManifest({
  projectId,
  teacherUid,
  releaseId,
  changeId,
  authorizationId,
  observedAt,
  domains,
  observations,
}) {
  if (!isPlainObject(domains)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'domains must be a plain object of observation payloads.',
    )
  }

  const domainKeys = Object.keys(domains)
  if (domainKeys.length !== CHECKSUM_DOMAINS.length ||
      CHECKSUM_DOMAINS.some(domain => !domainKeys.includes(domain))) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'domains must contain exactly the defined checksum domains.',
      { expected: [...CHECKSUM_DOMAINS] },
    )
  }

  const domainChecksums = {}
  for (const domain of CHECKSUM_DOMAINS) {
    domainChecksums[domain] = hashDomain(domains[domain])
  }

  const body = {
    schemaVersion: PRODUCTION_MANIFEST_SCHEMA_VERSION,
    kind: PRODUCTION_PREFLIGHT_KIND,
    projectId,
    teacherUid,
    releaseId,
    changeId,
    authorizationId,
    observedAt,
    outcome: 'succeeded',
    domainChecksums,
    preflightChecksum: computePreflightChecksum(domainChecksums),
    observations,
  }

  const manifest = { ...body, preflightManifestId: deriveManifestId(body) }
  return validateProductionManifest(manifest)
}

/**
 * Resolves the on-disk path for a manifest ID.
 *
 * The ID is checksum-shaped, so it cannot contain a separator or dot segment;
 * the containment assertion is a second, independent barrier against traversal
 * in case that invariant were ever relaxed.
 */
export function resolveManifestPath(preflightManifestId) {
  if (typeof preflightManifestId !== 'string' ||
      !SHA256_HEX.test(preflightManifestId)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_IDENTIFIER,
      'A preflight manifest ID must be a lowercase SHA-256 hex digest.',
    )
  }

  const filename = `preflight-${preflightManifestId}.json`
  const resolved = path.join(PRODUCTION_STATE_DIRECTORY, filename)
  const expectedPrefix = PRODUCTION_STATE_DIRECTORY.endsWith(path.sep)
    ? PRODUCTION_STATE_DIRECTORY
    : `${PRODUCTION_STATE_DIRECTORY}${path.sep}`

  if (!resolved.startsWith(expectedPrefix) ||
      path.dirname(resolved) !== path.resolve(PRODUCTION_STATE_DIRECTORY)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_IDENTIFIER,
      'A resolved manifest path escaped the Phase 3 state directory.',
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
    // Directory fsync is unsupported on some platforms/filesystems. Mirrors the
    // Phase 2A tolerance list rather than inventing a new policy.
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS']).has(error?.code)
    const unsupportedOnWindows = process.platform === 'win32' &&
      new Set(['EISDIR', 'EPERM']).has(error?.code)
    if (!unsupported && !unsupportedOnWindows) {
      throw error
    }
  } finally {
    await handle?.close()
  }
}

/**
 * Durably installs a successful preflight manifest.
 *
 * Sequence: validate, write to a same-directory temp file with `wx`, flush,
 * fsync, atomically link into place without clobbering, then fsync the
 * directory. `link`+`unlink` is used rather than `rename` because `rename`
 * silently replaces an existing file — and an immutable record must never be
 * overwritten, not even by an identical one.
 */
export async function persistProductionManifest(manifest, dependencies = {}) {
  const validated = validateProductionManifest(manifest)
  const targetPath = resolveManifestPath(validated.preflightManifestId)
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
    `preflight-${validated.preflightManifestId}.${randomUUID()}.tmp`,
  )

  let handle
  let temporaryCreated = false
  try {
    await fs.mkdir(PRODUCTION_STATE_DIRECTORY, { recursive: true, mode: 0o700 })

    // An existing manifest is never replaced. Checked before the temp write so
    // the common case fails fast, and enforced again by the exclusive create.
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
        PRODUCTION_MANIFEST_CATEGORIES.ALREADY_EXISTS,
        'A manifest with this content address already exists and is immutable.',
        { preflightManifestId: validated.preflightManifestId },
      )
    }

    // The complete bytes are written and flushed to stable storage BEFORE the
    // target name exists. This is what makes the install atomic: the target is
    // never a partially written file, because it only ever comes into existence
    // as a second name for an already-durable inode.
    handle = await fs.open(temporaryPath, 'wx', 0o400)
    temporaryCreated = true
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined

    // `link` is the install. It is atomic and it FAILS on an existing target
    // rather than replacing it, which `rename` would do silently. The target path
    // is never opened for writing anywhere in this function — a crash at any
    // point either leaves the target absent (retryable) or fully correct, never
    // truncated at an address that can never be rewritten.
    try {
      await fs.link(temporaryPath, targetPath)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        fail(
          PRODUCTION_MANIFEST_CATEGORIES.ALREADY_EXISTS,
          'A manifest with this content address already exists and is immutable.',
          { preflightManifestId: validated.preflightManifestId },
        )
      }
      throw error
    }

    // Directory fsync makes the new link itself durable, not just its contents.
    await fs.syncDirectory(PRODUCTION_STATE_DIRECTORY)
  } catch (error) {
    try {
      await handle?.close()
    } catch {
      // The original durability failure remains the blocking cause.
    }
    if (error instanceof ProductionManifestError) throw error
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.WRITE_FAILED,
      'The production preflight manifest could not be durably persisted.',
      { preflightManifestId: validated.preflightManifestId },
    )
  } finally {
    // Drop the temporary name whenever it was created. On success the inode
    // survives under the target name, so unlinking the temp name does not remove
    // the manifest. On failure the partial write is discarded. An unlink failure
    // must never mask the real result or turn a durable success into a failure.
    if (temporaryCreated) {
      try {
        await fs.unlink(temporaryPath)
      } catch {
        // A stale .tmp file is inert: it is never read, and its name embeds a
        // UUID so it can never collide with a future install.
      }
    }
  }

  return Object.freeze({
    preflightManifestId: validated.preflightManifestId,
    manifestPath: targetPath,
    preflightChecksum: validated.preflightChecksum,
  })
}

/**
 * Reads a retained manifest by ID. There is deliberately no path-based reader:
 * a later writer must locate its authorization by content address, never by a
 * path an operator or argument could redirect.
 */
export async function readProductionManifest(preflightManifestId, dependencies = {}) {
  const targetPath = resolveManifestPath(preflightManifestId)
  const read = dependencies.readFile ?? readFile

  let contents
  try {
    contents = await read(targetPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(
        PRODUCTION_MANIFEST_CATEGORIES.NOT_FOUND,
        'No retained manifest exists for this preflight manifest ID.',
        { preflightManifestId },
      )
    }
    throw error
  }

  let parsed
  try {
    parsed = JSON.parse(contents)
  } catch {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_CANONICAL,
      'A retained manifest is not parseable JSON.',
      { preflightManifestId },
    )
  }

  // The stored bytes must already be canonical. A re-serialized match proves the
  // file was not hand-edited into an equivalent-but-different form.
  if (serializeCanonicalState(parsed) !== contents) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_CANONICAL,
      'A retained manifest is not in canonical serialized form.',
      { preflightManifestId },
    )
  }

  const validated = validateProductionManifest(parsed)
  if (validated.preflightManifestId !== preflightManifestId) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A retained manifest does not match its requested content address.',
      { preflightManifestId },
    )
  }

  return validated
}

/* ------------------------------------------------------------------------- *
 * Read-only journal replay
 * ------------------------------------------------------------------------- */

/**
 * The append-only journal's event vocabulary and legal transitions.
 *
 * Declared HERE, in a module with no mutation capability, so a read-only
 * consumer can replay and validate a journal without importing
 * `productionWriter.js`. The writer imports these rather than declaring its own,
 * so there is exactly one transition table in the system: a reader and a writer
 * that disagreed about legality is precisely how an illegal event became durable
 * and then bricked every later replay.
 */
/**
 * Journal schema version 2.
 *
 * Correction B added exact retained-evidence fields to the planned header and
 * made payload validation unconditional for read-only replay. A v1 chain cannot
 * express that contract, so accepting it would turn absent evidence into an
 * implicit waiver. No production journal exists yet and the retained state
 * directory is empty; the format is therefore versioned now rather than
 * carrying an ambiguous compatibility path into the first production run.
 */
export const JOURNAL_SCHEMA_VERSION = 2
export const JOURNAL_KIND = 'phase3-production-write-journal'

export const JOURNAL_EVENTS = Object.freeze({
  PLANNED: 'planned',
  INITIALIZATION_IN_FLIGHT: 'initialization-in-flight',
  INITIALIZATION_VERIFIED: 'initialization-verified',
  AWAITING_COPY_DEPLOYMENT: 'awaiting-copy-deployment',
  BATCH_IN_FLIGHT: 'batch-in-flight',
  BATCH_COMMITTED: 'batch-committed',
  BATCH_VERIFIED: 'batch-verified',
  COPY_VERIFYING: 'copy-verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INDETERMINATE: 'indeterminate',
})

export const LEGAL_TRANSITIONS = Object.freeze({
  [JOURNAL_EVENTS.PLANNED]: Object.freeze([
    JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT]: Object.freeze([
    JOURNAL_EVENTS.INITIALIZATION_VERIFIED,
    JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.INITIALIZATION_VERIFIED]: Object.freeze([
    JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT]: Object.freeze([
    JOURNAL_EVENTS.BATCH_IN_FLIGHT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.BATCH_IN_FLIGHT]: Object.freeze([
    JOURNAL_EVENTS.BATCH_COMMITTED,
    JOURNAL_EVENTS.BATCH_IN_FLIGHT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.BATCH_COMMITTED]: Object.freeze([
    JOURNAL_EVENTS.BATCH_VERIFIED,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.BATCH_VERIFIED]: Object.freeze([
    JOURNAL_EVENTS.BATCH_IN_FLIGHT,
    JOURNAL_EVENTS.COPY_VERIFYING,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.COPY_VERIFYING]: Object.freeze([
    JOURNAL_EVENTS.COMPLETED,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.COMPLETED]: Object.freeze([]),
  [JOURNAL_EVENTS.FAILED]: Object.freeze([]),
  [JOURNAL_EVENTS.INDETERMINATE]: Object.freeze([]),
})

const MAX_JOURNAL_EVENTS = 100_000

function journalFail(message, details) {
  fail(PRODUCTION_MANIFEST_CATEGORIES.JOURNAL_CORRUPT, message, details)
}

/** The exact copy surfaces recorded in a planned journal header. */
export const JOURNAL_COPY_SURFACES = Object.freeze([
  'classroom',
  'students',
  'transactions',
  'loginHistory',
  'scopedCredentials',
  'scopedAuthLogs',
])

const JOURNAL_EVENT_BASE_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'event', 'sequence', 'previousDigest',
])

const isJournalSha256 = value =>
  typeof value === 'string' && SHA256_HEX.test(value)
const isNonEmptyJournalString = value =>
  typeof value === 'string' && value !== ''
const isJournalIndex = value => Number.isInteger(value) && value >= 0
const isPositiveJournalIndex = value =>
  Number.isInteger(value) && value > 0
const isJournalNanoseconds = value =>
  isJournalIndex(value) && value <= 999_999_999
const isBooleanTrue = value => value === true
const isJournalCounts = value => isPlainObject(value) &&
  JOURNAL_COPY_SURFACES.every(surface => isJournalIndex(value[surface])) &&
  Object.keys(value).length === JOURNAL_COPY_SURFACES.length &&
  Object.keys(value).every(key => JOURNAL_COPY_SURFACES.includes(key)) &&
  value.classroom === 1

/**
 * Exact payload schema for every durable journal event.
 *
 * This declaration lives with read-only replay, not with the writer. A journal
 * file must have one meaning whether it is opened by write.js or reverify.js;
 * making payload validation injectable allowed a read-only consumer to accept a
 * chain the writer would reject.
 */
const JOURNAL_EVENT_SCHEMAS = Object.freeze({
  [JOURNAL_EVENTS.PLANNED]: Object.freeze({
    required: Object.freeze({
      projectId: isNonEmptyJournalString,
      teacherUidSha256: isJournalSha256,
      releaseId: isNonEmptyJournalString,
      changeId: isNonEmptyJournalString,
      authorizationId: isNonEmptyJournalString,
      snapshotId: isNonEmptyJournalString,
      writeFreezeProof: isNonEmptyJournalString,
      credentialProvenance: isNonEmptyJournalString,
      preflightManifestId: isJournalSha256,
      preflightChecksum: isJournalSha256,
      writeAuthorizationSha256: isJournalSha256,
      preflightAuthorizationSha256: isJournalSha256,
      credentialSha256: isJournalSha256,
      initializationExpectationsSha256: isJournalSha256,
      copyExpectationsSha256: isJournalSha256,
      loginCodeSha256: isJournalSha256,
      loginCodePathSha256: isJournalSha256,
      classroomIdSha256: isJournalSha256,
      nextStudentNumber: isJournalIndex,
      initializedAtSeconds: Number.isSafeInteger,
      initializedAtNanoseconds: isJournalNanoseconds,
      planDigest: isJournalSha256,
      batchCount: isPositiveJournalIndex,
      countsBySurface: isJournalCounts,
      foundationStateSha256: isJournalSha256,
      foundationBodiesSha256: isJournalSha256,
      foundationStableBodiesSha256: isJournalSha256,
      teacherSourceSha256: isJournalSha256,
      classroomInitializedBodySha256: isJournalSha256,
      classroomProjectedBodySha256: isJournalSha256,
      legacySourceStateSha256: isJournalSha256,
      destinationAbsenceSha256: isJournalSha256,
      authCompatibilitySha256: isJournalSha256,
      watermarkSha256: isJournalSha256,
    }),
    optional: Object.freeze({}),
  }),
  [JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT]: Object.freeze({
    required: Object.freeze({
      initializedAtSeconds: Number.isSafeInteger,
      initializedAtNanoseconds: isJournalNanoseconds,
    }),
    optional: Object.freeze({}),
  }),
  [JOURNAL_EVENTS.INITIALIZATION_VERIFIED]: Object.freeze({
    required: Object.freeze({}),
    optional: Object.freeze({ recoveredByClassification: isBooleanTrue }),
  }),
  [JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT]: Object.freeze({
    required: Object.freeze({}), optional: Object.freeze({}),
  }),
  [JOURNAL_EVENTS.BATCH_IN_FLIGHT]: Object.freeze({
    required: Object.freeze({
      batchIndex: isJournalIndex,
      batchDigest: isJournalSha256,
      operationCount: value => isPositiveJournalIndex(value) && value <= 400,
      estimatedBytes: value =>
        isPositiveJournalIndex(value) && value <= 8 * 1024 * 1024,
    }),
    optional: Object.freeze({}),
  }),
  [JOURNAL_EVENTS.BATCH_COMMITTED]: Object.freeze({
    required: Object.freeze({
      batchIndex: isJournalIndex, batchDigest: isJournalSha256,
    }),
    optional: Object.freeze({ recoveredByClassification: isBooleanTrue }),
  }),
  [JOURNAL_EVENTS.BATCH_VERIFIED]: Object.freeze({
    required: Object.freeze({
      batchIndex: isJournalIndex, batchDigest: isJournalSha256,
    }),
    optional: Object.freeze({ recoveredByClassification: isBooleanTrue }),
  }),
  [JOURNAL_EVENTS.COPY_VERIFYING]: Object.freeze({
    required: Object.freeze({}),
    optional: Object.freeze({ reconciledAfterRestart: isBooleanTrue }),
  }),
  [JOURNAL_EVENTS.COMPLETED]: Object.freeze({
    required: Object.freeze({}), optional: Object.freeze({}),
  }),
  [JOURNAL_EVENTS.FAILED]: Object.freeze({
    required: Object.freeze({ reason: isNonEmptyJournalString }),
    optional: Object.freeze({
      phase: isNonEmptyJournalString, batchIndex: isJournalIndex,
    }),
  }),
  [JOURNAL_EVENTS.INDETERMINATE]: Object.freeze({
    required: Object.freeze({ phase: isNonEmptyJournalString }),
    optional: Object.freeze({ batchIndex: isJournalIndex }),
  }),
})

const FORBIDDEN_JOURNAL_KEYS = Object.freeze(new Set([
  'pin', 'pins', 'pinhash', 'pinhashes', 'password', 'passwords',
  'secret', 'secrets', 'token', 'tokens', 'email', 'emails',
  'emailaddress', 'email_address', 'privatekey', 'private_key',
  'apikey', 'api_key', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'clientsecret', 'client_secret',
  'logincode', 'login_code', 'studentlogincode', 'student_login_code',
  'classroomcode', 'classroom_code', 'code', 'rawcode', 'raw_code',
  'data', 'body', 'document', 'documents', 'contents',
  'path', 'paths', 'documentpath', 'document_path', 'sourcepath',
  'targetpath', 'credentialpath', 'credential_path',
  'credentialbody', 'credential_body', 'rawcredential', 'raw_credential',
  'serviceaccount', 'service_account',
]))

const FORBIDDEN_JOURNAL_SUBSTRINGS = Object.freeze([
  'pinhash', 'privatekey', 'private_key', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'clientsecret', 'client_secret',
  'credentialpath', 'credentialbody', 'rawcredential',
  'serviceaccount', 'service_account',
])

const FORBIDDEN_JOURNAL_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\bya29\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/i,
  /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\$2[aby]\$\d{2}\$/,
  /\b(?:classrooms|teachers|studentCredentials|studentAuthLogs|morganBank|classroomLoginCodes)\/[^\s"]+/,
])

/** Rejects raw identities, paths, document bodies, and credentials in a journal. */
export function assertNoJournalSecrets(value, label = '$') {
  if (typeof value === 'string') {
    if (FORBIDDEN_JOURNAL_VALUE_PATTERNS.some(pattern => pattern.test(value))) {
      journalFail('A journal event contains sensitive material.', { label })
    }
    return true
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoJournalSecrets(entry, `${label}[${index}]`))
    return true
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.toLowerCase()
      if (FORBIDDEN_JOURNAL_KEYS.has(normalized) ||
          FORBIDDEN_JOURNAL_SUBSTRINGS.some(part => normalized.includes(part))) {
        journalFail('A journal event contains a forbidden field name.', {
          label: `${label}.${key}`,
        })
      }
      assertNoJournalSecrets(entry, `${label}.${key}`)
    }
  }
  return true
}

/** Validates one event's exact base envelope, payload, and secret-free shape. */
export function validateJournalEvent(event, sequence) {
  if (!isPlainObject(event)) {
    journalFail('A journal event must be a plain object.', { sequence })
  }
  for (const key of JOURNAL_EVENT_BASE_KEYS) {
    if (!Object.hasOwn(event, key)) {
      journalFail('A journal event is missing a required field.', {
        sequence, field: key,
      })
    }
  }
  if (event.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
      event.kind !== JOURNAL_KIND) {
    journalFail('A journal event declares an unsupported schema or kind.', {
      sequence,
    })
  }
  if (!Object.values(JOURNAL_EVENTS).includes(event.event)) {
    journalFail('A journal event declares an unrecognized event kind.', { sequence })
  }
  if (event.sequence !== sequence) {
    journalFail('A journal event declares the wrong sequence.', { sequence })
  }
  if (sequence === 0) {
    if (event.previousDigest !== null) {
      journalFail('The header event must have a null predecessor digest.', {
        sequence,
      })
    }
  } else if (!isJournalSha256(event.previousDigest)) {
    journalFail('A journal event has no valid predecessor digest.', { sequence })
  }

  const schema = JOURNAL_EVENT_SCHEMAS[event.event]
  if (schema === undefined) {
    journalFail('A journal event has no declared schema.', {
      sequence, event: event.event,
    })
  }
  for (const [field, predicate] of Object.entries(schema.required)) {
    if (!Object.hasOwn(event, field) || !predicate(event[field])) {
      journalFail('A journal event is missing or misdeclares a required field.', {
        sequence, event: event.event, field,
      })
    }
  }
  for (const field of Object.keys(event)) {
    if (JOURNAL_EVENT_BASE_KEYS.includes(field) ||
        Object.hasOwn(schema.required, field)) continue
    if (Object.hasOwn(schema.optional, field)) {
      if (!schema.optional[field](event[field])) {
        journalFail('A journal event misdeclares an optional field.', {
          sequence, event: event.event, field,
        })
      }
      continue
    }
    journalFail('A journal event carries an undeclared field.', {
      sequence, event: event.event, field,
    })
  }
  assertNoJournalSecrets(event, `event[${sequence}]`)
  return true
}

/**
 * Validates the meaning shared across journal events, not just each event's
 * individual shape.
 *
 * The planned header commits to an ordered list of batch digests. A chain that
 * merely carried checksum-shaped values could otherwise claim one plan in its
 * header and execute unrelated batches while remaining transition-valid. This
 * function binds every in-flight/committed/verified record to one descriptor,
 * requires consecutive batch indices, and reconstructs the exact plan digest
 * once the complete descriptor set is present. It is intentionally owned by
 * this read-only module so `write.js` and `reverify.js` cannot disagree.
 */
export function validateJournalSemantics(events) {
  if (!Array.isArray(events) || events.length === 0) return true

  const header = events[0]
  const batches = new Map()
  let nextBatchIndex = 0

  const semanticFail = (message, details = {}) =>
    journalFail(message, details)
  const requireBatch = event => {
    const recorded = batches.get(event.batchIndex)
    if (recorded === undefined || recorded.batchDigest !== event.batchDigest) {
      semanticFail(
        'A journal batch event does not match its in-flight descriptor.',
        { sequence: event.sequence, batchIndex: event.batchIndex },
      )
    }
    return recorded
  }

  for (const event of events.slice(1)) {
    if (event.event === JOURNAL_EVENTS.BATCH_IN_FLIGHT) {
      const existing = batches.get(event.batchIndex)
      if (existing !== undefined) {
        if (existing.verified === true ||
            existing.batchDigest !== event.batchDigest ||
            existing.operationCount !== event.operationCount ||
            existing.estimatedBytes !== event.estimatedBytes) {
          semanticFail(
            'A repeated in-flight batch does not reproduce its descriptor.',
            { sequence: event.sequence, batchIndex: event.batchIndex },
          )
        }
        continue
      }
      if (event.batchIndex !== nextBatchIndex ||
          event.batchIndex >= header.batchCount) {
        semanticFail(
          'Journal batches are not consecutive within the planned bounds.',
          { sequence: event.sequence, batchIndex: event.batchIndex },
        )
      }
      batches.set(event.batchIndex, {
        batchDigest: event.batchDigest,
        operationCount: event.operationCount,
        estimatedBytes: event.estimatedBytes,
        committed: false,
        verified: false,
      })
      nextBatchIndex += 1
      continue
    }

    if (event.event === JOURNAL_EVENTS.BATCH_COMMITTED) {
      const recorded = requireBatch(event)
      if (recorded.committed === true || recorded.verified === true) {
        semanticFail('A journal batch is committed more than once.', {
          sequence: event.sequence, batchIndex: event.batchIndex,
        })
      }
      recorded.committed = true
      continue
    }

    if (event.event === JOURNAL_EVENTS.BATCH_VERIFIED) {
      const recorded = requireBatch(event)
      if (recorded.committed !== true || recorded.verified === true) {
        semanticFail('A journal batch is verified without one matching commit.', {
          sequence: event.sequence, batchIndex: event.batchIndex,
        })
      }
      recorded.verified = true
    }
  }

  const descriptorSetComplete = batches.size === header.batchCount
  if (descriptorSetComplete) {
    const ordered = Array.from({ length: header.batchCount }, (_, index) => {
      const batch = batches.get(index)
      if (batch === undefined) {
        semanticFail('The journal plan has a missing batch descriptor.', { index })
      }
      return batch
    })
    const reconstructedPlanDigest = createHash('sha256')
      .update(serializeCanonicalState(
        ordered.map(batch => batch.batchDigest),
      ), 'utf8')
      .digest('hex')
    if (reconstructedPlanDigest !== header.planDigest) {
      semanticFail(
        'The journal batches do not reconstruct the planned digest.',
      )
    }
    const plannedOperationCount = Object.values(header.countsBySurface)
      .reduce((total, count) => total + count, 0)
    const describedOperationCount = ordered
      .reduce((total, batch) => total + batch.operationCount, 0)
    if (describedOperationCount !== plannedOperationCount) {
      semanticFail(
        'The journal batch sizes do not match the planned surface counts.',
      )
    }
  }

  const head = events.at(-1)
  if (head.event === JOURNAL_EVENTS.COPY_VERIFYING ||
      head.event === JOURNAL_EVENTS.COMPLETED) {
    if (!descriptorSetComplete ||
        [...batches.values()].some(batch => batch.verified !== true)) {
      semanticFail(
        'The journal entered reconciliation before every planned batch verified.',
      )
    }
  }

  return true
}

export function journalSequenceFilename(sequence) {
  return `${String(sequence).padStart(6, '0')}.json`
}

/** Resolves a journal directory, refusing anything outside the state root. */
export function resolveJournalDirectory(preflightManifestId,
  stateRoot = PRODUCTION_STATE_DIRECTORY) {
  if (typeof preflightManifestId !== 'string' ||
      !SHA256_HEX.test(preflightManifestId)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_IDENTIFIER,
      'A journal requires a SHA-256 preflight manifest ID.',
    )
  }
  const directory = path.join(stateRoot, `write-${preflightManifestId}`)
  const expectedPrefix = stateRoot.endsWith(path.sep)
    ? stateRoot
    : `${stateRoot}${path.sep}`
  if (!directory.startsWith(expectedPrefix)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_IDENTIFIER,
      'A resolved journal directory escaped the Phase 3 state directory.',
    )
  }
  return directory
}

/**
 * Replays a journal READ-ONLY and validates the complete chain.
 *
 * Opens nothing for writing, creates no directory, and appends nothing. Both the
 * writer's journal and the read-only re-verifier call this, so the two can never
 * disagree about whether a stored chain is valid.
 *
 * Exact payload and secret validation is unconditional and owned here. A
 * read-only replay therefore accepts exactly the same bytes as the writer.
 */
export async function replayWriteJournal({
  directory,
  fs: injectedFs = {},
} = {}) {
  const readDirectory = injectedFs.readdir ?? readdir
  const readEventFile = injectedFs.readFile ?? readFile

  let names
  try {
    names = await readDirectory(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        exists: false,
        events: Object.freeze([]),
        head: undefined,
        headDigest: null,
        nextSequence: 0,
      })
    }
    throw error
  }

  const eventFiles = names.filter(name => /^\d{6}\.json$/.test(name)).sort()

  const events = []
  let previousDigest = null
  for (let sequence = 0; sequence < eventFiles.length; sequence += 1) {
    const expectedName = journalSequenceFilename(sequence)
    if (eventFiles[sequence] !== expectedName) {
      journalFail('The journal has a gap or out-of-order sequence file.',
        { sequence })
    }
    const contents = await readEventFile(
      path.join(directory, expectedName), 'utf8',
    )
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch {
      journalFail('A journal event is not parseable JSON.', { sequence })
    }
    // Canonical round-trip: proves the stored bytes were not hand-edited into
    // an equivalent-but-different form.
    if (serializeCanonicalState(parsed) !== contents) {
      journalFail('A journal event is not in canonical serialized form.',
        { sequence })
    }
    if (!isPlainObject(parsed)) {
      journalFail('A journal event must be a plain object.', { sequence })
    }
    if (parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
        parsed.kind !== JOURNAL_KIND) {
      journalFail('A journal event declares an unsupported schema or kind.',
        { sequence })
    }
    if (!Object.values(JOURNAL_EVENTS).includes(parsed.event)) {
      journalFail('A journal event declares an unrecognized event kind.',
        { sequence })
    }
    if (parsed.sequence !== sequence) {
      journalFail('A journal event declares the wrong sequence.', { sequence })
    }
    if (parsed.previousDigest !== previousDigest) {
      journalFail('A journal event does not chain to its predecessor.',
        { sequence })
    }
    if (sequence === 0) {
      if (parsed.event !== JOURNAL_EVENTS.PLANNED) {
        journalFail('A journal must begin with a planned header event.')
      }
    } else {
      const legal = LEGAL_TRANSITIONS[events[sequence - 1].event] ?? []
      if (!legal.includes(parsed.event)) {
        journalFail('A journal event is not a legal successor of its predecessor.',
          { sequence, from: events[sequence - 1].event, to: parsed.event })
      }
    }
    validateJournalEvent(parsed, sequence)

    events.push(parsed)
    previousDigest = createHash('sha256')
      .update(serializeCanonicalState(parsed), 'utf8')
      .digest('hex')
    if (sequence >= MAX_JOURNAL_EVENTS) {
      journalFail('The journal exceeded its bounded event count.')
    }
  }

  validateJournalSemantics(events)

  return Object.freeze({
    exists: true,
    events: Object.freeze(events),
    head: events.at(-1),
    headDigest: previousDigest,
    nextSequence: events.length,
  })
}

/**
 * A READ-ONLY journal view for the re-verifier.
 *
 * Exposes `replay` and nothing else. There is no `append`, so a caller holding
 * this object has no way to modify the record even by mistake.
 */
export function createReadOnlyJournalView({
  preflightManifestId,
  stateRoot = PRODUCTION_STATE_DIRECTORY,
  fs: injectedFs = {},
} = {}) {
  const directory = resolveJournalDirectory(preflightManifestId, stateRoot)
  return Object.freeze({
    directory,
    replay: () => replayWriteJournal({
      directory, fs: injectedFs,
    }),
  })
}

/**
 * The exact foundation-state digest.
 *
 * Declared in this mutation-free module so the writer (which BINDS it), the
 * initialization transaction (which REPROVES it), and the read-only re-verifier
 * (which COMPARES it) all derive it identically. Three copies of this
 * derivation would be three chances for a comparison to silently never match.
 */
export function computeFoundationStateDigest(teacherData, classroomData) {
  return createHash('sha256')
    .update(serializeCanonicalState({
      teacher: encodeCanonicalFirestoreValue(teacherData),
      classroom: encodeCanonicalFirestoreValue(classroomData),
    }), 'utf8')
    .digest('hex')
}

/**
 * Proves a retained manifest may authorize Commit 5 writes.
 *
 * A diagnostic manifest — foundation absent, an acknowledged anomaly, an
 * acknowledged destination count, or a present code — is explicitly NOT
 * write-eligible. Correction A: the existing foundation is created or repaired
 * administratively under Release Order step 8 and preflight is rerun; this
 * writer validates an existing reciprocal foundation and never invents one.
 */
export function assertManifestWriteEligible(manifest, { expectedProjectId }) {
  if (!isPlainObject(manifest)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
      'A retained manifest is required.',
    )
  }
  if (manifest.schemaVersion !== 2) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'Only a schema v2 manifest may authorize a write.',
    )
  }
  if (manifest.outcome !== 'succeeded') {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'Only a succeeded preflight may authorize a write.',
    )
  }
  if (manifest.projectId !== expectedProjectId) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'The retained manifest names a different project than this invocation.',
    )
  }
  const observations = manifest.observations
  if (!isPlainObject(observations)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'The retained manifest has no observations.',
    )
  }
  if (observations.foundationPresent !== true) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'A manifest recording an absent foundation must not authorize a write.',
    )
  }
  if (observations.selectedCodePresent !== false) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'The selected classroom login code was already present at preflight.',
    )
  }
  if (observations.acknowledgedAnomalyCount !== 0) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'An acknowledged-anomaly manifest must not authorize a write.',
    )
  }
  const counts = observations.destinationCounts
  if (!isPlainObject(counts)) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'The retained manifest records no destination counts.',
    )
  }
  // EXACTLY the six declared surfaces, each exactly zero. Iterating only the
  // keys that happen to be present let a manifest satisfy this by omission: one
  // declaring nothing but `{loginCodeIndex: 0}` proved five surfaces were empty
  // without ever having examined them.
  const countedSurfaces = Object.keys(counts)
  const missingSurfaces = DESTINATION_COUNT_SURFACES.filter(
    surface => !Object.hasOwn(counts, surface),
  )
  if (missingSurfaces.length > 0) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'The retained manifest did not count every destination surface.',
      { missing: missingSurfaces },
    )
  }
  const unknownSurfaces = countedSurfaces.filter(
    surface => !DESTINATION_COUNT_SURFACES.includes(surface),
  )
  if (unknownSurfaces.length > 0) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'The retained manifest counts an undeclared destination surface.',
      { unknown: unknownSurfaces },
    )
  }
  for (const surface of DESTINATION_COUNT_SURFACES) {
    if (counts[surface] !== 0) {
      fail(
        PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
        'A destination surface was not empty at preflight.',
        { surface },
      )
    }
  }
  if (observations.writeEligible !== true) {
    fail(
      PRODUCTION_MANIFEST_CATEGORIES.NOT_ELIGIBLE,
      'The retained manifest does not declare itself write-eligible.',
    )
  }
  return manifest
}

/**
 * Hashes a UTF-8 string. Exported so read-only consumers can derive the same
 * identifier digests the writer binds without holding a hashing idiom that a
 * blunt read-only boundary scan would have to special-case.
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
