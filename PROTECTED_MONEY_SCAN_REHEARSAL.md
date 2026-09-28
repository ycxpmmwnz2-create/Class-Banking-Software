# Protected money scan — Stage11 implementation rehearsal

Status: built for fictional local tests; pending Muse then Claude review. Baseline
`d64617e03221bdec9c59bf19dbd631a2fffa5c74` (reviewed Stage10 preparation).
This implements the bounded reader, shared money/projection analysis, change
checks and private file writer. It does not yet implement a production reader,
credential verifier, control-plane inventory, independent live observer, drain or
human-only launcher. No real scan can be enabled by a plan, flag or evidence file.

## Runtime boundary

`functions/operator/protectedMoneyScan/runner.js` accepts only
`demo-morgan-bank-protected-scan` and `(default)`. Real-project rejection precedes
access to dependency properties. No import reaches it from deployed Functions;
no frontend, export, release binding, rules artifact or default Firebase config
is changed. Stage9 exports its existing pure analyzer; its scanner retains its
original demo guard. The separate loopback reader independently rejects real
projects and out-of-scope paths. It issues GET only to literal `127.0.0.1:8080`,
without credential discovery, environment selection, redirects or retries. Its
literal `Bearer owner` header is an emulator convention required for metadata
operations, not a credential or proof of production read-only IAM. Test setup and
race injection use explicit emulator-only SDK writes; the reader has no write API.
Never seed real records into this demo or use its test output for a live decision.

The injected reader/clock/observer/publisher interfaces are trusted fictional test
seams, not a sandbox against hostile JavaScript. The fixture source SHA, owner IDs,
entry state digest and observer sequence are simulated. Their shape and binding
checks do not authenticate a principal, prove a reviewed checkout, establish IAM,
prove deployed rules/Functions, drain writers, reconcile triggers or acquire a
real maintenance lock. Reopen/reclose detection is tested against fixture history;
completeness of real observation is still unimplemented. Production hard refusal
applies in unsafe and safe terminal contexts alike. Automatic agent detection is
not implemented or claimed. The full private Terminal.app procedure remains open.

## Reads and consistency

An immutable bounded plan names a sorted, unique whole-classroom scope, one
reciprocal owner each, explicit suspended-room permissions and a declared canary.
The name-only paginated inventory includes missing parents. A witness-only root
blocks before money reads. Minimal masked root and owner fields establish all
foundations first. Full existing roots, students, ledger and optional rent follow;
credentials, PINs, login history, balanceHistory and unrelated subtrees are excluded.
Missing/null settings retain actual browser defaults. Projection is the real
`projectClassroomData`, with defaults pinned to its index.html call site and an
empty login-history input. The unchanged money analyzer retains exact mirror
parity, pending cents, legacy historical amounts and conservative capacity checks.
No value is repaired, rounded or returned in findings.

REST `showMissing` cannot use orderBy; the service's returned order is validated as
strict UTF-8 name order across pages. Pages are at most 25 and token length is
bounded; repeated/empty-continuation/foreign/duplicate/phantom results abort.
Membership is re-enumerated and every retained create/update version or absence
is rechecked, including owners and missing rent. Changed-and-restored data and
creation after absence abort. This is not an atomic snapshot. A real external fence
is still required through publication; demo sequential checks cannot supply it.

Limits: 100 roots, 20,000 retained documents (including owner/root/absent rent),
100,000 findings, 64 MiB cumulative wire bytes and a separate conservative 64 MiB
copy budget, 8 MiB per response, 32 MiB report, 15-minute run, 30-minute authority.
Response decoding and data copying bound nesting/nodes. HTTP has a 10-second absolute
and inactivity timeout; dependency calls time out at 30 seconds or the remaining
window. Timeout cannot undo a publisher that has already run. There is no resume,
retry or successful-prefix report. These are admission/processing limits, not an
OS RSS cap or proof of production cost. Unsupported Firestore types abort; they are
not converted into apparently valid money. No real transport completeness claim.

## Publication and safe output

The manifest binds frozen plan/evidence/versions and the observer's completed exit
record. Fictional observer hold spans publication acknowledgement; the runner
then rechecks deadlines. Reports contain only locations, versions, fixed findings,
capacity estimates and metadata, never stored names, balances or credential fields.
They are still restricted artifacts. Tests use exclusively fictional values.

The local publisher requires `/usr/bin/python3` with descriptor-relative filesystem
operations. It traverses absolute canonical directories using no-follow directory
fds, requires an owned 0700 parent, creates an exclusive 0700 run directory and
0600 regular file, writes fully, fsyncs, rereads its digest, links atomically without
overwrite, unlinks the temporary name and fsyncs the run directory. All operations
remain relative to held descriptors. A renamed ancestor cannot redirect output.
It refuses real-project report tags, symlink ancestors, permissive parents and
reused IDs. It never deletes an earlier run. No network or credential input enters
this helper. macOS local tests cover short/zero writes, disk-full, readback mismatch,
sync/link failure, renamed parent, concurrent publication and existing run refusal.
These are syscall fault simulations, not a physical power-loss/disk durability test.

Only a matching durable receipt plus final hold/clock checks returns completion.
A report always has `artifactAccepted:false`, `productionEligible:false`,
`initializationAllowed:false` and `activationAllowed:false`; a file's existence or
embedded summary status never authorizes consumption. Failure before publication
returns `publication:not-attempted`; after it starts, returns `unconfirmed` because
a file might exist, including after timeout. Such a run stays aborted permanently;
no persistent acceptance token or production consumer exists. This explicitly
corrects Stage10's overly absolute claim that every abort means no file was published.

The returned summary contains project-total counts and fixed reason counts only;
it explicitly includes the fictional canary. Fixed abort categories map to actions:

| Categories | Meaning / next step |
| --- | --- |
| live-unavailable | Stop; this tool has no live path. |
| invalid-plan, authorization, expired, clock | Obtain a fresh valid scope/window; no bypass. |
| scope, foundation | Resolve the inventory conflict under separate authority. |
| transport, budget | Diagnose with fictional reproduction; do not accept partial results. |
| drift, continuity | Close this run and re-establish fresh independent evidence. |
| storage | Retain uncertainty, do not reuse the run, resolve local storage. |

No raw SDK/OS exception text appears in returned errors. Future live summaries may
be manually shared by Andrew with Codex under his Stage10 decision; restricted
reports and every private-data process stay outside agent-visible/readable tools.

## Reproduce locally

Use already-installed Node, root/functions dependencies, Firebase CLI, Java and
`/usr/bin/python3`. Current evidence is Node 24; Node 22 target validation is open.
No dependency installs or downloads are required with the cached emulator. If it
is not cached, stop; do not download during a network-disabled review. Ports must
be free. No login, production account or ADC is needed; the guarded command refuses
local ADC, scrubs credential/project/emulator variables and isolates CLI config.

```sh
npm run test:phase3:unit
npm run test:phase3:contracts
npm run test:phase3:protected-money-scan
npm run lint
```

The emulator suite proves paginated REST reads/private persistence, unchanged
source bytes and update times, missing parents, edit/restore drift and scoped
transport refusals. Each of five canary write probes succeeds under the exact
local prior rules artifact and fails unchanged under the maintenance artifact with
the same identity/body. Invalid auth/schema fail the success control. This is not
live denial evidence, batch/transaction drain coverage or a complete operator run.
Existing maintenance-rule tests cover additional write surfaces separately.

Remaining Stage10 gates include the real inventory/identity/observer/lock/launcher,
macOS operator privacy rehearsal and unsafe-context detection/refusal, canary
lifecycle/recovery, live baseline/revision/queue evidence and separate operation
approvals. Test PASS does not authorize a real scan, maintenance change, commit,
release, initialization or activation.
