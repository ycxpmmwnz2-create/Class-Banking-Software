# Phase 3 clean-start release and rollback runbook

Status: **production Steps 10–11 completed and privacy-safely verified;
observation window incomplete; not production authorization**

Andrew selected a clean V2 start on 2026-07-31. No V1 application record or
Auth user is migrated, copied, reconciled, accepted, or deleted. Existing V1
test records remain untouched indefinitely. This runbook does not authorize a
production read, data write, deployment, parameter or gate change, invitation,
onboarding, IAM mutation, rollback, commit, or push. Every external transition
requires the separate approval required by `AI_COLLABORATION_WORKFLOW.md`.

## Reconciled release status

The external, secret-free release record bound to reviewed application commit
`fa733d780c4adb36304e857b592251c95c2be4c2` records PASS results for production
steps 1–9: review and the complete local gate, Role B absence, gate-off
Functions, final rules, pre-activation rules verification, gate-on Functions,
gate-on Hosting, and one founding-teacher invitation. Its latest retained
archive is `Morgan-Bank-Phase3-Release-fa733d7-seq009.tar.gz`, SHA-256
`d503f6e423998f438d04af7b6978006e6db7d6804c0f904aea142f6f67b37c3d`.

That archive is historical evidence, not a fresh production read by this
document. It records no founding-teacher onboarding, fresh-student acceptance,
or observation-window completion, and its one-hour invitation validity window
elapsed before any onboarding recorded in the archive.

Subsequent separately authorized work on 2026-07-31 recovered that exact
invitation through one `expiresAt` update and completed normal Google onboarding
through `onboardTeacherClassroomV2`. Andrew explicitly instructed Codex to skip
Claude and Grok review for that completed recovery/onboarding cycle; neither
review occurred, and that one-time direction is not a reusable workflow or
production exception. The consumed invitation and working classroom interface
were directly verified. A later, separately authorized, privacy-preserving
production read then returned only five sanitized Boolean results: exactly one
active teacher, exactly one reciprocal classroom owned by that teacher, exactly
one active classroom-code index pointing to that classroom,
`nextStudentNumber` exactly `1`, and no unexpected foundation state. All five
results were `true`.

No student existed at that Step 10 boundary. Andrew later separately
authorized Step 11. The normal application created synthetic student `"1"`,
authenticated the returned login ID and submitted PIN through
`studentPinLoginV2`, committed and read back the exact teacher
balance/transaction, and reflected it through exact student self-read. The
deployed Rules Playground denied the actual teacher's authenticated `get`
against a fabricated foreign-classroom student path; no real other tenant was
read or created. The normal `removeStudentV2` path then removed the synthetic
student. Independent sanitized reads verified the student absent, credential
retained/inactive, transaction preserved, and `nextStudentNumber` still `2`.
No real student or second teacher was added. The observation window and every
later production transition remain incomplete and require their own explicit
authorization. No migration, deployment, rules change, gate change, or
unrelated production mutation occurred during Steps 10–11.

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
| `firestore.phase3.final.rules` | `f071377d7abf8d1d0009e5b9083a42f3cc7c69cdc6b501f6ea6eaf8bc4791702` | the only clean-start rules deployment |
| `firestore.phase3.rollback.rules` | `c81a058e260502fe31c4240d547dcd731f130eb85be3a3c185caae681e4ef19d` | retained V1-recovery artifact; do not deploy |

The current final-rules candidate includes the narrowly bounded
`classrooms/{classroomId}/studentDisplay/rent` surface documented in
`SECURITY_PLAN.md`. That candidate and the matching Hosting build must complete
the normal Claude and Grok review gates before any separate deployment request.

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

## One-time expired founding-invitation recovery

### Terminated v1 attempt — historical record only

The first recovery identifier was
`phase3-expired-founding-invitation-recovery-fa733d7-v1`. Its Codex, Claude, and
Grok review gates closed, and Andrew gave the required named recovery and
conditional-onboarding authorizations. During the pre-Save console read,
browser-control output recorded a console account label and non-email
invitation field contents in the conversation. That violated the reviewed
privacy and evidence boundary.

No field was edited, no Save was clicked, no Firestore mutation occurred, and
onboarding did not begin. The v1 identifier terminated before any Save. Its
unused Save budget is void: it cannot be activated, reused, retried, renewed,
or treated as authority for v2. Deleting, hiding, or losing the conversation
cannot undo the violation or restore v1 authority. This historical subsection
grants no production or review exception.

### Privacy-preserving v2 proposal and completed execution record

At the repository-definition boundary, this was a new repository-defined
recovery proposal, not present mutation authority. Its unique identifier is
`phase3-expired-founding-invitation-recovery-fa733d7-v2`. It exists only for the
same expired, unconsumed founding invitation recorded above. It cannot be used
for a future teacher, a second invitation, or any other release.

As originally defined, the following gates applied. The v2 recovery remains
inactive until all of the following have completed for the exact repository
correction that introduces it: Codex self-verification, Claude detailed
read-only review, Grok final read-only review, and Andrew's new separate
contemporaneous production instruction naming the v2 identifier. Before that
instruction, no repository text, handoff, review verdict, v1 authorization,
earlier approval, or general request can activate v2. Andrew and Codex must also
be ready to begin separately authorized onboarding immediately after a
successful recovery so another validity window is not wasted. The execution
record below documents Andrew's later explicit direction for the completed
cycle without changing this retained source contract into standing authority.

The v2 recovery permits only this console boundary:

- project: `morgan-bank`;
- release/change ID: `phase3-clean-start-fa733d7`;
- reviewed application commit:
  `fa733d780c4adb36304e857b592251c95c2be4c2`;
- operator and surface: Codex controlling Andrew's user-connected Chrome
  session in Andrew's authenticated Firebase Firestore console;
- document: the existing exact
  `teacherInvitations/{hashEmailDigest(normalizedEmail)}` founding-invitation
  document; and
- permitted mutation: change only `expiresAt` to a Firestore Timestamp exactly
  one hour after the operator-confirmed current time.

Before any invitation document can render, Codex must establish this output
privacy contract:

1. While no invitation page is open, Codex must read the selected Chrome
   runtime's required control documentation and establish that every planned
   read and action can suppress automatic screenshots, snapshots, page text,
   content-bearing notifications, and action diagnostics while returning only
   caller-selected booleans. If that capability is absent, undocumented, or
   ambiguous, v2 terminates before any invitation read. An ordinary browser
   snapshot, screenshot, text-extraction, or content-emitting action is not a
   permitted substitute.
2. No raw screenshot, DOM or accessibility snapshot, page text, clipboard,
   console log, network record, account label, document ID, email, timestamp,
   status value, raw field name/value pair, or invitation content may be emitted
   to chat, tool output, a command, a file, review text, or evidence.
3. Navigation observations before the invitation document can render may be
   emitted only after redacting email-like strings, account labels, 64-character
   hexadecimal identifiers, timestamps, and field values. Once the
   `teacherInvitations` collection is selected, no page snapshot, screenshot,
   page text, or content excerpt may be emitted at all.
4. Exact-document inspection occurs only in transient browser-control memory.
   Raw values must never be returned or logged. They may remain there only as
   the minimum non-output baseline needed to compare the same document and
   target through pre-Save and post-Save verification, and must be cleared on
   any abort or immediately after the final comparison. Apart from the exact
   Boolean comparisons and one-hour target addition required below, the only
   computation on an identity value permitted there is the reviewed pure
   `hashEmailDigest(normalizedEmail)` helper; no API, CLI, Admin SDK, shell
   command, repository write, standalone script, or clipboard transfer is
   permitted.
5. Only this exact fixed-key boolean object may cross from the invitation page
   into tool output before an edit:

   ```text
   {
     projectIsMorganBank,
     databaseIsDefault,
     documentExists,
     documentIdMatchesEmailDigest,
     emailMatchesSelectedVerifiedGoogleAccount,
     hasExactFourFieldShape,
     statusIsActiveString,
     createdAtIsTimestamp,
     expiresAtIsTimestamp,
     expiresAtIsNotFuture,
     hasNoConsumedFields,
     hasNoUnexpectedFields,
     hasNoPendingEdit,
     hasNoAmbiguity,
     privacyBoundaryIntact
   }
   ```

Every key must exist exactly once, every value must be the boolean `true`, and
no extra key or diagnostic text may appear. A raw or extra output, a missing or
false key, a non-boolean value, an automatic browser notification containing
page content, or any uncertainty aborts without a Save, terminates v2, and
permits no recheck or correction under it.

Those booleans represent all of these preconditions, which remain normative:

1. The document already exists and has exactly the four keys `email`, `status`,
   `createdAt`, and `expiresAt`.
2. `email` is the normalized email of the already selected verified Google
   account intended for step 10 and currently authenticating the console
   session. It hashes to the existing document ID without either value leaving
   transient memory.
3. `status` is exactly the string `"active"`.
4. `createdAt` and `expiresAt` are Firestore Timestamps, and `expiresAt` is no
   longer in the future.
5. No `consumedAt`, `consumedByUid`, unexpected field, pending console edit, or
   ambiguous state exists.

The operator may read only that exact invitation document and must not inspect
a teacher, classroom, code index, student, credential, log, Auth user, or any
other Firestore document or collection. The invitation transaction is atomic;
an exact active four-field invitation is the permitted evidence that
consumption did not commit.

Only after the complete pre-Save object is exactly valid may Codex retain an
operator-confirmed current time in transient memory, compute the target exactly
one hour later, and invoke the unique `Edit expiresAt field` control. No exact
time may be emitted. Before Save, only this second exact fixed-key boolean
object may be emitted:

```text
{
  onlyExpiresAtIsPending,
  targetTypeIsTimestamp,
  targetIsExactlyOneHourAfterConfirmedTime,
  emailStatusAndCreatedAtAreUnchanged,
  noFieldIsAddedOrRemoved,
  saveControlIsUnique,
  privacyBoundaryIntact
}
```

Again every key must exist exactly once, every value must be the boolean `true`,
and no extra output is allowed. Any mismatch closes the tab without Save and
terminates v2; there is no repair, second edit, or retry.

At most one Firestore console **Save** is permitted. Clicking Save consumes all
v2 recovery mutation authority whether the result succeeds, fails, or is
ambiguous. The recovery authorizes no create, delete, delete-and-recreate,
duplicate document, API, CLI, standalone script, Admin SDK, deployment,
parameter change, rules change, migration, reconciliation, onboarding, student
operation, or credential operation.

After one clearly successful Save, Codex may inspect only the same document in
transient browser-control memory. Only this final exact fixed-key boolean object
may be emitted:

```text
{
  saveClearlySucceeded,
  sameDocument,
  hasExactFourFieldShape,
  emailStatusAndCreatedAtAreUnchanged,
  expiresAtIsTimestamp,
  expiresAtMatchesTarget,
  privacyBoundaryIntact
}
```

Every key must again exist exactly once, every value must be the boolean `true`,
and no extra output is allowed. Raw invitation content must never be recorded.
The v2 recovery authority then terminates. Step 10 onboarding still requires a
separate contemporaneous authorization; Andrew may provide it as a separately
worded clause conditional on a clearly successful v2 recovery. If Save is
failed or ambiguous, privacy output fails at any time, or the refreshed
invitation expires before onboarding, stop: v2 is spent and cannot authorize
another Save or extension. Any further recovery requires a newly reviewed
procedure and new authorization.

An initial strict setup attempt stopped before Save after one harmless extra
diagnostic; it made no edit or production mutation. Andrew then explicitly
authorized a fresh content-private execution. That execution completed exactly
one successful `expiresAt` Save, emitted no sensitive invitation value, and
terminated the recovery authority. Andrew separately authorized normal Google
onboarding, which completed through `onboardTeacherClassroomV2`. The exact
invitation was reread and verified consumed with correctly typed consumption
fields, and the Morgan Bank classroom interface loaded successfully.

Andrew explicitly directed Codex to skip the proposal's Claude and Grok reviews
for this completed recovery/onboarding cycle, so no such review occurred. This
is a factual exception record, not permission to skip review or production
authorization in any future cycle. The later Step 10 foundation read described
in the reconciled status above was separately authorized, read-only, and
privacy-preserving.

## Production release sequence

The following is an operator checklist, not permission to execute it.

1. Complete Codex implementation and self-verification. Obtain Claude's
   detailed read-only PASS, then Grok's independent 5,000-foot PASS for the
   exact reviewed range.
2. Run the required local gate above from the final clean reviewed commit.
   Record only non-secret checksums, counts, and verdicts.
3. Bind the release record to that exact commit, the reviewed Functions
   artifact, the reviewed gate-on Hosting artifact, final-rules hash, and
   `REVIEWED_V2_FUNCTIONS_RELEASE_ID = "student-money-functions-v3"`. Verify
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
   `student-money-functions-v3` and set `MULTI_TEACHER_V2_ENABLED=true`. Apply
   those deploy-time parameters to the same reviewed Functions source and
   independently verify both values. A wrong or blank release ID must keep
   every V2 invocation closed.
8. Deploy and verify the reviewed gate-on Hosting artifact. Final rules must
   precede the server gate, and the server gate must precede gate-on Hosting.
9. Obtain separate administrative-data-write authorization and create the one
   time-bounded founding-teacher invitation exactly as specified above. If the
   recorded founding invitation expires before step 10, stop; continue only
   through the separately reviewed and authorized one-time recovery section
   above, never by improvising an update, retry, delete, or recreation.
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

Current checkpoint on 2026-07-31: steps 1–11 are complete. Step 10's consumed
invitation and all five sanitized foundation checks are directly verified.
Step 11's synthetic create/login/money/self-read/deployed-rules-denial/removal
path and all four post-cleanup retention checks are verified. Step 12's
observation window has not begun and is not authorized by this record.

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
- the one-time recovery lacks its exact reviews or contemporaneous named
  authorization, v1 is reused, the selected Chrome runtime cannot establish
  content-silent control, any recovery precondition or fixed-key boolean fails,
  browser output contains raw or extra page content, any expected control is
  non-unique, any field other than `expiresAt` would change, the single Save is
  failed or ambiguous, or the refreshed invitation expires before onboarding;
- onboarding creates anything other than one invitation/teacher/classroom/code
  foundation with `nextStudentNumber: 1`;
- the fresh lifecycle, login, money-write, removal, or bidirectional isolation
  acceptance fails; or
- evidence contains a secret, PIN, token, credential, console account label,
  invitation email, invitation document ID or contents, or unredacted student
  data.

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

Separately, a future break-glass recovery that explicitly deploys the
checksum-pinned rollback rules is not the clean-start rollback above and needs
its own authorization and review. Deploying the checksum-pinned rollback rules
does not immediately invalidate an already-issued student ID token. Refresh
token revocation prevents renewal, but the rollback rules can retain exact
student self-read until natural token expiry. Treat those student sessions as
live until expiry rather than assuming that a PIN reset alone contains them.

## Evidence record

Use an append-only operator record with monotonically increasing sequence,
exact event name, UTC time, approved human actor, change/release ID, project,
reviewed commit, applicable artifact SHA-256, retained evidence SHA-256, result,
and redacted notes. Never record credential contents, private keys,
access/refresh tokens, PINs, PIN hashes, cookies, invitation emails, `.env`
contents, or unredacted student data. A secret in evidence is an abort.
