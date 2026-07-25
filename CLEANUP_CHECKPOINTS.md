# Cleanup Checkpoints

Cleanup checkpoints require review; they do not authorize automatic code deletion.

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

- Revisit during Phase 2B Item 11 readiness verification.
- In `tests/phase2b/functions-auth.emulator.test.js`, the negative V2 sync
  cases for a disabled teacher and an inconsistent reciprocal ownership link
  each take roughly 60–70 seconds while the Firestore emulator releases a
  transaction lock after the deliberately rejected trigger is terminated.
- This is currently a performance nuisance, not a correctness failure: the
  complete server suite passed repeatedly with 9 gate-off and 56 gate-on
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
- Use the Sol → Gemini → Claude review workflow for material cleanup.
- Treat a cleanup checkpoint as a review requirement, not authorization to delete code automatically.
