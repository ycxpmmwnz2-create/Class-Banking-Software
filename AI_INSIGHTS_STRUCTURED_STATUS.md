# AI Insights structured answers — release record

Andrew approved commit, push, merge, and deployment on September 4, 2026.
He clarified the scope as **classroom-data answers only**. General teaching
advice is excluded. All existing bank data and unrelated work must be preserved.

## Candidate

- Branch: `codex/ai-insights-structured-answers`.
- Starting commit: `27825fbbcb613c4844b16cf5b1ec9101073782ca`.
- Main verified through GitHub: `2aabc8e8c879d22b5edb5abccf8ea02a71f0e463`.
- Codex implements this experiment; Muse Spark Code reviews read-only.
- Current state: implementation commit `c449b3505b3be55af6bfc955318d797f3cd2585e`
  is pushed; draft PR #25 is open. Staging-only deployment and three real
  signed-in fictional questions passed. Production remains unchanged and the
  PR is not merged. Live same-request replay remains unverified.


## Resulting behavior

With the existing tool-assistant gate enabled, the live handler constructs
`createStructuredClassroomAssistant`. Gemini selects validated read-only
operations and registered result IDs. Code renders every factual statement;
the final provider envelope has no prose, headings, values, or field pointers.
Legacy free-text output cannot fall back through the old validator on this path.

All seven existing operations have views: balances, absence of matching
transactions, transaction lists, grouped metrics, period comparison, balance
history, and available capabilities. Unknown balances stay unavailable; frozen
filters run against the full current roster; partial pages disclose full totals.
Dates, statuses, purposes, category substring matching and selected students
remain explicit. Invalid calendar dates and common ambiguous name references
refuse. This is not a proof of arbitrary English interpretation.

Stored results use schema 2 and `answerContract: structured-v1`. Reservations
bind that revision to the tenant, question, period, timezone, and existing
evidence signature. Old results are refused without rewriting stored data or
opening a second reservation. One provider transport attempt runs per reserved
model turn; ambiguous failures keep the conservative usage reservation.

The existing feature gate and alternative planner remain in place. No rules,
authentication, student-money operations, migration, credential flows, or
classroom-data write paths were changed. Only the existing AI usage ledger
continues to write reservation and billing records.

## Review history

- Muse design round 1: CHANGES REQUIRED. Preserved report in the local review
  archive; findings reconciled in `AI_INSIGHTS_REDESIGN_PLAN.md`.
- Muse bounded prototype round 2: PASS FOR BOUNDED PROTOTYPE. This covered the
  two initial views and toolbox corrections, not later integration or release.
- Muse integrated round 3: **PASS FOR SYNTHETIC PROVIDER CANARY**, with no
  blocking source defect found. Saved report:
  `/private/tmp/morgan-bank-muse-reviews/integration-round3/report.md`.
  This was a static review of the immutable seven-view integration packet;
  Muse did not execute tests. The reviewer explicitly withheld production and
  live-provider sign-off. Do not restart the completed reviews.

## Evidence boundaries

Saved local runs passed: 1216 Functions tests, 75 client/contracts, root and
Functions lint, build, and 30 Chromium plus 30 WebKit browser tests. Browser
runs preceded the final copy/scope cleanup; their exact bounds remain in the
immutable review packet's `TEST_EVIDENCE.md`.

Synthetic unit/service tests cover the actual live composition using a fake
SDK and in-memory Firestore: teacher/tenant resolution, name redaction and
collision labels, two-classroom separation, reservation/replay, pricing, prose
refusal and unchanged bank fixtures. This is not an actual Gemini request.

Chromium/WebKit emulator suites exercise the existing browser/callable path;
the added browser test renders a real structured-result string through a mocked
transport response and verifies escaped HTML, visible scope and line breaks.
That test is UI evidence, not a live provider or production check.

The ordinary-question corpus is preserved in
`experiments/ai-insights-structured-answers/question-corpus.json`. Real provider
interpretation, staging/live configuration, reviewed artifact identity, and
production behavior must be established before calling the release complete.

## Synthetic provider check

Andrew explicitly approved this check: "run the fictional data". It used only
hard-coded fictional evidence and the existing staging Gemini credential,
kept in memory and never displayed or saved. It did not read or write Firestore
or access production bank records.
The prepared test plan and cases are outside the release tree under
`/private/tmp/morgan-bank-muse-reviews/`. The test budget is USD 2 using the
application's conservative rate card; one transport attempt per model turn,
stop at the first failed case, and no automatic reruns.

Credential-free offline preparation passed for all 14 cases. All 25 reviewed
source/test/corpus files in its identity check match the immutable round 3
packet. Each prepared operation executes and renders using fictional records;
the largest per-case conservative quote is USD 0.422778. The USD 2 cumulative
budget still applies before every case. This is neither provider evidence nor
a promise that all 14 paid cases can run within that budget. Saved plan and
offline report: `provider-canary-plan.md` and
`provider-canary-offline-preflight.json` in the local review directory.

Automatic approval review initially rejected preparation of the credential-
access/live request script. Andrew subsequently supplied explicit approval;
the prepared runner passed its offline checks before the authorized live run.
Commit, push, merge, and deployment approval remains recorded.

Round 1 ran once, using the real Gemini transport and model with the synthetic
toolbox. Ten cases passed: negative balances, overdrawn rephrasing, frozen
accounts, highest balance, rent absence, Pending absence, Approved absence,
repeated rent, Technology spending, and explicit period comparison. The run
stopped on the eleventh case's balance-history date-scope assertion. The three
remaining cases (memo wording, unsupported memo search, class balance summary)
were not attempted. Verified token usage accounts for USD 0.111888 using the
application rate card; this is not a provider invoice.

The stopped case requested August 20-27 from the seven-day selected range;
the tool's default row cap returned August 21-27. Its seven monetary values
were correct, and the answer disclosed 7 of 8 requested dates. The canary
expected the omitted-date default of August 21-27 and rejected the different
requested start. This was a scope/oracle failure, not evidence
of invented balances. A local probe shows analogous 30-day behavior and that
the selected 90-day range spans 91 dates and hits the explicit-date range cap.
Muse's focused round 4 diagnosis confirmed both an overly rigid oracle and an
incomplete product window. Earlier reviews and paid cases were not restarted.
No deployment has occurred.

Saved immutable run report:
`/private/tmp/morgan-bank-muse-reviews/provider-canary-round1/report.json`.
Focused diagnostic packet:
`/private/tmp/morgan-bank-muse-reviews/canary-history-round4/packet`.

## History correction after the canary

The requested history window now defaults to the same classroom calendar
dates touched by the selected period. The row cap no longer defines that
window. Defaults return 8 dates for the selected 7-day period and 31 for the
30-day period. A 90-day selection can request 91 calendar dates, but still
returns at most the existing 90 dates, with the omitted date disclosed. Range
checks still enforce retained history, valid calendar dates, and no future
dates. Explicit row limits remain 1-90. The executed result supplies the
effective limit for the renderer. No banking/auth/Firestore operation changed.

Five new local regression checks were added: four failed before the correction
for the intended date-window reason; the retained safety-boundary check passed.
After correction, all 1221 Functions tests and Functions lint pass. Existing
missing-balance and snapshot-caveat tests remain green. The UI did not change.

The follow-up oracle checks the executed date span and every expected daily
balance, accepting equivalent explicit/default arguments while rejecting the
old seven-row partial result. Only the repaired history case and the three
unattempted cases may run next, after focused Muse correction review. The
runner carries the first run's USD 0.111888 into the original cumulative USD 2
budget. This is a deliberate bounded follow-up, not a restart of passing cases.

Muse round 5 returned **PASS FOR BOUNDED PROVIDER FOLLOW-UP**. The authorized
follow-up ran once: repaired history PASS, memo wording PASS, memo-search case
stopped on its required-tool assertion. Class balance summary remains unrun.
Cumulative accounted Gemini cost is USD 0.145962 across both runs. Source
has not changed since the approved history correction.

## Memo-search diagnosis and operator preference

The saved second run shows that the memo-search fixture used the same
"Fictional Field Trip memo" on every transaction. The provider selected an
unfiltered memo list; all eleven returned memos really contained "field trip".
It failed the pinned unsupported-operation route, but that fixture does not
demonstrate false memo-text matches. The FAIL remains recorded.

A local mixed-memo probe replayed the recorded tool call: it lists eleven
records, of which only two contain the phrase. Category substitution returns
one false match and misses a true match in a different category. No provider
was called with this mixed fixture, so the probe does not establish how Gemini
would respond to it. A focused Muse diagnosis is being prepared before any
further source change or paid test. Original run reports remain immutable.

Andrew clarified the operator workflow: **Andrew pastes and runs Muse Spark
commands; Codex continues ordinary coding, tests, and report reads.** Codex
prepares each prompt file and exact command, then reads the saved review after
Andrew runs it. Muse stays non-interactive and read-only, with approval and
sandbox controls enabled. This does not revoke the existing release approval.

Andrew requires **Muse 1.3, not Muse 1.3 Contributor** for upcoming reviews.
The installed model catalog identifies the two models as `muse-spark-1.3`
and `muse-spark-1.3-contributor`, with Contributor currently the catalog
default. The static review runner now explicitly passes
`--model muse-spark-1.3` and prints that selection before starting. Its
existing read-only, approval, sandbox, and duplicate-run controls remain.
Saved round 3 and round 5 events confirm those completed reviews used
`muse-spark-1.3-contributor`; their original reports are preserved and are
not relabeled or restarted. Round 6 completed with exit 0, terminal completed,
no approval requests, and only `muse-spark-1.3` recorded in its model fields.

## Memo boundary correction after Muse round 6

Muse round 6 diagnosed both a nondiscriminating fixture and the unsupported
memo-search routing gap. It recommended retaining the existing capability
boundary and fixing the fictional fixture, rather than adding memo search.
Original review and test FAIL records remain immutable.

The corrected mixed fixture preserved all original transaction evidence,
questions, and expected tools. Offline checks reject unfiltered lists and
category substitution, reject an invented `memoContains` argument, and retain
legitimate category-selected quotations. Authorized provider round 3 used
unchanged round 5 source: memo wording PASS; memo search FAIL again. This
time the actual provider selected and returned eleven memos with only two
text matches and nine nonmatches. It is direct routing-failure evidence, not
just the earlier offline replay. The run stopped and class summary remains
unattempted. Cumulative accounted Gemini cost is USD 0.169117 of the USD 2
budget; round 3 used USD 0.023155. No real bank-data access occurred.

The proposed correction changes only provider instructions/tool descriptions,
the code-owned capabilities wording, the question corpus, and a focused test.
Memo search/filtering is explicitly unavailable in every date range; requests
to quote memos on transactions selected by supported filters remain valid.
No query parser, new tool/filter, memo resolver, banking operation, or database
path is added. A recorded real-provider failure establishes the pre-fix
routing problem. The updated capability-response assertion failed before
the correction; the mixed category-quote compatibility test passed before.
All 1,222 Functions tests, Functions lint, and diff whitespace checks now pass.
Local tests do not establish provider compliance with the revised wording.

Muse round 7 completed using `muse-spark-1.3`, exit 0, terminal completed,
and no approval requests. Verdict: **PASS FOR BOUNDED PROVIDER FOLLOW-UP**.
It reviewed the correction and runner, not production readiness. It did not
independently execute tests or re-hash artifacts and reported that it had not
accessed the proposed fixture. Codex separately verified all 46 packet hashes,
fixture/runner equality, 25 source identities, and the offline oracle checks.
The review's "USD 2M" wording refers to 2,000,000 microdollars: USD 2.

## Remaining final-response reliability gap

Authorized provider round 4 passed three legitimate memo-quotation requests
and two unsupported-search phrasings, including the original failing question.
The sixth question, "Show only memos containing bus within the selected
period.", executed `describe_schema` successfully but failed the final result
envelope with `answer-unverified` / `answer-shape`. The response was blocked;
no incorrect answer was accepted. The runner did not retain the rejected final
text, so the exact JSON/keys/result-id/view failure cannot be identified from
that record. It stopped before full-history memo search and class summary.

A deliberate one-case diagnostic (round 5) added bounded public-final-text
capture to the external fictional runner only. It passed without application
changes. This is an intermittent, unreproduced failure, not a verified fix.
Round 6 then ran only the two unattempted cases: full-history memo search PASS;
class balance summary PASS with total USD 15 and average USD 5. Original FAILs
remain unchanged; these later passes do not close the round 4 reliability gap.

Across the staged runs, all 19 distinct prepared questions have at least one
PASS, but they were not one clean 19-case run of the final artifact. Local
source remains exactly the 25 files reviewed in Muse round 7. No further
application change, commit, push, merge, or deployment has occurred. The
latest cumulative budget accounting is USD 0.689412, including the full
USD 0.430506 reservation for round 4's failed response. Known priced usage
across the runs is USD 0.258906; the failed request's actual cost is unknown.

Focused Muse round 8 will assess this evidence and the smallest justified
reliability correction. Current requests ask for JSON in the system prompt
but set no `responseMimeType`, `responseSchema`, or `responseJsonSchema`.
Installed @google/genai 2.18.0 types document JSON/schema request options;
that alone does not establish Gemini 3.6 tool-mode compatibility. A proposed
provider-constrained envelope must retain independent result validation,
multi-step tools, privacy, and conservative schema-byte pricing. No such
runtime correction or additional paid run has been started.

## Typed diagnostics after Muse round 8

Muse round 8 completed with `muse-spark-1.3`, exit 0, terminal completed,
and no approval requests. It kept the reliability gate open and recommended
safe typed validation diagnostics before any native response schema. It did
not identify the missing rejected response's cause or grant production PASS.

The local correction adds a fixed `structuredAnswerCode` vocabulary to
structured validation failures. Codes distinguish non-string/invalid JSON,
envelope type/keys/version, sections bounds, section type/keys, result-id type,
duplicate/unknown IDs, wrong view, and oversized output; other renderer-value
failures use a fixed fallback code. Outward category/subcategory remain
`answer-unverified` / `answer-shape`. Non-string final text is explicitly
refused rather than passed to JSON coercion. The logger accepts only the
fixed code vocabulary, and client error details still contain category only.
No rejected text, keys, IDs, names, values, or SDK errors enter diagnostics.

The live-composition regression confirms diagnostics survive the service
re-wrap, while failure retains an uncertain reservation and replay does not
call the provider again. Before the change, 18 focused diagnostic assertions
failed because the details were absent; four compatibility/privacy checks
passed. The final Functions suite has 1,245 PASS, zero failures; lint and
diff whitespace checks pass. Two external runner contract tests also pass.
They exercise an actual fake-provider refusal and malicious diagnostic
values without model calls. All validation checks and valid rendering remain.

The prepared next fictional runner wires a tested, bounded typed-diagnostic
capture helper into its failure branch and retains only registered ID/view/
tool summaries there. It removes the temporary raw public-final-text capture;
the existing fictional tool-call evidence remains in synthetic reports.
No paid test was run for this correction. Budget accounting remains
USD 0.689412 of USD 2; the historical unknown failure remains unresolved.
Native schema options, tool flow, cost policy, production logging targets,
and bank-data paths have not been changed. Focused Muse round 9 is next.

## Current full-corpus result and staging handoff

Muse round 9 returned **PASS FOR TYPED DIAGNOSTICS**, using standard
`muse-spark-1.3`, with no approval requests. Its scope was diagnostics and
one instrumented synthetic attempt, not production readiness. Codex verified
packet hashes, candidate identities, runner paths, and the two helper contract
tests directly. Muse did not independently run the tests; its report says it
could not locate the helper test. The test file was present in the packet.
The 14-code test coverage uses both assistant and direct registry/helper tests;
it is not accurate to call every code an end-to-end assistant test.

Provider round 7 passed the single instrumented previously failing question.
Round 8 then ran the fixed full corpus once on that same current candidate:
**19 of 19 PASS**, each distinct question once, no automatic retry. This is
new full-corpus evidence, not a replacement for any earlier failed report.
All 26 pinned source/test/corpus artifacts match the round 9 reviewed files.
The old final-envelope failure's exact cause remains unknown. Typed diagnostics
will distinguish a recurrence; successful subsequent runs do not prove a fix.

Round 7 priced usage was USD 0.010959; round 8 was USD 0.210056. Cumulative
accounted cost is **USD 0.910427 of the original USD 2 ceiling**, including
USD 0.430506 conservatively reserved for the old uncertain failure. Known
priced usage totals USD 0.479921; this is application accounting, not an invoice.
These requests used fictional evidence and the existing in-memory staging key,
without reading or writing real bank records.

Current local checks: 1,245 Functions tests, 75 client/contract tests, root and
Functions lint, build, and 30 Chromium plus 30 WebKit browser tests all pass.
The emulator includes legacy guidance fixture tests; those do not establish
general advice support on this release's structured path. Browser evidence
is emulator/mocked transport evidence, not a live App Check or deployed Gemini
check. The ordinary build uses production defaults and must not be deployed
to staging Hosting. No staging Hosting build has been prepared.

The release diff must start at GitHub main
`2aabc8e8c879d22b5edb5abccf8ea02a71f0e463`, not only at experiment baseline
`27825fbbcb613c4844b16cf5b1ec9101073782ca`. Eighteen earlier AI commits sit
between those points and are included in the proposed release. Round 10 is a
new cumulative staging-boundary review of this complete diff and new evidence,
not a restart of any completed diagnostic review. Unrelated original-checkout
work remains protected. See `AI_INSIGHTS_STRUCTURED_STAGING_PLAN.md` for the
specific callable-only staging target, preserved configuration, and stop gates.

## Muse staging-plan review and coverage reconciliation

Round 10 completed with standard `muse-spark-1.3`, exit 0, no approval requests:
**PASS WITH CONDITIONS (controlled staging plan only)**. It found no required
source correction but hit its step limit before reading the complete source diff.
Do not call round 10 complete release-code clearance or production readiness.

The earlier round 3 report explicitly reviewed the shared live/error changes in
`full-main-tracked.patch`, including the inherited baseline, as well as the full
structured integration. Those earlier commits were already present in its packet;
the preceding staging-handoff description overstated that review-scope gap.
Current live wiring, tenant/question evidence, service, usage ledger, cost policy,
and Function entry point were rechecked byte-for-byte against round 3. Runtime
deltas since then are the history, memo-boundary and diagnostic corrections
reviewed in rounds 5, 7 and 9. Current 26 pins still match round 9. Existing
reviews are retained with their original scope/model attribution, not restarted.

Staging execution still requires exact commit binding, fresh configuration and
artifact verification, a verified rollback procedure, the fictional signed-in
staging fixture, existing-gate disposition, concrete budget allowance and live
postdeploy readback. The existing staging test classroom is signed in and its
fake-data banner was verified; no AI request or data write was made by that check.
No production action or source-failure closure is implied by this plan verdict.

## Actual staging deployment and live results

Implementation commit: `c449b3505b3be55af6bfc955318d797f3cd2585e`.
Draft PR: https://github.com/ycxpmmwnz2-create/Class-Banking-Software/pull/25.
Only `analyzeTeacherInsightsV3` in `morgan-bank-staging` was deployed. Node 22
revision `analyzeteacherinsightsv3-00029-wed` is ACTIVE at 100% traffic;
update time 2026-09-05T02:48:43.227618469Z. All seven preexisting parameters
and the staging GEMINI_API_KEY version-1 binding were verified unchanged.
No Hosting, rules, other Functions, production resource or bank record changed.

Before deploying, the old revision `analyzeteacherinsightsv3-00026-xeq` and its
image digest were captured. Routing explicitly to that already-serving revision
succeeded; readback confirmed 100%, then the original LATEST routing was restored.
This rehearses traffic recovery to retained code/settings. It does not prove
full Cloud Functions deployment-metadata restoration; any emergency traffic
rollback must be reported with that distinction and reconciled afterward.

The existing signed-in fictional staging classroom was used without seeding,
resetting, exporting or importing records. In the selected 90-day period:

- Class balances PASS: total $21, average $7, three accounts at $4/$10/$7.
- Approved rent PASS: one $1 subtract/rent payment on 2026-08-08, matching the
  visible fictional transaction history.
- Unsupported memo search PASS: capabilities response explicitly says memo-text
  search is unavailable in the selected period; no approximation is returned.

The first two requests were consecutive and cloud verification records on the
new revision show both auth and App Check VALID. Three questions were submitted
once each; no retry-to-pass was used. Dashboard readback retains $21, 3 students,
10 pending credits, 0 frozen accounts and 20 total transactions. This is bounded
UI observation, not a database-wide audit or arbitrary-language correctness proof.

New staging AI charges total USD 0.032888. Added to the prior USD 0.910427,
this experiment accounts for **USD 0.943315 of USD 2**. The pre-test staging
ledger held USD 2.428768 from September 2, before this experiment; it is not new
experiment spend. Automatic approval initially conflated that historical counter
with this budget and blocked a submit before execution. Dated accounting evidence
resolved the rejection; the same approved action then ran with the ceiling intact.

The earlier intermittent envelope failure did not recur but remains unexplained.
Actual same-request replay is NOT verified: the normal UI generates a fresh ID
for each question, and repeating the wording would not test replay. Existing
local live-composition tests assert exact replay and no additional provider call;
they remain local evidence. A focused handoff will resolve the smallest safe live
replay check. No tokens are extracted, no auth/App Check safeguard is bypassed,
and the production release is not cleared by these staging results alone.

## Release boundary

Deploy only the reviewed Insights callable and necessary Hosting artifact to
the explicitly named target. Read existing configuration before deployment
and preserve unrelated functions and data. Do not export or copy real student
data for tests. Use synthetic evidence for provider checks. Rollback changes
code/configuration, never classroom transactions or balances.
