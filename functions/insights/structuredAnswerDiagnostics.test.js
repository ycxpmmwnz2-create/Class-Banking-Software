import assert from 'node:assert/strict'
import test from 'node:test'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { createStructuredClassroomAssistant } from './geminiClassroomAssistant.js'
import { createStructuredAnswerRegistry, StructuredClassroomAnswerError, STRUCTURED_ANSWER_FAILURE_CODES } from './structuredClassroomAnswers.js'
import { callableErrorDetails, callableLogDiagnostic } from './callableErrors.js'

const PRIVATE_TEXT = 'Private classroom wording must not appear in diagnostics'
function evidence() {
  return { question: 'Show current balances.', generatedAt: '2026-08-27T18:00:00.000Z',
    asOfDate: '2026-08-27', timeZone: 'America/Denver', periodDays: 7,
    periodStart: '2026-08-20T18:00:00.000Z', historyStart: '2026-05-29T18:00:00.000Z',
    configuredRentAmount: 10,
    students: [{ ref: 'student-001', displayName: 'Fable', current: true, balance: 5, frozen: false }],
    categories: [], transactions: [] }
}
function envelope(results) {
  return { schemaVersion: 1, sections: results.map(({ resultId, view }) => ({ resultId, view })) }
}
async function answerWith(final, names = ['describe_schema']) {
  let calls = 0
  const assistant = createStructuredClassroomAssistant({ generateContent: async request => {
    calls++
    const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
    if (calls === 1) {
      const functionCalls = names.map((name, i) => ({ id: `call-${i}`, name, args: {} }))
      return { usageMetadata, finishReason: 'STOP', functionCalls,
        candidateContent: { role: 'model', parts: functionCalls.map(functionCall => ({ functionCall })) } }
    }
    assert.equal(calls, 2, 'no retry or repair call is added')
    const results = request.contents.at(-1).parts.map(p => p.functionResponse.response)
    return { usageMetadata, finishReason: 'STOP', text: final(results) }
  } })
  return assistant.answer({ assistantEvidence: evidence() })
}

const cases = [
  ['non-string', () => undefined],
  ['invalid-json', () => '{"' + PRIVATE_TEXT],
  ['envelope-type', () => 'null'],
  ['envelope-type', () => '[]'],
  ['envelope-keys', results => JSON.stringify({ ...envelope(results), [PRIVATE_TEXT]: true })],
  ['envelope-keys', results => JSON.stringify({ sections: envelope(results).sections })],
  ['schema-version', results => JSON.stringify({ ...envelope(results), schemaVersion: '1' })],
  ['sections-shape', () => JSON.stringify({ schemaVersion: 1, sections: [] })],
  ['sections-shape', results => JSON.stringify({ schemaVersion: 1, sections: Array(9).fill(envelope(results).sections[0]) })],
  ['sections-shape', () => JSON.stringify({ schemaVersion: 1, sections: {} })],
  ['section-type', () => JSON.stringify({ schemaVersion: 1, sections: [null] })],
  ['section-keys', results => JSON.stringify({ schemaVersion: 1, sections: [{ ...envelope(results).sections[0], [PRIVATE_TEXT]: true }] })],
  ['section-keys', results => JSON.stringify({ schemaVersion: 1, sections: [{ resultId: results[0].resultId }] })],
  ['result-id-type', () => JSON.stringify({ schemaVersion: 1, sections: [{ resultId: 1, view: 'capabilities' }] })],
  ['duplicate-result', results => JSON.stringify({ schemaVersion: 1, sections: Array(2).fill(envelope(results).sections[0]) })],
  ['unknown-result', () => JSON.stringify({ schemaVersion: 1, sections: [{ resultId: PRIVATE_TEXT, view: 'capabilities' }] })],
  ['view-mismatch', results => JSON.stringify({ schemaVersion: 1, sections: [{ resultId: results[0].resultId, view: PRIVATE_TEXT }] })],
]
for (const [index, [code, final]] of cases.entries()) {
  test(`structured diagnostic ${index + 1}: ${code} preserves refusal without content`, async () => {
    await assert.rejects(answerWith(final), error => {
      assert.equal(error.category, 'answer-unverified')
      assert.equal(error.subcategory, 'answer-shape')
      assert.deepEqual(error.diagnostic, { structuredAnswerCode: code })
      assert.deepEqual(callableLogDiagnostic(error), { structuredAnswerCode: code })
      assert.deepEqual(callableErrorDetails(error), { category: 'answer-unverified' })
      assert.ok(!JSON.stringify(error).includes(PRIVATE_TEXT))
      assert.ok(!error.message.includes(PRIVATE_TEXT))
      return true
    })
  })
}
for (const fenced of [false, true]) {
  test(`valid ${fenced ? 'fenced' : 'bare'} final selection still renders`, async () => {
    const result = await answerWith(results => {
      const text = JSON.stringify(envelope(results))
      return fenced ? '```json\n' + text + '\n```' : text
    })
    assert.match(result.answer, /I can check balances/u)
    assert.equal(result.toolCallCount, 1)
  })
}
test('valid multiple result selections retain independent views', async () => {
  const result = await answerWith(results => JSON.stringify(envelope(results)), ['describe_schema', 'get_balances'])
  assert.match(result.answer, /I can check balances/u)
  assert.match(result.answer, /Total balance: \$5.00/u)
  assert.equal(result.evidence.length, 2)
  assert.equal(result.toolCallCount, 2)
})
test('oversize rendered answer has a content-free diagnostic and is not trimmed', () => {
  const data = evidence()
  data.categories = [{ label: 'Technology', transactionTypes: ['Add'] }]
  data.transactions = Array.from({ length: 100 }, (_, i) => ({ ref: `transaction-${String(i + 1).padStart(5, '0')}`,
    studentRef: 'student-001', date: '2026-08-27T15:01:00.000Z', type: 'Add', amount: 1,
    category: 'Technology', purpose: 'other', status: 'Approved' }))
  const registry = createStructuredAnswerRegistry(createClassroomAssistantToolbox(data, {
    memoResolver: () => ({ text: 'm'.repeat(500), truncated: false }),
  }))
  const result = registry.execute('list_transactions', { includeMemos: true, limit: 100 })
  assert.equal(result.output.ok, true)
  assert.throws(() => registry.render(envelope([result])), error => {
    assert.equal(error.category, 'answer-unverified')
    assert.deepEqual(error.diagnostic, { structuredAnswerCode: 'answer-too-large' })
    return true
  })
})
test('diagnostic log rejects unknown code values and never sends codes to the client', () => {
  for (const structuredAnswerCode of [PRIVATE_TEXT, ['invalid-json'], 5, null]) {
    const error = { category: 'answer-unverified', subcategory: 'answer-shape', diagnostic: { structuredAnswerCode } }
    assert.equal(callableLogDiagnostic(error), null)
    assert.deepEqual(callableErrorDetails(error), { category: 'answer-unverified' })
  }
})

test('every fixed code survives log sanitization while rejected content is discarded', () => {
  for (const code of STRUCTURED_ANSWER_FAILURE_CODES) {
    const error = { category: 'answer-unverified', subcategory: 'answer-shape', diagnostic: {
      structuredAnswerCode: code, answer: PRIVATE_TEXT, resultId: PRIVATE_TEXT,
      memo: PRIVATE_TEXT, schemaVersion: PRIVATE_TEXT, candidateContent: PRIVATE_TEXT,
    } }
    assert.deepEqual(callableLogDiagnostic(error), { structuredAnswerCode: code })
  }
  assert.deepEqual(new StructuredClassroomAnswerError(PRIVATE_TEXT).diagnostic, { structuredAnswerCode: 'render-value' })
})
