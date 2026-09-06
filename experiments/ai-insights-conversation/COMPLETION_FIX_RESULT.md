# Focused correction: finish a completed earnings calculation

This checkpoint supersedes the open provider-check status in PRODUCTION_RESULT.md. Historical evidence remains unchanged. No deployment or real bank record change occurred.

Muse round17 returned PASS WITH CONDITIONS for the local candidate. Codex reconciled its diagnostic and UTC+13/+14 notes against the actual paths; no runtime defect was established by those notes. Andrew then explicitly raised the fictional-test ceiling from $2 to $3.

The newly instrumented round3 run passed the complete-data and tie cases but failed partial history with `answer-unverified / answer-shape / structuredAnswerCode: envelope-keys`, during the second planner response. The exact response text was not captured, so no particular extra field is asserted. Its 514536 microUSD reservation remains conservatively accounted. This diagnosis applies to round3, not retroactively to the undiagnosed round2 failure.

The correction removes that unnecessary selection response for the dedicated operation. After a single successful compare_student_earnings tool call, the server selects that request-local registered result and renders its full calculation or explicit coverage warning. Optional Gemini narration still receives only the calculated answer and sanitized question. No parser validation is loosened and no model-written factual answer replaces the calculation. Automatic completion requires a single-call batch and no earlier successful factual operation other than describe_schema, so mixed or multi-part questions retain the normal closed final selection. Failed tool calls may be corrected. The original four planning turns remain available; narration yields when the fourth is used.

Changed runtime file: functions/insights/geminiClassroomAssistant.js. Tests update the expected lower call count and cover partial-history failure reproduction, failed-call correction, mixed batches, earlier factual operations and fourth-turn completion. The regression fails on round17 with the observed envelope-keys error class and passes after this fix. The broader Gemini package suite passes 487/487 tests. Focused tests pass 22/22. ESLint and diff checks pass. Browser code is unchanged from round17, so its previous desktop/mobile escaping/fallback evidence is retained rather than rerun.

Real Gemini round4 uses the exact corrected source:
- Partial history: explicit full-period coverage warning, with no invented rankings.
- 40-student most/least: correct Fable 1 $30 and Fable 40 $0.
- Ties: correct Fable 1/Fable 2 at $30 and Fable 3 through Fable 40 at $5.
- Each used ONE planner call plus ONE optional narrator call. All three replies matched calculated facts on Codex manual review. The unique-extrema paragraph remains somewhat verbose; no further paid style tuning was performed.
- Identical request replay returned the identical response and added zero provider calls, cost or in-memory writes in every case. All writes were limited to the in-memory usage collections. This remains local composition with injected fictional evidence, not deployed Auth/App Check evidence.
- Charges: 8000 + 8295 + 8457 = 24752 microUSD ($0.024752) for round4. Cumulative accounting including conservative failed-run reservations: 2158923 microUSD ($2.158923) of the approved $3. Remaining: 841077 microUSD.

Both historical failed and successful source snapshots, exact manifests, requests, response summaries and replay evidence are preserved under /private/tmp/morgan-bank-conversation-candidate-20260906-round3 and round4. Neither atomic run directory may be restarted.

Remaining gates: focused independent Muse review of this correction and evidence; reconcile any confirmed findings; then deployed staging Auth/App Check/replay, signed-in browser and exact-artifact verification before production rollout. Existing release authority does not waive those checks. Free-form AI summaries remain explicitly labelled and can still be inaccurate outside the reviewed examples.
