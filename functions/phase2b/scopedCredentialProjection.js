import { createHash } from 'node:crypto'
import {
  normalizeStudentLoginId,
  validateCanonicalDocumentId,
} from './identityNormalization.js'
import {
  STUDENT_CREDENTIAL_COLLECTIONS,
  studentCredentialPath,
} from './studentCredentialPaths.js'

/**
 * Emulator-only projection of flat legacy `studentCredentials/{loginId}`
 * documents onto the Phase 2B scoped path
 * `classrooms/{classroomId}/studentCredentials/{loginId}`.
 *
 * The projection is deliberately fail-closed: every accepted source envelope
 * must look exactly like an untouched flat legacy credential read with the
 * Admin SDK (canonical document ID, flat `studentCredentials/{id}` path,
 * Firestore `updateTime` metadata, a plain credential map, and a legacy
 * `classroomId` that is *not* the scoped target). Anything ambiguous is
 * rejected rather than migrated, because a wrong projection would silently
 * re-key a credential or alias two students onto one Firebase Auth identity.
 */

const SOURCE_ENVELOPE_KEYS = Object.freeze([
  'id',
  'loginId',
  'path',
  'data',
  'createTime',
  'updateTime',
  'readTime',
])

const TARGET_ENVELOPE_KEYS = Object.freeze([
  'id',
  'path',
  'data',
  'createTime',
  'updateTime',
  'readTime',
])

export class ScopedCredentialProjectionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ScopedCredentialProjectionError'
    this.code = code
  }
}

export function deriveDeterministicStudentAuthUid(classroomId, studentId) {
  const validClassroomId = validateCanonicalDocumentId(classroomId, 'classroomId')
  const validStudentId = validateCanonicalDocumentId(studentId, 'studentId')

  const digest = createHash('sha256')
    .update(`${validClassroomId}\0${validStudentId}`, 'utf8')
    .digest('base64url')

  return `s_${digest}`
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Firestore timestamps arrive either as `Date` (test/emulator fixtures) or as
 * an Admin SDK `Timestamp`. A plain `{ seconds, nanoseconds }` map is a map,
 * not a timestamp, so a `toMillis` method is required before either side is
 * treated as time — otherwise a stored map could compare equal to a real
 * timestamp and a divergent credential would pass the rerun check.
 */
function timestampParts(value) {
  if (value instanceof Date) {
    const millis = value.getTime()
    if (!Number.isFinite(millis)) {
      return null
    }
    const seconds = Math.floor(millis / 1000)
    return { seconds, nanoseconds: (millis - seconds * 1000) * 1e6 }
  }

  if (typeof value !== 'object' || value === null) {
    return null
  }
  if (typeof value.toMillis !== 'function') {
    return null
  }

  const seconds = typeof value.seconds === 'number'
    ? value.seconds
    : (typeof value._seconds === 'number' ? value._seconds : null)
  const nanoseconds = typeof value.nanoseconds === 'number'
    ? value.nanoseconds
    : (typeof value._nanoseconds === 'number' ? value._nanoseconds : null)

  if (seconds === null || nanoseconds === null) {
    return null
  }
  return { seconds, nanoseconds }
}

function byteViewOf(value) {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value && typeof value.toUint8Array === 'function') {
    try {
      const bytes = value.toUint8Array()
      return bytes instanceof Uint8Array ? bytes : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Value equality for exact rerun/divergence checks. Unrecognized value kinds
 * deliberately compare unequal: reporting a false divergence is recoverable,
 * silently accepting a divergent credential as parity is not.
 */
export function firestoreValuesEqual(left, right) {
  if (Object.is(left, right)) {
    return true
  }

  const leftTime = timestampParts(left)
  const rightTime = timestampParts(right)
  if (leftTime || rightTime) {
    return Boolean(
      leftTime &&
      rightTime &&
      leftTime.seconds === rightTime.seconds &&
      leftTime.nanoseconds === rightTime.nanoseconds,
    )
  }

  const leftBytes = byteViewOf(left)
  const rightBytes = byteViewOf(right)
  if (leftBytes || rightBytes) {
    if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length) {
      return false
    }
    for (let index = 0; index < leftBytes.length; index += 1) {
      if (leftBytes[index] !== rightBytes[index]) {
        return false
      }
    }
    return true
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false
    }
    if (left.length !== right.length) {
      return false
    }
    return left.every((value, index) => firestoreValuesEqual(value, right[index]))
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) {
      return false
    }
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) {
        return false
      }
      if (!firestoreValuesEqual(left[key], right[key])) {
        return false
      }
    }
    return true
  }

  // GeoPoint / DocumentReference / Bytes style Firestore values.
  if (
    left && right &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    typeof left.isEqual === 'function'
  ) {
    return left.isEqual(right) === true
  }

  return false
}

function requireAllowedKeys(envelope, allowedKeys, code, label) {
  for (const key of Object.keys(envelope)) {
    if (!allowedKeys.includes(key)) {
      throw new ScopedCredentialProjectionError(
        code,
        `${label} contains an unsupported field.`,
      )
    }
  }
}

export function projectScopedCredential(sourceEnvelope, targetClassroomId, options = {}) {
  const validTargetClassroomId = validateCanonicalDocumentId(
    targetClassroomId,
    'targetClassroomId',
  )

  if (!isPlainObject(sourceEnvelope)) {
    throw new ScopedCredentialProjectionError(
      'malformed-envelope',
      'Source envelope must be a plain object.',
    )
  }
  requireAllowedKeys(
    sourceEnvelope,
    SOURCE_ENVELOPE_KEYS,
    'malformed-envelope',
    'Source envelope',
  )

  const rawId = sourceEnvelope.id
  if (typeof rawId !== 'string' || !rawId) {
    throw new ScopedCredentialProjectionError(
      'malformed-envelope',
      'Source envelope must specify the flat credential document ID.',
    )
  }

  let canonicalLoginId
  try {
    canonicalLoginId = normalizeStudentLoginId(rawId)
  } catch (error) {
    throw new ScopedCredentialProjectionError(
      'malformed-envelope',
      `Invalid login ID in source envelope: ${error.message}`,
    )
  }

  // A source document ID that merely *normalizes* to a canonical login ID is a
  // different document than the canonical one, so projecting it would silently
  // re-key the credential.
  if (rawId !== canonicalLoginId) {
    throw new ScopedCredentialProjectionError(
      'noncanonical-login-id',
      'Source credential document ID is not already in canonical form.',
    )
  }

  if (
    sourceEnvelope.loginId !== undefined &&
    sourceEnvelope.loginId !== canonicalLoginId
  ) {
    throw new ScopedCredentialProjectionError(
      'noncanonical-login-id',
      'Source envelope loginId does not match the canonical document ID.',
    )
  }

  const expectedSourcePath =
    `${STUDENT_CREDENTIAL_COLLECTIONS.STUDENT_CREDENTIALS}/${canonicalLoginId}`
  if (
    typeof sourceEnvelope.path !== 'string' ||
    sourceEnvelope.path !== expectedSourcePath
  ) {
    throw new ScopedCredentialProjectionError(
      'malformed-source-path',
      'Source envelope path must be the flat studentCredentials document for this login ID.',
    )
  }

  // Phase 3's production runner copies credentials under update-time/checksum
  // preconditions, so the projection refuses sources with no read metadata.
  if (sourceEnvelope.updateTime === undefined || sourceEnvelope.updateTime === null) {
    throw new ScopedCredentialProjectionError(
      'missing-source-update-time',
      'Source envelope must carry Firestore updateTime metadata.',
    )
  }

  const data = sourceEnvelope.data
  if (!isPlainObject(data)) {
    throw new ScopedCredentialProjectionError(
      'malformed-envelope',
      'Source envelope data must be a plain credential map.',
    )
  }

  const studentId = data.studentId
  try {
    validateCanonicalDocumentId(studentId, 'studentId')
  } catch (error) {
    throw new ScopedCredentialProjectionError(
      'malformed-student-id',
      `Invalid student ID in credential data: ${error.message}`,
    )
  }

  if (data.loginId !== undefined && data.loginId !== canonicalLoginId) {
    throw new ScopedCredentialProjectionError(
      'source-login-id-mismatch',
      'Source credential body loginId does not match its document ID.',
    )
  }

  const sourceClassroomId = data.classroomId
  if (typeof sourceClassroomId !== 'string' || !sourceClassroomId) {
    throw new ScopedCredentialProjectionError(
      'missing-source-classroom-id',
      'Flat source credential must carry its legacy classroomId.',
    )
  }
  try {
    validateCanonicalDocumentId(sourceClassroomId, 'sourceClassroomId')
  } catch (error) {
    throw new ScopedCredentialProjectionError(
      'malformed-classroom-id',
      `Invalid classroom ID in source credential data: ${error.message}`,
    )
  }
  // The flat legacy source must still hold its untouched legacy classroom
  // value. A source already carrying the scoped target ID is not a legacy
  // rollback artifact and must not be treated as one.
  if (sourceClassroomId === validTargetClassroomId) {
    throw new ScopedCredentialProjectionError(
      'source-classroom-mismatch',
      'Flat source credential already carries the target classroom ID.',
    )
  }

  const newAuthUid = deriveDeterministicStudentAuthUid(
    validTargetClassroomId,
    studentId,
  )

  const targetPath = studentCredentialPath(
    validTargetClassroomId,
    canonicalLoginId,
  )

  // Every source field survives; only the tenant classroom value and the
  // deterministic V2 Auth UID are replaced.
  const projectedData = {
    ...data,
    classroomId: validTargetClassroomId,
    authUid: newAuthUid,
  }

  if (options.rosterStudentIds !== undefined && !Array.isArray(options.rosterStudentIds)) {
    throw new ScopedCredentialProjectionError(
      'malformed-roster',
      'rosterStudentIds must be an array when provided.',
    )
  }

  const isOrphaned =
    data.isOrphaned === true ||
    data.orphaned === true ||
    (Array.isArray(options.rosterStudentIds) &&
      !options.rosterStudentIds.includes(studentId))

  const uidMapping = Object.freeze({
    oldAuthUid: typeof data.authUid === 'string' ? data.authUid : null,
    newAuthUid,
    classroomId: validTargetClassroomId,
    studentId,
  })

  // Claims resolve to the same classroom/student identity the UID was derived
  // from; this catches an accidental mapping edit rather than trusting it.
  const expectedAuthUid = deriveDeterministicStudentAuthUid(
    uidMapping.classroomId,
    uidMapping.studentId,
  )
  if (uidMapping.newAuthUid !== expectedAuthUid) {
    throw new ScopedCredentialProjectionError(
      'auth-uid-claims-mismatch',
      'New auth UID does not match claims identity.',
    )
  }

  return Object.freeze({
    targetPath,
    sourcePath: expectedSourcePath,
    sourceClassroomId,
    sourceUpdateTime: sourceEnvelope.updateTime,
    projectedData: Object.freeze(projectedData),
    uidMapping,
    isOrphaned,
    loginId: canonicalLoginId,
    studentId,
  })
}

function indexTargetEnvelopes(targets) {
  const targetsByPath = new Map()

  for (const targetDoc of targets) {
    if (!isPlainObject(targetDoc)) {
      throw new ScopedCredentialProjectionError(
        'malformed-target-envelope',
        'Target envelope must be a plain object.',
      )
    }
    requireAllowedKeys(
      targetDoc,
      TARGET_ENVELOPE_KEYS,
      'malformed-target-envelope',
      'Target envelope',
    )
    if (typeof targetDoc.path !== 'string' || !targetDoc.path) {
      throw new ScopedCredentialProjectionError(
        'malformed-target-envelope',
        'Target envelope must specify its scoped document path.',
      )
    }
    if (!isPlainObject(targetDoc.data)) {
      throw new ScopedCredentialProjectionError(
        'malformed-target-envelope',
        'Target envelope data must be a plain credential map.',
      )
    }
    if (targetsByPath.has(targetDoc.path)) {
      throw new ScopedCredentialProjectionError(
        'duplicate-target-envelope',
        `Duplicate target envelope detected: ${targetDoc.path}`,
      )
    }
    targetsByPath.set(targetDoc.path, targetDoc.data)
  }

  return targetsByPath
}

export function projectAndReconcileScopedCredentials({
  sources,
  targets = [],
  targetClassroomId,
  rosterStudentIds,
  strict = true,
}) {
  const validTargetClassroomId = validateCanonicalDocumentId(
    targetClassroomId,
    'targetClassroomId',
  )

  if (!Array.isArray(sources)) {
    throw new ScopedCredentialProjectionError(
      'malformed-sources',
      'sources must be an array.',
    )
  }

  if (!Array.isArray(targets)) {
    throw new ScopedCredentialProjectionError(
      'malformed-targets',
      'targets must be an array when provided.',
    )
  }

  if (rosterStudentIds !== undefined && !Array.isArray(rosterStudentIds)) {
    throw new ScopedCredentialProjectionError(
      'malformed-roster',
      'rosterStudentIds must be an array when provided.',
    )
  }

  const seenLoginIds = new Set()
  const seenStudentIds = new Set()
  const seenTargetPaths = new Set()

  const projections = []
  const uidMappings = []
  const orphanedCredentialPaths = []

  let absentCount = 0
  let exactParityCount = 0
  let divergentCount = 0

  const targetsByPath = indexTargetEnvelopes(targets)

  for (const sourceEnvelope of sources) {
    const projection = projectScopedCredential(
      sourceEnvelope,
      validTargetClassroomId,
      { rosterStudentIds },
    )

    if (seenLoginIds.has(projection.loginId)) {
      throw new ScopedCredentialProjectionError(
        'duplicate-source-id',
        `Duplicate source login ID detected: ${projection.loginId}`,
      )
    }
    seenLoginIds.add(projection.loginId)

    if (seenStudentIds.has(projection.studentId)) {
      throw new ScopedCredentialProjectionError(
        'duplicate-student-id',
        `Duplicate studentId detected across sources: ${projection.studentId}`,
      )
    }
    seenStudentIds.add(projection.studentId)

    if (seenTargetPaths.has(projection.targetPath)) {
      throw new ScopedCredentialProjectionError(
        'duplicate-target-path',
        `Duplicate target path detected: ${projection.targetPath}`,
      )
    }
    seenTargetPaths.add(projection.targetPath)

    let reconciliationStatus = 'absent'
    if (targetsByPath.has(projection.targetPath)) {
      const existingTargetData = targetsByPath.get(projection.targetPath)
      if (firestoreValuesEqual(existingTargetData, projection.projectedData)) {
        reconciliationStatus = 'exact_parity'
        exactParityCount += 1
      } else {
        reconciliationStatus = 'divergent'
        divergentCount += 1
        if (strict) {
          // Only the path is reported: credential bodies hold PIN hashes.
          throw new ScopedCredentialProjectionError(
            'target-divergence',
            `Target credential at path ${projection.targetPath} is divergent from projected credential.`,
          )
        }
      }
    } else {
      absentCount += 1
    }

    if (projection.isOrphaned) {
      orphanedCredentialPaths.push(projection.targetPath)
    }

    projections.push({
      ...projection,
      reconciliationStatus,
    })
    uidMappings.push(projection.uidMapping)
  }

  return Object.freeze({
    projections: Object.freeze(projections),
    uidMappings: Object.freeze(uidMappings),
    orphanedCredentialPaths: Object.freeze(orphanedCredentialPaths),
    stats: Object.freeze({
      total: sources.length,
      absent: absentCount,
      exactParity: exactParityCount,
      divergent: divergentCount,
      orphaned: orphanedCredentialPaths.length,
    }),
  })
}
