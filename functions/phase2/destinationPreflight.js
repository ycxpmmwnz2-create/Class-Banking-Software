import {
  encodeCanonicalFirestoreValue,
  hashCanonicalState,
  serializeCanonicalState,
} from './canonicalState.js'
import { normalizeFirestoreDocumentId } from './firestoreDocumentId.js'
import { LEGACY_CLASSROOM_ID } from './projection.js'

const FIRESTORE_VALUE_TAG = '$phase2aFirestoreValue'

export const DESTINATION_PREFLIGHT_ERROR_CATEGORIES = Object.freeze({
  DIVERGENT_DESTINATIONS: 'divergent-destinations',
  DUPLICATE_DESTINATION: 'duplicate-destination',
  INVALID_ARGUMENTS: 'invalid-arguments',
  INVALID_FIRESTORE: 'invalid-firestore',
  INVALID_FOUNDATION: 'invalid-foundation',
  INVALID_PROJECTION: 'invalid-projection',
  INVALID_SNAPSHOT: 'invalid-snapshot',
})

export const DESTINATION_OPERATION_TYPES = Object.freeze({
  CLASSROOM_FIELD_UPDATE: 'classroom-field-update',
  CREATE: 'create',
  CREDENTIAL_CLASSROOM_UPDATE: 'credential-classroom-update',
})

export const DESTINATION_OPERATION_STATES = Object.freeze({
  PLANNED: 'planned',
  SKIPPED_IDENTICAL: 'skipped_identical',
})

export class DestinationPreflightError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'DestinationPreflightError'
    this.code = 'PHASE2A_DESTINATION_PREFLIGHT_ERROR'
    this.category = category
    this.blocking = true
    this.details = freezeDetails(details)
  }
}

function freezeDetails(details) {
  for (const value of Object.values(details)) {
    if (Array.isArray(value)) {
      value.forEach(entry => {
        if (entry !== null && typeof entry === 'object') {
          Object.freeze(entry)
        }
      })
      Object.freeze(value)
    }
  }

  return Object.freeze({ ...details })
}

function fail(category, message, details) {
  throw new DestinationPreflightError(category, message, details)
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requirePlainRecord(value, label, category) {
  if (!isPlainRecord(value)) {
    fail(category, `${label} is malformed.`)
  }

  const keys = Reflect.ownKeys(value)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (typeof key !== 'string' || !descriptor?.enumerable ||
        descriptor.get || descriptor.set) {
      fail(category, `${label} is malformed.`)
    }
  }

  return value
}

function requireExactKeys(value, expectedKeys, label, category) {
  requirePlainRecord(value, label, category)
  const keys = Reflect.ownKeys(value)

  if (keys.length !== expectedKeys.length ||
      expectedKeys.some(key => !keys.includes(key))) {
    fail(category, `${label} has an unexpected shape.`)
  }

  return value
}

function requireDenseArray(value, label, category) {
  if (!Array.isArray(value)) {
    fail(category, `${label} must be an array.`)
  }

  const expectedKeys = new Set(['length'])
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      fail(category, `${label} is malformed.`)
    }
    expectedKeys.add(key)
  }

  if (Reflect.ownKeys(value).some(key => !expectedKeys.has(key))) {
    fail(category, `${label} is malformed.`)
  }

  return value
}

function requireDocumentId(value, label, category) {
  const validation = normalizeFirestoreDocumentId(value)

  if (typeof value !== 'string' || !validation.valid) {
    fail(category, `${label} is not a canonical Firestore document ID.`)
  }

  return validation.normalizedValue
}

function requireSourceIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_PROJECTION,
      `${label} has an invalid source index.`,
    )
  }
}

function requireFirestoreMap(value, label, category) {
  requirePlainRecord(value, label, category)

  try {
    return encodeCanonicalFirestoreValue(value)
  } catch {
    fail(category, `${label} is not a supported Firestore map.`)
  }
}

function encodedTimestamp(value, label, category) {
  let encoded

  try {
    encoded = encodeCanonicalFirestoreValue(value)
  } catch {
    fail(category, `${label} is not an exact Firestore Timestamp.`)
  }

  if (encoded?.[FIRESTORE_VALUE_TAG]?.type !== 'timestamp') {
    fail(category, `${label} is not an exact Firestore Timestamp.`)
  }

  return encoded
}

function canonicalEncoded(encoded) {
  return serializeCanonicalState(encoded)
}

function hashEncoded(encoded) {
  return hashCanonicalState(encoded)
}

function encodeProjectionMap(
  value,
  label,
  path,
  {
    credential = false,
    category = DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_PROJECTION,
  } = {},
) {
  try {
    return requireFirestoreMap(value, label, category)
  } catch (error) {
    if (error instanceof DestinationPreflightError) {
      fail(
        category,
        credential
          ? 'A projected credential is malformed.'
          : `${label} is malformed.`,
        path === undefined ? {} : { path },
      )
    }
    throw error
  }
}

function encodeInputValue(value, label, category) {
  try {
    return encodeCanonicalFirestoreValue(value)
  } catch {
    fail(category, `${label} is not a supported Firestore value.`)
  }
}

function copyFieldsExcept(record, excludedKey) {
  const result = {}

  for (const key of Reflect.ownKeys(record)) {
    if (key === excludedKey) {
      continue
    }

    Object.defineProperty(result, key, {
      value: Object.getOwnPropertyDescriptor(record, key).value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }

  return result
}

function withClassroomId(invariantBody, classroomId) {
  const result = copyFieldsExcept(invariantBody, 'classroomId')
  Object.defineProperty(result, 'classroomId', {
    value: classroomId,
    enumerable: true,
    writable: true,
    configurable: true,
  })
  return result
}

function classroomFields(data) {
  const fields = {}

  if (Object.hasOwn(data, 'settings')) {
    fields.settings = data.settings
  }
  if (Object.hasOwn(data, 'lastBackupAt')) {
    fields.lastBackupAt = data.lastBackupAt
  }

  return fields
}

function validateFoundation(foundation, classroomId) {
  const category = DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_FOUNDATION
  requireExactKeys(
    foundation,
    ['teacherUid', 'classroomId', 'teacher', 'classroom'],
    'foundation',
    category,
  )
  const teacherUid = requireDocumentId(
    foundation.teacherUid,
    'foundation.teacherUid',
    category,
  )

  if (foundation.classroomId !== classroomId ||
      foundation.classroomId === LEGACY_CLASSROOM_ID) {
    fail(category, 'foundation.classroomId does not match the projection.')
  }

  requireExactKeys(
    foundation.teacher,
    ['id', 'path', 'data', 'updateTime'],
    'foundation.teacher',
    category,
  )
  requireExactKeys(
    foundation.classroom,
    ['id', 'path', 'data', 'updateTime'],
    'foundation.classroom',
    category,
  )

  if (foundation.teacher.id !== teacherUid ||
      foundation.teacher.path !== `teachers/${teacherUid}` ||
      foundation.classroom.id !== classroomId ||
      foundation.classroom.path !== `classrooms/${classroomId}`) {
    fail(category, 'foundation snapshot identity is inconsistent.')
  }

  const teacherData = requirePlainRecord(
    foundation.teacher.data,
    'foundation.teacher.data',
    category,
  )
  const classroomData = requirePlainRecord(
    foundation.classroom.data,
    'foundation.classroom.data',
    category,
  )

  if (teacherData.uid !== teacherUid ||
      teacherData.classroomId !== classroomId ||
      !Object.hasOwn(classroomData, 'settings')) {
    fail(category, 'foundation snapshot data is inconsistent.')
  }

  encodedTimestamp(
    foundation.teacher.updateTime,
    'foundation.teacher.updateTime',
    category,
  )
  encodedTimestamp(
    foundation.classroom.updateTime,
    'foundation.classroom.updateTime',
    category,
  )
  const beforeFields = classroomFields(classroomData)
  const beforeEncoded = encodeProjectionMap(
    beforeFields,
    'foundation classroom migration fields',
    undefined,
    { category },
  )

  if (!Object.hasOwn(beforeFields, 'settings')) {
    fail(category, 'foundation classroom settings are missing.')
  }

  return {
    beforeEncoded,
    rollbackPreimage: {
      settings: encodeProjectionMap(
        classroomData.settings,
        'foundation classroom settings',
        undefined,
        { category },
      ),
      lastBackupAt: {
        present: Object.hasOwn(classroomData, 'lastBackupAt'),
        value: Object.hasOwn(classroomData, 'lastBackupAt')
          ? encodeInputValue(
            classroomData.lastBackupAt,
            'foundation classroom lastBackupAt',
            category,
          )
          : null,
      },
    },
  }
}

function validateProjectionEntry(entry, expectedKeys, label) {
  const category = DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_PROJECTION
  requireExactKeys(entry, expectedKeys, label, category)
  requireSourceIndex(entry.sourceIndex, label)
  requireDocumentId(entry.id, `${label}.id`, category)
  requirePlainRecord(entry.data, `${label}.data`, category)
  return entry
}

function validateCreateEntries(projection, classroomId, candidates) {
  const category = DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_PROJECTION
  const specifications = [
    {
      key: 'students',
      collection: 'students',
      expectedKeys: ['sourceIndex', 'id', 'normalizedId', 'path', 'data'],
      validateData(entry, label) {
        requireExactKeys(
          entry.data,
          ['id', 'name', 'balance', 'frozen', 'transactions'],
          `${label}.data`,
          category,
        )
      },
    },
    {
      key: 'transactions',
      collection: 'transactions',
      expectedKeys: ['sourceIndex', 'id', 'normalizedId', 'path', 'data'],
    },
    {
      key: 'loginHistory',
      collection: 'loginHistory',
      expectedKeys: ['sourceIndex', 'id', 'normalizedId', 'path', 'data'],
    },
  ]

  for (const specification of specifications) {
    const entries = requireDenseArray(
      projection[specification.key],
      `projection.${specification.key}`,
      category,
    )

    entries.forEach((entry, index) => {
      const label = `projection.${specification.key}[${index}]`
      validateProjectionEntry(
        entry,
        specification.expectedKeys,
        label,
      )
      const normalizedId = requireDocumentId(
        entry.normalizedId,
        `${label}.normalizedId`,
        category,
      )
      const bodyId = normalizeFirestoreDocumentId(entry.data.id)
      const expectedPath = `classrooms/${classroomId}/${specification.collection}/${normalizedId}`

      if (entry.id !== normalizedId || entry.path !== expectedPath ||
          !bodyId.valid || bodyId.normalizedValue !== normalizedId) {
        fail(category, `${label} identity is inconsistent.`)
      }

      specification.validateData?.(entry, label)
      const expectedEncoded = encodeProjectionMap(
        entry.data,
        `${label}.data`,
        entry.path,
      )
      candidates.push({
        kind: 'create',
        type: DESTINATION_OPERATION_TYPES.CREATE,
        path: entry.path,
        expectedEncoded,
      })
    })
  }
}

function validateAuthLogEntries(projection, classroomId, candidates) {
  const category = DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_PROJECTION
  const entries = requireDenseArray(
    projection.studentAuthLogs,
    'projection.studentAuthLogs',
    category,
  )

  entries.forEach((entry, index) => {
    const label = `projection.studentAuthLogs[${index}]`
    validateProjectionEntry(
      entry,
      ['sourceIndex', 'id', 'sourcePath', 'path', 'data'],
      label,
    )
    const id = requireDocumentId(entry.id, `${label}.id`, category)

    if (entry.sourcePath !== `studentAuthLogs/${id}` ||
        entry.path !== `studentAuthLogs/${classroomId}/logs/${id}` ||
        Object.hasOwn(entry.data, 'classroomId')) {
      fail(category, `${label} is inconsistent.`)
    }

    candidates.push({
      kind: 'create',
      type: DESTINATION_OPERATION_TYPES.CREATE,
      path: entry.path,
      expectedEncoded: encodeProjectionMap(
        entry.data,
        `${label}.data`,
        entry.path,
      ),
    })
  })
}

function validateCredentialEntries(projection, classroomId, candidates) {
  const category = DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_PROJECTION
  const entries = requireDenseArray(
    projection.studentCredentials,
    'projection.studentCredentials',
    category,
  )
  const orphanedPaths = []

  entries.forEach((entry, index) => {
    const label = `projection.studentCredentials[${index}]`
    validateProjectionEntry(
      entry,
      ['sourceIndex', 'id', 'path', 'data', 'orphaned'],
      label,
    )
    const id = requireDocumentId(entry.id, `${label}.id`, category)

    if (entry.path !== `studentCredentials/${id}` ||
        typeof entry.orphaned !== 'boolean' ||
        !Object.hasOwn(entry.data, 'classroomId') ||
        entry.data.classroomId !== classroomId) {
      fail(category, 'A projected credential is malformed.', {
        path: entry.path,
      })
    }

    const invariantBody = copyFieldsExcept(entry.data, 'classroomId')
    const invariantEncoded = encodeProjectionMap(
      invariantBody,
      'projected credential invariant',
      entry.path,
      { credential: true },
    )
    const beforeEncoded = encodeProjectionMap(
      withClassroomId(invariantBody, LEGACY_CLASSROOM_ID),
      'projected credential before-state',
      entry.path,
      { credential: true },
    )
    const afterEncoded = encodeProjectionMap(
      withClassroomId(invariantBody, classroomId),
      'projected credential after-state',
      entry.path,
      { credential: true },
    )

    candidates.push({
      kind: 'credential',
      type: DESTINATION_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE,
      path: entry.path,
      invariantCanonical: canonicalEncoded(invariantEncoded),
      invariantHash: hashEncoded(invariantEncoded),
      beforeEncoded,
      afterEncoded,
    })

    if (entry.orphaned) {
      orphanedPaths.push(entry.path)
    }
  })

  return orphanedPaths.sort(compareStrings)
}

function validateProjection(projection) {
  const category = DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_PROJECTION
  requireExactKeys(
    projection,
    [
      'classroomId',
      'classroom',
      'students',
      'transactions',
      'loginHistory',
      'studentCredentials',
      'studentAuthLogs',
      'orphanedCredentialPaths',
    ],
    'projection',
    category,
  )
  const classroomId = requireDocumentId(
    projection.classroomId,
    'projection.classroomId',
    category,
  )

  if (classroomId === LEGACY_CLASSROOM_ID) {
    fail(category, 'projection.classroomId cannot be the legacy classroom ID.')
  }

  requireExactKeys(
    projection.classroom,
    ['id', 'path', 'data'],
    'projection.classroom',
    category,
  )
  requireExactKeys(
    projection.classroom.data,
    ['settings', 'lastBackupAt'],
    'projection.classroom.data',
    category,
  )

  if (projection.classroom.id !== classroomId ||
      projection.classroom.path !== `classrooms/${classroomId}`) {
    fail(category, 'projection.classroom identity is inconsistent.')
  }

  const classroomAfterEncoded = encodeProjectionMap(
    projection.classroom.data,
    'projection.classroom.data',
    projection.classroom.path,
  )
  const candidates = [{
    kind: 'classroom',
    type: DESTINATION_OPERATION_TYPES.CLASSROOM_FIELD_UPDATE,
    path: projection.classroom.path,
    afterEncoded: classroomAfterEncoded,
  }]

  validateCreateEntries(projection, classroomId, candidates)
  validateAuthLogEntries(projection, classroomId, candidates)
  const orphanedCredentialPaths = validateCredentialEntries(
    projection,
    classroomId,
    candidates,
  )
  const reportedOrphans = requireDenseArray(
    projection.orphanedCredentialPaths,
    'projection.orphanedCredentialPaths',
    category,
  )

  reportedOrphans.forEach((path, index) => {
    if (typeof path !== 'string') {
      fail(category, `projection.orphanedCredentialPaths[${index}] is invalid.`)
    }
  })

  if (serializeCanonicalState(reportedOrphans) !==
      serializeCanonicalState(orphanedCredentialPaths)) {
    fail(category, 'projection orphaned credential reporting is inconsistent.')
  }

  candidates.sort((left, right) => {
    const pathOrder = compareStrings(left.path, right.path)
    return pathOrder === 0 ? compareStrings(left.type, right.type) : pathOrder
  })

  const seenPaths = new Set()
  for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) {
      fail(
        DESTINATION_PREFLIGHT_ERROR_CATEGORIES.DUPLICATE_DESTINATION,
        'The projection contains a duplicate destination path.',
        { path: candidate.path },
      )
    }
    seenPaths.add(candidate.path)
  }

  return { classroomId, candidates, orphanedCredentialPaths }
}

function compareStrings(left, right) {
  if (left < right) {
    return -1
  }
  return left > right ? 1 : 0
}

function validateOptions(options) {
  const category = DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_ARGUMENTS
  requireExactKeys(
    options,
    ['firestore', 'foundation', 'projection'],
    'destination preflight options',
    category,
  )

  const { firestore } = options
  if (firestore === null ||
      (typeof firestore !== 'object' && typeof firestore !== 'function') ||
      typeof firestore.doc !== 'function') {
    fail(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_FIRESTORE,
      'firestore must provide read-capable doc() references.',
    )
  }

  return options
}

async function readDestination(firestore, path) {
  const reference = firestore.doc(path)

  if (reference === null ||
      (typeof reference !== 'object' && typeof reference !== 'function') ||
      reference.path !== path || typeof reference.get !== 'function') {
    fail(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_FIRESTORE,
      'firestore.doc() returned an invalid read reference.',
      { path },
    )
  }

  // Read errors deliberately propagate unchanged so callers retain the SDK's
  // original retryability/status information.
  const snapshot = await reference.get()
  const expectedId = path.slice(path.lastIndexOf('/') + 1)

  if (snapshot === null || typeof snapshot !== 'object' ||
      typeof snapshot.exists !== 'boolean' ||
      snapshot.id !== expectedId || snapshot.ref?.path !== path ||
      typeof snapshot.data !== 'function') {
    fail(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_SNAPSHOT,
      'Firestore returned a malformed destination snapshot.',
      { path },
    )
  }

  if (!snapshot.exists) {
    return { exists: false, path }
  }

  const data = snapshot.data()
  let encodedData

  try {
    encodedData = requireFirestoreMap(
      data,
      'destination snapshot data',
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_SNAPSHOT,
    )
  } catch (error) {
    if (error instanceof DestinationPreflightError) {
      fail(
        DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_SNAPSHOT,
        'Firestore returned malformed destination document data.',
        { path },
      )
    }
    throw error
  }

  return {
    exists: true,
    path,
    data,
    encodedData,
    updateTimePrecondition: encodedTimestamp(
      snapshot.updateTime,
      'destination snapshot updateTime',
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.INVALID_SNAPSHOT,
    ),
  }
}

function operationIdentity(type, path) {
  return `operation-${hashCanonicalState({ type, path })}`
}

function baseOperation(candidate, expectedBeforeHash, expectedAfterHash) {
  return {
    operationId: operationIdentity(candidate.type, candidate.path),
    type: candidate.type,
    path: candidate.path,
    expectedBeforeHash,
    expectedAfterHash,
  }
}

function classifyCreate(candidate, snapshot) {
  const expectedAfterHash = hashEncoded(candidate.expectedEncoded)
  let state
  let conflict

  if (!snapshot.exists) {
    state = DESTINATION_OPERATION_STATES.PLANNED
  } else if (canonicalEncoded(snapshot.encodedData) ===
      canonicalEncoded(candidate.expectedEncoded)) {
    state = DESTINATION_OPERATION_STATES.SKIPPED_IDENTICAL
  } else {
    conflict = 'existing-create-body-differs'
  }

  return {
    conflict,
    operation: {
      ...baseOperation(candidate, 'absent', expectedAfterHash),
      rollbackPreimage: null,
      updateTimePrecondition: null,
      state,
    },
  }
}

function classifyClassroom(candidate, snapshot, foundationState) {
  const expectedBeforeHash = hashEncoded(foundationState.beforeEncoded)
  const expectedAfterHash = hashEncoded(candidate.afterEncoded)

  if (!snapshot.exists) {
    return {
      conflict: 'classroom-missing',
      operation: null,
    }
  }

  let currentEncoded
  try {
    currentEncoded = encodeCanonicalFirestoreValue(
      classroomFields(snapshot.data),
    )
  } catch {
    return {
      conflict: 'classroom-fields-divergent',
      operation: null,
    }
  }

  const currentCanonical = canonicalEncoded(currentEncoded)
  let state
  let conflict

  if (currentCanonical === canonicalEncoded(foundationState.beforeEncoded)) {
    state = DESTINATION_OPERATION_STATES.PLANNED
  } else if (currentCanonical === canonicalEncoded(candidate.afterEncoded)) {
    state = DESTINATION_OPERATION_STATES.SKIPPED_IDENTICAL
  } else {
    conflict = 'classroom-fields-divergent'
  }

  return {
    conflict,
    operation: {
      ...baseOperation(candidate, expectedBeforeHash, expectedAfterHash),
      rollbackPreimage: foundationState.rollbackPreimage,
      updateTimePrecondition: snapshot.updateTimePrecondition,
      state,
    },
  }
}

function classifyCredential(candidate, snapshot, classroomId) {
  if (!snapshot.exists) {
    return { conflict: 'credential-missing', operation: null }
  }

  const data = snapshot.data
  const currentClassroomId = Object.hasOwn(data, 'classroomId')
    ? data.classroomId
    : undefined

  if (currentClassroomId !== LEGACY_CLASSROOM_ID &&
      currentClassroomId !== classroomId) {
    return { conflict: 'credential-classroom-id-unexpected', operation: null }
  }

  let currentInvariant
  try {
    currentInvariant = canonicalEncoded(
      encodeCanonicalFirestoreValue(copyFieldsExcept(data, 'classroomId')),
    )
  } catch {
    return { conflict: 'credential-invariant-changed', operation: null }
  }

  if (currentInvariant !== candidate.invariantCanonical) {
    return { conflict: 'credential-invariant-changed', operation: null }
  }

  const state = currentClassroomId === LEGACY_CLASSROOM_ID
    ? DESTINATION_OPERATION_STATES.PLANNED
    : DESTINATION_OPERATION_STATES.SKIPPED_IDENTICAL

  return {
    operation: {
      ...baseOperation(
        candidate,
        hashEncoded(candidate.beforeEncoded),
        hashEncoded(candidate.afterEncoded),
      ),
      rollbackPreimage: {
        path: candidate.path,
        oldClassroomId: LEGACY_CLASSROOM_ID,
        newClassroomId: classroomId,
        invariantHash: candidate.invariantHash,
      },
      updateTimePrecondition: snapshot.updateTimePrecondition,
      state,
    },
  }
}

function classifyCandidate(candidate, snapshot, classroomId, foundationState) {
  if (candidate.kind === 'create') {
    return classifyCreate(candidate, snapshot)
  }
  if (candidate.kind === 'classroom') {
    return classifyClassroom(candidate, snapshot, foundationState)
  }
  return classifyCredential(candidate, snapshot, classroomId)
}

function attachDeterministicBatches(operations) {
  const batches = []
  const batchedOperations = operations.map((operation, index) => {
    // Item 7 owns payload estimation and packing. One operation per batch is
    // the conservative Item 6 association: deterministic, manifest-valid,
    // and incapable of crossing the later 400-operation ceiling.
    const batchId = `batch-${String(index + 1).padStart(6, '0')}`
    batches.push({ batchId, operationIds: [operation.operationId] })
    return { ...operation, batchId }
  })

  return { batches, operations: batchedOperations }
}

function planChecksum(operations) {
  return hashCanonicalState(operations.map(operation => ({
    type: operation.type,
    path: operation.path,
    expectedBeforeHash: operation.expectedBeforeHash,
    expectedAfterHash: operation.expectedAfterHash,
  })))
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }

  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Object.getOwnPropertyDescriptor(value, key).value)
  }
  return Object.freeze(value)
}

/**
 * Reads and classifies every projected Phase 2A destination. This function
 * has no Firestore mutation surface; the injected database is used only for
 * individual document reads.
 */
export async function buildDestinationPreflight(options) {
  const { firestore, foundation, projection } = validateOptions(options)
  const {
    classroomId,
    candidates,
    orphanedCredentialPaths,
  } = validateProjection(projection)
  const foundationState = validateFoundation(foundation, classroomId)
  const snapshots = await Promise.all(candidates.map(candidate =>
    readDestination(firestore, candidate.path)))
  const operations = []
  const conflicts = []

  candidates.forEach((candidate, index) => {
    const classification = classifyCandidate(
      candidate,
      snapshots[index],
      classroomId,
      foundationState,
    )

    if (classification.conflict) {
      conflicts.push({
        type: candidate.type,
        path: candidate.path,
        reason: classification.conflict,
      })
    } else {
      operations.push(classification.operation)
    }
  })

  if (conflicts.length > 0) {
    fail(
      DESTINATION_PREFLIGHT_ERROR_CATEGORIES.DIVERGENT_DESTINATIONS,
      `Destination preflight found ${conflicts.length} blocking divergent destination${conflicts.length === 1 ? '' : 's'}.`,
      {
        destinationCount: candidates.length,
        classifiedDestinationCount: candidates.length,
        conflicts,
      },
    )
  }

  const associated = attachDeterministicBatches(operations)
  const result = {
    classroomId,
    planChecksum: planChecksum(associated.operations),
    batches: associated.batches,
    operations: associated.operations,
    orphanedCredentialPaths: [...orphanedCredentialPaths],
  }

  return deepFreeze(result)
}
