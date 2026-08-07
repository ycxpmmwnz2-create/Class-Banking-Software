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
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

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
  writeBatch,
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
const FINAL_RULES_PATH = path.join(REPO_ROOT, 'firestore.phase3.final.rules')

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
    await Promise.all(students.docs.map(doc => doc.ref.delete()))
    await waitFor(async () => {
      const creds = await db.collectionGroup('studentCredentials').get()
      return creds.docs.every(doc => doc.data().active !== true)
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
async function activateStudentPin(teacherFunctions, studentId, newPin) {
  const res = await httpsCallable(teacherFunctions, 'resetStudentPinV2')({ studentId, newPin })
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
    "console.log('GUARD_RESULT ' + JSON.stringify({ threw, apps: getApps().length, message, invocation, warningCategories, reviewedRelease: imported?.REVIEWED_V2_FUNCTIONS_RELEASE_ID || null, releaseParamAvailable: Boolean(imported?.MULTI_TEACHER_V2_RELEASE_ID), exportsAvailable: Boolean(imported?.studentPinLogin && imported?.studentPinLoginV2 && imported?.createTeacherInvitationV2 && imported?.revokeTeacherInvitationV2 && imported?.syncStudentProfilesV2) }))",
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
          MULTI_TEACHER_V2_RELEASE_ID: 'staging-support-functions-v1',
          FORCE_POST_GATE_APP_GUARD: 'true',
          RUN_V2_PROBE: 'true',
        })
        assert.equal(accepted.threw, false)
        assert.equal(accepted.reviewedRelease, 'staging-support-functions-v1')
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
          MULTI_TEACHER_V2_RELEASE_ID: 'staging-support-functions-v1',
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
    describe('C2. Fresh-classroom lifecycle seam', () => {
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

        const created = await httpsCallable(
          teacherA.functions,
          'createStudentV2',
        )({
          name: 'Fresh Student',
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
        const transactionPath =
          `classrooms/${teacherA.classroomId}/transactions/1001`
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
        assert.deepEqual(Object.keys(login.data), ['token'])
        const signedInStudent = await signInWithCustomToken(
          anonymousStudent.auth,
          login.data.token,
        )
        const claims = await getIdTokenResult(signedInStudent.user, true)
        assert.equal(claims.claims.classroomId, teacherA.classroomId)
        assert.equal(claims.claims.studentId, '1')

        const transaction = {
          id: 1001,
          date: '2026-07-31T12:00:00.000Z',
          studentId: 1,
          studentName: 'Fresh Student',
          type: 'Add',
          amount: 10,
          reason: 'Fresh-classroom acceptance',
          memo: '',
          category: 'Class',
          status: 'Approved',
          source: 'Teacher',
        }
        const teacherBatch = writeBatch(teacherA.firestore)
        teacherBatch.set(doc(teacherA.firestore, studentPath), {
          ...createdStudent.data(),
          balance: 35,
          transactions: [transaction],
        })
        teacherBatch.set(doc(teacherA.firestore, transactionPath), transaction)
        await teacherBatch.commit()

        const teacherRead = await getDoc(doc(teacherA.firestore, transactionPath))
        assert.deepEqual(teacherRead.data(), transaction)
        const studentRead = await getDoc(
          doc(anonymousStudent.firestore, studentPath),
        )
        assert.equal(studentRead.data().balance, 35)
        assert.deepEqual(studentRead.data().transactions, [transaction])

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
        )({ studentId: '1' })
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
    describe('D. V2 student sync trigger', () => {
      it('creates an inactive credential with the default PIN at bcrypt cost 12', async () => {
        const teacher = await onboardGoogleTeacher('sync@school.org', 'Sync Room')
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
        const teacher = await onboardGoogleTeacher('collide@school.org', 'Collide Room')

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
        const teacher = await onboardGoogleTeacher('recycle@school.org', 'Recycle Room')
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
        const teacher = await onboardGoogleTeacher('rename@school.org', 'Rename Room')
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
        const teacherA = await onboardGoogleTeacher('del.a@school.org', 'Delete Room A')
        const teacherB = await onboardGoogleTeacher('del.b@school.org', 'Delete Room B')

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
        const teacher = await onboardGoogleTeacher('syncdisabled@school.org', 'Sync Disabled Room')
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
        const teacher = await onboardGoogleTeacher('syncbroken@school.org', 'Sync Broken Room')
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
        const before = await waitForCredentialByStudentId(teacher.classroomId, 's-reset')
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
        await waitForCredentialByStudentId(teacher.classroomId, 's-f')

        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({
            studentId: 's-f',
            newPin: '1111',
            classroomId: teacher.classroomId,
          }),
          'invalid-argument',
        )
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-f', newPin: '12x4' }),
          'invalid-argument',
        )
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 'bad/id', newPin: '1111' }),
          'invalid-argument',
        )
      })

      it('fails closed for an unknown student in the caller’s own classroom', async () => {
        const teacher = await onboardGoogleTeacher('resetmissing@school.org', 'Reset Missing Room')
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-nope', newPin: '1111' }),
          'not-found',
        )
      })

      it('denies cross-tenant resets in both directions', async () => {
        const teacherA = await onboardGoogleTeacher('xa@school.org', 'Cross Room A')
        const teacherB = await onboardGoogleTeacher('xb@school.org', 'Cross Room B')

        await studentDocRef(teacherA.classroomId, 's-a-only').set({ name: 'Alpha Only' })
        await studentDocRef(teacherB.classroomId, 's-b-only').set({ name: 'Beta Only' })
        const credA = await waitForCredentialByStudentId(teacherA.classroomId, 's-a-only')
        const credB = await waitForCredentialByStudentId(teacherB.classroomId, 's-b-only')
        const beforeA = credA.data()
        const beforeB = credB.data()

        await expectCallableError(
          () => httpsCallable(teacherA.functions, 'resetStudentPinV2')({ studentId: 's-b-only', newPin: '2222' }),
          'not-found',
        )
        await expectCallableError(
          () => httpsCallable(teacherB.functions, 'resetStudentPinV2')({ studentId: 's-a-only', newPin: '2222' }),
          'not-found',
        )

        assert.deepEqual((await credentialsRef(teacherA.classroomId).doc(credA.id).get()).data(), beforeA)
        assert.deepEqual((await credentialsRef(teacherB.classroomId).doc(credB.id).get()).data(), beforeB)
      })

      it('refuses to repair a credential whose identity does not match the tenant', async () => {
        const teacher = await onboardGoogleTeacher('resetforged@school.org', 'Reset Forged Room')
        await studentDocRef(teacher.classroomId, 's-forged').set({ name: 'Forged Target' })
        const cred = await waitForCredentialByStudentId(teacher.classroomId, 's-forged')
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
            () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-forged', newPin: '3333' }),
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
        await waitForCredentialByStudentId(teacher.classroomId, 's-d')

        await db.collection('teachers').doc(teacher.uid).update({ status: 'disabled' })
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-d', newPin: '4444' }),
          'permission-denied',
        )

        await db.collection('teachers').doc(teacher.uid).update({ status: 'active' })
        await db.collection('classrooms').doc(teacher.classroomId).update({ ownerUid: 'someone-else' })
        await expectCallableError(
          () => httpsCallable(teacher.functions, 'resetStudentPinV2')({ studentId: 's-d', newPin: '4444' }),
          'failed-precondition',
        )

        await db.collection('classrooms').doc(teacher.classroomId).update({ ownerUid: teacher.uid })
      })

      it('requires authentication', async () => {
        const { functions } = createTestClientApp()
        await expectCallableError(
          () => httpsCallable(functions, 'resetStudentPinV2')({ studentId: 's-x', newPin: '1111' }),
          'unauthenticated',
        )
      })
    })

    // -----------------------------------------------------------------------
    describe('F. Student login, tokens, logs, locks, and throttles', () => {
      async function seedActivatedStudent(teacher, studentId, name, pin) {
        await studentDocRef(teacher.classroomId, studentId).set({ name })
        const cred = await waitForCredentialByStudentId(teacher.classroomId, studentId)
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
        assert.deepEqual(Object.keys(res.data), ['token'], 'only a token may be returned')

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
        assert.equal(tokenResult.claims.loginId, undefined)
        assert.equal(tokenResult.claims.pinHash, undefined)
      })

      it('refuses an inactive credential until the teacher activates it', async () => {
        const teacher = await onboardGoogleTeacher('inactive@school.org', 'Inactive Room')
        await studentDocRef(teacher.classroomId, 's-inactive').set({ name: 'Not Yet' })
        const cred = await waitForCredentialByStudentId(teacher.classroomId, 's-inactive')
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

      it('locks a credential after five failures and keeps the response generic', async () => {
        const teacher = await onboardGoogleTeacher('lock@school.org', 'Lock Room')
        const loginId = await seedActivatedStudent(teacher, 's-lock', 'Locked Student', '4321')
        const student = createTestClientApp()
        const login = httpsCallable(student.functions, 'studentPinLoginV2')

        for (let attempt = 1; attempt <= 5; attempt += 1) {
          await expectCallableError(
            () => login({ classroomCode: teacher.studentLoginCode, loginId, pin: '0000' }),
            'unauthenticated',
            'Invalid student credentials.',
          )
          const snap = await credentialsRef(teacher.classroomId).doc(loginId).get()
          assert.equal(snap.data().failedAttempts, attempt)
          assert.equal(snap.data().lockedUntil === null, attempt < 5,
            `lock must engage only on the fifth failure (attempt ${attempt})`)
        }

        // The correct PIN is refused while locked, and the lock is not reset.
        await expectCallableError(
          () => login({ classroomCode: teacher.studentLoginCode, loginId, pin: '4321' }),
          'unauthenticated',
          'Invalid student credentials.',
        )
        const locked = await credentialsRef(teacher.classroomId).doc(loginId).get()
        assert.equal(locked.data().failedAttempts, 5)
        assert.ok(locked.data().lockedUntil > Date.now())
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
        assert.equal(throttled.size, 1)
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
        assert.equal(bucket.data().attempts.length, 1,
          'the rolling window must drop every expired timestamp')
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
