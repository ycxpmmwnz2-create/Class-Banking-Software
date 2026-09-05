# Morgan Bank AI Insights: structured answer experiment

Status: the current candidate passed all 19 fictional questions in one complete
real-provider run after Muse approved typed diagnostics. The earlier intermittent
final-envelope failure remains unexplained. Cumulative staging-readiness review
is next; nothing has been committed or deployed. See
`AI_INSIGHTS_STRUCTURED_STATUS.md` for the evidence and release authorization.

## September 4 contract revision and release authority

Andrew has now explicitly approved commit, push, merge, and deployment of this
AI redesign. That approval applies after implementation, required independent
review, and verification. It does not authorize data resets, migrations,
banking changes, or bypassing failed checks. Earlier descriptions below of
unapproved release steps describe the original design-review stage.

The original design and Muse verdict are preserved in the review ZIP and
`/private/tmp/morgan-bank-muse-reviews/design-review-round1.report.md`.
This revision reconciles that review; it does not relabel it as a PASS.

### Muse finding dispositions

- F1: accepted. The only final answer object is `{schemaVersion: 1, sections}`;
  each section has exactly `resultId` and `view`. No title, text, options,
  values, field pointers, or other keys exist. A finite view catalog dispatches
  to code-owned templates. Every semantic scope term comes from normalized
  executed arguments or the snapshot, including status and balance condition.
- F2: accepted with corrections. Store a request-random result identifier,
  tool name, normalized arguments/defaults, effective result dates, pagination,
  and a frozen result. Copy the classroom context once per request; never copy
  the transaction snapshot per result. Tenant binding remains inside the
  authenticated service and ledger signature, never in provider metadata.
  Correct pagination totals are matchedCount (balances/transactions),
  studentsWithoutCount (absence), and resultCount (aggregate groups).
  distinctCurrentStudentCount is a participant statistic, not a page total.
  Stable refs resolve against the same frozen context; display-name collisions
  already have deterministic disambiguated labels from the evidence adapter.
- F3: accepted. Each answer shows actual population, transaction status/type/
  purpose, amount/category filters, effective dates, timezone, and sort where
  applicable. The ordinary-question corpus pins expected operations separately
  from renderer tests. Mocked tool choices are not live interpretation proof.
  Ambiguous or unsupported questions can select a fixed capabilities response;
  provider-written clarification prose is not an escape hatch.
- F4: accepted. Closed catalog: student-balances, students-without-transactions,
  transaction-list, transaction-summary, balance-history, period-comparison,
  capabilities. Summary supports every existing aggregate metric/grouping;
  lists include redacted memo quotations only when requested. Rent paid twice
  uses student grouping, Approved/Subtract/rent, count >= 2. Category matching
  is explicitly described as case-insensitive substring matching. Searching
  arbitrary memo text is an unsupported capability, not category filtering.
- F5: accepted. Unknown balance/frozen values display as unavailable; unknown
  balances cannot enter complete summaries as zero. Null balances sort after
  known amounts. Rank pages never assert a unique winner, and disclose that
  ties can extend beyond the page. Empty amount averages/minima/maxima/medians
  are unavailable, even if the legacy tool returns a zero sentinel. History
  states which requested dates/students are omitted and is labeled as a
  reconstruction from retained approved records, with today's snapshot caveat.
  Frozen-account filtering will be a validated tool argument, not a heading.
- F6: accepted. Random result IDs are unique per answer invocation, including
  retries; only that local Map can resolve them. Service stored schema becomes
  version 2 with answerContract `structured-v1`; the reservation signature is
  SHA256 of that revision plus the existing tenant/question/evidence signature.
  Old stored prose is rejected without conversion, rewriting, or retry billing.
- F7: preservation invariant retained. No data operation is needed. Rollback
  restores code/configuration; existing usage results are never backfilled.

The initial pure-module slice is reviewed before live integration. Later
integration must measure real-service behavior, privacy, usage/replay, browser
rendering, interpretation coverage, and release configuration. All reported
evidence must identify synthetic, local, staging, or production scope.

Andrew clarified the release scope: classroom-data answers only. General
teaching suggestions are excluded. Open-ended questions about Morgan Bank
records remain supported through the full tool and view catalog. The briefly
prepared teaching-idea addition was withdrawn before review or release.

## Authority and isolation

On September 4, 2026, Andrew directed this new attempt to be Codex, Andrew,
and Muse Code. For this experiment Codex owns design and implementation;
Muse is the independent, read-only design and code reviewer; Andrew owns
product decisions and release authority. This is Andrew's current direction,
not an inferred exception based on Claude's availability. Historical review
attributions remain unchanged. Existing tracked workflow files are not edited
by this packet.

Andrew uses Morgan Bank now. Its students, balances, transactions, settings,
credentials, and live availability must be preserved. This experiment uses
only synthetic fixtures. It requires no database deletion, reset, migration,
export, real student-data copy, live provider request, or deployment.

- Original checkout: `/Users/andrewmorgan/Documents/GitHub/Class-Banking-Software`
- Original branch: `claude/ai-insights-production-findings`
- Isolated checkout: `/private/tmp/morgan-bank-ai-structured-answers`
- Experiment branch: `codex/ai-insights-structured-answers`
- Exact baseline: `27825fbbcb613c4844b16cf5b1ec9101073782ca`

The isolated worktree starts at the committed baseline. It does not copy the
original checkout's uncommitted files, untracked `.env` files, or credentials.
This baseline is an investigation candidate, not a claim about what is live.
No remote was fetched. No commit, push, merge, configuration change, provider
enablement, staging operation, or production operation is part of this stage.

## Problem we are replacing

The current provider writes an `answer` string plus scalar fact references.
`parseFinalAnswer` in `functions/insights/geminiClassroomAssistant.js` then
tries to infer the meaning of that English sentence. Matching numbers and
recognizing a noun phrase do not prove that its qualifiers describe the
population selected by the tool.

Four synthetic cases accept false statements on the baseline:

| Provider statement | Actual fixture and cited operation |
| --- | --- |
| Showing 1 of 3 frozen students. | All accounts are unfrozen; `get_balances` selects positive balances. |
| Showing 1 of 3 students with negative balances. | All balances are positive; `get_balances` selects positive balances. |
| Showing 1 of 3 students without approved transactions. | Everyone has an Approved transaction; the tool checked absence of Pending transactions. |
| The records show 1 of 3 went without matching transactions. | All three have no transactions; only the returned page contains one. |

The last failure survives disabling the listing exemption. Replacing only
the partial-result notice, or appending a correct notice to unverified prose,
cannot fix the complete problem. Preserve `74dbdc2` and `27825fb` as useful
bounded corrections; do not describe the residual as a regression they caused.

The packet includes a small standalone reproduction test using the unchanged
assistant and real toolbox with a fake provider. All four assertions expect
rejection; they must fail on this baseline. These tests prove a local
validation defect, not its frequency in live model output.

## Proposed answer path

1. The existing service authenticates the teacher, derives the classroom,
   loads a bounded evidence snapshot, applies the existing privacy boundary,
   and reserves usage before invoking a provider.
2. AI interprets a free-form question and selects supported read-only tools.
   Tool arguments are validated before execution. No teacher/classroom ID,
   arbitrary query, code, database write, or provider-authored evidence enters
   this interface.
3. The server keeps a request-local registry of executed results. Each record
   binds the executed operation, normalized filters/defaults, effective dates,
   student selection, result population, metric/unit, page count, total, and
   evidence snapshot. Copy/freeze inputs so later mutation cannot rewrite
   the description of an already executed result.
4. The provider selects result IDs and supported presentation types. It cannot
   supply factual prose, values, names, population labels, filter descriptions,
   JSON Pointer paths, or replacement result objects in the final answer.
5. Code validates each selected result and presentation combination, resolves
   authorized display labels, and builds concise factual sentences, lists,
   and partial-result notices from the registered result. All final factual
   language belongs to these validated renderers. Unknown fields, unsupported
   views, failed calls, duplicate references, and results from another request
   are rejected before rendering.

Illustrative provider selection, not the final schema:

```json
{
  "schemaVersion": 1,
  "sections": [
    { "resultId": "result-1", "view": "student-balances" }
  ]
}
```

The server, not this JSON, determines that `result-1` selected *positive*
balances and returned one of three matching students. That selection cannot
be relabeled as frozen students or negative balances. A view needing a filter
the operation did not execute must fail. The first slice must not pretend
`get_balances` has a frozen-state filter; it currently does not. Either a
separately tested operation computes that population from the full scoped
snapshot, or the request reports that the capability is unavailable.

No fallback sends the provider's original `answer` string through the old
grammar on the new path. No unverified introductions, headings, explanations,
or follow-up prose can reintroduce factual assertions around a correct result.
Fixed connective wording may be composed by code. Category names and memo
excerpts are untrusted *data*: use bounded, labeled, escaped text; preserve
memo privacy/redaction and truncation rules. Never interpret them as code,
HTML, instructions, or assertion templates.

## Preserve usefulness

The question remains free-form. The allowed *operations and result views* are
structured; the teacher is not limited to a menu of preset questions. Add
supported computations as capabilities with independently checked semantics.
Do not replace today's broad feature with a balance-only feature and call it
finished. Unsupported ordinary questions are coverage gaps to close.

The critical remaining risk is question interpretation. An AI can select
Pending when the teacher meant Approved, or the wrong period, and produce a
perfectly grounded answer to the wrong question. This design does not claim
to prove arbitrary English intent. Always make the executed status, dates,
population, and scope visible in the answer; measure tool selection separately
against expected plans for natural teacher questions. Ambiguity should produce
a concise clarification rather than a guessed personal or financial claim.
Query correctness and result grounding are separate acceptance requirements.

Teacher-facing output should answer directly, use short conversational wording,
show full-result totals separately from displayed rows, and put calculation
details after the answer. The implementation must support empty results and
ties without inventing a winner or implying that a limited page is complete.

## Reuse and change boundaries

Reuse subject to focused verification:

- `functions/insights/classroomAssistantTools.js`: deterministic read-only
  operations over the supplied snapshot. Audit filter/default/date semantics
  when adapting each operation; reuse is not automatic correctness proof.
- `functions/insights/questionEvidenceAdapter.js`: scoped evidence and privacy
  handling, including stable student references and colliding display labels.
- `functions/insights/toolQuestionService.js`: authentication, evidence loading,
  reservations, usage settlement, and idempotency orchestration.
- Existing client tenant/epoch cancellation and safe text rendering.

Replace the provider-final-answer contract and its factual renderers. Begin
as new inert modules under `functions/insights/`; initially import them only
from local tests. Provider-loop, service, and browser integration are later
bounded diffs. Leave Firebase rules, ledger data, balance calculations, money
submission, student login, credentials, migrations, and deployment setup alone.

The existing service caches an answer with result schema version 1. Integration
must use a distinct answer-contract revision in replay validation/reservation
identity so an old free-text answer cannot masquerade as a newly grounded
result. Determine the smallest compatible revision during implementation.
Do not rewrite stored classroom records or invalidate unrelated banking data.
Keep current cost ceilings and bounded retries; a schema retry is not free.

## Acceptance matrix

| Surface | Required evidence before release readiness |
| --- | --- |
| False claims | All four baseline failures reject on the replacement, including hidden claims in headings and extra fields. |
| Binding | Wrong request/snapshot/result IDs, altered filters, same numbers from another tool, duplicate or failed calls cannot substitute for evidence. |
| Population | Current versus archived students, selected subsets versus full class, frozen status, balance conditions, Approved/Pending/Denied, and rent purpose stay distinct. |
| Pagination | Counts derive from the complete matching set; server describes truncation correctly for zero, one, many, and tied results. |
| Names and text | Stable refs preserve ordinary names and `First (n)` / `First X. (n)` collisions; data strings remain bounded escaped labels; memo redaction and quotes remain intact. |
| Dates | Classroom timezone, selected period, current week, explicit dates, available-history limits, and comparison windows remain visible and correct. |
| Teacher tasks | Balances/ranking, who did not pay rent, category totals, status, time comparisons, balance history, and permitted memo questions get correct scoped answers. |
| Interpretation | Natural rephrasings choose the expected tool/filters; wrong-scope and ambiguous requests do not silently look correct. |
| Runtime | Real service path with fake provider; reservation, replay revision, cost accounting, timeout, malformed output, and stale response handling remain correct. |
| Isolation | Two synthetic tenants and session switches establish no cross-classroom reads, displays, or replay reuse; no banking writes are added. |
| Teacher experience | Browser shows a direct useful answer with honest scope and partial-result notices, including errors and clarifications. |

The first implementation slice is narrower than release: a pure result
registry and renderer covering balances and students without matching
transactions, plus the four failure cases. Freeze the required question
corpus before testing the replacement so tests cannot silently shrink to fit
the design. Subsequent slices add the other tools, then integrate the real
local service/browser path. A safe refusal is not sufficient evidence of
useful completion.

## Sequence and decisions

1. **Now:** Muse challenges this design, particularly scope binding, semantic
   coverage, and preservation of the live bank. Return one complete verdict.
2. Codex reconciles the findings and implements the smallest agreed local
   slice using synthetic fixtures and an injected provider. Muse reviews its
   exact frozen artifact and independently tries to break it.
3. Extend the capabilities and connect the existing service/browser contracts
   locally. Run the teacher-question corpus and the relevant existing suites.
4. Report remaining coverage, interpretation, runtime, and live-evidence gaps.
   Andrew separately decides any commit/push, staging exercise, provider call,
   or deployment. A Muse PASS is never a release command.

For changed code, use focused Node tests first. Existing broader entrypoints
are `npm run test:version3:gemini-layer`, `npm run test:version3:insights`,
`npm run test:functions`, and the existing browser suites when the integrated
path is ready. Reuse configured ESLint commands. Emulator commands must retain
their demo-project/credential checks. Do not run Firebase or live-provider
tests as part of the current design review.

Rollback, if a future release is authorized, must restore code/configuration
only and must not restore or roll back classroom transactions. The concrete
artifact and activation plan require review at that later stage. This packet
does not claim the existing live deployment is verified or changed.

## Questions Muse must settle

- Does result selection plus code-owned factual rendering close both the
  disclosure loophole and unchecked factual prose without moving the same
  inference problem into a new free-text field?
- What metadata must be recorded at execution so no view can misstate a tool's
  filters, population, metric, dates, completeness, or source snapshot?
- Is the first slice small enough to validate while preserving an explicit
  path to all ordinary teacher questions listed above?
- What realistic wrong-query, stale replay, label, or privacy case would still
  produce a plausible but incorrect teacher-facing answer?
- Which existing functions should be reused, and which must be corrected or
  replaced? Cite source evidence instead of proposing an unrelated rewrite.
