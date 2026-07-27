# Phase 3 test suites

## Progress against Section 13

| Commit | Scope | State |
| --- | --- | --- |
| 1 | Acceptance contracts and credential-isolated commands | complete |
| 2 | Production environment, project, and authorization guards | complete |
| 3 | Read-only production preflight and manifest | complete |
| 4 | Copy-only production projection and reconciliation | complete |
| 5 | Production writer and crash/restart recovery | complete |
| 6–11 | Lifecycle, client, rules, rehearsal | not started |

Commit 5 adds the bounded production writer, its append-only durable journal,
and the read-only re-verifier. The writer owns exactly two remote mutations: one
atomic initialization transaction that reserves the classroom login code and
sets the student counter on an ALREADY EXISTING foundation, and a bounded series
of copy transactions. It contains no delete API, no Auth mutation, and no
control-plane mutation.

Release Order steps 9–12 require two deployment states, so `write.js` is
journal-driven across **two invocations**. There is no stage flag, mode
argument, or resume switch: the stage is derived solely by replaying the
journal, and the copy branch is reachable only from an
`awaiting-copy-deployment` event that only a verified initialization can append.
The first invocation stops with a distinct `ACTION_REQUIRED/AWAITING_DEPLOYMENT`
result and a nonzero exit code, so it can never be mistaken for a completed
migration.

`reverify.js` is remote read-only and local state read-only. It does not import
`productionWriter.js` — a structural guarantee, since the writer is the only
module holding transaction code — and `release-order.contract.test.js` asserts
that plus the absence of any mutating call path. Commit 3's preflight remains
read-only with respect to Firebase and Google services, and `preflight.js` still
imports no writer, projection, or reconciliation module.

Student lifecycle, client wiring, rules artifacts, and deployment logic remain
unimplemented.

## Commands

| Command | Needs Java/emulator | Needs Chromium |
| --- | --- | --- |
| `npm run test:phase3:contracts` | no | no |
| `npm run test:phase3:unit` | no | no |
| `npm run test:phase3:migration` | yes | no |

`test:phase3:contracts` selects `tests/phase3/*.contract.test.js` — deliberately
**not** `*.test.js`. The broader glob would also select the emulator-backed runner
suite and execute it with no emulator running. The command-safety contract asserts
the narrowing and that no `*.emulator.test.js` file matches it.

`test:phase3:migration` starts the Firestore and Auth emulators, so automatic
discovery in `command-safety.contract.test.js` applies the complete isolation
contract to it with no special-case entry.

`test:phase3:unit` runs the colocated `functions/phase3/*.test.js` suites. Per
Section 12 as amended it is **emulator-free** and therefore needs no Firebase CLI
isolation wrapper — it must not start the CLI, an emulator, or any network-backed
operation. `command-safety.contract.test.js` asserts that: the gate must execute
`functions/phase3`, must have at least one suite to run, and must contain neither
`emulators:exec` nor a bare `firebase` invocation.

Four Section 12 gates remain **deliberately undeclared** —
`test:phase3:rules`, `test:phase3:migration`, `test:phase3:release-rehearsal`,
`test:phase3:rollback-rehearsal`. A passing placeholder under any of those names
would report green for work that does not exist; the command-safety contract
asserts their absence and will admit each one only alongside the suite it runs.

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
scrub every credential/token/project/config/emulator/gate variable — including
`MULTI_TEACHER_V2_RELEASE_ID`, added in Commit 2, since a leaked release
identifier could satisfy the production branch of the V2 gate during a local
run — set
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

## Commit 2 — production guard unit suite

`functions/phase3/productionEnvironment.test.js` is **behavioral**, not static:
every case invokes the real guard functions and asserts the actual outcome and
error category. Environments are injected rather than read from `process.env`, so
the negative cases are exhaustive without contaminating the test runner.

It proves the guards' decisions — exact-project allowlist (rejecting
`morgan-bank-staging`, case variants, and padded lookalikes), emulator
host/flag leakage into production, ambiguous or unparseable project sources,
loopback-only emulator hosts, strict `v2Enabled === true`, release-ID matching,
complete write authorization with every prohibited override key refused by name,
and redacted telemetry that never carries a project or release value.

Project identity resolves from **three** routing sources — `GCLOUD_PROJECT`,
`GOOGLE_CLOUD_PROJECT`, and `FIREBASE_CONFIG.projectId`. All present sources must
agree exactly, checked pairwise across the full set rather than two at a time. No
value is trimmed, normalized, or coerced: `" morgan-bank"` is refused rather than
silently accepted as production, because padding is evidence of a misconfigured
caller. `GOOGLE_CLOUD_PROJECT` is included because the repository's isolation
contract already classifies it as project-routing — omitting it would let a
contradictory value pass here while another SDK layer honored it.

**Absent and present-but-blank are different.** Only a genuinely absent source —
one nothing set, or whose value is `undefined` — may be ignored. A defined
routing variable holding `""`, `"   "`, `null`, an array, or a number blocks, and
so does a present `FIREBASE_CONFIG` that is blank, unparseable, not an object, or
carries no usable `projectId`. This matters because a malformed source would
otherwise vanish behind whichever source happened to be valid: something set that
variable and failed, and the failure has to surface. The suite pins the specific
guard by message, since several of these checks share one error category and
asserting the category alone cannot tell them apart.

A contract assertion in `command-safety.contract.test.js` couples every
`PROJECT_ROUTING_VARIABLES` member, plus `FIREBASE_CONFIG`, to
`REQUIRED_SCRUBBED_VARIABLES` and to the actual text of every discovered emulator
command. The two lists are related by intent rather than derivation, so without
that check a future commit could teach the guard about a new routing variable and
forget the scrub.

Reviewed release identifiers must already be canonical strings. Coercion is
deliberately absent: `String(123)` would let a numeric `expectedReleaseId`
authorize release `"123"`, so a caller reading the value from JSON or a
spreadsheet cell could authorize a release it never named.

It does **not** prove that any future runner calls these guards, that production
state matches any assumption, or that a release executes correctly. Wiring the
guards into an entrypoint is a later commit's evidence.

One assertion deserves note for reviewers: an explicitly passed
`environment: undefined` must throw rather than silently fall back to
`process.env`. A parameter default would have made `validate(maybeEnv)` check the
ambient process while the caller believed it supplied a constrained context. This
applies to every public guard surface, including the exported
`resolveRuntimeProjectId`.

## Commit 3 — preflight and manifest suites

`functions/phase3/productionPreflight.test.js` and
`productionManifest.test.js` are **behavioral**. `production-runner.emulator.test.js`
is **emulator-backed**: it drives the real `runPreflightMain` against live
Firestore and Auth emulators and asserts pre/post state equality to prove zero
remote writes.

The deployment inventory — Rules releases, Functions revisions, Hosting releases —
is **injected** in the emulator suite. The Firebase emulators do not emulate those
control planes, so there is nothing live to read. The unit suite drives the real
fixed-endpoint control-plane client with fake HTTP responses and proves GET-only
requests, redirect rejection, deadlines, complete pagination, preview-channel
coverage, and inventory caching. Every Firestore and Auth observation in the
emulator suite is genuine and now runs through the same data-reader implementation
the production entrypoint selects; there is no parallel emulator-only reader.

The emulator suite runs under `demo-morgan-bank-phase2b-server-test`, the single
demo project Commit 2's allowlist permits. Giving this suite its own project would
have meant widening `ALLOWED_EMULATOR_PROJECT_ID`, weakening a security guard for
test convenience; the suite conforms to the guard instead. It supplies
`FUNCTIONS_EMULATOR=true` explicitly because `emulators:exec --only auth,firestore`
does not set it (no Functions emulator runs) while the guard requires it.

### Phantom-parent enumeration — found during this commit

A Firestore document that holds only subcollections does not exist as a document:
`collection('classrooms').get()` returns **zero** rows while its subcollections
remain fully readable. Verified against the emulator — after writing
`classrooms/x/studentCredentials/ada` with no `classrooms/x` document, `get()` saw
0 and `listDocuments()` saw 1.

A destination-absence check built on `get()` would therefore have been **blind to
scoped credentials orphaned under such a parent** — exactly the pre-existing V2
data the check exists to catch. Destination enumeration and the pre/post snapshot
both use `listDocuments()`. `COLLECTION_ENUMERATION_REQUIREMENT` records the rule
for the production reader implementation, and a source guard fails if the emulator
suite reverts to `get()`.

### Manifest project scope

`validateProductionManifest` accepts the production project or a `demo-` project.
The rehearsal therefore exercises the real validation and persistence path rather
than a weaker variant. A rehearsal manifest still cannot authorize a production
write: the future writer requires the production project ID, which a demo manifest
never carries.

### What these suites do not prove

Nothing here proves production state, deployed artifacts, real-account behavior, or
that a later writer honors a retained manifest. No test contacts production. The
emulator suite installs one real manifest only under its disposable demo identity,
then verifies and removes exactly that test-owned path; it never removes or
overwrites an operator manifest and leaves `functions/phase3/.state/` empty.

## Commit 4 — copy projection and reconciliation suites

`functions/phase3/productionProjection.test.js` and
`productionReconciliation.test.js` are emulator-free behavioral suites. They
exercise pure values only and do not construct a Firebase handle, load a
credential, touch a manifest, or contact any service.

The projection suite proves that the classroom patch, students, transactions,
login history, scoped credentials, and scoped authentication logs are derived
deterministically without mutating their sources. It pins the Phase 2A helper
dependency for legacy data and the Phase 2B helper dependency for credentials.
Every flat credential field is preserved except `classroomId` and `authUid`, the
new Auth UID is deterministic, active/inactive/orphaned credentials all survive,
and no projected destination can be a flat credential path.

The reconciliation suite has separate dry-run and write-run surfaces. Dry-run
recomputes the projection from source. Write-run compares caller-supplied
post-copy reads against every expected destination path, body, and count and
checks UID mappings, the exact five-field student allowlist, total balance, and
scoped-log shape. It also compares the legacy singleton, every flat credential,
every flat log, and the teacher foundation against their original bodies and
exact update times. Mismatches report only area, reason, and path — never
document bodies or secret values.

These tests do not prove production behavior. Commit 5 adds the writer that
applies the projection and the emulator rehearsal that exercises it.

## Commit 5 — production writer, journal, and re-verifier

`functions/phase3/productionWriter.test.js` is an emulator-free behavioral suite
over the writer's decision logic, journal, and recovery classifier. Its
Firestore doubles implement genuine transaction semantics — reads observe a
snapshot, writes are buffered until commit, a forced retry discards them, and
`set()`/`delete()` throw — so the retry-safety and read-before-write assertions
exercise real behavior rather than a mock's echo.

It proves manifest v2 write-eligibility (including that each precondition blocks
independently of the summary `writeEligible` flag), login-code recovery from the
re-presented authorization artifact without the manifest ever retaining the raw
code, the append-only hash-chained journal, exclusive atomic install with
same-sequence arbitration and fork rejection, file and directory fsync, journal
secret scanning, deterministic plan ordering with the 400-write and 8-MiB
bounds, the exact initialization write set with full field preservation, source
and target preconditions, batch recovery classification, stage derivation, and
deployment-expectation comparison.

The Commit 5 block in `production-runner.emulator.test.js` runs the same paths
against **live Firestore and Auth emulators** with a real on-disk journal in an
isolated temporary state root. It proves that the first invocation writes
exactly the classroom root and the code index and that every copy surface
remains absent; that a gate-on inventory refuses the copy stage and writes
nothing; that re-initialization cannot renumber the counter or overwrite the
code index; that flat credentials, the legacy source, the teacher document, and
Auth users are never mutated; that re-verification changes no Firestore or Auth
state; and that a real committed transaction followed by a deliberately failed
journal event recovers by read classification **without duplicate writes**,
while a divergent target blocks instead.

### Evidence limits specific to Commit 5

The control-plane inventories (Rules releases, Functions revisions, Hosting
releases, gate parameters, active writers) are **injected** in the emulator
suite, because the Firebase emulators do not emulate those control planes at
all. Every Firestore and Auth observation is genuine; no deployment observation
is. The emulator is not production. The supplied snapshot ID, write-freeze
proof, credential provenance, and authorization ID are operator-entered strings
that are recorded and bound — they do **not** cryptographically prove that a
snapshot, freeze, provenance statement, or human approval exists.

## Relationship to the Phase 2B matrix

These suites supplement, and never replace, the complete Phase 2B and repository
matrix recorded in [../phase2b/README.md](../phase2b/README.md).
