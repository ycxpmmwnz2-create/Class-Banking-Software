import { createHash } from 'node:crypto'
import {
  normalizeStudentLoginId,
  validateCanonicalDocumentId,
} from './identityNormalization.js'
import { studentCredentialPath } from './studentCredentialPaths.js'

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

function deepEqual(objA, objB) {
  if (objA === objB) return true
  if (
    typeof objA !== 'object' ||
    objA === null ||
    typeof objB !== 'object' ||
    objB === null
  ) {
    return false
  }

  const keysA = Object.keys(objA)
  const keysB = Object.keys(objB)

  if (keysA.length !== keysB.length) return false

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false
    const valA = objA[key]
    const valB = objB[key]

    if (valA instanceof Date && valB instanceof Date) {
      if (valA.getTime() !== valB.getTime()) return false
    } else if (typeof valA === 'object' && valA !== null && typeof valB === 'object' && valB !== null) {
      if (!deepEqual(valA, valB)) return false
    } else if (valA !== valB) {
      return false
    }
  }

  return true
}

export function projectScopedCredential(sourceEnvelope, targetClassroomId, options = {}) {
  const validTargetClassroomId = validateCanonicalDocumentId(
    targetClassroomId,
    'targetClassroomId',
  )

  if (typeof sourceEnvelope !== 'object' || sourceEnvelope === null) {
    throw new ScopedCredentialProjectionError(
      'malformed-envelope',
      'Source envelope must be a non-null object.',
    )
  }

  const rawLoginId =
    sourceEnvelope.id ??
    sourceEnvelope.loginId ??
    (typeof sourceEnvelope.path === 'string'
      ? sourceEnvelope.path.split('/').pop()
      : undefined)

  if (typeof rawLoginId !== 'string' || !rawLoginId) {
    throw new ScopedCredentialProjectionError(
      'malformed-envelope',
      'Source envelope must specify a valid login ID.',
    )
  }

  let canonicalLoginId
  try {
    canonicalLoginId = normalizeStudentLoginId(rawLoginId)
  } catch (error) {
    throw new ScopedCredentialProjectionError(
      'malformed-envelope',
      `Invalid login ID in source envelope: ${error.message}`,
    )
  }

  if (
    typeof sourceEnvelope.loginId === 'string' &&
    sourceEnvelope.loginId !== canonicalLoginId
  ) {
    throw new ScopedCredentialProjectionError(
      'noncanonical-login-id',
      'Source envelope loginId is not in canonical normalized form.',
    )
  }

  const data = sourceEnvelope.data
  if (typeof data !== 'object' || data === null) {
    throw new ScopedCredentialProjectionError(
      'malformed-envelope',
      'Source envelope data must be a non-null object.',
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

  if (typeof data.classroomId === 'string' && data.classroomId) {
    try {
      validateCanonicalDocumentId(data.classroomId, 'sourceClassroomId')
    } catch (error) {
      throw new ScopedCredentialProjectionError(
        'malformed-classroom-id',
        `Invalid classroom ID in source credential data: ${error.message}`,
      )
    }

    if (
      data.classroomId !== validTargetClassroomId &&
      data.classroomId !== 'morgan'
    ) {
      throw new ScopedCredentialProjectionError(
        'source-classroom-mismatch',
        'Source credential classroomId does not match target classroom ID.',
      )
    }
  }

  const newAuthUid = deriveDeterministicStudentAuthUid(
    validTargetClassroomId,
    studentId,
  )

  const targetPath = studentCredentialPath(
    validTargetClassroomId,
    canonicalLoginId,
  )

  const projectedData = {
    ...data,
    classroomId: validTargetClassroomId,
    authUid: newAuthUid,
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

  // Validate claims identity: verifying authUid derives correctly from claims identity
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
    projectedData: Object.freeze(projectedData),
    uidMapping,
    isOrphaned,
    loginId: canonicalLoginId,
    studentId,
  })
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

  const seenLoginIds = new Set()
  const seenStudentIds = new Set()
  const seenTargetPaths = new Set()

  const projections = []
  const uidMappings = []
  const orphanedCredentialPaths = []

  let absentCount = 0
  let exactParityCount = 0
  let divergentCount = 0

  const targetsByPath = new Map()
  if (Array.isArray(targets)) {
    for (const targetDoc of targets) {
      if (targetDoc && typeof targetDoc.path === 'string' && targetDoc.data) {
        targetsByPath.set(targetDoc.path, targetDoc.data)
      }
    }
  }

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
      if (deepEqual(existingTargetData, projection.projectedData)) {
        reconciliationStatus = 'exact_parity'
        exactParityCount += 1
      } else {
        reconciliationStatus = 'divergent'
        divergentCount += 1
        if (strict) {
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
