# Structured Insights: controlled staging plan

This is a reviewable plan, not an execution record or production sign-off.
Andrew has approved commit, push, merge, and deployment. Preserve every existing
bank record and unrelated work. Codex implements this experiment; Andrew runs
Muse 1.3 read-only reviews. No repeated approval is needed for already authorized
release actions, but technical prerequisites must be met before execution.

## Exact source and scope

Candidate: `codex/ai-insights-structured-answers`, local HEAD
`27825fbbcb613c4844b16cf5b1ec9101073782ca` plus the frozen working-tree patch.
Release base: main `2aabc8e8c879d22b5edb5abccf8ea02a71f0e463`.
The complete patch includes the 18 inherited AI commits, not just diagnostics.
Keep the original checkout untouched. Commit only the frozen candidate after
review closure; verify it reconstructs the reviewed after-tree. Recheck remote
main before preparing a PR. If main moved, assess the changed overlap before
claiming the same review applies. Staging must precede production release.

First deployment target: Firebase project `morgan-bank-staging`, region
`us-central1`, ONLY `analyzeTeacherInsightsV3`, Node.js 22.
No Hosting, other Functions, Firestore rules/indexes, migration, reset, export,
credential reset, or student-money operation is included in this first step.
Only the existing AI usage ledger can record question reservations/settlements.
The UI diff changes two help/placeholder strings; existing string rendering is
compatible in local tests. Verify the current staging browser's compatibility
and project identity before using it for live smoke. Do not deploy the ordinary
production-default `dist` to staging.

## Configuration preservation and prerequisite checks

Fresh read-only staging metadata is included in the review packet. It shows an
ACTIVE pre-experiment function updated 2026-09-01T23:15:14.049319641Z with the
following known non-secret parameters:

- MULTI_TEACHER_V2_ENABLED=true
- MULTI_TEACHER_V2_RELEASE_ID=student-money-functions-v3
- MORGAN_BANK_DEPLOYMENT_TIER=staging
- MORGAN_BANK_STAGING_PROJECT_ID=morgan-bank-staging
- VERSION3_GEMINI_ENABLED=true
- VERSION3_GEMINI_RELEASE_ID=gemini-3.6-flash-morgan-bank-assistant-v4
- VERSION3_GEMINI_TOOL_ASSISTANT_ENABLED=true

Existing binding: GEMINI_API_KEY, staging project, version 1. Keep that binding;
never read/display/copy the value into files or a review packet. Do not copy
protected checkout .env files. Firebase CLI parameter resolution can replace
existing variables with defaults, so the seven explicit values above must be
supplied through a newly generated, untracked, non-secret deployment parameter
file in an isolated deployment workspace. Preserve any additional user-managed
settings discovered on the fresh predeploy metadata read. Built-in platform
variables remain platform managed. Refuse unrecognized target/secret changes.
Never resolve an interactive deployment question by accepting a guessed default.

Both provider gates are already enabled in staging. This plan preserves that
existing state, not a new gate activation. Review whether staging's existing
use permits replacing that already-enabled callable. If it requires a gate-off
sequence or separate canary endpoint, resolve that concrete scope before deploy;
do not silently change the existing gates or claim a gate-off test occurred.

Before deployment, capture the exact current Function/Cloud Run revision,
container image digest, runtime settings and source-generation identity using
metadata only. Verify the old artifact is still available and prepare a tested
CLI/API rollback procedure restoring that artifact and those settings. The
source generation in the present snapshot is 1788304426791441 in
`gcf-v2-sources-882735123688-us-central1/analyzeTeacherInsightsV3/function-source.zip`.
This pointer alone is not a verified rollback. **Do not deploy until the exact
restore procedure and artifact availability are established.** Rollback affects
code/configuration only; never restore a database or rewrite usage records.

After source identity, configuration and rollback checks, the intended deployment
command is the following, from the isolated reviewed deployment workspace:

```sh
firebase deploy --project morgan-bank-staging --config firebase.json --only functions:analyzeTeacherInsightsV3 --non-interactive
```

Codex runs this ordinary deployment step, not Andrew's Muse terminal. The command
is documented for review and has NOT run. It is not ready to execute until the
prerequisites in this document are verified. Use the installed CLI and retain its
lint predeploy hook. Never broaden --only to make an error disappear. Capture a
sanitized deploy log and re-read exact project, new artifact identity, runtime,
release values, gates, and secret binding. Stop on any unexpected difference.

## Real staging acceptance and stop conditions

Before deployment, identify the existing approved fictional staging classroom
and teacher session, confirm the browser targets staging with real App Check,
and freeze expected values/question scope without importing production data.
These session/fixture details are still pending; do not assume emulator fixtures
exist in staging. If a new synthetic classroom is necessary, prepare its exact
creation/cleanup scope first; never overwrite an existing classroom or grant
access to real data for this test. Staging does not need real student evidence.

Run two separately identified, back-to-back accepted staging questions through
the signed-in teacher browser/callable against that fictional fixture: a balance
question and a supported transaction/rent question with fixed expected results.
Also check an unsupported memo-search question yields the capabilities response.
Record the visible answer, executed scope, generic errors if any, and sanitized
request/revision metadata. Verify a same-request replay does not create another
provider charge, and preserve the existing App Check/auth/tenant boundaries.
These are additional live boundary checks, not proof of arbitrary language
coverage. Use the application ledger limits and remaining original test ceiling;
set a concrete worst-case allowance before requests, stop if insufficient, and
never silently raise the USD 2 synthetic-test budget or retry a failed question.

The previous unexplained answer-shape failure remains a reliability risk despite
the new 19/19 provider run. Any recurrence stops staging progression; retain only
safe typed diagnostics and request metadata, never rejected student/model text.
Do not retry until a test passes and call that a fix. On a bank-data mutation,
wrong tenant/project, lost setting, weakened auth/App Check, or unexpected cost,
stop immediately and use the verified code/config rollback when needed.

## Remaining evidence before production

Muse's requested verdict is controlled staging readiness, not production PASS.
Pending prerequisites: immutable commit binding, fresh target/config readback,
verified rollback command/artifact, known fictional staging session and expected
results, real Node 22/App Check/callable behavior, and live staging acceptance.
After successful staging, prepare the exact production callable and separately
configured Hosting artifacts, review the release evidence, and use Andrew's
existing release authorization. No production deployment or merge is claimed by
this packet. A PASS on this plan cannot replace the pending live checks.
