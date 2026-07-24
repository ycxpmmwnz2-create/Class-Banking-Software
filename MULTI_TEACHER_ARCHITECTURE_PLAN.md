# Multi-Teacher Architecture Plan (Version 2.0)

Status: **Planning only. No source files, Firestore rules, Cloud Functions, or
Firebase configuration have been changed to produce this document.** This is
a read-only architectural analysis and design proposal, written on
`feature/multi-teacher`. **Production deployment state is unknown and is not
inferred anywhere in this document** — statements throughout refer to what
is checked in on this branch, not to what is currently running against the
live Firebase project.

This document builds directly on `GOOGLE_AUTH_MIGRATION_PLAN.md` (Phase B),
`SECURITY_PLAN.md` ("Version 2.0 Items"), and `GOOGLE_AUTH_PHASE1_CHECKLIST.md`
(which shipped as v1.1.0). It does not repeat their reasoning where it still
holds; it extends it into a concrete, phased implementation plan.

---

## Part 1 — Current Architecture Analysis

> **Scope of Part 1:** this section describes the **legacy runtime and data
> paths** — the code paths every client request still goes through today,
> unchanged by anything on `feature/multi-teacher` — plus, where noted, the
> **additive Phase 1 branch state** now checked in alongside it. The two are
> kept in the same numbered list below (rather than split into two separate
> parts) because that is how they actually coexist in this repository right
> now: the legacy paths run exactly as described, and the Phase 1 additions
> sit beside them, not yet wired into the legacy read/write path. **Whether
> any of the Phase 1 branch-state facts noted below (the `teachers`/
> `classrooms` documents, or the `ensureTeacherClassroom` callable) exist in
> the live deployed Firebase project is unknown and is not asserted or
> inferred anywhere in this document** — the existence of code capable of
> creating a document is not the same as that document existing in
> production. See Part 3 "Genuine remaining blockers" for this same caveat
> restated at the phasing level.

### Structural note

The application as checked in on this branch is **not** the React/Vite
scaffold implied by `package.json`. `src/App.jsx` and `src/main.jsx` are
empty/unused. The entire client — UI, state, routing, auth, and every
Firestore read/write the browser performs — is one 3,013-line inline
`<script type="module">` block inside **`index.html`**, using hand-rolled
global state and `innerHTML` rendering (no React, no router). Server-side
logic lives in `functions/`. This matters a great deal for the migration:
there is no component tree, no context/provider pattern, and no URL-based
routing to extend — multi-teacher session isolation must be built from a
single-global-`let`-variables model, not refactored from an existing
per-tenant abstraction. (Whether this exact `index.html` is what the live
deployment currently serves is unknown; this describes the checked-in file.)

### 1. Current Firestore collections

**Legacy collections** (what every existing client read/write still uses
today, unchanged by Phase 1):

| Collection / path | Nature |
|---|---|
| `morganBank/classroomData` | Single fixed top-level document. The **entire class**: roster, every transaction ever, login history, settings. |
| `classrooms/morgan/students/{studentId}` | Per-student read-only mirror, written by a Cloud Function trigger. `morgan` is a hardcoded literal, not a variable classroom ID. |
| `studentCredentials/{loginId}` | Flat, top-level, server-only (no client rule at all — default deny). PIN hashes, lockout state, `classroomId` + `studentId` fields. |
| `studentAuthLogs/{logId}` | Flat, top-level, global. Every PIN login attempt, across the whole app, with no classroom scoping in the security rule. |

**Additive Phase 1 branch state** (checked in on `feature/multi-teacher`,
built by `functions/phase1/teacherClassroomProvisioner.js`, not read or
written by any legacy client code path above):

| Collection / path | Nature |
|---|---|
| `teachers/{teacherUid}` | Document model exists in code (`functions/phase1/teacherClassroomModels.js`); created by `provisionTeacherClassroom`, invoked through the `ensureTeacherClassroom` callable (see §5, §7). Nothing in the legacy `index.html` read/write path (§1's other rows) references this collection. |
| `classrooms/{classroomId}` (root document only, generated ID) | Document model exists in code; created by the same provisioner alongside its paired `teachers/{teacherUid}` document. Distinct from the legacy `classrooms/morgan/students/*` mirror above, which is a different subcollection under the same top-level `classrooms` name. |

The local branch therefore contains teacher/classroom document *models* and
the code to create them — it does not follow that either collection exists
in the live deployed project. No `teachers` document, and no `classrooms`
root document with an `ownerUid` field, is read or written anywhere in the
*legacy* client/rules/functions path described in the rest of Part 1; the
teacher today is still authorized purely by a literal UID string compared
in code, exactly as before Phase 1.

### 2. Current document hierarchy

```
morganBank/classroomData                     (singleton — the whole class)
  { students: [...], transactions: [...], loginHistory: [...], settings: {...} }

classrooms/morgan/students/{studentId}       (mirror; "morgan" hardcoded)
  { id, name, balance, frozen, transactions: [...] }

studentCredentials/{loginId}                 (flat; classroomId field always "morgan")
studentAuthLogs/{logId}                      (flat; not classroom-scoped)
```

Within the legacy hierarchy above, the only "foreign key" fields are
`classroomId` (always the literal `"morgan"`) and `studentId`, on
`studentCredentials` and `studentAuthLogs`. No legacy document has a
`teacherId` or `ownerUid` field. The `classrooms/{classroomId}` root
document model checked into `functions/phase1/teacherClassroomModels.js`
(§1) *does* define an `ownerUid` field — see "Teacher profile model" and
"Classroom ownership model" in Part 2 for that shape — but no legacy
read/write path in this document's Part 1 references it, and whether any
such document exists in the live deployed project is unknown.

### 3. Authentication flow

**Teacher (as of v1.1.0):** Google Sign-In (`signInWithPopup`) or legacy
email/password, both resolving to one Firebase Auth user via account linking
(`linkWithPopup`), so `auth.currentUser.uid` is stable. Teacher identity is
decided by exactly one check, in `onAuthStateChanged` (`index.html:2910`):

```js
const isAuthenticatedTeacher = user?.uid === TEACHER_UID;
```

`TEACHER_UID` (`index.html:758`) is a literal string, duplicated verbatim in
(source, non-test, files — see §7 for the exhaustive inventory including
test fixtures):
- `index.html:758`
- `firestore.rules` (`isTeacher()`)
- `functions/resetStudentPin.js`
- `functions/phase1/ensureTeacherClassroom.js` (Phase 1 branch addition —
  the `ensureTeacherClassroom` callable's own authorization check, see §5)

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

**Legacy exports** (unchanged by Phase 1):

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

**Additive Phase 1 export** (checked in on `feature/multi-teacher`):

- **`ensureTeacherClassroom`** (`onCall`) — `functions/index.js` imports
  `ensureTeacherClassroomForCaller` from
  `functions/phase1/ensureTeacherClassroom.js` and exports it as
  `export const ensureTeacherClassroom =
  onCall(ensureTeacherClassroomForCaller)`. The handler itself requires
  `request.auth.uid === TEACHER_UID` (the same hardcoded literal used by
  `resetStudentPin`, defined again in this file — see §7) before calling
  `provisionTeacherClassroom` with a fixed classroom name. `index.html`
  already invokes it (`onAuthStateChanged`'s teacher branch calls
  `httpsCallable(functions, "ensureTeacherClassroom")` after the existing
  hardcoded teacher signs in). It is restricted to that one teacher today
  and is **not** a general onboarding endpoint — see Part 2, "New teacher
  onboarding flow," for the corrected status of general multi-teacher
  onboarding. Whether this export is part of the live deployed Cloud
  Functions today is unknown.

### 6. Every place the app assumes exactly one teacher / one classroom

| Assumption | Location |
|---|---|
| `TEACHER_UID` literal, sole authorization check | `index.html:758`, `firestore.rules`, `functions/resetStudentPin.js`, and (Phase 1 branch addition) `functions/phase1/ensureTeacherClassroom.js` (4 independent copies in source, not counting test fixtures — see §7) |
| `classroomId === "morgan"` client-side gate | `index.html:930` (approx., in `onAuthStateChanged` student branch) |
| `"morgan"` hardcoded as a Firestore path segment | `index.html:1120` (`viewStudentProfile`), and 3 `resetStudentPin({ classroomId: "morgan", ... })` call sites |
| Single global document, no classroom key in path | `morganBank/classroomData` — read in `loadData()` (`index.html:868`), written in `saveData()` (`index.html:889`) |
| Global mutable module-level state (`data`, `isTeacher`, `screen`, etc.) | `index.html:807-820` — one in-memory session for the whole running app; no per-teacher/session isolation concept exists at all |
| Single fixed `localStorage` key | `STORAGE_KEY = "mrMorganClassCashDataV5"` (`index.html:757`) — would collide across teachers on a shared device |
| `syncStudentProfiles` hardcodes `'morgan'` | `functions/syncStudentProfiles.js` (3 places) |
| Admin scripts hardcode `'morgan'` / single project | `functions/scripts/checkData.js`, `checkStudent.js`, `seedTestStudent.js` |
| No routing layer to scope by teacher/classroom | Entire app — `screen` is a plain string switch, no URL segments, no router of any kind |

### 7. Hard-coded teacher UID / classroom references (exhaustive, including
Phase 1 branch state)

**Teacher UID `YkYUzIzy0aW7roolM1VaLcIJPuN2`**: `index.html:758`,
`firestore.rules:7`, `functions/resetStudentPin.js:5` (+ its test fixture),
and — checked in on `feature/multi-teacher`, not present before Phase 1 —
`functions/phase1/ensureTeacherClassroom.js:6` (+ its test fixture,
`functions/phase1/ensureTeacherClassroom.test.js`). Confirmed by direct
search of the checked-in tree: exactly these four source files plus three
test-fixture files contain the literal.

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
| `classrooms/morgan/students/*` | This literal `morgan`-keyed mirror path is **not** the Phase 2A migration destination. Phase 2A writes fresh, allowlisted student documents to `classrooms/{generatedClassroomId}/students/{id}` (see Part 2) — it does not reuse or rewrite this path, since the V2 `classroomId` is a generated ID, never the literal `"morgan"`. |
| `studentCredentials/*` | Requires migration. Every document's `classroomId` field changes from the literal `"morgan"` to the resolved generated `classroomId` — see Part 2, "Student credentials." All other fields are preserved exactly. This is **not** a no-op: query/rule scoping changes *and* the `classroomId` field value changes. |
| `studentAuthLogs/*` | Requires migration. Flat `studentAuthLogs/{logId}` documents are copied to `studentAuthLogs/{generatedClassroomId}/logs/{logId}`, with the embedded `classroomId` field removed from the destination body (the destination path is authoritative) — see Part 2, "Student authentication logs." The original flat documents are left untouched, not deleted. |
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
generated `classroomId` — specifically, the Firestore auto-ID that
`provisionTeacherClassroom` (Phase 1B) already assigns when it creates the
`classrooms/{classroomId}` document (see Part 2, "Foundation and
validation"). **The literal `"morgan"` is never used as the Version 2
`classroomId`** — it remains only the legacy source classroom's identifier
inside `studentCredentials.classroomId` and (optionally) embedded
`studentAuthLogs` documents, purely as a source-side matching key during
migration. Nothing about today's student experience, PIN login, or
transaction history changes in shape — only the *ownership* layer is added
on top. This directly satisfies "my existing classroom must migrate safely
without losing any balances, transactions, or history" by making the
migration a **re-key + ownership-tag**, not a data rewrite.

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

> **Field provenance note:** the fields below marked *(Phase 1, implemented)*
> are exactly what `functions/phase1/teacherClassroomModels.js` builds today.
> Fields marked *(Phase 2B+ proposal)* are not implemented, not written by
> any Phase 1 or Phase 2A code, and must not be read as current fact —
> they're design placeholders for whichever later phase actually adds
> profile-picture display, last-login tracking, or teacher-disable support.

```
teachers/{teacherUid}
  {
    uid, classroomId,                   // (Phase 1, implemented)
    createdAt, updatedAt,                // (Phase 1, implemented)
    status: "active",                    // (Phase 1, implemented — TEACHER_STATUS.ACTIVE;
                                          // "disabled" is a Phase 2B+ proposal, not built)
    displayName, email,                  // (Phase 1, implemented — optional strings)
    photoURL, lastLoginAt                // (Phase 2B+ proposal — not implemented)
  }

classrooms/{classroomId}
  {
    ownerUid, name,                      // (Phase 1, implemented)
    createdAt, updatedAt, version,       // (Phase 1, implemented)
    settings: {}                         // (Phase 1, implemented — empty object at creation;
                                          // same shape as today's data.settings once populated
                                          // by Phase 2A migration)
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

studentCredentials/{loginId}            // path and document schema UNCHANGED;
                                         // classroomId VALUE is migrated per document
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

**Why `studentCredentials` keeps its flat collection path and document
schema**: it's server-only (Admin SDK), already has a `classroomId` field
in the right shape, and is queried (not listed/read by clients) — there's
no client-side rule risk here today, and changing its *path or schema*
would be pure churn for no security benefit. This is about structure only,
not data: every legacy document's `classroomId` **value** still has to be
migrated from the literal `"morgan"` to the resolved generated
`classroomId`, exactly like every other collection — see Part 2, "Student
credentials," for the full migration requirements. Nothing about this
collection is exempt from the migration; only its path and field names are
unchanged.

### Teacher profile model

This is now **implemented**, not merely proposed. `functions/phase1/
teacherClassroomModels.js` (`buildTeacherDocument`) and
`functions/phase1/teacherClassroomProvisioner.js`
(`provisionTeacherClassroom`) build this exact shape today, on the Phase 1B
`feature/multi-teacher` branch. Unlike an earlier draft of this document
claimed, the provisioner **is** wired to a callable in the local commit —
see "New teacher onboarding flow" below for the exact shape and its scope
restriction, and "Foundation and validation" in Part 2 for how Phase 2A's
emulator rehearsal uses the underlying helper directly:

```ts
// actual shape written by buildTeacherDocument(), functions/phase1/teacherClassroomModels.js
teachers/{teacherUid}: {
  uid: string,                 // equals the document ID
  classroomId: string,         // the ONE classroom this teacher owns (V2 scope)
  createdAt: Timestamp,
  updatedAt: Timestamp,
  status: "active",            // TEACHER_STATUS.ACTIVE — no other value exists yet
  displayName: string,         // optional, defaults to "" if not supplied
  email: string,               // optional, defaults to "" if not supplied
}
```

`photoURL`, `lastLoginAt`, and a `"disabled"` status value are **Phase 2B+
proposals** — none of them are written by `provisionTeacherClassroom` today,
and nothing in Phase 2A depends on or introduces them. Do not treat them as
current schema when implementing against this document in Phase 2A.

Created once, atomically alongside its `classrooms/{classroomId}` document,
by `provisionTeacherClassroom` (a server-only, transactional helper),
invoked through the `ensureTeacherClassroom` callable — see "New teacher
onboarding flow" below for its current scope restriction. It is **never**
client-writable directly, to prevent a signed-in user from self-assigning a
`classroomId` they don't own.

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

> **Implementation status (corrected):** an earlier draft of this document
> claimed `provisionTeacherClassroom` had no callable wrapper and that a
> deployed callable was future Phase 2B work. That was wrong. In the local
> Phase 1B commit, both the callable and its client wiring already exist:
>
> - `functions/index.js` imports `ensureTeacherClassroomForCaller` from
>   `functions/phase1/ensureTeacherClassroom.js` and exports it as a
>   deployed-in-code callable: `export const ensureTeacherClassroom =
>   onCall(ensureTeacherClassroomForCaller)`.
> - `functions/phase1/ensureTeacherClassroom.js` requires
>   `request.auth.uid === TEACHER_UID` (the same hardcoded UID used
>   elsewhere in v1) before calling `provisionTeacherClassroom`, using a
>   fixed classroom name (`"Mr. Morgan's Classroom"`) — this is **not** a
>   general onboarding endpoint any signed-in user can call to create their
>   own classroom; it is a thin, single-teacher-restricted wrapper whose own
>   code comments describe it as a "Temporary single-teacher bootstrap"
>   ahead of real multi-teacher onboarding.
> - `index.html` already calls it: `onAuthStateChanged`'s teacher branch
>   invokes `httpsCallable(functions, "ensureTeacherClassroom")` once the
>   existing hardcoded teacher signs in.
>
> **Whether this local commit has been deployed to the live Firebase
> project is unknown and must not be inferred from the repository alone.**
> This document describes what is checked in on `feature/multi-teacher`,
> not what is currently running in production.
>
> What remains **actually unbuilt**, and is correctly still Phase 2B+ scope,
> is the **general** multi-teacher onboarding flow: a callable any newly
> signed-in teacher (not just the one hardcoded UID) can call to create
> their *own* classroom with a name they choose, plus the "Create your
> classroom" UI step for that case. `ensureTeacherClassroom` as it exists
> today only ever provisions the one foundation classroom for the one
> hardcoded teacher; it does not generalize without further authorization
> and UX work.

The two-callable shape (`ensureTeacherProfile` then `createClassroom`)
sketched in even earlier drafts of this document remains a reasonable
target design for that later, general-onboarding phase, but should be
revisited against what `ensureTeacherClassroom`/`provisionTeacherClassroom`
already prove out (a single transactional helper covering both documents,
currently gated to one teacher) rather than assumed as final:

1. Teacher signs in with Google (existing flow, no changes needed there).
2. Client calls a callable that ensures a `teachers/{uid}` document exists,
   creating one (with its paired `classrooms/{classroomId}` document, per
   `provisionTeacherClassroom`'s actual transactional behavior) if it does
   not, or returning the existing one unchanged if it does — generalized,
   for Phase 2B+, to any authorized teacher rather than one hardcoded UID.
3. Client then proceeds parameterized by the returned `classroomId` instead
   of the literal `"morgan"`.

This generalized flow, once built, would only run for **new** teachers. The
existing teacher's data is seeded by the Phase 2A migration (see "Data
migration strategy" below) — not by this onboarding flow — so their first
sign-in after that migration finds an already-existing `teachers/{uid}`
document (created either by the migration or, in the local commit today,
by `ensureTeacherClassroom` itself) rather than triggering first-time
creation.

### Data migration strategy

> **Revision history:** The first Phase 2 draft (a short numbered list) was
> replaced after an independent review (Codex) found unsafe defaults: reuse
> of the provisioner's transactional validation from inside the migration,
> ambiguity about whether the legacy literal `"morgan"` could become the V2
> `classroomId`, no plan for `studentCredentials`/`studentAuthLogs`, no
> document-ID validation, and no restart/idempotency story. That revision
> was itself then corrected after a second, focused Codex review found it
> still underspecified: the "any differing destination is a conflict" rule
> didn't account for re-running a migration that intentionally mutates
> `settings`/`lastBackupAt`/`classroomId`; the checksum design would block
> restart recovery on exactly the documents Phase 2A is supposed to update;
> the manifest schema, batch limits, and CLI exit codes were described only
> in prose; and Part 1's migration-need table, the onboarding-flow section,
> and the teacher-profile field list still stated things (`"morgan"` as an
> acceptable V2 ID, `studentCredentials`/`studentAuthLogs` needing no
> migration, `ensureTeacherProfile`/`createClassroom` as already-built
> functions, `photoURL`/`lastLoginAt`/disabled-status as current schema)
> that contradicted this section. Those have all been corrected in place
> throughout the document. After implementation Items 2–4, independent
> Gemini and Claude reviews identified one further Item 5 integration gap:
> native Firestore `Timestamp` values require an explicit, lossless,
> collision-safe canonical encoding before hashing or JSON-manifest
> persistence. The normative encoding clarification below closes that gap
> without changing the existing checksum domains or canonical manifest-slot
> identity. This note exists so the history isn't lost, not because any of
> the superseded statements are still live. Everything below is the current,
> authoritative Phase 2A design.

Goal: zero data loss, zero downtime for the existing classroom, and a
rehearsed, restart-safe, reversible cutover, with the tooling and rehearsal
fully proven in the Firestore emulator before Phase 3 ever touches
production.

#### Scope boundary for Phase 2A

Phase 2A delivers the migration CLI, the independent read-only validator, the
versioned manifest format, and a Firestore-emulator rehearsal harness that
calls the existing `provisionTeacherClassroom` helper to build the Phase 1
foundation before migrating legacy data on top of it. It does **not** stand
up an Auth or Functions emulator, does not change `firestore.rules`, does
not touch production, and does not implement a destructive rollback
executable. Firestore-only emulation is sufficient for everything in this
phase.

Phase 2B (Functions/Auth changes, onboarding UX, credential-collision
handling at the product level, browser account-switch/cache safety) is a
mandatory follow-up before Phase 3, named here so it isn't lost, but is
intentionally not designed in this document — see "Implementation phases."

#### Foundation and validation

- The rehearsal harness calls `provisionTeacherClassroom` (Phase 1B,
  `functions/phase1/teacherClassroomProvisioner.js`) against the Firestore
  emulator to create the `teachers/{teacherUid}` and
  `classrooms/{classroomId}` documents the migration will write on top of.
  This is the only place Phase 2A depends on Phase 1 code.
- The migration itself does **not** call the provisioner and does **not**
  reuse its transactional validation. It ships its own **independent,
  strictly read-only validator** that re-derives the same guarantees from
  scratch by reading Firestore directly. The validator performs no
  transactions, creates, sets, updates, batches, commits, or deletes — read
  calls only.
- The validator rejects the run unless all of the following hold:
  - `teachers/{teacherUid}` exists.
  - The document's `uid` field equals `teacherUid` (the doc ID).
  - `status === TEACHER_STATUS.ACTIVE` (`'active'`) — the only status value
    the checked-in Phase 1 models (`functions/phase1/
    teacherClassroomModels.js`) or the Phase 2A rehearsal design in this
    document ever write. A `"disabled"` status is a Phase 2B+ proposal not
    written by either of those — this says nothing about whether a
    deployed Firestore document could contain some other status value; the
    validator simply has no branch for anything but `"active"` beyond
    "not active → reject."
  - `classroomId` is present and passes document-ID validation (see
    "Document-ID validation" below).
  - `classrooms/{classroomId}` exists.
  - The classroom's `ownerUid === teacherUid`.
  - The classroom's `version === CLASSROOM_DOCUMENT_VERSION` (`1`) and it has
    the required Phase 1 fields (`ownerUid`, `name`, `createdAt`, `updatedAt`,
    `version`, `settings`).
- Any failure is a blocking error, reported before any plan is built — the
  validator's job is to prove the Phase 1 foundation is trustworthy, not to
  repair it.

#### Classroom identity

- The Version 2 `classroomId` is **whatever generated ID
  `teachers/{teacherUid}.classroomId` already references** — i.e., the ID
  `provisionTeacherClassroom` assigned when it created the foundation. The
  migration reads this value; it does not choose or generate it.
- The literal `"morgan"` is **never** used as the V2 `classroomId`, anywhere
  in this document or in the tooling it describes. It remains the legacy
  source classroom's identifier inside `studentCredentials.classroomId` and
  (optionally) inside embedded `studentAuthLogs` documents, and is treated
  purely as a source-side matching key, never written to any V2 destination
  path.

#### Classroom root update

- The existing Phase 1 `classrooms/{classroomId}` root document (created by
  `provisionTeacherClassroom`) is **never replaced**. The migration only
  updates two fields on it:
  - `settings` — copied from the legacy `morganBank/classroomData.settings`.
  - `lastBackupAt` — copied from the legacy
    `morganBank/classroomData.lastBackupAt`. If the legacy field is missing
    (not merely falsy — actually absent), the destination is normalized to
    `null`. If the legacy field is present, its exact value is preserved,
    including if that value is `null`.
  - `ownerUid`, `name`, `version`, `createdAt`, and `updatedAt` are left
    completely untouched by this operation.
- The manifest's preimage for this operation stores only the prior
  `settings` value and the prior presence/value of `lastBackupAt` — enough
  to restore exactly what the migration changed. It never records or implies
  that the pre-existing `teachers/{teacherUid}` or
  `classrooms/{classroomId}` documents themselves are rollback candidates
  for deletion; the Phase 1 foundation they represent is out of scope for
  any Phase 2A rollback.

#### Student documents

- Destination: `classrooms/{classroomId}/students/{normalizedStudentId}`.
- The destination body contains **exactly** these fields, built as follows
  (matching `syncStudentProfiles`' existing mirror logic,
  `functions/syncStudentProfiles.js:71-77`, so the migrated shape is
  identical to what the sync trigger already produces today):
  - `id`: the original `student.id` (unnormalized — the same value already
    on the legacy roster entry).
  - `name`: `student.name` when it is a string, otherwise the literal
    `"Student"`.
  - `balance`: `Number(student.balance || 0)`.
  - `frozen`: `Boolean(student.frozen)`.
  - `transactions`: the legacy transaction array filtered to entries whose
    `studentId` is non-null and where `String(transaction.studentId) ===
    normalizedStudentId`, preserving the original array order and each
    transaction's complete original body (no field-level filtering within a
    transaction — only the student document itself is allowlisted).
- No other field is ever written to a student destination document, and the
  legacy student object is **never copied verbatim**. The following are
  explicitly excluded even though they exist on the legacy object today:
  plaintext `pin`, `loginId`, any credential field, `credentialActive`, and
  any other field not in the list above.
- Required test coverage: construct a legacy student object with a plaintext
  `pin`, `loginId`, `credentialActive: true`, and an invented unknown field,
  run it through the migration against the emulator, and assert the
  resulting destination document's key set is exactly `{id, name, balance,
  frozen, transactions}` — an explicit assertion on the written document's
  actual keys, not a partial/allowlist-only equality check that could pass
  even if extra keys leaked through.

#### Transactions and login history

- Destinations:
  - `classrooms/{classroomId}/transactions/{normalizedTransactionId}`
  - `classrooms/{classroomId}/loginHistory/{normalizedHistoryId}`
- Each destination document preserves the **complete original body** of the
  corresponding legacy transaction or login-history entry, including its
  original `id` field — unlike the student document, there is no allowlist
  here; the whole record is retained.
- Document IDs are **deterministic**, derived from the legacy `id` via the
  document-ID validation rules below, not Firestore auto-IDs.
- **Explicit departure from an earlier draft:** transactions/login-history
  were previously described as being copied into `{autoId}` documents. That
  is superseded — deterministic, legacy-`id`-derived document IDs are
  required instead, because restart-safe idempotency (re-running the
  migration after a partial failure without creating duplicates) is only
  possible if the same legacy record always maps to the same destination
  document ID. Auto-IDs would make every retry a duplicate-write risk.

#### Document-ID validation

Applies to student, transaction, and login-history IDs, validated **before**
any write is planned — i.e., during the preflight/plan-building step
described in "Preflight and concurrency protection," not at write time:

- Accepted inputs: finite numbers, or strings that are already canonical.
  - Numbers normalize via `String(value)`.
  - Strings must already be canonical: nonempty, not whitespace-only, and
    with no leading or trailing whitespace. Accepted strings are used
    as-is — they are **not** trimmed and **not** Unicode-normalized. A
    string that would only become valid after trimming (e.g. `" 42 "`) is
    **rejected**, not silently trimmed and accepted — silent transformation
    would make the destination ID a function of a normalization step this
    validator doesn't actually apply, which is a correctness trap for
    anyone reading the destination ID back later and assuming it equals
    `String(source value)` with no hidden step.
- Rejected inputs: objects, arrays, booleans, `null`, `undefined`, `NaN`,
  `Infinity`/`-Infinity`; empty or whitespace-only strings; any string
  requiring trimming to become valid; any value containing `/`; `.` or
  `..`; reserved IDs matching `__.*__`; invalid Unicode/UTF-8 encodings;
  values exceeding **1,500 UTF-8 bytes** (Firestore's per-document-ID
  limit); and any value that collides with another *after* normalization
  (e.g., numeric `1` and string `"1"` both normalize to `"1"` and are both
  rejected as a collision, not silently deduplicated).
- Every rejection reports: category (which rule failed), source index
  (position in the legacy array/collection), original value and its type,
  the normalized value (if normalization was even possible), and — for
  collisions — the identity of the colliding partner record.
- This validation is shared logic used identically for students,
  transactions, and login-history entries; it is not re-implemented three
  times with subtly different rules. See "Proposed files and module
  boundaries" below for where this lives (`firestoreDocumentId.js`).

#### Student credentials

Student credentials are **mandatory migration content** in Phase 2A, not a
deferred item.

**Lifecycle note — this section's `classroomId === "morgan"` requirement
applies specifically to starting a brand-new run, not to every invocation
of the tool.** The full lifecycle, stated explicitly to avoid the
contradiction an earlier draft left between this section and the restart
logic in "Preflight classification" / "Manifest durability procedure"
below:

- **Starting a brand-new run** means that the canonical manifest slot for
  this migration identifier/emulator-project/teacher identity is absent, or
  contains a `failed` manifest with `writePhaseStarted === false` that is
  eligible for replacement under the state-machine rules below. Before a
  replacement is written into that same canonical slot, the complete
  brand-new-run validation runs again. Every source `studentCredentials`
  document must have
  `classroomId === "morgan"` at that moment. A missing `classroomId`, or any
  value other than `"morgan"`, is a **blocking source anomaly** — the run
  fails closed rather than guessing. This is a check against the raw
  legacy source before a replacement plan is accepted.
- A successful dry-run leaves a `planned` manifest with
  `writePhaseStarted === false` in the canonical slot. That manifest is the
  plan write mode must consume; the tool does not casually replace it on a
  later invocation. It revalidates that retained plan, or blocks on identity,
  source, foundation, or plan drift.
- **Once `writePhaseStarted === true`**, that value is monotonic and proves
  that a batch may have been attempted even if recovery later resets every
  batch to `pending`. A `writing`, `verifying`, `failed`, or `indeterminate`
  manifest with this flag set must use retained-manifest recovery; the
  brand-new-run source-anomaly check above does **not** re-run against raw
  source data. Instead, recovery classifies each
  credential against *that manifest's* recorded `expectedBeforeHash`
  (`classroomId === "morgan"` plus the credential's invariant hash) and
  `expectedAfterHash` (`classroomId === generatedClassroomId` plus the same
  invariant hash), per "Preflight classification" and "Manifest durability
  procedure" below. A credential in its expected-after state during restart
  is correct and expected, not an anomaly — the new-run check above would
  wrongly reject it if it were mistakenly re-applied at this stage. A crash
  after `writePhaseStarted` is durably set but before the first Firestore
  commit is therefore still a recovery case, not permission to replace the
  manifest.
- A `failed` manifest with `writePhaseStarted === false` is the narrow
  exception: it is demonstrably a zero-write validation/preflight failure and
  may be replaced in the same canonical slot by a new dry run, but only if the
  retained manifest is readable, well-formed, and its fixed identity
  (`migrationId`, `schemaVersion`, `emulatorProjectId`, and `teacherUid`)
  matches that slot. The replacement must perform the full brand-new-run
  validation above, including requiring every credential's `classroomId ===
  "morgan"`. It deliberately does **not** require the failed manifest's old
  classroom ID, source/foundation checksums, or plan checksum to match:
  correcting the zero-write failure may legitimately change any of them. The
  tool re-reads and independently validates the current foundation and complete
  legacy source, recalculates the classroom identity, projections,
  preconditions, batches, and every checksum, generates a new `runId`, and only
  then atomically replaces the old file. If that new validation fails, the
  existing failed manifest remains intact. Current batch states alone never
  establish this exception; only the monotonic manifest flag does.
- **A credential document that already contains `generatedClassroomId` is
  never, by itself, assumed to be safely migrated.** It is only treated as
  correctly migrated when it matches a *specific, retained* manifest's
  `expectedAfterHash` for that exact document — i.e., when there is a
  manifest to check it against. A `generatedClassroomId` value found with
  no retained manifest to validate it against (or against a manifest whose
  plan/foundation/source checksums don't match) is a **divergent,
  blocking** state, not a silent pass — see "Preflight classification" and
  "Restart recovery" below.
- **Every invocation derives and inspects the canonical manifest slot before
  planning from Firestore.** A retained manifest with
  `writePhaseStarted === true` and `runState` of `writing`, `verifying`,
  `failed`, or `indeterminate` must enter recovery; a `completed` manifest is
  read-only/reverification-only; and a `failed` manifest with
  `writePhaseStarted === false` may follow only the explicit replacement path
  described above. This ordering is what
  prevents the new-run `classroomId === "morgan"`-only check from ever
  being applied to a credential that a retained manifest already
  legitimately advanced to `generatedClassroomId` — see "Preflight
  classification" and "Manifest durability procedure" below for the exact
  mechanics, and note that `migrateClassroomData.js`'s orchestration
  (validate → plan → manifest → write → reconcile, per "Proposed files and
  module boundaries") means *deriving and checking the canonical slot*
  happens before planning a fresh run from source, not after — a fresh
  "validate source, build a new plan" pass never runs ahead of checking
  whether that identity already has retained state. Drift blocks for a valid
  `planned` manifest, any manifest with `writePhaseStarted === true`, and a
  `completed` manifest under reverification. The sole exception is the
  well-formed, fixed-identity-matching `failed` +
  `writePhaseStarted === false` replacement path above, where current state is
  fully revalidated and new checksums are expected; even there, replacement is
  atomic in the same slot and never creates a second run.
- Active, inactive, and orphaned credentials (per the states
  `syncStudentProfiles` already produces — `active: true`/`false`, and
  credentials whose `studentId` no longer matches any current roster entry)
  are **all included**, to preserve parity with the source. Orphaned
  credentials are additionally reported in a separate manifest section
  (`orphanedCredentialPaths`) for later human review, but are never omitted
  from the migration itself.
- The **only** field the migration changes is `classroomId`, rewritten from
  `"morgan"` to the resolved `generatedClassroomId`. Every other field is
  preserved exactly, including unknown/undocumented fields, `pinHash`,
  `authUid`, `active`, `failedAttempts`, `lockedUntil`, `schemaVersion`, and
  all timestamp fields (`createdAt`, `updatedAt`, `pinUpdatedAt`).
- Writes use an **update-time precondition** captured during the complete
  destination preflight (see "Preflight and concurrency protection" below),
  so a credential document that changed underneath the plan (e.g., a
  student logged in and triggered a lockout update between preflight and
  write) is detected and blocked rather than silently overwritten.
- `pinHash` and all other credential secrets are never written to console
  output or the manifest. The manifest records only: document path, old and
  new `classroomId`, a hash (not the secret value) sufficient to verify
  before/after integrity, and the update-time/precondition metadata needed
  for verification and rollback.

#### Student authentication logs

- Source: flat documents at `studentAuthLogs/{legacyLogId}`.
- Destination: `studentAuthLogs/{generatedClassroomId}/logs/{legacyLogId}` —
  note this is **not** a verbatim copy, because the embedded `classroomId`
  field is intentionally removed from the destination body (the destination
  path is authoritative, so carrying a redundant, potentially-stale
  `classroomId` field forward would be a second source of truth for the
  same fact).
- Policy on the legacy embedded `classroomId` field (per
  `functions/studentCredentialVerifier.js:44-46`, which writes it only when
  present as a string): a **missing** embedded `classroomId` is accepted (log
  entries from before that field existed, or from failed-lookup attempts
  that never resolved a classroom); an embedded value of `"morgan"` is
  accepted; any other embedded value is a **blocking anomaly**.
- **Every other field is preserved exactly** — `loginId`, `success`,
  `reason`, `timestamp`, `studentId` when present, and any field this
  document happens to carry that isn't named here, including fields added
  by a future version of `studentCredentialVerifier.js` that this plan
  doesn't know about yet. This is deliberately not a finite enumerated list
  that could be read as "unknown fields are dropped" — only `classroomId`
  is ever removed; everything else on the source document body is copied
  through unconditionally.
- The original flat `studentAuthLogs/{legacyLogId}` documents are left
  untouched — this is an additive copy, not a move.
- The destination document ID is the existing Firestore document ID
  (`legacyLogId`) — no new ID scheme, since these IDs are already Firestore
  auto-IDs with no collision risk across the rename.

#### Dry-run and CLI safety

- Every executable in the Phase 2A tooling refuses to run unless
  `FIRESTORE_EMULATOR_HOST` is set in the environment — there is no code path
  that can reach a real Firestore project.
- Required explicit flags: `--teacher-uid`, `--project-id`.
  Unknown, duplicate, missing, or mutually contradictory flags fail closed
  before any Firestore access. See "CLI contract" below for the exact
  invocation shape and exit codes.
- `--manifest` is not supported. The parser rejects it, every state-directory
  or manifest-filename override, and any unknown alias attempting the same
  thing. The tool derives one canonical manifest slot from the fixed Phase 2A
  migration identifier/schema version plus the explicit emulator project ID
  and teacher UID, and displays the resolved path for operator visibility;
  the operator cannot select or override it.
- A command invoked without `--write` is always a dry run and performs
  **zero** Firestore writes — it only reads, validates, plans, and writes the
  local canonical manifest file. Only `--write` reaches the writer code path
  at all.
- Write mode must consume the successful manifest produced by the preceding
  dry-run. See "Immutable checksums vs. mutable fields" below for exactly
  what must match and what is allowed to have advanced between dry-run and
  write.
- There is no production override flag, no confirmation flag that bypasses
  the emulator-host check, no default production project ID, and no dormant
  code path that could reach production, even accidentally, in Phase 2A.

#### Preflight classification (operation-specific, not one blanket rule)

An earlier draft of this section said "any existing, differing destination
is a blocking conflict," full stop. That rule is wrong for this migration,
because two of the three operation types **intentionally** change an
already-existing document (the classroom root, and each credential
document) — under a single blanket rule, re-running the migration after
those fields were already updated would misclassify the correctly-migrated
state as a conflict and refuse to proceed, which would break restart
recovery for exactly the runs that most need it. Classification is therefore
**per operation type**, and every destination is classified before batch 1:

**Create operations** (student, transaction, login-history, and
studentAuthLogs destination documents — none of these exist before the
first successful run):
- Absent → `planned` (a create).
- Exists, and its body exactly equals the expected post-migration body →
  `skipped_identical` (already complete from a prior run; not re-written).
- Exists with any other body → **blocking divergent conflict**. The tool
  never guesses which version is correct.

**Classroom-root update** (the `settings`/`lastBackupAt` field update on
`classrooms/{classroomId}`):
- Current state exactly matches the expected **pre-migration** value
  (i.e., the Phase 1 foundation's original `settings`/`lastBackupAt`, as
  captured by the foundation-invariant read) → `planned` (an update).
- Current state exactly matches the expected **post-migration** value →
  `skipped_identical` (already complete from a prior run).
- Anything else (partially applied, or diverged from either expected state)
  → **blocking divergent conflict**.

**Credential-classroom update** (the `classroomId` field on each
`studentCredentials` document):
- `classroomId === "morgan"` **and** every other field matches the
  credential's recorded invariant hash (see "Credential invariant hash"
  below) → `planned` (an update).
- `classroomId === generatedClassroomId` **and** every other field still
  matches the invariant hash → `skipped_identical` (already migrated by a
  prior run).
- Missing document, an unexpected `classroomId` value (neither `"morgan"`
  nor the resolved `generatedClassroomId`), or a changed invariant body →
  **blocking conflict**.

This is what makes the migration genuinely re-runnable: a second `--write`
invocation against a fully-completed prior run finds every destination in
its `skipped_identical` state and commits nothing, rather than failing on
"the classroom root already has the new settings" or "the credential
already has the new classroomId."

#### Immutable checksums vs. mutable fields

A single whole-source checksum (as sketched in an earlier draft) cannot
survive a partially-completed run, because `studentCredentials` and the
classroom root are **intentionally** mutated by this migration — hashing
"the whole source plus destination" would change checksum on every batch
and make restart recovery indistinguishable from "the source changed
underneath you." The checksums are therefore split by what is actually
allowed to change:

- **Legacy immutable-source checksum**: a hash over
  `morganBank/classroomData` (the whole document, since nothing in it is
  ever mutated by this migration) plus the original flat `studentAuthLogs`
  source documents (also never mutated). This checksum must be identical
  between dry-run and every subsequent write/restart — if it changes,
  someone modified legacy data mid-migration, which is always a hard stop.
- **Foundation-invariant checksum**: a hash over the `teachers/{teacherUid}`
  document plus the classroom's immutable identity fields (`ownerUid`,
  `name`, `createdAt`, `updatedAt`, `version`) — explicitly **excluding**
  `settings` and `lastBackupAt`, since those are the two fields this
  migration is allowed to change. This must also stay identical across the
  whole run; if it changes, the Phase 1 foundation itself was tampered with,
  which is also a hard stop.
- **Credential invariant hash** (per credential document): a hash over every
  field on the credential **except** `classroomId`. Used both to detect a
  divergent credential (someone changed `pinHash`/`active`/etc. in a way
  the migration didn't expect) and to confirm a credential in its
  post-migration state is otherwise untouched.
- **Classroom expected-before/expected-after hashes**: two hashes covering
  just the `settings`/`lastBackupAt` update — "before" is the Phase 1
  foundation's original values, "after" is what the migration will write.
  These are what "Preflight classification" above compares the current
  document state against.
- **Plan checksum**: a hash over the canonical, ordered operation plan
  itself (every operation's type, path, and expected before/after hashes,
  in a fixed serialization order) — this is what lets write mode confirm
  it's executing the exact plan the dry-run produced, independent of the
  source/foundation checksums above.

On write or restart:
- A credential document may legitimately be found in **either** its
  expected-before (`"morgan"`) or expected-after (`generatedClassroomId`)
  state — both are valid, per "Preflight classification" above.
- The classroom root may legitimately be found in **either** its
  expected-before or expected-after `settings`/`lastBackupAt` state — same
  reasoning.
- Any other state for either is divergent and blocking.
- Critically: **a partially completed valid migration must reach restart
  recovery** (see "Restart recovery" under "Manifest durability procedure"
  below), not fail on a stale whole-source checksum first. The
  immutable-source and
  foundation-invariant checksums only ever gate on things that truly never
  change during a correct run; they must never be computed over
  `settings`/`lastBackupAt`/credential `classroomId`, or restart recovery
  becomes unreachable by construction.

#### Canonical Firestore-value encoding (normative Item 5 clarification)

The checksum domains above are unchanged, but some values inside those
domains are native Firestore `Timestamp` instances rather than JSON values.
Snapshot `updateTime` preconditions are also `Timestamp` instances. The
strict JSON-only behavior already established by `canonicalState.js` must
remain strict: passing a raw `Timestamp` (or any other class instance) to
`serializeCanonicalState` or `hashCanonicalState` continues to fail rather
than relying on an SDK object's incidental enumerable/private fields.

Item 5 therefore makes a **purely additive** change in the existing
`canonicalState.js` module. It adds recursive
`encodeCanonicalFirestoreValue(value)` and
`decodeCanonicalFirestoreValue(value)` exports; it does not add a new codec
module and does not change the behavior or output of
`serializeCanonicalState`/`hashCanonicalState`. Code hashing a
Firestore-derived value uses
`hashCanonicalState(encodeCanonicalFirestoreValue(value))`. Importing the
Firestore SDK's `Timestamp` value class for recognition and reconstruction
does not initialize a client, read Firestore, or write Firestore, so this
remains within `canonicalState.js`'s no-Firestore-access boundary.

The encoding is a versioned, recursive tagged union. JSON primitives remain
primitives, while every container and Timestamp is represented by one exact
wrapper shape:

```jsonc
// ordinary Firestore map (entries are sorted by field name)
{
  "$phase2aFirestoreValue": {
    "version": 1,
    "type": "map",
    "entries": [["fieldName", "<recursively encoded value>"]]
  }
}

// ordinary Firestore array (element order is preserved)
{
  "$phase2aFirestoreValue": {
    "version": 1,
    "type": "array",
    "values": ["<recursively encoded value>"]
  }
}

// Firestore Timestamp
{
  "$phase2aFirestoreValue": {
    "version": 1,
    "type": "timestamp",
    "seconds": -1,
    "nanoseconds": 999999999
  }
}
```

This is deliberately not a single tag added only to Timestamp-shaped
objects. Because **every** ordinary map and array is wrapped, a legitimate
Firestore map containing keys such as `$phase2aFirestoreValue`, `type`,
`seconds`, or `nanoseconds` cannot collide with or be decoded as a Timestamp;
those keys remain entries inside the map wrapper. The decoder accepts only
the exact version-1 shapes, rejects unknown or extra wrapper fields, rejects
duplicate/out-of-order map entries, and reconstructs maps, arrays, and
Timestamps without prototype pollution or implicit coercion.

Timestamp encoding and decoding use only the SDK's public `seconds` and
`nanoseconds` values. `seconds` must be a safe integer from -62,135,596,800
through 253,402,300,799; `nanoseconds` must be an integer from 0 through
999,999,999. Decoding reconstructs a genuine SDK `Timestamp` from that exact
pair so an update-time precondition survives a manifest write/read/restart
with nanosecond precision. `toMillis()`, `Date`, ISO strings, private
`_seconds`/`_nanoseconds` fields, and direct `JSON.stringify(Timestamp)` are
not valid canonical representations because they are lossy or rely on SDK
implementation details.

The encoder remains fail-closed for values outside this Phase 2A data
contract: unsupported Firestore-native classes, arbitrary class instances,
accessors, symbol keys, cycles, sparse arrays, `undefined`, `BigInt`,
non-finite numbers, and negative zero are rejected before a checksum or
manifest can be accepted. No `toJSON()` hook or other implicit conversion is
called. Map entries use the same deterministic string ordering as the
existing canonical JSON serializer; arrays retain their source order.

This representation rule does **not** change which values belong to a hash:

- The legacy immutable-source checksum still includes the entire legacy
  `morganBank/classroomData` document and every original flat
  `studentAuthLogs` source document. It does not exclude legacy
  `settings`/`lastBackupAt`; those source documents are never mutated.
- Only the foundation-invariant checksum excludes the destination
  classroom's `settings`/`lastBackupAt`, and only each credential invariant
  hash excludes that credential's `classroomId`, exactly as specified above.
- Classroom before/after hashes and the ordered plan checksum retain their
  existing domains. Any Firestore-derived value within those domains is
  recursively encoded before canonical hashing.

Any Firestore-derived value persisted in the manifest — including an
`updateTimePrecondition` and any allowed rollback-preimage value — is stored
in this encoded JSON form. On manifest read, `manifest.js` first validates
the manifest schema and the exact encoded wrapper structure, then decodes a
value only at the boundary that requires its native form. In particular, the
later writer decodes an update-time precondition back to a genuine
`Timestamp`; it never substitutes a millisecond or string approximation.
Credential-secret restrictions remain unchanged: encoding support is not
permission to persist a complete credential body, `pinHash`, a PIN, a token,
or any other secret.

Item 5 tests must cover all of the following:

- exact encode → canonical JSON → JSON parse → decode round trips for epoch,
  negative seconds, zero nanoseconds, and 999,999,999 nanoseconds, verified
  with the SDK's Timestamp equality semantics;
- nested maps/arrays and an ordinary map containing every reserved/tag-like
  key, proving it cannot collide with a Timestamp wrapper;
- rejection of malformed/unknown wrappers and every unsupported value
  category listed above;
- continued rejection of a raw, unencoded Timestamp by the existing
  JSON-only serializer/hash functions;
- unchanged canonical JSON/hash output for existing JSON inputs and unchanged
  `manifestSlot.js` filename derivation; and
- an atomic manifest write/read/restart round trip containing an encoded
  update-time precondition, proving exact seconds/nanoseconds recovery.

#### Versioned manifest schema

The manifest is a single JSON document stored in a **canonical,
non-user-selectable slot**. `manifestSlot.js` owns these fixed constants:

```
PHASE2A_MIGRATION_ID = "class-banking-phase2a-legacy-classroom-migration"
MANIFEST_SCHEMA_VERSION = 1
CANONICAL_STATE_DIRECTORY = functions/phase2/.state/
```

The state directory is resolved from `manifestSlot.js`'s own module URL (or
an equivalently anchored repository/module location), never from
`process.cwd()`. The filename is the lowercase hexadecimal SHA-256 of the
canonical JSON encoding of exactly `{ migrationId, schemaVersion,
emulatorProjectId, teacherUid }`, followed by `.manifest.json`. The generated
`classroomId`, immutable-source checksum, foundation-invariant checksum, and
plan checksum are deliberately **not** filename inputs: they remain inside
the manifest for validation because any of them may be unavailable or may
reveal drift after a partial run, and including them would make an unresolved
manifest undiscoverable.

Consequently, the same migration identifier/schema version, emulator project
ID, and teacher UID always resolve to the same slot regardless of the caller's
current working directory; changing the emulator project ID or teacher UID
resolves to a different slot. Every invocation displays this derived path and
inspects it before any fresh Firestore planning. There is no CLI flag or
environment override for the directory or filename. An unreadable, malformed,
or fixed-identity-mismatched retained manifest always blocks because the tool
cannot safely prove its lifecycle. Stale or divergent current state also
blocks for a valid `planned` manifest, any manifest with
`writePhaseStarted === true`, and a `completed` manifest under reverification.
The only drift exception is a readable, well-formed, fixed-identity-matching
`failed` manifest with `writePhaseStarted === false`: the explicit
same-slot replacement procedure below may recalculate its classroom identity,
checksums, and plan from fully revalidated current state. No condition ever
permits creating a second run in a different slot.

The manifest has this top-level shape (field names are illustrative of
required content, not a literal schema-validator spec):

```jsonc
{
  "schemaVersion": 1,
  "migrationId": "class-banking-phase2a-legacy-classroom-migration",
  "runId": "<opaque unique id, generated once at first dry-run>",
  "mode": "dry-run" | "write",
  "emulatorProjectId": "<--project-id value>",
  "teacherUid": "<--teacher-uid value>",
  "classroomId": "<resolved generatedClassroomId>",
  "createdAt": "<ISO 8601, set on first dry-run, never rewritten>",
  "updatedAt": "<ISO 8601, rewritten on every atomic manifest update>",

  "immutableSourceChecksum": "<hash>",
  "foundationInvariantChecksum": "<hash>",
  "planChecksum": "<hash>",

  "runState": "planned" | "writing" | "verifying" | "completed" | "failed" | "indeterminate",
  "writePhaseStarted": false | true,
  "inFlightBatchId": "<batch id or null>",

  "batches": [
    {
      "batchId": "<ordered index or opaque id>",
      "state": "pending" | "in_flight" | "committed" | "verified" | "failed" | "indeterminate",
      "operationIds": ["<ordered operationId list in this batch>"]
    }
  ],

  "operations": [
    {
      "operationId": "<opaque unique id, stable across dry-run and write>",
      "type": "create" | "classroom-field-update" | "credential-classroom-update",
      "path": "<destination Firestore path>",
      "expectedBeforeHash": "<hash, or explicit 'absent' for create ops>",
      "expectedAfterHash": "<hash>",
      "rollbackPreimage": { "...limited non-secret fields, see below..." },
      "updateTimePrecondition": {
        "$phase2aFirestoreValue": {
          "version": 1,
          "type": "timestamp",
          "seconds": 0,
          "nanoseconds": 0
        }
      }, // exact preflight value when applicable; otherwise null
      "state": "planned" | "skipped_identical" | "in_flight" | "committed" | "verified" | "failed" | "indeterminate",
      "batchId": "<owning batch id>",
      "error": { "code": "...", "message": "..." }  // present only on failed/indeterminate, never includes secrets
    }
  ],

  "orphanedCredentialPaths": ["<studentCredentials/{loginId} paths reported for human review>"],
  "reconciliationSummary": { "...counts and equality results from the last reconciliation pass, see 'Reconciliation requirements'..." }
}
```

**Run states**: `planned` (dry-run complete, no writes yet) → `writing` (a
write-mode invocation is actively committing batches) → `verifying`
(post-write reconciliation in progress) → `completed` (verified, terminal)
or `failed` or `indeterminate` (see below).

**`writePhaseStarted` is the monotonic write-safety boundary.** A fresh,
successful dry-run manifest is `planned` with `writePhaseStarted: false`.
Immediately before the first batch is permitted to enter `in_flight`, write
mode must durably persist `writePhaseStarted: true` through the atomic
manifest procedure below. Once true, it never returns to false — including
when recovery resets every current batch state to `pending`. Whether writes
were ever possible must never be inferred solely from current batch or
operation states.

**`failed` is not uniformly "safe to replace."** Specifically:
- A `failed` manifest with `writePhaseStarted === false` is demonstrably a
  zero-write validation/preflight failure. A later dry run may replace it in
  the **same canonical slot**, but only after re-running the complete
  brand-new-run validation, including the raw credential
  `classroomId === "morgan"` requirement. This exception requires a readable,
  well-formed manifest whose fixed identity matches the canonical slot. It
  does not compare the failed run's classroom ID, source/foundation checksums,
  or plan checksum with current state: those are recalculated because fixing a
  zero-write validation failure may legitimately change them. Replacement
  uses a new `runId` and the same atomic durability procedure, and occurs only
  after the current foundation, complete source, projections, preconditions,
  batches, and plan all validate. A new validation failure leaves the retained
  failed manifest untouched.
- A valid `planned` manifest with `writePhaseStarted === false` is the
  successful dry-run plan that write mode consumes. It is retained and
  revalidated, not automatically replaced by another dry run.
- **Once `writePhaseStarted === true`, the canonical manifest must never be
  abandoned or replaced.** A `writing`, `verifying`, `failed`, or
  `indeterminate` run with this flag set must recover or block using that
  exact retained manifest, even when `inFlightBatchId` is null and all
  current batches say `pending`. A changed classroom identity, source,
  foundation, or plan checksum is stale/divergent and blocking — never a
  reason to overwrite the slot with a new `runId`.
- `indeterminate` (a crash or uncertain commit occurred) always requires
  restart recovery before any other transition — it is never treated as
  simply "failed, start over."
- `completed` is terminal and read-only/reverification-only regardless of
  its other recorded state; it never reapplies writes.

**Batch states**: `pending` → `in_flight` → `committed` → `verified`, with
`failed`/`indeterminate` reachable from `in_flight` on error or crash.

**Operation states**: `planned` → `in_flight` → `committed` → `verified`
(or `skipped_identical` in place of the whole chain, reached directly from
preflight classification, and terminal), with `failed`/`indeterminate`
reachable from `in_flight`.

**Allowed transitions**: no terminal state (`completed`, `verified`,
`skipped_identical`) transitions backward except through the explicit
restart-recovery procedure in "Manifest durability procedure" below, which
is the only path that may move an `indeterminate` batch/operation forward
to `committed`/`verified` or back to a well-understood `failed`/`pending`
state after re-reading actual Firestore state. A `failed` manifest with
`writePhaseStarted === false` follows only the canonical-slot replacement
path above; a `failed` manifest with `writePhaseStarted === true` follows the
restart-recovery procedure and cannot be discarded. No code path silently retries or
re-derives a new state for an `indeterminate` entry without going through
recovery.

Every operation record always includes `operationId`, `type`, `path`,
`expectedBeforeHash` (or an explicit "absent" marker for create
operations), `expectedAfterHash`, its limited non-secret `rollbackPreimage`
where applicable (classroom root: prior `settings`/`lastBackupAt`;
credential: path + old/new `classroomId` + invariant hash — never a full
credential body), `updateTimePrecondition` where applicable (classroom-root
and credential updates, stored as the canonical encoded Timestamp defined
above), `state`, `batchId`, and `error` metadata without secrets when in a
failed/indeterminate state.

**Credential manifest entries never contain**: complete credential bodies,
`pinHash`, PINs, tokens, or any local credential material — only path,
old/new `classroomId`, the invariant hash, and precondition metadata.

**State-directory lifecycle and version-control policy**: Phase 2A
implementation must add the exact entry `functions/phase2/.state/` to the
repository-root `.gitignore`. The exact path is intentional; a broad
`**/.state/` pattern is unnecessary. The directory contains operator/runtime
state only: canonical manifests, temporary manifest files, crash-recovery
state, and every other file beneath it must remain untracked, and no
`.gitkeep` is committed inside it. Implementation tests must prove a
representative path such as
`functions/phase2/.state/example.manifest.json` is ignored (for example via
`git check-ignore`). Ignoring the directory is not a cleanup mechanism:
the migration tool never automatically deletes an unresolved,
write-started, indeterminate, post-write-failed, or completed manifest,
because that file is the recovery/audit journal. Rehearsal cleanup may remove
only disposable state created under an isolated test identity or temporary
test workspace; it must never silently remove an operator's canonical
manifest for an unresolved run.

#### Manifest durability procedure

1. Validate that every Firestore-derived manifest value is already in the
   canonical encoded form above, then serialize the manifest as canonical
   JSON (stable key ordering, so two writes of logically-identical state
   produce byte-identical output — useful for tests, not a functional
   requirement of Firestore itself).
2. Write to a uniquely-named temporary file in the **same directory** as the
   canonical manifest slot (the fixed `functions/phase2/.state/` directory
   resolved from the module location, not the caller's working directory;
   same-directory is required for the rename in step 4 to be atomic on POSIX
   filesystems).
3. Flush and `fsync` the temporary file.
4. Atomically rename the temporary file over the canonical manifest.
5. `fsync` the canonical state directory where the platform supports it (this is
   what makes the rename itself durable across a crash, not just the file
   contents).
6. Any failure at any step is treated as blocking — the tool does not
   proceed as though the manifest write succeeded when it didn't.

Sequencing around a batch commit:
- **Before any batch may enter `in_flight`**: atomically persist
  `writePhaseStarted: true` and `runState: writing` through the durability
  procedure above. This transition happens once. It is never reversed, and
  no batch commit may be called unless the durable manifest already contains
  `writePhaseStarted: true`. A crash after this transition but before the
  first Firestore commit therefore finds the same canonical manifest and
  enters recovery even though all batch states may still be `pending`.
- **Before** committing each batch: persist `inFlightBatchId`, the batch's
  state as `in_flight`, and every operation in that batch as `in_flight`, via
  the durability procedure above. This is what makes the "was this batch
  actually committed" question answerable after a crash.
- **After** a commit call returns success: persist the batch and its
  operations as `committed`. Then perform a **verify** step — read back the
  actual Firestore documents for that batch and confirm they match
  `expectedAfterHash` — and only then persist `verified` states and clear
  `inFlightBatchId` to null. None of these transitions changes
  `writePhaseStarted` back to false.
- **If the commit's outcome is uncertain** (the write call didn't return a
  clear success/failure, e.g. it threw a timeout or the process was
  killed), or if manifest persistence itself fails after a commit that
  did succeed: mark the batch (and, on restart, discover and mark) as
  `indeterminate`. Never assume success or failure from a missing answer.

**Restart recovery**: after the canonical slot is inspected, recovery is
triggered for a manifest with `writePhaseStarted === true` whose `runState`
is `writing`, `verifying`, `failed`, or `indeterminate`.
(`inFlightBatchId` being set is a *common cause* of hitting one of these
`runState`s, not itself the trigger condition — recovery must also run when
`inFlightBatchId` is `null` but earlier batches were left unresolved, e.g.
every batch committed but a post-write reconciliation failure moved
`runState` to `failed` before any batch reached `verified`. The procedure
below is written to cover both cases identically.) A `failed` manifest with
`writePhaseStarted === false` does not enter this procedure; it may only take
the same-slot replacement path after full brand-new-run validation. A
`completed` manifest takes the separate read-only reverification path, never
recovery or write execution.

**Selecting which batches to recover:**
- If `inFlightBatchId` is set, that batch is always included in the
  recovery set — it is the batch most recently known to be mid-commit.
- Independent of whether `inFlightBatchId` is set, recovery also includes
  **every batch recorded in the manifest whose `state` is not yet
  `verified`** (i.e., `pending`, `in_flight`, `committed`, `failed`, or
  `indeterminate`) — this is what covers the null-`inFlightBatchId`/
  post-reconciliation-failure case, where every batch may already be
  `committed` but none has reached `verified` yet.
- **Recovery candidates are inspected in ascending batch order** (the same
  deterministic order the original plan assigned batch IDs in) — never in
  an arbitrary or discovery order — so that an earlier batch's recovery
  outcome is always resolved before a later batch's is inspected, matching
  the same order the batches were originally meant to commit in.

**Per-batch recovery** (for each selected batch, in that order):
1. Read every Firestore document actually referenced by that batch's
   operations (not the manifest's last recorded state — the manifest may be
   stale relative to what really happened on the server).
2. Classify each operation in the batch against its `expectedBeforeHash`
   (an absent document counts as matching `expectedBeforeHash` for a
   create operation — there is no separate "missing" case; an absent
   create destination simply *is* that operation's before-state) and its
   `expectedAfterHash`. Then classify the **whole batch** as one of exactly
   four aggregate states — no others are used:
   - **before-state**: every operation in the batch matches its
     expected-before state (including any create operations whose
     destination is still absent).
   - **after-state**: every operation in the batch matches its
     expected-after state.
   - **mixed**: a valid combination of some operations in expected-before
     state and others in expected-after state — i.e., every operation is
     individually accounted for as either before or after, just not
     uniformly.
   - **divergent**: at least one operation matches **neither** its
     expected-before nor expected-after state.
3. Recovery per aggregate state:
   - **before-state**: nothing in this batch committed. Reset the batch to
     `pending` and retry it from the start.
   - **after-state**: everything in this batch already committed
     correctly. Mark the batch `verified` and continue to the next batch.
   - **mixed**: recover **operation by operation**, not as a whole batch.
     Operations already found in their expected-after state are marked
     `verified` as-is. Operations still in their expected-before state may
     be safely replanned with **fresh** update-time preconditions (their
     old preconditions may no longer be valid) and retried. This case must
     **never be silently retried as a whole batch**, since blindly
     re-committing a mixed batch risks re-applying an already-committed
     operation without the verification step ever running against it.
   - **divergent**: block for human review. A document that matches
     neither expected state cannot be safely auto-recovered — this is not
     a case the tool resolves on its own. Blocking on a divergent batch
     halts recovery for that batch and every batch after it in order;
     later batches are not inspected until the divergent one is resolved.

**Continuation and completion:**
- Recovery continues, batch by batch in order, **until every operation
  across every batch is `verified` or `skipped_identical`, or a divergent
  state blocks it** — there is no partial-recovery terminal state short of
  one of those two outcomes.
- Once every batch has reached `verified` (or every operation in it was
  already `skipped_identical`), **full reconciliation** (see
  "Reconciliation requirements" below) must run and pass before `runState`
  is set to `completed`. `runState` never transitions to `completed` on
  batch-level recovery success alone, without reconciliation having run.
- A run whose `runState` is already `completed` may be **reopened only for
  read-only verification** (e.g., a later audit re-checking reconciliation
  invariants) — it must never reapply writes; `--write` against a
  `completed` manifest is a no-op that re-verifies and exits, not a
  re-execution.

The manifest never contains plaintext PINs, PIN hashes, tokens, local
credentials, or full credential document bodies, in any state, at any point
in this procedure.

Phase 2A ships **no destructive rollback executable**. Rollback is a
manifest-driven **manual** procedure only (an operator reads the manifest's
`rollbackPreimage` entries and reverses the specific recorded field changes
by hand, or with a reviewed one-off script, at the time it's needed) — this
keeps the emulator-rehearsal surface area limited to forward migration plus
manifest bookkeeping, and defers any automated-rollback design to whenever
Phase 3 actually needs it.

#### Batch safety

- Maximum **400 operations per batch** and maximum estimated **8 MiB
  payload per batch** — split before either threshold would be exceeded,
  whichever comes first.
- A single operation whose estimated size alone exceeds the 8 MiB ceiling is
  **blocking** — it is never split across batches or written outside the
  batch mechanism.
- Deterministic operation order is preserved when splitting: batch
  membership is assigned by walking the canonical ordered operation plan
  and closing a batch exactly at the operation that would cross a
  threshold, never by reordering for a tighter pack.
- The size estimate for a single operation sums: the canonical serialized
  document/update body in bytes, the UTF-8 byte length of the destination
  document path, any field-mask/precondition bytes attached to the write,
  and a documented conservative per-write overhead allowance (accounting
  for gRPC/Firestore wire-format overhead beyond the raw document bytes).
- This 8 MiB figure is deliberately conservative and **below** Firestore's
  platform batch-write limit — it exists to leave headroom, not to claim
  the platform limit itself. It also does **not** make multiple batches
  globally atomic: Firestore batched writes are atomic *within* a batch
  only. If a later batch fails, earlier, already-committed batches remain
  committed — this is exactly why per-operation and per-batch manifest
  state (not an all-or-nothing assumption) is required.

#### Preflight and concurrency protection

Before any fresh plan is built, derive and inspect the canonical manifest
slot using only the fixed migration identifier/schema version plus the
explicit emulator project ID and teacher UID. Apply the retained-state rules
above before reading Firestore for a new run: recover/block unresolved
`writePhaseStarted` state, reverify completed state, retain a valid planned
manifest, or permit same-slot replacement only for `failed` plus
`writePhaseStarted === false`. After that gate, and before batch 1 of any
write-mode run:

The same-slot replacement exception applies only to a readable, well-formed,
fixed-identity-matching `failed` manifest with `writePhaseStarted === false`.
For that exception, old classroom/source/foundation/plan values are not drift
gates: the tool performs the entire brand-new-run validation against current
state and atomically replaces the failed manifest only after all new values
and checksums are valid. If validation fails, the old failed manifest remains
unchanged. Every other retained lifecycle (`planned`, any
`writePhaseStarted === true`, and `completed`) keeps the normal drift-blocking
rules.

1. Read and classify every destination document the plan would touch, using
   the operation-specific rules in "Preflight classification" above.
2. Build the complete ordered operation plan from that classification.
3. Atomically create/replace the canonical manifest when the dry-run lifecycle
   permits it, or validate the retained canonical manifest against current
   state in write/recovery/reverification mode.
4. Recheck the immutable-source and foundation-invariant checksums
   immediately before the first batch, in case something outside this
   migration's control changed between dry-run and write.
5. Apply create semantics (fail if something now unexpectedly exists) to
   destinations the preflight found absent.
6. Attach the update-time preconditions observed during preflight to every
   classroom-field and credential-classroom update, so a concurrent change
   is detected rather than clobbered.

The emulator fixture must remain quiescent (no concurrent writers) while the
preflight read-and-classify pass runs, since the whole conflict-detection
model assumes the classified snapshot is still accurate when the plan is
built from it.

#### CLI contract

Dry-run:

```
node functions/phase2/run.js \
  --teacher-uid UID \
  --project-id EMULATOR_PROJECT
```

Write (same identifying flags, plus `--write`; the canonical manifest slot
is derived automatically):

```
node functions/phase2/run.js \
  --write \
  --teacher-uid UID \
  --project-id EMULATOR_PROJECT
```

- The complete flag allowlist is `--teacher-uid`, `--project-id`, and optional
  `--write`. Argument parsing is fail-closed: unknown flags, duplicated flags,
  missing required flags, or flags that contradict the retained canonical
  manifest (e.g. a manifest identity mismatch after deriving the slot) all
  exit with a validation-failure code before touching Firestore.
- `--manifest` is explicitly rejected as unsupported. So are
  `--state-dir`, `--manifest-dir`, `--manifest-file`,
  `--manifest-filename`, or any other flag/alias attempting to override the
  fixed state directory or filename. No environment variable provides an
  equivalent override.
- After parsing the required identity, `manifestSlot.js` resolves and prints
  the canonical manifest path. Because it anchors the state directory to the
  Phase 2A module location and hashes only the fixed migration
  identifier/schema version, emulator project ID, and teacher UID, changing
  the caller's current working directory cannot change that path.
- Every invocation inspects that canonical slot **before** building a new
  plan. An unresolved manifest with `writePhaseStarted === true` is recovered
  or blocks; a valid `planned` manifest is retained for write mode; a
  `completed` manifest is reverified read-only; and only a `failed` manifest
  with `writePhaseStarted === false` is eligible for same-slot replacement
  after full brand-new-run validation. Classroom identity or
  source/foundation/plan drift blocks against `planned`,
  `writePhaseStarted === true`, and `completed` manifests and never creates a
  second run. For the sole `failed` + `writePhaseStarted === false` exception,
  corrected current state is allowed to differ from the failed run: all
  mutable identity, checksums, projections, preconditions, batches, and plan
  data are recalculated after full validation before atomic same-slot
  replacement. Malformed, unreadable, or fixed-identity-mismatched manifests
  never qualify for that exception.
- A bare invocation (no `--write`) can never write — this is enforced at the
  argument-parsing layer, not just by convention in the writer.
- No production override exists at any layer of the CLI.
- Distinct exit codes for: success, argument/validation failure, preflight
  conflict (a blocking divergent destination), stale manifest (checksum or
  identifying-flag mismatch between dry-run and write), write failure,
  indeterminate state requiring recovery, and reconciliation failure — so a
  calling script (or a human) can distinguish "nothing to do" from "you
  need to intervene" without parsing log text.

#### Reconciliation requirements

Both a **dry-run reconciliation** (against the projected plan, before any
write) and a **write-run reconciliation** (against actual post-write
Firestore reads) must verify:

- **Foundation**: teacher document unchanged; immutable classroom identity
  fields (`ownerUid`, `name`, `version`, `createdAt`, `updatedAt`)
  unchanged; only `settings` and `lastBackupAt` differ from the Phase 1
  foundation state.
- **Classroom metadata**: `settings` deep-equality against the legacy
  source; `lastBackupAt` equality, with a missing legacy source value
  normalized to `null`.
- **Students**: destination count; the normalized destination ID set;
  exact allowlisted bodies (`id`/`name`/`balance`/`frozen`/`transactions`);
  names, balances, and frozen state match source; per-student transaction
  arrays match both content and order; total balance across all students
  matches the source total; no forbidden keys (`pin`, `loginId`,
  `credentialActive`, or any unlisted key) on any destination document.
- **Transactions**: destination count; normalized ID set; destination
  paths; exact complete bodies (full field-for-field equality with source).
- **Login history**: destination count; normalized ID set; destination
  paths; exact complete bodies.
- **Credentials**: exact set of destination credential paths; every
  document's `classroomId` changed from `"morgan"` to the resolved
  generated ID; every other field (including unknown fields) unchanged;
  active, inactive, and orphaned credentials all present.
- **Authentication logs**: exact set of destination paths; every field
  except `classroomId` preserved; `classroomId` absent on every destination
  document; original flat source documents unchanged.
- **Checksums**: immutable-source checksum, foundation-invariant checksum,
  every credential's invariant hash, and the operation-plan checksum all
  match their expected values.

Any mismatch in any of the above is a **blocking failure**, not a warning,
in both dry-run and write-run reconciliation.

#### Synthetic fixture and rehearsal procedure

Phase 2A includes a fixture/seeder (`rehearsalFixture.js` /
`seedRehearsal.js` — see "Proposed files and module boundaries") capable of
creating, entirely inside the Firestore emulator:

- `morganBank/classroomData` with multiple students.
- Plaintext student PIN fields on those students, which must be excluded
  from migration output (this is what the student-document exclusion test
  actually exercises against).
- Transactions and login-history entries for those students.
- Active, inactive, and orphaned `studentCredentials` documents.
- Flat `studentAuthLogs` documents with a **missing** embedded `classroomId`.
- Flat `studentAuthLogs` documents with embedded `classroomId === "morgan"`.
- Flat `studentAuthLogs` documents with an **unexpected** embedded
  `classroomId` (to exercise the blocking-anomaly path).
- Records with missing, invalid, and duplicate IDs (to exercise every
  document-ID validation rejection category, including a numeric/string
  collision like `1` vs. `"1"`).
- More student/transaction/login-history records than fit in one Firestore
  query pagination page, to exercise paginated reads in the source reader.
- Enough total operations to require multiple write batches, to exercise
  batch-splitting and multi-batch manifest state.
- A stale-precondition scenario (a credential or classroom-root document
  mutated between preflight and write, to exercise precondition-failure
  handling).
- A divergent-destination scenario (a destination document pre-seeded with
  a body that matches neither expected-before nor expected-after state, to
  exercise the blocking-conflict path).

Rehearsal orchestration is a dedicated command (built on `firebase
emulators:exec`, following the same pattern as the existing `npm run
test:rules` — see `package.json`) that:

1. Starts **only** the Firestore emulator (no Auth, no Functions).
2. Supplies `FIRESTORE_EMULATOR_HOST` automatically as part of the emulator
   harness's own environment setup — this rehearsal command does **not**
   assume a developer has already run `firebase emulators:start` in a
   separate terminal and exported the host variable themselves; a plain
   `firebase emulators:start` does not export that variable into other
   terminals, so the rehearsal command must set it itself for the process
   it spawns.
3. Uses a non-production emulator project ID (distinct from `morgan-bank`,
   the project ID hardcoded in today's diagnostic scripts).
4. Seeds the legacy fixture (`rehearsalFixture.js`).
5. Calls `provisionTeacherClassroom` for foundation setup.
6. Runs dry-run mode from one working directory, confirms the canonical
   manifest path is displayed and the local state file is created, and
   records its `runId` and path.
7. Verifies **zero Firestore writes** occurred (a read-only check of every
   destination path immediately after the dry-run).
8. Invokes the same identity from a different working directory and proves
   it resolves the same canonical path and retains the same planned `runId`.
9. Proves a different emulator project or teacher UID resolves a different
   slot, and proves `--manifest` plus every state-directory/filename override
   is rejected before Firestore access.
10. Runs explicit `--write`; the tool automatically consumes the retained
    canonical manifest, with no path argument.
11. Performs post-write reconciliation (see "Reconciliation requirements").
12. Runs a **second** `--write` invocation against the completed canonical
    manifest and proves read-only idempotency (all operations are already
    `skipped_identical`/`verified`, zero new writes, and completion does not
    reapply writes).
13. Creates a zero-write `failed` manifest with
    `writePhaseStarted === false`, corrects legacy source data so the
    immutable-source checksum and projected plan change, then proves
    same-slot replacement succeeds only after the complete new-run validation
    (including credential `classroomId === "morgan"`) and records wholly new
    checksums, plan data, and `runId`.
14. Separately corrects a foundation problem behind a zero-write failure and
    proves replacement is allowed only when the newly read foundation passes
    every independent validator requirement. It also forces a new-run
    validation failure and proves the old failed manifest remains byte-for-
    byte intact rather than being partially replaced.
15. Proves source/foundation/classroom/plan drift remains blocking against a
    valid `planned` manifest and a `completed` manifest under read-only
    reverification, and proves malformed, unreadable, or fixed-identity-
    mismatched manifests never qualify for the zero-write replacement
    exception.
16. Durably transitions `writePhaseStarted` to true, forces a crash before
    the first batch enters `in_flight` or commits, and proves restart recovers
    the same canonical manifest even though every batch is still `pending`.
    Recovery may change batch states but must never return
    `writePhaseStarted` to false.
17. Injects a failure immediately after an earlier batch has successfully
    committed but before the manifest records it as `verified`.
18. Restarts the tool with only the same project/teacher identity and proves
    it rediscovers the canonical manifest and reaches the same terminal state
    as an uninterrupted run.
19. Separately changes the classroom identity, foundation invariant,
    immutable source, and plan projection after retaining an unresolved
    `writePhaseStarted === true` manifest, and proves each invocation still
    discovers that manifest and blocks as stale/divergent instead of creating
    another run.
20. Verifies an unresolved run cannot be bypassed by any filename or state
    directory flag, and verifies the repository-root `.gitignore` ignores
    `functions/phase2/.state/example.manifest.json` while no `.gitkeep` or
    runtime state file is tracked.
21. Verifies no Firestore deletes occurred anywhere during the whole
    rehearsal, no secret material (PINs, `pinHash`, tokens) appears in console
    output or the manifest at any point, and cleanup removes only disposable
    isolated test state—never an operator's unresolved canonical manifest.

#### Diagnostic-script requirements

Phase 2A includes focused hardening of three existing scripts, since they
will be used to inspect emulator state during rehearsal and must not become
a second, informal path to production:

- **`functions/scripts/checkData.js`**: today hardcodes
  `initializeApp({ projectId: 'morgan-bank' })` (a production project ID)
  with no emulator guard at all. Phase 2A requires it to run emulator-only
  (require `FIRESTORE_EMULATOR_HOST`), take an explicit `--project-id`
  instead of a hardcoded value, and gain basic argument/safety-guard tests.
- **`functions/scripts/checkStudent.js`**: today reads the Firebase CLI's
  cached refresh token from `~/.config/configstore/firebase-tools.json` and
  writes a temporary Application Default Credentials file
  (`temp_adc.json`) to authenticate — this is a real production-credential
  access path with no emulator option at all. Phase 2A requires removing
  that pattern entirely for the emulator-only version of this script:
  require `FIRESTORE_EMULATOR_HOST`, accept explicit project/teacher/
  classroom inputs, never read the Firebase CLI's cached token, never write
  a temporary ADC file, and never print PIN hashes or other credential
  secrets to console output.
- **`functions/scripts/seedTestStudent.js`**: today hardcodes `CLASSROOM_ID
  = 'morgan'` and the production project ID with no emulator guard. Phase
  2A requires the same treatment: emulator-only, explicit inputs, no
  hardcoded production project, and Version 2 ownership/path awareness
  (able to seed under a generated `classroomId`, not just the literal
  `"morgan"`).
- All three gain explicit tests for their argument parsing and safety
  guards (e.g., "refuses to run without `FIRESTORE_EMULATOR_HOST`," "rejects
  a missing required flag").

**`functions/scripts/listAuthUsers.js`** uses the same cached-refresh-token/
temp-ADC pattern as `checkStudent.js` today. It is explicitly kept **outside
Phase 2A scope** (it lists Auth users, which has nothing to do with a
Firestore-only migration), but is recorded here as a **later
security-cleanup candidate** for whenever Auth-related work is actually
undertaken (Phase 2B or later), precisely because it shares the same
credential-handling pattern being removed from the other three scripts.

#### Rules-baseline section (corrected)

An earlier draft of this document stated that no Firestore rules tests
exist. That was already false when written and remains false now: the
baseline suite exists today at `tests/firestore/rules.baseline.test.js`
(see also `tests/firestore/README.md`), runs via `npm run test:rules`
(`firebase emulators:exec --project morgan-bank --only firestore "node
--test tests/firestore"`, per the root `package.json`), and already covers
the teacher/unauthorized-user/student/unauthenticated-user matrix against
the **current checked-in** `firestore.rules` — whether that exact file is
what's currently deployed to production is unknown and not something this
document infers; "current checked-in" is used throughout this section
instead of "deployed" or "production" for that reason.

Phase 2A's only change to this area is **additive**: new assertions in that
same existing suite covering the Phase 1 `teachers/{uid}` and
`classrooms/{classroomId}` documents, evaluated against **today's unmodified
checked-in `firestore.rules`** — not a blanket "both default-deny for every
actor" claim, since the two collections behave differently under the actual
rule text:

- `teachers/{uid}` has **no matching rule at all** in the current
  checked-in `firestore.rules`, so it is denied to every actor with no
  exception: the hardcoded teacher, an unauthorized authenticated user, a
  student-claim token, and an unauthenticated user must all be asserted
  denied.
- `classrooms/{generatedClassroomId}` (a Phase 1-style classroom document,
  keyed by a generated ID rather than the legacy literal `"morgan"`) **is**
  covered by the existing `match /classrooms/{document=**} { allow read,
  write: if isTeacher(); }` rule — this grants the current hardcoded
  `TEACHER_UID` full read/write on it today, exactly as it does for the
  legacy `classrooms/morgan/**` subtree, because the rule matches on any
  document under `classrooms/**` with no per-classroom scoping. The planned
  assertions must reflect this accurately: the hardcoded teacher **can**
  read/write it; an unauthorized authenticated user, a student-claim token,
  and an unauthenticated user are all denied, per the existing rule.
- The existing student-specific rule (`match
  /classrooms/{classroomId}/students/{studentId} { allow read: if
  isStudent(classroomId, studentId); }`) is unaffected by either addition
  above and remains covered by its own already-existing assertions in the
  baseline suite — Phase 2A does not change or duplicate that coverage.

`firestore.rules` itself remains completely unchanged by Phase 2A; the new
assertions describe today's checked-in rule behavior, they don't add new
authorization logic. This is precisely why the `classrooms/{document=**}`
assertion must show the hardcoded teacher *succeeding*, not being denied —
asserting a blanket default-deny there would describe rules Phase 2A never
writes, not the rules that actually exist.

#### Proposed files and module boundaries

```
functions/phase2/
  README.md                          — module map and invariants (this section, condensed)
  emulatorEnvironment.js             — FIRESTORE_EMULATOR_HOST guard; refuses to load without it
  cli.js                             — argument parsing only; allowlists teacher/project/write and rejects
                                        --manifest plus every state-directory/filename override; no Firestore access
  firestoreDocumentId.js             — shared document-ID validation (students/transactions/login-history)
  canonicalState.js                  — canonical JSON serialization + hashing (checksums, invariant hashes),
                                        plus the recursive, collision-safe, lossless Firestore Timestamp
                                        value encoding owned by the normative Item 5 clarification
  manifestSlot.js                    — owns migration ID/schema version and module-anchored .state directory;
                                        deterministically derives/displays the non-overridable canonical slot
                                        from emulator project ID + teacher UID, independent of process.cwd()
  sourceReader.js                    — paginated reads of legacy morganBank/studentCredentials/studentAuthLogs; read-only
  foundationValidator.js             — independent, read-only Phase 1 foundation validator (no provisioner reuse)
  projection.js                      — pure functions: legacy record -> destination body (student allowlist, credential/log transforms)
  destinationPreflight.js            — reads + classifies every destination per "Preflight classification"; builds the ordered operation plan
  reconciliation.js                  — dry-run and write-run reconciliation checks
  manifest.js                        — versioned manifest read/write in the canonical slot, strict validation
                                        of encoded Firestore-derived preconditions/preimages, atomic durability,
                                        monotonic writePhaseStarted, and state-machine/recovery transitions
  batchWriter.js                     — the ONLY module that may perform migration DESTINATION writes (see invariant below)
  migrateClassroomData.js            — orchestrates: derive and inspect the canonical slot FIRST; recover/block
                                        retained writePhaseStarted state, reverify completed state, or explicitly
                                        replace only failed + writePhaseStarted:false after full new-run validation;
                                        that sole replacement path recalculates corrected current state and leaves
                                        the old failed manifest intact if new validation does not pass;
                                        only when the canonical-slot rules allow does it validate source -> plan ->
                                        manifest -> (write mode: batchWriter) -> reconcile.
                                        "validate -> plan -> manifest" is the fresh-run path, not the only path —
                                        see "Student credentials" and "Preflight classification" in Part 2
  run.js                             — CLI entry point; wires cli.js + emulatorEnvironment.js + manifestSlot.js +
                                        migrateClassroomData.js and displays the resolved canonical path
  rehearsalFixture.js                — synthetic legacy-data fixture builder (see "Synthetic fixture and rehearsal procedure")
  seedRehearsal.js                   — rehearsal SETUP script; an explicitly isolated exception to the read-only
                                        invariant below — seeds synthetic legacy fixture data and calls
                                        provisionTeacherClassroom BEFORE the migration runtime starts (see invariant below)
  *.test.js                          — unit tests colocated per module above

tests/migration/
  migration.emulator.test.js         — end-to-end emulator rehearsal test (the 21-step procedure above)
```

Modified diagnostic scripts and their new tests:
- `functions/scripts/checkData.js`, `functions/scripts/checkData.test.js`
- `functions/scripts/checkStudent.js`, `functions/scripts/checkStudent.test.js`
- `functions/scripts/seedTestStudent.js`, `functions/scripts/seedTestStudent.test.js`

Modified existing baseline and documentation:
- `.gitignore` (Phase 2A implementation adds the exact
  `functions/phase2/.state/` entry; no broad `**/.state/` rule and no
  `.gitkeep` inside the runtime state directory)
- `tests/firestore/rules.baseline.test.js` (additive `teachers`/`classrooms`
  assertions per "Rules-baseline section (corrected)" — not a uniform
  default-deny claim, since the hardcoded teacher can read/write
  `classrooms/{generatedClassroomId}` under the existing rule)
- `tests/firestore/README.md` (documents the additive assertions)
- `package.json` (new explicit emulator-test/rehearsal npm scripts,
  alongside the existing `test:rules`/`test:functions`/`test:all`)
- `MULTI_TEACHER_ARCHITECTURE_PLAN.md` (this document)

**Module boundary invariant (corrected)**: within the migration runtime
itself, only `batchWriter.js` may perform migration **destination** writes
— every other runtime module (`sourceReader.js`, `foundationValidator.js`,
`projection.js`, `destinationPreflight.js`, `reconciliation.js`, and
`manifest.js`'s own read paths) is read-only with respect to migration
destinations. `manifest.js` is a narrow, explicitly-scoped exception to
"read-only" in one sense — it does write the manifest *file* to disk — but
it never writes to Firestore itself; that distinction is what "migration
destination writes" means here.

**Rehearsal setup is a separate, explicitly isolated exception, not a
violation of the above**: `seedRehearsal.js` necessarily writes synthetic
legacy fixture data and calls `provisionTeacherClassroom` (which itself
writes the Phase 1 foundation) — but it does so entirely *before* the
migration begins, as one-time rehearsal setup, not as part of the migration
runtime's own execution. All such fixture/foundation setup writes must
complete before dry-run/preflight starts; nothing in `seedRehearsal.js` runs
concurrently with, or is called by, `migrateClassroomData.js` or any module
it invokes.

`functions/scripts/seedTestStudent.js` (an existing diagnostic script,
hardened per "Diagnostic-script requirements" above) sits **outside the
migration-runtime boundary entirely** — it is not part of
`functions/phase2/` and is not invoked by any migration module. It remains
its own emulator-only tool, unrelated to the migration's read/write
boundary.

`foundationValidator.js` in particular must never import or call anything
from `functions/phase1/teacherClassroomProvisioner.js`, to preserve the
"independent validator" requirement — this is unaffected by the
rehearsal-setup exception above, since `seedRehearsal.js` (not
`foundationValidator.js`) is what calls the provisioner, and only before
the migration runtime starts.

#### Small commit sequence

No implementation commit is authorized by this document. If and when
implementation is separately authorized, the recommended sequence is:

1. This corrected, normative architecture document only.
2. `emulatorEnvironment.js`, `cli.js`, `firestoreDocumentId.js`,
   `canonicalState.js`, `manifestSlot.js`, their unit tests, and the
   repository-root `.gitignore` entry `functions/phase2/.state/` — no
   Firestore access at all. This commit also proves a representative
   manifest path is ignored, adds no `.gitkeep`, and establishes that runtime
   state is retained as an audit/recovery journal rather than auto-deleted.
3. `sourceReader.js` and `foundationValidator.js`, with tests — read-only
   Firestore access, still no writer.
4. `projection.js` and `reconciliation.js`, with tests, exercised against
   fixtures rather than a live emulator where practical.
5. Additive `canonicalState.js`/`canonicalState.test.js` Firestore-value
   encoding from the normative Item 5 clarification above — without changing
   the existing JSON-only serializer/hash outputs or `manifestSlot.js`
   filenames — plus `manifest.js` (versioned schema, canonical-slot durable
   writes, monotonic `writePhaseStarted`, strict encoded-value validation,
   and state machine), with exact Timestamp-round-trip and
   crash/restart-simulation tests. No new codec module is added.
6. `destinationPreflight.js` (complete preflight classification), with
   tests — still no writer module exists yet.
7. `batchWriter.js` (create/update preconditions, operation/size ceilings,
   explicit no-delete assertions, injected-failure tests for the
   indeterminate-recovery path).
8. `migrateClassroomData.js` and `run.js` (canonical-slot-first orchestration
   + CLI integration tests, including override rejection, lifecycle, and
   exit-code coverage).
9. `rehearsalFixture.js`, `seedRehearsal.js`, and the
   `tests/migration/migration.emulator.test.js` end-to-end rehearsal.
10. Diagnostic-script hardening — one reviewable commit per script
    (`checkData.js`, `checkStudent.js`, `seedTestStudent.js`).
11. The additive `tests/firestore/rules.baseline.test.js` assertions and
    documentation update.

### Rollback strategy

Because `morganBank/classroomData` is deliberately **not touched or
deleted** by the Phase 2A migration, and because the migration only ever
adds new documents or updates two specific fields on the pre-existing
classroom root plus one field on each credential document, rollback at any
point in Phase 2A rehearsal is low-risk and manifest-driven:

- **If the migration produced bad data in the emulator:** use the
  manifest's `rollbackPreimage` entries to manually restore `settings` and
  `lastBackupAt` on the classroom root, and delete the specific
  newly-created `students`/`transactions`/`loginHistory`/`studentAuthLogs`
  documents the manifest lists as `committed`/`verified` — never delete the
  pre-existing `teachers/{teacherUid}` or `classrooms/{classroomId}`
  documents themselves, since those are the Phase 1 foundation, not
  migration output.
- **`studentCredentials` rollback** is a single-field revert per document
  (`classroomId` back to `"morgan"`) using the manifest's recorded old/new
  values and update-time precondition — never a document delete, since the
  credential documents themselves predate the migration.
- There is no automated rollback executable to invoke; this is a documented
  manual procedure an operator follows using the manifest as the source of
  truth, consistent with "Manifest durability procedure" above.
- This rehearsal-scope rollback strategy is necessarily incomplete for a
  real production cutover (e.g., it says nothing about rolling back
  `firestore.rules` or Hosting) — that is intentional, since Phase 2A never
  touches production. A production rollback runbook is Phase 3 scope, once
  the rules rewrite and client cutover it must cover actually exist — see
  "Implementation phases" for the explicit Phase 3 requirements this
  implies.

### Testing strategy

1. **Firestore Rules Unit Tests** — an existing suite, not a gap. It runs
   today at `tests/firestore/rules.baseline.test.js` via `npm run
   test:rules`, against the **current checked-in** `firestore.rules`
   (deployment state unknown — see "Rules-baseline section (corrected)"),
   and already covers:
   - The hardcoded-`TEACHER_UID` teacher's read/write access to
     `morganBank/classroomData` and the `classrooms/morgan/students/*`
     mirror, and read access to `studentAuthLogs`.
   - An unauthorized authenticated user denied on all of the above plus
     `studentCredentials`.
   - A student-claim token restricted to only its own
     `classrooms/{classroomId}/students/{studentId}` document, denied
     everywhere else (other students, other classrooms, writes,
     `studentAuthLogs`, `studentCredentials`).
   - An unauthenticated user denied everywhere.
   Phase 2A's only change here is additive, per "Rules-baseline section
   (corrected)" above: `teachers/{uid}` denied to every actor (no matching
   rule exists), and `classrooms/{generatedClassroomId}` allowed to the
   hardcoded teacher but denied to an unauthorized authenticated user, a
   student-claim token, and an unauthenticated user — per the existing
   `isTeacher()`-gated `classrooms/{document=**}` rule, which already
   covers any document under that path today, not a new default-deny rule.
   The existing student-specific rule keeps its own separate, already-
   existing coverage, unchanged. The full ownership-based rewrite of these
   rules (`isOwner()`, `get()`-based lookups) remains Phase 3 scope, not
   built or tested yet.
2. **Cloud Functions unit tests** (extending the existing
   `resetStudentPin.test.js` / `studentCredentialVerifier.test.js` /
   `functions/phase1/*.test.js` patterns) — Phase 3+ scope, listed here for
   continuity with the original plan, not part of Phase 2A's deliverable:
   - `resetStudentPin` denies a teacher who doesn't own the target
     classroom.
   - `syncStudentProfiles` correctly derives `classroomId` from the
     triggering path for at least two different classroom IDs (regression
     test against the old hardcoded-`'morgan'` bug class).
   - A **general**, any-teacher onboarding callable (the Phase 2B+
     generalization of the already-implemented, single-teacher-restricted
     `ensureTeacherClassroom` — see "New teacher onboarding flow") is
     idempotent and never leaves a `teachers` doc pointing at a
     nonexistent classroom. Both `provisionTeacherClassroom`
     (`functions/phase1/teacherClassroomProvisioner.test.js`) and the
     existing `ensureTeacherClassroom` callable wrapper already have test
     coverage today for their current, single-teacher-restricted behavior;
     this item is specifically about the *generalized*, multi-teacher
     version Phase 2B+ would add.
3. **Migration script reconciliation test (Phase 2A, Firestore emulator
   only — never production, no Auth or Functions emulator required)**:
   the full "Reconciliation requirements" and "Synthetic fixture and
   rehearsal procedure" sections above constitute this test's specification
   in detail. In summary, it must prove:
   - The independent validator rejects every one of its documented failure
     conditions and performs zero writes in every case.
   - The literal `"morgan"` never appears as a V2 `classroomId` anywhere in
     the destination tree.
   - The classroom root's immutable fields are byte-for-byte unchanged;
     only `settings` and `lastBackupAt` differ.
   - Destination student documents' key sets are exactly the five
     allowlisted fields, even when the legacy fixture includes PINs,
     `loginId`, `credentialActive`, or unknown fields.
   - Document-ID validation rejects every category in its list, with
     correctly detailed error reporting.
   - All `studentCredentials` states (active, inactive, orphaned) survive
     migration with only `classroomId` changed; orphaned ones are both
     migrated and separately reported.
   - `studentAuthLogs` destination documents never contain a `classroomId`
     field; a non-`"morgan"`, non-missing embedded `classroomId` blocks the
     run; original flat log documents are unmodified.
   - Preflight classification correctly distinguishes `planned` /
     `skipped_identical` / blocking-divergent for all three operation
     types, including re-running against an already-migrated destination.
   - Canonical-slot derivation returns the same path for the same migration
     version/project/teacher identity from different current working
     directories, and different paths for different project or teacher
     identities. The CLI rejects `--manifest` and every state-directory or
     filename override before Firestore access.
   - An unresolved canonical manifest cannot be bypassed by selecting another
     filename. Classroom identity, immutable-source, foundation-invariant, or
     plan drift against `planned`, `writePhaseStarted === true`, or
     `completed` retained state still discovers the manifest and blocks
     instead of creating a new run.
   - A zero-write `failed` manifest with `writePhaseStarted === false` may be
     replaced only in the same canonical slot when it is readable,
     well-formed, and fixed-identity-matching. Replacement reruns the complete
     brand-new validation, including credential `classroomId === "morgan"`,
     and permits corrected source/foundation/classroom/plan state to produce
     new checksums, projections, preconditions, batches, plan, and `runId`.
     Tests cover a changed immutable-source checksum after source correction,
     a corrected foundation, and a new validation failure leaving the old
     manifest intact. Malformed, unreadable, and fixed-identity-mismatched
     files block. A manifest with `writePhaseStarted === true` cannot be
     replaced even if every current batch state is `pending`.
   - A crash after `writePhaseStarted` becomes true but before the first
     Firestore commit recovers the same manifest, and no state-machine or
     recovery transition ever changes the flag back to false.
   - Re-running write mode twice against the same emulator state
     (idempotency) produces no duplicate documents and no double-application
     of any update; a completed manifest is read-only/reverification-only and
     never reapplies writes.
   - A simulated crash between batch commit and manifest verification,
     followed by a restart, recovers via the before-state/after-state/
     mixed/divergent classification and reaches the same terminal state as
     an uninterrupted run — including the mixed case requiring
     operation-by-operation recovery (with fresh preconditions for
     still-before-state operations) and the divergent case blocking for
     human review, not a whole-batch retry.
   - A dry-run (no `--write`) followed by inspecting the emulator confirms
     zero Firestore writes occurred; its canonical manifest is only a local
     state file.
   - The repository-root `.gitignore` contains the exact
     `functions/phase2/.state/` entry, a representative manifest underneath it
     passes an equivalent of `git check-ignore`, no broad `**/.state/` rule or
     `.gitkeep` is introduced, and runtime manifests are never automatically
     deleted. Test cleanup is restricted to isolated disposable test state.
   - Batch splitting respects the 400-operation/8-MiB thresholds and
     preserves deterministic order; a single oversized operation blocks
     rather than silently splitting.
   - No secret material appears in manifest or console output at any point.
   Any mismatch or missing proof is a blocking failure, not a warning.
4. **Manual end-to-end acceptance tests in staging (Phase 3+ scope)**,
   mirroring the rigor of `GOOGLE_AUTH_PHASE1_CHECKLIST.md` §8 — listed here
   for continuity with the original plan; these require the rules rewrite
   and client cutover that Phase 2A deliberately does not build:
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
     `classrooms/{first-teacher-classroomId}/...` while signed in as the
     second teacher) is denied by rules, not just hidden by the UI.
5. **Regression pass on everything V1 already covers** (Phase 3+ scope):
   CSV export, transaction history rendering, PIN reset UI, student
   request/approval flow — all must continue working against the new data
   shape.

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

**Phase 0 — Foundations (complete in the local repository)**
- This architecture document (current deliverable).
- Firestore Rules Unit Testing harness and emulator config, committed and
  running today (`tests/firestore/rules.baseline.test.js`, `npm run
  test:rules`) — tests *against the current checked-in `firestore.rules`*
  (whether that exact file is deployed to production is unknown and not
  inferred here), as a baseline. Not a future to-do; see "Rules-baseline
  section (corrected)" in Part 2. This baseline evolves alongside the new
  ownership-based rules in Phase 3, and gains Phase 1 teacher/classroom
  assertions (reflecting the actual, non-uniform current rule behavior —
  `teachers/{uid}` denied to everyone, `classrooms/{document=**}` allowed
  to the hardcoded teacher) in Phase 2A.

**Phase 1 — Teacher & classroom data model, additive only (Phase 1B
complete in the local repository, including a single-teacher-restricted
callable; general multi-teacher onboarding is Phase 2B+ scope)**
- `teachers/{uid}` and `classrooms/{classroomId}` document shapes, the
  server-only, transactional `provisionTeacherClassroom` helper
  (`functions/phase1/teacherClassroomProvisioner.js`), **and** the
  `ensureTeacherClassroom` callable that wraps it
  (`functions/phase1/ensureTeacherClassroom.js`, exported from
  `functions/index.js`, invoked by `index.html` after sign-in) are all
  implemented and tested in the local `feature/multi-teacher` commit today.
  That callable is restricted to the existing hardcoded `TEACHER_UID` and a
  fixed classroom name — it is **not** the future general multi-teacher
  onboarding flow. A callable any newly signed-in teacher can use to create
  their *own*, arbitrarily-named classroom remains unbuilt and is Phase
  2B+ scope — see "New teacher onboarding flow" in Part 2 for the corrected
  status of that work.
- No changes yet to `morganBank/classroomData`, existing rules, or the
  client's read/write path — purely additive, verified inert before
  anything depends on it. **Whether this local commit has been deployed to
  production is unknown and must not be inferred from the repository.**

**Phase 2A — Migration tooling + Firestore-emulator rehearsal (fully
specified — see Part 2, "Data migration strategy")**
- Build the independent, strictly read-only foundation validator; the
  shared document-ID validator; the projection logic for students,
  transactions, login history, credentials, and auth logs; the
  operation-specific preflight classifier; the versioned, restart-safe
  manifest; the batch writer; and the CLI — per the exact module inventory,
  CLI contract, manifest schema, and commit sequence specified in Part 2.
- Rehearse entirely against the Firestore emulator per the 21-step
  rehearsal procedure in Part 2, seeded via `provisionTeacherClassroom` for
  the Phase 1 foundation. Firestore-only emulation is sufficient — no Auth
  or Functions emulator is needed, since the tooling never touches either.
- Harden `checkData.js`, `checkStudent.js`, and `seedTestStudent.js` per
  "Diagnostic-script requirements" in Part 2 (emulator-only, no cached
  Firebase-CLI-token/temp-ADC reads, no hardcoded production project).
- Do **not** run against production. No production override path exists in
  the tooling at all.
- **No implementation commit for any of the above is authorized by this
  document.** Per the "Small commit sequence" in Part 2, the first
  authorized commit is this corrected architecture document alone, and
  further implementation commits require this document to pass another
  independent review first.

**Phase 2B — Broader cutover readiness (mandatory follow-up, not yet
designed)**
- Everything Phase 2A intentionally defers: generalizing
  `ensureTeacherClassroom` beyond its current single-hardcoded-teacher
  restriction into a real multi-teacher onboarding callable, plus
  emulator-backed validation of that generalized flow's ownership/isolation
  guarantees (distinct from Phase 5's real-account onboarding of an actual
  second teacher), Cloud Functions changes (`syncStudentProfiles`,
  `resetStudentPin`, `studentCredentialVerifier`) needed for
  multi-classroom operation, Auth-side changes and Auth-emulator-backed
  testing, credential-collision handling at the product/UX level (beyond
  the migration's data-level parity), and browser account-switch/cache
  safety (e.g., the
  `mrMorganClassCashDataV5` localStorage-namespacing gap flagged in
  `PHASE1_IMPLEMENTATION_CHECKLIST.md` item 1).
- This phase is a **mandatory prerequisite for Phase 3** — the rules
  rewrite and client cutover cannot be safely designed until Phase 2B has
  resolved how Functions, Auth, and the browser client behave across
  multiple classrooms. It is called out here as a required follow-up; its
  detailed design is explicitly out of scope for this revision and should
  get its own planning pass before Phase 3 begins.

**Phase 3 — Rules rewrite + client cutover (single coordinated release)**
- New ownership-based `firestore.rules`, deployed together with the updated
  client that reads/writes `classrooms/{classroomId}` instead of
  `morganBank/classroomData`, and the updated `syncStudentProfiles`/
  `resetStudentPin` functions.
- **Phase 2A's tooling is emulator-only by construction (it hard-refuses to
  run without `FIRESTORE_EMULATOR_HOST` and has no production override
  path) and proves the migration *logic* only — it does not authorize and
  cannot itself provide a production execution path.** Running it
  unchanged against production is explicitly **not** the plan. Before any
  production migration run, Phase 3 must separately produce:
  - A **separately reviewed production adaptation or runner** — not the
    Phase 2A emulator-guarded CLI invoked with a different project ID, but
    a distinct, independently reviewed execution path built for production
    use, since Phase 2A's design (manifest, checksums, batch limits) proves
    the algorithm, not a production-safe deployment of it.
  - **Explicit production authorization** as a separate, deliberate step —
    not a flag on the Phase 2A CLI.
  - **Production project identity safeguards** (e.g., confirming the target
    project ID against an allowlist, distinct from Phase 2A's emulator
    project ID checks).
  - A **production export/snapshot or write-freeze strategy** covering the
    live `morganBank/classroomData`, `studentCredentials`, and
    `studentAuthLogs` collections before the run.
  - A **production rollback runbook** — the manifest-driven manual
    procedure in Part 2's "Rollback strategy" is scoped to emulator
    rehearsal only and explicitly does not cover `firestore.rules` or
    Hosting rollback.
  - **Revalidation of every Phase 2A assumption against real production
    state** (document counts, field shapes, credential states) before
    trusting the rehearsed plan against production data, since production
    data may have drifted from what Phase 2A's synthetic fixture models.
  - **Coordinated migration, rules, Functions, and client cutover
    ordering** — the migration run, the rules deploy, and the client deploy
    must happen in the safe sequence Part 2 already establishes (migrate
    first, flip rules and client together second), not independently.
- This is the only phase that touches production data or rules — everything
  before it (2A, 2B) is additive/inert/tooling-only, everything after it is
  verification/rollback readiness.

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

### Genuine remaining blockers

These are open questions this document does not resolve, listed so they
aren't mistaken for settled decisions:

- **Phase 2B has no detailed design yet.** It is named and scoped at a
  high level ("New teacher onboarding flow," "Implementation phases" above)
  but its Functions/Auth/general-multi-teacher-onboarding-UX/
  credential-collision/browser-cache design is genuinely not written down
  anywhere — this is specifically about *generalizing*
  `ensureTeacherClassroom` beyond its current single-hardcoded-teacher
  restriction, not about building onboarding from scratch. Phase 3 cannot
  start until it exists.
- **Production deployment state is unknown to this document by design** —
  per the task constraints this revision was written under, production
  state must not be inferred from the local repository. Phase 1B is
  committed locally but its actual production deployment status is not
  something this document can or should assert.
- **The production adaptation runner named in Phase 3 does not exist.**
  Phase 2A's tooling deliberately cannot run against production; something
  else has to, and that something is unbuilt and unreviewed.
- **The exact conservative per-write overhead allowance** for batch-size
  estimation (see "Batch safety" in Part 2) is a documented policy this
  plan requires but does not itself compute a number for — that requires
  either empirical measurement against the Firestore emulator or a
  cited platform figure, not an invented constant.
- **Whether `syncStudentProfiles`' existing mirror-write behavior should be
  imported as a shared function** rather than re-implemented in
  `projection.js` (see "Proposed files and module boundaries") is an open
  implementation-time judgment call, not resolved here — re-implementing
  keeps Phase 2A's module free of a runtime dependency on
  `functions/syncStudentProfiles.js`, but risks drift if that file's mirror
  logic changes later without a corresponding update here.

**No implementation commit for Phase 2A (or any later phase) is authorized
by this document.** This revision itself is the only thing authorized to be
committed, and only after it passes another independent review — see
"Small commit sequence" in Part 2.

---

*This document is planning output only. Per the project's stated
development philosophy (`VERSION.md`), nothing here should be implemented
until explicitly requested, and implementation should proceed phase-by-phase
with verification at each step rather than as one large change.*
