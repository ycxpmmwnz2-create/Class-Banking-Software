import process from 'node:process'

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
  EMULATOR_FLAG_IN_PRODUCTION: 'emulator-flag-in-production',
  EMULATOR_HOST_IN_PRODUCTION: 'emulator-host-in-production',
  INVALID_AUTHORIZATION: 'invalid-authorization',
  INVALID_EMULATOR_HOST: 'invalid-emulator-host',
  INVALID_RELEASE_ID: 'invalid-release-id',
  MISSING_AUTHORIZATION: 'missing-authorization',
  MISSING_EMULATOR_FLAG: 'missing-emulator-flag',
  MISSING_EMULATOR_HOST: 'missing-emulator-host',
  MISSING_PROJECT_ID: 'missing-project-id',
  PROJECT_NOT_ALLOWED: 'project-not-allowed',
  RELEASE_ID_MISMATCH: 'release-id-mismatch',
  V2_NOT_ENABLED: 'v2-not-enabled',
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
 * A canonical project ID: already exact, with no surrounding whitespace. This
 * guard never normalizes a routing value — trimming would accept
 * `" morgan-bank"` as production despite the exact-string requirement, and the
 * padded value is evidence of a misconfigured caller, not a formatting nicety.
 */
function requireCanonicalProjectValue(value, source) {
  if (typeof value !== 'string') {
    fail(
      PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
      'A project routing value must be a string.',
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

  for (const variable of PROJECT_ROUTING_VARIABLES) {
    const raw = environment[variable]
    if (isBlank(raw)) continue
    found.push({
      source: variable,
      value: requireCanonicalProjectValue(raw, variable),
    })
  }

  const rawFirebaseConfig = environment.FIREBASE_CONFIG
  if (!isBlank(rawFirebaseConfig)) {
    let parsed
    try {
      parsed = typeof rawFirebaseConfig === 'string'
        ? JSON.parse(rawFirebaseConfig)
        : rawFirebaseConfig
    } catch {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
        'FIREBASE_CONFIG is present but is not parseable JSON.',
        { variable: 'FIREBASE_CONFIG' },
      )
    }
    if (parsed !== null && typeof parsed === 'object' &&
        !isBlank(parsed.projectId)) {
      found.push({
        source: 'FIREBASE_CONFIG.projectId',
        value: requireCanonicalProjectValue(
          parsed.projectId,
          'FIREBASE_CONFIG.projectId',
        ),
      })
    }
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
  'authorizationId',
  'releaseId',
  'snapshotId',
  'writeFreezeProof',
  'credentialProvenance',
  'preflightManifestId',
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
  const { expectedReleaseId } = options

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
    if (!AUTHORIZATION_ID_PATTERN.test(value)) {
      fail(
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'A write authorization field is not a canonical identifier.',
        { field },
      )
    }
  }

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

  return Object.freeze({
    context: validated.context,
    projectId: validated.projectId,
    authorizationId: authorization.authorizationId,
    releaseId: authorization.releaseId,
    snapshotId: authorization.snapshotId,
    preflightManifestId: authorization.preflightManifestId,
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
