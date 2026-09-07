# Natural classroom answers — review candidate

Baseline: `8ac9960e9d72fdd29435bdc99f1ed6491b8179ec` (merged category mapping release). Branch: `codex/ai-insights-natural-answers`. This candidate is uncommitted and not deployed.

## User-visible behavior

Andrew requested a direct, readable answer with useful actual weekdays, without visible sources or a duplicate calculated-fact dump. Gemini supplies the prose. Broad classroom-data support remains; teaching advice remains outside scope.

Distinct-day aggregate rows now carry up to seven actual matching classroom-calendar dates, deduplicated and sorted per group. The full distinct-day count is unchanged. The code-owned rendered answer names their weekdays and dates; if truncated it explicitly says “First 7 of N matching dates.” Gemini receives that factual text and instructions to synthesize it naturally, preserve material caveats, and avoid calculation jargon. The prompt example is illustrative; it must not supply invented weekdays.

The browser renders one escaped answer: Gemini prose when available, otherwise the complete existing calculated answer. The normal source/details section, duplicate facts, and “check below” wording are removed at Andrew's request. Backend answer/evidence/presentation fields remain available for validation and exact replay. The fallback remains more technical when narration fails; it still provides the complete answer rather than hiding relevant facts.

## Boundaries

No bank data writes, tenant loading changes, category mapping changes, status/date filtering changes, or count arithmetic changes. No new model, provider call, prose validator, fixed-category allowlist, retry, increased budget, token limit, or output-size limit. Supplemental dates increase bounded tool text; existing size guards still apply. Existing category-catalog cap is unchanged. Names and dates come from the selected tool result; generated prose is not independently semantically certified.

## Verification

- New regression: 5/5 fail before correction; 5/5 pass after. Covers actual three weekdays with four transactions, excluded pending/category/student records, Denver versus UTC date boundary, per-student groups, ten-day partial sample and zero-day result.
- Full Gemini-layer suite: 541/541 pass.
- UI renderer/source contracts: 12/12 pass, including escaping, one visible answer, complete fallback and preservation of the underlying response.
- Root lint, Functions lint, Vite production build and diff check pass.
- One genuine Gemini full-pipeline test with fictional Fable records: Tuesday Aug 25, Thursday Aug 27 and Saturday Aug 29, 2026; duplicate Thursday transaction, unrelated and pending records excluded. Correct count three from four matching transactions. These dates deliberately differ from the prompt's Monday/Wednesday/Friday style example.

Actual Gemini wording:

> Fable earned money for Technology three days last week: Tuesday, August 25, 2026; Thursday, August 27, 2026; and Saturday, August 29, 2026.

The extra calendar dates are an accepted wording variation. The test used the real provider with the local service and an in-memory usage ledger; this is not deployed Auth/App Check or Firestore proof. Two planner calls and one narrator call cost 15,599 microUSD. Identical-request replay returned the identical response with zero additional calls, charge or writes. Cumulative fictional-test accounting is 2,397,959 of 3,000,000 microUSD; 602,041 remain. This completed runner must not be restarted.

A static localhost preview uses the actual renderer, application CSS and saved genuine Gemini response. Visually checked: readable wrapping, one answer, no source/fact dump. It contains only fictional data and makes no Firebase calls.

Evidence: `/private/tmp/morgan-bank-natural-answers-20260906/` and `/private/tmp/morgan-bank-natural-*.log`; a frozen copy accompanies the round22 review packet.

## Remaining gates

Manual read-only Muse 1.3 review of this exact delta, followed by staged function and Hosting verification, then production release under existing user authorization. No completed review should be restarted. Before another paid staging request, reconcile the live ledger and prove its worst-case quote fits the remaining 602,041 microUSD; the old generic 610,000 guard no longer fits. Do not silently increase the $3 ceiling or weaken reservation/replay controls. No production AI request by Codex and no real classroom data changes.
