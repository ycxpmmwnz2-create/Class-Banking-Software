# Morgan Bank AI Insights — context-reset handoff

**Prepared:** 2026-08-19  
**Purpose:** Resume the Version 3 AI Insights work in a fresh Codex task without
repeating the read-only checkpoint audit.  
**Current verdict:** **NOT CLEARED for a real Gemini provider or production
deployment.** The emulator-only prototype is technically strong, but two design
defects and two review/governance gaps must be resolved first.

## 1. Instructions for the fresh task

1. Work only in `/Users/andrewmorgan/Documents/GitHub/Class-Banking-Software`.
2. Read `AGENTS.md`, `AI_COLLABORATION_WORKFLOW.md`, this handoff, and the Version
   3 plans before acting.
3. Treat the existing main checkout as dirty and protected. Do not modify,
   discard, stage, or overwrite its existing changes.
4. Confirm current local and remote state before relying on the hashes below.
5. Do not make corrections until Andrew separately authorizes an isolated AI
   Insights correction pass.
6. Commit, push, PR, merge, real provider access, Firebase access, billing,
   secrets, staging, production, and deployment remain separate approval gates.
7. Claude detailed review and Grok final review remain required under
   `AI_COLLABORATION_WORKFLOW.md`.

Recommended next authorization phrase:

> $7.50 is the whole-app monthly cap. Authorize an isolated AI Insights
> correction pass.

That phrase should authorize only an isolated local correction pass. It does
not authorize commit, push, PR, merge, Firebase/provider access, billing,
secrets, or deployment.

## 2. Repository state observed during the audit

The ordinary checkout was deliberately left untouched:

- Path: `/Users/andrewmorgan/Documents/GitHub/Class-Banking-Software`
- Branch: `feature/multi-teacher`
- Local HEAD: `a10be3cb194145f9f251cf94a85a3265d7eb4455`
- At audit time it was 21 commits behind `origin/feature/multi-teacher`.
- Existing modified files:
  - `PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md`
  - `PHASE3_RELEASE_RUNBOOK.md`
  - `package.json`
  - `tests/browser/phase2b-fixtures.js`
  - `tests/phase3/release-order.contract.test.js`
- Existing untracked protected/user files:
  - `SAFARI_COMPAT_HANDOFF.md`
  - `scripts/sandbox.mjs`
- This handoff is the only new file intentionally added by the handoff task.

The read-only audit used a detached temporary worktree:

- Path: `/private/tmp/morgan-bank-ai-insights-audit.c62KJk/worktree`
- Audited HEAD: `74c905ca792aec9cd3e5cec36ca1c5b3a58aaba2`
- This was the live `origin/feature/multi-teacher` merge tip when verified.
- The temporary worktree was clean after verification.
- It contains ignored dependency symlinks and generated test/build artifacts.
  Do not treat it as a development worktree without rechecking it.

Remote commits observed during the audit:

- `origin/codex/version-3-gemini-callable-browser-plan`:
  `b7c7815...`
- `origin/codex/version-3-gemini-browser`: `c12b39e...`
- `origin/feature/multi-teacher`: `74c905c...`
- PR #9 merged as `f6315f6...`.
- PR #10 merged as `74c905c...`.

Reverify all remote facts in the fresh task because they can change.

## 3. What AI Insights currently is

Version 3 has three materially different layers:

1. A provider-independent, deterministic local Insights foundation.
2. Checkpoint A: an emulator-only callable using synthetic data and a fixed fake
   provider/rate card.
3. Checkpoint B: default-off browser wiring that activates only for the exact
   demo project and loopback emulator runtime.

The normal application still uses the local, zero-API-cost Insights behavior.
There is no real Gemini SDK, model call, API key, prompt, current provider price
lookup, billing setup, App Check activation, staging access, production access,
or authorized deployment in this checkpoint.

Strong properties confirmed in review:

- The browser sends only `{requestId, mode, periodDays}`.
- The server derives and revalidates the teacher/classroom tenant.
- Firestore reads are bounded using `MAX + 1` checks.
- Names, IDs, reasons, and display facts are pseudonymized before the provider
  boundary.
- Raw/display reports are paired with pseudonymized provider facts without
  persisting sensitive display facts.
- Request and response schemas fail closed.
- Replay state stores digests and bounded metadata rather than display facts.
- Browser stale-completion guards prevent an older result from overwriting a
  newer request.
- Output is escaped before display.
- Runtime checks refuse the callable outside the exact demo/loopback emulator
  conditions before obtaining the Firestore handle.

No prompt-injection or attempted secret-extraction instructions were found in
the reviewed repository or pull-request content.

## 4. Blocking finding: the Gemini allowance is tenant-scoped

The approved plan states:

- Gemini API allowance: **$7.50**
- Firebase allowance: **$5.00**
- Combined ceiling: **$12.50**
- A future provider integration must refuse calls once the application-side
  Gemini allowance is exhausted.

Relevant plan: `VERSION3_AI_INSIGHTS_PLAN.md`, lines 13–22.

The implementation instead hashes `teacherUid + classroomId` into the ledger
ID in `functions/insights/firestoreUsageLedger.js` around lines 75–80. The
allowance is then enforced only inside that tenant ledger around lines 134–139.

The test `monthly allowance and tenant scope are enforced before another
reservation` in `functions/insights/firestoreUsageLedger.test.js` around lines
111–125 proves the behavior: one tenant exhausts its allowance, while another
tenant receives a new full allowance.

Consequences if the real provider were enabled:

- Two classrooms could reserve $15 of Gemini usage.
- The displayed $7.50 Gemini ceiling and $12.50 combined ceiling would not be
  true application-wide ceilings.
- Additional classrooms could multiply the exposure further.

There is no present monetary exposure because the provider is still fake. This
is nevertheless a blocking design defect before any real provider work.

Recommended product decision: treat $7.50 as the whole-application monthly cap,
consistent with the existing plan and combined ceiling. If Andrew instead wants
$7.50 per classroom, the plan, UI, billing explanation, aggregate safety cap,
and acceptance tests must be explicitly redesigned before implementation.

## 5. Blocking finding: emulator callable is in the deployable entrypoint

`functions/index.js` unconditionally exports
`analyzeTeacherInsightsV3 = onCall(...)` around lines 255–283.

The callable has a strong runtime fail-closed guard, so normal production data
access should be refused. However, `firebase.json` uses the entire `functions`
directory as the default Functions codebase and does not exclude this export.
A future full Functions deployment could therefore discover and publish the
endpoint even though the checkpoint's explicit non-goals include:

> No production callable enablement.

Relevant plan: `VERSION3_GEMINI_EMULATOR_CALLABLE_BROWSER_PLAN.md`, lines
401–418.

This must be corrected at the deployment/discovery boundary, not merely by
relying on the runtime rejection. The correction design must also preserve
existing Functions discovery and legacy/V2 exports under gate-off.

## 6. Review and governance gaps

### Required review evidence is incomplete

The repository workflow requires:

1. Codex implementation and verification.
2. Claude detailed, read-only engineering review and any correction re-review.
3. Grok final, read-only 5,000-foot review.
4. Separate authorization for each later state change.

GitHub evidence observed:

- PR #9 had no recorded GitHub reviews, comments, checks, or statuses.
- PR #10 had no checks and one automated Codex review submitted about two
  minutes after the merge.
- That review flagged the stale Checkpoint B status described below.
- No verifiable Grok PASS was found.
- Earlier context indicates Claude reviewed at least some Checkpoint A material,
  but the complete required A/B Claude-to-Grok closure could not be reconstructed
  from the current repository and GitHub evidence.

This is not proof that an off-GitHub review never happened. It means the audit
cannot certify that the required review sequence closed before the merges.

### Governing plan is stale

`VERSION3_GEMINI_EMULATOR_CALLABLE_BROWSER_PLAN.md` around lines 10–15 and
329–336 still says Checkpoint B is uncommitted and awaiting Claude review. It is
already committed and merged through PR #10.

Update this only as part of an authorized correction, using precise historical
language. Do not rewrite history or claim a review PASS without its complete
evidence.

## 7. Verification completed at audited merge `74c905c`

Passed:

- `npm run test:version3:insights` — 50/50.
- `npm run test:version3:gemini-layer` — 60/60.
- `npm run test:phase2b:client` — passed.
- `npm run test:phase3:unit` — 512/512.
- `npm run test:phase3:contracts` — 86/86.
- `npm run lint` — passed.
- `npm --prefix functions run lint` — passed.
- `npm run build` — passed.
- Serialized Functions suite with `node --test --test-concurrency=1` — 852/852.
- `npm run test:version3:gemini-bridge:emulator` — 4/4.
- `npm run test:version3:gemini-callable:emulator` — 2/2.
- Chromium browser acceptance — 8/8.
- WebKit browser acceptance — 8/8.
- `git diff --check` — passed.

Important limitations:

- The ordinary parallel `npm run test:functions` run produced 851/852 because
  of the known `functions/phase2/manifestSlot.test.js` shared-state race. The
  exact suite passed 852/852 when serialized. Treat the package command as
  flaky until separately corrected; do not misreport the initial run as green.
- Functions request Node 22, but the local Firebase emulator used global Node
  24 and warned about the mismatch.
- The build passed with a 556.34 kB JavaScript chunk warning.
- Emulator tests used demo projects, isolated CLI configuration, loopback
  services, synthetic tenants, and refused application default credentials.
  They are not staging or production evidence.

## 8. Safe correction sequence after authorization

Once Andrew gives the recommended budget decision and authorizes an isolated
correction pass:

1. Refresh `origin/feature/multi-teacher` read-only.
2. Create a new isolated worktree from the exact refreshed baseline. Do not use
   or clean the dirty ordinary checkout.
3. Write an acceptance-first correction brief covering both blocking findings,
   documentation truth, and required regression evidence.
4. Change the budget ledger to enforce the chosen application-wide cap without
   weakening tenant isolation, replay safety, or idempotency.
5. Remove the emulator callable from production Functions discovery while
   preserving the exact emulator acceptance path and existing exports.
6. Correct the stale checkpoint status without claiming unverified reviews.
7. Add focused tests for cross-tenant aggregate allowance and production
   Functions discovery/exclusion.
8. Re-run all relevant gates, including both browsers and serialized Functions.
9. Stop and prepare the complete Claude handoff. Do not commit without separate
   approval.
10. After Claude PASS and any correction re-review, prepare the Grok handoff.
11. Treat commit, push, PR, merge, provider configuration, Firebase work,
    billing, secrets, staging, production, and deployment as separate gates.

## 9. Current stop conditions

Stop and ask Andrew before proceeding if any of these becomes necessary:

- Deciding whether $7.50 is application-wide or per classroom.
- Choosing a real Gemini model or current provider pricing.
- Creating or reading secrets.
- Activating App Check.
- Accessing any real Firebase project.
- Enabling billing or configuring budget-console controls.
- Selecting classroom time-zone semantics.
- Changing Firestore rules or indexes.
- Committing, pushing, opening a PR, merging, or deploying.
- Discarding, staging, or modifying the pre-existing dirty checkout changes.

## 10. Plain-language status for Andrew

AI Insights was not abandoned. The local feature and emulator prototype were
built and merged, and their tests are strong. It has not become a real paid AI
feature and is not deployed. Before that can happen, the monthly cap must become
a true application-wide cap, the emulator callable must be kept out of
production discovery, the stale plan must be corrected, and the required
Claude/Grok review trail must be closed.
