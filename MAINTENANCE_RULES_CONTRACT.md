# Interim client-write fence — local candidate

`firestore.phase3.maintenance.rules` implements only the application-client rules
portion of §6 step 2 of `TEACHER_MONEY_INTEGRITY_AND_RECOVERY_DESIGN.md`.
It is not deployed, is not selected by `firebase.json`, and does not establish
release readiness or authorize a rollout.

## Exact source boundary

The candidate derives from `firestore.phase3.final.rules`, SHA-256
`f071377d7abf8d1d0009e5b9083a42f3cc7c69cdc6b501f6ea6eaf8bc4791702`.
All create/update/delete/write conditions become literal `false`; all helpers,
matches and get/list/read conditions remain unchanged. Comments identify the
temporary boundary. Private, unmatched and legacy paths retain their denial.
Unused write validators are retained to keep the transformation auditable.
The existing final artifact, legacy artifact and default configuration are unchanged.

This preserves reads relative to that pinned source, not a freshly inspected live
ruleset. Before deployment, verify the actual target/database, active rules and
entire classroom inventory against the release manifest. A mismatch requires
reconciliation and review; do not silently assume this source matches production.

Current reciprocal teachers retain their scoped reads. Current, version-bound
students retain self/rent reads. No client may write, regardless of classroom or
accessControl mode. This interim artifact deliberately does not interpret
accessControl; it is not the future strict control-aware rules. In particular,
existing scoped reads remain possible for a classroom marked suspended. Do not
use it as the final suspension policy or claim it provides sensitive-read control.

## Separate server and release requirements

Admin SDK writes bypass Firestore rules. This candidate does not stop callables,
operators, old revisions, in-flight transactions or queued triggers. Follow the
reviewed `MAINTENANCE_MODE_CONTRACT.md` for admission, including its explicit
balance-history audit exception. Rules denial alone is never proof of drain.
No final scan, control initialization or new money writer may proceed until the
combined fence and bounded drain have independently verified evidence.

The full release still requires inventory/compatibility checks, fictional-data
rehearsal, idempotent initialization and recovery journal, guard-aware services,
strict final rules, compatible client, exact deployed-artifact verification and
explicit classroom resumption. There is no automatic reopening timer. Recovery
must not restore direct money writes after new money operations have occurred;
use the frozen design's compatible recovery sequence.

## Local verification

`npm run test:phase3:contracts` includes the exact transformation contract and
negative mutations restoring writes, widening/removing reads and adding broad
or mixed read/write grants. This source check is not a general Rules parser.

`npm run test:phase3:maintenance-rules` starts and stops an isolated Firestore
emulator and runs `tests/phase3/maintenance-rules.emulator.test.js`. The suite
explicitly loads the maintenance artifact into the fixed fictional project
`demo-morgan-bank-maintenance-rules` on `127.0.0.1:8080`. The guarded command
refuses local Google ADC, scrubs inherited credentials/project/gate variables,
uses a temporary CLI configuration and is covered by automatic command-safety
checks. Java, Firebase CLI and installed test dependencies are required; the CLI
may download the emulator on first use. This project's supplied run uses a cached
emulator. The suite clears only that demo database and uses rules-disabled
synthetic seeding/readback, never real data. Keep the configured local emulator
ports free; do not share a running rehearsal session. No Admin SDK, account login, production
project selection or deployment is involved. Default rules selection is unchanged.

Coverage includes reciprocal two-tenant reads and denied cross-tenant reads,
student credential version/binding checks, private/legacy denials, otherwise-valid
client writes, atomic batches and transactions, and unchanged synthetic data
after denied writes. Before/after discrimination substitutes the pinned original
rules into a disposable test workspace only; it never changes repository rules.

Emulator evidence is not production propagation, server drain, browser/REST
acceptance or a Node 22 target-runtime result. Exact execution evidence and
review status belong in the external release packet.
