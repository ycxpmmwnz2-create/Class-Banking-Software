# Stage17: atomic teacher award/deduct service

Candidate for Muse then Claude review. Dormant: not exported by functions/index.js,
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
  acknowledged. No name, balance, memo, PIN or full payload.
- teacherMoneyActors/{key}: SHA-256 of
  ["teacher-money-actor",1,canonicalTeacherUid], with version, actorUid and
  unacknowledgedRequestId (null or the request ID).
- teacherMoneyMetadata/receiptQuota: version and count, bounded at 100000.

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
The 100-target protocol ceiling is not a supported whole-class batch size.
With the current receipt mapping and estimator, the short-ID, empty-history
fixture succeeds at 23 targets and fails at 24 with receipt-size-limit. A
three-target success also verifies every balance/history/ledger and replay.
Longer IDs and larger histories can lower capacity further; 23 is not a guarantee
for arbitrary records. Reads and resulting student writes both charge history
bytes against the 8 MiB budget. No prefix is returned or written if the complete
action cannot fit. A typical 25–30 student whole-class action is therefore not
supported by this dormant component.

Before preview/UI integration, resolve whole-class capacity. The recommended
next design is a compact receipt representation that preserves one atomic
whole-class confirmation and exact replay validation. This is a proposal, not
an implemented or qualified format: it still needs bounded size evidence and
independent review. Do not silently split teacher actions or increase budgets.
History growth remains a separate constraint even if receipt size is improved.

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
