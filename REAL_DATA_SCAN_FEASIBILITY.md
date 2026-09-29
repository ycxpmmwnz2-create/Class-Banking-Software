# Real-data scanner feasibility — Stage15

Status: Codex assessment for independent review; Muse and Claude pending.
September 28, 2026 (America/Denver). Baseline:
`d6e371b276908bc7a2e9f0d4baa8837d69e064aa`.

## Decision

**NO-GO for implementing the Stage14 advisory scanner under its retained requirements.**
The researched mechanisms do not supply the required continuous access boundary or
destructive-admin exclusion. This is a bounded engineering decision about the
current design and evidence, not a proof that all possible Cloud architectures are
incapable of satisfying them. Actual Morgan Bank policies and operator equipment
were not inspected. No production vulnerability or current misconfiguration is
inferred from that lack of evidence.

There is a documented basis for fixed-time reads, and credible local design paths
for inventory provenance and process coordination. Those partial results do not
satisfy the combined admission gate. Do not start the inventory adapter, scan
adapter or private launcher on the assumption that the Cloud proof will follow.

This assessment adds no runtime, permission, role, feature flag, contract waiver or
live operation. Stage14's two reviewed documents and the protected scan contracts
remain unchanged. A PASS on this assessment would validate the analysis and stop
decision, not approve implementation or establish live safety.

## Scope and evidence meanings

Andrew asked to establish feasibility before implementation. Research used public
official Google Cloud/Firebase documentation under his existing exception, plus
local source and reviewed contracts. No authenticated Cloud request, credential,
private record, console inspection, installation or configuration change occurred.

- **Documented basis:** a service contract supports part of the design; target
  configuration, implementation and fictional service qualification still follow.
- **Conditional local design:** an engineering approach exists, conditional on a
  trusted host and reviewed code; no implementation or qualification is claimed.
- **Unresolved blocker:** no mechanism with the required coverage is established.
  Reject admission; a schema, acknowledgment, digest or passing fixture cannot fix it.

## Admission coverage

References below point to the unchanged Stage14 plan and the source register at
the end. Every row remains subject to its original limits and approval gates.

| Required safeguard | Mechanism assessed and finding | Qualification or failure boundary |
| --- | --- | --- |
| Exact effective reader powers before any request, including inventory metadata | Dedicated get/list-only custom role, database condition, explicit short-lived service-account token, separate policy observer. Documented building blocks, but **unresolved blocker** for exhaustive effective access and its continuity. S1–S9. | Unknown ancestors, groups, conditions, external grants, delegation or token provenance refuse admission. Successful reads cannot certify absence of extra powers. |
| Permission boundary throughout the run | IAM deny, Principal Access Boundary (PAB), token scopes/lifetime, policy sampling and history were assessed. **Unresolved blocker**: no qualified interval boundary for all relevant changes. | A grant/change/reversal between samples must not pass. No polling frequency or quiet-period timer supplies missing completeness. |
| Destructive database/admin exclusion | Delete protection plus policy restrictions and separate UID observations are useful controls, but **unresolved blocker** under the retained exclusion requirement. S10–S11. | Do not admit because delete protection is on or UIDs match. Missing control over administrators and the controls they can change is blocking. |
| No model access to private execution, credentials or output | **Conditional local design** on a separately established agent-free operator host; a Terminal window on the current shared account does not establish it. | Host/OS trust, remote access, screen capture, sync, ACLs and all process lifetimes need an independently reviewed procedure and fictional qualification. No current host is certified. |
| Authentic inventory and separate scan authority | **Conditional local design:** one private supervisor retains the completed inventory and accepts a distinct local scope approval; no inventory-file import. See provenance design below. | Prevent fabrication/replay at the process boundary; this does not prove that Cloud evidence inside an inventory is true or complete. Blocked on preceding rows. |
| Exact target, principal, source and runtime | Pin project/database, independently observed UID, reviewed clean source/dependencies/runtime; privately bind credential issuance to principal and expiry. | S5 supplies an issuance response, not a permission certificate. Reject ambient credentials and unknown identity. This chain is not implemented. |
| Complete inventory and ownership | Reuse protected-plan section 1 operation 1, including control-plane inventory and prior separately authorized fictional canary setup; later re-enumerate scope/owners at T. | Names/masked roots only during inventory; no students, transactions or rent. Unknown/V1 roots, phantom parents or reciprocal-owner failures stop globally. Current inventory feasibility inherits Cloud/privacy blockers. |
| One historical data state | Same supported readTime on every subsequent list/get after a single masked bootstrap. **Documented basis**, S12–S14. | Qualify pagination, create/delete/recreate, change/restore, ownership and precision in fictional staging. Local mocks cannot establish service semantics. |
| Bounded transport and data minimization | Fixed origin/target, narrow GET plus bootstrap POST interface, exact masks/paths, strict errors and budgets: **conditional local design**. | No generic requests, credentials/Auth/history reads, redirects, ambient refresh, current-read fallback or partial successful report. Wrapper restrictions do not downscope a stolen bearer token. |
| Full process and publication lease | Stage13's same-host fixed-directory descriptor lease is implemented as a component. Complete private supervisor/worker/publisher chain remains **conditional local design**. | Every surviving child retains the descriptor; never explicit unlock. Crash, swapped inode, same-user adversary, remote operator and unacknowledged publication retain the documented limitations. |
| Expiry and availability | Monotonic plus absolute expiry checks and hard budgets are locally implementable. S5, S12 and original plan limits. | Inventory valid no more than 30 minutes after completion, through publication; scan at most 15 minutes. Human-review time and actual throughput are not qualified. No extensions. |
| Output authority and protected-operation separation | Distinct advisory schema; fixed project totals/categories; all four authority flags false; private durable report only: **conditional local design**. | No protected receipt, activation/initialization authority, automated upload or claim of present-day health. Full protected maintenance/history/drain proof remains independently unresolved. |

## Access: useful controls do not establish the required certificate

A minimal role is technically expressible. Firestore documents entity get/list
for the relevant read methods and separate permissions for writes and metadata.
It also supports database access conditions. The configured role is only one
input to effective access; another applicable grant can add authority. S1–S2.

Policy Troubleshooter improves on allow-only Policy Analyzer: it considers
allow/deny/PAB policies for a specified principal/resource/permission. It still
depends on policy, role and membership visibility and can return unknown results.
It does not enumerate and freeze every possible capability of a credential.
Policy Analyzer additionally has limited scope and best-effort freshness. S3–S4.
This assessment does not conflate those two products or require an allow-only
tool to evaluate deny policies.

Token issuance can bind the service-account target, requested scope and expiry
inside a trusted private credential broker. A token's lifetime is not an immutable
permission set. Both Firestore get and patch accept the datastore OAuth scope;
choosing that scope cannot alone enforce get/list-only capability. Credential
Access Boundaries document downscoping for Cloud Storage, not Firestore. S5–S7.

PAB controls resource eligibility for supported permissions; it does not select
only reads on an eligible resource. Current enforcement documentation does include
Firestore permissions, so lack of Firestore support is not the reason for rejecting
PAB as a complete answer. Its administration, coverage and other relevant policies
would still need qualification. IAM deny can block supported permissions despite
allow grants, but its policies are mutable and propagation remains relevant. S8–S9.

The Firestore IAM page describes a five-minute permission cache. General IAM
documentation also describes longer possible propagation, particularly for group
changes. Neither statement documents an atomic snapshot of every applicable
policy or a full-run administrative lock. A five-minute sleep is not such a proof.
This reconciles the narrower cache statement instead of claiming it does not exist.
S1, S9.

**Counterexample to sample-based admission:** the entry observation shows only
reads; a separate administrator changes an applicable policy or role; some requests
can encounter changed authority before later observations or propagation catch up.
Restoring visible configuration does not certify which authority applied throughout.
This is a reasoning case, not an observed Morgan Bank incident or executed test.
The retained guarantee needs a proven enforcement/completeness boundary, not just
a reader that chooses not to exploit the extra permission.

An organization-wide administrative freeze could be a separate architecture
research direction. No complete design for its controllers, exceptions, inherited
authority, propagation, recovery or already-admitted operations is supplied here.
Calling an administrator trusted or scheduling a change window would change the
assurance assumption; it does not satisfy the present gate without review.

## Database administration: protection is not immutable exclusion

Delete protection blocks deletion while enabled, but an authorized administrator
can disable it. IAM documents distinct database update/delete capabilities. These
are helpful controls, not a finite-time proof that every relevant administrative
action was excluded. A UID observation checks identity at that observation; it
does not certify no configuration transition occurred between observations. S1, S10.

The assessment does not assert that database delete/recreate can preserve its UID,
nor that historical reads necessarily return a mixed dataset after deletion.
Those assertions are unnecessary: Stage14 expressly retained administrative
exclusion as an additional gate. Replacing exclusion with abort-on-service-error
and UID checks would be a contract change, not implementation of the accepted one.

Empty logs and completed pagination do not add the missing interval guarantee.
The researched Logging response has entries/tokens but no stated cross-service
producer-completeness certificate. Asset Inventory documents consistency limits.
These remain monitoring inputs, not a substitute for enforcement. S11.

## Private execution and inventory provenance: conditional design paths

Stage13's own documented limits rule out treating owner-only file modes or flock
as proof against another same-user process or screen access. A credible route is
a dedicated operator machine without installed/running model tools or remote agent
access, private nonsynced storage, controlled software/runtime, and independently
established screen/remote-access and credential-handling controls. This is a design
assumption requiring a concrete OS-specific procedure, not a finding that Andrew
owns such a machine or that a launcher can detect every observer. A second Terminal
window or VM controlled by an agent-visible host is not automatically equivalent.
No equipment purchase or machine reconfiguration is proposed or authorized here.

A candidate provenance mechanism avoids trusting a hand-written or edited file:

1. The reviewed private supervisor starts a new nonresumable session under the
   fixed lease. It verifies its source/runtime and requires separate inventory
   authority and all underlying admission evidence before starting operation 1.
2. Only its reviewed producer may transition the in-memory inventory state from
   collecting to completed. Failure destroys eligibility; a saved partial record
   cannot be re-imported. No public setter can mark supplied bytes completed.
3. The completed immutable record binds a fresh session/inventory identifier,
   target and UID, canonical sorted unique classroom/owner tuples, suspended-scope
   limits, operation-1 evidence references, producer/source/runtime identity,
   completion clocks and absolute expiry. The inventory digest binds those bytes.
4. A separate local approval screen displays scope from that same immutable object.
   Andrew approves only the scope. The supervisor constructs a separate one-use
   scan-authorization object bound to the exact inventory, target, list, reviewed
   scan identity, issue/start/expiry bounds and private output/lease scope. Andrew
   does not certify IAM, provenance or Cloud correctness by pressing approve.
5. Scan admission accepts only this supervisor's retained completed object and its
   distinct approval state, never an imported file, digest alone or caller-created
   lookalike. Private workers receive bounded data through supervisor-created
   channels. Abort, lost supervisor, restart, expiry or consumed authorization
   prevents reuse; new operations need fresh separate authority. Surviving children
   still retain the lease until settled, without publishing an accepted report.

This is process-origin authenticity conditional on reviewed code and OS isolation,
not protection against a compromised supervisor/root user and not cryptographic
attestation of Cloud truth. The disk record is retained evidence, never an input
that can manufacture authorization. An independent-process or portable-file design
would need its own authenticated trust anchor, replay state and review; adding a
signature to arbitrary bytes would not establish truthful inventory collection.

Fictional qualification must separately reject: fabricated object/file; copied
completed record from another session; partial/aborted inventory; changed target,
UID, owner list, source or expiry; absent/replayed approval; modified display versus
approved object; expiry during publication; supervisor crash with surviving worker;
and private fields in exception context, logs or summaries. Successful provenance
tests cannot make unresolved Cloud evidence valid. No such tests were run here.

## Practical time and prerequisite costs

Operation 1 still requires the separately authorized canary setup and control-plane
inventory. Reusing its name does not waive either. Provisioning or slow evidence
collection must not be hidden inside a supposedly immediate scan launch.

Let R be time from inventory completion through local scope review and scan start,
S the scan duration, and P any remaining publication time. Acceptance needs
R + S + P within the inventory's 30-minute validity, all other authorizations and
credential expiries, and the scan's own 15-minute deadline. Count publication inside
S if that is how the final implementation defines it; never omit it or count it
as extra authorized time. No current timing measurements establish those bounds.

The record/byte/request limits are refusal budgets, not promises that the largest
allowed dataset can finish. Fictional maximum-size, slow-response and delayed-local-
approval cases must demonstrate completion or timely global refusal. A deadline
can safely stop a run even when useful availability is poor. Repeated timeout is
not permission to extend expiry or skip records.

## What would change this decision

There are two honest paths, neither selected or authorized by this assessment:

1. Supply a concrete stronger enforcement architecture with complete scope,
   control over its controllers, propagation and interval evidence. Subject it to
   feasibility review before implementing this advisory operation. Opening account
   access might reveal configuration, but does not by itself create the missing
   platform guarantee; no credential access is needed to reach this no-go decision.
2. Separately propose a narrower advisory assurance contract: point-in-time access
   assessment, specified trusted administrators, explicit residual concurrent-change
   risk and concrete compensating controls. Name the powers/actors left outside
   exclusion, consequences for credentials/data/reports, limits and abort behavior.
   Review that proposal with Muse and Claude before asking Andrew to accept the
   specific risk. No such relaxation, acceptance or ready-to-build alternative is
   supplied here. Private execution and authentic scope remain required.

Continue unrelated authorized integrity work without calling this scanner ready.
The stricter protected maintenance/history/drain operation and eventual server-money
cutover have their own unchanged requirements. This advisory feasibility assessment
does not prohibit their separately authorized research or waive any of their gates.

## Source register — read September 28, 2026 local time

Public documentation is supplied evidence for reviewers, not proof of Morgan Bank
configuration. The packet adds short source observations and URLs; reviewers are
not authorized to browse or execute Cloud checks. Engineering inferences above are
Codex's and are open to independent challenge.

- S1: [Firestore method permissions, custom roles and role-change latency](https://docs.cloud.google.com/firestore/native/docs/security/iam).
- S2: [IAM policy types and evaluation](https://docs.cloud.google.com/iam/docs/policy-types).
- S3: [Policy Troubleshooter inputs and visibility limits](https://docs.cloud.google.com/policy-intelligence/docs/troubleshoot-access).
- S4: [Policy Analyzer scope, policy types and freshness](https://docs.cloud.google.com/policy-intelligence/docs/policy-analyzer-overview).
- S5: [GenerateAccessToken target, scope and expiry](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken).
- S6: [GetDocument authorization scopes](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/get) and [PatchDocument authorization scopes](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/patch).
- S7: [Credential Access Boundaries for Cloud Storage](https://docs.cloud.google.com/iam/docs/create-downscoped-short-lived-credentials).
- S8: [PAB policy semantics](https://docs.cloud.google.com/iam/docs/principal-access-boundary-policies) and [enforcement permission versions](https://docs.cloud.google.com/iam/docs/pab-blocked-permissions).
- S9: [Deny policy semantics](https://docs.cloud.google.com/iam/docs/deny-overview), [deny-policy deletion](https://docs.cloud.google.com/iam/docs/reference/rest/v2/policies/delete), and [access propagation](https://docs.cloud.google.com/iam/docs/access-change-propagation).
- S10: [Firestore Native database delete protection](https://docs.cloud.google.com/firestore/native/docs/manage-databases).
- S11: [Logging entries.list response](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list) and [Asset Inventory consistency](https://docs.cloud.google.com/asset-inventory/docs/asset-inventory-overview#consistency_model).
- S12: [GetDocument readTime](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/get).
- S13: [ListDocuments readTime, masks, missing parents and pagination](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/list).
- S14: [BatchGetDocuments read-time metadata](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/batchGet).

## Verification and review status

This is a documentation-only assessment. No runtime tests or Cloud experiments were
run, and no existing runtime results are represented as new evidence. Codex checks
the document against the admission rows, retained review notes, exact baseline and
frozen packet identity. Independent Muse review comes next; Claude follows after
that cycle closes. Both reviews and any later commit remain pending.
