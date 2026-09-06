// Shared server/browser contract. The summary is explicitly not a verified fact.
export const CONVERSATIONAL_ANSWER_CONTRACT = 'conversational-v1'
export function validateConversationPresentation(value, answer) {
  if (value === null) return null
  const fields = ['aiSummary', 'calculatedSummary', 'calculationDetails', 'billingBasis']
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
    !['observed', 'reserved-unknown'].includes(value.billingBasis) ||
    !text(value.calculatedSummary, 48000) || !text(value.calculationDetails, 8000) ||
    !(value.aiSummary === null || text(value.aiSummary, 1200)) ||
    answer !== `${value.calculatedSummary}\n${value.calculationDetails}`) {
    throw new TypeError('Conversation presentation is malformed.')
  }
  return Object.freeze({ ...value })
}
function text(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.trim() === value && ![...value].some(c => (c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))) || c.charCodeAt(0) === 127)
}
