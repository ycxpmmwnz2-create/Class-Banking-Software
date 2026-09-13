import { CALCULATION_DETAILS_HEADING } from '../../functions/insights/conversationContract.js';

// Keep the calculated response intact for validation/replay; show one answer.
// Escape all model/classroom text rather than treating it as HTML.
export function renderQuestionAnswer(result) {
  const summary = result.presentation?.aiSummary;
  const presentation = result.presentation;
  // Recognize only the fixed server report heading; never infer facts by
  // parsing prose, student names or a question. Old saved answers stay intact.
  if (!summary && presentation?.calculationDetails.startsWith(CALCULATION_DETAILS_HEADING) &&
      result.answer === `${presentation.calculatedSummary}\n${presentation.calculationDetails}`) {
    return `<p class="insights-answer-copy" data-testid="provider-question-calculated-summary">${escape(presentation.calculatedSummary)}</p>` +
      `<details class="insights-answer-details"><summary>View details</summary><p class="insights-answer-copy" data-testid="provider-question-calculation-details">${escape(presentation.calculationDetails.slice(CALCULATION_DETAILS_HEADING.length))}</p></details>`;
  }
  const text = summary || result.answer;
  const testId = summary ? "provider-question-ai-summary" : "provider-question-calculated-summary";
  return `<p class="insights-answer-copy" data-testid="${testId}">${escape(text)}</p>`;
}
function escape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
