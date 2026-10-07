# Cleanup Checkpoints

Cleanup checkpoints require review; they do not authorize automatic code deletion.

## October 1, 2026 current cleanup candidate

Andrew authorized connecting and testing the existing V2 Quick Cash/custom
Add/Subtract buttons, and requested a detailed Muse review of the result. This
uncommitted candidate connects planned server saves, durable status/cancellation,
explicit receipt acknowledgment, and new-classroom metadata. It also removes
five proven-unused functions and four unused consumer imports from `index.html`.
Public module exports and legacy rollback paths are retained. The dead-code-only
intermediate build was byte-identical for both V2-off and V2-on artifacts.

The branch comparison found no missing runtime work in
`codex/ai-insights-canary-diagnostic-v3`; its unique work was incorporated or
superseded. The useful cleanup from `feature/multi-teacher` is applied here.
Its separate developer sandbox-runner experiment is optional tooling, not a
missing website function or a required cherry-pick. Neither old branch was
merged or deleted. Detailed comparison evidence is preserved outside the repo.

Local tests are supplied evidence for Muse, followed by independent Claude final
review. Commit, push and release authority remain separate. This candidate does
not close the real-data scanner NO-GO, existing-classroom initialization, other
money writers/rules, actual release acceptance, or all stabilization checkpoints.

## Checkpoint 1 — After Phase 2A

- Audit migration tooling, scripts, documentation, and test commands.
- Fix narrow tooling and documentation issues.
- Do not remove migration manifests, rehearsal tools, recovery logic, or compatibility code that may still be needed for cutover or rollback.

## Checkpoint 2 — After multi-classroom cutover and rollback window

- Identify obsolete single-classroom code and hardcoded `morgan` assumptions.
- Remove legacy paths only after acceptance tests prove the new paths work.
- Confirm nothing still depends on compatibility or rollback code.
- Audit stale diagnostic and migration scripts, Firestore paths, configuration, and documentation.

## Checkpoint 3 — Final stabilization

- Audit dead code and unused dependencies.
- Audit credentials, logging, and secret exposure.
- Review Firestore rules and classroom isolation.
- Review test duplication and coverage.
- Review performance and bundle size.
- Clean up documentation and operational runbooks.
- Run final repository-wide lint, build, unit tests, and emulator tests.

## Open verification follow-ups

### Phase 2B server-emulator cleanup latency

- Phase 2B Item 11 and the later Phase 3 Item 11 matrix completed without this
  becoming a correctness failure; keep it as a performance follow-up only.
- In `tests/phase2b/functions-auth.emulator.test.js`, the negative V2 sync
  cases for a disabled teacher and an inconsistent reciprocal ownership link
  each take roughly 60–70 seconds while the Firestore emulator releases a
  transaction lock after the deliberately rejected trigger is terminated.
- This is currently a performance nuisance, not a correctness failure: the
  complete server suite passed repeatedly with 9 gate-off and 60 gate-on
  tests.
- Tighten the cleanup only if the suite becomes flaky or exceeds the CI time
  budget. Preserve the real-trigger denial assertions, bounded cleanup, and
  fail-closed behavior; do not replace them with sleeps, skipped cleanup, or
  unit-only mocks merely to shorten the run.

## Cleanup method

- Inventory first.
- Prove code is unreachable or obsolete before deleting it.
- Preserve migration and rollback capabilities until their window closes.
- Use small, purpose-specific, reversible commits.
- Run proportionate regression and emulator tests after each removal.
- Use Codex implementation, Muse Spark detailed checking, and Claude final
  independent 100-foot review under `AI_COLLABORATION_WORKFLOW.md` and
  `GROK_REVIEW_HANDOFF.md` for material cleanup.
- Treat a cleanup checkpoint as a review requirement, not authorization to delete code automatically.
