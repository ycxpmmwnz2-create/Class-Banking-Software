// Admission policy for the reviewed V2 revision. This is not a transaction fence:
// deployment/release must separately drain older and already-admitted invocations.
const verificationReads = new Set(['getClassroomAccessV2', 'resolveTeacherTenantV2'])
const auditOperation = 'recordStudentBalanceHistoryV3'
const otherOperations = new Set([
  'onboardTeacherClassroomV2', 'createTeacherInvitationV2', 'revokeTeacherInvitationV2',
  'studentPinLoginV2', 'resetStudentPinV2', 'createStudentV2', 'removeStudentV2',
  'listStudentPinsV2', 'submitStudentTransactionV2', 'analyzeTeacherInsightsV3',
  'syncStudentProfilesV2',
])

export function assertMaintenanceAdmission({ mode, operation }) {
  // Previously committed events may arrive after callable admission closes.
  // Only this deterministic create-only witness is exempt; runtime guards still apply.
  if (operation === auditOperation && ['closed', 'verification', 'normal'].includes(mode)) return
  const known = verificationReads.has(operation) || otherOperations.has(operation)
  if (known && (mode === 'normal' || (mode === 'verification' && verificationReads.has(operation)))) return
  // Exact values only. Missing/malformed mode and unknown operations deny, including audit.
  // Do not attach the supplied value, request, project identity or operation.
  const error = new Error('V2 maintenance admission refused.')
  error.category = 'maintenance-denied'
  throw error
}
