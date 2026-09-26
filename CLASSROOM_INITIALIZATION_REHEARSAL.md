# Existing-classroom initialization — foundation rehearsal only

This local candidate rehearses a bounded part of the frozen integrity/recovery
design §6 step 3: inventory existing classroom foundations, add missing readOnly
controls and recover from interrupted initialization. It is not a production
initializer, a money-data compatibility scanner, a write fence, or an activation
path. No deployed Functions export or client imports it.

## Hard execution boundary

Both exported functions accept only `demo-morgan-bank-classroom-init`, the default
database and the exact local emulator host `127.0.0.1:8080`. They require an
explicit matching injected Firestore handle; there is no SDK creation, credential
discovery, default project or production override. The environment argument is a
trusted test seam, not a user-controlled callable request. This is a rehearsal
module, not an IAM authorization mechanism or protection against a malicious
caller supplying a fake SDK. No production CLI is provided.

Run `npm run test:phase3:classroom-initialization`. The command uses the existing
ADC refusal, variable scrubbing, temporary CLI configuration and cleanup wrapper.
It starts only the Firestore emulator and stops it on success or failure. Java,
Firebase CLI and installed dependencies are required; first use may download the
emulator. Keep configured local ports free. The tests use fictional data only.
`npm run test:phase3:unit` covers the paired local unit tests;
`npm run test:phase3:contracts` covers command safety and permitted source files.

## Inventory and saved plan

The planner performs explicit read-only transactions. It pages all existing
classroom root documents in document-ID order, 25 per page. It also uses
`listDocuments` before and after to detect phantom roots with descendants but no
parent document. Empty scopes, more than 100 roots, missing parents, malformed
IDs/versions and incomplete or inconsistent enumeration fail; no subset is
silently selected. UTF-8 ordering matches Firestore document names.

Every root must name an active, reciprocal teacher foundation. Every accessControl
must be absent, its entire audit collection empty, and the operation's run record
must not already exist. Retained audit history blocks reinitialization even if a
control was removed; the rehearsal provides no deletion or reset operation.
Already-controlled classrooms—including active onboarding classrooms—are rejected,
never reset or silently skipped. A future production transition must explicitly
reconcile those classrooms through the separate control-transition protocol.

The restricted plan contains project/database, a 32-hex operation ID, a validated
server-clock ISO instant, sorted classroom/owner IDs, exact seconds/nanoseconds
update versions and a digest binding all these values. It contains no names,
PINs, balances or raw records. Store the plan as a restricted local artifact if
rehearsing process restart; this stage provides no local file persister. JSON
round-trip is supported. The executor validates and detaches the plan before any
await; a digest is integrity binding, not a signature or grant of authority.

This is a foundation inventory, not complete money compatibility evidence. No
students, ledger/mirrors, Pending amounts, capacity, numeric precision or encoded
sizes are scanned. The emulator deliberately preserves an incompatible fractional
balance and never issues compatibility approval. The future version-bound
compatibility scan remains mandatory before any production initialization.

## Atomic initialization and durable recovery

The server-only `classroomInitializationRuns/{operationId}` document binds the
operation, digest, timestamp, project, total count and completed count. Each room
gets `classrooms/{classroomId}/accessControlAudits/{operationId}`. Both paths are
client-denied by the current final and maintenance rules' explicit allowlists.
They are new rehearsal journal paths, not enrolled production operator tooling.

Before creating the run record, and before each classroom write transaction, the
executor reads the complete root query, all owner foundations, this run record and
every audit collection (empty or exactly the expected witness). Unfinished roots and owners must match the saved versions.
It then atomically updates only the root's accessControl to schema1/readOnly/
generation1, creates its audit and increments the run count. All other root fields,
students, money, credentials and history are untouched. No control is deleted,
no existing generation reset, and no room becomes active.

Completed rooms must have the exact expected control and audit, unchanged owner
version, and equal database-assigned updateTime on the root/audit pair. Firestore
assigns that pair's versions in the same transaction. A separately changed then
restored root or audit therefore conflicts even if final values match. A no-op
write may retain updateTime and is not claimed detectable. Stored timestamp
transforms are not equated with updateTime; their precision can differ.

The run count must equal the number of exact completed pairs. Missing/tampered
journal, audit, changed scope/time, broken foundation or version drift halts the
whole rehearsal. Callback retries re-read all conditions. SDK ABORTED (code 10) becomes a sanitized
`retryable-conflict`; competing runs can exhaust SDK retries. Explicit replay
with the same saved plan is required, not a fresh operation or success claim. A lost response after
commit resumes from server readback using the original saved plan; already
completed pairs receive no writes. Fresh planning after partial initialization
is intentionally rejected. A new operation ID cannot overwrite prior controls.

Final readback validates all rooms and counts in a read-only transaction plus
namespace checks. The only public success result is counts, readOnly mode and
literal `productionEligible: false`, `activationAllowed: false`. A run document
with zero or partial completion is not success. There is no activation API/timer.

## Limits and remaining release work

Repeated namespace checks and version comparisons do not establish a production
write fence. In particular, out-of-transaction namespace enumeration cannot prove
absence of a transient phantom root under concurrent external writers. Real
maintenance admission, old/in-flight/trigger drain and independently verified
client-rule propagation must precede the future production final scan. Rehearsal
success must never be used as authorization or a cutover-ready signal.

The bounded algorithm re-reads the full foundation scope for each transaction;
work grows quadratically, with a hard 100-root ceiling. Namespace listDocuments
may enumerate more than 100 references before rejecting; the ceiling bounds the
plan and write scope, not that initial listing cost. SDK read/transaction/time
limits can still reject an otherwise valid plan; failures do not grant partial
success. Larger inventories require a separately designed and reviewed protocol.

Still unfinished: full compatibility scanning, production operator authorization
and CLI, local artifact persistence, live project/rules/inventory binding,
existing-control transitions, real drain proof, strict final rules, compatible
client/services, complete release rehearsal and verified deployment. This stage
adds a local foundation rehearsal and tests only. Node22 and production behavior
are not established by Node24 emulator evidence.
