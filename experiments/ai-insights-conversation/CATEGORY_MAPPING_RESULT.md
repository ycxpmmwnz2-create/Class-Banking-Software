# Displayed transaction category mapping

Baseline: 0ef3ac7aee1cc69ab5844437cb1de21a659acb9e on codex/ai-insights-result-format. That formatting fix passed Muse round20, was committed/pushed, and is staged as analyzeteacherinsightsv3-00032-led. It has not been merged or deployed to production. Production remains analyzeteacherinsightsv3-00021-vos. This is a separate correction discovered by the required staging test, not a repeat of completed round20.

## Observed defect

The fictional staging history showed Michael Jordan's Approved Homework additions on August 5, 8 and 9. One real Auth/App Check request asking how many days he earned Homework money from August 3 through 9 completed successfully with constrained format and friendly narration, but reported one day/one matching transaction. The completed result was saved; no provider retry or replay followed.

Read-only verification of the fictional records explains the difference: August 5 has category Homework; August 8/9 have empty category and reason Homework, source Student, status Approved. This is the canonical student submission shape in functions/phase3/studentMoney.js (reason is persisted and category is empty). The history/export displays category || reason. AI assistant evidence previously exposed only category, so its category filter missed valid student-entered transactions. This is an input-mapping defect, not a wording imperfection.

The staging checker also expected full names/capitalization while the assistant uses first-name display labels and case-insensitive filters. Those helper assumptions are not product defects. The three-versus-one count discrepancy is independently grounded in the fictional records. Original helper/failure, saved result, ledger and record-field evidence are retained outside the repository. Helper removed and exact clean Hosting restored.

## Correction

The assistant builds its effective category from category || reason and uses that value for both the tool records and category catalog. Explicit category retains precedence. No hardcoded Homework/Technology list or question parser is added: custom displayed reasons work too. Memo remains separate and is never promoted into a searchable category.

The effective labels use the existing bounded assistant text sanitizer, contact and surname redaction, and strict stored-text obscured-name check. Unsafe obscured labels become Private category. Category deduplication/type grouping and the existing category-count cap still apply. The projection does not mutate source records. Raw evidence/signature, tenant reads, dates, statuses, rent-purpose classification, balances and ledger/replay logic are unchanged. Legacy planner/answer evidence keeps its prior category contract. The round20 schema formatting and broad Gemini narration remain intact.

## Verification and limits

Six new focused tests: before correction five failed and one passed (explicit category precedence already worked). After correction all pass. The realistic mixed-storage fixture goes through the actual evidence loader, toolbox aggregation and structured result registry and returns three days/three approved transactions; pending and out-of-window rows are excluded. Additional tests cover Technology, Class Store Purchase and an arbitrary custom reason, explicit category precedence, memo exclusion, contact/surname redaction and padded-name handling. No stored fixture mutation.

44 evidence-adapter tests and the full 536 Gemini-layer checks pass; functions lint and diff checks pass. Existing suite covers maximum-size evidence, tenant isolation, replay, format enforcement and narration. These are local tests; no corrected-mapping live Gemini or deployed staging result is claimed yet.

The completed staging format test charged 14048 microUSD (8325 input tokens), bringing conservative fictional spending to $2.368372 of the authorized $3.00. $0.631628 remains. Completed runners, the original staging request, and round20 review must not restart. A fresh request for the new candidate and its exact replay remain post-review staging gates, subject to the unchanged 610000-microUSD per-call headroom guard and ledger checks. No production AI retry, bank-data writes, migrations, resets or credential changes occurred.

Muse Spark 1.3 returned PASS WITH CONDITIONS on this exact adapter/test/document delta; no code changes requested. The existing 128-category cap now counts distinct displayed reasons as well, a known cardinality limitation. Pending: verify a correctly counted deployed question and exact replay before merge/production release under Andrew's standing approval. No need to reopen the accepted broad narration design.
