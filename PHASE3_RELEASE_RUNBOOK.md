# Phase 3 clean-start release and rollback runbook

Status: **local rehearsal evidence only; not production authorization**

Andrew selected a clean V2 start on 2026-07-31. No V1 application record or
Auth user is migrated, copied, reconciled, accepted, or deleted. Existing V1
test records remain untouched indefinitely. This runbook does not authorize a
production read, data write, deployment, parameter or gate change, invitation,
onboarding, IAM mutation, rollback, commit, or push. Every external transition
requires the separate approval required by `AI_COLLABORATION_WORKFLOW.md`.

## What the local evidence proves

`npm run test:phase2b:server` runs the gate-off and gate-on Functions suites
against fresh credential-isolated Auth, Functions, and Firestore emulators. In
gate-on mode, the suite loads the reviewed final rules and proves the complete
fresh path: invitation-controlled onboarding, first lifecycle student,
classroom-code/PIN login, custom-token Auth, teacher balance and transaction
writes, exact student self-read, cross-tenant denial, and lifecycle removal.
It seeds no legacy classroom or aggregate for that case.

`npm run test:phase3:rules` proves the bridge, final, and rollback-safe
artifacts independently. Final-rules evidence includes a phantom-parent legacy
student mirror and a stale token with matching path claims; the read is denied
because student self-read now requires an active reciprocal foundation.

`npm run test:phase3:migration`, `test:phase3:release-rehearsal`, and
`test:phase3:rollback-rehearsal` continue to execute the retained migration
runner and its historical two-write release ledger. They are regression
evidence only. Passing them does not place `inventory.js`, `preflight.js`,
`write.js`, `reverify.js`, bridge rules, rollback-safe rules, Role A, Role B, a
freeze, snapshot, or legacy acceptance into the clean-start operator sequence.

No local gate reads production, deploys anything, changes `firestore.rules`,
uses ambient credentials, creates an invitation, or proves current production
state.

## Immutable rules artifacts

Record and independently compare these hashes before any separately authorized
release:

| Artifact | SHA-256 | Clean-start status |
| --- | --- | --- |
| `firestore.rules` | `0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50` | recursive V1 baseline; never deploy |
| `firestore.phase3.bridge.rules` | `4bf76a85e576a1d5b30573c3c3d5eba0d3561fb9d9a19ac14ac6382dced8d7f0` | retained migration-only artifact; do not deploy |
| `firestore.phase3.final.rules` | `1a5994098bd3041c578bb5578cd299fe24b12263ce390e65c4f21fb274849c71` | the only clean-start rules deployment |
| `firestore.phase3.rollback.rules` | `c81a058e260502fe31c4240d547dcd731f130eb85be3a3c185caae681e4ef19d` | retained V1-recovery artifact; do not deploy |

Never copy a candidate over `firestore.rules` for testing. Never deploy the
recursive baseline, bridge, or rollback-safe rules in the clean-start route.

## Retained IAM definitions

The migration roles remain checksum-pinned review inputs, not clean-start
requirements:

| Alias and resource | Tracked definition | Raw-byte SHA-256 | Clean-start status |
| --- | --- | --- | --- |
| Role A — `projects/morgan-bank/roles/phase3DataPlaneReader` | `iam/phase3/phase3DataPlaneReader.yaml` | `4c4259c12d3d1f0188e997baac0a7fed000510357cb4b5c453de342123fad8d5` | unused; any teardown is a separate IAM decision |
| Role B — `projects/morgan-bank/roles/phase3MigrationWriter` | `iam/phase3/phase3MigrationWriter.yaml` | `a97924dbbdbf025cca740a6c952791a3ec5a774b0c2277f0228d029fd272d1bf` | must remain uncreated and unbound |

Do not create, bind, or widen either role for this release. Preserve the
tracked files and every 0400 artifact under `functions/phase3/.state/` exactly
as historical evidence. Do not use a role or retained artifact as a substitute
for deployment authorization.

## Required local gate

Run from a clean reviewed checkout with no Google Application Default
Credentials present:

```text
npm run test:phase3:contracts
npm run test:phase3:unit
npm run test:phase2b:client
npm run test:phase2b:server
npm run test:phase2b:rules
npm run test:phase3:rules
npm run test:phase3:migration
npm run test:phase3:release-rehearsal
npm run test:phase3:rollback-rehearsal
```

Any failure blocks release preparation. Preserve the command, reviewed commit,
artifact hashes, pass/fail counts, and redacted failure category. Do not rerun
with a force, production override, alternate project, relaxed rules, ambient
credential, or skipped suite.

## Clean-start decisions

- N11 (`PHASE3_FUNCTIONS_COPY_EXPECTATIONS_PREDICTABILITY`) is dissolved. It
  protected copy expectations for a writer that this route never invokes; it
  is not renamed, deferred, or replaced by a new expectation artifact.
- Do not run `functions/phase3/inventory.js`, `preflight.js`, `write.js`, or
  `reverify.js`.
- Do not author an inventory authorization, expectations file, preflight or
  write authorization, manifest, journal, snapshot, freeze proof, or copy
  expectation.
- Do not migrate or reconcile V1 records, flat credentials, Auth users, logs,
  balances, transactions, IDs, or counts.
- Do not delete production records. Old test documents are neither a release
  blocker nor cleanup scope.
- Do not create or bind Role B. No clean-start operation needs its write set.
- Deploy final rules directly; bridge rules have no scoped-copy window to
  protect.
- Acceptance uses only fresh accounts created through the normal V2 paths.

## Founding-teacher invitation

The repository has no reviewed administrative invitation-creation endpoint.
For the one founding teacher, use a separately authorized Firestore console
write. Do not hand-build `teachers`, `classrooms`, `classroomLoginCodes`,
students, or credentials.

The invitation path is:

```text
teacherInvitations/{hashEmailDigest(normalizedEmail)}
```

The exact initial body is:

```text
email: normalized verified Google-account email
status: "active"
createdAt: Firestore Timestamp
expiresAt: future Firestore Timestamp within the approved onboarding window
```

The digest may be derived offline with the reviewed
`hashEmailDigest(normalizedEmail)` helper. Do not put the email in a command
line, shell history, repository file, review prompt, or evidence log. Confirm
the path and field types in the console, but never record invitation contents
in release evidence. The callable atomically changes the invitation to
`consumed` and adds `consumedAt` and `consumedByUid` when onboarding succeeds.

Future teachers continue to require the same separately authorized console
write until a reviewed admin path is implemented. This runbook does not create
that future path.

## Production release sequence

The following is an operator checklist, not permission to execute it.

1. Complete Codex implementation and self-verification. Obtain Claude's
   detailed read-only PASS, then Grok's independent 5,000-foot PASS for the
   exact reviewed range.
2. Run the required local gate above from the final clean reviewed commit.
   Record only non-secret checksums, counts, and verdicts.
3. Bind the release record to that exact commit, the reviewed Functions
   artifact, the reviewed gate-on Hosting artifact, final-rules hash, and
   `REVIEWED_V2_FUNCTIONS_RELEASE_ID = "phase3-commit8-functions-v1"`. Verify
   Role B remains uncreated and unbound.
4. Under separate deployment authorization, deploy the reviewed V2 Functions
   with `MULTI_TEACHER_V2_ENABLED=false`. Verify every V2 callable fails closed
   and legacy exports remain discoverable; do not invoke migration entrypoints.
5. Deploy and verify the exact final-rules hash. Independently prove the active
   release is the reviewed final artifact. Deploy neither bridge rules,
   rollback-safe rules, nor the recursive baseline.
6. Before activation, prove the deployed final rules permit only a fresh
   reciprocal owner's scoped reads and exact client writes, permit student
   self-read only with exact claims plus an active reciprocal foundation, and
   deny cross-tenant access, both credential shapes, invitations, code indexes,
   throttles, unresolved logs, V1 blobs, flat logs, and phantom-parent legacy
   mirrors. Any mismatch aborts before activation.
7. Configure `MULTI_TEACHER_V2_RELEASE_ID` to exactly
   `phase3-commit8-functions-v1` and set `MULTI_TEACHER_V2_ENABLED=true`. Apply
   those deploy-time parameters to the same reviewed Functions source and
   independently verify both values. A wrong or blank release ID must keep
   every V2 invocation closed.
8. Deploy and verify the reviewed gate-on Hosting artifact. Final rules must
   precede the server gate, and the server gate must precede gate-on Hosting.
9. Obtain separate administrative-data-write authorization and create the one
   time-bounded founding-teacher invitation exactly as specified above.
10. Sign in with the invited verified Google account and complete
    `onboardTeacherClassroomV2`. Verify exactly one consumed invitation, active
    teacher, reciprocal classroom, active classroom-code index, and classroom
    `nextStudentNumber: 1`. Do not create the foundation administratively.
11. Perform fresh-account acceptance: create student `"1"` through
    `createStudentV2`; authenticate the returned login ID and submitted PIN
    through `studentPinLoginV2`; commit and read back an exact balance plus
    transaction write; prove exact student self-read and cross-tenant denial;
    then remove the student through `removeStudentV2` and verify the student is
    absent, the credential is retained/inactive, the transaction remains, and
    `nextStudentNumber` remains `2`.
12. Observe through the recorded pre-school rollback window. Do not onboard a
    second real teacher or add any real student. Preserve all fresh and legacy
    documents and retained historical artifacts.

## Abort criteria

Abort without improvising when any of these occurs:

- a required approval, review verdict, commit, artifact, checksum, release ID,
  parameter value, deployment identity, or local gate is missing or mismatched;
- Role B exists, is bound, or is proposed as part of the clean-start sequence;
- any operator attempts to run inventory, preflight, write, reverify, migration,
  reconciliation, deletion, snapshot, freeze, bridge, rollback-safe, or baseline
  operations as a clean-start prerequisite;
- final rules are not active before gate enable, or the server gate is not
  active before gate-on Hosting;
- a stale legacy student token can read a phantom-parent mirror, any legacy blob
  or credential becomes client-readable, or a fresh student lacks exact self-
  read;
- the founding invitation lacks an `expiresAt` field containing a future
  Firestore Timestamp when step 9 is verified, or the invitation is not
  `consumed` after step 10;
- onboarding creates anything other than one invitation/teacher/classroom/code
  foundation with `nextStudentNumber: 1`;
- the fresh lifecycle, login, money-write, removal, or bidirectional isolation
  acceptance fails; or
- evidence contains a secret, PIN, token, credential, invitation email, or
  unredacted student data.

Preserve evidence, keep the gate closed or withdraw the release, return to
review, and repeat the complete gate after the smallest reviewed correction.

## Clean-start rollback before real-student rollout

Rollback requires explicit authorization. It is a fail-closed service
withdrawal, not a return to V1.

1. Stop invitation and acceptance activity. Close and sign out every
   operator-controlled acceptance client.
2. Roll Hosting back to the recorded default-off artifact.
3. Disable the V2 server gate and independently verify V2 callables fail closed.
4. Keep the checksum-pinned final rules deployed. Do not deploy rollback-safe,
   bridge, or recursive baseline rules; no legacy writes resume.
5. Verify scoped credentials, fresh classroom records, V1 blobs, flat
   credentials/logs, and phantom-parent legacy mirrors remain stored as
   applicable but client-denied. Preserve them; do not migrate, reconcile, or
   delete them.
6. Diagnose and correct forward. Re-enter the full clean-start release sequence
   only after the correction completes Codex, Claude, and Grok review and the
   complete local gate passes again.

Disabling the Functions gate does not revoke an already authenticated teacher's
direct Firestore permission under final rules. This rollback is therefore
valid only while every user is an operator-controlled pre-school test identity.
If closing those clients cannot be proven, separately authorize disabling the
fresh teacher foundation before claiming containment. Once real students or
independent teachers exist, this rollback is insufficient and a newly reviewed
continuity and containment plan is required before rollout.

## Evidence record

Use an append-only operator record with monotonically increasing sequence,
exact event name, UTC time, approved human actor, change/release ID, project,
reviewed commit, applicable artifact SHA-256, retained evidence SHA-256, result,
and redacted notes. Never record credential contents, private keys,
access/refresh tokens, PINs, PIN hashes, cookies, invitation emails, `.env`
contents, or unredacted student data. A secret in evidence is an abort.
