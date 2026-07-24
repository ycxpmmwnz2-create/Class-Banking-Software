# Firestore Rules Baseline Tests (Phase 0)

Phase 0 of `MULTI_TEACHER_ARCHITECTURE_PLAN.md`. This directory contains an
automated Firestore Rules Unit Testing suite that runs against the
**current, unmodified** production `firestore.rules` via the Firebase
Firestore Emulator. It exists to pin down today's v1.1 authorization
behavior with repeatable tests *before* any multi-teacher rules changes are
made in a later phase, so that phase's rules diff can be checked against a
known-good baseline instead of relying on manual inspection.

No rules, application code, Cloud Functions, or Firestore data model changes
are made by this suite — it only adds test coverage for the existing
`isTeacher()` / `isStudent()` rules exactly as deployed.

## Running

From the **repository root** (this suite uses the root dependency tree —
there is no separate `package.json` under `tests/`):

```sh
npm install
npm run test:rules
```

`npm run test:rules` starts the Firestore emulator (via `firebase
emulators:exec`, using the root `firebase.json`'s `emulators.firestore`
config) and runs everything under `tests/firestore` with Node's built-in
test runner inside it, then shuts the emulator down. Requires the
`firebase-tools` CLI to be available (used globally elsewhere in this
repo's `functions/serve` script) and a Java runtime on `PATH` (a
requirement of the Firestore emulator itself, not of this test code).

`npm run test:all` runs the Cloud Functions test suite followed by this
rules suite.

## Coverage

- **Teacher** (`TEACHER_UID` hardcoded in the current rules): can read/write
  `morganBank/classroomData`, can read/write the classroom student mirror,
  can read `studentAuthLogs`.
- **Unauthorized authenticated user**: denied on all of the above, and
  denied on `studentCredentials`.
- **Student** (custom-token claims `role`/`classroomId`/`studentId`): can
  read only their own `classrooms/{classroomId}/students/{studentId}`
  document; denied on another student's document, another classroom's
  same-numbered document, writes to their own profile, teacher-only
  classroom data, `studentAuthLogs`, and `studentCredentials`.
- **Unauthenticated user**: denied everywhere.
