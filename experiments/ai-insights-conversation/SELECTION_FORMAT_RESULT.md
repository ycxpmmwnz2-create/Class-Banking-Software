# Final selection formatting correction

Local branch codex/ai-insights-result-format, baseline a03bf5a4b92674ee613affaeaec50988d4df5c19. Production remains on that baseline, revision analyzeteacherinsightsv3-00021-vos. No deployment, bank-data write or production question retry is part of this correction so far.

## Observed defect

Andrew's day-count question failed after release. The fixed-format production log at 2026-09-06T23:26:01.301340Z reports answer-unverified / answer-shape / invalid-json. Auth and App Check were VALID. No raw provider reply or classroom record was read or saved. This proves a final-format failure; it does not prove the malformed reply's text or whether the selected tool arguments were right.

The conversational planner asked for JSON in its system prompt but used ordinary AUTO text completion after the first tool call. It could return unparseable final text before the separate friendly narrator ran.

## Change and preserved breadth

The conversational path now supplies a JSON response schema on turns after the first, with VALIDATED function calling. Gemini can still choose any of the eight read-only classroom tools, make additional calculations, and select multiple result sections. The first required-tool request stays ANY without an output schema. The existing structured-only and legacy paths keep their request configuration. The same request-local registry validates every result ID/view, duplicate and rendered fact; provider formatting does not replace validation. No arbitrary prose is accepted as calculated facts.

The narrator and broad question support from the prior release remain unchanged. No shortcut is broadened, and no day-count-specific parser or grammar exceptions are introduced. No extra provider call, retry, tool, or increased duration/output ceiling is added.

The schema is 590 serialized UTF-8 bytes. At most three eligible turns add 1770 bytes, bounded below 2048 by test, within the existing 4096 input-token safety padding (byte-per-token conservative accounting). No rate card, reservation quote, ledger, request identity, replay contract, schema version, UI, tenant scope, rules, configuration or credentials change. At least half of that padding remains for request framing; the reviewed cost policy otherwise already accounts for full prompt/history/tool bytes and model output. Reviewer should assess this overhead allocation explicitly.

## Verification

Before fix: 12 focused tests, 10 failures and 2 passes. Fakes reproduce the observed invalid-json ERROR CLASS when the provider request lacks enforced formatting; they do not fabricate a raw production transcript. After fix: full Gemini-layer suite 530/530; 13 focused format tests; lint and diff checks pass. The only edit after the full suite/provider snapshot adds an explicit node:buffer import in the test file to satisfy lint. Runtime source is unchanged.

Tests cover six non-earnings tool families, additional tool calls and multipart completion, foreign result IDs, wrong views, malformed prose despite schema, unchanged structured path, byte budget, and actual live composition forwarding the schema through the SDK then saving/replaying the same result without new writes/calls. Existing tests cover four-turn limits, uncertain billing, long-answer fallback, tenant isolation and earnings shortcut behavior.

Real Gemini, final runtime sources: a 21-student fictional day-count query returned one distinct Technology day from two approved additions during Aug24-30, using two planners plus narration. A multipart query returned that day count plus total class balance $16, preserving both fact sections, using three planners plus narration. Both identical-request replays added zero calls, charges or writes in the in-memory ledger. Cumulative fictional-test spend $2.354324 of the approved $3.00; $0.645676 remains. Completed atomic runners must not be restarted.

One initial lint check caught the missing test Buffer import; corrected and lint/focused tests rerun. No runtime defect was hidden by that correction. Genuine tests use the real installed SDK/transport and staging key in memory with fictional injected records; they are not deployed Auth/App Check or production evidence.

## Provider reference

Google's Generate Content structured-output documentation describes schema-constrained final responses combined with function calling for Gemini 3 models. The installed SDK exposes responseMimeType/responseJsonSchema; both genuine runs demonstrated support with the existing model and VALIDATED tools.

https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en
https://ai.google.dev/gemini-api/docs/generate-content/function-calling?hl=en

Muse Spark 1.3 returned PASS WITH CONDITIONS on the exact five-file packet; no code changes requested. Pending: deployed staging day-count/Auth/App Check and exact replay verification, then release verification and bounded diagnostic observation under Andrew's standing release approval. Keep the current broad classroom-data behavior and Gemini narration. Do not reopen an English-grammar perfection loop.
