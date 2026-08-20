import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateQuestionAnswer } from './questionAnswerCalculator.js'

const evidence = {
  periodDays: 30,
  timeZone: 'America/Denver',
  students: [
    { id: 1, alias: 'student-001', name: 'GianMarco', balance: 42 },
    { id: 2, alias: 'student-002', name: 'Sofia', balance: 75 },
  ],
  transactions: [
    { id: 1, studentId: 1, date: '2026-08-19T15:00:00.000Z', type: 'Add', amount: 12, category: 'Class job', status: 'Approved' },
    { id: 2, studentId: 1, date: '2026-08-19T16:00:00.000Z', type: 'Add', amount: 8, category: 'Class job', status: 'Approved' },
    { id: 3, studentId: 1, date: '2026-08-19T21:00:00.000Z', type: 'Add', amount: 15, category: 'Homework', status: 'Approved' },
    { id: 4, studentId: 1, date: '2026-08-19T20:00:00.000Z', type: 'Subtract', amount: 9, category: 'Store', status: 'Approved' },
    { id: 5, studentId: 2, date: '2026-08-19T20:30:00.000Z', type: 'Subtract', amount: 11, category: 'Store', status: 'Approved' },
    { id: 6, studentId: 2, date: '2026-08-19T17:00:00.000Z', type: 'Subtract', amount: 100, category: 'Ignored pending', status: 'Pending' },
  ],
}

test('calculates the named-student top earning category without asking the model for facts', () => {
  const result = calculateQuestionAnswer({
    intent: 'student-top-earning-category',
    subjectAlias: 'student-001',
    evidence,
  })
  assert.match(result.answer, /GianMarco.*Class job.*\$20\.00/)
  assert.match(result.evidence[0], /2 approved transactions/)
  assert.doesNotMatch(result.answer, /Homework.*most/i)
})

test('uses the browser IANA zone only as the server-owned time-bucketing lens', () => {
  const result = calculateQuestionAnswer({
    intent: 'class-peak-spending-time',
    subjectAlias: null,
    evidence,
  })
  assert.match(result.answer, /afternoon \(12:00 PM–4:59 PM\).*America\/Denver.*\$20\.00/)
  assert.match(result.evidence[1], /America\/Denver/)
  assert.doesNotMatch(JSON.stringify(result), /Ignored pending|\$100/)
})

test('approved totals, current balances, and unsupported questions remain explicit', () => {
  assert.match(calculateQuestionAnswer({
    intent: 'student-current-balance',
    subjectAlias: 'student-001',
    evidence,
  }).answer, /current balance is \$42\.00/)
  assert.match(calculateQuestionAnswer({
    intent: 'class-total-spent',
    subjectAlias: null,
    evidence,
  }).answer, /spent \$20\.00/)
  assert.match(calculateQuestionAnswer({
    intent: 'unsupported',
    subjectAlias: null,
    evidence,
  }).answer, /do not support that question/)
})
