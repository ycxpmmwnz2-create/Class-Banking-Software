import {
  STUDENT_DESTINATION_FIELDS,
  buildProductionProjection,
} from './productionProjection.js'
import { firestoreValuesEqual } from '../phase2b/scopedCredentialProjection.js'

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
  return Number.isSafeInteger(value?.seconds) &&
    Number.isInteger(value?.nanoseconds) &&
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

function validateWriteRunOptions(options) {
  const value = requireExactKeys(
    options,
    ['source', 'foundation', 'projection', 'actual'],
    'options',
  )
  const source = requireSource(value.source)
  const foundation = requireFoundation(value.foundation)
  const projection = requireProjection(value.projection)
  const actual = requireActual(value.actual)
  return {
    source,
    foundation,
    projection,
    actual,
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
  for (const entry of actual) {
    if (!isPlainObject(entry?.data)) continue
    if (!firestoreValuesEqual(Object.keys(entry.data).sort(), allowed)) {
      issue(issues, 'students', 'forbidden-or-unlisted-key', entry.path)
    }
    actualBalance += entry.data.balance
  }
  const sourceBalance = source.classroomData.data.students.reduce(
    (total, student) => total + Number(student.balance || 0),
    0,
  )
  if (!Object.is(actualBalance, sourceBalance)) {
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

function expectedClassroomAfterCopy(foundation, projection) {
  return {
    ...foundation.classroom.data,
    settings: projection.classroom.data.settings,
    lastBackupAt: projection.classroom.data.lastBackupAt,
  }
}

function compareWriteRun(state, issues) {
  const {
    source,
    foundation,
    expectedProjection,
    actual,
  } = state

  if (expectedProjection.classroomId !== foundation.classroomId ||
      expectedProjection.classroom.path !== foundation.classroom.path) {
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
      data: expectedClassroomAfterCopy(foundation, expectedProjection),
    },
    actual.classroom,
    'classroom-root',
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
