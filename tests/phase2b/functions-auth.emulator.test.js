import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { initializeApp, deleteApp } from 'firebase/app'
import {
  getAuth,
  connectAuthEmulator,
  signInWithCustomToken,
  signOut,
  getIdTokenResult,
} from 'firebase/auth'
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from 'firebase/functions'

const functionsRequire = createRequire(new URL('../../functions/package.json', import.meta.url))
const admin = functionsRequire('firebase-admin')
const bcrypt = functionsRequire('bcryptjs')

const testMode = process.env.PHASE2B_EMULATOR_TEST_MODE
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST
const functionsHost = '127.0.0.1:5001'
const gcloudProject = process.env.GCLOUD_PROJECT

if (!['gate-off', 'gate-on'].includes(testMode)) {
  throw new Error(`PHASE2B_EMULATOR_TEST_MODE must be "gate-off" or "gate-on". Received: "${testMode}"`)
}

function isLoopback(h) {
  if (!h || typeof h !== 'string') return false
  const parts = h.split(':')
  if (parts.length !== 2) return false
  const port = parseInt(parts[1], 10)
  return (parts[0] === '127.0.0.1' || parts[0] === 'localhost') && port > 0 && port < 65536
}

if (!isLoopback(firestoreHost)) {
  throw new Error(`FIRESTORE_EMULATOR_HOST must be a loopback host:port. Received: "${firestoreHost}"`)
}
if (!isLoopback(authHost)) {
  throw new Error(`FIREBASE_AUTH_EMULATOR_HOST must be a loopback host:port. Received: "${authHost}"`)
}

const expectedProject = testMode === 'gate-off'
  ? 'morgan-bank-phase2b-server-off-test'
  : 'morgan-bank-phase2b-server-test'

if (gcloudProject !== expectedProject) {
  throw new Error(`Expected project ID "${expectedProject}" for mode "${testMode}", but got "${gcloudProject}"`)
}
if (gcloudProject === 'morgan-bank' || !gcloudProject.includes('-test')) {
  throw new Error(`Forbidden production or non-test project ID: "${gcloudProject}"`)
}

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: expectedProject })
}
const db = admin.firestore()
const adminAuth = admin.auth()

let clientApps = []

function createTestClientApp() {
  const appName = `test-app-${Date.now()}-${Math.random()}`
  const app = initializeApp({
    projectId: expectedProject,
    apiKey: 'fake-api-key',
  }, appName)

  const auth = getAuth(app)
  connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true })

  const functions = getFunctions(app, 'us-central1')
  connectFunctionsEmulator(functions, '127.0.0.1', 5001)

  clientApps.push(app)
  return { app, auth, functions }
}

async function cleanupClientApps() {
  for (const app of clientApps) {
    try {
      await deleteApp(app)
    } catch {
      // ignore
    }
  }
  clientApps = []
}

async function clearEmulators() {
  const firestoreUrl = `http://${firestoreHost}/emulator/v1/projects/${expectedProject}/databases/(default)/documents`
  const firestoreRes = await fetch(firestoreUrl, { method: 'DELETE' })
  if (!firestoreRes.ok) {
    throw new Error(`Failed to clear Firestore emulator: ${firestoreRes.statusText}`)
  }

  const authUrl = `http://${authHost}/emulator/v1/projects/${expectedProject}/accounts`
  const authRes = await fetch(authUrl, { method: 'DELETE' })
  if (!authRes.ok) {
    throw new Error(`Failed to clear Auth emulator: ${authRes.statusText}`)
  }
}

async function createGoogleUserInEmulator(email, subId = `google-sub-${Date.now()}-${Math.random().toString(36).substring(2)}`) {
  const postBody = `id_token=${encodeURIComponent(JSON.stringify({
    sub: subId,
    email: email,
    email_verified: true,
  }))}&providerId=google.com`

  const url = `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake-key`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody,
      requestUri: 'http://localhost',
      returnSecureToken: true,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to create Google user in Auth emulator: ${text}`)
  }

  const data = await res.json()
  return {
    uid: data.localId,
    idToken: data.idToken,
    email: data.email,
  }
}

async function waitForCondition(checkFn, timeoutMs = 5000, pollIntervalMs = 100) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await checkFn()
    if (result) return result
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`)
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

function hashSha256(input) {
  const crypto = functionsRequire('crypto')
  return crypto.createHash('sha256').update(input).digest('hex')
}

after(async () => {
  await cleanupClientApps()
  if (admin.apps.length > 0) {
    await Promise.all(admin.apps.map(a => a.delete()))
  }
})

if (testMode === 'gate-off') {
  describe('Gate-Off Emulator Compatibility Matrix (MULT_TEACHER_V2_ENABLED unset)', () => {
    beforeEach(async () => {
      await cleanupClientApps()
      await clearEmulators()
    })

    it('1. Legacy export names exist and execute through Functions emulator', async () => {
      const { functions } = createTestClientApp()
      const studentPinLoginFn = httpsCallable(functions, 'studentPinLogin')
      const resetStudentPinFn = httpsCallable(functions, 'resetStudentPin')
      const ensureTeacherClassroomFn = httpsCallable(functions, 'ensureTeacherClassroom')

      await assert.rejects(
        () => studentPinLoginFn({ loginId: 'invalid', pin: '0000' }),
        (err) => err.code === 'unauthenticated' || err.message.includes('Invalid student credentials'),
      )

      await assert.rejects(
        () => resetStudentPinFn({ studentId: 'invalid', newPin: '1234' }),
        (err) => err.code === 'unauthenticated',
      )

      await assert.rejects(
        () => ensureTeacherClassroomFn({}),
        (err) => err.code === 'unauthenticated',
      )
    })

    it('2. V2 export names exist but fail/inert before V2 data access', async () => {
      const { functions } = createTestClientApp()
      const resolveFn = httpsCallable(functions, 'resolveTeacherTenantV2')
      const onboardFn = httpsCallable(functions, 'onboardTeacherClassroomV2')
      const loginV2Fn = httpsCallable(functions, 'studentPinLoginV2')
      const resetV2Fn = httpsCallable(functions, 'resetStudentPinV2')

      for (const fn of [resolveFn, onboardFn, loginV2Fn, resetV2Fn]) {
        await assert.rejects(
          () => fn({}),
          (err) => err.code === 'failed-precondition' && err.message.includes('Multi-teacher V2 is disabled'),
        )
      }
    })

    it('3. Smoke-test legacy studentPinLogin using Admin-seeded flat credential', async () => {
      const legacyHash = await bcrypt.hash('1234', 12)
      await db.collection('studentCredentials').doc('legacy-john').set({
        loginId: 'legacy-john',
        pinHash: legacyHash,
        authUid: 'legacy-auth-john',
        studentId: 's-legacy-john',
        claims: { role: 'student', classroomId: 'morgan', studentId: 's-legacy-john' },
      })

      const { auth, functions } = createTestClientApp()
      const studentPinLoginFn = httpsCallable(functions, 'studentPinLogin')

      const res = await studentPinLoginFn({ loginId: 'legacy-john', pin: '1234' })
      assert.ok(res.data.token)

      const userCred = await signInWithCustomToken(auth, res.data.token)
      assert.equal(userCred.user.uid, 'legacy-auth-john')
    })

    it('4. Smoke-test legacy resetStudentPin with hardcoded teacher UID', async () => {
      const teacherUid = 'teacher-uid-1'
      const customToken = await adminAuth.createCustomToken(teacherUid)

      const oldHash = await bcrypt.hash('0000', 12)
      await db.collection('studentCredentials').doc('legacy-stu').set({
        loginId: 'legacy-stu',
        pinHash: oldHash,
        authUid: 'legacy-auth-stu',
        studentId: 's-legacy-stu',
      })

      const { auth, functions } = createTestClientApp()
      await signInWithCustomToken(auth, customToken)

      const resetFn = httpsCallable(functions, 'resetStudentPin')
      const res = await resetFn({ studentId: 's-legacy-stu', newPin: '9999' })
      assert.equal(res.data.success, true)

      const doc = await db.collection('studentCredentials').doc('legacy-stu').get()
      const isMatch = await bcrypt.compare('9999', doc.data().pinHash)
      assert.equal(isMatch, true)
    })

    it('5. Smoke-test ensureTeacherClassroom with hardcoded teacher UID', async () => {
      const teacherUid = 'teacher-uid-1'
      const customToken = await adminAuth.createCustomToken(teacherUid)

      const { auth, functions } = createTestClientApp()
      await signInWithCustomToken(auth, customToken)

      const ensureFn = httpsCallable(functions, 'ensureTeacherClassroom')
      const res = await ensureFn({})
      assert.equal(res.data.success, true)

      const doc = await db.collection('classrooms').doc('morgan').get()
      assert.ok(doc.exists)
    })

    it('6. Write morganBank/classroomData and prove legacy sync trigger creates flat credentials', async () => {
      await db.collection('morganBank').doc('classroomData').set({
        students: [
          { id: 1, name: 'Alice Smith', pin: '1111' }
        ]
      })

      const cred = await waitForCondition(async () => {
        const doc = await db.collection('studentCredentials').doc('alice-smith').get()
        return doc.exists ? doc.data() : null
      })

      assert.equal(cred.loginId, 'alice-smith')
      assert.equal(cred.studentId, '1')
    })

    it('7. Confirm no scoped V2 credential, throttle, or log created in gate-off mode', async () => {
      const scopedCreds = await db.collectionGroup('studentCredentials').get()
      const v2Creds = scopedCreds.docs.filter(d => d.ref.path.startsWith('classrooms/'))
      assert.equal(v2Creds.length, 0)

      const throttles = await db.collection('studentLoginThrottle').get()
      assert.equal(throttles.size, 0)

      const unresolvedLogs = await db.collection('studentAuthUnresolvedLogs').get()
      assert.equal(unresolvedLogs.size, 0)
    })
  })
}

if (testMode === 'gate-on') {
  describe('Gate-On Real-Emulator Acceptance Matrix (MULTI_TEACHER_V2_ENABLED=true)', () => {
    beforeEach(async () => {
      await cleanupClientApps()
      await clearEmulators()
    })

    describe('A. Guard and initialization safety', () => {
      it('Probe missing Auth host fails before initializeApp()', () => {
        assert.throws(() => {
          execSync(
            `"${process.execPath}" --input-type=module -e "delete process.env.FIREBASE_AUTH_EMULATOR_HOST; import('./functions/index.js')"`,
            { env: { ...process.env, MULTI_TEACHER_V2_ENABLED: 'true' }, stdio: 'pipe' }
          )
        })
      })

      it('Child process probes validate environment guards', () => {
        // Missing FUNCTIONS_EMULATOR
        assert.throws(() => {
          execSync(
            `"${process.execPath}" --input-type=module -e "delete process.env.FUNCTIONS_EMULATOR; import('./functions/index.js')"`,
            { env: { ...process.env, MULTI_TEACHER_V2_ENABLED: 'true' }, stdio: 'pipe' }
          )
        })

        // Forbidden project morgan-bank
        assert.throws(() => {
          execSync(
            `"${process.execPath}" --input-type=module -e "import('./functions/index.js')"`,
            { env: { ...process.env, MULTI_TEACHER_V2_ENABLED: 'true', GCLOUD_PROJECT: 'morgan-bank' }, stdio: 'pipe' }
          )
        })

        // Conflicting project variables
        assert.throws(() => {
          execSync(
            `"${process.execPath}" --input-type=module -e "import('./functions/index.js')"`,
            { env: {
              ...process.env,
              MULTI_TEACHER_V2_ENABLED: 'true',
              GCLOUD_PROJECT: 'morgan-bank-phase2b-server-test',
              FIREBASE_CONFIG: JSON.stringify({ projectId: 'morgan-bank-other' }),
            }, stdio: 'pipe' }
          )
        })

        // Non-loopback host
        assert.throws(() => {
          execSync(
            `"${process.execPath}" --input-type=module -e "import('./functions/index.js')"`,
            { env: {
              ...process.env,
              MULTI_TEACHER_V2_ENABLED: 'true',
              FIRESTORE_EMULATOR_HOST: '192.168.1.1:8080',
            }, stdio: 'pipe' }
          )
        })
      })

      it('Valid gate-on environment loads successfully', () => {
        const res = execSync(
          `"${process.execPath}" --input-type=module -e "import('./functions/index.js').then(() => console.log('LOADED_OK'))"`,
          { env: {
            ...process.env,
            FUNCTIONS_EMULATOR: 'true',
            FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
            FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
            GCLOUD_PROJECT: 'morgan-bank-phase2b-server-test',
            MULTI_TEACHER_V2_ENABLED: 'true',
          }, stdio: 'pipe' }
        ).toString()
        assert.ok(res.includes('LOADED_OK'))
      })
    })

    describe('B. Real Firestore SDK semantics', () => {
      it('Read-after-write transaction is rejected by Firestore emulator/SDK', async () => {
        const docRef = db.collection('testDocs').doc('t1')

        await assert.rejects(
          async () => {
            await db.runTransaction(async (tx) => {
              tx.set(docRef, { val: 1 })
              await tx.get(docRef)
            })
          },
          (err) => err.message.includes('Firestore transactions require all reads to be executed before all writes') || err.message.includes('reads after writes'),
        )
      })

      it('Thrown/aborted transaction leaves no buffered writes committed', async () => {
        const docRef = db.collection('testDocs').doc('t-abort')

        await assert.rejects(
          async () => {
            await db.runTransaction(async (tx) => {
              tx.set(docRef, { val: 100 })
              throw new Error('Simulated abort')
            })
          },
          (err) => err.message === 'Simulated abort',
        )

        const snap = await docRef.get()
        assert.equal(snap.exists, false)
      })

      it('Force transaction conflict and prove callback retries', async () => {
        const docRef = db.collection('testDocs').doc('t-counter')
        await docRef.set({ count: 0 })

        let attempts = 0
        const promise1 = db.runTransaction(async (tx) => {
          attempts++
          const snap = await tx.get(docRef)
          const curr = snap.data().count
          if (attempts === 1) {
            // Interleave a write outside this transaction to force conflict
            await db.collection('testDocs').doc('t-counter').set({ count: 5 })
          }
          tx.update(docRef, { count: curr + 1 })
        })

        await promise1
        assert.ok(attempts > 1, 'Transaction should retry after conflict')
        const finalSnap = await docRef.get()
        assert.equal(finalSnap.data().count, 6)
      })

      it('Transaction.create on an existing document fails', async () => {
        const docRef = db.collection('testDocs').doc('t-create-exists')
        await docRef.set({ val: 'existing' })

        await assert.rejects(
          async () => {
            await db.runTransaction(async (tx) => {
              tx.create(docRef, { val: 'new' })
            })
          },
          (err) => /ALREADY_EXISTS|already exists/i.test(err.message),
        )
      })

      it('Transaction.update on a missing document fails', async () => {
        const docRef = db.collection('testDocs').doc('t-update-missing')

        await assert.rejects(
          async () => {
            await db.runTransaction(async (tx) => {
              tx.update(docRef, { val: 'updated' })
            })
          },
          (err) => /NOT_FOUND|no document to update/i.test(err.message),
        )
      })
    })

    describe('C. Teacher onboarding and resolution', () => {
      it('Create Teacher A and B via verified Google emulator identities and onboard', async () => {
        const teacherAUser = await createGoogleUserInEmulator('teacher.a@school.org')
        const teacherBUser = await createGoogleUserInEmulator('teacher.b@school.org')

        const hashA = hashSha256(normalizeEmail('teacher.a@school.org'))
        const hashB = hashSha256(normalizeEmail('teacher.b@school.org'))

        await db.collection('teacherInvitations').doc(hashA).set({
          email: 'teacher.a@school.org',
          status: 'active',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        await db.collection('teacherInvitations').doc(hashB).set({
          email: 'teacher.b@school.org',
          status: 'active',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        const { auth: authA, functions: functionsA } = createTestClientApp()
        await signInWithCustomToken(authA, await adminAuth.createCustomToken(teacherAUser.uid))

        // Assert claims from Auth emulator
        const tokenResA = await getIdTokenResult(authA.currentUser)
        assert.equal(tokenResA.claims.email, 'teacher.a@school.org')
        assert.equal(tokenResA.claims.email_verified, true)
        assert.equal(tokenResA.claims.firebase?.sign_in_provider, 'google.com')

        const onboardFnA = httpsCallable(functionsA, 'onboardTeacherClassroomV2')
        const resA = await onboardFnA({ classroomName: 'Classroom Alpha' })
        assert.ok(resA.data.classroomId)
        assert.ok(resA.data.studentLoginCode)

        // Retry onboarding for Teacher A returns identical classroom & code
        const resA2 = await onboardFnA({ classroomName: 'Classroom Alpha Retry' })
        assert.equal(resA2.data.classroomId, resA.data.classroomId)
        assert.equal(resA2.data.studentLoginCode, resA.data.studentLoginCode)

        // Onboard Teacher B
        const { auth: authB, functions: functionsB } = createTestClientApp()
        await signInWithCustomToken(authB, await adminAuth.createCustomToken(teacherBUser.uid))
        const onboardFnB = httpsCallable(functionsB, 'onboardTeacherClassroomV2')
        const resB = await onboardFnB({ classroomName: 'Classroom Beta' })
        assert.ok(resB.data.classroomId)
        assert.notEqual(resB.data.classroomId, resA.data.classroomId)

        // Resolve teacher tenant for A and B
        const resolveFnA = httpsCallable(functionsA, 'resolveTeacherTenantV2')
        const tenantA = await resolveFnA({})
        assert.equal(tenantA.data.classroomId, resA.data.classroomId)
        assert.equal(tenantA.data.teacher.uid, teacherAUser.uid)

        const resolveFnB = httpsCallable(functionsB, 'resolveTeacherTenantV2')
        const tenantB = await resolveFnB({})
        assert.equal(tenantB.data.classroomId, resB.data.classroomId)
        assert.equal(tenantB.data.teacher.uid, teacherBUser.uid)
      })

      it('Uninvited user onboarding is denied generically', async () => {
        const uninvitedUser = await createGoogleUserInEmulator('uninvited@school.org')
        const { auth, functions } = createTestClientApp()
        await signInWithCustomToken(auth, await adminAuth.createCustomToken(uninvitedUser.uid))

        const onboardFn = httpsCallable(functions, 'onboardTeacherClassroomV2')
        await assert.rejects(
          () => onboardFn({ classroomName: 'Denied Room' }),
          (err) => err.code === 'permission-denied' && err.message.includes('This account is not eligible to complete this action.'),
        )
      })
    })

    describe('D. V2 sync and credential creation', () => {
      it('Write student documents and verify syncStudentProfilesV2 trigger creates credentials', async () => {
        const teacherUser = await createGoogleUserInEmulator('sync.teacher@school.org')
        const hash = hashSha256(normalizeEmail('sync.teacher@school.org'))
        await db.collection('teacherInvitations').doc(hash).set({
          email: 'sync.teacher@school.org',
          status: 'active',
        })

        const { auth, functions } = createTestClientApp()
        await signInWithCustomToken(auth, await adminAuth.createCustomToken(teacherUser.uid))
        const onboardFn = httpsCallable(functions, 'onboardTeacherClassroomV2')
        const onboardRes = await onboardFn({ classroomName: 'Sync Room' })
        const classroomId = onboardRes.data.classroomId

        // Write student doc under classrooms/{classroomId}/students/s-stu1
        await db.collection('classrooms').doc(classroomId).collection('students').doc('s-stu1').set({
          name: 'Bob Jones',
          pin: '5555',
        })

        // Poll for V2 credential creation
        const cred = await waitForCondition(async () => {
          const snap = await db.collection('classrooms').doc(classroomId).collection('studentCredentials').doc('bob-jones').get()
          return snap.exists ? snap.data() : null
        })

        assert.equal(cred.schemaVersion, 1)
        assert.equal(cred.classroomId, classroomId)
        assert.equal(cred.studentId, 's-stu1')
        assert.equal(cred.active, true)
        assert.equal(cred.failedAttempts, 0)
        assert.equal(cred.lockedUntil, null)
        assert.ok(cred.authUid.startsWith('s_'))
        assert.ok(cred.pinHash.startsWith('$2b$12$'))

        // Same name student created in same classroom gets distinct canonical ID
        await db.collection('classrooms').doc(classroomId).collection('students').doc('s-stu2').set({
          name: 'Bob Jones',
          pin: '6666',
        })

        const cred2 = await waitForCondition(async () => {
          const snap = await db.collection('classrooms').doc(classroomId).collection('studentCredentials').doc('bob-jones-2').get()
          return snap.exists ? snap.data() : null
        })
        assert.equal(cred2.studentId, 's-stu2')
        assert.equal(cred2.loginId, 'bob-jones-2')

        // Deleting student document marks credential inactive
        await db.collection('classrooms').doc(classroomId).collection('students').doc('s-stu1').delete()
        const credDeactivated = await waitForCondition(async () => {
          const snap = await db.collection('classrooms').doc(classroomId).collection('studentCredentials').doc('bob-jones').get()
          return snap.exists && snap.data().active === false ? snap.data() : null
        })
        assert.equal(credDeactivated.active, false)
      })
    })

    describe('E. Tenant-derived PIN reset', () => {
      it('Reset student PIN as owner teacher and verify fields and cross-tenant safety', async () => {
        const teacherA = await createGoogleUserInEmulator('pin.teacher.a@school.org')
        const teacherB = await createGoogleUserInEmulator('pin.teacher.b@school.org')

        await db.collection('teacherInvitations').doc(hashSha256('pin.teacher.a@school.org')).set({ email: 'pin.teacher.a@school.org', status: 'active' })
        await db.collection('teacherInvitations').doc(hashSha256('pin.teacher.b@school.org')).set({ email: 'pin.teacher.b@school.org', status: 'active' })

        const { auth: authA, functions: functionsA } = createTestClientApp()
        await signInWithCustomToken(authA, await adminAuth.createCustomToken(teacherA.uid))
        const roomA = (await httpsCallable(functionsA, 'onboardTeacherClassroomV2')({ classroomName: 'Room A' })).data.classroomId

        const { auth: authB, functions: functionsB } = createTestClientApp()
        await signInWithCustomToken(authB, await adminAuth.createCustomToken(teacherB.uid))
        const roomB = (await httpsCallable(functionsB, 'onboardTeacherClassroomV2')({ classroomName: 'Room B' })).data.classroomId

        // Create student in Room A and B with same studentId 's-shared'
        await db.collection('classrooms').doc(roomA).collection('students').doc('s-shared').set({ name: 'Sam Red', pin: '1111' })
        await db.collection('classrooms').doc(roomB).collection('students').doc('s-shared').set({ name: 'Sam Blue', pin: '2222' })

        await waitForCondition(async () => (await db.collection('classrooms').doc(roomA).collection('studentCredentials').doc('sam-red').get()).exists)
        await waitForCondition(async () => (await db.collection('classrooms').doc(roomB).collection('studentCredentials').doc('sam-blue').get()).exists)

        const credBSnapBefore = await db.collection('classrooms').doc(roomB).collection('studentCredentials').doc('sam-blue').get()
        const credBDataBefore = credBSnapBefore.data()

        // Teacher A resets student in Room A
        const resetFnA = httpsCallable(functionsA, 'resetStudentPinV2')
        const resetRes = await resetFnA({ studentId: 's-shared', newPin: '9876' })
        assert.equal(resetRes.data.success, true)

        // Verify Room A credential updated
        const credASnap = await db.collection('classrooms').doc(roomA).collection('studentCredentials').doc('sam-red').get()
        const credAData = credASnap.data()
        const isMatch = await bcrypt.compare('9876', credAData.pinHash)
        assert.equal(isMatch, true)
        assert.equal(credAData.failedAttempts, 0)
        assert.equal(credAData.lockedUntil, null)

        // Verify Room B credential byte-for-byte unchanged
        const credBSnapAfter = await db.collection('classrooms').doc(roomB).collection('studentCredentials').doc('sam-blue').get()
        assert.deepEqual(credBSnapAfter.data(), credBDataBefore)

        // Supplying classroomId parameter to reset is invalid-argument
        await assert.rejects(
          () => resetFnA({ studentId: 's-shared', newPin: '9876', classroomId: roomA }),
          (err) => err.code === 'invalid-argument',
        )

        // Teacher A trying to reset non-existent student in Room A fails closed
        await assert.rejects(
          () => resetFnA({ studentId: 's-nonexistent', newPin: '9876' }),
          (err) => err.code === 'not-found',
        )
      })
    })

    describe('F. Student login, logs, locks, throttle, and Auth', () => {
      it('Student login flow, custom token, claims, lockouts, and throttle', async () => {
        const teacher = await createGoogleUserInEmulator('student.login.teacher@school.org')
        await db.collection('teacherInvitations').doc(hashSha256('student.login.teacher@school.org')).set({ email: 'student.login.teacher@school.org', status: 'active' })

        const { auth: teacherAuth, functions: teacherFunctions } = createTestClientApp()
        await signInWithCustomToken(teacherAuth, await adminAuth.createCustomToken(teacher.uid))
        const onboardRes = (await httpsCallable(teacherFunctions, 'onboardTeacherClassroomV2')({ classroomName: 'Login Room' })).data

        const classroomId = onboardRes.classroomId
        const formattedCode = onboardRes.studentLoginCode
        const canonicalCode = formattedCode.replace('-', '')

        // Seed student document
        await db.collection('classrooms').doc(classroomId).collection('students').doc('s-login-1').set({ name: 'Charlie Brown', pin: '4321' })
        await waitForCondition(async () => (await db.collection('classrooms').doc(classroomId).collection('studentCredentials').doc('charlie-brown').get()).exists)

        const { auth: studentAuth, functions: studentFunctions } = createTestClientApp()
        const loginFn = httpsCallable(studentFunctions, 'studentPinLoginV2')

        // Successful login returns custom token
        const loginRes = await loginFn({ classroomCode: formattedCode, loginId: 'charlie-brown', pin: '4321' })
        assert.ok(loginRes.data.token)

        // Sign in with token and assert claims
        const userCred = await signInWithCustomToken(studentAuth, loginRes.data.token)
        const tokenResult = await getIdTokenResult(userCred.user)
        assert.equal(tokenResult.claims.role, 'student')
        assert.equal(tokenResult.claims.classroomId, classroomId)
        assert.equal(tokenResult.claims.studentId, 's-login-1')
        assert.equal(userCred.user.uid, tokenResult.claims.authUid || userCred.user.uid)

        // Known-classroom login log created under studentAuthLogs/{classroomId}/logs/*
        const logs = await db.collection('studentAuthLogs').doc(classroomId).collection('logs').get()
        assert.ok(logs.size > 0)
        for (const logDoc of logs.docs) {
          const l = logDoc.data()
          assert.equal(l.pin, undefined)
          assert.equal(l.pinHash, undefined)
          assert.equal(l.token, undefined)
          assert.equal(l.rawLoginId, undefined)
        }

        // Wrong PIN 5 times establishes 5-minute lockout
        for (let i = 0; i < 4; i++) {
          await assert.rejects(
            () => loginFn({ classroomCode: formattedCode, loginId: 'charlie-brown', pin: '0000' }),
            (err) => err.code === 'unauthenticated' && err.message.includes('Invalid student credentials'),
          )
        }

        // 5th attempt locks credential
        await assert.rejects(
          () => loginFn({ classroomCode: formattedCode, loginId: 'charlie-brown', pin: '0000' }),
          (err) => err.code === 'unauthenticated',
        )

        const credSnap = await db.collection('classrooms').doc(classroomId).collection('studentCredentials').doc('charlie-brown').get()
        assert.equal(credSnap.data().failedAttempts, 5)
        assert.ok(credSnap.data().lockedUntil !== null)

        // Invalid classroom code logs under studentAuthUnresolvedLogs
        await assert.rejects(
          () => loginFn({ classroomCode: 'INVALID8', loginId: 'charlie-brown', pin: '4321' }),
          (err) => err.code === 'unauthenticated',
        )
        const unresolved = await db.collection('studentAuthUnresolvedLogs').get()
        assert.ok(unresolved.size > 0)
      })
    })

    describe('G. Cross-tenant isolation', () => {
      it('Bidirectional teacher denial and cross-tenant isolation', async () => {
        const teacherA = await createGoogleUserInEmulator('iso.teacher.a@school.org')
        const teacherB = await createGoogleUserInEmulator('iso.teacher.b@school.org')

        await db.collection('teacherInvitations').doc(hashSha256('iso.teacher.a@school.org')).set({ email: 'iso.teacher.a@school.org', status: 'active' })
        await db.collection('teacherInvitations').doc(hashSha256('iso.teacher.b@school.org')).set({ email: 'iso.teacher.b@school.org', status: 'active' })

        const { auth: authA, functions: functionsA } = createTestClientApp()
        await signInWithCustomToken(authA, await adminAuth.createCustomToken(teacherA.uid))
        const roomA = (await httpsCallable(functionsA, 'onboardTeacherClassroomV2')({ classroomName: 'Iso Room A' })).data.classroomId

        const { auth: authB, functions: functionsB } = createTestClientApp()
        await signInWithCustomToken(authB, await adminAuth.createCustomToken(teacherB.uid))
        const roomB = (await httpsCallable(functionsB, 'onboardTeacherClassroomV2')({ classroomName: 'Iso Room B' })).data.classroomId

        // Teacher A resolving yields Room A, never Room B
        const resA = await httpsCallable(functionsA, 'resolveTeacherTenantV2')({})
        assert.equal(resA.data.classroomId, roomA)
        assert.notEqual(resA.data.classroomId, roomB)

        // Teacher B resolving yields Room B, never Room A
        const resB = await httpsCallable(functionsB, 'resolveTeacherTenantV2')({})
        assert.equal(resB.data.classroomId, roomB)
        assert.notEqual(resB.data.classroomId, roomA)

        // Teacher A cannot reset student in Room B
        await db.collection('classrooms').doc(roomB).collection('students').doc('s-student-b').set({ name: 'Student B', pin: '1234' })
        await waitForCondition(async () => (await db.collection('classrooms').doc(roomB).collection('studentCredentials').doc('student-b').get()).exists)

        const resetFnA = httpsCallable(functionsA, 'resetStudentPinV2')
        await assert.rejects(
          () => resetFnA({ studentId: 's-student-b', newPin: '9999' }),
          (err) => err.code === 'not-found',
        )
      })
    })
  })
}
