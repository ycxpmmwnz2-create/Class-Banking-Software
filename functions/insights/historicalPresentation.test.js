import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationalClassroomAssistant } from './geminiClassroomAssistant.js'
import { renderQuestionAnswer } from '../../src/insights/renderQuestionAnswer.js'

const CUTOFF = '2026-09-04'
const known = [
  { ref: 'student-001', displayName: 'Blake', current: true, balance: -5, frozen: false },
  { ref: 'student-002', displayName: 'Quinn', current: true, balance: -20, frozen: false },
]
const evidence = (students = known) => ({
  question: 'Who had negative balances on September 4?',
  generatedAt: '2026-09-08T18:00:00.000Z', asOfDate: '2026-09-08', timeZone: 'America/Denver',
  periodDays: 7, periodStart: '2026-09-01T18:00:00.000Z', historyStart: '2026-06-10T18:00:00.000Z',
  configuredRentAmount: 10,
  // Fictional stable dated balances, independent of a transaction ledger.
  students: students.map(student => ({ ...student, balanceHistory: student.balance === null ? {} :
    Object.fromEntries(['04', '05', '06', '07'].map(day => [`2026-09-${day}`, student.balance])) })),
  categories: [], transactions: [],
})
const historical = (args = {}) => ({ name: 'get_balances_as_of', args: { asOfDate: CUTOFF, condition: 'negative', ...args } })
const current = { name: 'get_balances', args: { condition: 'negative' } }
const unknown = [...known, { ref: 'student-003', displayName: 'Robin', current: true, balance: null, frozen: false }]

// Actual assistant and client renderer; only the provider is mocked. The two
// planning turns still use tools and result-bound selection. A third call would
// be narration, which must never happen for selected historical balances.
async function run(summary, { calls = [historical()], selected, students, narrationAllowed = true } = {}) {
  let narratorCalls = 0, modelTurns = 0
  const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    if (!request.config.tools) {
      narratorCalls += 1
      return { finishReason: 'STOP', usageMetadata, text: JSON.stringify({ answer: summary }) }
    }
    modelTurns += 1
    if (modelTurns === 1) {
      const functionCalls = calls.map((call, index) => ({ id: `call-${index + 1}`, ...call }))
      return { finishReason: 'STOP', usageMetadata, functionCalls,
        candidateContent: { role: 'model', parts: functionCalls.map(functionCall => ({ functionCall })) } }
    }
    const responses = request.contents.at(-1).parts.map(part => part.functionResponse.response)
    const sections = (selected ?? responses.map((_, index) => index)).map(index => ({
      resultId: responses[index].resultId, view: responses[index].view,
    }))
    return { finishReason: 'STOP', usageMetadata, text: JSON.stringify({ schemaVersion: 1, sections }) }
  } })
  const result = await assistant.answer({ assistantEvidence: evidence(students), narrationAllowed })
  return { result, html: renderQuestionAnswer(result), narratorCalls, modelTurns }
}

function assertVerified({ result, html, narratorCalls, modelTurns }) {
  assert.equal(narratorCalls, 0, 'Do not call the narrator and then attempt to validate its prose')
  assert.equal(modelTurns, 2)
  assert.equal(result.presentation.aiSummary, null)
  assert.match(html, /data-testid="provider-question-calculated-summary"/u)
  assert.equal(Object.hasOwn(result, 'narrationContract'), false)
  assert.equal(Object.hasOwn(result, 'requiresVerifiedAnswer'), false)
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 40, thinkingTokens: 0 })
  assert.equal(result.usageUncertain, false)
  assert.equal(result.presentation.billingBasis, 'observed')
  assert.equal(result.answer, `${result.presentation.calculatedSummary}\n${result.presentation.calculationDetails}`)
}

for (const [name, summary] of [
  ['reversed polarity', 'On September 4, Blake and Quinn had positive account balances.'],
  ['swapped amounts', 'On September 4, Blake had -$20.00 and Quinn had -$5.00.'],
  ['wrong explicit date with matching weekday', 'On Friday, September 11, Blake and Quinn had negative balances.'],
  ['invented student', 'On September 4, Blake, Quinn and Zelda had negative balances.'],
  ['faithful prose also bypasses narration', 'On September 4, Blake and Quinn had negative balances.'],
]) test(`historical display is verified without narration: ${name}`, async () => {
  const response = await run(summary)
  assertVerified(response)
  assert.match(response.html, /negative balances on 2026-09-04/u)
  assert.match(response.html, /Blake&quot; — -\$5\.00 on 2026-09-04/u)
  assert.match(response.html, /Quinn&quot; — -\$20\.00 on 2026-09-04/u)
  assert.doesNotMatch(response.html, /positive account|September 11|Zelda/u)
})

test('missing-balance disclosure cannot be dropped from the displayed answer', async () => {
  const response = await run('On September 4, Blake and Quinn had negative balances.', { students: unknown })
  assertVerified(response)
  assert.match(response.html, /Balance history is unavailable for 1 current student/u)
  assert.match(response.html, /Population: the 3 current classroom students/u)
})

test('limited results always display their full match count and page disclosure', async () => {
  const response = await run('On September 4, Quinn had a negative balance.', { calls: [historical({ limit: 1 })] })
  assertVerified(response)
  assert.match(response.html, /2 current students match/u)
  assert.match(response.html, /Showing 1 of 2 students/u)
  assert.match(response.html, /Quinn&quot; — -\$20\.00/u)
  assert.doesNotMatch(response.html, /Blake&quot; —/u)
})

test('no known matches still discloses an unknown balance', async () => {
  const students = [{ ...known[0], balance: 5 }, unknown[2]]
  const response = await run('Nobody had a negative balance on September 4.', { students })
  assertVerified(response)
  assert.match(response.html, /Cannot determine the complete list/u)
  assert.match(response.html, /Balance history is unavailable for 1 current student/u)
})

test('the classroom date keeps its verified snapshot wording', async () => {
  const response = await run('Blake and Quinn had negative closing balances.', { calls: [historical({ asOfDate: '2026-09-08' })] })
  assertVerified(response)
  assert.match(response.html, /classroom snapshot taken so far that day, not a completed end-of-day total/u)
  assert.doesNotMatch(response.html, /Reconstructed end-of-day/u)
})

test('named balance history also displays verified facts without narration', async () => {
  const calls = [{ name: 'get_balance_history', args: { studentRefs: ['student-001'], startDate: CUTOFF, endDate: '2026-09-08' } }]
  const response = await run('Blake was above zero on Friday.', { calls })
  assertVerified(response)
  assert.match(response.html, /2026-09-04: -\$5\.00/u)
  assert.match(response.html, /Today&#39;s value reflects the snapshot on 2026-09-08/u)
})

for (const selected of [[0, 1], [1, 0]]) test(`mixed selection ${selected.join(',')} keeps all verified sections`, async () => {
  const response = await run('Blake and Quinn had positive balances.', { calls: [current, historical()], selected })
  assertVerified(response)
  assert.match(response.html, /Balances as of 2026-09-08/u)
  assert.match(response.html, /negative balances on 2026-09-04/u)
})

test('unselected history does not disable ordinary current-balance narration', async () => {
  const summary = 'Blake and Quinn currently have negative balances.'
  const response = await run(summary, { calls: [historical(), current], selected: [1] })
  assert.equal(response.narratorCalls, 1)
  assert.equal(response.result.presentation.aiSummary, summary)
  assert.match(response.html, /provider-question-ai-summary/u)
})

test('ordinary current-balance narration remains unchanged', async () => {
  const summary = 'Blake and Quinn currently have negative balances.'
  const response = await run(summary, { calls: [current] })
  assert.equal(response.narratorCalls, 1)
  assert.equal(response.result.presentation.aiSummary, summary)
  assert.match(response.html, /provider-question-ai-summary/u)
})

test('the existing narrationAllowed gate still skips non-historical narration', async () => {
  const response = await run('Unused', { calls: [current], narrationAllowed: false })
  assertVerified(response)
})
