import process from 'node:process'

import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { defineBoolean, defineString } from 'firebase-functions/params'

import { ensureTeacherClassroomForCaller } from './phase1/ensureTeacherClassroom.js'
import { resetStudentPinForTeacher } from './resetStudentPin.js'
import { verifyStudentCredentials } from './studentCredentialVerifier.js'
import { syncStudentProfiles as syncStudentProfilesHandler } from './syncStudentProfiles.js'

import {
  onboardTeacherClassroomCallable,
  resolveTeacherTenantCallable,
} from './phase2b/teacherCallables.js'
import {
  createTeacherInvitationCallable,
  revokeTeacherInvitationCallable,
} from './phase2b/teacherInvitationAdmin.js'
import { studentPinLoginV2CallableHandler } from './phase2b/studentCredentialVerifier.js'
import { resetStudentPinV2CallableHandler } from './phase2b/resetStudentPin.js'
import { syncStudentProfilesV2Handler } from './phase2b/syncStudentProfiles.js'
import {
  createStudentV2CallableHandler,
  removeStudentV2CallableHandler,
} from './phase3/studentLifecycle.js'
import { assertV2GateAllowed } from './phase3/productionEnvironment.js'

export const MULTI_TEACHER_V2_ENABLED = defineBoolean('MULTI_TEACHER_V2_ENABLED', {
  default: false,
})

export const MULTI_TEACHER_V2_RELEASE_ID = defineString('MULTI_TEACHER_V2_RELEASE_ID', {
  default: '',
})

export const MORGAN_BANK_DEPLOYMENT_TIER = defineString('MORGAN_BANK_DEPLOYMENT_TIER', {
  default: 'production',
})

export const MORGAN_BANK_STAGING_PROJECT_ID = defineString('MORGAN_BANK_STAGING_PROJECT_ID', {
  default: '',
})

// This identifier is part of the reviewed Functions artifact. Production V2
// invocations require the separately configured release parameter to match it
// exactly; emulator invocations have no deployed release and therefore do not.
export const REVIEWED_V2_FUNCTIONS_RELEASE_ID = 'staging-support-functions-v1'

/**
 * Module loading is deliberately unconditional. Section 6 requires discovery
 * and every legacy export to remain available even when a V2 parameter or
 * runtime identity is malformed. The strict environment/release guard runs at
 * the start of each V2 invocation, before a Firestore/Auth handle is created.
 */
if (getApps().length === 0) {
  try {
    initializeApp()
  } catch {
    // firebase-admin itself parses FIREBASE_CONFIG during initializeApp(). A
    // malformed value must not take down Functions discovery or hide legacy
    // exports. V2 invocations revalidate the environment below and fail before
    // requesting a handle; no configuration value or parse error is logged.
    globalThis.console.warn('Firebase Admin initialization deferred.', {
      category: 'invalid-runtime',
    })
  }
}

/**
 * Per-invocation gate. `MULTI_TEACHER_V2_ENABLED.value()` is the authoritative
 * check and runs before any Firestore/Auth handle is created. The environment
 * revalidation is defence in depth; its message is collapsed to the same
 * generic string so a caller cannot learn which host/project check failed.
 */
function assertV2Invocation(operation) {
  try {
    const validated = assertV2GateAllowed({
      v2Enabled: MULTI_TEACHER_V2_ENABLED.value(),
      expectedReleaseId: REVIEWED_V2_FUNCTIONS_RELEASE_ID,
      deploymentTier: MORGAN_BANK_DEPLOYMENT_TIER.value(),
      stagingProjectId: MORGAN_BANK_STAGING_PROJECT_ID.value(),
      environment: process.env,
    })
    if (getApps().length !== 1) {
      throw new Error('Firebase Admin is unavailable.')
    }
    return validated
  } catch (error) {
    // Redacted telemetry: operation and category are allowlisted labels. Never
    // log the environment, project/release values, request body, or error text.
    globalThis.console.warn('V2 invocation refused.', {
      operation,
      category: typeof error?.category === 'string' ? error.category : 'invalid-runtime',
    })
    throw new HttpsError('failed-precondition', 'Multi-teacher V2 is disabled.')
  }
}

function assertLegacyCompatibility() {
  if (MULTI_TEACHER_V2_ENABLED.value()) {
    throw new HttpsError(
      'failed-precondition',
      'This client version is unavailable during multi-teacher maintenance.',
    )
  }
}

// Legacy exports
export const studentPinLogin = onCall(async (request) => {
  assertLegacyCompatibility()
  const { loginId, pin } = request.data ?? {}

  const student = await verifyStudentCredentials({ loginId, pin })

  if (!student) {
    throw new HttpsError('unauthenticated', 'Invalid student credentials.')
  }

  const token = await getAuth().createCustomToken(
    student.authUid,
    student.claims,
  )

  return { token }
})

export const resetStudentPin = onCall(async (request) => {
  assertLegacyCompatibility()
  return resetStudentPinForTeacher(request)
})

export const syncStudentProfiles = onDocumentWritten(
  'morganBank/classroomData',
  async (event) => {
    // A gate-on legacy aggregate write must never update flat credentials or
    // the legacy student mirror. Commit 9 rules will reject the client write;
    // this Commit 8 guard makes the retained trigger itself inert immediately.
    if (MULTI_TEACHER_V2_ENABLED.value()) return
    return syncStudentProfilesHandler.run(event)
  },
)

export const ensureTeacherClassroom = onCall(async (request) => {
  assertLegacyCompatibility()
  return ensureTeacherClassroomForCaller(request)
})

// V2 exports
export const resolveTeacherTenantV2 = onCall(async (request) => {
  assertV2Invocation('resolveTeacherTenantV2')
  return resolveTeacherTenantCallable(request, {
    firestore: getFirestore(),
    auth: getAuth(),
  })
})

export const onboardTeacherClassroomV2 = onCall(async (request) => {
  assertV2Invocation('onboardTeacherClassroomV2')
  return onboardTeacherClassroomCallable(request, {
    firestore: getFirestore(),
    auth: getAuth(),
  })
})

export const createTeacherInvitationV2 = onCall(async (request) => {
  assertV2Invocation('createTeacherInvitationV2')
  return createTeacherInvitationCallable(request, {
    firestore: getFirestore(),
  })
})

export const revokeTeacherInvitationV2 = onCall(async (request) => {
  assertV2Invocation('revokeTeacherInvitationV2')
  return revokeTeacherInvitationCallable(request, {
    firestore: getFirestore(),
  })
})

export const studentPinLoginV2 = onCall(async (request) => {
  assertV2Invocation('studentPinLoginV2')
  return studentPinLoginV2CallableHandler(
    request.data,
    request,
    { firestore: getFirestore(), auth: getAuth() },
  )
})

export const resetStudentPinV2 = onCall(async (request) => {
  assertV2Invocation('resetStudentPinV2')
  return resetStudentPinV2CallableHandler(
    request.data,
    request,
    { firestore: getFirestore() },
  )
})

export const createStudentV2 = onCall(async (request) => {
  assertV2Invocation('createStudentV2')
  return createStudentV2CallableHandler(
    request.data,
    request,
    { firestore: getFirestore() },
  )
})

export const removeStudentV2 = onCall(async (request) => {
  assertV2Invocation('removeStudentV2')
  return removeStudentV2CallableHandler(
    request.data,
    request,
    { firestore: getFirestore() },
  )
})

export const syncStudentProfilesV2 = onDocumentWritten(
  'classrooms/{classroomId}/students/{studentId}',
  async (event) => {
    if (!MULTI_TEACHER_V2_ENABLED.value()) {
      return
    }
    assertV2Invocation('syncStudentProfilesV2')
    return syncStudentProfilesV2Handler(event, {
      firestore: getFirestore(),
    })
  },
)
