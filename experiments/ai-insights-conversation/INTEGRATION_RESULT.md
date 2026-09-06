# Isolated integration result

September 6, 2026 — implementation-agent verification complete for the bounded local test. No production integration or release approval is claimed.

The experiment composes the real structured assistant, tool question service, cost policy, and Firestore usage-ledger implementation with fictional evidence and an in-memory Firestore transaction double. Teacher resolution/evidence loading are injected test dependencies, so this does not establish live Firebase authentication/App Check or deployed behavior. Production files, settings and banking data are unchanged.

## Real Gemini path

Three cases used the real Gemini transport for both planning/selection and narration, one transport attempt per call. Each used two planner turns plus one narration call:

- Unique extremes: Fable $30 approved additions; Quill no approved additions. Narration matched.
- Ties: Fable and Orbit $30 each; Pixel and Quill $5 each. Narration preserved all ties.
- Partial history: no full-week extrema asserted; an explicit coverage warning is visible in the calculated result and narration.

Each exact request/body was then repeated against the real service/ledger composition: identical preview, zero additional provider calls, zero additional ledger charge and zero additional ledger writes. No snapshot/fixture mutation occurred; writes were to in-memory usage collections only. Accounted new cost: USD 0.043296. Original cumulative experiment spend: USD 1.016789 of USD 2.

Full saved evidence: /private/tmp/morgan-bank-isolated-integration-20260906/run-once/report.json. Exact provider-run source is preserved under provider-run-source. After these calls, a local-only correction bound budget-refusal replay fallback to exact equality with the existing closed deterministic renderer; the budget-refusal test now repeats the same request. This is not an English/prose validator. The corrected source passed local tests, but that specific budget-refusal path was not exercised against a live provider (it makes no narrator call).

## Local checks

- 13 integrated tests pass: real service/ledger replay, zero-earners/ties, explicit partial-history warning, malformed/truncated/timeout/unknown-usage fallback, narration budget refusal/replay, wrong selected scope, two-tenant separation, stale evidence refusal, concurrent request suppression, and separate unverified prose.
- 20 existing question-service, Firestore ledger, and live-composition tests pass.
- ESLint for all experiment modules and git diff --check pass. Existing runtime/client/config files are unchanged.
- Browser check at http://127.0.0.1:8766/: scenario selection, Next example, calculation-only toggle, calculation details, incomplete-history case and simulated timeout all display correctly. Screenshot inspected. These controls browse saved responses; they do not perform live provider calls. Dynamic content is assembled using text nodes and a restricted bold-text renderer; arbitrary model HTML is not interpreted by source design. No full browser attack corpus or performance benchmark is claimed.

## Boundaries still requiring review

This is a four-fictional-student, explicit-date comparison test, with an eight-current-student maximum in the prototype. It is not the full classroom rollout, free-form question corpus, timezone/DST implementation, or Firebase emulator/deployment proof. No AI explanation is promoted to the existing structured production answer; it stays a separately labelled draft beside calculated facts.

Separate base/narration reservations consume two hourly quota slots. Production should use a reviewed combined reservation rather than silently changing that allowance. Unknown narration usage is conservatively charged at the reservation ceiling and labelled reserved-unknown in the experimental saved record; that is not a measured provider invoice. A process interrupted before narration starts keeps a fallback on replay; it does not start fresh narration. Save-failure fallback and ledger-unavailability recovery need deeper review before deployment.

The test deliberately demonstrates that fluent false prose can still be returned as an unverified draft. The correct calculated summary remains separate and visible. Do not represent these small samples, syntax checks, or name/number checks as a general guarantee of semantic correctness.
