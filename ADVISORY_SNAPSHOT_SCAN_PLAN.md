# Advisory scan at a fixed database time — Stage14 proposal

Status: correction1 design only; Muse delta and Claude closure pending after
Claude's F1/F2 findings. No transport, launcher,
principal, live switch or report consumer is implemented or enabled here.
Baseline: `fd6b60e199b68a869408894261e151cfa2daafe8`.
Read `CLOUD_SCAN_PROOF_DECISION.md` for the platform facts and unresolved gates.

## Purpose and precise contract difference

The proposed operation reports compatibility of the entire authorized classroom
dataset as it existed at one database time T. Writers may continue after T;
that does not mix their later values into the report. This is an engineering
consequence of the documented Firestore read-time semantics, conditional on
correct transport, complete enumeration and successful reads at T.

This is a separate advisory operation. It cannot satisfy the protected scan's
maintenance, audit-chain, initialization or activation requirements. Do not add
an advisory bypass to `runProtectedMoneyScan`, its fictional observer or publisher.
Do not reuse a protected report kind or forge an observer exit record.

The integrity design's section 3 currently says the advisory scan is not a
consistent frozen snapshot. Proposed clarification, only if this design is
adopted: the new advisory operation is consistent as of T, but is never evidence
that the current database is frozen or eligible for cutover. The existing
advisory implementation and final fenced-scan requirement retain their contracts.
Neither existing authoritative document is amended by this proposal alone.

## Feasibility before implementation

Retain the current evidence standard. Under that standard, this proposed operation
is expected to remain unlaunchable with the researched mechanisms. Do not build
its inventory adapter, scan adapter or private launcher first and defer this
decision until live admission. The current deliverable stops at a reviewed blocked
design; it is not an implementation-ready alternative.

Before implementation, a separately reviewed feasibility record must map every
admission condition to a named mechanism, its documented coverage and limitations,
and discriminating qualification cases. In particular, it must resolve effective
access, concurrent policy changes, database/admin exclusion and private execution.
Rejected log/inventory/probe shortcuts, merely naming a future observer, or matching
before/after samples do not satisfy this prerequisite. No qualifying mechanism for
those unresolved conditions is supplied here. If one remains unmapped, stop before
local implementation; later live qualification and authorization remain separate.

The protected plan explicitly requires effective-permission verification before
credential delivery; this proposal also requires a concurrent-policy-change boundary.
That additional requirement is a retained design gate, not a guarantee already
established by the protected plan. A future point-in-time evidence standard would
change the claimed assurance. It needs a concrete limitations/risk proposal, Muse
and Claude review, and Andrew's explicit scoped acceptance before adoption. No such
relaxation or risk acceptance is made here.

## Admission before the first request

Require a separately approved private scope for `morgan-bank` / `(default)`,
1–100 classrooms, exact owners and explicit suspended-room permission, reviewed
source/dependency/runtime hashes, a new run ID, start/expiry limits and the private
output/lease directory. A fictional staging adapter must have a separate fixed
target; no arbitrary endpoint/project selector, environment fallback or force flag.
The current demo reader and production refusal stay unchanged.

Before even names or timestamp metadata are read, require independently collected
principal/credential evidence and explicit scan authorization. Metadata and document
IDs are private too. A hash or a typed acknowledgment cannot satisfy that gate.
The private supervisor is run by Andrew outside agent-visible sessions. It must
enforce the existing no-model-access rule, fixed local lease directory, reviewed
bytes and full child/publisher lifetime. Stage13 alone does not implement these.

The desired data principal has only `datastore.entities.get` and
`datastore.entities.list` on the approved database scope. These permissions can
read beyond the application's path allowlist, including credential documents;
they are not tenant/path isolation. Preserve the protected plan's disclosure of
that broader privilege. The narrow transport enforces which paths are requested.
Do not reuse the old migration reader role, which also permits Auth-user reads.
Credentials must be explicit, short-lived and unavailable to models, output,
arguments, environment discovery or automatic refresh. No cached CLI/ADC, key
discovery or metadata-server fallback. The transport must never request Auth,
credential collections, logs, exports, IAM or deployment APIs. The actual binding
and credential delivery mechanism must be separately reviewed.

Effective access remains a hard gate, not a claim made by this plan. The separate
private observer must establish the exact principal, full applicable resource
hierarchy and policy/role definitions, direct and group/principal-set grants,
conditions, impersonation/delegation and applicable boundaries. Hidden/unreadable
ancestors, unresolved membership, stale-only inventories, incomplete expansions,
extra powers or an unproven concurrent-policy-change boundary leave admission
unavailable. Read-only request construction is an additional invariant; it does
not prove a bearer credential has no other capability. Policy Analyzer and
testIamPermissions can contribute evidence but cannot alone certify this gate.
This plan supplies no new algorithm that converts those limitations into PASS.

The observer also binds the exact database resource and UID using its own minimal
metadata authority before admission and before publication. The data principal
does not receive database-metadata permission for this purpose. Missing, changed
or indeterminate identity aborts. This is an identity check, not complete Cloud
history proof. Independently established exclusion of destructive database/admin
operations is explicitly an admission gate in this retained standard. No qualifying exclusion
procedure is supplied, so this too blocks implementation at the feasibility step.
Matching UID samples do not establish exclusion. The reviewer's suggested argument
that failures and UID checks alone suffice was not independently verified and is
not adopted as a replacement guarantee.

## Scope inventory and separate scan authorization

The scope producer is the read-only inventory preparation in
`PROTECTED_MONEY_SCAN_PLAN.md` section 1, operation 1. Reuse that exact operation,
including its control-plane inventory, separately authorized prior fictional
canary setup, complete phantom-parent-aware names enumeration, masked V2 root/owner
classification, and blockers for legacy roots or invalid reciprocal ownership.
This proposal does not invent a reduced inventory that skips those requirements.
The inventory has its own authorization and the same principal, privacy, transport,
deadline and output protections; authorizing discovery of the target database's
complete classroom namespace does not require an already-known classroom list.
Neither the inventory nor its canary setup is authorized by this scan proposal.

No student, transaction or rent paths may be requested by the inventory. Its data
reads are classroom names and masked root/owner fields only; its separately scoped
control-plane observer keeps its own authority. The inventory is advisory, not a
claim that its observations equal the later scan's database snapshot at T.

The completed restricted inventory record binds target/database identity, canonical
classroom/owner list, evidence provenance, reviewed tool/runtime identity, completion
time and an expiry no later than 30 minutes after completion. Reviewed tools validate
its foundations; Andrew reviews the permitted scope locally outside every model and
separately authorizes the scan. He is not asked to certify technical correctness.
Bind the exact inventory record digest, classroom/owner list and expiry into that
scan authorization. A digest binds bytes; it does not establish provenance, valid
inventory, permission evidence or Andrew's approval by itself.

The scan must refuse a hand-written list, an aborted run's output, a missing or
unvalidated inventory, mismatched target/identity/list, absent scope approval or an
expired record before its first request. Keep the inventory valid through publication;
never extend its expiry. A stale or changed scope requires a fresh independently
authorized inventory and scan, not automatic reuse or promotion of failed output.
At scan T, re-enumerate and require exact namespace equality and reciprocal ownership
again. No matching digest or prior inventory waives this current-run check.

## Select and bind T without reading money

After admission, perform exactly one non-retried strong `batchGet` of one root
already named in the private authorization, masked to `__name__`. Do not use an
arbitrary path, create a clock document, request a transaction, or read the root's
money/profile fields. Found or missing may supply timestamp metadata; either
response must name exactly the requested resource, include a valid read time,
and contain no extra document/field payload. Full namespace validation follows.

ReadTime is server-returned metadata, not a value inferred from the local clock,
HTTP Date, document updateTime or audit timestamp. Parse seconds and nanoseconds
without truncating to JavaScript Date milliseconds. Convert the server time down
to supported microsecond precision, never round forward, and encode one canonical
UTC string T. Preserve both the returned time and chosen T in the restricted
record. If conversion is invalid or T is rejected, abort; never select a new T
inside the same run. Qualify this bootstrap and precision behavior in staging.

Immediately bind T immutably to the run, database identity, source, authorization
and scope. All subsequent data calls, including names, owner/root classification,
money, absence checks and repeat verification, must specify exactly T.
The bootstrap payload is never analyzed as money or counted as a scan input.

Use the ordinary one-hour historical-read window; this initial design does not
enable or rely on seven-day PITR. Keep the existing 15-minute run and 30-minute
authorization limits, measured with monotonic continuity and absolute expiry.
Do not assume host time proves Firestore retention; any server refusal aborts.
Never fall back to a current read, retry at a newer time, resume a prefix, or extend
expiry. A new authorized run must discard the old provisional result entirely.

## Complete enumeration and ownership at T

First enumerate all `classrooms` names at T using bounded ListDocuments pages,
`showMissing:true` and a names-only mask. Do not set explicit orderBy with
showMissing. Follow continuation tokens until exhausted; a short page is not the
end. A repeated token, duplicate/nonmonotonic path, malformed/over-budget response
or unsupported ID aborts. An empty page with a continuation token may conservatively
abort; it must never be treated as successful exhaustion. Keep all page parameters,
including T and masks, fixed; tokens are scoped to their originating collection.

The complete namespace must equal the privately authorized allowlist. New or
deleted rooms relative to that scope, unknown/legacy roots, or phantom parents
are whole-run blockers before money reads. Do not skip invalid roots or fetch
their aggregate contents. Read every root with `ownerUid`, `classroomId` and
`accessControl` only, and every approved owner with `uid`, `status`, `classroomId`
only, all at T. Validate unique reciprocal active ownership, tenant paths and
suspended scope for every room before reading any room's full data. A current
owner observation cannot substitute for ownership at T or for authorization.

Then inspect only the same data surfaces as the protected plan section 5: approved
roots, those masked owners, direct students and transactions, and the exact rent
document. Enumerate the two child collections with the same T, pagination and
missing-parent rules. Root/student/ledger/rent content stays in private memory.
Do not read credentials, Auth, invitations, loginHistory, balanceHistory, operator
journals, unrelated subcollections or collection groups. No root creation/repair,
orphan cleanup or historical-record reconstruction is performed.

Use the existing pure room analyzer and projection requirements unchanged,
including `loginHistory: []` and pinned projection defaults. That synthetic empty
history does not verify real login history, credential readiness, UI access or
audit continuity. Pending work or a multi-write workflow spanning T can yield
findings at T; the report must not call them permanent corruption or a safe repair
instruction. No balance, rounding, transaction decision or migration is performed.

Every required operation must succeed at T. A genuine absent optional rent
document may be represented as absent; an HTTP/auth/transport failure must not be
converted into absence. Invalid foundations or incomplete reads abort globally.
Keep create/update versions, but do not use updateTime as the snapshot selector.
Repeat namespace/version checks, if implemented, also use T and detect implementation
or scope errors; they do not establish what the database looks like now.

## Transport, limits and private output

Proposed real transport: fixed official Firestore HTTPS origin and exact v1 target
paths; GET only for ListDocuments/GetDocument, plus the single narrowly shaped
bootstrap BatchGet POST. No generic request interface, transaction, write batch,
create/update/delete/commit, arbitrary query, redirect, proxy from ambient state,
custom CA bypass or automatic credential discovery. Authorization headers stay
only in the private transport. Per-page response checking precedes analysis.
List/Get do not echo readTime as an independent receipt: the guarantee rests on
the actual outgoing request plus the service contract, not fabricated response
metadata. Inspect that request construction in tests and staging.

Retain limits: 100 rooms, 20,000 total retained documents including owners/rent,
100,000 findings, 25 documents/page, 8 MiB/response, 64 MiB/input, 32 MiB/report,
10-second network request timeout and the absolute run deadline. Count bootstrap
and verification wire bytes against input limits. Start with no automatic retries;
a transport failure aborts. Do not retain raw response bodies in diagnostic logs.
No import/help/plan validation constructs a client or sends a request.

Use a new result kind `advisory-money-snapshot-result-v1` and a separate strict
schema. Restricted metadata includes T, database UID, source/scope/authorization
bindings, versions, membership, findings and publication digest. Completion means
the bounded scan and private durable publication finished, not that findings are
empty or the application is healthy. Include fixed statements that the report is
historical/advisory and that maintenance, writer drain and audit completeness are
not established. Keep `artifactAccepted:false`, `productionEligible:false`,
`initializationAllowed:false` and `activationAllowed:false` unconditionally.

Normal output retains the authorized project-total counts and fixed categories
only, with an advisory-only label; no timestamp, UID, run ID, room rows, paths,
values, raw error text or new free-text output is shared with models. T belongs
in the restricted record. Andrew may manually share only the previously approved
bounded summary. Never serialize exception chains or dump traceback/local values.

Retain descriptor-based private storage, no-clobber publication, readback/digest
verification and the inherited lease until every child has settled. Child processes
must close their copy and never explicitly unlock the shared lock. An attempted
but unacknowledged publication remains unconfirmed; leftovers are unaccepted.
No report consumer or conversion into a protected-scan receipt is supplied.

## Required discriminating acceptance cases — not yet executed

Before any implementation, the design/readiness review must reject a feasibility
record that leaves access, policy-change, admin exclusion or privacy conditions
unmapped. A future-observer label or manual acknowledgment is not a mechanism.
The cases below are prospective runtime tests, not executed evidence.

| Case | Required result |
| --- | --- |
| Missing, fabricated, expired or mismatched inventory; list copied from an aborted run | Refuse before the scan's first request; no automatic promotion or new authorization |
| Inventory attempts a student, transaction or rent request | Reject before dispatch; names and masked root/owner data only |
| Inventory scope changes before T, or inventory expires during scan | Global refusal/abort; no prefix report, expiry extension or silent scope update |
| Change an existing balance after T, including change-then-restore | Every read and analyzer input remains its version at T |
| Create/delete/recreate a student, transaction, rent or room across T | Membership and existence reflect T; no mixture from current pages |
| Change owner/control after T | Classification uses T; separate run authorization still required |
| Phantom classroom whose only child is an audit witness | Names enumeration sees the phantom; abort before money, without reading the witness |
| Unknown/V1 root, unapproved room or foreign owner | Abort globally before full root/student/ledger/rent reads |
| Omit or alter T on one request, cross-use a page token or change a mask | Adapter/contract rejects; no completion or fallback |
| More than 25 records, short nonterminal page, repeated/empty continuation | Complete correctly or abort conservatively; never accept a prefix |
| Expired, unsupported, future or excess-precision time | Refuse or precisely normalize the bootstrap once; never change bound T |
| Bootstrap missing/extra result, incorrect path or absent timestamp | Abort before namespace/money reads |
| Credential expiry, missing IAM evidence or hidden ancestor/group expansion | No admission or immediate abort; no ambient refresh |
| Broadly privileged credential with a get/list-only wrapper | Qualification rejects; wrapper is not permission proof |
| Rules denial with OAuth identity | Never count Rules as the reader's authorization boundary |
| Database identity uncertainty, byte/deadline/clock failure | Abort globally with fixed safe category |
| Child outlives parent during publish, explicit-unlock mutation | Third contender stays excluded; unsafe mutation fails regression |
| Error object contains paths in context/cause/locals | Only fixed diagnostics reach stdout/stderr or summaries |
| Crash after atomic report creation but before receipt | Abort/unconfirmed; file never becomes authority |
| Feed an advisory report to a protected/initialization consumer | Reject distinct schema and always-false flags |

Local fixtures can prove request construction, refusal and race handling. They
cannot establish Google's production historical-read behavior or real effective
IAM. Under a separate fictional staging authorization, use known fixtures and
concurrent writes to demonstrate balance change/restore, create/delete/recreate,
owner/control changes and phantom-parent detection against the real service,
including all pagination and microsecond retention behavior. Qualify the inventory's
request exclusions, scope binding and expiry separately as well.
Run with the intended minimal principal and separately observe effective access;
do not infer minimality from a successful read or risk real writes as a probe.
Staging creation/credential/configuration operations and fixture cleanup need their
own concrete reviewed scope. None is authorized or executed by this document.

## Dependency order and honest stopping point

1. Muse delta review and Claude closure evaluate this corrected blocked design.
   Neither design PASS nor Andrew's selection of a research direction is live approval.
2. Resolve and independently review the feasibility record for every admission
   condition before local implementation. If a condition lacks a qualifying mechanism,
   stop here. This is the present stopping point under the retained standard.
3. Only after feasibility and scoped implementation authority, build the inventory
   and distinct scan adapters, private launcher and complete child/publisher chain,
   incorporating retained Stage13 notes and the acceptance cases; review all changes.
4. Qualify transport, inventory, principal and process/privacy behavior with separately
   authorized fictional staging data; obtain final evidence review before private use.
5. Andrew separately authorizes any canary prerequisite, then the operation-1 inventory
   outside all models. He reviews its restricted scope locally and separately
   authorizes the scan bound to that inventory. These are at least two private-data
   operations with separate evidence and authority, not one scan launch.
6. Only then may Andrew perform that bounded private diagnostic. The full protected
   maintenance operation and server-money cutover remain independent unfinished work.

A consistent snapshot does not waive access/privacy/admin-exclusion gates. With no
qualifying mechanism presently supplied, stop before implementation and keep the
operation unavailable. This proposal does not close the full proof-gap checklist item.
