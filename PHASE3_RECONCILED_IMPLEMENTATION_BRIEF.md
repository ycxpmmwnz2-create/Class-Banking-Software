# Phase 3 Reconciled Implementation and Release Brief

Status: **clean-start application released through founding-invitation
creation; onboarding and acceptance incomplete; not production authorization**.

On 2026-07-31 Andrew selected a clean V2 start. The existing production records
are development-only V1 test data and are not copied, reconciled, accepted, or
deleted. They remain untouched indefinitely. The implemented migration runner,
its immutable state artifacts, bridge rules, rollback-safe rules, IAM role
definitions, and rehearsals remain in the repository as dormant historical and
regression evidence; they are not steps in the clean-start release.

Items 1–14 remain implemented from local repository, unit, source-contract,
emulator, rules, browser, migration-rehearsal, release-rehearsal, and rollback-
rehearsal evidence. The release record bound to reviewed application commit
`fa733d780c4adb36304e857b592251c95c2be4c2` records review/local-gate closure,
Role B absence, gate-off and gate-on Functions, final rules, gate-on Hosting,
and founding-invitation creation. The corrected N9/N10 observations remain
immutable evidence and agreed on all five deployment surfaces and active-writer
classification. The clean-start route does not consume them and requires no
replacement inventory. No broader production application data was inspected;
the bounded v1 recovery attempt read only the founding invitation before a
privacy-boundary abort and performed no Save or mutation. No recorded
onboarding, fresh-student acceptance, or observation-window completion exists.
This document does not authorize production inspection, data deletion,
migration, deployment, a rules change, feature-gate activation, invitation
recovery, real-account onboarding, cleanup, IAM mutation, commit, or push.

Reviewed baseline for the production-readiness correction:

- Branch: `feature/multi-teacher`
- Historical reviewed baseline HEAD at that correction:
  `c39b40c50abd5e31e56d68eb9d80ae3ba5761215`
- Checked-in `firestore.rules` SHA-256:
  `0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50`
- Live state is not inferred from repository source; the external release
  record described above is the bounded evidence for completed steps 1–9.

This brief reconciles Claude's earlier Phase 3 migration challenge report, the
clean-start pivot, repository evidence, and the authoritative Phase 2B
completion gate. It does not replace `MULTI_TEACHER_ARCHITECTURE_PLAN.md`; it
supersedes that plan's migration-only release ordering for this launch.

## 1. Historical challenge-finding disposition

This section records the pre-implementation findings that shaped the Phase 3
contracts. Statements about missing client, Function, rules, or runner behavior
describe the baseline at reconciliation commit `5db34e5`; they are not a
current inventory. Current local implementation and evidence are recorded in
`tests/phase3/README.md`. Production state remains unknown.

The migration-specific findings below remain historical rationale only. The
clean-start release neither satisfies nor works around them; it has no legacy
copy operation to which they could apply.

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
- **Resolved for the retired migration route:** V2 mode must not invoke the
  hardcoded `ensureTeacherClassroom` bootstrap. That runner established the
  existing teacher's foundation administratively. Clean start instead creates
  a time-bounded invitation and uses normal new-teacher onboarding.

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
8. The clean-start release deploys final rules before the V2 server gate and
   before gate-on Hosting.
9. Bridge, final, and rollback-safe rules remain separate checksum-pinned and
   independently tested artifacts, but only final rules are deployed by the
   clean-start sequence.
10. `inventory.js`, `preflight.js`, `write.js`, and `reverify.js` remain
    separate retained entrypoints and are not run for the clean-start release.

## 3. Objectives and non-goals

Phase 3 now launches the reviewed V2 system without importing V1 application
records or Auth users. It deploys V2 Functions gate-off, deploys the final
ownership rules, activates the exact reviewed Functions release and gate,
deploys gate-on Hosting, creates a time-bounded administrative invitation, and
uses the normal invitation-controlled onboarding path to create a fresh
teacher/classroom foundation. Acceptance creates and authenticates fresh test
students and proves money writes, removal, and tenant isolation.

It does not authorize or include production-data inspection, migration,
reconciliation against V1, deletion of legacy data or Auth users, Role B,
maintenance freeze, snapshot/export, a second real teacher, real students,
co-teachers, multiple classrooms, districts, ownership transfer, or any Phase
2A/Phase 3 production runner entrypoint. No real students may be added until a
later separately reviewed school-start readiness decision.

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

The classroom root has a server-managed `nextStudentNumber`. The normal V2
invitation-controlled onboarding transaction creates a fresh classroom with
`nextStudentNumber: 1` alongside its teacher document, active classroom-code
index, and consumed invitation. The first `createStudentV2` call therefore
allocates document ID `"1"`; removal never decrements the counter.

This initialization belongs in `functions/phase2b/teacherOnboarding.js`, not
the shared Phase 1 classroom model. The Phase 1 hardcoded bootstrap supplies no
student login code and cannot produce a usable V2 student-login foundation.
Keeping the change at the V2 onboarding boundary avoids changing that retained
legacy path while making every future invitation-created classroom complete.

The dormant migration writer retains its historical maximum-plus-one
derivation and its fail-closed assumption that its initialization delta is
absent. A classroom already carrying `nextStudentNumber` is rejected on a
fresh writer initialization rather than overwritten or renumbered. The clean-
start release never invokes that writer.

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
from mutating retained V1 test data after activation. Clean-start withdrawal
disables the gate, deploys the recorded default-off Hosting artifact, retains
final rules, and never resumes legacy writes. The rollback-safe artifact and
legacy-write resumption remain migration-route history only.

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

All three retained artifacts delete the recursive
`classrooms/{document=**}` client allow and deny both flat and scoped
credentials to every client, including the active owner. The clean-start
release deploys only the checksum-pinned final artifact. Bridge and rollback-
safe rules remain tested migration-era recovery evidence and are not clean-
start deployment stages.

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
- student self-read requires both exact token claims and an existing active
  reciprocal teacher/classroom foundation, so phantom-parent legacy mirrors
  remain denied even to stale matching student tokens;
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

- retained for regression evidence and not deployed by the clean-start
  rollback;
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

## 8. Retained migration runner contract

Phase 3 retains four separate migration entrypoints:

```
node functions/phase3/inventory.js ...
node functions/phase3/preflight.js ...
node functions/phase3/write.js ...
node functions/phase3/reverify.js ...
```

They remain tested and fail closed, but the clean-start release does not run
any of them and does not author or consume inventory, expectations, preflight,
write, re-verification, snapshot, freeze, or copy artifacts. The detailed
runner material below is a retained historical contract, not the current
operator sequence. Nothing in this section may be used to infer clean-start
authorization.

The inventory entrypoint closes the expectations-bootstrap gap without widening
preflight. It is a separately authorized, production-only, control-plane-only
observation. Its exact inputs are a full reviewed commit SHA, an inventory
authorization file, and an explicit service-account credential file. The
authorization has an exact schema and binds `morgan-bank`, the commit, change
and authorization identifiers, credential provenance, the exact credential
SHA-256, and a maximum two-hour UTC validity interval. Before opening either
artifact, the entrypoint also proves its actual Git HEAD is the authorized full
SHA and that the anchored repository worktree is clean. Credential creation and
IAM assignment are separate human decisions; neither this implementation nor
an inventory authorization creates or changes a credential or binding.

After every local artifact binding succeeds, `inventory.js` may issue GET-only
reads to the fixed Firebase Rules, Cloud Functions, Firebase Hosting, and
Firestore Admin API origins. It consumes every page or aborts, records the
active rules release/checksum, complete Functions inventory and V2 parameters,
complete Hosting release inventory, complete composite/field index inventory,
and derived active-writer names, then creates one immutable content-addressed,
secret-scanned local inventory under `functions/phase3/.state/`. It creates no
Admin app, Firestore data handle, or Auth handle and reads no application data,
student data, teacher data, credentials collection, logs, or Auth users.

The inventory is an observation, not an authorization or expectation. Its exact
schema contains no `writeEligible`, `preflightManifestId`, or `expectations`
field. It cannot be supplied to `write.js` or `reverify.js`, does not satisfy
preflight authorization, and does not create a preflight manifest. An operator
must independently corroborate the named deployment surfaces and current
releases/parameters through Firebase or Google Cloud Console, retain the
inventory for detailed Claude and independent Grok review, and obtain Andrew's
separate approval before its opaque observed values may be transcribed into a
checksum-bound expectations artifact. The console check corroborates the
surface names, counts, current release/version identities, parameters, and
index/writer presence; it is not claimed to reproduce the implementation's
canonical resource digests. Any mismatch or unexplained surface aborts.

Only after that review may a new, separately authorized preflight inspect the
teacher/classroom, Firestore application data, credential/log, Auth, and
control-plane surfaces against the exact expectations artifact. Discovery by a
deliberately failing preflight is prohibited: preflight error telemetry does not
retain the opaque observed values and cannot bootstrap trustworthy
expectations.

### Retained-artifact supersession after the Functions digest correction

Commit `773ac6c70eebac2db89b1394052e20a39ff7b831` corrected the Functions
surface digest by canonicalizing only the order of
`eventTrigger.eventFilters` before hashing the otherwise complete function
resource. Every control-plane inventory and preflight-expectations artifact
that existed before that commit is superseded. Preserve those files unchanged
as historical evidence, but do not present an old expectations artifact,
transcribe an old Functions digest into a new artifact, or treat an equal
comparison as proof that the artifact is current.

This rejection is an unconditional process gate, not a behavior the current
artifact schemas can enforce. The inventory artifact records its producing
commit but no digest-algorithm discriminator. The preflight-expectations
artifact that supplies the compared values records neither a producing commit
nor a digest-algorithm discriminator. A pre-correction digest may therefore
either mismatch and abort or coincidentally equal the corrected digest when the
older API response already returned the filters in canonical order. Equality
cannot rehabilitate a superseded artifact.

The normal N9/N10 sequence performs exactly two new observations with the one
read-set transition placed between them. The **base-role observation** runs
while the candidate identity still holds only the existing
`phase3ControlPlaneInventoryReader` custom role and
`roles/firebasehosting.viewer`, before the stable Firestore/Auth read layer is
bound. Under its own separate IAM mutation authorization, the reviewed stable
Firestore/Auth reader (Role A) is then created and bound, and its exact
definition and binding are verified. Role B remains both uncreated and
unbound. The **final-read-set
observation** runs only after that verification, with the base roles plus Role A
forming the frozen read set.

### Tracked IAM role definitions

The names "Role A" and "Role B" are aliases for these exact tracked role
definitions; neither label may be interpreted or expanded from prose:

- **Role A — `projects/morgan-bank/roles/phase3DataPlaneReader`:**
  `iam/phase3/phase3DataPlaneReader.yaml`, raw-byte SHA-256
  `4c4259c12d3d1f0188e997baac0a7fed000510357cb4b5c453de342123fad8d5`.
  It contains exactly `datastore.entities.get`,
  `datastore.entities.list`, and `firebaseauth.users.get`.
- **Role B — `projects/morgan-bank/roles/phase3MigrationWriter`:**
  `iam/phase3/phase3MigrationWriter.yaml`, raw-byte SHA-256
  `a97924dbbdbf025cca740a6c952791a3ec5a774b0c2277f0228d029fd272d1bf`.
  It contains exactly `datastore.databases.get`,
  `datastore.entities.create`, and `datastore.entities.update`.

The Role A permissions are the closed data-read set. Firestore document gets
use `BatchGetDocuments` and require `datastore.entities.get`; Firestore
`RunQuery` and `ListDocuments` operations require both
`datastore.entities.get` and `datastore.entities.list`; Auth user pagination
requires `firebaseauth.users.get`. Role A deliberately excludes
`firebaseauth.configs.getHashConfig`, so Auth password hashes and salts are not
part of the observable `UserRecord` preimage. Preflight, both writer
invocations, and re-verification must therefore use the same frozen Role A read
set so the Auth digest remains reproducible.

Role A is read-only but sensitive: a project IAM binding cannot restrict these
Firestore entity permissions to the paths the preflight enumerates. It grants
the service account read access across the default database, including student
PII and credential documents, plus Auth user records without password hashes.
That temporary project-wide exposure is an explicit accepted prerequisite for
the bounded production inspection, not a tenant- or path-scoped control.

Role B is the later write-set transition. `datastore.databases.get` is required
by Firestore `BeginTransaction`/`Rollback`; the two entity permissions cover
the writer's create/update operations. Delete and every Auth mutation remain
excluded. Role B is defined now for review but must not be created or bound in
the Role A step. It is created and bound only under the later, separately
approved write-privilege boundary while Role A remains bound.

Both files are non-secret, tracked review inputs. They do not belong in the
ignored runtime `.state` directory and do not change retained-state file
counts. Any byte change invalidates the recorded digest and requires renewed
review and authorization before the corresponding live role operation.

Neither Role A nor Role B is required by the clean-start sequence. In
particular, Role B must remain uncreated and unbound. Any later cleanup of an
already existing Role A binding is a separate IAM decision and is not
authorized by this brief.

Each observation is itself a production `inventory.js` run. Each run requires
its own separately approved, time-bounded, checksum-bound inventory
authorization, the final clean reviewed commit, and the explicit credential;
there is no unauthorized preliminary diagnostic. If the required comparison
passes, the final-read-set observation is the fresh inventory that proceeds
through Claude and Grok review. Its deployment and active-writer values are the
sole inventory source for those fields in the new preflight expectations;
every other required expectations field retains its own separately reviewed
source. No third inventory run exists solely for expectations authoring.

The two observations must agree exactly on all five deployment surfaces and
active-writer classification; any mismatch aborts unless a separately
authorized triangulation procedure proves its cause and receives review.

Every file retained under `functions/phase3/.state/` at the pivot remains
immutable historical evidence, including superseded inventory/expectations
artifacts and the corrected N9/N10 observations. Clean start creates no new
inventory, expectations, preflight manifest, journal, or triangulation file.
Never delete, overwrite, repurpose, or change the 0400 mode of a retained file.

### Retired migration-only control-plane blocker

`PHASE3_FUNCTIONS_COPY_EXPECTATIONS_PREDICTABILITY` (N11) applied only to
pre-binding expectations for post-deploy Gen2 resources used by the legacy-copy
writer. The clean-start route has no copy expectations, preflight manifest,
writer invocation, or copied Functions surface. N11 therefore has no surviving
release requirement: it is dissolved, not renamed or deferred. Routes A, B,
and C remain unselected because no route is needed.

This conclusion does not weaken the independent final-Rules checksum gate. The
clean-start release must still verify the deployed final rules against the
reviewed repository artifact before gate activation.

The strict preflight authorization self-identifies as the production read-
preflight kind and binds the full lowercase reviewed commit SHA in addition to
the project, teacher, release/change/authorization identifiers, credential
provenance and raw-byte SHA-256, expectations raw-byte SHA-256, canonical
classroom login code, and validity bounds. Its interval is machine-capped at two
hours. Before a production preflight opens the credential, and again before
production write or re-verification reopens it, the entrypoint proves that the
anchored repository has the authorized HEAD and a clean worktree. The manifest's
authorization-artifact domain binds those exact authorization bytes, so the
authorization and same-SHA credential must be retained outside Git through both
writer invocations and re-verification; credential teardown cannot occur
immediately after preflight.

That checkout proof is operator-only. It lives in `reviewedCheckout.js`, the one
Phase 3 module permitted to run a local read-only Git command, and its only
importers are the four operator entrypoints — `inventory.js`, `preflight.js`,
`write.js`, and `reverify.js` — which run from an operator workstation. It is
deliberately NOT part of `productionEnvironment.js`: `functions/index.js` imports
that module for the V2 gate, so it ships inside the deployed Functions artifact
and must carry no subprocess capability. The shared `ProductionEnvironmentError`
and the three `checkout-*` categories stay in the guard module so every
entrypoint keeps one error type and one redacted failure path. The reviewed
boundary is therefore a proven graph property: no module reachable from
`functions/index.js` may import `reviewedCheckout.js` or `node:child_process`,
and `reviewedCheckout.test.js` exercises the real Git execution path — anchored
root, independently observed HEAD, dirty worktree, fabricated commit, and
routing-variable scrubbing — rather than only an injected substitute.

There is no shared write subcommand, `--force`, production override,
manifest-path override, state-directory override, or implicit credential
discovery. Write mode requires the retained successful preflight manifest,
exact project allowlist, reviewed release/change identifier, snapshot ID,
write-freeze proof, credential provenance, and separate authorization.

Commit 3's production preflight is read-only with respect to Firebase and
Google services. Persisting its successful local manifest is required and does
not weaken that boundary. Phase 3 owns a distinct, module-anchored canonical
state directory at `functions/phase3/.state/`; it never stores Phase 3 state in
the preserved Phase 2A slot. The directory has no CLI or environment override,
is ignored by the exact repository-root `.gitignore` entry
`functions/phase3/.state/`, and contains runtime/operator state only. Successful
preflight manifests are immutable, installed atomically without overwriting an
existing manifest, and retained for later write authorization and audit. The
runner exposes no cleanup operation. Tests may remove only state created under
an explicitly disposable test identity or isolated temporary filesystem; they
never remove an operator manifest.

The runner may reuse proven canonical/manifest concepts, but never edits or
weakens `functions/phase2/**`. For credentials it uses Phase 2B copy semantics:
flat `studentCredentials/{loginId}` remains byte-for-byte untouched; the scoped
copy changes only the generated classroom ID and deterministic V2 Auth UID.
Absence or divergence never falls back to flat data after activation.

Commit 3 may import Phase 2A's proven canonical Firestore-value encoder from
`functions/phase2/canonicalState.js` rather than vendor a second copy. That
dependency does not authorize editing Phase 2A. A Phase 3 unit test must pin the
imported encoder's canonical output and hash for a fixed representative fixture,
including a Firestore Timestamp, so later encoder drift fails loudly before it
can invalidate retained Phase 3 manifest checksums.

## 9. Release ordering and abort criteria

N11, preflight, migration writes, reconciliation, Role B, the maintenance
freeze, snapshot, bridge rules, and legacy acceptance have no step in this
sequence. The absence is deliberate: nothing is copied from V1. The old test
documents remain untouched and client-denied under final rules.

The release record now closes steps 1–9 only. It records a one-hour founding
invitation that elapsed before any recorded onboarding. Item 15 defined and
completed review of the first recovery identifier,
`phase3-expired-founding-invitation-recovery-fa733d7-v1`. Its authorized
pre-Save read emitted prohibited browser content into the conversation, so v1
terminated without an edit, Save, mutation, or onboarding and can never be
reused.

Item 16 defines the distinct privacy-preserving proposal
`phase3-expired-founding-invitation-recovery-fa733d7-v2`. It confines invitation
inspection to transient browser-control memory and permits only exact fixed-key
boolean observations to leave the page. After its own Codex, Claude, and Grok
review gates close and Andrew separately activates v2, at most one console Save
may change only the existing invitation's `expiresAt`. Every output constraint,
precondition, one-Save/no-retry rule, privacy boundary, and termination rule in
`PHASE3_RELEASE_RUNBOOK.md` is normative. V2 is not a numbered release step,
cannot activate itself, and does not authorize onboarding.

1. Complete Codex implementation and self-verification. Obtain Claude's
   detailed read-only PASS, then Grok's independent 5,000-foot PASS for the
   exact reviewed range.
2. Run the complete credential-isolated local gate, including the gate-on
   fresh-classroom Auth/Functions/Firestore seam and final-rules orphan denial.
3. Record the exact reviewed commit, V2 Functions artifact, gate-on Hosting
   artifact, final-rules hash, and the code-pinned Functions release ID
   `phase3-commit8-functions-v1`. Verify Role B remains uncreated and unbound.
4. Under separate deployment authorization, deploy the reviewed V2 Functions
   with `MULTI_TEACHER_V2_ENABLED=false`. No V2 callable may succeed yet.
5. Deploy and independently verify the checksum-pinned final rules. Do not
   deploy bridge, rollback-safe, or recursive baseline rules.
6. Prove final rules permit a fresh reciprocal owner to read/write only its
   classroom, permit exact student self-read only with an active reciprocal
   foundation, and deny legacy blobs, phantom-parent legacy mirrors,
   credentials, control documents, and cross-tenant access.
7. Configure `MULTI_TEACHER_V2_RELEASE_ID` to exactly
   `phase3-commit8-functions-v1`, set `MULTI_TEACHER_V2_ENABLED=true`, and apply
   the parameter change to the same reviewed Functions artifact. Independently
   verify both deployed values and one generic fail-closed negative probe before
   continuing.
8. Deploy and verify the reviewed gate-on Hosting artifact. Hosting must not
   turn on before final rules and the server gate.
9. Under a separate administrative-data-write authorization, create Andrew's
   time-bounded invitation in the Firebase console. Its document ID is
   `hashEmailDigest(normalizedEmail)` and its exact fields are normalized
   `email`, `status: "active"`, `createdAt`, and a future Firestore Timestamp
   `expiresAt`. No client can create or read this document. If that invitation
   expires before step 10, stop and use only the separately reviewed and
   authorized one-time recovery in the runbook; never improvise an update,
   retry, deletion, or recreation.
10. Sign in with the invited, verified Google account and invoke the normal
    `onboardTeacherClassroomV2` path. Verify one consumed invitation, one active
    teacher, one reciprocal classroom, one active classroom-code index, and
    `nextStudentNumber: 1`; do not hand-build the foundation.
11. Run fresh-account acceptance: `createStudentV2` allocates student `"1"`;
    the returned login ID and submitted PIN authenticate through
    `studentPinLoginV2`; a teacher balance/transaction batch is readable by the
    teacher and reflected in exact student self-read; cross-tenant reads fail;
    `removeStudentV2` deletes the student, retains and deactivates the
    credential, preserves the transaction, and leaves the counter at `2`.
12. Abort on any mismatch, revoke/disable the affected fresh test identity as a
    separately authorized containment action if needed, and do not add real
    students or a second real teacher.
13. Observe through the recorded pre-school rollback window. Preserve all
    fresh and legacy records and every immutable historical artifact.

Clean-start rollback before real-student rollout:

1. stop onboarding and acceptance activity, and obtain explicit rollback
   authorization;
2. roll Hosting back to the recorded default-off artifact;
3. disable the V2 server gate and independently verify V2 callables fail
   closed;
4. retain the final rules so scoped credentials, legacy blobs, and orphaned
   legacy mirrors remain client-denied — deploy neither rollback-safe rules nor
   the recursive baseline;
5. preserve all fresh and legacy documents without migration, reconciliation,
   cleanup, or legacy write resumption; and
6. diagnose and return through the full forward clean-start sequence after a
   reviewed correction.

This rollback is a pre-real-user service withdrawal, not a return to V1. It is
not sufficient after real students are admitted; that later authority boundary
requires a newly reviewed continuity and containment plan.

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
- `functions/phase2b/teacherOnboarding.js` and directly affected test, only to
  initialize the V2 classroom counter at the invitation-controlled boundary
- `functions/phase2b/syncStudentProfiles.js` and directly affected test
- `src/phase2b/tenantSession.js`, `tenantCache.js`, `tenantClient.js`, and
  directly affected tests
- `firestore.rules`
- `firestore.phase3.final.rules` and
  `tests/firestore/rules.phase3.final.test.js`, only to require an active
  reciprocal foundation for student self-read and deny orphaned legacy mirrors
- `tests/phase2b/functions-auth.emulator.test.js`, only for the complete fresh-
  classroom seam
- `tests/phase3/release-order.contract.test.js`, only to replace migration
  ordering assertions with non-vacuous clean-start and rollback invariants
- `package.json`, `functions/package.json`, and lockfiles only as required
- `.gitignore`, only to add the exact `functions/phase3/.state/` runtime-state
  entry required by the production manifest contract
- `firebase.json`
- `firestore.indexes.json` only with evidence of a required new index
- `tests/phase3/README.md`, updated only to describe suites and evidence that
  actually exist in the same commit
- `MULTI_TEACHER_ARCHITECTURE_PLAN.md`, this brief, and
  `PHASE3_RELEASE_RUNBOOK.md`, only to record the separately reviewed
  production-readiness correction or clean-start pivot boundary
- final evidence-only documentation updates

New files:

```
iam/phase3/
  phase3DataPlaneReader.yaml
  phase3MigrationWriter.yaml

functions/phase3/
  productionEnvironment.js
  productionEnvironment.test.js
  reviewedCheckout.js
  reviewedCheckout.test.js
  productionPreflight.js
  productionPreflight.test.js
  productionProjection.js
  productionProjection.test.js
  productionManifest.js
  productionManifest.test.js
  productionInventory.js
  productionInventory.test.js
  productionWriter.js
  productionWriter.test.js
  productionReconciliation.js
  productionReconciliation.test.js
  inventory.js
  inventory.test.js
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
  control-plane-inventory.contract.test.js
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

Each colocated `functions/phase3/*.test.js` file is permitted only in the same
commit as the corresponding implementation module and must exercise real
behavior; it may not be added as a placeholder. The preflight, write, and
reverify entrypoints remain covered through the production-runner suites. The
new inventory entrypoint has a colocated behavioral suite because it cannot be
executed by an emulator-backed runner without ceasing to test the real
production-only environment boundary.

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
The local gates were added only when their corresponding behavior existed. The
clean-start release gate is:

```
npm run test:phase3:contracts
npm run test:phase3:unit
npm run test:phase2b:client
npm run test:phase2b:server
npm run test:phase2b:rules
npm run test:phase3:rules
npm run test:phase3:migration
npm run test:phase3:release-rehearsal
npm run test:phase3:rollback-rehearsal
```

The migration and release/rollback rehearsals in this list are retained
regression gates. They prove the dormant code remains safe and do not turn that
code into a clean-start operator step.

`test:phase3:unit` is the emulator-free Node unit gate for the colocated Phase 3
unit suites. It requires no Firebase CLI isolation wrapper because it must not
start the Firebase CLI, an emulator, or any network-backed operation. A suite
that needs an emulator belongs under an appropriately named emulator-backed
command and inherits every isolation protection above.

Commit 3 adds the real `tests/phase3/production-runner.emulator.test.js`
behavioral suite and earns `test:phase3:migration`. That command starts the
emulators and therefore is discovered automatically by the command-safety
contract; it receives the complete credential, token, project, config,
emulator, and gate-variable isolation contract without a special-case list.
The emulator-free `test:phase3:contracts` command must simultaneously narrow
from `tests/phase3/*.test.js` to `tests/phase3/*.contract.test.js`. Otherwise its
glob would also select the new emulator-backed runner suite and execute it
without the required harness.

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
13. Production-readiness expectations-bootstrap correction: separate
    control-plane-only inventory entrypoint, immutable non-authorizing artifact,
    focused behavioral/source contracts, and governing-document updates. This
    local item performs no production read and requires focused Claude review,
    Grok independent review, and Andrew's approval before any operational
    inventory authorization is prepared or used.
14. Clean-start pivot: initialize the counter in V2 onboarding, prove the full
    fresh-classroom seam through real emulators and final rules, deny orphaned
    legacy mirrors to stale student tokens, retire migration operations from the
    release order without deleting their code, and replace the source contract
    with clean-start activation and service-withdrawal rollback invariants.
15. Expired founding-invitation recovery and status reconciliation: document a
    unique, inactive-until-reviewed console boundary that may change only the
    existing invitation's `expiresAt` through at most one Save; pin its
    preconditions, privacy, no-retry, and separate-onboarding authority in the
    release-order source contract; and reconcile source status with the external
    release record through step 9. This item changes no runtime code or
    production state and requires Claude and Grok review before Andrew may
    separately activate its identifier.
16. Privacy-preserving expired-invitation recovery: record v1 as permanently
    terminated without a Save or mutation, define a distinct inactive v2
    identifier, confine raw invitation values to transient browser-control
    memory, allow only exact fixed-key boolean observations, and preserve the
    one-field/one-Save/no-retry and separately authorized onboarding boundary.
    This item changes no runtime code or production state and requires its own
    Claude and Grok review before Andrew may separately activate v2.

Claude and Codex retain the detailed plan-build-review-correct loop. After a
material item reaches review-quality, Grok performs the bounded read-only
systems-level/residual-risk checkpoint defined in
`AI_COLLABORATION_WORKFLOW.md`. A deeper third review remains required at the
production-readiness gate.

## 14. Historical Commit 1 boundary

This section preserves the acceptance boundary used for the first Phase 3
implementation commit, `575b438`. Its absence and future-tense statements are
historical assertions about that commit boundary, not the current repository.
The first implementation item was:

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
