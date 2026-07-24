import {
  normalizeFirestoreDocumentId,
  validateFirestoreDocumentIds,
} from './firestoreDocumentId.js'

export const LEGACY_CLASSROOM_ID = 'morgan'

export const PROJECTION_ERROR_CATEGORIES = Object.freeze({
  AUTH_LOG_CLASSROOM_ANOMALY: 'auth-log-classroom-anomaly',
  CREDENTIAL_CLASSROOM_ANOMALY: 'credential-classroom-anomaly',
  INVALID_ARGUMENTS: 'invalid-arguments',
  INVALID_CLASSROOM_ID: 'invalid-classroom-id',
  INVALID_DOCUMENT_IDS: 'invalid-document-ids',
  INVALID_SOURCE_DOCUMENT: 'invalid-source-document',
  INVALID_SOURCE_FIELD: 'invalid-source-field',
})

export const STUDENT_DESTINATION_FIELDS = Object.freeze([
  'id',
  'name',
  'balance',
  'frozen',
  'transactions',
])

export class ProjectionError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ProjectionError'
    this.code = 'PHASE2A_PROJECTION_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new ProjectionError(category, message, details)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value, label, details = {}) {
  if (!isRecord(value)) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_DOCUMENT,
      `${label} must be a Firestore map-like object.`,
      details,
    )
  }

  return value
}

function copyRecord(value, label, details = {}) {
  const record = requireRecord(value, label, details)
  const keys = Reflect.ownKeys(record)

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)

    if (typeof key !== 'string' || !descriptor?.enumerable ||
        descriptor.get || descriptor.set) {
      fail(
        PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_DOCUMENT,
        `${label} contains a non-Firestore property.`,
        details,
      )
    }
  }

  return { ...record }
}

function requireCanonicalClassroomId(classroomId) {
  const validation = normalizeFirestoreDocumentId(classroomId)

  if (typeof classroomId !== 'string' || !validation.valid ||
      classroomId === LEGACY_CLASSROOM_ID) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_CLASSROOM_ID,
      'classroomId must be a canonical generated Firestore document ID.',
      {
        classroomId,
        documentIdRejection: validation.rejection,
      },
    )
  }

  return validation.normalizedValue
}

function requireCanonicalExistingId(id, sourceIndex, collectionPath) {
  const validation = normalizeFirestoreDocumentId(id, sourceIndex)

  if (typeof id !== 'string' || !validation.valid) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_DOCUMENT,
      `A ${collectionPath} source envelope has an invalid document ID.`,
      {
        collectionPath,
        sourceIndex,
        documentIdRejection: validation.rejection,
      },
    )
  }

  return validation.normalizedValue
}

function requireSourceEnvelope(envelope, collectionPath, sourceIndex) {
  if (!isRecord(envelope)) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_DOCUMENT,
      `Source ${collectionPath} entry ${sourceIndex} must be an envelope.`,
      { collectionPath, sourceIndex },
    )
  }

  const id = requireCanonicalExistingId(
    envelope.id,
    sourceIndex,
    collectionPath,
  )
  const expectedPath = `${collectionPath}/${id}`

  if (envelope.path !== expectedPath || envelope.updateTime == null) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_DOCUMENT,
      `Source envelope ${expectedPath} is malformed.`,
      { collectionPath, sourceIndex, path: envelope.path },
    )
  }

  requireRecord(envelope.data, `Source document ${expectedPath}`, {
    path: expectedPath,
    sourceIndex,
  })

  return envelope
}

function requireLegacyClassroomEnvelope(classroomData) {
  if (!isRecord(classroomData) || classroomData.id !== 'classroomData' ||
      classroomData.path !== 'morganBank/classroomData' ||
      classroomData.updateTime == null) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_DOCUMENT,
      'The legacy classroom source envelope is missing or malformed.',
      { path: classroomData?.path },
    )
  }

  return requireRecord(
    classroomData.data,
    'Legacy classroom data',
    { path: classroomData.path },
  )
}

function requireArrayField(sourceData, field) {
  if (!Object.hasOwn(sourceData, field) || !Array.isArray(sourceData[field])) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_FIELD,
      `Legacy classroom field ${field} must be an array.`,
      { path: 'morganBank/classroomData', field },
    )
  }

  sourceData[field].forEach((record, sourceIndex) => {
    requireRecord(record, `Legacy ${field} entry ${sourceIndex}`, {
      field,
      sourceIndex,
    })
  })

  return sourceData[field]
}

function validateRecordIds(records, collection) {
  const validation = validateFirestoreDocumentIds(
    records.map(record => record.id),
  )

  if (!validation.valid) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_DOCUMENT_IDS,
      `Legacy ${collection} contains invalid or colliding document IDs.`,
      { collection, rejections: validation.rejections },
    )
  }

  return validation.normalizedValues
}

function freezeEntries(entries) {
  entries.forEach(Object.freeze)
  return Object.freeze(entries)
}

/**
 * Projects only the two fields Phase 2A is allowed to change on the existing
 * classroom root. A missing lastBackupAt is deliberately normalized to null.
 */
export function projectClassroomFields(legacyClassroomData) {
  const source = requireRecord(
    legacyClassroomData,
    'Legacy classroom data',
    { path: 'morganBank/classroomData' },
  )

  if (!Object.hasOwn(source, 'settings') || !isRecord(source.settings)) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_FIELD,
      'Legacy classroom settings must be a map-like object.',
      { path: 'morganBank/classroomData', field: 'settings' },
    )
  }

  return {
    settings: source.settings,
    lastBackupAt: Object.hasOwn(source, 'lastBackupAt')
      ? source.lastBackupAt
      : null,
  }
}

/**
 * Builds the exact five-field student destination body. Transaction objects
 * are retained in their original order and are never field-filtered.
 */
export function projectStudentBody({
  student,
  normalizedStudentId,
  transactions,
}) {
  const sourceStudent = requireRecord(student, 'Legacy student')
  const studentId = requireCanonicalExistingId(
    normalizedStudentId,
    0,
    'students',
  )

  if (!Array.isArray(transactions)) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_SOURCE_FIELD,
      'Legacy transactions must be an array.',
      { field: 'transactions' },
    )
  }

  const matchingTransactions = transactions.filter((transaction, sourceIndex) => {
    requireRecord(transaction, `Legacy transaction ${sourceIndex}`, {
      field: 'transactions',
      sourceIndex,
    })

    return transaction.studentId != null &&
      String(transaction.studentId) === studentId
  })

  return {
    id: sourceStudent.id,
    name: typeof sourceStudent.name === 'string'
      ? sourceStudent.name
      : 'Student',
    balance: Number(sourceStudent.balance || 0),
    frozen: Boolean(sourceStudent.frozen),
    transactions: matchingTransactions,
  }
}

/** Preserves a complete transaction or login-history record. */
export function projectCompleteRecord(record, label = 'Legacy record') {
  return copyRecord(record, label)
}

/** Preserves every credential field while replacing only classroomId. */
export function projectCredentialBody(credential, classroomId, path = null) {
  const generatedClassroomId = requireCanonicalClassroomId(classroomId)
  const source = copyRecord(credential, 'Student credential', { path })

  if (!Object.hasOwn(source, 'classroomId') ||
      source.classroomId !== LEGACY_CLASSROOM_ID) {
    fail(
      PROJECTION_ERROR_CATEGORIES.CREDENTIAL_CLASSROOM_ANOMALY,
      'A brand-new migration requires every credential classroomId to equal morgan.',
      {
        path,
        classroomIdPresent: Object.hasOwn(source, 'classroomId'),
        actualClassroomId: source.classroomId,
      },
    )
  }

  source.classroomId = generatedClassroomId
  return source
}

/** Preserves every authentication-log field except classroomId. */
export function projectStudentAuthLogBody(log, path = null) {
  const source = copyRecord(log, 'Student authentication log', { path })

  if (Object.hasOwn(source, 'classroomId') &&
      source.classroomId !== LEGACY_CLASSROOM_ID) {
    fail(
      PROJECTION_ERROR_CATEGORIES.AUTH_LOG_CLASSROOM_ANOMALY,
      'A student authentication log has an unexpected classroomId.',
      { path, actualClassroomId: source.classroomId },
    )
  }

  delete source.classroomId
  return source
}

function credentialStudentId(credentialData) {
  if (credentialData.studentId == null) {
    return null
  }

  try {
    return String(credentialData.studentId)
  } catch {
    return null
  }
}

function validateBuildOptions(options) {
  if (!isRecord(options)) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      'buildMigrationProjection requires an options object.',
    )
  }

  const allowedKeys = new Set([
    'classroomId',
    'classroomData',
    'studentCredentials',
    'studentAuthLogs',
  ])
  const unknownKey = Reflect.ownKeys(options).find(key =>
    typeof key !== 'string' || !allowedKeys.has(key),
  )

  if (unknownKey !== undefined) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      `Unknown projection argument: ${String(unknownKey)}.`,
      { argument: String(unknownKey) },
    )
  }
}

/**
 * Builds the deterministic, Firestore-free destination projection consumed
 * by later preflight and reconciliation slices. This function never reads or
 * writes Firestore and never mutates a source envelope or document body.
 */
export function buildMigrationProjection(options) {
  validateBuildOptions(options)

  const classroomId = requireCanonicalClassroomId(options.classroomId)
  const sourceData = requireLegacyClassroomEnvelope(options.classroomData)
  const students = requireArrayField(sourceData, 'students')
  const transactions = requireArrayField(sourceData, 'transactions')
  const loginHistory = requireArrayField(sourceData, 'loginHistory')
  const studentCredentials = options.studentCredentials
  const studentAuthLogs = options.studentAuthLogs

  if (!Array.isArray(studentCredentials) || !Array.isArray(studentAuthLogs)) {
    fail(
      PROJECTION_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      'studentCredentials and studentAuthLogs must be source-envelope arrays.',
    )
  }

  const normalizedStudentIds = validateRecordIds(students, 'students')
  const normalizedTransactionIds = validateRecordIds(
    transactions,
    'transactions',
  )
  const normalizedHistoryIds = validateRecordIds(loginHistory, 'loginHistory')
  const projectedStudents = students.map((student, sourceIndex) => {
    const normalizedId = normalizedStudentIds[sourceIndex]

    return {
      sourceIndex,
      id: normalizedId,
      normalizedId,
      path: `classrooms/${classroomId}/students/${normalizedId}`,
      data: projectStudentBody({
        student,
        normalizedStudentId: normalizedId,
        transactions,
      }),
    }
  })
  const projectedTransactions = transactions.map((transaction, sourceIndex) => {
    const normalizedId = normalizedTransactionIds[sourceIndex]

    return {
      sourceIndex,
      id: normalizedId,
      normalizedId,
      path: `classrooms/${classroomId}/transactions/${normalizedId}`,
      data: projectCompleteRecord(transaction, 'Legacy transaction'),
    }
  })
  const projectedLoginHistory = loginHistory.map((history, sourceIndex) => {
    const normalizedId = normalizedHistoryIds[sourceIndex]

    return {
      sourceIndex,
      id: normalizedId,
      normalizedId,
      path: `classrooms/${classroomId}/loginHistory/${normalizedId}`,
      data: projectCompleteRecord(history, 'Legacy login-history entry'),
    }
  })
  const activeStudentIds = new Set(normalizedStudentIds)
  const projectedCredentials = studentCredentials.map((envelope, sourceIndex) => {
    const source = requireSourceEnvelope(
      envelope,
      'studentCredentials',
      sourceIndex,
    )
    const orphaned = !activeStudentIds.has(credentialStudentId(source.data))

    return {
      sourceIndex,
      id: source.id,
      path: source.path,
      data: projectCredentialBody(source.data, classroomId, source.path),
      orphaned,
    }
  })
  const projectedAuthLogs = studentAuthLogs.map((envelope, sourceIndex) => {
    const source = requireSourceEnvelope(
      envelope,
      'studentAuthLogs',
      sourceIndex,
    )

    return {
      sourceIndex,
      id: source.id,
      sourcePath: source.path,
      path: `studentAuthLogs/${classroomId}/logs/${source.id}`,
      data: projectStudentAuthLogBody(source.data, source.path),
    }
  })
  const orphanedCredentialPaths = projectedCredentials
    .filter(credential => credential.orphaned)
    .map(credential => credential.path)
    .sort()

  return Object.freeze({
    classroomId,
    classroom: Object.freeze({
      id: classroomId,
      path: `classrooms/${classroomId}`,
      data: projectClassroomFields(sourceData),
    }),
    students: freezeEntries(projectedStudents),
    transactions: freezeEntries(projectedTransactions),
    loginHistory: freezeEntries(projectedLoginHistory),
    studentCredentials: freezeEntries(projectedCredentials),
    studentAuthLogs: freezeEntries(projectedAuthLogs),
    orphanedCredentialPaths: Object.freeze(orphanedCredentialPaths),
  })
}
