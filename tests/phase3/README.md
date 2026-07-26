# Phase 3 test suites

## Commit 1 scope

Commit 1 adds **acceptance contracts and credential-isolated emulator
commands** only. It contains no Phase 3 production implementation: no runner, no
student lifecycle service, no client data projection, no rules artifacts, and no
deployment logic. Those arrive in Commits 2–11 per
`PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md` Section 13.

## Command

| Command | Needs Java/emulator | Needs Chromium |
| --- | --- | --- |
| `npm run test:phase3:contracts` | no | no |

The five future behavioral gates named in Section 12 —
`test:phase3:unit`, `test:phase3:rules`, `test:phase3:migration`,
`test:phase3:release-rehearsal`, `test:phase3:rollback-rehearsal` — are
**deliberately not declared yet**. A passing placeholder under one of those
names would report green for work that does not exist.
`command-safety.contract.test.js` asserts their absence.

## Evidence layer — read this before citing these tests

Every suite in this directory is **static/source evidence**. Each suite parses
repository text (`package.json`, the reconciled brief, `index.html`) or checks
filesystem and checksum facts. Every test title begins with `source contract:`
or `boundary:` for that reason.

These suites prove:

- the declared emulator commands **carry** the credential-isolation contract;
- the brief still **states** the safe release and rollback ordering;
- Commit 1 has **not** created later-commit artifacts or edited `firestore.rules`;
- the current client identity/adapter/login facts are exactly as surveyed.

These suites do **not** prove:

- that credential isolation works at runtime — nothing here starts an emulator
  or the Firebase CLI;
- that a production release or rollback executes correctly in the stated order;
- any behavior of the Phase 3 runner, student lifecycle, tenant data service,
  or rules — none of that code exists yet;
- anything about deployed production state, which remains unknown by design.

Per `AI_COLLABORATION_WORKFLOW.md` rule 7, do not present these results as
emulator, browser, or production acceptance evidence.

## Suites

### `command-safety.contract.test.js`

Parses the root `package.json` scripts and requires each emulator-backed command
to refuse local Google ADC, use a temporary isolated Firebase CLI configuration,
scrub every credential/token/project/config/emulator/gate variable, set
`METADATA_SERVER_DETECTION=none`, and target an explicit `demo-` project. It also
rejects deploy, `--force`, production-project, and non-loopback-host markers
across **all** scripts.

**The command set is discovered automatically**, not maintained by hand. Any
script whose text contains `firebase emulators:exec` is included, so a new Phase
3 emulator command is subject to the full isolation contract the moment it is
added — no list to remember to update. A complement assertion proves no
emulator-launching script escaped discovery, and the set is asserted nonempty (an
empty set would make every isolation assertion pass vacuously) and to include
`test:migration`.

Aggregator scripts such as `test:phase2b:server`, which only chain other npm
scripts, are correctly skipped: they carry no emulator invocation of their own,
and the commands they delegate to are discovered and checked individually.

`test:migration` is brought under this contract in Commit 1. Before the change it
had none of these protections and targeted the non-`demo-`
`morgan-bank-migration-rehearsal`, so the Firebase CLI could attempt real project
resolution — recorded as a deferred limitation in
[../phase2b/README.md](../phase2b/README.md) and closed here.

The suite carries **negative controls**: a hardened fixture that satisfies every
matcher, plus one mutation per protection that must be rejected. Without those, a
matcher that always returned true would let the whole suite pass vacuously.

Two further controls cover discovery itself. A synthetic **unprotected** emulator
command must be discovered *and* rejected by every matcher — the exact regression
a hand-maintained list allowed. A synthetic **hardened** command must be
discovered *and* accepted, so the first control cannot pass merely because the
matchers reject everything indiscriminately.

### `release-order.contract.test.js`

Parses Section 9 of the brief into its numbered steps and asserts foundation
before bridge rules, bridge rules before the first scoped credential, final rules
before gate enable before gate-on Hosting, and reconciliation before activation
with an abort on mismatch. It parses the rollback sequence separately and asserts
Hosting default-off before gate disable before rollback-safe rules before legacy
writes resume.

Parsing the section into steps matters: a raw `indexOf` over the whole document
would also match the identical wording in Sections 2 and 7 and could pass for
the wrong reason.

Boundary assertions pin that the three future rules artifacts, `functions/phase3`,
and `src/phase3` are absent, and that `firestore.rules` still hashes to
`0659a857…cff2cf50`. The suite additionally asserts the baseline file **still
contains** the recursive `classrooms/{document=**}` allow, so the checksum pin
cannot become vacuous if the file were replaced by something unrelated.

### `student-identity.contract.test.js`

Pins the current client identity facts that Phase 3 must change.

Verified and pinned:

- exactly one live student allocator, `max(roster)+1`, with one
  `data.students.push` site;
- all seven `Date.now()` ID sites are transaction/login-history records, proven
  by required `studentId`/`studentName` siblings and the absence of
  `const newStudent` — these are **not** student allocators;
- exactly nine `id:` literals total (1 allocator, 7 transaction/history, 1
  read-only claim echo in `dataForSecureStudent`), so a new site cannot appear
  unclassified before the Section 5 watermark is derived;
- both V2 data adapters are referenced by the client but never defined by it —
  they are defined **only** by the Item 10 browser harness, which activates
  solely under an explicit test flag;
- V2 persistence fails closed with `missing-v2-save-adapter` rather than writing
  the legacy blob;
- student login still calls legacy `studentPinLogin({loginId, pin})` with no
  `studentPinLoginV2` wiring and no classroom-code input.

**Pinned defects.** Some assertions deliberately require a *known defect* to
still be present: `importBackup` accepting unvalidated imported student IDs
through `normalizeData`, and `addStudent` placing a plaintext `pin` on the roster
object. They are pinned so the Section 4/5 requirements that depend on them
cannot be quietly dropped. When Commits 6–8 fix these, the owning commit is
expected to **update** these assertions to the new contract — not delete them.

## Relationship to the Phase 2B matrix

These suites supplement, and never replace, the complete Phase 2B and repository
matrix recorded in [../phase2b/README.md](../phase2b/README.md).
