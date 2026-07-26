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
 * Derives the historical student-ID watermark across every required source.
 *
 * Any malformed ID or numeric/string collision blocks: the watermark is what a
 * later allocator starts above, so an unexplained ID here would let a future
 * student reuse a historical identity.
 */
export function deriveStudentIdWatermark(sources) {
  if (!isPlainObject(sources)) {
    abort(
      PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
      'Watermark derivation requires a source map.',
    )
  }

  const seenNumeric = new Map()
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

    for (const raw of ids) {
      const numeric = numericStudentId(raw)
      if (numeric === null) {
        malformed.push({ source: sourceName, kind: typeof raw })
        continue
      }

      // Two different raw representations mapping to one number is a
      // normalization collision: the string "7" and the number 7 would silently
      // share an allocation slot, so a later allocator could hand the same
      // identity to two students.
      //
      // The comparison must include the TYPE, not just the text: comparing
      // String(raw) would make '7' and 7 look identical and never trip, which is
      // exactly the case this check exists to catch.
      const spelling = `${typeof raw}:${String(raw)}`
      const existing = seenNumeric.get(numeric)
      if (existing !== undefined && existing !== spelling) {
        abort(
          PREFLIGHT_ABORT_CATEGORIES.IDENTITY_COLLISION,
          'Two distinct student-ID representations normalize to the same number.',
          { source: sourceName, numeric },
        )
      }
      seenNumeric.set(numeric, spelling)
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
  teacherUid,
  nowMillis,
  persistManifest,
  observedAt,
}) {
  // ---- 1. environment, before anything else ----
  const validatedEnvironment = validateExecutionEnvironment(environment)

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
  for (const [surface, count] of Object.entries(destination.counts ?? {})) {
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
    legacySourceState: {
      counts: legacy.counts,
      credentialCount: credentials.count,
      authLogCount: authLogs.count,
      noncanonicalValueCount: legacy.noncanonicalValueCount,
    },
    foundationState: {
      present: foundation.present,
      reciprocal: foundation.present === true ? foundation.reciprocal : null,
      teacherStatus: foundation.present === true ? foundation.teacherStatus : null,
      classroomIdPresent: Boolean(foundation.classroomId),
    },
    destinationAbsence: { counts: destination.counts ?? {} },
    authCompatibility: {
      uidCollisions: authCompatibility.uidCollisions,
      incompatibleUsers: authCompatibility.incompatibleUsers,
      examinedUserCount: authCompatibility.examinedUserCount,
    },
    identityWatermark: {
      observedMaximum: watermark.observedMaximum,
      nextStudentNumber: watermark.nextStudentNumber,
      distinctCount: watermark.distinctCount,
    },
    expectationsArtifact: { sha256: expectationsSha256 },
    authorizationArtifact: {
      sha256: hashArtifactBytes(
        JSON.stringify({
          authorizationId: validatedAuthorization.authorizationId,
          changeId: validatedAuthorization.changeId,
          releaseId: validatedAuthorization.releaseId,
          credentialSha256: validatedAuthorization.credentialSha256,
          expectationsSha256: validatedAuthorization.expectationsSha256,
        }),
      ),
    },
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

  const persisted = typeof persistManifest === 'function'
    ? await persistManifest(manifest)
    : null

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
