# Google Sign-In Migration Plan

Status: Planning only. No code has been changed. This document analyzes the
current v1.0.0 architecture and proposes a path to (a) Google Sign-In for
teachers and (b) eventual multi-teacher / multi-classroom isolation.

---

## 1. Current Authentication Architecture

**Teacher:**
- Firebase Auth, email/password (`signInWithEmailAndPassword`), triggered from
  `loginTeacher()` in `index.html`.
- Persistence is explicitly set to `browserSessionPersistence` before sign-in.
- There is exactly **one** recognized teacher, identified by a single
  hardcoded UID (`TEACHER_UID`), which is duplicated as a literal string in
  four places:
  - `index.html` (client-side gating: `requireTeacher()`, `onAuthStateChanged`)
  - `firestore.rules` (`isTeacher()`)
  - `functions/resetStudentPin.js` (`requireTeacher(auth)`)
  - Implicitly relied upon anywhere `classroomId === "morgan"` is assumed
- There is no Firestore document representing "the teacher" as an entity —
  the UID literal *is* the authorization mechanism.

**Student:**
- Custom login flow: Student ID + PIN submitted to the `studentPinLogin`
  callable Cloud Function.
- `studentCredentialVerifier.js` looks up `studentCredentials/{loginId}`,
  verifies the PIN with bcrypt, enforces a 5-attempt lockout (5 minutes), and
  logs every attempt to `studentAuthLogs`.
- On success, the function mints a **Firebase custom token** with claims
  `{ role: "student", classroomId, studentId }` via
  `getAuth().createCustomToken(authUid, claims)`.
- Client calls `signInWithCustomToken(auth, token)`. `onAuthStateChanged`
  then reads back `role`/`classroomId`/`studentId` from the ID token result
  and hard-codes a check that `classroomId === "morgan"`.
- Firestore rules authorize student reads via a matching `isStudent()`
  function that compares custom-token claims against the requested document
  path.

**Key architectural fact:** authorization is claims-based for students
(scalable to multiple classrooms in principle) but UID-literal-based for the
teacher (not scalable at all — there is no notion of "a" teacher, only "the"
teacher).

---

## 2. Current Firestore Data Structure

```
morganBank/classroomData          <- single document: entire class's data blob
  { students: [...], transactions: [...], loginHistory: [...], settings: {...} }

classrooms/morgan/students/{studentId}   <- per-student read-only mirror
  { id, name, balance, frozen, transactions: [...] }

studentCredentials/{loginId}      <- flat collection, NOT scoped under classroom
  { schemaVersion, authUid, classroomId: "morgan", studentId, pinHash,
    active, failedAttempts, lockedUntil, createdAt, updatedAt, pinUpdatedAt }

studentAuthLogs/{logId}           <- flat collection, global, not classroom-scoped
  { loginId, success, reason, timestamp, classroomId?, studentId? }
```

Observations:
- `"morgan"` is a **string literal**, not a generated/foreign-keyed
  classroom ID. It appears hardcoded in `syncStudentProfiles.js` (three
  places), `index.html` (`classroomId === "morgan"` check), and is the only
  document ID ever written under `classrooms/`.
- The entire class's roster + every transaction ever recorded lives in
  **one Firestore document** (`morganBank/classroomData`). This is a
  single-teacher-classroom assumption baked deep into the read/write path
  (`loadData()`/`saveData()` in `index.html`, and the trigger path
  `onDocumentWritten('morganBank/classroomData', ...)` in
  `syncStudentProfiles.js`).
- `studentCredentials` and `studentAuthLogs` are flat, ungoverned by any
  classroom-scoped security rule beyond `isTeacher()` reading all of
  `studentAuthLogs`. Multi-teacher isolation does not exist at this layer —
  any future second teacher would, under current rules, see the same
  `studentAuthLogs` collection in full (rule only checks `isTeacher()`, not
  which classroom the log belongs to).
- There is no `teachers` collection and no per-teacher document at all today.

---

## 3. What Must Change

### For Google Sign-In only (single-teacher, no multi-tenancy yet)
1. **`index.html`**: replace `signInWithEmailAndPassword` + the email/password
   form with `signInWithPopup(auth, new GoogleAuthProvider())` (or
   `signInWithRedirect`, see Risks). The `browserSessionPersistence` call
   stays, unmodified — persistence is orthogonal to the provider.
2. **Firebase Console**: enable the Google sign-in provider under
   Authentication, and restrict/verify which Google account maps to the
   existing `TEACHER_UID`. Note: switching providers on an *existing* UID
   generally is not a drop-in swap — see Risks below on UID stability.
3. **`firestore.rules`, `functions/resetStudentPin.js`**: no change required
   *if* the existing `TEACHER_UID` constant continues to identify the same
   Firebase Auth user post-migration. If Google Sign-In creates a **new**
   Firebase Auth UID (the common outcome — see Risks), then `TEACHER_UID`
   must be updated everywhere it is hardcoded, and any data currently
   addressable only by admin/manual means tied to the old UID needs no
   change since authorization checks only compare UIDs, not stored data.
4. Remove the teacher email/password UI branch entirely once Google
   Sign-In is confirmed working, per the "smallest possible change" pattern
   already used in this codebase for the persistence change.

### For eventual multi-teacher / multi-classroom isolation
This is a materially larger change and should be treated as a **separate,
later migration**, not bundled with the Google Sign-In switch:
1. Introduce a `teachers/{teacherUid}` collection with at minimum
   `{ classroomId, displayName, email }`. Firestore rules move from a
   single hardcoded UID to `get(/databases/$(database)/documents/teachers/$(request.auth.uid))` lookups.
2. Replace the `"morgan"` literal everywhere with a real `classroomId`
   derived from the authenticated teacher's own `teachers/{uid}` document —
   never trust a client-supplied `classroomId`.
3. Re-key all classroom-scoped collections so isolation is structural, not
   just rule-enforced:
   - `morganBank/classroomData` → `classrooms/{classroomId}` (the class
     data blob keyed by classroom, not a fixed document name)
   - `studentCredentials` → scoped under `classrooms/{classroomId}/studentCredentials`
     (or keep flat but make every rule/query mandatorily filter by
     `classroomId` matching the caller's own teacher doc)
   - `studentAuthLogs` → same scoping problem; today any teacher able to
     read `studentAuthLogs` reads **all** classrooms' logs. This must be
     fixed before onboarding a second teacher, not after.
4. `syncStudentProfiles.js` must stop hardcoding `'morgan'` as the
   classroom filter and instead derive `classroomId` from the triggering
   document's path.
5. Student custom-token claims already carry `classroomId` — this part of
   the design was built with multi-classroom in mind and needs no rework,
   only the removal of the hardcoded `=== "morgan"` comparisons on the
   client.

---

## 4. What Can Stay the Same

- **Student authentication is untouched by both migrations.** Student ID +
  PIN, `studentPinLogin`, bcrypt hashing, lockout logic, and audit logging
  in `studentCredentialVerifier.js` require zero changes for the Google
  Sign-In switch, and only the `classroomId` sourcing changes (not the
  mechanism) for multi-tenancy.
- `resetStudentPin.js`'s `requireTeacher()` pattern (check `request.auth.uid`
  against a known-good value) is the right shape for multi-teacher too — it
  just needs to check against the caller's own `teachers/{uid}` document
  membership instead of one literal UID.
- Session-only persistence (`browserSessionPersistence`) behavior is
  provider-agnostic and stays exactly as implemented today.
- Firestore's per-student rule (`isStudent()`) already keys off claims,
  not the auth provider — no change needed there for the Google Sign-In
  step.
- `syncStudentProfiles`'s credential-healing/dedup logic (matching by
  login-id fallback) is independent of the auth provider and does not need
  to change for Google Sign-In.
- Hosting, build process, CSV export, transaction history, PIN reset UI —
  none of this is touched by either migration.

---

## 5. Recommended Migration Path (safest order)

**Phase A — Google Sign-In only, single teacher, production stays stable**
1. In a non-production Firebase project or the Auth Emulator, enable Google
   as a sign-in provider and confirm what UID a real sign-in produces for
   your Google account (emulator or a test project, not production, to
   avoid touching the live teacher UID prematurely).
2. Decide UID strategy up front (see Risks): either (a) plan for a new UID
   and update all four hardcoded locations, or (b) use Firebase Auth's
   account-linking (`linkWithPopup`) against the *existing* email/password
   user so the existing UID is preserved. **(b) is safer** since it avoids
   touching `firestore.rules` or any Cloud Function and keeps
   `TEACHER_UID` valid throughout.
3. Ship the client-side sign-in method swap behind a small, reversible
   change (mirroring how the session-persistence change was done): keep
   `signOut`/session behavior identical, only change how the credential is
   obtained.
4. Test end-to-end in a staging build: sign in with Google, confirm
   `auth.currentUser.uid` still equals `TEACHER_UID`, confirm
   `requireTeacher()`, Firestore rules, and `resetStudentPin` all still
   pass.
5. Remove the email/password form and the now-unused
   `signInWithEmailAndPassword` import.
6. Keep the old email/password provider enabled in Firebase Auth for a
   short overlap window as a fallback, then disable it once Google
   Sign-In is confirmed stable in real classroom use.

**Phase B — Multi-teacher / multi-classroom isolation (separate release)**
1. Design and add the `teachers/{uid}` collection and update
   `firestore.rules` to look up caller identity instead of comparing a
   literal UID. Do this behind a rules simulator test pass before deploying.
2. Migrate the single `morganBank/classroomData` document into a
   classroom-keyed structure, writing a one-time migration script that
   copies today's data into `classrooms/morgan` (preserving the existing
   `"morgan"` ID for the current class, so no data is lost or renamed
   mid-year).
3. Update `syncStudentProfiles.js` to derive `classroomId` from the
   document path rather than hardcoding `'morgan'`.
4. Scope `studentCredentials` and `studentAuthLogs` per classroom and fix
   the rule so a teacher can only read their own classroom's logs.
5. Only after the above is deployed and verified, onboard a second teacher
   account and confirm cross-classroom access is actually denied (test as
   an explicit acceptance step, not an assumption).

---

## 6. Risks

- **UID change on provider switch (highest risk for Phase A).** Firebase
  Auth's default behavior when a user signs in with a *new* provider and no
  existing account matches is to create a **new** user with a **new** UID.
  Since `TEACHER_UID` is a literal string duplicated in `firestore.rules`,
  `functions/resetStudentPin.js`, and `index.html`, an uncoordinated switch
  would silently lock the real teacher out of their own data (rules would
  deny a `request.auth.uid` that no longer matches) or, worse, treat a new
  Google-authenticated UID as an unrecognized user with **no access at
  all** until every hardcoded location is updated in lockstep. Mitigation:
  use Firebase account linking to preserve the existing UID, or update all
  four locations atomically in the same deploy and verify before removing
  the old sign-in method.
- **Single point of production truth.** All of `morganBank/classroomData`
  (every student, every transaction, ever) lives in one document. Any
  migration script touching this document must be tested against a copy of
  production data, not assumed safe from reading the code alone.
- **`studentAuthLogs` and `studentCredentials` are not classroom-scoped
  today.** If Phase B is rushed or partially deployed, a second teacher
  could read the first teacher's students' PIN-attempt logs. This must be
  fixed as part of Phase B, not left for "later," since it is a direct
  violation of the stated goal ("no teacher should ever access another
  teacher's students").
- **Google account governance.** Unlike email/password (where you control
  the credential), Google Sign-In ties access to whichever Google account
  can authenticate — if using a personal Gmail account, losing access to
  that Google account means losing access to the teacher role entirely with
  no independent password reset path under your control. Consider whether
  a Google Workspace / school-managed account is available and preferable
  to a personal Gmail account for this reason.
- **No current `teachers` collection.** Phase B is a genuine data-model
  migration, not a config change — it should not be attempted quickly or
  bundled with the Google Sign-In switch. Keep the two phases in separate
  releases so a problem in one is easy to isolate and roll back.
- **Cloud Functions predeploy lint/tests won't catch rule or UID
  mismatches.** The existing test suite covers `resetStudentPin` and
  `studentCredentialVerifier` logic well, but there is no automated test
  today for `firestore.rules` itself (e.g. via the Firestore Rules Unit
  Testing library / emulator). Adding rule tests before Phase B is strongly
  recommended given how much Phase B changes the rules.

---

## 7. Suggested Order of Work

1. Decide UID-preservation strategy for the teacher account (account
   linking vs. new UID + coordinated update) — this is a decision, not
   code, and should be settled before any implementation starts.
2. Implement and test Google Sign-In client-side change in isolation
   (Phase A steps 1–4), verified in a non-production project or emulator.
3. Deploy Phase A to production, keep email/password enabled briefly as a
   fallback, then disable it once confirmed stable in real use.
4. Only after Phase A has been used successfully in the classroom for a
   period of time, begin Phase B design: `teachers` collection schema,
   updated `firestore.rules`, and a rules-emulator test suite added
   *before* changing any production rule.
5. Write and dry-run the `classrooms/morgan` data migration script against
   a copy/export of production data.
6. Deploy Phase B behind the same read-only-check discipline used for the
   Google Sign-In change: verify build, lint, and functions tests pass,
   and manually confirm cross-classroom denial before onboarding any real
   second teacher.

---

*This document is planning output only. No source files were modified to
produce it. Per IDEAS.md's stated philosophy, nothing here should be
implemented until explicitly requested.*
