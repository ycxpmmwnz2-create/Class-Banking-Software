# Roster adjustments and forward-looking balance history

Local candidate, not deployed. Andrew authorized implementation and Muse Spark
review; Codex implements, Muse reviews, Claude is not part of this iteration.
Earlier ownership text is superseded by Andrew's current instructions.

## Why the previous answer was wrong

Roster edits/reset-all previously overwrote a balance without recording a
transaction. Subtracting later Approved transactions from today's balance
therefore could not reconstruct the earlier balance. Transaction dates and
statuses are also editable and cannot certify a historic balance. Old amounts
do not need to be recovered; Andrew requested reliable history going forward.

## Two complementary changes

1. The roster UI prepares an Approved Teacher adjustment for each changed
   balance, including bulk reset. Zero-delta/name-only edits add no adjustment.
   Each entry labels the change as a balance adjustment, not earnings or a
   purchase. Existing Add/Subtract transaction summaries still include these
   recorded amounts; category-specific reporting can distinguish them. No
   transaction/reporting-category semantics were silently redefined.
2. `recordStudentBalanceHistoryV3` records trusted before/after Firestore
   student-document versions into `classrooms/{classroomId}/balanceHistory`.
   Current document metadata plus a connected sequence of these records proves
   dated balances independently of the editable transaction ledger. No client
   can read or write this collection under the pinned final rules. Insights
   reads it server-side after resolving the teacher/classroom foundation.

The audit writer never changes a balance, transaction, roster or credential.
Its record contains schema version, classroom/student IDs, incarnation
(`createTime`), before/after versions (`updateTime`), and before/after balances.
It stores no name, PIN, memo, credential or question. Records are create-only
with deterministic IDs: retries compare an existing record instead of replacing
it. Every student **write**, including name/mirror changes, is witnessed because
version continuity matters; deletions are ignored because historical answers
cover only the current roster. A new incarnation cannot use an old one's chain.

## Honest availability

- An unchanged document proves its balance on dates from its last write onward.
- Otherwise every intervening version must connect, with matching balances.
- Missing, inconsistent, foreign or delayed records do not authorize an answer.
- Today is the current snapshot, never a future end-of-day amount.
- Historical tools consume only verified dated evidence; they do not fall back
  to transaction arithmetic. Partial answers identify unavailable students or
  dates and never assert a complete zero-match result.
- Historical answers retain their verified rendering/narration bypass. Other
  tools and narration keep their existing behavior.
- A snapshot read crossing classroom midnight is refused and can be retried.

There is no global switch, browser field, question phrase, or provider argument
that certifies historical integrity. No migration, backfill or inferred opening
balance is created. Older history is shown only where actual version evidence
supports it. Delayed event delivery can temporarily leave a gap; out-of-order
delivery is safe. A permanently missed/no-op event can leave a permanent gap:
the reader must not jump it merely because adjacent balances look equal.

## Bounds, privacy and operational cost

Each valid student-document version event adds one small history document.
Duplicate deliveries add no documents but may incur create/read attempts.
Permanently invalid identity/path/state events (including equal-version no-ops)
are acknowledged without database access, with only a fixed reason code logged.
Conflicting duplicate witnesses are acknowledged with a redacted warning and
the first stored record is preserved; retrying cannot repair that conflict.
Missing links still make history unavailable, never an inferred zero. Database
failures and unexpected exceptions still propagate for retry; this does not
claim a bound on retry costs during operational failures.
An assistant-mode Insights request makes one additional, ordered, same-snapshot
query for at most the latest 5,000 classroom history documents. This applies to
all assistant questions, not just historical ones. The available date window
remains at most 90 days (91 touched calendar dates); the record cap can shorten
actual coverage. This is a bounded correctness tradeoff, **not** a claim of
faster startup or lower Firestore cost. There is no automatic history deletion
or TTL in this candidate. Storage grows with student writes.

Only resolved dated balances, deidentified under the existing student mapping,
reach the tool evidence. History IDs/versions/classroom IDs do not reach the
provider. History-derived values enter the evidence signature so a changed
history result cannot reuse a stale signed answer. Existing Firestore rules,
indexes, credential controls and tenant-saver atomic/concurrency protections
are unchanged. Teacher-side adjustment preparation lives in `src/teacher`,
outside the deliberately restricted Phase 3 projection/service module boundary.

## Release and rollback gates

This candidate needs Muse's read-only review, then Andrew's explicit release
authorization. A release would involve the new `recordStudentBalanceHistoryV3`
trigger, the existing `analyzeTeacherInsightsV3` callable, and Hosting. Deploy
the history writer before the new reader/UI, verify Eventarc delivery in the
authorized environment, then verify readback with separately authorized
fictional data. No live teacher/classroom data or provider run was used to build
this candidate. Do not deploy other Functions, rules, indexes or migration tools.

The trigger uses the existing default-off V2 environment/release guard before
Firestore construction and retries failed delivery; maximum instances is two.
Actual deployed event delivery/IAM/configuration and signed-in browser behavior
remain separate release checks. The local emulator test calls the writer with
real Admin snapshots; it does NOT prove Eventarc delivery or cloud retry policy.

Do not roll the historical reader back to the previous arithmetic-based answer
while leaving history questions enabled: that would reintroduce false answers.
Stop/disable affected historical functionality with a reviewed rollback plan
instead. Do not delete recorded history as rollback cleanup. Old cached Hosting
clients may still overwrite balances without an adjustment transaction, but the
server witness captures their actual student writes once deployed.

## Verification surfaces

- `npm run test:teacher:balances`: real inline roster handlers executed with
  DOM/save seams, plus pure preparation tests.
- `npm run test:phase3:unit`: real saver with stateful transactional double;
  balance, ledger and mirror atomicity; conflict/failure/retry checks.
- `npm run test:phase3:contracts`: unchanged allocation/module boundaries plus
  the new trigger's static guard/wiring check.
- `npm run test:phase3:rules`: pinned bridge/final/rollback rules in the isolated
  emulator; all-client history denial; real Admin metadata, ordered history
  query and duplicate-write checks.
- `npm run test:version3:gemini-layer`, `npm run test:functions`,
  `npm run test:version3:insights`, both lints, build and diff check.

The prior historical calculation tests now supply explicit fictional dated
evidence for their retained filtering/formatting/range/narration assertions.
Version-chain tests and adapter integration tests own the new source-of-truth
proof. Six of eight independent missing-history regressions fail against the
unchanged baseline; two preservation guards pass. No review or passing test
authorizes deployment or production data access.
