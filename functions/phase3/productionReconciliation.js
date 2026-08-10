import {
  STUDENT_DESTINATION_FIELDS,
  buildProductionProjection,
} from './productionProjection.js'
import { firestoreValuesEqual } from '../phase2b/scopedCredentialProjection.js'
import {
  formatClassroomCode,
  normalizeClassroomCode,
} from '../phase2b/identityNormalization.js'
import { toSourceEnvelope } from './productionPreflight.js'

/**
 * Phase 3 Commit 4 — pure dry-run and post-copy reconciliation.
 *
 * Every value compared here is supplied by the caller. This module has no SDK,
 * network, filesystem, manifest, or write capability. A later runner owns the
 * reads and may proceed only when this module returns a passing summary.
 */

export const PRODUCTION_RECONCILIATION_MODES = Object.freeze({
  DRY_RUN: 'dry-run',
  WRITE_RUN: 'write-run',
})

export const PRODUCTION_RECONCILIATION_CATEGORIES = Object.freeze({
  DRY_RUN_MISMATCH: 'dry-run-mismatch',
  INVALID_ARGUMENTS: 'invalid-arguments',
  WRITE_RUN_MISMATCH: 'write-run-mismatch',
})

const SOURCE_KEYS = Object.freeze([
  'classroomData',
  'studentCredentials',
  'studentAuthLogs',
])

const FOUNDATION_KEYS = Object.freeze([
  'teacherUid',
  'classroomId',
  'teacher',
  'classroom',
])

const ACTUAL_KEYS = Object.freeze([
  'teacher',
  'classroom',
  'legacyClassroomData',
  'flatCredentials',
  'flatAuthLogs',
  'students',
  'transactions',
  'loginHistory',
  'scopedCredentials',
  'scopedAuthLogs',
  // The reserved login-code index document. Included in write-run reconciliation
  // because it is a document the writer creates; omitting it would let the copy
  // reconcile as complete while the reservation was missing, wrong, or pointed at
  // another classroom.
  'loginCodeIndex',
])

/**
 * The initialization inputs Release Order step 9 established, supplied to
 * reconciliation so the expected classroom after copy includes them.
 *
 * Kept as an EXPLICIT input rather than derived inside the legacy projection:
 * the login code and student counter are not properties of the legacy data, and
 * mixing their derivation into `buildProductionProjection` would make a pure
 * copy transformation responsible for identity allocation.
 */
const INITIALIZATION_KEYS = Object.freeze([
  'canonicalLoginCode',
  'formattedLoginCode',
  'nextStudentNumber',
])

export class ProductionReconciliationError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ProductionReconciliationError'
    this.code = 'PHASE3_PRODUCTION_RECONCILIATION_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new ProductionReconciliationError(category, message, details)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      `${label} must be a plain object.`,
      { argument: label },
    )
  }
  const keys = Reflect.ownKeys(value)
  const unknown = keys.find(key =>
    typeof key !== 'string' || !expectedKeys.includes(key),
  )
  const missing = expectedKeys.find(key => !Object.hasOwn(value, key))
  if (unknown !== undefined || missing !== undefined ||
      keys.length !== expectedKeys.length) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      `${label} must contain exactly its declared fields.`,
      {
        argument: label,
        ...(unknown === undefined ? {} : { unknown: String(unknown) }),
        ...(missing === undefined ? {} : { missing }),
      },
    )
  }
  return value
}

function requireSource(source) {
  const value = requireExactKeys(source, SOURCE_KEYS, 'source')
  if (!Array.isArray(value.studentCredentials) ||
      !Array.isArray(value.studentAuthLogs)) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'Source credential and authentication-log collections must be arrays.',
      { argument: 'source' },
    )
  }
  return value
}

function isExactUpdateTime(value) {
  return typeof value?.toMillis === 'function' &&
    Number.isSafeInteger(value.seconds) && value.seconds >= 0 &&
    Number.isSafeInteger(value.nanoseconds) &&
    value.nanoseconds >= 0 && value.nanoseconds <= 999_999_999
}

function requireEnvelope(value, label, { updateTime = false } = {}) {
  if (!isPlainObject(value) || typeof value.id !== 'string' ||
      value.id.length === 0 || typeof value.path !== 'string' ||
      value.path.length === 0 || !isPlainObject(value.data) ||
      (updateTime && !isExactUpdateTime(value.updateTime))) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      `${label} must be a complete document envelope.`,
      { argument: label },
    )
  }
  return value
}

function requireFoundation(foundation) {
  const value = requireExactKeys(foundation, FOUNDATION_KEYS, 'foundation')
  if (typeof value.teacherUid !== 'string' || value.teacherUid === '' ||
      typeof value.classroomId !== 'string' || value.classroomId === '') {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'Foundation identities must be non-empty strings.',
      { argument: 'foundation' },
    )
  }
  const teacher = requireEnvelope(
    value.teacher,
    'foundation.teacher',
    { updateTime: true },
  )
  const classroom = requireEnvelope(
    value.classroom,
    'foundation.classroom',
    { updateTime: true },
  )
  if (teacher.id !== value.teacherUid ||
      teacher.path !== `teachers/${value.teacherUid}` ||
      classroom.id !== value.classroomId ||
      classroom.path !== `classrooms/${value.classroomId}`) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'Foundation envelope paths do not match their declared identities.',
      { argument: 'foundation' },
    )
  }
  if (teacher.data.uid !== value.teacherUid ||
      teacher.data.classroomId !== value.classroomId ||
      teacher.data.status !== 'active' ||
      classroom.data.ownerUid !== value.teacherUid) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'Foundation documents do not form an active reciprocal identity.',
      { argument: 'foundation' },
    )
  }
  return value
}

function requireActual(actual) {
  const value = requireExactKeys(actual, ACTUAL_KEYS, 'actual')
  for (const field of [
    'flatCredentials',
    'flatAuthLogs',
    'students',
    'transactions',
    'loginHistory',
    'scopedCredentials',
    'scopedAuthLogs',
  ]) {
    if (!Array.isArray(value[field])) {
      fail(
        PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
        `actual.${field} must be an array.`,
        { argument: `actual.${field}` },
      )
    }
  }
  return value
}

function requireProjection(value) {
  if (!isPlainObject(value)) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'projection must be a plain object.',
      { argument: 'projection' },
    )
  }
  return value
}

function validateDryRunOptions(options) {
  const value = requireExactKeys(
    options,
    ['classroomId', 'source', 'projection'],
    'options',
  )
  if (typeof value.classroomId !== 'string' || value.classroomId === '') {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'classroomId must be a non-empty string.',
      { argument: 'classroomId' },
    )
  }
  const source = requireSource(value.source)
  const projection = requireProjection(value.projection)
  return {
    source,
    projection,
    expectedProjection: buildProductionProjection({
      classroomId: value.classroomId,
      ...source,
    }),
  }
}

/**
 * Validates the initialization inputs and their mutual consistency.
 *
 * The formatted and canonical codes must be exactly the two renderings of one
 * code — proven by normalizing the formatted value back and comparing — so a
 * mismatched pair cannot describe a classroom root and an index document that
 * disagree about which code was reserved.
 */
function requireInitialization(initialization) {
  const value = requireExactKeys(
    initialization,
    INITIALIZATION_KEYS,
    'initialization',
  )
  let canonical
  try {
    canonical = normalizeClassroomCode(value.canonicalLoginCode)
  } catch {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'The initialization login code is not a valid classroom code.',
      { argument: 'initialization.canonicalLoginCode' },
    )
  }
  if (value.canonicalLoginCode !== canonical) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'The initialization login code is not already canonical.',
      { argument: 'initialization.canonicalLoginCode' },
    )
  }
  if (value.formattedLoginCode !== formatClassroomCode(canonical)) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'The formatted login code does not correspond to the canonical code.',
      { argument: 'initialization.formattedLoginCode' },
    )
  }
  if (!Number.isSafeInteger(value.nextStudentNumber) ||
      value.nextStudentNumber < 1) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'nextStudentNumber must be a safe positive integer.',
      { argument: 'initialization.nextStudentNumber' },
    )
  }
  return value
}

function validateWriteRunOptions(options) {
  const value = requireExactKeys(
    options,
    ['source', 'foundation', 'projection', 'actual', 'initialization'],
    'options',
  )
  const source = requireSource(value.source)
  const foundation = requireFoundation(value.foundation)
  const projection = requireProjection(value.projection)
  const actual = requireActual(value.actual)
  const initialization = requireInitialization(value.initialization)
  return {
    source,
    foundation,
    projection,
    actual,
    initialization,
    expectedProjection: buildProductionProjection({
      classroomId: foundation.classroomId,
      ...source,
    }),
  }
}

function issue(issues, area, reason, path) {
  issues.push(Object.freeze({
    area,
    reason,
    ...(path === undefined ? {} : { path }),
  }))
}

function compareDocumentBody(expected, actual, area, issues) {
  if (!isPlainObject(actual) || typeof actual.id !== 'string' ||
      typeof actual.path !== 'string' || !isPlainObject(actual.data)) {
    issue(issues, area, 'missing-or-malformed-document', expected.path)
    return
  }
  if (actual.id !== expected.id || actual.path !== expected.path) {
    issue(issues, area, 'identity-or-path-mismatch', expected.path)
  }
  if (!firestoreValuesEqual(actual.data, expected.data)) {
    issue(issues, area, 'document-body-mismatch', expected.path)
  }
}

function compareSourceDocument(expected, actual, area, issues) {
  compareDocumentBody(expected, actual, area, issues)
  if (!isPlainObject(actual) ||
      !firestoreValuesEqual(actual.updateTime, expected.updateTime)) {
    issue(issues, area, 'source-update-time-mismatch', expected.path)
  }
}

function indexCollection(entries, area, issues) {
  const indexed = new Map()
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' ||
        typeof entry.path !== 'string' || !isPlainObject(entry.data)) {
      issue(issues, area, 'malformed-document-envelope')
      continue
    }
    if (indexed.has(entry.path)) {
      issue(issues, area, 'duplicate-document-path', entry.path)
      continue
    }
    indexed.set(entry.path, entry)
  }
  return indexed
}

function compareCollection(
  expectedEntries,
  actualEntries,
  area,
  issues,
  { source = false } = {},
) {
  const actualByPath = indexCollection(actualEntries, area, issues)
  if (actualEntries.length !== expectedEntries.length) {
    issue(issues, area, 'document-count-mismatch')
  }

  const expectedPaths = expectedEntries.map(entry => entry.path).sort()
  const actualPaths = [...actualByPath.keys()].sort()
  if (!firestoreValuesEqual(actualPaths, expectedPaths)) {
    issue(issues, area, 'document-path-set-mismatch')
  }

  for (const expected of expectedEntries) {
    const actual = actualByPath.get(expected.path)
    if (!actual) {
      issue(issues, area, 'missing-document', expected.path)
      continue
    }
    if (source) {
      compareSourceDocument(expected, actual, area, issues)
    } else {
      compareDocumentBody(expected, actual, area, issues)
    }
  }
}

function compareStudents(source, expected, actual, issues) {
  compareCollection(expected, actual, 'students', issues)
  const allowed = [...STUDENT_DESTINATION_FIELDS].sort()
  let actualBalance = 0
  let balancesAreFiniteNumbers = true
  for (const entry of actual) {
    if (!isPlainObject(entry?.data)) continue
    if (!firestoreValuesEqual(Object.keys(entry.data).sort(), allowed)) {
      issue(issues, 'students', 'forbidden-or-unlisted-key', entry.path)
    }
    if (typeof entry.data.balance !== 'number' ||
        !Number.isFinite(entry.data.balance)) {
      balancesAreFiniteNumbers = false
      issue(issues, 'students', 'invalid-balance', entry.path)
      continue
    }
    actualBalance += entry.data.balance
  }
  const sourceBalance = source.classroomData.data.students.reduce(
    (total, student) => total + Number(student.balance || 0),
    0,
  )
  if (!balancesAreFiniteNumbers || !Number.isFinite(sourceBalance) ||
      !Object.is(actualBalance, sourceBalance)) {
    issue(issues, 'students', 'total-balance-mismatch')
  }
}

function compareScopedCredentials(expectedProjection, actual, issues) {
  compareCollection(
    expectedProjection.scopedCredentials,
    actual,
    'scoped-credentials',
    issues,
  )
  const actualByPath = indexCollection(actual, 'uid-mappings', issues)
  for (const expected of expectedProjection.scopedCredentials) {
    const observed = actualByPath.get(expected.path)
    if (!observed) continue
    if (observed.data.authUid !== expected.uidMapping.newAuthUid ||
        observed.data.studentId !== expected.uidMapping.studentId ||
        observed.data.classroomId !== expected.uidMapping.classroomId) {
      issue(issues, 'uid-mappings', 'identity-mapping-mismatch', expected.path)
    }
  }
}

function compareScopedAuthLogs(expected, actual, issues) {
  compareCollection(expected, actual, 'scoped-auth-logs', issues)
  for (const entry of actual) {
    if (isPlainObject(entry?.data) &&
        Object.hasOwn(entry.data, 'classroomId')) {
      issue(
        issues,
        'scoped-auth-logs',
        'destination-retains-classroom-id',
        entry.path,
      )
    }
  }
}

/**
 * The exact classroom body expected after initialization AND copy.
 *
 * Every pre-existing foundation field is PRESERVED; initialization contributes
 * the formatted login code and the student counter, and the copy contributes
 * settings and `lastBackupAt`. Nothing else may change — notably `updatedAt` is
 * not touched, because the default contract is preservation.
 */
function expectedClassroomAfterCopy(foundation, projection, initialization) {
  return {
    ...foundation.classroom.data,
    studentLoginCode: initialization.formattedLoginCode,
    nextStudentNumber: initialization.nextStudentNumber,
    settings: projection.classroom.data.settings,
    lastBackupAt: projection.classroom.data.lastBackupAt,
  }
}

/**
 * The login-code index document the writer reserved. Exactly three fields; the
 * document ID is the canonical code and it must point at this classroom.
 */
function compareLoginCodeIndex(foundation, initialization, actual, issues) {
  const path = `classroomLoginCodes/${initialization.canonicalLoginCode}`
  if (!isPlainObject(actual) || typeof actual.id !== 'string' ||
      typeof actual.path !== 'string' || !isPlainObject(actual.data)) {
    issue(issues, 'login-code-index', 'missing-or-malformed-document', path)
    return
  }
  if (actual.id !== initialization.canonicalLoginCode || actual.path !== path) {
    issue(issues, 'login-code-index', 'identity-or-path-mismatch', path)
  }
  if (actual.data.classroomId !== foundation.classroomId) {
    issue(issues, 'login-code-index', 'classroom-mismatch', path)
  }
  if (actual.data.status !== 'active') {
    issue(issues, 'login-code-index', 'status-mismatch', path)
  }
  // Exactly the reviewed key set: an extra field here is an unreviewed write.
  if (!firestoreValuesEqual(
    Object.keys(actual.data).sort(),
    ['classroomId', 'createdAt', 'status'],
  )) {
    issue(issues, 'login-code-index', 'forbidden-or-unlisted-key', path)
  }
}

function compareWriteRun(state, issues) {
  const {
    source,
    foundation,
    projection,
    expectedProjection,
    actual,
    initialization,
  } = state

  if (projection.classroomId !== foundation.classroomId ||
      projection.classroom?.path !== foundation.classroom.path) {
    issue(issues, 'foundation', 'classroom-identity-mismatch')
  }

  compareSourceDocument(
    foundation.teacher,
    actual.teacher,
    'foundation-teacher',
    issues,
  )
  compareDocumentBody(
    {
      id: foundation.classroom.id,
      path: foundation.classroom.path,
      data: expectedClassroomAfterCopy(
        foundation,
        expectedProjection,
        initialization,
      ),
    },
    actual.classroom,
    'classroom-root',
    issues,
  )
  compareLoginCodeIndex(
    foundation,
    initialization,
    actual.loginCodeIndex,
    issues,
  )
  compareSourceDocument(
    source.classroomData,
    actual.legacyClassroomData,
    'legacy-classroom-source',
    issues,
  )
  compareCollection(
    source.studentCredentials,
    actual.flatCredentials,
    'flat-credentials-source',
    issues,
    { source: true },
  )
  compareCollection(
    source.studentAuthLogs,
    actual.flatAuthLogs,
    'flat-auth-logs-source',
    issues,
    { source: true },
  )
  compareStudents(
    source,
    expectedProjection.students,
    actual.students,
    issues,
  )
  compareCollection(
    expectedProjection.transactions,
    actual.transactions,
    'transactions',
    issues,
  )
  compareCollection(
    expectedProjection.loginHistory,
    actual.loginHistory,
    'login-history',
    issues,
  )
  compareScopedCredentials(
    expectedProjection,
    actual.scopedCredentials,
    issues,
  )
  compareScopedAuthLogs(
    expectedProjection.scopedAuthLogs,
    actual.scopedAuthLogs,
    issues,
  )
}

function summary(mode, projection) {
  const writeRun = mode === PRODUCTION_RECONCILIATION_MODES.WRITE_RUN
  return Object.freeze({
    mode,
    passed: true,
    counts: Object.freeze({ ...projection.counts }),
    equality: Object.freeze({
      projection: true,
      uidMappings: true,
      ...(writeRun
        ? {
          foundation: true,
          classroomMetadata: true,
          loginCodeIndex: true,
          students: true,
          transactions: true,
          loginHistory: true,
          scopedCredentials: true,
          scopedAuthLogs: true,
          legacyClassroomSource: true,
          flatCredentialsSource: true,
          flatAuthLogsSource: true,
        }
        : {}),
    }),
  })
}

function finish(mode, state, issues) {
  if (issues.length > 0) {
    const category = mode === PRODUCTION_RECONCILIATION_MODES.DRY_RUN
      ? PRODUCTION_RECONCILIATION_CATEGORIES.DRY_RUN_MISMATCH
      : PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH
    fail(
      category,
      `${mode} reconciliation found blocking mismatches.`,
      { mode, issues: Object.freeze(issues) },
    )
  }
  return summary(mode, state.expectedProjection)
}

/** Recomputes and verifies a proposed projection before any write is possible. */
export function reconcileProductionDryRun(options) {
  const state = validateDryRunOptions(options)
  const issues = []
  if (!firestoreValuesEqual(state.projection, state.expectedProjection)) {
    issue(issues, 'projection', 'projection-does-not-match-source')
  }
  return finish(PRODUCTION_RECONCILIATION_MODES.DRY_RUN, state, issues)
}

/**
 * Verifies caller-supplied post-copy reads, including exact source update times.
 * The function cannot read or mutate either the source or destination itself.
 */
export function reconcileProductionWriteRun(options) {
  const state = validateWriteRunOptions(options)
  const issues = []
  if (!firestoreValuesEqual(state.projection, state.expectedProjection)) {
    issue(issues, 'projection', 'projection-does-not-match-source')
  }
  compareWriteRun(state, issues)
  return finish(PRODUCTION_RECONCILIATION_MODES.WRITE_RUN, state, issues)
}

/**
 * Reads every source and destination surface through injected READ-ONLY readers
 * and invokes the pure write-run reconciliation above.
 *
 * Deliberately lives in this module rather than in `productionWriter.js`. Both
 * the writer's final verification and `reverify.js` need exactly this behavior,
 * and reverify must never import the writer — so the shared code has to sit in a
 * module that contains no mutation capability at all. This function performs no
 * write of any kind: it only calls reader functions and one pure comparison.
 */
/**
 * Proves the CURRENT source and foundation still match the retained evidence.
 *
 * This is what stops reverify from self-masking. A source edit made after the
 * copy would otherwise change the expected projection and the observed actual
 * together, so the two would continue to agree and reverify would report
 * success over drifted data.
 *
 * Every digest is recomputed with the same derivation preflight used, so this
 * compares current state to the reviewed record — never to itself.
 */
export function assertRetainedSourceEvidence({ retainedEvidence, observed }) {
  if (!isPlainObject(retainedEvidence)) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'Retained evidence must be a plain object.',
    )
  }
  const {
    legacySourceStateSha256,
    foundationBodiesSha256,
    teacherSourceSha256,
    watermarkSha256,
    computeLegacySourceDigest,
    computeFoundationDigest: computeFoundation,
    computeTeacherSourceDigest,
    computeWatermarkDigest,
  } = retainedEvidence

  for (const [name, value] of Object.entries({
    legacySourceStateSha256,
    foundationBodiesSha256,
    teacherSourceSha256,
    watermarkSha256,
  })) {
    if (typeof value !== 'string' || value === '') {
      fail(
        PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
        'Retained evidence is missing a required digest.',
        { field: name },
      )
    }
  }
  if (typeof computeLegacySourceDigest !== 'function' ||
      typeof computeFoundation !== 'function' ||
      typeof computeTeacherSourceDigest !== 'function' ||
      typeof computeWatermarkDigest !== 'function') {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.INVALID_ARGUMENTS,
      'Retained evidence must supply every digest derivation.',
    )
  }

  const observedLegacy = computeLegacySourceDigest({
    legacyClassroomData: observed.legacyClassroomData,
    flatCredentials: observed.flatCredentials,
    flatAuthLogs: observed.flatAuthLogs,
  })
  if (observedLegacy !== legacySourceStateSha256) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      'The legacy source no longer matches the retained preflight evidence.',
    )
  }

  const observedFoundation = computeFoundation({
    teacher: observed.teacher,
    classroom: observed.classroom,
  })
  if (observedFoundation !== foundationBodiesSha256) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      'The foundation no longer matches the retained preflight evidence.',
    )
  }

  if (computeTeacherSourceDigest(observed.teacher) !== teacherSourceSha256) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      'The immutable teacher source no longer matches the retained evidence.',
    )
  }

  if (computeWatermarkDigest(observed) !== watermarkSha256) {
    fail(
      PRODUCTION_RECONCILIATION_CATEGORIES.WRITE_RUN_MISMATCH,
      'The identity watermark no longer matches the retained preflight evidence.',
    )
  }
  return true
}

export async function readAndReconcileWriteRun({
  rawReaders,
  foundation,
  initialization,
  /**
   * RETAINED evidence the current state must be compared against.
   *
   * Without it this function builds the expected projection from the CURRENT
   * source and then uses those same current documents as the actual source, so
   * a post-write source edit appears on both sides and cancels out. Reverify
   * supplies this so the comparison is current-state-vs-retained-evidence rather
   * than current-state-vs-itself.
   */
  retainedEvidence,
}) {
  const classroomId = foundation.classroomId
  const [
    legacyClassroomData, flatCredentials, flatAuthLogs,
    teacher, classroom, loginCodeIndex,
    students, transactions, loginHistory, scopedCredentials, scopedAuthLogs,
  ] = await Promise.all([
    rawReaders.readLegacyClassroomAggregate(),
    rawReaders.readFlatCredentials(),
    rawReaders.readFlatAuthLogs(),
    rawReaders.readTeacher(),
    rawReaders.readClassroom(classroomId),
    rawReaders.readLoginCodeIndexDocument(initialization.canonicalLoginCode),
    rawReaders.readClassroomStudents(classroomId),
    rawReaders.readClassroomTransactions(classroomId),
    rawReaders.readClassroomLoginHistory(classroomId),
    rawReaders.readScopedCredentials(classroomId),
    rawReaders.readScopedAuthLogs(classroomId),
  ])

  // Narrowed to Phase 2B's declared source-envelope contract. The raw readers
  // carry an `exists` marker for the writer's presence checks, which that strict
  // contract would reject as an unlisted key.
  const source = {
    classroomData: toSourceEnvelope(legacyClassroomData),
    studentCredentials: flatCredentials.map(toSourceEnvelope),
    studentAuthLogs: flatAuthLogs.map(toSourceEnvelope),
  }
  const projection = buildProductionProjection({ classroomId, ...source })

  // When retained evidence is supplied, the CURRENT source must first be proven
  // identical to what the run was reviewed against. Only then is a projection
  // derived from it meaningful as an expectation.
  if (retainedEvidence !== undefined) {
    assertRetainedSourceEvidence({
      retainedEvidence,
      observed: {
        legacyClassroomData,
        flatCredentials,
        flatAuthLogs,
        teacher,
        classroom,
        students,
        transactions,
        loginHistory,
        scopedCredentials,
        scopedAuthLogs,
      },
    })
  }

  return reconcileProductionWriteRun({
    source,
    // The foundation compared here is the CURRENT observed teacher plus the
    // exact initialized-after classroom. When retained evidence is supplied the
    // caller's classroom is NOT trusted as its own historical baseline: the
    // observed classroom is used and the retained digest above is what
    // constrains it.
    foundation: {
      teacherUid: foundation.teacherUid,
      classroomId,
      teacher,
      classroom: retainedEvidence === undefined
        ? foundation.classroom
        : classroom,
    },
    projection,
    initialization: {
      canonicalLoginCode: initialization.canonicalLoginCode,
      formattedLoginCode: initialization.formattedLoginCode,
      nextStudentNumber: initialization.nextStudentNumber,
    },
    actual: {
      teacher,
      classroom,
      loginCodeIndex,
      legacyClassroomData,
      flatCredentials: [...flatCredentials],
      flatAuthLogs: [...flatAuthLogs],
      students: [...students],
      transactions: [...transactions],
      loginHistory: [...loginHistory],
      scopedCredentials: [...scopedCredentials],
      scopedAuthLogs: [...scopedAuthLogs],
    },
  })
}
