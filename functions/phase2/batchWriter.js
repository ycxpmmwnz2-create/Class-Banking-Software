import { Buffer } from 'node:buffer'

import { Timestamp } from 'firebase-admin/firestore'

import {
  decodeCanonicalFirestoreValue,
  encodeCanonicalFirestoreValue,
  hashCanonicalState,
  serializeCanonicalState,
} from './canonicalState.js'
import {
  MANIFEST_BATCH_STATES,
  MANIFEST_OPERATION_STATES,
  MANIFEST_OPERATION_TYPES,
  MANIFEST_RUN_STATES,
  MANIFEST_TRANSITIONS,
  transitionManifest,
  validateManifest,
  writeCanonicalManifest,
} from './manifest.js'

export const MAX_BATCH_OPERATIONS = 400
export const MAX_BATCH_PAYLOAD_BYTES = 8 * 1024 * 1024
// Canonical body/path/mask/precondition bytes are counted separately. This
// additional 1 KiB per write conservatively covers protobuf/gRPC framing and
// other Firestore wire-format overhead that is not present in those values.
export const ESTIMATED_WRITE_OVERHEAD_BYTES = 1024

export const BATCH_WRITER_ERROR_CATEGORIES = Object.freeze({
  BATCH_BUILD_FAILED: 'batch-build-failed',
  BATCH_TOO_LARGE: 'batch-too-large',
  BATCH_TOO_MANY_OPERATIONS: 'batch-too-many-operations',
  COMMIT_INDETERMINATE: 'commit-indeterminate',
  COMMIT_REJECTED: 'commit-rejected',
  DELETE_PROHIBITED: 'delete-prohibited',
  INVALID_ARGUMENTS: 'invalid-arguments',
  INVALID_FIRESTORE: 'invalid-firestore',
  INVALID_LIFECYCLE: 'invalid-lifecycle',
  INVALID_OPERATION: 'invalid-operation',
  INVALID_PROJECTION: 'invalid-projection',
  MANIFEST_PERSISTENCE_FAILED: 'manifest-persistence-failed',
  MANIFEST_PERSISTENCE_INDETERMINATE:
    'manifest-persistence-indeterminate',
  OPERATION_TOO_LARGE: 'operation-too-large',
  VERIFICATION_INDETERMINATE: 'verification-indeterminate',
})

const CLEAR_COMMIT_FAILURE_CODES = new Set([
  '3',
  '5',
  '6',
  '7',
  '9',
  '10',
  '11',
  '12',
  '16',
  'aborted',
  'already-exists',
  'failed-precondition',
  'invalid-argument',
  'not-found',
  'out-of-range',
  'permission-denied',
  'unauthenticated',
  'unimplemented',
])

const COMMIT_REJECTED_METADATA = Object.freeze({
  code: 'PHASE2A_BATCH_COMMIT_REJECTED',
  message: 'Firestore clearly rejected the batch commit.',
})
const BATCH_BUILD_FAILED_METADATA = Object.freeze({
  code: 'PHASE2A_BATCH_BUILD_FAILED',
  message: 'The Firestore batch could not be safely constructed; no commit was attempted.',
})
const COMMIT_INDETERMINATE_METADATA = Object.freeze({
  code: 'PHASE2A_BATCH_COMMIT_OUTCOME_UNKNOWN',
  message: 'The Firestore batch commit outcome is uncertain; restart recovery is required.',
})
const POST_COMMIT_STATE_METADATA = Object.freeze({
  code: 'PHASE2A_POST_COMMIT_STATE_UNCERTAIN',
  message: 'A confirmed commit was not durably verified; restart recovery is required.',
})

export class BatchWriterError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'BatchWriterError'
    this.code = 'PHASE2A_BATCH_WRITER_ERROR'
    this.category = category
    this.blocking = true
    this.details = deepFreeze({ ...details })
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested)
    }
    Object.freeze(value)
  }
  return value
}

function fail(category, message, details) {
  throw new BatchWriterError(category, message, details)
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requirePlainRecord(value, label) {
  if (!isPlainRecord(value)) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
      `${label} must be a Firestore map.`,
    )
  }

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (typeof key !== 'string' || !descriptor?.enumerable ||
        descriptor.get || descriptor.set) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
        `${label} contains a non-Firestore property.`,
      )
    }
  }

  return value
}

function requireExactKeys(value, expectedKeys, label) {
  requirePlainRecord(value, label)
  const keys = Reflect.ownKeys(value)

  if (keys.length !== expectedKeys.length ||
      expectedKeys.some(key => !keys.includes(key))) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
      `${label} has an unexpected shape.`,
    )
  }
}

function encodeBody(value, label, path) {
  requirePlainRecord(value, label)

  try {
    const encoded = encodeCanonicalFirestoreValue(value)
    return {
      encoded,
      clone: decodeCanonicalFirestoreValue(encoded),
    }
  } catch {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
      `${label} is not a supported Firestore map.`,
      path === undefined ? {} : { path },
    )
  }
}

function hashEncoded(encoded) {
  return hashCanonicalState(encoded)
}

function bodyBytes(encoded) {
  return Buffer.byteLength(serializeCanonicalState(encoded), 'utf8')
}

function pathBytes(path) {
  return Buffer.byteLength(path, 'utf8')
}

function fieldMaskBytes(fieldMask) {
  return Buffer.byteLength(serializeCanonicalState(fieldMask), 'utf8')
}

function preconditionBytes(precondition) {
  return precondition === null
    ? 0
    : Buffer.byteLength(serializeCanonicalState(precondition), 'utf8')
}

function decodeUpdateTimePrecondition(operation) {
  let decoded

  try {
    decoded = decodeCanonicalFirestoreValue(
      operation.updateTimePrecondition,
    )
  } catch {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_OPERATION,
      'An update operation has a malformed update-time precondition.',
      { operationId: operation.operationId, path: operation.path },
    )
  }

  if (!(decoded instanceof Timestamp)) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_OPERATION,
      'An update operation requires an exact Timestamp precondition.',
      { operationId: operation.operationId, path: operation.path },
    )
  }

  return decoded
}

function insertProjectionEntry(index, entry, label) {
  if (!isPlainRecord(entry) || typeof entry.path !== 'string') {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
      `${label} is malformed.`,
    )
  }

  if (index.has(entry.path)) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
      'The projection contains a duplicate destination path.',
      { path: entry.path },
    )
  }

  index.set(entry.path, entry)
}

function indexProjection(projection, classroomId) {
  if (!isPlainRecord(projection) ||
      projection.classroomId !== classroomId ||
      !isPlainRecord(projection.classroom) ||
      projection.classroom.path !== `classrooms/${classroomId}`) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
      'The projection identity does not match the manifest.',
    )
  }

  requireExactKeys(
    projection.classroom.data,
    ['settings', 'lastBackupAt'],
    'projection.classroom.data',
  )

  const createEntries = new Map()
  for (const collection of [
    'students',
    'transactions',
    'loginHistory',
    'studentAuthLogs',
  ]) {
    if (!Array.isArray(projection[collection])) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
        `projection.${collection} must be an array.`,
      )
    }

    projection[collection].forEach((entry, index) => {
      insertProjectionEntry(
        createEntries,
        entry,
        `projection.${collection}[${index}]`,
      )
    })
  }

  if (!Array.isArray(projection.studentCredentials)) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
      'projection.studentCredentials must be an array.',
    )
  }

  const credentialEntries = new Map()
  projection.studentCredentials.forEach((entry, index) => {
    insertProjectionEntry(
      credentialEntries,
      entry,
      `projection.studentCredentials[${index}]`,
    )
  })

  return {
    classroom: projection.classroom,
    createEntries,
    credentialEntries,
  }
}

function assertExpectedAfterHash(operation, encoded) {
  if (hashEncoded(encoded) !== operation.expectedAfterHash) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
      'A projected write body does not match the retained operation plan.',
      { operationId: operation.operationId, path: operation.path },
    )
  }
}

function createWriteSpecification(operation, projectionIndex, classroomId) {
  if (operation.type === MANIFEST_OPERATION_TYPES.CREATE) {
    const entry = projectionIndex.createEntries.get(operation.path)
    if (!entry) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
        'A create operation has no matching projected destination body.',
        { operationId: operation.operationId, path: operation.path },
      )
    }

    const body = encodeBody(
      entry.data,
      'projected create body',
      operation.path,
    )
    assertExpectedAfterHash(operation, body.encoded)

    return {
      operation,
      method: 'create',
      body: body.clone,
      fieldMask: [],
      precondition: null,
      encodedBody: body.encoded,
    }
  }

  if (operation.type === MANIFEST_OPERATION_TYPES.CLASSROOM_FIELD_UPDATE) {
    if (operation.path !== projectionIndex.classroom.path) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
        'The classroom update does not match the projected classroom.',
        { operationId: operation.operationId, path: operation.path },
      )
    }

    const body = encodeBody(
      projectionIndex.classroom.data,
      'projected classroom update body',
      operation.path,
    )
    assertExpectedAfterHash(operation, body.encoded)

    return {
      operation,
      method: 'update',
      body: body.clone,
      fieldMask: ['lastBackupAt', 'settings'],
      precondition: decodeUpdateTimePrecondition(operation),
      encodedBody: body.encoded,
    }
  }

  if (operation.type ===
      MANIFEST_OPERATION_TYPES.CREDENTIAL_CLASSROOM_UPDATE) {
    const entry = projectionIndex.credentialEntries.get(operation.path)
    if (!entry) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
        'A credential update has no matching projected credential.',
        { operationId: operation.operationId, path: operation.path },
      )
    }

    const projectedCredential = encodeBody(
      entry.data,
      'projected credential',
      operation.path,
    )
    assertExpectedAfterHash(operation, projectedCredential.encoded)

    if (projectedCredential.clone.classroomId !== classroomId) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_PROJECTION,
        'A projected credential has the wrong classroomId.',
        { operationId: operation.operationId, path: operation.path },
      )
    }

    const updateBody = encodeBody(
      { classroomId },
      'credential classroom update body',
      operation.path,
    )

    return {
      operation,
      method: 'update',
      body: updateBody.clone,
      fieldMask: ['classroomId'],
      precondition: decodeUpdateTimePrecondition(operation),
      encodedBody: updateBody.encoded,
    }
  }

  fail(
    BATCH_WRITER_ERROR_CATEGORIES.INVALID_OPERATION,
    'The manifest contains an unsupported migration operation.',
    { operationId: operation.operationId, path: operation.path },
  )
}

function estimateWriteBytes(specification) {
  return bodyBytes(specification.encodedBody) +
    pathBytes(specification.operation.path) +
    fieldMaskBytes(specification.fieldMask) +
    preconditionBytes(specification.operation.updateTimePrecondition) +
    ESTIMATED_WRITE_OVERHEAD_BYTES
}

function assertNoDeleteOperations(manifest) {
  if (!Array.isArray(manifest?.operations)) {
    return
  }

  const prohibited = manifest.operations.find(operation =>
    typeof operation?.type === 'string' &&
    operation.type.toLowerCase().includes('delete'),
  )

  if (prohibited) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.DELETE_PROHIBITED,
      'Phase 2A migration batches must never contain delete operations.',
      {
        operationId: prohibited.operationId,
        path: prohibited.path,
      },
    )
  }
}

function prepareWritePlan(manifest, projection) {
  assertNoDeleteOperations(manifest)
  validateManifest(manifest)
  const projectionIndex = indexProjection(projection, manifest.classroomId)
  const specifications = new Map()

  for (const operation of manifest.operations) {
    specifications.set(
      operation.operationId,
      createWriteSpecification(
        operation,
        projectionIndex,
        manifest.classroomId,
      ),
    )
  }

  return manifest.batches.map(batch => {
    if (batch.state !== MANIFEST_BATCH_STATES.PENDING &&
        batch.state !== MANIFEST_BATCH_STATES.VERIFIED) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_LIFECYCLE,
        'Unresolved batches must complete restart recovery before writing.',
        { batchId: batch.batchId, batchState: batch.state },
      )
    }

    const writes = batch.operationIds
      .map(operationId => specifications.get(operationId))
      .filter(specification => specification.operation.state ===
        MANIFEST_OPERATION_STATES.PLANNED)

    if (batch.state === MANIFEST_BATCH_STATES.VERIFIED) {
      if (writes.length > 0) {
        fail(
          BATCH_WRITER_ERROR_CATEGORIES.INVALID_LIFECYCLE,
          'A verified batch cannot contain planned writes.',
          { batchId: batch.batchId },
        )
      }
      return { batchId: batch.batchId, writes: [], estimatedBytes: 0 }
    }

    if (writes.length === 0) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_LIFECYCLE,
        'A pending batch must contain at least one planned write.',
        { batchId: batch.batchId },
      )
    }

    if (writes.length > MAX_BATCH_OPERATIONS) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.BATCH_TOO_MANY_OPERATIONS,
        `Batch ${batch.batchId} exceeds the ${MAX_BATCH_OPERATIONS}-operation ceiling.`,
        {
          batchId: batch.batchId,
          operationCount: writes.length,
          maximumOperationCount: MAX_BATCH_OPERATIONS,
        },
      )
    }

    let estimatedBytes = 0
    for (const specification of writes) {
      const operationBytes = estimateWriteBytes(specification)
      if (operationBytes > MAX_BATCH_PAYLOAD_BYTES) {
        fail(
          BATCH_WRITER_ERROR_CATEGORIES.OPERATION_TOO_LARGE,
          'A single migration operation exceeds the 8 MiB payload ceiling.',
          {
            batchId: batch.batchId,
            operationId: specification.operation.operationId,
            path: specification.operation.path,
            estimatedBytes: operationBytes,
            maximumBytes: MAX_BATCH_PAYLOAD_BYTES,
          },
        )
      }
      estimatedBytes += operationBytes
    }

    if (estimatedBytes > MAX_BATCH_PAYLOAD_BYTES) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.BATCH_TOO_LARGE,
        `Batch ${batch.batchId} exceeds the 8 MiB payload ceiling.`,
        {
          batchId: batch.batchId,
          estimatedBytes,
          maximumBytes: MAX_BATCH_PAYLOAD_BYTES,
        },
      )
    }

    return { batchId: batch.batchId, writes, estimatedBytes }
  })
}

function validateOptions(options) {
  if (!isPlainRecord(options)) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      'writeMigrationBatches requires an options object.',
    )
  }

  const allowedKeys = new Set([
    'firestore',
    'manifest',
    'projection',
    'persistManifest',
    'clock',
  ])
  const unknownKey = Reflect.ownKeys(options).find(key =>
    typeof key !== 'string' || !allowedKeys.has(key),
  )

  if (unknownKey !== undefined ||
      !Object.hasOwn(options, 'firestore') ||
      !Object.hasOwn(options, 'manifest') ||
      !Object.hasOwn(options, 'projection')) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      'Batch-writer arguments are missing or unsupported.',
      unknownKey === undefined ? {} : { argument: String(unknownKey) },
    )
  }

  const { firestore } = options
  if (firestore === null ||
      (typeof firestore !== 'object' && typeof firestore !== 'function') ||
      typeof firestore.doc !== 'function' ||
      typeof firestore.batch !== 'function') {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_FIRESTORE,
      'firestore must provide doc() and batch() methods.',
    )
  }

  const persistManifest = options.persistManifest ?? writeCanonicalManifest
  const clock = options.clock ?? (() => new Date())
  if (typeof persistManifest !== 'function' || typeof clock !== 'function') {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      'persistManifest and clock must be functions.',
    )
  }

  return { ...options, persistManifest, clock }
}

function createTimestampSequencer(manifest, clock) {
  let latestMilliseconds = Date.parse(manifest.updatedAt)

  return () => {
    let sampled
    try {
      sampled = clock()
    } catch {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_ARGUMENTS,
        'The batch-writer clock failed.',
      )
    }

    const date = sampled instanceof Date ? sampled : new Date(sampled)
    const sampledMilliseconds = date.getTime()
    if (!Number.isFinite(sampledMilliseconds)) {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.INVALID_ARGUMENTS,
        'The batch-writer clock returned an invalid timestamp.',
      )
    }

    latestMilliseconds = Math.max(
      sampledMilliseconds,
      latestMilliseconds + 1,
    )
    return new Date(latestMilliseconds).toISOString()
  }
}

async function persistTransition(candidate, persistManifest) {
  await persistManifest(candidate)
  return candidate
}

function transition(current, nextTimestamp, type, details = {}) {
  return transitionManifest(current, {
    type,
    updatedAt: nextTimestamp(),
    ...details,
  })
}

async function persistBeforeCommit(
  candidate,
  persistManifest,
  details = {},
) {
  try {
    return await persistTransition(candidate, persistManifest)
  } catch {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.MANIFEST_PERSISTENCE_FAILED,
      'The manifest transition could not be durably persisted; no batch commit was attempted.',
      details,
    )
  }
}

async function tryPersistIndeterminate({
  current,
  batchId,
  errorMetadata,
  nextTimestamp,
  persistManifest,
}) {
  try {
    const candidate = transition(
      current,
      nextTimestamp,
      MANIFEST_TRANSITIONS.MARK_INDETERMINATE,
      { batchId, error: errorMetadata },
    )
    await persistTransition(candidate, persistManifest)
    return true
  } catch {
    return false
  }
}

async function throwIndeterminate({
  current,
  batchId,
  errorMetadata,
  nextTimestamp,
  persistManifest,
  category,
  message,
}) {
  const indeterminateStatePersisted = await tryPersistIndeterminate({
    current,
    batchId,
    errorMetadata,
    nextTimestamp,
    persistManifest,
  })

  fail(category, message, {
    batchId,
    indeterminateStatePersisted,
    recoveryRequired: true,
  })
}

function normalizeCommitErrorCode(error) {
  const value = error?.code
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }

  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^firestore\//, '')
}

export function isClearlyRejectedCommit(error) {
  const code = normalizeCommitErrorCode(error)
  return code !== null && CLEAR_COMMIT_FAILURE_CODES.has(code)
}

function documentReference(firestore, path) {
  const reference = firestore.doc(path)
  if (reference === null ||
      (typeof reference !== 'object' && typeof reference !== 'function') ||
      reference.path !== path) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_FIRESTORE,
      'firestore.doc() returned an invalid document reference.',
      { path },
    )
  }
  return reference
}

function configureFirestoreBatch(firestore, writes) {
  const batch = firestore.batch()
  if (batch === null ||
      (typeof batch !== 'object' && typeof batch !== 'function') ||
      typeof batch.create !== 'function' ||
      typeof batch.update !== 'function' ||
      typeof batch.commit !== 'function') {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_FIRESTORE,
      'firestore.batch() returned an invalid write batch.',
    )
  }

  for (const specification of writes) {
    const reference = documentReference(
      firestore,
      specification.operation.path,
    )

    if (specification.method === 'create') {
      batch.create(reference, specification.body)
    } else if (specification.method === 'update') {
      batch.update(reference, specification.body, {
        lastUpdateTime: specification.precondition,
      })
    } else {
      fail(
        BATCH_WRITER_ERROR_CATEGORIES.DELETE_PROHIBITED,
        'Phase 2A migration batches may only create or update documents.',
        {
          operationId: specification.operation.operationId,
          path: specification.operation.path,
        },
      )
    }
  }

  return batch
}

function classroomVerificationFields(data) {
  const fields = {}
  if (Object.hasOwn(data, 'settings')) {
    fields.settings = data.settings
  }
  if (Object.hasOwn(data, 'lastBackupAt')) {
    fields.lastBackupAt = data.lastBackupAt
  }
  return fields
}

async function verifyCommittedWrites(firestore, writes) {
  for (const specification of writes) {
    const { operation } = specification
    const reference = documentReference(firestore, operation.path)
    if (typeof reference.get !== 'function') {
      throw new Error('Document reference cannot be read for verification.')
    }

    const snapshot = await reference.get()
    if (snapshot === null || typeof snapshot !== 'object' ||
        snapshot.exists !== true || typeof snapshot.data !== 'function') {
      throw new Error('Committed destination snapshot is malformed.')
    }

    const data = snapshot.data()
    const verifiableData = operation.type ===
      MANIFEST_OPERATION_TYPES.CLASSROOM_FIELD_UPDATE
      ? classroomVerificationFields(data)
      : data
    const encoded = encodeCanonicalFirestoreValue(
      requirePlainRecord(verifiableData, 'committed destination body'),
    )

    if (hashEncoded(encoded) !== operation.expectedAfterHash) {
      throw new Error('Committed destination does not match its expected hash.')
    }
  }
}

async function persistClearFailure({
  current,
  batchId,
  nextTimestamp,
  persistManifest,
  errorMetadata,
  category,
  message,
}) {
  const candidate = transition(
    current,
    nextTimestamp,
    MANIFEST_TRANSITIONS.FAIL_BATCH,
    { batchId, error: errorMetadata },
  )

  try {
    await persistTransition(candidate, persistManifest)
  } catch {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.MANIFEST_PERSISTENCE_INDETERMINATE,
      'The rejected commit could not be durably recorded; restart recovery is required.',
      { batchId, recoveryRequired: true },
    )
  }

  fail(category, message, { batchId, recoveryRequired: true })
}

/**
 * Executes retained Phase 2A batches in manifest order. The complete payload
 * plan is validated before writePhaseStarted is persisted. Item 6 currently
 * assigns one operation per deterministic batch; this writer preserves that
 * association and independently enforces both safety ceilings.
 */
export async function writeMigrationBatches(options) {
  const {
    firestore,
    projection,
    persistManifest,
    clock,
  } = validateOptions(options)
  let manifest = options.manifest
  const writePlan = prepareWritePlan(manifest, projection)
  const nextTimestamp = createTimestampSequencer(manifest, clock)

  if (manifest.runState === MANIFEST_RUN_STATES.PLANNED) {
    const started = transition(
      manifest,
      nextTimestamp,
      MANIFEST_TRANSITIONS.START_WRITE,
    )
    manifest = await persistBeforeCommit(started, persistManifest)
  } else if (manifest.runState !== MANIFEST_RUN_STATES.WRITING ||
      !manifest.writePhaseStarted || manifest.inFlightBatchId !== null) {
    fail(
      BATCH_WRITER_ERROR_CATEGORIES.INVALID_LIFECYCLE,
      'The manifest must be planned or recovered to an idle writing state.',
      {
        runState: manifest.runState,
        writePhaseStarted: manifest.writePhaseStarted,
        inFlightBatchId: manifest.inFlightBatchId,
      },
    )
  }

  for (const plannedBatch of writePlan) {
    if (plannedBatch.writes.length === 0) {
      continue
    }

    const inFlight = transition(
      manifest,
      nextTimestamp,
      MANIFEST_TRANSITIONS.START_BATCH,
      { batchId: plannedBatch.batchId },
    )
    manifest = await persistBeforeCommit(
      inFlight,
      persistManifest,
      { batchId: plannedBatch.batchId },
    )

    let firestoreBatch
    try {
      firestoreBatch = configureFirestoreBatch(
        firestore,
        plannedBatch.writes,
      )
    } catch {
      await persistClearFailure({
        current: manifest,
        batchId: plannedBatch.batchId,
        nextTimestamp,
        persistManifest,
        errorMetadata: BATCH_BUILD_FAILED_METADATA,
        category: BATCH_WRITER_ERROR_CATEGORIES.BATCH_BUILD_FAILED,
        message: 'The Firestore batch could not be safely constructed.',
      })
    }

    try {
      await firestoreBatch.commit()
    } catch (error) {
      if (isClearlyRejectedCommit(error)) {
        await persistClearFailure({
          current: manifest,
          batchId: plannedBatch.batchId,
          nextTimestamp,
          persistManifest,
          errorMetadata: COMMIT_REJECTED_METADATA,
          category: BATCH_WRITER_ERROR_CATEGORIES.COMMIT_REJECTED,
          message: 'Firestore clearly rejected a Phase 2A batch commit.',
        })
      }

      await throwIndeterminate({
        current: manifest,
        batchId: plannedBatch.batchId,
        errorMetadata: COMMIT_INDETERMINATE_METADATA,
        nextTimestamp,
        persistManifest,
        category: BATCH_WRITER_ERROR_CATEGORIES.COMMIT_INDETERMINATE,
        message: 'The Firestore batch commit outcome is uncertain; restart recovery is required.',
      })
    }

    const committed = transition(
      manifest,
      nextTimestamp,
      MANIFEST_TRANSITIONS.COMMIT_BATCH,
      { batchId: plannedBatch.batchId },
    )
    try {
      manifest = await persistTransition(committed, persistManifest)
    } catch {
      await throwIndeterminate({
        current: manifest,
        batchId: plannedBatch.batchId,
        errorMetadata: POST_COMMIT_STATE_METADATA,
        nextTimestamp,
        persistManifest,
        category:
          BATCH_WRITER_ERROR_CATEGORIES.MANIFEST_PERSISTENCE_INDETERMINATE,
        message: 'The batch committed, but its committed manifest state is uncertain; restart recovery is required.',
      })
    }

    try {
      await verifyCommittedWrites(firestore, plannedBatch.writes)
    } catch {
      await throwIndeterminate({
        current: manifest,
        batchId: plannedBatch.batchId,
        errorMetadata: POST_COMMIT_STATE_METADATA,
        nextTimestamp,
        persistManifest,
        category: BATCH_WRITER_ERROR_CATEGORIES.VERIFICATION_INDETERMINATE,
        message: 'The committed batch could not be verified; restart recovery is required.',
      })
    }

    const verified = transition(
      manifest,
      nextTimestamp,
      MANIFEST_TRANSITIONS.VERIFY_BATCH,
      { batchId: plannedBatch.batchId },
    )
    try {
      manifest = await persistTransition(verified, persistManifest)
    } catch {
      await throwIndeterminate({
        current: manifest,
        batchId: plannedBatch.batchId,
        errorMetadata: POST_COMMIT_STATE_METADATA,
        nextTimestamp,
        persistManifest,
        category:
          BATCH_WRITER_ERROR_CATEGORIES.MANIFEST_PERSISTENCE_INDETERMINATE,
        message: 'Batch verification succeeded, but its manifest state is uncertain; restart recovery is required.',
      })
    }
  }

  return manifest
}
