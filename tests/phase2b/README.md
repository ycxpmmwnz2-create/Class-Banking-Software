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
| `npm run test:phase2b:client` | 84/84 |
| `npm run test:phase2b:build-contract` | 6/6 |
| `npm run test:phase2b:rules` | 29/29 |
| `npm run test:rules` (hardened) | 36/36 |
| `npm run test:phase2b:server` | 9/9 gate-off + 56/56 gate-on |
| `npm run test:phase2b:browser` | 21/21 |
| `npm run lint` | clean |
| `npm run build` | clean, default-off 450.95 kB; gate-on 467.56 kB |

The proposed-rules contract has teeth: reintroducing the recursive
`classrooms/{document=**}` allow into the fixture fails **16 of 29** tests,
including the scoped-credential lockout assertions the plan calls out.

### `npm run test:phase2b:browser` — GREEN

The suite executes end-to-end against real Auth, Functions, and Firestore
emulators with Chromium. It uses two independently owned teacher/classroom
fixtures and proves both A→B and B→A switching, refresh/cache poisoning,
sign-out reanimation prevention, pre-Auth quarantine behavior, malformed
messages, native BroadcastChannel delivery, the storage-event fallback,
duplicate-delivery boundedness, stale load/save completions, real student
custom claims, and transient versus permission-failure cache behavior.

Every tenant test first proves the expected tenant positively (UID, classroom,
cache envelope, own sentinel rendered, foreign sentinel absent), so an
unresolved or blank page cannot make a denial assertion pass vacuously. Refresh
tests wait on the actual reload instead of navigating a second time. Epoch and
transport effects are asserted as monotonic and bounded rather than exact +1,
because the known observer/orchestrator invalidation paths may legitimately
advance more than once.

The fixtures include the canonical classroom login code and index required by
`resolveTeacherTenantV2`. Scoped credentials are not hand-seeded: the real
`syncStudentProfilesV2` trigger derives them, and the fixture polls for their
observable completion. Two same-name students independently produce the same
`shared-name` login ID in separate classrooms, proving the credential namespace
is tenant-scoped.

### Boot regression this work depended on

The `window.updateStudent = updateStudent` export in `index.html` remained, but
commit `d1765f2` had renamed the definition to `toggleStudentFrozen` while
leaving both the roster Save button and the export on the old name. The
resulting top-level `ReferenceError` aborted the entire inline module, so the
app never booted in a browser — invisible to unit tests, which import the
extracted modules instead of executing `index.html`.

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

## Item 11 completion-gate verification (2026-07-26)

The complete Phase 2B matrix was rerun from local commit `36dc850` before any
Item 11 documentation edit. No Function, rule, migration, client, or fixture
file was changed for this verification.

| Command | Fresh result |
| --- | --- |
| `npm run lint` | clean |
| `npm --prefix functions run lint` | clean |
| `npm run build` (V2 default off) | clean; 450.95 kB / 143.02 kB gzip |
| `VITE_MULTI_TEACHER_V2_ENABLED=true npm run build` | clean; 467.56 kB / 146.75 kB gzip |
| `npm run test:functions` | 357/357 |
| `npm run test:rules` | 36/36 |
| `npm run test:migration` | 38/38 |
| `npm run test:phase2b:server` | 9/9 gate-off + 56/56 gate-on |
| `npm run test:phase2b:client` | 84/84 |
| `npm run test:phase2b:rules` | 29/29 |
| `npm run test:phase2b:browser` | 21/21 |
| `npm run test:phase2b:build-contract` | 6/6 |

The checked-in `firestore.rules` remained byte-for-byte unchanged at SHA-256
`0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50`.
All emulator-backed Phase 2B commands use local emulator hosts; the browser,
server, and proposed-rules commands additionally isolate Firebase CLI config
and refuse local Google ADC. Nothing was deployed or migrated, no production
data service was read or written, and no feature gate was activated outside a
local build/emulator process.

### Verification deviations and accepted limitations

- The repository's exact `npm run test:migration` command passed 38/38, but it
  does not isolate Firebase CLI config itself and the first run observed the
  developer's cached CLI login while still forcing every Admin SDK operation
  to `127.0.0.1:8080`. A second run with an empty temporary CLI config, Google
  credential variables removed, and no ADC also passed 38/38 while explicitly
  unauthenticated. The package-script hardening belongs to a separately scoped
  infrastructure correction, not this docs-only item.
- One additional credential-isolated migration run produced a non-reproducible
  37/38 false positive in the final console-secret scan. That test searches
  random IDs/checksums for the four-character synthetic PIN substrings `2718`
  and `3141`; the unchanged immediate rerun passed 38/38. This is a fail-loud
  test-harness flake, not evidence of a leaked value, and no assertion was
  weakened for Item 11.
- Independent adversarial review of `3be8fb5..36dc850` found no Blocking or
  High Item 10 defect. Its two Medium observations are accepted fail-closed
  availability costs: a malformed message creates a generic quarantine, and
  more than 16 pending UID digests also degrade to generic quarantine. Dropping
  either protection could silently lose an owed invalidation and permit tenant
  reanimation; revisit the blast radius only with a separately reviewed design.

These results close the repository/emulator evidence required by Item 11 and
the Phase 2B completion gate. They do not prove deployment state, real-account
behavior, live onboarding, or production rollout ordering. Phase 3 remains an
architecture/release-planning handoff and requires explicit authorization.
