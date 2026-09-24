# Teacher money and recovery: complete source export matrix (R4)

Baseline: `86c7c148611250cad93502e2bc9b13179b34a65c`.
This is the proposed disposition of all 17 callable/trigger exports in
`functions/index.js`, not a claim that the wiring has been implemented.
The nine parameter/secret/release-constant exports are configuration, not
invocation surfaces. No scheduled Function is declared in that file.
Production deployed-export inventory remains a separate release preflight.

Control policy: the root's `accessControl` is read alongside the reciprocal
teacher/classroom foundation. Active permits current-generation mutations;
readOnly permits scoped reads and only named recovery/audit writes; suspended
denies application data access. Operator actions are separately authorized.

## Baseline exports

| Export | Required disposition | Evidence test required |
| --- | --- | --- |
| `studentPinLogin` | Legacy-denied throughout V2 cutover and recovery; never reopen by deploying legacy gate behavior. | Gate-on legacy invocation makes no credential lookup/token. |
| `resetStudentPin` | Legacy-denied; no old reset writer during maintenance or recovery. | Gate-on refusal and no PIN/Auth mutation. |
| `syncStudentProfiles` | Legacy trigger inert in V2; old executions drained before declaring maintenance fence. | Legacy event produces no V2 or flat credential write after fence. |
| `ensureTeacherClassroom` | Legacy-denied; cannot bootstrap around V2 onboarding/control. | Gate-on refusal, no teacher/classroom creation. |
| `resolveTeacherTenantV2` | Re-read active reciprocal foundation and current root control. Return public tenant identity/mode/generation for active/readOnly; suspended generic denial. No classroom write. | Both ownership directions; disabled/missing/malformed state; control changes during resolution. |
| `onboardTeacherClassroomV2` | During cutover no new onboarding. After activation, existing platform invitation authorization plus transactionally create generation-1 active control with new reciprocal foundation. Existing tenant replay must honor its current control; never overwrite/reset generation. | Interrupted enrollment, replay, consumed/revoked invitation, existing suspended tenant. |
| `createTeacherInvitationV2` | Platform-admin lifecycle, not classroom money. Keep existing signed admin authorization. Deny new invitations during project maintenance via the existing V2 invocation gate; afterward classroom pause alone does not remove unrelated platform-admin powers. Creating an invitation cannot resume a paused classroom. | Ordinary teacher/student denial; maintenance refusal; paused admin cannot mutate classroom through invitation creation. |
| `revokeTeacherInvitationV2` | Same platform-admin boundary. During V2 maintenance gate-off, browser callable unavailable; emergency revocation uses explicitly authorized operator tooling. No classroom access-control changes. | Maintenance denial; resumed admin role intact; revocation never rewrites existing classroom foundation. |
| `studentPinLoginV2` | Verify scoped credential + reciprocal foundation + root mode in the verifier transaction. Active/readOnly may issue session with current control generation; suspended cannot issue usable access. Bounded throttle/auth logs are security-record exceptions. Recheck before token mint; current rules/callables still deny a late token during suspension. | Pause before/after verifier, hash delay and token mint; credential-version mismatch; no data/money access using a late token. |
| `resetStudentPinV2` | Require mutable request protocol/generation; re-read foundation/control INSIDE credential/PIN write transaction after hashing. Auth revocation for an already committed reset can finish during pause, since it narrows access. No new credential writes after pause. | Barrier after hash and each transactional read; ownership transfer/disable; pause-resume generation mismatch; exact PIN mirror and credential agreement. |
| `createStudentV2` | Current-generation foundation/control checks in lifecycle transaction; request deduplication, actor pointer, quota, opening ledger/mirror and credentials atomic. | Lost response/new device; same/different create digest including PIN; pause; opening reporting; no duplicate student or orphan credential. |
| `removeStudentV2` | Current-generation transaction atomically removes student/deactivates credentials as baseline; preserve history and records. A preaccepted removal may complete ancillary access revocation while paused. No late credential trigger may reactivate it. | Pause at transaction barriers; concurrent award/rename/removal; preserved ledger, inactive credentials and no post-pause trigger repair. |
| `listStudentPinsV2` | Sensitive read: active only. Explicitly unavailable in readOnly/suspended, even though ordinary profile/history reads remain. Recheck foundation/control immediately before returning; output already sent before pause cannot be recalled. | Existing teacher token, owner switch, readOnly/suspended refusal, no PIN in error/log. |
| `submitStudentTransactionV2` | Exact student credential/version plus current reciprocal foundation, active mode and generation on every attempt. Adopt N1 integer amountCents and current/resulting balance domain; reject old unbounded dollar requests before money/mirror/throttle writes. Preserve Add Pending/Subtract Approved, frozen/insufficient-funds/throttle/replay, with stored dollar shape and T1 ISO date. Historical names are immutable; replay binds ID and exact mirror/ledger parity. | Ceiling accepted when otherwise valid, ceiling+1 rejected; old shape, unsafe conversion, pause/resume/stale generation, renamed replay, duplicate ID and teacher concurrency. |
| `analyzeTeacherInsightsV3` | New evidence work/reservation/dispatch claims require active current-generation authorization. Propagate that requirement through analysis/question/tool services, evidence loaders and usage ledger. Settlement of an already-reserved request is accounting-only exception; no increased allowance or new provider dispatch. Guard answer return with current authorization. | Control change before evidence/reservation/each tool dispatch; pause after dispatch claim; late settlement/replay; budget unchanged by blocked new call. |
| `syncStudentProfilesV2` | Inert for enrolled protocol-1 classrooms, determined by transactional root marker check. Lifecycle/reset paths synchronously own credentials. Pre-enrollment drain/reconciliation required; never defer a credential mutation for automatic replay on resume. | Late historical event, out-of-order delivery, new enrollment, remove/create/reset/rename; no credential/PIN mutation for enrolled root in any mode. |
| `recordStudentBalanceHistoryV3` | Allowed create-only, deterministic audit of a previously committed event in ALL modes. Retain its private server-only destination, exact duplicate comparison and retry rules. Cannot change student, ledger, credentials or control. This is an explicit audit exception to pause. | Pause during delivery, duplicate/out-of-order events, malformed/conflicting witness; zero changes outside the exact witness path. |

## New planned surfaces

| Surface | Policy |
| --- | --- |
| `planTeacherMoneyV2` | Active current owner/generation, read-only consistent bounded-prefix preview of at most 100 supplied IDs; 64 KiB request/reply. Reserve worst-case complete dependency-group bytes BEFORE each read within the planner's own 8 MiB budget, including existing-document/overhead bounds. Stop before an unsafe read; return feasible prefix plus ordered remaining `notYetPlanned` IDs only, or explicit single-target limit without a plan. No unbounded query/all-target prefetch. Retry resets accounting; continuation freshly reauthorizes and never merges snapshots. Exact-action/version/size plan expires in 60 seconds. No receipt/money writes or auto-submit. Authorized summaries only; a plan grants no authority and execution revalidates all fields. |
| `executeTeacherMoneyV2` | Active current-generation transaction; current exact plan checks; money/ledger/mirror/receipt/actor/quota atomic; T1 dates. Rejected invocation leaves money/pointer untouched; valid correlated rejection triggers client automatic same-key recovery, never error-based unfenced clearing. |
| `getTeacherMoneyStatusV2` | Active/readOnly current teacher only; own unresolved receipt status with the minimal R3 response. Available outside classroom projection. No writes. |
| `acknowledgeTeacherMoneyV2` | Active/readOnly, own committed receipt and exact pointer; recovery metadata only. Explicit teacher acknowledgment may use terminal status without a successful classroom reload; no stale data publication. |
| `cancelTeacherMoneyV2` | Active/readOnly, create-only cancelled tombstone fences the whole authenticated request key, any digest; no money write, no different-pointer change. Automatic recovery after ordinary dispatched rejection is allowed; committed winner instead requires acknowledgment. No payload/PIN needed. |
| `editStudentProfileV2` | Active current-generation expected-name compare-and-set, or successful no-op if current already equals requested new name; immutable historical names, current profile only. Separate from balance adjustment. |
| `getClassroomAccessV2` | Active/readOnly; authenticated reciprocal teacher or exact active version-bound student credential. Return only mode, protocolVersion and generation. Suspended generic denial; no sensitive data and no writes. |
| Local operator CLI | Existing IAM plus explicit project/classroom list, expected generation and operation ID. Plan/dry-run by default; separately authorized execute writes control and audit atomically. No browser role escalation. |

Teacher resolution and student login return control generation for new sessions.
An explicit refresh uses `getClassroomAccessV2` before enabling a newly composed
mutation. Never substitute the newly read generation into an old queued intent.
The mutation request preserves its captured generation; it fails after resume.
No control claim in an ID token is required for current read authorization.
Fresh rules still check root control and credential version on each request.

Cutover is project-wide for the single default database: complete inventory,
interim deny-write rules, old-writer drain, final scan and control initialization
for EVERY classroom. Deferred numeric/capacity cases use the same strict rules
and compatible client under readOnly, never an old-rules cohort. Activation waits
for remediation and a fresh scan. Invalid foundations stop the project transition.

## Non-exported write dependencies that must be tested through real callers

- `functions/phase2b/resetStudentPin.js`: credential+PIN writes and postcommit
  Auth revocation; no early-resolver-only authorization.
- `functions/phase2b/studentCredentialVerifier.js`: throttle/log writes allowed
  while refusing suspended access; active session cannot be minted from disabled
  or mismatched foundation. Do not retain PINs in audit data.
- `functions/phase2b/syncStudentProfiles.js`: enrolled-root no-op must precede any
  credential create/refresh/deactivation. Invocation guard alone is insufficient.
- `functions/phase3/studentLifecycle.js`: allocator, public profile, credential,
  PIN directory, opening adjustment, actor pointer and receipt all accounted.
  T1 ISO dates; create-intent HMAC replaces any generic unkeyed digest, not a
  supplementary PIN-derived value. Receipt-only acknowledgment survives reload
  failure without claiming the view is current.
- `functions/insights/firestoreUsageLedger.js`: reserve and dispatch claims fence
  new external work; charge settlement of an old reservation is a narrowly
  classified exception, never a path to a fresh reservation or larger allowance.
- `functions/insights/balanceHistoryLedger.js`: audit-only as listed above.
- `functions/insights/storedTransactionDate.js` and both evidence adapters: exact
  ISO and legacy wall-clock acceptance, explicit canonical reporting-zone input;
  affected reporting reductions must not silently use the process time zone.
- Dormant production migration/reconciliation writers do not run in this release;
  operator manifest explicitly forbids them. Future use needs its own control
  compatibility review and approval. Do not claim that Admin SDK IAM prevents a
  project operator from bypassing application policy.

## Evidence and closure

Source inventory verification mechanically compares the baseline onCall and
onDocumentWritten exports with this table and rejects missing/extra rows.
Implementation must add barrier tests per caller and real final-rules tests;
a unit test of the shared helper is not enough. Actual deployment inventory,
old-revision drain and trigger delivery are release evidence, not proven by this
document or its source inventory check.
