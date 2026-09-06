# Broader classroom-data narration candidate

Uncommitted branch: codex/ai-insights-conversational-answers. Baseline: aa2b3611153dfb6ea2a9502d8c2637bfce4f1fbf (released earnings-only candidate). This follow-up is local only; not deployed.

Gemini now narrates every validated factual selection, including distinct days, balances, lists, students without transactions, history, and comparisons. It receives the question and the complete calculated answer. Capabilities-only and legacy structured responses stay fixed. One optional narrator shares the existing four-call/time/token/cost limits. Calculated facts remain code-owned and separately visible. Oversized presentations retain the entire original answer without a narrator call. Missing usage retains conservative accounting; exact request replay retains the saved response.

The classroom context supplies the previous completed calendar week using the existing earnings date calculation. This fixes observed Sunday confusion without changing week semantics. Absence rows now explicitly say that each listed student has no matching transactions under the stated filters and label the amount as current balance.

Andrew accepts occasional wording imperfections and requests a fluid Gemini response. This is not a semantic guarantee for arbitrary generated prose. No grammar whitelist or expanding semantic validator is introduced. Classroom-data answers only; no general teaching advice.

## Verification

516/516 Gemini-layer tests pass; ESLint and git diff --check pass. Includes actual tool/registry facts, all tool families, multipart selections, size fallback, fourth-turn limit, uncertain billing, replay, tenant separation, and calendar boundary regressions. Final post-test edit only relocates an existing comment to its proper function. The final label regression checks actual absence results before they reach the narrator; it does not prove Gemini will always honor them.

Fictional genuine Gemini broad run: balances, transaction lists, comparison, history and earnings matched calculated facts. Initial day-count query chose the wrong week; follow-up with explicit calendar context correctly reported one distinct day from two approved transactions. Zero-day follow-up also matched. All completed requests replayed identically with no additional provider calls, usage charges or writes in the in-memory harness.

Known observed narration failure: absence replies first omitted the available name, then reversed the predicate and confused Quill's $4 current balance with Homework earnings. The final code now labels both predicate and balance explicitly. Its single final provider check STOPPED_SETUP_FAILURE before any provider call; no semantic PASS is claimed for that correction. Earlier failed replies are preserved in the packet. This residual limitation must be visible in review, not dismissed as a style issue.

Cumulative conservative fictional-test accounting: $2.291671 of the authorized $3.00. No new charge occurred in the final setup failure. Do not restart completed or failed atomic runners. These are local injected fictional records and an in-memory ledger, not deployed Auth/App Check or production evidence.

No client/UI/schema/cost-policy/ledger/deployment configuration changes. No bank records or original checkout changes. Pending: independent manual Muse review, reconcile concrete findings, then release verification under existing user release authorization. Existing production deployment remains the earnings-only baseline.

## Muse review and final predicate check

Muse round19 returned PASS WITH CONDITIONS with no code changes requested. Its one final-provider condition is now satisfied: the reviewed labels produced "Quill had no approved Homework additions last week between August 24, 2026, and August 30, 2026." The prior setup failure was gcloud credential-database sandbox access; it was preserved, and a new single recovery run used the same reviewed runtime sources. Identical request replay incurred no additional calls, charge or writes. Cumulative conservative accounting is now $2.305177 of $3.00. This document update is the only change after the reviewed packet. Deployed staging and production checks remain pending.
