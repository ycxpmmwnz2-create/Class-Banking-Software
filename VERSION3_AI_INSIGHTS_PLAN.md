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
