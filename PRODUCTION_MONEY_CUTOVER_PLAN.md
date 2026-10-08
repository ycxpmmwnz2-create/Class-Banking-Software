# Production money cutover — implementation scope and recovery design

## Scoped amendment — accepted 2026-10-08

For the one controlled Morgan Bank maintenance release,
[CONTROLLED_MAINTENANCE_CONTRACT.md](CONTROLLED_MAINTENANCE_CONTRACT.md) takes
precedence only for its explicitly listed assurance and D1 sequencing substitutions.
Andrew accepted those reviewed substitutions on 2026-10-08. The original text below
remains historical evidence and governs every requirement not replaced. Existing
demo-only guards, advisory report schemas and production-ineligibility flags are
unchanged; they cannot certify the new operational standard. No live evidence or
cloud/private-data authority follows from this amendment.


Status: **proposal for review; no production runner or live operation enabled**.
Baseline: `morgan-bank-2026-10-06-rc2`, archive SHA-256
`7a4072245ac59002974359f880e3457573fa4171d887566e1fe98d1efe64d056`.
Codex builds; Muse Spark checks at xhigh; Claude gives the independent final review.

## 1. Objective and existing contracts

Finish the operational prerequisites for the reviewed money writers and stricter
rules. The application changes remain frozen in RC2. This proposal adds no runtime
code, source export, permissions, rules selection, deployment or data mutation.
It does not repeat the already-closed demo L2 correction or optional naming cleanup.

Keep `PROTECTED_MONEY_SCAN_PLAN.md` as the scan-only privacy/fence/data contract,
`MAINTENANCE_MODE_CONTRACT.md` as the admission contract, and
`TEACHER_MONEY_INTEGRITY_AND_RECOVERY_DESIGN.md` sections 5–6 plus
`TEACHER_MONEY_ACCESS_SURFACE.md` as the control/cutover contract. The more specific
maintenance contract governs older global-gate wording: closed admission, correctly
bound V2 runtime and the narrow balance-history audit exception must coexist.

The production adapter is a new operator-only entrypoint. Never turn the demo
scanner, its fake observer, or `classroomInitialization.js` into a live tool by
removing their guards. Reuse pure analysis and exact public data contracts, with
separate transport and authorization. Preserve their false eligibility flags.

A scan-only report remains `initializationAllowed: false` and
`activationAllowed: false`, including after this proposal. It cannot be fed to an
initializer. The initialization workflow defined below requires its own scope,
current complete qualification reads and write authority; no old report, digest,
terminal acknowledgment or fixture evidence substitutes for those checks.

## 2. Delivery boundaries and the first implementation

Three implementation bundles, each with proportionate tests and the established
review order. These are work boundaries, not extra production approval dialogs.
Existing user authority covers preparation; reviewers do not authorize live work.

| Bundle | Concrete deliverable | Completion evidence |
| --- | --- | --- |
| A: qualification | Private operator launch/identity and bounded read adapters; real-platform evidence capability assessment; complete inventory; read-only provider-claim report; sanitized NO-GO output | Adapter refusal/resource tests and fictional transport fixtures; actual platform semantics documented before any live eligibility |
| B: controlled preparation/recovery | Version-bound whole-project plan; journaled control/metadata transactions; resume, terminal abandonment and successor-run rules below | Real local SDK races, retries and lost-response tests; strict allowed-write comparison; private artifact persistence failures |
| C: release composition | Actual strict rules/narrow saver selection, artifact/order/rollback manifest, full fictional cutover rehearsal in Chromium and WebKit | Exact combined candidate tested; independent review; operational runbook with bounded live checks |

Start with A. Before implementing a live collector, identify whether every required
platform surface can supply the necessary evidence. Record each as SUPPORTED,
UNSUPPORTED or UNVERIFIED, with source/version and a discriminating staging check.
SUPPORT is not established by an interface, sample JSON, empty logs or emulator.
The project remains NO-GO if one required capability is unresolved. If the platform
cannot meet the reviewed complete-interval contract, present the concrete gap for
a separately reviewed contract decision; do not build a fictitious completion
cursor, weaken the contract, or keep adding local tests that cannot resolve it.

| Evidence obligation | Qualification must establish | Never accepted instead |
| --- | --- | --- |
| Effective reader/writer authority | Exact short-lived principal, target, inherited/group permissions and impersonation reach; no unintended capability | Claimed principal name, one direct role binding, or Rules constraining Admin SDK |
| Deployed writer inventory | All routable revisions, Functions/HTTP routes, triggers, queues, schedulers and other operator writers; known producer/retry/transaction lifetimes | Source exports alone or a new revision receiving all observed traffic |
| Client denial | Actual release hash/propagation plus valid fictional SDK/REST/batch/transaction probes | Invalid auth/payload, Playground or emulator-only pass |
| Drain and interval | Independent complete evidence from admission closure through last revalidation and publication; reject reopen/reclose and missing/delayed history | Quiet logs, fixed sleep, endpoint snapshots, or repeated matching document versions |
| Credentials and audit exception | Separate bounded credential-consistency verification and admitted-event audit reconciliation; terminal historical gaps distinct from unresolved retries | Reading credentials in the money scanner, assuming retry guarantees delivery, or relabeling pending work as a gap |
| Operator exclusion | Cross-process exclusion plus verified external configuration/writer control through publication | A local lock directory, expiring lease or a cooperative database journal alone |

No network research or live-platform verification was performed to write this
proposal. Exact collector endpoints, completeness semantics and effective IAM
verification are open qualification deliverables, not assumed capabilities.

## 3. Private execution and bounded read operations

Retain the Stage10 human-only Terminal.app boundary, outside every agent's allowed
read scope, attachments, repository and synced folders. Codex does not run or watch
live inventory/scans, inspect private reports, or receive credentials. Andrew may
manually share only the previously permitted fixed project-total count/category
summary. New restricted journals and provider records do not enlarge that consent.
Implementation/review/staging fixtures contain fictional records only.

Require explicit `morgan-bank` / `(default)`, exact reviewed clean source/runtime/
lockfile hashes, approved operation/expiry, expected principal and private output
location. Imports/help/plan-format validation do not construct a client or fetch
credentials. No ADC, Firebase cached session, key-file discovery, metadata fallback,
emulator/custom endpoint, redirect or default-project fallback. A separately
verified credential adapter supplies short-lived credentials through a private
channel, never argv/output. Credential provenance and expiry must be verified
independently; caller-supplied identity fields are not proof. Adapter design and
transport qualification belong to A, and fail before data reads when unavailable.

The reader exposes bounded list/get only. Use the existing scan budgets (100 rooms,
25 per page, 20,000 documents, 64 MiB input, 32 MiB report, 15-minute operation within
30-minute authority). Enforce bytes/deadline before retaining responses; repeated
or malformed cursors, incomplete pages, unsafe paths or any limit abort the whole
operation. Budget each companion report separately, with combined cost disclosed.
Do not carry unbounded listDocuments materialization into production. Qualify
paginated missing-parent enumeration, including witness-only phantom roots.

Inventory uses names and masked root/teacher foundation/control fields before
any full classroom read. Invalid/missing/legacy foundations stop the project.
The protected money scan retains exactly the Stage10 path allowlist, pure money
analysis and real projection/defaults. Separate metadata/credential/provider
operations have explicit narrower masks and budgets; their authority is not
inherited from scan permission. In particular, no raw PIN/hash or stored Insights
answer enters a scan/report or model context. Credentials verification operates
privately under its own reviewed scope and emits only fixed consistency outcomes.

### Provider-claim report

Read-only inventory of the entire `insightUsageReservations` namespace across ALL
months, including missing parents with dispatch descendants, and each reservation's
`dispatches` subcollection. No collection-group shortcut that omits parent state.
Mask out `result`, prompts, answers and unrelated values. Bind reservation identity,
scope/request digests, schema, status, generation and dispatch index/state/times;
validate against `firestoreUsageLedger.js`, without needing original request text.
Bound pagination, cardinality and revalidation; extra/malformed dispatches, unknown
schemas, missing parents, drift or incomplete coverage yield UNKNOWN, not zero.

Report `claimed`, `uncertain`, reserved/uncertain reservations, legacy records with
no dispatch evidence and orphan/malformed records separately. A completed legacy
reservation or absence of claims is not proof that old provider-capable revisions
are drained. Finished claims establish only their recorded completion. Report
record completeness separately from external-provider drain, which stays UNKNOWN
until independent writer/provider evidence closes it. No timeout/month rollover
expires uncertainty; no deletion, cancellation, settlement, allowance adjustment,
new dispatch or provider call occurs. Only the existing permitted summary schema
may leave the private boundary; keep provider-specific detail private unless
Andrew separately authorizes a narrowly defined summary extension.

## 4. Whole-project initialization plan

The planner is read-only. It obtains fresh complete qualification under the same
verified fence and source/authority window as execution, including all input
versions, control/audit history and money recovery metadata. Retained scan-only
reports may guide investigation but cannot grant initialization admission.

Freeze all classroom IDs and reciprocal owners, expected create/update versions,
existing control/audit identity, explicit target mode/action, metadata action and
reason codes. Scope digest binds every row, versions, source, fence and authority
references. Private file publication uses exclusive/no-follow owner-only storage,
readback and durability checks. Partial files and uncertain publication are unusable.
No names, balances, PINs or raw answer text are serialized in these plans.

| Observed state | Planned preparation behavior |
| --- | --- |
| Absent control, valid foundation, no conflicting audit | Create schema1/readOnly/generation1 and its audit atomically |
| Valid active control | Explicitly approved transition to readOnly, generation +1, expected prior control/version and new audit |
| Valid readOnly control | Preserve control/generation; verify prior audit and record a run witness without rewriting root |
| Valid suspended control | Preserve suspension; explicit scope inclusion and an unresolved activation disposition; never silently downgrade to readOnly |
| Malformed control/audit, invalid foundation, exhausted generation | Whole-plan conflict; no default, deletion or reset |
| Numeric/capacity/projection blocker with valid foundation | Same strict rules and compatible client; leave readOnly/suspended and record deferral, never skip its inventory row |

This extends the demo's reject-all-existing-controls behavior only in the future
production module. Before activation, every row must have a verified restrictive
control and a supported credential/metadata disposition. A suspended/deferred room
is never represented as healthy or read-capable merely because preparation ended.

Money metadata needs its own proof: derive the current owner's actor path with
`teacherAwardPaths`, validate `actorState` and `receiptCount`, and inventory all
receipt/actor/quota records under the fence. Preserve valid existing metadata and
unacknowledged requests. Missing actor/quota may be created with null pointer/zero
count ONLY after complete proof that the entire corresponding receipt/actor/
metadata namespace has no prior history and no competing writer. Do not use a
missing current-owner record as an empty-namespace proof. Any partial, inconsistent,
legacy or nonempty-but-missing metadata state blocks automatic initialization;
reconciliation needs a separately reviewed plan, never a counter reset. The
control, new metadata, audit and per-room journal witness commit together.

## 5. Persistent ownership, resumability and abandonment

Use a new production protocol; do not reuse or delete the demo L2 journal.
Proposed server-only paths (no callable/client permissions):

- `moneyCutoverState/current`: fixed contention point, protocol version, monotonic
  epoch, current run ID, plan digest and state;
- `moneyCutoverRuns/{runId}`: immutable binding fields plus bounded progress/state;
- `moneyCutoverRuns/{runId}/rooms/{classroomId}`: create-only per-room witness;
- `moneyCutoverTransitions/{operationId}`: create-only terminal/recovery audit.

Exact key/type/size validators are required in B; these names do not themselves
provide IAM isolation. Use safe bounded IDs and generation/epoch overflow refusal.
Rules and deployed import inventories must prove these paths stay client-denied
and operator modules stay unreachable from application entrypoints.

Inventory the production journal namespace before accepting first use or recovery:
no singleton with missing run, unowned running run, duplicate active lineage,
unknown protocol, phantom parent or broken predecessor audit may be ignored. Use
bounded pages, initially at most 100 retained runs and 10,000 witnesses/transitions
within the operation's document/byte budget. Exceeding this cap blocks the tool;
it never prunes history. A history-retention extension needs its own reviewed
policy. Fresh first use requires proven absence of prior production journals.

States: `prepared` (private artifact only), `running`, `prepared-readOnly`,
`abandoned`. `blocked`/UNKNOWN is an observation, never an automatic state mutation.
Only a fully validated execution transaction may create a run and claim the fixed
record together. Every write transaction rereads exact run ID/epoch/digest/state,
full bounded scope/foundations and required versions/witnesses before staging any
write. A callback retry repeats those reads. Per-room control/metadata/audit/witness
and progress commit atomically; a matching witness is read back without repeating
the action. Mismatch, different owner/scope or missing evidence stops globally.
Terminal readback checks every row and progress count before prepared-readOnly.
That state authorizes no activation or recovery-policy weakening.

### Resume the same run

Read server journals first; never infer failure from a lost response. Reestablish
identity, external fence, current inventory and fresh qualification after process
restart or expiry. Renewed authority binds the SAME immutable plan/run and current
epoch; it cannot change row actions or expected versions. Completed rows must
still match their exact control/metadata/audit witnesses; unfinished rows must
match the original expected versions. If exact recovery cannot be established,
stop and use the abandonment path. Never silently replace the plan.

### Explicit abandonment (not deletion, rollback or unlock)

1. Prepare a read-only recovery plan naming the existing run, exact epoch/state/
   digest and every completed/unfinished row. Obtain fresh restrictive-maintenance
   and external-writer evidence. Unknown state or unreadable journal blocks it.
2. Separately scoped execute authority names this abandonment and a fixed reason;
   age, process absence or zero completion does not authorize it.
3. One transaction verifies the current owner and run, then writes a terminal
   abandoned status, increments the singleton epoch, and creates the immutable
   transition audit together. Replayed operation reads the same audit; changed
   parameters conflict. Do not delete/reuse the singleton, run, witness or audit.
4. No classroom, balance, receipt, counter, credential, control or maintenance
   setting changes. An old in-flight cooperating transaction either commits
   before abandonment and is accounted for, or conflicts/retries and sees the
   terminal state/epoch. It cannot commit afterward using a stale claim.
5. A successor uses a new ID, fresh inventory/qualification and explicit plan
   binding the predecessor's terminal audit. It classifies already-completed
   restrictive controls/metadata by exact witnesses and preserves them; it never
   treats partial work as virgin data or resets generations/counters. Claim and
   successor creation atomically compare the retained predecessor/epoch and
   increment the epoch again. Multiple successors contend on the same document.

If a room commits between the recovery plan and abandonment transaction, require
a fresh recovery plan: compare the entire expected progress/witness set inside
that transaction. Never log stale completed/unfinished counts as the terminal
truth. Two inconsistent legacy runs are a conflict, not a reason to auto-select
one; their resolution requires a separate specific plan. This protocol stops only
cooperating new executors. It cannot fence arbitrary Admin writes, older tools or
platform changes; the independently established external fence remains mandatory.

## 6. Publication, cutover and rollback

Keep fence observation and exclusion through the final readback and durable private
publication acknowledgment. A late failure returns UNKNOWN/unconfirmed, retains
journals and private artifacts, and never reopens writes in finally/cleanup. Retry
requires server readback; local artifact existence does not establish completion.
The initializer intentionally changes approved control/metadata versions: the
observer must distinguish its exact journaled changes from unexpected changes,
without waiving scope/writer/configuration continuity or accepting arbitrary diffs.
Its pre-write qualification snapshot is consumed for that run, not reused afterward.

Bundle C binds exact Functions/rules/Hosting bytes, configuration and recovery
versions. Deploy the CB1 endpoint before its dependent client and retain it on
compatible backend rollback. Preserve creation HMAC versions, receipt readers and
schema4 dispatch/settlement compatibility. No rollback to direct money rules, old
writers, counter resets or deleted claims. After any new-schema write, hold
readOnly/suspended under compatible rules/services and restore a compatible
revision or fix forward. Downtime is preferable to silently losing recovery data.

Classroom activation is a SEPARATE explicit control transition with expected
current generation, increment and atomic audit, fresh compatible-data evidence,
complete project preparation and verified final composition. Never activate a
partial project because some rooms passed. A validated subset may become active
only after every classroom has its restrictive disposition under the same strict
rules/client; deferred/suspended rooms remain restricted. No timer auto-activates.
Run signed-in teacher/student acceptance on explicitly designated fictional
records, including reload durability and tenant isolation, before health closure.

## 7. Discriminating verification and completion criteria

- A: missing/expired/mismatched authority before client construction; no ambient
  discovery or unexpected endpoint; bounded missing-parent pagination; masked
  reads; malformed/extra/orphan/all-month provider records; timeout/storage failure;
  raw sentinel values absent from safe output; UNKNOWN when any evidence is missing.
- B: two fresh runs; same-run race; stale epoch; failed transaction/no partial
  writes; lost committed response/restart; legacy/partial metadata refusal;
  mixed absent/active/readOnly/suspended controls; overflow; drift in later room;
  concurrent last-room commit vs abandonment; lost abandonment response; two
  successors; old executor retry after abandonment; no deletion/reset/activation.
- C: whole-project mixed-state cutover, stale/old-client direct writes denied,
  runtime admission and every writer, credentials/audit exception, CB1 ordering,
  rollback compatibility, both browsers and failed/premature transition cases.

Use relevant existing package commands and add isolated operator suites only where
needed. Print runtime version into new logs; retain raw fictional logs. Supplied
logs, static review, emulator, staging and live evidence remain distinct. Do not
repeat unchanged broad suites or optional cleanups merely to prolong a stage.

Design acceptance means these boundaries are coherent and implementable subject
to the explicitly open platform qualification in A. It is not implementation
acceptance, a claim that the platform supports complete history, or permission to
perform production reads/writes. Before declaring a live path ready, each open
capability must have a concrete verified adapter and staging evidence; an
unsupported capability requires a new decision, not an operator override.
