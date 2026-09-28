# Protected scan maintenance observer — Stage12 rehearsal

Status: Stage12 rehearsal passed Muse and Claude review (2026-09-28).
Baseline: `c80a83f9e4217e3121e0b7136def0506236bf178`, the reviewed Stage11 scanner.
This implements the observer's evidence validation, interval lifecycle and scanner
composition using a fictional collector. It does not implement Cloud collectors,
a production credential, an OS/process lock, or a private live operator launcher.
No live check or maintenance operation can be enabled by supplying these records.

## Entry point and trust boundary

`runObservedMoneyScan` constructs `createMaintenanceObserver`; it accepts reader,
publisher, fictional collector and clocks, never a caller-provided observer or
`maintenanceVerified` flag. The original scanner core remains demo-only and its
Stage11 tests remain. The new composition checks observer continuity before every
data-reader invocation and closes observer admission in every completion path.

Both entry points validate the existing exact scan plan and reject any project
other than `demo-morgan-bank-protected-scan` before accessing dependencies. The
default database is the only supported target. No ambient credentials, SDK setup,
network destination, control-plane mutation, Auth or provider operation is added.
The deployed import-graph exclusion covers this entire operator directory.

The collector and its lease are trusted JavaScript capabilities, not a sandbox
against malicious dependencies. A digest binds supplied records; it cannot prove
that the records describe a real platform, permissions, reviewed checkout, or
Andrew's approval. `maintenanceFixtures.js` is a fictional platform model, with
an in-process exclusive lease, consumed run IDs, monotonic per-surface sequences
and callbacks for injecting failure. Its writer rows represent categories, not
an enumeration of deployed Functions. Its canary outcomes, IAM/recovery hashes,
credential results, audit outcomes and completeness boundaries are simulated.

## Evidence checked before any data read

The immutable expectation binds the whole scan plan (including scope, run, source
commit and time window), collector identity, maintenance start, all surface cursors,
reviewed artifact hashes, sorted writer inventory, prior rules hash and expected
audit-version digests. Missing/extra fields or foreign bindings fail closed.
The audit inventory must contain 1–10,000 distinct sorted digests. An empty
inventory is unsupported and fails as `authorization` before collector opening,
even when paired with empty outcomes. A real transition could legitimately admit
no student versions, but this rehearsal has no separate proof of that condition.
Nonemptiness is only a minimum input requirement; completeness of even a nonempty
inventory still depends on the trusted fictional source and proves no live coverage.
Neither a fabricated version nor a fabricated outcome can establish live evidence.

Both entry points reject missing, null, non-object or array dependency containers
with bounded `authorization` errors. The composition also validates the original
reader identity and both methods before wrapping it or opening the collector.
These are input checks, not isolation from hostile JavaScript capabilities.

The observer requires an exact matching snapshot with:

- expected rules, serving-revision, runtime, trigger, IAM, recovery and credential-
  verifier artifact digests;
- global V2 enabled, exact maintenance `closed`, profile-sync and legacy admission
  closed; global-off and `verification` do not satisfy the scan contract;
- exactly the pinned writer inventory, zero in-flight/queued/retrying work and a
  drain-evidence reference for every writer;
- the named `recordStudentBalanceHistoryV3` trigger admitted only for create-only
  balance-history writes, with all other pinned writers closed;
- credential-consistency evidence after drain and before accepted maintenance;
- one terminal outcome per expected audit version: recorded or an explicitly
  reconciled historical gap. Pending/retrying/unknown/missing outcomes block;
- declared frozen canary scope and paired prior-success/maintenance-denial evidence
  for SDK, REST, batch and transaction probes. Each pair binds the same request,
  identity and fixture; denial must leave the probe state unchanged.

These validations reject contradictory/incomplete fixture evidence. They do not
execute live denial probes, inspect actual queues, or prove effective IAM. The
existing emulator canary tests retain their narrower, independently stated scope.
No original record or credential value is read to validate these metadata fields.

## Complete interval and publication lifecycle

Required surfaces are audit, canary, credentials, IAM, operators, revisions,
rules, triggers and writers. Every surface needs matching start/end cursors and
exact time coverage from accepted maintenance through the requested boundary.
Missing, duplicate, delayed, foreign or non-empty history fails. Matching endpoint
state alone is insufficient: any advancing sequence, including reopen/reclose,
invalidates the run. Snapshot evidence is also frozen across observations.

The observer checks entry history before data reads, checks again after the final
scan revalidation, immediately before publication, and after durable acknowledgement.
It binds the scan evidence digest and completion boundary to the exit record.
The collector's lease must remain held throughout; invalidation prevents the next
data request. A conforming collector must make lease continuity checks authoritative
for its own modeled state even when notifications are delayed. The fixture compares
its current epoch/cursors directly; silent changes cannot hide behind an older
history request. No such real-platform capability is assumed to exist.

The state machine accepts one begin, one finish and one publication hold. A second
hold cannot publish again. Closing a run synchronously closes admission. If opening
or publishing timed out, the observer retains the cooperative lease until that
outstanding operation settles, then releases it. Never-settling work keeps it held;
there is no force-unlock, fixed-sleep drain, auto-resume or recovery command.
This is an in-process fixture lease, not cross-process exclusion or a Cloud fence.

Failure before publication remains `not-attempted`. Failure after publication begins
is `unconfirmed`, even if a private report exists. Release failure also prevents a
completion result. No artifact becomes accepted; all Stage11 false flags remain.
Neither cleanup nor release changes maintenance configuration or classroom data.

## Verification and remaining gates

Use the existing `test:phase3:unit`, `test:phase3:contracts`,
`test:phase3:protected-money-scan`, root lint and Functions lint commands. New
tests exercise entry refusals, all interval surfaces, asynchronous invalidation,
silent changes, loss during publication, opening/publication timeout, stale/foreign
evidence, consumed IDs and overlapping runs. The emulator adds the actual loopback
reader and private filesystem publisher to this observer; its control-plane source
remains fictional. Existing Stage11 private-storage and scanner tests still apply.
Evidence counts and runtime belong to the frozen review packet, not this contract.

Still required before live use: independently verified platform collectors and
complete history semantics for every surface; complete deployed/old-writer inventory
and bounded drain; actual effective IAM and credential verification; a cross-process
and external maintenance/recovery exclusion mechanism; complete canary lifecycle;
private Terminal.app procedure and independently established agent privacy boundary;
reviewed source/runtime binding, Node22 validation, live baseline/recovery artifacts,
and Andrew's separately scoped operation approvals. If a platform cannot provide
the required completeness/fence proof, the live scan stays unavailable. There is no
manual override. Stage12 does not close those gates or the broader integrity upgrade.
