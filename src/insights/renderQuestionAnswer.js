// Keep the calculated response intact for validation/replay; show one answer.
// Escape all model/classroom text rather than treating it as HTML.
export function renderQuestionAnswer(result) {
  const summary = result.presentation?.aiSummary;
  const text = summary || result.answer;
  const testId = summary ? "provider-question-ai-summary" : "provider-question-calculated-summary";
  return `<p class="insights-answer-copy" data-testid="${testId}">${escape(text)}</p>`;
}
function escape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
