import { isDeepStrictEqual } from 'node:util'

import {
  STUDENT_DESTINATION_FIELDS,
  buildMigrationProjection,
} from './projection.js'

export const RECONCILIATION_MODES = Object.freeze({
  DRY_RUN: 'dry-run',
  WRITE: 'write',
})

export const RECONCILIATION_ERROR_CATEGORIES = Object.freeze({
  DRY_RUN_MISMATCH: 'dry-run-mismatch',
  INVALID_ARGUMENTS: 'invalid-arguments',
  WRITE_RUN_MISMATCH: 'write-run-mismatch',
})

export const RECONCILIATION_CHECKSUM_FIELDS = Object.freeze([
  'immutableSourceChecksum',
  'foundationInvariantChecksum',
  'planChecksum',
])

const HASH_PATTERN = /^[0-9a-f]{64}$/

export class ReconciliationError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ReconciliationError'
    this.code = 'PHASE2A_RECONCILIATION_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new ReconciliationError(category, message, details)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    fail(
      RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      `${label} must be an object.`,
      { argument: label },
    )
  }

  return value
}

function requireEnvelope(value, label) {
  const envelope = requireRecord(value, label)

  if (typeof envelope.id !== 'string' || envelope.id.length === 0 ||
      typeof envelope.path !== 'string' || envelope.path.length === 0 ||
      !isRecord(envelope.data)) {
    fail(
      RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      `${label} must contain id, path, and map-like data.`,
      { argument: label },
    )
  }

  return envelope
}

function requireFoundation(foundation) {
  const value = requireRecord(foundation, 'foundation')

  if (typeof value.teacherUid !== 'string' ||
      typeof value.classroomId !== 'string') {
    fail(
      RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      'foundation must identify the teacher and classroom.',
      { argument: 'foundation' },
    )
  }

  const teacher = requireEnvelope(value.teacher, 'foundation.teacher')
  const classroom = requireEnvelope(value.classroom, 'foundation.classroom')

  if (teacher.path !== `teachers/${value.teacherUid}` ||
      classroom.path !== `classrooms/${value.classroomId}`) {
    fail(
      RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      'Foundation envelope paths do not match their identities.',
      { argument: 'foundation' },
    )
  }

  return value
}

function requireChecksumBundle(
  value,
  label,
  credentialPaths,
  { strict } = { strict: true },
) {
  const bundle = requireRecord(value, label)

  if (strict) {
    for (const field of RECONCILIATION_CHECKSUM_FIELDS) {
      if (typeof bundle[field] !== 'string' ||
          !HASH_PATTERN.test(bundle[field])) {
        fail(
          RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
          `${label}.${field} must be a lowercase SHA-256 hash.`,
          { argument: `${label}.${field}` },
        )
      }
    }
  }

  const credentialHashes = requireRecord(
    bundle.credentialInvariantHashes,
    `${label}.credentialInvariantHashes`,
  )
  const expectedPaths = [...credentialPaths].sort()
  const actualPaths = Object.keys(credentialHashes).sort()

  if (strict && !isDeepStrictEqual(actualPaths, expectedPaths)) {
    fail(
      RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      `${label} must contain one invariant hash for every credential path.`,
      { argument: `${label}.credentialInvariantHashes` },
    )
  }

  for (const path of strict ? expectedPaths : actualPaths) {
    if (typeof credentialHashes[path] !== 'string' ||
        !HASH_PATTERN.test(credentialHashes[path])) {
      fail(
        RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
        `${label} contains an invalid credential invariant hash.`,
        { argument: `${label}.credentialInvariantHashes`, path },
      )
    }
  }

  return bundle
}

function validateOptions(options, mode) {
  const value = requireRecord(options, 'options')
  const allowedKeys = new Set([
    'source',
    'foundation',
    'projection',
    'expectedChecksums',
    'observedChecksums',
  ])

  if (mode === RECONCILIATION_MODES.WRITE) {
    allowedKeys.add('actual')
  }

  const unknownKey = Reflect.ownKeys(value).find(key =>
    typeof key !== 'string' || !allowedKeys.has(key),
  )

  if (unknownKey !== undefined) {
    fail(
      RECONCILIATION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      `Unknown reconciliation argument: ${String(unknownKey)}.`,
      { argument: String(unknownKey) },
    )
  }

  const source = requireRecord(value.source, 'source')
  const foundation = requireFoundation(value.foundation)
  const expectedProjection = buildMigrationProjection({
    classroomId: foundation.classroomId,
    classroomData: source.classroomData,
    studentCredentials: source.studentCredentials,
    studentAuthLogs: source.studentAuthLogs,
  })
  const projection = requireRecord(value.projection, 'projection')
  const credentialPaths = expectedProjection.studentCredentials
    .map(credential => credential.path)
  const expectedChecksums = requireChecksumBundle(
    value.expectedChecksums,
    'expectedChecksums',
    credentialPaths,
  )
  const observedChecksums = requireChecksumBundle(
    value.observedChecksums,
    'observedChecksums',
    credentialPaths,
    { strict: false },
  )

  return {
    source,
    foundation,
    projection,
    expectedProjection,
    expectedChecksums,
    observedChecksums,
    actual: mode === RECONCILIATION_MODES.WRITE
      ? requireRecord(value.actual, 'actual')
      : null,
  }
}

function issue(issues, area, reason, path) {
  const entry = { area, reason }

  if (path !== undefined) {
    entry.path = path
  }

  issues.push(Object.freeze(entry))
}

function compareChecksums(expected, observed, issues) {
  for (const field of RECONCILIATION_CHECKSUM_FIELDS) {
    if (expected[field] !== observed[field]) {
      issue(issues, 'checksums', `${field}-mismatch`)
    }
  }

  const expectedPaths = Object.keys(expected.credentialInvariantHashes).sort()
  const observedPaths = Object.keys(observed.credentialInvariantHashes).sort()

  if (!isDeepStrictEqual(observedPaths, expectedPaths)) {
    issue(issues, 'checksums', 'credential-invariant-path-set-mismatch')
  }

  for (const path of expectedPaths) {
    if (expected.credentialInvariantHashes[path] !==
        observed.credentialInvariantHashes[path]) {
      issue(issues, 'checksums', 'credential-invariant-hash-mismatch', path)
    }
  }
}

function compareSingleEnvelope(expected, actual, area, issues) {
  if (!isRecord(actual) || typeof actual.id !== 'string' ||
      typeof actual.path !== 'string' || !isRecord(actual.data)) {
    issue(issues, area, 'missing-or-malformed-document', expected.path)
    return
  }

  if (actual.id !== expected.id || actual.path !== expected.path) {
    issue(issues, area, 'identity-or-path-mismatch', expected.path)
  }

  if (!isDeepStrictEqual(actual.data, expected.data)) {
    issue(issues, area, 'document-body-mismatch', expected.path)
  }
}

function collectionMap(entries, area, issues) {
  if (!Array.isArray(entries)) {
    issue(issues, area, 'collection-is-not-an-array')
    return null
  }

  const documents = new Map()

  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' ||
        typeof entry.path !== 'string' || !isRecord(entry.data)) {
      issue(issues, area, 'malformed-document-envelope')
      continue
    }

    if (documents.has(entry.path)) {
      issue(issues, area, 'duplicate-destination-path', entry.path)
      continue
    }

    documents.set(entry.path, entry)
  }

  return documents
}

function compareCollection(expectedEntries, actualEntries, area, issues) {
  const actualByPath = collectionMap(actualEntries, area, issues)

  if (actualByPath === null) {
    return
  }

  if (actualEntries.length !== expectedEntries.length) {
    issue(issues, area, 'destination-count-mismatch')
  }

  const expectedPaths = expectedEntries.map(entry => entry.path).sort()
  const actualPaths = [...actualByPath.keys()].sort()

  if (!isDeepStrictEqual(actualPaths, expectedPaths)) {
    issue(issues, area, 'destination-path-set-mismatch')
  }

  for (const expected of expectedEntries) {
    const actual = actualByPath.get(expected.path)

    if (!actual) {
      issue(issues, area, 'missing-destination-document', expected.path)
      continue
    }

    if (actual.id !== expected.id) {
      issue(issues, area, 'destination-id-mismatch', expected.path)
    }

    if (!isDeepStrictEqual(actual.data, expected.data)) {
      issue(issues, area, 'document-body-mismatch', expected.path)
    }
  }
}

function compareStudentRequirements(source, expectedEntries, actualEntries, issues) {
  compareCollection(expectedEntries, actualEntries, 'students', issues)

  if (!Array.isArray(actualEntries)) {
    return
  }

  const allowedFields = [...STUDENT_DESTINATION_FIELDS].sort()
  let destinationBalance = 0

  for (const entry of actualEntries) {
    if (!isRecord(entry?.data)) {
      continue
    }

    if (!isDeepStrictEqual(Object.keys(entry.data).sort(), allowedFields)) {
      issue(issues, 'students', 'forbidden-or-unlisted-student-key', entry.path)
    }

    destinationBalance += entry.data.balance
  }

  const sourceBalance = source.classroomData.data.students.reduce(
    (total, student) => total + Number(student.balance || 0),
    0,
  )

  if (!Object.is(destinationBalance, sourceBalance)) {
    issue(issues, 'students', 'total-balance-mismatch')
  }
}

function compareAuthLogRequirements(expectedEntries, actualEntries, issues) {
  compareCollection(
    expectedEntries,
    actualEntries,
    'student-auth-logs',
    issues,
  )

  if (!Array.isArray(actualEntries)) {
    return
  }

  for (const entry of actualEntries) {
    if (isRecord(entry?.data) && Object.hasOwn(entry.data, 'classroomId')) {
      issue(
        issues,
        'student-auth-logs',
        'destination-retains-classroom-id',
        entry.path,
      )
    }
  }
}

function expectedClassroomAfter(foundation, projection) {
  return {
    ...foundation.classroom.data,
    settings: projection.classroom.data.settings,
    lastBackupAt: projection.classroom.data.lastBackupAt,
  }
}

function reconcileWriteState(state, issues) {
  const {
    source,
    foundation,
    expectedProjection,
    actual,
  } = state

  compareSingleEnvelope(
    foundation.teacher,
    actual.teacher,
    'foundation-teacher',
    issues,
  )
  compareSingleEnvelope(
    {
      id: foundation.classroom.id,
      path: foundation.classroom.path,
      data: expectedClassroomAfter(foundation, expectedProjection),
    },
    actual.classroom,
    'classroom-root',
    issues,
  )
  compareSingleEnvelope(
    source.classroomData,
    actual.legacyClassroomData,
    'legacy-classroom-source',
    issues,
  )
  compareStudentRequirements(
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
  compareCollection(
    expectedProjection.studentCredentials,
    actual.studentCredentials,
    'student-credentials',
    issues,
  )
  compareAuthLogRequirements(
    expectedProjection.studentAuthLogs,
    actual.studentAuthLogs,
    issues,
  )
  compareCollection(
    source.studentAuthLogs,
    actual.originalStudentAuthLogs,
    'original-student-auth-logs',
    issues,
  )
}

function reconciliationSummary(mode, projection) {
  return Object.freeze({
    mode,
    passed: true,
    counts: Object.freeze({
      students: projection.students.length,
      transactions: projection.transactions.length,
      loginHistory: projection.loginHistory.length,
      studentCredentials: projection.studentCredentials.length,
      studentAuthLogs: projection.studentAuthLogs.length,
      orphanedCredentials: projection.orphanedCredentialPaths.length,
    }),
    equality: Object.freeze({
      foundation: true,
      classroomMetadata: true,
      students: true,
      transactions: true,
      loginHistory: true,
      studentCredentials: true,
      studentAuthLogs: true,
      originalSources: true,
      checksums: true,
    }),
  })
}

function reconcile(options, mode) {
  const state = validateOptions(options, mode)
  const issues = []

  if (!isDeepStrictEqual(state.projection, state.expectedProjection)) {
    issue(issues, 'projection', 'projection-does-not-match-legacy-source')
  }

  if (state.expectedProjection.classroom.path !==
      state.foundation.classroom.path) {
    issue(issues, 'foundation', 'classroom-identity-mismatch')
  }

  compareChecksums(
    state.expectedChecksums,
    state.observedChecksums,
    issues,
  )

  if (mode === RECONCILIATION_MODES.WRITE) {
    reconcileWriteState(state, issues)
  }

  if (issues.length > 0) {
    const category = mode === RECONCILIATION_MODES.DRY_RUN
      ? RECONCILIATION_ERROR_CATEGORIES.DRY_RUN_MISMATCH
      : RECONCILIATION_ERROR_CATEGORIES.WRITE_RUN_MISMATCH

    fail(
      category,
      `${mode} reconciliation found ${issues.length} blocking mismatch(es).`,
      {
        mode,
        issues: Object.freeze(issues),
      },
    )
  }

  return reconciliationSummary(mode, state.expectedProjection)
}

/** Verifies a proposed dry-run projection before any Firestore write. */
export function reconcileDryRun(options) {
  return reconcile(options, RECONCILIATION_MODES.DRY_RUN)
}

/** Verifies caller-supplied post-write Firestore reads without writing. */
export function reconcileWriteRun(options) {
  return reconcile(options, RECONCILIATION_MODES.WRITE)
}
