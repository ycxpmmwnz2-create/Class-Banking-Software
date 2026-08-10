# Morgan Bank Version 2 — Phase 1 Implementation Checklist

## Audit scope and counting convention

- [ ] Treat this as an implementation inventory, not authorization to change production code, Firestore data, Firebase rules, deployment state, or git history.
- [ ] Reconfirm the Version 2 scope before implementation: this repository currently has both global single-classroom assumptions and a proposed Version 2 design that intentionally allows one classroom per teacher.
- [ ] Each numbered item below is counted as one location. Adjacent lines or repeated call sites in the same function are grouped when they implement the same assumption.
- [ ] Firebase project identifiers such as `morgan-bank`, package names, lockfiles, and historical changelog entries are not counted by themselves. They name the product/project, not a classroom tenant. Teacher-specific UI copy is counted because it affects the multi-teacher experience.

## Application and UI (`index.html`)

### 1. Fixed browser-storage namespace

--------------------------------------------------

**Location**  
`index.html`, approximately lines 757, 876, and 886

**Current behavior**  
All classroom fallback data is stored under the single key `mrMorganClassCashDataV5`. Every teacher session in the same browser reads and writes the same cached blob.

**Why it will need to change**  
The key must be scoped by the resolved classroom ID (and preferably by environment/schema version). Otherwise a shared browser can display or overwrite another teacher's cached classroom, especially when a Firestore read fails and `loadData()` silently falls back to local storage.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 2. Hardcoded teacher UID constant

--------------------------------------------------

**Location**  
`index.html`, approximately line 758

**Current behavior**  
`TEACHER_UID` contains the only UID recognized as a teacher by the client.

**Why it will need to change**  
Teacher status must come from an authoritative teacher/profile or classroom-ownership record. Adding more UID literals would not create tenant isolation and would make authorization drift across the client, rules, and Cloud Functions likely.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 3. One global classroom data object

--------------------------------------------------

**Location**  
`index.html`, approximately lines 759-850

**Current behavior**  
`defaultData` and the module-level `data` variable hold one roster, one embedded transaction array, one login-history array, and one settings object. No `teacherUid` or `classroomId` is part of the state.

**Why it will need to change**  
The application needs an explicit authenticated teacher profile and current classroom context before data is loaded or mutated. The embedded all-history arrays also make the singleton document a size and write-contention risk.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 4. Global session and navigation state has no tenant context

--------------------------------------------------

**Location**  
`index.html`, approximately lines 807-820

**Current behavior**  
Authentication, screen, selected student, logs, and PIN-reset state are module-level globals. There is no `currentTeacher`, `currentClassroomId`, profile-loading state, onboarding state, or tenant-change reset path.

**Why it will need to change**  
All asynchronous loads and writes must be tied to the authenticated user's resolved classroom. Tenant state must be cleared atomically on auth changes so stale data cannot survive account switching or delayed promises.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 5. Secure-student view expects one mirrored document shape

--------------------------------------------------

**Location**  
`index.html`, approximately lines 853-863

**Current behavior**  
`dataForSecureStudent()` reconstructs the global data blob from one mirrored student document and expects all of that student's transactions to be embedded in `profile.transactions`.

**Why it will need to change**  
If Version 2 promotes students and transactions to classroom subcollections, the student view needs classroom-scoped reads and a defined loading strategy for transaction history rather than assuming one preassembled mirror document.

**Recommended Phase:** Phase 3

**Risk:** Medium

--------------------------------------------------

### 6. Client teacher guard checks the one UID

--------------------------------------------------

**Location**  
`index.html`, approximately lines 822-828

**Current behavior**  
`requireTeacher()` allows actions only when `isTeacher` is true and the current Firebase Auth UID equals `TEACHER_UID`.

**Why it will need to change**  
The guard must require a loaded, active teacher profile and resolved classroom ownership. It remains only a UI guard; Firestore rules and callable functions must independently enforce the same ownership contract.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 7. Classroom load uses the singleton Firestore document

--------------------------------------------------

**Location**  
`index.html`, approximately lines 866-883

**Current behavior**  
`loadData()` always reads `morganBank/classroomData`, then silently falls back to the one local-storage blob.

**Why it will need to change**  
The teacher's classroom ID must be resolved before loading, and the read must target that classroom's documents/subcollections. Error handling must not substitute data belonging to a previously signed-in teacher.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 8. Classroom save overwrites the singleton Firestore document

--------------------------------------------------

**Location**  
`index.html`, approximately lines 885-893

**Current behavior**  
`saveData()` writes the entire in-memory object to both the fixed local-storage key and `morganBank/classroomData` using `setDoc()`.

**Why it will need to change**  
Writes must be scoped to the current classroom and split by domain record where the Version 2 schema requires it. A full-document last-writer-wins save can lose concurrent changes and, if the tenant context is stale, overwrite the wrong classroom.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 9. Student-auth log screen queries a global collection

--------------------------------------------------

**Location**  
`index.html`, approximately lines 1030-1044

**Current behavior**  
`openStudentAuthLogs()` reads the newest 25 documents from the top-level `studentAuthLogs` collection without a classroom path or filter.

**Why it will need to change**  
The query must use the authenticated teacher's classroom and a rules-enforceable path/query shape. Otherwise any newly recognized teacher could see every classroom's login attempts.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 10. Student profile sync-status check hardcodes `morgan`

--------------------------------------------------

**Location**  
`index.html`, approximately lines 1110-1124

**Current behavior**  
`viewStudentProfile()` reads `classrooms/morgan/students/{studentId}`.

**Why it will need to change**  
The path must use the teacher's resolved classroom ID. The current path would show incorrect sync status or probe another classroom after a second teacher is added.

**Recommended Phase:** Phase 3

**Risk:** Medium

--------------------------------------------------

### 11. Profile PIN reset sends `classroomId: "morgan"`

--------------------------------------------------

**Location**  
`index.html`, approximately lines 1137-1167

**Current behavior**  
`resetProfileStudentPin()` always asks the callable function to reset a student in the `morgan` classroom.

**Why it will need to change**  
The client must send the resolved classroom ID, and the server must verify that the caller owns that classroom. Client-supplied tenant IDs cannot be trusted as authorization.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 12. Teacher sign-in has no teacher-profile or onboarding resolution

--------------------------------------------------

**Location**  
`index.html`, approximately lines 1277-1335

**Current behavior**  
Email/password and Google sign-in authenticate a Firebase user, but the flow has no step to load an existing teacher profile, determine status/ownership, or create a new teacher/classroom safely.

**Why it will need to change**  
Version 2 needs a server-controlled distinction among existing teachers, invited/allowed new teachers, disabled teachers, and ordinary authenticated Google users. First-time classroom creation must be idempotent and must not be available merely because a Google sign-in succeeded.

**Recommended Phase:** Phase 1

**Risk:** High

--------------------------------------------------

### 13. Student login has no classroom context and assumes globally unique login IDs

--------------------------------------------------

**Location**  
`index.html`, approximately lines 1337-1368

**Current behavior**  
The student submits only `loginId` and PIN. No classroom code, classroom ID, teacher code, or other tenant discriminator is sent.

**Why it will need to change**  
Either login IDs must be guaranteed globally unique across all classrooms or the login request must include a safe classroom discriminator. This decision must match the credential document key, enumeration protections, and invalid-attempt logging design.

**Recommended Phase:** Phase 1

**Risk:** High

--------------------------------------------------

### 14. Student-originated transactions use the singleton save path

--------------------------------------------------

**Location**  
`index.html`, approximately lines 1515-1627 and 2079-2165

**Current behavior**  
Student requests and purchases mutate the local `data.transactions` array and call `saveData()`, which targets the teacher-only singleton document. Secure students do not have rule permission to write that document, so persistence depends on local state and failed writes.

**Why it will need to change**  
Student writes need an explicit classroom-scoped, rules-protected document path or a callable transaction service. The server/rules must validate student claims, amount/status transitions, and classroom ownership without trusting the client blob.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 15. Account activation call sites hardcode `morgan`

--------------------------------------------------

**Location**  
`index.html`, approximately lines 1741-1815

**Current behavior**  
Both `activateStudent()` and `bulkActivateStudents()` send `classroomId: "morgan"` to `resetStudentPin`.

**Why it will need to change**  
Both paths must use the current classroom and rely on server-side ownership checks. Bulk activation must also prevent a tenant change during the asynchronous loop.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 16. Class-wide settings and destructive actions operate on one implicit classroom

--------------------------------------------------

**Location**  
`index.html`, approximately lines 1888-1963

**Current behavior**  
Settings updates, clearing all transactions, resetting every balance, and resetting everything mutate the one global blob. The confirmation copy does not identify which classroom will be affected.

**Why it will need to change**  
Every class-wide action must be bound to the resolved classroom, display that classroom's identity, and revalidate ownership immediately before the write. Destructive operations should not be able to run against stale tenant state.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 17. Backup import/export has no classroom identity

--------------------------------------------------

**Location**  
`index.html`, approximately lines 1966-2017

**Current behavior**  
Backup files contain roster, transactions, login history, and settings but no classroom ID, owner UID, schema version, or source environment. Import replaces the current global data object and saves it to the singleton path.

**Why it will need to change**  
Backups must carry verifiable schema and classroom metadata, and importing should require an explicit target-classroom confirmation. Without safeguards, a teacher can restore one classroom's full data into another.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 18. Main UI has no classroom identity or onboarding state

--------------------------------------------------

**Location**  
`index.html`, approximately lines 2261-2904

**Current behavior**  
The header, dashboard, navigation, settings, roster, credentials, and logs screens assume that signing in as the teacher implies one known classroom. There is no visible classroom name/ID, ownership state, loading boundary, or new-teacher onboarding screen.

**Why it will need to change**  
Teachers need clear confirmation of the active classroom, and the UI must handle profile loading, no classroom yet, disabled access, initialization errors, and successful classroom creation without rendering stale data.

**Recommended Phase:** Phase 3

**Risk:** Medium

--------------------------------------------------

### 19. Teacher-specific product copy is hardcoded throughout the UI

--------------------------------------------------

**Location**  
`index.html`, approximately lines 7, 1329, 1522, 1588, 1607, 2084, 2126, 2288, 2548, 2849, 2863, 2934, and 2945

**Current behavior**  
The title, headings, help/error messages, printable roster, and student prompts name “Mr. Morgan” or “Morgan Bank” as the one teacher/bank.

**Why it will need to change**  
Teacher-facing and student-facing copy should use product-level branding plus the current teacher/classroom display name where appropriate. Printed/exported artifacts also need tenant identity.

**Recommended Phase:** Phase 5

**Risk:** Low

--------------------------------------------------

### 20. Auth observer recognizes one teacher and one student classroom

--------------------------------------------------

**Location**  
`index.html`, approximately lines 2907-2967

**Current behavior**  
The teacher branch is selected only when `user.uid === TEACHER_UID`. The student branch accepts custom-token claims only when `classroomId === "morgan"`, although the subsequent Firestore path is otherwise parameterized by the claim.

**Why it will need to change**  
The observer must resolve an active teacher profile/ownership record for arbitrary authorized teachers and accept valid server-minted student claims for any active classroom. Race/version checks must cover profile and classroom loads as well as the auth event.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

## Firestore rules

### 21. Rules recognize one hardcoded teacher UID

--------------------------------------------------

**Location**  
`firestore.rules`, approximately lines 5-8

**Current behavior**  
`isTeacher()` returns true only for the literal UID `YkYUzIzy0aW7roolM1VaLcIJPuN2`.

**Why it will need to change**  
Authorization must be based on an active teacher/profile record and ownership of the specific classroom being accessed. A generic “is any teacher” predicate is not sufficient for tenant isolation.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 22. Rules preserve the singleton `morganBank` path

--------------------------------------------------

**Location**  
`firestore.rules`, approximately lines 17-19

**Current behavior**  
The one recognized teacher can read and write every document under `morganBank/**`, including `morganBank/classroomData`.

**Why it will need to change**  
The new classroom-scoped source of truth needs ownership rules, while the legacy singleton needs an explicit migration/rollback policy. Leaving broad legacy writes enabled after cutover risks two diverging sources of truth.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 23. Any recognized teacher can access every classroom subtree

--------------------------------------------------

**Location**  
`firestore.rules`, approximately lines 21-23

**Current behavior**  
`match /classrooms/{document=**}` grants read/write access based only on `isTeacher()`, with no check against the requested classroom ID or owner.

**Why it will need to change**  
Simply recognizing a second teacher under this rule would immediately grant that teacher access to the first teacher's classroom. Every classroom-level and nested match must enforce ownership for the path being requested.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 24. Student-auth log rule is globally scoped

--------------------------------------------------

**Location**  
`firestore.rules`, approximately lines 25-27

**Current behavior**  
Any user passing `isTeacher()` can read every top-level `studentAuthLogs/{logId}` document.

**Why it will need to change**  
Logs must be structurally or queryably tied to a classroom, and the rule must verify ownership of that classroom. Cross-classroom login metadata is sensitive student information.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 25. Rules have no teacher-profile, classroom-creation, or ownership contract

--------------------------------------------------

**Location**  
`firestore.rules`, entire file (approximately lines 1-33)

**Current behavior**  
There is no `teachers/{uid}` match, no active/disabled teacher status, no `ownerUid` validation, and no safe rule for creating or linking a classroom.

**Why it will need to change**  
The Version 2 data model needs one authoritative ownership contract shared conceptually by rules and callable functions. Teacher/profile and classroom creation should remain server-controlled so users cannot self-assign another classroom.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

## Cloud Functions

### 26. PIN reset function recognizes one hardcoded teacher UID

--------------------------------------------------

**Location**  
`functions/resetStudentPin.js`, approximately lines 5-17

**Current behavior**  
`requireTeacher()` permits only the literal `TEACHER_UID`.

**Why it will need to change**  
The callable must recognize active teachers dynamically and then authorize the caller against the specific requested classroom.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 27. PIN reset trusts the caller's classroom after a global teacher check

--------------------------------------------------

**Location**  
`functions/resetStudentPin.js`, approximately lines 19-53

**Current behavior**  
The function accepts `classroomId` from `request.data` and immediately uses it in a credential query after checking only that the caller is the one teacher. It never reads a classroom ownership document.

**Why it will need to change**  
With multiple teachers this becomes an insecure direct-object reference: a teacher could submit another classroom ID and reset that classroom's student PIN. Ownership must be verified server-side before querying or updating credentials.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 28. Student sync trigger is bound to one document

--------------------------------------------------

**Location**  
`functions/syncStudentProfiles.js`, approximately lines 5-12

**Current behavior**  
`syncStudentProfiles` runs only when `morganBank/classroomData` is written and reads embedded students and transactions from that one document.

**Why it will need to change**  
The trigger/source-of-truth design must work for arbitrary classroom IDs and the new data shape. The event path should supply the classroom ID rather than relying on a constant.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 29. Student sync loads credentials only for `morgan`

--------------------------------------------------

**Location**  
`functions/syncStudentProfiles.js`, approximately lines 28-44

**Current behavior**  
Existing credentials are queried with `.where('classroomId', '==', 'morgan')`.

**Why it will need to change**  
The query must use the triggering classroom. The in-memory identity maps and deactivation logic must never mix or omit credentials from the current tenant.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 30. Student sync writes mirrors only under `classrooms/morgan`

--------------------------------------------------

**Location**  
`functions/syncStudentProfiles.js`, approximately lines 56-77

**Current behavior**  
Every student mirror is written to `classrooms/morgan/students/{studentId}`.

**Why it will need to change**  
The output path must be derived from the triggering classroom. If students become primary records rather than mirrors, the function may need redesign or removal to avoid feedback loops and dual-source drift.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 31. Credential creation combines a global document key with single-class collision detection

--------------------------------------------------

**Location**  
`functions/syncStudentProfiles.js`, approximately lines 83-135

**Current behavior**  
Login IDs are generated from student names and used directly as top-level `studentCredentials/{loginId}` document IDs. Collision detection sees only the credentials returned by the `morgan` query, and new records hardcode `classroomId: 'morgan'`.

**Why it will need to change**  
Two classrooms can generate the same login ID. Under a naive parameterized version, the second write could overwrite the first classroom's credential because the document key is global while collision detection is tenant-local. Choose a globally unique login-ID strategy or a classroom-scoped key/path before implementing multi-teacher sync.

**Recommended Phase:** Phase 1

**Risk:** High

--------------------------------------------------

### 32. Removed-student deactivation assumes the one credential set is complete

--------------------------------------------------

**Location**  
`functions/syncStudentProfiles.js`, approximately lines 139-145

**Current behavior**  
Credentials absent from the singleton roster are marked inactive based on the earlier hardcoded `morgan` query.

**Why it will need to change**  
Deactivation must be constrained to the triggering classroom and must not act on incomplete/cross-tenant result sets. This path deserves explicit two-classroom regression tests because a scoping error would disable other teachers' students.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 33. Credential verification uses one global login-ID namespace

--------------------------------------------------

**Location**  
`functions/studentCredentialVerifier.js`, approximately lines 53-85

**Current behavior**  
`verifyStudentCredentials()` accepts only `loginId` and PIN and reads `studentCredentials/{normalizedLoginId}` directly.

**Why it will need to change**  
The credential key and request contract must implement the Phase 1 decision on global uniqueness versus classroom-qualified login. The verifier must resolve exactly one classroom without trusting a spoofable client tenant value.

**Recommended Phase:** Phase 3

**Risk:** High

--------------------------------------------------

### 34. Credential verification writes all logs to one flat collection

--------------------------------------------------

**Location**  
`functions/studentCredentialVerifier.js`, approximately lines 32-78 and 87-173

**Current behavior**  
Every login attempt receives a top-level `studentAuthLogs/{autoId}` document. Known credentials add a `classroomId` field, but malformed or unknown login IDs have no classroom association.

**Why it will need to change**  
Version 2 needs a log path/query that teachers can read only for their classroom. The design must explicitly decide where unknown-ID attempts belong; nesting all logs by classroom is impossible unless the login request or credential lookup can resolve a classroom safely.

**Recommended Phase:** Phase 1

**Risk:** High

--------------------------------------------------

### 35. Function exports contain no teacher/profile or classroom onboarding service

--------------------------------------------------

**Location**  
`functions/index.js`, approximately lines 13-32

**Current behavior**  
The function entry point exports student PIN login, teacher PIN reset, and singleton profile sync only.

**Why it will need to change**  
Phase 1 needs server-controlled, idempotent teacher-profile and classroom-creation operations (or an explicitly chosen alternative). They must enforce eligibility and the intended one-classroom-per-teacher constraint atomically.

**Recommended Phase:** Phase 1

**Risk:** High

--------------------------------------------------

## Administrative and diagnostic scripts

### 36. Test-student seeding is fixed to the singleton classroom

--------------------------------------------------

**Location**  
`functions/scripts/seedTestStudent.js`, approximately lines 5-18 and 37-59

**Current behavior**  
The script hardcodes `CLASSROOM_ID = 'morgan'`, reads `morganBank/classroomData`, and writes a global credential document.

**Why it will need to change**  
The target project and classroom must be explicit inputs with safe defaults/guards, and the script must use the Version 2 schema and login-ID strategy. It must not silently seed the legacy or wrong classroom.

**Recommended Phase:** Phase 2

**Risk:** High

--------------------------------------------------

### 37. Data-check script inspects one singleton roster and one named credential

--------------------------------------------------

**Location**  
`functions/scripts/checkData.js`, approximately lines 4-13

**Current behavior**  
The script reads `morganBank/classroomData` and `studentCredentials/edge-test` from the fixed Firebase project.

**Why it will need to change**  
Migration reconciliation and support diagnostics must accept a classroom ID, report ownership, and compare the correct Version 2 records rather than treating one roster and one student as the database.

**Recommended Phase:** Phase 2

**Risk:** Medium

--------------------------------------------------

### 38. Student-check script assumes one global credential identity

--------------------------------------------------

**Location**  
`functions/scripts/checkStudent.js`, approximately lines 33-43

**Current behavior**  
The script looks up only the global document `studentCredentials/edge-test` and prints it without classroom validation.

**Why it will need to change**  
Diagnostics must follow the chosen credential key strategy and require/verify the classroom context so identical student names or IDs cannot be confused across tenants.

**Recommended Phase:** Phase 2

**Risk:** Medium

--------------------------------------------------

## Automated tests and test documentation

### 39. PIN-reset tests codify one trusted UID and one classroom

--------------------------------------------------

**Location**  
`functions/resetStudentPin.test.js`, approximately lines 7-10, 56-66, 82-89, and 142-159

**Current behavior**  
Fixtures use the production teacher UID and `classroomId: 'morgan'`; a test explicitly expects every other authenticated UID to be denied. The Firestore mock supports credential queries only and has no classroom ownership document.

**Why it will need to change**  
Tests must cover Teacher A owning Classroom A, Teacher B owning Classroom B, cross-classroom denial, inactive/missing teacher profiles, forged classroom IDs, and ownership changes. The production UID should not be the conceptual definition of a teacher in new tests.

**Recommended Phase:** Phase 2

**Risk:** High

--------------------------------------------------

### 40. Credential-verifier tests cover only flat logs and `morgan`

--------------------------------------------------

**Location**  
`functions/studentCredentialVerifier.test.js`, approximately lines 9-73 and 92-247

**Current behavior**  
The mock exposes flat `studentAuthLogs` and `studentCredentials` collections, and every valid fixture/assertion uses `classroomId: 'morgan'`.

**Why it will need to change**  
Tests need at least two classrooms, duplicate student/login-name scenarios, the chosen tenant-resolution flow, classroom-scoped logs, and behavior for malformed/unknown IDs whose classroom cannot be resolved.

**Recommended Phase:** Phase 2

**Risk:** High

--------------------------------------------------

### 41. Firestore baseline tests pin the singleton authorization model

--------------------------------------------------

**Location**  
`tests/firestore/rules.baseline.test.js`, approximately lines 1-8, 22-27, 46-79, and 84-290

**Current behavior**  
The suite intentionally defines one hardcoded teacher, `CLASSROOM_ID = 'morgan'`, `morganBank/classroomData`, flat auth logs, and the expectation that a second authenticated UID is not a teacher. It seeds another classroom but does not assert that a dynamically authorized Teacher A is denied from Teacher B's classroom because dynamic teachers do not exist yet.

**Why it will need to change**  
Keep the baseline valuable, but add/version a new ownership suite before changing rules. The new suite must prove bidirectional teacher isolation, student isolation, log isolation, onboarding write restrictions, disabled-teacher behavior, and legacy-path behavior during migration/rollback.

**Recommended Phase:** Phase 2

**Risk:** High

--------------------------------------------------

### 42. No sync, onboarding, migration, or browser tenant-isolation tests exist

--------------------------------------------------

**Location**  
Repository test coverage: `functions/`, `tests/firestore/`, and no client test directory

**Current behavior**  
There are unit tests for PIN reset/verification and baseline rules, but no automated coverage for `syncStudentProfiles`, teacher profile/classroom creation, data migration reconciliation, local-storage scoping, auth account switching, or stale asynchronous loads.

**Why it will need to change**  
These are the paths most likely to cause cross-classroom data exposure or migration loss. Multi-tenant acceptance cannot rely only on manual UI checks.

**Recommended Phase:** Phase 2

**Risk:** High

--------------------------------------------------

### 43. Rules test documentation describes the old model as the only suite

--------------------------------------------------

**Location**  
`tests/firestore/README.md`, approximately lines 1-13 and 36-47

**Current behavior**  
The README documents the hardcoded `TEACHER_UID`, singleton document, classroom mirror, and flat log expectations as the current baseline.

**Why it will need to change**  
Once the ownership suite exists, the documentation must distinguish legacy-baseline tests from Version 2 rules tests and explain how to run both safely.

**Recommended Phase:** Phase 2

**Risk:** Low

--------------------------------------------------

## Architecture and release documentation

### 44. Proposed Version 2 architecture intentionally assumes one classroom per teacher

--------------------------------------------------

**Location**  
`MULTI_TEACHER_ARCHITECTURE_PLAN.md`, approximately lines 256-269, 350-388, and 420-437

**Current behavior**  
The proposed schema uses a scalar `teachers/{uid}.classroomId`, a single `classrooms/{classroomId}.ownerUid`, and explicitly scopes Version 2 to one classroom per teacher with no co-teachers.

**Why it will need to change**  
This is a Phase 1 decision gate. If “multi-teacher” still means exactly one independently owned classroom per teacher, record the constraint as accepted and implement it consistently. If Version 2 must support multiple classrooms per teacher or co-teachers now, the profile, ownership, rules, onboarding, UI, and tests must be redesigned before any schema is created.

**Recommended Phase:** Phase 1

**Risk:** High

--------------------------------------------------

### 45. Release/status documents still describe multi-teacher support as future work

--------------------------------------------------

**Location**  
`VERSION.md`, approximately lines 11-18 and 32-36; `ROADMAP.md`, approximately line 19; `SECURITY_PLAN.md`, approximately lines 54-59

**Current behavior**  
The current release documents describe one existing teacher account and defer multi-teacher support.

**Why it will need to change**  
After implementation and verification, the documentation must state the shipped tenant model, supported teacher/classroom cardinality, security guarantees, and remaining limitations. Historical migration/checklist documents and `CHANGELOG.md` history should remain historical rather than being rewritten.

**Recommended Phase:** Phase 5

**Risk:** Low

--------------------------------------------------

## Summary

### 1. Total number of locations found

**45 audit locations.**

This count groups adjacent lines and repeated call sites inside the same function when they express the same architectural assumption. It excludes product-level Firebase project names, dependency lockfiles, unused scaffold assets, and historical changelog entries that do not control tenant behavior.

### 2. Recommended implementation order

- [ ] **Phase 1 — Lock the tenancy contract before writing schema.** Decide whether Version 2 is one classroom per teacher or supports broader cardinality; choose generated classroom IDs; define teacher eligibility/status; choose global-versus-classroom-qualified student login IDs; define how unknown login attempts are scoped; specify the authoritative ownership check; design idempotent teacher-profile/classroom creation.
- [ ] **Phase 1 — Build additive server foundations.** Implement and unit-test server-controlled teacher profile and classroom creation against an emulator/non-production project. Do not make the current client or rules depend on them yet.
- [ ] **Phase 2 — Build the safety net.** Add two-teacher/two-classroom ownership tests, sync tests, credential-collision tests, onboarding tests, client account-switch/cache tests, and an idempotent migration/reconciliation script. Parameterize diagnostic/seeding scripts and rehearse only in an emulator or separate non-production project.
- [ ] **Phase 2 — Prove migration invariants.** Automatically compare roster count and identities, total balances, transaction count/content, settings, login history, credentials, and login logs before and after rehearsal. Exercise restart/partial-failure behavior and rollback.
- [ ] **Phase 3 — Make the coordinated cutover changes.** Resolve teacher/classroom context in the client; replace singleton reads/writes; update student-write paths; update PIN reset and sync functions; implement ownership rules; scope logs/caches/backups; remove all runtime UID and `morgan` tenant literals. Client, functions, rules, indexes, and migrated data must follow one rehearsed compatibility sequence.
- [ ] **Phase 4 — Verify the existing classroom first.** Confirm exact data parity, teacher workflows, student PIN login, student requests, PIN reset, exports/import safeguards, auth logs, and rollback readiness. Test account switching on a shared browser and direct cross-classroom access attempts.
- [ ] **Phase 5 — Onboard a second real teacher only after stability.** Create an independent classroom, repeat cross-classroom isolation tests in both directions, verify student login-ID collision behavior, then update branding and release/status documentation.

### 3. Technically risky areas

- [ ] **Rules/client/data deployment ordering:** the old client and old rules depend on the singleton path, while the new client and ownership rules depend on migrated teacher/classroom records. A partial rollout can lock out the teacher or expose another classroom.
- [ ] **Global credential key collisions:** `studentCredentials/{loginId}` is global, but current collision detection is single-classroom. A duplicate name/login ID can overwrite or authenticate against another classroom unless the identity strategy is decided first.
- [ ] **PIN-reset authorization:** the current callable trusts a caller-supplied classroom after checking only one UID. This becomes a direct cross-tenant account-takeover path if teacher recognition is broadened without adding ownership verification.
- [ ] **Student-auth log scoping:** known credentials carry `classroomId`, but malformed and unknown login attempts do not. The log hierarchy cannot be safely finalized until tenant resolution for login is defined.
- [ ] **Browser fallback leakage:** the fixed local-storage key plus silent Firestore fallback can display a prior teacher's data after account switching or a network/rules error.
- [ ] **Whole-document writes and embedded history:** the singleton blob uses last-writer-wins replacement and contains unbounded transaction/login arrays. Migration must account for Firestore document-size limits, concurrent writes, ordering, and stable transaction identity.
- [ ] **Dual-source sync behavior:** changing the fixed trigger to wildcard paths without defining the new source of truth can create feedback loops, duplicate writes, stale mirrors, or cross-classroom credential deactivation.
- [ ] **Custom-token claim freshness:** student classroom claims remain valid until token refresh/expiry. Moving a student or disabling a classroom needs a clear revocation and server/rules strategy.
- [ ] **Monolithic client and limited tests:** all UI, auth, state, and data access live in one inline module. Tenant context can be captured incorrectly by delayed callbacks, bulk loops, imports, and auth changes unless it is centralized and covered by browser tests.
- [ ] **Migration reversibility:** preserve the legacy singleton as a read-only rollback source until parity and stability are proven. Migration scripts must be idempotent and reconciled; cleanup should not occur during the initial Version 2 cutover.
