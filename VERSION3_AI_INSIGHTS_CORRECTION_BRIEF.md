# Morgan Bank Version 3 — AI Insights correction brief

## Authority and baseline

- Authorized by Andrew on August 19, 2026 as an isolated local correction pass.
- Product decision: the 7,500,000 micro-USD Gemini allowance is one
  application-wide monthly cap, not a per-teacher or per-classroom allowance.
- Baseline: live `origin/feature/multi-teacher` commit
  `74c905ca792aec9cd3e5cec36ca1c5b3a58aaba2`.
- Worktree: detached and isolated from the dirty ordinary checkout.
- This pass authorizes local edits and verification only. Commit, branch, push,
  pull request, merge, real provider or Firebase access, App Check, secrets,
  billing, staging, production, and deployment remain separate gates.

## Objective

Close the two audit blockers without changing the normal application or any
legacy/V2 Function:

1. serialize every tenant's worst-case reservation through one monthly
   application ledger while retaining tenant-scoped hourly limits,
   idempotency, replay binding, and de-identified persistence; and
2. remove `analyzeTeacherInsightsV3` from the default deployable Functions
   entrypoint and package, while retaining exact-demo-project Auth, Functions,
   and Firestore emulator acceptance through a dedicated non-deployable test
   entrypoint.

Correct the stale Checkpoint B status without claiming review evidence that the
repository and GitHub record do not establish.

## Security and compatibility invariants

- A reservation for any tenant consumes the same 7,500,000 micro-USD monthly
  application cap before the fake provider starts.
- Concurrent cross-tenant reservations cannot exceed that cap.
- Quick/Deep rolling hourly limits remain scoped to the validated teacher and
  classroom and carry correctly across a UTC month boundary.
- Request identity, evidence-signature replay binding, uncertain reservation
  retention, downward reconciliation, and exact-schema validation remain
  fail-closed.
- Persisted documents contain only digests, bounded metadata, validated replay
  artifacts, and usage values; no teacher/classroom/request identifier,
  classroom fact, prompt, raw provider response, or display observation is
  added.
- The default `firebase.json` Functions source discovers all existing legacy
  and V2 exports but cannot discover or package `analyzeTeacherInsightsV3`.
- The dedicated emulator entrypoint refuses discovery outside the Functions
  emulator and retains the existing runtime guard before Firebase handles.
- Normal development/production builds and the default-off browser boundary do
  not change.

## Permitted files

- `VERSION3_AI_INSIGHTS_CORRECTION_BRIEF.md`
- `AI_INSIGHTS_CORRECTION_CLAUDE_HANDOFF.md`
- `VERSION3_GEMINI_EMULATOR_CALLABLE_BROWSER_PLAN.md`
- `VERSION3_AI_INSIGHTS_PLAN.md`
- `VERSION3_GEMINI_EMULATOR_BRIDGE_PLAN.md`
- `VERSION3_GEMINI_LAYER_PLAN.md`
- `MULTI_TEACHER_ARCHITECTURE_PLAN.md`
- `functions/insights/firestoreUsageLedger.js`
- `functions/insights/firestoreUsageLedger.test.js`
- `functions/index.js`
- `functions/version3-emulator/**`
- `functions/.env.demo-morgan-bank-version3-gemini-callable-browser` only for
  relocation into the dedicated emulator source
- `firebase.json`
- `firebase.version3-gemini-emulator.json`
- `package.json`
- focused `tests/version3/**` contracts and emulator assertions

No rules, indexes, dependencies, lockfiles, balances, transactions,
credentials, authentication behavior, migrations, or production release files
may change.

## Acceptance evidence

Focused regression evidence must prove:

1. a first tenant's 4,000,000 micro-USD reservation leaves only 3,500,000 for
   every other tenant, so a second 4,000,000 reservation fails;
2. a smaller cross-tenant reservation may consume only the shared remainder;
3. downward reconciliation returns capacity to the one shared ledger;
4. same-tenant rolling rate limits and month-boundary behavior remain intact;
5. the default Functions discovery main has no Version 3 callable import or
   export and excludes the dedicated emulator source from its package;
6. the dedicated source is selected only by the explicit emulator config,
   refuses non-emulator discovery, and still passes real three-emulator callable
   and Chromium/WebKit acceptance; and
7. Checkpoint B is described as merged through PR #10 while its full required
   Claude-to-Grok review closure remains unverified.

Required verification is the focused Version 3 unit/contract/emulator/browser
matrix followed by the plan's root/Functions lint, build, Phase 2B client,
Phase 3 unit/contracts, serialized Functions suite, and `git diff --check`.

## Stop conditions

Stop before expanding scope if the correction would require a real provider or
rate card, Firebase project access, App Check, a secret, billing, rules/index
changes, time-zone semantics, production configuration, or changes to existing
legacy/V2 discovery. Stop after preparing the complete Claude read-only handoff;
do not commit.
