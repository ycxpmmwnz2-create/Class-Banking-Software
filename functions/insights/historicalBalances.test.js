import assert from 'node:assert/strict'
import test from 'node:test'

import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { createConversationalClassroomAssistant } from './geminiClassroomAssistant.js'
import { createStructuredAnswerRegistry } from './structuredClassroomAnswers.js'

// The teacher's real question: "Who had a negative account balance as of last
// Friday 9/4?" asked on 2026-09-08. Every figure below is fictional.
const CUTOFF = '2026-09-04'

// America/Denver is UTC-6 on these dates, so 05:30Z is 23:30 on the 4th and
// 06:30Z is 00:30 on the 5th. Those two transactions sit either side of the
// classroom-local date boundary.
const BEFORE_LOCAL_MIDNIGHT = '2026-09-05T05:30:00.000Z'
const AFTER_LOCAL_MIDNIGHT = '2026-09-05T06:30:00.000Z'

function transaction(ref, studentRef, date, type, amount, status = 'Approved') {
  return { ref, studentRef, date, type, amount, category: 'Technology', purpose: 'other', status }
}

// Twelve current students. The sign changes run in both directions, one true
// historical match sits beyond the first eight (the get_balance_history cap),
// and one student's balance is unknown.
function evidence(overrides = {}) {
  const students = [
    { ref: 'student-001', displayName: 'Avery', current: true, balance: -5, frozen: false },
    { ref: 'student-002', displayName: 'Blake', current: true, balance: 10, frozen: false },
    { ref: 'student-003', displayName: 'Casey', current: true, balance: 0, frozen: false },
    { ref: 'student-004', displayName: 'Dana', current: true, balance: 0, frozen: false },
    ...Array.from({ length: 5 }, (_, i) => ({
      ref: `student-00${i + 5}`, displayName: `Filler ${i + 1}`, current: true, balance: 0, frozen: false,
    })),
    { ref: 'student-010', displayName: 'Quinn', current: true, balance: 20, frozen: false },
    { ref: 'student-011', displayName: 'Robin', current: true, balance: null, frozen: false },
    { ref: 'student-012', displayName: 'Sam', current: true, balance: 3, frozen: false },
  ]
  return {
    question: 'Who had a negative account balance as of last Friday 9/4?',
    generatedAt: '2026-09-08T18:00:00.000Z', asOfDate: '2026-09-08', timeZone: 'America/Denver',
    periodDays: 7, periodStart: '2026-09-01T18:00:00.000Z', historyStart: '2026-06-10T18:00:00.000Z',
    configuredRentAmount: 10, students,
    categories: [{ label: 'Technology', transactionTypes: ['Add', 'Subtract'] }],
    transactions: [
      // Negative today, POSITIVE on the cutoff. Must be excluded.
      transaction('transaction-00001', 'student-001', '2026-09-07T15:00:00.000Z', 'Subtract', 15),
      // Positive today, NEGATIVE on the cutoff. Must be included.
      transaction('transaction-00002', 'student-002', '2026-09-07T15:00:00.000Z', 'Add', 15),
      // Same-day-boundary pair for Dana; nets to zero today, +$7 on the cutoff.
      transaction('transaction-00003', 'student-004', BEFORE_LOCAL_MIDNIGHT, 'Add', 7),
      transaction('transaction-00004', 'student-004', AFTER_LOCAL_MIDNIGHT, 'Subtract', 7),
      // The tenth student is a true historical match beyond the first eight.
      transaction('transaction-00005', 'student-010', '2026-09-07T15:00:00.000Z', 'Add', 25),
      // A Pending transaction never moves a reconstructed balance.
      transaction('transaction-00006', 'student-012', '2026-09-07T15:00:00.000Z', 'Subtract', 50, 'Pending'),
    ],
    ...overrides,
  }
}

const setup = (data = evidence()) => {
  const toolbox = createClassroomAssistantToolbox(data)
  return { toolbox, registry: createStructuredAnswerRegistry(toolbox) }
}
const asOf = (toolbox, args = {}) => toolbox.execute('get_balances_as_of', { asOfDate: CUTOFF, ...args })
const names = result => result.students.map(row => row.student)

test('finds who was negative on the cutoff in both sign-change directions', () => {
  const { toolbox } = setup()
  const result = asOf(toolbox, { condition: 'negative' })
  assert.equal(result.ok, true)
  // Blake was negative on 9/4 despite being positive today; Avery is negative
  // today but was positive on 9/4. Selecting today's negatives inverts both.
  assert.deepEqual(names(result), ['Blake', 'Quinn'])
  assert.equal(result.matchedCount, 2)
  const todayNegative = toolbox.execute('get_balances', { condition: 'negative' })
  assert.deepEqual(todayNegative.students.map(row => row.student), ['Avery'])
})

test('a student negative today but positive on the cutoff is excluded', () => {
  const { toolbox } = setup()
  assert.equal(asOf(toolbox, { condition: 'positive' }).students.find(row => row.student === 'Avery').balanceAsOf, 10)
  assert.equal(names(asOf(toolbox, { condition: 'negative' })).includes('Avery'), false)
})

test('zero is not negative and is reported only under its own condition', () => {
  const { toolbox } = setup()
  assert.equal(names(asOf(toolbox, { condition: 'negative' })).includes('Casey'), false)
  assert.equal(names(asOf(toolbox, { condition: 'zero' })).includes('Casey'), true)
  assert.equal(names(asOf(toolbox, { condition: 'nonpositive' })).includes('Casey'), true)
})

test('the whole current roster is reconstructed, past the eight-student history cap', () => {
  const { toolbox } = setup()
  const result = asOf(toolbox, { condition: 'negative' })
  // Quinn is the tenth student. A tool capped at eight named students cannot
  // reach this match, which is why the historical predicate is code-owned.
  assert.equal(names(result).includes('Quinn'), true)
  assert.equal(result.currentStudentCount, 12)
  const capped = toolbox.execute('get_balance_history', {
    studentRefs: Array.from({ length: 9 }, (_, i) => `student-${String(i + 1).padStart(3, '0')}`),
    startDate: CUTOFF, endDate: CUTOFF,
  })
  assert.equal(capped.ok, false)
})

test('reconstruction agrees with the existing balance-history tool', () => {
  const { toolbox } = setup()
  const reconstructed = asOf(toolbox, { condition: 'any' })
  for (const row of reconstructed.students) {
    const history = toolbox.execute('get_balance_history', {
      studentRefs: [row.studentRef], startDate: CUTOFF, endDate: CUTOFF,
    })
    assert.equal(history.rows[0].closingBalance, row.balanceAsOf, `${row.student} disagrees with get_balance_history`)
  }
})

test('the classroom-local date boundary decides which transactions count', () => {
  const { toolbox } = setup()
  const dana = asOf(toolbox, { condition: 'any' }).students.find(row => row.student === 'Dana')
  // 23:30 local on the 4th is inside the cutoff's closing balance; 00:30 local
  // on the 5th is unwound. Mishandling either boundary yields $0.00 instead.
  assert.equal(dana.balanceAsOf, 7)
})

test('pending transactions never move a reconstructed balance', () => {
  const { toolbox } = setup()
  assert.equal(asOf(toolbox, { condition: 'any' }).students.find(row => row.student === 'Sam').balanceAsOf, 3)
})

test('no matches reports zero without inventing students', () => {
  // Nobody is negative on the cutoff: every balance is zero or positive and
  // there is nothing to unwind.
  const { registry, toolbox } = setup(evidence({
    students: [
      { ref: 'student-001', displayName: 'Avery', current: true, balance: 4, frozen: false },
      { ref: 'student-002', displayName: 'Blake', current: true, balance: 0, frozen: false },
    ],
    transactions: [],
  }))
  const result = asOf(toolbox, { condition: 'negative' })
  assert.equal(result.matchedCount, 0)
  assert.equal(result.unavailableCount, 0)
  assert.deepEqual(result.students, [])
  const call = registry.execute('get_balances_as_of', { asOfDate: CUTOFF, condition: 'negative' })
  const { answer } = registry.render({ schemaVersion: 1, sections: [{ resultId: call.resultId, view: call.view }] })
  assert.match(answer, /^0 current students match: negative balances on 2026-09-04\./u)
  // With nothing unavailable the answer states a clean none and adds no caveat.
  assert.doesNotMatch(answer, /Balance history is unavailable/u)
})

test('a none answer discloses students that could not be checked', () => {
  const { registry } = setup(evidence({
    students: [
      { ref: 'student-001', displayName: 'Avery', current: true, balance: 4, frozen: false },
      { ref: 'student-002', displayName: 'Robin', current: true, balance: null, frozen: false },
    ],
    transactions: [],
  }))
  const call = registry.execute('get_balances_as_of', { asOfDate: CUTOFF, condition: 'negative' })
  const { answer } = registry.render({ schemaVersion: 1, sections: [{ resultId: call.resultId, view: call.view }] })
  assert.match(answer, /^0 current students match/u)
  // An unconditional "none" would be a false claim while a balance is unknown.
  assert.match(answer, /Balance history is unavailable for 1 current student, who could not be checked and are not covered by this count\./u)
})

test('an unknown balance stays unavailable rather than counting as zero', () => {
  const { toolbox } = setup()
  const result = asOf(toolbox, { condition: 'any' })
  assert.equal(result.unavailableCount, 1)
  assert.equal(names(result).includes('Robin'), false)
  // Robin is neither matched nor silently treated as a $0 student.
  assert.equal(result.matchedCount + result.unavailableCount, result.currentStudentCount)
  assert.equal(names(asOf(toolbox, { condition: 'zero' })).includes('Robin'), false)
})

test('a cutoff outside retained history or in the future is refused', () => {
  const { toolbox } = setup()
  // The in-range cutoff must succeed, so this cannot pass merely because the
  // tool is missing.
  const past = toolbox.execute('get_balances_as_of', { asOfDate: CUTOFF })
  assert.equal(past.ok, true)
  assert.equal(past.throughSnapshot, false)
  // Today is inside retained history and is accepted, but it is the snapshot
  // date rather than a completed day.
  const today = toolbox.execute('get_balances_as_of', { asOfDate: '2026-09-08' })
  assert.equal(today.ok, true)
  assert.equal(today.throughSnapshot, true)
  for (const asOfDate of ['2026-06-09', '2026-09-09', '2026-02-30']) {
    assert.equal(toolbox.execute('get_balances_as_of', { asOfDate }).ok, false)
  }
})

test('filtering covers every eligible student before output limiting', () => {
  const { toolbox } = setup()
  const limited = asOf(toolbox, { condition: 'negative', limit: 1 })
  // The page shrinks; the population count and truncation flag do not.
  assert.equal(limited.matchedCount, 2)
  assert.equal(limited.returnedCount, 1)
  assert.equal(limited.truncated, true)
  assert.equal(limited.students.length, 1)
  assert.equal(asOf(toolbox, { condition: 'negative' }).truncated, false)
})

test('no historical value is exposed under a current-balance name', () => {
  const { toolbox } = setup()
  const result = asOf(toolbox, { condition: 'any' })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('currentBalance'), false)
  assert.equal(Object.hasOwn(result.students[0], 'balanceAsOf'), true)
  // Frozen status is a present-day attribute this tool cannot reconstruct.
  assert.equal(Object.hasOwn(result.students[0], 'frozen'), false)
})

test('the rendered historical answer is bound to the reconstructed result', () => {
  const { registry } = setup()
  const call = registry.execute('get_balances_as_of', { asOfDate: CUTOFF, condition: 'negative' })
  assert.equal(call.view, 'balances-as-of')
  const { answer, evidence: lines } = registry.render({ schemaVersion: 1, sections: [{ resultId: call.resultId, view: call.view }] })
  assert.match(answer, /^2 current students match: negative balances on 2026-09-04\./u)
  assert.match(answer, /"Blake" — -\$5\.00 on 2026-09-04\./u)
  assert.match(answer, /"Quinn" — -\$5\.00 on 2026-09-04\./u)
  assert.doesNotMatch(answer, /"Avery"/u)
  // The roster is today's, and the answer must not claim otherwise.
  assert.match(answer, /Population: the 12 current classroom students, not the roster as it existed on 2026-09-04\./u)
  assert.match(answer, /Balance history is unavailable for 1 current student/u)
  assert.match(lines[0], /^Reconstructed balances as of 2026-09-04;/u)
})

test('a historical-only answer carries no today-snapshot sentence', () => {
  const { registry } = setup()
  const historical = registry.execute('get_balance_history', { studentRefs: ['student-002'], startDate: CUTOFF, endDate: CUTOFF })
  const historicalAnswer = registry.render({ schemaVersion: 1, sections: [{ resultId: historical.resultId, view: historical.view }] }).answer
  assert.doesNotMatch(historicalAnswer, /Today's value reflects the snapshot/u)

  const throughToday = registry.execute('get_balance_history', { studentRefs: ['student-002'], startDate: CUTOFF, endDate: '2026-09-08' })
  const todayAnswer = registry.render({ schemaVersion: 1, sections: [{ resultId: throughToday.resultId, view: throughToday.view }] }).answer
  assert.match(todayAnswer, /Today's value reflects the snapshot on 2026-09-08/u)

  const asOfCall = registry.execute('get_balances_as_of', { asOfDate: CUTOFF, condition: 'negative' })
  const asOfAnswer = registry.render({ schemaVersion: 1, sections: [{ resultId: asOfCall.resultId, view: asOfCall.view }] }).answer
  assert.doesNotMatch(asOfAnswer, /Today's value reflects the snapshot/u)
})

test('the active assistant answers the historical question from the reconstructed result', async () => {
  const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
  let turn = 0
  let sawTool = false
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    if (!request.config.tools) {
      return { finishReason: 'STOP', usageMetadata, text: JSON.stringify({ answer: 'Here is who was in the red that day.' }) }
    }
    turn += 1
    if (turn === 1) {
      // The tool must be published to the provider for this path to exist.
      sawTool = request.config.tools[0].functionDeclarations.some(item => item.name === 'get_balances_as_of')
      const functionCalls = [{ id: 'call-1', name: 'get_balances_as_of', args: { asOfDate: CUTOFF, condition: 'negative' } }]
      return {
        finishReason: 'STOP', usageMetadata, functionCalls,
        candidateContent: { role: 'model', parts: functionCalls.map(functionCall => ({ functionCall })) },
      }
    }
    const response = request.contents.at(-1).parts[0].functionResponse.response
    assert.equal(response.view, 'balances-as-of')
    return {
      finishReason: 'STOP', usageMetadata,
      text: JSON.stringify({ schemaVersion: 1, sections: [{ resultId: response.resultId, view: response.view }] }),
    }
  } })
  const result = await assistant.answer({ assistantEvidence: evidence() })
  assert.equal(sawTool, true)
  assert.match(result.answer, /2 current students match: negative balances on 2026-09-04\./u)
  assert.match(result.answer, /"Blake"/u)
  assert.match(result.answer, /"Quinn"/u)
  assert.doesNotMatch(result.answer, /"Avery"/u)
  assert.equal(turn, 2)
})

// The evidence snapshot is taken at 18:00Z, which is midday in America/Denver:
// the classroom date is still in progress when the question is asked.
test('the classroom date is reported as a snapshot, never a completed end-of-day balance', () => {
  const { registry, toolbox } = setup()
  const result = toolbox.execute('get_balances_as_of', { asOfDate: '2026-09-08', condition: 'negative' })
  assert.equal(result.ok, true)
  assert.equal(result.throughSnapshot, true)
  const call = registry.execute('get_balances_as_of', { asOfDate: '2026-09-08', condition: 'negative' })
  const { answer, evidence: lines } = registry.render({ schemaVersion: 1, sections: [{ resultId: call.resultId, view: call.view }] })
  assert.match(answer, /Balances for 2026-09-08 \(America\/Denver\) as of the classroom snapshot taken so far that day, not a completed end-of-day total\./u)
  assert.doesNotMatch(answer, /end-of-day balances for 2026-09-08/u)
  assert.doesNotMatch(answer, /Reconstructed end-of-day/u)
  assert.match(lines[0], /^Balances at the 2026-09-08 classroom snapshot;/u)
  // Avery is negative today, so the value itself is still correct.
  assert.match(answer, /"Avery" — -\$5\.00 on 2026-09-08\./u)
})

test('a past cutoff keeps its completed end-of-day wording', () => {
  const { registry } = setup()
  const call = registry.execute('get_balances_as_of', { asOfDate: CUTOFF, condition: 'negative' })
  const { answer, evidence: lines } = registry.render({ schemaVersion: 1, sections: [{ resultId: call.resultId, view: call.view }] })
  assert.match(answer, /Reconstructed end-of-day balances for 2026-09-04 \(America\/Denver\) from current balances and retained Approved transactions\./u)
  assert.doesNotMatch(answer, /snapshot taken so far/u)
  assert.match(lines[0], /^Reconstructed balances as of 2026-09-04;/u)
})

test('the population line agrees in number with the roster it counts', () => {
  const { registry } = setup(evidence({
    students: [{ ref: 'student-001', displayName: 'Avery', current: true, balance: -5, frozen: false }],
    transactions: [],
  }))
  const call = registry.execute('get_balances_as_of', { asOfDate: CUTOFF, condition: 'negative' })
  const { answer } = registry.render({ schemaVersion: 1, sections: [{ resultId: call.resultId, view: call.view }] })
  assert.match(answer, /Population: the 1 current classroom student, not the roster as it existed on 2026-09-04\./u)
})

test('the active assistant states the snapshot caveat when it asks about today', async () => {
  const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
  let turn = 0
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    if (!request.config.tools) {
      return { finishReason: 'STOP', usageMetadata, text: JSON.stringify({ answer: 'Here is where things stand right now.' }) }
    }
    turn += 1
    if (turn === 1) {
      const functionCalls = [{ id: 'call-1', name: 'get_balances_as_of', args: { asOfDate: '2026-09-08', condition: 'negative' } }]
      return {
        finishReason: 'STOP', usageMetadata, functionCalls,
        candidateContent: { role: 'model', parts: functionCalls.map(functionCall => ({ functionCall })) },
      }
    }
    const response = request.contents.at(-1).parts[0].functionResponse.response
    return {
      finishReason: 'STOP', usageMetadata,
      text: JSON.stringify({ schemaVersion: 1, sections: [{ resultId: response.resultId, view: response.view }] }),
    }
  } })
  const result = await assistant.answer({ assistantEvidence: evidence() })
  assert.match(result.answer, /as of the classroom snapshot taken so far that day, not a completed end-of-day total\./u)
  assert.doesNotMatch(result.answer, /Reconstructed end-of-day/u)
  assert.equal(turn, 2)
})
