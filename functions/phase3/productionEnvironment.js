import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile as defaultReadFile } from 'node:fs/promises'
import process from 'node:process'
import { TextDecoder } from 'node:util'

/**
 * Phase 3 Commit 2 — production environment, project, and authorization guards.
 *
 * These are the fail-closed gates the future production runner and the V2
 * Functions gate must pass before any Firestore handle exists. This module
 * deliberately contains NO discovery, manifest, projection, reconciliation, or
 * write behavior; it only decides whether an execution context is a permitted
 * one and whether an operator supplied genuine authorization for a write.
 *
 * Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 2, 6, and 8.
 *
 * Design rules this module exists to enforce:
 *
 *  1. Exactly two recognized contexts — the existing demo emulator project with
 *     loopback hosts and emulator flags, or the exact production project with no
 *     emulator hosts/flags. Anything else, including an ambiguous mixture, is a
 *     blocking failure rather than a best guess.
 *  2. Importing this module never throws. Section 6 requires that module loading
 *     stay nonfatal so a misconfigured gate cannot crash Functions discovery or
 *     take the legacy exports down with it. Every check is a callable function.
 *  3. Write authorization is separate from environment validation, so a
 *     recognized production environment is necessary but never sufficient.
 *  4. No `--force`, project override, or implicit credential discovery exists
 *     anywhere in this module's contract.
 */

/** The only production project Phase 3 may ever target. */
export const ALLOWED_PRODUCTION_PROJECT_ID = 'morgan-bank'

/**
 * The only non-production project permitted, reused verbatim from the Phase 2B
 * gate-on acceptance contract (`functions/index.js`). It is a Firebase *demo*
 * project, so the CLI never contacts `firebase.googleapis.com` for it.
 */
export const ALLOWED_EMULATOR_PROJECT_ID = 'demo-morgan-bank-phase2b-server-test'

export const EXECUTION_CONTEXT = Object.freeze({
  EMULATOR: 'emulator',
  PRODUCTION: 'production',
})

export const PRODUCTION_ENVIRONMENT_CATEGORIES = Object.freeze({
  AMBIGUOUS_PROJECT_ID: 'ambiguous-project-id',
  CHECKOUT_DIRTY: 'checkout-dirty',
  CHECKOUT_MISMATCH: 'checkout-mismatch',
  CHECKOUT_UNVERIFIABLE: 'checkout-unverifiable',
  EMULATOR_FLAG_IN_PRODUCTION: 'emulator-flag-in-production',
  EMULATOR_HOST_IN_PRODUCTION: 'emulator-host-in-production',
  INVALID_AUTHORIZATION: 'invalid-authorization',
  INVALID_EMULATOR_HOST: 'invalid-emulator-host',
  INVALID_RELEASE_ID: 'invalid-release-id',
  MALFORMED_ARTIFACT: 'malformed-artifact',
  MALFORMED_CREDENTIAL: 'malformed-credential',
  MISSING_AUTHORIZATION: 'missing-authorization',
  MISSING_EMULATOR_FLAG: 'missing-emulator-flag',
  MISSING_EMULATOR_HOST: 'missing-emulator-host',
  MISSING_PROJECT_ID: 'missing-project-id',
  PROJECT_NOT_ALLOWED: 'project-not-allowed',
  RELEASE_ID_MISMATCH: 'release-id-mismatch',
  V2_NOT_ENABLED: 'v2-not-enabled',
  WRONG_PROJECT_CREDENTIAL: 'wrong-project-credential',
})

/**
 * Environment variables that must be absent (or empty) in a production context.
 * A leaked emulator host would silently redirect production traffic at a local
 * process; a leaked emulator flag would let production code take an
 * emulator-only branch.
 */
export const EMULATOR_HOST_VARIABLES = Object.freeze([
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
  'PUBSUB_EMULATOR_HOST',
])

export const EMULATOR_FLAG_VARIABLES = Object.freeze([
  'FUNCTIONS_EMULATOR',
  'FIREBASE_EMULATOR_HUB',
])

/** Release IDs are opaque to this module but must be unambiguous strings. */
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Authorization identifiers follow the same conservative shape. */
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A lowercase SHA-256 hex digest. Uppercase is rejected, not normalized. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

export class ProductionEnvironmentError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ProductionEnvironmentError'
    this.code = 'PHASE3_PRODUCTION_ENVIRONMENT_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new ProductionEnvironmentError(category, message, details)
}

/*
 * The reviewed-checkout proof deliberately does NOT live here. `functions/index.js`
 * imports this module for the V2 gate, so it ships inside the deployed Functions
 * artifact and must stay free of subprocess capability. The three CHECKOUT_*
 * categories above remain here so every entrypoint keeps one shared error type
 * and one redaction path for a rejected checkout; the local Git inspection that
 * raises them lives in the operator-only sibling `reviewedCheckout.js`, which
 * only the four operator entrypoints import and nothing deployed can reach.
 */

/**
 * Validates a reviewed release identifier supplied by a caller.
 *
 * Deliberately NOT coercing: `String(123)` would let a numeric
 * `expectedReleaseId` authorize release `"123"`, so a caller that read the value
 * from JSON or a spreadsheet cell could authorize a release it never named. The
 * reviewed identifier must already be a canonical string.
 */
function requireCanonicalReleaseId(value, missingMessage) {
  if (value === undefined || value === null ||
      (typeof value === 'string' && value.trim() === '')) {
    fail(PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION, missingMessage)
  }
  if (typeof value !== 'string' || !RELEASE_ID_PATTERN.test(value)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_RELEASE_ID,
      'The expected release identifier is not a canonical string.',
    )
  }
  return value
}

/**
 * Reads a variable from an environment-like object.
 *
 * The environment is injected rather than read from `process.env` directly so
 * every negative case is testable without mutating the test runner's own
 * process. `process.env` remains the default for real callers.
 */
function readVariable(environment, name) {
  const value = environment[name]
  return typeof value === 'string' ? value : undefined
}

/** Treats absent, empty, and whitespace-only values identically. */
function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === ''
}

/**
 * A loopback host:port. Copied in spirit from `functions/index.js`'s
 * `isLoopbackHostPort` so the emulator branch here cannot be laxer than the
 * Phase 2B gate it mirrors. A non-loopback emulator host is rejected outright
 * rather than treated as "probably local".
 */
export function isLoopbackHostPort(value) {
  if (typeof value !== 'string' || value !== value.trim() || value === '') {
    return false
  }
  const separatorIndex = value.lastIndexOf(':')
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return false
  }
  const host = value.slice(0, separatorIndex)
  const portText = value.slice(separatorIndex + 1)

  if (!/^\d+$/.test(portText)) return false
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false

  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

/**
 * Every environment variable that can route a Firebase/Google client at a
 * project. `GOOGLE_CLOUD_PROJECT` is included because the repository's own
 * isolation contract already classifies it as project-routing (it is scrubbed by
 * every Phase 2B emulator command); omitting it here would let a contradictory
 * value pass unnoticed while a different SDK layer honored it.
 */
export const PROJECT_ROUTING_VARIABLES = Object.freeze([
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
])

/**
 * A canonical project ID: a nonempty string, already exact, with no surrounding
 * whitespace.
 *
 * This guard never normalizes a routing value — trimming would accept
 * `" morgan-bank"` as production despite the exact-string requirement, and the
 * padded value is evidence of a misconfigured caller, not a formatting nicety.
 *
 * A present-but-blank value is equally a misconfiguration and must NOT be
 * silently treated as absent: `GOOGLE_CLOUD_PROJECT=""` alongside a valid
 * `GCLOUD_PROJECT` means something set that variable and failed, and the failure
 * has to surface rather than vanish behind the source that happens to be valid.
 */
function requireCanonicalProjectValue(value, source) {
  if (typeof value !== 'string') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
      'A project routing value must be a string.',
      { variable: source },
    )
  }
  if (value === '' || value.trim() === '') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
      'A project routing value is present but blank.',
      { variable: source },
    )
  }
  if (value !== value.trim()) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
      'A project routing value has surrounding whitespace and is not canonical.',
      { variable: source },
    )
  }
  return value
}

/**
 * Resolves the runtime project ID from every source Firebase/Google populates.
 *
 * All present sources must agree EXACTLY. Disagreement is ambiguous and
 * therefore blocking: guessing which one is authoritative is precisely how a
 * command aimed at an emulator ends up pointed at production. No value is
 * trimmed, normalized, or coerced.
 */
export function resolveRuntimeProjectId(...args) {
  // Same fail-closed rule as the high-level guards: an explicitly passed
  // `undefined` must not silently fall back to the ambient `process.env`. This
  // function is part of the public guard surface, so it needs the protection too.
  const environment = args.length === 0 ? process.env : args[0]

  if (environment === null || typeof environment !== 'object' ||
      Array.isArray(environment)) {
    throw new TypeError('environment must be an object.')
  }

  /** @type {{ source: string, value: string }[]} */
  const found = []

  // ONLY an actually absent source may be ignored. `undefined` means nothing set
  // the variable; anything else — including `""`, `"   "`, `null`, an array, or a
  // number — means something set it and got it wrong, which blocks. Using a
  // blankness test here instead would let a malformed source disappear whenever
  // another source happened to be valid.
  for (const variable of PROJECT_ROUTING_VARIABLES) {
    if (!Object.hasOwn(environment, variable)) continue
    const raw = environment[variable]
    if (raw === undefined) continue
    found.push({
      source: variable,
      value: requireCanonicalProjectValue(raw, variable),
    })
  }

  if (Object.hasOwn(environment, 'FIREBASE_CONFIG') &&
      environment.FIREBASE_CONFIG !== undefined) {
    const rawFirebaseConfig = environment.FIREBASE_CONFIG

    // A present FIREBASE_CONFIG must be usable. Blank, unparseable, non-object,
    // or projectId-less values are all misconfigurations rather than absence.
    if (typeof rawFirebaseConfig === 'string' && rawFirebaseConfig.trim() === '') {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
        'FIREBASE_CONFIG is present but blank.',
        { variable: 'FIREBASE_CONFIG' },
      )
    }

    let parsed
    if (typeof rawFirebaseConfig === 'string') {
      try {
        parsed = JSON.parse(rawFirebaseConfig)
      } catch {
        fail(
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          'FIREBASE_CONFIG is present but is not parseable JSON.',
          { variable: 'FIREBASE_CONFIG' },
        )
      }
    } else {
      parsed = rawFirebaseConfig
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
        'FIREBASE_CONFIG is present but is not a JSON object.',
        { variable: 'FIREBASE_CONFIG' },
      )
    }

    if (!Object.hasOwn(parsed, 'projectId') || parsed.projectId === undefined) {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
        'FIREBASE_CONFIG is present but declares no projectId.',
        { variable: 'FIREBASE_CONFIG' },
      )
    }

    found.push({
      source: 'FIREBASE_CONFIG.projectId',
      value: requireCanonicalProjectValue(
        parsed.projectId,
        'FIREBASE_CONFIG.projectId',
      ),
    })
  }

  if (found.length === 0) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_PROJECT_ID,
      'No runtime project ID is present in any project routing source.',
    )
  }

  // Full pairwise agreement, not just first-versus-second: with three sources a
  // two-way check could pass while a third disagreed.
  const distinct = [...new Set(found.map(entry => entry.value))]
  if (distinct.length > 1) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
      'Project routing sources name different projects.',
      // Names only, never values: Section 6 requires redacted telemetry.
      { sources: found.map(entry => entry.source) },
    )
  }

  return found[0].value
}

/**
 * Validates a project ID against the exact allowlist and returns its context.
 *
 * Exact string equality only — no prefix, suffix, or pattern matching, so a
 * lookalike such as `morgan-bank-staging` or `morgan-bank ` is rejected.
 */
export function classifyAllowedProject(projectId) {
  if (typeof projectId !== 'string' || isBlank(projectId)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_PROJECT_ID,
      'A project ID string is required.',
      { projectId },
    )
  }

  if (projectId === ALLOWED_PRODUCTION_PROJECT_ID) {
    return EXECUTION_CONTEXT.PRODUCTION
  }
  if (projectId === ALLOWED_EMULATOR_PROJECT_ID) {
    return EXECUTION_CONTEXT.EMULATOR
  }

  fail(
    PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
    'Project ID is not on the Phase 3 allowlist.',
    { projectId },
  )
}

/**
 * Validates the complete execution environment and returns the recognized
 * context. Throws `ProductionEnvironmentError` for every unrecognized or
 * ambiguous configuration.
 *
 * Production requires: exact project, no emulator host variable, no emulator
 * flag variable. Emulator requires: exact demo project, valid loopback
 * Firestore and Auth hosts, and `FUNCTIONS_EMULATOR === "true"`.
 */
export function validateExecutionEnvironment(...args) {
  // An explicitly passed `undefined` must NOT fall through to `process.env`.
  // Relying on a parameter default would let `validate(maybeEnv)` silently read
  // the ambient environment when `maybeEnv` is undefined — the caller believes
  // it constrained the check while the guard actually consulted the real
  // process. Distinguishing "no argument" from "undefined argument" is required
  // for this to fail closed.
  const environment = args.length === 0 ? process.env : args[0]

  if (environment === null || typeof environment !== 'object' ||
      Array.isArray(environment)) {
    throw new TypeError('environment must be an object.')
  }

  const projectId = resolveRuntimeProjectId(environment)
  const context = classifyAllowedProject(projectId)

  if (context === EXECUTION_CONTEXT.PRODUCTION) {
    for (const name of EMULATOR_HOST_VARIABLES) {
      if (!isBlank(readVariable(environment, name))) {
        fail(
          PRODUCTION_ENVIRONMENT_CATEGORIES.EMULATOR_HOST_IN_PRODUCTION,
          'An emulator host variable is set in a production context.',
          { variable: name },
        )
      }
    }
    for (const name of EMULATOR_FLAG_VARIABLES) {
      if (!isBlank(readVariable(environment, name))) {
        fail(
          PRODUCTION_ENVIRONMENT_CATEGORIES.EMULATOR_FLAG_IN_PRODUCTION,
          'An emulator flag variable is set in a production context.',
          { variable: name },
        )
      }
    }

    return Object.freeze({ context, projectId })
  }

  // Emulator context.
  if (readVariable(environment, 'FUNCTIONS_EMULATOR') !== 'true') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_EMULATOR_FLAG,
      'FUNCTIONS_EMULATOR must be exactly "true" in an emulator context.',
    )
  }
  for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    const value = readVariable(environment, name)
    if (isBlank(value)) {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_EMULATOR_HOST,
        'A required emulator host variable is missing.',
        { variable: name },
      )
    }
    if (!isLoopbackHostPort(value)) {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_EMULATOR_HOST,
        'An emulator host variable is not a valid loopback host:port.',
        { variable: name },
      )
    }
  }

  return Object.freeze({ context, projectId })
}

/**
 * Per-invocation V2 gate check for a recognized environment.
 *
 * Section 6 requires that a mismatch fail only this invocation, so callers are
 * expected to catch and collapse the error into a generic client-facing message.
 * Production additionally requires a release ID matching the reviewed deployed
 * artifact; the emulator context does not, because no release exists there.
 */
export function assertV2GateAllowed(options = {}) {
  const { v2Enabled, expectedReleaseId } = options

  if (v2Enabled !== true) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.V2_NOT_ENABLED,
      'Multi-teacher V2 is disabled.',
    )
  }

  // Same fail-closed rule as `validateExecutionEnvironment`: an explicitly
  // supplied `environment: undefined` must not silently become `process.env`.
  const suppliedEnvironment = Object.hasOwn(options, 'environment')
  const environment = suppliedEnvironment ? options.environment : process.env
  const validated = suppliedEnvironment
    ? validateExecutionEnvironment(options.environment)
    : validateExecutionEnvironment()

  if (validated.context === EXECUTION_CONTEXT.EMULATOR) {
    return validated
  }

  const actualReleaseId = readVariable(environment, 'MULTI_TEACHER_V2_RELEASE_ID')
  if (isBlank(actualReleaseId)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
      'A production V2 invocation requires MULTI_TEACHER_V2_RELEASE_ID.',
    )
  }
  if (!RELEASE_ID_PATTERN.test(actualReleaseId)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_RELEASE_ID,
      'MULTI_TEACHER_V2_RELEASE_ID is not a canonical release identifier.',
    )
  }
  requireCanonicalReleaseId(
    expectedReleaseId,
    'An expected release identifier is required to validate a production gate.',
  )
  if (actualReleaseId !== expectedReleaseId) {
    // Values are deliberately omitted: Section 6 requires redacted telemetry.
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.RELEASE_ID_MISMATCH,
      'The deployed release identifier does not match the reviewed artifact.',
    )
  }

  return Object.freeze({ ...validated, releaseIdVerified: true })
}

/**
 * The fields an operator must supply, out of band, to authorize a production
 * write. Every one is a human-recorded artifact of the release process; none can
 * be inferred, defaulted, or discovered by the runner.
 */
export const REQUIRED_WRITE_AUTHORIZATION_FIELDS = Object.freeze([
  'projectId',
  'teacherUid',
  'releaseId',
  'changeId',
  'authorizationId',
  'snapshotId',
  'writeFreezeProof',
  'credentialProvenance',
  'preflightManifestId',
  'initializationExpectationsSha256',
  'copyExpectationsSha256',
  'notBefore',
  'notAfter',
])

/**
 * Fields that are lowercase 64-character SHA-256 digests rather than canonical
 * identifiers. `preflightManifestId` is content-addressed, so it is digest-shaped
 * too — validating it as a loose identifier would accept a manifest ID that could
 * never resolve to a retained file.
 */
const WRITE_AUTHORIZATION_SHA256_FIELDS = Object.freeze([
  'preflightManifestId',
  'initializationExpectationsSha256',
  'copyExpectationsSha256',
])

/** Fields carrying an ISO-8601 instant bounding the authorization's validity. */
const WRITE_AUTHORIZATION_INSTANT_FIELDS = Object.freeze([
  'notBefore',
  'notAfter',
])

/**
 * Supplied identifiers that are recorded and bound but are NOT proofs.
 *
 * Named explicitly so no reader of this module mistakes their presence for
 * evidence that a snapshot was taken, a freeze is in effect, a credential's
 * provenance was audited, or a human approved anything. They are operator-entered
 * strings; this module proves only that they are well-formed and consistent
 * across artifacts.
 */
export const WRITE_AUTHORIZATION_UNPROVEN_IDENTIFIERS = Object.freeze([
  'snapshotId',
  'writeFreezeProof',
  'credentialProvenance',
  'authorizationId',
])

/** Flags that must never be honored, even if an operator passes them. */
export const PROHIBITED_AUTHORIZATION_KEYS = Object.freeze([
  'force',
  'skipPreflight',
  'allowProduction',
  'productionOverride',
  'manifestPath',
  'manifestOverride',
  'stateDir',
  'stateDirectory',
  'bypass',
  'dryRunOverride',
])

/**
 * Validates explicit, separately supplied write authorization.
 *
 * Deliberately separate from `validateExecutionEnvironment`: a recognized
 * production environment authorizes nothing on its own. This function proves an
 * operator supplied every required identifier and no override flag. It performs
 * no I/O — it does not read a manifest, contact Firestore, or verify that the
 * referenced snapshot exists. Those checks belong to the preflight and writer
 * commits; conflating them here would make this guard appear to prove more than
 * it does.
 */
export function validateWriteAuthorization(authorization, options = {}) {
  // A write is only ever authorized against the real production project. An
  // emulator rehearsal must not travel through this guard. The explicit-undefined
  // rule from `validateExecutionEnvironment` applies here too.
  const validated = Object.hasOwn(options, 'environment')
    ? validateExecutionEnvironment(options.environment)
    : validateExecutionEnvironment()
  if (validated.context !== EXECUTION_CONTEXT.PRODUCTION) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
      'A production write authorization requires the production project.',
      { context: validated.context },
    )
  }

  return finishWriteAuthorization(authorization, options, validated)
}

/**
 * The emulator-rehearsal counterpart to `validateWriteAuthorization`.
 *
 * Separately named on purpose. It shares the strict shape, binding, and validity
 * logic above, but it can NEVER authorize production: it requires the emulator
 * context and the one exact demo project, so a rehearsal artifact and a
 * production artifact are not interchangeable in either direction. The production
 * guard is not weakened or parameterized to accommodate this path, and no
 * `demo-*` project family is admitted — only the single allowlisted ID.
 */
export function validateRehearsalWriteAuthorization(authorization, options = {}) {
  const validated = Object.hasOwn(options, 'environment')
    ? validateExecutionEnvironment(options.environment)
    : validateExecutionEnvironment()
  if (validated.context !== EXECUTION_CONTEXT.EMULATOR) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
      'A rehearsal write authorization requires the emulator context.',
      { context: validated.context },
    )
  }
  // Defence in depth: `validateExecutionEnvironment` already pins the emulator
  // project, but a rehearsal authorization must never be satisfiable by any
  // project other than the single allowlisted demo ID.
  if (validated.projectId !== ALLOWED_EMULATOR_PROJECT_ID) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
      'A rehearsal write authorization requires the exact demo project.',
    )
  }

  return finishWriteAuthorization(authorization, options, validated)
}

/**
 * Shared strict validation for both authorization paths.
 *
 * The caller has already decided — and proven — which execution context applies.
 * This function never makes that decision, so it cannot become a way to reach the
 * production branch from a rehearsal call site.
 */
function finishWriteAuthorization(authorization, options, validated) {
  const { expectedReleaseId, nowMillis } = options

  if (authorization === null || typeof authorization !== 'object' ||
      Array.isArray(authorization)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
      'A write authorization object is required.',
    )
  }

  for (const key of PROHIBITED_AUTHORIZATION_KEYS) {
    if (Object.hasOwn(authorization, key)) {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'A prohibited override key was supplied.',
        { key },
      )
    }
  }

  const unknownKeys = Object.keys(authorization).filter(
    key => !REQUIRED_WRITE_AUTHORIZATION_FIELDS.includes(key),
  )
  if (unknownKeys.length > 0) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
      'The write authorization contains unsupported fields.',
      { unknownKeys },
    )
  }

  const missing = REQUIRED_WRITE_AUTHORIZATION_FIELDS.filter(
    field => isBlank(authorization[field]),
  )
  if (missing.length > 0) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
      'The write authorization is incomplete.',
      { missing },
    )
  }

  for (const field of REQUIRED_WRITE_AUTHORIZATION_FIELDS) {
    const value = authorization[field]
    if (typeof value !== 'string') {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'Every write authorization field must be a string.',
        { field },
      )
    }
    if (value !== value.trim()) {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'A write authorization field has surrounding whitespace.',
        { field },
      )
    }
  }

  // Digest-shaped fields are validated as digests, not as loose identifiers. The
  // canonical-identifier pattern would accept an uppercase or short value that can
  // never address a retained manifest or match a raw artifact hash.
  for (const field of WRITE_AUTHORIZATION_SHA256_FIELDS) {
    if (!SHA256_HEX_PATTERN.test(authorization[field])) {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'A write authorization digest is not a lowercase SHA-256 hex value.',
        { field },
      )
    }
  }

  for (const field of REQUIRED_WRITE_AUTHORIZATION_FIELDS) {
    if (WRITE_AUTHORIZATION_SHA256_FIELDS.includes(field) ||
        WRITE_AUTHORIZATION_INSTANT_FIELDS.includes(field)) {
      continue
    }
    if (!AUTHORIZATION_ID_PATTERN.test(authorization[field])) {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'A write authorization field is not a canonical identifier.',
        { field },
      )
    }
  }

  // The authorization must name the project it is being validated against, so a
  // record issued for one target cannot authorize writing another.
  if (authorization.projectId !== validated.projectId) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
      'The write authorization names a different project than the environment.',
    )
  }

  requireCanonicalReleaseId(
    expectedReleaseId,
    'An expected release identifier is required to authorize a write.',
  )
  if (authorization.releaseId !== expectedReleaseId) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.RELEASE_ID_MISMATCH,
      'The supplied release identifier does not match the reviewed artifact.',
    )
  }

  // The validity window is strict and must be CURRENT for every mutating
  // invocation. Unlike the read authorization — which a later write invocation may
  // legitimately outlive — a stale write authorization must never mutate anything.
  const notBefore = parseAuthorizationInstant(authorization.notBefore, 'notBefore')
  const notAfter = parseAuthorizationInstant(authorization.notAfter, 'notAfter')
  if (!(notBefore < notAfter)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
      'The write-authorization validity interval is empty or inverted.',
    )
  }
  if (!Number.isFinite(nowMillis)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
      'A finite current time is required to validate the authorization window.',
    )
  }
  if (nowMillis < notBefore || nowMillis > notAfter) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
      'The write authorization is outside its validity interval.',
    )
  }

  // Every validated safe field is returned. An earlier version dropped
  // `writeFreezeProof` and `credentialProvenance`, which meant the journal could
  // not record the identifiers the operator actually supplied.
  return Object.freeze({
    context: validated.context,
    projectId: validated.projectId,
    teacherUid: authorization.teacherUid,
    releaseId: authorization.releaseId,
    changeId: authorization.changeId,
    authorizationId: authorization.authorizationId,
    snapshotId: authorization.snapshotId,
    writeFreezeProof: authorization.writeFreezeProof,
    credentialProvenance: authorization.credentialProvenance,
    preflightManifestId: authorization.preflightManifestId,
    initializationExpectationsSha256:
      authorization.initializationExpectationsSha256,
    copyExpectationsSha256: authorization.copyExpectationsSha256,
    notBefore: authorization.notBefore,
    notAfter: authorization.notAfter,
  })
}

/**
 * Redacts an error for telemetry. Section 6 requires that a gate mismatch emit
 * redacted diagnostics: a category and variable/field name are safe, but values
 * (release IDs, project IDs, authorization identifiers) are not.
 */
export function redactEnvironmentError(error) {
  if (!(error instanceof ProductionEnvironmentError)) {
    return Object.freeze({ code: 'unknown', category: 'unknown' })
  }

  const safeDetails = {}
  for (const key of ['variable', 'field', 'key', 'context']) {
    if (typeof error.details[key] === 'string') {
      safeDetails[key] = error.details[key]
    }
  }
  // `sources` holds variable NAMES (e.g. GOOGLE_CLOUD_PROJECT), never values.
  for (const key of ['missing', 'unknownKeys', 'sources']) {
    if (Array.isArray(error.details[key])) {
      safeDetails[key] = Object.freeze([...error.details[key]])
    }
  }

  return Object.freeze({
    code: error.code,
    category: error.category,
    details: Object.freeze(safeDetails),
  })
}

/**
 * Parses an ISO-8601 instant bounding an authorization's validity.
 *
 * Not coercing: a numeric or `Date` input would let a caller supply a bound this
 * module never reviewed as text.
 */
function parseAuthorizationInstant(value, field) {
  if (typeof value !== 'string') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
      'An authorization validity bound must be an ISO-8601 string.',
      { field },
    )
  }
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
      'An authorization validity bound is not a parseable instant.',
      { field },
    )
  }
  return millis
}

/* ------------------------------------------------------------------------- *
 * Shared local-artifact helpers.
 *
 * Relocated here from `preflight.js` so all three Phase 3 entrypoints bind
 * artifacts identically instead of each carrying a near-copy that could drift.
 *
 * Importing this module remains side-effect-free: every function below reads
 * only when CALLED, with an explicitly named path supplied by the caller, and
 * none of them constructs an SDK, network, or Admin handle. The credential
 * FACTORY is injected by the caller — this module never imports `firebase-admin`.
 * ------------------------------------------------------------------------- */

/**
 * Reads an artifact and returns its exact bytes' SHA-256 plus a strictly decoded
 * UTF-8 string.
 *
 * Hash-before-parse: the digest covers the exact bytes on disk, so an artifact
 * cannot be bound to an authorization by one representation and then interpreted
 * as another. The decode is `fatal` because a lenient decode maps distinct
 * invalid byte sequences onto the same replacement character, which would let two
 * different files agree after decoding while disagreeing on disk.
 */
export async function readHashedArtifact(filePath, dependencies = {}) {
  const read = dependencies.readFile ?? defaultReadFile
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_ARTIFACT,
      'An artifact path must be a non-empty string.',
    )
  }
  const artifact = await read(filePath)
  if (typeof artifact !== 'string' && !(artifact instanceof Uint8Array)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_ARTIFACT,
      'An artifact reader returned no bytes.',
    )
  }
  const bytes = typeof artifact === 'string'
    ? Buffer.from(artifact, 'utf8')
    : artifact
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let contents
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_ARTIFACT,
      'An artifact is not valid UTF-8.',
    )
  }
  return Object.freeze({ contents, sha256 })
}

/** Parses artifact text as JSON without leaking its contents into the error. */
export function parseJsonArtifact(contents, label) {
  try {
    return JSON.parse(contents)
  } catch {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_ARTIFACT,
      `${label} is not parseable JSON.`,
      { label },
    )
  }
}

/**
 * Asserts a parsed artifact is a strict service-account key naming exactly the
 * expected project. PURE: it constructs nothing and returns the validated fields.
 *
 * `expectedProjectId` is a REQUIRED explicit argument that the caller must derive
 * from an already-validated execution environment, and it must be exactly one of
 * the two allowlisted projects. There is no default, no fallback, and no
 * `demo-*` family: an absent or unrecognized expectation fails closed here,
 * before any SDK handle could exist.
 */
export function assertServiceAccountArtifact(parsed, expectedProjectId) {
  if (expectedProjectId !== ALLOWED_PRODUCTION_PROJECT_ID &&
      expectedProjectId !== ALLOWED_EMULATOR_PROJECT_ID) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
      'A credential expectation must name an allowlisted project exactly.',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
      'The credential file must be a JSON object.',
    )
  }
  if (parsed.type !== 'service_account') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
      'The credential file must be an explicit service-account key.',
    )
  }
  if (parsed.project_id !== expectedProjectId) {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.WRONG_PROJECT_CREDENTIAL,
      'The credential file does not name the expected project.',
    )
  }
  for (const field of ['client_email', 'private_key']) {
    if (typeof parsed[field] !== 'string' || parsed[field].trim() === '') {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
        'The credential file is missing a required service-account field.',
        { field },
      )
    }
  }
  return Object.freeze({
    projectId: parsed.project_id,
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
  })
}

/**
 * Validates a service-account artifact and constructs an explicit Admin
 * credential from it.
 *
 * PRODUCTION ONLY. An explicit Admin credential is a production concept: the
 * emulator rehearsal path validates the artifact's shape with
 * `assertServiceAccountArtifact` and then uses the no-credential loopback handle
 * path, so a rehearsal never manufactures or uses one. Keeping construction on
 * this single production-pinned path is what preserves that meaning.
 *
 * There is no ADC, CLI-login, metadata-server, or ambient-discovery fallback
 * anywhere in this contract.
 */
export function validateExplicitCredential(parsed, credentialFactory) {
  const fields = assertServiceAccountArtifact(
    parsed,
    ALLOWED_PRODUCTION_PROJECT_ID,
  )
  if (typeof credentialFactory !== 'function') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
      'The explicit credential factory is unavailable.',
    )
  }
  let credential
  try {
    credential = credentialFactory({
      projectId: fields.projectId,
      clientEmail: fields.clientEmail,
      privateKey: fields.privateKey,
    })
  } catch {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
      'The credential file does not contain a usable service-account key.',
    )
  }
  if (!credential || typeof credential.getAccessToken !== 'function') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
      'The credential file did not produce an explicit Admin credential.',
    )
  }
  return credential
}
