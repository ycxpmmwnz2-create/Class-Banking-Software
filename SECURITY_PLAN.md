# Morgan Bank Security Plan

## Current Security Status
- Teacher login uses Firebase Authentication.
- Teacher access is tied to Andrew's Firebase UID.
- Firestore classroom document is restricted to the teacher UID.
- Teacher-only browser functions are guarded with `requireTeacher()`.
- Student PIN login uses a callable Cloud Function, bcrypt hashes, temporary
  lockout, and server-side authentication logs.
- Only the test student is provisioned; the real roster is not migrated yet.

## Remaining Risk
Real student credentials still need to be provisioned and linked to
student-specific profile data before Chromebook use. Student transaction writes
also need a server-controlled path.

## Target Student Login Architecture
Student enters login ID + PIN.
Cloud Function verifies the PIN server-side.
Cloud Function returns a Firebase custom token.
Student signs in with Firebase Auth.
Firestore rules allow access only to that student's data.

## Production Student Credential Schema
Credentials are stored at:

`studentCredentials/{normalizedLoginId}`

Login IDs are trimmed and lowercased before lookup. Credential documents are
server-only and contain:

- `schemaVersion`: Number identifying the credential schema version.
- `authUid`: Stable Firebase Authentication UID for the student.
- `classroomId`: Classroom identifier used in custom claims.
- `studentId`: Student identifier used in custom claims and profile paths.
- `pinHash`: bcrypt hash. Plaintext PINs are never stored.
- `active`: Whether the credential may authenticate.
- `failedAttempts`: Current consecutive failed-login count.
- `lockedUntil`: Firestore timestamp for temporary lockout, or `null`.
- `createdAt`: Firestore timestamp for credential creation.
- `updatedAt`: Firestore timestamp for the latest credential change.
- `pinUpdatedAt`: Firestore timestamp for the latest PIN change.

Credential documents must not contain student names, balances, transactions, or
plaintext PINs. Browser clients must not receive direct access to this
collection.

## Remembered Student Login Locator

After a successful V2 student login, a browser may remember one project-scoped
record holding exactly the classroom code and the canonical student login ID, so a
returning student normally types only a PIN.

This locator is **not** an authentication credential. It contains no PIN, no PIN
hash, no custom or ID token, no Auth UID, and no student, credential, balance, or
transaction data, and it grants no access on its own: the server still receives
the classroom code, login ID, and PIN and still verifies the PIN with bcrypt
before returning a custom token. Student Firebase Auth persistence remains
session-only, so remembering the locator never keeps a student signed in.

Residual risk: on a shared or unattended browser the locator narrows an attacker
to guessing a 4-digit PIN against a login ID that is now visible on the sign-in
screen. The existing server-side bcrypt verification, consecutive-failure
counter, and temporary lockout are the mitigations. "Use a different student"
clears the locator and is student-operable.

## Required Future Work
- Provision production credentials when the real roster is available.
- Split and migrate real student data into safer Firestore collections.
- Route student money requests through Cloud Functions.
- Add App Check before real student rollout.
- Test rules before Chromebook use.

## Version 2.0 Items
- Multi-teacher support.
- Multiple classrooms.
- Co-teachers.
- Grade-level PBIS tools.
