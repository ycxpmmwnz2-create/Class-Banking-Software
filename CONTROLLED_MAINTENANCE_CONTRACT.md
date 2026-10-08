# Controlled maintenance — accepted operational standard

Andrew accepted this approach on 2026-10-08 after both independent reviews closed.
The exact reviewed proposal is retained in
[APPROVED-PROPOSAL.md](docs/controlled-maintenance/APPROVED-PROPOSAL.md), SHA256
`d662d9379f282a47139eb82debf04e7fe17436149eef82f6ea57a4e1d25c1e99`.
Its references to a pending owner decision describe its frozen review-time status;
this acceptance record supersedes that status only. No live qualification is claimed.

## Scope and precedence

This accepts one maintenance-window operational standard for the existing
`morgan-bank` / `(default)` upgrade. It authorizes bounded implementation and
rehearsal. The six substitutions in proposal section 2 now govern this release:

1. Gap-free continuous history becomes a named change freeze, direct observations,
   completed operations and drift refusal, with invisible changes acknowledged.
2. Absolute arbitrary-Admin exclusion becomes enumerated trusted administrators,
   stopped conflicting jobs and one operator under that freeze.
3. Universal zero-work proof becomes the five conjunctive per-writer R2 predicates,
   actual execution/delivery observations and version-bound reconciliation.
4. Immutable exhaustive reader authority becomes short-lived explicit identity,
   directly inspected relevant policy scope and a known policy freeze.
5. Absolute model-process exclusion becomes the reviewed trusted private operator
   session/host boundary, disabled capture/sync/agent access and privacy checks.
6. D1 global-off/deploy-after-preparation ordering becomes verified client denial,
   then R1 pinned Functions with V2 enabled and exact closed mode, preserving the
   audit consumer through R2–R4. R4 reuses those source bytes with verified mode changes.

These substitutions apply together to PROTECTED_MONEY_SCAN_PLAN.md,
MAINTENANCE_MODE_CONTRACT.md, CLOUD_SCAN_PROOF_DECISION.md,
REAL_DATA_SCAN_FEASIBILITY.md, PRODUCTION_MONEY_CUTOVER_PLAN.md,
CUTOVER_QUALIFICATION.md and D1 in TEACHER_MONEY_INTEGRITY_AND_RECOVERY_DESIGN.md.
They do not silently alter a runtime consumer. Old proof reports and demo adapters
retain their exact schemas, restrictions and false eligibility flags. New operational
evidence must use a distinct schema; an advisory report cannot authorize preparation.

All other contracts remain: tenant boundaries, balances/ledger/credential preservation,
exact receipts, audits and journal recovery, restrictive room dispositions, bounded
resources, no invented history, no replay to resolve uncertainty, forward recovery
after preparation, and the Codex → Muse xhigh → Claude review order.
Secret creation/rotation, live private-data access and cloud actions require their
applicable scoped authority. Acceptance is not proof that any platform gate passed.

## First implementation: local R0 source preparation

The ordinary Firebase selection now pairs `firestore.phase3.money.rules` with
`createNonMoneyTenantDataSaver`. These are the previously combined-test components;
no handler or rule predicate changes. This local selection is not a deployment.
The old final, interim-maintenance and rollback rule artifacts remain byte-identical.

`npm run cutover:prepare` reads only allowlisted tracked public source paths from
this checkout, parses Functions without importing them, hashes the source set,
and emits a local preparation manifest. It does not read dotenv files,
credentials, secret values, private records, runtime environment or deployed state.
It refuses command arguments, symlinks, unsupported export forms and unsafe source
composition. Changed/uncommitted source is identified as a rehearsal candidate,
not a commit-bound release; the final manifest must be regenerated from the exact
reviewed clean commit and bind the separately built assets before scheduling downtime.

The result has no initialization, activation or production authority. The existing
qualification status remains NO-GO. This stage does not implement the private live
adapter, journaled preparation or R1–R5 executor, and does not certify Bundle A complete.

The manifest inventories declared invocation exports and secret **names**, identifies
the exact literal Functions release ID and Node major, and pins client/rule/lockfile
bytes. R0 live inventory must independently enumerate actual generations, unmatched
exports, regions, tags, triggers, queues, schedulers, identities and operator jobs.
Source inventory is never substituted for that live inventory.

## Concrete R0 prerequisites before downtime

- Verify exact project/database identity, clean reviewed commit, build and dependency
  hashes, R1/R4 mode bindings, final strict client/rules and compatible rollback set.
- Privately verify required secret versions and access bindings (creation HMAC key
  ring and Gemini key) before R1. Never log key values. Missing prerequisites stop
  before the window; this stage creates or rotates nothing.
- For every actual writer, bind its supported retirement/supersession action, old
  revision signal and observation coverage, timeout/grace, trigger/retry disposition
  and rollback. Missing supported signals stop that writer; no generic timeout proof.
- For known downstream database requests, qualify the actual request/transaction
  service deadline and reconciliation mechanism. A caller timeout is not a database
  settle point. No assumed universal deadline is implemented in this stage.
- Gemini-only billing/result uncertainty retains the separate R5 Insights gate once
  no execution can mutate protected data. Independently continuing protected writes
  still block R2; caller termination cannot settle them by assertion.
- Qualify private host/identity/IAM, bounded wire masking (including missing parents),
  authenticated rules propagation, full credential/audit reconciliation and journal
  storage. R3 retains the explicit masks/budgets in CUTOVER_QUALIFICATION.md.
- Use fictional fixtures in local/emulator rehearsal. No separate Firebase project
  is created or assumed; a disruptive real-platform test needs its own safe scope.

Known unavailable prerequisites are specific stops. Do not repeat the earlier
universal-proof investigation or silently add optional alternate implementations.
Before/after checks reduce risk but do not guarantee detection or lossless recovery.
