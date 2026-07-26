import { createHash } from 'node:crypto'

import { deleteApp, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

import {
  EXECUTION_CONTEXT,
  validateExecutionEnvironment,
} from './productionEnvironment.js'
import {
  CHECKSUM_DOMAINS,
  buildProductionManifest,
  hashDomain,
} from './productionManifest.js'

/**
 * Phase 3 Commit 3 — strictly read-only production preflight.
 *
 * "Read-only" scopes to Firebase and Google services: this module issues only
 * read operations through injected readers and never constructs a transaction,
 * batch, or mutating call. Persisting the local manifest is required and does not
 * weaken that boundary.
 *
 * Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 6, 8, 9 as
 * amended.
 *
 * Every reader is injected. That is not merely for testability: it means this
 * module has no ambient credential discovery path at all, so it cannot
 * accidentally authenticate via ADC, a cached Firebase CLI login, or the
 * metadata server. The entrypoint owns credential construction.
 */

export const PREFLIGHT_ABORT_CATEGORIES = Object.freeze({
  AMBIGUOUS_ENVIRONMENT: 'ambiguous-environment',
  AUTH_INCOMPATIBLE: 'auth-incompatible',
  AUTHORIZATION_EXPIRED: 'authorization-expired',
  AUTHORIZATION_MISMATCH: 'authorization-mismatch',
  AUTHORIZATION_UNBOUND: 'authorization-unbound',
  DESTINATION_DATA_PRESENT: 'destination-data-present',
  EXPECTATIONS_MISMATCH: 'expectations-mismatch',
  FOUNDATION_PARTIAL: 'foundation-partial',
  IDENTITY_COLLISION: 'identity-collision',
  INCOMPLETE_PAGINATION: 'incomplete-pagination',
  INSPECTION_UNAVAILABLE: 'inspection-unavailable',
  MALFORMED_AUTHORIZATION: 'malformed-authorization',
  MALFORMED_ID: 'malformed-id',
  NONCANONICAL_VALUE: 'noncanonical-value',
  UNKNOWN_DEPLOYED_ARTIFACT: 'unknown-deployed-artifact',
  UNREVIEWED_ANOMALY: 'unreviewed-anomaly',
  WATERMARK_UNRESOLVED: 'watermark-unresolved',
})

/**
 * Enumeration guidance for whoever implements the production readers.
 *
 * A Firestore document that holds only subcollections is a "phantom parent": it
 * does not exist as a document, so `collection(...).get()` returns zero rows
 * while its subcollections remain fully readable. Enumerating destination paths
 * with `get()` would therefore make scoped credentials orphaned under such a
 * parent INVISIBLE to preflight — exactly the pre-existing V2 data the
 * destination-absence check exists to catch.
 *
 * Verified against the Firestore emulator: after writing
 * `classrooms/x/studentCredentials/ada` with no `classrooms/x` document,
 * `.get()` saw 0 documents and `.listDocuments()` saw 1.
 *
 * Any reader that enumerates a collection whose children matter MUST use
 * `listDocuments()`.
 */
export const COLLECTION_ENUMERATION_REQUIREMENT = Object.freeze({
  method: 'listDocuments',
  rejected: 'get',
  reason: 'phantom-parent documents are invisible to get()',
})

/** The observation domains a complete preflight must produce. */
const REQUIRED_READER_NAMES = Object.freeze([
  'readDeploymentInventory',
  'readLegacyClassroomAggregate',
  'readFlatCredentials',
  'readFlatAuthLogs',
  'readFoundation',
  'readDestinationPaths',
  'readAuthCompatibility',
  'readActiveWriters',
])

export class PreflightAbortError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'PreflightAbortError'
    this.code = 'PHASE3_PREFLIGHT_ABORT'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function abort(category, message, details) {
  throw new PreflightAbortError(category, message, details)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Hashes an artifact's raw bytes for authorization binding. */
export function hashArtifactBytes(contents) {
  if (typeof contents !== 'string' && !(contents instanceof Uint8Array)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'An artifact must be a string or byte array to be hashed.',
    )
  }
  return createHash('sha256').update(contents).digest('hex')
}

/**
 * Fields the read-authorization artifact must bind.
 *
 * This validates that supplied identifiers agree with each other and with the
 * artifacts actually presented. It is a consistency and provenance check, NOT a
 * cryptographic approval: nothing here proves a human authorized the change, only
 * that the operator supplied a self-consistent, unexpired, checksum-bound record.
 */
const AUTHORIZATION_FIELDS = Object.freeze([
  'projectId',
  'teacherUid',
  'releaseId',
  'changeId',
  'authorizationId',
  'credentialProvenance',
  'credentialSha256',
  'expectationsSha256',
  'notBefore',
  'notAfter',
])

function parseInstant(value, field) {
  if (typeof value !== 'string') {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'An authorization validity bound must be an ISO-8601 string.',
      { field },
    )
  }
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'An authorization validity bound is not a parseable instant.',
      { field },
    )
  }
  return millis
}

/**
 * Validates the read authorization and binds it to the exact credential and
 * expectations artifacts presented.
 */
export function validateReadAuthorization({
  authorization,
  credentialSha256,
  expectationsSha256,
  teacherUid,
  projectId,
  nowMillis,
}) {
  if (!isPlainObject(authorization)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'The read authorization must be a JSON object.',
    )
  }

  const keys = Object.keys(authorization)
  const unexpected = keys.filter(key => !AUTHORIZATION_FIELDS.includes(key))
  if (unexpected.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'The read authorization contains unsupported fields.',
      { unexpected },
    )
  }
  const missing = AUTHORIZATION_FIELDS.filter(
    field => typeof authorization[field] !== 'string' ||
      authorization[field].trim() === '',
  )
  if (missing.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'The read authorization is incomplete.',
      { missing },
    )
  }

  for (const field of [
    'teacherUid', 'releaseId', 'changeId', 'authorizationId',
    'credentialProvenance',
  ]) {
    if (!CANONICAL_ID.test(authorization[field])) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
        'A read-authorization identifier is not canonical.',
        { field },
      )
    }
  }
  for (const field of ['credentialSha256', 'expectationsSha256']) {
    if (!SHA256_HEX.test(authorization[field])) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
        'A read-authorization checksum is not a SHA-256 hex digest.',
        { field },
      )
    }
  }

  // The authorization must name the same project and teacher the run resolved,
  // so a record issued for one target cannot authorize reading another.
  if (authorization.projectId !== projectId) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_MISMATCH,
      'The read authorization names a different project than the environment.',
    )
  }
  if (authorization.teacherUid !== teacherUid) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_MISMATCH,
      'The read authorization names a different teacher than the invocation.',
    )
  }

  // Binding: the artifacts actually read must be the ones the authorization
  // covers. Without this the authorization would approve a credential and
  // expectations set nobody reviewed.
  if (authorization.credentialSha256 !== credentialSha256) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_UNBOUND,
      'The presented credential does not match the authorized credential checksum.',
    )
  }
  if (authorization.expectationsSha256 !== expectationsSha256) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_UNBOUND,
      'The presented expectations do not match the authorized expectations checksum.',
    )
  }

  const notBefore = parseInstant(authorization.notBefore, 'notBefore')
  const notAfter = parseInstant(authorization.notAfter, 'notAfter')
  if (!(notBefore < notAfter)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'The read-authorization validity interval is empty or inverted.',
    )
  }
  if (!Number.isFinite(nowMillis)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'A finite current time is required to validate the authorization window.',
    )
  }
  if (nowMillis < notBefore || nowMillis > notAfter) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_EXPIRED,
      'The read authorization is outside its validity interval.',
    )
  }

  return Object.freeze({ ...authorization })
}

/**
 * The per-document evidence entry every hashed source must supply.
 *
 * This is the shape that makes a domain checksum meaningful. A count-only domain
 * cannot detect a changed balance, PIN hash, transaction body, or update time, so
 * a later writer could not prove it is operating on the state that passed
 * preflight. Each entry instead carries:
 *
 *  - `pathHash`  — SHA-256 of the document's full canonical path. The raw path is
 *                  NEVER retained: a path like
 *                  `classrooms/x/studentCredentials/ada.smith` embeds student
 *                  identity, and the manifest must not carry it.
 *  - `updateTime`— the exact Firestore update time as {seconds, nanoseconds}, so
 *                  a same-shape rewrite inside one millisecond is still detected.
 *                  An ISO-8601 millisecond string would discard nanoseconds.
 *  - `documentHash` — SHA-256 over the document's canonically encoded body,
 *                  computed IN MEMORY by the reader. Secret-bearing values may
 *                  enter that hash preimage; none of them are retained.
 *
 * A later writer recomputes these same three values under the freeze and compares
 * digests, with no raw credential material ever present in the manifest.
 */
const SOURCE_ENTRY_FIELDS = Object.freeze(['pathHash', 'updateTime', 'documentHash'])

/** Nanoseconds are sub-second by definition. */
const NANOSECONDS_PER_SECOND = 1_000_000_000

/**
 * Validates a Firestore update time at full precision.
 *
 * Firestore timestamps carry nanosecond resolution. Representing one as an
 * ISO-8601 millisecond string discards up to six digits, so two distinct writes
 * inside the same millisecond become indistinguishable — and a body restored to a
 * previous value would then produce byte-identical evidence.
 */
function requireExactUpdateTime(value, surface) {
  if (!isPlainObject(value)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A source entry updateTime must be an exact {seconds, nanoseconds} value.',
      { surface },
    )
  }
  const extra = Object.keys(value).filter(
    key => key !== 'seconds' && key !== 'nanoseconds',
  )
  if (extra.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A source entry updateTime carries unsupported fields.',
      { surface, extra },
    )
  }
  const { seconds, nanoseconds } = value
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A source entry updateTime has non-integer or negative seconds.',
      { surface },
    )
  }
  if (!Number.isSafeInteger(nanoseconds) ||
      nanoseconds < 0 || nanoseconds >= NANOSECONDS_PER_SECOND) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A source entry updateTime has out-of-range nanoseconds.',
      { surface },
    )
  }
  return Object.freeze({ seconds, nanoseconds })
}

/**
 * Validates and canonically orders one hashed source's entries.
 *
 * Sorting is by `pathHash` — a stable, identity-free key. Reader iteration order
 * must not change the domain checksum, or two runs over identical state would
 * disagree.
 */
export function normalizeSourceEntries(entries, surface) {
  if (!Array.isArray(entries)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A hashed source must supply an array of per-document entries.',
      { surface },
    )
  }

  const normalized = entries.map(entry => {
    if (!isPlainObject(entry)) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'A source entry is not an object.',
        { surface },
      )
    }
    const unexpected = Object.keys(entry).filter(
      key => !SOURCE_ENTRY_FIELDS.includes(key),
    )
    if (unexpected.length > 0) {
      // An extra field is refused rather than dropped: it is the route by which a
      // raw path, login ID, or credential body would reach the manifest.
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'A source entry carries fields beyond the hashed evidence schema.',
        { surface, unexpected },
      )
    }
    for (const field of ['pathHash', 'documentHash']) {
      if (typeof entry[field] !== 'string' || !SHA256_HEX.test(entry[field])) {
        abort(
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          'A source entry hash is not a SHA-256 hex digest.',
          { surface, field },
        )
      }
    }
    // EXACT Firestore precision. An ISO-8601 string built via
    // `toDate().toISOString()` truncates to milliseconds, so two writes within one
    // millisecond that restore the same body would produce identical evidence and
    // a rewrite would go undetected.
    const updateTime = requireExactUpdateTime(entry.updateTime, surface)
    return Object.freeze({
      pathHash: entry.pathHash,
      updateTime,
      documentHash: entry.documentHash,
    })
  })

  // Two entries for one path means the reader double-counted or paged
  // incorrectly; the resulting checksum would be order-dependent.
  const pathHashes = new Set(normalized.map(entry => entry.pathHash))
  if (pathHashes.size !== normalized.length) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A hashed source reported the same document path twice.',
      { surface },
    )
  }

  normalized.sort((left, right) => (left.pathHash < right.pathHash ? -1 : 1))
  return Object.freeze(normalized)
}

/**
 * Reduces a source's entries to one digest plus its count.
 *
 * The count is retained alongside the digest for cost and audit visibility, per
 * the Section 9 read-volume requirement — but it is never a substitute for the
 * digest.
 */
export function summarizeHashedSource(entries, surface) {
  const normalized = normalizeSourceEntries(entries, surface)
  // Both timestamp components enter the preimage at full precision.
  const preimage = normalized
    .map(entry => [
      entry.pathHash,
      entry.updateTime.seconds,
      entry.updateTime.nanoseconds,
      entry.documentHash,
    ].join(':'))
    .join('\n')

  return Object.freeze({
    documentCount: normalized.length,
    entriesHash: createHash('sha256').update(preimage, 'utf8').digest('hex'),
  })
}

/**
 * The destination and scoped surfaces whose absence preflight must establish.
 *
 * Each gets its OWN evidence set, so a reader cannot satisfy a pooled total while
 * leaving one surface unenumerated.
 */
export const DESTINATION_SURFACES = Object.freeze([
  'scopedCredentials',
  'scopedLogs',
  'classroomStudents',
])

/**
 * Requires a separate, schema-valid evidence set per destination surface, and
 * refuses any surface the contract does not name.
 */
function requireDestinationEvidence(destination) {
  const sets = destination.sourceEntriesBySurface
  if (!isPlainObject(sets)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The destination reader must supply per-surface evidence sets.',
    )
  }
  const unexpected = Object.keys(sets).filter(
    key => !DESTINATION_SURFACES.includes(key),
  )
  if (unexpected.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The destination reader reported an unrecognized surface.',
      { unexpected },
    )
  }
  const missing = DESTINATION_SURFACES.filter(surface => !Object.hasOwn(sets, surface))
  if (missing.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The destination reader did not enumerate every scoped surface.',
      { missing },
    )
  }
  return sets
}

/**
 * Requires an unambiguous boolean presence classification.
 *
 * `undefined` is not "absent": a reader that could not determine presence must not
 * be read as having proven absence.
 */
function requireExplicitPresence(result, surface) {
  if (typeof result.present !== 'boolean') {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A reader must state presence explicitly as a boolean.',
      { surface },
    )
  }
  return result.present
}

/**
 * Binds each declared count to the number of documents actually hashed for it.
 */
function bindEvidenceCardinality(bindings) {
  for (const [surface, declared, entries] of bindings) {
    if (!Number.isInteger(declared) || declared < 0) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'A declared count is not a non-negative integer.',
        { surface },
      )
    }
    const { documentCount } = summarizeHashedSource(entries, surface)
    if (declared !== documentCount) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'A declared document count disagrees with the hashed evidence for that source.',
        { surface, declared, documentCount },
      )
    }
  }
}

/**
 * Summarizes several named sources into one deterministic map.
 *
 * Keys are emitted in sorted order so the domain checksum cannot change because a
 * caller listed sources differently.
 */
function hashedSourceSummaries(namedEntries) {
  const summaries = {}
  for (const [surface, entries] of [...namedEntries].sort(
    ([left], [right]) => (left < right ? -1 : 1),
  )) {
    summaries[surface] = summarizeHashedSource(entries, surface)
  }
  return summaries
}

/**
 * Every reader result must declare completeness. A reader that paginated
 * partially, hit a timeout, or could not reach its surface must say so; a missing
 * declaration is treated as incomplete rather than assumed fine.
 */
function requireCompleteResult(result, surface) {
  if (!isPlainObject(result)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'An inspection surface returned no structured result.',
      { surface },
    )
  }
  if (result.complete !== true) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
      'An inspection surface returned an incomplete result.',
      { surface },
    )
  }
  if (result.truncated === true || result.nextPageToken) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
      'An inspection surface reported unread pages.',
      { surface },
    )
  }
  return result
}

/**
 * Compares an observed inventory against checksum-bound expectations.
 *
 * Anything observed that expectations do not describe is an unknown deployed
 * artifact, and anything expected but absent is equally blocking. Silence is
 * never agreement.
 */
function compareInventory(observed, expected, surface) {
  const observedKeys = Object.keys(observed).sort()
  const expectedKeys = Object.keys(expected).sort()

  const unexpected = observedKeys.filter(key => !expectedKeys.includes(key))
  if (unexpected.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.UNKNOWN_DEPLOYED_ARTIFACT,
      'Production presents an artifact the reviewed expectations do not describe.',
      { surface, unexpected },
    )
  }
  const absent = expectedKeys.filter(key => !observedKeys.includes(key))
  if (absent.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
      'A reviewed expectation names an artifact production does not present.',
      { surface, absent },
    )
  }
  const divergent = observedKeys.filter(
    key => observed[key] !== expected[key],
  )
  if (divergent.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
      'A deployed artifact diverges from its reviewed expectation.',
      { surface, divergent },
    )
  }
}

/** Normalizes a student ID to its numeric value, or null when non-numeric. */
export function numericStudentId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string') return null
  // Only a bare canonical decimal counts; "007" and " 7" are normalization
  // hazards, not numbers.
  if (!/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Sources that constitute IDENTITY SETS: one entry means one distinct student
 * record. Two entries here normalizing to the same number are two students
 * claiming one identity, which blocks.
 *
 * Every other source holds REFERENCES to students (a transaction cites a student,
 * a log line cites a student). The same student is referenced many times by
 * design, and different subsystems spell the reference differently — the legacy
 * roster stores `id: 7` while a credential stores `studentId: "7"`. Section 5 of
 * the brief is explicit that "Numeric/string equivalents are normalized", so a
 * repeated cross-source reference must NOT block.
 */
const IDENTITY_SET_SOURCES = Object.freeze(['roster', 'credentials', 'destinationStudents'])

/**
 * Derives the historical student-ID watermark across every required source.
 *
 * A malformed ID blocks, and a duplicate WITHIN one identity set blocks. A
 * numeric/string equivalent of the same student across sources is normalized, per
 * Section 5.
 *
 * An earlier version compared `${typeof raw}:${String(raw)}` across ALL sources
 * pooled together, which made the brief's own expected shape — roster `7`,
 * credential `"7"` — abort as a collision. The type is still what distinguishes
 * two spellings, but it is no longer grounds to reject a cross-source reference.
 */
export function deriveStudentIdWatermark(sources) {
  if (!isPlainObject(sources)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
      'Watermark derivation requires a source map.',
    )
  }

  const seenNumeric = new Set()
  let maximum = null
  const malformed = []

  for (const [sourceName, ids] of Object.entries(sources)) {
    if (!Array.isArray(ids)) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
        'Every watermark source must supply an array of student IDs.',
        { source: sourceName },
      )
    }

    // Duplicate detection is per identity set, on the NORMALIZED value: two
    // roster students spelled `7` and `"7"` are still two students claiming one
    // identity, so normalizing first is what catches them.
    const identitySet = IDENTITY_SET_SOURCES.includes(sourceName)
      ? new Set()
      : null

    for (const raw of ids) {
      const numeric = numericStudentId(raw)
      if (numeric === null) {
        malformed.push({ source: sourceName, kind: typeof raw })
        continue
      }

      if (identitySet !== null) {
        if (identitySet.has(numeric)) {
          abort(
            PREFLIGHT_ABORT_CATEGORIES.IDENTITY_COLLISION,
            'Two distinct student records in one identity set share a normalized ID.',
            { source: sourceName, numeric },
          )
        }
        identitySet.add(numeric)
      }

      seenNumeric.add(numeric)
      maximum = maximum === null ? numeric : Math.max(maximum, numeric)
    }
  }

  if (malformed.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
      'A student ID is malformed or non-numeric and cannot seed the watermark.',
      { malformedCount: malformed.length },
    )
  }

  return Object.freeze({
    observedMaximum: maximum,
    // A classroom with no historical students starts at 1.
    nextStudentNumber: maximum === null ? 1 : maximum + 1,
    distinctCount: seenNumeric.size,
  })
}

/**
 * Runs the complete read-only preflight.
 *
 * Ordering is load-bearing: the environment is validated, then the authorization
 * is bound, and only then is any reader invoked. The caller must not have created
 * an SDK handle before calling this — the entrypoint enforces that by
 * constructing readers lazily after its own guard call.
 */
export async function runProductionPreflight({
  environment,
  readers,
  authorization,
  expectations,
  credentialSha256,
  expectationsSha256,
  authorizationSha256,
  teacherUid,
  nowMillis,
  persistManifest,
  observedAt,
}) {
  // ---- 1. environment, before anything else ----
  const validatedEnvironment = validateExecutionEnvironment(environment)

  // The raw authorization digest is required, not optional: it is what binds the
  // manifest to the exact artifact bytes an operator presented.
  if (!SHA256_HEX.test(String(authorizationSha256))) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'The raw authorization-artifact digest is required and must be a SHA-256 hex digest.',
    )
  }

  // Persistence is mandatory. The Commit 3 contract is that a SUCCESSFUL preflight
  // produces a retained authorization record; returning success with nothing on
  // disk would let a later writer believe a preflight it cannot verify occurred.
  if (typeof persistManifest !== 'function') {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A manifest persister is required; a successful preflight must be retained.',
    )
  }

  if (validatedEnvironment.context !== EXECUTION_CONTEXT.PRODUCTION &&
      validatedEnvironment.context !== EXECUTION_CONTEXT.EMULATOR) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.AMBIGUOUS_ENVIRONMENT,
      'The execution context is not a recognized preflight target.',
    )
  }

  if (!isPlainObject(readers)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A complete reader set is required.',
    )
  }
  const missingReaders = REQUIRED_READER_NAMES.filter(
    name => typeof readers[name] !== 'function',
  )
  if (missingReaders.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A required inspection reader is unavailable.',
      { missingReaders },
    )
  }

  if (!isPlainObject(expectations)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
      'A reviewed expectations artifact is required.',
    )
  }

  // ---- 2. authorization, bound to the exact artifacts ----
  const validatedAuthorization = validateReadAuthorization({
    authorization,
    credentialSha256,
    expectationsSha256,
    teacherUid,
    projectId: validatedEnvironment.projectId,
    nowMillis,
  })

  // ---- 3. reads only ----
  const deployment = requireCompleteResult(
    await readers.readDeploymentInventory(),
    'deploymentInventory',
  )
  const REQUIRED_DEPLOYMENT_SURFACES = [
    'rules', 'functions', 'hosting', 'indexes', 'gateParameters',
  ]

  // Every surface must be readable from production BEFORE any is compared. An
  // unreadable surface is an unavailable inspection, not an expectations
  // mismatch, and checking all of them first keeps that distinction from
  // depending on which surface happens to be compared first.
  for (const surface of REQUIRED_DEPLOYMENT_SURFACES) {
    if (!isPlainObject(deployment[surface])) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'The deployment inventory is missing a required surface.',
        { surface },
      )
    }
  }

  for (const surface of REQUIRED_DEPLOYMENT_SURFACES) {
    if (!isPlainObject(expectations.deployment?.[surface])) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
        'The expectations artifact does not describe a required surface.',
        { surface },
      )
    }
    compareInventory(
      deployment[surface],
      expectations.deployment[surface],
      surface,
    )
  }

  const activeWriters = requireCompleteResult(
    await readers.readActiveWriters(),
    'activeWriters',
  )
  const acknowledgedWriters = Array.isArray(expectations.acknowledgedWriters)
    ? expectations.acknowledgedWriters
    : null
  if (acknowledgedWriters === null) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
      'The expectations artifact must enumerate acknowledged active writers.',
    )
  }
  const unacknowledged = (activeWriters.writers ?? []).filter(
    writer => !acknowledgedWriters.includes(writer),
  )
  if (unacknowledged.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.UNKNOWN_DEPLOYED_ARTIFACT,
      'An active writer is not acknowledged by the reviewed expectations.',
      { unacknowledged },
    )
  }

  const legacy = requireCompleteResult(
    await readers.readLegacyClassroomAggregate(),
    'legacyClassroomAggregate',
  )
  const credentials = requireCompleteResult(
    await readers.readFlatCredentials(),
    'flatCredentials',
  )
  const authLogs = requireCompleteResult(
    await readers.readFlatAuthLogs(),
    'flatAuthLogs',
  )
  const foundation = requireCompleteResult(
    await readers.readFoundation(),
    'foundation',
  )
  const destination = requireCompleteResult(
    await readers.readDestinationPaths(),
    'destinationPaths',
  )
  const authCompatibility = requireCompleteResult(
    await readers.readAuthCompatibility(),
    'authCompatibility',
  )

  // ---- 4. classification and abort criteria ----

  // The foundation is either completely present and reciprocal, or
  // unambiguously absent pending later administrative creation. A partial or
  // mismatched link is never repaired here.
  if (foundation.present === true) {
    if (foundation.reciprocal !== true) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
        'The existing foundation is present but its ownership link is not reciprocal.',
      )
    }
    if (foundation.teacherStatus !== 'active') {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
        'The existing teacher record is not exactly active.',
      )
    }
  } else if (foundation.present !== false) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
      'Foundation presence is ambiguous.',
    )
  }

  // Scoped credentials, scoped logs, or destination classroom data before bridge
  // rules would mean something already wrote V2 state. That must be explained,
  // not migrated over.
  // Iterating exactly the contract surfaces, not whatever the reader happened to
  // report: `Object.entries(destination.counts)` would silently skip a surface the
  // reader omitted entirely.
  if (!isPlainObject(destination.counts)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The destination reader must report a count per scoped surface.',
    )
  }
  const unexpectedCounts = Object.keys(destination.counts).filter(
    key => !DESTINATION_SURFACES.includes(key),
  )
  if (unexpectedCounts.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The destination reader reported a count for an unrecognized surface.',
      { unexpected: unexpectedCounts },
    )
  }
  for (const surface of DESTINATION_SURFACES) {
    const count = destination.counts[surface]
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'A destination path count is not a non-negative integer.',
        { surface },
      )
    }
    const acknowledged = expectations.acknowledgedDestinationCounts?.[surface]
    const allowed = typeof acknowledged === 'number' ? acknowledged : 0
    if (count !== allowed) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.DESTINATION_DATA_PRESENT,
        'A destination or scoped path holds unexpected data before bridge rules.',
        { surface },
      )
    }
  }

  if (authCompatibility.uidCollisions > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.AUTH_INCOMPATIBLE,
      'A deterministic V2 Auth UID collides with an existing Auth user.',
      { collisions: authCompatibility.uidCollisions },
    )
  }
  if (authCompatibility.incompatibleUsers > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.AUTH_INCOMPATIBLE,
      'An existing Auth user is in a state incompatible with the V2 identity scheme.',
      { incompatibleUsers: authCompatibility.incompatibleUsers },
    )
  }

  if (legacy.noncanonicalValueCount > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.NONCANONICAL_VALUE,
      'Legacy data contains values that are not checksum-safe under canonical encoding.',
      { count: legacy.noncanonicalValueCount },
    )
  }

  // Anomalies are permitted only when the checksum-bound expectations name them
  // explicitly. An unlisted anomaly is an unreviewed assumption.
  const acknowledgedAnomalies = Array.isArray(expectations.acknowledgedAnomalies)
    ? expectations.acknowledgedAnomalies
    : []
  const observedAnomalies = [
    ...(legacy.anomalies ?? []),
    ...(credentials.anomalies ?? []),
    ...(authLogs.anomalies ?? []),
    ...(foundation.anomalies ?? []),
  ]
  const unreviewed = observedAnomalies.filter(
    anomaly => !acknowledgedAnomalies.includes(anomaly),
  )
  if (unreviewed.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.UNREVIEWED_ANOMALY,
      'Production presents an anomaly the reviewed expectations do not acknowledge.',
      { unreviewed },
    )
  }

  if (credentials.duplicateLoginIds > 0 || credentials.duplicateStudentIds > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.IDENTITY_COLLISION,
      'Flat credentials contain duplicate login or student identities.',
    )
  }
  if (credentials.noncanonicalLoginIds > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
      'A flat credential login ID is not canonical.',
    )
  }

  // EVERY declared count and presence classification is bound to its evidence
  // cardinality. A reader that reports ten examined Auth users but supplies nine
  // hashes has retained evidence that never covered the omitted state, so the
  // summary and the digests would describe different sets of documents.
  //
  // An earlier version bound only flatCredentials and flatAuthLogs, leaving Auth
  // users, the destination surfaces, the foundation, and the legacy singleton
  // unbound.
  bindEvidenceCardinality([
    ['flatCredentials', credentials.count, credentials.sourceEntries],
    ['flatAuthLogs', authLogs.count, authLogs.sourceEntries],
    ['authUsers', authCompatibility.examinedUserCount, authCompatibility.sourceEntries],
    // The legacy aggregate is a singleton document: present means exactly one
    // entry, absent exactly none. Presence must be stated explicitly — inferring
    // it from the entry count would make this binding circular.
    ['legacyClassroom', requireExplicitPresence(legacy, 'legacyClassroom') ? 1 : 0,
      legacy.sourceEntries],
    // The foundation is the teacher record plus its reciprocal classroom when
    // present, and nothing when absent.
    ['foundation', foundation.present === true ? 2 : 0, foundation.sourceEntries],
  ])

  // Destination surfaces are bound INDIVIDUALLY. One pooled evidence set would
  // let a reader satisfy the total while omitting a whole surface — for example
  // reporting scoped auth logs as zero without ever enumerating them.
  const destinationSurfaces = requireDestinationEvidence(destination)
  bindEvidenceCardinality(
    DESTINATION_SURFACES.map(surface => [
      `destination.${surface}`,
      destination.counts[surface],
      destinationSurfaces[surface],
    ]),
  )

  const watermark = deriveStudentIdWatermark({
    roster: legacy.studentIds ?? [],
    credentials: credentials.studentIds ?? [],
    transactions: legacy.transactionStudentIds ?? [],
    loginHistory: legacy.loginHistoryStudentIds ?? [],
    authLogs: authLogs.studentIds ?? [],
    destinationStudents: destination.studentIds ?? [],
  })

  // ---- 5. manifest, only after every check passed ----
  const domains = {
    deploymentInventory: {
      rules: deployment.rules,
      functions: deployment.functions,
      hosting: deployment.hosting,
      indexes: deployment.indexes,
      gateParameters: deployment.gateParameters,
      activeWriters: [...(activeWriters.writers ?? [])].sort(),
    },
    // Counts are retained for cost/audit visibility, but the per-source digests
    // are what make this domain able to detect a changed balance, transaction
    // body, PIN hash, or update time while counts stay constant.
    legacySourceState: {
      present: legacy.present,
      counts: legacy.counts,
      credentialCount: credentials.count,
      authLogCount: authLogs.count,
      noncanonicalValueCount: legacy.noncanonicalValueCount,
      sources: hashedSourceSummaries([
        ['legacyClassroom', legacy.sourceEntries],
        ['flatCredentials', credentials.sourceEntries],
        ['flatAuthLogs', authLogs.sourceEntries],
      ]),
    },
    foundationState: {
      present: foundation.present,
      reciprocal: foundation.present === true ? foundation.reciprocal : null,
      teacherStatus: foundation.present === true ? foundation.teacherStatus : null,
      classroomIdPresent: Boolean(foundation.classroomId),
      sources: hashedSourceSummaries([
        ['foundation', foundation.sourceEntries],
      ]),
    },
    // Absence is asserted with evidence, not just a zero. If anything IS present
    // the run has already aborted; these digests record exactly what was examined,
    // per surface, so a later writer can tell which surface was proven empty.
    destinationAbsence: {
      counts: destination.counts,
      sources: hashedSourceSummaries(
        DESTINATION_SURFACES.map(surface => [surface, destinationSurfaces[surface]]),
      ),
    },
    authCompatibility: {
      uidCollisions: authCompatibility.uidCollisions,
      incompatibleUsers: authCompatibility.incompatibleUsers,
      examinedUserCount: authCompatibility.examinedUserCount,
      sources: hashedSourceSummaries([
        ['authUsers', authCompatibility.sourceEntries],
      ]),
    },
    identityWatermark: {
      observedMaximum: watermark.observedMaximum,
      nextStudentNumber: watermark.nextStudentNumber,
      distinctCount: watermark.distinctCount,
    },
    expectationsArtifact: { sha256: expectationsSha256 },
    // The digest of the authorization file's RAW BYTES, hashed before parsing.
    // A reconstruction from selected fields was rejected: it silently excluded
    // projectId, teacherUid, credentialProvenance, notBefore and notAfter, so
    // altering the provenance or the expiry left this checksum unchanged. The
    // pre-parse digest covers the whole artifact, including fields this module
    // does not itself interpret.
    authorizationArtifact: { sha256: authorizationSha256 },
  }

  // Every declared domain must be populated; a silently absent domain would
  // produce a manifest that looks complete but attests to nothing.
  const producedDomains = Object.keys(domains)
  if (CHECKSUM_DOMAINS.some(domain => !producedDomains.includes(domain))) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'A required checksum domain was not produced.',
    )
  }

  const manifest = buildProductionManifest({
    projectId: validatedEnvironment.projectId,
    teacherUid,
    releaseId: validatedAuthorization.releaseId,
    changeId: validatedAuthorization.changeId,
    authorizationId: validatedAuthorization.authorizationId,
    observedAt,
    domains,
    observations: {
      watermark: {
        observedMaximum: watermark.observedMaximum,
        nextStudentNumber: watermark.nextStudentNumber,
        distinctCount: watermark.distinctCount,
      },
      counts: {
        legacy: legacy.counts,
        flatCredentials: credentials.count,
        flatAuthLogs: authLogs.count,
      },
      foundationPresent: foundation.present,
      acknowledgedAnomalyCount: acknowledgedAnomalies.length,
    },
  })

  const persisted = await persistManifest(manifest)

  // The persister's own report must agree with what was built. A persister that
  // returned a different content address than the manifest it was handed would
  // mean the retained record and the reported one are not the same document.
  if (!isPlainObject(persisted)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The manifest persister did not report a retained record.',
    )
  }
  if (persisted.preflightManifestId !== manifest.preflightManifestId ||
      persisted.preflightChecksum !== manifest.preflightChecksum) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The retained manifest does not match the manifest this preflight built.',
    )
  }

  return Object.freeze({
    outcome: 'succeeded',
    context: validatedEnvironment.context,
    projectId: validatedEnvironment.projectId,
    preflightManifestId: manifest.preflightManifestId,
    preflightChecksum: manifest.preflightChecksum,
    domainChecksums: Object.freeze({ ...manifest.domainChecksums }),
    watermark,
    persisted,
  })
}

/** Exposed for the entrypoint's domain-hash reuse without re-deriving it. */
export { hashDomain }

/**
 * Creates a read-only Firestore/Auth handle pair.
 *
 * Lives here rather than in the entrypoint so `firebase-admin` resolves from
 * `functions/node_modules`, following the same convention as
 * `functions/phase2/seedRehearsal.js`: the repository-root suites reach Admin
 * through a module that lives beside the production code, so `firebase-admin`
 * never becomes a root dependency.
 *
 * The returned object exposes ONLY the getters the readers need. No batch,
 * transaction, or writer handle is constructed or returned, so a caller has no
 * mutating surface to reach for.
 */
export function createReadOnlyAdminHandles({ projectId, appName, credential }) {
  const existing = getApps().find(app => app.name === appName)
  const options = credential ? { projectId, credential } : { projectId }
  const app = existing ?? initializeApp(options, appName)

  return Object.freeze({
    app,
    firestore: getFirestore(app),
    auth: getAuth(app),
    close: async () => {
      // Only closes an app this factory created; a shared/default app is left
      // alone so a caller cannot accidentally tear down another consumer's handle.
      if (existing === undefined) await deleteApp(app)
    },
  })
}
