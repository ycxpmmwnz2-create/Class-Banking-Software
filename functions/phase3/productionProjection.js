import {
  ProjectionError,
  STUDENT_DESTINATION_FIELDS,
  buildMigrationProjection,
} from '../phase2/projection.js'
import {
  ScopedCredentialProjectionError,
  firestoreValuesEqual,
  projectAndReconcileScopedCredentials,
} from '../phase2b/scopedCredentialProjection.js'

/**
 * Phase 3 Commit 4 — pure production copy projection.
 *
 * This module deliberately has no Firebase handle, filesystem access, runner,
 * manifest mutation, or write primitive. It adapts Phase 2A's proven legacy-data
 * projection to Phase 3's scoped destination and replaces Phase 2A's obsolete
 * in-place credential update with Phase 2B's copy-only credential contract.
 */

export const PRODUCTION_PROJECTION_SURFACES = Object.freeze([
  'students',
  'transactions',
  'loginHistory',
  'scopedCredentials',
  'scopedAuthLogs',
])

export const PRODUCTION_PROJECTION_CATEGORIES = Object.freeze({
  COPY_CONTRACT_VIOLATION: 'copy-contract-violation',
  INVALID_ARGUMENTS: 'invalid-arguments',
  LEGACY_PROJECTION_REJECTED: 'legacy-projection-rejected',
  SCOPED_CREDENTIAL_PROJECTION_REJECTED:
    'scoped-credential-projection-rejected',
})

const FLAT_CREDENTIAL_PREFIX = 'studentCredentials/'
const FLAT_AUTH_LOG_PREFIX = 'studentAuthLogs/'

export class ProductionProjectionError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ProductionProjectionError'
    this.code = 'PHASE3_PRODUCTION_PROJECTION_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new ProductionProjectionError(category, message, details)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isExactUpdateTime(value) {
  return typeof value?.toMillis === 'function' &&
    Number.isSafeInteger(value.seconds) && value.seconds >= 0 &&
    Number.isSafeInteger(value.nanoseconds) &&
    value.nanoseconds >= 0 && value.nanoseconds <= 999_999_999
}

function requireOptions(options) {
  if (!isPlainObject(options)) {
    fail(
      PRODUCTION_PROJECTION_CATEGORIES.INVALID_ARGUMENTS,
      'buildProductionProjection requires a plain options object.',
    )
  }

  const allowedKeys = new Set([
    'classroomId',
    'classroomData',
    'studentCredentials',
    'studentAuthLogs',
  ])
  const unknown = Reflect.ownKeys(options).find(key =>
    typeof key !== 'string' || !allowedKeys.has(key),
  )
  if (unknown !== undefined) {
    fail(
      PRODUCTION_PROJECTION_CATEGORIES.INVALID_ARGUMENTS,
      'The production projection received an unsupported argument.',
      { argument: String(unknown) },
    )
  }

  if (!Array.isArray(options.studentCredentials) ||
      !Array.isArray(options.studentAuthLogs)) {
    fail(
      PRODUCTION_PROJECTION_CATEGORIES.INVALID_ARGUMENTS,
      'Credential and authentication-log sources must be arrays.',
    )
  }

  const timestampSources = [
    ['legacyClassroom', options.classroomData],
    ...options.studentCredentials.map((entry, index) => [
      `flatCredentials[${index}]`,
      entry,
    ]),
    ...options.studentAuthLogs.map((entry, index) => [
      `flatAuthLogs[${index}]`,
      entry,
    ]),
  ]
  for (const [surface, entry] of timestampSources) {
    const updateTime = entry?.updateTime
    if (!isExactUpdateTime(updateTime)) {
      fail(
        PRODUCTION_PROJECTION_CATEGORIES.INVALID_ARGUMENTS,
        'Every production source must carry an exact update time.',
        { surface },
      )
    }
  }
  return options
}

function buildLegacyProjection(options) {
  try {
    // Passing no credentials is intentional. Phase 2A updates flat credential
    // bodies in place; Phase 3 must never even represent that as a destination.
    return buildMigrationProjection({
      classroomId: options.classroomId,
      classroomData: options.classroomData,
      studentCredentials: [],
      studentAuthLogs: options.studentAuthLogs,
    })
  } catch (error) {
    if (error instanceof ProjectionError) {
      fail(
        PRODUCTION_PROJECTION_CATEGORIES.LEGACY_PROJECTION_REJECTED,
        'The legacy source cannot be projected safely.',
        { sourceCategory: error.category },
      )
    }
    throw error
  }
}

function buildScopedCredentialProjection(options, rosterStudentIds) {
  try {
    return projectAndReconcileScopedCredentials({
      sources: options.studentCredentials,
      targets: [],
      targetClassroomId: options.classroomId,
      rosterStudentIds,
      strict: true,
    })
  } catch (error) {
    if (error instanceof ScopedCredentialProjectionError ||
        error instanceof TypeError) {
      fail(
        PRODUCTION_PROJECTION_CATEGORIES
          .SCOPED_CREDENTIAL_PROJECTION_REJECTED,
        'A flat credential cannot be copied safely to the scoped destination.',
        { sourceCode: error.code ?? 'invalid-identity' },
      )
    }
    throw error
  }
}

function sortedFrozenEntries(entries) {
  entries.sort((left, right) => {
    if (left.path < right.path) return -1
    if (left.path > right.path) return 1
    return 0
  })
  entries.forEach(entry => {
    if (isPlainObject(entry.data)) Object.freeze(entry.data)
    Object.freeze(entry)
  })
  return Object.freeze(entries)
}

function destinationEntries(entries) {
  return sortedFrozenEntries(entries.map(entry => ({
    id: entry.id,
    path: entry.path,
    data: entry.data,
  })))
}

function sortedKeysExcept(record, excluded) {
  return Object.keys(record)
    .filter(key => !excluded.has(key))
    .sort()
}

function requireCredentialCopyParity(source, destination) {
  const excluded = new Set(['classroomId', 'authUid'])
  const sourceKeys = sortedKeysExcept(source.data, excluded)
  const destinationKeys = sortedKeysExcept(destination.data, excluded)
  if (!firestoreValuesEqual(sourceKeys, destinationKeys)) {
    return false
  }
  return sourceKeys.every(key =>
    firestoreValuesEqual(source.data[key], destination.data[key]),
  )
}

function requireAuthLogCopyParity(source, destination) {
  const sourceKeys = Object.keys(source.data)
    .filter(key => key !== 'classroomId')
    .sort()
  const destinationKeys = Object.keys(destination.data).sort()
  if (!firestoreValuesEqual(sourceKeys, destinationKeys)) return false
  return sourceKeys.every(key =>
    firestoreValuesEqual(source.data[key], destination.data[key]),
  )
}

function assertCopyOnlyBoundary(projection, sources) {
  const destinationPaths = new Set()
  for (const surface of PRODUCTION_PROJECTION_SURFACES) {
    for (const entry of projection[surface]) {
      if (destinationPaths.has(entry.path)) {
        fail(
          PRODUCTION_PROJECTION_CATEGORIES.COPY_CONTRACT_VIOLATION,
          'Two projected documents resolve to the same destination path.',
          { surface },
        )
      }
      destinationPaths.add(entry.path)
      if (entry.path.startsWith(FLAT_CREDENTIAL_PREFIX)) {
        fail(
          PRODUCTION_PROJECTION_CATEGORIES.COPY_CONTRACT_VIOLATION,
          'A production destination must never target a flat credential.',
          { surface },
        )
      }
    }
  }

  const expectedCredentialPrefix =
    `classrooms/${projection.classroomId}/studentCredentials/`
  const credentialsByPath = new Map(
    sources.studentCredentials.map(source => [source.path, source]),
  )
  for (const destination of projection.scopedCredentials) {
    const source = credentialsByPath.get(destination.sourcePath)
    if (!source || destination.sourcePath !== source.path ||
        !firestoreValuesEqual(
          destination.sourceUpdateTime,
          source.updateTime,
        ) ||
        !source.path.startsWith(FLAT_CREDENTIAL_PREFIX) ||
        !destination.path.startsWith(expectedCredentialPrefix) ||
        destination.data.classroomId !== projection.classroomId ||
        destination.data.authUid !== destination.uidMapping.newAuthUid ||
        !requireCredentialCopyParity(source, destination)) {
      fail(
        PRODUCTION_PROJECTION_CATEGORIES.COPY_CONTRACT_VIOLATION,
        'A scoped credential violates the copy-only field contract.',
      )
    }
  }

  const expectedAuthLogPrefix =
    `studentAuthLogs/${projection.classroomId}/logs/`
  const authLogsByPath = new Map(
    sources.studentAuthLogs.map(source => [source.path, source]),
  )
  for (const destination of projection.scopedAuthLogs) {
    const source = authLogsByPath.get(destination.sourcePath)
    if (!source || destination.sourcePath !== source.path ||
        !firestoreValuesEqual(
          destination.sourceUpdateTime,
          source.updateTime,
        ) ||
        !source.path.startsWith(FLAT_AUTH_LOG_PREFIX) ||
        !destination.path.startsWith(expectedAuthLogPrefix) ||
        Object.hasOwn(destination.data, 'classroomId') ||
        !requireAuthLogCopyParity(source, destination)) {
      fail(
        PRODUCTION_PROJECTION_CATEGORIES.COPY_CONTRACT_VIOLATION,
        'A scoped authentication log violates the copy-only field contract.',
      )
    }
  }
}

/**
 * Builds the complete copy-only data projection for the existing classroom.
 *
 * The result contains no operation verbs and no flat credential destination.
 * A later writer may translate these documents into create/update operations,
 * but this module cannot perform or authorize that translation itself.
 */
export function buildProductionProjection(rawOptions) {
  const options = requireOptions(rawOptions)
  const legacy = buildLegacyProjection(options)
  const rosterStudentIds = legacy.students.map(student => student.normalizedId)
  const credentialResult = buildScopedCredentialProjection(
    options,
    rosterStudentIds,
  )
  const students = destinationEntries(legacy.students)
  const transactions = destinationEntries(legacy.transactions)
  const loginHistory = destinationEntries(legacy.loginHistory)
  const classroom = Object.freeze({
    ...legacy.classroom,
    data: Object.freeze(legacy.classroom.data),
  })

  const scopedCredentials = sortedFrozenEntries(
    credentialResult.projections.map(credential => ({
      id: credential.loginId,
      path: credential.targetPath,
      sourcePath: credential.sourcePath,
      sourceUpdateTime: credential.sourceUpdateTime,
      studentId: credential.studentId,
      data: credential.projectedData,
      uidMapping: credential.uidMapping,
      orphaned: credential.isOrphaned,
    })),
  )

  const scopedAuthLogs = sortedFrozenEntries(
    legacy.studentAuthLogs.map(log => {
      const source = options.studentAuthLogs[log.sourceIndex]
      return {
        id: log.id,
        path: log.path,
        sourcePath: log.sourcePath,
        sourceUpdateTime: source.updateTime,
        data: log.data,
      }
    }),
  )

  const projection = Object.freeze({
    classroomId: legacy.classroomId,
    classroom,
    students,
    transactions,
    loginHistory,
    scopedCredentials,
    scopedAuthLogs,
    uidMappings: Object.freeze(
      scopedCredentials.map(credential => credential.uidMapping),
    ),
    orphanedCredentialPaths: Object.freeze(
      scopedCredentials
        .filter(credential => credential.orphaned)
        .map(credential => credential.path)
        .sort(),
    ),
    counts: Object.freeze({
      students: students.length,
      transactions: transactions.length,
      loginHistory: loginHistory.length,
      scopedCredentials: scopedCredentials.length,
      scopedAuthLogs: scopedAuthLogs.length,
      orphanedCredentials: credentialResult.orphanedCredentialPaths.length,
    }),
  })

  assertCopyOnlyBoundary(projection, options)
  return projection
}

export { STUDENT_DESTINATION_FIELDS }
