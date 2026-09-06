# Structured Insights production release review

Prepared September 6, 2026. This is a concrete release plan awaiting Muse's final
technical verdict, not a deployment record. Andrew already approved commit,
push, merge and deployment. Codex implements this experiment; Muse 1.3 is the
independent read-only reviewer. Andrew operates Muse's interactive terminal chat.

## Candidate and completed acceptance

Runtime commit: c449b3505b3be55af6bfc955318d797f3cd2585e.
Release base: main 2aabc8e8c879d22b5edb5abccf8ea02a71f0e463.
PR #25: codex/ai-insights-structured-answers, open/draft and mergeable at inspection.
GitHub exposes no status-check results for this PR; local and staging evidence
are reported separately. The final packet pins the documentation HEAD as well.
The original checkout and its unrelated dirty work remain protected.

The complete release includes the 18 inherited AI commits. Their shared live
boundaries were included in round 3, followed by history/memo/diagnostics reviews.
Round 3 and round 5 actually used Contributor; that historical attribution is
preserved. Subsequent reviews use standard muse-spark-1.3. Round 10 was a limited
staging-plan review, not complete production-source clearance. See the packet's
review reconciliation and original verdicts; do not restart completed reviews.
The final review concerns cumulative production readiness and the new artifacts,
configuration, staging evidence, rollback limits and release sequence.

Existing unchanged-code evidence: 1,245 Functions tests; 75 client/contract tests;
root/Functions lint; build; 30 Chromium and 30 WebKit emulator browser tests;
19/19 fictional provider-corpus questions. These are implementation-agent results,
not tests independently executed by Muse. Live staging additionally passed total/
average balances, rent, unsupported memo search, and literal same-ID replay.
Replay returned the full identical response, unchanged reservation/updateTime,
zero second charge, and auth/App Check VALID on revision 00029-wed. Temporary
Hosting files were removed; original file hashes/configuration restored; fake
balances and transaction count unchanged. Budget accounted USD 0.954175 of USD 2.
The old intermittent envelope failure remains unexplained; do not call it fixed.

## Exact production state and artifacts

Project/site morgan-bank, region us-central1. Only analyzeTeacherInsightsV3 and
its compatible Hosting UI are in release scope. No other Functions, Firestore
rules/indexes, migrations, balances, transactions, users or credentials change.
No real student records are exported, copied, reset, or used for a test request.
The feature answers classroom-data questions only, not general teaching advice.

Fresh production metadata: ACTIVE Node 22 revision
analyzeteacherinsightsv3-00018-yof, serving 100% traffic. Existing parameters:
- MULTI_TEACHER_V2_ENABLED=true
- MULTI_TEACHER_V2_RELEASE_ID=student-money-functions-v3
- MORGAN_BANK_DEPLOYMENT_TIER=production
- VERSION3_GEMINI_ENABLED=true
- VERSION3_GEMINI_RELEASE_ID=gemini-3.6-flash-morgan-bank-assistant-v4
- VERSION3_GEMINI_TOOL_ASSISTANT_ENABLED=true
- MORGAN_BANK_STAGING_PROJECT_ID is currently absent; the prepared deployment
  explicitly supplies empty string, matching its declared default. No staging
  project is bound, and all existing values remain unchanged.
Existing secret binding: GEMINI_API_KEY in morgan-bank, version 1. Only binding
metadata was inspected, never the value. No unknown user environment names found.

Both provider gates are already on. This plan replaces the existing enabled
callable after successful staging and preserves that state. It does not claim a
production gate-off rehearsal or new provider enablement. Turning it off would
interrupt the existing service; the reviewer must explicitly assess preserving
these gates during replacement. Any required change to this sequence is a finding,
not permission to silently toggle production settings.

Prepared deployment workspace:
/private/tmp/morgan-bank-production-release-20260906/deployment
It was extracted from runtime commit c449b350, excluding every tracked .env file.
The sole generated Functions parameter file contains only the seven non-secret
values above. Existing local dependencies were linked for build/lint; Firebase
uses the committed package lock for the cloud build. Runtime source and asset
hashes are pinned in artifact-manifest.json outside the checkout.

The browser was built explicitly for production with V2=true, live Gemini=true,
project=morgan-bank and production's public App Check site key read from Firebase
metadata. All configured Firebase browser values match the live public metadata.
The ordinary default build is NOT substituted. Three existing artifact-contract
tests pass: disabled default, live build with App Check/limited-use tokens, and
V2-off refusal. The actual minified release artifact contains the public site key
and production Functions preconnect, with no replay harness or provider-secret
marker. These are static build checks, not a production signed-in canary.

Six build output files are pinned by raw and Hosting-gzip SHA256. Hosting currently
has eight files: six ordinary app files plus Firebase's generated /__/firebase/
init.js and init.json. Firebase CLI supplies those two public initialization files;
postdeploy verification must match the six prepared files and the correct
production initialization configuration. Verify headers/rewrites as well. Current
Hosting baseline is sites/morgan-bank/versions/fafc7bce6c98263a; all eight baseline
hashes and full serving config are saved. No temporary replay page ships.

## Rollback evidence and limitations

Retained Cloud Run revision 00018-yof is Ready and currently serves all traffic.
Its source generation 1788308573368632 exists in bucket
gcf-v2-sources-242031426628-us-central1, object
analyzeTeacherInsightsV3/function-source.zip. No source archive was downloaded.
Artifact Registry reports the old image digest not found. Do NOT claim that
recreating the old revision from that registry image was verified.

Recovery uses the retained Cloud Run revision, whose imported image is retained
by Cloud Run. Google's deployment documentation states an imported image can be
deleted from Artifact Registry after deployment. The identical traffic-command
mechanism was exercised in staging; no production routing change has been made
for this review. Immediately before any deployment, recheck that this retained
revision is Ready and preserve it. The production command, if rollback is needed:

    gcloud run services update-traffic analyzeteacherinsightsv3 --region us-central1 --project morgan-bank --to-revisions analyzeteacherinsightsv3-00018-yof=100 --quiet

Read back 100% on that exact revision. This restores serving code/settings, not
Cloud Functions deployment/source metadata; reconcile that metadata separately.
No database or AI ledger rollback is permitted. Do not delete retained revisions.

Hosting recovery releases the exact saved version fafc7bce6c98263a to this site's
live channel using Firebase Hosting's release API. Before doing so, verify live
still equals this release's recorded candidate (refuse a newer unrelated release),
the old version remains FINALIZED, and all eight hashes/config match the snapshot.
After release, verify those identities again. The corresponding lifecycle was
successfully exercised in staging, including exact restoration. Production
Hosting restoration has not been executed for this packet.

References:
https://cloud.google.com/run/docs/deploying
https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration

## Execution sequence after final review

1. Recheck the completed Muse verdict, immutable packet/source/asset hashes,
   expected PR/main refs, current production metadata and rollback targets.
   Any runtime change, conflicting production change or failed prerequisite stops
   execution for focused assessment. Do not rerun failed tests merely for a PASS.
2. Under Andrew's existing authority, publish the documentation commit, mark PR25
   ready and merge only the reviewed branch. Prefer a merge commit retaining the
   reviewed history; verify the merged runtime tree matches the artifact pins.
   Do not incorporate original-checkout dirty work or an unrelated PR.
3. From the pinned deployment workspace run only:

       firebase deploy --project morgan-bank --config firebase.json --only functions:analyzeTeacherInsightsV3 --non-interactive

   Retain its lint predeploy hook. On success read back new revision, runtime,
   image/source identity, traffic, existing six parameters plus the explicitly
   empty staging-project parameter, and the same version-1 secret binding. Verify
   the old revision remains Ready. On unexpected change or failure, diagnose and
   use the documented traffic recovery when necessary. Do not broaden --only.
4. Only after callable verification, publish the pinned production browser build:

       firebase deploy --project morgan-bank --config firebase.json --only hosting --non-interactive

   Record the new version before subsequent actions. Verify exact release files,
   public project/App Check binding, serving config, and normal application load.
   Do not infer success from CLI exit status alone. Restore the original version
   if a release defect occurs, provided no unrelated deployment intervened.
5. Do not submit any real-classroom AI question as an automatic smoke test.
   Production readback here covers artifact/configuration and application load;
   successful signed-in AI questions are the fictional staging evidence. A later
   user-directed classroom question is separate from this release verification.
6. Record actual merge/deployment IDs, verified state, review caveats and remaining
   live-validation limits. Do not call an unexecuted rollback or real-data canary
   completed, or imply arbitrary questions are guaranteed correct.

Requested verdict: PASS FOR THE SCOPED PRODUCTION RELEASE, CHANGES REQUIRED, or
NEEDS HUMAN DECISION. Name unread critical boundaries and distinguish reviewed
source and reported tests from independently reproduced or live evidence.
