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
| `firestore.phase3.final.rules` | `3a169ad65f911aa80d25c524aec219775773952019cd53a57a776e14c711793d` | gate-on V2 policy |
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

1. Complete local implementation, required independent review, and every local
   gate above. Record the reviewed commit and artifact hashes.
2. Obtain explicit read-only production-validation authorization. Run only the
   separate `functions/phase3/preflight.js` entrypoint with its four required
   reviewed inputs: teacher UID, read-authorization file, expectations file,
   and explicit credential file. Record its immutable manifest. Abort on any
   unexpected path, shape, count, ID, duplicate, UID mapping, credential/log,
   Auth compatibility, index, active writer, or recovery prerequisite.
3. Obtain separate production write/deploy authorization. Enter and verify the
   maintenance/write freeze. Capture the approved export/snapshot and final
   checksums; writes remain frozen through acceptance.
4. Administratively create or validate the existing reciprocal
   teacher/classroom foundation. Do not create an invitation.
5. Invoke `functions/phase3/write.js` with only the reviewed write
   authorization, preflight authorization, initialization expectations, copy
   expectations, and explicit credential artifacts. The first invocation must
   stop with `ACTION_REQUIRED/AWAITING_DEPLOYMENT` (exit 10) after reserving the
   login code and initializing the counter. Any other result blocks progress.
6. Deploy and verify the exact bridge-rules hash. Then deploy the reviewed V2
   Functions with the V2 gate off. Confirm the deployed surfaces and gate-off
   state independently before continuing.
7. Invoke the same `write.js` entrypoint with the same immutable artifact set a
   second time. Its journal—not an operator stage flag—selects copy. Require a
   completed copy result.
8. Run the separate remote/local read-only `functions/phase3/reverify.js`
   entrypoint with the same five artifacts. Reconcile every path, count,
   checksum, UID mapping, source-immutability assertion, Auth compatibility
   fact, active-writer fact, and sensitive-path denial. Any mismatch aborts
   before activation.
9. Deploy and verify the exact final-rules hash. Only after that, set the exact
   reviewed `MULTI_TEACHER_V2_RELEASE_ID` and enable the server gate. Then deploy
   the reviewed gate-on Hosting artifact.
10. Perform existing-teacher and existing-student acceptance, including tenant
    isolation and the V2 cleanup-control policy: Reset All Balances and Clear
    Login History remain available; Clear Transaction History and Reset
    Everything are absent and direct invocation is inert because deletion
    requires a separately reviewed server workflow.
11. End the write freeze only after acceptance passes. Observe through the
    recorded rollback window and do not onboard a second real teacher.

## Abort criteria

Stop, retain/re-enter the write freeze as applicable, and do not activate or
resume writes when any of these occurs:

- an approval, reviewed artifact, checksum, project, release ID, deployment
  surface, snapshot, or recovery prerequisite is missing or mismatched;
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
