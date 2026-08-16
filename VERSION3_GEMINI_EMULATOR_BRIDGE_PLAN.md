# Morgan Bank Version 3 — Emulator-Only Gemini Bridge Plan

## Objective

Connect the reviewed dormant Gemini contract kernel to production-shaped
Firestore adapters inside a Firebase demo-project emulator. The slice proves
tenant-derived evidence loading, de-identification, deterministic fact-packet
construction, idempotent usage accounting, rolling hourly limits, and the
$7.50 monthly Gemini allowance while using only synthetic classroom data and
an injected fake provider.

The bridge remains unreachable from the deployed application. It adds no
callable export, browser request, provider SDK, secret, billing configuration,
staging access, production access, deployment, or live model request.

## Acceptance criteria

1. The bridge resolves the authenticated teacher through the existing
   reciprocal teacher/classroom foundation before loading evidence.
2. The evidence read revalidates that foundation in the same read-only
   Firestore transaction that loads only the resolved classroom's `students`
   and `transactions` collections.
3. Student names and IDs, teacher/classroom IDs, raw transaction reasons, and
   raw transaction IDs are removed before deterministic evidence crosses the
   provider boundary. The adapter supplies a server-calculated lowercase
   SHA-256 evidence signature and a non-empty declaration of removed sensitive
   values.
4. The existing deterministic Insights calculator runs over pseudonymized
   records. The packet builder emits only exact-schema opaque observation and
   evidence references; it receives neither the browser request nor sensitive
   values.
5. A Firestore transaction atomically enforces per-tenant/per-month accounting,
   rolling per-mode hourly limits, request idempotency, and the exact $7.50
   Gemini allowance before the fake provider may run.
6. A completed identical request replays its stored validated result without a
   second provider call. A conflicting reuse, active/uncertain reservation,
   malformed ledger record, rate-limit refusal, or allowance refusal fails
   closed.
7. Provider failure or an ambiguous outcome retains the worst-case reservation.
   Successful reconciliation may reduce it only to a trusted actual cost no
   greater than the reservation.
8. Concurrent reservations that together exceed the allowance cannot both
   succeed.
9. Emulator evidence uses two synthetic teachers/classrooms and proves both
   tenant directions, stale signatures, no provider-visible identifiers, and
   separate budget scopes.
10. The emulator command refuses local Google ADC, scrubs credential/project/
    emulator/gate variables, uses an isolated Firebase CLI configuration, and
    targets only `demo-morgan-bank-version3-gemini-bridge` on loopback.
11. The reviewed 7-, 30-, and 90-day periods, deterministic UI, Firebase rules,
    existing callables, and all production configuration remain unchanged.
12. No bridge module is imported by `functions/index.js`, `src/`, or
    `index.html`.

## Permitted files

- `VERSION3_GEMINI_EMULATOR_BRIDGE_PLAN.md`
- `MULTI_TEACHER_ARCHITECTURE_PLAN.md`
- `functions/insights/analysisService.js`
- `functions/insights/analysisService.test.js`
- `functions/insights/tenantEvidenceAdapter.js`
- `functions/insights/tenantEvidenceAdapter.test.js`
- `functions/insights/factPacketBuilder.js`
- `functions/insights/factPacketBuilder.test.js`
- `functions/insights/firestoreUsageLedger.js`
- `functions/insights/firestoreUsageLedger.test.js`
- `tests/version3/emulator/gemini-bridge.test.js`
- `tests/version3/gemini-layer.contract.test.js`
- `package.json`

## Explicit non-goals

- No `functions/index.js`, `index.html`, `src/`, Firebase configuration,
  Firestore rules, index, lockfile, deployment file, or existing data change.
- No live callable or browser integration.
- No Gemini SDK, model selection, API key, secret, billing, budget-console
  action, provider pricing, or network request.
- No staging or production access and no real teacher or student data.
- No persistence of raw classroom records, raw reasons, names, IDs,
  credentials, PINs, auth logs, or provider prompts/responses.
- No commit, push, merge, pull request, or deployment without separate approval.

## Verification

```text
npm run test:version3:gemini-layer
npm run test:version3:gemini-bridge:emulator
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

The emulator command proves local Firestore transaction behavior against a
synthetic demo project. It does not prove deployed Functions, browser behavior,
provider behavior, pricing, billing, staging, production, or real-account
behavior.
