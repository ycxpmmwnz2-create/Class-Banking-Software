# Gemini conversational-answer experiment results

September 6, 2026. Isolated branch: `codex/ai-insights-conversational-experiment`. Existing application files are unchanged.

Two real-Gemini rounds used eight fictional cases each. Round 1 preserved ranking values but remained formal, omitted a currency sign once, and blurred incomplete returned results into incomplete records. The revised prompt fixes that distinction and puts stable scope/date details below the paragraph.

Codex manually compared all eight revised candidates with their calculated fictional facts and found no factual mismatch. This is implementation-agent assessment, not independent review or a guarantee of future responses. The partial-history response still adds an unnecessary effort/motivation sentence.

Both rounds cost an accounted USD 0.019318, bringing the original cumulative experiment to USD 0.973493 of USD 2. Unknown charges from earlier experiments remain included in that total.

Local verification: 12 experiment tests and 40 existing tool/renderer tests passed; ESLint passed. Existing functions, client, HTML, Firebase configuration and rules remain identical to the baseline. Provider calls used only fictional records and the existing staging credential.

## Revised Gemini answers

### unique-zero-and-filter-distractors

**Fable** received the most money with **$30** added. **Quill** received the least, with no approved money added.

*Displayed separately by the preview:* August 31–September 6, 2026 · Current classroom roster · Approved money added (USD).

Assessment: Fable $30, Quill no approved additions. Correctly excludes pending, subtractions, former participant and outside dates.

### ties-at-both-ends

**Fable** and **Orbit** tied for the most money added with **$30** each. **Pixel** and **Quill** tied for the least with **$5** each.

*Displayed separately by the preview:* August 31–September 6, 2026 · Current classroom roster · Approved money added (USD).

Assessment: Both highest students and both lowest students named; $30 each and $5 each are correct.

### tied-zero-earners

**Fable** received the most money added with **$30**. **Pixel** and **Quill** received the least, with no approved money added.

*Displayed separately by the preview:* August 31–September 6, 2026 · Current classroom roster · Approved money added (USD).

Assessment: Fable $30; Pixel and Quill both correctly identified with no approved additions.

### everyone-zero

Everyone tied for both the most and least money added from August 31 through September 6. **Fable**, **Orbit**, **Pixel**, and **Quill** each had no approved money added during this period.

*Displayed separately by the preview:* August 31–September 6, 2026 · Current classroom roster · Approved money added (USD).

Assessment: All four tied with no approved additions; no arbitrary winner.

### empty-roster

I cannot determine who received the most or least money because there are no current students in the roster to compare for this date range.

*Displayed separately by the preview:* August 31–September 6, 2026 · Current classroom roster · Approved money added (USD).

Assessment: No winner invented for the empty current roster.

### truncated-results

Because the returned results are incomplete, I cannot determine who received the most or least money from August 31 through September 6. Neither highest nor lowest amount can be established from this page.

*Displayed separately by the preview:* August 31–September 6, 2026 · Current classroom roster · Approved money added (USD).

Assessment: Correctly distinguishes incomplete returned results from missing records; no extrema invented.

### partial-history

I cannot determine who received the most or least money because our retained history does not cover the full date range from August 31 through September 6. Additionally, these records cannot tell us about student effort or motivation.

*Displayed separately by the preview:* August 31–September 6, 2026 · Current classroom roster · Approved money added (USD).

Assessment: Correctly withholds full-week extrema. Unnecessary effort/motivation sentence is a tone issue, not a factual mismatch.

### unsupported-judgment

**Fable** had the most money added with **$30**, while **Quill** had the least with **$0**. These records only show approved credits, so they cannot tell us if a student was lazy or worked the hardest.

*Displayed separately by the preview:* August 31–September 6, 2026 · Current classroom roster · Approved money added (USD).

Assessment: Correct extrema; declines unsupported judgments about laziness and effort.

## Boundaries before app integration

This prototype always retains the existing deterministic text as the serving answer. The candidate is labelled `needs-human-semantic-review`; JSON syntax checks do not establish truth. No automatic prose-verification mechanism has been approved.

Before connecting this to the live app, review a bounded design covering: request-local fact construction from selected executed results; complete population and zero-earner joins beyond this eight-student prototype; explicit versus relative dates; duplicate display names; preserving required limitations outside collapsible details; safe text/Markdown rendering; a separately reserved narration cost and deadline; failure fallback without turning a valid calculation into an error; exact answer persistence and replay without a second provider charge; and an explicit policy for semantic errors that mechanical checks cannot detect.

The existing deployed answer remains the release fallback. Do not revive the retired English allowlist validator or label free prose as server-verified facts. This experiment is evidence about tone and a small set of meanings, not readiness to release.
