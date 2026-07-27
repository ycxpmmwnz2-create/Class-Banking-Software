import process from 'node:process'

import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { defineBoolean } from 'firebase-functions/params'

import { ensureTeacherClassroomForCaller } from './phase1/ensureTeacherClassroom.js'
import { resetStudentPinForTeacher } from './resetStudentPin.js'
import { verifyStudentCredentials } from './studentCredentialVerifier.js'
import { syncStudentProfiles as syncStudentProfilesHandler } from './syncStudentProfiles.js'

import {
  onboardTeacherClassroomCallable,
  resolveTeacherTenantCallable,
} from './phase2b/teacherCallables.js'
import { studentPinLoginV2CallableHandler } from './phase2b/studentCredentialVerifier.js'
import { resetStudentPinV2CallableHandler } from './phase2b/resetStudentPin.js'
import { syncStudentProfilesV2Handler } from './phase2b/syncStudentProfiles.js'
import {
  createStudentV2CallableHandler,
  removeStudentV2CallableHandler,
} from './phase3/studentLifecycle.js'

export const MULTI_TEACHER_V2_ENABLED = defineBoolean('MULTI_TEACHER_V2_ENABLED', {
  default: false,
})

/**
 * The only project the V2 gate may be enabled in. It is a Firebase *demo*
 * project ID: the CLI short-circuits `getProjectAdminSdkConfigOrCached` for
 * `demo-` projects, so starting the emulators for it never calls
 * `firebase.googleapis.com` and never needs a live project to exist.
 */
const ALLOWED_GATE_ON_PROJECT_ID = 'demo-morgan-bank-phase2b-server-test'

function isLoopbackHostPort(envVal) {
  if (!envVal || typeof envVal !== 'string') return false
  const parts = envVal.split(':')
  if (parts.length !== 2) return false
  const [host, portStr] = parts
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  const port = parseInt(portStr, 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 && String(port) === portStr
}

function resolveRuntimeProjectId() {
  const gcloud = process.env.GCLOUD_PROJECT
  let firebaseConfigProject
  if (process.env.FIREBASE_CONFIG) {
    try {
      const parsed = typeof process.env.FIREBASE_CONFIG === 'string'
        ? JSON.parse(process.env.FIREBASE_CONFIG)
        : process.env.FIREBASE_CONFIG
      firebaseConfigProject = parsed?.projectId
    } catch {
      return null
    }
  }

  if (gcloud && firebaseConfigProject && gcloud !== firebaseConfigProject) {
    return null
  }
  return gcloud || firebaseConfigProject || null
}

function validateGateOnEnvironment() {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    throw new Error('FUNCTIONS_EMULATOR must be "true".')
  }
  if (!isLoopbackHostPort(process.env.FIRESTORE_EMULATOR_HOST)) {
    throw new Error('FIRESTORE_EMULATOR_HOST must be a valid loopback host:port.')
  }
  if (!isLoopbackHostPort(process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
    throw new Error('FIREBASE_AUTH_EMULATOR_HOST must be a valid loopback host:port.')
  }
  const projectId = resolveRuntimeProjectId()
  if (projectId !== ALLOWED_GATE_ON_PROJECT_ID) {
    throw new Error('Project ID is invalid or not allowed for gate-on acceptance.')
  }
}

/**
 * Module-load safety check.
 *
 * The raw environment variable is read directly instead of calling
 * `MULTI_TEACHER_V2_ENABLED.value()` here. `Param.value()` logs a
 * "invoked during function deployment" warning whenever
 * `FUNCTIONS_CONTROL_API === "true"` (firebase-functions 7.2.5,
 * `lib/params/types.js:19-26`), which is exactly the Functions *discovery*
 * pass the CLI runs before any parameter has been resolved. Reading the
 * variable is equivalent at runtime — `BooleanParam.runtimeValue()` is
 * `process.env[name] === "true"` (`lib/params/types.js:436-438`) — but is
 * silent during discovery and cannot be mistaken for a resolved parameter.
 *
 * This runs before `initializeApp()` so that an explicitly enabled gate can
 * never initialize the Admin SDK against a non-emulator or non-demo target.
 * Every V2 invocation still consults the `defineBoolean` parameter itself.
 */
if (process.env.MULTI_TEACHER_V2_ENABLED === 'true') {
  validateGateOnEnvironment()
}

if (getApps().length === 0) {
  initializeApp()
}

/**
 * Per-invocation gate. `MULTI_TEACHER_V2_ENABLED.value()` is the authoritative
 * check and runs before any Firestore/Auth handle is created. The environment
 * revalidation is defence in depth; its message is collapsed to the same
 * generic string so a caller cannot learn which host/project check failed.
 */
function assertV2Callable() {
  if (!MULTI_TEACHER_V2_ENABLED.value()) {
    throw new HttpsError('failed-precondition', 'Multi-teacher V2 is disabled.')
  }
  try {
    validateGateOnEnvironment()
  } catch {
    throw new HttpsError('failed-precondition', 'Multi-teacher V2 is disabled.')
  }
}

// Legacy exports
export const studentPinLogin = onCall(async (request) => {
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

export const resetStudentPin = onCall(resetStudentPinForTeacher)

export const syncStudentProfiles = syncStudentProfilesHandler

export const ensureTeacherClassroom = onCall(ensureTeacherClassroomForCaller)

// V2 exports
export const resolveTeacherTenantV2 = onCall(async (request) => {
  assertV2Callable()
  return resolveTeacherTenantCallable(request, {
    firestore: getFirestore(),
    auth: getAuth(),
  })
})

export const onboardTeacherClassroomV2 = onCall(async (request) => {
  assertV2Callable()
  return onboardTeacherClassroomCallable(request, {
    firestore: getFirestore(),
    auth: getAuth(),
  })
})

export const studentPinLoginV2 = onCall(async (request) => {
  assertV2Callable()
  return studentPinLoginV2CallableHandler(
    request.data,
    request,
    { firestore: getFirestore(), auth: getAuth() },
  )
})

export const resetStudentPinV2 = onCall(async (request) => {
  assertV2Callable()
  return resetStudentPinV2CallableHandler(
    request.data,
    request,
    { firestore: getFirestore() },
  )
})

export const createStudentV2 = onCall(async (request) => {
  assertV2Callable()
  return createStudentV2CallableHandler(
    request.data,
    request,
    { firestore: getFirestore() },
  )
})

export const removeStudentV2 = onCall(async (request) => {
  assertV2Callable()
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
    validateGateOnEnvironment()
    return syncStudentProfilesV2Handler(event, {
      firestore: getFirestore(),
    })
  },
)
