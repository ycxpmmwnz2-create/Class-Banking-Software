import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { Timestamp } from 'firebase-admin/firestore'

import {
  decodeCanonicalFirestoreValue,
  serializeCanonicalState,
} from './canonicalState.js'
import {
  deriveCanonicalManifestSlot,
  MANIFEST_SCHEMA_VERSION,
  PHASE2A_MIGRATION_ID,
} from './manifestSlot.js'
import { normalizeFirestoreDocumentId } from './firestoreDocumentId.js'

export const MANIFEST_MODES = Object.freeze({
  DRY_RUN: 'dry-run',
  WRITE: 'write',
})

export const MANIFEST_RUN_STATES = Object.freeze({
  PLANNED: 'planned',
  WRITING: 'writing',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INDETERMINATE: 'indeterminate',
})

export const MANIFEST_BATCH_STATES = Object.freeze({
  PENDING: 'pending',
  IN_FLIGHT: 'in_flight',
  COMMITTED: 'committed',
  VERIFIED: 'verified',
  FAILED: 'failed',
  INDETERMINATE: 'indeterminate',
})

export const MANIFEST_OPERATION_STATES = Object.freeze({
  PLANNED: 'planned',
  SKIPPED_IDENTICAL: 'skipped_identical',
  IN_FLIGHT: 'in_flight',
  COMMITTED: 'committed',
  VERIFIED: 'verified',
  FAILED: 'failed',
  INDETERMINATE: 'indeterminate',
})

export const MANIFEST_OPERATION_TYPES = Object.freeze({
  CREATE: 'create',
  CLASSROOM_FIELD_UPDATE: 'classroom-field-update',
  CREDENTIAL_CLASSROOM_UPDATE: 'credential-classroom-update',
})

export const MANIFEST_TRANSITIONS = Object.freeze({
  START_WRITE: 'start-write',
  START_BATCH: 'start-batch',
  COMMIT_BATCH: 'commit-batch',
  VERIFY_BATCH: 'verify-batch',
  START_VERIFICATION: 'start-verification',
  COMPLETE: 'complete',
  FAIL: 'fail',
  FAIL_BATCH: 'fail-batch',
  MARK_INDETERMINATE: 'mark-indeterminate',
  RECOVER_BATCH_BEFORE: 'recover-batch-before',
  RECOVER_BATCH_AFTER: 'recover-batch-after',
  RECOVER_BATCH_MIXED: 'recover-batch-mixed',
  RECOVER_BATCH_DIVERGENT: 'recover-batch-divergent',
})

export const MANIFEST_ERROR_CATEGORIES = Object.freeze({
  INVALID_MANIFEST: 'invalid-manifest',
  INVALID_TRANSITION: 'invalid-transition',
  READ_FAILED: 'read-failed',
  REPLACEMENT_BLOCKED: 'replacement-blocked',
  WRITE_FAILED: 'write-failed',
})

const HASH_PATTERN = /^[0-9a-f]{64}$/
const RUN_STATE_VALUES = new Set(Object.values(MANIFEST_RUN_STATES))
const BATCH_STATE_VALUES = new Set(Object.values(MANIFEST_BATCH_STATES))
const OPERATION_STATE_VALUES = new Set(Object.values(MANIFEST_OPERATION_STATES))
const OPERATION_TYPE_VALUES = new Set(Object.values(MANIFEST_OPERATION_TYPES))
const RECONCILIATION_COUNT_FIELDS = Object.freeze([
  'students',
  'transactions',
  'loginHistory',
  'studentCredentials',
  'studentAuthLogs',
  'orphanedCredentials',
])
const RECONCILIATION_EQUALITY_FIELDS = Object.freeze([
  'foundation',
  'classroomMetadata',
  'students',
  'transactions',
  'loginHistory',
  'studentCredentials',
  'studentAuthLogs',
  'originalSources',
  'checksums',
])
const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'migrationId',
  'runId',
  'mode',
  'emulatorProjectId',
  'teacherUid',
  'classroomId',
  'createdAt',
  'updatedAt',
  'immutableSourceChecksum',
  'foundationInvariantChecksum',
  'planChecksum',
  'runState',
  'writePhaseStarted',
  'inFlightBatchId',
  'batches',
  'operations',
  'orphanedCredentialPaths',
  'reconciliationSummary',
])

// Object provenance prevents a schema-valid hand edit from bypassing the
// state machine. The recorded predecessor also makes each durable update an
// optimistic comparison against the exact manifest state it advanced from.
const TRUSTED_MANIFESTS = new WeakSet()
const FRESH_PLANNED_PREDECESSOR = Symbol('fresh-planned-manifest')
const PERSISTABLE_PREDECESSORS = new WeakMap()
const MUTABLE_TRANSITION_PREDECESSORS = new WeakMap()

const RUN_STATE_ADVANCES = Object.freeze({
  [MANIFEST_RUN_STATES.PLANNED]: new Set([
    MANIFEST_RUN_STATES.PLANNED,
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.FAILED,
  ]),
  [MANIFEST_RUN_STATES.WRITING]: new Set([
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.VERIFYING,
    MANIFEST_RUN_STATES.FAILED,
    MANIFEST_RUN_STATES.INDETERMINATE,
  ]),
  [MANIFEST_RUN_STATES.VERIFYING]: new Set([
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.VERIFYING,
    MANIFEST_RUN_STATES.COMPLETED,
    MANIFEST_RUN_STATES.FAILED,
    MANIFEST_RUN_STATES.INDETERMINATE,
  ]),
  [MANIFEST_RUN_STATES.FAILED]: new Set([
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.VERIFYING,
    MANIFEST_RUN_STATES.FAILED,
    MANIFEST_RUN_STATES.INDETERMINATE,
  ]),
  [MANIFEST_RUN_STATES.INDETERMINATE]: new Set([
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.VERIFYING,
    MANIFEST_RUN_STATES.FAILED,
    MANIFEST_RUN_STATES.INDETERMINATE,
  ]),
  [MANIFEST_RUN_STATES.COMPLETED]: new Set([
    MANIFEST_RUN_STATES.COMPLETED,
  ]),
})

export class ManifestError extends Error {
  constructor(category, message, details = {}, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ManifestError'
    this.code = 'PHASE2A_MANIFEST_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details, cause) {
  throw new ManifestError(category, message, details, cause)
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, expectedKeys, label, category) {
  if (!isRecord(value)) {
    fail(category, `${label} must be an object.`, { field: label })
  }

  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string') ||
      keys.length !== expectedKeys.length ||
      expectedKeys.some(key => !keys.includes(key))) {
    fail(category, `${label} contains an unexpected field set.`, {
      field: label,
    })
  }
}

function canonicalClone(value, label, category) {
  try {
    return JSON.parse(serializeCanonicalState(value))
  } catch (error) {
    fail(category, `${label} must contain strict canonical JSON values.`, {
      field: label,
    }, error)
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

function trustManifest(
  manifest,
  {
    persistable = false,
    predecessor = FRESH_PLANNED_PREDECESSOR,
  } = {},
) {
  TRUSTED_MANIFESTS.add(manifest)
  if (persistable) {
    PERSISTABLE_PREDECESSORS.set(manifest, predecessor)
  }
  return manifest
}

function requireCanonicalString(value, label, category) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.trim() !== value) {
    fail(category, `${label} must be a non-empty canonical string.`, {
      field: label,
    })
  }

  return value
}

function requireHash(value, label, category) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(category, `${label} must be a lowercase SHA-256 hash.`, {
      field: label,
    })
  }
}

function requireDocumentId(value, label, category) {
  const validation = normalizeFirestoreDocumentId(value)

  if (typeof value !== 'string' || !validation.valid) {
    const rejection = validation.rejection
    fail(category, `${label} must be a canonical Firestore document ID.`, {
      field: label,
      documentIdRejection: {
        category: rejection?.category,
        sourceIndex: rejection?.sourceIndex,
        originalType: rejection?.originalType,
      },
    })
  }
}

function requireIsoTimestamp(value, label, category) {
  if (typeof value !== 'string') {
    fail(category, `${label} must be a canonical ISO 8601 timestamp.`, {
      field: label,
    })
  }

  const parsed = new Date(value)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(category, `${label} must be a canonical ISO 8601 timestamp.`, {
      field: label,
    })
  }
}

function requireStringArray(value, label, category, { sorted = false } = {}) {
  if (!Array.isArray(value)) {
    fail(category, `${label} must be an array.`, { field: label })
  }

  const seen = new Set()
  let previous

  for (let index = 0; index < value.length; index += 1) {
    const entry = requireCanonicalString(
      value[index],
      `${label}[${index}]`,
      category,
    )

    if (seen.has(entry)) {
      fail(category, `${label} must not contain duplicates.`, {
        field: label,
        value: entry,
      })
    }

    if (sorted && previous !== undefined && !(previous < entry)) {
      fail(category, `${label} must be in canonical sorted order.`, {
        field: label,
      })
    }

    seen.add(entry)
    previous = entry
  }

  return value
}

function requireErrorMetadata(value, label, category) {
  exactKeys(value, ['code', 'message'], label, category)
  requireCanonicalString(value.code, `${label}.code`, category)
  requireCanonicalString(value.message, `${label}.message`, category)
}

function requireEncodedFirestoreValue(value, label, category) {
  try {
    return decodeCanonicalFirestoreValue(value)
  } catch (error) {
    fail(category, `${label} is not a valid canonical Firestore value.`, {
      field: label,
    }, error)
  }
}

function requireEncodedTimestamp(value, label, category) {
  const decoded = requireEncodedFirestoreValue(value, label, category)

  if (!(decoded instanceof Timestamp)) {
    fail(category, `${label} must encode a Firestore Timestamp.`, {
      field: label,
    })
  }
}

function validateClassroomRollbackPreimage(value, category) {
  exactKeys(
    value,
    ['settings', 'lastBackupAt'],
    'operation.rollbackPreimage',
    category,
  )
  const settings = requireEncodedFirestoreValue(
    value.settings,
    'operation.rollbackPreimage.settings',
    category,
  )
  if (!isRecord(settings)) {
    fail(
      category,
      'operation.rollbackPreimage.settings must encode a map.',
      { field: 'operation.rollbackPreimage.settings' },
    )
  }
  exactKeys(
    value.lastBackupAt,
    ['present', 'value'],
    'operation.rollbackPreimage.lastBackupAt',
    category,
  )

  if (typeof value.lastBackupAt.present !== 'boolean') {
    fail(
      category,
      'operation.rollbackPreimage.lastBackupAt.present must be boolean.',
      { field: 'operation.rollbackPreimage.lastBackupAt.present' },
    )
  }

  if (!value.lastBackupAt.present && value.lastBackupAt.value !== null) {
    fail(
      category,
      'An absent rollback lastBackupAt value must be null.',
      { field: 'operation.rollbackPreimage.lastBackupAt.value' },
    )
  }

  if (value.lastBackupAt.present) {
    requireEncodedFirestoreValue(
      value.lastBackupAt.value,
      'operation.rollbackPreimage.lastBackupAt.value',
      category,
    )
  }
}

function validateCredentialRollbackPreimage(
  value,
  operation,
  classroomId,
  category,
) {
  exactKeys(
    value,
    ['path', 'oldClassroomId', 'newClassroomId', 'invariantHash'],
    'operation.rollbackPreimage',
    category,
  )

  if (value.path !== operation.path || value.oldClassroomId !== 'morgan' ||
      value.newClassroomId !== classroomId) {
    fail(
      category,
      'Credential rollback metadata does not match the operation identity.',
      { operationId: operation.operationId },
    )
  }

  requireHash(
    value.invariantHash,
    'operation.rollbackPreimage.invariantHash',
    category,
  )
}

function requireCreatePath(pathValue, classroomId, category) {
  const prefixes = [
    `classrooms/${classroomId}/students/`,
    `classrooms/${classroomId}/transactions/`,
    `classrooms/${classroomId}/loginHistory/`,
    `studentAuthLogs/${classroomId}/logs/`,
  ]
  const prefix = prefixes.find(candidate => pathValue.startsWith(candidate))
  const documentId = prefix === undefined ? undefined : pathValue.slice(prefix.length)

  if (prefix === undefined || documentId.length === 0 ||
      documentId.includes('/')) {
    fail(category, 'Create operation path is outside Phase 2A destinations.', {
      path: pathValue,
    })
  }

  requireDocumentId(documentId, 'operation.path document ID', category)
}

function validateOperation(operation, classroomId, category, index) {
  const label = `operations[${index}]`

  if (!isRecord(operation)) {
    fail(category, `${label} must be an object.`, { field: label })
  }

  const hasError = Object.hasOwn(operation, 'error')
  const expectedKeys = [
    'operationId',
    'type',
    'path',
    'expectedBeforeHash',
    'expectedAfterHash',
    'rollbackPreimage',
    'updateTimePrecondition',
    'state',
    'batchId',
    ...(hasError ? ['error'] : []),
  ]
  exactKeys(operation, expectedKeys, label, category)

  requireCanonicalString(operation.operationId, `${label}.operationId`, category)
  requireCanonicalString(operation.path, `${label}.path`, category)
  requireCanonicalString(operation.batchId, `${label}.batchId`, category)

  if (!OPERATION_TYPE_VALUES.has(operation.type)) {
    fail(category, `${label}.type is unsupported.`, {
      operationId: operation.operationId,
    })
  }

  if (!OPERATION_STATE_VALUES.has(operation.state)) {
    fail(category, `${label}.state is unsupported.`, {
      operationId: operation.operationId,
    })
  }

  requireHash(operation.expectedAfterHash, `${label}.expectedAfterHash`, category)

  if (operation.type === MANIFEST_OPERATION_TYPES.CREATE) {
    if (operation.expectedBeforeHash !== 'absent' ||
        operation.rollbackPreimage !== null ||
        operation.updateTimePrecondition !== null) {
      fail(category, 'Create operation metadata is malformed.', {
        operationId: operation.operationId,
      })
    }

    requireCreatePath(operation.path, classroomId, category)
  } else {
    requireHash(
      operation.expectedBeforeHash,
      `${label}.expectedBeforeHash`,
      category,
    )
    requireEncodedTimestamp(
      operation.updateTimePrecondition,
      `${label}.updateTimePrecondition`,
      category,
    )

    if (operation.type === MANIFEST_OPERATION_TYPES.CLASSROOM_FIELD_UPDATE) {
      if (operation.path !== `classrooms/${classroomId}`) {
        fail(category, 'Classroom update path does not match classroomId.', {
          operationId: operation.operationId,
        })
      }
      validateClassroomRollbackPreimage(operation.rollbackPreimage, category)
    } else {
      const credentialPrefix = 'studentCredentials/'
      const credentialId = operation.path.startsWith(credentialPrefix)
        ? operation.path.slice(credentialPrefix.length)
        : undefined

      if (credentialId === undefined || credentialId.length === 0 ||
          credentialId.includes('/')) {
        fail(category, 'Credential update path is malformed.', {
          operationId: operation.operationId,
        })
      }
      requireDocumentId(
        credentialId,
        'operation.path credential document ID',
        category,
      )
      validateCredentialRollbackPreimage(
        operation.rollbackPreimage,
        operation,
        classroomId,
        category,
      )
    }
  }

  const needsError = operation.state === MANIFEST_OPERATION_STATES.FAILED ||
    operation.state === MANIFEST_OPERATION_STATES.INDETERMINATE

  if (needsError !== hasError) {
    fail(
      category,
      `${label}.error must exist only for failed or indeterminate state.`,
      { operationId: operation.operationId },
    )
  }

  if (hasError) {
    requireErrorMetadata(operation.error, `${label}.error`, category)
  }
}

function validateBatch(batch, category, index) {
  const label = `batches[${index}]`
  exactKeys(batch, ['batchId', 'state', 'operationIds'], label, category)
  requireCanonicalString(batch.batchId, `${label}.batchId`, category)

  if (!BATCH_STATE_VALUES.has(batch.state)) {
    fail(category, `${label}.state is unsupported.`, {
      batchId: batch.batchId,
    })
  }

  requireStringArray(batch.operationIds, `${label}.operationIds`, category)

  if (batch.operationIds.length === 0) {
    fail(category, `${label} must own at least one operation.`, {
      batchId: batch.batchId,
    })
  }
}

function validateBatchStateConsistency(batch, operations, category) {
  const states = operations.map(operation => operation.state)
  const everyStateIs = allowed => states.every(state => allowed.has(state))
  const includesState = state => states.includes(state)
  const terminal = new Set([
    MANIFEST_OPERATION_STATES.VERIFIED,
    MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL,
  ])

  if (batch.state === MANIFEST_BATCH_STATES.VERIFIED &&
      !everyStateIs(terminal)) {
    fail(category, 'Verified batch contains an unverified operation.', {
      batchId: batch.batchId,
    })
  }

  if (batch.state === MANIFEST_BATCH_STATES.PENDING &&
      !everyStateIs(new Set([
        MANIFEST_OPERATION_STATES.PLANNED,
        ...terminal,
      ]))) {
    fail(category, 'Pending batch contains an invalid operation state.', {
      batchId: batch.batchId,
    })
  }

  if (batch.state === MANIFEST_BATCH_STATES.IN_FLIGHT &&
      (!includesState(MANIFEST_OPERATION_STATES.IN_FLIGHT) ||
       !everyStateIs(new Set([
         MANIFEST_OPERATION_STATES.IN_FLIGHT,
         ...terminal,
       ])))) {
    fail(category, 'In-flight batch operation states are inconsistent.', {
      batchId: batch.batchId,
    })
  }

  if (batch.state === MANIFEST_BATCH_STATES.COMMITTED &&
      (!includesState(MANIFEST_OPERATION_STATES.COMMITTED) ||
       !everyStateIs(new Set([
         MANIFEST_OPERATION_STATES.COMMITTED,
         ...terminal,
       ])))) {
    fail(category, 'Committed batch operation states are inconsistent.', {
      batchId: batch.batchId,
    })
  }

  if (batch.state === MANIFEST_BATCH_STATES.FAILED &&
      !includesState(MANIFEST_OPERATION_STATES.FAILED)) {
    fail(category, 'Failed batch has no failed operation.', {
      batchId: batch.batchId,
    })
  }

  if (batch.state === MANIFEST_BATCH_STATES.INDETERMINATE &&
      !includesState(MANIFEST_OPERATION_STATES.INDETERMINATE)) {
    fail(category, 'Indeterminate batch has no indeterminate operation.', {
      batchId: batch.batchId,
    })
  }
}

function validateReconciliationSummary(value, category) {
  exactKeys(
    value,
    ['mode', 'passed', 'counts', 'equality'],
    'reconciliationSummary',
    category,
  )

  if (!Object.values(MANIFEST_MODES).includes(value.mode) ||
      typeof value.passed !== 'boolean') {
    fail(category, 'reconciliationSummary mode or passed value is invalid.', {
      field: 'reconciliationSummary',
    })
  }

  exactKeys(
    value.counts,
    RECONCILIATION_COUNT_FIELDS,
    'reconciliationSummary.counts',
    category,
  )
  for (const field of RECONCILIATION_COUNT_FIELDS) {
    if (!Number.isSafeInteger(value.counts[field]) || value.counts[field] < 0) {
      fail(category, 'Reconciliation count must be a non-negative integer.', {
        field: `reconciliationSummary.counts.${field}`,
      })
    }
  }

  exactKeys(
    value.equality,
    RECONCILIATION_EQUALITY_FIELDS,
    'reconciliationSummary.equality',
    category,
  )
  for (const field of RECONCILIATION_EQUALITY_FIELDS) {
    if (typeof value.equality[field] !== 'boolean') {
      fail(category, 'Reconciliation equality result must be boolean.', {
        field: `reconciliationSummary.equality.${field}`,
      })
    }
  }
}

function validateManifestStructure(manifest, expectedIdentity, category) {
  exactKeys(manifest, TOP_LEVEL_KEYS, 'manifest', category)

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
      manifest.migrationId !== PHASE2A_MIGRATION_ID) {
    fail(category, 'Manifest fixed identity is unsupported.', {
      schemaVersion: manifest.schemaVersion,
      migrationId: manifest.migrationId,
    })
  }

  for (const field of [
    'runId',
    'emulatorProjectId',
  ]) {
    requireCanonicalString(manifest[field], field, category)
  }
  requireDocumentId(manifest.teacherUid, 'teacherUid', category)
  requireDocumentId(manifest.classroomId, 'classroomId', category)

  if (manifest.classroomId === 'morgan') {
    fail(category, 'The legacy classroom ID cannot be a V2 classroomId.', {
      classroomId: manifest.classroomId,
    })
  }

  if (expectedIdentity !== undefined) {
    exactKeys(
      expectedIdentity,
      ['emulatorProjectId', 'teacherUid'],
      'expectedIdentity',
      category,
    )

    if (manifest.emulatorProjectId !== expectedIdentity.emulatorProjectId ||
        manifest.teacherUid !== expectedIdentity.teacherUid) {
      fail(category, 'Manifest fixed identity does not match its canonical slot.', {
        emulatorProjectId: expectedIdentity.emulatorProjectId,
        teacherUid: expectedIdentity.teacherUid,
      })
    }
  }

  if (!Object.values(MANIFEST_MODES).includes(manifest.mode)) {
    fail(category, 'Manifest mode is unsupported.', { mode: manifest.mode })
  }

  if (!RUN_STATE_VALUES.has(manifest.runState)) {
    fail(category, 'Manifest runState is unsupported.', {
      runState: manifest.runState,
    })
  }

  if (typeof manifest.writePhaseStarted !== 'boolean') {
    fail(category, 'Manifest writePhaseStarted must be boolean.', {
      field: 'writePhaseStarted',
    })
  }

  requireIsoTimestamp(manifest.createdAt, 'createdAt', category)
  requireIsoTimestamp(manifest.updatedAt, 'updatedAt', category)

  if (manifest.updatedAt < manifest.createdAt) {
    fail(category, 'Manifest updatedAt cannot precede createdAt.', {
      field: 'updatedAt',
    })
  }

  for (const field of [
    'immutableSourceChecksum',
    'foundationInvariantChecksum',
    'planChecksum',
  ]) {
    requireHash(manifest[field], field, category)
  }

  if (!Array.isArray(manifest.batches) ||
      !Array.isArray(manifest.operations)) {
    fail(category, 'Manifest batches and operations must be arrays.', {})
  }

  if (manifest.batches.length === 0 || manifest.operations.length === 0) {
    fail(category, 'Manifest plan must contain at least one batch and operation.', {})
  }

  const batchIds = new Set()
  manifest.batches.forEach((batch, index) => {
    validateBatch(batch, category, index)
    if (batchIds.has(batch.batchId)) {
      fail(category, 'Manifest contains a duplicate batchId.', {
        batchId: batch.batchId,
      })
    }
    batchIds.add(batch.batchId)
  })

  const operationIds = new Set()
  manifest.operations.forEach((operation, index) => {
    validateOperation(operation, manifest.classroomId, category, index)
    if (operationIds.has(operation.operationId)) {
      fail(category, 'Manifest contains a duplicate operationId.', {
        operationId: operation.operationId,
      })
    }
    operationIds.add(operation.operationId)
  })

  const batchedOperationIds = manifest.batches.flatMap(batch =>
    batch.operationIds,
  )
  const orderedOperationIds = manifest.operations.map(operation =>
    operation.operationId,
  )

  if (!isDeepStrictEqual(batchedOperationIds, orderedOperationIds)) {
    fail(
      category,
      'Batch membership must cover every operation exactly once in plan order.',
      {},
    )
  }

  const operationById = new Map(manifest.operations.map(operation => [
    operation.operationId,
    operation,
  ]))

  for (const batch of manifest.batches) {
    const operations = batch.operationIds.map(operationId =>
      operationById.get(operationId),
    )

    if (operations.some(operation => operation.batchId !== batch.batchId)) {
      fail(category, 'Operation batchId does not match batch membership.', {
        batchId: batch.batchId,
      })
    }

    validateBatchStateConsistency(batch, operations, category)
  }

  if (manifest.inFlightBatchId !== null) {
    requireCanonicalString(
      manifest.inFlightBatchId,
      'inFlightBatchId',
      category,
    )
    const inFlightBatch = manifest.batches.find(
      batch => batch.batchId === manifest.inFlightBatchId,
    )

    if (!inFlightBatch || !new Set([
      MANIFEST_BATCH_STATES.IN_FLIGHT,
      MANIFEST_BATCH_STATES.COMMITTED,
      MANIFEST_BATCH_STATES.FAILED,
      MANIFEST_BATCH_STATES.INDETERMINATE,
    ]).has(inFlightBatch.state)) {
      fail(category, 'inFlightBatchId does not identify an active batch.', {
        inFlightBatchId: manifest.inFlightBatchId,
      })
    }

    const inFlightIndex = manifest.batches.indexOf(inFlightBatch)
    const unresolvedEarlier = manifest.batches
      .slice(0, inFlightIndex)
      .find(batch => batch.state !== MANIFEST_BATCH_STATES.VERIFIED)

    if (unresolvedEarlier) {
      fail(category, 'An active batch cannot bypass an earlier batch.', {
        inFlightBatchId: manifest.inFlightBatchId,
        unresolvedBatchId: unresolvedEarlier.batchId,
      })
    }
  } else if (manifest.batches.some(
    batch => batch.state === MANIFEST_BATCH_STATES.IN_FLIGHT,
  )) {
    fail(category, 'An in-flight batch requires inFlightBatchId.', {})
  }

  requireStringArray(
    manifest.orphanedCredentialPaths,
    'orphanedCredentialPaths',
    category,
    { sorted: true },
  )

  for (const credentialPath of manifest.orphanedCredentialPaths) {
    const prefix = 'studentCredentials/'
    const credentialId = credentialPath.startsWith(prefix)
      ? credentialPath.slice(prefix.length)
      : undefined

    if (credentialId === undefined || credentialId.length === 0 ||
        credentialId.includes('/')) {
      fail(category, 'Orphaned credential path is malformed.', {
        path: credentialPath,
      })
    }
    requireDocumentId(
      credentialId,
      'orphaned credential document ID',
      category,
    )
  }

  if (manifest.reconciliationSummary !== null) {
    validateReconciliationSummary(manifest.reconciliationSummary, category)
  }

  if (!manifest.writePhaseStarted) {
    if (manifest.mode !== MANIFEST_MODES.DRY_RUN ||
        !new Set([
          MANIFEST_RUN_STATES.PLANNED,
          MANIFEST_RUN_STATES.FAILED,
        ]).has(manifest.runState) ||
        manifest.inFlightBatchId !== null) {
      fail(category, 'Zero-write manifest lifecycle is inconsistent.', {})
    }

    const invalidBatch = manifest.batches.find(batch =>
      !new Set([
        MANIFEST_BATCH_STATES.PENDING,
        MANIFEST_BATCH_STATES.VERIFIED,
      ]).has(batch.state),
    )
    const invalidOperation = manifest.operations.find(operation =>
      !new Set([
        MANIFEST_OPERATION_STATES.PLANNED,
        MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL,
      ]).has(operation.state),
    )

    if (invalidBatch || invalidOperation) {
      fail(category, 'Zero-write manifest contains write-phase states.', {})
    }
  } else if (manifest.mode !== MANIFEST_MODES.WRITE ||
      !new Set([
        MANIFEST_RUN_STATES.WRITING,
        MANIFEST_RUN_STATES.VERIFYING,
        MANIFEST_RUN_STATES.COMPLETED,
        MANIFEST_RUN_STATES.FAILED,
        MANIFEST_RUN_STATES.INDETERMINATE,
      ]).has(manifest.runState)) {
    fail(category, 'Write-started manifest lifecycle is inconsistent.', {})
  }

  const allOperationsTerminal = manifest.operations.every(operation =>
    operation.state === MANIFEST_OPERATION_STATES.VERIFIED ||
    operation.state === MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL,
  )
  const allBatchesVerified = manifest.batches.every(
    batch => batch.state === MANIFEST_BATCH_STATES.VERIFIED,
  )

  if (new Set([
    MANIFEST_RUN_STATES.VERIFYING,
    MANIFEST_RUN_STATES.COMPLETED,
  ]).has(manifest.runState) &&
      (!allOperationsTerminal || !allBatchesVerified ||
       manifest.inFlightBatchId !== null)) {
    fail(category, 'Verification lifecycle contains unfinished work.', {})
  }

  if (manifest.runState === MANIFEST_RUN_STATES.COMPLETED &&
      manifest.reconciliationSummary === null) {
    fail(category, 'Completed manifest requires reconciliationSummary.', {})
  }

  if (manifest.runState !== MANIFEST_RUN_STATES.COMPLETED &&
      manifest.reconciliationSummary !== null) {
    fail(category, 'Only a completed manifest may retain reconciliationSummary.', {})
  }

  if (manifest.runState === MANIFEST_RUN_STATES.COMPLETED &&
      (manifest.reconciliationSummary.mode !== MANIFEST_MODES.WRITE ||
       !manifest.reconciliationSummary.passed ||
       Object.values(manifest.reconciliationSummary.equality).some(
         result => !result,
       ))) {
    fail(category, 'Completed manifest requires a passing write reconciliation.', {})
  }
}

export function validateManifest(manifest, expectedIdentity) {
  const clone = canonicalClone(
    manifest,
    'manifest',
    MANIFEST_ERROR_CATEGORIES.INVALID_MANIFEST,
  )
  validateManifestStructure(
    clone,
    expectedIdentity,
    MANIFEST_ERROR_CATEGORIES.INVALID_MANIFEST,
  )
  return deepFreeze(clone)
}

function buildInitialOperation(operation, index) {
  if (!isRecord(operation)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_MANIFEST,
      `operations[${index}] must be an object.`,
      { field: `operations[${index}]` },
    )
  }

  exactKeys(operation, [
    'operationId',
    'type',
    'path',
    'expectedBeforeHash',
    'expectedAfterHash',
    'rollbackPreimage',
    'updateTimePrecondition',
    'state',
    'batchId',
  ], `operations[${index}]`, MANIFEST_ERROR_CATEGORIES.INVALID_MANIFEST)

  if (!new Set([
    MANIFEST_OPERATION_STATES.PLANNED,
    MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL,
  ]).has(operation.state)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_MANIFEST,
      'A fresh manifest operation must be planned or skipped_identical.',
      { operationId: operation.operationId },
    )
  }

  return { ...operation }
}

export function createPlannedManifest(options) {
  const category = MANIFEST_ERROR_CATEGORIES.INVALID_MANIFEST
  exactKeys(options, [
    'runId',
    'emulatorProjectId',
    'teacherUid',
    'classroomId',
    'createdAt',
    'immutableSourceChecksum',
    'foundationInvariantChecksum',
    'planChecksum',
    'batches',
    'operations',
    'orphanedCredentialPaths',
  ], 'options', category)

  if (!Array.isArray(options.batches) ||
      !Array.isArray(options.operations) ||
      !Array.isArray(options.orphanedCredentialPaths)) {
    fail(
      category,
      'options batches, operations, and orphanedCredentialPaths must be arrays.',
      {},
    )
  }

  const operations = options.operations.map(buildInitialOperation)
  const operationById = new Map(operations.map(operation => [
    operation.operationId,
    operation,
  ]))
  const batches = options.batches.map((batch, index) => {
    exactKeys(
      batch,
      ['batchId', 'operationIds'],
      `batches[${index}]`,
      category,
    )
    requireStringArray(
      batch.operationIds,
      `batches[${index}].operationIds`,
      category,
    )
    const operationIds = [...batch.operationIds]
    const allSkipped = operationIds.length > 0 && operationIds.every(
      operationId => operationById.get(operationId)?.state ===
        MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL,
    )

    return {
      batchId: batch.batchId,
      state: allSkipped
        ? MANIFEST_BATCH_STATES.VERIFIED
        : MANIFEST_BATCH_STATES.PENDING,
      operationIds,
    }
  })
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    migrationId: PHASE2A_MIGRATION_ID,
    runId: options.runId,
    mode: MANIFEST_MODES.DRY_RUN,
    emulatorProjectId: options.emulatorProjectId,
    teacherUid: options.teacherUid,
    classroomId: options.classroomId,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
    immutableSourceChecksum: options.immutableSourceChecksum,
    foundationInvariantChecksum: options.foundationInvariantChecksum,
    planChecksum: options.planChecksum,
    runState: MANIFEST_RUN_STATES.PLANNED,
    writePhaseStarted: false,
    inFlightBatchId: null,
    batches,
    operations,
    orphanedCredentialPaths: [...options.orphanedCredentialPaths],
    reconciliationSummary: null,
  }

  return trustManifest(validateManifest(manifest), { persistable: true })
}

function mutableManifest(manifest) {
  return JSON.parse(serializeCanonicalState(validateManifest(manifest)))
}

function requireTransitionAction(action, requiredKeys) {
  const category = MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION
  const clone = canonicalClone(action, 'transition', category)
  exactKeys(clone, requiredKeys, 'transition', category)

  if (!Object.values(MANIFEST_TRANSITIONS).includes(clone.type)) {
    fail(category, 'Unknown manifest transition.', { type: clone.type })
  }

  requireIsoTimestamp(clone.updatedAt, 'transition.updatedAt', category)
  return clone
}

function prepareTransition(manifest, action, requiredKeys) {
  const current = validateManifest(manifest)
  const transition = requireTransitionAction(action, requiredKeys)

  if (transition.updatedAt <= current.updatedAt) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Manifest transition updatedAt must advance monotonically.',
      { updatedAt: transition.updatedAt },
    )
  }

  const next = mutableManifest(current)
  MUTABLE_TRANSITION_PREDECESSORS.set(
    next,
    serializeCanonicalState(current),
  )

  return {
    current,
    next,
    transition,
  }
}

function batchFor(manifest, batchId) {
  const batch = manifest.batches.find(entry => entry.batchId === batchId)
  if (!batch) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Manifest transition references an unknown batch.',
      { batchId },
    )
  }
  return batch
}

function operationsFor(manifest, batch) {
  const byId = new Map(manifest.operations.map(operation => [
    operation.operationId,
    operation,
  ]))
  return batch.operationIds.map(operationId => byId.get(operationId))
}

function requireRunState(manifest, allowedStates, transitionType) {
  if (!allowedStates.includes(manifest.runState)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      `${transitionType} is not allowed from runState ${manifest.runState}.`,
      { runState: manifest.runState, transition: transitionType },
    )
  }
}

function finalizeTransition(next, updatedAt) {
  const predecessor = MUTABLE_TRANSITION_PREDECESSORS.get(next)

  if (predecessor === undefined) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Manifest transition predecessor is unavailable.',
      {},
    )
  }

  next.updatedAt = updatedAt
  return trustManifest(validateManifest(next), {
    persistable: true,
    predecessor,
  })
}

function transitionStartWrite(manifest, action) {
  const { current, next, transition } = prepareTransition(
    manifest,
    action,
    ['type', 'updatedAt'],
  )
  requireRunState(current, [MANIFEST_RUN_STATES.PLANNED], transition.type)

  if (current.writePhaseStarted || current.inFlightBatchId !== null) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Write phase can start only once from a clean planned manifest.',
      {},
    )
  }

  next.mode = MANIFEST_MODES.WRITE
  next.runState = MANIFEST_RUN_STATES.WRITING
  next.writePhaseStarted = true
  return finalizeTransition(next, transition.updatedAt)
}

function assertEarlierBatchesVerified(manifest, batchId) {
  const targetIndex = manifest.batches.findIndex(batch =>
    batch.batchId === batchId,
  )

  if (targetIndex === -1) {
    batchFor(manifest, batchId)
  }

  const unresolvedEarlier = manifest.batches
    .slice(0, targetIndex)
    .find(batch => batch.state !== MANIFEST_BATCH_STATES.VERIFIED)

  if (unresolvedEarlier) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Batches must advance and recover in manifest order.',
      { batchId, unresolvedBatchId: unresolvedEarlier.batchId },
    )
  }
}

function transitionStartBatch(manifest, action) {
  const { current, next, transition } = prepareTransition(
    manifest,
    action,
    ['type', 'updatedAt', 'batchId'],
  )
  requireCanonicalString(
    transition.batchId,
    'transition.batchId',
    MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
  )
  requireRunState(current, [MANIFEST_RUN_STATES.WRITING], transition.type)

  if (!current.writePhaseStarted || current.inFlightBatchId !== null) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'A batch cannot start before the durable write boundary or beside another batch.',
      { batchId: transition.batchId },
    )
  }

  assertEarlierBatchesVerified(current, transition.batchId)
  const batch = batchFor(next, transition.batchId)

  if (batch.state !== MANIFEST_BATCH_STATES.PENDING) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Only a pending batch can enter in_flight.',
      { batchId: batch.batchId, state: batch.state },
    )
  }

  const operations = operationsFor(next, batch)
  if (!operations.some(
    operation => operation.state === MANIFEST_OPERATION_STATES.PLANNED,
  )) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'A batch with no planned operations cannot enter in_flight.',
      { batchId: batch.batchId },
    )
  }

  for (const operation of operations) {
    if (operation.state === MANIFEST_OPERATION_STATES.PLANNED) {
      operation.state = MANIFEST_OPERATION_STATES.IN_FLIGHT
    }
  }
  batch.state = MANIFEST_BATCH_STATES.IN_FLIGHT
  next.inFlightBatchId = batch.batchId
  return finalizeTransition(next, transition.updatedAt)
}

function transitionCommitBatch(manifest, action) {
  const { current, next, transition } = prepareTransition(
    manifest,
    action,
    ['type', 'updatedAt', 'batchId'],
  )
  requireRunState(current, [MANIFEST_RUN_STATES.WRITING], transition.type)
  const batch = batchFor(next, transition.batchId)

  if (current.inFlightBatchId !== batch.batchId ||
      batch.state !== MANIFEST_BATCH_STATES.IN_FLIGHT) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Only the active in-flight batch can be marked committed.',
      { batchId: batch.batchId },
    )
  }

  for (const operation of operationsFor(next, batch)) {
    if (operation.state === MANIFEST_OPERATION_STATES.IN_FLIGHT) {
      operation.state = MANIFEST_OPERATION_STATES.COMMITTED
    }
  }
  batch.state = MANIFEST_BATCH_STATES.COMMITTED
  return finalizeTransition(next, transition.updatedAt)
}

function transitionVerifyBatch(manifest, action) {
  const { current, next, transition } = prepareTransition(
    manifest,
    action,
    ['type', 'updatedAt', 'batchId'],
  )
  requireRunState(current, [MANIFEST_RUN_STATES.WRITING], transition.type)
  const batch = batchFor(next, transition.batchId)

  if (current.inFlightBatchId !== batch.batchId ||
      batch.state !== MANIFEST_BATCH_STATES.COMMITTED) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Only the active committed batch can be marked verified.',
      { batchId: batch.batchId },
    )
  }

  for (const operation of operationsFor(next, batch)) {
    if (operation.state === MANIFEST_OPERATION_STATES.COMMITTED) {
      operation.state = MANIFEST_OPERATION_STATES.VERIFIED
    }
  }
  batch.state = MANIFEST_BATCH_STATES.VERIFIED
  next.inFlightBatchId = null
  return finalizeTransition(next, transition.updatedAt)
}

function transitionStartVerification(manifest, action) {
  const { current, next, transition } = prepareTransition(
    manifest,
    action,
    ['type', 'updatedAt'],
  )
  requireRunState(current, [
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.FAILED,
    MANIFEST_RUN_STATES.INDETERMINATE,
  ], transition.type)

  if (current.inFlightBatchId !== null || current.batches.some(
    batch => batch.state !== MANIFEST_BATCH_STATES.VERIFIED,
  )) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Verification cannot start until every batch is verified.',
      {},
    )
  }

  next.runState = MANIFEST_RUN_STATES.VERIFYING
  return finalizeTransition(next, transition.updatedAt)
}

function transitionComplete(manifest, action) {
  const { current, next, transition } = prepareTransition(
    manifest,
    action,
    ['type', 'updatedAt', 'reconciliationSummary'],
  )
  requireRunState(current, [MANIFEST_RUN_STATES.VERIFYING], transition.type)

  if (!isRecord(transition.reconciliationSummary)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Completion requires a reconciliation summary object.',
      {},
    )
  }

  validateReconciliationSummary(
    transition.reconciliationSummary,
    MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
  )

  if (transition.reconciliationSummary.mode !== MANIFEST_MODES.WRITE ||
      !transition.reconciliationSummary.passed ||
      Object.values(transition.reconciliationSummary.equality).some(
        result => !result,
      )) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Completion requires a passing write reconciliation.',
      {},
    )
  }

  next.reconciliationSummary = transition.reconciliationSummary
  next.runState = MANIFEST_RUN_STATES.COMPLETED
  return finalizeTransition(next, transition.updatedAt)
}

function transitionFail(manifest, action) {
  const { current, next, transition } = prepareTransition(
    manifest,
    action,
    ['type', 'updatedAt'],
  )
  requireRunState(current, [
    MANIFEST_RUN_STATES.PLANNED,
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.VERIFYING,
  ], transition.type)

  next.runState = MANIFEST_RUN_STATES.FAILED
  return finalizeTransition(next, transition.updatedAt)
}

function transitionFailBatch(manifest, action) {
  const { current, next, transition } = prepareTransition(
    manifest,
    action,
    ['type', 'updatedAt', 'batchId', 'error'],
  )
  requireRunState(current, [MANIFEST_RUN_STATES.WRITING], transition.type)
  requireErrorMetadata(
    transition.error,
    'transition.error',
    MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
  )
  const batch = batchFor(next, transition.batchId)

  if (!current.writePhaseStarted ||
      current.inFlightBatchId !== batch.batchId ||
      batch.state !== MANIFEST_BATCH_STATES.IN_FLIGHT) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Only the active in-flight batch can fail clearly.',
      { batchId: batch.batchId },
    )
  }

  for (const operation of operationsFor(next, batch)) {
    if (operation.state === MANIFEST_OPERATION_STATES.IN_FLIGHT) {
      operation.state = MANIFEST_OPERATION_STATES.FAILED
      operation.error = transition.error
    }
  }
  batch.state = MANIFEST_BATCH_STATES.FAILED
  next.runState = MANIFEST_RUN_STATES.FAILED
  return finalizeTransition(next, transition.updatedAt)
}

function transitionMarkIndeterminate(manifest, action) {
  const { current, next, transition } = prepareTransition(
    manifest,
    action,
    ['type', 'updatedAt', 'batchId', 'error'],
  )
  requireRunState(current, [
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.INDETERMINATE,
  ], transition.type)
  requireErrorMetadata(
    transition.error,
    'transition.error',
    MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
  )
  const batch = batchFor(next, transition.batchId)

  if (!current.writePhaseStarted ||
      current.inFlightBatchId !== batch.batchId ||
      !new Set([
        MANIFEST_BATCH_STATES.IN_FLIGHT,
        MANIFEST_BATCH_STATES.COMMITTED,
        MANIFEST_BATCH_STATES.INDETERMINATE,
      ]).has(batch.state)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Only the active uncertain batch can become indeterminate.',
      { batchId: batch.batchId },
    )
  }

  for (const operation of operationsFor(next, batch)) {
    if (!new Set([
      MANIFEST_OPERATION_STATES.VERIFIED,
      MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL,
    ]).has(operation.state)) {
      operation.state = MANIFEST_OPERATION_STATES.INDETERMINATE
      operation.error = transition.error
    }
  }
  batch.state = MANIFEST_BATCH_STATES.INDETERMINATE
  next.runState = MANIFEST_RUN_STATES.INDETERMINATE
  return finalizeTransition(next, transition.updatedAt)
}

function prepareRecovery(manifest, action, requiredKeys) {
  const prepared = prepareTransition(manifest, action, requiredKeys)
  const { current, transition } = prepared
  requireRunState(current, [
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.VERIFYING,
    MANIFEST_RUN_STATES.FAILED,
    MANIFEST_RUN_STATES.INDETERMINATE,
  ], transition.type)

  if (!current.writePhaseStarted) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Restart recovery requires writePhaseStarted.',
      {},
    )
  }

  assertEarlierBatchesVerified(current, transition.batchId)
  const batch = batchFor(prepared.next, transition.batchId)
  if (batch.state === MANIFEST_BATCH_STATES.VERIFIED) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'A verified batch is not a recovery candidate.',
      { batchId: batch.batchId },
    )
  }

  return { ...prepared, batch }
}

function refreshRecoveryPreconditions(
  operations,
  preconditions,
  category,
) {
  if (!isRecord(preconditions)) {
    fail(category, 'Fresh preconditions must be an operationId map.', {})
  }

  const expectedIds = operations
    .filter(operation => operation.type !== MANIFEST_OPERATION_TYPES.CREATE)
    .map(operation => operation.operationId)
    .sort()
  const actualIds = Object.keys(preconditions).sort()

  if (!isDeepStrictEqual(actualIds, expectedIds)) {
    fail(
      category,
      'Fresh preconditions must cover exactly the recovered update operations.',
      { expectedOperationIds: expectedIds },
    )
  }

  for (const operation of operations) {
    if (operation.type !== MANIFEST_OPERATION_TYPES.CREATE) {
      requireEncodedTimestamp(
        preconditions[operation.operationId],
        `freshUpdateTimePreconditions.${operation.operationId}`,
        category,
      )
      operation.updateTimePrecondition = preconditions[operation.operationId]
    }
  }
}

function clearOperationError(operation) {
  delete operation.error
}

function isTerminalOperation(operation) {
  return operation.state === MANIFEST_OPERATION_STATES.VERIFIED ||
    operation.state === MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL
}

function finishRecovery(next, batch, updatedAt) {
  if (next.inFlightBatchId === batch.batchId) {
    next.inFlightBatchId = null
  }
  next.runState = MANIFEST_RUN_STATES.WRITING
  return finalizeTransition(next, updatedAt)
}

function transitionRecoverBefore(manifest, action) {
  const { next, transition, batch } = prepareRecovery(
    manifest,
    action,
    ['type', 'updatedAt', 'batchId', 'freshUpdateTimePreconditions'],
  )
  const batchOperations = operationsFor(next, batch)

  const terminalOperation = batchOperations.find(isTerminalOperation)
  if (terminalOperation) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'A batch containing terminal operations cannot be wholly before-state.',
      {
        batchId: batch.batchId,
        operationId: terminalOperation.operationId,
        operationState: terminalOperation.state,
      },
    )
  }

  const operations = batchOperations
  refreshRecoveryPreconditions(
    operations,
    transition.freshUpdateTimePreconditions,
    MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
  )

  for (const operation of operations) {
    operation.state = MANIFEST_OPERATION_STATES.PLANNED
    clearOperationError(operation)
  }
  batch.state = MANIFEST_BATCH_STATES.PENDING
  return finishRecovery(next, batch, transition.updatedAt)
}

function transitionRecoverAfter(manifest, action) {
  const { next, transition, batch } = prepareRecovery(
    manifest,
    action,
    ['type', 'updatedAt', 'batchId'],
  )

  for (const operation of operationsFor(next, batch)) {
    if (operation.state !== MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL) {
      operation.state = MANIFEST_OPERATION_STATES.VERIFIED
      clearOperationError(operation)
    }
  }
  batch.state = MANIFEST_BATCH_STATES.VERIFIED
  return finishRecovery(next, batch, transition.updatedAt)
}

function transitionRecoverMixed(manifest, action) {
  const { next, transition, batch } = prepareRecovery(
    manifest,
    action,
    [
      'type',
      'updatedAt',
      'batchId',
      'beforeOperationIds',
      'afterOperationIds',
      'freshUpdateTimePreconditions',
    ],
  )
  const category = MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION
  requireStringArray(
    transition.beforeOperationIds,
    'transition.beforeOperationIds',
    category,
  )
  requireStringArray(
    transition.afterOperationIds,
    'transition.afterOperationIds',
    category,
  )

  if (transition.beforeOperationIds.length === 0 ||
      transition.afterOperationIds.length === 0) {
    fail(category, 'Mixed recovery requires both before and after operations.', {})
  }

  const classifiedIds = [
    ...transition.beforeOperationIds,
    ...transition.afterOperationIds,
  ].sort()
  const expectedIds = [...batch.operationIds].sort()

  if (!isDeepStrictEqual(classifiedIds, expectedIds)) {
    fail(category, 'Mixed recovery must classify every operation exactly once.', {
      batchId: batch.batchId,
    })
  }

  const beforeIds = new Set(transition.beforeOperationIds)
  const afterIds = new Set(transition.afterOperationIds)
  if ([...beforeIds].some(operationId => afterIds.has(operationId))) {
    fail(category, 'Mixed recovery operation classifications overlap.', {})
  }

  const operations = operationsFor(next, batch)
  const beforeOperations = operations.filter(operation =>
    beforeIds.has(operation.operationId),
  )

  const terminalBeforeOperation = beforeOperations.find(isTerminalOperation)
  if (terminalBeforeOperation) {
    fail(
      category,
      'A terminal operation cannot be reclassified as before-state.',
      {
        operationId: terminalBeforeOperation.operationId,
        operationState: terminalBeforeOperation.state,
      },
    )
  }

  refreshRecoveryPreconditions(
    beforeOperations,
    transition.freshUpdateTimePreconditions,
    category,
  )

  for (const operation of operations) {
    if (beforeIds.has(operation.operationId)) {
      operation.state = MANIFEST_OPERATION_STATES.PLANNED
      clearOperationError(operation)
    } else if (operation.state !== MANIFEST_OPERATION_STATES.SKIPPED_IDENTICAL) {
      operation.state = MANIFEST_OPERATION_STATES.VERIFIED
      clearOperationError(operation)
    }
  }
  batch.state = MANIFEST_BATCH_STATES.PENDING
  return finishRecovery(next, batch, transition.updatedAt)
}

function transitionRecoverDivergent(manifest, action) {
  const { next, transition, batch } = prepareRecovery(
    manifest,
    action,
    ['type', 'updatedAt', 'batchId', 'operationIds', 'error'],
  )
  const category = MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION
  requireStringArray(
    transition.operationIds,
    'transition.operationIds',
    category,
  )
  requireErrorMetadata(transition.error, 'transition.error', category)

  if (transition.operationIds.length === 0 ||
      transition.operationIds.some(operationId =>
        !batch.operationIds.includes(operationId),
      )) {
    fail(category, 'Divergent recovery must identify affected batch operations.', {
      batchId: batch.batchId,
    })
  }

  const divergentIds = new Set(transition.operationIds)
  const operations = operationsFor(next, batch)
  const terminalDivergentOperation = operations.find(operation =>
    divergentIds.has(operation.operationId) && isTerminalOperation(operation),
  )
  if (terminalDivergentOperation) {
    fail(
      category,
      'A terminal operation cannot be reclassified as divergent.',
      {
        operationId: terminalDivergentOperation.operationId,
        operationState: terminalDivergentOperation.state,
      },
    )
  }

  for (const operation of operations) {
    if (divergentIds.has(operation.operationId)) {
      operation.state = MANIFEST_OPERATION_STATES.FAILED
      operation.error = transition.error
    }
  }
  batch.state = MANIFEST_BATCH_STATES.FAILED
  if (next.inFlightBatchId === batch.batchId) {
    next.inFlightBatchId = null
  }
  next.runState = MANIFEST_RUN_STATES.FAILED
  return finalizeTransition(next, transition.updatedAt)
}

export function transitionManifest(manifest, action) {
  if (!TRUSTED_MANIFESTS.has(manifest)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Transitions require a manifest created or read by this module.',
      {},
    )
  }

  if (!isRecord(action) || typeof action.type !== 'string') {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Manifest transition action with a type is required.',
      {},
    )
  }

  switch (action.type) {
    case MANIFEST_TRANSITIONS.START_WRITE:
      return transitionStartWrite(manifest, action)
    case MANIFEST_TRANSITIONS.START_BATCH:
      return transitionStartBatch(manifest, action)
    case MANIFEST_TRANSITIONS.COMMIT_BATCH:
      return transitionCommitBatch(manifest, action)
    case MANIFEST_TRANSITIONS.VERIFY_BATCH:
      return transitionVerifyBatch(manifest, action)
    case MANIFEST_TRANSITIONS.START_VERIFICATION:
      return transitionStartVerification(manifest, action)
    case MANIFEST_TRANSITIONS.COMPLETE:
      return transitionComplete(manifest, action)
    case MANIFEST_TRANSITIONS.FAIL:
      return transitionFail(manifest, action)
    case MANIFEST_TRANSITIONS.FAIL_BATCH:
      return transitionFailBatch(manifest, action)
    case MANIFEST_TRANSITIONS.MARK_INDETERMINATE:
      return transitionMarkIndeterminate(manifest, action)
    case MANIFEST_TRANSITIONS.RECOVER_BATCH_BEFORE:
      return transitionRecoverBefore(manifest, action)
    case MANIFEST_TRANSITIONS.RECOVER_BATCH_AFTER:
      return transitionRecoverAfter(manifest, action)
    case MANIFEST_TRANSITIONS.RECOVER_BATCH_MIXED:
      return transitionRecoverMixed(manifest, action)
    case MANIFEST_TRANSITIONS.RECOVER_BATCH_DIVERGENT:
      return transitionRecoverDivergent(manifest, action)
    default:
      fail(
        MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
        'Unknown manifest transition.',
        { type: action.type },
      )
  }
}

export function listRecoveryBatchIds(manifest) {
  const current = validateManifest(manifest)
  requireRunState(current, [
    MANIFEST_RUN_STATES.WRITING,
    MANIFEST_RUN_STATES.VERIFYING,
    MANIFEST_RUN_STATES.FAILED,
    MANIFEST_RUN_STATES.INDETERMINATE,
  ], 'list-recovery-batches')

  if (!current.writePhaseStarted) {
    fail(
      MANIFEST_ERROR_CATEGORIES.INVALID_TRANSITION,
      'Restart recovery requires writePhaseStarted.',
      {},
    )
  }

  return Object.freeze(current.batches
    .filter(batch => batch.state !== MANIFEST_BATCH_STATES.VERIFIED)
    .map(batch => batch.batchId))
}

function immutableManifestIdentity(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    migrationId: manifest.migrationId,
    runId: manifest.runId,
    emulatorProjectId: manifest.emulatorProjectId,
    teacherUid: manifest.teacherUid,
    classroomId: manifest.classroomId,
    createdAt: manifest.createdAt,
    immutableSourceChecksum: manifest.immutableSourceChecksum,
    foundationInvariantChecksum: manifest.foundationInvariantChecksum,
    planChecksum: manifest.planChecksum,
    batches: manifest.batches.map(batch => ({
      batchId: batch.batchId,
      operationIds: batch.operationIds,
    })),
    operations: manifest.operations.map(operation => ({
      operationId: operation.operationId,
      type: operation.type,
      path: operation.path,
      expectedBeforeHash: operation.expectedBeforeHash,
      expectedAfterHash: operation.expectedAfterHash,
      rollbackPreimage: operation.rollbackPreimage,
      batchId: operation.batchId,
    })),
    orphanedCredentialPaths: manifest.orphanedCredentialPaths,
  }
}

function assertSameRunAdvance(existing, candidate) {
  if (candidate.updatedAt <= existing.updatedAt) {
    fail(
      MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
      'Manifest updatedAt must advance on every durable update.',
      {},
    )
  }

  if (!isDeepStrictEqual(
    immutableManifestIdentity(candidate),
    immutableManifestIdentity(existing),
  )) {
    fail(
      MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
      'A retained manifest immutable plan identity cannot change.',
      {},
    )
  }

  if (existing.writePhaseStarted && !candidate.writePhaseStarted) {
    fail(
      MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
      'writePhaseStarted is monotonic and cannot return to false.',
      {},
    )
  }

  if (existing.mode === MANIFEST_MODES.WRITE &&
      candidate.mode !== MANIFEST_MODES.WRITE) {
    fail(
      MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
      'Manifest mode cannot return from write to dry-run.',
      {},
    )
  }

  if (existing.runState === MANIFEST_RUN_STATES.COMPLETED) {
    fail(
      MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
      'A completed manifest is read-only and cannot be rewritten.',
      {},
    )
  }

  if (!RUN_STATE_ADVANCES[existing.runState].has(candidate.runState)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
      'Manifest runState does not follow an allowed lifecycle advance.',
      { from: existing.runState, to: candidate.runState },
    )
  }

  for (let index = 0; index < existing.operations.length; index += 1) {
    const previous = existing.operations[index]
    const next = candidate.operations[index]
    const preconditionChanged = !isDeepStrictEqual(
      previous.updateTimePrecondition,
      next.updateTimePrecondition,
    )

    if (preconditionChanged &&
        (!existing.writePhaseStarted || !candidate.writePhaseStarted ||
         next.state !== MANIFEST_OPERATION_STATES.PLANNED ||
         next.type === MANIFEST_OPERATION_TYPES.CREATE)) {
      fail(
        MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
        'Update-time preconditions may change only during write-started recovery.',
        { operationId: next.operationId },
      )
    }
  }
}

function assertPersistable(existing, candidate) {
  if (existing === null) {
    if (candidate.runState !== MANIFEST_RUN_STATES.PLANNED ||
        candidate.writePhaseStarted) {
      fail(
        MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
        'A new canonical slot must begin with a successful planned dry run.',
        {},
      )
    }
    return
  }

  if (existing.runId === candidate.runId) {
    assertSameRunAdvance(existing, candidate)
    return
  }

  if (existing.runState !== MANIFEST_RUN_STATES.FAILED ||
      existing.writePhaseStarted ||
      candidate.runState !== MANIFEST_RUN_STATES.PLANNED ||
      candidate.writePhaseStarted) {
    fail(
      MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
      'The retained canonical manifest cannot be replaced by a new run.',
      {},
    )
  }
}

async function readManifestAtSlot(slot, expectedIdentity) {
  let serialized

  try {
    serialized = await readFile(slot.manifestPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    fail(
      MANIFEST_ERROR_CATEGORIES.READ_FAILED,
      'The canonical manifest could not be read.',
      { manifestPath: slot.manifestPath },
      error,
    )
  }

  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    fail(
      MANIFEST_ERROR_CATEGORIES.READ_FAILED,
      'The canonical manifest contains malformed JSON.',
      { manifestPath: slot.manifestPath },
      error,
    )
  }

  let manifest
  try {
    manifest = validateManifest(parsed, expectedIdentity)
  } catch (error) {
    fail(
      MANIFEST_ERROR_CATEGORIES.READ_FAILED,
      'The canonical manifest failed schema or identity validation.',
      { manifestPath: slot.manifestPath },
      error,
    )
  }

  if (serialized !== serializeCanonicalState(manifest)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.READ_FAILED,
      'The canonical manifest file is not in canonical serialized form.',
      { manifestPath: slot.manifestPath },
    )
  }

  return trustManifest(manifest)
}

export async function readCanonicalManifest(identity) {
  const slot = deriveCanonicalManifestSlot(identity)
  return readManifestAtSlot(slot, identity)
}

async function syncStateDirectory(stateDirectory) {
  let directoryHandle

  try {
    directoryHandle = await open(stateDirectory, 'r')
    await directoryHandle.sync()
  } catch (error) {
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS'])
      .has(error?.code)
    const unsupportedOnWindows = process.platform === 'win32' &&
      new Set(['EISDIR', 'EPERM']).has(error?.code)

    if (!unsupported && !unsupportedOnWindows) {
      throw error
    }
  } finally {
    await directoryHandle?.close()
  }
}

export async function writeCanonicalManifest(manifest) {
  if (!PERSISTABLE_PREDECESSORS.has(manifest)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
      'Only a manifest produced by the planner or state machine can be persisted.',
      {},
    )
  }

  const candidate = validateManifest(manifest)
  const identity = {
    emulatorProjectId: candidate.emulatorProjectId,
    teacherUid: candidate.teacherUid,
  }
  const slot = deriveCanonicalManifestSlot(identity)
  const existing = await readManifestAtSlot(slot, identity)
  const predecessor = PERSISTABLE_PREDECESSORS.get(manifest)

  if (predecessor !== FRESH_PLANNED_PREDECESSOR &&
      (existing === null ||
       serializeCanonicalState(existing) !== predecessor)) {
    fail(
      MANIFEST_ERROR_CATEGORIES.REPLACEMENT_BLOCKED,
      'The retained manifest changed after this transition was derived.',
      { manifestPath: slot.manifestPath },
    )
  }

  assertPersistable(existing, candidate)

  const serialized = serializeCanonicalState(candidate)
  const temporaryPath = path.join(
    slot.stateDirectory,
    `${slot.filename}.${randomUUID()}.tmp`,
  )
  let fileHandle

  try {
    await mkdir(slot.stateDirectory, { recursive: true, mode: 0o700 })
    fileHandle = await open(temporaryPath, 'wx', 0o600)
    await fileHandle.writeFile(serialized, 'utf8')
    await fileHandle.sync()
    await fileHandle.close()
    fileHandle = undefined
    await rename(temporaryPath, slot.manifestPath)
    await syncStateDirectory(slot.stateDirectory)
  } catch (error) {
    try {
      await fileHandle?.close()
    } catch {
      // The original durability failure remains the blocking cause.
    }

    fail(
      MANIFEST_ERROR_CATEGORIES.WRITE_FAILED,
      'The canonical manifest could not be durably persisted.',
      {
        manifestPath: slot.manifestPath,
        temporaryPath,
      },
      error,
    )
  }

  return trustManifest(candidate)
}
