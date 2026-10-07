# Phase 2B test suites

## Post-Phase-3 multi-account invitation coverage

The current suites also cover the administrator-only teacher invitation
workflow defined in `MULTI_ACCOUNT_INVITATION_IMPLEMENTATION_BRIEF.md`.
Functions-emulator evidence uses real Auth-emulator tokens to prove both the
founding UID and `platformAdmin: true` paths, ordinary and forged denial,
transactional create/revoke behavior, and two complete invited-teacher
onboardings with reciprocal cross-tenant denial under final rules. The browser
suite proves the invitation control is absent for an ordinary teacher and that
the visible administrator flow reaches the real callable without directly
accessing the server-only collection.

Historical Item 10 counts below describe their named checkpoint. Fresh counts
for the multi-account change belong in its final self-verification and review
handoff rather than overwriting that historical record.

## Commands

| Command | Needs Java/emulator | Needs Playwright browsers |
| --- | --- | --- |
| `npm run test:phase2b:client` | no | no |
| `npm run test:phase2b:build-contract` | no | no |
| `npm run test:phase2b:rules` | yes | no |
| `npm run test:phase2b:browser` | yes | yes |
| `npm run test:phase2b:server` | yes | no |
| `npm run test:rules` | yes | no |

The current Playwright configuration runs the browser suite in both Chromium
and WebKit. Each engine receives a fresh credential-isolated emulator lifecycle
so fixture cleanup from one engine cannot affect the other. Historical
checkpoint counts below retain the engine coverage that was actually executed
at those checkpoints. The harness also forces Firestore long-polling only for
WebKit in its explicit demo-emulator configuration so WebKit cannot indefinitely
buffer an open emulator stream; Chromium keeps its normal streaming transport,
and normal development, staging, and production builds do not receive that
setting.

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
| `npm run test:phase2b:server` | 9/9 gate-off + 61/61 gate-on |
| `npm run test:phase2b:browser` | 21/21 |
| `npm run lint` | clean |
| `npm run build` | clean, default-off 450.95 kB; gate-on 467.56 kB |

The proposed-rules contract has teeth: reintroducing the recursive
`classrooms/{document=**}` allow into the fixture fails **16 of 29** tests,
including scoped-credential throttle and victim-lockout prevention assertions.

The gate-on server suite also loads the checksum-pinned Phase 3 final rules and
executes the complete clean-start seam without legacy seeding: a time-bounded
invitation drives normal onboarding, the classroom begins at
`nextStudentNumber: 1`, student creation returns a working login ID, PIN login
mints the expected scoped token, a teacher balance/transaction batch survives
teacher and student reads, both tenant-isolation directions deny, and removal
deletes only the student while deactivating its credential and preserving the
transaction and monotonic counter.

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

The `window.updateStudent = updateStudent` export in `index.html` was present at
that baseline, but commit `d1765f2` had renamed the definition to
`toggleStudentFrozen` while leaving both the roster Save button and the export
on the old name. The resulting top-level `ReferenceError` aborted the entire
inline module, so the app never booted in a browser — invisible to unit tests,
which import the extracted modules instead of executing `index.html`.

Fixed in a separate commit (`19ec8a7`), with two regression guards in
`tenantClient.test.js`: a general one requiring every `window.X = X` export to
have a matching definition, and a specific one pinning `updateStudent`'s wiring
and Save behavior.

### Emulator project and rules used by the browser suite

The browser suite runs under `demo-morgan-bank-phase2b-server-test` with
`auth,functions,firestore`, reusing the gate-on server project's `.env` contract
so V2 Functions activate. It loads the current checksum-pinned
`firestore.phase3.final.rules`. The immutable
`firestore.phase2b.proposed.rules` fixture remains covered separately by
`test:phase2b:rules` and is not expanded for later application features.

Seeding goes through `@firebase/rules-unit-testing`'s
`withSecurityRulesDisabled()`, not plain REST. Unauthenticated REST writes are
rejected once the selected rules load — verified directly:

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
| `npm run test:phase2b:server` | 9/9 gate-off + 61/61 gate-on |
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
# October 1 teacher-money callable candidate

`npm run test:phase2b:server` keeps its gate-off/gate-on demo project and loopback
contracts. The runner now copies public Functions JavaScript and package files
to a disposable runtime with the installed dependency directory linked. It never
reads or changes repository dotenv files. Fictional parameter/disabled-provider
fixtures and isolated CLI configuration are written only in that runtime and
removed afterward. ADC presence is refused; credential/provider/project overrides
are excluded by a system-environment allowlist. Gate-off pins maintenance closed;
gate-on pins normal for the demo runtime only. No release setting is changed.

The new C1 cases use the actual money client and Firebase HTTPS callables to save,
recover a deliberately lost client response, explicitly acknowledge, preserve
pending metadata on onboarding replay, fence a stale plan, and reject anonymous
and foreign-classroom recovery. Gate-off checks include all five added exports.
These are local fictional Auth/Functions/Firestore evidence, not production or
full money-writer containment evidence.


October 4 teacher-writer coverage: approvals/denials, adjustment/reset, separate
profile compare-and-set, immutable-name student replay, lost-response recovery,
and stale/group refusals use the existing Phase 3 unit, Phase 2B client/server,
and offline `node --test tests/browser/money-form.test.js` suites. The server
runner remains isolated to its fixed demo projects; current selected rules are
unchanged. Strict candidate-rule selection and remaining writers are separate.


Stage 3 adds the fixed `student-writers` focus to the gate-on isolated runner:
`node tests/phase2b/runServerEmulatorTests.js gate-on student-writers`.
This selects C2 plus anonymous denial, retaining demo-only project/environment
isolation. Student requests use protocol/controlGeneration/amountCents; removal
also sends captured classroomId. Old requests are deliberately refused.


October 5 Stage 4 creation coverage: existing student-writers emulator focus now
includes receipted positive/negative opening history, replay/PIN binding, old-wire
refusal, cancellation and stale generation. Synthetic/browser tests cover lost
responses, failed refresh, minimal markers and both page engines. Lifecycle
concurrency now expects identical requests to allocate once and a newly
acknowledged request to allocate the next ID. Emulator keys are fictional and
injected only in the disposable demo copy. No production secret or data access.


## Writer containment Stage 5 — credential boundary

The current PIN reset fixture wire includes captured classroomId, protocolVersion
and controlGeneration. Old wire is an explicit negative test. Login replies add
only the access descriptor beside the token; claims remain unchanged. Run the
focused server acceptance with `node tests/phase2b/runServerEmulatorTests.js gate-on
credential-writers` (one shell line): C3 covers current controls; D explicitly
uses unenrolled emulator classrooms for retained trigger compatibility; E/F seed
explicit inactive credentials because enrolled triggers no longer provision them.
These fixture writes use only the already isolated demo emulator.

Phase 2B unit regressions cover post-hash authority changes/retry, pre-mint
pause/resume/reset/removal, readOnly/suspended policy, malformed control and
concurrent enrollment. Actual page handler tests in student-money-form.test.js
cover profile, single and bulk PIN paths in Chromium/WebKit, including a fixed
bulk generation across pause/resume and stale-session refusal before dispatch.

## Writer containment Stage 7 strict-rule profile

`npm run test:phase3:writer-containment:server` runs the complete gate-on suite
against `firestore.phase3.money.rules` in the isolated demo runtime. C1 now checks
opening history plus exactly one recovered award and preserves the entire prior
ledger on stale-plan/cancellation refusal. C2 validates the minimal login access
descriptor and uses plan/execute/acknowledge for its money save; direct balance and
ledger mutation is additionally denied under this profile. No test is skipped to
make the strict rules pass. The existing default profile still selects final rules.
See tests/phase3/README.md for the paired Chromium/WebKit composition and limits.


### CB1 student settings candidate
Student data loads additionally require the narrow `getStudentSettingsV2` callable.
The existing self/rent Firestore paths do not expand. Custom menu and enablement
coverage is in the combined Chromium/WebKit suite; see tests/phase3/README.md.
At this boundary validate both `test:phase2b:server:gate-on` (selected rules) and
`test:phase3:writer-containment:server` (strict candidate rules). Deploy the callable
before its dependent client; no production selection or deployment is implied.
