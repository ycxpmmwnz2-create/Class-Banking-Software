# Multi-Teacher Architecture Plan (Version 2.0)

Status: **Planning only. No source files, Firestore rules, Cloud Functions, or
Firebase configuration have been changed to produce this document.** This is
a read-only architectural analysis and design proposal, written on
`feature/multi-teacher`, while `v1.1.0` remains deployed to production
unchanged.

This document builds directly on `GOOGLE_AUTH_MIGRATION_PLAN.md` (Phase B),
`SECURITY_PLAN.md` ("Version 2.0 Items"), and `GOOGLE_AUTH_PHASE1_CHECKLIST.md`
(which shipped as v1.1.0). It does not repeat their reasoning where it still
holds; it extends it into a concrete, phased implementation plan.

---

## Part 1 — Current Architecture Analysis

### Structural note

The deployed application is **not** the React/Vite scaffold implied by
`package.json`. `src/App.jsx` and `src/main.jsx` are empty/unused. The entire
live app — UI, state, routing, auth, and every Firestore read/write — is one
3,013-line inline `<script type="module">` block inside **`index.html`**,
using hand-rolled global state and `innerHTML` rendering (no React, no
router). Server-side logic lives in `functions/`. This matters a great deal
for the migration: there is no component tree, no context/provider pattern,
and no URL-based routing to extend — multi-teacher session isolation must be
built from a single-global-`let`-variables model, not refactored from an
existing per-tenant abstraction.

### 1. Current Firestore collections

| Collection / path | Nature |
|---|---|
| `morganBank/classroomData` | Single fixed top-level document. The **entire class**: roster, every transaction ever, login history, settings. |
| `classrooms/morgan/students/{studentId}` | Per-student read-only mirror, written by a Cloud Function trigger. `morgan` is a hardcoded literal, not a variable classroom ID. |
| `studentCredentials/{loginId}` | Flat, top-level, server-only (no client rule at all — default deny). PIN hashes, lockout state, `classroomId` + `studentId` fields. |
| `studentAuthLogs/{logId}` | Flat, top-level, global. Every PIN login attempt, across the whole app, with no classroom scoping in the security rule. |

No `teachers` collection exists anywhere. No document represents "a teacher"
as data — the teacher is authorized purely by a literal UID string compared
in code.

### 2. Current document hierarchy

```
morganBank/classroomData                     (singleton — the whole class)
  { students: [...], transactions: [...], loginHistory: [...], settings: {...} }

classrooms/morgan/students/{studentId}       (mirror; "morgan" hardcoded)
  { id, name, balance, frozen, transactions: [...] }

studentCredentials/{loginId}                 (flat; classroomId field always "morgan")
studentAuthLogs/{logId}                      (flat; not classroom-scoped)
```

The only "foreign key" fields anywhere are `classroomId` (always the literal
`"morgan"`) and `studentId`, on `studentCredentials` and `studentAuthLogs`.
No document, anywhere, has a `teacherId` or `ownerUid` field.

### 3. Authentication flow

**Teacher (as of v1.1.0):** Google Sign-In (`signInWithPopup`) or legacy
email/password, both resolving to one Firebase Auth user via account linking
(`linkWithPopup`), so `auth.currentUser.uid` is stable. Teacher identity is
decided by exactly one check, in `onAuthStateChanged` (`index.html:2910`):

```js
const isAuthenticatedTeacher = user?.uid === TEACHER_UID;
```

`TEACHER_UID` (`index.html:758`) is a literal string, duplicated verbatim in:
- `index.html:758`
- `firestore.rules` (`isTeacher()`)
- `functions/resetStudentPin.js`

`requireTeacher()` (`index.html:822-828`) gates ~30+ teacher-only actions by
re-checking the same module-level `isTeacher` boolean and UID equality.
Session persistence is `browserSessionPersistence` (sign-out on full browser
close), provider-agnostic, unaffected by this migration.

**Student:** Student ID + PIN → `studentPinLogin` callable Cloud Function →
`studentCredentialVerifier.js` verifies bcrypt hash server-side, enforces a
5-attempt/5-minute lockout, logs every attempt to `studentAuthLogs`, and on
success mints a Firebase custom token with claims
`{ role: "student", classroomId, studentId }`. Client calls
`signInWithCustomToken`, then `onAuthStateChanged`'s student branch
(`index.html:2925-2960`) reads back the claims and does:

```js
const isSecureStudent = role === "student"
  && classroomId === "morgan"          // <-- hardcoded literal, client-side gate
  && typeof studentId === "string";
```

Key fact carried forward from `GOOGLE_AUTH_MIGRATION_PLAN.md`: **the claims
mechanism is already classroom-aware** (`classroomId` is server-minted into
the token today), and the subsequent Firestore read
(`doc(db, "classrooms", classroomId, "students", studentId)`) is already
parameterized by that claim. Only the *client-side equality check* against
the literal `"morgan"` is hardcoded. This is the smallest possible surface
that needs to change on the student side.

### 4. Firestore security rules (current, in full)

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    function isTeacher() {
      return request.auth != null
        && request.auth.uid == "YkYUzIzy0aW7roolM1VaLcIJPuN2";
    }

    function isStudent(classroomId, studentId) {
      return request.auth != null
        && request.auth.token.role == "student"
        && request.auth.token.classroomId == classroomId
        && request.auth.token.studentId == studentId;
    }

    match /morganBank/{document=**} {
      allow read, write: if isTeacher();
    }

    match /classrooms/{document=**} {
      allow read, write: if isTeacher();
    }

    match /studentAuthLogs/{logId} {
      allow read: if isTeacher();
    }

    match /classrooms/{classroomId}/students/{studentId} {
      allow read: if isStudent(classroomId, studentId);
    }
  }
}
```

`studentCredentials` has no rule at all (default deny — server/Admin-SDK-only
by design, and this should **not** change). `firestore.indexes.json` is
empty.

**Rules-layer risk carried forward:** `match /classrooms/{document=**}` grants
*any* authenticated teacher read/write over *all* classrooms' subtrees today
— there is no per-classroom scoping in the rule itself, only the fact that
exactly one classroom (`morgan`) exists. If a second teacher UID were simply
added to `isTeacher()` without further changes, that teacher would gain full
read/write over the first teacher's entire classroom. **This must not
happen** — see Part 2, Ownership Model.

### 5. Cloud Functions (`functions/index.js`)

- **`studentPinLogin`** (`onCall`) — verifies PIN, logs attempt, mints custom
  token with `classroomId`/`studentId` claims. No teacher-UID dependency.
- **`resetStudentPin`** (`onCall`) — guarded by `requireTeacher(auth)`
  checking `auth.uid !== TEACHER_UID` (hardcoded literal in
  `functions/resetStudentPin.js`). Queries `studentCredentials` by
  `classroomId` + `studentId`.
- **`syncStudentProfiles`** — Firestore trigger bound to the single path
  `morganBank/classroomData`. Hardcodes `'morgan'` as the classroom filter in
  three places (`.where('classroomId', '==', 'morgan')`, `.doc('morgan')`,
  and the literal on new credential docs). This function is the other half
  of the "one classroom" assumption — even if the top-level document were
  re-keyed, this trigger would still only ever look at `morgan` unless
  changed.

### 6. Every place the app assumes exactly one teacher / one classroom

| Assumption | Location |
|---|---|
| `TEACHER_UID` literal, sole authorization check | `index.html:758`, `firestore.rules`, `functions/resetStudentPin.js` (3 independent copies) |
| `classroomId === "morgan"` client-side gate | `index.html:930` (approx., in `onAuthStateChanged` student branch) |
| `"morgan"` hardcoded as a Firestore path segment | `index.html:1120` (`viewStudentProfile`), and 3 `resetStudentPin({ classroomId: "morgan", ... })` call sites |
| Single global document, no classroom key in path | `morganBank/classroomData` — read in `loadData()` (`index.html:868`), written in `saveData()` (`index.html:889`) |
| Global mutable module-level state (`data`, `isTeacher`, `screen`, etc.) | `index.html:807-820` — one in-memory session for the whole running app; no per-teacher/session isolation concept exists at all |
| Single fixed `localStorage` key | `STORAGE_KEY = "mrMorganClassCashDataV5"` (`index.html:757`) — would collide across teachers on a shared device |
| `syncStudentProfiles` hardcodes `'morgan'` | `functions/syncStudentProfiles.js` (3 places) |
| Admin scripts hardcode `'morgan'` / single project | `functions/scripts/checkData.js`, `checkStudent.js`, `seedTestStudent.js` |
| No routing layer to scope by teacher/classroom | Entire app — `screen` is a plain string switch, no URL segments, no router of any kind |

### 7. Hard-coded teacher UID / classroom references (exhaustive)

**Teacher UID `YkYUzIzy0aW7roolM1VaLcIJPuN2`**: `index.html:758`,
`firestore.rules:7`, `functions/resetStudentPin.js:5` (+ its test fixture).

**Classroom ID `"morgan"`**: `index.html:1120,1164,1758,1800,2930` (approx
line numbers per agent scan); `functions/syncStudentProfiles.js:31,67,126`;
`functions/scripts/seedTestStudent.js:5`; test fixtures in
`functions/resetStudentPin.test.js` and
`functions/studentCredentialVerifier.test.js`.

**Singleton document path** `morganBank/classroomData`:
`index.html:868,889`; `functions/syncStudentProfiles.js:6` (trigger is bound
to this exact path — the trigger itself must be redesigned, not just its
body); `functions/scripts/checkData.js`, `seedTestStudent.js`.

### 8. Student login assumptions

Student PIN login (`studentPinLogin` → `studentCredentialVerifier.js`) is
**already classroom-parameterized at the server/claims layer** — this is the
one part of the system built with multi-classroom in mind from the start.
The only assumption that breaks under multi-teacher is the **client-side**
literal comparison `classroomId === "morgan"` in `onAuthStateChanged`. The
downstream Firestore read is already keyed off the claim, not a literal.
`studentCredentials` and `studentAuthLogs`, however, are flat collections
with a `classroomId` *field* but no structural (path-based) scoping — the
security rule for `studentAuthLogs` grants read to *any* `isTeacher()`,
meaning under a naive multi-teacher `isTeacher()` expansion, one teacher
could read another's students' login attempt logs. This was already flagged
as a hard blocker in `GOOGLE_AUTH_MIGRATION_PLAN.md` §6 and remains the
single most important rules-layer fix for V2.

### 9. Teacher settings assumptions

Settings are not a separate document — `data.settings` is a nested object
inside the one `morganBank/classroomData` document, defined by
`defaultSettings` (`index.html:759-797`) and merged in `normalizeData()`.
Every settings write (`saveSettings()`, `saveSettingsLists()`) rewrites the
*entire* classroom document via the same global `saveData()`. There is
structurally no way for a second teacher to have independent settings today
— any second teacher who could write to this path would overwrite the first
teacher's settings (and roster, and transactions — it's the same document).

### 10. Transaction ownership assumptions

Transactions are plain objects appended to `data.transactions`, an array
inside the single global document. No transaction object carries a
`classroomId` or `teacherId` field — ownership today is purely *structural*
(one document = one implicit classroom), not a property of the transaction
record itself. This means re-keying the parent document is sufficient for
transaction ownership (no per-transaction field migration needed), **but** it
also means any future feature that queries transactions across classrooms,
or that flattens transactions into their own collection, will need to add an
explicit ownership field at that time — don't assume today's array-embedding
approach scales past a second or third teacher's data volume.

### 11. Collections/documents requiring migration

| Item | Migration need |
|---|---|
| `morganBank/classroomData` | Re-key to a classroom-scoped path. Must preserve all students, balances, transactions, login history, settings — zero data loss. |
| `classrooms/morgan/students/*` | Mirror is regenerated by the sync trigger; no manual migration needed once the trigger is updated and the parent doc is rewritten, but must be verified post-migration, not assumed. |
| `studentCredentials/*` | `classroomId` field already exists and is correct (`"morgan"`) — no rewrite needed if the classroom ID for the existing class is preserved as `"morgan"` (recommended, see Part 2). Rule/query scoping must change even though the data doesn't. |
| `studentAuthLogs/*` | Same as above — data is fine if `classroomId` is preserved; the **security rule** is what must change to scope reads. |
| `firestore.rules` | Full rewrite of `isTeacher()` and the `classrooms` match block (see Part 2). |
| `functions/syncStudentProfiles.js` | Must derive `classroomId` from the triggering document's path/ID instead of hardcoding `'morgan'`, and the trigger binding itself must move from a single fixed path to a collection-group or wildcard trigger. |
| `functions/resetStudentPin.js` | `requireTeacher()` must become an ownership check (does this teacher own this classroom?), not a single-UID equality check. |

---

## Part 2 — Proposed Version 2 Architecture

### Scope for this revision

This revision **simplifies** the Version 2 design per explicit direction
after reviewing the initial draft. The governing principles are now:

1. A teacher **owns** a classroom (singular).
2. A classroom contains students, transactions, settings, and login history.
3. `teachers` and `classrooms` are separate top-level collections.
4. **Co-teachers, districts, and multiple classrooms per teacher are
   explicitly out of scope** and must not be implemented now.
5. The data model must still support adding those things *later* without a
   Firestore redesign — i.e., without re-keying existing collections,
   changing document IDs, or moving data between paths. Widening a field's
   *cardinality* later (single value → array/subcollection) is acceptable
   forward-growth; changing a document's *identity* or *path* later is not,
   and is exactly what this revision avoids.

This replaces the previous draft's `classroomIds: [...]` array and
co-teaching-flavored language — that was premature scope for a feature this
plan explicitly excludes. The model below is deliberately smaller.

### Design principle

**Preserve the existing classroom's data and identity exactly as-is.** Under
the recommended Option B (below), the current class is assigned one
generated `classroomId` during migration — it may reuse the literal
`"morgan"` as that generated value for continuity, or a fresh auto-ID; either
is valid since Option B never derives the ID from a teacher UID. Nothing
about today's student experience, PIN login, or transaction history changes
in shape — only the *ownership* layer is added on top. This directly
satisfies "my existing classroom must migrate safely without losing any
balances, transactions, or history" by making the migration a **re-key +
ownership-tag**, not a data rewrite.

### Classroom ownership: Option A vs. Option B

**Option A — `classroomId = teacherUid`**
```
teachers/{teacherUid}
classrooms/{teacherUid}          // same ID as the owning teacher
```
- Ownership check becomes a string comparison (`classroomId ==
  request.auth.uid`) — no `get()` lookup needed in rules.
- Teacher's classroom path is derivable from their UID alone, client-side,
  with no read required first.
- **Breaks under principle 5.** The instant multiple classrooms per teacher,
  co-teaching, or a district layer is introduced, the 1:1 identity between
  teacher UID and classroom ID no longer holds — some classrooms would need
  an ID that *isn't* a teacher UID (a second classroom for the same teacher,
  or a classroom with two owners), which forces an actual re-key migration
  of every existing classroom document at that point. This is precisely the
  kind of later redesign principle 5 asks to avoid.

**Option B — `classroomId` = generated Firestore document ID**
```
teachers/{teacherUid}   { classroomId: "<generated-id>", ... }
classrooms/{classroomId} { ownerUid: teacherUid, ... }
```
- Requires one extra lookup: given a signed-in teacher, read
  `teachers/{uid}.classroomId` to find their classroom (client-side), and
  rules need a `get()` on the `teachers` doc (or equivalent) to confirm
  ownership rather than a bare string-equality check.
- Classroom identity is independent of teacher identity from day one — a
  classroom is "a thing a teacher points to," not "a thing whose ID *is*
  the teacher." Adding a second classroom per teacher later means widening
  `classroomId` (single field) to `classroomIds` (array/subcollection) —
  an additive schema change to the `teachers` document, with **zero**
  changes to the shape, ID scheme, or path of any existing `classrooms`
  document. Co-teaching later means adding a second `teachers` doc whose
  `classroomId` points at the *same* existing classroom, again with no
  change to `classrooms/*`.

**Recommendation: Option B.**

The extra `get()` lookup in rules (or one extra read on the client) is a
small, constant cost. In exchange, it decouples two identities
(teacher-the-person vs. classroom-the-thing) that principle 5 explicitly
requires stay decoupled — Option A only works today by accident of "each
teacher currently has exactly one classroom," which is precisely the
assumption principle 4/5 says not to bake in twice. Choosing Option A now
would mean Version 2's own data model repeats the same mistake Version 1
made with the single hardcoded `TEACHER_UID` (identity-as-key instead of
identity-with-a-key) — just one level up the stack. Option B costs slightly
more to build today and costs nothing to extend later; Option A costs
slightly less today and requires a full re-migration the day a second
classroom or co-teacher is added. Given principle 5 is explicit, Option B is
the correct trade.

### New Firestore hierarchy (final)

```
teachers/{teacherUid}
  {
    email, displayName, photoURL,
    classroomId: "<generated-id>",      // ONE classroom per teacher (V2 scope) —
                                         // not an array; see note below
    createdAt, lastLoginAt,
    status: "active" | "disabled"
  }

classrooms/{classroomId}
  {
    ownerUid: "{teacherUid}",           // authoritative ownership field
    name, createdAt,
    settings: { ...same shape as today's data.settings... }
  }

classrooms/{classroomId}/students/{studentId}
  { id, name, balance, frozen, transactions: [...] }
  // same shape as today's mirror; now the PRIMARY record, not just a mirror

classrooms/{classroomId}/transactions/{transactionId}
  { studentId, studentName, type, amount, reason, memo, category, status, source, date }
  // promoted out of an embedded array into its own subcollection —
  // see "Why split transactions out" below

classrooms/{classroomId}/loginHistory/{logId}
  { studentId, studentName, date, result, note }

studentCredentials/{loginId}            // UNCHANGED shape and path
  { schemaVersion, authUid, classroomId, studentId, pinHash, active,
    failedAttempts, lockedUntil, createdAt, updatedAt, pinUpdatedAt }

studentAuthLogs/{classroomId}/logs/{logId}   // RE-SCOPED under classroomId
  { loginId, success, reason, timestamp, studentId }
```

`teachers` and `classrooms` are separate top-level collections (principle
3), linked only by the `classroomId` field on `teachers/{uid}` and the
mirrored `ownerUid` field on `classrooms/{classroomId}` — no nesting of one
inside the other. This is what keeps future growth additive: co-teaching
later means a second `teachers` document referencing the same
`classroomId`; multiple classrooms per teacher later means `classroomId`
widening to an array or a `teachers/{uid}/classrooms` subcollection. Neither
change touches the `classrooms` collection's shape, IDs, or paths.

**Why split transactions out of the classroom document:** the current model
embeds every transaction ever, for the whole class's history, in one array
inside one document. That already risks the 1 MiB Firestore document size
limit for a single class over multiple years; multiplying by N teachers
makes per-document growth a real operational risk, not just a
scalability nicety. This is the one deliberate schema change beyond pure
re-keying, and it is additive: `classrooms/{classroomId}` keeps a `settings`
object in the same shape as today, so most client code that reads
`data.settings` is unaffected — only the transaction read/write path changes
from array-in-document to subcollection reads.

**Why `studentAuthLogs` moves under `classroomId`**: this is the fix for the
cross-classroom log-leak risk flagged in `GOOGLE_AUTH_MIGRATION_PLAN.md`.
Nesting under `classroomId` makes the security rule structurally scoped
(`match /studentAuthLogs/{classroomId}/logs/{logId}`) instead of relying on a
field-based `where` filter that a rule can't easily enforce on `list`/`read`
without a `get()` lookup per document.

**Why `studentCredentials` stays flat and unchanged**: it's server-only
(Admin SDK), already has a `classroomId` field, and is queried (not
listed/read by clients) — there's no client-side rule risk here today, and
changing its path would be pure churn for no security benefit. Leave it
alone.

### Teacher profile model

```ts
// conceptual shape, not a literal TS type in this JS codebase
teachers/{teacherUid}: {
  email: string,
  displayName: string,
  photoURL: string | null,
  classroomId: string,        // the ONE classroom this teacher owns (V2 scope)
  createdAt: Timestamp,
  lastLoginAt: Timestamp,
  status: "active" | "disabled"
}
```

Created once, on first successful teacher sign-in, by a Cloud Function
(`onCreateTeacherProfile` or folded into a new `ensureTeacherProfile` callable
invoked right after sign-in) — **never** client-writable directly, to prevent
a signed-in user from self-assigning a `classroomId` they don't own.

A single scalar `classroomId` field (not an array) is deliberate: it's the
simplest shape that satisfies today's requirement (one teacher, one
classroom), and widening a scalar field to an array or subcollection later
is a purely additive schema change, not a redesign — consistent with
principle 5 without speculatively building for co-teaching now.

### Classroom ownership model

- `classrooms/{classroomId}.ownerUid` is the single source of truth for
  ownership.
- Firestore rules replace the literal-UID `isTeacher()` with an ownership
  lookup:

```
function isOwner(classroomId) {
  return request.auth != null
    && get(/databases/$(database)/documents/classrooms/$(classroomId)).data.ownerUid == request.auth.uid;
}

match /classrooms/{classroomId} {
  allow read, write: if isOwner(classroomId);

  match /students/{studentId} {
    allow read, write: if isOwner(classroomId);
    allow read: if isStudent(classroomId, studentId);   // unchanged from today
  }
  match /transactions/{transactionId} {
    allow read, write: if isOwner(classroomId);
  }
  match /loginHistory/{logId} {
    allow read, write: if isOwner(classroomId);
  }
}

match /studentAuthLogs/{classroomId}/logs/{logId} {
  allow read: if isOwner(classroomId);
}
```

This is the structural fix for the risk flagged in Part 1 §4/§8: a second
teacher's `classrooms/{their-id}` grants them nothing on
`classrooms/morgan-generated-id/**`, because `isOwner()` checks the
*specific* classroom document's `ownerUid`, not just "is this any teacher."

- `resetStudentPin` (Cloud Function) changes its guard from
  `auth.uid !== TEACHER_UID` to "does `classrooms/{classroomId}.ownerUid`
  equal `auth.uid`?" — same shape, ownership-based instead of literal.
- `syncStudentProfiles` trigger changes from a fixed single-document path
  binding to a wildcard/collection-group binding
  (`onDocumentWritten('classrooms/{classroomId}/...', ...)` or per-write-path
  derivation) so `classroomId` comes from the triggering document's path, not
  a hardcoded literal — this removes all three hardcoded `'morgan'`
  occurrences in that file at once.

### Authentication flow (V2)

Student PIN login is **unchanged in mechanism** — same callable function,
same bcrypt verification, same lockout logic, same custom-token claims shape.
The only change is on the client: replace the literal
`classroomId === "morgan"` check with "does this classroomId exist and is it
active," since any valid classroom should now be accepted, not just
`"morgan"`.

Teacher login: Google Sign-In / linked email-password stays exactly as
shipped in v1.1.0 (no further auth-provider changes needed). What changes is
*what happens after* a successful sign-in — instead of a hardcoded UID
equality check, `onAuthStateChanged` (or an equivalent) now:
1. Looks up `teachers/{user.uid}`.
2. If it doesn't exist, this is a first-time sign-in → **New Teacher
   Onboarding** (below).
3. If it exists, reads `classroomId` and scopes all subsequent reads/writes
   to `classrooms/{that classroomId}` instead of the fixed
   `morganBank/classroomData` path. There is no picker or multi-classroom
   selection step — V2 scope is exactly one classroom per teacher.

### New teacher onboarding flow

1. Teacher signs in with Google (existing flow, no changes needed there).
2. Client calls a new callable Cloud Function, `ensureTeacherProfile`, which:
   - If `teachers/{uid}` already exists, returns it unchanged (idempotent).
   - If not, creates `teachers/{uid}` with `classroomId: null`, `status:
     "active"`, and prompts the client to show a "Create your classroom"
     step.
3. Client calls a new callable, `createClassroom({ name })`, which:
   - Generates a new `classroomId` (a Firestore auto-generated document ID —
     **not** client-supplied, to avoid collisions/spoofing — this is what
     Option B requires and Option A cannot do, since Option A's ID is fixed
     to the teacher's own UID rather than generated).
   - Writes `classrooms/{classroomId}` with `ownerUid: auth.uid`.
   - Sets `teachers/{uid}.classroomId` to the new ID.
   - Rejects if `teachers/{uid}.classroomId` is already set (enforces "one
     classroom per teacher" for V2 scope at the function layer, not just by
     convention).
   - Both writes happen inside the same function invocation (a Firestore
     transaction) so a teacher document is never left pointing at a
     nonexistent classroom.
4. Client then proceeds exactly as today, just parameterized by the new
   `classroomId` instead of the literal `"morgan"`.

This flow only runs for **new** teachers. The existing production teacher's
sign-in must short-circuit straight to step 2's "already exists" branch —
see migration strategy below for exactly how that gets seeded.

### Data migration strategy

Goal: zero data loss, zero downtime for the existing classroom, and a
rehearsed, reversible cutover.

1. **Pre-migration, on a copy of production data (never production
   directly):** export `morganBank/classroomData`, `studentCredentials`, and
   `studentAuthLogs` via `firebase firestore:export` or the Admin SDK, and
   restore into a **separate, non-production Firebase project** (or the
   emulator) for rehearsal.
2. **Write a one-time, idempotent migration script** (Admin SDK, run
   manually, not a client-triggered function) that:
   - Generates one new `classroomId` for the existing class under Option B
     (a fresh auto-ID — see recommendation above), **or** reuses the literal
     `"morgan"` as the generated ID if preserving the existing human-readable
     ID is preferred for continuity. Either choice is compatible with Option
     B — the ID's *value* doesn't matter, only that it is not derived from
     `TEACHER_UID`.
   - Creates `teachers/{existing-TEACHER_UID}` with that `classroomId`.
   - Creates `classrooms/{classroomId}` with `ownerUid: "{existing
     TEACHER_UID}"`, copying `data.settings` verbatim.
   - Copies `data.students` into `classrooms/{classroomId}/students/{id}`
     (the mirror already exists from `syncStudentProfiles` — verify it's
     complete and current before trusting it as the source, don't assume
     it's never drifted from the source-of-truth document).
   - Copies `data.transactions` into
     `classrooms/{classroomId}/transactions/{autoId}` documents, preserving
     original transaction `id`/`date`/all fields.
   - Copies `data.loginHistory` into
     `classrooms/{classroomId}/loginHistory/{autoId}`.
   - **Does not delete** `morganBank/classroomData` — leave it in place,
     untouched, as a read-only backup until the new structure is verified in
     production for a full grading period.
   - Leaves `studentCredentials` and `studentAuthLogs` documents' data
     untouched (their `classroomId` field already matches whichever ID is
     chosen above, as long as the migration keeps the value consistent) —
     only the security rules governing them change.
3. **Dry-run this script against the rehearsal project**, diff student
   counts, sum total balances before/after, and diff transaction counts —
   an automated reconciliation check, not a manual eyeball pass, since this
   is exactly the kind of migration where an off-by-one or partial-batch
   failure is easy to miss by inspection alone.
4. **Deploy new `firestore.rules`** (ownership-based) to production
   *only after* the migration script has run successfully in production and
   been reconciled — never flip the rules before the data they depend on
   exists, or the teacher would be locked out of their own classroom for the
   gap.
5. **Ship the updated client** (`index.html` reading from
   `classrooms/{classroomId}` instead of `morganBank/classroomData`) in the
   same deploy as the rules change, since the old rules and old client only
   work together, and the new rules and new client only work together —
   there is no safe intermediate state where one is updated and not the
   other.
6. **Verify in production** with the real teacher account before announcing
   V2 or onboarding any second teacher: confirm roster, balances, full
   transaction history, and settings all match the pre-migration values
   exactly.
7. Only after that verification, begin onboarding additional teachers via
   the New Teacher Onboarding flow above.

### Rollback strategy

Because `morganBank/classroomData` is deliberately **not deleted** during
migration (step 2 above), rollback at any point before old rules are removed
is low-risk:

- **If the new client/rules misbehave post-deploy:** roll back Firebase
  Hosting to the prior release (same mechanism used for the v1.1.0 Google
  Sign-In rollback) and redeploy the prior `firestore.rules` — the old data
  path (`morganBank/classroomData`) is untouched and still has all data, so
  the app returns to its exact pre-migration working state.
- **If the migration script itself produced bad data:** since it's additive
  (writes new paths, doesn't touch the old document), simply delete the
  newly-created `classrooms/morgan/**` and `teachers/{uid}` documents and
  re-run the corrected script — the source data
  (`morganBank/classroomData`) was never modified, so there's no
  data-loss risk from a bad first attempt.
- **Do not delete `morganBank/classroomData`** until the new structure has
  been the production source of truth for at least one full grading period
  with no issues — treat it as the rollback safety net, not dead weight to
  clean up quickly.
- **If a second teacher's onboarding needs to be undone:** delete their
  `teachers/{uid}` document and their `classrooms/{their-id}` document/
  subtree — this cannot affect the first teacher's `classrooms/morgan`
  subtree at all, by construction of the ownership model (this is the
  acceptance test that actually proves isolation works, not just an assumed
  property).

### Testing strategy

1. **Firestore Rules Unit Tests** (via `@firebase/rules-unit-testing` and the
   Firestore emulator) — this repo has none today per the Firestore-layer
   analysis; this is the single highest-leverage new test investment for V2,
   since the entire security model is changing from literal-UID to
   ownership-lookup. Minimum required cases:
   - Teacher A can read/write `classrooms/A-id/**`.
   - Teacher A **cannot** read or write `classrooms/B-id/**` (the core
     multi-tenant isolation guarantee — must be an explicit, automated,
     repeatable test, not a manual one-time check).
   - Teacher A cannot read `studentAuthLogs/B-id/**`.
   - A student token scoped to classroom A cannot read classroom B's student
     documents even with a guessed/forged `studentId`.
   - An unauthenticated request is denied everywhere.
2. **Cloud Functions unit tests** (extending the existing
   `resetStudentPin.test.js` / `studentCredentialVerifier.test.js` patterns):
   - `resetStudentPin` denies a teacher who doesn't own the target
     classroom.
   - `syncStudentProfiles` correctly derives `classroomId` from the
     triggering path for at least two different classroom IDs (regression
     test against the old hardcoded-`'morgan'` bug class).
   - `ensureTeacherProfile` / `createClassroom` are idempotent and never
     leave a `teachers` doc pointing at a nonexistent classroom.
3. **Migration script reconciliation test** — run against the rehearsal
   project (never production): automated diff of pre/post student count,
   sum of balances, transaction count, and settings equality. Treat any
   mismatch as a blocking failure, not a warning.
4. **Manual end-to-end acceptance tests in staging**, mirroring the rigor of
   `GOOGLE_AUTH_PHASE1_CHECKLIST.md` §8:
   - Existing teacher signs in, sees their exact pre-migration classroom
     data.
   - Existing student PIN login still works unchanged, including lockout
     behavior.
   - A newly onboarded second teacher can create a classroom, add students,
     and record transactions, entirely independent of the first teacher's
     data.
   - The second teacher's login screen, roster, and settings show **zero**
     data from the first teacher's classroom, verified by direct
     inspection, not just absence of errors.
   - Attempting to access the first teacher's classroom path directly (e.g.
     via browser devtools, manually calling `getDoc` on
     `classrooms/morgan/...` while signed in as the second teacher) is
     denied by rules, not just hidden by the UI.
5. **Regression pass on everything V1 already covers**: CSV export,
   transaction history rendering, PIN reset UI, student request/approval
   flow — all must continue working against the new data shape.

---

## Part 3 — Complexity Estimate and Phasing

### Complexity estimate

This is a **major, structural migration** — larger in scope than the v1.1.0
Google Sign-In change, comparable to a full data-model rewrite of the core
domain. Contributing factors:

- Every collection except `studentCredentials` needs a path/shape change.
- The security rules model changes from literal-equality to ownership-lookup
  (`get()` calls), which changes rules performance/read-cost characteristics
  and needs its own test suite from scratch.
- The client has zero existing abstraction for "current classroom" — every
  one of ~30+ `requireTeacher()` call sites and both `loadData()`/
  `saveData()` need to become classroom-parameterized.
- There is no routing layer to reuse; if URL-based classroom scoping is
  wanted (recommended, so a teacher's dashboard has a stable/bookmarkable
  URL), that's new infrastructure, not a wiring change.
- A real, irreversible-if-botched data migration against the one production
  classroom's entire history.

Rough sizing (for planning, not a committed estimate): **larger than any
single prior change in this repo's history** (larger than the v1.0 initial
build's Firestore/Functions work and larger than the v1.1.0 auth switch
combined). Should be treated as its own major version for exactly this
reason — the `VERSION.md` "Version 2.0 Items: Multi-teacher support" framing
already anticipated this.

### Implementation phases

**Phase 0 — Foundations (this document + rules test harness)**
- This architecture document (current deliverable).
- Add Firestore Rules Unit Testing harness and emulator config (no
  production rule changes yet) — write tests *against the current rules
  first* as a baseline, then evolve them alongside the new rules in Phase 2.

**Phase 1 — Teacher & classroom data model, additive only**
- Add `teachers/{uid}` and `classrooms/{classroomId}` collections and the
  `ensureTeacherProfile` / `createClassroom` callables.
- No changes yet to `morganBank/classroomData`, existing rules, or the
  client's read/write path — purely additive, deployed and verified inert
  before anything depends on it.

**Phase 2 — Migration script + rehearsal**
- Write the one-time migration script (Part 2, "Data migration strategy").
- Dry-run and reconcile against a non-production copy of real data.
- Do **not** run against production yet.

**Phase 3 — Rules rewrite + client cutover (single coordinated release)**
- New ownership-based `firestore.rules`, deployed together with the updated
  client that reads/writes `classrooms/{classroomId}` instead of
  `morganBank/classroomData`, and the updated `syncStudentProfiles`/
  `resetStudentPin` functions.
- Run the migration script against production immediately before this
  deploy, per the safe ordering in Part 2.
- This is the only phase that touches production data or rules — everything
  before it is additive/inert, everything after it is verification/rollback
  readiness.

**Phase 4 — Production verification**
- Full manual + automated acceptance pass (Part 2, "Testing strategy" §4)
  against the real, migrated production classroom.
- Old `morganBank/classroomData` retained, untouched, as rollback safety net.

**Phase 5 — Second-teacher onboarding**
- Only after Phase 4 has been stable for a full grading period: onboard an
  actual second teacher, and run the cross-classroom isolation acceptance
  tests against real accounts, not just emulator tests.

**Phase 6 — Cleanup (deferred, separate future release)**
- Remove `morganBank/classroomData` only after V2 has been the sole source
  of truth, stable, for an extended period.
- Consider whether `classrooms/{id}/students/*` should stop being called a
  "mirror" once it's promoted to primary — at that point
  `syncStudentProfiles` may be simplifiable, but that's out of scope for
  this plan and should get its own follow-up analysis when it's actually
  being considered.

---

*This document is planning output only. Per the project's stated
development philosophy (`VERSION.md`), nothing here should be implemented
until explicitly requested, and implementation should proceed phase-by-phase
with verification at each step rather than as one large change.*
