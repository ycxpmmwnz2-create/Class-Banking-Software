# Protected money-data check — Stage10 preparation

Status: proposed operating design for Muse then Claude review. No live runner,
production read, maintenance change or scan approval is provided by this document.
Baseline: `859946d074f2b0f6e0f5d1db1e3a74bb9823ba29`, branch
`codex/teacher-money-integrity-design`. Stage9 and its correction have both reviews
closed; L1 is closed. Their demo-only scanner remains unchanged.

Andrew requested preparation of a protected read-only check of real money data.
The intended result is a private, version-bound report of compatibility problems,
with no balance adjustment, transaction decision, deletion or initialization.
Codex owns the technical work and explains the result; Andrew need not interpret
IAM policies, trigger queues or document versions.

## 1. Decisions and scope

The future target is explicitly `morgan-bank`, database `(default)`. This is the
repository's permitted production target, not evidence of today's live state.
No default project, alternate database, force flag or emulator override is allowed.
The whole classroom namespace is fenced even if some rooms are incompatible.
Inventory must enumerate the entire classroom namespace, including missing parents
with descendants. A missing parent is an inventory blocker, not a scannable room:
operation 1 stops before maintenance, including when its only children are retained
balanceHistory witnesses. Unknown/legacy roots and invalid reciprocal ownership
likewise block entry pending a separately authorized resolution; no skipping,
recreation, migration or deletion occurs here. Only a complete inventory of existing,
valid V2 roots can become the frozen scan allowlist. A missing parent first detected
during the scan aborts the entire run as a foundation conflict. The historical
clean-start prohibition on touching V1 data remains in force.

This proposal separates three operations, each with its own evidence and scope:

1. **Read-only inventory preparation:** authorized control-plane inventory and
   minimal V2 root/owner metadata enumeration establish target, complete classroom
   IDs, deployed artifacts, writers and recovery options. Do not read students or
   transactions in this operation. Enumerate names first and use an explicit field
   mask for owner/tenant/control metadata; do not fetch a legacy aggregate while
   classifying an unknown root. Perform the final inventory after the separately
   authorized canary setup described in section 4; include that fictional classroom.
   Its output is advisory and must be revalidated before maintenance entry.
2. **Establish maintenance:** independently reviewed, explicitly authorized rules
   and Functions/configuration changes stop application writes and drain prior
   work. These are mutations; a read-only scan authorization cannot perform them.
3. **Protected scan:** the separately built read-only runner validates the approved
   scope and fence evidence, reads allowed records, revalidates versions and saves
   a private report. It cannot establish maintenance or reopen the application.

This is a proposed scan-only stopping point before design section 6 initialization.
It is not the full integrity upgrade, and does not declare its remaining services,
UI, strict rules, receipt or recovery requirements complete. A report will always
carry `initializationAllowed: false` and `activationAllowed: false`. Neither a
passing report nor this plan may be consumed by a production initializer.

## 2. Reader identity and process isolation

### Human operator and model boundary

Andrew executes the eventual reviewed live runner in his own local Terminal,
outside Codex/Muse/Claude agent tools or any terminal session whose output is fed
to an agent. The same boundary applies to live inventory, observer and credential-
verification processes that handle private data. Codex prepares reviewed tools and
step-by-step instructions using fictional fixtures; Andrew runs them and does not
need to make technical judgments about the evidence. A failed or ambiguous gate
stops the tool, rather than asking Andrew to override it. The exact execution
principal and permissions still require verification before any live operation.

Raw records and restricted manifests/evidence never enter any model context,
including manual uploads, agent file reads, shell output, computer-use screenshots,
terminal capture, transcript export or attached logs. Codex must not open those
files or operate/capture the live terminal. Putting them outside a repository is
not enough: they are outside every agent's allowed read scope. Do not upload them
manually either. Only fictional examples go into implementation/review packets.

Andrew's decision on 2026-09-27 permits him to share summary counts and fixed problem
categories with Codex. This permits only the fixed-schema, project-total summary
specified in section 7, manually selected by Andrew after the local run. It does
not permit per-room rows, IDs, teacher UIDs, paths, raw records, restricted reports,
free-text diagnostics, or automated upload. Other models receive fictional examples
only unless Andrew separately authorizes sharing the same bounded summary.
Codex explains allowed categories/counts and develops category-level remediation
proposals using fictional reproductions. Any per-record diagnosis or remediation
requires a separately reviewed local tool that reads the restricted manifest outside
all models and has its own scoped authorization; Codex never needs that file.

### Technical reader identity

The runner must use an explicitly selected, short-lived read-only principal bound
to the approved project/database. Verify its effective permissions, including
inherited/group roles and impersonation capabilities, before supplying credentials.
The intended data permissions are only `datastore.entities.get` and
`datastore.entities.list`; their sufficiency and effective scope must be verified
in implementation and staging. Do not reuse the old migration reader unchanged:
`iam/phase3/phase3DataPlaneReader.yaml` also grants Auth-user reads. Do not reuse
its writer, legacy inventory/preflight CLI, or migration authorization format.
No new role, principal, key or binding is created by this preparation.

A separate control-plane observer supplies deployment, runtime and IAM evidence;
the data runner does not gain deployment, log, IAM, Auth, secret, export or write
privileges to collect it. Firestore IAM may allow broader reads than the classroom
allowlist: treat that as a disclosed privilege boundary, never as path isolation.
The runner's narrow path adapter and owner/scope checks enforce the application
read boundary. No assertion that ordinary Firestore Rules constrain Admin reads.

No ambient ADC, cached Firebase CLI session, service-account key file discovery,
metadata-server fallback, emulator host, custom endpoint or existing global SDK
app. Credentials are acquired explicitly outside model-visible output and shell
arguments; never copy them to a packet, command history, report or log. A missing,
expired, wrong-target or unverified credential aborts before data reads. The
implementation must pin and test the real SDK transport and project/database
construction, not rely on a caller-supplied environment label or `.projectId` alone.
No SDK is constructed merely by importing the module, asking for help or validating
a plan. Credentials need not be read to prepare or review this design.

Bind execution to the exact reviewed source commit, dependency lockfiles and
runner bytes, a clean checkout, and the reviewed runtime. The production runner
must expose only list/get capabilities, never transactions, batches, create, set,
update, delete, Auth or provider calls. SDK automatic retries remain read-only and
bounded by the run deadline. There is no automatic credential refresh or restart
past authorization expiry and no continuous listener. Root/Functions entrypoints
and the browser import graph must not reach the operator runner.

## 3. Evidence before any money read

The operator's restricted execution record binds all of the following:

- Unique run ID; target project/database; exact reviewed runner commit and hashes;
  canonical sorted classroom allowlist and its digest; operator principal;
  Andrew's explicit scan scope; issue time, start deadline and absolute expiry.
- Reviewed live baseline/recovery inventory hashes; maintenance rules release
  identity and content hash; all serving Function revisions, routing/traffic and
  exact relevant parameter bindings; trigger definitions and delivery policy.
- Writer inventory and bounded drain evidence; audit-exception reconciliation;
  client-write-denial evidence; evidence collection times and collector identity.
- Exact private output directory, report schema/size budget, source/read budgets,
  and the planned maintenance recovery procedure and its separate authority.

Proposed bounds for the initial implementation are a 30-minute authorization and
15-minute scan deadline, both within the independently verified maintenance window.
The observer collects entry evidence and post-revalidation interval evidence under
the interface below; the runner checks its bindings before publishing the report.
If a safe drain cannot fit the window, stop and reschedule;
do not extend authorization, infer a new window or shorten drain to meet a timer.
Host UTC and a monotonic elapsed timer are recorded; neither is a database clock.
Clock rollback, expiry, changed scope or changed evidence invalidates the run.

These artifacts are consistency/provenance records, not proof of Andrew's approval,
IAM authority or physical quiescence. A Boolean such as `maintenanceVerified: true`,
a typed acknowledgment, hash, quiet dashboard or timestamp cannot establish the
fence. The reviewed local observer must inspect independent platform evidence,
retain its source and verify it still applies. The implementation must not offer a self-asserted
`--fence-verified` bypass. Exact platform collectors, effective-permission checks,
credential acquisition and drain procedures are implementation/release prerequisites;
until they are implemented, rehearsed and verified, there is no launchable check.

### Observer-to-runner interface

The observer owns live platform inspection; the data runner never independently
queries deployment, log or IAM APIs. Before reading data the runner receives an
entry record binding the run ID, target, scope digest, reviewed source, writer
inventory, approved rules/revision/parameter state, collector identity, evidence
references and observation start. The local observer verifies that record's
provenance against independently collected platform evidence, outside any model. Typed assertions or a
matching digest alone cannot satisfy this gate.

Before each data batch the runner checks only its local authorization expiry,
absolute deadline, monotonic-clock continuity and immutable entry-record bindings.
Those checks do not prove the live fence is still present. Independently, the
observer tracks the complete interval from entry through AFTER the last version/
namespace revalidation read, including rules releases, deployments, traffic and
parameter changes, writer eligibility and relevant trigger/queue/drain evidence.
It must use change-history evidence, not just matching entry and exit samples.
A reopen followed by a re-close invalidates the run even with unchanged data.

The runner finishes revalidation and provides the observer with a completion
boundary and digest of the provisional scan evidence. The observer returns a
post-revalidation record bound to that boundary/digest and the same run, target,
scope and entry record, plus interval start/end and source completeness evidence.
Missing, delayed, inaccessible or incomplete change history cannot be treated as
"no changes"; the collector needs a verified completeness boundary covering that
interval or must abort. Collector implementation must demonstrate this capability
for every relevant platform surface before live use; there is no assumed API or
fixed log-settling delay that makes it complete.

The runner publishes only after verifying the post-revalidation record's binding
and coverage and incorporating its digest into the restricted manifest. Until then
results are provisional, never a completed report. The observer/operator maintains
the external fence through publication acknowledgment; known changes or an
unverifiable interval through publication abort. Recovery/reopen cannot race this
handshake. The runner rechecks local expiry/deadline/bindings before publication.
The record is retained operational evidence, not a cryptographic proof of truthful
collection or a future-write guarantee. Independent platform verification and the
external fence remain required; digest validation does not replace either.

## 4. Fence and drain, including the audit exception

The gate is a verified freeze of the scanned data, not a claim that every write in
the project has stopped. The source of truth for selective admission is
`MAINTENANCE_MODE_CONTRACT.md`, which refines the earlier design's gate wording.

### Canary lifecycle and frozen scope

Before the final operation-1 inventory and any maintenance changes, separately
review/authorize setup of a dedicated fictional teacher/classroom and known-valid
old-client probe data. The restricted operation record must bind exact, non-reused
canaryTeacherUid, canaryClassroomId, canaryStudentId and canaryTransactionId values,
with these explicit paths (symbols are bound in that record, not guessed at run time):

- `teachers/{canaryTeacherUid}` and `classrooms/{canaryClassroomId}`;
- `classrooms/{canaryClassroomId}/students/{canaryStudentId}`;
- `classrooms/{canaryClassroomId}/transactions/{canaryTransactionId}`;
- `classrooms/{canaryClassroomId}/studentDisplay/rent` if used by a probe.

Setup must preserve the real reciprocal active-teacher foundation and student/ledger
contracts. Auth/foundation/code-index or other supporting records created by the
separately reviewed setup are explicitly inventoried in its private lifecycle
record; they are not new scan read paths. Check path absence/ownership before setup;
never borrow a real classroom, overwrite records or forge a foundation casually.

Final inventory includes the canary as declared fictional scope in the complete
classroom allowlist; it is subject to the same scan and compatibility checks. Run
the expected-denied SDK/REST/batch/transaction probes after interim rules deployment
but BEFORE fence acceptance. The probe identities and payloads must otherwise be
valid for the corresponding prior writer, so an unrelated auth/schema failure
cannot pass as maintenance denial. An unexpected successful write or ambiguous
probe aborts fence acceptance and requires separate resolution and a fresh inventory.

After fence acceptance, no canary setup, fixture mutation or cleanup is allowed
until report publication. No background cleanup timer or finally-block cleanup.
After publication, cleanup requires its own explicit authority and complete known-
path/descendant accounting, including possible audit witnesses. Never delete a root
alone and strand a phantom parent. If cleanup cannot be completed safely, retain
the declared fictional scope and report that status. Cleanup changes invalidate
this report for later reuse; any later scan needs a fresh complete inventory and
fence. For an aborted run, first close that run as aborted and authorize recovery
separately before cleanup; never resume it with a changed canary scope.

### Establish and verify the fence

1. Inventory every deployed callable/HTTP endpoint, trigger, active or routable old
   revision, scheduler/task producer, operator job and other Admin writer. Source
   export inventory is only a comparison baseline. Unclassified writers or uncertain
   deployment state block entry. Include pending deliveries, retries and admitted
   transactions, not only requests arriving after the window begins.
2. Establish and independently verify the exact interim client-write-denying rules
   release against the actual live rules baseline, for the whole project. Preserve
   its documented read/suspension limitations. Test direct old-client SDK/REST,
   batch and transaction denial using an explicitly authorized fictional canary;
   never probe a denial by trying to change a real balance. Canary setup/cleanup is
   separate authorized mutation, not part of the read-only runner. Rules Playground
   or emulator-only evidence alone is insufficient for live propagation.
3. Close new application-writer admission using the reviewed maintenance-aware
   revisions and exact mode `closed`. Keep global V2 enabled with its correct
   project/release binding so legacy handlers stay denied and the balance-history
   recorder can finish. Verify the actual starting value: if global V2 is off,
   enabling it is an explicit reviewed maintenance mutation, including its legacy-
   trigger and recorder effects, never an assumed existing state. Do not use
   global-off as drain, or assume changing a local
   parameter affects all instances/older revisions. Verify every active revision.
   No `verification` mode is needed by this direct operator check.
4. Drain or disable all remaining old/in-flight writers and queued work capable of
   changing roots, owners, students, ledger or rent. Account for open transactions
   and retry lifetimes using the actual platform configuration. Retain independent
   evidence that they can no longer commit. A fixed sleep, zero observed requests,
   mode switch, stable pair of data reads or lack of logged errors is insufficient.
   If that cannot be established within a bounded procedure, the scan does not run.
5. Keep `recordStudentBalanceHistoryV3` available for its deterministic, create-only
   `classrooms/{id}/balanceHistory/{id}` witnesses. Verify the deployed exception
   cannot mutate any scan input or call another writer. Reconcile expected admitted
   student versions with delivery/skip/conflict outcomes THROUGH transition and
   final observation. `retry: true` is not a replay or eventual-delivery guarantee.
   Missing continuity stays unavailable; no witness is fabricated or overwritten.
   Unknown/unreconciled transition outcomes block fence acceptance. Known historical
   gaps remain explicitly unavailable and cannot become a history-completeness claim.
   A pending or transiently failing retry cannot be relabeled "unavailable" merely
   to meet the window. The rehearsal must distinguish reconciled terminal gaps from
   unresolved delivery; the latter keep entry blocked until resolved or the run is
   abandoned. No timeout waives this requirement.
6. Profile-sync admission remains closed; its nonretry events may be lost. Require
   a separately authorized, privacy-preserving credential consistency verification
   across the transition before declaring the operational fence accepted. The money
   runner does not read PINs/credentials to do this. Missing verifier/evidence blocks
   acceptance, not an implicit waiver. Keep provider-drain status separate from
   money-data stability; never claim all external work stopped from this scan.

The observer/operator controls configuration and operator changes through the
section 3 publication handshake. Its interval evidence, including change history,
must reject any new routable writer, reopen/re-close, uncertain trigger state or
unverifiable interval even when stored versions happen to match. The data runner
only validates the local guard and observer-record bindings described there; it
cannot claim to inspect live control-plane state. Abort instead of publishing a
successful prefix when those obligations are unmet.

## 5. Exact data boundary and compatibility coverage

The data reader permits only these paths, after approved namespace comparison:

| Surface | Read scope | Retained evidence |
| --- | --- | --- |
| Classroom roots | Entire approved `classrooms` namespace | Paths, exists/create/update versions, scoped findings |
| Teachers | Only approved owners referenced by those roots; field mask `uid`, `status`, `classroomId` | Reciprocal active ownership and version, no email/profile values fetched |
| Students | Every `classrooms/{id}/students` document | Version, money/schema/parity/capacity findings |
| Ledger | Every `classrooms/{id}/transactions` document | Version and compatibility findings, including every Pending row |
| Rent | Only `classrooms/{id}/studentDisplay/rent` | Presence/absence and version plus shape/amount findings |

No collection-group query or recursive subcollection walk. No V1 aggregate, flat
credentials, studentCredentials, studentPins, Auth users, invitations, loginHistory,
balanceHistory or operator journals are read by this runner. The separate fence
observers have their own reviewed, explicitly bounded access; this plan grants none.
Roots are read in full for projection and can contain incidental private fields;
teacher reads use the field mask above. Raw records stay only
in process memory, without inspection through model tools, debug output or crash
dumps. The adapter must validate paths before fetching each batch; never follow a
foreign teacher or classroom reference outside the approved ownership inventory.

Reuse Stage9's reviewed money rules without relaxing numeric, identity, parity,
reserved source/category or capacity checks. Positive numeric IDs/exact transaction
keys intentionally remain stricter than the historical projection. Preserve missing/
null settings defaults, optional empty text, padded valid strings, historical
Approved/Denied amounts and removed-student history exactly. No trim, rounding,
coercion, remediation, Pending decision or balance reconstruction is performed.

Close the known coverage gaps as part of the future implementation: run the real
pure `projectClassroomData` against each room's same root, students, ledger and rent
with `loginHistory: []`. Cover credential-named nested keys, root tenant tag,
lastBackupAt, settings and rent, alongside Stage9 money analysis. Map thrown errors
to fixed safe categories; never retain their message/details, which can contain
identifiers. Pin the projection's default-settings input against the current client
call site and test equivalent fixtures. Never retain the projected aggregate.
This checks only the supplied surfaces: synthetic empty login history cannot prove
live login-history validity, full UI renderability, authentication or client access.
A pass must state these exclusions, not claim complete classroom readiness.

Require unique reciprocal active owners, valid tenant paths and complete namespace.
Structural foundation, scope or read incompleteness aborts the whole run. Money,
shape/projection and capacity blockers produce a completed report with blocked
classrooms; they never permit a partial activation. Absent/valid existing classroom
controls are recorded unchanged; malformed control is a blocker, and suspended
classrooms require explicit operator scope, not a teacher-role workaround. Existing
controls do not authorize scanning. Stage8 L2 foreign empty-run ownership remains
unresolved because this operation reads/writes no initialization journal.

## 6. Completeness, resource bounds and revalidation

Initially retain Stage9's conservative 1–100 classrooms, 20,000 total documents,
100,000 findings, 25-document query pages and size/headroom thresholds. Count rent
and owners in the total. Add a reviewed 64 MiB decoded-input budget, 32 MiB private
report budget and the absolute deadline. Exceeding any limit aborts the whole run;
no prefix counts as completion. Streaming/backpressure and a bounded transport must
reject over-budget responses before retaining them. SDK/OS buffers need measured
headroom; this is not a promise of exact process RSS or billing cost.

Do not carry Stage9's unbounded `listDocuments()` materialization into a production
runner silently. Implement and test a bounded, paginated namespace reader that
includes missing parents with descendants and rejects repeated tokens, duplicates,
non-monotonic pages or truncation. The chosen real API/SDK pagination and missing-
parent behavior must be verified before implementation review can close. Names
alone must match exact allowlisted paths; no unexpected collection content is read.

Retain every input document's full create/update timestamp (seconds/nanoseconds),
collection membership and rent existence. Re-enumerate every scanned collection and
compare its complete path/version set; reread owners, roots and rent including
absence-to-presence, delete/recreate and edits restored to their former value.
Before each batch, check local authorization expiry/deadline/monotonic time and
entry-record binding only. After final revalidation, require the observer's complete
interval record and bind its digest before publication as specified in section 3.
Changed, missing, inaccessible or indeterminate evidence aborts. Immutable input
copies prevent caller mutation during awaits; no resume from a partial report.

These reads are not an atomic snapshot. Consistency depends on the independently
maintained external fence, plus detected-drift rejection. This report expires with
the window or any loss of the fence. Future initialization or correction requires
its own reviewed consumer, fresh complete scan/version revalidation and authority;
a stored digest or old report must never bypass that requirement.

## 7. Private report and safe output

Normal output to Andrew's non-agent local terminal is a fixed-schema summary:
completion/abort status, project-total room/student/ledger/Pending counts, counts by
fixed reason, blocked-room count, and always-false initialization/activation flags.
No per-classroom breakdown or stable run identifier is included in this summary.
No document paths, IDs, names, balances, amounts,
text, error details or raw SDK responses reach stdout, stderr, chats or providers.
Summary counts still describe a class. Andrew may manually share ONLY this bounded
summary with Codex under his section 2 decision; the runner never uploads it and
Codex never runs the live command or reads its local output files to obtain it.
Abort output is a fixed category and says no complete report was published.

The restricted manifest additionally binds source hashes, scope, principal/approval
and fence-evidence references, observation times, document presence/versions,
per-room outcomes, finding locations and mirror indices, capacity estimates and
its digest. No original values, names, credential fields or projected aggregate.
Fixed finding codes identify a problem without echoing an offending field value.
The digest detects mismatched artifacts; it is not a signature or trusted approval.
No report is an automatic repair plan or complete historical ledger reconstruction.

Use an explicitly selected private local directory outside repository, review
packets, attachments and synced folders. Check owner-only directory permissions
(0700), regular report files (0600), ownership, non-symlink paths and non-reused
run ID; refuse permissive/existing targets. The implementation must use exclusive,
no-follow creation and descriptor-based verification, not only a racy path check.
Use a private temporary file, bounded serialization, flush/fsync, no-clobber atomic
publication and directory durability check. Publish completion only after readback
and digest verification. Crash, disk-full, symlink/hardlink collision, existing run,
permission failure or interrupted publication must never leave an apparently
complete report. Do not overwrite or automatically delete a prior run. Verify the
actual macOS filesystem primitive and adversarial cases before choosing it.

Keep the private record locally until the maintenance decision and follow-up review
finish; then Andrew decides retention/deletion. Never upload it, manually or
automatically, to Muse, Claude, Codex, GitHub, backup services or any model, and never
read it through agent file/shell/computer tools. Reviews use only fictional reports.
Only the bounded summary has the manual-sharing exception in section 2.
Operating-system administrators or a compromised machine are outside the file-mode
protection claim; raw memory/credential erasure is not guaranteed by JavaScript.

## 8. Stop, recover and explain the result

A blocked completed scan changes no data. If Andrew shares the permitted summary,
Codex explains its categories/counts and prepares a category-level remediation
proposal using fictional reproductions. Codex does not inspect the restricted
manifest; any per-record follow-up uses separately reviewed/authorized local tooling
outside model context as required by section 2. A failed/interrupted run cannot
be reused;
start with a new run ID and fresh evidence only while authorization remains valid.
No retry automatically opens maintenance, changes rules or resumes teachers.

Before starting the maintenance window, independently verify a concrete recovery
procedure and available artifacts. Scan-only exit may restore an authorized prior
service/rules configuration only after proving no initialization, control change,
new-protocol money commit or incompatible data mutation occurred and checking that
the recovery preserves current guarantees. An unknown history or missing compatible
artifact means remain closed for operator resolution. Restoration is a separate
mutation and is never performed by the reader or triggered by a passing report.
After any new money operation, do not restore permissive legacy rules or old writers.
The scan is not a backup, restore rehearsal or proof that deployment is reversible.

## 9. Implementation and review acceptance

This change is preparation only; the following tests are requirements, not passing
results. Build one bounded runner/adapter/report-storage candidate after design
review, leaving the Stage9 demo gate intact. Review any shared-core extraction and
both callers together; never obtain live access by relabeling the demo handle.

| Boundary | Discriminating implementation evidence required |
| --- | --- |
| Pre-read guard | Wrong project/database/principal, expired/unbound/tampered evidence, dirty checkout, unknown flags, emulator or ambient credential settings yield zero data reads and no SDK fallback |
| Scope | Two tenants with overlapping student IDs, foreign owner, extra root, missing scope, duplicate ID/token, interrupted page and over-budget result abort without a successful prefix; missing root with only balanceHistory children blocks operation 1 before any maintenance mutation, and a newly missing root aborts the scan |
| Read-only | Capability spies observe no write/Auth/provider calls on success, failure and retry; separate staging effective-IAM proof and write denial on a fictional target |
| Compatibility | Real projection on identical root/settings/rent fixtures, nested credential fields, tenant mismatch, backup timestamp, optional/default cases, all Stage9 numeric/parity/history/capacity cases |
| Drift | Changes during await, namespace growth, create/delete/recreate, rent absent-to-present, owner/control change, config reopen, clock rollback and authorization expiry invalidate publication |
| Fence | Old-revision/in-flight/queued writer and lost profile-sync cases block; audit-only late witness is accounted for; pending retries cannot be timed out into known gaps; reopen-then-reclose between entry/exit samples invalidates via change history; missing/delayed history or wrong run/boundary/digest blocks publication; runner makes zero control-plane calls |
| Reports | Canary secrets/identifiers in all input/error fields never appear in safe summary; full operator rehearsal proves no raw/restricted data enters any agent transcript or tool-read log and only the manually chosen total-count/fixed-category summary is shared; size/depth caps, restrictive modes, existing target, link races, crash/disk-full and durable readback are exercised |
| Separation | Runtime/browser graph cannot import operator code; unchanged demo entry still rejects real projects; no report consumer can initialize or activate |
| Recovery | Fictional full sequence including abort-before-scan and failure after report; no automatic resume or data mutation; missing recovery artifact blocks maintenance entry; canary setup before final inventory, probes before fence acceptance and authorized cleanup after publication succeed, while undeclared canary or cleanup during the fenced scan aborts |

Use existing `test:phase3:unit`, `test:phase3:contracts`, and the guarded
`test:phase3:money-compatibility` baseline where applicable. Add a separately guarded
fictional-project suite for new operator seams; never point an emulator command at
production or infer IAM/drain from emulator results. Verify Node22 target and actual
operator runtime, plus installed SDK transport/limits. Do not label document checks
as these behavioral tests. Changes go through Codex, Muse, then Claude; only the
exact closed candidate can become the subject of a concrete live-operation request.

## 10. Current readiness and next gate

Andrew is the designated human operator, and summary-only sharing with Codex is
approved as described in section 2. No current classroom/canary IDs, execution
principal or effective IAM, live writer inventory, fence/drain, recovery artifacts,
credential verifier, bounded production reader or private
report persister have been verified for this proposed operation. A prior offered
maintenance day is not a current window. Nothing here closes the remaining upgrade,
strict-rules, operator-audit, Stage8 L2 or production gates.

Next: Muse reviews this plan against the included source, then Claude independently
reviews the design. Codex builds and rehearses the agreed runner and safeguards.
Before real access, Codex presents Andrew a short concrete scope for the authorized
inventory, maintenance mutations and scan, with actual artifacts and recovery.
There is deliberately no copy/paste production command in this preparation.
