# Morgan Bank Version 3 — AI Insights Plan

## Product objective

Give the teacher useful, calm, evidence-backed observations about classroom
money patterns without crowding Morgan Bank's simple Apple-style interface or
creating unpredictable AI expense.

The product principle is:

> A great deal of intelligence behind a very small amount of interface.

## Approved monthly allowances

- Gemini API: **$7.50**
- Firebase: **$5.00**
- Combined budget target: **$12.50**

These are separate buckets. Gemini usage must not consume the Firebase
allowance. The combined amount is a planning target, not a guaranteed hard cap
on every Firebase charge. A future provider integration must refuse additional
model calls when the application-side Gemini allowance is exhausted even if
provider billing would permit them. The $7.50 Gemini allowance is one
whole-application monthly cap, not a separate allowance per teacher or
classroom.

## First implementation item: provider-independent foundation

### Objective

Create a teacher-only Insights experience that proves the information design,
deterministic calculations, anomaly language, and cost presentation before any
real model call or billing configuration is introduced.

### Acceptance criteria

1. Teacher navigation contains one `Insights` destination immediately after
   Dashboard. Student navigation is unchanged.
2. The Dashboard adds only one compact preview card. It never starts analysis
   automatically and does not display a dense report.
3. The Insights screen uses progressive disclosure, generous spacing, plain
   language, and one clear primary action. It contains no chatbot, prompt box,
   robot imagery, glowing AI treatment, modal interruption, or automatic popup.
4. The screen offers 7-, 30-, and 90-day periods and distinct local previews
   for `Quick Insights` and `Deep Analysis`.
5. Quick Insights shows only the most important observations. Deep Analysis may
   show the fuller deterministic set in quiet sections.
6. The deterministic engine can identify, when supported by the supplied data:
   - student-originated pending Add requests of $20 or more;
   - repeated same student requests;
   - predominant earning and spending time windows;
   - notable current balance outliers;
   - class-period Add/Subtract totals, net movement, and pending volume.
7. Every observation contains a concise explanation plus the concrete evidence
   used to produce it. It does not invent a cause or label a student.
8. The UI displays the approved $7.50 Gemini, $5 Firebase, and $12.50 combined
   allowances. This local item reports $0.00 AI usage because it makes no model
   call.
9. Insights read only the already loaded active-tenant aggregate view. They do
   not read Firestore, write data, change a balance or transaction, persist a
   report, or survive a tenant/session reset.
10. Rendering the Dashboard, opening Insights, changing the period, and viewing
    a local preview make no network or Firebase call.
11. Pure behavioral tests cover the calculations and malformed-record handling.
    A bounded source contract pins the teacher-only wiring and zero-network
    first-item boundary without claiming browser or emulator evidence.

### Permitted files

- `MULTI_TEACHER_ARCHITECTURE_PLAN.md`
- `VERSION3_AI_INSIGHTS_PLAN.md`
- `src/insights/classInsights.js`
- `src/insights/classInsights.test.js`
- `tests/version3/insights-ui.contract.test.js`
- `index.html`
- `package.json`

### Explicit non-goals

- No Gemini, Firebase AI Logic, Vertex AI, Muse Spark, or other provider call.
- No API key, secret, environment variable, billing, quota, or spend-cap setup.
- No Cloud Function, Firestore rule, schema, index, data, Auth, cache, backup,
  migration, staging, production, or deployment change.
- No report persistence or report history.
- No automatic/scheduled analysis.
- No per-student model call.
- No Approvals or Student Profile enhancement in this first item; those remain
  later presentation slices after the main Insights experience is reviewed.
- No commit, push, pull request, merge, or release without separate approval.

## Later real-Gemini item

The provider-backed item begins only after this foundation passes Codex
verification, Claude detailed review, and Grok final review, and Andrew
separately approves the next implementation boundary.

That later item must retain one classwide request rather than one request per
student, calculate arithmetic locally, estimate tokens before sending, cap
thinking and output tokens, report actual usage, cache/reuse unchanged reports,
and keep Quick Insights and Deep Analysis as explicit teacher actions. Provider
configuration, billing, Firebase environment selection, staging, and deployment
remain separate authorization gates.

## Morgan Bank assistant and grounded natural-question engine

The provider-backed teacher experience includes one plain-language Morgan Bank
assistant box. It can answer broadly within Morgan Bank and classroom-economy
teaching, but Gemini is not allowed to calculate or narrate a factual claim
about the current classroom. The browser sends exactly `requestId`, `kind`,
`periodDays`, `timeZone`, and the teacher's question. Functions resolves the
active teacher and classroom, reads that tenant's bounded records, removes
student identities from provider input, and sends only the sanitized question,
up to eight opaque aliases for students named in the question, and a bounded
category-label catalog.

For a classroom-data question, Gemini 3.6 Flash with minimal thinking may
return only a versioned, read-only query plan. That plan can select the student
or transaction dataset; choose a
bounded count, total, average, net, or balance metric; filter by opaque student
or category aliases, type, status, time bucket, or current frozen state; group
by student, category, time of day, day of week, or week; and choose a bounded
order and result limit. Functions validates every field and alias, calculates
the result from server-owned evidence, handles ties, and returns only the
calculated answer and short evidence lines.

Plan schema version 4 also permits one separate negative-match operation for
current students without transactions matching allowlisted criteria. It can
filter by opaque named-student or category aliases, the built-in rent purpose,
transaction type and status, an exact amount, the selected period or the
classroom-local current date, current student state, and a bounded display
limit. The rent purpose is derived server-side from the exact built-in `Rent`
and `Desk rent` labels, including V2 student transactions whose stored category
is blank; raw reasons remain outside provider input. The classroom-local date
is bound into the evidence signature so a completed `today` request cannot be
replayed across local midnight.

For a conceptual Morgan Bank question that does not require a claim about the
current records, the same strict schema permits one bounded guidance paragraph.
The provider receives authoritative product context and may explain features,
suggest classroom-economy routines, or offer teacher-facing ideas. Guidance
cannot claim that records were inspected, characterize a current student,
claim that data was changed, include a URL, or repeat opaque aliases. The
server labels the result as general Morgan Bank guidance and states that no
classroom records were used to make a factual claim. Requests outside Morgan
Bank and classroom-economy teaching, requests to change data, and questions
requiring unavailable information remain unsupported.

One question may also request a classroom fact and advice together. In that
case the provider returns the same bounded data plan plus a shorter,
result-independent guidance paragraph. Functions calculates the factual part,
labels the advice as general Morgan Bank guidance, validates the combined
public response bounds, and exposes nothing if the combined answer is unsafe or
too large.

This supports natural questions such as who has the most restroom visits,
which category a named student earns most in, when students lose the most
money, how many requests are pending, which current students did not make an
exact rent payment today, current or average balances, class size, frozen-account
counts, how to establish a saving routine, or ways to introduce class rent.
A question is refused only when neither the bounded records nor the Morgan Bank
assistant context can answer it safely. Raw transaction
reasons, student names or IDs, tenant identifiers, balances, transaction rows,
counts, and amounts never enter the provider request. The reviewed mixed-release
guard for this contract is `gemini-3.6-flash-morgan-bank-assistant-v3`.

## Verification for the first item

Run, at minimum:

```text
npm run test:version3:insights
npm run lint
npm run build
git diff --check
```

The focused tests are local only. A successful build is not browser,
Firebase-emulator, staging, production, or model-provider evidence.
