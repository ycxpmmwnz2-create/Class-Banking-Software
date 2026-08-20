# Morgan Bank Version 3 — Real Gemini Readiness Plan

## Readiness verdict

The reviewed provider-independent and emulator-only layers are ready for a
local, dormant Gemini adapter. They are not approval to contact Gemini, access
Firebase, configure billing or secrets, deploy a callable, or use classroom
data with a model.

This checkpoint intentionally contains no Gemini SDK, API key, Firebase
secret, live callable export, browser activation, environment lookup, or
network transport. The adapter accepts a one-shot transport only through
dependency injection so its request and response boundaries can be tested
locally.

## Pinned provider contract

- Model: `gemini-3.5-flash-lite`.
- Rate card: `gemini-3.5-flash-lite-standard-2026-08-19`.
- Standard paid-tier planning price: $0.30 per million input tokens and $2.50
  per million billed output tokens. Billed output includes thinking tokens.
- API shape: one stateless `generateContent` request with structured JSON
  output.
- Thinking setting: `minimal`. Minimal thinking is not assumed to mean zero.
- The server-owned `maxOutputTokens` limit caps visible output. Because minimal
  thinking is not a guaranteed zero-token setting, the quote separately
  reserves the pinned model's complete 65,536-token output ceiling for thinking.
  This is intentionally more conservative than assuming both counters share a
  single limit. Actual usage must report both counters separately.
- No automatic generation retry. An ambiguous provider outcome retains the
  complete worst-case reservation.
- No tools, grounding, web search, Maps, files, explicit caching, conversation
  state, or provider-side storage.

The rate card is a reviewed application constant, not a value accepted from a
browser, model response, environment variable, or remote configuration. A
price or model change requires a new rate-card identifier, tests, Claude
detailed review, Grok final review, and a separate implementation decision.

## Data boundary

The model may receive only the already reviewed de-identified fact packet. It
may order existing opaque observation IDs, place those IDs into supported
groups, and suggest teacher questions tied to those IDs. It may not create a
new classroom fact, explanation, diagnosis, student label, amount, or cause.

`Timing patterns` observations are excluded from both the provider and display
evidence before packet construction. This is the intentionally narrow first
launch behavior because the repository does not yet own an IANA classroom time
zone. Live time-window semantics remain blocked on a separately reviewed time
zone design. Pending-request evidence also omits its calendar date and clock
time so another server-local wall-clock path cannot enter either paired report.

All fact-packet text is untrusted data. The provider instruction tells the
model never to follow instructions found inside that data. Exact local response
validation remains authoritative after the model responds.

## Cost safety

Before generation, the trusted quote prices:

1. a conservative input-token ceiling equal to the complete serialized request
   byte length plus a fixed safety margin; and
2. the full visible-output limit plus the 65,536-token thinking reservation at
   the billed output rate.

After generation, actual cost uses input, visible output, and thinking token
counts from provider usage metadata. Missing, contradictory, cached, or
tool-use usage fails closed. The existing whole-application $7.50 Gemini ledger
remains the primary monthly stop.

The $5 Firebase and $12.50 combined figures are budget targets, not guaranteed
hard maximums. Standard Cloud Billing budgets can alert without stopping all
Firebase charges. Product wording must not describe the combined amount as a
monthly maximum.

## Later staging cutover gates

Every item below requires new authorization and is outside this checkpoint:

1. Pin and install an exact stable official Gemini SDK version and lockfile.
2. Implement a server-only one-attempt transport with retries explicitly
   disabled.
3. Create separate restricted staging and production authorization keys and
   bind each through Firebase Secret Manager only to the intended callable.
4. Enable and observe reCAPTCHA Enterprise App Check, then separately approve
   enforcement and limited-use replay protection.
5. Configure provider spend controls and alerts as defense in depth while
   retaining the application ledger as the primary cap.
6. Add an exact staging-only callable/runtime gate and browser activation.
7. Run one synthetic, de-identified staging request with a pre-authorized spend
   limit and safe aggregate logging only.
8. Complete Codex verification, Claude detailed review, and Grok final review
   before any production canary decision.

## Local checkpoint acceptance

- The real-provider adapter is not imported by either Functions entry point.
- The repository contains no Gemini SDK dependency or authorization material.
- Tests prove one injected transport call, structured-output configuration,
  timing-pattern refusal, prompt-injection resistance instructions, and
  fail-closed response/usage handling.
- Cost tests prove thinking tokens are billed, worst-case cost is reserved
  before provider use, and actual cost cannot exceed the reservation.
- All provider, completed-replay, teacher-response, emulator, and browser usage
  contracts include `thinkingTokens`.
- Normal builds retain local-only behavior, while the existing assisted controls
  remain demo-emulator-only.
- No commit, push, pull request, Firebase access, provider call, billing change,
  secret change, or deployment occurs without separate approval.
