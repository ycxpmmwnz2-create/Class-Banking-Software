# Phase 2B test suites

## Commands

| Command | Needs Java/emulator | Needs Chromium |
| --- | --- | --- |
| `npm run test:phase2b:client` | no | no |
| `npm run test:phase2b:build-contract` | no | no |
| `npm run test:phase2b:rules` | yes | no |
| `npm run test:phase2b:browser` | yes | yes |
| `npm run test:phase2b:server` | yes | no |
| `npm run test:rules` | yes | no |

## Item 10 status

A Java runtime is required for the Firestore/Auth emulators and is installed
(Temurin JDK 21). All emulator-backed suites run.

### Verified — actually executed and passing

| Command | Result |
| --- | --- |
| `npm run test:phase2b:client` | 83/83 |
| `npm run test:phase2b:build-contract` | 6/6 |
| `npm run test:phase2b:rules` | 29/29 |
| `npm run test:rules` (hardened) | 36/36 |
| `npm run test:phase2b:server` | 9/9 gate-off + gate-on |
| `npm run test:phase2b:browser` | **1/20 — see below, not green** |
| `npm run lint` | clean |
| `npm run build` | clean, both gate states |

The proposed-rules contract has teeth: reintroducing the recursive
`classrooms/{document=**}` allow into the fixture fails **16 of 29** tests,
including the scoped-credential lockout assertions the plan calls out.

### `npm run test:phase2b:browser` — RUNS, NOT YET GREEN

The suite now executes end-to-end against real emulators (auth, functions,
firestore) with a real Chromium. **1 of 20 passes**: `switching A -> B purges
outgoing state with no intermediate outgoing render`. That one passing test is
genuine — it drives a real account switch and asserts no outgoing sentinel
appears in any MutationObserver record.

The remaining 19 are blocked by one unresolved fixture problem, not 19 separate
problems. Teacher resolution ends in `DENIED_OR_INCONSISTENT` ("Access Denied or
Tenant Inconsistent"), so no cache envelope is written and every downstream
assertion fails on its precondition.

What is established about it so far:

* Auth is correct — the signed-in UID matches the seeded teacher UID, and
  `authAppName()` is `phase2b-emulator-app`, so this is not the bare-`getAuth()`
  bug.
* `resolveTeacherTenantV2` is loaded, invoked, and *returns successfully*
  (~46ms, no thrown error in the Functions log).
* The V2 gate is on for this project via
  `functions/.env.demo-morgan-bank-phase2b-server-test`.
* Collection names and status values in the fixture match
  `functions/phase1/firestoreSchema.js` exactly (`teachers`, `classrooms`,
  `active`), and the resolver's required `teachers/{uid}.uid == uid` field is
  seeded.

So the resolver returns a state the client does not treat as `active` — most
likely `onboarding-required` (whose UI text matches what renders) rather than a
hard error. Confirming that requires capturing the callable's actual return
value, which is the next step. It is a **fixture/seeding** issue inside Item 10's
test scope, not evidence of a production defect, and it must not be reported as
either passing or as a product bug until the return value is read.

### Boot regression this work depended on

`index.html:3453` exported `window.updateStudent = updateStudent`, but commit
`d1765f2` had renamed the definition to `toggleStudentFrozen` while leaving both
the roster Save button and the export on the old name. The resulting top-level
`ReferenceError` aborted the entire inline module, so the app never booted in a
browser — invisible to unit tests, which import the extracted modules instead of
executing `index.html`.

Fixed in a separate commit (`19ec8a7`), with two regression guards in
`tenantClient.test.js`: a general one requiring every `window.X = X` export to
have a matching definition, and a specific one pinning `updateStudent`'s wiring
and Save behavior.

### Emulator project and rules used by the browser suite

The browser suite runs under `demo-morgan-bank-phase2b-server-test` with
`auth,functions,firestore`, reusing the gate-on server project's `.env` contract
so V2 Functions activate. It loads `firestore.phase2b.proposed.rules`, so the
browser and rules suites exercise the same rules.

Seeding goes through `@firebase/rules-unit-testing`'s
`withSecurityRulesDisabled()`, not plain REST. Unauthenticated REST writes are
rejected once the proposed rules load — verified directly:

```
POST .../documents/things?documentId=x
-> 403 {"error":{"code":403,"message":"No matching allow statements"}}
```

Auth user creation stays on REST, since the Auth emulator has no rules layer.

### Auth-app hazard

Specs must never call a bare `getAuth()`. With no argument it resolves the
**default** app — production `morgan-bank`, initialized at `firebase.js` import
time — not the named `phase2b-emulator-app` that the emulator connection rebinds.
A spec doing that would authenticate against production while asserting against
emulator data. All auth goes through `__PHASE2B_TEST__.signInTeacher` /
`signOutCurrent`, which close over `firebase.js`'s live `auth` binding, and
`gotoApp()` asserts `authAppName() === "phase2b-emulator-app"` on every load.

### Harness gotcha worth preserving

Vite's `define` did **not** substitute a bare `__X__` identifier in this served
module — it survived verbatim, threw a `ReferenceError`, and left the harness
silently inert while the page otherwise looked fine. Activation therefore travels
via `import.meta.env.PHASE2B_BROWSER_TEST` (with `envPrefix` extended), which
Vite substitutes reliably. Do not reintroduce the `define`-identifier form.

## Rules fixture

`firestore.phase2b.proposed.rules` is a **contract fixture, never deployment
rules**. `tests/firestore/rules.v2.contract.test.js` loads it explicitly through
`initializeTestEnvironment` and never copies it over `firestore.rules`.

The checked-in `firestore.rules` is pinned by content hash
(`0659a857…cff2cf50`) so any edit during Item 10 fails loudly. The baseline's
recursive `classrooms/{document=**}` allow (`firestore.rules:21-23`) is the
cross-tenant hole the proposal removes; the contract asserts its absence
structurally *and* asserts the baseline still contains it, so the check cannot
silently become vacuous.

## Build-artifact marker reconciliation

The original Item 10 wording required the default-off build to contain no V2
lifecycle markers. That is **not true of this repository and never was**. Four
strings survive tree-shaking in default-off:

```
session-invalidated        multi-tab-invalidation
malformed-broadcast-message   V2_TENANT_DATA_ADAPTER
```

They are reachable from code not gated behind `IS_MULTI_TEACHER_V2_ENABLED`, so
Rollup keeps them. Verified pre-existing by building `HEAD` in a throwaway
worktree and getting identical counts.

The contract instead asserts the four **operational** markers — the channel name,
both storage keys, and the save adapter — are absent from default-off and present
in gate-on. Those are the strings whose presence would mean live transport or
persistence shipping to production. Complete removal of the residual four is a
production refactor, outside Item 10's boundary.
