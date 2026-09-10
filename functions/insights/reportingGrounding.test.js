import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationalClassroomAssistant } from './geminiClassroomAssistant.js'
import { renderQuestionAnswer } from '../../src/insights/renderQuestionAnswer.js'
import { reportingEvidence, REPORTING_CASES } from './broaderConversationFixtures.js'
const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
for (const item of REPORTING_CASES.slice(0, 5)) {
  test(`${item.id}: unsupported fluent claims cannot replace calculated results in the UI`, async () => {
    let narrations = 0, plans = 0
    const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
      if (!request.config.tools) {
        narrations++
        return { finishReason: 'STOP', usageMetadata, text: JSON.stringify({ answer: 'Only students whose names start with S qualified. Fable had $999 because Quill was lazy.' }) }
      }
      if (++plans === 1) {
        const functionCall = { id: 'report', name: item.tool, args: item.args }
        return { finishReason: 'STOP', usageMetadata, functionCalls: [functionCall], candidateContent: { role: 'model', parts: [{ functionCall }] } }
      }
      const selected = request.contents.at(-1).parts[0].functionResponse.response
      return { finishReason: 'STOP', usageMetadata, text: JSON.stringify({ schemaVersion: 1, sections: [{ resultId: selected.resultId, view: selected.view }] }) }
    } })
    const result = await assistant.answer({ assistantEvidence: { ...reportingEvidence(), question: item.question } })
    const visible = renderQuestionAnswer(result)
    assert.doesNotMatch(visible, /names start|999|lazy/u)
    assert.match(visible.replaceAll('&quot;', '"'), item.expected)
    assert.equal(result.presentation.aiSummary, null)
    assert.equal(narrations, 0)
    assert.deepEqual(result.usage, { inputTokens: plans * 100, outputTokens: plans * 20, thinkingTokens: 0 })
  })
}
