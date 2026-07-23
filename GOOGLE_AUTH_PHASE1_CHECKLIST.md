# Google Sign-In — Phase 1 Implementation Checklist

Status: Planning only. Nothing in this document has been implemented,
committed, or deployed. This checklist operationalizes **Phase A** from
`GOOGLE_AUTH_MIGRATION_PLAN.md` — Google Sign-In for the existing teacher
account, with the existing Firebase UID and all production data preserved.
Multi-teacher isolation (Phase B) is explicitly out of scope here.

**Goal:** the teacher can sign in with Google instead of email/password,
`auth.currentUser.uid` still equals the current `TEACHER_UID`
(`YkYUzIzy0aW7roolM1VaLcIJPuN2`), and nothing about student login,
Firestore rules, or Cloud Functions needs to change.

---

## 1. Manual Firebase Console Actions

These happen in the Firebase Console for the `morgan-bank` project, outside
the repository. None of this touches code.

1. Go to **Authentication → Sign-in method**.
2. Confirm **Email/Password** is currently listed as "Enabled" — note this,
   it must stay enabled through all of Phase 1 (see §7).
3. Click **Add new provider → Google**.
4. Enable the Google provider.
   - **Project support email**: set to an email you control and can
     receive Firebase/Google notifications at (required field).
   - Leave **Web SDK configuration** (client ID/secret) on Firebase's
     auto-managed default unless you have a specific reason to supply your
     own OAuth client — auto-managed is simpler and sufficient here.
5. Save.
6. Under **Authentication → Settings → Authorized domains**, confirm the
   production Hosting domain (and `localhost` for local testing) are
   already present. Firebase Hosting domains are added automatically; just
   verify, don't add anything unless missing.
7. Do **not** yet disable Email/Password. Do **not** delete or modify the
   existing teacher user record in **Authentication → Users**.
8. Decide (and write down, outside the console) which specific Google
   account will be linked — this should be an account the teacher controls
   long-term. See the account-governance risk in the migration plan
   (§6 of `GOOGLE_AUTH_MIGRATION_PLAN.md`) before choosing a personal Gmail
   vs. a school-managed Google account.

---

## 2. Verify the Current Email/Password Teacher Account and UID

Manual, read-only — confirms the baseline before touching anything.

1. In **Authentication → Users**, locate the existing teacher row (the one
   used for classroom logins).
2. Copy its **User UID** column value and confirm it matches the
   `TEACHER_UID` constant used in the codebase:
   `YkYUzIzy0aW7roolM1VaLcIJPuN2` — found today in:
   - [index.html:736](index.html#L736) — `const TEACHER_UID = "..."`
   - [firestore.rules:7](firestore.rules#L7) — `isTeacher()`
   - [functions/resetStudentPin.js:5](functions/resetStudentPin.js#L5) — `const TEACHER_UID = '...'`
3. Confirm the **Sign-in provider** column currently shows only
   "Email / Password" for this user — this is the pre-migration baseline
   you're comparing against after linking.
4. In a browser, sign in as the teacher via the existing email/password
   form and confirm in the browser console that
   `auth.currentUser.uid` equals the same value. This is your
   ground-truth check to compare against after linking (§3, §8).
5. Record the exact UID and the current sign-in-provider list somewhere
   outside the repo (a notes doc, not a committed file) so you have a
   known-good reference during testing and rollback.

---

## 3. Safest Account-Linking Flow

**Goal:** attach a Google credential to the *existing* Firebase user so the
UID never changes. This uses Firebase's account-linking API
(`linkWithPopup`), not a fresh Google sign-in.

Recommended flow, in order:

1. **Teacher must be signed in with the existing email/password credential
   first.** Account linking attaches a new credential to *whichever user is
   currently signed in* — so the existing session must be the
   already-authenticated `TEACHER_UID` user before linking.
2. From that authenticated session, call
   `linkWithPopup(auth.currentUser, new GoogleAuthProvider())`.
   - This is a **one-time, one-directional linking action** — it should be
     triggered by a deliberate, explicit UI action (e.g. a "Link Google
     Account" button shown only while signed in via email/password), not
     something that runs automatically on every login.
3. On success, `linkWithPopup`'s result reflects the **same** `auth.currentUser.uid`
   as before linking — Firebase attaches the Google credential as an
   additional sign-in method on the existing user record, it does not
   create a second user.
4. **Handle `auth/credential-already-in-use`**: this fires if the Google
   account is already linked to a *different* Firebase user (for example,
   if someone previously signed in with that Google account directly,
   creating a separate new user first). If this happens, **stop** — do not
   attempt to merge or delete users from a script. Resolve manually in the
   Console by confirming which user should be canonical, since Firebase
   cannot safely auto-merge two existing users with their own data.
5. **Handle `auth/provider-already-linked`**: fires if Google is already
   linked to the current user — treat this as success/no-op in the UI (see
   §6).
6. After linking succeeds once, the teacher can subsequently sign in with
   **either** email/password or Google — same UID either way, since both
   are now sign-in methods on one user record.
7. This linking step should be done **once**, in a controlled
   session (ideally by the teacher themselves, or by you on their behalf
   with them present), not exposed as a routine part of the login screen
   after Phase 1 ships.

---

## 4. Application Files That Will Need Changes

All changes are additive/small, consistent with the "smallest possible
change" pattern already used for the persistence change in this codebase.
No file listed here should have unrelated changes bundled in.

- **`index.html`**
  - Add `GoogleAuthProvider`, `linkWithPopup`, `signInWithPopup` to the
    existing Firebase Auth import (alongside the current
    `browserSessionPersistence, onAuthStateChanged, setPersistence,
    signInWithCustomToken, signInWithEmailAndPassword, signOut` import at
    [index.html:732](index.html#L732)).
  - Add a new function (e.g. `linkGoogleAccount()`) that calls
    `setPersistence` (reuse the existing `browserSessionPersistence` call,
    unchanged) then `linkWithPopup(auth.currentUser, new GoogleAuthProvider())`,
    with `try/catch` handling the two error codes in §3.4–§3.5.
  - Add a new function (e.g. `loginTeacherWithGoogle()`) that calls
    `setPersistence(auth, browserSessionPersistence)` then
    `signInWithPopup(auth, new GoogleAuthProvider())`, mirroring the
    existing `loginTeacher()` shape at [index.html:1249](index.html#L1249).
  - Add a "Sign in with Google" button/entry point on the teacher login
    screen, and (temporarily, per §7) a "Link Google Account" action
    reachable only from an authenticated teacher session.
  - `requireTeacher()` ([index.html:799](index.html#L799)) and the
    `onAuthStateChanged` handler ([index.html:2826](index.html#L2826)) need
    **no changes** — both key off `auth.currentUser?.uid === TEACHER_UID`,
    which is provider-agnostic once linking preserves the UID.
  - `loginStudent()` ([index.html:1268](index.html#L1268)) — **do not
    touch**.

- **`firestore.rules`** — no change expected. `isTeacher()` compares
  `request.auth.uid`, not the provider used to obtain it. Only revisit this
  file if the UID-preservation strategy fails and a new UID must be
  substituted (out of scope for the happy path).

- **`functions/resetStudentPin.js`** — no change expected, same reasoning
  (`requireTeacher(auth)` checks `auth.uid`, not provider).

- **`functions/index.js`, `functions/studentCredentialVerifier.js`,
  `functions/syncStudentProfiles.js`** — no changes. None of these
  reference the teacher's sign-in provider.

- **No changes** to `vite.config.js`, `package.json`, `src/firebase/firebase.js`
  (Google provider is used via the existing `auth` export, no new SDK
  config needed), CSS, or any Firestore data documents.

---

## 5. Hardcoded UID Values That Must Remain Unchanged

If Phase 1 is implemented correctly (linking, not a fresh sign-in), **none**
of the following should be edited during Phase 1. Listing them explicitly so
any diff touching these lines is treated as a red flag during review:

- `index.html:736` — `const TEACHER_UID = "YkYUzIzy0aW7roolM1VaLcIJPuN2";`
- `firestore.rules:7` — `&& request.auth.uid == "YkYUzIzy0aW7roolM1VaLcIJPuN2";`
- `functions/resetStudentPin.js:5` — `const TEACHER_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'`
- `functions/resetStudentPin.test.js:8` — test fixture using the same UID

If any of these four locations needs to change during implementation, that
is a signal the linking approach did not preserve the UID as intended, and
implementation should stop and be reassessed rather than proceeding to
update all four (that fallback path belongs to a different, riskier
strategy described only as a fallback in the migration plan, not the Phase
1 goal).

---

## 6. UI Behavior Requirements

- **Existing email/password login**: unchanged in appearance and function
  for the entire duration of Phase 1. The current form, `loginTeacher()`,
  and its error message ("Wrong teacher email or password.") stay exactly
  as-is.
- **Google account linking**: a distinct, clearly-labeled action (e.g.
  "Link Google Account for faster sign-in") visible only to an
  already-authenticated teacher (gate it behind `requireTeacher()`, same
  pattern as other teacher-only actions). Should show a clear success
  message on completion and a clear, specific error message for
  `credential-already-in-use` and `provider-already-linked` (see §3.4–3.5)
  rather than a generic failure message — the teacher needs to know
  *which* of these happened to decide the next step.
- **Google Sign-In after linking**: a "Sign in with Google" button on the
  teacher login screen, alongside (not replacing) the existing
  email/password form during Phase 1. Both paths lead to the same
  `screen = "teacher"` state via the existing `onAuthStateChanged` handler
  — no new post-login UI state is needed since the handler already only
  checks `user?.uid === TEACHER_UID` regardless of provider.
- **Sign-out**: unchanged. The existing `logout()` function
  ([index.html:1314](index.html#L1314)) calls `signOut(auth)` regardless of
  which provider was used to sign in — no provider-specific sign-out logic
  is needed.
- **Browser-session persistence**: unchanged behavior, applied identically
  to both sign-in paths. `setPersistence(auth, browserSessionPersistence)`
  must be called before *both* `signInWithPopup` (new) and the existing
  `signInWithEmailAndPassword` call — same requirement as today, just
  duplicated for the new entry point rather than modified.
- **`auth/account-exists-with-different-credential` errors**: this error
  can occur if a Google sign-in (not linking) is attempted with an email
  address that's already associated with the existing email/password
  account, without going through the linking flow first. Handle explicitly:
  catch this error code and show a message directing the teacher to sign in
  with email/password first and use "Link Google Account," rather than a
  generic "sign-in failed" message. This is a distinct, expected error case
  — it should never be silently swallowed or shown as an unrecognized
  error.

---

## 7. Should Email/Password Remain Available Temporarily?

**Yes.** Keep email/password enabled and the existing form functional
through an overlap/observation period after Google Sign-In ships, per the
migration plan's Phase A step 6. This is the rollback path (§10) — if Google
Sign-In misbehaves in real classroom use, the teacher needs an
already-working fallback that requires no redeploy. Only disable the
Email/Password provider in the Firebase Console (and only then consider
removing the form from `index.html`) after Google Sign-In has been used
successfully for a real stretch of classroom use, as a **separate, later,
smallest-possible-change** removal — not part of this Phase 1 checklist.

---

## 8. Test Cases

All tests should be run against a staging build (or the local emulator)
before any production deploy. None of these require code beyond what's
listed in §4.

### Manual / functional
1. **Existing teacher data still loading**: sign in with email/password
   (unchanged path), confirm the teacher dashboard loads
   `morganBank/classroomData` exactly as before — roster, balances,
   transaction history all present and unchanged.
2. **Student login unchanged**: run through `loginStudent()` with a known
   test student ID + PIN, confirm success, lockout-after-5-attempts, and
   `studentAuthLogs` entries are unaffected by any of this work.
3. **Google sign-in after linking**: complete the linking flow (§3), sign
   out, then sign back in using only the "Sign in with Google" button.
   Confirm `auth.currentUser.uid` equals the original `TEACHER_UID` and the
   teacher dashboard loads identically to the email/password path.
4. **Browser restart behavior**: after signing in with Google, fully quit
   the browser (not just close the tab) and relaunch. Confirm the teacher
   is signed out and must sign in again — this validates that
   `browserSessionPersistence` applies identically regardless of which
   provider was used to sign in.
5. **Refresh / new-tab behavior within the same session**: after signing in
   with Google, refresh the page and open a second tab to the app. Confirm
   the teacher remains signed in in both cases (session persistence,
   unchanged requirement from the prior persistence work).
6. **Wrong Google account**: attempt "Sign in with Google" using a Google
   account that is *not* the one linked in §3. Confirm the app does **not**
   grant teacher access (since `auth.currentUser.uid` will not equal
   `TEACHER_UID`) and instead reaches the same "not a recognized teacher"
   path the code already has for any non-teacher UID.
7. **Duplicate Firebase user prevention**: attempt to sign in with Google
   directly (not via linking) using the *same* Google account already
   linked — confirm this succeeds and resolves to the *same* existing user
   (no second user created). Separately, attempt to link an already-linked
   Google account a second time and confirm `provider-already-linked` is
   handled gracefully (§3.5, §6) rather than erroring destructively.
8. **`account-exists-with-different-credential` case**: attempt a direct
   Google sign-in (bypassing linking) with an email that matches the
   existing email/password account's email address, before linking has
   occurred. Confirm the specific error handling from §6 triggers instead
   of a generic failure.
9. **Rollback path still works**: at every stage above, confirm the
   existing email/password form still successfully signs in as the same
   teacher — this must remain true throughout Phase 1 (§7).

### Automated (where applicable)
10. Existing `functions` test suite (`npm --prefix functions test`) should
    continue to pass unmodified — none of these files change in Phase 1, so
    this is a regression check, not new test-writing.
11. If any new pure-logic helper is introduced client-side (e.g. a small
    function mapping auth error codes to user-facing messages), consider
    unit-testing it the same way `resetStudentPin.test.js` tests
    `resetStudentPin.js` — but this is optional scope, not required to ship
    Phase 1.

---

## 9. Safe Deployment Order

1. Complete all Manual Firebase Console Actions (§1) in the production
   Firebase project — enabling a provider is non-destructive and reversible
   (can be disabled again with no data impact), so this can be done first
   without risk to production data.
2. Implement the code changes from §4 locally; run `npm run build`,
   `npm run lint`, `npm --prefix functions run lint`, and
   `npm --prefix functions test` — all must pass before proceeding, per this
   repo's established verification pattern.
3. Test the full flow against the **Firebase Auth Emulator** or a
   **non-production Firebase project** first, if available, to rehearse
   linking without touching the real teacher UID. If only production is
   available, proceed carefully with the real account, since linking is
   additive and the existing email/password sign-in remains a safe fallback
   throughout.
4. Perform the one-time account-linking step (§3) using the real
   production teacher account, with the teacher present or informed.
5. Run through the full test case list in §8 against production, using the
   actual teacher account and a real (or dedicated test) student account.
6. Deploy the `index.html` changes to Firebase Hosting only — no
   `firestore.rules` or Functions deploy is needed for Phase 1 (§4 confirms
   no changes to those layers).
7. Keep Email/Password enabled in the Firebase Console after deployment
   (§7) — do not disable it as part of this deployment.
8. Monitor real classroom use for a period before considering removal of
   the email/password form or provider — that removal is explicitly
   deferred, not part of this deployment.

---

## 10. Rollback Procedure

Because Phase 1 makes no changes to `firestore.rules`, Cloud Functions, or
any stored data, rollback is low-risk:

1. **If Google Sign-In misbehaves after deployment**: the existing
   email/password form remains fully functional (per §7) — the teacher can
   continue signing in exactly as before with no immediate action needed.
2. **If a code rollback is needed**: revert the `index.html` deployment to
   the prior Hosting release (Firebase Hosting supports rolling back to a
   previous release from the Console or CLI) — this removes the Google
   Sign-In UI entirely and restores the pre-Phase-1 experience. No data
   migration or rules rollback is needed since none were changed.
3. **If account linking itself needs to be undone**: in **Authentication →
   Users**, the linked Google provider can be unlinked from the existing
   user record via the Console (or `unlink(user, 'google.com')` client-side)
   without deleting the user or affecting the UID, email/password sign-in,
   or any Firestore data.
4. **At no point** does rollback require touching `firestore.rules`,
   redeploying Cloud Functions, or modifying any student data — this is a
   direct consequence of Phase 1's scope being deliberately limited to the
   client-side sign-in method.

---

## 11. Final Go/No-Go Checklist Before Deployment

All items must be true before deploying to production:

- [ ] Google provider enabled in Firebase Console (§1), Email/Password
      still enabled.
- [ ] Existing teacher UID confirmed and recorded (§2).
- [ ] Account linking completed successfully; `auth.currentUser.uid` after
      linking confirmed identical to the pre-linking UID (§3, §8 test 3).
- [ ] `npm run build` passes.
- [ ] `npm run lint` passes.
- [ ] `npm --prefix functions run lint` passes (sanity check — no functions
      files should have changed, but confirms nothing was accidentally
      touched).
- [ ] `npm --prefix functions test` passes (same reasoning).
- [ ] All test cases in §8 pass, including the wrong-Google-account and
      account-exists-with-different-credential error handling.
- [ ] Browser-restart test (§8 test 4) confirms session-only persistence
      still holds for the Google Sign-In path specifically, not just
      email/password.
- [ ] No changes present in `firestore.rules`, `functions/resetStudentPin.js`,
      `functions/index.js`, `functions/studentCredentialVerifier.js`, or
      `functions/syncStudentProfiles.js` (`git diff` reviewed and confirmed
      limited to `index.html` and, if added, `src/firebase/firebase.js` for
      new imports only if needed).
- [ ] None of the four UID locations in §5 have been edited.
- [ ] Email/password sign-in re-confirmed working immediately before
      deployment, as the rollback path.
- [ ] Rollback procedure (§10) reviewed and understood by whoever is
      deploying.

---

## Recommendation: Should Phase 1 Ship as v1.1.0?

**Yes.** This is a scoped, additive, low-risk change relative to v1.0.0:

- No Firestore rules, Cloud Functions, or data-model changes — the entire
  change surface is a client-side sign-in method addition plus one
  one-time, manual account-linking action.
- Student authentication is completely unaffected, which is the highest-
  stakes part of the existing system and is explicitly out of scope here.
- Rollback is cheap (a Hosting release rollback, or simply continuing to
  use the still-functional email/password form) and does not require
  touching production data or security rules.
- It fits the project's existing versioning language in `VERSION.md`
  ("Future development should be driven by real classroom experience" /
  "Only implement features when classroom use demonstrates they are
  valuable") as a minor, additive release rather than a rework — a **minor**
  version bump (1.0.0 → 1.1.0) accurately signals "additive, backward
  compatible" rather than a major/breaking change, since email/password
  keeps working throughout and no existing behavior is removed as part of
  this release.
- Recommend explicitly deferring the *removal* of email/password (§7) to
  a later patch/minor release of its own, only after real classroom use
  confirms Google Sign-In is reliable — that removal, not this addition,
  is the point where "unused code path" cleanup becomes appropriate.

---

*This document is planning output only. No source files were modified to
produce it. Per IDEAS.md's stated philosophy, nothing here should be
implemented until explicitly requested.*
