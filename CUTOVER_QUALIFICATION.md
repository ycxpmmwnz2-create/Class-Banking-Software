# Bundle A — local qualification candidate and blocking capabilities

## Scoped amendment — accepted 2026-10-08

For the one controlled Morgan Bank maintenance release,
[CONTROLLED_MAINTENANCE_CONTRACT.md](CONTROLLED_MAINTENANCE_CONTRACT.md) takes
precedence only for its explicitly listed assurance and D1 sequencing substitutions.
Andrew accepted those reviewed substitutions on 2026-10-08. The original text below
remains historical evidence and governs every requirement not replaced. Existing
demo-only guards, advisory report schemas and production-ineligibility flags are
unchanged; they cannot certify the new operational standard. No live evidence or
cloud/private-data authority follows from this amendment.


Status (2026-10-07): **partial Bundle A; NO-GO for production**. The reviewed
`PRODUCTION_MONEY_CUTOVER_PLAN.md` remains the authority. This candidate provides
bounded fictional readers/reports, a static capability status command, and a
concrete local transport limitation. It does not complete Bundle A, supply live
identity, or qualify a production collector/launcher. Application writers, rules
selection, deployment configuration and the RC2 release artifact are unchanged.

## Implemented boundary

`functions/operator/cutoverQualification/` is operator-only and not imported by
Functions. The only CLI, `npm run cutover:qualification-status`, prints fixed public
code-capability status without constructing a reader, finding credentials, reading
a file or accepting arguments. Caller-supplied evidence cannot change NO-GO.

The read adapter accepts only `demo-morgan-bank-cutover-qualification`, default
database, literal HTTP `127.0.0.1:8080`. It refuses real project IDs before dependency
access. It has no SDK, ADC, metadata discovery, custom endpoint, redirect, retry,
write or provider call. `Bearer owner` is the local emulator convention, not a
credential. Reader/clock injection in reports is a fictional test seam, not an
attestation, sandbox or production adapter. No live-reader API is implemented.

Inventory lists the complete classroom namespace including missing-parent entries,
then checks masked root and reciprocal active teacher records. Duplicate owners,
phantom roots, empty/oversized scope, invalid foundations/control, foreign tenant
tags and observed drift refuse the whole report. Valid absent, active, readOnly
and suspended controls are classified without mutation. This report does not
verify audits, credentials or money compatibility and cannot initialize anything.

Provider reporting enumerates all months and each reservation's dispatch children,
including missing parents. It checks schema3/4 reservation metadata, derived IDs,
request/scope/generation binding, statuses, times, dispatch indices 1–4 and sequence.
It reports legacy/no-dispatch evidence, orphan parents and malformed metadata
separately from claimed/uncertain/finished records. It excludes stored answers,
prompts, cost/evidence payloads and unrelated fields. It does not certify the
unread full reservation payload. No settlement, cancellation or expiry occurs.

Both operations re-enumerate and compare versions/content. This detects observed
changes; it is **not an atomic snapshot or a complete interval fence**. A later
change or a transient create/delete can escape these comparisons. Every result
has false production/initialization/activation eligibility and snapshot consistency.
`completion/coverage: COMPLETE` means only that this bounded metadata traversal and
revalidation finished; malformed provider metadata still sets `recordState: UNKNOWN`.
`providerDrain` is always UNKNOWN, including an empty or wholly finished namespace.
Read/pagination/resource/drift failures discard all partial counts (`counts: null`).
Fixed diagnostics never interpolate raw SDK errors, records, paths or arguments.

### Explicit masks and resource ceilings

- Names: `__name__`; root: `ownerUid`, `classroomId`, `accessControl`;
  teacher: `uid`, `classroomId`, `status`.
- Reservation: schema, scope/request/ledger digests, month, status, reservation time,
  control generation. Dispatch: schema, reservation/request/scope binding,
  generation, index, status, claimed/finished times, outcome.
- 25 records/page, 100 classrooms, 20,000 provider records including descendants,
  40,000 validated document observations including rereads; 512-byte relative
  paths, 4,096-character page tokens; repeated cursors/duplicate or unordered paths
  and empty continuing pages refuse. Missing parents are not silently discarded.
- 8 MiB per HTTP response, 64 MiB cumulative HTTP input and separately 64 MiB
  normalized report input, 32 MiB output; 10-second per-request/read timeout and
  15-minute operation lifetime. Bounds are checked before publishing any report.
  JSON decoding is bounded by response size; metadata decoding by depth/node caps.
- Inventory and provider reports are separate operations. Running both permits up
  to 128 MiB combined HTTP input and 30 minutes total. No private file publisher or
  production 30-minute authority implementation exists in this candidate.

All report objects are restricted/private even though tests use fictional data.
There is no report-sharing CLI. The Stage10 money-summary consent does not cover
provider statistics, IDs or new journal information. No sharing extension is
implemented. The following fixed proposal is available for review and later owner
approval; it does not extend existing consent:

- `schemaVersion: 1`, `kind: "provider-claim-summary"`;
- `completion` and `coverage`: COMPLETE or UNKNOWN;
- `recordState`: UNKNOWN or NO_UNRESOLVED_METADATA_OBSERVED;
- `providerDrain: "UNKNOWN"`, `productionEligible: false`,
  `initializationAllowed: false`, `activationAllowed: false`;
- `counts`: null for incomplete coverage, otherwise exactly nonnegative totals
  `reservations`, `dispatches`, `reserved`, `uncertainReservations`, `claimed`,
  `uncertainDispatches`, `finished`, `legacyWithoutDispatch`,
  `missingDispatchEvidence`, `orphanParents`, `malformedRecords`;
- `category`: null after completed traversal or one of the fixed refusal categories
  live-unavailable, scope, transport, budget, expired, drift, foundation.

No IDs/digests, paths, teacher/classroom rows, timestamps, amounts, request/answer
text, raw diagnostics or free text. Counts may overlap: they are evidence categories,
not a sum of exclusive states. UNKNOWN is not zero. Even all-zero unresolved counts
do not prove provider drain or permission to proceed. This is a proposed schema,
not a serializer, approved export channel, or real-data collection request. Until
explicit consent, every provider result remains private.

## Discovered emulator limitation — do not hide it

Firestore emulator **1.21.0** returns unmasked fields when `ListDocuments` uses
`showMissing=true`. A fictional classroom `settings` sentinel and provider `result`
sentinel reproduce this. Masked single-document GET works. The installed API
contract promises list masks and missing-parent enumeration, but this observed
emulator combination does not uphold the mask. Changing query spelling did not
fix it. Local bytecode inspection corroborates that the missing-parent branch
bypasses the ordinary projected query path; this is not a production API claim.

The reader refuses unexpected raw field keys before metadata decoding; it does
not discard extra fields and call the operation privacy-safe. The response has
already reached the fictional process, so refusal is not proof of data minimization.
Successful emulator provider traversal uses explicitly metadata-only fixtures and
proves pagination/missing-parent/version behavior only. Full classroom traversal
is exercised with synthetic transport fixtures; the actual emulator inventory
refuses when roots contain fields outside the names mask. These limitations are
retained as negative regression tests, not relabeled successful masking tests.

Local source anchors (not remotely verified documentation):

- Installed `@google-cloud/firestore` **7.11.6**, bundled
  `build/protos/google/firestore/v1/firestore.proto`, `ListDocumentsRequest`:
  page token, default name order, mask, and `show_missing` phantom semantics.
  SHA-256 `a1576de51f042d9d021613d32e8950b80b8fd5900bb4a70af040ebe490dd2b79`.
- Emulator JAR 1.21.0 SHA-256
  `c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e`.
- Node **22.23.3** is printed in verification logs. No dependency update occurred.

## Real-platform capability assessment

Every production capability remains **UNVERIFIED**. The local emulator's masked
missing-parent list combination is **UNSUPPORTED in the tested emulator**, which
does not establish either support or impossibility on production. No cloud API,
private credential, live report or external platform configuration was inspected.

| Capability | Current evidence / gap | Required discriminating staging evidence |
| --- | --- | --- |
| Bounded masked missing-parent reader | Installed ListDocuments contract; emulator limitation above | Separate real-platform adapter with explicit nonproduction target; >25 records, phantom-only parents, restricted-field sentinels, pagination and wire-byte/deadline refusal; prove the masked response, not just filtered output |
| Explicit credential and effective IAM | No qualified credential adapter; demo guard only | Short-lived explicit principal provenance/expiry; exact target; effective inherited/group grants and impersonation reach; unavailable/expired/mismatched principal rejected before reads; no ambient fallback |
| Complete deployed writers | Source inventory is not platform inventory | All routable revisions/routes, triggers, queues, schedulers and operator writers, with independent enumeration/completeness and retry/transaction/provider lifetimes |
| Complete interval and drain | No qualified history/completeness boundary or collector endpoint | Inject reopen/reclose, delayed/missing history, queued old revision, provider timeout and delayed settlement; independently prove continuous coverage through publication or return UNKNOWN |
| Client denial propagation | Emulator rules tests are not release propagation | Exact staged release hash plus valid fictional authenticated SDK/REST/batch/transaction attempts; account for every serving revision and propagation boundary |
| Credential/audit reconciliation | No bounded private live verifier | Separate restricted credential consistency checks and admitted-event reconciliation; distinguish unresolved retries from terminal historical gaps without exposing credentials |
| External operator exclusion | Existing same-host cooperative OS lock is insufficient | Competing process and external Admin/configuration writer attempts throughout the interval; independently verified exclusion and failure handling through publication |
| Private launch/publication | Static status CLI only; no private launcher/publisher | Human-only Terminal outside all agent read scopes; clean-source/runtime hashes, authority/expiry/principal binding; exclusive no-follow owner-only storage, readback/durability and storage-failure refusal |

These are evidence requirements, not implemented collectors. Source/version for a
real collector, its exact endpoints and its completeness guarantee are still
unavailable. Do not accept boolean `verified` flags, repeated snapshots, quiet logs,
a fixed sleep or more emulator tests as substitutes. Do not remove the demo guard.

**Next unresolved work:** determine whether the real platform can supply effective
identity, complete writer/interval evidence and a safe masked missing-parent reader.
Prepare a separately scoped private staging qualification only after those adapter
contracts are concrete. If complete-interval evidence is unavailable, return the
specific gap for a reviewed contract decision. Do not advance a live implementation
or declare Bundle A complete on the strength of this candidate's local PASS.

Bundle B retains the closed design review's carryforwards: explicitly reconcile
absent-only initialization versus active-to-readOnly transitions; retain restrictive
controls; bind exact journal/epoch and audit schemas; keep abandonment under the
same OS lock without force unlock; budget transaction retries and whole-scope reads.

## Verification entrypoints

- `npm run test:phase3:qualification:unit`
- `npm run test:phase3:qualification` (isolated local demo emulator only)
- `npm run test:phase3:unit`, `npm run test:phase3:contracts`, `npm run lint`
- `npm run cutover:qualification-status` (public, static NO-GO only)

The review packet retains initial failed masking expectations, diagnostic evidence,
and final refusal tests separately. Muse Spark at xhigh then Claude review this
bounded implementation; neither PASS is production qualification or release authority.
