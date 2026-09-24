import { createHash } from 'node:crypto'
import { validateCanonicalDocumentId } from '../phase2b/identityNormalization.js'
import { ClassroomAccessError, hasExactDataKeys, isControlGeneration, requireClassroomControl } from './classroomAccess.js'

function invalid() { throw new ClassroomAccessError('invalid-argument') }
function conflict() { throw new ClassroomAccessError('failed-precondition') }
function canonicalId(value) {
  try { return validateCanonicalDocumentId(value) } catch { return invalid() }
}

// Operator-only read capability; no Firebase initialization, credential discovery,
// default project, write API or public callable. The future local CLI supplies an
// explicitly scoped IAM-authorized handle. A plan grants no execution authority.
export async function planClassroomAccessTransition({ firestore, projectId, request }) {
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) invalid()
  // An SDK handle can throw while resolving its project binding. Do not expose
  // that SDK error or proceed to reads with an unverified handle.
  let boundProjectId
  try { boundProjectId = firestore?.projectId } catch { invalid() }
  if (boundProjectId !== projectId) invalid()
  if (!hasExactDataKeys(request, ['operationId', 'mode', 'targets']) ||
      typeof request.operationId !== 'string' || !/^[a-f0-9]{32}$/.test(request.operationId) ||
      !['active', 'readOnly', 'suspended'].includes(request.mode) ||
      !Array.isArray(request.targets) || request.targets.length < 1 || request.targets.length > 100) invalid()
  const targets = request.targets.map(target => {
    if (!hasExactDataKeys(target, ['classroomId', 'expectedGeneration']) || !isControlGeneration(target.expectedGeneration) ||
        target.expectedGeneration === Number.MAX_SAFE_INTEGER) invalid()
    return Object.freeze({ classroomId: canonicalId(target.classroomId), expectedGeneration: target.expectedGeneration })
  })
  // Array holes must not bypass target validation or enter the canonical scope.
  if (Object.keys(targets).length !== request.targets.length ||
      new Set(targets.map(target => target.classroomId)).size !== targets.length) invalid()
  targets.sort((a, b) => a.classroomId < b.classroomId ? -1 : a.classroomId > b.classroomId ? 1 : 0)
  const operationId = request.operationId
  const mode = request.mode
  const scopeDigest = createHash('sha256').update(JSON.stringify([
    'morgan-bank/access-plan', 1, projectId, operationId, mode,
    targets.map(target => [target.classroomId, target.expectedGeneration]),
  ])).digest('hex')
  const planned = []
  for (const target of targets) {
    // Each classroom gets a bounded, consistent foundation read. Multiple rows
    // are advisory observations, NOT a single atomic project-wide snapshot.
    const row = await firestore.runTransaction(async transaction => {
      const root = await transaction.get(firestore.doc(`classrooms/${target.classroomId}`))
      if (root.exists !== true) conflict()
      const classroom = root.data()
      let ownerUid
      try { ownerUid = validateCanonicalDocumentId(classroom?.ownerUid) } catch { conflict() }
      const owner = await transaction.get(firestore.doc(`teachers/${ownerUid}`))
      const teacher = owner.exists === true ? owner.data() : null
      if (teacher?.uid !== ownerUid || teacher.status !== 'active' || teacher.classroomId !== target.classroomId) conflict()
      const control = requireClassroomControl(classroom.accessControl)
      if (control.generation !== target.expectedGeneration) conflict()
      return Object.freeze({
        classroomId: target.classroomId, fromMode: control.mode, toMode: mode,
        expectedGeneration: control.generation, nextGeneration: control.generation + 1,
      })
    })
    planned.push(row)
  }
  return Object.freeze({
    protocolVersion: 1, kind: 'advisory-access-plan', projectId, operationId, scopeDigest,
    executable: false, classroomCount: planned.length, targets: Object.freeze(planned),
  })
}
