import { createHash } from 'node:crypto'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { URL } from 'node:url'

import { deleteApp, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldPath, getFirestore } from 'firebase-admin/firestore'

import {
  EMULATOR_FLAG_VARIABLES,
  EMULATOR_HOST_VARIABLES,
  EXECUTION_CONTEXT,
  validateExecutionEnvironment,
} from './productionEnvironment.js'
import {
  CHECKSUM_DOMAINS,
  buildProductionManifest,
  hashDomain,
} from './productionManifest.js'
import {
  encodeCanonicalFirestoreValue,
  serializeCanonicalState,
} from '../phase2/canonicalState.js'
import { normalizeClassroomCode } from '../phase2b/identityNormalization.js'

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
  'studentLoginCode',
  'notBefore',
  'notAfter',
])

/**
 * Requires an already-canonical classroom login code.
 *
 * IMPORTANT: `normalizeClassroomCode` is a NORMALIZER, not a validator of
 * canonical form. It accepts and rewrites lowercase, surrounding whitespace,
 * internal spaces, and one formatting hyphen. Relying on it alone would let
 * `abcd-efgh`, `ABCD-EFGH`, ` ABCDEFGH `, and `ABCD EFGH` all authorize the same
 * write while the artifact an operator reviewed said something different.
 *
 * The rule enforced here is strictly stronger: normalization must SUCCEED and the
 * supplied bytes must already equal the canonical eight-character result exactly.
 * The reviewed artifact therefore states the code in exactly one form.
 *
 * The classroom root stores `formatClassroomCode(canonical)`; the login-code
 * index uses the canonical unformatted value as its document ID.
 */
function requireCanonicalLoginCode(rawCode) {
  let canonical
  try {
    canonical = normalizeClassroomCode(rawCode)
  } catch {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'The authorized classroom login code is not a valid classroom code.',
      { field: 'studentLoginCode' },
    )
  }
  if (rawCode !== canonical) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
      'The authorized classroom login code is not already in canonical form.',
      { field: 'studentLoginCode' },
    )
  }
  return canonical
}

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

  // The classroom login code must be chosen and bound BEFORE any write exists.
  // Binding it in the read authorization is what lets preflight prove the exact
  // selected code is absent, and lets the writer recover the code later from the
  // same artifact without the manifest ever retaining it.
  const canonicalLoginCode = requireCanonicalLoginCode(
    authorization.studentLoginCode,
  )

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

  // `canonicalLoginCode` is byte-identical to `authorization.studentLoginCode`
  // by construction; it is surfaced separately so callers bind the value the
  // canonical rule accepted rather than re-deriving it.
  return Object.freeze({ ...authorization, canonicalLoginCode })
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
/**
 * Builds a hashed source entry from a RAW READ-ONLY ENVELOPE.
 *
 * The evidence readers build the same entry from a Firestore snapshot. This
 * variant exists so the writer can recompute a retained domain checksum from the
 * envelopes its raw readers already return, using the identical preimage — the
 * whole point of reproving evidence is that both sides derive it the same way,
 * so the derivation lives in exactly one place.
 */
export function sourceEntryFromEnvelope(envelope, surface) {
  // updateTime is a Firestore Timestamp — a CLASS INSTANCE, not a plain object —
  // so it is validated by its contract (integer seconds/nanoseconds) rather than
  // by shape.
  if (!isPlainObject(envelope) || envelope.exists === false ||
      typeof envelope.path !== 'string' ||
      envelope.updateTime === null ||
      typeof envelope.updateTime !== 'object' ||
      !Number.isInteger(envelope.updateTime.seconds) ||
      !Number.isInteger(envelope.updateTime.nanoseconds)) {
    failInspection('A raw envelope cannot be summarized as source evidence.', {
      surface,
    })
  }
  let documentHash
  try {
    // `?? {}` mirrors the snapshot-based builder exactly: the two preimages must
    // agree byte for byte or a reproved checksum would never match.
    documentHash = canonicalDigest(
      encodeCanonicalFirestoreValue(envelope.data ?? {}),
    )
  } catch {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.NONCANONICAL_VALUE,
      'A Firestore document cannot be encoded canonically.',
      { surface },
    )
  }
  return Object.freeze({
    pathHash: createHash('sha256').update(envelope.path, 'utf8').digest('hex'),
    updateTime: Object.freeze({
      seconds: envelope.updateTime.seconds,
      nanoseconds: envelope.updateTime.nanoseconds,
    }),
    documentHash,
  })
}

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
  'classroomStudents',
  'classroomTransactions',
  'classroomLoginHistory',
  'scopedCredentials',
  'scopedLogs',
  // The root login-code index. Added as a SEPARATELY BOUND surface rather than
  // folded into an existing one: a pooled count would let a pre-existing code
  // reservation hide behind another surface's zero. Reserving a code that already
  // maps to some other classroom is exactly the collision the writer must never
  // commit, so its absence needs its own evidence set.
  'loginCodeIndex',
])

/**
 * The scoped subcollections beneath a V2 classroom root, paired with the
 * destination surface each one evidences.
 *
 * Taken from Phase 2A's own destination model (`batchWriter.js` writes
 * students/transactions/loginHistory/studentAuthLogs;
 * `destinationPreflight.js` and `manifest.js` enumerate the same set), so this
 * list cannot drift from what a V2 write would actually create. An earlier version
 * of this contract named only students, credentials and logs, which left a
 * pre-existing transaction or login-history document completely invisible while
 * preflight reported absence.
 */
export const CLASSROOM_SUBCOLLECTION_SURFACES = Object.freeze({
  students: 'classroomStudents',
  transactions: 'classroomTransactions',
  loginHistory: 'classroomLoginHistory',
  studentCredentials: 'scopedCredentials',
})

/**
 * Watermark sources that are IDENTITY SETS versus REFERENCE SETS.
 *
 * Exported so a reader cannot quietly classify a new source as a reference set to
 * dodge collision detection.
 */
export const WATERMARK_IDENTITY_SOURCES = Object.freeze([
  'roster',
  'credentials',
  'destinationStudents',
  'destinationCredentials',
])
export const WATERMARK_REFERENCE_SOURCES = Object.freeze([
  'transactions',
  'loginHistory',
  'authLogs',
  'destinationTransactions',
  'destinationLoginHistory',
  'destinationAuthLogs',
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
 * Requires the foundation reader to report the EXISTING teacher and classroom root
 * documents it enumerated.
 *
 * Both lists must be present and must contain only existing documents; a phantom
 * parent is not a root document.
 */
function requireFoundationRoots(foundation) {
  const roots = foundation.roots
  if (!isPlainObject(roots)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The foundation reader must enumerate existing teacher and classroom roots.',
    )
  }
  const unexpected = Object.keys(roots).filter(
    key => key !== 'teacherIds' && key !== 'classroomIds',
  )
  if (unexpected.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The foundation reader reported an unrecognized root set.',
      { unexpected },
    )
  }
  const resolved = {}
  for (const name of ['teacherIds', 'classroomIds']) {
    const value = roots[name]
    if (!Array.isArray(value) ||
        value.some(id => typeof id !== 'string' || id.trim() === '')) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'A foundation root set is missing or not a list of document IDs.',
        { set: name },
      )
    }
    if (new Set(value).size !== value.length) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'A foundation root set reported the same document twice.',
        { set: name },
      )
    }
    resolved[name] = value
  }
  return resolved
}

/**
 * The student-ID reference sets every destination reader must supply, one per
 * surface that can carry a student identity.
 */
const DESTINATION_ID_SETS = Object.freeze([
  'destinationStudents',
  'destinationCredentials',
  'destinationTransactions',
  'destinationLoginHistory',
  'destinationAuthLogs',
])

const DESTINATION_ID_SURFACE_CONTRACT = Object.freeze({
  destinationStudents: Object.freeze({
    surface: 'classroomStudents', identityRequired: true,
  }),
  destinationCredentials: Object.freeze({
    surface: 'scopedCredentials', identityRequired: true,
  }),
  destinationTransactions: Object.freeze({
    surface: 'classroomTransactions', identityRequired: false,
  }),
  destinationLoginHistory: Object.freeze({
    surface: 'classroomLoginHistory', identityRequired: false,
  }),
  destinationAuthLogs: Object.freeze({
    surface: 'scopedLogs', identityRequired: false,
  }),
})

const DESTINATION_ID_COVERAGE_FIELDS = Object.freeze([
  'referencedCount',
  'unassignedCount',
  'inconsistentCount',
])

/**
 * Requires the destination reader to state every student-ID reference set.
 *
 * An absent set is refused rather than defaulted to `[]`: silently treating a
 * missing set as empty is exactly how an acknowledged scoped record's historical
 * ID would fail to reach the watermark.
 */
function requireDestinationStudentIds(destination) {
  const supplied = destination.studentIdsBySurface
  if (!isPlainObject(supplied)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
      'The destination reader must supply student-ID references per surface.',
    )
  }
  const unexpected = Object.keys(supplied).filter(
    key => !DESTINATION_ID_SETS.includes(key),
  )
  if (unexpected.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
      'The destination reader supplied an unrecognized student-ID set.',
      { unexpected },
    )
  }
  const coverage = destination.studentIdCoverageBySurface
  if (!isPlainObject(coverage)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
      'The destination reader must classify every document as referenced or unassigned.',
    )
  }
  const unexpectedCoverage = Object.keys(coverage).filter(
    key => !DESTINATION_ID_SETS.includes(key),
  )
  if (unexpectedCoverage.length > 0) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
      'The destination reader supplied an unrecognized student-ID coverage set.',
      { unexpected: unexpectedCoverage },
    )
  }

  const resolved = {}
  const resolvedCoverage = {}
  for (const name of DESTINATION_ID_SETS) {
    if (!Array.isArray(supplied[name])) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
        'A destination student-ID set is missing or not an array.',
        { set: name },
      )
    }
    resolved[name] = supplied[name]

    const classification = coverage[name]
    if (!isPlainObject(classification) ||
        Object.keys(classification).length !== DESTINATION_ID_COVERAGE_FIELDS.length ||
        DESTINATION_ID_COVERAGE_FIELDS.some(field =>
          !Object.hasOwn(classification, field) ||
          !Number.isInteger(classification[field]) ||
          classification[field] < 0,
        )) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
        'A destination student-ID coverage classification is malformed.',
        { set: name },
      )
    }
    const unexpectedFields = Object.keys(classification).filter(
      field => !DESTINATION_ID_COVERAGE_FIELDS.includes(field),
    )
    if (unexpectedFields.length > 0) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
        'A destination student-ID coverage classification has unknown fields.',
        { set: name, unexpected: unexpectedFields },
      )
    }

    const contract = DESTINATION_ID_SURFACE_CONTRACT[name]
    const declaredDocuments = destination.counts[contract.surface]
    if (classification.referencedCount !== supplied[name].length ||
        classification.referencedCount + classification.unassignedCount !==
          declaredDocuments) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
        'A destination ID classification does not cover exactly the evidenced documents.',
        { set: name },
      )
    }
    if (contract.identityRequired && classification.unassignedCount !== 0) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
        'A destination identity document is missing its student ID.',
        { set: name, count: classification.unassignedCount },
      )
    }
    if (classification.inconsistentCount !== 0) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
        'A destination document carries an identity inconsistent with its path or shape.',
        { set: name, count: classification.inconsistentCount },
      )
    }
    resolvedCoverage[name] = Object.freeze({ ...classification })
  }
  return Object.freeze({
    ids: Object.freeze(resolved),
    coverage: Object.freeze(resolvedCoverage),
  })
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
const IDENTITY_SET_SOURCES = WATERMARK_IDENTITY_SOURCES

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

    // Every source must be explicitly classified. An unrecognized name would
    // otherwise default to "reference set" and silently skip collision detection —
    // so adding a new identity-bearing source without classifying it fails loudly
    // instead of quietly weakening the check.
    if (!IDENTITY_SET_SOURCES.includes(sourceName) &&
        !WATERMARK_REFERENCE_SOURCES.includes(sourceName)) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
        'A watermark source is not classified as an identity or reference set.',
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
    await readers.readDestinationPaths({
      canonicalLoginCode: validatedAuthorization.canonicalLoginCode,
    }),
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

  // Enumerated roots, not just the ONE teacher and classroom the invocation names.
  // Reading `teachers/{uid}` directly cannot see an unrelated second teacher or an
  // extra classroom root, and multiple teachers/classrooms are outside the
  // production state Phase 3 is authorized to migrate.
  //
  // Root documents must be EXISTING documents. A phantom parent — a path that
  // holds only subcollections — is not a root document, and counting one as a
  // teacher or classroom would invent state that is not there. The destination
  // surfaces above are what account for data beneath a phantom parent.
  const roots = requireFoundationRoots(foundation)

  const authorizedTeachers = foundation.present === true ? 1 : 0
  if (roots.teacherIds.length !== authorizedTeachers) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
      'Production holds a teacher document outside the authorized foundation.',
      { observed: roots.teacherIds.length, authorized: authorizedTeachers },
    )
  }
  if (roots.classroomIds.length !== authorizedTeachers) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
      'Production holds a classroom root outside the authorized foundation.',
      { observed: roots.classroomIds.length, authorized: authorizedTeachers },
    )
  }
  if (foundation.present === true) {
    // The one existing pair must be exactly the reciprocal pair just validated,
    // not some other teacher who happens to be the only one.
    if (roots.teacherIds[0] !== teacherUid) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
        'The only existing teacher document is not the authorized teacher.',
      )
    }
    if (roots.classroomIds[0] !== foundation.classroomId) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
        'The only existing classroom root is not the authorized classroom.',
      )
    }
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
  // Two distinct questions are answered here, and conflating them is what an
  // earlier version got wrong:
  //
  //  1. May this preflight COMPLETE? An acknowledged nonzero count is still a
  //     reviewed, explainable state, so it may complete and produce a manifest.
  //     That preserves preflight's diagnostic value.
  //  2. May the resulting manifest AUTHORIZE A WRITE? Only if every destination
  //     surface is exactly zero. An acknowledged record is an unreviewed
  //     assumption for a writer that is about to create documents beneath it.
  //
  // `writeEligible` is therefore computed independently of the abort criteria.
  let destinationsAllEmpty = true
  for (const surface of DESTINATION_SURFACES) {
    const count = destination.counts[surface]
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'A destination path count is not a non-negative integer.',
        { surface },
      )
    }
    if (count !== 0) destinationsAllEmpty = false

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

  // Checked after the per-surface counts so a surface-level problem reports its
  // own specific category rather than being masked by this classification.
  if (typeof destination.selectedCodePresent !== 'boolean') {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      'The destination reader did not classify the selected login code.',
    )
  }
  // A present selected code is a live reservation. Even if it happens to point at
  // this classroom, the writer must not proceed: preflight proved absence, and
  // reusing an existing index entry is a collision the initialization transaction
  // is explicitly forbidden to overwrite.
  if (destination.selectedCodePresent === true) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.DESTINATION_DATA_PRESENT,
      'The selected classroom login code is already reserved.',
    )
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

  // Every destination surface must contribute its raw student-ID references.
  //
  // "It normally aborts on nonzero destination counts" is NOT sufficient: a
  // nonzero count can be explicitly acknowledged by the reviewed expectations, and
  // an acknowledged record still carries a historical identity a later allocator
  // must start above. Omitting these would let an acknowledged scoped credential
  // holding student 900 leave the watermark at 4.
  const destinationIdentity = requireDestinationStudentIds(destination)
  const destinationIds = destinationIdentity.ids

  const watermark = deriveStudentIdWatermark({
    roster: legacy.studentIds ?? [],
    credentials: credentials.studentIds ?? [],
    transactions: legacy.transactionStudentIds ?? [],
    loginHistory: legacy.loginHistoryStudentIds ?? [],
    authLogs: authLogs.studentIds ?? [],
    destinationStudents: destinationIds.destinationStudents,
    destinationCredentials: destinationIds.destinationCredentials,
    destinationTransactions: destinationIds.destinationTransactions,
    destinationLoginHistory: destinationIds.destinationLoginHistory,
    destinationAuthLogs: destinationIds.destinationAuthLogs,
  })

  // ---- 5. manifest, only after every check passed ----

  // The RAW CODE IS NEVER RETAINED. Only its digest and the digest of the index
  // document path are bound, which is enough for a later writer to prove the
  // code it recovered from the re-presented authorization artifact is the same
  // one this preflight proved absent — without the manifest itself becoming a
  // document that discloses a live classroom credential.
  const canonicalCode = validatedAuthorization.canonicalLoginCode
  const canonicalCodeSha256 = createHash('sha256')
    .update(canonicalCode, 'utf8')
    .digest('hex')
  const canonicalCodePathSha256 = createHash('sha256')
    .update(`classroomLoginCodes/${canonicalCode}`, 'utf8')
    .digest('hex')

  // A manifest may only authorize Commit 5 writes when the foundation actually
  // exists and reciprocates, every destination surface is exactly zero, the
  // selected code is absent, and nothing was merely acknowledged. A
  // foundation-absent or acknowledged-anomaly manifest remains diagnostic.
  const writeEligible = foundation.present === true &&
    foundation.reciprocal === true &&
    destinationsAllEmpty &&
    destination.selectedCodePresent === false &&
    acknowledgedAnomalies.length === 0 &&
    Object.keys(expectations.acknowledgedDestinationCounts ?? {}).length === 0

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
      // Enumerated root counts, so the manifest attests to how many teacher and
      // classroom documents existed — not merely that the named pair was fine.
      existingTeacherCount: roots.teacherIds.length,
      existingClassroomCount: roots.classroomIds.length,
      sources: hashedSourceSummaries([
        ['foundation', foundation.sourceEntries],
      ]),
    },
    // Absence is asserted with evidence, not just a zero. If anything IS present
    // the run has already aborted; these digests record exactly what was examined,
    // per surface, so a later writer can tell which surface was proven empty.
    destinationAbsence: {
      counts: destination.counts,
      studentIdCoverage: destinationIdentity.coverage,
      // The selected code's absence is part of the checksummed domain, not just
      // a reported observation, so a writer cannot be handed a manifest whose
      // digest matches while its code classification was altered.
      selectedCodePresent: destination.selectedCodePresent,
      selectedCodeSha256: canonicalCodeSha256,
      selectedCodePathSha256: canonicalCodePathSha256,
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
      // Explicit, so a writer never has to re-derive eligibility from a
      // scattering of counts — and so a manifest that was only ever diagnostic
      // says so in one unambiguous field.
      writeEligible,
      selectedCodePresent: destination.selectedCodePresent,
      destinationCounts: destination.counts,
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

/** Fixed Google API origins reachable by the production reader factory. */
export const PRODUCTION_GOOGLE_API_ORIGINS = Object.freeze({
  rules: 'https://firebaserules.googleapis.com',
  functions: 'https://cloudfunctions.googleapis.com',
  hosting: 'https://firebasehosting.googleapis.com',
  firestoreAdmin: 'https://firestore.googleapis.com',
})

export const PRODUCTION_READER_TIMEOUT_MS = 10_000
const PRODUCTION_PAGE_LIMIT = 10_000
const PRODUCTION_LIST_PAGE_SIZE = 1_000
// The Firestore Admin API rejects every non-zero pageSize on the
// collectionGroups wildcard: "Invalid page size. Only 0 is supported."
const FIRESTORE_ADMIN_PAGE_SIZE = 0
let productionReaderSequence = 0

function canonicalDigest(value) {
  return createHash('sha256')
    .update(serializeCanonicalState(value), 'utf8')
    .digest('hex')
}

function failInspection(message, details) {
  abort(PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE, message, details)
}

async function boundedOperation(operation, label, timeoutMs) {
  let timeout
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new PreflightAbortError(
            PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
            'A read-only production inspection timed out.',
            { surface: label },
          ))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * GET-only JSON client for the four fixed Google control-plane origins.
 *
 * Redirect following is disabled, every request has a deadline, response shapes
 * are fail-closed, and pagination tokens are consumed until the service states
 * that no page remains. Callers provide only an origin key and an absolute API
 * path; no arbitrary URL is accepted.
 */
export function createBoundedGoogleApiClient({
  credential,
  fetchImpl = globalThis.fetch,
  timeoutMs = PRODUCTION_READER_TIMEOUT_MS,
}) {
  if (!credential || typeof credential.getAccessToken !== 'function') {
    failInspection('The explicit credential cannot mint a Google access token.')
  }
  if (typeof fetchImpl !== 'function') {
    failInspection('No HTTP implementation is available for control-plane reads.')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > PRODUCTION_READER_TIMEOUT_MS) {
    failInspection('The production-reader timeout is outside its fixed safety bound.')
  }

  async function accessToken() {
    let result
    try {
      result = await boundedOperation(
        () => credential.getAccessToken(),
        'accessToken',
        timeoutMs,
      )
    } catch (error) {
      if (error instanceof PreflightAbortError) throw error
      failInspection('The explicit credential could not obtain an access token.')
    }
    if (!isPlainObject(result) || typeof result.access_token !== 'string' ||
        result.access_token === '') {
      failInspection('The explicit credential returned no usable access token.')
    }
    return result.access_token
  }

  async function getJson(originKey, apiPath, query = {}) {
    const origin = PRODUCTION_GOOGLE_API_ORIGINS[originKey]
    if (typeof origin !== 'string' || typeof apiPath !== 'string' ||
        !apiPath.startsWith('/') || apiPath.startsWith('//')) {
      failInspection('A control-plane request was not anchored to a fixed endpoint.')
    }
    const url = new URL(apiPath, origin)
    if (url.origin !== origin || url.username || url.password || url.hash) {
      failInspection('A control-plane request escaped its fixed endpoint.')
    }
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }

    const token = await accessToken()
    const controller = new globalThis.AbortController()
    let timeout
    let response
    try {
      timeout = setTimeout(() => controller.abort(), timeoutMs)
      response = await fetchImpl(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: Object.freeze({
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        }),
      })
    } catch {
      failInspection('A read-only Google API request failed or timed out.', {
        service: originKey,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response || typeof response.status !== 'number') {
      failInspection('A Google API returned no structured response.', {
        service: originKey,
      })
    }
    if (response.redirected === true ||
        (response.status >= 300 && response.status < 400)) {
      failInspection('A Google API attempted to redirect a fixed-endpoint request.', {
        service: originKey,
      })
    }
    if (response.status < 200 || response.status >= 300) {
      failInspection('A read-only Google API request was rejected.', {
        service: originKey,
        status: response.status,
      })
    }

    let payload
    try {
      payload = await boundedOperation(
        () => response.json(),
        `${originKey}.json`,
        timeoutMs,
      )
    } catch (error) {
      if (error instanceof PreflightAbortError) throw error
      failInspection('A Google API returned malformed JSON.', { service: originKey })
    }
    if (!isPlainObject(payload)) {
      failInspection('A Google API returned a non-object JSON response.', {
        service: originKey,
      })
    }
    return payload
  }

  async function listAll({
    originKey,
    apiPath,
    itemsField,
    query = {},
    rejectUnreachable = false,
  }) {
    const items = []
    const seenTokens = new Set()
    let pageToken
    for (let page = 0; page < PRODUCTION_PAGE_LIMIT; page += 1) {
      const payload = await getJson(originKey, apiPath, {
        ...query,
        pageSize: query.pageSize ?? PRODUCTION_LIST_PAGE_SIZE,
        pageToken,
      })
      const pageItems = payload[itemsField] ?? []
      if (!Array.isArray(pageItems)) {
        failInspection('A paginated Google API response has no item array.', {
          service: originKey,
          field: itemsField,
        })
      }
      if (rejectUnreachable && Array.isArray(payload.unreachable) &&
          payload.unreachable.length > 0) {
        abort(
          PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
          'A Google API reported an unreachable location.',
          { service: originKey, count: payload.unreachable.length },
        )
      }
      items.push(...pageItems)

      const next = payload.nextPageToken
      if (next === undefined || next === null || next === '') return items
      if (typeof next !== 'string' || seenTokens.has(next)) {
        abort(
          PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
          'A Google API returned an invalid or repeated page token.',
          { service: originKey },
        )
      }
      seenTokens.add(next)
      pageToken = next
    }
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
      'A Google API exceeded the bounded pagination limit.',
      { service: originKey },
    )
  }

  return Object.freeze({ getJson, listAll })
}

function requireResourceName(value, prefix, label) {
  if (typeof value !== 'string' || !value.startsWith(prefix) ||
      value.includes('..') || value.includes('?') || value.includes('#')) {
    failInspection('A Google API returned a malformed resource name.', { surface: label })
  }
  return value
}

function lastPathPart(resourceName) {
  return resourceName.slice(resourceName.lastIndexOf('/') + 1)
}

async function readRulesInventory(client, projectId) {
  const release = await client.getJson(
    'rules',
    `/v1/projects/${encodeURIComponent(projectId)}/releases/cloud.firestore`,
  )
  const releaseName = requireResourceName(
    release.name,
    `projects/${projectId}/releases/`,
    'rulesRelease',
  )
  const rulesetName = requireResourceName(
    release.rulesetName,
    `projects/${projectId}/rulesets/`,
    'ruleset',
  )
  const ruleset = await client.getJson('rules', `/v1/${rulesetName}`)
  if (ruleset.name !== rulesetName || !isPlainObject(ruleset.source) ||
      !Array.isArray(ruleset.source.files) || ruleset.source.files.length === 0) {
    failInspection('The active Firestore ruleset source is incomplete.')
  }
  const files = ruleset.source.files.map(file => {
    if (!isPlainObject(file) || typeof file.name !== 'string' ||
        typeof file.content !== 'string') {
      failInspection('The active Firestore ruleset contains a malformed source file.')
    }
    return {
      name: file.name,
      content: file.content,
      fingerprint: typeof file.fingerprint === 'string' ? file.fingerprint : null,
    }
  }).sort((left, right) => left.name.localeCompare(right.name))

  return Object.freeze({
    release: releaseName,
    checksum: canonicalDigest(files),
  })
}

function normalizedFunctionRevision(functionResource) {
  // The API response is JSON. Hash the complete deployed resource rather than a
  // hand-selected subset: ingress, service account, secret bindings, scaling,
  // memory, timeout or a future field are all deployment state and must not drift
  // while a retained manifest still compares equal.
  return canonicalDigest(functionResource)
}

async function readFunctionsInventory(client, projectId) {
  const functions = await client.listAll({
    originKey: 'functions',
    apiPath: `/v2/projects/${encodeURIComponent(projectId)}/locations/-/functions`,
    itemsField: 'functions',
    rejectUnreachable: true,
  })
  const inventory = {}
  const gateValues = new Map()
  const writers = []
  for (const resource of functions) {
    if (!isPlainObject(resource)) {
      failInspection('The Functions API returned a malformed function resource.')
    }
    const name = requireResourceName(
      resource.name,
      `projects/${projectId}/locations/`,
      'function',
    )
    const key = name.slice(`projects/${projectId}/locations/`.length)
    const keyParts = key.split('/')
    if (keyParts.length !== 3 || keyParts[1] !== 'functions' ||
        !CANONICAL_ID.test(keyParts[0]) || !CANONICAL_ID.test(keyParts[2]) ||
        Object.hasOwn(inventory, key)) {
      failInspection('The Functions API returned a duplicate function name.')
    }
    inventory[key] = normalizedFunctionRevision(resource)
    writers.push(`function:${key}`)

    const environmentVariables = {
      ...(isPlainObject(resource.environmentVariables)
        ? resource.environmentVariables
        : {}),
      ...(isPlainObject(resource.serviceConfig?.environmentVariables)
        ? resource.serviceConfig.environmentVariables
        : {}),
    }
    for (const parameter of [
      'MULTI_TEACHER_V2_ENABLED',
      'MULTI_TEACHER_V2_RELEASE_ID',
    ]) {
      const value = Object.hasOwn(environmentVariables, parameter)
        ? environmentVariables[parameter]
        : 'absent'
      if (typeof value !== 'string') {
        failInspection('A deployed gate parameter is not a string.', { parameter })
      }
      if (!gateValues.has(parameter)) gateValues.set(parameter, new Map())
      gateValues.get(parameter).set(key, value)
    }
  }

  const gateParameters = {}
  for (const parameter of [
    'MULTI_TEACHER_V2_ENABLED',
    'MULTI_TEACHER_V2_RELEASE_ID',
  ]) {
    const values = gateValues.get(parameter)
    if (!values || values.size === 0) {
      gateParameters[parameter] = 'absent'
      continue
    }
    const distinct = new Set(values.values())
    gateParameters[parameter] = distinct.size === 1
      ? [...distinct][0]
      : `mixed:${canonicalDigest(Object.fromEntries([...values].sort()))}`
  }

  return Object.freeze({
    inventory: Object.freeze(inventory),
    gateParameters: Object.freeze(gateParameters),
    writers: Object.freeze(writers.sort()),
  })
}

async function readHostingInventory(client, projectId) {
  const sites = await client.listAll({
    originKey: 'hosting',
    apiPath: `/v1beta1/projects/${encodeURIComponent(projectId)}/sites`,
    itemsField: 'sites',
    query: { pageSize: 100 },
  })
  const inventory = {}
  const writers = []
  for (const site of sites) {
    if (!isPlainObject(site)) {
      failInspection('The Hosting API returned a malformed site resource.')
    }
    const siteName = requireResourceName(
      site.name,
      `projects/${projectId}/sites/`,
      'hostingSite',
    )
    const siteId = lastPathPart(siteName)
    if (!CANONICAL_ID.test(siteId) || Object.hasOwn(inventory, siteId)) {
      failInspection('The Hosting API returned an invalid or duplicate site ID.')
    }
    const releases = await client.listAll({
      originKey: 'hosting',
      apiPath: `/v1beta1/sites/${encodeURIComponent(siteId)}/releases`,
      itemsField: 'releases',
      query: { pageSize: 100 },
    })
    const releasesByTarget = new Map()
    for (const release of releases) {
      if (!isPlainObject(release) || typeof release.name !== 'string' ||
          typeof release.releaseTime !== 'string' ||
          !Number.isFinite(Date.parse(release.releaseTime))) {
        failInspection('The Hosting API returned a malformed release resource.')
      }
      const livePrefix = `sites/${siteId}/releases/`
      const channelPrefix = `sites/${siteId}/channels/`
      let target = siteId
      if (release.name.startsWith(channelPrefix)) {
        const remainder = release.name.slice(channelPrefix.length)
        const match = /^([^/]+)\/releases\/([^/]+)$/.exec(remainder)
        if (!match || !CANONICAL_ID.test(match[1]) || !CANONICAL_ID.test(match[2])) {
          failInspection('The Hosting API returned a malformed channel release name.')
        }
        target = `${siteId}:channel:${match[1]}`
      } else if (!release.name.startsWith(livePrefix) ||
          !CANONICAL_ID.test(release.name.slice(livePrefix.length))) {
        failInspection('The Hosting API returned a malformed live release name.')
      }
      if (!releasesByTarget.has(target)) releasesByTarget.set(target, [])
      releasesByTarget.get(target).push(release)
    }

    if (!releasesByTarget.has(siteId)) inventory[siteId] = 'none'
    for (const [target, targetReleases] of releasesByTarget) {
      targetReleases.sort((left, right) => {
        const byTime = right.releaseTime.localeCompare(left.releaseTime)
        return byTime === 0 ? left.name.localeCompare(right.name) : byTime
      })
      const current = targetReleases[0]
      const versionName = current.version?.name
      if (current.type === 'SITE_DISABLE' && versionName === undefined) {
        inventory[target] = `${current.name}|SITE_DISABLE`
        continue
      }
      if (typeof versionName !== 'string' ||
          !versionName.startsWith(`sites/${siteId}/versions/`) ||
          !CANONICAL_ID.test(lastPathPart(versionName))) {
        failInspection('The current Hosting release has no valid version identity.')
      }
      inventory[target] = `${current.name}|${versionName}`
      writers.push(`hosting:${target}:${lastPathPart(versionName)}`)
    }
  }
  if (sites.length === 0) inventory.default = 'none'
  return Object.freeze({
    inventory: Object.freeze(inventory),
    writers: Object.freeze(writers.sort()),
  })
}

async function readIndexesInventory(client, projectId) {
  const parent = `/v1/projects/${encodeURIComponent(projectId)}` +
    '/databases/(default)/collectionGroups/-'
  const [indexes, fields] = await Promise.all([
    client.listAll({
      originKey: 'firestoreAdmin',
      apiPath: `${parent}/indexes`,
      itemsField: 'indexes',
      query: { pageSize: FIRESTORE_ADMIN_PAGE_SIZE },
    }),
    client.listAll({
      originKey: 'firestoreAdmin',
      apiPath: `${parent}/fields`,
      itemsField: 'fields',
      query: {
        filter: 'indexConfig.usesAncestorConfig:false',
        pageSize: FIRESTORE_ADMIN_PAGE_SIZE,
      },
    }),
  ])
  const inventory = {}
  for (const index of indexes) {
    if (!isPlainObject(index)) failInspection('Firestore returned a malformed index.')
    const name = requireResourceName(
      index.name,
      `projects/${projectId}/databases/(default)/collectionGroups/`,
      'firestoreIndex',
    )
    const key = `composite:${name.slice(name.indexOf('/collectionGroups/') + 18)}`
    if (Object.hasOwn(inventory, key)) {
      failInspection('Firestore returned a duplicate composite index.')
    }
    inventory[key] = canonicalDigest(index)
  }
  for (const field of fields) {
    if (!isPlainObject(field)) failInspection('Firestore returned a malformed field index.')
    const name = requireResourceName(
      field.name,
      `projects/${projectId}/databases/(default)/collectionGroups/`,
      'firestoreFieldIndex',
    )
    const key = `field:${name.slice(name.indexOf('/collectionGroups/') + 18)}`
    if (Object.hasOwn(inventory, key)) {
      failInspection('Firestore returned a duplicate field override.')
    }
    inventory[key] = canonicalDigest(field)
  }
  if (indexes.length === 0) inventory.composite = 'none'
  if (fields.length === 0) inventory.fieldOverrides = 'none'
  return Object.freeze(inventory)
}

const FIRESTORE_PAGE_SIZE = 250

function exactSnapshotUpdateTime(snapshot, surface) {
  const updateTime = snapshot?.updateTime
  if (!Number.isSafeInteger(updateTime?.seconds) ||
      !Number.isInteger(updateTime?.nanoseconds) ||
      updateTime.nanoseconds < 0 || updateTime.nanoseconds > 999_999_999) {
    failInspection('Firestore returned a document without an exact update time.', {
      surface,
    })
  }
  return {
    seconds: updateTime.seconds,
    nanoseconds: updateTime.nanoseconds,
  }
}

function firestoreEvidenceEntry(snapshot, surface) {
  if (!snapshot || snapshot.exists !== true ||
      typeof snapshot.ref?.path !== 'string' ||
      typeof snapshot.data !== 'function') {
    failInspection('Firestore returned a malformed document snapshot.', { surface })
  }

  let documentHash
  try {
    documentHash = canonicalDigest(
      encodeCanonicalFirestoreValue(snapshot.data() ?? {}),
    )
  } catch {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.NONCANONICAL_VALUE,
      'A Firestore document cannot be encoded canonically.',
      { surface },
    )
  }
  return Object.freeze({
    pathHash: createHash('sha256')
      .update(snapshot.ref.path, 'utf8')
      .digest('hex'),
    updateTime: exactSnapshotUpdateTime(snapshot, surface),
    documentHash,
  })
}

function requireQueryPage(snapshot, collectionPath) {
  if (!snapshot || !Array.isArray(snapshot.docs) ||
      snapshot.docs.length > FIRESTORE_PAGE_SIZE) {
    failInspection('Firestore returned a malformed or oversized query page.', {
      surface: collectionPath,
    })
  }
  return snapshot.docs
}

async function readPaginatedFirestoreCollection({
  firestore,
  collectionPath,
  timeoutMs,
}) {
  const documents = []
  const seenPaths = new Set()
  let cursor = null

  for (let page = 0; page < PRODUCTION_PAGE_LIMIT; page += 1) {
    let query
    try {
      query = firestore.collection(collectionPath)
        .orderBy(FieldPath.documentId())
      if (cursor !== null) query = query.startAfter(cursor)
      query = query.limit(FIRESTORE_PAGE_SIZE)
    } catch {
      failInspection('A bounded Firestore collection query could not be built.', {
        surface: collectionPath,
      })
    }

    let snapshot
    try {
      snapshot = await boundedOperation(
        () => query.get(),
        collectionPath,
        timeoutMs,
      )
    } catch (error) {
      if (error instanceof PreflightAbortError) throw error
      failInspection('A bounded Firestore collection read failed.', {
        surface: collectionPath,
      })
    }
    const pageDocuments = requireQueryPage(snapshot, collectionPath)
    for (const document of pageDocuments) {
      if (document?.exists !== true || typeof document.ref?.path !== 'string' ||
          seenPaths.has(document.ref.path)) {
        abort(
          PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
          'Firestore returned a malformed or duplicate paginated document.',
          { surface: collectionPath },
        )
      }
      seenPaths.add(document.ref.path)
      documents.push(document)
    }

    if (pageDocuments.length < FIRESTORE_PAGE_SIZE) {
      return Object.freeze(documents)
    }
    cursor = pageDocuments.at(-1)
  }

  abort(
    PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
    'Firestore exceeded the bounded pagination limit.',
    { surface: collectionPath },
  )
}

async function readOptionalFirestoreDocument({
  firestore,
  documentPath,
  timeoutMs,
}) {
  let snapshot
  try {
    snapshot = await boundedOperation(
      () => firestore.doc(documentPath).get(),
      documentPath,
      timeoutMs,
    )
  } catch (error) {
    if (error instanceof PreflightAbortError) throw error
    failInspection('A bounded Firestore document read failed.', {
      surface: documentPath,
    })
  }
  if (!snapshot || typeof snapshot.exists !== 'boolean') {
    failInspection('Firestore returned no document presence classification.', {
      surface: documentPath,
    })
  }
  return snapshot
}

async function enumerateExistingRootIds({ firestore, collectionPath, timeoutMs }) {
  let references
  try {
    references = await boundedOperation(
      () => firestore.collection(collectionPath).listDocuments(),
      `${collectionPath}.listDocuments`,
      timeoutMs,
    )
  } catch (error) {
    if (error instanceof PreflightAbortError) throw error
    failInspection('A Firestore root collection could not be enumerated.', {
      surface: collectionPath,
    })
  }
  if (!Array.isArray(references)) {
    failInspection('Firestore returned no root-document reference list.', {
      surface: collectionPath,
    })
  }

  const ids = []
  const seen = new Set()
  for (const reference of references) {
    if (typeof reference?.id !== 'string' || reference.id === '' ||
        seen.has(reference.id) || typeof reference.get !== 'function') {
      abort(
        PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
        'Firestore returned a malformed or duplicate root reference.',
        { surface: collectionPath },
      )
    }
    seen.add(reference.id)
    let snapshot
    try {
      snapshot = await boundedOperation(
        () => reference.get(),
        `${collectionPath}.root`,
        timeoutMs,
      )
    } catch (error) {
      if (error instanceof PreflightAbortError) throw error
      failInspection('A Firestore root reference could not be inspected.', {
        surface: collectionPath,
      })
    }
    if (!snapshot || typeof snapshot.exists !== 'boolean') {
      failInspection('Firestore returned an invalid root snapshot.', {
        surface: collectionPath,
      })
    }
    if (snapshot.exists) ids.push(reference.id)
  }
  return Object.freeze(ids.sort())
}

function arrayOrAnomaly(data, field, anomalies, prefix) {
  if (Array.isArray(data[field])) return data[field]
  anomalies.push(`${prefix}:${field}:not-array`)
  return []
}

function duplicateNormalizedCount(values) {
  const normalized = values.map((value, index) => {
    const numeric = numericStudentId(value)
    return numeric === null
      // Malformed values are rejected later by watermark derivation. Keep them
      // distinct here without stringifying or retaining secret-bearing data.
      ? `malformed:${typeof value}:${index}`
      : `numeric:${numeric}`
  })
  return normalized.length - new Set(normalized).size
}

function authUserUpdateTime(user) {
  const value = user?.metadata?.lastRefreshTime ?? user?.metadata?.creationTime
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    failInspection('An Auth user has no parseable source timestamp.', {
      surface: 'authUsers',
    })
  }
  const seconds = Math.floor(milliseconds / 1_000)
  return {
    seconds,
    nanoseconds: (milliseconds - seconds * 1_000) * 1_000_000,
  }
}

function authUserEvidenceEntry(user) {
  if (!user || typeof user.uid !== 'string' || user.uid === '') {
    failInspection('Auth returned a malformed user record.', {
      surface: 'authUsers',
    })
  }
  if (!Array.isArray(user.providerData)) {
    failInspection('Auth returned a user without a provider list.', {
      surface: 'authUsers',
    })
  }
  const providers = user.providerData.map(entry => entry?.providerId).sort()
  if (providers.some(provider => typeof provider !== 'string')) {
    failInspection('Auth returned a malformed provider record.', {
      surface: 'authUsers',
    })
  }
  let completeUserState
  try {
    // UserRecord.toJSON() is the Admin SDK's complete serializable view. Hashing
    // it binds claims, provider identities, disabled state, token revocation and
    // any password-hash metadata the caller is permitted to observe. Raw values
    // exist only in this digest preimage and are never retained in the manifest.
    const serializable = typeof user.toJSON === 'function'
      ? user.toJSON()
      : {
        uid: user.uid,
        disabled: user.disabled,
        email: user.email,
        emailVerified: user.emailVerified,
        displayName: user.displayName,
        phoneNumber: user.phoneNumber,
        photoURL: user.photoURL,
        customClaims: user.customClaims,
        tenantId: user.tenantId,
        tokensValidAfterTime: user.tokensValidAfterTime,
        metadata: user.metadata,
        providerData: user.providerData,
        multiFactor: user.multiFactor,
      }
    // Normalize through JSON exactly as the Admin record promises. This drops
    // absent `undefined` properties without dropping present null/false values.
    completeUserState = JSON.parse(JSON.stringify(serializable))
  } catch {
    failInspection('Auth returned a user that could not be hashed canonically.', {
      surface: 'authUsers',
    })
  }
  return Object.freeze({
    pathHash: createHash('sha256')
      .update(`auth/users/${user.uid}`, 'utf8')
      .digest('hex'),
    updateTime: authUserUpdateTime(user),
    documentHash: canonicalDigest(completeUserState),
  })
}

/**
 * Builds the Firestore/Auth half of the production reader set.
 *
 * This exported seam lets the emulator suite exercise the exact production data
 * reader code while continuing to inject control-plane state, which Firebase
 * does not emulate. It accepts already-created handles and never initializes an
 * SDK or credential on its own.
 */
export function createReadOnlyDataReaders({
  firestore,
  auth,
  teacherUid,
  timeoutMs = PRODUCTION_READER_TIMEOUT_MS,
}) {
  if (!firestore || typeof firestore.doc !== 'function' ||
      typeof firestore.collection !== 'function' ||
      !auth || typeof auth.listUsers !== 'function' ||
      typeof teacherUid !== 'string' || teacherUid === '' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > PRODUCTION_READER_TIMEOUT_MS) {
    failInspection('The read-only data-reader configuration is malformed.')
  }

  async function readLegacyClassroomAggregate() {
    const snapshot = await readOptionalFirestoreDocument({
      firestore,
      documentPath: 'morganBank/classroomData',
      timeoutMs,
    })
    if (!snapshot.exists) {
      return Object.freeze({
        complete: true,
        counts: { students: 0, transactions: 0, loginHistory: 0 },
        studentIds: [],
        transactionStudentIds: [],
        loginHistoryStudentIds: [],
        noncanonicalValueCount: 0,
        anomalies: [],
        present: false,
        sourceEntries: [],
      })
    }

    const data = snapshot.data()
    if (!isPlainObject(data)) {
      failInspection('The legacy classroom singleton has a malformed body.')
    }
    const anomalies = []
    const students = arrayOrAnomaly(data, 'students', anomalies, 'legacy')
    const transactions = arrayOrAnomaly(data, 'transactions', anomalies, 'legacy')
    const loginHistory = arrayOrAnomaly(data, 'loginHistory', anomalies, 'legacy')
    for (const [name, values] of [
      ['students', students],
      ['transactions', transactions],
      ['loginHistory', loginHistory],
    ]) {
      if (values.some(value => !isPlainObject(value))) {
        anomalies.push(`legacy:${name}:item-not-object`)
      }
    }
    return Object.freeze({
      complete: true,
      counts: {
        students: students.length,
        transactions: transactions.length,
        loginHistory: loginHistory.length,
      },
      studentIds: students.map(student => student?.id),
      transactionStudentIds: transactions
        .filter(entry => entry?.studentId != null)
        .map(entry => entry.studentId),
      loginHistoryStudentIds: loginHistory
        .filter(entry => entry?.studentId != null)
        .map(entry => entry.studentId),
      noncanonicalValueCount: 0,
      anomalies,
      present: true,
      sourceEntries: [firestoreEvidenceEntry(snapshot, 'legacyClassroomAggregate')],
    })
  }

  async function readFlatCredentials() {
    const documents = await readPaginatedFirestoreCollection({
      firestore,
      collectionPath: 'studentCredentials',
      timeoutMs,
    })
    const loginIds = documents.map(document => document.id)
    const studentIds = documents.map(document => document.data()?.studentId)
    return Object.freeze({
      complete: true,
      count: documents.length,
      studentIds,
      duplicateLoginIds: loginIds.length - new Set(loginIds).size,
      duplicateStudentIds: duplicateNormalizedCount(studentIds),
      noncanonicalLoginIds: loginIds.filter(
        id => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id),
      ).length,
      anomalies: [],
      sourceEntries: documents.map(document =>
        firestoreEvidenceEntry(document, 'flatCredentials')),
    })
  }

  async function readFlatAuthLogs() {
    const documents = await readPaginatedFirestoreCollection({
      firestore,
      collectionPath: 'studentAuthLogs',
      timeoutMs,
    })
    return Object.freeze({
      complete: true,
      count: documents.length,
      studentIds: documents
        .filter(document => document.data()?.studentId != null)
        .map(document => document.data().studentId),
      anomalies: [],
      sourceEntries: documents.map(document =>
        firestoreEvidenceEntry(document, 'flatAuthLogs')),
    })
  }

  async function readFoundation() {
    const [teacherIds, classroomIds] = await Promise.all([
      enumerateExistingRootIds({
        firestore,
        collectionPath: 'teachers',
        timeoutMs,
      }),
      enumerateExistingRootIds({
        firestore,
        collectionPath: 'classrooms',
        timeoutMs,
      }),
    ])
    const roots = Object.freeze({ teacherIds, classroomIds })
    const teacherSnapshot = await readOptionalFirestoreDocument({
      firestore,
      documentPath: `teachers/${teacherUid}`,
      timeoutMs,
    })
    if (!teacherSnapshot.exists) {
      return Object.freeze({
        complete: true,
        present: false,
        anomalies: [],
        sourceEntries: [],
        roots,
      })
    }

    const teacher = teacherSnapshot.data()
    if (!isPlainObject(teacher) || typeof teacher.classroomId !== 'string' ||
        teacher.classroomId === '') {
      failInspection('The authorized teacher foundation is malformed.')
    }
    const classroomSnapshot = await readOptionalFirestoreDocument({
      firestore,
      documentPath: `classrooms/${teacher.classroomId}`,
      timeoutMs,
    })
    const classroom = classroomSnapshot.exists ? classroomSnapshot.data() : null
    return Object.freeze({
      complete: true,
      present: true,
      reciprocal: classroomSnapshot.exists && isPlainObject(classroom) &&
        classroom.ownerUid === teacherUid && teacher.uid === teacherUid,
      teacherStatus: teacher.status,
      classroomId: teacher.classroomId,
      anomalies: [],
      sourceEntries: [
        firestoreEvidenceEntry(teacherSnapshot, 'foundation'),
        ...(classroomSnapshot.exists
          ? [firestoreEvidenceEntry(classroomSnapshot, 'foundation')]
          : []),
      ],
      roots,
    })
  }

  async function readDestinationPaths({ canonicalLoginCode } = {}) {
    // The selected code is required: the login-code-index surface has to prove
    // both that the whole collection is empty AND that the exact document the
    // writer intends to create is absent. Deriving only the collection count
    // would leave the specific reservation unproven if the count check ever
    // loosened.
    if (typeof canonicalLoginCode !== 'string' || canonicalLoginCode === '') {
      failInspection(
        'A canonical classroom login code is required to inspect the code index.',
      )
    }

    let classroomReferences
    let scopedLogParents
    try {
      [classroomReferences, scopedLogParents] = await Promise.all([
        boundedOperation(
          () => firestore.collection('classrooms').listDocuments(),
          'classrooms.listDocuments',
          timeoutMs,
        ),
        boundedOperation(
          () => firestore.collection('studentAuthLogs').listDocuments(),
          'studentAuthLogs.listDocuments',
          timeoutMs,
        ),
      ])
    } catch (error) {
      if (error instanceof PreflightAbortError) throw error
      failInspection('A destination parent collection could not be enumerated.')
    }
    if (!Array.isArray(classroomReferences) || !Array.isArray(scopedLogParents)) {
      failInspection('A destination parent enumeration was malformed.')
    }

    const bySurface = Object.fromEntries(
      DESTINATION_SURFACES.map(surface => [surface, []]),
    )
    const idsBySurface = Object.fromEntries(
      DESTINATION_ID_SETS.map(surface => [surface, []]),
    )
    const coverage = Object.fromEntries(
      DESTINATION_ID_SETS.map(surface => [surface, {
        referencedCount: 0,
        unassignedCount: 0,
        inconsistentCount: 0,
      }]),
    )

    function recordIdentity(setName, document, { pathMustMatch = false } = {}) {
      const body = document.data()
      const field = pathMustMatch ? 'id' : 'studentId'
      if (!isPlainObject(body) || !Object.hasOwn(body, field) ||
          body[field] == null) {
        coverage[setName].unassignedCount += 1
        return
      }
      const rawId = body[field]
      idsBySurface[setName].push(rawId)
      coverage[setName].referencedCount += 1
      if (pathMustMatch) {
        const bodyId = numericStudentId(rawId)
        const pathId = numericStudentId(document.id)
        if (bodyId === null || pathId === null || bodyId !== pathId) {
          coverage[setName].inconsistentCount += 1
        }
      }
    }

    function recordReference(setName, document) {
      const body = document.data()
      if (!isPlainObject(body) || !Object.hasOwn(body, 'studentId') ||
          body.studentId == null) {
        coverage[setName].unassignedCount += 1
        return
      }
      idsBySurface[setName].push(body.studentId)
      coverage[setName].referencedCount += 1
    }

    const classroomIds = new Set()
    for (const reference of classroomReferences) {
      if (typeof reference?.id !== 'string' || reference.id === '' ||
          classroomIds.has(reference.id)) {
        abort(
          PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
          'Firestore returned a malformed or duplicate classroom reference.',
        )
      }
      classroomIds.add(reference.id)
      for (const [subcollection, surface] of Object.entries(
        CLASSROOM_SUBCOLLECTION_SURFACES,
      )) {
        const documents = await readPaginatedFirestoreCollection({
          firestore,
          collectionPath: `classrooms/${reference.id}/${subcollection}`,
          timeoutMs,
        })
        bySurface[surface].push(...documents.map(document =>
          firestoreEvidenceEntry(document, surface)))
        if (subcollection === 'students') {
          documents.forEach(document => recordIdentity(
            'destinationStudents',
            document,
            { pathMustMatch: true },
          ))
        } else if (subcollection === 'studentCredentials') {
          documents.forEach(document => recordIdentity(
            'destinationCredentials',
            document,
          ))
        } else {
          const setName = subcollection === 'transactions'
            ? 'destinationTransactions'
            : 'destinationLoginHistory'
          documents.forEach(document => recordReference(setName, document))
        }
      }
    }

    // The root login-code index is enumerated COMPLETELY, with the same bounded
    // pagination every other surface uses, and the exact selected document is
    // then read on its own. Both are required: a complete enumeration proves no
    // reservation exists anywhere, and the exact read proves the specific
    // document the writer will create is absent.
    const loginCodeDocuments = await readPaginatedFirestoreCollection({
      firestore,
      collectionPath: 'classroomLoginCodes',
      timeoutMs,
    })
    bySurface.loginCodeIndex.push(...loginCodeDocuments.map(document =>
      firestoreEvidenceEntry(document, 'loginCodeIndex')))

    const selectedCodeSnapshot = await readOptionalFirestoreDocument({
      firestore,
      documentPath: `classroomLoginCodes/${canonicalLoginCode}`,
      timeoutMs,
    })

    const scopedParentIds = new Set()
    for (const parent of scopedLogParents) {
      if (typeof parent?.id !== 'string' || parent.id === '' ||
          scopedParentIds.has(parent.id)) {
        abort(
          PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
          'Firestore returned a malformed or duplicate scoped-log parent.',
        )
      }
      scopedParentIds.add(parent.id)
      const documents = await readPaginatedFirestoreCollection({
        firestore,
        collectionPath: `studentAuthLogs/${parent.id}/logs`,
        timeoutMs,
      })
      bySurface.scopedLogs.push(...documents.map(document =>
        firestoreEvidenceEntry(document, 'scopedLogs')))
      documents.forEach(document =>
        recordReference('destinationAuthLogs', document))
    }

    return Object.freeze({
      complete: true,
      counts: Object.freeze(Object.fromEntries(
        Object.entries(bySurface).map(([surface, entries]) => [
          surface,
          entries.length,
        ]),
      )),
      sourceEntriesBySurface: Object.freeze(bySurface),
      studentIdsBySurface: Object.freeze(idsBySurface),
      studentIdCoverageBySurface: Object.freeze(coverage),
      // Stated explicitly rather than inferred from the collection count, so the
      // selected-code check cannot be satisfied by a surface-level zero.
      selectedCodePresent: selectedCodeSnapshot.exists === true,
    })
  }

  async function readAuthCompatibility() {
    const users = []
    const seenUids = new Set()
    const seenTokens = new Set()
    let pageToken
    for (let page = 0; page < PRODUCTION_PAGE_LIMIT; page += 1) {
      let result
      try {
        result = await boundedOperation(
          () => auth.listUsers(PRODUCTION_LIST_PAGE_SIZE, pageToken),
          'authUsers',
          timeoutMs,
        )
      } catch (error) {
        if (error instanceof PreflightAbortError) throw error
        failInspection('A bounded Auth user read failed.')
      }
      if (!result || !Array.isArray(result.users)) {
        failInspection('Auth returned a malformed user page.')
      }
      for (const user of result.users) {
        if (typeof user?.uid !== 'string' || user.uid === '' ||
            seenUids.has(user.uid)) {
          abort(
            PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
            'Auth returned a malformed or duplicate user.',
          )
        }
        seenUids.add(user.uid)
        users.push(user)
      }
      const next = result.pageToken
      if (next === undefined || next === null || next === '') {
        return Object.freeze({
          complete: true,
          // V2 owns the deterministic `s_` namespace. An existing user in that
          // namespace can collide with a future classroom not yet present, so it
          // is conservatively blocking even when no destination credential exists.
          uidCollisions: users.filter(user => user.uid.startsWith('s_')).length,
          incompatibleUsers: 0,
          examinedUserCount: users.length,
          sourceEntries: users.map(authUserEvidenceEntry),
        })
      }
      if (typeof next !== 'string' || seenTokens.has(next)) {
        abort(
          PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
          'Auth returned an invalid or repeated page token.',
        )
      }
      seenTokens.add(next)
      pageToken = next
    }
    abort(
      PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
      'Auth exceeded the bounded pagination limit.',
    )
  }

  return Object.freeze({
    readLegacyClassroomAggregate,
    readFlatCredentials,
    readFlatAuthLogs,
    readFoundation,
    readDestinationPaths,
    readAuthCompatibility,
  })
}

/**
 * A complete raw Firestore envelope: identity, body, presence classification and
 * exact update time. This is what the projection and reconciliation contracts
 * consume, and it is deliberately NOT what the evidence readers above produce.
 */
function rawEnvelope(snapshot) {
  const data = snapshot.data()
  if (!isPlainObject(data)) {
    failInspection('Firestore returned a document with a malformed body.', {
      surface: 'rawEnvelope',
    })
  }
  // Validated for exact seconds/nanoseconds, then the ORIGINAL Timestamp is
  // returned rather than a plain {seconds, nanoseconds} copy. The projection and
  // reconciliation contracts require a real Timestamp (they call `toMillis`),
  // and a downgraded copy would silently fail their exactness check.
  exactSnapshotUpdateTime(snapshot, 'rawEnvelope')

  // `exists` is carried for the writer's presence checks but is NOT part of
  // Phase 2B's strict source-envelope contract, which rejects unlisted keys.
  // `toSourceEnvelope` below strips it before a projection ever sees it —
  // widening the Phase 2B contract instead would mean editing Phase 2B.
  return Object.freeze({
    id: snapshot.id,
    path: snapshot.ref.path,
    data,
    exists: true,
    updateTime: snapshot.updateTime,
  })
}

/**
 * Narrows a raw envelope to exactly the keys Phase 2B's projection accepts.
 *
 * Kept as an explicit adapter so the writer can rely on `exists` while the pure
 * projection still receives only its declared contract.
 */
export function toSourceEnvelope(envelope) {
  if (!isPlainObject(envelope) || envelope.exists === false) return envelope
  return Object.freeze({
    id: envelope.id,
    path: envelope.path,
    data: envelope.data,
    updateTime: envelope.updateTime,
  })
}

/**
 * Read-only readers that return COMPLETE RAW ENVELOPES.
 *
 * Why this exists as a separate family, and why it lives in this module rather
 * than in `productionWriter.js`:
 *
 *  - The evidence readers above intentionally retain only hashes. A manifest must
 *    never carry a raw path or body, and that property must not be weakened to
 *    serve the writer.
 *  - But `buildProductionProjection` and `reconcileProductionWriteRun` are pure
 *    functions over raw `{id, path, data, updateTime}` envelopes. Something has to
 *    supply those, and it must be a read-only component.
 *  - Ownership sits here so `reverify.js` can consume these readers WITHOUT
 *    importing `productionWriter.js`. If the writer owned them, a read-only
 *    re-verifier could not read anything without importing mutation code.
 *
 * These functions issue only reads. They share the exact same private pagination
 * and snapshot primitives as the evidence readers, so the two families cannot
 * silently enumerate different document sets. Raw bodies and paths returned here
 * are for in-memory comparison only; they never enter a manifest or a journal.
 */
export function createRawDataReaders({
  firestore,
  teacherUid,
  timeoutMs = PRODUCTION_READER_TIMEOUT_MS,
}) {
  if (!firestore || typeof firestore.doc !== 'function' ||
      typeof firestore.collection !== 'function' ||
      typeof teacherUid !== 'string' || teacherUid === '' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > PRODUCTION_READER_TIMEOUT_MS) {
    failInspection('The raw data-reader configuration is malformed.')
  }

  async function readDocument(documentPath) {
    const snapshot = await readOptionalFirestoreDocument({
      firestore,
      documentPath,
      timeoutMs,
    })
    if (snapshot.exists !== true) {
      return Object.freeze({ path: documentPath, exists: false })
    }
    return rawEnvelope(snapshot)
  }


  async function readCollection(collectionPath) {
    const documents = await readPaginatedFirestoreCollection({
      firestore,
      collectionPath,
      timeoutMs,
    })
    return Object.freeze(documents.map(rawEnvelope))
  }

  return Object.freeze({
    readDocument,
    readCollection,
    readLegacyClassroomAggregate: () => readDocument('morganBank/classroomData'),
    readFlatCredentials: () => readCollection('studentCredentials'),
    readFlatAuthLogs: () => readCollection('studentAuthLogs'),
    readTeacher: () => readDocument(`teachers/${teacherUid}`),
    readClassroom: classroomId => readDocument(`classrooms/${classroomId}`),
    readLoginCodeIndexDocument: canonicalCode =>
      readDocument(`classroomLoginCodes/${canonicalCode}`),
    readLoginCodeIndex: () => readCollection('classroomLoginCodes'),
    readClassroomStudents: classroomId =>
      readCollection(`classrooms/${classroomId}/students`),
    readClassroomTransactions: classroomId =>
      readCollection(`classrooms/${classroomId}/transactions`),
    readClassroomLoginHistory: classroomId =>
      readCollection(`classrooms/${classroomId}/loginHistory`),
    readScopedCredentials: classroomId =>
      readCollection(`classrooms/${classroomId}/studentCredentials`),
    readScopedAuthLogs: classroomId =>
      readCollection(`studentAuthLogs/${classroomId}/logs`),
  })
}

/**
 * Constructs the control-plane-only production reader set from one explicit
 * credential.
 *
 * This factory deliberately creates no Admin app and exposes no Firestore or
 * Auth reader. It exists so the separately authorized inventory boundary can
 * observe the opaque deployed values needed to prepare reviewed expectations
 * without reaching application data or authentication records.
 */
export function createProductionControlPlaneReaders({
  projectId,
  credential,
  fetchImpl = globalThis.fetch,
  timeoutMs = PRODUCTION_READER_TIMEOUT_MS,
}) {
  if (projectId !== 'morgan-bank') {
    failInspection('The production control-plane reader requires the exact production project.')
  }
  if (!credential || typeof credential.getAccessToken !== 'function') {
    failInspection('The production control-plane reader requires an explicit credential.')
  }
  const ambientEmulatorMarker = [
    ...EMULATOR_HOST_VARIABLES,
    ...EMULATOR_FLAG_VARIABLES,
  ].find(name => typeof process.env[name] === 'string' &&
    process.env[name].trim() !== '')
  if (ambientEmulatorMarker !== undefined) {
    failInspection(
      'The production reader factory refuses ambient emulator routing.',
      { variable: ambientEmulatorMarker },
    )
  }
  const client = createBoundedGoogleApiClient({ credential, fetchImpl, timeoutMs })
  let inventoryPromise

  async function readControlPlane() {
    if (inventoryPromise === undefined) {
      inventoryPromise = Promise.all([
        readRulesInventory(client, projectId),
        readFunctionsInventory(client, projectId),
        readHostingInventory(client, projectId),
        readIndexesInventory(client, projectId),
      ]).then(([rules, functions, hosting, indexes]) => Object.freeze({
        rules,
        functions: functions.inventory,
        hosting: hosting.inventory,
        indexes,
        gateParameters: functions.gateParameters,
        writers: Object.freeze([
          ...functions.writers,
          ...hosting.writers,
        ].sort()),
      }))
    }
    return inventoryPromise
  }

  return Object.freeze({
    readDeploymentInventory: async () => {
      const inventory = await readControlPlane()
      return Object.freeze({
        complete: true,
        rules: inventory.rules,
        functions: inventory.functions,
        hosting: inventory.hosting,
        indexes: inventory.indexes,
        gateParameters: inventory.gateParameters,
      })
    },
    readActiveWriters: async () => {
      const inventory = await readControlPlane()
      return Object.freeze({ complete: true, writers: inventory.writers })
    },
  })
}

/**
 * Constructs the complete production reader set from one explicit credential.
 * Construction never reads remotely; the returned functions perform the reads
 * only after the entrypoint has validated arguments, environment, artifacts and
 * authorization inputs.
 */
export function createProductionReaders({
  projectId,
  teacherUid,
  credential,
  fetchImpl = globalThis.fetch,
  timeoutMs = PRODUCTION_READER_TIMEOUT_MS,
  adminHandleFactory = createReadOnlyAdminHandles,
}) {
  if (!CANONICAL_ID.test(teacherUid)) {
    failInspection('The production reader factory requires a canonical teacher UID.')
  }
  if (typeof adminHandleFactory !== 'function') {
    failInspection('The production Admin handle factory is unavailable.')
  }

  // Validate every control-plane input before constructing an Admin app, so an
  // invalid test seam cannot leave even a local SDK handle behind.
  const controlPlaneReaders = createProductionControlPlaneReaders({
    projectId,
    credential,
    fetchImpl,
    timeoutMs,
  })

  const handles = adminHandleFactory({
    projectId,
    credential,
    appName: `phase3-production-preflight-${process.pid}-${productionReaderSequence += 1}`,
  })
  if (!handles || typeof handles.close !== 'function') {
    failInspection('The production Admin handle factory returned no closable handles.')
  }
  let dataReaders
  try {
    dataReaders = createReadOnlyDataReaders({
      firestore: handles.firestore,
      auth: handles.auth,
      teacherUid,
      timeoutMs,
    })
  } catch (error) {
    // Factory construction is synchronous, while deleteApp is asynchronous.
    // Start cleanup immediately and retain the original fail-closed error.
    Promise.resolve().then(() => handles.close()).catch(() => {})
    throw error
  }

  return Object.freeze({
    ...dataReaders,
    ...controlPlaneReaders,
    close: async () => handles.close(),
  })
}
