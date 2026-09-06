// All provider and classroom text is escaped. AI summaries are never HTML.
export function renderQuestionAnswer(result) {
  const presentation = result.presentation;
  if (!presentation) return `<p class="insights-answer-copy">${escape(result.answer)}</p>`;
  return `
    ${presentation.aiSummary ? `
      <span class="insights-eyebrow">AI summary</span>
      <p class="insights-answer-copy" data-testid="provider-question-ai-summary">${escape(presentation.aiSummary)}</p>
      <p class="insights-field-hint">AI wording can make mistakes. Check the calculated facts below.</p>
    ` : ""}
    <span class="insights-eyebrow">Calculated facts</span>
    <p class="insights-answer-copy" data-testid="provider-question-calculated-summary">${escape(presentation.calculatedSummary)}</p>
    <p class="insights-field-hint" style="white-space: pre-line;">${escape(presentation.calculationDetails)}</p>
    ${presentation.billingBasis === "reserved-unknown" ? `<p class="insights-field-hint">The AI summary was unavailable. Its reserved allowance is retained because the provider did not confirm usage.</p>` : ""}
  `;
}
function escape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
