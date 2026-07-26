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

## Item 10 status — what is and is not verified

Two blockers prevent the emulator-backed suites from running on this machine.
Both are environmental or pre-existing; neither was introduced by Item 10.

### 1. No Java runtime (blocks every emulator suite)

`firebase emulators:exec` requires a JRE. This machine has only the macOS
`/usr/bin/java` stub:

```
$ java -version
The operation couldn't be completed. Unable to locate a Java Runtime.
```

This is **pre-existing**, not caused by Item 10 — the already-committed
`npm run test:rules` fails with the identical error. It blocks:

* `test:phase2b:rules` (new)
* `test:phase2b:browser` (new — needs Auth + Firestore emulators)
* `test:rules`, `test:phase2b:server` (pre-existing)

Fix: install a JDK (e.g. `brew install --cask temurin`), then re-run.

### 2. `updateStudent is not defined` (blocks the browser suite specifically)

`index.html:3453` does `window.updateStudent = updateStudent;` but
`updateStudent` is **defined nowhere in the repository**. The resulting
`ReferenceError` aborts the inline application module, so the app never finishes
booting in a real browser.

Verified pre-existing: present identically at `b3e8800` and `b756f75`, before any
Item 10 file existed.

This matters for Item 10's acceptance: the browser specs in
`tests/browser/tenant-isolation.spec.js` cannot pass against this baseline no
matter how they are written, because the application under test does not reach a
ready state. Repairing it is a **production** change to `index.html`, which
Item 10's tests-only boundary forbids. It needs a separate corrective brief.

### What IS verified

* **Harness injection contract** — confirmed working in real Chromium: the
  harness module executes before the application module, reuses the
  `src/firebase/firebase.js` singleton without a second `initializeApp`, rebinds
  to the demo project, and defines both V2 data adapters. This is the constraint
  the brief flagged as hardest, and it holds.
* **Build-artifact contract** — 6/6 passing, no emulator needed.
* **Client suite** — 81/81 passing.
* **Lint** — clean, including all new `tests/**` files.

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
