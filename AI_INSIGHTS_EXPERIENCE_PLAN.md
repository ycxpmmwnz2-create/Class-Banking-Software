# AI Insights experience acceptance plan

## Objective

Replace the teacher-facing local/Gemini split with one model-neutral **AI
Insights** experience. A teacher explicitly requests an initial result, may
request more insights, and may ask factual questions about the selected 7, 30,
or 90 day period.

## User-facing behavior

- The page says **AI Insights** and does not display a model, provider, version,
  thinking setting, token usage, API cost, Firebase allowance, or internal
  budget.
- There is one initial **Get AI Insights** action. After the initial result the
  same position offers **Get More Insights**. Internal `quick` and `deep`
  profile identifiers are implementation details only; they do not select
  different models.
- The page never runs analysis automatically. Opening the page, changing a
  period, signing in, or completing App Check makes no provider request.
- There is no production local-analysis fallback. If the protected callable is
  unavailable, the page fails closed and says AI Insights is unavailable.
- A teacher may type one question and explicitly submit it. The selected period
  applies to transaction questions. Browser IANA time zone is a display and
  bucketing lens only, never tenant authority.

## Provider and cost contract

- All generated-insight and teacher-question requests use exactly
  `gemini-3.6-flash` with `thinkingLevel: minimal`; there is no fallback model,
  web search, code execution, or provider-owned data source. Teacher questions
  may use only Morgan Bank's six server-owned read-only classroom tools.
- A teacher question may use at most four provider turns, eight tool calls,
  32 KiB of total tool output, 2,048 output tokens per turn, and 4,096 thinking
  tokens per turn, all inside one 60-second assistant deadline. Usage metadata
  must satisfy Gemini's exact total: prompt tokens (including cached content),
  candidates, tool-use prompt tokens, and thoughts. Tool-use prompt tokens are
  included in the charged input total; contradictory metadata fails closed.
- The transport retries only transient 408, 429, and 5xx failures, at most
  three attempts with bounded backoff. Authentication, request-schema, and
  answer-verification failures are not retried.
- Cost reservations use the conservative post-promotion ceiling of $1.50 per
  million input tokens and $7.50 per million billed output tokens. The existing
  application-wide $7.50 ledger remains the hard application control and stays
  hidden from the teacher UI.
- Provider ambiguity retains the worst-case reservation. Completed request
  replay remains evidence-signature checked.

## Grounded question boundary

- Browser question requests contain exactly `requestId`, `kind`, `periodDays`,
  `timeZone`, and `question`. The browser cannot submit a teacher UID,
  classroom ID, student ID, fact packet, model, prompt, price, or answer.
- The callable resolves the active teacher tenant before reading one bounded
  classroom roster and transaction set.
- The server builds one classroom-scoped assistant view. Gemini may receive
  first names; when first names collide it receives first name plus last
  initial. It receives ephemeral student/transaction references, current
  balances, frozen status, safe categories, server-calculated classroom dates,
  and only the bounded tool results needed for the question. Concatenated,
  reordered, compatibility-obscured, or character-obscured multi-part roster
  names fail before a question can reach Gemini.
- Transaction memos are absent by default. A tool may request them only when
  relevant; emails, phone numbers, links, and control characters are removed,
  each memo is capped at 500 characters, and truncation is explicit. Memo text
  is resolved and sanitized lazily only for the bounded rows the tool returns;
  a memo that still retains or reconstructs an obscured multi-part roster name
  is unavailable.
- Gemini never receives Auth UIDs, Firestore IDs or paths, teacher/classroom
  identifiers, credentials, PINs, App Check data, secrets, another classroom,
  or write authority. Tool arguments contain no tenant selector.
- The six tools list transactions, aggregate transactions, read current
  balances, calculate balance history, compare periods, and describe available
  schema. Their filters, multidimensional groupings, totals, averages, medians,
  ranges, percentages, distinct counts, and period comparisons are general
  primitives for unforeseen questions, not sentence-specific fixes.
- Gemini writes the direct teacher-facing answer, cites the executed tool-call
  IDs, and cannot expose opaque references. Morgan Bank validates the final
  envelope, evidence citations, output bounds, identities, usage, reservation,
  and replay signature before returning it.
- The previous schema-8 deterministic calculator remains available behind the
  server feature switch as a rollback path. The new tool assistant is separately
  gated by `VERSION3_GEMINI_TOOL_ASSISTANT_ENABLED`.

## Stale and external-state controls

- Results are discarded on logout, teacher/classroom change, classroom-data
  signature change, selected-period change, or a newer request.
- This implementation authorization covers local repository edits and local
  verification only. Commit, push, pull request, merge, secret changes,
  Functions or Hosting deployment, runtime-gate activation, and live provider
  requests remain separate gates.
- Claude performs detailed read-only review after a reviewable commit. Grok
  performs the final systems-level review only after the Claude cycle closes.
