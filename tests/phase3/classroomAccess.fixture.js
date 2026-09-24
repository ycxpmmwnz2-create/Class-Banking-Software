import { deriveDeterministicStudentAuthUid } from '../../functions/phase2b/scopedCredentialProjection.js'

export const teacherAuth = Object.freeze({ uid: 'teacher-a', token: {} })
export const studentAuth = Object.freeze({
  uid: deriveDeterministicStudentAuthUid('class-a', '1'),
  token: Object.freeze({ role: 'student', classroomId: 'class-a', studentId: '1', loginId: 'learner1', credentialVersion: 1000 }),
})
export function control(overrides = {}) {
  return { schemaVersion: 1, mode: 'active', generation: 3, changedAt: '2026-09-22T12:00:00.000Z', auditId: 'fictional-op', ...overrides }
}
export function documents(mode = 'active') {
  return {
    'teachers/teacher-a': { uid: 'teacher-a', classroomId: 'class-a', status: 'active', displayName: 'PRIVATE NAME' },
    'classrooms/class-a': { ownerUid: 'teacher-a', accessControl: control({ mode }), privateData: 'PRIVATE ROOT' },
    'classrooms/class-a/studentCredentials/learner1': {
      active: true, classroomId: 'class-a', studentId: '1', authUid: studentAuth.uid,
      pinUpdatedAt: 1000, pin: 'PRIVATE PIN', passwordHash: 'PRIVATE HASH',
    },
  }
}

// Fictional transaction harness, not an emulator. Each snapshot list entry is a
// callback attempt; only the last attempt can publish staged writes.
export function database(attempts = [documents()]) {
  const reads = [], staged = [], committed = []
  return {
    projectId: 'demo-access', reads, staged, committed,
    doc(path) { return { path } },
    async runTransaction(callback) {
      let result
      for (const [attempt, store] of attempts.entries()) {
        const pending = []
        result = await callback({
          async get(ref) {
            reads.push({ attempt, path: ref.path })
            const value = store[ref.path]
            return { exists: value !== undefined, data: () => value }
          },
          update(ref, data) {
            const write = { attempt, path: ref.path, data }
            staged.push(write); pending.push(write)
          },
          set() { throw new Error('Unexpected write') },
          create() { throw new Error('Unexpected write') },
          delete() { throw new Error('Unexpected write') },
        })
        if (attempt === attempts.length - 1) committed.push(...pending)
      }
      return result
    },
  }
}
