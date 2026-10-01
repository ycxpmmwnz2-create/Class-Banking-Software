# Atomic teacher award/deduct service — Stage18 capacity candidate

Stage17 committed as 9ab312a after Muse/Claude review. Stage18 capacity candidate
awaits Muse then Claude review. Dormant: not exported by functions/index.js,
not callable from the browser, and not deployed. Stage16 is committed as 2c1cb0a;
this stage builds on its reviewed calculations. No real-data scanner activation.

## Scope and storage contract

`executeTeacherAwardService` receives trusted server dependencies (Firestore,
auth context, configured project ID and server clock). It snapshots the exact
wire intent, then resolves current reciprocal teacher/classroom ownership within
every transaction attempt. Client-supplied owner, balance, clock and IDs remain
forbidden. Classroom settings provide the action-specific category list; the
service adds only Quick Cash for awards and Classroom Expense for deductions.
Missing/malformed category lists fail closed; no settings are created here.

New actions require active control and matching generation. The same transaction
reads receipt, actor, quota, target students and candidate ledgers; computes the
changes; and atomically updates students, creates ledgers and receipt, and updates
actor/quota. No writes are staged until validation/budget checks finish. There
are no external side effects in the transaction callback.

Server-only metadata beneath classrooms/{classroomId}:

- teacherMoneyReceipts/{key}: SHA-256 of compact UTF-8 JSON
  ["teacher-money-receipt",1,canonicalTeacherUid,requestId]. The stored actor and
  request are also checked. The receipt holds only version, actor UID, request ID,
  generation, status, serverTime, digest, action, itemCount, ledgerIds and
  acknowledged. New committed receipts use version 2; ledgerIds is the canonical
  string `b36:1:<target>:<ledger>,<target>:<ledger>,...`, with each positive safe
  integer encoded in lowercase base36 without leading zeroes, in ascending target
  order. This stores the entire mapping without repeated object-field overhead.
  Replay compares it exactly with the mapping freshly derived from the bound
  request; it never parses or trusts stored numbers. Version 1 object-array
  committed receipts remain readable without rewriting; cancelled receipts stay
  version 1. Unknown versions/encodings or noncanonical mappings fail closed. No name, balance, memo, PIN or full payload.
- teacherMoneyActors/{key}: SHA-256 of
  ["teacher-money-actor",1,canonicalTeacherUid], with version, actorUid and
  unacknowledgedRequestId (null or the request ID).
- teacherMoneyMetadata/receiptQuota: version and count, bounded at 100000.

Receipt schema version 2 is independent of wire protocol version 1. No existing
receipt is migrated. Before any future activation, all receipt readers and
recovery endpoints must understand both committed formats. Rolling back to
Stage17 after creating v2 receipts would make those replays fail closed; retain
compatible readers and use maintenance/readOnly recovery, never delete receipts
or replace request IDs to work around a version mismatch. The service is dormant,
so this stage needs no live migration.

Actor and quota documents MUST already exist from a future reviewed initializer.
An absent or malformed counter is never inferred to mean zero. No initializer,
reset, deletion or counter repair is provided here. Existing terminal receipts
must already be counted, including cancellation tombstones. These collections
need server-only rule coverage before any integration/activation.

Same key/digest returns a validated stored committed result without rereading or
rewriting money. Different digest conflicts. Valid cancelled receipts fence the
key regardless of digest. A different new request is refused while the actor
has an unacknowledged operation. Replay rechecks current ownership/control and
is permitted in active/readOnly, including old generations; suspended denies it.
Receipt status is minimal and requires refresh, never a fabricated current balance.
Warnings reflect the current counter at 80%/95%; they may differ on a later replay.

## Bounds and remaining work

The service accounts for reads plus resulting writes and metadata under 8 MiB,
receipt under 8 KiB and writes under 400. Before each new read it reserves the
Firestore 1 MiB document maximum plus 32 KiB path/wire headroom. The two foundation
reads retain that full conservative charge, allowing SDK timestamp fields without
serializing them. Scalar money/metadata reads settle to the shared estimate;
unsupported encodings or estimates beyond the reserved bound fail closed.
This is conservative accounting, not proof of Firestore index/write size limits.
Stage18 removes the Stage17 short-ID, empty-history 23-target receipt bottleneck
without raising any limit. The 100-target protocol maximum remains a ceiling,
not a guaranteed batch size. Tests cover 3, 23, 24, 30 and 100 empty-history targets,
exact mappings including maximum safe student IDs, same-response replay, corrupt
mapping refusal, legacy receipt replay and an oversized-UID receipt refusal.
Each base36 ID is at most 11 characters; 100 pairs with separators and the codec
prefix occupy at most 2,405 ASCII characters. Receipt metadata and document path
still count toward 8 KiB, so unusually long IDs can still make a receipt fail.

### Chosen whole-class behavior — Andrew approved 2026-09-30

Use one atomic whole-class save only when the entire selected class fits. Otherwise
use smaller, explicitly selected groups, each shown and confirmed separately.
This is the existing §4 explicit-batch policy in the integrity/recovery design.
No automatic splitting, silent partial save, budget increase or history trimming.
One receipt/acknowledgment per deliberately confirmed group; the future UI shows
completed groups separately if a later group fails. A dispatched unresolved ID
must be fenced before selecting a new group. There is no client workflow here.

History still consumes bytes on both read and resulting write. Measured local
fixtures below use short owner/classroom IDs, numeric student IDs, name "Fictional
student", empty memo, Homework category, and the exact entry shape in the tests.
These are regression fixtures, not production thresholds or planner shortcuts:

| Existing history entries per student | Largest tested fitting group | Next size |
| --- | --- | --- |
| 0 | 100 (protocol ceiling) | 101 invalid targets |
| 50 | 54 | 55 rejected |
| 100 | 27 | 28 rejected |
| 200 | 14 | 15 rejected |
| 300 | 9 | 10 rejected |
| 600 | 4 | 5 rejected |

The next sizes above fail the unchanged 8 MiB transaction budget, with no writes.
Long text, mixed histories, long IDs or per-student ceilings change these numbers.
Even a single student may fail; then show a capacity/support path, never trim
history or retry smaller forever. The 1,000-entry and 900 KiB student caps remain.
Actual SDK/emulator tests exercise 30 students with 50 history entries each, 100
with empty histories, and a 14-student group with 200 entries; a 30-student class
with 200 entries is refused in full. They verify atomicity/replay, not production
index sizes or a completed preview/recovery workflow.

The product choice is resolved. Before UI integration, implement and independently
review the existing §4 bounded read-only planner using the SAME receipt encoding
and conservative accounting as execution. It must return only a proven fitting
prefix, retain ordered unplanned IDs, enforce snapshot/version/expiry checks and
require fresh confirmation per group. Do not use the table or failed writes to
choose group sizes. The planner, acknowledgment and dispatch-rejection fencing
remain separate required work; this component must stay dormant until integrated.

Stage16 Claude C1 is addressed by extracting the unchanged estimator algorithm
into moneyDocumentSize.js. The scanner retains its existing exported wrapper and
error contract. moneyCompatibility.js stays excluded from the deployed graph;
the new service is also explicitly excluded while dormant. The release-order
file inventory gains only the paired estimator/service modules and tests.

Before application use: implement/review metadata initialization, status,
acknowledgment and cancellation recovery; bounded preview and dispatch-rejection
fencing; strict rules and UI; other money writers; compatibility qualification;
and the integrated release sequence. This service intentionally leaves the actor
blocked after success until that future acknowledgment operation. Never clear it
manually to make a pilot work. It does not supersede Stage15's scanner NO-GO.

Tests use fictional records: optimistic transaction fakes for retries, revocation,
quota, malformed state and budgets; actual Firestore emulator transactions for
concurrent same/different request IDs, atomic refusal and controlled replay.
Commands: npm run test:phase3:unit, npm run test:phase3:contracts,
npm run test:phase3:teacher-award, npm run test:phase3:money-compatibility,
npm run lint, npm --prefix functions run lint. The guarded emulator command
retains the existing credential exclusions and pins a demo project and localhost.
These are not live, browser, complete recovery or production acceptance tests.
