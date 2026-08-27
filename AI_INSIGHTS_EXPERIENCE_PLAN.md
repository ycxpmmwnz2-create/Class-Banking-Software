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

- All generated-insight and question-interpretation requests use exactly
  `gemini-3.6-flash` with `thinkingLevel: minimal`; no fallback model, tool,
  search, grounding, provider cache, or automatic retry exists.
- The server uses a 4,096 thinking-token safety ceiling and rejects usage above
  it. Minimal thinking is not described as guaranteed zero thinking.
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
- Roster names are matched and replaced server-side with opaque aliases before
  the question reaches the model. Email addresses, URLs, likely phone numbers,
  ambiguous students, and questions naming more than one student fail before a
  provider call.
- The model maps the sanitized question to a composable, allowlisted read-only
  analytics plan and allowed opaque aliases. It receives no classroom
  transactions, balances, raw reasons, IDs, login data, PINs, teacher identity,
  or classroom identity, and it never writes the factual answer.
- Morgan Bank calculates the answer deterministically from the authorized
  server data. Only the teacher response may restore a real student name.
  Stored idempotency results contain the intent, alias, signature, and usage,
  never the raw question, real name, factual answer, or raw evidence.
- The plan vocabulary covers roster and balance questions, transaction counts
  and amounts, date and time comparisons, current balance history, missing
  payments, multiple simultaneous grouping dimensions, distinct-value counts,
  amount ranges, and grouped numeric conditions. This is a composition model,
  not a closed list of example questions. Requests requiring unavailable data,
  data changes, causal or predictive claims, or unrelated information still
  return a bounded refusal rather than an invented answer.

## Stale and external-state controls

- Results are discarded on logout, teacher/classroom change, classroom-data
  signature change, selected-period change, or a newer request.
- This implementation authorization covers local repository edits and local
  verification only. Commit, push, pull request, merge, secret changes,
  Functions or Hosting deployment, runtime-gate activation, and live provider
  requests remain separate gates.
- Claude performs detailed read-only review after a reviewable commit. Grok
  performs the final systems-level review only after the Claude cycle closes.
