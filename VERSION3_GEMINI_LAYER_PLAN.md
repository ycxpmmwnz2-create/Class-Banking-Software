# Morgan Bank Version 3 — Guarded Gemini Layer Plan

## Objective

Add the smallest reviewable server-side contract kernel for a future
Gemini-assisted teacher Insights experience. Morgan Bank remains the sole
calculator of facts. A provider may only prioritize supplied deterministic
observations and suggest teacher questions.

This item is deliberately dormant. It adds no callable export, browser wiring,
provider SDK, secret, Firebase adapter, model selection, billing configuration,
deployment, or network request.

## Acceptance criteria

1. Requests contain exactly a request ID, mode, period, and evidence signature.
   They cannot supply a classroom ID, fact packet, prompt, model, price, or token
   limit.
2. Only `quick` and `deep` modes and the reviewed 7-, 30-, and 90-day periods
   are accepted.
3. The orchestration boundary authenticates and resolves the active teacher
   tenant before loading evidence, and derives every tenant key server-side.
   Its evidence adapter must return an exact envelope containing de-identified
   analysis evidence, an explicit set of removed sensitive values, and a
   signature calculated from the current server-loaded evidence.
4. The service compares that server-calculated signature with the browser's
   expected signature before packet construction. The packet builder receives
   only de-identified evidence, server-derived mode/period values, and that
   server-calculated signature; it never receives the browser request or the
   removed sensitive values.
5. Provider output cannot introduce factual prose or suppress a deterministic
   observation. It must return every supplied observation ID exactly once, may
   group those IDs with a closed vocabulary, and may propose short questions
   explicitly labeled as suggestions and tied to supplied IDs.
6. Unknown keys, malformed values, duplicate or foreign references, excessive
   counts or lengths, invalid usage, and oversized packets fail closed.
7. The one application-wide Gemini monthly allowance is exactly $7.50. Cost
   arithmetic uses integer micro-US-dollars. Firebase retains its separate
   $5.00 allowance and the UI's combined presentation remains $12.50.
8. A trusted worst-case cost reservation and rate-limit decision must complete
   before the provider is invoked. Request IDs are idempotency keys.
9. Once provider invocation begins, malformed output, provider failure, or an
   ambiguous outcome retains the worst-case reservation. Only a validated
   result may reconcile to a lower trusted actual cost.
10. Quick is limited to 4 observations, 12 evidence items, a 16 KiB packet,
    350 output tokens, and 10 requests per teacher/classroom per hour. Deep is
    limited to 20 observations, 60 evidence items, a 48 KiB packet, 900 output
    tokens, and 2 requests per teacher/classroom per hour.
11. Tests use only synthetic classroom evidence, injected fakes, and a fake
    provider. They make no Firebase, emulator, provider, or network call.
12. Existing deterministic Insights remain unchanged and available. No file in
    this item may wire the dormant service into `functions/index.js` or
    `index.html`.

## Permitted files

- `VERSION3_GEMINI_LAYER_PLAN.md`
- `MULTI_TEACHER_ARCHITECTURE_PLAN.md`
- `functions/insights/contracts.js`
- `functions/insights/contracts.test.js`
- `functions/insights/costPolicy.js`
- `functions/insights/costPolicy.test.js`
- `functions/insights/analysisService.js`
- `functions/insights/analysisService.test.js`
- `tests/version3/gemini-layer.contract.test.js`
- `package.json`

## Explicit non-goals

- No `functions/index.js`, `index.html`, Firebase configuration, Firestore
  rules, deployment file, or lockfile change.
- No callable export or browser request path.
- No Gemini SDK, model identifier, rate card, prompt, API key, secret, live
  request, billing action, or budget-console change.
- No Firestore usage-ledger implementation or classroom-data reader. Those
  adapters require a later separately approved emulator-backed slice.
- No report persistence, raw-record persistence, provider-response logging, or
  provider-visible student name, login ID, PIN, UID, classroom ID, auth log, or
  raw transaction.
- No commit, push, pull request, merge, staging/production access, or deployment
  without separate approval.

## Evidence boundary

The focused test command is local and injected. Passing it proves the pure
request, packet, response, cost, reservation-order, and failure contracts. It
does not prove a deployed callable, Firebase transaction, browser flow, Gemini
schema mode, provider pricing, staging behavior, or production behavior.

Run:

```text
npm run test:version3:gemini-layer
npm run test:version3:insights
npm run test:functions
npm run test:phase2b:client
npm run test:phase3:unit
npm run test:phase3:contracts
npm run lint
npm --prefix functions run lint
npm run build
git diff --check
```

## Checkpoint A contract evolution

The original criteria above describe the reviewed dormant kernel and remain as
historical evidence for that slice. The separately approved emulator-callable
Checkpoint A in `VERSION3_GEMINI_EMULATOR_CALLABLE_BROWSER_PLAN.md` supersedes
only its future-wiring assumptions:

- the callable request is now exactly `requestId`, `mode`, and `periodDays`;
  the evidence signature is calculated and consumed only by the server;
- the evidence envelope now pairs a pseudonymized provider report with an
  aligned raw teacher-display report from the same bounded records and clock;
- the provider packet contains no evidence signature, while the schema-v3
  reservation binds the internal signature for replay/conflict detection and
  separates the application cost ledger from tenant rate-limit ledgers; and
- `analyzeTeacherInsightsV3` is reachable only from the dedicated
  non-deployable emulator source when the exact demo project and Auth,
  Functions, and Firestore emulator guards all pass before Firestore is
  obtained. The default Functions entrypoint and package exclude it. It uses a
  fake provider and has no production override.

This evolution does not authorize browser wiring, a real provider, provider
credentials, model or price selection, App Check claims, staging, production,
billing, deployment, commit, or push.

## Teacher question route evolution

The later, separately approved `askTeacherQuestionV3` route uses Gemini only to
interpret a teacher's natural-language question into one through four bounded,
read-only query plans. Firebase Functions remains the sole calculator and the
sole author of factual answer text. There is no second provider pass that may
rewrite, reverse, or otherwise replace the server-calculated conclusion. A
completed request therefore replays the same calculated wording without a new
provider call.

To support explicit custom windows up to 90 classroom days, the evidence
adapter retains a bounded 90-day transaction view before applying the selected
query window. The provider still receives no transactions, balances, amounts,
counts, tenant identifiers, or raw reasons. Its identity and category
vocabulary can include bounded opaque student aliases, single-word subject
hints, and safe category labels derived from that retained 90-day view, even
when the browser's selected summary period is shorter. All facts and final
names remain server-side.

Question-plan schema version 8 broadens the read-only vocabulary so Gemini can
compose unforeseen Morgan Bank questions instead of selecting from a narrow
sentence catalog. Transaction plans may filter by amount range and purpose;
group directly or jointly by student, category, type, status, amount, purpose,
or time dimensions; count distinct values; and apply numeric conditions to
grouped results. Repeated transactions are one composition of those generic
primitives, not a privileged intent. The browser authority, tenant resolution,
evidence signature, provider data boundary, Functions-owned calculation,
reservation, replay, and no-write guarantees remain unchanged.

## Tool-assistant evolution

The teacher question route now has a separately gated version-4 redesign. It
replaces data-blind plan generation with a bounded Gemini function-calling loop
over six server-owned read-only tools. This is the approved general-purpose
route for unforeseen classroom questions. The schema-8 planner remains dormant
code for immediate rollback while the tool-assistant flag is off.

The server still resolves the authenticated reciprocal teacher/classroom pair
before reading any data. The provider receives one classroom only, first names
or first name plus last initial, ephemeral references, safe categories, dates,
and bounded tool results. Memo text is on-demand, contact-sanitized, limited to
500 characters, and marked when truncated. No tool accepts a classroom or
teacher selector, and no write tool exists.

The loop is limited to four provider turns, eight calls, 32 KiB of tool output,
one 60-second overall deadline, and a 1,200-character final answer. The first
turn must call a tool; the final JSON cites executed call IDs. The server rejects
uncited results, opaque refs, unknown two-part identities, output truncation,
malformed usage, and exhausted limits. Transient provider transport errors
receive bounded retries inside that one deadline; request, authentication, and
verification failures do not.
