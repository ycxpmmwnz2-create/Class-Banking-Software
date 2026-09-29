# Cloud scan proof decision — Stage14 proposal

Status: correction1 design candidate, September 28, 2026; Muse delta and Claude
closure pending after Claude's F1/F2 findings.
Baseline: `fd6b60e199b68a869408894261e151cfa2daafe8`, branch
`codex/teacher-money-integrity-design`. Andrew requested: "Resolve the proof gap."
Only public official documentation and local source were inspected. No account
policies, credentials, classroom data or deployed state were inspected or changed.

## Decision proposed for review

Do not build the protected scan's live collector by interpreting empty logs,
matching configuration samples or elapsed time as a complete maintenance proof.
The researched APIs do not establish that guarantee. This is a bounded finding
about the mechanisms below, not a claim that no possible Google Cloud architecture
could ever establish a suitable fence.

For the earlier advisory diagnostic, propose one immutable Firestore read time
for the entire allowed dataset. `ADVISORY_SNAPSHOT_SCAN_PLAN.md` defines that
separate operation, its proof obligations and its implementation acceptance cases.
It answers what the allowed data looked like at that time. It does not prove the
database stayed unchanged, audit delivery finished, or maintenance remained closed.

The original protected scan, its full interval-history requirement, all live
refusals and the initialization/cutover gates remain unchanged. This proposal
does not satisfy or waive them. It also does not close the reader's effective-IAM
proof: that still needs actual private evidence and a separately reviewed procedure.
No runtime implementation or new live mode is included in this two-document change.

Correction1 retains the strict evidence standard and moves its feasibility decision
before local implementation. Under the current standard and researched mechanisms,
the operation is expected to remain unlaunchable. The deliverable is a blocked
design direction with a documented consistency basis, not an implementation-ready
solution to the original proof-gap request. Do not build an adapter on the assumption
that later permission evidence will become available.

The scope source is explicitly protected-plan section 1 operation 1, with its
existing canary/control-plane/privacy prerequisites retained. Inventory and scan
are separately authorized private-data operations. A validated restricted inventory,
local scope review and a short-lived digest-bound authorization precede the scan;
the scan still independently revalidates complete scope and ownership at T.

## Separate the claims

| Claim | Evidence needed | Current disposition |
| --- | --- | --- |
| Every included document is from the same database state | The same supported read time on every page/get, complete scope, fixed database identity | Documented platform basis only; feasibility blocks implementation |
| Every permitted classroom and record at that time was examined | Valid inventory provenance plus complete names-only pagination including phantom parents, ownership checks, exact scope, no skipped failures | Acceptance contract specified; implementation blocked on feasibility |
| The reader cannot exercise extra Cloud permissions | Independently verified effective grants, principal and credential binding; restricted transport is an additional control | Still unproven for any real principal |
| All relevant writers stayed fenced and drained through publication | Enforced writer exclusion plus complete, attributable transition/history/drain evidence | No qualifying collector established; protected live scan stays unavailable |
| A report authorizes initialization, correction or activation | Separately reviewed operation, fresh applicable evidence and Andrew's scoped authority | Always false for both advisory and existing rehearsal reports |

Snapshot consistency removes the need to infer quiescence for the advisory
claim alone. It does not turn a data timestamp into a timestamped IAM policy,
an Auth snapshot, a complete history of changes, or a maintenance lease.

The extra concurrent-policy-change and destructive-admin exclusion requirements
remain admission gates for this proposal; fixed-time reads do not establish them.
Before implementation, a reviewed feasibility record must map each admission
condition to a named mechanism with documented coverage, limits and qualification
cases. No qualifying mechanism for the unresolved access/exclusion/privacy gates
is supplied here; that stops work before local implementation. Matching policy or
UID samples cannot silently replace the retained assurance requirement.

A point-in-time access assessment with explicit residual risk is a possible future
contract proposal, not an approved mechanism or proven safe substitute. Claude's
suggested policy reads, dedicated principal and short-lived token are research
leads; before/after observations alone cannot certify unchanged intervening access.
Codex must first make any proposed lower-assurance standard concrete and reviewable,
then obtain both reviews and Andrew's explicit scoped risk acceptance. No relaxed
standard, admin-exclusion waiver or owner risk decision is inferred here.

## Platform evidence and consequences

The references below were read on September 28, 2026. These are platform facts
followed by engineering conclusions; no successful live experiment is implied.

1. [Logging entries.list](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list)
   returns entries and a continuation token. Even an empty page can continue.
   Its response has no documented producer-completeness boundary for all required
   services. Finishing the query cannot certify all earlier events have arrived.
   [LogEntry](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry)
   distinguishes event time and receipt time; neither supplies that missing bound.
2. [Cloud Asset Inventory's consistency model](https://docs.cloud.google.com/asset-inventory/docs/asset-inventory-overview#consistency_model)
   permits indexing delays and dropped, late or out-of-order events. The service
   cautions against real-time enforcement based on possibly stale/missing data.
   Moving the collector to its feeds or history therefore does not close this gap.
3. [Policy Analyzer](https://docs.cloud.google.com/policy-intelligence/docs/policy-analyzer-overview)
   analyzes allow policies in the selected hierarchy; a project-scoped query does
   not include ancestor policies outside that scope. It does not evaluate deny or
   principal access boundary policies and has best-effort freshness. These are
   useful diagnostic results, not a fresh, exhaustive permission certificate.
   A completed query cannot cure omitted scope or stale inputs.
4. [testIamPermissions](https://docs.cloud.google.com/iam/docs/testing-permissions)
   tests requested permissions. A successful get/list probe does not enumerate
   other powers. A finite list of negative probes likewise does not establish the
   absence of every permission, resource grant or impersonation path.
5. [IAM propagation](https://docs.cloud.google.com/iam/docs/access-change-propagation)
   is eventual; policy and group changes have different delays and no fixed safe
   upper wait in the documented estimates. Waiting a selected number of minutes
   after a revocation is not proof that old authority disappeared everywhere.
6. [Credential Access Boundaries](https://docs.cloud.google.com/iam/docs/downscoping-short-lived-credentials)
   are supported for Cloud Storage, not Firestore. Do not propose a Firestore
   downscoped token with a guaranteed get/list-only capability on that basis.
7. [IAM deny support](https://docs.cloud.google.com/iam/docs/deny-permissions-support)
   includes Firestore entity writes. A deny policy may help an eventual engineered
   fence, but is itself a control-plane change with scope, exceptions and propagation
   to prove. It does not establish queue drain or continuous policy enforcement.
   Blanket create denial would also conflict with the required audit exception;
   exempting an audit principal does not by itself constrain that principal to
   the audited document paths. No deny policy is proposed or installed here.
8. [Function retries](https://docs.cloud.google.com/run/docs/tips/function-retries)
   depend on event delivery/retry configuration, including associated subscriptions.
   Current serving revision and traffic settings alone do not prove pending work
   finished. Audit work that has not committed by a snapshot time remains outside
   that snapshot, even if it originated from an earlier money change.
9. Firestore's [database contract](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases)
   describes historical reads within its version-retention period and exposes a
   database UID. [ListDocuments](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/list)
   and [GetDocument](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/get)
   support an explicit `readTime`. Using one time for all input operations supplies
   a different consistency basis from repeatedly reading the current state.
10. [BatchGetDocuments](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/batchGet)
    returns read-time metadata. A single masked, approved root request can supply
    a server time before snapshot enumeration. This is a read-only POST, not a
    write batch or transaction. Its exact handling needs implementation and staging
    verification; a Document's update time is not an equivalent source of read time.
11. [Firestore method permissions](https://docs.cloud.google.com/firestore/native/docs/security/iam)
    distinguish document get/list from database metadata and transaction access.
    `batchGet`/`get` require entity get; `list` requires entity get and list.
    The two data permissions do not imply absence of other grants. Keep database
    metadata observation outside the data principal rather than granting it more
    access to make an observer convenient.
12. [Firestore REST authentication](https://docs.cloud.google.com/firestore/native/docs/use-rest-api)
    uses IAM for a service-account OAuth token and Rules for Firebase ID tokens.
    Denying client writes in Rules does not constrain the proposed OAuth reader.

## Rejected shortcuts and retained release work

No flags named fence-verified, permissions-verified or equivalent attestations
may bypass missing evidence. Operator identity, a digest, a model verdict and a
generated JSON record do not prove platform state. No monitor is complete merely
because its page tokens ended; no inventory is complete merely because no error
was returned. No live destructive probe is authorized to test negative permissions.

A read-only transaction is not a general replacement for this 15-minute scan:
the [transaction limits](https://docs.cloud.google.com/firestore/native/docs/manage-data/transactions)
include 270 seconds and an idle expiry. Its read-only property also does not
downscope the credential used outside that transaction. Exporting or cloning a
database would introduce separate operations, access and private-data copies;
neither is an automatic fallback or implemented by this proposal.

For the eventual protected maintenance operation, a new proposal must identify
the enforcement mechanism, every client/server/background/admin writer, the audit
exception, already-admitted work, credential propagation, concurrent operator
exclusion and the exact evidence covering the required interval. If adopting a
different guarantee, explicitly revise the relevant design/maintenance/scan
contracts through Muse and Claude and obtain Andrew's scoped decision. Do not
incrementally weaken the observer until fictional evidence becomes acceptable.

## Authority, review and completion criteria

Andrew's request authorizes this investigation and concrete proposal. The earlier
official-documentation exception covers the research; it does not extend to
reviewer browsing, Cloud account access, credentials or live data operations.

Muse reviews the technical feasibility, contradictions and acceptance requirements
of these two documents. Claude then independently reviews the full proposal.
Both must distinguish design soundness from implemented/live proof. They may
reject the alternative without weakening the existing protected-scan requirements.

After those reviews, Andrew can select a research direction. Under the retained
standard this operation stays blocked before implementation until the admission
mechanisms pass the separate feasibility review. Any future implementation authority,
private credential/IAM qualification, fictional staging proof, process/privacy
integration and final reviews remain distinct from live authorization. Actual use
would require the separately authorized scope inventory and the subsequent scan;
the scan cannot invent its own list or promote output from an aborted run.

Acceptance may close the bounded documentation investigation and design-review item,
not the unresolved implementation-feasibility gate.
Keep the full Cloud fence, effective-IAM, private-launcher and live-readiness items
open until each has its own evidence. At this baseline the full proof gap remains
open; the deliverable is a blocked design direction and explicit rejection of the
unsupported collector approach, not a clean bill of health or readiness to build.
