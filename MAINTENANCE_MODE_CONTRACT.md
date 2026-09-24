# V2 maintenance admission — Stage 6 local contract

This describes the new local Functions revision, not deployed configuration or a
verified production fence. It supplements the unchanged R4 integrity design.
The existing global enabled/project/release guards remain required. An additional
string parameter, `MULTI_TEACHER_V2_MAINTENANCE_MODE`, defaults to `closed`.

| Exact value | Admission after existing runtime checks |
| --- | --- |
| `closed` | Deny all V2 callables and profile sync; admit only `recordStudentBalanceHistoryV3` for its create-only audit. |
| `verification` | Allow `getClassroomAccessV2`, `resolveTeacherTenantV2` and the same balance-history audit exception; all existing authentication, tenant and current-control checks still apply. |
| `normal` | Admit the 14 known V2 entry points to their existing service checks. This does not activate a classroom or bypass its policy. |
| Missing, unreadable or any other value | Deny every V2 entry point. No trimming, case folding, truthiness or request override. |

Unknown operation names deny even in normal mode. A new route must be added to
the explicit policy and inventory tests in its own reviewed implementation.
There are still 18 invocation exports, now ten configuration exports. No future
money/receipt route is activated by this change. Each invocation reads the SDK
parameter anew; this makes no promise of cross-instance live parameter refresh.

Verification blocks onboarding of a new teacher AND zero-write replay through
the onboarding endpoint; existing teachers use the two admitted read endpoints.
It blocks invitation creation and revocation, PIN login/list/reset, student
creation/removal/money, Insights dispatch and profile sync before database/Auth handles or service/provider work. A previously
issued valid invitation cannot be redeemed. No invitation/root/audit repair,
generation change, or data write is performed by this pure admission helper.
The admitted balance-history recorder DOES write private witness documents;
closed and verification are not zero-write modes. Only exact closed/verification/
normal values admit it, after the unchanged global/project/release guard. Missing
runtime mode (SDK empty string), unreadable or malformed mode denies even the
recorder. CLI resolution of the declared closed default permits only this audit.

The helper is pure; the production index supplies its operation label and server
parameter. Request fields cannot select the mode. Failures use the existing
generic V2 failed-precondition response and redacted operation/category telemetry.
These are admission checks, not replacements for service authorization.

## Release and recovery requirements — still open

- This revision without explicit configuration denies V2 callables. Every future
  deployment, local Functions-emulator setup and staging/release manifest must
  deliberately select and verify the intended mode. Existing gate-on emulator
  configurations do not imply `normal`; do not silently bypass the new guard.
  Current historical emulator fixtures also need the previously tracked control
  updates. No emulator/browser/runtime configuration is changed in Stage 6.
- Global enabled=false retains the existing legacy compatibility behavior. This
  V2-only mode is not a legacy or direct Firestore write fence. During verification
  the global gate must be enabled with the exact reviewed project/release binding;
  this also keeps legacy callables denied and the legacy trigger inert. Separately
  reviewed strict rules/Hosting must fence direct SDK/REST and old-client writes.
- The mode does not cancel an invocation already admitted, including an onboarding
  transaction retry, or affect an older deployed revision. Before final inventory,
  initialization or verification, establish and independently verify the design's
  full drain/fence across all revisions, callables and triggers. Stop if that cannot
  be established. A flag change or elapsed timeout alone is not evidence.
- Preserve the R4 deterministic balance-history audit exception in both closed
  and verification, including events caused by admitted writers that finish during
  the transition. Keep global V2 enabled and exact runtime/release bindings valid
  while selectively closing callable writers; global-off makes the recorder return
  without writing and is NOT a safe drain strategy when relying on audit delivery.
  Establish the direct-client fence and closure of new callable admissions, drain
  already-admitted/old-revision writers, and observe/reconcile trigger delivery
  THROUGH the transition and final inventory. A pre-window backlog check is not
  enough. Do not initialize or advance until this sequence is independently proven.
- Witness delivery remains create-only, with exact duplicate comparison and the
  existing retry:true; no student/ledger/credential/control writes. Transient errors
  still propagate. Conflicting/malformed events are skipped with sanitized reasons
  under the existing recorder contract: no fabricated repair or continuity. Inspect
  safe diagnostics and reconcile expected committed versions with their witnesses;
  any unproven/missing chain remains unavailable. Do not reconstruct lost history
  from current balances. There is no guarantee of infinite retry or eventual delivery.
- Profile sync remains denied. Its nonretry events can be lost, so strict rules
  must block direct student edits before the window and credentials must be checked
  across the entire transition. Atomic lifecycle writes do not justify silently
  ignoring other writers. Correct trigger revisions, pending/failed-event accounting,
  deployment propagation and the operational fence still require release evidence.
- `verification` is intentionally narrower than the full future readOnly product:
  student login writes credential/log state, PIN listing is sensitive, and receipt
  recovery is not implemented. Neither is allowed merely for being read-like.
  No per-classroom maintenance scope or operator allowlist is introduced; the two
  read routes retain their normal authenticated tenant scope, not arbitrary targets.
- Existing-room initialization must still use the frozen inventory and operation
  journal, readOnly generation1 plus atomic audit, no overwrite on conflict, and
  resumable readback. This document adds no operator or production authority.
- After complete verification, selecting `normal` is a separately authorized
  release action. Keep deferred rooms readOnly and resume only authorized rooms
  with non-reused generations. Normal mode is not evidence that remaining routes,
  client containment or strict rules have been integrated.

## Evidence and review boundary

Tests execute the actual index declarations/callbacks in a VM with injected SDK
factories, parameter values and handles, plus the real runtime guard and real
verification services over synthetic storage. The witness tests inject only its
lazy module-loading seam, then execute the actual wrapper and real recorder with
synthetic create-only storage. No production import or handler body is changed. They prove default closure,
malformed-value denial, all 14 route admissions, pre-issued-invitation denial,
two populated tenants with exact error/read-path assertions, authentication/control preservation, legacy global-on denial and the limitation
for already-admitted work. No test reads the real environment or initializes Admin.
They do not prove deployed parameter propagation, Firestore isolation, trigger
delivery, emulator/rules behavior, production state or a verified maintenance fence.

The prospective Insights production/staging plan addenda require explicit normal
mode binding for normal-service releases and post-deploy revision/config checks.
The preflight reader observes the mode plus every shared guard parameter; it does
not authorize deployment, select a mode or replace per-revision expectations.

Stage 5 follow-ups remain: strict-rules negative control tests, dormant migration
surface enumeration and cross-component operator audit contract. Stage 3 F1 pinned
documents in the actual eventual commit tree and Stage 4 A1 transaction inventory
also remain open. Every material implementation stage still requires Muse then
Claude review; PASS is not deployment, configuration or cutover authorization.
