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

export const MULTI_TEACHER_V2_ENABLED = defineBoolean('MULTI_TEACHER_V2_ENABLED', {
  default: false,
})

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
  if (!projectId || projectId !== 'morgan-bank-phase2b-server-test') {
    throw new Error(`Project ID "${projectId}" is invalid or not allowed for gate-on acceptance.`)
  }
}

if (MULTI_TEACHER_V2_ENABLED.value()) {
  validateGateOnEnvironment()
}

if (getApps().length === 0) {
  initializeApp()
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
  if (!MULTI_TEACHER_V2_ENABLED.value()) {
    throw new HttpsError('failed-precondition', 'Multi-teacher V2 is disabled.')
  }
  validateGateOnEnvironment()
  return resolveTeacherTenantCallable(request, {
    firestore: getFirestore(),
    auth: getAuth(),
  })
})

export const onboardTeacherClassroomV2 = onCall(async (request) => {
  if (!MULTI_TEACHER_V2_ENABLED.value()) {
    throw new HttpsError('failed-precondition', 'Multi-teacher V2 is disabled.')
  }
  validateGateOnEnvironment()
  return onboardTeacherClassroomCallable(request, {
    firestore: getFirestore(),
    auth: getAuth(),
  })
})

export const studentPinLoginV2 = onCall(async (request) => {
  if (!MULTI_TEACHER_V2_ENABLED.value()) {
    throw new HttpsError('failed-precondition', 'Multi-teacher V2 is disabled.')
  }
  validateGateOnEnvironment()
  return studentPinLoginV2CallableHandler(
    request.data,
    request,
    { firestore: getFirestore(), auth: getAuth() },
  )
})

export const resetStudentPinV2 = onCall(async (request) => {
  if (!MULTI_TEACHER_V2_ENABLED.value()) {
    throw new HttpsError('failed-precondition', 'Multi-teacher V2 is disabled.')
  }
  validateGateOnEnvironment()
  return resetStudentPinV2CallableHandler(
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
