# Teacher award/deduct service — button integration candidate

Stage17 committed as 9ab312a and Stage18 as a69833b after Muse/Claude reviews.
Stage19 preview/recovery was reviewed and committed as 88e4084. Andrew subsequently
authorized connecting and testing the existing Quick Cash and custom Add/Subtract
buttons. The current uncommitted candidate wires those V2 buttons and five guarded
callables. It awaits detailed Muse checking and independent Claude final review;
it is not deployed or production-qualified. Stage16 is committed as 2c1cb0a.
No real-data scanner activation or existing-classroom initialization is included.

## Scope and storage contract

`executeTeacherAwardService` receives trusted server dependencies (Firestore,
auth context, configured project ID and server clock). It snapshots the exact
wire intent, then resolves current reciprocal teacher/classroom ownership within
every transaction attempt. Client-supplied owner, balance, clock and IDs remain
forbidden. Classroom settings provide the action-specific category list; the
service adds only Quick Cash for awards and Classroom Expense for deductions.
Missing/malformed category lists fail closed; no settings are created here.

New actions require active control and matching generation. The same transaction
reads receipt, actor, quota, target students and candidate ledgers; computes the
changes; and atomically updates students, creates ledgers and receipt, and updates
actor/quota. No writes are staged until validation/budget checks finish. There
are no external side effects in the transaction callback.

Server-only metadata beneath classrooms/{classroomId}:

- teacherMoneyReceipts/{key}: SHA-256 of compact UTF-8 JSON
  ["teacher-money-receipt",1,canonicalTeacherUid,requestId]. The stored actor and
  request are also checked. The receipt holds only version, actor UID, request ID,
  generation, status, serverTime, digest, action, itemCount, ledgerIds and
  acknowledged. New committed receipts use version 2; ledgerIds is the canonical
  string `b36:1:<target>:<ledger>,<target>:<ledger>,...`, with each positive safe
  integer encoded in lowercase base36 without leading zeroes, in ascending target
  order. This stores the entire mapping without repeated object-field overhead.
  Replay compares it exactly with the mapping freshly derived from the bound
  request; it never parses or trusts stored numbers. Version 1 object-array
  committed receipts remain readable without rewriting; cancelled receipts stay
  version 1. Unknown versions/encodings or noncanonical mappings fail closed. No name, balance, memo, PIN or full payload.
- teacherMoneyActors/{key}: SHA-256 of
  ["teacher-money-actor",1,canonicalTeacherUid], with version, actorUid and
  unacknowledgedRequestId (null or the request ID).
- teacherMoneyMetadata/receiptQuota: version and count, bounded at 100000.

Receipt schema version 2 is independent of wire protocol version 1. No existing
receipt is migrated. Before any future activation, all receipt readers and
recovery endpoints must understand both committed formats. Rolling back to
Stage17 after creating v2 receipts would make those replays fail closed; retain
compatible readers and use maintenance/readOnly recovery, never delete receipts
or replace request IDs to work around a version mismatch. This candidate has no
live receipt migration and grants no activation authority.

Actor and quota documents MUST already exist. The invitation-controlled new-
classroom transaction now initializes them atomically with its foundation only
after bounded probes find no students, ledgers, receipts, actors or metadata
under that new ID. It also seeds the existing browser's category defaults.
Existing-classroom onboarding replay never initializes or resets metadata.
Existing classrooms still need a separately qualified initializer; none is
available for real data under the current scanner NO-GO.
The startup status check cannot succeed without valid actor/quota metadata.
Until status is confirmed, the current browser locks its guarded teacher actions,
including non-money classroom edits, to prevent a stale whole-classroom save from
overwriting a money action. The status panel describes this lock without claiming
a previous save exists. Read-only navigation remains available.

Activation prerequisite: every classroom reached by this new V2 client must
already have valid, consistent actor/quota metadata and counted terminal receipts.
Do not deploy/enable this integration for older V2 classrooms lacking that setup.
Fictional local/staging acceptance can use newly invitation-onboarded classrooms.
Preserve existing real classrooms until a separately reviewed initializer is
qualified; do not delete/recreate them or manually seed/reset metadata as a bypass.
This documents the existing protective lock and grants no activation authority.

An absent or malformed counter is never inferred to mean zero. No initializer,
reset, deletion or counter repair is provided here. Existing terminal receipts
must already be counted, including cancellation tombstones. These collections
need server-only rule coverage before any integration/activation.

Same key/digest returns a validated stored committed result without rereading or
rewriting money. Different digest conflicts. Valid cancelled receipts fence the
key regardless of digest. A different new request is refused while the actor
has an unacknowledged operation. Replay rechecks current ownership/control and
is permitted in active/readOnly, including old generations; suspended denies it.
Receipt status is minimal and requires refresh, never a fabricated current balance.
Warnings reflect the current counter at 80%/95%; they may differ on a later replay.

## Bounds and remaining work

The service accounts for reads plus resulting writes and metadata under 8 MiB,
receipt under 8 KiB and writes under 400. Before each new read it reserves the
Firestore 1 MiB document maximum plus 32 KiB path/wire headroom. The two foundation
reads retain that full conservative charge, allowing SDK timestamp fields without
serializing them. Scalar money/metadata reads settle to the shared estimate;
unsupported encodings or estimates beyond the reserved bound fail closed.
This is conservative accounting, not proof of Firestore index/write size limits.
Stage18 removes the Stage17 short-ID, empty-history 23-target receipt bottleneck
without raising any limit. The 100-target protocol maximum remains a ceiling,
not a guaranteed batch size. Tests cover 3, 23, 24, 30 and 100 empty-history targets,
exact mappings including maximum safe student IDs, same-response replay, corrupt
mapping refusal, legacy receipt replay and an oversized-UID receipt refusal.
Each base36 ID is at most 11 characters; 100 pairs with separators and the codec
prefix occupy at most 2,405 ASCII characters. Receipt metadata and document path
still count toward 8 KiB, so unusually long IDs can still make a receipt fail.

### Chosen whole-class behavior — Andrew approved 2026-09-30

Use one atomic whole-class save only when the entire selected class fits. Otherwise
use smaller, explicitly selected groups, each shown and confirmed separately.
This is the existing §4 explicit-batch policy in the integrity/recovery design.
No automatic splitting, silent partial save, budget increase or history trimming.
One receipt/acknowledgment per deliberately confirmed group; the future UI shows
completed groups separately if a later group fails. A dispatched unresolved ID
must be fenced before selecting a new group. There is no client workflow here.

History still consumes bytes on both read and resulting write. Measured local
fixtures below use short owner/classroom IDs, numeric student IDs, name "Fictional
student", empty memo, Homework category, and the exact entry shape in the tests.
These are regression fixtures, not production thresholds or planner shortcuts:

| Existing history entries per student | Largest tested fitting group | Next size |
| --- | --- | --- |
| 0 | 100 (protocol ceiling) | 101 invalid targets |
| 50 | 54 | 55 rejected |
| 100 | 27 | 28 rejected |
| 200 | 14 | 15 rejected |
| 300 | 9 | 10 rejected |
| 600 | 4 | 5 rejected |

The next sizes above fail the unchanged 8 MiB transaction budget, with no writes.
Long text, mixed histories, long IDs or per-student ceilings change these numbers.
Even a single student may fail; then show a capacity/support path, never trim
history or retry smaller forever. The 1,000-entry and 900 KiB student caps remain.
Actual SDK/emulator tests exercise 30 students with 50 history entries each, 100
with empty histories, and a 14-student group with 200 entries; a 30-student class
with 200 entries is refused in full. They verify atomicity/replay, not production
index sizes or a completed preview/recovery workflow.

### Stage19 server preview and recovery

The product choice is resolved. This stage adds dormant server functions within
the same excluded module; no callable, browser or rules change is included.
All dependencies remain trusted server inputs. The older unplanned executor stays
available for component tests; a future application callable must use the planned
executor for new award/deduct actions, never expose a way to skip the plan.

- `planTeacherAwardService(request, dependencies)` accepts the existing award
  intent. It checks current ownership, active control/generation, unused request
  ID, actor/quota and settings. It hydrates only a sorted prefix in one consistent
  transaction. Before either point read for a target, the complete student/ledger
  dependency group reserves two worst-case document bounds. Foundation and
  metadata reads also reserve bounds. Accounting resets on each callback retry.
- Each hydrated prefix is checked through the SAME `awardMutation` helper used
  by execution: unchanged calculator, compact receipt, read/write estimates and
  quotas. It stops at the first capacity or reply-size exclusion without reading
  further targets. The entire ordered remainder, including any fetched-but-excluded
  target, stays in `notYetPlanned`; its existence/ownership is not asserted.
- The response contains `{plan, request, selected, notYetPlanned, reason}`.
  `request` is the exact subset intent for confirmation; selected summaries have
  current name and current/expected cents. `plan` binds project, teacher, classroom,
  intent digest, a 60-second window and exact SDK document `updateTime` seconds/
  nanoseconds (absence represented by null) for the selected dependencies. The
  result is capped at 64 KiB. If no target fits, plan/request are null and all IDs
  remain; there is no executable plan and no retry loop. Invalid/auth/collision
  conditions reject rather than silently skipping a target.
- `executePlannedTeacherAwardService({request, plan}, dependencies)` snapshots the
  supplied plan, re-derives identity/digest/authorization and all money/capacity
  checks, and compares the full exact selected dependency version vector and time
  window immediately before staging any write. Stale/expired plans fail without
  financial writes. A matching committed receipt may replay after expiry: an
  expired preview must never hide a save that already committed. Client-supplied
  plan fields confer no authority or proof of human confirmation; no signature or
  secret is introduced. Execution does not trust preview balances or names.
- `recoverTeacherAwardService({protocolVersion:1, classroomId, requestId,
  operation}, dependencies)` handles `status`, `acknowledge`, or `cancel` with
  fresh reciprocal ownership and active/readOnly access. Suspended is denied.
  The expected classroom binding prevents an old marker being reinterpreted after
  teacher rebinding. Status permits a null requestId to inspect the sole actor
  pointer; no pointer/receipt yields `unconfirmed`, never permission to resubmit.
- Recovery validates both committed receipt formats, canonical mapping/ledger
  derivation, receipt size, quota and actor consistency without reading money or
  requiring the lost payload. It returns only minimal status metadata. Idempotent
  acknowledgment marks a committed receipt and clears only its matching actor
  pointer; replaying an old acknowledgment cannot clear a newer operation.
- Cancellation creates a v1 tombstone plus one quota increment atomically, never
  alters balances or clears another actor pointer. It serializes against execution
  on the same receipt/actor/quota reads: if execution won, it returns committed;
  if cancellation won, any payload using that ID is fenced. Missing/corrupt
  metadata is never initialized. A full quota blocks new tombstones but permits
  existing status/acknowledgment. Cancellation of a cancelled key is idempotent.

Recovery has a fixed bound of five point-read documents (two foundation, actor,
quota, receipt) and at most two small metadata writes. The existing document
maximum plus headroom bounds that read set below 8 MiB; exact metadata schemas
and the 8 KiB receipt cap bound writes. Planning remains read-only, not a
reservation, and must never concatenate separate snapshots into one class plan.

The candidate client persists the project/UID/classroom/request ID marker before
dispatch, outside tenant-cache keys so logout cannot erase it. The marker contains
no money, names, memo or PIN. It makes one status/cancel recovery attempt after a
rejected or uncertain dispatch, retains the original rejection reason, and stays
blocked on failed recovery. It never resubmits a dispatched money action. Startup
also resolves the server actor pointer, including after local-storage loss.

The teacher sees the server's selected students, current/expected balances and
excluded count/names in an explicit confirmation. Excluded names come from the
loaded classroom roster; the planner returns their ordered IDs without fetching
or verifying that remainder. Only the planned prefix is sent. On a directly
confirmed partial save, the client returns the exact validated notYetPlanned
list; the page keeps the amount/type/category/memo, switches to Selected Students,
checks only those IDs and names them in the result. No click or acknowledgment
automatically submits them. Each next group needs a fresh preview and explicit
confirmation. After a complete refreshed save the draft resets as before.
Saved groups remain
blocked until explicit acknowledgment. A recovery panel outside the classroom
projection permits minimal-receipt acknowledgment after reload failure without
claiming the view refreshed. Account/epoch changes prevent stale publication,
cache writes and clearing the outgoing marker. Failed acknowledgment can be
checked or retried for the same receipt without applying money again.
Only a successful planned-execute response confirms the current draft. A minimal
recovered receipt (including another device's pending action found before planning)
confirms a saved action but cannot establish its equivalence to that draft. The
UI then uses recovery wording and keeps the draft; it does not claim the selected
amount/recipients were saved or reset the form. Fresh balances are still loaded
when available, and acknowledgment remains explicit before another deliberate save.

`teacherMoneyCallables.js` maps only recognized, reauthorized and digest-bound
validation refusals to `{status: "rejected", wroteNothing: true}`. That means
this invocation staged no money, not that another invocation cannot commit the
same key. SDK/transport errors remain ambiguous and safely redacted. The five
exports in `functions/index.js` use the existing project/release/global-maintenance
guard before opening handles; closed/verification maintenance blocks all five.
Only the planned executor is callable. Each recovery route supplies its own
operation; clients cannot override it or select another teacher's classroom.

Stage16 Claude C1 is addressed by extracting the unchanged estimator algorithm
into moneyDocumentSize.js. The scanner retains its existing exported wrapper and
error contract. moneyCompatibility.js stays excluded from the deployed graph;
the award service is now deliberately included through the callable adapter.
The release-order contract pins this change while keeping operator scanner and
compatibility modules outside the deployed graph.

Before release: complete both independent reviews and qualify the entire deployed
writer/rules/access boundary, existing-classroom initialization, compatibility
and the release sequence. Approvals, roster adjustments, opening balances,
student money, Insights dispatch and credential-trigger containment have not
all adopted the final teacher-money contract. The existing generic saver and
rules remain unchanged; this button integration is not full writer containment.
The actor stays blocked after a save until explicit acknowledgment through the
recovery service. Never clear metadata manually to make a pilot work. This does
not supersede Stage15's scanner NO-GO or certify production readiness.

Andrew expanded the earlier October 1 server-only finish line to finish connecting
and testing the existing money buttons, then review and resolve required cleanup.
This is an authorized local candidate, not a clean bill of health for the site.

Tests use fictional records: optimistic transaction fakes for retries, revocation,
quota, malformed state and budgets; actual Firestore emulator transactions for
concurrent same/different request IDs, atomic refusal and controlled replay.
Commands: npm run test:phase3:unit, npm run test:phase3:contracts,
npm run test:phase3:teacher-award, npm run test:phase3:money-compatibility,
npm run lint, npm --prefix functions run lint. The guarded emulator command
retains the existing credential exclusions and pins a demo project and localhost.
The new client and offline Chromium/WebKit tests reach the actual money services
using fictional optimistic storage. `npm run test:phase2b:server` separately reaches
the actual five exports through Firebase client SDK HTTPS calls with real emulator
Auth tokens and Admin SDK Firestore transactions, including a deliberately lost
client response, replay-preserving onboarding, cancellation and tenant refusal.
These layers do not prove production IAM, deployment, a native human confirmation,
full writer containment or signed-in production acceptance.


## October 4 local extension: complete teacher groups

The shared money callable/recovery service now also accepts `approve`/`deny`
with unique `transactionIds` plus explicit `allowNegative`, and `adjust`/`reset`
with unique `{studentId, expectedCents, targetCents}` adjustments. New-action
canonical intent digests use a separate versioned domain. Version-3 receipts
retain the private compact target/ledger mapping; decision entries map existing
transaction IDs to themselves, while adjustments derive new action-specific IDs.
Every new group is complete or rejected; there is no automatic prefix/remainder.
Prior award/deduct plans and version-1/2 recovery remain supported.

The separate `editStudentProfileV2` callable accepts protocol/generation,
captured classroom, student ID, expected name and requested name. Narrow name-only
compare-and-set preserves historical records; exact desired-name retry still
checks current authority. Browser name and balance controls are separate and
keep failed drafts. These source changes await Muse and Claude and do not select
strict rules, activate remaining writers or authorize deployment.
