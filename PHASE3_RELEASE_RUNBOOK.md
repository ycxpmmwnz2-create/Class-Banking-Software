# Phase 3 release and rollback runbook

Status: **local rehearsal evidence only; not production authorization**

This runbook binds the reviewed Phase 3 release order to executable local
rehearsals. It does not authorize a production read, write, deployment, gate
change, Hosting change, or rollback. Each production phase requires the
separate approvals required by `AI_COLLABORATION_WORKFLOW.md` and
`PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md`.

## What the local rehearsals prove

`npm run test:phase3:release-rehearsal` uses only explicit `demo-` projects and
fresh, credential-isolated Firebase CLI configuration. Its runner half uses
real local Auth and Firestore emulators, the real production preflight/write/
reverify modules, two real writer invocations, and the checksum-pinned bridge
and final rules. Its browser half starts a fresh Auth/Functions/Firestore
emulator lifecycle and runs Chromium under the final rules.

The release ledger also models control-plane transitions that a local emulator
cannot perform: maintenance freeze, Functions deployment, server parameter
change, Hosting deployment, acceptance sign-off, and rollback-window
observation. Those ledger entries prove ordering and fail-closed transitions;
they are not evidence that any production control plane changed.

`npm run test:phase3:rollback-rehearsal` uses a real local Firestore emulator
and the checksum-pinned final and rollback-safe rules. It proves legacy data
and flat credentials remain unchanged, scoped credentials remain stored but
client-denied, legacy teacher/student acceptance works, and writes cannot
resume before acceptance. Hosting rollback, gate disable, freeze, and
acceptance sign-off are modeled ordering controls only.

Neither rehearsal reads production, deploys anything, changes `firestore.rules`,
uses ambient credentials, or proves current production state.

## Immutable rules artifacts

Record and independently compare all four hashes before any authorized release:

| Artifact | SHA-256 | Purpose |
| --- | --- | --- |
| `firestore.rules` | `0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50` | unchanged legacy baseline; never redeploy after scoped credentials exist |
| `firestore.phase3.bridge.rules` | `4bf76a85e576a1d5b30573c3c3d5eba0d3561fb9d9a19ac14ac6382dced8d7f0` | gate-off migration bridge |
| `firestore.phase3.final.rules` | `414ab5cad328b4b254fe4397ec891f0b7639548c324d2ae0ee74c8db0a9639f3` | gate-on V2 policy |
| `firestore.phase3.rollback.rules` | `c81a058e260502fe31c4240d547dcd731f130eb85be3a3c185caae681e4ef19d` | default-off recovery policy |

Never copy a candidate over `firestore.rules` for testing. The rehearsals load
the checksum-pinned candidate bytes directly. Never deploy the recursive
baseline rules while scoped credentials exist.

## Required local gate

Run from a clean reviewed checkout, with no Google Application Default
Credentials present:

```text
npm run test:phase3:contracts
npm run test:phase3:unit
npm run test:phase3:migration
npm run test:phase3:rules
npm run test:phase3:release-rehearsal
npm run test:phase3:rollback-rehearsal
```

Any failure blocks release preparation. Preserve the command, commit SHA,
artifact hashes, pass/fail counts, and redacted failure category. Do not rerun
with a force, production override, alternate project, or relaxed rules.

## Evidence record

Use an append-only record with one row per transition:

| Field | Required content |
| --- | --- |
| `sequence` | monotonically increasing integer |
| `event` | exact approved transition name |
| `timestampUtc` | UTC timestamp from the operator record |
| `actor` | approved human/operator identity, not a token |
| `changeId` / `releaseId` | reviewed non-secret identifiers |
| `projectId` | exact expected project |
| `commitSha` | reviewed source commit |
| `artifactSha256` | applicable immutable artifact hash |
| `evidenceSha256` | hash of the separately retained redacted evidence file |
| `result` | `passed`, `blocked`, or `rolled-back` |
| `notes` | redacted counts/categories only |

Never record credential contents, private keys, access/refresh tokens, PINs,
PIN hashes, cookies, `.env` contents, or unredacted student data. A secret in
evidence is an abort, not something to sanitize after continuing.

## Production release sequence

The following is an operator checklist, not permission to execute it.

### Superseded retained-artifact gate

Commit `773ac6c70eebac2db89b1394052e20a39ff7b831` changed the Functions surface
digest algorithm by canonicalizing only `eventTrigger.eventFilters` order. All
control-plane inventory and preflight-expectations artifacts retained before
that commit are historical evidence only. Preserve them unchanged, but never
reuse them, copy their Functions digests into a new artifact, or accept digest
equality as proof that they are current.

This gate is process-enforced. The inventory artifact records its producing
commit, but neither it nor the preflight-expectations artifact carries a digest-
algorithm identifier, and the expectations artifact carries no producing-
commit field. A historical value may therefore either mismatch or
coincidentally equal the corrected value if its source response was already in
canonical filter order.

The normal N9/N10 sequence repeats exactly two observations at the final clean
reviewed commit with the one read-set transition placed between them. The
**base-role observation** runs while the candidate identity still holds only
the existing `phase3ControlPlaneInventoryReader` custom role and
`roles/firebasehosting.viewer`, before the stable Firestore/Auth read layer is
bound. Under its own separate IAM mutation authorization, the reviewed stable
Firestore/Auth reader (Role A) is then bound and its exact definition and
binding are verified. Role B remains unbound. The **final-read-set
observation** runs only after that verification, with the base roles plus Role A
forming the frozen read set.

Each observation is itself a production `inventory.js` run and requires its
own separately approved, time-bounded, checksum-bound inventory authorization
and explicit credential. There is no unauthorized preliminary diagnostic. If
the required comparison passes, the final-read-set observation is the fresh
inventory that receives Claude and Grok review. Its deployment and active-
writer values are the sole inventory source for those fields in the new
preflight-expectations artifact; every other required field retains its own
separately reviewed source. No third inventory run is required solely for
expectations authoring.

The two observations must agree exactly on all five deployment surfaces and
active-writer classification; any mismatch aborts unless a separately
authorized triangulation procedure proves its cause and receives review.

The normal result is exactly four preserved files in
`functions/phase3/.state/`: the superseded historical inventory and preflight
expectations plus two new immutable N9/N10 inventory artifacts. A triangulation
fallback or a selected N11 route that changes the deployed surface adds another
separately authorized observation and requires updated file accounting and
review. After a new preflight-expectations artifact is separately approved,
authored, and retained, the normal count becomes five before preflight. A
successful preflight then adds its immutable manifest as the sixth file; later
writer artifacts follow their separately verified state accounting. Never
delete, overwrite, or repurpose a superseded file.

### Open blocker: Functions copy-expectations predictability

`PHASE3_FUNCTIONS_COPY_EXPECTATIONS_PREDICTABILITY` (N11) remains open and
High. Complete post-deploy Gen2 function resources contain server-assigned
fields, while the copy expectations that describe them are bound before writer
invocation 1. Routes A, B, and C remain unselected and unauthorized. Route B
may use an already deployed and observed gate-off surface for both
initialization and copy expectations, but selecting any route requires a
separate bounded review.

Until one route is selected, do not author a preflight authorization, run
preflight, finalize expectations, author write authorization, prepare a
deployment, or invoke writer invocation 1. The two separately authorized
N9/N10 inventory observations may proceed while N11 is open, but they do not
resolve it. Neither the unchanged-read stability correction, IAM verification,
emulator fixtures, local canonicalization tests, parameter defaults, nor an
approximated or hand-authored digest can close N11.

The deployed-Rules checksum limitation remains separately open at the later
Rules/release boundary because the observed deployed checksum does not match a
checksum-pinned repository Rules artifact. N11 does not close that limitation,
and Rules evidence does not close N11.

1. Complete local implementation, required independent review, and every local
   gate above. Record the reviewed commit and artifact hashes.
2. Make a separate human decision about a least-privilege explicit credential
   and its IAM bindings. While the candidate still holds only the base
   control-plane role and Hosting Viewer, obtain one time-bounded,
   checksum-bound authorization for the base-role control-plane-only inventory
   observation. The authorization is tied to `morgan-bank`, the reviewed
   commit, change/authorization identifiers, credential provenance, and the
   exact credential SHA-256. Its interval must be no more than two hours, and
   the actual anchored checkout must have that exact HEAD with a clean worktree.
3. Run only `functions/phase3/inventory.js` for the authorized base-role
   observation, with its three required inputs: full reviewed commit SHA, that
   observation's inventory-authorization file, and the explicit credential
   file. Retain its immutable local `inventory-<sha256>.json` artifact.
4. Only under a separate approved IAM mutation, bind the reviewed stable
   Firestore/Auth reader (Role A). Verify its exact definition and binding,
   verify that the base role and Hosting Viewer remain unchanged, keep Role B
   unbound, and freeze that final read set. Credential creation or IAM changes
   are not part of an inventory operation and require their own authority.
5. Obtain a new, separate time-bounded, checksum-bound inventory authorization
   for the final-read-set observation. Then run
   `functions/phase3/inventory.js` with that authorization, the same final clean
   reviewed commit, and the explicit credential. Retain its distinct immutable
   `inventory-<sha256>.json` artifact. Each artifact is not an expectation,
   preflight manifest, or write authorization.
6. Independently corroborate in Firebase or Google Cloud Console the named
   deployment surfaces, counts, current release/version identities, gate
   parameters, index presence, and active writers. Console evidence is not
   claimed to reproduce canonical resource digests. Any disagreement or
   unexplained surface aborts; exact equality of all five deployment surfaces
   and active-writer classification is required. Claude performs detailed
   read-only review of both retained inventories, their comparison, the final-
   read-set observation, and the corroboration record; Grok then performs the
   independent 5,000-foot review. Andrew transports complete verdicts and is
   not expected to judge technical correctness.
7. Only after both reviews close, an N11 route is separately reviewed and
   selected, the final-read-set observation remains current under that route, and
   Andrew approves the next boundary, author and
   checksum the exact preflight expectations, using the final-read-set
   observation for every inventory-derived deployment and active-writer value
   and separately reviewed sources for all other required fields. Retain that
   artifact as the fifth normal state file. Obtain a new,
   separate read-only preflight authorization bound to those exact bytes, the
   explicit credential, and the full lowercase reviewed commit SHA. The
   authorization must carry the exact production-preflight kind and a validity
   interval no longer than two hours. Do not use a failing preflight as
   discovery: its retained/error evidence intentionally does not disclose the
   opaque deployed values needed to author expectations.
8. Run only the separate `functions/phase3/preflight.js` entrypoint with its
   four required reviewed inputs: teacher UID, read-authorization file,
   expectations file, and explicit credential file. The entrypoint
   machine-verifies the authorization's exact reviewed commit and a clean
   anchored worktree before opening the credential. Record its immutable
   manifest. Abort on any
   unexpected path, shape, count, ID, duplicate, UID mapping, credential/log,
   Auth compatibility, index, active writer, or recovery prerequisite.
9. Obtain separate production write/deploy authorization. Enter and verify the
   maintenance/write freeze. Capture the approved export/snapshot and final
   checksums; writes remain frozen through acceptance.
10. Administratively create or validate the existing reciprocal
   teacher/classroom foundation. Do not create an invitation.
11. Invoke `functions/phase3/write.js` with only the reviewed write
   authorization, preflight authorization, initialization expectations, copy
   expectations, and explicit credential artifacts. The first invocation must
   stop with `ACTION_REQUIRED/AWAITING_DEPLOYMENT` (exit 10) after reserving the
   login code and initializing the counter. Any other result blocks progress.
12. Deploy and verify the exact bridge-rules hash. Then deploy the reviewed V2
   Functions with the V2 gate off. Confirm the deployed surfaces and gate-off
   state independently before continuing.
13. Invoke the same `write.js` entrypoint with the same immutable artifact set a
   second time. Its journal—not an operator stage flag—selects copy. Require a
   completed copy result.
14. Run the separate remote/local read-only `functions/phase3/reverify.js`
   entrypoint with the same five artifacts. Reconcile every path, count,
   checksum, UID mapping, source-immutability assertion, Auth compatibility
   fact, active-writer fact, and sensitive-path denial. Any mismatch aborts
   before activation.

The exact preflight authorization and explicit credential are retained outside
Git with mode `0600` through both writer invocations and re-verification. Record
their raw-byte SHA-256 values without recording their contents or login code,
and keep a secure recoverable copy of the authorization. The manifest binds the
authorization's raw-byte digest, and write/reverify require the same credential
raw-byte SHA-256 while repeating the clean-reviewed-checkout proof. Do not delete
the key or service account immediately after preflight. Credential privilege
changes and final teardown are separate approval boundaries whose order must
preserve those byte bindings.

15. Deploy and verify the exact final-rules hash. Only after that, set the exact
   reviewed `MULTI_TEACHER_V2_RELEASE_ID` and enable the server gate. Then deploy
   the reviewed gate-on Hosting artifact.
16. Perform existing-teacher and existing-student acceptance, including tenant
    isolation and the V2 cleanup-control policy: Reset All Balances and Clear
    Login History remain available; Clear Transaction History and Reset
    Everything are absent and direct invocation is inert because deletion
    requires a separately reviewed server workflow.
17. End the write freeze only after acceptance passes. Observe through the
    recorded rollback window and do not onboard a second real teacher.

## Abort criteria

Stop, retain/re-enter the write freeze as applicable, and do not activate or
resume writes when any of these occurs:

- an approval, reviewed artifact, checksum, project, release ID, deployment
  surface, snapshot, or recovery prerequisite is missing or mismatched;
- an inventory or expectations artifact predates the Functions digest
  correction, or any required N9/N10 observation was not repeated at the final
  clean reviewed commit, regardless of whether an old digest compares equal;
- N11 remains open without a separately reviewed route selection, a selected
  route makes the final-read-set observation stale, or any blocked preflight,
  expectations, authorization, deployment-preparation, or writer action is
  attempted early;
- the deployed Rules checksum remains unexplained at the Rules/release boundary
  or differs from the separately reviewed checksum-pinned artifact for that
  stage;
- the inventory authorization, credential checksum, validity interval, fixed
  endpoint boundary, completeness declaration, independent corroboration, or
  inventory review is missing or mismatched;
- the first writer invocation does not stop at the deployment boundary, or the
  journal is indeterminate;
- any unexplained path, malformed/missing ID, duplicate, count/shape drift,
  source mutation, UID/Auth incompatibility, unacknowledged active writer, or
  sensitive-path access appears;
- bridge/final/rollback rules behavior differs from its reviewed suite;
- the gate turns on before final rules, Hosting turns on before the gate, or a
  control-plane state cannot be independently observed;
- existing-teacher or existing-student acceptance fails; or
- evidence contains secrets or cannot be tied to the reviewed commit/change.

Do not improvise repairs during the release. Preserve evidence, return to
review, issue new immutable artifacts where required, and rehearse again.

## Rollback after scoped credentials exist

Rollback also requires explicit authorization. Preserve scoped credentials;
do not expose, delete, or move them through a client path.

1. Retain or re-enter and verify the write freeze.
2. Roll Hosting back to the recorded default-off artifact.
3. Disable the V2 server gate and independently verify the disabled state.
4. Deploy and verify the exact checksum-pinned rollback-safe rules. Never
   deploy the recursive `firestore.rules` baseline.
5. Reconcile the untouched legacy aggregate, flat credentials, Auth mappings,
   and legacy logs. Verify scoped credentials still exist but are denied to all
   clients under rollback-safe rules.
6. Run legacy existing-teacher and existing-student acceptance. Resume writes
   only after both pass; otherwise keep the freeze and escalate for review.

The rollback rehearsal deliberately proves that modeled write authorization is
rejected before acceptance and permits a disposable write only after the ordered
acceptance transition.
