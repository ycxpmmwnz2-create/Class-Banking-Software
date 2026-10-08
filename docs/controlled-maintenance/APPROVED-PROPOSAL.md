# One controlled maintenance release — proposed assurance amendment

2026-10-08, correction R2 (Claude C1/C2). Baseline: `9cce606d1ab4623627084f6e49ee65b22f9a4916`.
**Design proposal only. No accepted amendment, implemented runner or live operation.**

## 1. Decision and scope

Finish the reviewed money-writer upgrade on the existing Morgan Bank project using
one controlled maintenance window. Keep the existing classroom data and history.
Do not introduce another application architecture, replace the database, migrate
legacy V1 data, rebuild historical transactions, or add optional functionality.

The proposed change is an explicit **operational assurance standard** in place of
the existing universal continuous-proof standard. Those are different guarantees.
The new standard combines a trusted administrator/change freeze, direct service
inventory, completed maintenance actions, observed retirement of old writers,
version-bound validation, transactional controls and post-release checks. It does
not prove the absence of an invisible, compromised or undisclosed privileged writer.

Codex recommends reviewing this bounded change rather than repeating the already
completed Stage14, Stage15 and Bundle A investigations into unavailable history
cursors. Reviewer acceptance must distinguish technical coherence from Andrew's
acceptance of the changed assurance and from actual production qualification.
Andrew's general request to finish is not recorded as that specific risk acceptance.

This proposal does not amend runtime code, enable a bypass flag or make the old
protected scanner accept weaker evidence. Until both reviews and the scoped owner
decision close, the original NO-GO remains authoritative.

## 2. Exact contract changes proposed

| Existing requirement | Proposed replacement, for this one release only | What remains unproved |
| --- | --- | --- |
| Gap-free history of every relevant change across all nine observer surfaces through publication | Named administrator/change freeze, direct service observations before entry, before each state-changing phase and before exit; retained operation receipts and diagnostics; abort on observed drift or unknown required inventory | A change and reversal between observations or delayed/missing telemetry |
| Independently excluded arbitrary external Admin/configuration writers | Enumerated known principals/tools/automation, stopped conflicting jobs, one trusted release operator, explicit freeze by every identified administrator | Malicious/compromised privileged actors, undisclosed credentials or an administrator violating the freeze |
| Complete proof that every old invocation/queue/retry has drained | No routable old revision; completed retirement actions; actual old-generation execution-stop observations and reconciled database effects; no known work still able to mutate money/credentials; operational acceptance described below | Unobserved already-admitted work or telemetry gaps below the available service visibility |
| Exhaustive immutable effective-reader capability certificate over the whole interval | Dedicated short-lived reader, current directly inspected policy/role/ancestor/impersonation scope, known policy freeze, separate observer and constrained transport; unknown relevant authority refuses admission | The observer cannot certify every possible concurrent or undisclosed privilege change |
| Independently proven exclusion of every model process from the operator host | Retain human-only private operation; use a separately controlled operator session/host, with agent access, capture and sync disabled by the operator, reviewed file permissions and fictional privacy checks | A compromised host or hidden process is outside the trusted-host assumption |
| D1 steps 2–4 defer guard-aware Functions deployment until after initialization and disable the global V2 gate | After the verified client fence and pre-rollout trigger checks, R1 supersedes same-named Functions with pinned reviewed bytes, V2 enabled and exact closed mode; retain the audit recorder through R2–R4; R4 changes admission configuration on those bytes | Rollout alone does not stop old invocations or guarantee trigger delivery; R2 retirement and reconciliation remain mandatory |

No automatic weakening applies to other operations. Specifically:

- `PROTECTED_MONEY_SCAN_PLAN.md`, `MAINTENANCE_MODE_CONTRACT.md`,
  `CLOUD_SCAN_PROOF_DECISION.md`, `REAL_DATA_SCAN_FEASIBILITY.md`,
  `PRODUCTION_MONEY_CUTOVER_PLAN.md`, decision D1 in
  `TEACHER_MONEY_INTEGRITY_AND_RECOVERY_DESIGN.md`, and `CUTOVER_QUALIFICATION.md` contain the old
  gates. A subsequent accepted amendment must identify these exact substitutions
  together. Merely adding a new launcher next to them is not enough.
- Advisory snapshots remain advisory. A report still cannot initialize or activate.
  No existing report schema, false eligibility flag or demo transport is changed.
- The source/runtime/project binding, privacy restrictions, money invariants,
  narrow audit exception, authenticated tenant isolation, idempotency, resource
  bounds and preserved journals remain mandatory.
- No operator checkbox called `fenceVerified` can assert the old guarantee.
  A future record must name this assurance version and identify operator assertions,
  observed evidence and unknowns separately. Old consumers must reject that record.

## 3. What the code already provides

- `teacherAwardService.js` reads reciprocal foundation/control in every transaction
  callback; new money work requires active/current generation before staged writes.
  Exact committed receipt replay is separately validated and does not repeat money.
- `studentMoney.js` reads classroom/teacher/credential and checks current control
  inside its balance/ledger transaction. Root modification conflicts with an
  overlapping transaction; a retry must read the changed control.
- `studentLifecycle.js`, `teacherProfile.js` and `resetStudentPin.js` enforce their
  corresponding checks within the mutation transaction. Profile sync has its own
  lifecycle/credential guards; it is not a substitute for checking old revisions.
- `firestore.phase3.money.rules` constrains client writes separately from server
  code. `firebase.json` does not yet select it, and `index.html` still imports the
  general saver. The final selection delta is real remaining release work.
- `classroomInitialization.js` is demo-only, absent-control-only and has a shared
  ownership record. It is not the production initializer. Active-to-readOnly,
  metadata and activation need the previously reviewed separate protocol.

Firestore serializable transactions support the first two points, but only for
participating code. They do not neutralize old Admin code, client writes under old
rules, already-sent provider requests or a separate administrator. Those limitations
are the reason for the maintenance stages below. See SOURCE-BASIS.md S1 for the
documented transaction primitive and its limits.

## 4. Concrete release sequence and stop conditions

The subsequent implementation is one bounded operator workflow with a persistent
journal, not a set of self-certifying boolean files. Existing A/B/C deliverables
are consolidated into the stages below; no new feature work is introduced.

### R0 — Bind and rehearse before scheduling downtime

Pin commit, clean build, dependencies, runtime, functions export/source hashes,
strict rules and narrow-saver composition, exact configuration and rollback set.
Bind `morgan-bank` / `(default)` plus observed database identity. Private inventory
must enumerate all current relevant deployment generations, regions, routes/tags,
triggers, queues, schedulers, runtime identities and known external operator jobs.
Include inherited policy scope and impersonation; an unavailable region, unknown
writer or unknown relevant privilege stops preparation.

Do not infer actual deployment from GitHub or source. Do not use the historical
clean-start inventory as current evidence. Review the actual inventory privately;
model output receives only already authorized fixed summaries.

Before entering maintenance, the artifact must include the exact endpoint/action,
old identity, producer handling, credential behavior and rollback for every writer.
Only Cloud Run/Functions configurations covered by the implemented adapter may be
used. Unknown generation/deployment type is a stop, not a generic delete fallback.
No service deletion, IAM revocation or runtime-secret change is preauthorized here.

Use existing emulators for money/rules/concurrency/recovery/browser cases. Real API
masking can be qualified against owned fictional records under a separate narrow
scope on the existing project. A second Firebase project is not a prerequisite
merely because the plan uses the word staging. Disruptive old-writer/trigger tests
must not run alongside real classrooms: isolate them on a separate test project
if they are required to qualify the selected mechanism, or stop that mechanism.

### R1 — Close new user and server admissions

Announce a maintenance window; serve the maintenance client and deploy the pinned
interim deny-write rules. Valid, authenticated fictional SDK/REST/batch/transaction
attempts must be denied, with a prior positive control and exact serving artifact
readback. An invalid token/payload is not a passing denial test. Stop if any path
writes. Do not infer rule propagation solely from deployment success.

Before superseding Functions, stop scheduled producers and conflicting operator
jobs, take validation pass V1 (defined in R2), and observe settlement of existing
old-revision trigger deliveries. In particular, profile-sync events are nonretry:
delivery to the closed replacement can be lost, so a rollout acknowledgment is not
evidence of successful credential sync. Account for deliveries throughout the
transition and check credential consistency in V2/R3; a missing required signal,
unsettled delivery or unexplained mismatch stops progression. Do not silently
discard an event or replay a credential mutation to make this gate pass.

Then supersede the same-named Functions through a normal rollout of the exact
reviewed Functions bytes pinned at R0, with `MULTI_TEACHER_V2_ENABLED=true`, the
matching project/release bindings and `MULTI_TEACHER_V2_MAINTENANCE_MODE=closed`.
Read back the actual serving revision and configuration and verify its admission
behavior. This replacement closes new callable/provider admissions, refuses legacy
callables and makes the legacy profile trigger inert. It admits only the reviewed
create-only balance-history recorder under the retained global guards. It does not
cancel work admitted by a superseded revision. Until all callable replacements
have passed readback, treat remaining old endpoints and their generated events as
old writers under R2, not as already closed.

Preserve the audit trigger/consumer through the rollout and R2–R4; do not delete it
and recreate it after preparation. Keep its global V2 bindings and exact closed
mode valid. Reconcile witnesses for commits across the transition, including old
work that finishes late. A gap or unknown delivery cannot count as a successful
audit handover. Do not globally disable V2: that would silently discard witnesses.
This explicitly substitutes the deployment/global-gate ordering in D1 steps 2–4;
new callable money work still remains denied before preparation and activation.

### R2 — Settle superseded writers and reconcile their effects

Normal R1 rollout supersedes same-named exports; it does not require deleting every
service. The remaining inventory covers old tagged/routable revisions, work still
running on superseded revisions, production Functions absent from the reviewed
export list, and outstanding trigger/retry deliveries. Bind a reviewed action to
each unmatched writer; remove an old tag or retire an unmatched function only by
that exact per-writer action. Preserve the replacement audit recorder. Manual
scaling zero misses tag-only revisions (SOURCE-BASIS.md S2). Any required deletion
must finish and be read back; acknowledgment alone does not stop instances (S3–S5).
No first-generation adapter is inferred from second-generation documentation.

For each old writer, R0 must name the actual platform instance/execution signal,
the old revision identities it covers, the configured maximum timeout, the relevant
shutdown grace, and the trigger/retry inventory or non-mutating destination. Record
event/observation times, scope, sampling and ingestion limits. These are required
fields in a future adapter's evidence, not an assertion that such a signal exists.
If the actual service cannot supply that signal, stop that writer's qualification.
Do not substitute a guessed API, an empty log search or a new abstract proof study.

All of the following must pass for that writer:

1. Successful, completed supersession/retirement operations are bound to exact
   resources and versions. A fresh direct inventory shows no traffic or tag route
   to its old revisions and no usable old callable URL. Account for region errors,
   producer destinations and every unmatched export; an unknown remains a stop.
2. The named platform instance/execution signal shows no running work on those old
   revisions, observed after completed retirement/supersession plus that writer's
   configured maximum timeout and applicable shutdown grace. This interval sets
   the earliest observation; elapsed time or HTTP timeout never supplies the
   no-running-work evidence. If the signal is stale, ambiguous or lacks coverage,
   stop. A request timeout does not establish instance termination (S5).
3. Event-triggered writers have no undelivered or retrying deliveries capable of
   protected mutation, or those deliveries have a reviewed, verified destination
   that cannot mutate protected money/credential data while closed. Account for
   the create-only audit destination separately and reconcile its expected events;
   neither purge nor silent profile-event loss is a permitted settlement method.
4. A terminated execution can be marked execution-settled even if its reply was
   lost or its result is unknown to the caller. This does not mark its mutation
   successful or authorize replay. Any committed effects must be explained by V2
   below. Known database/provider requests or retries that may still complete
   independently remain outstanding; termination of their caller does not settle
   them. Only an unknown reply to otherwise settled work can proceed. Work that
   could still mutate protected data, or an unexplained stored effect, blocks.
   Separate Insights provider uncertainty retains the R5 full-feature closeout gate.
5. Two bounded, complete version-bound validation passes account for the transition:
   V1 runs after the client fence and before R1 supersession/other old-writer
   retirement; V2 runs after the last required settle observation and before R3's
   first write. They inventory the same complete protected scope with the R3
   privacy, masking, compatibility and resource limits. Reconcile changed versions
   against valid committed balances, ledger/mirror records, credentials, receipts
   and expected audit witnesses. Normal old work may finish between passes; equal
   versions are not required, but unexplained or inconsistent effects stop. These
   reads grant no preparation authority until every R2 predicate passes.

No fixed sleep, HTTP timeout, quiet logs, zero traffic percentage or successful
deploy alone passes R2. A lost reply alone does not block forever; an execution
or downstream mutation that may still run does. This is a concrete per-writer
acceptance rule to qualify during R0, not a claim of live platform qualification.

**Residual limit:** even this combined record is not the former mathematical
zero-work/continuous-history proof. An unobserved delayed privileged write could
escape observations and conflict with the release. That risk is explicitly part
of the proposed owner decision; it is not solved by renaming UNKNOWN to drained.
Retain raw private uncertainty details and label the result `operationally-cleared`,
never `complete-interval-proven`. These labels describe a proposed schema, not an
implemented or accepted runtime state.

### R3 — Validate and prepare existing classrooms

After R2, enumerate all foundations, including missing-parent descendants, with
real wire masks and bounded pagination. Reject malformed/legacy/unknown ownership
globally. Check balances/ledger/mirrors and credential consistency privately using
the reviewed predicates. Do not read PIN material into the money scanner. Stop on
unsupported data; no automatic repair or invented historical transactions.

Keep the existing whole-project ownership/journal protocol and every-transaction
foundation revalidation. For absent controls create readOnly generation 1 with its
atomic audit; for existing active controls use expected generation plus a strictly
increasing generation and the separate transition audit. Preserve readOnly and
suspended controls. Reject unknown audits and incompatible existing metadata.
Reconcile actor/quota/receipt records without resetting counters or losing pending
acknowledgments. Each transaction preserves balances, ledger, mirrors and credentials
except separately scoped credential verification (which remains read-only here).

Bind read/write/byte/deadline/retry budgets; preserve exact lost-response recovery,
whole-plan drift refusal and terminal-abandonment rules from the reviewed cutover
plan. No force unlock, journal deletion or age-based takeover. A failure leaves the
project in maintenance with its partial journal available for exact recovery.

### R4 — Verify the new closed deployment and activate

Keep the same pinned Functions source bytes already deployed in R1. Change only
the reviewed admission configuration from closed to verification when required,
then publish strict rules and the narrow-saver client in the reviewed order.
Re-verify every serving revision/configuration after any rollout needed to apply
the mode; do not assume an in-place parameter refresh. `getStudentSettingsV2` is
already deployed by R1 before its dependent client (closed/verification denies
its calls until normal admission). Retain the exact creation-key versions and all receipt,
dispatch and settlement readers needed by existing records; no secret values in
logs, packets or model context.

Revalidate deployment identities, all classrooms, ownership, journal and R2 evidence
before activation. Compare this post-R3 pass with V2, allowing only the exact
journaled control/metadata/audit changes made by R3 and accounted create-only
witness deliveries; verify them, do not ignore entire documents or collections.
Unexplained changes, pending witness reconciliation or known unfinished protected
writers stop globally.
Activate only eligible explicitly scoped rooms with fresh generation and audit;
retain intentionally restrictive room states. Normal admission is last, after the
complete release composition and metadata readback have passed. Old pages must
refresh; old dollar-shaped requests safely refuse instead of bypassing the protocol.

### R5 — Verify and close

Use designated fictional records for teacher/student sign-in, account creation,
opening balance, approval/rejection, add/subtract, transaction history, profile/PIN
changes, settings, removal, reload durability, duplicate/lost-response recovery and
tenant isolation. Run the already-required Chromium and WebKit combined tests.
Verify the actual signed-in deployed app through the authorized browser boundary;
never expose real credentials/PIN pages or unrelated student records to a model.

Preserve create-only audit evidence. Reconcile admitted-event outcomes; unresolved
audit work cannot be relabeled as a historical gap. Unproven historical continuity
stays unavailable in reporting rather than being fabricated. Provider uncertainty
is a separate record: a removed service or ended billing month does not settle an
external call. An unresolved claim blocks affected Insights acceptance and the
full-feature closeout, but does not authorize replay or cancellation to clear it.

The final report binds deployed hashes, checks, any retained historical limitations,
review closure and the repository state. Commit/push/merge the reviewed final delta;
verify clean synchronized working state and no outstanding relevant PRs/issues.
Optional suggestions are explicitly declined for this release, not left as hidden
unfinished release tasks. Do not certify no defects merely because GitHub is empty.

## 5. Rollback and failure rules

Before any data/control preparation, restore only a known compatible prior set if
doing so is safe and explicitly part of the bound plan. After preparation begins,
default to maintenance plus forward recovery. Never reopen the old broad client
saver/rules against partially initialized state. Do not roll back data wholesale,
delete retained receipts/audits or undo a committed money operation. Keep the new
settings endpoint available for clients already loaded. Provider uncertainty and
private journal state survive any backend/client rollback.

If runtime evidence contradicts an operational assumption, stop immediately. No
operator force flag, relaxed sentinel, retry storm or data cleanup is a recovery
mechanism. Resume only an exact journal-bound plan after the conflict is resolved.

## 6. Bounded acceptance work

No runtime tests were run for this design-only change. Implementation must exercise:

- R1 same-name supersession deploys the pinned closed revision before preparation,
  keeps the audit recorder admitted, refuses legacy callables, and accounts for
  nonretry profile deliveries. No delete/recreate gap for the audit consumer.
- A terminated execution with a lost reply can pass after its effects reconcile;
  a terminated caller with a pending downstream mutation cannot. V1 is before
  retirement, V2 after settlement and before the first R3 write; post-R3 validation
  allows only exact journaled changes and reconciled audit events.
- A delayed old writer, an old tagged route, unknown regional inventory, missing
  telemetry, continued processing after HTTP timeout, and interrupted retirement:
  none may silently pass R2. Public docs are not a live retirement test.
- A new money transaction straddling a readOnly/generation change: retry/refusal
  with no late balance/ledger write. Test teacher, student and lifecycle paths.
- Lost response after metadata commit, crash/restart, a second operator, changed
  classroom scope, conflicting control/audit and bounded retries: preserve exact
  recovery and no balance change/duplicate initialization.
- Valid old client denied by strict rules and obsolete wire contract; malformed
  masking or missing-parent inventory refuses before private unrestricted reads.
- Provider result uncertainty and delayed witness delivery stay explicitly unresolved;
  no fake terminal claim, history reconstruction or retry-queue purge.
- Final selected rules/saver/functions build in both browsers, followed by the
  bounded live R5 checks. Reuse closed component evidence unless changed behavior
  or a failure justifies rerunning it.

Acceptance of this design permits building the specified workflow only after the
scoped owner decision. It does not certify the actual project, old-writer retirement,
identity, private host or any live operation. The release still requires the actual
evidence above. A reviewer should reject an unimplementable operational criterion
now rather than sending Codex into another hypothetical collector stage.

## 7. Owner decision after independent review

The concrete decision is whether to use this one-window operational standard,
trusting the named administrators, operator host and available Google service
evidence, while accepting that invisible concurrent privileged changes or old work
are not exhaustively excluded. The material consequence could be a stale report,
unexpected write, credential mismatch, provider uncertainty or balance/history
inconsistency requiring maintenance and recovery. Tests and fresh reconciliation
reduce that risk; they do not eliminate it.

This is the scoped deviation required by the earlier proof/feasibility contracts.
Reviewers cannot accept it on Andrew's behalf. If he declines, this proposal remains
inactive and the original proof requirement remains unresolved. Do not infer his
choice from frustration with delays, general release approval or a desire for no
outstanding work. Codex must explain the reviewed practical tradeoff plainly.
