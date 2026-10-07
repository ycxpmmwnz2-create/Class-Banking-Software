# Remaining writer containment — local implementation stages

## October 2, 2026: client-write boundary candidate

Andrew authorized tackling the remaining money-writing paths and Firestore rules.
The prior 29-file money-button candidate and its seven-file correction have Muse
and Claude PASS. Stage 1 received bounded Muse and Claude PASS; its frozen closure is retained in the October 2 review artifact. It does not
change deployment selection or certify that all writers are contained.

Implemented here:

- `firestore.phase3.money.rules`: current reciprocal owner/control and exact
  student credential-version checks; active/readOnly scoped reads; suspended
  refusal; active-only allowlisted non-money writes. Student token roles never
  qualify as teachers. Client balances, names, mirrors, ledger creates/status
  changes, credentials, PINs, receipts, actor/quota, usage and audit writes deny.
- `createNonMoneyTenantDataSaver`: a cutover candidate that refuses money, ledger,
  roster membership and name changes against a required captured baseline before
  starting any database work. It retains existing session and concurrency checks.
  Freeze changes become narrow updates, preserving the server's mirror order.
  Settings, rent and non-money login history retain the existing decomposition.
- Real Firestore emulator tests exercise modes, two tenants, stale credentials,
  malformed controls, forbidden batch piggyback, private paths, 400 freeze writes
  and the actual candidate saver. A regression proof demonstrates that the prior
  rules allow a balance/status bypass which the candidate refuses.

These two candidates are deliberately NOT selected by index.html/firebase.json.
The current generic saver and selected rules still have the old behavior. The
reviewed design prohibits activating stricter rules after migrating only Quick
Cash: selecting these candidates now would break approvals and roster actions.
The candidate does not constrain Admin SDK writes. No commit, push, deploy,
feature setting, production access or data operation is performed by this stage.

## Actual remaining paths and required migrations

| Path | Current source behavior / next required work |
| --- | --- |
| Quick Cash and custom Add/Subtract | Reviewed planned server intent, receipt and recovery route. Preserve its reviewed behavior. |
| `queueApprovalDecision` / individual and all approvals and denials | October 4 candidate uses complete server-planned pending IDs, exact mirror parity and durable receipt/recovery; no filtering after a conflicting decision. Bounded Muse and Claude PASS; frozen Stage 2 closure retained. |
| `updateStudent` / `resetBalancesToZero` | October 4 candidate separates Save name and Adjust balance, moves reset to complete confirmed server intents, and preserves historical names. Bounded Muse and Claude PASS; frozen Stage 2 closure retained. |
| `createStudentV2Service` | Stage 4 candidate writes student, credential/PIN, opening ledger/mirror, allocator and HMAC-bound receipt atomically; actual Add Student uses durable recovery. Bounded Muse and Claude PASS; secret provisioning remains a release prerequisite. |
| `removeStudentV2Service` | Stage 3 candidate checks captured classroom/control each attempt, refuses pending requests and preserves history; Stage 5 now makes the enrolled credential trigger inert (bounded Muse/Claude PASS). |
| `submitStudentTransactionV2` + student UI | Stage 3 candidate migrates the real handlers and server to bounded cents/current generation, retaining exact replay, history, credential, frozen/settings and throttle checks. Stage 3 received bounded Muse and Claude PASS; no release. |
| `resetStudentPinV2` + callers | Stage 5 rechecks reciprocal foundation/generation inside each post-hash write callback; all three page entries send captured access. Bounded Muse/Claude PASS. |
| `studentPinLoginV2` | Stage 5 validates control and rechecks identity/generation before mint. Bounded Muse/Claude PASS; strict-rules late-token qualification remains open. |
| `syncStudentProfilesV2` | Stage 5 enrolled-root transactional no-op fences late events and every legacy callback retry. Bounded Muse/Claude PASS. |
| Insights work and usage accounting | Active-generation evidence/reservation/dispatch guards. Only settlement of an existing reservation is a pause exception. |
| `recordStudentBalanceHistoryV3` | Preserve deterministic create-only audit exception in all modes; no money/credential/control writes. |
| Generic saver and deployed rules | Wire these new candidates only after caller migrations, full mixed-path tests and review; preserve the maintenance/drain/initialization sequence. |

This inventory is source evidence, not deployed-export or old-revision drain
evidence. Dormant migration/reconciliation/operator writers stay outside the
release and may not run without their separate reviewed control compatibility.

## Required continuation and release checks

The October 4 candidate implements approvals/denials and roster adjustment/reset/profile
server intents with actual browser wiring. Next: student/lifecycle and remaining
background routes. Each material stage follows Codex → Muse → Claude.
Do not count this first client boundary as finishing Andrew's loose-end request.

Before switching either candidate, prove all retained actions and mixed concurrent
writers, exact-generation pause/resume behavior, both browser engines and strict
rules together. Freeze/settings writes use current rules rather than a generation
token, as specified by R4; no new offline-replay feature is introduced. Rules
propagation, production IAM, scanner NO-GO, existing-class initialization and
Stage8 L2 remain separate release qualifications. Never reopen permissive rules
or manually reset metadata to make an acceptance check pass.

Run `npm run test:phase3:money-rules` for the new isolated demo/loopback suite,
`npm run test:phase3:unit` for the candidate saver and existing units, and
`npm run test:phase3:contracts` for release/source contracts. Test counts and
runtime version belong in the frozen stage evidence, not a claim of live safety.


## October 4, 2026: complete teacher groups and separate profile save

Bounded Stage 2 received Muse and Claude PASS. No release or strict-rules selection.

- All V2 approve/deny buttons pass an explicit transaction-ID set to the existing
  planner/executor/recovery path. Server reads Pending ledger and matching mirrors,
  applies bounded cents once for approval, and preserves date/name. Denial changes
  no balance. A decision conflict refuses the entire group.
- Roster adjustment/reset compares every expected balance and writes the signed
  before/after adjustment, balance, mirror, version-3 receipt, actor and quota
  atomically. New groups reject duplicates and zero-delta edits. The reset button
  explicitly confirms the displayed nonzero targets; it never auto-chunks a group.
- New actions reuse the existing 60-second snapshot plan and read/write/byte
  bounds. Complete groups only: oversize or stale selections require a smaller
  deliberate selection/reconfirmation. Award/deduct's reviewed prefix planner is
  unchanged. Receipts map decisions to existing ledger IDs; adjustment/reset IDs
  are derived in their existing action domains. Old award receipts remain readable.
- `editStudentProfileV2` binds the captured classroom and checks current reciprocal
  ownership, mode and generation on every transaction attempt. It changes only
  name after expected-name comparison; exact desired-name retry is a no-op.
- V2 roster drafts survive failed saves and clear on session change. Only the
  confirmed action's corresponding draft clears after a successful refresh.
- Student replay and full mirror validation accept nonempty historical names by
  student ID, retaining exact ledger/mirror equality. Projection already uses ID
  and exact parity; report participants aggregate by ID and use current roster names.
  The remaining student cents/control migration is still outstanding.

Verification includes actual handlers in Chromium and WebKit over fictional
storage, Node suites, and real callable/Admin Firestore demo-emulator tests.
Exact final counts and commands are in the frozen Stage 2 packet. These checks
establish local behavior, not production safety or a completed clean bill of health.


## October 4, 2026: Stage 3 student submissions and safe removal

Stage 3 received bounded Muse and Claude PASS. No deployment or strict-rule selection.

- Actual student Add/Subtract handlers send protocol 1, captured control generation
  and bounded integer amountCents. Whole-dollar UI is retained. Exact ambiguous
  retries retain the original ID and generation; there is no automatic generation
  refresh. Server checks control on every transaction attempt, including replay,
  and enforces safe current/resulting balances using cent arithmetic. Existing
  Add Pending/Subtract Approved, frozen/settings, credential version, immutable
  historical names, exact ledger/mirror replay, throttle and 1,000-entry cap remain.
- Removal binds the captured classroom/protocol/generation and checks reciprocal
  ownership/control inside every attempt. A bounded pending-ledger query plus
  mirror guard refuses deletion until requests are decided, preserving all data.
  Concurrent student writes contend on the student/root and query. Decided history
  remains unchanged, credentials deactivate and the PIN-directory row is deleted
  atomically. No new postcommit credential writer was added.
- The removal page reloads confirmed server data/cache; stale completions cannot
  affect another session. Failure keeps controls recoverable; ambiguous removal
  requires refresh. Existing removed-student pending records are shown separately
  and explicitly excluded from the displayed current-roster Approve All scope.
  Their stored status/history is not silently repaired or deleted.

Still outstanding: receipted/HMAC-bound student creation and opening reporting,
PIN reset/login/sensitive PIN reads, enrolled-root credential trigger containment,
Insights/audit, full mixed-writer/strict-rule evidence and release qualifications.
Stage 2 optional preview-refusal guidance travels with later teacher/client work;
this stage does not claim it fixed. Legacy orphan remediation remains a separate
explicit data-qualification decision; separation restores current-roster approvals.


## October 5, 2026: Stage 4 account creation and opening balances

Local candidate; Muse then Claude review pending. This fixes the existing Add
Student save and its affected reporting. No new account feature or rules selection.

- Exact creation wire: name, PIN, signed bounded startingBalanceCents, classroomId,
  requestId, protocolVersion and controlGeneration. Old dollar-shaped requests
  refuse. The page parses decimal input without rounding and uses the existing
  teacher money client/marker/status/acknowledgment surface. No PIN or payload is
  persisted in recovery storage. Confirmed creation reloads actual history rather
  than manufacturing an empty mirror. All page lock work is inside try/finally.
- Each transaction attempt rechecks reciprocal ownership and control. New commits
  require current active generation, existing valid actor/quota metadata, capacity
  and no unresolved actor pointer. Same-key replay binds the full canonical input
  with keyed HMAC; it can inspect a committed result in active/readOnly, following
  the teacher receipt contract. Suspended denies. Changed input or missing retained
  key fails closed. Cancellation fences the same key before any new writes.
- Nonzero opening money creates one server-dated Approved Opening Balance entry
  with exact signed Add/Subtract semantics and identical mirror. Zero has no money
  entry. Allocation, student, credential, PIN, opening ledger, v4 receipt, actor
  pointer and quota commit together. Deterministic ledger collision refuses.
  Reads reserve document/query bounds before I/O; local write estimates enforce
  the shared 8 MiB bound. This estimate is not production SDK/index-size proof.
- Receipt v4 stores only allocated student/login IDs, key version/HMAC and bounded
  action metadata/mapping. No PIN, password hash, name, balance or unkeyed full
  intent digest. Existing recovery routes validate and return the public identity;
  no new callable exports. Generic teacher receipts remain unchanged.
- Shared reporting classification identifies exact Opening Balance source and
  teacher/operator adjustments before reduction. Earnings comparisons and timing
  patterns exclude them; raw ledger/cash movement and current balances retain them.
  Separate signed adjustment totals and recorded-history limitations are visible.
  The fact packet preserves the classified deterministic report; it performs no
  independent raw-ledger reduction. Existing balance-witness proof is unchanged.

### Release dependency, not activated here

The existing createStudentV2 callable now binds STUDENT_CREATION_HMAC_KEYS, a private
versioned JSON key ring with currentVersion and keys. Each key is 32 random bytes
encoded as 64 lowercase hex characters; version names are bounded identifiers.
Provision through the authorized secret-management release process, validate the
configured version before enabling creation, and retain previous versions for all
retained receipts. Do not put real keys in source, packets, logs or browser state.
Missing key configuration refuses creation; this candidate must not be deployed
without that prerequisite. The emulator runner uses a clearly fictional key only
in its disposable demo copy. No real key was read, generated, installed or rotated.

Old open pages require refresh/revision drain because their creation wire is
obsolete. Review, initialization, scanner NO-GO, IAM, old-writer drain, mixed-writer
and strict-rule checks, Stage8 L2 and signed-in live acceptance remain open. PIN/
login/sensitive reads, enrolled credential trigger, Insights admission and audit
writers remain the next containment work; this reporting change does not contain
those background writers. Optional Stage 2/3 findings remain tracked in closures.


## October 5 Stage 5 candidate — PIN, login and enrolled credential trigger

Stage 4 has bounded Muse/Claude PASS without required corrections. Its frozen
closure and optional release follow-ups are in the Stage 4 review artifact.
Stage 5 received bounded Muse and Claude PASS; its closure and release follow-ups are retained in the Stage 5 review artifact. No release.

- PIN reset requires exactly studentId/newPin/classroomId/protocolVersion/
  controlGeneration. Old requests refuse before hashing. Hash once per call;
  each write callback re-reads reciprocal active teacher/classroom and active
  matching generation after hashing, before credentials/PIN updates. Captured
  classroom cannot move with a changed teacher mapping. Existing monotonic
  credential version, atomic visible PIN and postcommit Auth revocation remain.
  Revocation may finish while paused because it narrows access.
- Profile reset, single activation and bulk activation read current access before
  dispatch and bind the captured classroom/generation. Bulk captures once for the
  entire group, never upgrades pending work after pause/resume. Existing stale
  result guards and memory-only PIN display remain; no automatic reset retry.
- Login resolves reciprocal foundation and valid read control in the verifier
  transaction. Active/readOnly may authenticate; suspended/malformed control
  cannot. Existing bounded throttle/log telemetry remains a security exception.
  A fresh read-only transaction before token mint rechecks code binding, same
  owner/classroom/generation and exact active credential/version/schema. The
  callable returns token plus minimal access {protocolVersion,mode,generation};
  custom claims remain unchanged. Rules and current callables must still refuse
  a token minted after the final check when suspension races the external mint.
- listStudentPinsV2 already has active-only sensitive access and a final same-
  generation/foundation recheck. Its existing regression suite is retained.
- The credential trigger reads the root marker transactionally. A valid enrolled
  control in any mode returns enrolled_noop before credential reads or writes.
  Malformed control fails closed, never falls back to pre-enrollment behavior.
  An early read avoids hashing for enrolled creation events; EVERY legacy write
  callback rechecks the marker, so concurrent enrollment also fences the write.
  Pre-enrollment compatibility remains; drain/reconcile it before enrollment.

No selected rules/saver, export/secret binding, migration, credential provisioning
or deployment changes. Old PIN-reset pages require refresh at release. Insights
admission, audit writers, mixed-writer/strict-rules acceptance and all previously
listed operational/live release qualifications remain open.


## October 5 Stage 6 candidate — Insights admission and audit proof

Local implementation; Muse and Claude review pending. This is the final identified
retained writer family, not the completion of integrated or production acceptance.

- Both live and emulator callable composition create one immutable server-derived
  teacher/classroom/generation scope. Initial authorization rejects student roles,
  missing/malformed control and non-active modes. Pure analysis/question/tool
  services receive scoped evidence, ledger and provider adapters; no browser wire,
  model, spending limit, provider retry policy or export/gate is changed.
- Both evidence loaders validate active matching generation in their existing
  reciprocal-foundation transaction before student/ledger/history reads. Every
  reservation callback rechecks the current foundation/control before any usage
  write or completed replay. New reservation schema 4 stores controlGeneration;
  old schema 3 supports accounting settlement only, never new dispatch or replay.
- Each outbound provider attempt creates one private, sequential, single-use
  dispatch claim under its reservation. Current active matching generation and
  reservation identity/status are read transactionally. At most four claims are
  admitted, within the existing assistant turn bound; analysis/legacy question
  composition emits one. Each tool execution also rechecks the same generation.
  Provider transport remains one attempt per claim; narration uses the same wrapper.
- Dispatch completion and existing reservation settlement may finish after pause;
  they cannot create claims, increase allowance or invoke a provider. Completion
  errors leave observable unresolved claims and conservatively charged reservations.
  A failed/timeout transport records an uncertain claim, never a finished provider
  operation; uncertain claims cannot authorize a next dispatch.
  A pause between reservation and dispatch leaves the existing worst-case charge;
  it does not authorize another call or an automatic refund/retry.
- Return authorization covers successful results, completed replay and fallback.
  Pause/resume never upgrades an in-flight request. A call claimed before pause
  can already be in flight: report provider work draining until claims resolve and
  runtime termination is verified. No automatic expiry pretends external work ended.
- recordStudentBalanceHistoryV3 runtime is unchanged: deterministic create-only
  witness, exact duplicate comparison, no student/ledger/credential/control writes.
  Demo-emulator proof covers all modes and reversed/duplicate delivery. Existing
  malformed/conflicting witness and retry tests remain in the Insights suite.
- The Stage 5 production-runner scenario now reads the persisted credential before
  and after enrolled_noop, rather than expecting loginId from the no-op reply.
  Its title is corrected. The full migration profile executed this scenario.

### Operational cost and rollback carry-forward

No Gemini allowance, Firebase allowance, quote or model-turn limit is raised.
Relative to prior composition: capture uses two consistent foundation reads in
place of the two uncoordinated resolver reads; evidence adds validation to the same
reads; reservation adds two foundation reads. Each claim uses four reads (five
for subsequent claims), one create; finishing it uses two reads, one write. Each
tool gate and final publication use two reads. With four dispatches and eight
tools, the additional successful-path bound is 47 document reads and eight
writes per request (excluding existing evidence/ledger reads and all retries).
Actual Firebase pricing, retry amplification, latency, traffic and combined budget
qualification in staging are still release requirements, not inferred here.

Schema-4 reservations/dispatches require compatible code during rollback. Drain
older revisions and outstanding work; preserve settlement readers and unresolved
claims. Never roll back to a schema-3-only active writer or delete claims/reservations
to bypass recovery. If necessary use the reviewed coordinated maintenance withdrawal.

Next: both independent reviews, then combined mixed-writer/browser acceptance and
rules/saver selection qualification. Carry Stage 4/5 secret, initialization,
strict-rules late-token, old-page drain, scanner NO-GO, IAM, Stage8 L2 and signed-in
live checks. No rules/saver selection, commit, deployment, live data or provider call
has occurred during Stage 6.
