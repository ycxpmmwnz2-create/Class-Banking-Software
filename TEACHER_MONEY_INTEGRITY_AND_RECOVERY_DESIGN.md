# Teacher money integrity and classroom recovery

Status: revised proposal R4 following Claude R3 finding F-G; awaiting focused
Muse recheck, then Claude independent closure. No runtime or production
change. Codex selected the contracts below; reviewers evaluate them rather than
being asked to invent missing implementation decisions.

Baseline: `86c7c148611250cad93502e2bc9b13179b34a65c`.
Owner direction: address server-enforced transaction integrity and emergency
recovery, following the completed teacher money-save release. Codex owns the
design and implementation. The existing independent review order remains in
force; earlier reviewer exceptions do not apply.

## 1. What this work must accomplish

Every supported teacher money action must commit its balance effect and history
together, exactly once for the same logical request. The browser sends an
intent, not a replacement balance/ledger document. A classroom must also have
a tested way to stop new mutations or suspend remote access while preserving
records and allowing an explicit, verified return to service.

This is classroom play money. Preserve ordinary teacher authority to award,
deduct, approve, deny, adjust, and reset balances. The security boundary protects
consistency and tenant ownership; it does not judge whether an authorized
teacher's award is educationally appropriate.

## 2. Current source evidence

| Boundary | Current implementation | Consequence |
| --- | --- | --- |
| Quick/custom money | `index.html`: `quickCash`, `saveTeacherTransaction`, `saveTeacherMoneyCandidate` | Confirmed-save UI is fixed, but the browser prepares balances and history. |
| Approvals | `src/phase2b/approvalQueue.js`: `prepareApprovalDecision`; `index.html`: queue wiring | Serialized confirmed saves; decisions still become browser-computed replacement records. |
| Roster adjustments/reset | `src/teacher/rosterBalanceAdjustments.js`; `index.html`: `saveStudent`, `resetBalancesToZero` | Adjustment history exists; optimistic candidate publication still occurs before save confirmation. |
| Generic saver | `src/phase3/tenantDataService.js`: `createTenantDataSaver` | Atomic client transaction and conflict checks prevent ordinary overwrite races; they are not a server authorization policy for money arithmetic. |
| Rules | `firestore.phase3.final.rules`: `validStudentUpdate`, transaction create/update | Active owner can independently alter balance, student mirror, or ledger status. No balance-to-ledger arithmetic relationship is enforced. |
| Student money | `functions/phase3/studentMoney.js` | Existing server transaction validates foundation/credential and atomically writes balance, ledger and mirror; useful pattern to preserve. |
| New student | `functions/phase3/studentLifecycle.js`: `createStudentV2Service` | Server accepts an opening balance with an empty mirror. Opening state must be explicitly distinguished from earned money. |
| Tenant access | `functions/phase2b/teacherTenantResolver.js`, final rules | Active reciprocal foundation is checked; no dedicated read-only/suspended classroom control exists. |
| PIN reset | `functions/phase2b/resetStudentPin.js` | Resolves owner before hashing, but its write transaction currently reads credential/student rather than re-reading teacher/classroom. Containment must close this race. |
| Recovery | `PHASE3_RELEASE_RUNBOOK.md`: clean-start rollback | Explicitly limited to controlled test clients; Hosting rollback/Functions disable alone cannot stop active teacher Firestore writes. |

These are current static source observations. No new emulator reproduction,
deployed-rules inspection, production inventory, or production write was
performed for this design. Historical security reports are leads, not fresh
proof. The completed Hosting release remains separate evidence.

## 3. Proposed server money contract

Add `executeTeacherMoneyV2`, with an exact, versioned discriminated request.
Resolve teacher UID and classroom from authenticated server-owned foundation;
reject a student caller, foreign student IDs, malformed fields, and any supplied
owner, calculated balance, ledger object, timestamp, or transaction status that
does not belong to the specific action contract.

Each request carries `requestId` (cryptographically random, generated once per
deliberate action), `protocolVersion`, `controlGeneration`, and one action:

| Action | Intent | Server result |
| --- | --- | --- |
| Award/deduct | Explicit unique student IDs, Add/Subtract, amount in integer cents, approved category/reason and bounded memo | Calculate each delta from current stored balance; one Approved Teacher ledger entry per target. |
| Approve/deny | Explicit pending transaction IDs and decision | Read stored amount/type/owner; atomically transition Pending and update matching mirrors; apply balance once for approval, never for denial. |
| Adjust/reset | Explicit student IDs, target cents and expected prior cents | Refuse stale expected balances; server calculates signed adjustment and records its before/after explanation. Reset-to-zero uses the same action. |

Whole-class actions send the explicit set shown in the confirmation, never a
server query that silently includes newly added students. Missing targets or a
conflicting approval decision reject the entire bounded action, not a partial
subset. This changes the old Approve-all behavior that silently filtered decided
items: show the conflict, refresh the selection and require a new confirmation;
never automatically approve the remainder. Preserve the present teacher overdraft behavior; pending subtraction
approval that needs negative-balance confirmation includes an explicit intent
flag, rechecked against current balances. Student deductions retain their
existing insufficient-funds rule. Teacher actions on frozen accounts preserve
current teacher authority; freezing still blocks student spending.

### Arithmetic and compatibility preflight — decision N1

New money operations use integer cents: absolute resulting balance and individual
amount are at most 100,000,000 cents ($1,000,000). This reuses the roster-edit
limit; it does not describe all values accepted by the old application. Convert
stored numbers to cents only when finite, in range, and within the existing
roster helper's 0.0000001-cent floating representation tolerance of an integer.
Thus ordinary binary encoding of 1.10 is accepted; 1.001 is rejected. Never
truncate or silently round substantive fractions. New UI input is parsed from
a decimal string with no more than two places. Teacher overdrafts remain allowed.

This domain applies to EVERY new money writer, including student submissions.
The versioned student request uses integer `amountCents` in [1, 100,000,000], not
the old unbounded dollar `amount`. Keep the present whole-dollar student UI;
convert validated decimal input explicitly to cents. Reject the old shape,
unsafe conversion, excessive amount or out-of-domain current/resulting balance
before any ledger, mirror or submission-throttle write. Add remains Pending with
no balance effect; Subtract remains Approved with existing insufficient-funds,
freeze, reason, throttle and replay checks. Convert accepted cents to the existing
stored dollar-number shape only at the write boundary. The ceiling itself is
valid if other checks pass; ceiling+1 cent is invalid. Approval rechecks the
stored amount and resulting balance, with `amount-out-of-domain` for unsupported
historical Pending values. Denial need not convert that amount: for an otherwise
valid finite-positive Pending record with exact ledger/mirror agreement, preserve
amount and balance and change only status atomically. This does not relax auth,
control, shape or parity, or permit activation of an unremediated classroom.
No automatic denial occurs in preflight.

Before any production enforcement change, a read-only, explicitly scoped scanner
must enumerate every current student balance, every ledger amount, each mirror,
and every Pending decision in the proposed classroom scope, with pagination to
completion. It checks numeric domain/precision, IDs, duplicate/orphan ledger
links, mirror agreement, source/category collisions with reserved new values,
roster size, mirror capacity and encoded sizes. It records document paths and
update versions in a restricted local remediation manifest; only counts and
reason codes appear in normal output. No names, PINs or raw records are logged.
Incomplete reads or a changed document invalidate the result. Run an advisory
scan before maintenance and a final version-bound scan under the verified write
fence in §6; never treat the advisory scan as a consistent frozen snapshot.

Remediation is explicit, per record, and not part of normal rollout:

- Valid current balances/amounts pass without rewrite. Existing out-of-domain
  Approved/Denied historical ledger amounts are preserved, marked legacy-only in
  the restricted report, and excluded from integer-cent mutation inputs. They
  remain readable with existing history semantics; do not reconstruct earnings.
- Out-of-domain current balances or Pending amounts block money activation of
  that classroom. Advisory scans identify deferrals before maintenance; every
  classroom is still inventoried, finally scanned and initialized under the same
  project-wide fence/rules. No unscanned classroom is silently activated.
- The owner chooses a corrected value only where business meaning is needed.
  A separately authorized operator correction uses the exact scanned document
  version, records the original IEEE-754 value and proposed decimal value in a
  server-only compatibility audit, and atomically updates the balance with a
  clearly labeled correction record. If the adjustment delta itself cannot be
  represented in the new domain, do not force it into a normal money ledger:
  retain the original record and defer that classroom's cutover. No fabricated
  historical transaction or automatic rounding is allowed.
- Deferred classrooms receive the same compatible client, strict rules and valid
  readOnly control as the rest of the project; hold them readOnly until a fresh
  scan passes after separately authorized remediation. There is no per-classroom
  old-release alternative in the single default database. Preserve authorized
  reads without narrowing their historical numeric domain; malformed/parity-broken
  data may still prevent normal projection and needs explicit support guidance,
  not a promise that a broken view renders. Missing/invalid foundations must be
  resolved before switching project artifacts, or rollout stops. No source edit
  or production scan here authorizes an operator correction.

### Stored dates and reporting — decision T1

Every NEW server ledger entry (teacher, student, opening and operator correction)
stores a server-clock instant in exactly the 24-character `Date.toISOString()`
form `YYYY-MM-DDTHH:mm:ss.sssZ`, copied identically into its mirror. Invalid clock
values or extended-year forms fail before writes. A replay returns its original
record/date; approval/denial preserves the existing Pending entry's date. Clients
cannot supply authoritative timestamps. Do not put a Firestore Timestamp object
in the existing string field.

`normalizeStoredTransactionDate` already accepts canonical ISO and the exact
legacy en-US wall-clock form. Normalize both before affected reporting reductions;
never use process-local parsing of a legacy string or an ISO UTC date substring
as a classroom day. Preserve the current canonicalized, validated Insights request
`timeZone` as the reporting zone and display it in date-based answers/history;
this baseline has no persisted canonical classroom time zone. Legacy wall clocks
are interpreted in that zone; ISO strings retain their instant. Day/time-of-day
grouping uses explicit zone-aware formatting independent of the Functions/browser
process zone. Existing rolling windows remain elapsed N*24 hours, not calendar days.

Preflight reports unsupported dates and legacy zone uncertainty without rewriting
history. Historical browser clocks/zones cannot be recovered from wall-clock
strings; disclose that limitation rather than inventing them. Server timing
replaces browser timing, not the reporting zone. Verify equal-instant legacy/ISO
fixtures near local midnight, DST changes, rolling boundaries and mixed opening/
history records. ISO storage alone does not imply a day-bucket shift.

### Deterministic IDs and atomic size — decisions I1 and L1

Preserve positive safe-integer ledger IDs and existing ledger shapes. Compute a
candidate ID as `1 + first52bits(SHA256(canonicalTuple))`; the tuple contains a
fixed domain/version string, project, classroom, authenticated UID, request ID,
action discriminator and stable child index. Sort and deduplicate explicit
student/transaction targets before assigning indices. Timestamp and Firestore
callback-attempt number are never inputs. Server execution and re-execution of
the same intent generate the same mapping, which is stored in its receipt.

The transaction reads candidate ledger IDs and affected student mirrors before
writing. Any existing receipt is checked first; otherwise an occupied ledger ID,
an orphan mirror with that ID, or an intra-request hash collision rejects the
whole action. Never overwrite, never re-key automatically, and never retry a
new logical request after an ambiguous response. A confirmed collision can be
cancelled/tombstoned, then the teacher deliberately starts a new request. The
preflight proves ledger/mirror agreement across the classroom; strict rules and
all migrated writers preserve that invariant. Read all affected mirrors even
when a candidate ledger is absent. Existing student submission IDs also remain
create-only and collision-checked. They cannot overwrite the teacher's IDs.

Firestore callback retries re-read state and repeat the SAME pure mapping; an
aborted attempt has no committed ledger entry. A callback retry is not itself
proof of duplicate spending. Receipt uniqueness is the exactly-once boundary.

Maximum one atomic action: 100 targets/decisions, 400 writes including receipts,
actor state and counters, 64 KiB encoded request, 8 KiB receipt, 900 KiB maximum
encoded resulting student document and 8 MiB estimated total transaction data.
Use conservative serialized-size checks and real SDK/emulator boundary tests;
estimates do not replace SDK errors. 100 is a ceiling, not a guaranteed batch;
use the action-specific server plan in §4 before confirmation. Text limits: memo
500 Unicode scalar values, reason/category 120 each, with the byte ceiling too.
No financial writes precede validation; recovery cancellation metadata follows
its separate contract below. Existing mirror arrays are never trimmed. For new money additions
retain the student-money service's 1,000-entry limit; Pending decisions that
replace an existing mirror entry do not consume a new slot. Legacy mirrors
already above the limit remain readable; addition is refused with the explicit
capacity path in §4, not silently truncated.

### Receipts and durable acknowledgment — decisions R1 and R2

Within every money transaction attempt, read authenticated teacher, classroom,
access state, actor operation state, receipt, quota counter, affected students
and ledger entries before writing. Revalidate ownership/status/control generation
and request digest each time. Commit canonical ledger, balance, mirrors, receipt,
actor state and quota together. Never return or publish browser-proposed data.

Receipt key: canonical authenticated UID plus 128-bit random request ID, scoped
to classroom. The canonical request digest binds protocol, control generation,
action, sorted targets and all amounts/text/flags. Same key and digest returns
the committed result; a different digest fails. Replay rechecks authorization
and the current control policy. Old-generation receipts remain inspectable but
cannot authorize a new mutation. Approving an already-decided transaction under
a different request ID is a conflict, never another credit.

The committed money-action baseline for server-only receipts contains version, actor UID,
request ID/digest, generation,
terminal status (committed/cancelled), server time, action code, item count and
ledger-ID mapping; no PIN, name, memo, before/after balance or full input payload.
Keep at most 100,000 terminal receipts per classroom, each at most 8 KiB. Enforce
that cap transactionally using a server-owned counter; warn the teacher at 80%
and 95%. At the cap, refuse NEW actions before writes while preserving status,
acknowledgment and all reads. This is a bounded pilot policy, with no TTL or
routine deletion. Before a classroom reaches the cap, capacity expansion or a
reviewed expiry/tombstone protocol is required; never reset the counter or drop
receipts to bypass it. At exhaustion the operator holds the classroom readOnly,
preserves all receipts/counters, resolves existing terminal acknowledgments, and
prepares a separately reviewed capacity increase with storage/cost evidence or
a reviewed retention protocol. New tombstones/money stay blocked until that
change is authorized, deployed and verified; there is no bypass or guaranteed
repair time. This pilot explicitly accepts that outage risk, with escalation at
80%/95% before exhaustion. This is not approval to raise quotas or spending.
Count cancelled receipts too. At most one unresolved operation
per teacher/classroom prevents normal clients from rapidly creating orphan work.

Persist request ID, UID/project/classroom binding and unresolved marker in local
storage BEFORE dispatch; no payload, names, money values or credentials. Keep
that marker across reload, tab close AND logout. Other users cannot view its
contents through the UI; query it only after the same UID/tenant signs in.
Clear only after a definitive committed-and-acknowledged or cancelled result,
not merely a network error or an `absent` lookup. Failure to persist the marker
prevents submission. Do not add an offline write queue.

Routine validation/size/stale-state rejection must not force the teacher to find
a manual cancellation screen. A rejected invocation makes no financial writes
and leaves the server actor pointer untouched. For a valid bound envelope return
requestId, canonical digest and bounded reason code, meaning "this invocation
wrote nothing", NOT "no invocation can still commit". The supported client
automatically resolves/fences the same ID through status/cancel before clearing
its local marker. Cancellation fences the entire authenticated UID/classroom/
requestId key, regardless of digest, checks current owner/control, and serializes
on the same receipt/actor state as execution. It needs no retained payload or PIN.
Cancelled clears only that marker;
a committed winner uses confirmation/acknowledgment instead. Keep the original
validation reason visible. Never clear from an ordinary error or absent receipt:
another invocation of that ID may still be running. One recovery attempt follows
each returned rejection; transport/auth failure or quota exhaustion leaves an
explicit unresolved state and requires an explicit retry, not an automatic loop.
Local input/preview rejection before dispatch has no unresolved request to clear.
Malformed/unbound requests receive a generic error, not a terminal guarantee.
This deliberately consumes a bounded tombstone for dispatched rejections;
receipt-free clearing cannot fence duplicate execution and is not adopted.

Server actor state stores `unacknowledgedRequestId`. Every NEW commit checks it
and refuses while an earlier commit is unacknowledged. This also covers a new
browser or lost local storage: sign-in resolves that server pointer first. A
late request and a new request race on the SAME actor state, so at most one can
commit before review/acknowledgment. A retry with its original ID is still safe.
User intent cannot be deduced from equal amounts; deliberately acknowledged new
requests remain new awards. No claim is made that arbitrary distinct IDs are
automatically recognized as the same human intent.

`getTeacherMoneyStatusV2` authorizes current active reciprocal ownership and
allows active/readOnly, rejects suspended. It accepts one request ID or obtains
the caller's sole unresolved pointer. It returns only protocol version,
requestId, status (`committed`, `cancelled`, `unconfirmed`), action code, itemCount,
server commit time, and `requiresRefresh`; no target IDs, names, amounts, memo,
PINs, digest or stored ledger mapping. Different/unknown owners receive a generic
denial; the caller's absent receipt means unconfirmed, NEVER safe-to-resubmit.
The client prefers to reload history before presenting confirmation. If reload
fails, a current authenticated terminal receipt may show "The server confirmed
this action; the classroom view is unavailable", with action/count/time and an
explicit "Acknowledge saved action" control. It can call acknowledgment without
classroom projection succeeding; no balance or successful render is fabricated.
Timeout, absence or stale identity cannot enable this control. The same recovery
surface covers lifecycle creation.

`acknowledgeTeacherMoneyV2` is a recovery-metadata-only transaction: exact owner,
request ID, committed receipt and pointer match required; idempotently marks the
receipt acknowledged and clears only that pointer. Permitted in active/readOnly,
not suspended. It never changes money. `cancelTeacherMoneyV2` fences an unresolved
ID using a create-only cancelled receipt under the same key and actor state;
competing execution reads that receipt and must abort if cancellation wins. If
execution won, return committed and use receipt confirmation/acknowledgment instead.
Cancellation is allowed in active/readOnly, never suspended; quota exhaustion
may prevent new tombstones and must keep the UI blocked for operator resolution.
A refreshed absence alone never unlocks a new request. Cancellation has a bounded
receipt cost and no financial side effect. These writes are named recovery
metadata exceptions to readOnly, not hidden classroom-data mutations.

A cancelled tombstone has a status-specific schema: version, actor UID, requestId,
terminal status, server time and generation; no input digest or allocated IDs.
It rejects execution for that key before digest comparison, for ANY payload.
Its status response uses action `cancel`, count 0 and no financial-success claim.
Cancellation never overwrites a committed receipt or clears a different actor
pointer; a cancelled key needs no acknowledgment. This also permits recovery when
local payload was lost. Committed receipts still require exact digest/HMAC match
for execution replay; status/acknowledgment need only current owner and exact key.

Successful commit followed by failed reload says "Saved; refresh to see the
updated classroom" and offers the receipt-only acknowledgment above. Until that
acknowledgment the pointer remains. Acknowledgment clears the server operation
block even if the view cannot render; it does not clear an integrity error or
authorize stale balances/selections. The recovery surface works outside full
classroom projection. A new money action uses fresh identity/generation and §4's
targeted server plan; the broken full view cannot supply expected balances.
New-student creation may be composed there with fresh access state and lifecycle
checks. Uncertain transport says
"Not confirmed" and resolves the original ID. Stale UID/classroom/session
completions never publish, reset drafts or seed cache. Preserve operation lock
cleanup when rendering throws. Student-money requests retain their own replay
contract and receive the new generation check; this does not retroactively make
their old browser-generated IDs durable across lost devices.

## 4. Close all alternate money writers

Do not activate new rules after migrating only Quick Cash.

1. Move Quick Cash, custom selected/whole-class transactions, individual/all
   approvals and denials, roster balance adjustments, and reset-to-zero to the
   server intent contract. Keep pending controls, draft retention, refresh latch,
   exact-operation cleanup, and the recent initial-render exception regression.
2. Replace combined roster Save with explicitly separate "Save name" and
   "Adjust balance" actions. Historical `studentName` becomes immutable text at
   the time of each transaction. The current name comes from the current roster
   when displaying the account; history can display its recorded name. Rename
   atomically changes only the profile name, never historical ledger/mirror
   entries. Preserve projection's existing ledger-to-mirror parity contract;
   change student-money `validateStoredTransaction`, `matchesReplay` and the
   whole-mirror sweep in `requireStudentDocument` to bind student ID and exact
   ledger-to-mirror equality, not equality to TODAY'S name.
   Update all reporting identity mapping to use student ID; no permissive global
   schema relaxation. This intentional naming change removes historical fan-out.
   Rename compares expected current name, but returns successful no-op if the
   current name already equals the requested new name. Other mismatches conflict;
   both paths still recheck current owner/control/generation.
3. New nonzero opening balance creates an adjustment atomically with the student,
   credential, PIN directory and receipt: `status: Approved`, `source: Opening
   Balance`, `category: Balance adjustment`, `reason: Opening balance`, Add for
   positive/Subtract for negative, amount=absolute starting cents/100, server
   date, fixed explanatory memo. Zero opening balance has no money entry. Reserve
   these literal source/category semantics at the server; normal award input
   cannot choose them. Existing histories are not rewritten or backdated.
   `createStudentV2` receives requestId, protocol and control generation and uses
   the same actor pointer/quota/receipt contract. Its receipt holds allocated
   student ID/login ID but never plaintext PIN or credential password hash;
   lifecycle-specific status returns only
   the authorized public identity needed to recover the committed new student.
   Lifecycle extends the money receipt baseline with those public allocated IDs
   and a secret-key version. To bind retries of the initial PIN, a keyed HMAC of
   the canonical full create intent (including PIN) REPLACES the generic digest.
   It must not supplement an unkeyed full-intent/PIN digest in receipts, responses,
   preview tokens, logs or local markers. Never store an unkeyed PIN
   digest susceptible to 10,000-value guessing. Key remains valid for retained
   receipts; missing retired key fails replay closed, not new creation. This
   extra secret/binding is a release-manifest dependency. No secret is read here.

   Add a single shared reporting classification used before reduction by
   `classInsights.js`, `questionEvidenceAdapter.js`, `factPacketBuilder.js` and
   relevant tool aggregates: an exact server `source == Opening Balance` is an
   opening adjustment, not earned income or purchase. Existing `source == Teacher`
   plus `category == Balance adjustment` is an ordinary adjustment. Exclude both
   from metrics named earned/spent; include them in raw cash movement, ledger and
   current balances, with separate adjustment totals. Keep those scopes visible
   in verified answer rendering. Opening/history tests cover old/new cohorts:
   recorded earnings only, never inferred opening money or claims that missing
   legacy events prove zero earnings. Both cohorts' current balances remain
   comparable; complete lifetime earnings may be unavailable. Preserve historical
   balance-witness version-chain proof and its unavailable results.
   Reserve `source: Operator correction`, `category: Balance adjustment`,
   `reason: Compatibility correction` for N1's separately authorized tool, with
   Approved status and Add/Subtract by representable delta. Normal award/student
   inputs cannot choose these semantics. Use the same earned/spent exclusion and
   separate adjustment totals, retaining the restricted audit of original/proposed
   values. Unrepresentable deltas remain deferred, never rounded.
4. Freeze/unfreeze may remain a narrowly allowed teacher write if it changes
   only `frozen`; name, balance and mirror cannot piggyback. Settings/rent and
   non-money history paths stay separately allowlisted and access-controlled.
5. Deny direct client balance and mirror changes, all ledger creates and status
   transitions, and name changes that would desynchronize mirrors. Receipts are
   server-only; root accessControl is operator-owned and client-immutable.
   Keep student direct money writes
   denied. Server Admin SDK writers must enforce their own equivalent policy.
   Enumerate explicit client-deny blocks for receipt/actor/counter/audit paths,
   insightUsageLedgers, insightUsageReservations, balanceHistory and
   studentPinDirectory as well as default deny; broaden no allow rule.
6. The generic saver must refuse money-bearing differences before sending writes.
   A stale pre-cutover client receives a refresh-required failure from the final
   rules; it never gets a legacy money-write fallback. Keep V2 import, ledger
   clearing and reset-everything disabled. Dormant legacy/bridge rules are never
   deployed as recovery for this change.
7. Migrate the retained student callable and actual UI together to N1's versioned
   cent request and resulting-balance checks. Reject old unbounded requests;
   preserve create-only IDs/replay and the existing student safeguards.

### Explicit capacity behavior

Before confirmation, `planTeacherMoneyV2` checks current owner/control and performs
a consistent read-only transaction over a BOUNDED PREFIX of the sorted proposed
targets, current student/mirror/ledger versions and capacity, not all targets at
once. Accept at most 100 target IDs and a 64 KiB request; larger rosters first
require an explicit subset. The planner itself has an 8 MiB conservative read-data
budget, independent of execution feasibility. Before EACH point read, reserve a
proven worst-case bound for the next target's complete dependency group, including
foundation/control/capacity reads and transport/encoding overhead. For unread
existing documents use the verified platform maximum unless an enforced schema
proves a tighter limit; the new 900 KiB write ceiling does not bound legacy reads.
Never fetch a document merely to discover that it exceeded the remaining budget;
never issue an unbounded query or fetch all targets before partitioning. If the
next dependency group cannot fit, stop BEFORE that read and return a feasible
prefix plus ordered remaining supplied IDs labeled `notYetPlanned`. Return those
as IDs only, not an assertion of ownership, existence or capacity. If no target
can safely be read/planned alone, return an explicit single-target planning-limit
reason, no executable plan and the remainder; do not retry in a no-progress loop.
All hydrated targets in this attempt share its consistent snapshot. On transaction
callback retry, reset read accounting and rebuild the prefix from fresh state.
Every continuation is a fresh bounded plan with fresh authorization/version checks;
do not concatenate snapshots into a supposedly atomic whole-class plan. Read no
more targets in this invocation to service its remainder. Bound the reply to 64 KiB
too, shortening the prefix if necessary, never dropping remainder IDs silently.
Only a feasible prefix is offered for explicit teacher confirmation; the remainder
needs a later plan and confirmation, with no automatic execution. Return a server-derived plan bound
to owner/classroom/generation, exact action and versions, expiring after 60 seconds,
with selected target summaries/expected balances and a size-feasible selection.
Return only authorized selected data, no PINs/unrelated records. Planning writes
no marker, receipt or money; it is a preview, not a reservation or auto-submit.
Returned plan fields are untrusted when sent back; no signature or additional
secret is required because execution re-derives every authorization, amount,
version and size check from current server records. A forged plan grants nothing.

Size only hydrated prefix targets deterministically using the SAME conservative
sizing function as execution: full resulting documents/mirrors, ledger writes,
receipt/actor/counter, read-set budget, encoding/index overhead, request size and
write count. Each proposed subset must fit all limits; a target that cannot fit
alone gets a specific reason. Any fetched target excluded from the final feasible
prefix (including reply-size trimming) stays in the ordered remainder too; its
data is not returned as an executable plan. The displayed bound is at most 100 and may be much
smaller; count alone cannot describe heterogeneous sizes. Only a fully planned
exact subset enables "Apply to these N students". No guessing downward through
repeated size errors. Execution rechecks versions, generation, all invariants and
actual size: expiry or relevant data change demands explicit replan/reconfirmation
without partial money writes. Verify unchanged maximum-size plans with real SDK/
emulator requests before release. Neither a document-count calculation nor this
proposal proves actual platform byte accounting or guaranteed success under races.
Resolve/fence any dispatched prior ID before composing that new action/plan;
never change the digest, generation or plan of an unresolved request in place.

The UI permits explicitly selected, separately planned batches. It never
automatically chunks or labels a partial batch as "whole class reset". Completed
batch receipts remain visible if a later batch fails. Each teacher-confirmed
batch is a separate deliberate atomic action, with a new ID only after prior
receipt acknowledgment. The all-class button is disabled unless the entire shown
roster fits one valid exact plan within every ceiling, and
points to this batch workflow. This is an explicit product limit, not silent
partial success. Name edits remain bounded independently of history length.

At 1,000 mirror entries or 900 KiB, new additions stop with a specific capacity
message and support path; decisions on existing requests and reads still work
within byte limits. The preflight reports remaining capacity. Money activation requires
at least 100 additional mirror slots and 100 KiB headroom per current student;
at 80% of either cap, schedule the separate paginated-history migration before
headroom is exhausted. No archiving/deletion is improvised. An oversized existing
classroom remains readOnly through project-wide cutover. These explicit limits are subject to
independent design review and must be disclosed, rather than claiming indefinite
operation at the current schema's capacity ceiling.

## 5. Classroom access control and recovery — decision C1

Store server-owned `accessControl` INSIDE the existing classroom root, with exact
fields `schemaVersion: 1`, `mode`, positive integer `generation`, `changedAt`,
`auditId`. This supersedes the separate classroomControls collection. Client root
updates must preserve accessControl exactly; no client may set/delete it. It is
not secret and may accompany an authorized root read. Missing/malformed control
fails closed under post-cutover rules and guard-aware services.

| Mode | Remote scoped reads | Money/profile/credential mutations |
| --- | --- | --- |
| active | Existing authorized reads | Current-generation authorized operations |
| readOnly | Existing scoped reads, receipt status | Denied; only named recovery metadata/audit exceptions below |
| suspended | Classroom data and sensitive callable reads denied | Denied, except restricted operator recovery/audit |

Operator interface is a local CLI, not a new browser administrator role. Existing
project operator IAM, explicit target project + classroom allowlist, operation
ID and expected generation authorize the server transaction. No new IAM grant,
service-account key or platform-admin privilege is introduced. Audit records
are server-only; output contains outcome and counts, never classroom contents.
Control+audit commit atomically. Replaying the same operation returns its prior
result; stale generation or changed scope fails. No timed auto-resume, control
deletion or generation reset. New onboarding creates control with foundation;
existing initialization follows §6. Operator tooling must have a read-only
plan/dry-run and refuse default project selection.

### Exact client rules matrix (distinct-document lookup budget)

Use split `isReadableOwner`, `isWritableOwner`, `isReadableStudent` and explicit
path allowlists. Avoid evaluating the teacher path for a student token: role
routing must prevent a lookup of teachers/<student auth UID>. Student role never
qualifies as teacher even if a malformed teacher document exists.

| Allow branch | Documents looked up beyond requested resource | Upper bound |
| --- | --- | --- |
| Teacher own foundation get | teacher/current resource; linked classroom | 2 conservatively |
| Teacher classroom root get/settings update | teacher + classroom (requested resource may be reused) | 2 |
| Teacher roster get/list; rent; ledger get/list; login history; scoped auth logs | teacher + classroom | 2 |
| Teacher freeze-only and allowed non-money history/rent writes | teacher + classroom | 2 |
| Student own profile get / rent get | classroom + owner teacher + scoped credential | 3 |
| Money fields, mirrors, ledger create/status, credential/PIN/receipt/usage/control writes by clients | unconditional deny | 0 |
| Foreign tenant, anonymous, malformed identity, legacy and unmatched paths | early deny where possible; bounded above by corresponding branch | at most 3 |

Read helpers require mode active/readOnly; write helpers require active. Student
self-read retains exact auth UID, classroom/student/login ID and credentialVersion
checks; hasActiveReciprocalFoundation also checks valid accessControl mode.
No generation claim is needed merely to deny a currently suspended token: every
fresh authorized read checks CURRENT root control. On resume a still-valid token
may read again deliberately. Suspension is not permanent credential revocation;
an account-compromise recovery also rotates/revokes the affected credentials
before resume. No one-hour token-expiry wait is treated as the pause mechanism.

The retained generic saver already uses one classroom per transaction. Shared
lookups are same exact paths, so planned legal teacher multiwrites need two
unique lookups; budget tests must prove caching and per-operation/overall limits
with emulator requests at the maximum supported shape. If a path cannot meet the
budget, migrate that action server-side or lower its explicit bound; never raise
permissions or skip control checks. The source count is not execution proof.

### Mutation generations and pause ordering

Every mutable V2 request includes protocol + expected control generation after
cutover: teacher/student money, PIN reset, student create/remove and profile edit.
Its transaction reads current teacher/root and matches that generation before
writes on EVERY callback attempt. Old protocol requests are rejected, not given
a default current generation. A stale pending request cannot become valid after
pause/resume increments the generation. Freeze/settings direct writes rely on
current rules, not a new generation token; they are non-money writes and denied
while paused. They are not given a queued offline replay feature.

PIN hashing remains outside a transaction; authorization/control is re-read
inside. Login validates current mode/credential in its verification transaction;
custom token minting may finish after pause, but that token cannot read or spend
while suspended. Recheck immediately before minting for early refusal; do not
claim that this removes the unavoidable nontransactional boundary. Students
may sign in to view only in readOnly. Logs/throttle records may still be written
for denied login attempts as bounded security records. Fresh mutable requests
cannot use a generation from an old session.

A control write and a money transaction conflict on the same root read: commits
order before or after the pause. Pre-pause accepted money remains committed;
post-pause mutation cannot commit under the old generation. This does not cancel
a response in flight. Firestore client-rule access must also be verified after
rules propagation; no zero-latency or remote-wipe guarantee is made.

### All exported routes and background writes

`TEACHER_MONEY_ACCESS_SURFACE.md` is the exhaustive baseline export matrix.
There are no deferred active writers in the containment claim. Parameter/secret
exports are configuration, not callable routes. Any new export must have an
explicit tested row. The inventory is source-only; deployment metadata must
also establish that no retained older Function is serving before activation.

Important exceptions are explicit:

- `syncStudentProfilesV2` becomes inert for enrolled protocol-1 classrooms;
  lifecycle create/remove/reset synchronously own credential consistency.
  Before enrollment verify the invariant, drain old delivery and reconcile any
  mismatch under maintenance. Late old events see the enrollment marker and
  return without credential writes. No silent deferred replay on resume.
- `recordStudentBalanceHistoryV3` is create-only audit of an already committed
  Firestore event. It may append its deterministic witness during a pause; it
  never changes balances, credentials, controls or ledger. Preserve duplicate
  comparison and retries; suppressing it would destroy historical evidence.
- Insights may not make new reservations or dispatch claims in readOnly or
  suspended. Reservation/dispatch claim transactions read control+foundation;
  evidence reads are guarded and generation-bound. A claimed provider call can
  already be in flight when pause commits. Settlement of preexisting reservations
  remains permitted accounting-only (same reservation, no increased allowance,
  no new dispatch); answer publication requires current authorization. Track
  these outstanding claims and drain/cancel before claiming provider quiescence.
  A last-moment check cannot atomically fence a third-party HTTP request. Until
  claims are resolved/expired and runtime termination verified, report "classroom
  writes paused; provider work draining", not "all external work stopped".
  Per-dispatch claims are NEW writes, not current usage-ledger behavior. Include
  one transactional claim per outbound provider dispatch in the bounded request/
  tool budget; measure retry, latency and Firebase cost in staging. Codex retains
  this cost for observable pause/drain accounting, not an atomic HTTP fence.
  The release manifest must quantify it within the existing budget; if it does
  not fit, return for design review, never silently remove the guard or increase
  spending. No provider call is performed in this design work.
- Receipt acknowledgement/cancellation and restricted operator recovery remain
  the narrow non-money recovery writes described above. Neither grants clients
  arbitrary Firestore access to recovery documents.

This is remote containment, not deletion of earlier exports, screenshots or
already-delivered caches. Explicit denial purges/hides supported-client cache
and is not a transient offline fallback. Offline pages may retain previously
authorized data but cannot commit money. No provider or production reads are
performed while preparing/reviewing this proposal.

### Incident and recovery sequence

1. Choose affected classroom scope; capture release IDs and sanitized current
   control generation. Use readOnly for integrity incidents; suspended for access
   incidents. An all-classroom incident requires an explicit verified inventory;
   per-classroom controls do not claim atomic project-wide shutdown.
   The operator provides affected teachers an out-of-band pause/recovery notice
   and contact without sensitive incident details. Generic app denial remains
   deliberate; this design does not itself send any messages.
2. Apply the operator transition once with preconditions; independently read it
   back. Verify teacher direct writes and callable writes denied, student
   submissions denied, and read policy appropriate to the selected mode. Include
   already-signed-in clients and requests held at transaction barriers.
3. Preserve ledger, mirrors, receipts, credentials and snapshots. Investigate in
   a restricted environment. Never rerun pending money requests or restore an
   old database snapshot as routine application rollback.
4. Roll application code back only to a retained, tested version compatible with
   the strict rules/control protocol. The pre-cutover money client is not a
   functioning money rollback target. If no compatible version exists, retain
   maintenance/readOnly and fix forward; never reopen direct money writes.
5. Reconcile accepted receipts and ledger/mirror relationships. Restore any
   missing acknowledgment, not duplicate money. Obtain independent review for
   correction and test the exact recovery version before resuming.
6. Resume with a new generation after fresh identity/control checks. Old cached
   generations and queued actions remain rejected. Verify scoped read/write
   behavior and observe the recovered classroom. Record residual uncertainty.

Backup restoration is a separate disaster-recovery procedure requiring actual
backup availability and a restore rehearsal. This design does not assert a
current backup service, recovery time guarantee, or successful restore.

## 6. Implementation and release sequence — decision D1

Muse reviews this correction, then Claude independently reviews the final design.
Codex then implements bounded stages: access policy/operator dry-run and per-route
wiring tests; money/receipt/lifecycle service; UI and strict rules; emulator,
Chromium/WebKit, mixed-version and recovery rehearsals. Each material code change
follows the permanent Muse then Claude sequence. This design is not tested code.

Choose one controlled production maintenance window. No new teacher-money
endpoint is live while old direct money rules are writable:

1. Produce the full release manifest covering the project's ENTIRE classroom
   inventory in the single default database, including deferrals, current and
   compatible recovery versions, advisory compatibility scan, and operator
   authority record. Rehearse the entire sequence with fictional staging data.
   The earlier Hosting-only approval does not authorize these Functions/rules,
   initialization/secret/control mutations. Present one concrete grouped scope
   including each deferred classroom's readOnly/read-compatibility outcome.
2. Prepare a minimal, reviewed interim maintenance rules artifact that denies ALL
   application client writes project-wide, preserves existing scoped reads,
   and gives no new privilege. All classrooms are affected; there is no parallel
   old-rules cohort. Publish and independently verify the exact artifact
   plus denied old-client direct writes BEFORE exposing new money endpoints.
   Disable existing V2 invocation gates/new invitations during this interval;
   gates alone do not fence Admin SDK transactions already in flight. Drain all
   old callable invocations and triggers, and verify no active revision can still
   commit. No data initialization or final scan until that verification passes.
   If bounded drain cannot be established, STOP maintenance rollout; do not claim
   the fence or launch a concurrent new writer.
3. Under the verified fence run the final version-bound scan. Initialize each
   classroom accessControl to readOnly with generation 1 using an idempotent
   operator transaction: absent -> exact planned value + audit; identical prior
   operation -> readback success; any other state -> conflict, no overwrite.
   Initialization uses a frozen classroom inventory and a journal of per-classroom
   outcomes. Never activate a partially initialized project/scope. Interruption
   resumes by readback of that journal, not by guessing missing defaults.
   Numeric/capacity-deferred classrooms get the same valid readOnly control and
   compatible reads. An unverified foundation or incomplete inventory halts the
   project transition; it cannot be bypassed as a numeric deferral.
4. Deploy all guard-aware services (including student contracts, triggers,
   receipt/profile/lifecycle and Insights control wiring), with V2 gate still
   disabled. Publish final strict rules and compatible Hosting while controls
   remain readOnly; old clients still cannot write money. Verify exact service
   revisions, rules checksum, assets and configuration. New callable can execute
   money only after both gate and active control permit it.
5. Enable the reviewed V2 runtime while controls remain readOnly; verify scoped
   reads and all mutation denials, including stale tokens, old protocol clients,
   triggers, direct REST/SDK writes and receipt recovery. Never switch to active
   because only the UI banner looks right. Onboard/invite creation remains closed
   for the maintenance scope until inventory verification is complete.
6. Resume only validated classrooms by explicit operation ID and generation
   increment. Verify acceptance with an explicitly authorized fictional scope;
   keep real-classroom checking read-only unless the owner names intended writes.
   Record clean state and observe after cutover; no automatic activation timer.
   Deferred classrooms stay readOnly under those same strict rules and Hosting;
   verify their reads and denied money alongside active clean classrooms. Resume
   a deferred classroom only after authorized remediation and a fresh passing scan.

Interruption/recovery: before new money activation, remain on the verified
maintenance artifact/control with safe reads where supported; resume the journal
and deploy a compatible artifact. Missing controls under final rules deny access
until initialization completes; this is a disclosed maintenance state with an
operator readback path, not a default-active fallback. After any new money commits,
rollback never restores old permissive money rules or old server writers. Keep
readOnly/suspended, restore a recorded compatible revision or fix forward, and
reconcile receipts before resume. Retain code/rules/assets/config snapshots and
check their actual availability; no known compatible version is assumed yet.

The operator's pause record is evidence of a state change, not proof of a backup.
Disaster recovery/record restoration remains separate and needs a real restore
rehearsal. No data deletion, migration execution, provider call or release occurs
in this design correction.

## 7. Required discriminating tests

- Active teacher raw balance-only, mirror-only, forged ledger create/status
  update, name-plus-balance and unrelated-field writes denied by real rules;
  legitimate narrowly allowed settings/freeze remain usable. Cross-tenant,
  student, anonymous, missing/disabled foundation and malformed control denied.
- Exact request replay (including lost acknowledgment) makes one ledger/balance
  change; changed payload under same key fails. Concurrent same/different IDs,
  two approvers, approve-versus-deny, student spend versus teacher award, and
  stale reset fail or serialize with no lost updates and consistent mirrors.
- Decimal boundaries, negative teacher balances, student insufficiency, unsafe
  numbers, existing unsupported values, oversized batches/mirrors and injected
  ID collision fail before partial writes. Opening adjustment preserves existing
  historical uncertainty and does not count as earned money in Insights.
- Student Add and Subtract at the cent ceiling (otherwise permitted) versus
  ceiling+1, old dollar requests, unsafe conversion and out-of-domain balances:
  no rejected money/mirror/throttle write. Unsupported legacy Pending approval
  gives the specific refusal; Deny preserves amount/balance and exact parity.
- Canonical server dates accepted by the real normalizer; equal-instant mixed
  legacy/ISO records yield equal local-day and rolling-window inclusion around
  midnight/DST, including openings/corrections and different process time zones.
  Also compare two request zones: ISO instants stay fixed while legacy wall clocks
  follow each requested zone; disclose that uncertainty, never rewrite history.
- Unchanged maximal-mirror selections planned below 100 fit SDK/emulator limits;
  heterogeneous documents, receipt/index overhead, single-target overflow, expired
  plans and size/version drift before execution require safe replan, not partial
  writes or a false committable-batch promise.
- An oversized PLAN request (within 100 IDs but beyond the planner read budget)
  returns a feasible prefix and complete ordered `notYetPlanned` remainder, not
  an over-budget read/platform error. Instrument reads to prove reservation occurs
  BEFORE fetching the next complete dependency group; include large legacy docs,
  shared dependencies, callback retry, reply bounds and single-target no-progress.
  In unchanged valid state the returned prefix executes within SDK/emulator limits
  on its first attempt; concurrent change still safely requires replan. A fresh
  continuation reauthorizes and does not merge snapshots or auto-submit money.
  Prove both planner and executor accounting; estimated arithmetic alone is not
  platform limit evidence.
- Routine dispatched rejection automatically fences its key then clears only its
  marker; no rejected financial write or pointer modification. Race a second
  invocation with rejection recovery: cancellation wins and blocks all payloads,
  or committed wins and requires acknowledgment. Lost cancellation response,
  quota failure and changed identity never falsely clear unresolved state.
- Failed save retains drafts and confirmed state; successful commit with failed
  reload is distinguished; initial render throw clears only its own operation;
  changed UID/classroom/session never publishes a late result or cache entry.
  Add repeated reload/projection failure: show current terminal receipt outside
  the broken view, explicitly acknowledge, then execute a newly planned action
  or lifecycle create with fresh checks. Unconfirmed/stale status cannot unlock;
  acknowledgment never suppresses a continuing data-integrity error.
- Pause at every transaction barrier; PIN reset during hashing; old auth token;
  stale browser; old control generation after resume; cached offline page;
  paused Insights dispatch; removal and rename races. Verify remote denial
  independently of banners. Cover reads in both readOnly and suspended modes.
- Logout/tab close/local-storage loss with unresolved acknowledgment; two tabs
  racing different IDs; absent-status versus late commit/cancellation; cap reached
  during cancellation; immutable receipt inspection after a generation change.
  Prove unresolved server actor state prevents a second unacknowledged award.
- Mechanically enumerate all callable/trigger exports, then test each matrix
  row through its actual entry point. Assert enrolled credential trigger no-op,
  allowed audit witness writes and exact prior-reservation settlement exceptions.
- Rename after large history without rewriting ledger names; student mirror
  validation still rejects wrong IDs/content. Explicit 101-target batch UI must
  not claim whole-class atomic reset or auto-submit subsequent batches.
- Compatibility scan pagination, interrupted scan, version drift, fractional and
  over-limit legacy data, quota/mirror warnings and deferral of money activation
  under the same readOnly controls. No silent correction or partial initialization.
- Cutover with old/new clients, missing control, partial service deployment,
  interrupted initialization and recovery retry. Rehearse rollback without
  weakening rules or replaying money. Preserve all unrelated classroom records.
  Include clean and numeric/capacity-deferred classrooms under ONE rules artifact:
  both retain authorized reads, only the clean one activates, and missing control
  or broken foundation cannot silently pass project-wide initialization.
- Rename lost-response retry is a no-op only for the exact desired current name;
  renamed historical student replay still succeeds without relaxing parity.
  Lifecycle stores only the keyed HMAC binding, no parallel unkeyed PIN digest;
  enumerate deny rules for every named server-only path.

Use existing package commands where applicable: `test:phase3:unit`,
`test:teacher:balances`, `test:phase2b:client`, `test:phase3:rules`,
`test:phase2b:server`, `test:phase2b:browser`, `test:phase3:contracts`,
`test:phase2b:build-contract`, root/Functions lint and build. New meaningful
tests join these suites. No passing counts are claimed for an unimplemented
design; old results must not be relabeled as proof of these invariants.

## 8. Selected decisions, simplification and excluded work

N1 ($1M cent domain plus explicit preflight/remediation), I1 (deterministic IDs),
L1 (size-planned atomic actions and explicit batches), T1 (server ISO dates and
explicit reporting zone), R1/R2 (capped permanent receipts,
durable unresolved state and exact status contracts), C1 (root-embedded control)
and D1 (interim write fence first) are Codex's concrete proposed decisions, not
questions delegated to reviewers or claims of owner approval for production
mutations. Reviewers should accept or reject them with source-backed reasons.
Andrew only needs to decide actual business-value corrections or a scoped
release, not implementer details such as hashing and helper signatures.

Muse suggested splitting money integrity from a new pause system. Accept the
simplification of avoiding a separate control collection and any browser admin
console; keep server-owned state on the already-read root. Do not substitute only
V2 gate-off plus teacher disable for the requested recovery guarantee: existing
PIN-reset/Insights/background paths still need their own treatment, gate changes
do not cancel in-flight work, and teacher disable removes read continuity. The
matrix makes this cost explicit. If this remains disproportionate, a later scoped
alternative must withdraw the broader pause claim rather than quietly omit it.

PIN-guessing/throttle redesign, anti-framing, Node 22 CI, general stale-document
cleanup and dormant migration cleanup stay separate. Included Insights changes
are only access/settlement control and the explicit adjustment-reporting contract;
no new question feature or provider architecture change. Retain all historical
reviewer attribution. No full security scan or reviewer subagents are requested.

## 9. Platform references checked for this proposal

Server SDK calls bypass client security rules, which is why both enforcement
layers need explicit coverage. Rule document lookups are also bounded; add
budget tests rather than assuming every new control lookup is free.
[Firebase rule conditions](https://firebase.google.com/docs/firestore/security/rules-conditions)
and [transaction rules limits](https://firebase.google.com/docs/firestore/manage-data/transactions).
These references support the platform constraints, not proof that the proposed
implementation exists or passes them.
