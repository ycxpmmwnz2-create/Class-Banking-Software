# Conversational earnings candidate — local review checkpoint

Status: implemented locally; independent Muse review required. NOT ready for deployment. This change is not covered by round16's PASS FOR ISOLATED TEST.

## User-visible scope

Current-roster most/least money-added comparisons now have a dedicated full-roster operation and a separately labelled Gemini AI summary above calculated facts. Other question types retain their existing structured answers. There is no general teaching advice. The implementation follows the accepted preview; arbitrary Gemini prose can still be factually wrong. A deliberately false fluent paragraph passes the syntax boundary in the adversarial test and stays separate from the code-owned answer. No semantic correctness guarantee is claimed.

The operation counts Approved Add amounts by stable student reference across all current students, including zero earners and complete ties. Former students are excluded. Amounts are compared in cents. Supported windows: previous Monday–Sunday in the classroom timezone, explicit calendar dates (up to 90 days), and the exact existing rolling period. Partial first-day retention yields an explicit coverage warning; exact local midnight is complete. Empty rosters, DST, same-name identities, incomplete history and 500-student ties are tested. Questions requesting categories, subgroups, other statuses or former students must use the existing tools and retain their original answer format.

## Integration and failure behavior

The live composition uses conversational-v1 for its request signature and stored schema 3, leaving existing structured-v1 entries untouched. The public response preserves its calculated `answer`; an optional exact `presentation` contains the separate AI summary and a lossless split of the calculated text. The updated browser accepts old responses and escapes every dynamic string.

Planning and narration share the existing reservation, application allowance, hourly slot, tenant binding and completed response. A completed request replays identically without new provider work or usage writes. All four existing planner turns remain available; when planning uses the fourth turn, narration yields its slot. At most three planner turns plus one narrator call, or four planner turns without narration, preserves the reviewed output/thinking ceilings. Narration has no tools, one transport attempt, at most 15 seconds within the original 60-second deadline, a bounded prompt and output. Large ties retain the complete calculated answer rather than truncating names for narration.

A malformed/truncated reply keeps the calculated answer and settles confirmed usage. Missing/invalid usage or transport failure keeps the full original reservation as a conservative charge, saves the fallback, and explicitly reports `reserved-unknown`; recorded token counts include only confirmed usage, not invented totals. This is a policy reservation, not an invoice claim. If the combined quote will not fit, the service attempts the base quote and skips narration. Exact replay can try both quote sizes, with all tenant/request/signature fields still checked. A failed commit preserves the active/uncertain reservation and refuses another provider run, including when markUncertain itself fails.

## Verification

Final logs in `/private/tmp/morgan-bank-conversation-candidate-20260906/verification/` contain the exact counts for both package-script suites, ESLint, build and diff checks. The tests use fictional records and injected SDK/in-memory Firestore semantics. The live-composition tests execute the actual teacher resolver, evidence loader, assistant, service, pricing and usage ledger; they are not live Auth/App Check or deployed Firestore evidence.

Browser verification used the actual `renderQuestionAnswer` module and app stylesheet with fictional props in Chromium, at desktop and 390px widths. It checked AI/fact separation, escaped HTML-like model/name text, no script/image execution, and visible calculated fallback. All page network requests were blocked. Screenshots were visually inspected. This is not a signed-in deployed app smoke.

## Real Gemini evidence and open issue

First candidate run, using fictional 40-student data and the staging key in memory:
- Most/least: correct $30/$0 and named students, but the summary was too verbose.
- Ties: correct two students at $30 and the other 38 at $5.
- Partial history: Gemini chose generic capabilities rather than the specific successful earnings coverage result. This was an honest but unhelpful fallback; no false extrema were stated.
- Each of these three calls through the service replayed exactly with zero added calls, cost or writes. Only in-memory usage collections were written.
- Additional confirmed/reserved cost: 55,542 microUSD. Cumulative total: 1,072,331 microUSD.

The prompt was narrowed to avoid repeating visible dates/filter boilerplate and to select the successful earnings result even when complete:false. A follow-up run then failed on its FIRST scenario and stopped. That runner did not persist a useful failure category or provider phase trace; the exact cause is UNKNOWN. It must not be described as a proven provider outage or a proven application defect. Its full 514,536 microUSD reservation remains conservatively accounted, with no automatic retry or refund.

Current cumulative accounting: 1,586,867 microUSD ($1.586867) of the original $2 ceiling. Remaining: 413,133 microUSD. A new whole-candidate attempt currently quotes 514,536 microUSD and cannot fit. No further paid call was made. Both run directories are atomic and cannot be restarted. Subsequent local-only changes added allowlisted failure diagnostics for future runners and restored the fourth planner turn; the regression proves narration yields that slot. These changes have NO new successful real-provider run.

Exact provider-run source snapshots and preflight hashes are preserved separately for each paid run. The current candidate differs as described; do not relabel those historical runs as proof of the final prompt/turn behavior.

## Remaining release gates

Independent review of this exact candidate; reconcile concrete findings; a successful adequately instrumented fictional provider check of the final candidate (requires enough explicitly authorized remaining budget); then deployed staging Auth/App Check, same-request replay, current artifact/configuration and signed-in browser checks. Browser compatibility requires serving the client that accepts optional presentation before enabling the new function response. No bank records or old usage responses need migration or deletion. Rollback restores code; the answer-contract boundary may refuse old in-flight retries, which must be surfaced honestly rather than rebilled silently.

No commit, push, merge, deployment, rule change, student-data write or data reset occurred in this checkpoint. Existing production remains unchanged.
