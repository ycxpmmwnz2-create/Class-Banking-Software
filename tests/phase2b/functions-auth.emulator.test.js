import { deriveBaseLoginId } from '../../functions/phase2b/syncStudentProfiles.js'
/**
 * Phase 2B Item 8 — real Auth/Functions/Firestore emulator acceptance.
 *
 * Every callable is invoked through the Functions emulator with the Firebase
 * *client* SDK (`httpsCallable`) carrying a real emulator ID token. Fixtures
 * are seeded and inspected only with the Admin SDK pointed at the emulators.
 * The file refuses to initialize anything before proving that the process is
 * pointed at loopback emulators and an explicit Firebase demo project.
 *
 * Run through `npm run test:phase2b:server` only. Two modes exist:
 *   gate-off — MULTI_TEACHER_V2_ENABLED unset/false; legacy behavior and V2
 *              inertness are proven.
 *   gate-on  — MULTI_TEACHER_V2_ENABLED=true; the full V2 matrix runs.
 */
import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createTeacherMoneyClient } from '../../src/phase3/teacherMoneyClient.js'
import { teacherAwardPaths } from '../../functions/phase3/teacherAwardService.js'

import { initializeApp, deleteApp } from 'firebase/app'
import {
  getAuth,
  connectAuthEmulator,
  signInWithCredential,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  getIdTokenResult,
} from 'firebase/auth'
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  updateDoc,
} from 'firebase/firestore'
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from 'firebase/functions'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'

// ---------------------------------------------------------------------------
// Environment refusal. Nothing below this block may run — and in particular no
// Admin SDK app may be initialized — unless the process is provably pointed at
// loopback emulators and a Firebase demo project.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const FUNCTIONS_DIR = path.join(REPO_ROOT, 'functions')

const GATE_OFF_PROJECT_ID = 'demo-morgan-bank-phase2b-server-off-test'
const GATE_ON_PROJECT_ID = 'demo-morgan-bank-phase2b-server-test'
const FUNCTIONS_EMULATOR_HOST = '127.0.0.1'
const FUNCTIONS_EMULATOR_PORT = 5001
const FINAL_RULES_PATH = path.join(REPO_ROOT, process.env.PHASE3_WRITER_CONTAINMENT === 'true'
  ? 'firestore.phase3.money.rules' : 'firestore.phase3.final.rules')

/** The hardcoded UID the untouched legacy handlers still authorize. */
const LEGACY_TEACHER_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'

const testMode = process.env.PHASE2B_EMULATOR_TEST_MODE
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST
const gcloudProject = process.env.GCLOUD_PROJECT

if (!['gate-off', 'gate-on'].includes(testMode)) {
  throw new Error(
    `PHASE2B_EMULATOR_TEST_MODE must be "gate-off" or "gate-on". Received: "${testMode}"`,
  )
}

function isLoopbackHostPort(value) {
  if (typeof value !== 'string' || !value) return false
  const parts = value.split(':')
  if (parts.length !== 2) return false
  const [host, portStr] = parts
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  const port = Number.parseInt(portStr, 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 && String(port) === portStr
}

if (!isLoopbackHostPort(firestoreHost)) {
  throw new Error(
    `FIRESTORE_EMULATOR_HOST must be a loopback host:port. Received: "${firestoreHost}"`,
  )
}
if (!isLoopbackHostPort(authHost)) {
  throw new Error(
    `FIREBASE_AUTH_EMULATOR_HOST must be a loopback host:port. Received: "${authHost}"`,
  )
}

const expectedProject = testMode === 'gate-off' ? GATE_OFF_PROJECT_ID : GATE_ON_PROJECT_ID

if (gcloudProject !== expectedProject) {
  throw new Error(
    `Expected project ID "${expectedProject}" for mode "${testMode}", but got "${gcloudProject}"`,
  )
}
// A Firebase "demo-" project is the CLI's own offline marker: emulated services
// use a demo configuration and the CLI never calls firebase.googleapis.com for
// it. Refusing anything else is what keeps this suite off live services.
if (!expectedProject.startsWith('demo-')) {
  throw new Error(`Project ID must be a Firebase demo project: "${expectedProject}"`)
}

// ---------------------------------------------------------------------------
// Admin SDK (emulator-only) and client app helpers.
// ---------------------------------------------------------------------------

const functionsRequire = createRequire(path.join(FUNCTIONS_DIR, 'package.json'))
const admin = functionsRequire('firebase-admin')
const bcrypt = functionsRequire('bcryptjs')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: expectedProject })
}
const db = admin.firestore()
const adminAuth = admin.auth()

let clientApps = []
let clientAppSeq = 0
let gateOnRulesEnvironment = null

function createTestClientApp() {
  clientAppSeq += 1
  const app = initializeApp(
    { projectId: expectedProject, apiKey: 'fake-api-key' },
    `phase2b-client-${clientAppSeq}`,
  )

  const auth = getAuth(app)
  connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true })

  const functions = getFunctions(app, 'us-central1')
  connectFunctionsEmulator(functions, FUNCTIONS_EMULATOR_HOST, FUNCTIONS_EMULATOR_PORT)

  const firestore = getFirestore(app)
  const [firestoreEmulatorHost, firestoreEmulatorPort] = firestoreHost.split(':')
  connectFirestoreEmulator(
    firestore,
    firestoreEmulatorHost,
    Number(firestoreEmulatorPort),
  )

  clientApps.push(app)
  return { app, auth, firestore, functions }
}

async function cleanupClientApps() {
  const apps = clientApps
  clientApps = []
  for (const app of apps) {
    try {
      await deleteApp(app)
    } catch {
      // A client app already torn down is not a test failure.
    }
  }
}

/**
 * The Firestore emulator answers 409 while a trigger transaction is still open,
 * so the wipe is retried within a bounded budget before it is treated as a
 * genuine failure. It is never ignored and never silently skipped.
 */
async function deleteWithRetry(url, label, attempts = 60, intervalMs = 1000) {
  let last = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await fetch(url, { method: 'DELETE' })
    if (res.ok) return
    last = res.statusText
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Failed to clear ${label} emulator after ${attempts} attempts: ${last}`)
}

/**
 * Removes student documents before the bulk wipe.
 *
 * A bulk wipe deletes the classroom root and its students in one shot, so the
 * V2 sync trigger fires for a student whose classroom no longer exists, throws,
 * and is killed by the emulator with its Firestore transaction still open —
 * which then makes the next wipe conflict. Deleting the students first, while
 * their foundation is intact, keeps that from happening. The wait is on the
 * trigger's own observable outcome (credential deactivation), not on a sleep.
 */
async function drainStudentTriggers() {
  try {
    const students = await db.collectionGroup('students').get()
    if (students.empty) return
    const legacy = []
    for (const student of students.docs) {
      const classroomId = student.ref.parent.parent.id
      const root = await student.ref.parent.parent.get()
      if (root.data()?.accessControl) continue // enrolled triggers intentionally do not deactivate
      const creds = await credentialsRef(classroomId).where('studentId','==',student.id).get()
      for (const cred of creds.docs) legacy.push({ ref:cred.ref, updatedAt:cred.data().updatedAt })
    }
    await Promise.all(students.docs.map(doc => doc.ref.delete()))
    await waitFor(async () => {
      // An already inactive credential is not evidence that its delete event
      // finished. Observe the trigger timestamp too before deleting foundation.
      for (const prior of legacy) {
        const current = await prior.ref.get()
        if (current.exists && (current.data().active !== false || current.data().updatedAt === prior.updatedAt)) return false
      }
      return true
    }, { timeoutMs: 10000, pollIntervalMs: 100, label: 'student delete triggers to drain' })
  } catch {
    // A fixture whose foundation a test deliberately broke cannot drain
    // cleanly. The bounded wipe retry above is the backstop for that case.
  }
}

async function clearEmulators() {
  await drainStudentTriggers()
  await deleteWithRetry(
    `http://${firestoreHost}/emulator/v1/projects/${expectedProject}` +
    '/databases/(default)/documents',
    'Firestore',
  )
  await deleteWithRetry(
    `http://${authHost}/emulator/v1/projects/${expectedProject}/accounts`,
    'Auth',
  )
}

// ---------------------------------------------------------------------------
// Assertion and polling helpers.
// ---------------------------------------------------------------------------

/**
 * The Firebase client SDK reports callable failures as `functions/<code>`
 * (`@firebase/functions` `FunctionsError`), not as the bare gRPC code. Asserting
 * the bare code would silently never match.
 */
async function expectCallableError(promiseFactory, code, messageIncludes) {
  let error = null
  try {
    await promiseFactory()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `expected the callable to reject with functions/${code}`)
  assert.equal(error.code, `functions/${code}`, `unexpected error: ${error.code} ${error.message}`)
  if (messageIncludes !== undefined) {
    assert.ok(
      String(error.message).includes(messageIncludes),
      `expected message to include ${JSON.stringify(messageIncludes)}, got ${error.message}`,
    )
  }
  return error
}

async function waitFor(checkFn, { timeoutMs = 20000, pollIntervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = await checkFn()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}` +
    (lastError ? `; last error: ${lastError.message}` : ''),
  )
}

/**
 * Bounded proof of a *negative* trigger outcome. A trigger that must never fire
 * cannot be proven by a single read, so the condition is polled for a fixed
 * window that comfortably exceeds observed trigger latency in this suite.
 */
async function waitForStableAbsence(checkFn, { durationMs = 6000, pollIntervalMs = 200, label = 'absence' } = {}) {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    const found = await checkFn()
    assert.equal(found, false, `expected ${label} to stay absent, but it appeared`)
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
}

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Independent re-derivation of the documented V2 student Auth UID formula. */
function deriveStudentAuthUid(classroomId, studentId) {
  const digest = createHash('sha256')
    .update(`${classroomId}\0${studentId}`, 'utf8')
    .digest('base64url')
  return `s_${digest}`
}

function canonicalizeCode(formattedCode) {
  return formattedCode.replace(/-/g, '')
}

function throttleDigest(canonicalCode, canonicalLoginId) {
  return sha256Hex(`${canonicalCode}\0${canonicalLoginId}`)
}

function studentMoneyThrottleDigest(classroomId, studentId) {
  return sha256Hex(`student-money-submission:${sha256Hex(classroomId)}:${studentId}`)
}

// ---------------------------------------------------------------------------
// Identity helpers — real Auth emulator identities only.
// ---------------------------------------------------------------------------

let googleSubSeq = 0

/**
 * Signs the Firebase *client* in with the Auth emulator's fake Google
 * credential support. The session that results is backed by a genuine emulator
 * Google ID token, so `firebase.sign_in_provider` is really `google.com` and
 * `email_verified` is really true in the token the callable receives.
 */
async function signInAsGoogleUser(email, { emailVerified = true } = {}) {
  googleSubSeq += 1
  const client = createTestClientApp()
  const credential = GoogleAuthProvider.credential(JSON.stringify({
    sub: `google-sub-${googleSubSeq}-${email}`,
    email,
    email_verified: emailVerified,
  }))
  const userCred = await signInWithCredential(client.auth, credential)
  const tokenResult = await getIdTokenResult(userCred.user, true)
  return { ...client, uid: userCred.user.uid, email, tokenResult }
}

async function signInAsPlatformAdmin(email) {
  const identity = await signInAsGoogleUser(email)
  await adminAuth.setCustomUserClaims(identity.uid, { platformAdmin: true })
  const tokenResult = await getIdTokenResult(identity.auth.currentUser, true)
  assert.equal(tokenResult.claims.platformAdmin, true)
  await assertGoogleIdentity(tokenResult, email)
  return { ...identity, tokenResult }
}

async function assertGoogleIdentity(tokenResult, email) {
  assert.equal(tokenResult.claims.email, email)
  assert.equal(tokenResult.claims.email_verified, true)
  assert.equal(tokenResult.claims.firebase?.sign_in_provider, 'google.com')
}

async function seedInvitation(email, overrides = {}) {
  const normalizedEmail = email.trim().toLowerCase()
  const digest = sha256Hex(normalizedEmail)
  await db.collection('teacherInvitations').doc(digest).set({
    email: normalizedEmail,
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
    ...overrides,
  })
  return digest
}

async function onboardGoogleTeacher(email, classroomName) {
  await seedInvitation(email)
  const identity = await signInAsGoogleUser(email)
  await assertGoogleIdentity(identity.tokenResult, email)
  const res = await httpsCallable(identity.functions, 'onboardTeacherClassroomV2')({ classroomName })
  return {
    ...identity,
    onboarding: res.data,
    classroomId: res.data.classroom.id,
    studentLoginCode: res.data.classroom.studentLoginCode,
  }
}

function studentDocRef(classroomId, studentId) {
  return db.collection('classrooms').doc(classroomId).collection('students').doc(studentId)
}

function credentialsRef(classroomId) {
  return db.collection('classrooms').doc(classroomId).collection('studentCredentials')
}

async function waitForCredentialByStudentId(classroomId, studentId, label) {
  return waitFor(async () => {
    const snap = await credentialsRef(classroomId).where('studentId', '==', studentId).get()
    return snap.size === 1 ? snap.docs[0] : null
  }, { label: label ?? `credential for ${studentId} in ${classroomId}` })
}

/**
 * Item 7 creates credentials *inactive* with the default PIN. A student can
 * only log in after the owning teacher activates the credential through
 * `resetStudentPinV2`; a student document's own fields never control a
 * credential.
 */
// Explicit pre-enrollment compatibility fixture, confined to the D trigger suite.
async function onboardUnenrolledTeacher(email, name) {
  const teacher = await onboardGoogleTeacher(email, name)
  const root = db.doc(`classrooms/${teacher.classroomId}`)
  const data = (await root.get()).data()
  delete data.accessControl
  await root.set(data)
  return teacher
}

// E/F test credentials are explicit emulator fixtures: enrolled roots no longer
// delegate credential creation to asynchronous student-document events.
async function seedInactiveCredential(classroomId, studentId) {
  const student = (await studentDocRef(classroomId,studentId).get()).data()
  const loginId = deriveBaseLoginId(student.name)
  const ref = credentialsRef(classroomId).doc(loginId)
  await ref.create({loginId,classroomId,studentId,
    authUid:deriveStudentAuthUid(classroomId,studentId),schemaVersion:1,active:false,
    pinHash:await bcrypt.hash('1234',12),pinUpdatedAt:1000,createdAt:1000,updatedAt:1000,
    failedAttempts:0,lockedUntil:null})
  return ref.get()
}

async function resetWire(teacherFunctions, studentId, newPin) {
  const {data} = await httpsCallable(teacherFunctions,'resolveTeacherTenantV2')({})
  const access = (await httpsCallable(teacherFunctions,'getClassroomAccessV2')({})).data
  return {studentId,newPin,classroomId:data.classroom.id,protocolVersion:1,controlGeneration:access.generation}
}

async function activateStudentPin(teacherFunctions, studentId, newPin) {
  const res = await httpsCallable(teacherFunctions, 'resetStudentPinV2')(await resetWire(teacherFunctions, studentId, newPin))
  assert.equal(res.data.success, true)
  return res.data
}

after(async () => {
  await cleanupClientApps()
  await gateOnRulesEnvironment?.cleanup()
  await Promise.all(admin.apps.map(app => app.delete()))
})

// ===========================================================================
// GATE-OFF
// ===========================================================================

if (testMode === 'gate-off') {
  describe('Gate-off: legacy behavior intact and V2 completely inert', () => {
    beforeEach(async () => {
      await cleanupClientApps()
      await clearEmulators()
    })

    it('exports every legacy and V2 callable name through the Functions emulator', async () => {
      const { functions } = createTestClientApp()
      for (const name of [
        'studentPinLogin',
        'resetStudentPin',
        'ensureTeacherClassroom',
        'resolveTeacherTenantV2',
        'onboardTeacherClassroomV2',
        'createTeacherInvitationV2',
        'revokeTeacherInvitationV2',
        'studentPinLoginV2',
        'resetStudentPinV2',
        'createStudentV2',
        'removeStudentV2',
        'listStudentPinsV2',
        'submitStudentTransactionV2',
        'planTeacherMoneyV2', 'executeTeacherMoneyV2', 'getTeacherMoneyStatusV2',
        'acknowledgeTeacherMoneyV2', 'cancelTeacherMoneyV2', 'editStudentProfileV2',
      ]) {
        let error = null
        try {
          await httpsCallable(functions, name)({})
        } catch (caught) {
          error = caught
        }
        // Every name must resolve to a deployed callable; a missing export
        // surfaces as functions/not-found from the emulator router.
        assert.ok(error, `${name} unexpectedly succeeded with an empty request`)
        assert.notEqual(error.code, 'functions/not-found', `${name} is not exported`)
      }
    })

    it('rejects unauthenticated legacy callables', async () => {
      const { functions } = createTestClientApp()
      await expectCallableError(
        () => httpsCallable(functions, 'studentPinLogin')({ loginId: 'nobody', pin: '0000' }),
        'unauthenticated',
        'Invalid student credentials',
      )
      await expectCallableError(
        () => httpsCallable(functions, 'resetStudentPin')({ studentId: 's1', newPin: '1234' }),
        'unauthenticated',
      )
      await expectCallableError(
        () => httpsCallable(functions, 'ensureTeacherClassroom')({}),
        'unauthenticated',
      )
    })

    it('fails every V2 callable closed before any V2 data access', async () => {
      const { functions } = createTestClientApp()
      for (const name of [
        'resolveTeacherTenantV2',
        'onboardTeacherClassroomV2',
        'createTeacherInvitationV2',
        'revokeTeacherInvitationV2',
        'studentPinLoginV2',
        'resetStudentPinV2',
        'createStudentV2',
        'removeStudentV2',
        'listStudentPinsV2',
        'submitStudentTransactionV2',
        'planTeacherMoneyV2', 'executeTeacherMoneyV2', 'getTeacherMoneyStatusV2',
        'acknowledgeTeacherMoneyV2', 'cancelTeacherMoneyV2', 'editStudentProfileV2',
      ]) {
        await expectCallableError(
          () => httpsCallable(functions, name)({}),
          'failed-precondition',
          'Multi-teacher V2 is disabled',
        )
      }
      // No V2 side effect of any kind may exist afterwards.
      const scoped = await db.collectionGroup('studentCredentials').get()
      assert.equal(scoped.docs.filter(d => d.ref.path.startsWith('classrooms/')).length, 0)
      assert.equal((await db.collection('studentLoginThrottle').get()).size, 0)
      assert.equal((await db.collection('studentAuthUnresolvedLogs').get()).size, 0)
      assert.equal((await db.collection('teachers').get()).size, 0)
      assert.equal((await db.collection('classroomLoginCodes').get()).size, 0)
      assert.equal((await db.collection('teacherInvitations').get()).size, 0)
    })

    it('signs a student in through the untouched legacy flat credential path', async () => {
      const legacyHash = await bcrypt.hash('1234', 12)
      await db.collection('studentCredentials').doc('legacy-john').set({
        schemaVersion: 1,
        loginId: 'legacy-john',
        pinHash: legacyHash,
        authUid: 'legacy-auth-john',
        classroomId: 'morgan',
        studentId: 's-legacy-john',
        active: true,
        failedAttempts: 0,
        lockedUntil: null,
      })

      const { auth, functions } = createTestClientApp()
      const res = await httpsCallable(functions, 'studentPinLogin')({
        loginId: 'legacy-john',
        pin: '1234',
      })
      assert.ok(res.data.token)

      const userCred = await signInWithCustomToken(auth, res.data.token)
      assert.equal(userCred.user.uid, 'legacy-auth-john')
      const tokenResult = await getIdTokenResult(userCred.user, true)
      assert.equal(tokenResult.claims.role, 'student')
      assert.equal(tokenResult.claims.classroomId, 'morgan')
      assert.equal(tokenResult.claims.studentId, 's-legacy-john')
    })

    it('resets a PIN through the untouched legacy hardcoded-teacher path', async () => {
      const customToken = await adminAuth.createCustomToken(LEGACY_TEACHER_UID)
      const oldHash = await bcrypt.hash('0000', 12)
      await db.collection('studentCredentials').doc('legacy-stu').set({
        schemaVersion: 1,
        loginId: 'legacy-stu',
        pinHash: oldHash,
        authUid: 'legacy-auth-stu',
        classroomId: 'morgan',
        studentId: 's-legacy-stu',
        active: false,
        failedAttempts: 3,
        lockedUntil: null,
      })

      const { auth, functions } = createTestClientApp()
      await signInWithCustomToken(auth, customToken)

      // The legacy request contract still carries classroomId.
      const res = await httpsCallable(functions, 'resetStudentPin')({
        classroomId: 'morgan',
        studentId: 's-legacy-stu',
        newPin: '9999',
      })
      assert.equal(res.data.success, true)

      const doc = await db.collection('studentCredentials').doc('legacy-stu').get()
      assert.equal(await bcrypt.compare('9999', doc.data().pinHash), true)
      assert.equal(doc.data().active, true)
      assert.equal(doc.data().failedAttempts, 0)
    })

    it('denies the legacy reset to a non-hardcoded teacher UID', async () => {
      const customToken = await adminAuth.createCustomToken('not-the-legacy-teacher')
      const { auth, functions } = createTestClientApp()
      await signInWithCustomToken(auth, customToken)
      await expectCallableError(
        () => httpsCallable(functions, 'resetStudentPin')({
          classroomId: 'morgan',
          studentId: 's-legacy-stu',
          newPin: '9999',
        }),
        'permission-denied',
      )
    })

    it('provisions the legacy Phase 1 foundation through ensureTeacherClassroom', async () => {
      const customToken = await adminAuth.createCustomToken(LEGACY_TEACHER_UID)
      const { auth, functions } = createTestClientApp()
      await signInWithCustomToken(auth, customToken)

      const res = await httpsCallable(functions, 'ensureTeacherClassroom')({})
      assert.equal(res.data.created, true)
      assert.equal(res.data.teacherUid, LEGACY_TEACHER_UID)
      assert.ok(res.data.classroomId)

      const classroom = await db.collection('classrooms').doc(res.data.classroomId).get()
      assert.equal(classroom.exists, true)
      assert.equal(classroom.data().ownerUid, LEGACY_TEACHER_UID)

      const repeat = await httpsCallable(functions, 'ensureTeacherClassroom')({})
      assert.equal(repeat.data.created, false)
      assert.equal(repeat.data.classroomId, res.data.classroomId)
    })

    it('keeps the legacy syncStudentProfiles trigger authoritative for flat credentials', async () => {
      await db.collection('morganBank').doc('classroomData').set({
        students: [{ id: 1, name: 'Alice Smith', balance: 5 }],
      })

      const cred = await waitFor(async () => {
        const doc = await db.collection('studentCredentials').doc('alice-smith').get()
        return doc.exists ? doc.data() : null
      }, { label: 'legacy flat credential alice-smith' })

      assert.equal(cred.classroomId, 'morgan')
      assert.equal(cred.studentId, '1')
      assert.equal(cred.active, false)
      assert.equal(cred.authUid, 'alice-smith')
    })

    it('leaves the V2 sync trigger completely inert on a scoped student write', async () => {
      const classroomId = 'gate-off-classroom'
      await db.collection('classrooms').doc(classroomId).set({
        ownerUid: 'gate-off-teacher',
        name: 'Gate Off Room',
        version: 1,
        settings: {},
        studentLoginCode: 'ABCD-2345',
      })
      await db.collection('teachers').doc('gate-off-teacher').set({
        uid: 'gate-off-teacher',
        classroomId,
        status: 'active',
        displayName: '',
        email: 'gate.off@school.org',
      })
      await studentDocRef(classroomId, 's-inert').set({ name: 'Inert Student' })

      await waitForStableAbsence(async () => {
        const snap = await credentialsRef(classroomId).get()
        return snap.size > 0
      }, { label: 'a scoped V2 credential while the gate is off' })
    })
  })
}

// ===========================================================================
// GATE-ON
// ===========================================================================

if (testMode === 'gate-on') {
  const INDEX_SPECIFIER = './index.js'
  const INDEX_URL = pathToFileURL(path.join(FUNCTIONS_DIR, 'index.js')).href

  /** Child-process discovery and per-invocation guard probe. */
  const GUARD_PROBE = [
    "const { getApps, initializeApp } = await import('firebase-admin/app')",
    'let threw = false',
    'let message = ""',
    'let imported = null',
    'let invocation = null',
    'const warningCategories = []',
    'console.warn = (_message, details) => { warningCategories.push(details?.category || null) }',
    `try { imported = await import(${JSON.stringify(INDEX_SPECIFIER)}) }`,
    'catch (error) { threw = true; message = String(error && error.message) }',
    'if (imported && process.env.FORCE_POST_GATE_APP_GUARD === "true") { initializeApp({}, "phase2b-guard-probe-second-app") }',
    'if (imported && process.env.RUN_V2_PROBE === "true") {',
    '  try { await imported.studentPinLoginV2.run({ data: {} }); invocation = { succeeded: true } }',
    '  catch (error) { invocation = { succeeded: false, code: error?.code || null, message: String(error?.message || error) } }',
    '}',
    "console.log('GUARD_RESULT ' + JSON.stringify({ threw, apps: getApps().length, message, invocation, warningCategories, reviewedRelease: imported?.REVIEWED_V2_FUNCTIONS_RELEASE_ID || null, releaseParamAvailable: Boolean(imported?.MULTI_TEACHER_V2_RELEASE_ID), exportsAvailable: Boolean(imported?.studentPinLogin && imported?.studentPinLoginV2 && imported?.createTeacherInvitationV2 && imported?.revokeTeacherInvitationV2 && imported?.syncStudentProfilesV2 && imported?.submitStudentTransactionV2) }))",
    'process.exit(0)',
  ].join('\n')

  const BASE_GUARD_ENV = Object.freeze({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    FUNCTIONS_EMULATOR: 'true',
    FIRESTORE_EMULATOR_HOST: firestoreHost,
    FIREBASE_AUTH_EMULATOR_HOST: authHost,
    GCLOUD_PROJECT: GATE_ON_PROJECT_ID,
    MULTI_TEACHER_V2_ENABLED: 'true',
    MULTI_TEACHER_V2_MAINTENANCE_MODE: 'normal',
    MORGAN_BANK_DEPLOYMENT_TIER: 'production',
    MORGAN_BANK_STAGING_PROJECT_ID: '',
  })

  function runGuardProbe(envOverrides) {
    const env = { ...BASE_GUARD_ENV, ...envOverrides }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete env[key]
    }
    const stdout = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', GUARD_PROBE],
      { cwd: FUNCTIONS_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const line = stdout.split('\n').find(l => l.startsWith('GUARD_RESULT '))
    assert.ok(line, `guard probe produced no parseable result: ${stdout}`)
    return JSON.parse(line.slice('GUARD_RESULT '.length))
  }

  function assertDiscoverySurvives(envOverrides, label) {
    const result = runGuardProbe(envOverrides)
    assert.equal(result.threw, false, `${label}: module discovery must not throw`)
    assert.ok(result.apps === 0 || result.apps === 1, `${label}: discovery created an invalid Admin app count`)
    assert.equal(result.exportsAvailable, true, `${label}: legacy and V2 exports must remain discoverable`)
    assert.equal(result.releaseParamAvailable, true, `${label}: the release parameter must remain declared`)
  }

  function assertV2RefusedAtInvocation(envOverrides, label) {
    const result = runGuardProbe({ ...envOverrides, RUN_V2_PROBE: 'true' })
    assert.equal(result.threw, false, `${label}: module discovery must not throw`)
    assert.equal(result.exportsAvailable, true, `${label}: exports must remain discoverable`)
    assert.equal(result.releaseParamAvailable, true, `${label}: the release parameter must remain declared`)
    assert.deepEqual(result.invocation, {
      succeeded: false,
      code: 'failed-precondition',
      message: 'Multi-teacher V2 is disabled.',
    })
    return result
  }

  describe('Gate-on: real-emulator V2 acceptance', () => {
    before(async () => {
      assert.equal(INDEX_URL.startsWith('file://'), true)
      const [host, port] = firestoreHost.split(':')
      gateOnRulesEnvironment = await initializeTestEnvironment({
        projectId: expectedProject,
        firestore: {
          rules: readFileSync(FINAL_RULES_PATH, 'utf8'),
          host,
          port: Number(port),
        },
      })
    })

    beforeEach(async () => {
      await cleanupClientApps()
      await clearEmulators()
    })

    // -----------------------------------------------------------------------
    describe('A. Discovery-safe per-invocation environment guards', () => {
      it('keeps discovery alive with a missing Auth emulator host', () => {
        assertDiscoverySurvives({ FIREBASE_AUTH_EMULATOR_HOST: undefined }, 'missing auth host')
      })

      it('keeps discovery alive with a missing Firestore emulator host', () => {
        assertDiscoverySurvives({ FIRESTORE_EMULATOR_HOST: undefined }, 'missing firestore host')
      })

      it('keeps discovery alive when FUNCTIONS_EMULATOR is not exactly "true"', () => {
        assertDiscoverySurvives({ FUNCTIONS_EMULATOR: 'TRUE' }, 'FUNCTIONS_EMULATOR=TRUE')
        assertDiscoverySurvives({ FUNCTIONS_EMULATOR: '1' }, 'FUNCTIONS_EMULATOR=1')
        assertDiscoverySurvives({ FUNCTIONS_EMULATOR: undefined }, 'FUNCTIONS_EMULATOR unset')
      })

      it('keeps discovery alive with malformed host:port values', () => {
        assertDiscoverySurvives({ FIRESTORE_EMULATOR_HOST: '127.0.0.1' }, 'firestore without port')
        assertDiscoverySurvives({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:notaport' }, 'firestore bad port')
        assertDiscoverySurvives({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099:9099' }, 'auth extra colon')
        assertDiscoverySurvives({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:0' }, 'auth port zero')
      })

      it('keeps discovery alive with a non-loopback Auth host', () => {
        assertDiscoverySurvives({ FIREBASE_AUTH_EMULATOR_HOST: '10.0.0.5:9099' }, 'non-loopback auth')
        assertDiscoverySurvives(
          { FIREBASE_AUTH_EMULATOR_HOST: 'identitytoolkit.googleapis.com:443' },
          'production auth host',
        )
      })

      it('keeps discovery alive with a non-loopback Firestore host', () => {
        assertDiscoverySurvives({ FIRESTORE_EMULATOR_HOST: '192.168.1.1:8080' }, 'non-loopback firestore')
        assertDiscoverySurvives(
          { FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' },
          'production firestore host',
        )
      })

      it('keeps discovery alive with a missing project identity', () => {
        assertDiscoverySurvives(
          { GCLOUD_PROJECT: undefined, FIREBASE_CONFIG: undefined },
          'no project at all',
        )
      })

      it('keeps discovery alive with conflicting project sources', () => {
        assertDiscoverySurvives(
          {
            GCLOUD_PROJECT: GATE_ON_PROJECT_ID,
            FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-some-other-project' }),
          },
          'conflicting project ids',
        )
        assertDiscoverySurvives(
          { GCLOUD_PROJECT: undefined, FIREBASE_CONFIG: '{not json' },
          'unparseable FIREBASE_CONFIG',
        )
      })

      it('keeps discovery alive for production and non-allowlisted identities', () => {
        assertDiscoverySurvives({ GCLOUD_PROJECT: 'morgan-bank' }, 'production project with emulator flags')
        assertDiscoverySurvives({ GCLOUD_PROJECT: GATE_OFF_PROJECT_ID }, 'gate-off project with gate on')
      })

      it('accepts the valid demo-project emulator environment and initializes exactly one app', () => {
        const result = runGuardProbe({})
        assert.equal(result.threw, false, `valid environment threw: ${result.message}`)
        assert.equal(result.apps, 1)
      })

      it('fails only the V2 invocation for an invalid emulator identity', () => {
        assertV2RefusedAtInvocation({ GCLOUD_PROJECT: GATE_OFF_PROJECT_ID }, 'wrong demo project')
        assertV2RefusedAtInvocation({ FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' }, 'non-loopback host')
      })

      it('requires the production release parameter to match the reviewed Functions artifact', () => {
        const production = {
          FUNCTIONS_EMULATOR: undefined,
          FIRESTORE_EMULATOR_HOST: undefined,
          FIREBASE_AUTH_EMULATOR_HOST: undefined,
          FIREBASE_CONFIG: undefined,
          GCLOUD_PROJECT: 'morgan-bank',
          MULTI_TEACHER_V2_RELEASE_ID: 'wrong-release',
        }
        const rejected = assertV2RefusedAtInvocation({
          ...production,
          FORCE_POST_GATE_APP_GUARD: 'true',
        }, 'mismatched production release')
        assert.deepEqual(rejected.warningCategories, ['release-id-mismatch'])
        const accepted = runGuardProbe({
          ...production,
          MULTI_TEACHER_V2_RELEASE_ID: 'student-money-functions-v3',
          FORCE_POST_GATE_APP_GUARD: 'true',
          RUN_V2_PROBE: 'true',
        })
        assert.equal(accepted.threw, false)
        assert.equal(accepted.reviewedRelease, 'student-money-functions-v3')
        assert.deepEqual(accepted.invocation, {
          succeeded: false,
          code: 'failed-precondition',
          message: 'Multi-teacher V2 is disabled.',
        })
        assert.deepEqual(accepted.warningCategories, ['invalid-runtime'])
      })

      it('defaults an absent deployed tier to production at the real parameter boundary', () => {
        const accepted = runGuardProbe({
          FUNCTIONS_EMULATOR: undefined,
          FIRESTORE_EMULATOR_HOST: undefined,
          FIREBASE_AUTH_EMULATOR_HOST: undefined,
          FIREBASE_CONFIG: undefined,
          GCLOUD_PROJECT: 'morgan-bank',
          MULTI_TEACHER_V2_RELEASE_ID: 'student-money-functions-v3',
          MORGAN_BANK_DEPLOYMENT_TIER: undefined,
          FORCE_POST_GATE_APP_GUARD: 'true',
          RUN_V2_PROBE: 'true',
        })
        assert.equal(accepted.threw, false)
        assert.deepEqual(accepted.invocation, {
          succeeded: false,
          code: 'failed-precondition',
          message: 'Multi-teacher V2 is disabled.',
        })
        assert.deepEqual(accepted.warningCategories, ['invalid-runtime'])
      })
    })

    // -----------------------------------------------------------------------
    describe('A2. Gate-on legacy compatibility refusal', () => {
      const maintenanceMessage = 'This client version is unavailable during multi-teacher maintenance.'

      it('rejects legacy login, PIN reset, and bootstrap before any legacy read or write', async () => {
        const oldHash = await bcrypt.hash('1234', 12)
        const credentialRef = db.collection('studentCredentials').doc('legacy-gate-on')
        await credentialRef.set({
          schemaVersion: 1,
          loginId: 'legacy-gate-on',
          pinHash: oldHash,
          authUid: 'legacy-gate-on-auth',
          classroomId: 'morgan',
          studentId: '77',
          active: true,
          failedAttempts: 4,
          lockedUntil: null,
        })

        const anonymous = createTestClientApp()
        await expectCallableError(
          () => httpsCallable(anonymous.functions, 'studentPinLogin')({
            loginId: 'legacy-gate-on', pin: '1234',
          }),
          'failed-precondition',
          maintenanceMessage,
        )
        assert.equal((await db.collection('studentAuthLogs').get()).size, 0)
        assert.equal((await credentialRef.get()).data().failedAttempts, 4)

        const teacherToken = await adminAuth.createCustomToken(LEGACY_TEACHER_UID)
        const teacher = createTestClientApp()
        await signInWithCustomToken(teacher.auth, teacherToken)
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPin')({
            classroomId: 'morgan', studentId: '77', newPin: '9999',
          }),
          'failed-precondition',
          maintenanceMessage,
        )
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'ensureTeacherClassroom')({}),
          'failed-precondition',
          maintenanceMessage,
        )

        const after = (await credentialRef.get()).data()
        assert.equal(after.pinHash, oldHash)
        assert.equal(after.failedAttempts, 4)
        assert.equal((await db.collection('teachers').get()).size, 0)
        assert.equal((await db.collection('classrooms').get()).size, 0)
      })

      it('keeps the legacy aggregate trigger inert while the V2 gate is on', async () => {
        await db.collection('morganBank').doc('classroomData').set({
          students: [{ id: 88, name: 'Must Not Sync', balance: 50 }],
          transactions: [],
        })

        await waitForStableAbsence(async () => {
          const [credential, mirror] = await Promise.all([
            db.collection('studentCredentials').doc('must-not-sync').get(),
            db.collection('classrooms').doc('morgan').collection('students').doc('88').get(),
          ])
          return credential.exists || mirror.exists
        }, { label: 'a legacy trigger write while V2 is authoritative' })
      })
    })

    // -----------------------------------------------------------------------
    describe('B. Real Firestore transaction semantics', () => {
      it('rejects a read that follows a write inside one transaction', async () => {
        const docRef = db.collection('txProbe').doc('read-after-write')
        await assert.rejects(
          () => db.runTransaction(async tx => {
            tx.set(docRef, { val: 1 })
            await tx.get(docRef)
          }),
          error => /reads.*before.*writes|reads after writes/i.test(error.message),
        )
      })

      it('commits nothing when the transaction callback throws', async () => {
        const docRef = db.collection('txProbe').doc('aborted')
        await assert.rejects(
          () => db.runTransaction(async tx => {
            tx.set(docRef, { val: 100 })
            throw new Error('Simulated abort')
          }),
          error => error.message === 'Simulated abort',
        )
        assert.equal((await docRef.get()).exists, false)
      })

      it('loses no update when concurrent transactions contend for one document', async () => {
        // Retry-side-effect safety: a callback the SDK re-runs must not double
        // count or drop an increment. Every write here is transactional, so the
        // emulator's pessimistic range locks cannot deadlock against a
        // non-transactional write issued from inside a callback.
        const docRef = db.collection('txProbe').doc('counter')
        await docRef.set({ count: 0 })

        let callbackRuns = 0
        const increment = () => db.runTransaction(async tx => {
          callbackRuns += 1
          const snap = await tx.get(docRef)
          tx.update(docRef, { count: snap.data().count + 1 })
        })

        await Promise.all([increment(), increment(), increment()])

        assert.equal((await docRef.get()).data().count, 3, 'a concurrent increment was lost')
        assert.ok(callbackRuns >= 3)
      })

      it('fails transaction.create against an existing document', async () => {
        const docRef = db.collection('txProbe').doc('create-existing')
        await docRef.set({ val: 'existing' })
        await assert.rejects(
          () => db.runTransaction(async tx => { tx.create(docRef, { val: 'new' }) }),
          error => /ALREADY_EXISTS|already exists/i.test(error.message),
        )
      })

      it('fails transaction.update against a missing document', async () => {
        const docRef = db.collection('txProbe').doc('update-missing')
        await assert.rejects(
          () => db.runTransaction(async tx => { tx.update(docRef, { val: 'x' }) }),
          error => /NOT_FOUND|no document to update/i.test(error.message),
        )
      })

      it('makes the create precondition, not the query, the uniqueness enforcer', async () => {
        // This is the exact shape the V2 sync handler relies on: query the
        // classroom's credentials for a studentId, then create the credential.
        // Two facts have to hold for that to be safe.
        const col = db.collection('txProbe').doc('query-insert').collection('rows')

        // 1. A transaction query is a read of committed state at read time.
        await col.doc('pre-existing').set({ studentId: 'x1' })
        let observed = null
        await db.runTransaction(async tx => {
          const snap = await tx.get(col.where('studentId', '==', 'x1').limit(2))
          observed = snap.size
          tx.set(col.doc('marker'), { ok: true })
        })
        assert.equal(observed, 1, 'a transaction query must observe already committed matches')

        // 2. Two concurrent transactions can each read an empty query result, so
        //    the query alone cannot make the write unique. Only the `create`
        //    precondition on the deterministic document ID does: exactly one
        //    commits and the loser gets ALREADY_EXISTS, which is the retry
        //    signal the sync handler acts on.
        const raceCol = db.collection('txProbe').doc('create-race').collection('rows')
        const attempt = who => db.runTransaction(async tx => {
          await tx.get(raceCol.where('studentId', '==', 'x2').limit(2))
          tx.create(raceCol.doc('deterministic-id'), { studentId: 'x2', who })
        })
        const settled = await Promise.allSettled([attempt('a'), attempt('b')])

        const fulfilled = settled.filter(r => r.status === 'fulfilled')
        const rejected = settled.filter(r => r.status === 'rejected')
        assert.equal(fulfilled.length, 1, 'exactly one concurrent create may commit')
        assert.equal(rejected.length, 1)
        assert.match(String(rejected[0].reason.message), /ALREADY_EXISTS|already exists/i)

        const rows = await raceCol.where('studentId', '==', 'x2').get()
        assert.equal(rows.size, 1, 'the create precondition must leave exactly one document')
      })
    })

    // -----------------------------------------------------------------------
    describe('C0. Platform-admin teacher invitation workflow', () => {
      it('denies unauthenticated, ordinary-teacher, and request-forged authority', async () => {
        const unauthenticated = createTestClientApp()
        await expectCallableError(
          () => httpsCallable(unauthenticated.functions, 'createTeacherInvitationV2')({
            email: 'friend@school.org',
            expiresInHours: 48,
          }),
          'unauthenticated',
          'Sign in required.',
        )

        const ordinary = await signInAsGoogleUser('ordinary@school.org')
        await expectCallableError(
          () => httpsCallable(ordinary.functions, 'createTeacherInvitationV2')({
            email: 'friend@school.org',
            expiresInHours: 48,
          }),
          'permission-denied',
          'Platform administrator access is required.',
        )
        await expectCallableError(
          () => httpsCallable(ordinary.functions, 'createTeacherInvitationV2')({
            email: 'friend@school.org',
            expiresInHours: 48,
            platformAdmin: true,
          }),
          'permission-denied',
          'Platform administrator access is required.',
        )

        const student = createTestClientApp()
        await signInWithCustomToken(
          student.auth,
          await adminAuth.createCustomToken('student-admin-conflict', {
            role: 'student',
            classroomId: 'student-classroom',
            studentId: '1',
            platformAdmin: true,
          }),
        )
        await expectCallableError(
          () => httpsCallable(student.functions, 'createTeacherInvitationV2')({
            email: 'friend@school.org',
            expiresInHours: 48,
          }),
          'permission-denied',
          'Platform administrator access is required.',
        )

        assert.equal(
          (await db.collection('teacherInvitations').get()).size,
          0,
          'denied callers must not create or inspect invitation state',
        )
      })

      it('creates and revokes one exact invitation idempotently', async () => {
        const adminIdentity = await signInAsPlatformAdmin('platform.admin@school.org')
        const createInvitation = httpsCallable(
          adminIdentity.functions,
          'createTeacherInvitationV2',
        )
        const revokeInvitation = httpsCallable(
          adminIdentity.functions,
          'revokeTeacherInvitationV2',
        )
        const email = 'invited.teacher@school.org'

        const created = await createInvitation({ email: ` ${email.toUpperCase()} `, expiresInHours: 24 })
        assert.deepEqual(created.data, { success: true, status: 'active', created: true })

        const invitationRef = db.collection('teacherInvitations').doc(sha256Hex(email))
        const firstSnapshot = await invitationRef.get()
        assert.equal(firstSnapshot.exists, true)
        assert.deepEqual(Object.keys(firstSnapshot.data()).sort(), [
          'createdAt', 'email', 'expiresAt', 'status',
        ])
        assert.equal(firstSnapshot.data().email, email)
        assert.equal(firstSnapshot.data().status, 'active')
        assert.ok(firstSnapshot.data().createdAt instanceof admin.firestore.Timestamp)
        assert.ok(firstSnapshot.data().expiresAt instanceof admin.firestore.Timestamp)
        assert.ok(firstSnapshot.data().expiresAt.toMillis() > firstSnapshot.data().createdAt.toMillis())

        const repeated = await createInvitation({ email, expiresInHours: 168 })
        assert.deepEqual(repeated.data, { success: true, status: 'active', created: false })
        const repeatedSnapshot = await invitationRef.get()
        assert.equal(
          repeatedSnapshot.data().expiresAt.toMillis(),
          firstSnapshot.data().expiresAt.toMillis(),
          'an active retry must not silently extend the invitation',
        )

        const revoked = await revokeInvitation({ email })
        assert.deepEqual(revoked.data, { success: true, status: 'revoked', revoked: true })
        assert.equal((await invitationRef.get()).data().status, 'revoked')

        const repeatedRevoke = await revokeInvitation({ email })
        assert.deepEqual(repeatedRevoke.data, {
          success: true,
          status: 'revoked',
          revoked: false,
        })

        const deniedTeacher = await signInAsGoogleUser(email)
        await expectCallableError(
          () => httpsCallable(deniedTeacher.functions, 'onboardTeacherClassroomV2')({
            classroomName: 'Revoked Room',
          }),
          'permission-denied',
          'This account is not eligible to complete this action.',
        )
      })

      it('authorizes the signed founding UID without requiring a custom claim', async () => {
        const client = createTestClientApp()
        const customToken = await adminAuth.createCustomToken(LEGACY_TEACHER_UID)
        await signInWithCustomToken(client.auth, customToken)
        const claims = await getIdTokenResult(client.auth.currentUser, true)
        assert.equal(claims.claims.platformAdmin, undefined)

        const result = await httpsCallable(client.functions, 'createTeacherInvitationV2')({
          email: 'founding.invite@school.org',
          expiresInHours: 48,
        })
        assert.deepEqual(result.data, { success: true, status: 'active', created: true })
        assert.equal(
          (
            await db
              .collection('teacherInvitations')
              .doc(sha256Hex('founding.invite@school.org'))
              .get()
          ).data().status,
          'active',
        )
      })

      it('serializes simultaneous invitation creation to one durable active document', async () => {
        const adminIdentity = await signInAsPlatformAdmin('race.admin@school.org')
        const createInvitation = httpsCallable(
          adminIdentity.functions,
          'createTeacherInvitationV2',
        )
        const email = 'race.invite@school.org'

        const results = await Promise.all([
          createInvitation({ email, expiresInHours: 48 }),
          createInvitation({ email, expiresInHours: 48 }),
          createInvitation({ email, expiresInHours: 48 }),
        ])

        assert.equal(results.filter(result => result.data.created === true).length, 1)
        assert.equal(results.filter(result => result.data.created === false).length, 2)
        const invitations = await db.collection('teacherInvitations').get()
        assert.equal(invitations.size, 1)
        assert.equal(invitations.docs[0].id, sha256Hex(email))
        assert.equal(invitations.docs[0].data().status, 'active')
      })

      it('uses admin-created invitations to onboard two isolated teacher accounts', async () => {
        const adminIdentity = await signInAsPlatformAdmin('multi.admin@school.org')
        const createInvitation = httpsCallable(
          adminIdentity.functions,
          'createTeacherInvitationV2',
        )
        const teacherEmails = ['friend.one@school.org', 'friend.two@school.org']

        for (const email of teacherEmails) {
          const result = await createInvitation({ email, expiresInHours: 48 })
          assert.deepEqual(result.data, { success: true, status: 'active', created: true })
        }

        const identities = await Promise.all(teacherEmails.map(email => signInAsGoogleUser(email)))
        const onboarded = []
        for (const [index, identity] of identities.entries()) {
          const eligibility = await httpsCallable(identity.functions, 'resolveTeacherTenantV2')({})
          assert.deepEqual(eligibility.data, {
            state: 'onboarding-required',
            eligibility: 'invited',
          })
          const response = await httpsCallable(identity.functions, 'onboardTeacherClassroomV2')({
            classroomName: `Friend Room ${index + 1}`,
          })
          onboarded.push({ identity, response: response.data })
        }

        assert.notEqual(onboarded[0].response.classroom.id, onboarded[1].response.classroom.id)
        assert.equal(
          (await db.collection('teachers').get()).size,
          2,
          'each invited friend must receive a separate teacher document',
        )
        assert.equal(
          (await db.collection('classrooms').get()).size,
          2,
          'each invited friend must receive a separate classroom document',
        )

        for (const [index, { identity, response }] of onboarded.entries()) {
          const ownDb = gateOnRulesEnvironment.authenticatedContext(identity.uid).firestore()
          const foreign = onboarded[index === 0 ? 1 : 0].response.classroom.id
          await assertSucceeds(ownDb.doc(`classrooms/${response.classroom.id}`).get())
          await assertFails(ownDb.doc(`classrooms/${foreign}`).get())

          const invitation = await db
            .collection('teacherInvitations')
            .doc(sha256Hex(identity.email))
            .get()
          assert.equal(invitation.data().status, 'consumed')
          assert.equal(invitation.data().consumedByUid, identity.uid)
        }

        await expectCallableError(
          () => createInvitation({ email: teacherEmails[0], expiresInHours: 48 }),
          'failed-precondition',
          'This invitation cannot be changed automatically.',
        )

        await expectCallableError(
          () => httpsCallable(identities[0].functions, 'createTeacherInvitationV2')({
            email: 'friend.three@school.org',
            expiresInHours: 48,
          }),
          'permission-denied',
          'Platform administrator access is required.',
        )
      })
    })

    // -----------------------------------------------------------------------
    describe('C. Teacher onboarding and tenant resolution', () => {
      it('onboards an invited Google teacher and returns the nested contract', async () => {
        await seedInvitation('teacher.a@school.org')
        const teacher = await signInAsGoogleUser('teacher.a@school.org')
        await assertGoogleIdentity(teacher.tokenResult, 'teacher.a@school.org')

        const res = await httpsCallable(teacher.functions, 'onboardTeacherClassroomV2')({
          classroomName: 'Classroom Alpha',
        })
        assert.equal(res.data.created, true)
        assert.equal(res.data.teacher.uid, teacher.uid)
        assert.equal(res.data.teacher.status, 'active')
        assert.equal(res.data.teacher.email, 'teacher.a@school.org')
        assert.equal(res.data.classroom.name, 'Classroom Alpha')
        assert.match(res.data.classroom.studentLoginCode, /^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/)
        assert.equal(res.data.classroomId, undefined, 'the contract is nested, not flat')

        const classroomId = res.data.classroom.id
        const classroom = await db.collection('classrooms').doc(classroomId).get()
        assert.equal(classroom.data().ownerUid, teacher.uid)
        assert.equal(classroom.data().studentLoginCode, res.data.classroom.studentLoginCode)

        const teacherDoc = await db.collection('teachers').doc(teacher.uid).get()
        assert.equal(teacherDoc.data().classroomId, classroomId)
        assert.equal(teacherDoc.data().status, 'active')

        const codeDoc = await db
          .collection('classroomLoginCodes')
          .doc(canonicalizeCode(res.data.classroom.studentLoginCode))
          .get()
        assert.equal(codeDoc.data().classroomId, classroomId)
        assert.equal(codeDoc.data().status, 'active')

        const invitation = await db
          .collection('teacherInvitations')
          .doc(sha256Hex('teacher.a@school.org'))
          .get()
        assert.equal(invitation.data().status, 'consumed')
        assert.equal(invitation.data().consumedByUid, teacher.uid)
      })

      it('is idempotent: a repeated onboarding returns the same classroom and code', async () => {
        const teacher = await onboardGoogleTeacher('idem@school.org', 'Idempotent Room')
        const repeat = await httpsCallable(teacher.functions, 'onboardTeacherClassroomV2')({
          classroomName: 'A Completely Different Name',
        })
        assert.equal(repeat.data.created, false)
        assert.equal(repeat.data.classroom.id, teacher.classroomId)
        assert.equal(repeat.data.classroom.studentLoginCode, teacher.studentLoginCode)
        // The retry must not rename the classroom.
        assert.equal(repeat.data.classroom.name, 'Idempotent Room')

        const classrooms = await db.collection('classrooms').where('ownerUid', '==', teacher.uid).get()
        assert.equal(classrooms.size, 1)
      })

      it('consumes one invitation exactly once under simultaneous onboarding calls', async () => {
        await seedInvitation('race@school.org')
        const teacher = await signInAsGoogleUser('race@school.org')
        const onboard = httpsCallable(teacher.functions, 'onboardTeacherClassroomV2')

        const settled = await Promise.allSettled([
          onboard({ classroomName: 'Race Room 1' }),
          onboard({ classroomName: 'Race Room 2' }),
          onboard({ classroomName: 'Race Room 3' }),
        ])

        const fulfilled = settled.filter(r => r.status === 'fulfilled')
        assert.ok(fulfilled.length >= 1, 'at least one concurrent onboarding must succeed')
        const ids = new Set(fulfilled.map(r => r.value.data.classroom.id))
        assert.equal(ids.size, 1, 'concurrent onboarding produced more than one classroom')
        assert.equal(
          fulfilled.filter(r => r.value.data.created === true).length,
          1,
          'exactly one call may report that it created the foundation',
        )
        for (const rejected of settled.filter(r => r.status === 'rejected')) {
          assert.match(rejected.reason.code, /^functions\/(aborted|resource-exhausted|failed-precondition|already-exists)$/)
        }

        const classroomId = [...ids][0]
        assert.equal((await db.collection('classrooms').where('ownerUid', '==', teacher.uid).get()).size, 1)
        assert.equal(
          (await db.collection('classroomLoginCodes').where('classroomId', '==', classroomId).get()).size,
          1,
        )
        const invitation = await db.collection('teacherInvitations').doc(sha256Hex('race@school.org')).get()
        assert.equal(invitation.data().status, 'consumed')
        assert.equal(invitation.data().consumedByUid, teacher.uid)
      })

      it('denies an uninvited Google user generically', async () => {
        const uninvited = await signInAsGoogleUser('uninvited@school.org')
        await assertGoogleIdentity(uninvited.tokenResult, 'uninvited@school.org')
        await expectCallableError(
          () => httpsCallable(uninvited.functions, 'onboardTeacherClassroomV2')({ classroomName: 'Nope' }),
          'permission-denied',
          'This account is not eligible to complete this action.',
        )
        await expectCallableError(
          () => httpsCallable(uninvited.functions, 'resolveTeacherTenantV2')({}),
          'permission-denied',
        )
        assert.equal((await db.collection('teachers').get()).size, 0)
        assert.equal((await db.collection('classrooms').get()).size, 0)
      })

      it('denies a non-Google identity even with a verified email and a live invitation', async () => {
        await seedInvitation('password.user@school.org')
        await adminAuth.createUser({
          email: 'password.user@school.org',
          password: 'correct-horse-battery',
          emailVerified: true,
        })
        const client = createTestClientApp()
        const userCred = await signInWithEmailAndPassword(
          client.auth,
          'password.user@school.org',
          'correct-horse-battery',
        )
        const tokenResult = await getIdTokenResult(userCred.user, true)
        assert.equal(tokenResult.claims.email_verified, true)
        assert.equal(tokenResult.claims.firebase?.sign_in_provider, 'password')

        await expectCallableError(
          () => httpsCallable(client.functions, 'onboardTeacherClassroomV2')({ classroomName: 'Nope' }),
          'permission-denied',
        )
        assert.equal((await db.collection('teachers').get()).size, 0)
      })

      it('denies an anonymous custom-token identity', async () => {
        const client = createTestClientApp()
        await signInWithCustomToken(client.auth, await adminAuth.createCustomToken('custom-only-uid'))
        await expectCallableError(
          () => httpsCallable(client.functions, 'onboardTeacherClassroomV2')({ classroomName: 'Nope' }),
          'permission-denied',
        )
      })

      it('denies a disabled teacher in both onboarding and resolution', async () => {
        const teacher = await onboardGoogleTeacher('disabled@school.org', 'Disabled Room')
        await db.collection('teachers').doc(teacher.uid).update({ status: 'disabled' })

        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resolveTeacherTenantV2')({}),
          'permission-denied',
        )
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'onboardTeacherClassroomV2')({ classroomName: 'X' }),
          'permission-denied',
        )
      })

      it('fails closed on a malformed teacher classroom reference', async () => {
        const teacher = await onboardGoogleTeacher('malformed@school.org', 'Malformed Room')
        await db.collection('teachers').doc(teacher.uid).update({ classroomId: 'bad/id' })
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resolveTeacherTenantV2')({}),
          'failed-precondition',
        )
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'onboardTeacherClassroomV2')({ classroomName: 'X' }),
          'failed-precondition',
        )
      })

      it('fails closed on a missing classroom document', async () => {
        const teacher = await onboardGoogleTeacher('missingroom@school.org', 'Missing Room')
        await db.collection('classrooms').doc(teacher.classroomId).delete()
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resolveTeacherTenantV2')({}),
          'failed-precondition',
        )
      })

      it('fails closed on an inconsistent reciprocal ownership link', async () => {
        const teacher = await onboardGoogleTeacher('inconsistent@school.org', 'Inconsistent Room')
        await db.collection('classrooms').doc(teacher.classroomId).update({ ownerUid: 'someone-else' })
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resolveTeacherTenantV2')({}),
          'failed-precondition',
        )
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'onboardTeacherClassroomV2')({ classroomName: 'X' }),
          'failed-precondition',
        )
      })

      it('blocks rather than repairs a duplicate classroom login-code index', async () => {
        const teacher = await onboardGoogleTeacher('dupcode@school.org', 'Dup Code Room')
        await db.collection('classroomLoginCodes').doc('BBBB3333').set({
          classroomId: teacher.classroomId,
          status: 'active',
        })
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'onboardTeacherClassroomV2')({ classroomName: 'X' }),
          'failed-precondition',
        )
        // The duplicate is left for administrative reconciliation, not deleted.
        assert.equal(
          (await db.collection('classroomLoginCodes').where('classroomId', '==', teacher.classroomId).get()).size,
          2,
        )
      })

      it('rejects unknown fields on both V2 tenant callables', async () => {
        const teacher = await onboardGoogleTeacher('fields@school.org', 'Fields Room')
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resolveTeacherTenantV2')({ classroomId: teacher.classroomId }),
          'invalid-argument',
        )
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'onboardTeacherClassroomV2')({
            classroomName: 'X',
            classroomId: teacher.classroomId,
          }),
          'invalid-argument',
        )
      })

      it('resolves each teacher only to their own tenant, in both directions', async () => {
        const teacherA = await onboardGoogleTeacher('iso.a@school.org', 'Iso Room A')
        const teacherB = await onboardGoogleTeacher('iso.b@school.org', 'Iso Room B')
        assert.notEqual(teacherA.classroomId, teacherB.classroomId)

        const resA = await httpsCallable(teacherA.functions, 'resolveTeacherTenantV2')({})
        assert.equal(resA.data.state, 'active')
        assert.equal(resA.data.teacher.uid, teacherA.uid)
        assert.equal(resA.data.classroom.id, teacherA.classroomId)
        assert.notEqual(resA.data.classroom.id, teacherB.classroomId)

        const resB = await httpsCallable(teacherB.functions, 'resolveTeacherTenantV2')({})
        assert.equal(resB.data.state, 'active')
        assert.equal(resB.data.teacher.uid, teacherB.uid)
        assert.equal(resB.data.classroom.id, teacherB.classroomId)
        assert.notEqual(resB.data.classroom.id, teacherA.classroomId)
      })

      it('reports onboarding-required for an invited teacher with no foundation yet', async () => {
        await seedInvitation('pending@school.org')
        const pending = await signInAsGoogleUser('pending@school.org')
        const res = await httpsCallable(pending.functions, 'resolveTeacherTenantV2')({})
        assert.equal(res.data.state, 'onboarding-required')
        assert.equal(res.data.eligibility, 'invited')
      })
    })

    // -----------------------------------------------------------------------
    describe('C1. Planned teacher money callable integration', () => {
      it('real client recovers a lost callable response, acknowledges explicitly, and onboarding replay preserves its pending receipt', async () => {
        const teacher = await onboardGoogleTeacher('money.flow@school.org', 'Fictional Money Room')
        await createStudentFixture(teacher, { name: 'Fictional Avery', startingBalance: 10, pin: '2468' })
        const values = new Map(), calls = [], projectId = expectedProject
        const session = { projectId, captureIdentity: () => ({ uid: teacher.uid, role: 'teacher', classroomId: teacher.classroomId }),
          validateCapturedIdentity: captured => captured.uid === teacher.uid && captured.classroomId === teacher.classroomId }
        const paths = teacherAwardPaths(teacher.classroomId, teacher.uid, '01'.repeat(16))
        let preview, loaded
        const client = createTeacherMoneyClient({ session, currentUid: () => teacher.auth.currentUser?.uid,
          storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
          random: { getRandomValues(bytes) { bytes.fill(1); return bytes } },
          confirmPlan: result => { preview = result; return true },
          reload: async () => { loaded = (await getDoc(doc(teacher.firestore, `classrooms/${teacher.classroomId}/students/1`))).data(); return true },
          call: async (name, data) => {
            calls.push(name)
            if (name === 'executeTeacherMoneyV2') assert.equal(values.size, 1, 'durable marker before dispatch')
            const result = (await httpsCallable(teacher.functions, name)(data)).data
            // Lose only the client response AFTER the actual HTTP invocation and
            // Admin SDK transaction complete, then recover over real HTTP.
            if (name === 'executeTeacherMoneyV2') throw new Error('fictional lost client response')
            return result
          },
        })
        assert.equal((await client.check()).status, 'idle')
        const recovered = await client.run({ action: 'award', studentIds: [1], amountCents: 110,
          reason: 'Homework', category: 'Homework', memo: '' })
        assert.equal(recovered.status, 'committed'); assert.equal(recovered.intentConfirmed, false)
        assert.equal(loaded.balance, 11.1); assert.equal(loaded.transactions.length, 2)
        assert.equal(client.isBlocked(), true); assert.equal(values.size, 1)
        assert.equal((await client.run({})).status, 'blocked')
        assert.equal(calls.filter(name => name === 'executeTeacherMoneyV2').length, 1)
        assert.equal((await db.doc(paths.quota).get()).data().count, 2)
        assert.equal((await db.doc(paths.actor).get()).data().unacknowledgedRequestId, preview.request.requestId)
        const repeat = await httpsCallable(teacher.functions, 'onboardTeacherClassroomV2')({ classroomName: 'Ignored' })
        assert.equal(repeat.data.created, false)
        assert.equal((await db.doc(paths.quota).get()).data().count, 2)
        assert.equal((await db.doc(paths.actor).get()).data().unacknowledgedRequestId, preview.request.requestId)
        assert.equal((await client.acknowledge()).status, 'acknowledged')
        assert.equal(client.isBlocked(), false); assert.equal(values.size, 0)
        assert.equal((await db.doc(paths.actor).get()).data().unacknowledgedRequestId, null)
        const ledgers = await db.collection(`classrooms/${teacher.classroomId}/transactions`).get()
        assert.equal(ledgers.size, 2, 'opening balance plus exactly one recovered award')
        assert.deepEqual(ledgers.docs.map(d => d.data()).sort((a,b) => a.id-b.id),
          [...loaded.transactions].sort((a,b) => a.id-b.id))
        assert.equal(loaded.transactions.filter(t => t.source === 'Opening Balance').length, 1)
      })

      it('stale plan refusal is correlated, status absence stays unconfirmed, and cancellation fences execution', async () => {
        const teacher = await onboardGoogleTeacher('money.stale@school.org', 'Fictional Stale Room')
        await createStudentFixture(teacher, { name: 'Fictional Blake', startingBalance: 10, pin: '2468' })
        const ledgerBefore = (await db.collection(`classrooms/${teacher.classroomId}/transactions`).get()).docs.map(d => d.data())
        const access = (await httpsCallable(teacher.functions, 'getClassroomAccessV2')({})).data
        const requestId = 'ab'.repeat(16)
        const preview = (await httpsCallable(teacher.functions, 'planTeacherMoneyV2')({ protocolVersion: 1,
          controlGeneration: access.generation, requestId, action: 'deduct', studentIds: [1], amountCents: 110,
          reason: 'Rent', category: 'Rent', memo: '' })).data
        await db.doc(`classrooms/${teacher.classroomId}/students/1`).update({ balance: 12 })
        const envelope = { request: preview.request, plan: preview.plan }
        const rejected = (await httpsCallable(teacher.functions, 'executeTeacherMoneyV2')(envelope)).data
        assert.deepEqual(rejected, { protocolVersion: 1, status: 'rejected', requestId,
          digest: preview.plan.digest, reason: 'stale-plan', wroteNothing: true })
        const recovery = { protocolVersion: 1, classroomId: teacher.classroomId, requestId }
        assert.equal((await httpsCallable(teacher.functions, 'getTeacherMoneyStatusV2')(recovery)).data.status, 'unconfirmed')
        assert.equal((await httpsCallable(teacher.functions, 'cancelTeacherMoneyV2')(recovery)).data.status, 'cancelled')
        assert.equal((await httpsCallable(teacher.functions, 'executeTeacherMoneyV2')(envelope)).data.reason, 'request-cancelled')
        assert.equal((await db.doc(`classrooms/${teacher.classroomId}/students/1`).get()).data().balance, 12)
        assert.deepEqual((await db.collection(`classrooms/${teacher.classroomId}/transactions`).get()).docs.map(d => d.data()), ledgerBefore)
      })

      it('new routes deny anonymous access and foreign-classroom recovery without leaking a receipt', async () => {
        const anonymous = createTestClientApp()
        for (const name of ['planTeacherMoneyV2', 'executeTeacherMoneyV2', 'getTeacherMoneyStatusV2',
          'acknowledgeTeacherMoneyV2', 'cancelTeacherMoneyV2', 'editStudentProfileV2']) {
          await expectCallableError(() => httpsCallable(anonymous.functions, name)({}), 'unauthenticated')
        }
        const a = await onboardGoogleTeacher('money.owner@school.org', 'Fictional Owner Room')
        const b = await onboardGoogleTeacher('money.foreign@school.org', 'Fictional Other Room')
        for (const name of ['getTeacherMoneyStatusV2', 'acknowledgeTeacherMoneyV2', 'cancelTeacherMoneyV2']) {
          await expectCallableError(() => httpsCallable(b.functions, name)({ protocolVersion: 1,
            classroomId: a.classroomId, requestId: 'a'.repeat(32) }), 'failed-precondition')
        }
        assert.equal((await db.collection(`classrooms/${a.classroomId}/teacherMoneyReceipts`).get()).size, 0)
        assert.equal((await db.collection(`classrooms/${b.classroomId}/teacherMoneyReceipts`).get()).size, 0)
      })
    })

    describe('C1b. Remaining teacher money writers', () => {
      it('real callable approval, denial, rename and reset preserve exact ledger/mirror pairs', async () => {
        const teacher = await onboardGoogleTeacher('roster.money@school.org', 'Fictional Roster Room')
        await createStudentFixture(teacher, { name: 'Fictional Avery', startingBalance: 20, pin: '2468' })
        const root = `classrooms/${teacher.classroomId}`, studentRef = db.doc(`${root}/students/1`)
        const pending = [11, 12].map(id => ({ id, studentId: 1, studentName: 'Fictional Avery', date: '2026-09-01T00:00:00.000Z',
          type: 'Add', amount: 2.35, reason: 'Homework', memo: '', category: '', status: 'Pending', source: 'Student' }))
        const seed = db.batch()
        for (const row of pending) seed.create(db.doc(`${root}/transactions/${row.id}`), row)
        seed.update(studentRef, { transactions: [...pending, ...(await studentRef.get()).data().transactions] }); await seed.commit()
        const access = (await httpsCallable(teacher.functions, 'getClassroomAccessV2')({})).data
        let sequence = 1
        async function run(payload) {
          const requestId = String(sequence++).padStart(32, '0')
          const preview = (await httpsCallable(teacher.functions, 'planTeacherMoneyV2')({ ...payload, protocolVersion: 1,
            controlGeneration: access.generation, requestId })).data
          assert.deepEqual(preview.notYetPlanned, [])
          const envelope = { request: preview.request, plan: preview.plan }
          const saved = (await httpsCallable(teacher.functions, 'executeTeacherMoneyV2')(envelope)).data
          assert.equal(saved.status, 'committed')
          assert.deepEqual((await httpsCallable(teacher.functions, 'executeTeacherMoneyV2')(envelope)).data, saved)
          const recovery = { protocolVersion: 1, classroomId: teacher.classroomId, requestId }
          assert.equal((await httpsCallable(teacher.functions, 'getTeacherMoneyStatusV2')(recovery)).data.action, payload.action)
          await httpsCallable(teacher.functions, 'acknowledgeTeacherMoneyV2')(recovery)
        }
        await run({ action: 'approve', transactionIds: [11], allowNegative: false })
        await run({ action: 'deny', transactionIds: [12], allowNegative: false })
        assert.equal((await studentRef.get()).data().balance, 22.35)
        const rename = { protocolVersion: 1, controlGeneration: access.generation, classroomId: teacher.classroomId, studentId: 1,
          expectedName: 'Fictional Avery', name: 'Fictional New Name' }
        await httpsCallable(teacher.functions, 'editStudentProfileV2')(rename)
        await httpsCallable(teacher.functions, 'editStudentProfileV2')(rename)
        await run({ action: 'adjust', adjustments: [{ studentId: 1, expectedCents: 2235, targetCents: -110 }] })
        await run({ action: 'reset', adjustments: [{ studentId: 1, expectedCents: -110, targetCents: 0 }] })
        const student = (await studentRef.get()).data(), ledger = await db.collection(`${root}/transactions`).get()
        assert.equal(student.balance, 0); assert.equal(student.name, 'Fictional New Name'); assert.equal(ledger.size, 5)
        for (const snap of ledger.docs) assert.deepEqual(snap.data(), student.transactions.find(row => row.id === Number(snap.id)))
        assert.equal(student.transactions.find(row => row.id === 11).studentName, 'Fictional Avery')
        await db.doc(root).update({ 'accessControl.mode': 'readOnly' })
        await expectCallableError(() => httpsCallable(teacher.functions, 'editStudentProfileV2')(rename), 'failed-precondition')
      })
      it('real stale reset rejects atomically without receipts or partial updates', async () => {
        const teacher = await onboardGoogleTeacher('roster.stale@school.org', 'Fictional Stale Roster')
        await createStudentFixture(teacher, { name: 'Fictional Blake', startingBalance: 20, pin: '2468' })
        const root = `classrooms/${teacher.classroomId}`, ref = db.doc(`${root}/students/1`)
        const access = (await httpsCallable(teacher.functions, 'getClassroomAccessV2')({})).data
        const preview = (await httpsCallable(teacher.functions, 'planTeacherMoneyV2')({ protocolVersion: 1,
          controlGeneration: access.generation, requestId: 'b'.repeat(32), action: 'reset',
          adjustments: [{ studentId: 1, expectedCents: 2000, targetCents: 0 }] })).data
        await ref.update({ balance: 21 })
        const result = (await httpsCallable(teacher.functions, 'executeTeacherMoneyV2')({ request: preview.request, plan: preview.plan })).data
        assert.equal(result.reason, 'balance-conflict'); assert.equal(result.wroteNothing, true)
        assert.equal((await ref.get()).data().balance, 21)
        assert.equal((await db.collection(`${root}/teacherMoneyReceipts`).get()).size, 1)
        assert.equal((await db.collection(`${root}/transactions`).get()).size, 1)
      })
    })

    async function createStudentFixture(teacher, input) {
      const receipt = (await httpsCallable(teacher.functions, 'createStudentV2')({
        name: input.name, pin: input.pin, startingBalanceCents: input.startingBalance * 100,
        protocolVersion: 1, controlGeneration: 1, classroomId: teacher.classroomId, requestId: randomBytes(16).toString('hex'),
      })).data
      await httpsCallable(teacher.functions, 'acknowledgeTeacherMoneyV2')({protocolVersion:1,classroomId:teacher.classroomId,requestId:receipt.requestId})
      const student = (await db.doc(`classrooms/${teacher.classroomId}/students/${receipt.studentId}`).get()).data()
      return {data:{...receipt,student:{id:student.id,name:student.name,balance:student.balance,frozen:student.frozen}}}
    }

    describe('C2. Fresh-classroom lifecycle seam', () => {
      it('creation commits one opening entry, retries once by receipt, binds PIN and refuses old wire', async () => {
        const teacher = await onboardGoogleTeacher('creation.receipt@school.org','Fictional Creation')
        const wire = {protocolVersion:1,controlGeneration:1,classroomId:teacher.classroomId,requestId:'c'.repeat(32),name:'Fictional New',startingBalanceCents:-1234,pin:'0427'}
        const create = httpsCallable(teacher.functions,'createStudentV2')
        const first = (await create(wire)).data, retry = (await create(wire)).data
        assert.deepEqual(retry,first)
        await expectCallableError(()=>create({...wire,pin:'9999'}),'already-exists')
        await expectCallableError(()=>create({name:'Old',startingBalance:1,pin:'1234'}),'invalid-argument')
        const root = `classrooms/${teacher.classroomId}`
        const student = (await db.doc(`${root}/students/${first.studentId}`).get()).data()
        assert.equal(student.balance,-12.34); assert.equal(student.transactions.length,1)
        assert.equal(student.transactions[0].source,'Opening Balance')
        assert.equal(student.transactions[0].type,'Subtract')
        assert.equal((await db.collection(`${root}/transactions`).get()).size,1)
        const rows = (await db.collection(`${root}/teacherMoneyReceipts`).get()).docs
        assert.equal(rows.length,1); assert.equal(rows[0].data().digest,undefined)
        const receipt = rows[0].data()
        // An opaque hexadecimal HMAC can coincidentally contain the four PIN
        // digits. Pin exact schema and plaintext values instead of scanning
        // arbitrary substrings of identifiers, timestamps and cryptographic data.
        assert.deepEqual(Object.keys(receipt).sort(), ['version', 'actorUid', 'requestId', 'generation',
          'status', 'serverTime', 'action', 'itemCount', 'ledgerIds', 'acknowledged', 'studentId',
          'loginId', 'keyVersion', 'intentHmac'].sort())
        assert.match(receipt.intentHmac, /^[a-f0-9]{64}$/)
        assert.equal(Object.values(receipt).includes(wire.pin), false)
        assert.equal(Object.values(receipt).includes(wire.name), false)
        assert.equal((await db.doc(root).get()).data().nextStudentNumber,2)
        const key={protocolVersion:1,classroomId:teacher.classroomId,requestId:wire.requestId}
        assert.equal((await httpsCallable(teacher.functions,'getTeacherMoneyStatusV2')(key)).data.studentId,first.studentId)
        await httpsCallable(teacher.functions,'acknowledgeTeacherMoneyV2')(key)
        await db.doc(root).update({'accessControl.generation':2})
        await expectCallableError(()=>create({...wire,requestId:'d'.repeat(32)}),'permission-denied')
        const cancelled={...key,requestId:'e'.repeat(32)}
        await httpsCallable(teacher.functions,'cancelTeacherMoneyV2')(cancelled)
        await expectCallableError(()=>create({...wire,controlGeneration:2,requestId:cancelled.requestId}),'failed-precondition')
        assert.equal((await db.collection(`${root}/students`).get()).size,1)
      })

      it('persists student Add and Subtract submissions so the owning teacher reads the pending credit', async () => {
        const teacher = await onboardGoogleTeacher(
          'student.money@school.org',
          'Student Money Classroom',
        )
        const created = await createStudentFixture(teacher, { name: 'Money Student',
          startingBalance: 25,
          pin: '2468',
        })

        const studentClient = createTestClientApp()
        const login = await httpsCallable(
          studentClient.functions,
          'studentPinLoginV2',
        )({
          classroomCode: teacher.studentLoginCode,
          loginId: created.data.loginId,
          pin: '2468',
        })
        await signInWithCustomToken(studentClient.auth, login.data.token)

        const studentId = String(created.data.student.id)
        const attackerCode = 'moneyattack'
        const attackerLoginId = `${teacher.classroomId}\0${studentId}`
        const attackerDigest = throttleDigest(attackerCode, attackerLoginId)
        const moneyDigest = studentMoneyThrottleDigest(teacher.classroomId, studentId)
        assert.notEqual(
          attackerDigest,
          moneyDigest,
          'login and money throttle keyspaces must be structurally disjoint',
        )

        const attackerClient = createTestClientApp()
        const attackerLogin = httpsCallable(attackerClient.functions, 'studentPinLoginV2')
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await expectCallableError(
            () => attackerLogin({
              classroomCode: attackerCode,
              loginId: attackerLoginId,
              pin: '0000',
            }),
            'unauthenticated',
          )
        }
        const attackerBucket = await db
          .collection('studentLoginThrottle')
          .doc(attackerDigest)
          .get()
        assert.equal(attackerBucket.exists, true)
        assert.equal(attackerBucket.data().attempts.length, 10)
        assert.equal(
          (await db.collection('studentLoginThrottle').doc(moneyDigest).get()).exists,
          false,
          'login attempts must not pre-fill the student money bucket',
        )

        const addPayload = {
          transactionId: 1101,
          type: 'Add',
          protocolVersion: 1, controlGeneration: 1, amountCents: 1000,
          reason: 'Homework',
        }
        const add = await httpsCallable(
          studentClient.functions,
          'submitStudentTransactionV2',
        )(addPayload)
        assert.equal(add.data.balance, 25)
        assert.deepEqual(add.data.transaction, {
          id: 1101,
          date: add.data.transaction.date,
          studentId: 1,
          studentName: 'Money Student',
          type: 'Add',
          amount: 10,
          reason: 'Homework',
          memo: '',
          category: '',
          status: 'Pending',
          source: 'Student',
        })
        assert.equal(Number.isNaN(Date.parse(add.data.transaction.date)), false)

        const transactionPath =
          `classrooms/${teacher.classroomId}/transactions/${addPayload.transactionId}`
        const teacherRead = await getDoc(doc(teacher.firestore, transactionPath))
        assert.equal(teacherRead.exists(), true)
        assert.deepEqual(teacherRead.data(), add.data.transaction)

        const exactReplay = await httpsCallable(
          studentClient.functions,
          'submitStudentTransactionV2',
        )(addPayload)
        assert.deepEqual(exactReplay.data, add.data)

        const studentPath = `classrooms/${teacher.classroomId}/students/1`
        const afterAdd = await getDoc(doc(studentClient.firestore, studentPath))
        assert.equal(afterAdd.data().balance, 25)
        const opening = afterAdd.data().transactions.find(row => row.source === 'Opening Balance')
        assert.ok(opening)
        assert.deepEqual(afterAdd.data().transactions, [add.data.transaction, opening])

        const subtract = await httpsCallable(
          studentClient.functions,
          'submitStudentTransactionV2',
        )({
          transactionId: 1102,
          type: 'Subtract',
          protocolVersion: 1, controlGeneration: 1, amountCents: 400,
          reason: 'Rent',
        })
        assert.equal(subtract.data.balance, 21)
        assert.equal(subtract.data.transaction.status, 'Approved')
        assert.equal(subtract.data.transaction.source, 'Student')
        const afterSubtract = await getDoc(doc(studentClient.firestore, studentPath))
        assert.equal(afterSubtract.data().balance, 21)
        assert.deepEqual(
          afterSubtract.data().transactions.map(transaction => transaction.id),
          [1102, 1101, opening.id],
        )

        await expectCallableError(
          () => httpsCallable(
            studentClient.functions,
            'submitStudentTransactionV2',
          )({
            transactionId: 1103,
            type: 'Add',
            protocolVersion: 1, controlGeneration: 1, amountCents: 100,
            reason: 'Homework',
            classroomId: teacher.classroomId,
          }),
          'invalid-argument',
          'The request was invalid.',
        )
        assert.equal(
          (await db.doc(`classrooms/${teacher.classroomId}/transactions/1103`).get()).exists,
          false,
        )

        await assert.rejects(httpsCallable(teacher.functions, 'removeStudentV2')({
          studentId, classroomId: teacher.classroomId, protocolVersion: 1, controlGeneration: 1,
        }), error => error.code === 'functions/failed-precondition' && error.details.reason === 'pending-requests')
        assert.equal((await db.doc(studentPath).get()).exists, true)
        await expectCallableError(() => httpsCallable(studentClient.functions, 'submitStudentTransactionV2')({
          transactionId: 1199, type: 'Add', amount: 1, reason: 'Homework',
        }), 'invalid-argument')

        for (let transactionId = 1104; transactionId <= 1111; transactionId += 1) {
          const withinWindow = await httpsCallable(
            studentClient.functions,
            'submitStudentTransactionV2',
          )({
            transactionId,
            type: 'Add',
            protocolVersion: 1, controlGeneration: 1, amountCents: 100,
            reason: 'Homework',
          })
          assert.equal(withinWindow.data.transaction.id, transactionId)
        }

        const replayAtThrottle = await httpsCallable(
          studentClient.functions,
          'submitStudentTransactionV2',
        )(addPayload)
        assert.deepEqual(replayAtThrottle.data.transaction, add.data.transaction)
        assert.equal(replayAtThrottle.data.balance, 21)

        const moneyThrottle = await db
          .collection('studentLoginThrottle')
          .doc(moneyDigest)
          .get()
        assert.equal(moneyThrottle.exists, true)
        assert.equal(moneyThrottle.data().attempts.length, 10)

        await expectCallableError(
          () => httpsCallable(
            studentClient.functions,
            'submitStudentTransactionV2',
          )({
            transactionId: 1112,
            type: 'Add',
            protocolVersion: 1, controlGeneration: 1, amountCents: 100,
            reason: 'Homework',
          }),
          'resource-exhausted',
          'The request could not be completed. Please try again later.',
        )
        assert.equal(
          (await db.doc(`classrooms/${teacher.classroomId}/transactions/1112`).get()).exists,
          false,
        )
        const afterThrottle = await getDoc(doc(studentClient.firestore, studentPath))
        assert.equal(afterThrottle.data().transactions.length, 11)
        const rootRef = db.doc(`classrooms/${teacher.classroomId}`)
        const control = (await rootRef.get()).data().accessControl
        await rootRef.update({ accessControl: { ...control, mode: 'readOnly' } })
        await expectCallableError(() => httpsCallable(studentClient.functions, 'submitStudentTransactionV2')(addPayload), 'permission-denied')
        await rootRef.update({ accessControl: { ...control, generation: control.generation + 2 } })
        await expectCallableError(() => httpsCallable(studentClient.functions, 'submitStudentTransactionV2')(addPayload), 'permission-denied')
        await expectCallableError(() => httpsCallable(teacher.functions, 'removeStudentV2')({
          studentId, classroomId: teacher.classroomId, protocolVersion: 1, controlGeneration: 1,
        }), 'permission-denied')
        assert.deepEqual((await db.doc(studentPath).get()).data(), afterThrottle.data())

        assert.equal(moneyThrottle.data().attempts.length, 10)
      })

      it('onboards, creates, authenticates, persists money data, isolates, and removes without legacy seeding', async () => {
        const teacherA = await onboardGoogleTeacher(
          'fresh.a@school.org',
          'Fresh Classroom A',
        )
        const teacherB = await onboardGoogleTeacher(
          'fresh.b@school.org',
          'Fresh Classroom B',
        )

        assert.equal((await db.collection('morganBank').get()).empty, true)
        assert.equal(
          (await db.collection('classrooms').doc('morgan').get()).exists,
          false,
          'the seam must not depend on a legacy classroom root',
        )

        const classroomBefore = await db
          .collection('classrooms')
          .doc(teacherA.classroomId)
          .get()
        assert.equal(
          classroomBefore.data().nextStudentNumber,
          1,
          'normal onboarding must initialize the first lifecycle identity',
        )

        const created = await createStudentFixture(teacherA, { name: 'Fresh Student',
          startingBalance: 25,
          pin: '2468',
        })
        assert.deepEqual(created.data.student, {
          id: 1,
          name: 'Fresh Student',
          balance: 25,
          frozen: false,
        })
        assert.equal(created.data.loginId, 'fresh-student')

        const studentPath = `classrooms/${teacherA.classroomId}/students/1`
        let transactionPath
        const createdStudent = await db.doc(studentPath).get()
        assert.deepEqual(Object.keys(createdStudent.data()).sort(), [
          'balance',
          'frozen',
          'id',
          'name',
          'transactions',
        ])
        assert.equal(
          (await db.collection('classrooms').doc(teacherA.classroomId).get())
            .data().nextStudentNumber,
          2,
        )

        const anonymousStudent = createTestClientApp()
        const login = await httpsCallable(
          anonymousStudent.functions,
          'studentPinLoginV2',
        )({
          classroomCode: teacherA.studentLoginCode,
          loginId: created.data.loginId,
          pin: '2468',
        })
        assert.deepEqual(Object.keys(login.data).sort(), ['access', 'token'])
        assert.deepEqual(login.data.access, { protocolVersion: 1, mode: 'active', generation: 1 })
        const signedInStudent = await signInWithCustomToken(
          anonymousStudent.auth,
          login.data.token,
        )
        const claims = await getIdTokenResult(signedInStudent.user, true)
        assert.equal(claims.claims.classroomId, teacherA.classroomId)
        assert.equal(claims.claims.studentId, '1')

        // The lifecycle acceptance follows the migrated server writer instead
        // of depending on the old direct client balance/ledger permission.
        const preview = (await httpsCallable(teacherA.functions, 'planTeacherMoneyV2')({
          protocolVersion: 1, controlGeneration: 1, requestId: 'ce'.repeat(16),
          action: 'award', studentIds: [1], amountCents: 1000,
          reason: 'Homework', category: 'Homework', memo: 'Fresh-classroom acceptance',
        })).data
        const envelope = { request: preview.request, plan: preview.plan }
        const saved = (await httpsCallable(teacherA.functions, 'executeTeacherMoneyV2')(envelope)).data
        assert.equal(saved.status, 'committed')
        const written = await db.collection(`classrooms/${teacherA.classroomId}/transactions`).get()
        const transaction = written.docs.map(d => d.data()).find(t => t.memo === 'Fresh-classroom acceptance')
        assert.ok(transaction)
        transactionPath = `classrooms/${teacherA.classroomId}/transactions/${transaction.id}`
        assert.equal(transaction.amount, 10)
        assert.equal(transaction.status, 'Approved')
        if (process.env.PHASE3_WRITER_CONTAINMENT === 'true') {
          await assert.rejects(() => updateDoc(doc(teacherA.firestore, studentPath), { balance: 999 }),
            error => error?.code === 'permission-denied')
          await assert.rejects(() => updateDoc(doc(teacherA.firestore, transactionPath), { status: 'Denied' }),
            error => error?.code === 'permission-denied')
        }
        await httpsCallable(teacherA.functions, 'acknowledgeTeacherMoneyV2')({
          protocolVersion: 1, classroomId: teacherA.classroomId, requestId: preview.request.requestId,
        })

        const teacherRead = await getDoc(doc(teacherA.firestore, transactionPath))
        assert.deepEqual(teacherRead.data(), transaction)
        const studentRead = await getDoc(
          doc(anonymousStudent.firestore, studentPath),
        )
        assert.equal(studentRead.data().balance, 35)
        assert.deepEqual([...studentRead.data().transactions].sort((a,b) => a.id-b.id),
          [...createdStudent.data().transactions, transaction].sort((a,b) => a.id-b.id))

        await assert.rejects(
          () => getDoc(doc(teacherB.firestore, studentPath)),
          error => error?.code === 'permission-denied',
          'the other reciprocal owner must not read this fresh classroom',
        )
        await assert.rejects(
          () => getDoc(doc(
            teacherA.firestore,
            `classrooms/${teacherB.classroomId}`,
          )),
          error => error?.code === 'permission-denied',
          'teacher isolation must also deny A from the existing B root',
        )
        await assert.rejects(
          () => getDoc(doc(
            anonymousStudent.firestore,
            `classrooms/${teacherB.classroomId}`,
          )),
          error => error?.code === 'permission-denied',
          'student claims must not cross into the existing B root',
        )

        const removed = await httpsCallable(
          teacherA.functions,
          'removeStudentV2',
        )({ studentId: '1', classroomId: teacherA.classroomId, protocolVersion: 1, controlGeneration: 1 })
        assert.deepEqual(removed.data, { success: true })
        assert.equal((await db.doc(studentPath).get()).exists, false)
        assert.equal(
          (await db.doc(transactionPath).get()).exists,
          true,
          'student removal must preserve the transaction audit record',
        )
        const retainedCredential = await credentialsRef(teacherA.classroomId)
          .doc(created.data.loginId)
          .get()
        assert.equal(retainedCredential.exists, true)
        assert.equal(retainedCredential.data().active, false)
        assert.equal(
          (await db.collection('classrooms').doc(teacherA.classroomId).get())
            .data().nextStudentNumber,
          2,
          'student removal must never rewind the allocator',
        )
        await expectCallableError(
          () => httpsCallable(
            anonymousStudent.functions,
            'studentPinLoginV2',
          )({
            classroomCode: teacherA.studentLoginCode,
            loginId: created.data.loginId,
            pin: '2468',
          }),
          'unauthenticated',
          'Invalid student credentials.',
        )
      })
    })

    // -----------------------------------------------------------------------
    describe('C3. Credential containment', () => {
      it('current PIN wire, login modes, stale reset and sensitive read denial use real callables', async () => {
        const teacher = await onboardGoogleTeacher('credential-control@school.org','Credential Control')
        const created = await createStudentFixture(teacher, { name:'Fictional Credential',startingBalance:0,pin:'0427' })
        const studentId=String(created.data.student.id), root=db.doc(`classrooms/${teacher.classroomId}`)
        const control=(await root.get()).data().accessControl
        const payload={studentId,newPin:'2468',classroomId:teacher.classroomId,protocolVersion:1,controlGeneration:control.generation}
        await httpsCallable(teacher.functions,'resetStudentPinV2')(payload)
        const credential=(await credentialsRef(teacher.classroomId).where('studentId','==',studentId).get()).docs[0]
        assert.ok(await bcrypt.compare('2468',credential.data().pinHash))
        const student=createTestClientApp()
        const login=()=>httpsCallable(student.functions,'studentPinLoginV2')({classroomCode:teacher.studentLoginCode,loginId:credential.id,pin:'2468'})
        const token=(await login()).data.token
        await signInWithCustomToken(student.auth,token)
        for(const mode of ['readOnly','suspended']) {
          await root.update({accessControl:{...control,mode}})
          await expectCallableError(()=>httpsCallable(teacher.functions,'resetStudentPinV2')(payload),'permission-denied')
          await expectCallableError(()=>httpsCallable(teacher.functions,'listStudentPinsV2')({}),'permission-denied')
          if(mode==='readOnly') assert.equal((await login()).data.access.mode,'readOnly')
          else {
            await expectCallableError(login,'unauthenticated')
            await expectCallableError(()=>httpsCallable(student.functions,'getClassroomAccessV2')({}),'permission-denied')
          }
        }
        await root.update({accessControl:{...control,generation:control.generation+2}})
        await expectCallableError(()=>httpsCallable(teacher.functions,'resetStudentPinV2')(payload),'permission-denied')
        await expectCallableError(()=>httpsCallable(teacher.functions,'resetStudentPinV2')({studentId,newPin:'9999'}),'invalid-argument')
        assert.equal((await db.doc(`classrooms/${teacher.classroomId}/studentPins/${studentId}`).get()).data().pin,'2468')
        await httpsCallable(teacher.functions,'resetStudentPinV2')({...payload,controlGeneration:control.generation+2,newPin:'5678'})
        assert.equal((await db.doc(`classrooms/${teacher.classroomId}/studentPins/${studentId}`).get()).data().pin,'5678')
      })
      it('old student events cannot overwrite reset credentials or revive a removed account',async()=>{
        const {syncStudentProfilesV2Handler}=await import('../../functions/phase2b/syncStudentProfiles.js')
        const teacher=await onboardGoogleTeacher('late-credential@school.org','Late Credential')
        const created=await createStudentFixture(teacher,{name:'Fictional Late',startingBalance:0,pin:'0427'})
        const studentId=String(created.data.student.id), root=db.doc(`classrooms/${teacher.classroomId}`)
        const control=(await root.get()).data().accessControl
        const cred=(await credentialsRef(teacher.classroomId).where('studentId','==',studentId).get()).docs[0]
        await httpsCallable(teacher.functions,'resetStudentPinV2')({studentId,newPin:'5678',classroomId:teacher.classroomId,protocolVersion:1,controlGeneration:control.generation})
        const changed=(await cred.ref.get()).data()
        const event=(kind)=>({params:{classroomId:teacher.classroomId,studentId},data:{before:{exists:kind!=='create',data:()=>({name:'Old'})},after:{exists:kind!=='delete',data:()=>({name:'Late'})}}})
        for(const mode of ['active','readOnly','suspended']) {
          await root.update({accessControl:{...control,mode}})
          for(const kind of ['create','update','delete']) {
            assert.equal((await syncStudentProfilesV2Handler(event(kind),{firestore:db,hashPin:async()=>{assert.fail('enrolled event hash')}})).action,'enrolled_noop')
            assert.deepEqual((await cred.ref.get()).data(),changed)
          }
        }
        await root.update({accessControl:control})
        await httpsCallable(teacher.functions,'removeStudentV2')({studentId,classroomId:teacher.classroomId,protocolVersion:1,controlGeneration:control.generation})
        const removed=(await cred.ref.get()).data();assert.equal(removed.active,false)
        await syncStudentProfilesV2Handler(event('create'),{firestore:db,hashPin:async()=>{assert.fail('late event hash')}})
        assert.deepEqual((await cred.ref.get()).data(),removed)
        assert.equal((await db.doc(`classrooms/${teacher.classroomId}/studentPins/${studentId}`).get()).exists,false)
      })
    })

    describe('D. V2 student sync trigger', () => {
      it('creates an inactive credential with the default PIN at bcrypt cost 12', async () => {
        const teacher = await onboardUnenrolledTeacher('sync@school.org', 'Sync Room')
        await studentDocRef(teacher.classroomId, 's-stu1').set({ name: 'Bob Jones', balance: 0 })

        const credDoc = await waitForCredentialByStudentId(teacher.classroomId, 's-stu1')
        const cred = credDoc.data()

        assert.equal(credDoc.id, 'bob-jones')
        assert.equal(cred.loginId, 'bob-jones')
        assert.equal(cred.schemaVersion, 1)
        assert.equal(cred.classroomId, teacher.classroomId)
        assert.equal(cred.studentId, 's-stu1')
        assert.equal(cred.active, false, 'a freshly synced credential must be inactive')
        assert.equal(cred.failedAttempts, 0)
        assert.equal(cred.lockedUntil, null)
        assert.equal(cred.authUid, deriveStudentAuthUid(teacher.classroomId, 's-stu1'))
        assert.match(cred.pinHash, /^\$2[aby]\$12\$/)
        assert.equal(await bcrypt.compare('1234', cred.pinHash), true,
          'the default PIN must be 1234 hashed at cost 12')
        assert.equal(cred.pin, undefined, 'a raw PIN must never be stored on a credential')
      })

      it('keeps concurrent same-name creates distinct with no overwrite or identity alias', async () => {
        const teacher = await onboardUnenrolledTeacher('collide@school.org', 'Collide Room')

        // Genuinely overlapping writes: both student documents are written
        // without awaiting the first credential.
        await Promise.all([
          studentDocRef(teacher.classroomId, 's-a').set({ name: 'Bob Jones' }),
          studentDocRef(teacher.classroomId, 's-b').set({ name: 'Bob Jones' }),
        ])

        const creds = await waitFor(async () => {
          const snap = await credentialsRef(teacher.classroomId).get()
          return snap.size === 2 ? snap : null
        }, { label: 'two credentials for two concurrent same-name students' })

        const byStudentId = new Map(creds.docs.map(d => [d.data().studentId, d]))
        assert.deepEqual([...byStudentId.keys()].sort(), ['s-a', 's-b'])

        const loginIds = creds.docs.map(d => d.id).sort()
        assert.deepEqual(loginIds, ['bob-jones', 'bob-jones-2'])

        const authUids = new Set(creds.docs.map(d => d.data().authUid))
        assert.equal(authUids.size, 2, 'two students must never alias one Firebase Auth identity')
        for (const [studentId, doc] of byStudentId) {
          assert.equal(doc.data().authUid, deriveStudentAuthUid(teacher.classroomId, studentId))
          assert.equal(doc.data().loginId, doc.id)
          assert.equal(doc.data().classroomId, teacher.classroomId)
        }

        // No third credential may appear from a retry.
        await waitForStableAbsence(async () => {
          const snap = await credentialsRef(teacher.classroomId).get()
          return snap.size !== 2
        }, { label: 'a duplicate credential from create contention' })
      })

      it('rejects a recycled studentId instead of producing a second credential', async () => {
        const teacher = await onboardUnenrolledTeacher('recycle@school.org', 'Recycle Room')
        await studentDocRef(teacher.classroomId, 's-1').set({ name: 'First Occupant' })
        const original = await waitForCredentialByStudentId(teacher.classroomId, 's-1')

        await studentDocRef(teacher.classroomId, 's-1').delete()
        await waitFor(async () => {
          const snap = await credentialsRef(teacher.classroomId).doc(original.id).get()
          return snap.data().active === false
        }, { label: 'credential deactivation on student delete' })

        // The client's max(id)+1 allocation can recycle a departed student's ID.
        await studentDocRef(teacher.classroomId, 's-1').set({ name: 'Second Occupant' })

        await waitForStableAbsence(async () => {
          const snap = await credentialsRef(teacher.classroomId).get()
          return snap.size !== 1
        }, { label: 'a second credential for a recycled studentId' })

        const after = await credentialsRef(teacher.classroomId).doc(original.id).get()
        assert.equal(after.data().active, false, 'the recycled ID must not silently reactivate')
        assert.equal(after.data().pinHash, original.data().pinHash)
        assert.equal(after.data().authUid, original.data().authUid)
      })

      it('keeps the assigned login ID stable when a student is renamed', async () => {
        const teacher = await onboardUnenrolledTeacher('rename@school.org', 'Rename Room')
        await studentDocRef(teacher.classroomId, 's-r').set({ name: 'Original Name' })
        const before = await waitForCredentialByStudentId(teacher.classroomId, 's-r')
        assert.equal(before.id, 'original-name')

        await studentDocRef(teacher.classroomId, 's-r').set({ name: 'Totally Different' })
        await waitFor(async () => {
          const snap = await credentialsRef(teacher.classroomId).doc('original-name').get()
          return snap.data().updatedAt !== before.data().updatedAt
        }, { label: 'the rename update to be applied' })

        const all = await credentialsRef(teacher.classroomId).get()
        assert.equal(all.size, 1, 'a rename must not create a second credential')
        const after = all.docs[0]
        assert.equal(after.id, 'original-name')
        assert.equal(after.data().loginId, 'original-name')
        assert.equal(after.data().pinHash, before.data().pinHash)
        assert.equal(after.data().authUid, before.data().authUid)
        assert.equal(after.data().active, before.data().active)
      })

      it('deactivates only the deleted student’s own classroom credential', async () => {
        const teacherA = await onboardUnenrolledTeacher('del.a@school.org', 'Delete Room A')
        const teacherB = await onboardUnenrolledTeacher('del.b@school.org', 'Delete Room B')

        await studentDocRef(teacherA.classroomId, 's-shared').set({ name: 'Same Name' })
        await studentDocRef(teacherB.classroomId, 's-shared').set({ name: 'Same Name' })
        const credA = await waitForCredentialByStudentId(teacherA.classroomId, 's-shared')
        const credB = await waitForCredentialByStudentId(teacherB.classroomId, 's-shared')
        assert.equal(credA.id, credB.id, 'both classrooms should derive the same login ID')
        assert.notEqual(credA.data().authUid, credB.data().authUid)
        const beforeB = credB.data()

        await studentDocRef(teacherA.classroomId, 's-shared').delete()
        await waitFor(async () => {
          const snap = await credentialsRef(teacherA.classroomId).doc(credA.id).get()
          return snap.data().active === false
        }, { label: 'classroom A credential deactivation' })

        const afterB = await credentialsRef(teacherB.classroomId).doc(credB.id).get()
        assert.deepEqual(afterB.data(), beforeB, 'classroom B must be byte-for-byte unchanged')
        assert.equal((await credentialsRef(teacherA.classroomId).get()).size, 1,
          'deletion must never remove the credential document')
      })

      it('refuses to sync when the owning teacher is disabled', async () => {
        const teacher = await onboardUnenrolledTeacher('syncdisabled@school.org', 'Sync Disabled Room')
        await db.collection('teachers').doc(teacher.uid).update({ status: 'disabled' })
        await studentDocRef(teacher.classroomId, 's-blocked').set({ name: 'Blocked Student' })
        await waitForStableAbsence(async () => {
          const snap = await credentialsRef(teacher.classroomId).get()
          return snap.size > 0
        }, { label: 'a credential created under a disabled teacher' })

        // Restore the foundation so the shared teardown can delete this
        // student without the trigger failing against a broken tenant.
        await db.collection('teachers').doc(teacher.uid).update({ status: 'active' })
      })

      it('refuses to sync when the reciprocal ownership link is inconsistent', async () => {
        const teacher = await onboardUnenrolledTeacher('syncbroken@school.org', 'Sync Broken Room')
        await db.collection('classrooms').doc(teacher.classroomId).update({ ownerUid: 'not-the-owner' })
        await studentDocRef(teacher.classroomId, 's-blocked').set({ name: 'Blocked Student' })
        await waitForStableAbsence(async () => {
          const snap = await credentialsRef(teacher.classroomId).get()
          return snap.size > 0
        }, { label: 'a credential created under a broken ownership link' })

        await db.collection('classrooms').doc(teacher.classroomId).update({ ownerUid: teacher.uid })
      })
    })

    // -----------------------------------------------------------------------
    describe('E. Tenant-derived PIN reset', () => {
      it('activates and rehashes at cost 12 while preserving every identity field', async () => {
        const teacher = await onboardGoogleTeacher('reset@school.org', 'Reset Room')
        await studentDocRef(teacher.classroomId, 's-reset').set({ name: 'Reset Target' })
        const before = await seedInactiveCredential(teacher.classroomId, 's-reset')
        const beforeData = before.data()

        await activateStudentPin(teacher.functions, 's-reset', '9876')

        const after = await credentialsRef(teacher.classroomId).doc(before.id).get()
        const afterData = after.data()
        assert.equal(await bcrypt.compare('9876', afterData.pinHash), true)
        assert.match(afterData.pinHash, /^\$2[aby]\$12\$/)
        assert.equal(afterData.active, true)
        assert.equal(afterData.failedAttempts, 0)
        assert.equal(afterData.lockedUntil, null)
        for (const field of ['loginId', 'classroomId', 'studentId', 'authUid', 'schemaVersion', 'createdAt']) {
          assert.deepEqual(afterData[field], beforeData[field], `${field} must not be rewritten by a reset`)
        }
      })

      it('rejects a forged classroomId field on the reset request', async () => {
        const teacher = await onboardGoogleTeacher('resetfield@school.org', 'Reset Field Room')
        await studentDocRef(teacher.classroomId, 's-f').set({ name: 'Field Target' })
        await seedInactiveCredential(teacher.classroomId, 's-f')

        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({
            studentId: 's-f',
            newPin: '1111',
            classroomId: teacher.classroomId,
          }),
          'invalid-argument',
        )
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-f', newPin: '12x4', classroomId: teacher.classroomId, protocolVersion: 1, controlGeneration: 1 }),
          'invalid-argument',
        )
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 'bad/id', newPin: '1111', classroomId: teacher.classroomId, protocolVersion: 1, controlGeneration: 1 }),
          'invalid-argument',
        )
      })

      it('fails closed for an unknown student in the caller’s own classroom', async () => {
        const teacher = await onboardGoogleTeacher('resetmissing@school.org', 'Reset Missing Room')
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-nope', newPin: '1111', classroomId: teacher.classroomId, protocolVersion: 1, controlGeneration: 1 }),
          'not-found',
        )
      })

      it('denies cross-tenant resets in both directions', async () => {
        const teacherA = await onboardGoogleTeacher('xa@school.org', 'Cross Room A')
        const teacherB = await onboardGoogleTeacher('xb@school.org', 'Cross Room B')

        await studentDocRef(teacherA.classroomId, 's-a-only').set({ name: 'Alpha Only' })
        await studentDocRef(teacherB.classroomId, 's-b-only').set({ name: 'Beta Only' })
        const credA = await seedInactiveCredential(teacherA.classroomId, 's-a-only')
        const credB = await seedInactiveCredential(teacherB.classroomId, 's-b-only')
        const beforeA = credA.data()
        const beforeB = credB.data()

        await expectCallableError(
          () => httpsCallable(teacherA.functions, 'resetStudentPinV2')({ studentId: 's-b-only', newPin: '2222', classroomId: teacherA.classroomId, protocolVersion: 1, controlGeneration: 1 }),
          'not-found',
        )
        await expectCallableError(
          () => httpsCallable(teacherB.functions, 'resetStudentPinV2')({ studentId: 's-a-only', newPin: '2222', classroomId: teacherB.classroomId, protocolVersion: 1, controlGeneration: 1 }),
          'not-found',
        )

        assert.deepEqual((await credentialsRef(teacherA.classroomId).doc(credA.id).get()).data(), beforeA)
        assert.deepEqual((await credentialsRef(teacherB.classroomId).doc(credB.id).get()).data(), beforeB)
      })

      it('refuses to repair a credential whose identity does not match the tenant', async () => {
        const teacher = await onboardGoogleTeacher('resetforged@school.org', 'Reset Forged Room')
        await studentDocRef(teacher.classroomId, 's-forged').set({ name: 'Forged Target' })
        const cred = await seedInactiveCredential(teacher.classroomId, 's-forged')
        const credRef = credentialsRef(teacher.classroomId).doc(cred.id)
        const original = cred.data()

        const forgeries = [
          { authUid: 's_totally-wrong' },
          { classroomId: 'some-other-classroom' },
          { schemaVersion: 2 },
          { loginId: 'not-the-document-id' },
        ]
        for (const forgery of forgeries) {
          await credRef.set({ ...original, ...forgery })
          await expectCallableError(
            () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-forged', newPin: '3333', classroomId: teacher.classroomId, protocolVersion: 1, controlGeneration: 1 }),
            'failed-precondition',
            'Contact your administrator',
          )
          const unchanged = await credRef.get()
          assert.equal(unchanged.data().pinHash, original.pinHash, 'a forged credential must not be rewritten')
        }
        await credRef.set(original)
      })

      it('denies a disabled teacher and an inconsistent foundation', async () => {
        const teacher = await onboardGoogleTeacher('resetdisabled@school.org', 'Reset Disabled Room')
        await studentDocRef(teacher.classroomId, 's-d').set({ name: 'Disabled Target' })
        await seedInactiveCredential(teacher.classroomId, 's-d')

        await db.collection('teachers').doc(teacher.uid).update({ status: 'disabled' })
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-d', newPin: '4444', classroomId: teacher.classroomId, protocolVersion: 1, controlGeneration: 1 }),
          'permission-denied',
        )

        await db.collection('teachers').doc(teacher.uid).update({ status: 'active' })
        await db.collection('classrooms').doc(teacher.classroomId).update({ ownerUid: 'someone-else' })
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-d', newPin: '4444', classroomId: teacher.classroomId, protocolVersion: 1, controlGeneration: 1 }),
          'failed-precondition',
        )

        await db.collection('classrooms').doc(teacher.classroomId).update({ ownerUid: teacher.uid })
      })

      it('requires authentication', async () => {
        const { functions } = createTestClientApp()
        await expectCallableError(
          () => httpsCallable(functions, 'resetStudentPinV2')({ studentId: 's-x', newPin: '1111', classroomId: 'fictional-room', protocolVersion: 1, controlGeneration: 1 }),
          'unauthenticated',
        )
      })
    })

    // -----------------------------------------------------------------------
    describe('F. Student login, tokens, logs, locks, and throttles', () => {
      async function seedActivatedStudent(teacher, studentId, name, pin) {
        await studentDocRef(teacher.classroomId, studentId).set({ name })
        const cred = await seedInactiveCredential(teacher.classroomId, studentId)
        await activateStudentPin(teacher.functions, studentId, pin)
        return cred.id
      }

      it('mints a usable custom token with exactly the accepted student claims', async () => {
        const teacher = await onboardGoogleTeacher('login@school.org', 'Login Room')
        const loginId = await seedActivatedStudent(teacher, 's-login-1', 'Charlie Brown', '4321')

        const student = createTestClientApp()
        const res = await httpsCallable(student.functions, 'studentPinLoginV2')({
          classroomCode: teacher.studentLoginCode,
          loginId,
          pin: '4321',
        })
        assert.ok(res.data.token)
        assert.deepEqual(Object.keys(res.data).sort(), ['access','token'], 'only token and minimal access may be returned')
        assert.deepEqual(res.data.access,{protocolVersion:1,mode:'active',generation:1})

        // Commit-before-mint: the transaction's writes are already durable at
        // the moment the caller receives the token.
        const credAtMint = await credentialsRef(teacher.classroomId).doc(loginId).get()
        assert.equal(credAtMint.data().failedAttempts, 0)
        assert.equal(credAtMint.data().lockedUntil, null)
        const successLogs = await db
          .collection('studentAuthLogs').doc(teacher.classroomId).collection('logs')
          .where('outcome', '==', 'success').get()
        assert.equal(successLogs.size, 1, 'the success log must be committed before the token is returned')

        const userCred = await signInWithCustomToken(student.auth, res.data.token)
        const expectedUid = deriveStudentAuthUid(teacher.classroomId, 's-login-1')
        assert.equal(userCred.user.uid, expectedUid)

        const tokenResult = await getIdTokenResult(userCred.user, true)
        assert.equal(tokenResult.claims.role, 'student')
        assert.equal(tokenResult.claims.classroomId, teacher.classroomId)
        assert.equal(tokenResult.claims.studentId, 's-login-1')
        assert.equal(tokenResult.claims.authUid, undefined,
          'authUid is not part of the accepted claim set')
        assert.equal(tokenResult.claims.loginId, loginId)
        assert.equal(
          tokenResult.claims.credentialVersion,
          credAtMint.data().pinUpdatedAt,
        )
        assert.equal(Number.isSafeInteger(tokenResult.claims.credentialVersion), true)
        assert.equal(tokenResult.claims.pinHash, undefined)
      })

      it('refuses an inactive credential until the teacher activates it', async () => {
        const teacher = await onboardGoogleTeacher('inactive@school.org', 'Inactive Room')
        await studentDocRef(teacher.classroomId, 's-inactive').set({ name: 'Not Yet' })
        const cred = await seedInactiveCredential(teacher.classroomId, 's-inactive')
        assert.equal(cred.data().active, false)

        const student = createTestClientApp()
        // The synced default PIN is 1234, but the credential is inactive.
        await expectCallableError(
          () => httpsCallable(student.functions, 'studentPinLoginV2')({
            classroomCode: teacher.studentLoginCode,
            loginId: cred.id,
            pin: '1234',
          }),
          'unauthenticated',
          'Invalid student credentials.',
        )

        await activateStudentPin(teacher.functions, 's-inactive', '5678')
        const res = await httpsCallable(student.functions, 'studentPinLoginV2')({
          classroomCode: teacher.studentLoginCode,
          loginId: cred.id,
          pin: '5678',
        })
        assert.ok(res.data.token)
      })

      it('binds one shared login ID to whichever classroom code accompanies it', async () => {
        const teacherA = await onboardGoogleTeacher('share.a@school.org', 'Share Room A')
        const teacherB = await onboardGoogleTeacher('share.b@school.org', 'Share Room B')
        const loginA = await seedActivatedStudent(teacherA, 's-a', 'Same Name', '1111')
        const loginB = await seedActivatedStudent(teacherB, 's-b', 'Same Name', '2222')
        assert.equal(loginA, loginB)

        const student = createTestClientApp()
        const login = httpsCallable(student.functions, 'studentPinLoginV2')

        const resA = await login({ classroomCode: teacherA.studentLoginCode, loginId: loginA, pin: '1111' })
        const credA = await signInWithCustomToken(student.auth, resA.data.token)
        assert.equal(credA.user.uid, deriveStudentAuthUid(teacherA.classroomId, 's-a'))
        const claimsA = await getIdTokenResult(credA.user, true)
        assert.equal(claimsA.claims.classroomId, teacherA.classroomId)

        const resB = await login({ classroomCode: teacherB.studentLoginCode, loginId: loginB, pin: '2222' })
        const credB = await signInWithCustomToken(student.auth, resB.data.token)
        assert.equal(credB.user.uid, deriveStudentAuthUid(teacherB.classroomId, 's-b'))
        assert.notEqual(credB.user.uid, credA.user.uid)

        // The right PIN with the other classroom's code must fail.
        await expectCallableError(
          () => login({ classroomCode: teacherB.studentLoginCode, loginId: loginA, pin: '1111' }),
          'unauthenticated',
        )
      })

      it('caps failure telemetry without locking out a victim who knows the PIN', async () => {
        const teacher = await onboardGoogleTeacher('lock@school.org', 'Lock Room')
        const loginId = await seedActivatedStudent(teacher, 's-lock', 'Locked Student', '4321')
        const student = createTestClientApp()
        const login = httpsCallable(student.functions, 'studentPinLoginV2')

        for (let attempt = 1; attempt <= 10; attempt += 1) {
          await expectCallableError(
            () => login({ classroomCode: teacher.studentLoginCode, loginId, pin: '0000' }),
            'unauthenticated',
            'Invalid student credentials.',
          )
          const snap = await credentialsRef(teacher.classroomId).doc(loginId).get()
          assert.equal(snap.data().failedAttempts, Math.min(attempt, 5))
          assert.equal(snap.data().lockedUntil, null)
        }

        const recovered = await login({
          classroomCode: teacher.studentLoginCode,
          loginId,
          pin: '4321',
        })
        assert.ok(recovered.data.token)
        const credential = await credentialsRef(teacher.classroomId).doc(loginId).get()
        assert.equal(credential.data().failedAttempts, 0)
        assert.equal(credential.data().lockedUntil, null)
      })

      it('throttles the eleventh attempt in a rolling window for one identifier digest', async () => {
        const teacher = await onboardGoogleTeacher('throttle@school.org', 'Throttle Room')
        const student = createTestClientApp()
        const login = httpsCallable(student.functions, 'studentPinLoginV2')
        // An unknown login ID never touches a credential, so the credential
        // lockout cannot mask the digest throttle.
        const ghost = 'ghost-student'
        const digest = throttleDigest(canonicalizeCode(teacher.studentLoginCode), ghost)

        for (let attempt = 1; attempt <= 10; attempt += 1) {
          await expectCallableError(
            () => login({ classroomCode: teacher.studentLoginCode, loginId: ghost, pin: '0000' }),
            'unauthenticated',
          )
        }

        const bucket = await db.collection('studentLoginThrottle').doc(digest).get()
        assert.equal(bucket.exists, true)
        assert.equal(bucket.data().attempts.length, 10)

        await expectCallableError(
          () => login({ classroomCode: teacher.studentLoginCode, loginId: ghost, pin: '0000' }),
          'unauthenticated',
          'Invalid student credentials.',
        )

        const afterThrottle = await db.collection('studentLoginThrottle').doc(digest).get()
        assert.equal(afterThrottle.data().attempts.length, 10,
          'a throttled attempt must not extend the window')

        const throttled = await db
          .collection('studentAuthLogs').doc(teacher.classroomId).collection('logs')
          .where('outcome', '==', 'throttled').get()
        assert.equal(throttled.size, 0,
          'throttled requests must not amplify writes by creating more logs')
      })

      it('ignores throttle timestamps that fell out of the rolling window', async () => {
        const teacher = await onboardGoogleTeacher('expire@school.org', 'Expire Room')
        const loginId = await seedActivatedStudent(teacher, 's-exp', 'Expire Student', '4321')
        const digest = throttleDigest(canonicalizeCode(teacher.studentLoginCode), loginId)

        const stale = Date.now() - (6 * 60 * 1000)
        await db.collection('studentLoginThrottle').doc(digest).set({
          attempts: Array.from({ length: 10 }, (_, index) => stale - index),
          updatedAt: stale,
        })

        const student = createTestClientApp()
        const res = await httpsCallable(student.functions, 'studentPinLoginV2')({
          classroomCode: teacher.studentLoginCode,
          loginId,
          pin: '4321',
        })
        assert.ok(res.data.token, 'expired attempts must not throttle a valid login')

        const bucket = await db.collection('studentLoginThrottle').doc(digest).get()
        assert.equal(bucket.data().attempts.length, 0,
          'a successful login must clear every expired identifier timestamp')
      })

      it('funnels non-string code and login requests into one empty-identifier bucket', async () => {
        const teacher = await onboardGoogleTeacher('nonstring@school.org', 'Non String Room')
        const student = createTestClientApp()
        const login = httpsCallable(student.functions, 'studentPinLoginV2')
        const emptyDigest = throttleDigest('', '')

        await expectCallableError(
          () => login({ classroomCode: 12345678, loginId: null, pin: '0000' }),
          'unauthenticated',
          'Invalid student credentials.',
        )
        await expectCallableError(
          () => login({ classroomCode: true, loginId: [], pin: 7 }),
          'unauthenticated',
        )

        const bucket = await db.collection('studentLoginThrottle').doc(emptyDigest).get()
        assert.equal(bucket.exists, true,
          'non-string identifiers must share SHA-256(empty-code + NUL + empty-login)')
        assert.equal(bucket.data().attempts.length, 2)

        // Malformed requests never resolve a classroom, so they stay private.
        assert.equal((await db.collection('studentAuthUnresolvedLogs').get()).size, 2)
        assert.equal(
          (await db.collection('studentAuthLogs').doc(teacher.classroomId).collection('logs').get()).size,
          0,
        )
      })

      it('separates known-classroom logs from server-private unresolved logs', async () => {
        const teacher = await onboardGoogleTeacher('logs@school.org', 'Logs Room')
        const loginId = await seedActivatedStudent(teacher, 's-log', 'Log Student', '4321')
        const student = createTestClientApp()
        const login = httpsCallable(student.functions, 'studentPinLoginV2')

        await login({ classroomCode: teacher.studentLoginCode, loginId, pin: '4321' })
        await expectCallableError(
          () => login({ classroomCode: teacher.studentLoginCode, loginId, pin: '0000' }),
          'unauthenticated',
        )
        await expectCallableError(
          () => login({ classroomCode: 'ZZZZ2222', loginId, pin: '4321' }),
          'unauthenticated',
        )
        await expectCallableError(
          () => login({ classroomCode: 'not-a-code', loginId, pin: '4321' }),
          'unauthenticated',
        )

        const scoped = await db
          .collection('studentAuthLogs').doc(teacher.classroomId).collection('logs').get()
        assert.equal(scoped.size, 2, 'only resolved attempts belong to the tenant log')
        assert.deepEqual(
          scoped.docs.map(d => d.data().outcome).sort(),
          ['invalid_credentials', 'success'],
        )
        for (const doc of scoped.docs) {
          assert.equal(doc.data().studentId, 's-log')
        }

        const unresolved = await db.collection('studentAuthUnresolvedLogs').get()
        assert.equal(unresolved.size, 2, 'unknown and malformed codes stay server-private')
        for (const doc of unresolved.docs) {
          assert.equal(doc.data().studentId, undefined,
            'an unresolved attempt must not record a student identity')
        }
      })

      it('never writes a raw identifier, PIN, hash, or token into any log or throttle record', async () => {
        const teacher = await onboardGoogleTeacher('scan@school.org', 'Scan Room')
        const loginId = await seedActivatedStudent(teacher, 's-scan', 'Scan Student', '4321')
        const student = createTestClientApp()
        const login = httpsCallable(student.functions, 'studentPinLoginV2')

        const successRes = await login({
          classroomCode: teacher.studentLoginCode,
          loginId,
          pin: '4321',
        })
        await expectCallableError(
          () => login({ classroomCode: teacher.studentLoginCode, loginId, pin: '0000' }),
          'unauthenticated',
        )
        await expectCallableError(
          () => login({ classroomCode: 'QQQQ7777', loginId: 'secret-ghost', pin: '9999' }),
          'unauthenticated',
        )

        const credential = await credentialsRef(teacher.classroomId).doc(loginId).get()
        const forbidden = [
          '4321',
          '0000',
          '9999',
          loginId,
          'secret-ghost',
          teacher.studentLoginCode,
          canonicalizeCode(teacher.studentLoginCode),
          'QQQQ7777',
          credential.data().pinHash,
          successRes.data.token,
        ]

        const records = []
        const scopedLogs = await db.collectionGroup('logs').get()
        for (const doc of scopedLogs.docs) records.push({ path: doc.ref.path, data: doc.data() })
        const unresolvedLogs = await db.collection('studentAuthUnresolvedLogs').get()
        for (const doc of unresolvedLogs.docs) records.push({ path: doc.ref.path, data: doc.data() })
        const throttles = await db.collection('studentLoginThrottle').get()
        for (const doc of throttles.docs) records.push({ path: doc.ref.path, data: doc.data() })
        assert.ok(records.length >= 5, 'the scan must actually have records to inspect')

        // Digest fields are one-way by construction and are checked structurally
        // below; every other string is scanned literally. Numeric fields are
        // excluded from substring scanning so an epoch timestamp that happens to
        // contain "4321" cannot masquerade as a leak, and cannot hide one either
        // because a leaked PIN or ID would be a string.
        function stringsIn(value, key) {
          if (typeof value === 'string') return key === 'identifierDigest' ? [] : [value]
          if (Array.isArray(value)) return value.flatMap(item => stringsIn(item, key))
          if (value && typeof value === 'object') {
            return Object.entries(value).flatMap(([childKey, child]) => [
              childKey,
              ...stringsIn(child, childKey),
            ])
          }
          return []
        }

        for (const record of records) {
          const strings = stringsIn(record.data, null)
          for (const secret of forbidden) {
            assert.equal(
              record.path.includes(secret), false,
              `document ID ${record.path} leaks a sensitive value`,
            )
            for (const candidate of strings) {
              assert.equal(
                candidate.includes(secret), false,
                `document ${record.path} body leaks a sensitive value in ${JSON.stringify(candidate)}`,
              )
            }
          }
          const digest = record.data.identifierDigest
          if (digest !== undefined) {
            assert.match(digest, /^[a-f0-9]{64}$/, `${record.path} identifierDigest is not a SHA-256 digest`)
          }
          const throttleId = record.path.startsWith('studentLoginThrottle/')
            ? record.path.split('/')[1]
            : null
          if (throttleId !== null) {
            assert.match(throttleId, /^[a-f0-9]{64}$/, 'a throttle document ID must be a SHA-256 digest')
          }
        }

        // Bodies are restricted to the documented non-sensitive fields.
        for (const doc of scopedLogs.docs) {
          assert.deepEqual(
            Object.keys(doc.data()).sort(),
            ['identifierDigest', 'outcome', 'studentId', 'success', 'timestamp'],
          )
          assert.equal(doc.data().studentId, 's-scan')
          assert.equal(typeof doc.data().timestamp, 'number')
        }
        for (const doc of unresolvedLogs.docs) {
          assert.deepEqual(
            Object.keys(doc.data()).sort(),
            ['identifierDigest', 'outcome', 'success', 'timestamp'],
          )
        }
        for (const doc of throttles.docs) {
          assert.deepEqual(Object.keys(doc.data()).sort(), ['attempts', 'updatedAt'])
          assert.ok(doc.data().attempts.every(value => typeof value === 'number'))
        }
        assert.equal(
          throttles.docs.some(d => d.id === throttleDigest(canonicalizeCode(teacher.studentLoginCode), loginId)),
          true,
          'the resolved attempts must share the documented identifier digest bucket',
        )
      })

      it('refuses a forged classroom login-code index that the classroom root disowns', async () => {
        const teacher = await onboardGoogleTeacher('forgecode@school.org', 'Forge Code Room')
        const loginId = await seedActivatedStudent(teacher, 's-fc', 'Forge Target', '4321')
        const before = (await credentialsRef(teacher.classroomId).doc(loginId).get()).data()

        await db.collection('classroomLoginCodes').doc('ZZZZ2222').set({
          classroomId: teacher.classroomId,
          status: 'active',
        })

        const student = createTestClientApp()
        await expectCallableError(
          () => httpsCallable(student.functions, 'studentPinLoginV2')({
            classroomCode: 'ZZZZ-2222',
            loginId,
            pin: '4321',
          }),
          'unauthenticated',
          'Invalid student credentials.',
        )

        assert.deepEqual((await credentialsRef(teacher.classroomId).doc(loginId).get()).data(), before)
        assert.equal((await db.collection('studentAuthUnresolvedLogs').get()).size, 1,
          'a disowned code must resolve to nothing and stay in the private log')
      })

      it('refuses a login when the classroom foundation is disabled or inconsistent', async () => {
        const teacher = await onboardGoogleTeacher('forgefound@school.org', 'Forge Found Room')
        const loginId = await seedActivatedStudent(teacher, 's-ff', 'Foundation Target', '4321')
        const student = createTestClientApp()
        const login = httpsCallable(student.functions, 'studentPinLoginV2')

        await db.collection('teachers').doc(teacher.uid).update({ status: 'disabled' })
        await expectCallableError(
          () => login({ classroomCode: teacher.studentLoginCode, loginId, pin: '4321' }),
          'unauthenticated',
        )

        await db.collection('teachers').doc(teacher.uid).update({ status: 'active' })
        await db.collection('classrooms').doc(teacher.classroomId).update({ ownerUid: 'not-the-owner' })
        await expectCallableError(
          () => login({ classroomCode: teacher.studentLoginCode, loginId, pin: '4321' }),
          'unauthenticated',
        )

        await db.collection('classrooms').doc(teacher.classroomId).update({ ownerUid: teacher.uid })
        await db.collection('classroomLoginCodes')
          .doc(canonicalizeCode(teacher.studentLoginCode))
          .update({ status: 'revoked' })
        await expectCallableError(
          () => login({ classroomCode: teacher.studentLoginCode, loginId, pin: '4321' }),
          'unauthenticated',
        )
      })

      it('refuses a credential whose stored identity has been forged', async () => {
        const teacher = await onboardGoogleTeacher('forgecred@school.org', 'Forge Cred Room')
        const loginId = await seedActivatedStudent(teacher, 's-fcr', 'Cred Target', '4321')
        const credRef = credentialsRef(teacher.classroomId).doc(loginId)
        const original = (await credRef.get()).data()
        const student = createTestClientApp()
        const login = httpsCallable(student.functions, 'studentPinLoginV2')

        const forgeries = [
          { classroomId: 'another-classroom' },
          { studentId: 's-someone-else' },
          { authUid: 's_forged-uid' },
          { loginId: 'a-different-login' },
          { schemaVersion: 99 },
          { active: false },
          { pinHash: '' },
        ]
        for (const forgery of forgeries) {
          await credRef.set({ ...original, ...forgery })
          await expectCallableError(
            () => login({ classroomCode: teacher.studentLoginCode, loginId, pin: '4321' }),
            'unauthenticated',
            'Invalid student credentials.',
          )
          const after = await credRef.get()
          assert.equal(
            after.data().failedAttempts, original.failedAttempts,
            'an unusable credential must not be mutated by a login attempt',
          )
        }

        await credRef.set(original)
        const ok = await login({ classroomCode: teacher.studentLoginCode, loginId, pin: '4321' })
        assert.ok(ok.data.token, 'the restored credential must work again')
      })
    })
  })
}
