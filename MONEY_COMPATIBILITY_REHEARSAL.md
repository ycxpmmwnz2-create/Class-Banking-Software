# Money-data compatibility — read-only advisory rehearsal

This implements the scanner portion of the frozen integrity/recovery design N1.
It enumerates current student balances, classroom ledger records, every embedded
mirror, and every Pending decision. It reports problems without changing records,
rounding amounts, denying requests, initializing controls or activating money.
It is a demo-only advisory rehearsal, not a production scan or a frozen snapshot.

## Execution and scope

`scanMoneyCompatibilityRehearsal` accepts only the explicit project
`demo-morgan-bank-money-compatibility`, the default database, an injected SDK
handle reporting those identifiers, and caller-declared emulator host
`127.0.0.1:8080`. There is no SDK creation, credential discovery in the module,
production override, executable CLI or callable export. The environment argument
is a trusted test seam, not proof of the injected handle's actual endpoint. A
misconfigured handle can attempt SDK credential discovery. The guarded emulator
suite creates its handle with explicit loopback host and SSL disabled.

The caller supplies 1–100 unique canonical classroom IDs. They must equal the
entire observed classroom root namespace; no silent subset or omitted classroom.
Each root requires its unique active reciprocal teacher foundation. An invalid
foundation aborts the entire scan, rather than becoming a numeric deferral.
Existing access controls are not changed and do not grant production authority.

All root, student and ledger collections are paginated in document-ID order, 25
at a time, to completion. `listDocuments` before/after each enumeration also detects
missing parent documents with descendants. Namespace disagreement, duplicate or
out-of-order pages, SDK failure, invalid versions, or incomplete scope aborts with
a fixed message/reason and no partial report. Empty student/ledger collections
are valid; an empty project scope is not.

At most 20,000 total root/teacher/student/ledger documents and 100,000 findings may
be retained. Exceeding either aborts the entire scan, never declares a prefix
complete. These are rehearsal resource limits, not product roster limits.
`listDocuments` can enumerate beyond the limit before rejection; there is no
bounded listing-cost promise. Large scopes need a reviewed streaming protocol.

## Compatibility decisions

- Reuse `storedMoneyToCents`: finite numeric balance, absolute maximum $1,000,000,
  and 0.0000001-cent representation tolerance. Ordinary 1.10 passes; 1.001 fails.
  Negative teacher balances are permitted. Nothing is rounded or rewritten.
- Ledger/mirror amounts must be finite and positive. Pending amounts outside the
  new cent domain block compatibility. Finite positive Approved/Denied historical
  amounts outside that domain are legacy-only observations; preserve their exact
  stored values and exclude them from future integer-cent mutation inputs.
  Nonfinite, nonpositive or nonnumeric amounts remain malformed blockers.
- Exact current student and transaction shapes, canonical positive safe integer
  IDs, supported type/status, mirror ownership, duplicate IDs, orphan mirrors and
  every-field ledger/mirror agreement are checked. Historical student names bind
  mirror to ledger, not to today's name. No balance is reconstructed from history.
  Student names and transaction date/studentName/source must contain non-whitespace
  text, matching the app's projection. Values are checked without trimming or
  rewriting; empty reason/memo/category remain permitted. Missing/null settings
  retain the app's default behavior; other settings must be plain data maps.
  Positive numeric IDs and exact untagged transaction keys are intentionally
  stricter than the historical projection's string/zero IDs and optional tenant
  tag. Those cases block for explicit review rather than being coerced silently.
- Removal intentionally retains ledger records. Approved/Denied records for an
  absent student produce a historical warning; Pending for an absent student
  blocks. A current student's missing, wrong or extra mirror blocks.
- Existing `Opening Balance` or `Operator correction` source values, or
  `Balance adjustment` category on a source other than `Teacher`, block pending
  explicit review of collisions with reserved new semantics. Existing Teacher
  balance adjustments remain legitimate history. Configured award categories
  colliding with those reserved values also block. No new reporting classification
  or writer contract is activated by this scanner.
- Report current roster size. More than 100 students produces an explicit-batches
  warning, not a claim that all-class actions fit. Feasibility still needs the
  future per-action planner; 100 is only its target ceiling.
- Report mirror slots and conservative encoded student size. At least 100 slots
  and 100 KiB headroom below the 900 KiB ceiling are required for observed money
  compatibility. Less headroom blocks. At 80% of either cap, report a separate
  history-migration warning. Never trim a mirror, archive or delete history.
- The estimator counts UTF-8 strings at twice their bytes plus field/container/
  scalar overhead and a 1 KiB document reserve, including the path. Unsupported
  encoding blocks. It deliberately overestimates the supported scalar/map/array
  money schema, and is not Firestore billing/index accounting or proof a future
  complete transaction fits. Ledger estimates above 900 KiB also block. The
  emulator stores and scans actual documents on either side of the student
  headroom threshold; it does not prove future mutation/request ceilings.

## Version evidence and privacy

Before returning anything, the scanner re-enumerates every collection and compares
its full path/version set, then re-reads owner versions. Any observed addition,
deletion, edit or actual change-and-restore invalidates the entire scan. Firestore
no-op writes may retain updateTime; detecting those is not claimed.

These separate reads are advisory observations, NOT one consistent snapshot or a
write fence. Transient changes outside observation intervals and writes after a
final comparison remain possible. The output cannot authorize final initialization
or activation. A final production scan needs reviewed operator authority, actual
writer drain/fencing, persistence and revalidation of the retained versions under
that fence. No caller flag can enable a final/production mode here.

Return `{ summary, restrictedManifest }`. Only `summary` is suitable for normal
output: counts and fixed reason codes, with no paths, names, PINs, balances or raw
records. Counts of findings count individual locations: an incompatible historical
ledger amount and its mirror are two legacy-only observations, not two earnings.
The restricted manifest contains explicit scope, document paths/update versions,
per-classroom outcomes, finding locations (mirror index when applicable), and
capacity estimates. No original money values or names are retained. Its timestamp
comes from an injectable invoking-process clock, not Firestore. SHA256 binds the
manifest, not operator identity or authority. The result is deeply immutable and
JSON serializable. This stage has no local file persister; a caller must protect
any separately stored manifest and must not print it as the normal summary.

`compatible-observed` means only no blocking findings in this advisory observation.
`productionEligible` and `activationAllowed` are always false, even with no issues.
There is no exported report consumer capable of initializing or activating data.

## Verification and remaining work

Run `npm run test:phase3:money-compatibility` for the guarded Firestore-only demo
suite: ADC refusal, cleared credential/project variables, temporary CLI config,
metadata discovery disabled, explicit demo project and shutdown. Java, Firebase
CLI and existing dependencies are required; first use may download the emulator.
Use free local ports. The unit suite is included in `test:phase3:unit`; contracts
pin the command and keep both this scanner and the earlier initialization module
out of the deployed Functions import graph.

This stage also corrects the earlier initialization document's endpoint/clock
wording (Stage8 L3) and adds its missing graph assertion (L1). Stage8 L2, foreign
empty-run ownership, remains deferred to operator/recovery design; no initialization
behavior is changed. Pending decisions' eventual balance effects must still be
rechecked by the future money service. No transaction/money correction, operator
audit, client/rules deployment, final scan, maintenance-window claim or release is
included. Node22 and production evidence remain separate from local Node24 tests.

## Protected real-data check preparation

[PROTECTED_MONEY_SCAN_PLAN.md](PROTECTED_MONEY_SCAN_PLAN.md) proposes the separate
operator, maintenance evidence, read scope, private report and acceptance criteria
for a future live check. It is a design awaiting review, not a production runner
or approval to read real data. This rehearsal's hard demo boundary is unchanged.
