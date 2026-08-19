# Morgan Bank Security Plan

## Current Security Status
- Teacher login uses Firebase Authentication.
- Teacher access is tied to Andrew's Firebase UID.
- Firestore classroom document is restricted to the teacher UID.
- Teacher-only browser functions are guarded with `requireTeacher()`.
- Student PIN login uses a callable Cloud Function, bcrypt hashes, bounded
  identifier/source/global throttles, and server-side authentication logs.
- Student Add and Subtract submissions use a server-authoritative callable;
  direct student writes to student and transaction documents remain denied.
- Only the test student is provisioned; the real roster is not migrated yet.

## Remaining Risk
Real student credentials still need to be provisioned and linked to
student-specific profile data before Chromebook use.

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
- `pinHash`: bcrypt hash. The credential document never contains a plaintext PIN.
  Authentication always verifies against this hash. A separate teacher-visible
  copy exists outside this document; see "Teacher-Visible Student PINs".
- `active`: Whether the credential may authenticate.
- `failedAttempts`: Bounded consecutive-failure telemetry. It never blocks a
  victim's correct PIN.
- `lockedUntil`: Retained compatibility field. Active verification clears it
  to `null`; attacker-controlled failures cannot create a victim lockout.
- `createdAt`: Firestore timestamp for credential creation.
- `updatedAt`: Firestore timestamp for the latest credential change.
- `pinUpdatedAt`: Credential version for the latest PIN change. Migrated
  Firestore Timestamps are normalized to epoch milliseconds when claims are
  minted; active V2 resets store a strictly increasing epoch-millisecond value.
  Final rules and student callables accept those two equivalent stored forms so
  a reset invalidates the prior session without stranding a migrated account.

Credential documents must not contain student names, balances, transactions, or
plaintext PINs. Browser clients must not receive direct access to this
collection.

## Teacher-Visible Student PINs

Andrew decided that a teacher must be able to look up a student's current PIN
rather than reset it blind, and accepted that this requires the PIN to be
recoverable. This is a deliberate, documented departure from the original
bcrypt-only design, made for a classroom platform where PINs are four digits and
guard play-money balances rather than anything of value.

Current PINs are stored at:

`classrooms/{classroomId}/studentPins/{studentId}`

containing exactly `studentId`, `pin`, and `updatedAt`.

Controls:

- **Separate from the credential.** The credential document keeps its exact
  reviewed key set and its bcrypt hash. Authentication never consults this
  directory; `studentPinLoginV2` still verifies `pinHash`.
- **Server-only under the Phase 3 rulesets.** The path matches no rule in
  `firestore.phase3.final.rules`, `.bridge.rules`, or `.rollback.rules`, so
  Firestore's default deny makes it unreachable from every client identity there
  — including the owning teacher. The final-rules artifact is now repinned for
  the separate session-version check, while this directory remains absent from
  the ruleset. The final-rules test asserts that denial directly.

  **This is conditional, and the condition matters.** The legacy production
  ruleset `firestore.rules` has a recursive `match /classrooms/{document=**}`
  granting the one hard-coded teacher UID read and write beneath `/classrooms`,
  which reaches this directory. Verified in the emulator: that identity can read
  a PIN and overwrite one, and overwriting would make a displayed PIN disagree
  with the bcrypt hash that authenticates. No other identity — student, other
  authenticated user, or anonymous — reaches it under any ruleset.

  Adding `allow read, write: if false` does **not** fix this: Firestore rules are
  a permissive union, so any matching allow wins and a narrower deny is ignored.
  Closing it properly requires narrowing the recursive legacy rule, which is a
  change to the live V1 ruleset and has not been made.

  The operative control is release ordering — decision 8 of
  `PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md` requires final rules to deploy
  before the V2 server gate, and V2 is gated off until then, so no document can
  exist in this collection while the legacy ruleset is live. One standing
  hazard remains: never run a V2 Function that writes here while
  `firestore.rules` is active. The default deployment target in `firebase.json`
  is now `firestore.phase3.final.rules`, and the release-order contract pins that
  target so a routine rules deploy cannot select the recursive legacy baseline.
  `tests/firestore/rules.baseline.test.js` retains the legacy exposure as
  historical evidence so narrowing that artifact later fails loudly.
- **Read only through `listStudentPinsV2`,** which resolves the classroom from
  the caller's authenticated identity. The request must be empty, so no
  parameter can point at another teacher's classroom.
- **Displayed only on the teacher Credentials page.** The V2 roster, student
  profile, student-facing screens, and printed output do not render the PIN
  directory. The Credentials page places the PIN beside the already-visible
  login ID and account status.
- **Written only inside the same transaction** as the bcrypt hash it mirrors, by
  `createStudentV2` and `resetStudentPinV2`, so the displayed PIN and the hash
  that authenticates cannot disagree. Deleted when a student is removed.
- **Never persisted client-side.** The browser holds fetched PINs in memory only,
  stamped with the tenant they were fetched for. They never enter the aggregate
  data object, tenant cache, localStorage, backup export, or any write payload,
  all of which remain PIN-free by contract.

Residual risk, accepted: anyone who obtains the Firestore data obtains every
student's current PIN rather than useless hashes, and children reuse PINs
elsewhere. Students created before this directory existed show no PIN until
their next reset, because bcrypt hashes cannot be reversed.

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
screen. Server-side bcrypt verification plus bounded per-identifier,
per-source, and global rolling-window throttles limit compute, writes, and
logging without letting an attacker lock out a known student. "Use a different
student" clears the locator and is student-operable.

## Student-Visible Class Rent

The teacher dashboard may publish one classroom-wide, whole-dollar rent amount
from `$0` through `$1,000,000`. Missing data displays as `$0`. This is a display
setting only: saving rent does not change a balance, create a transaction, or
charge any student.

The value is stored at:

`classrooms/{classroomId}/studentDisplay/rent`

with exactly `rentAmount` and `updatedAt`. Rent is deliberately kept out of the
classroom root so students never gain read access to teacher-only settings. The
owning active teacher may get and create/update only the exact `rent` document.
An authenticated student may get that one document only when the classroom in
their server-minted claim has an active reciprocal teacher/classroom
foundation. Students, foreign teachers, and anonymous users cannot write it;
no client may list or delete the `studentDisplay` collection.

The student dashboard renders the amount as read-only text with no input or
button. It is loaded with the student's exact self document and remains
memory-only. A later teacher change becomes visible the next time the student
signs in or reloads; this first version does not install a real-time listener.

## Student Money Submission Path

`submitStudentTransactionV2` accepts exactly `transactionId`, `type`, `amount`,
and `reason`; `amount` must be a positive safe integer number of whole dollars.
It derives the classroom and student exclusively from the signed
student's server-minted Auth claims, validates the active reciprocal classroom
foundation, student document, classroom request settings, frozen state, allowed
reason, and available balance, and then commits the classroom ledger record and
student mirror atomically.

Add Money submissions are stored as `Pending` without changing the approved
balance. Subtract Money submissions are stored as `Approved` and decrement the
balance in the same transaction. An exact retry returns the already-stored
result; a reused transaction ID with different data fails closed. The browser
updates its displayed state and reports success only after validating the
callable response. Firestore rules still deny every direct student transaction
or student-document write. Teacher aggregate saves transactionally compare each
student record they would overwrite with the last server-confirmed teacher
baseline, so a submission from another session cannot be silently replaced by a
stale teacher save. A conflict writes nothing, reloads the classroom, and asks
the teacher to retry. Callable ISO timestamps are formatted locally for display
without changing their stored canonical value. New student submissions stop at
a fixed 1,000-entry mirror boundary and are limited to 10 successful submissions
per student in a rolling five-minute window. The bounded throttle record uses a
one-way digest in the existing server-only throttle collection and is updated
atomically with the ledger and mirror. Its preimage hashes the classroom ID and
contains no NUL byte, while every login-throttle preimage contains a mandatory
NUL separator; malformed unauthenticated login inputs therefore cannot target a
student's money bucket. Exact retries do not consume another throttle slot and
remain available at both limits.

`studentRequestsEnabled` is intentionally the master Add/Subtract switch in both
the legacy and V2 presentation paths. This explicitly accepts the legacy
gate-off behavior change identified during detailed review: a disabled master
switch hides and blocks both forms even if a per-type switch remains enabled.

Known rollout limitation: the student loader still receives page-default
categories rather than the resolved classroom's customized categories. V2
student money must remain disabled for any classroom using customized Add or
Subtract categories until that settings propagation receives its own reviewed
correction. The current mismatch fails closed; it is not an authorization
bypass.

## Required Future Work
- Provision production credentials when the real roster is available.
- Split and migrate real student data into safer Firestore collections.
- Add App Check before real student rollout.
- Test rules before Chromebook use.

## Version 2.0 Items
- Multi-teacher support.
- Multiple classrooms.
- Co-teachers.
- Grade-level PBIS tools.
