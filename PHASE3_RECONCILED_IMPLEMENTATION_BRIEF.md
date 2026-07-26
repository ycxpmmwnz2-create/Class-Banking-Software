# Phase 3 Reconciled Implementation and Release Brief

Status: **planning and review only**. This document does not authorize Phase 3
implementation, production inspection, migration, deployment, a rules change,
feature-gate activation, real-account onboarding, cleanup, commit, or push.

Baseline when reconciled:

- Branch: `feature/multi-teacher`
- HEAD and expected remote: `5db34e5e63848d9ac421db16dcf6ea2564718015`
- Checked-in `firestore.rules` SHA-256:
  `0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50`
- Production state remains unknown by design.

This brief reconciles Claude's independent Phase 3 challenge report with the
repository evidence and the authoritative Phase 2B completion gate. It does
not replace `MULTI_TEACHER_ARCHITECTURE_PLAN.md`; it resolves the Phase 3
implementation decisions that document intentionally left open.

## 1. Challenge-finding disposition

- **Accepted:** the client data layer is substantially under-scoped. One
  injected adapter file cannot safely translate the legacy aggregate blob into
  the V2 classroom root, students, transactions, and login-history paths.
- **Accepted:** student creation and deletion must be server-only; rules cannot
  enforce a monotonic client-selected document ID.
- **Corrected subfinding:** the seven `Date.now()`/`Date.now() + index` sites in
  `index.html` create transaction or login-history IDs, not student IDs. The
  only live student allocator is `max(data.students.id) + 1`. The broader
  never-reuse finding still stands because removed students disappear from
  that maximum while credentials remain. `importBackup` is a separate
  unvalidated student-ID entry path: it accepts arbitrary imported student
  objects through `normalizeData` and then saves them. This makes the V2 import
  prohibition and production-wide historical-ID preflight load-bearing.
- **Accepted:** the student-login UI has no classroom-code input and the login
  call is not branched to `studentPinLoginV2`.
- **Accepted:** Phase 3 must never write flat `studentCredentials`. The Phase
  2A in-place classroom-ID projection is not used for production credentials;
  Phase 3 uses Phase 2B copy semantics only.
- **Accepted:** the current V2 Functions gate is emulator-only and would reject
  or crash production V2 activation. Module discovery must remain nonfatal.
- **Accepted:** a separately tested bridge ruleset is required, including both
  flat and scoped auth-log paths.
- **Accepted:** the existing teacher foundation must exist and reconcile before
  ownership-dependent rules deploy.
- **Accepted:** Phase 3 and the existing migration rehearsal command require
  credential-isolated emulator wrappers.
- **Accepted limitation:** V2 localStorage envelopes may remain after a Hosting
  rollback, but the default-off legacy artifact never reads them.
- **No Phase 3 action:** existing `firestore-debug.log` files are already
  ignored by `*.log`, are not served because Hosting publishes `dist`, and are
  not cleanup authorization.
- **Resolved:** V2 mode must not invoke the hardcoded
  `ensureTeacherClassroom` bootstrap. The production runner establishes the
  existing teacher's foundation administratively; it does not create an
  invitation or run new-teacher onboarding.

## 2. Non-negotiable decisions

1. Student creation and deletion are server-only.
2. Rules deny browser `create` and `delete` on student documents.
3. Flat credentials are immutable throughout Phase 3, including rollback.
4. The V2 login UI requires classroom code, login ID, and PIN.
5. The gate-on V2 client calls versioned V2 Function names.
6. Stable legacy handlers are not silently mapped to incompatible V2
   handlers.
7. When V2 is active, legacy login and mutation handlers fail closed for stale
   clients rather than changing rollback sources.
8. The existing foundation precedes ownership-dependent bridge rules.
9. Bridge, final, and rollback-safe rules are separate checksum-pinned and
   independently tested artifacts.
10. Production preflight, write, and reverification use separate entrypoints;
    no argument or subcommand typo can turn preflight into a write.

## 3. Objectives and non-goals

Phase 3 is one coordinated cutover that builds and rehearses a separately
reviewed production runner, revalidates actual production state under separate
read-only authorization, preserves legacy sources, copies scoped credentials,
deploys credential-safe ownership rules in the required order, activates V2
Functions and Hosting, and retains a tested rollback path.

It does not authorize or include a second real teacher, cleanup, deletion of
legacy data or Auth users, co-teachers, multiple classrooms, districts,
ownership transfer, or running the emulator-only Phase 2A CLI against
production. Phase 4 owns real existing-classroom verification and Phase 5 owns
the second real teacher.

## 4. Client data contract

The aggregate `data` object may remain a UI view model, but it is no longer the
persistence model in V2.

V2 load must:

- read settings and `lastBackupAt` from the resolved classroom root;
- read only that classroom's students, transactions, and login history;
- reconstruct the aggregate view after strict shape and tenant validation;
- never load PINs or credential fields into the aggregate; and
- reject duplicate IDs, malformed documents, inconsistent references, and
  foreign paths before render or cache admission.

V2 persistence must decompose mutations by path:

- classroom root: only `settings`, `lastBackupAt`, and `updatedAt`;
- student update: only `name`, `balance`, `frozen`, and the required
  transaction mirror, with immutable `id`;
- student creation/deletion: server lifecycle callables only;
- transactions/login history: canonical deterministic document IDs and exact
  field contracts; and
- multi-document logical changes: bounded batch/transaction semantics plus
  tenant/epoch validation before memory, DOM, cache, or storage effects.

Every written student document must have exactly:

```
id, name, balance, frozen, transactions
```

No write payload or cache envelope may contain `pin`, `pinHash`, `loginId`,
`authUid`, credential activation, or lockout state. Emulator tests must inspect
the actual written key set and fail on any extra field.

V2 UI behavior:

- add a classroom-code field to student login;
- call `studentPinLoginV2({ classroomCode, loginId, pin })`;
- do not display or edit stored PINs on roster/profile screens;
- send a new PIN only to an authorized callable;
- use `resetStudentPinV2` for PIN changes;
- export PIN-free V2 backups; and
- disable V2 backup import for the initial cutover unless a separately tested
  import service allocates identities and reconciles all records. Default-off
  legacy backup behavior remains unchanged.

## 5. Student identity and lifecycle

New callable contract:

```
createStudentV2({ name, startingBalance, pin }) ->
  { student: { id, name, balance, frozen }, loginId }
```

It resolves the active reciprocal tenant from auth, validates inputs, hashes
the four-ASCII-digit PIN outside retryable transaction callbacks, allocates the
next student number transactionally, creates the student and scoped credential
atomically, allocates the classroom-scoped login ID transactionally, and uses
the deterministic V2 Auth UID. It never returns a PIN, hash, token, or full
credential body.

Deletion contract:

```
removeStudentV2({ studentId }) -> { success: true }
```

It resolves the tenant, verifies the exact student and unique credential,
deletes the student and marks the credential inactive atomically, never deletes
the credential, and never decrements the counter.

The classroom root gains a server-managed `nextStudentNumber`. Production
preflight derives its initial value from the maximum accepted historical
numeric student ID across the legacy roster, active/inactive/orphaned
credentials, transactions, login history, auth logs, destination students, and
any existing scoped credentials. Numeric/string equivalents are normalized.
Malformed values, collisions, unsafe integers, or unexplained historical
references block. The initial value is maximum plus one and is never reduced.

The V2 sync handler treats an exactly matching credential atomically created by
the trusted lifecycle callable as an idempotent verified state. Divergent or
duplicate credentials remain blocking.

## 6. Callable compatibility and gates

The first cutover retains and explicitly calls versioned names:

- `resolveTeacherTenantV2`
- `onboardTeacherClassroomV2`
- `studentPinLoginV2`
- `resetStudentPinV2`
- `syncStudentProfilesV2`
- the new versioned student lifecycle callables

This deliberately supersedes the older plan sentence saying Phase 3
immediately maps stable public names to V2. The payloads are incompatible.

Legacy handlers remain deployed for rollback:

- gate off: legacy behavior remains available;
- gate on: legacy login, PIN-reset, bootstrap, and mutation paths reject with a
  generic upgrade/maintenance error;
- no legacy handler routes an old payload into V2; and
- no legacy handler updates flat credentials or legacy data while V2 is
  authoritative.

Final rules also deny legacy blob writes, preventing a stale old teacher client
from mutating rollback data after activation. Rollback disables the gate,
deploys the recorded default-off Hosting artifact, and installs rollback-safe
rules before legacy writes resume.

Module loading must never throw merely because the V2 parameter is enabled.
Per-invocation validation recognizes only:

- the existing exact demo emulator project with loopback emulator hosts and
  emulator flags; or
- exact production project `morgan-bank`, no emulator hosts/flags, V2 enabled,
  and a release-ID parameter matching the reviewed deployed artifact.

Suggested parameters are `MULTI_TEACHER_V2_ENABLED` (default false) and
`MULTI_TEACHER_V2_RELEASE_ID`. A mismatch fails only the V2 invocation or
trigger, with redacted telemetry; it does not crash discovery or legacy
exports. Gate-off trigger execution is a clean no-op.

## 7. Rules contracts

All three artifacts delete the recursive `classrooms/{document=**}` client
allow and deny both flat and scoped credentials to every client, including the
active owner.

### Bridge

- deployed only after the existing foundation exists and reconciles;
- preserves narrowly required hardcoded-teacher legacy access during the
  maintenance/migration window;
- preserves exact legacy student self-read;
- covers both `studentAuthLogs/{logId}` and
  `studentAuthLogs/{classroomId}/logs/{logId}`;
- permits only the scoped V2 access needed for verification; and
- never exposes invitations, login-code indexes, throttles, unresolved logs,
  or credentials.

### Final

- exact active reciprocal ownership;
- no legacy blob client writes;
- student self-read only for exact claims;
- teacher student `create` and `delete` denied;
- student update requires immutable `id`, exact allowed document keys, and
  affected keys limited to `name`, `balance`, `frozen`, and `transactions`;
- transaction and login-history create bodies have exact allowlists, while
  updates have reviewed affected-key and identity invariants;
- teachers read only their own scoped auth logs; and
- all ownership, invitations, code indexes, throttles, unresolved logs,
  credentials, and unenumerated paths remain client-write denied.

### Rollback-safe

- re-enables only the narrow hardcoded legacy behavior needed by the recorded
  default-off artifact;
- retains explicit scoped-credential denial even though scoped documents stay
  in Firestore;
- covers both auth-log shapes; and
- never restores the current recursive baseline rule.

Repeated `exists()`/`get()` use in ownership predicates must be simplified or
budgeted against Firestore rules access-call limits and billing. The scoped
credential lookup by `studentId == value` uses an automatic single-field index;
`firestore.indexes.json` changes only if a new compound or exempted index is
actually proven necessary.

## 8. Production runner contract

Phase 3 has separate entrypoints:

```
node functions/phase3/preflight.js ...
node functions/phase3/write.js ...
node functions/phase3/reverify.js ...
```

There is no shared write subcommand, `--force`, production override,
manifest-path override, state-directory override, or implicit credential
discovery. Write mode requires the retained successful preflight manifest,
exact project allowlist, reviewed release/change identifier, snapshot ID,
write-freeze proof, credential provenance, and separate authorization.

The runner may reuse proven canonical/manifest concepts, but never edits or
weakens `functions/phase2/**`. For credentials it uses Phase 2B copy semantics:
flat `studentCredentials/{loginId}` remains byte-for-byte untouched; the scoped
copy changes only the generated classroom ID and deterministic V2 Auth UID.
Absence or divergence never falls back to flat data after activation.

## 9. Release ordering and abort criteria

1. Complete and independently review local Phase 3 implementation.
2. Run credential-isolated unit, rules, migration, browser, release, and
   rollback rehearsals.
3. Obtain separate authorization for read-only production validation.
4. Record deployed rules, Functions, Hosting, parameters, foundation, paths,
   counts, shapes, IDs, credentials/logs, Auth compatibility, indexes, and
   active writers.
5. Abort on any unexplained state, malformed ID, duplicate, divergence,
   missing recovery prerequisite, or unreviewed production assumption.
6. Obtain separate production write/deploy authorization.
7. Enter maintenance/write freeze and capture the production export/snapshot
   plus final immutable checksums.
8. Create or validate the existing teacher/classroom foundation
   administratively. No invitation is created.
9. Initialize/reserve classroom login code and student counter under the
   reviewed manifest.
10. Deploy and verify bridge rules.
11. Deploy V2 Functions with the V2 gate off.
12. Run classroom migration and scoped credential/log copy.
13. Reconcile all paths, counts, checksums, UID mappings, source immutability,
    and sensitive-path denials. Any mismatch aborts before activation.
14. Deploy final ownership rules.
15. Set the reviewed release identifier and enable the server gate.
16. Deploy the gate-on Hosting artifact.
17. Run existing-teacher and existing-student acceptance.
18. End write freeze only after acceptance succeeds.
19. Observe through the rollback window; do not onboard a second real teacher.

Rollback after scoped credentials exist:

1. retain or re-enter write freeze;
2. roll Hosting back to the recorded default-off artifact;
3. disable the V2 server gate;
4. deploy the checksum-pinned rollback-safe rules;
5. reconcile untouched flat credentials and legacy data; and
6. resume only after legacy acceptance passes.

Never redeploy the current recursive baseline rules while scoped credentials
exist.

## 10. Cache, invalidation, and rollback residue

The Phase 2B cache key/envelope, epoch checks, purge-before-resolve behavior,
transient-only offline fallback, BroadcastChannel/storage fallback, bounded
pending-digest quarantine, and generic malformed-message quarantine remain
normative. No classroom data is broadcast. Student sessions persist no teacher
data. Stale callbacks cannot write memory, DOM, cache, or storage.

A default-off Hosting rollback does not purge every previously written V2
localStorage envelope. This is accepted residue because the legacy artifact
never reads V2 keys. A later gate-on resolution still validates exact project,
UID, classroom, schema, and epoch before cache admission.

## 11. Exact permitted implementation file scope

Existing files:

- `index.html`
- `functions/index.js`
- `functions/phase2b/syncStudentProfiles.js` and directly affected test
- `src/phase2b/tenantSession.js`, `tenantCache.js`, `tenantClient.js`, and
  directly affected tests
- `firestore.rules`
- `package.json`, `functions/package.json`, and lockfiles only as required
- `firebase.json`
- `firestore.indexes.json` only with evidence of a required new index
- final evidence-only documentation updates

New files:

```
functions/phase3/
  productionEnvironment.js
  productionPreflight.js
  productionProjection.js
  productionManifest.js
  productionWriter.js
  productionReconciliation.js
  preflight.js
  write.js
  reverify.js
  studentLifecycle.js
  studentLifecycle.test.js

src/phase3/
  tenantDataProjection.js
  tenantDataProjection.test.js
  tenantDataService.js
  tenantDataService.test.js

tests/phase3/
  production-runner.emulator.test.js
  tenant-data.browser.spec.js
  release-order.contract.test.js
  rollback-rehearsal.test.js

firestore.phase3.bridge.rules
firestore.phase3.final.rules
firestore.phase3.rollback.rules
tests/firestore/rules.phase3.bridge.test.js
tests/firestore/rules.phase3.final.test.js
tests/firestore/rules.phase3.rollback.test.js
PHASE3_RELEASE_RUNBOOK.md
```

Any additional file requires an architecture update before editing. Phase 2A
runtime algorithms, manifests, recovery tools, legacy sources, flat
credentials, legacy Auth users, and rollback evidence are preserved.

The Phase 2B proposed-rules fixture and its tests remain immutable historical
acceptance evidence. Phase 3's three new rules artifacts supersede it for the
cutover contract; they do not keep it in sync or rewrite what Item 10 proved.

## 12. Test and command safety

Before Phase 3 implementation proceeds beyond acceptance tests,
`npm run test:migration` must gain the same protections as Phase 2B commands:

- refuse local Google ADC;
- use an empty temporary Firebase CLI configuration;
- unset Google credential, token, project, Firebase-config, and emulator-host
  variables before starting;
- use an explicit `demo-` emulator project;
- allow only loopback emulator hosts supplied by the harness; and
- never resolve or authenticate to a real project.

Every Phase 3 emulator/browser/release command inherits those protections.
Required future local gates, added only in the same commit as the behavior they
actually exercise, include:

```
npm run test:phase3:unit
npm run test:phase3:rules
npm run test:phase3:migration
npm run test:phase3:release-rehearsal
npm run test:phase3:rollback-rehearsal
```

They supplement, not replace, the complete Phase 2B and repository matrix.
Commit 1 must not add passing placeholder commands under these names before
their corresponding behavioral suites exist. Its static/source evidence runs
under the narrower `npm run test:phase3:contracts` name.

## 13. Commit and review boundaries

1. Acceptance tests and credential-isolated commands; no Phase 3 production
   implementation.
2. Production environment/project/authorization guards.
3. Read-only production preflight and manifest.
4. Copy-only production projection and reconciliation.
5. Production writer and crash/restart recovery.
6. Student lifecycle, counter, sync idempotency, and client add/remove wiring.
7. Tenant data projection/service and PIN-free V2 UI wiring.
8. Classroom-code student login and Function gate compatibility.
9. Bridge rules and tests.
10. Final and rollback-safe rules and tests.
11. Full release/rollback rehearsal and observability.
12. Evidence-only documentation corrections, including the stale Phase 2B
    Part 3 summary and stale line references.

Claude and Codex retain the detailed plan-build-review-correct loop. After a
material item reaches review-quality, Grok performs the bounded read-only
systems-level/residual-risk checkpoint defined in
`AI_COLLABORATION_WORKFLOW.md`. A deeper third review remains required at the
production-readiness gate.

## 14. Commit 1 boundary

No implementation is currently authorized. If separately authorized, Claude's
first implementation item is only:

> Phase 3 acceptance contracts and credential-isolated emulator commands.

Claude's read-only coherence challenge found no remaining Blocking or High
conflict. Commit 1 is therefore fully specified, but still requires separate
implementation authorization.

Modified file:

- `package.json`: harden `test:migration` per Section 12 and add only
  `test:phase3:contracts`. Do not add the five future behavioral gate names as
  passing placeholders.

New files:

- `tests/phase3/command-safety.contract.test.js`
- `tests/phase3/release-order.contract.test.js`
- `tests/phase3/student-identity.contract.test.js`
- `tests/phase3/README.md`

`functions/package.json` is not changed unless a concrete Node test-discovery
need is demonstrated before editing. `functions/phase3/` and `src/phase3/`
remain absent.

The command-safety contract must parse the root scripts and prove that
`test:migration` refuses local ADC, uses a temporary isolated Firebase CLI
configuration, scrubs credential/token/project/config/emulator/gate variables,
sets `METADATA_SERVER_DETECTION=none`, and uses a `demo-` project. It must reject
deploy, `--force`, production project, and non-loopback-host markers, and
include a negative-control fixture proving the matcher has teeth. As later
Phase 3 emulator commands are added, this same contract expands to require the
identical isolation contract from each one.

The release-order source contract must parse this brief and assert foundation
before bridge rules; bridge rules before the first scoped credential; final
rules before gate enable before gate-on Hosting; and rollback Hosting-off before
gate disable before rollback-safe rules before legacy writes resume. It also
asserts all three future rules artifacts remain absent in Commit 1 and that the
checked-in `firestore.rules` hash remains
`0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50`.

The student-identity source contract must prove the one live student allocator,
classify every `Date.now()` ID as transaction/history rather than student
allocation, pin `importBackup` as an unvalidated student-ID entry path, prove
one `data.students.push` allocation site, and pin both V2 data adapters as
referenced but undefined. Test titles and the README must identify these as
static/source evidence rather than behavioral proof.

Commit 1 verification commands are:

```
git status -sb
git rev-parse HEAD
git diff --check
npm run test:phase3:contracts
npm run lint
npm --prefix functions run lint
npm run test:phase2b:client
npm run test:phase2b:build-contract
npm run test:migration
shasum -a 256 firestore.rules
```

It must not implement production guards, a runner, lifecycle services, client
wiring, rules artifacts, deployment logic, or production operations, and it
must not access production, deploy, migrate production, activate a gate,
commit, or push.
