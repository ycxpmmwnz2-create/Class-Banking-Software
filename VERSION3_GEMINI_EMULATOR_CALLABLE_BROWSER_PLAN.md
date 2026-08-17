# Morgan Bank Version 3 — Emulator Callable and Browser Wiring Plan

## Status and authority

This began as an acceptance-first design document. Checkpoint A was later
separately authorized and implemented as an uncommitted emulator-only server
slice; Checkpoint B remains unimplemented and unauthorized. Its baseline is
the reviewed and integrated emulator bridge commit
`74a233e3bd75633b44ee9ee0eceac608e181d974`.

The Checkpoint A authorization did not authorize Checkpoint B, a commit, push,
pull request, merge, Firebase access, provider access, model or pricing selection,
secret creation, billing, staging, production, or deployment. Every later
implementation checkpoint below requires separate approval and the normal
Codex implementation, Claude detailed-review, and Grok final-review gates.

Checkpoint A currently proves only the exported `analyzeTeacherInsightsV3`
callable against the exact demo project with the Auth, Functions, and Firestore
emulators, synthetic records, and the deterministic fake provider. No browser
file was changed. The implementation remains uncommitted pending independent
review.

## Objective

Prove the complete authenticated teacher-to-callable-to-browser path against
the Firebase Auth, Functions, and Firestore emulators while retaining the
injected fake provider. The browser may request Quick or Deep assisted analysis
and render an authoritative teacher-visible result, but a normal development or
production build must continue to expose only the existing local deterministic
Insights experience.

The slice must close four review carry-forwards before any real provider work:

1. make the evidence signature server-internal instead of requiring the
   browser to reproduce a server-only hash;
2. bound Firestore collection reads before documents are materialized;
3. reject control characters in every identity used in a digest preimage; and
4. distinguish the persisted validated replay artifact from raw provider output
   and teacher-visible classroom facts.

## Inherited invariants

- Authentication and the reciprocal active teacher/classroom foundation are
  the only tenant authority. The browser cannot submit a teacher UID,
  classroom ID, classroom path, fact packet, prompt, model, price, token limit,
  provider option, or evidence body.
- Morgan Bank remains the sole calculator of facts. The fake provider may only
  order supplied opaque observation references, assign closed-vocabulary
  groups, and suggest bounded questions tied to those references.
- Student names and IDs, teacher/classroom IDs, transaction IDs, raw reasons,
  PINs, login IDs, credentials, auth logs, prompts, and raw classroom records
  never cross the provider boundary.
- Worst-case cost reservation, idempotency, rolling rate limits, and the exact
  7,500,000 micro-USD monthly Gemini allowance complete atomically before the
  fake provider runs. Ambiguous outcomes retain the reservation.
- Existing balances, transactions, deterministic Insights, callables,
  Firestore rules, Firebase configuration, production build behavior, and
  release gates remain unchanged.

## Pinned design decisions

### 1. Browser request and evidence signature

The browser callable request contains exactly:

```text
{
  requestId: string,
  mode: "quick" | "deep",
  periodDays: 7 | 30 | 90
}
```

The browser does not send `evidenceSignature`. The server resolves the tenant,
loads current authoritative evidence once, and calculates the signature from
that evidence. The signature remains an internal stale/replay binding and is
not sent to the fake provider or exposed as a browser trust input.

This intentionally supersedes the future-wiring assumption in acceptance
criteria 1 and 4 of `VERSION3_GEMINI_LAYER_PLAN.md`. An implementation may not
silently drift the contract: it must update that governing text, the contract
validators, and focused tests together in the server checkpoint.

The browser may capture its existing local classroom-data signature solely as
a stale-completion guard. That local value is never authorization evidence and
is never sent to the callable. If local classroom data, tenant epoch, selected
period, or selected mode changes while a request is in flight, the completion
is discarded.

### 2. Provider packet and teacher-visible response

The provider-bound packet contains the current exact-schema metrics and
de-identified observations, but no browser request, tenant identity, removed
sensitive-value declaration, or evidence signature.

The server constructs two deterministic reports from the same bounded records
and the same server clock:

- a pseudonymized report used only to build the provider packet; and
- a teacher display report containing the authorized classroom facts that may
  be returned only to that authenticated teacher.

The two reports must have the same observation count and the same ordered
`priority`, `category`, and `title` values. They are paired by array position
only after those assertions pass, then receive the same server-minted
`obs-NNN` references. Any mismatch fails closed before reservation or provider
invocation. Unit fixtures must exercise every current deterministic observation
generator so this alignment assertion is not a tautology.

The callable response contains exactly:

```text
{
  schemaVersion: 1,
  source: "provider-assisted",
  mode,
  periodDays,
  generatedAt,
  observations: [
    { id, priority, category, title, summary, evidence }
  ],
  orderedObservationIds,
  groups,
  teacherQuestions,
  usage: { inputTokens, outputTokens, costMicroUsd }
}
```

`observations` comes from the teacher display report. The opaque IDs and all
provider-derived fields are validated before the response is assembled. The
browser renders facts only from this server response; it does not try to join
provider references to a separately calculated browser report.

### 3. Replay and persistence boundary

The usage reservation persists only a schema-validated replay artifact:

- evidence signature and original generation time;
- opaque observation ordering and closed-vocabulary groups;
- bounded teacher questions tied to supplied opaque IDs; and
- trusted token counts and reconciled integer-microdollar cost.

The reservation binding includes the internal evidence signature. Reusing a
request ID against different evidence is an explicit conflict even while the
original reservation is incomplete; it cannot inherit or invoke work for a
different classroom snapshot.

It does not persist the raw provider response, provider prompt, provider-bound
fact packet, classroom records, sensitive-value declaration, or teacher display
observations. On an identical completed replay, the server loads current
authoritative evidence, validates the current signature against the stored
artifact, rebuilds the current teacher display projection, and combines it
with the stored validated metadata without another provider call. A changed
signature, malformed artifact, or structural display/provider mismatch fails
closed and cannot return the old result.

Because the ledger has never been deployed, an approved implementation may
raise its schema version rather than add compatibility for discarded emulator
documents.

### 4. Bounded transactional reads

The tenant evidence transaction queries:

- at most `MAX_STUDENTS + 1` student documents; and
- at most `MAX_TRANSACTIONS + 1` transaction documents.

The extra document detects overflow. A result above the approved maximum fails
`evidence-too-large`; no unbounded collection read is permitted. Ownership
validation still occurs in the same read-only transaction before either query.
Tests must inspect the actual query limits and prove an overflow fails before
calculation, reservation, or fake-provider invocation.

This bounds emulator and future operational cost but does not establish a live
Firebase budget. The separate 5.00 USD Firebase allowance remains a later
deployment gate.

### 5. Digest identity hardening

One shared Insights identity validator owns teacher/classroom validation for
the service, evidence adapter, and usage ledger. In addition to the current
type, trim, length, slash, and dot-segment checks, it rejects every C0/C1
control character (`U+0000`–`U+001F`, `U+007F`–`U+009F`). The NUL separator
therefore cannot occur inside either component of a digest preimage.

Request IDs retain their existing closed ASCII pattern. Tests prove that NUL,
newline, tab, and other control-bearing identities fail before a Firestore path
or digest is constructed.

### 6. Emulator-only callable boundary

The future callable name is `analyzeTeacherInsightsV3`. It is exported from
`functions/index.js` only for real Functions-emulator acceptance, but every
invocation must fail before obtaining a Firestore handle unless all of these
conditions hold:

- `VERSION3_GEMINI_EMULATOR_ENABLED` is exactly `"true"`;
- `FUNCTIONS_EMULATOR` is exactly `"true"`;
- the runtime project is exactly
  `demo-morgan-bank-version3-gemini-callable-browser`;
- Auth and Firestore emulator hosts are loopback host/port pairs; and
- the Admin app is available for that demo project.

There is no production override. A malformed, incomplete, non-demo, or
non-loopback runtime returns a generic `failed-precondition` error and logs only
allowlisted operation/category labels. It never logs environment values,
request bodies, tenant IDs, evidence, or error text.

The callable uses the existing active-teacher resolver, bounded evidence
adapter, usage ledger, deterministic calculator, fixed synthetic rate card,
and an injected deterministic fake provider. The fake provider performs no
network I/O and carries no SDK, key, model identifier, prompt template, or
production price.

App Check is not claimed by this emulator-only evidence layer. Before any
callable can be enabled outside the emulator, a separate reviewed cutover must
select and test App Check enforcement, abuse handling, provider credentials,
current model/pricing, and live budget controls.

### 7. Browser activation and stale-operation safety

Assisted controls appear only in the dedicated Version 3 browser-test build
when an exact build flag and injected runtime configuration both select the
same explicit demo project and loopback Auth/Functions/Firestore ports. A
normal development, staging, or production build retains the current local
Quick Insights and Deep Analysis controls, local wording, and zero-API-cost
behavior with no assisted callable path.

The browser client:

- creates a new cryptographically random request ID for a new explicit click;
- reuses that ID only for a retry whose first outcome is ambiguous;
- allows one in-flight assisted request at a time;
- validates the exact callable response before rendering;
- captures tenant/session epoch, mode, period, and local data signature before
  awaiting the callable;
- discards a completion after logout, tenant switch, data change, mode/period
  change, or a newer request;
- clears all assisted response/loading/error state during the existing global
  tenant reset; and
- stores nothing in localStorage, sessionStorage, tenant cache, exports, or the
  classroom aggregate.

Errors map to short allowlisted teacher messages. Raw Firebase categories,
request data, provider data, ledger state, and identifiers never render or log.

### 8. Time-zone evidence limit

Both server reports use the same injected clock, so their provider/display
alignment is deterministic. This emulator slice does not establish the
classroom time zone required for live timing-pattern semantics. Fixtures must
avoid daylight-saving and time-window boundaries, and the browser must render
the server-returned facts rather than recalculate them locally.

A server-owned classroom time-zone design is a stop condition before any live
provider or staging deployment. Emulator success must not be reported as proof
that UTC and the teacher's local time are product-equivalent.

## Acceptance criteria

1. Gate-off, wrong-project, non-loopback, unauthenticated, student-authenticated,
   disabled-teacher, missing-foundation, and reciprocal-owner-mismatch calls
   fail before evidence, ledger, or fake-provider use.
2. Callable input has exactly `requestId`, `mode`, and `periodDays`; every
   tenant, evidence, provider, price, prompt, and signature field is rejected.
3. The evidence signature is calculated server-side, binds reservation/replay,
   and is absent from the browser request and provider payload.
4. Student and transaction reads use real query limits of maximum plus one and
   reject overflow before calculation or reservation.
5. Control-bearing identities fail before path or digest construction.
6. Raw and pseudonymized deterministic reports align structurally or fail
   before provider use; every current observation generator is covered.
7. The exact provider payload contains no raw tenant/student/transaction/reason
   identifier and no evidence fingerprint.
8. The browser response contains authoritative teacher display observations
   paired with validated opaque provider metadata.
9. Stored ledger/reservation data contains no raw provider response, prompt,
   fact packet, display observation, teacher/classroom/request identifier, name,
   raw reason, or transaction ID.
10. Completed replay performs no second provider call and returns display facts
    only after current evidence and stored metadata validate.
11. Two synthetic teachers prove bidirectional tenant separation in the real
    Auth, Functions, and Firestore emulators.
12. Concurrent reservations, allowance exhaustion, Quick/Deep rolling limits,
    conflicting request reuse, malformed state, provider failure, and ambiguous
    completion retain the already reviewed fail-closed behavior.
13. The dedicated browser build proves the authenticated teacher click, loading
    state, safe rendering, replay, bounded error state, and no duplicate call.
14. Real-browser tests hold a callable response, then prove logout, tenant
    switch, local data change, period change, and a newer request make the late
    completion inert in both Chromium and WebKit.
15. Gate-off and normal production builds contain no visible assisted controls
    and preserve the current local deterministic experience.
16. Test wrappers refuse local Google ADC, scrub credential/project/gate
    variables, use isolated Firebase CLI configuration, start only the three
    loopback emulators, and target only the explicit demo project.
17. No test, build, or source-contract result is represented as provider,
    App Check, pricing, staging, production, billing, or deployment evidence.

## Future implementation checkpoints

### Checkpoint A — Server callable and three-emulator acceptance

Expected scope:

- update the governing Version 3 plan/architecture text for the internal
  signature and validated replay-artifact boundaries;
- add the shared Insights identity validator;
- refactor the request, packet, display, replay, bounded-read, and ledger
  contracts described above;
- add one emulator-runtime/fake-provider callable adapter;
- add the guarded `functions/index.js` export;
- extend unit/source-contract coverage; and
- exercise the exported callable through real Auth, Functions, and Firestore
  emulators with synthetic tenants.

No browser or production-build change belongs in Checkpoint A. Its commit and
Claude detailed review must close before Checkpoint B begins.

Expected file families are limited to this plan and the architecture record,
`functions/index.js`, `functions/insights/**`, the focused Version 3 contract
and emulator tests, `package.json`, and the exact non-secret demo-project
Functions dotenv needed to resolve the repository's existing declared
parameters non-interactively. That dotenv is scoped only to
`demo-morgan-bank-version3-gemini-callable-browser` and is excluded from
Functions deployment packaging. No `firebase.json`, rules, indexes, dependency,
lockfile, or deployment file change is expected.

### Checkpoint B — Gated browser wiring and real-browser acceptance

Expected scope:

- add one exact-schema provider Insights browser client and unit test;
- add default-off Insights UI state/rendering/reset integration;
- add a dedicated test-only Vite/harness/fixture/Playwright path for the
  explicit Version 3 demo project;
- prove Chromium and WebKit stale-completion and tenant isolation behavior;
- prove a normal build retains only local deterministic Insights; and
- update the plan/architecture evidence record.

Expected file families are limited to `src/insights/**`, `index.html`, focused
Version 3 source-contract and browser files, a dedicated Version 3 Playwright
configuration, `package.json`, and the two governing documents. It must not
modify the existing Phase 2B browser harness behavior, Firebase configuration,
rules, indexes, dependencies, lockfiles, or deployment files.

## Verification required during implementation

Checkpoint A must define and pass focused commands equivalent to:

```text
npm run test:version3:gemini-layer
npm run test:version3:gemini-callable:emulator
```

Checkpoint B must define and pass focused commands equivalent to:

```text
npm run test:version3:gemini-browser:chromium
npm run test:version3:gemini-browser:webkit
```

Before either checkpoint is presented for commit/review, also run the
proportionate regression boundary:

```text
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

Each command result must state its evidence layer. Emulator and browser success
remain local synthetic evidence only.

## Explicit non-goals

- No Gemini or other provider SDK, API endpoint, model, prompt template, live
  provider rate card, API key, secret, network call, or real provider response.
  The fixed synthetic emulator rate card is test data only.
- No App Check activation, billing, budget-console action, staging/production
  project access, deployment, migration, rules/index change, or existing-data
  mutation.
- No production feature flag, production callable enablement, background job,
  scheduled task, stream, queue, report export, report sharing, or persistence
  of teacher display facts.
- No change to balances, transactions, approval flows, credentials, PINs,
  authentication logs, deterministic Insights facts, or local Insights
  availability.
- No claim that the fake rate card or emulator cost proves current provider
  pricing or the separate Firebase allowance.
- No commit, push, pull request, merge, branch cleanup, or deployment without
  separate approval.

## Stop conditions before implementation or live expansion

Stop and request a new decision if:

- the teacher display report cannot be paired with the provider report without
  exposing or persisting sensitive facts;
- the callable cannot fail closed outside the exact demo/loopback emulator
  runtime before creating Firebase handles;
- existing Functions discovery or legacy/V2 exports change under gate-off;
- browser acceptance would require changing the normal production experience;
- a provider SDK, current model, live pricing, App Check, secret, billing,
  staging, production, or deployment decision becomes necessary;
- a classroom time-zone choice becomes necessary for live semantics; or
- the target branch moves and the approved baseline is no longer exact.
