import { ClassroomAccessError, isControlGeneration, readTeacherClassroomAccess } from '../phase3/classroomAccess.js'

async function authorize(operation) {
  try { return await operation() } catch (error) {
    if (!(error instanceof ClassroomAccessError)) throw error
    const denied = new Error('The active teacher classroom is unavailable.')
    denied.name = 'InsightAccessError'
    denied.category = 'authorization-failed'
    throw denied
  }
}

// Server-derived, immutable identity for one request. Never refresh its generation
// after a pause/resume, and never share a mutable scope across callable invocations.
export async function readInsightAccess({ firestore, transaction, teacherUid, classroomId, controlGeneration }) {
  if (!isControlGeneration(controlGeneration)) throw new ClassroomAccessError()
  const current = await readTeacherClassroomAccess({ firestore, transaction,
    auth: { uid: teacherUid },
    policy: { operation: 'mutate', protocolVersion: 1, controlGeneration } })
  if (current.classroomId !== classroomId) throw new ClassroomAccessError()
  return current
}

export async function createInsightRequestScope({ firestore, auth, usageLedger }) {
  const current = await authorize(() => firestore.runTransaction(transaction => readTeacherClassroomAccess({
    firestore, transaction, auth, policy: { operation: 'sensitiveRead' },
  }), { readOnly: true }))
  const identity = Object.freeze({ teacherUid: current.teacherUid, classroomId: current.classroomId,
    controlGeneration: current.control.generation })
  const assertActive = () => authorize(() => firestore.runTransaction(transaction => readInsightAccess({
    firestore, transaction, ...identity,
  }), { readOnly: true }))
  let reservation = null
  let dispatchIndex = 0
  let dispatchPending = false
  const ledger = Object.freeze({
    async reserve(input) {
      if (input.teacherUid !== identity.teacherUid || input.classroomId !== identity.classroomId) throw new ClassroomAccessError()
      const result = await usageLedger.reserve({ ...input, ...identity })
      if (result.kind === 'reserved') reservation = Object.freeze({
        reservationId: result.reservationId, requestId: input.requestId,
      })
      return result
    },
    commit: input => usageLedger.commit(input),
    markUncertain: input => usageLedger.markUncertain(input),
  })
  return Object.freeze({
    identity, assertActive, ledger,
    async load(loader, input) {
      if (input.teacherUid !== identity.teacherUid || input.classroomId !== identity.classroomId) throw new ClassroomAccessError()
      return loader({ ...input, ...identity })
    },
    async dispatch(operation) {
      if (!reservation || dispatchPending) throw new ClassroomAccessError()
      dispatchPending = true
      const input = { ...identity, ...reservation, dispatchIndex: ++dispatchIndex }
      try {
        await usageLedger.claimDispatch(input)
        // Pause after this claim can race the external request. This is observable
        // in-flight work, not an atomic HTTP fence. Never retry this claim/call.
        let outcome = 'failed'
        try {
          const result = await operation()
          outcome = 'returned'
          return result
        } finally {
          await usageLedger.finishDispatch({ ...reservation, dispatchIndex, outcome })
        }
      } finally { dispatchPending = false }
    },
  })
}
