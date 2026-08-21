import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InsightQuestionServiceError,
  createInsightQuestionService,
} from './questionService.js'

const SIGNATURE = 'a'.repeat(64)
const request = Object.freeze({
  requestId: '12345678-1234-4234-8234-123456789abc',
  kind: 'question',
  periodDays: 30,
  timeZone: 'America/Denver',
  question: 'What category is GianMarco earning the most money in?',
})

function envelope() {
  return {
    generatedAt: '2026-08-20T18:00:00.000Z',
    providerInput: {
      schemaVersion: 1,
      question: 'What category is [student-001] earning the most money in?',
      subjectAliases: ['student-001'],
      periodDays: 30,
    },
    answerEvidence: {
      periodDays: 30,
      timeZone: 'America/Denver',
      students: [{ id: 1, alias: 'student-001', name: 'GianMarco', balance: 42 }],
      transactions: [{
        id: 1,
        studentId: 1,
        date: '2026-08-19T16:00:00.000Z',
        type: 'Add',
        amount: 20,
        category: 'Class job',
        status: 'Approved',
      }],
    },
    allowedAliases: ['student-001'],
    sensitiveValues: [
      { kind: 'teacher-uid', value: 'teacher-a' },
      { kind: 'classroom-id', value: 'class-a' },
      { kind: 'student-id', value: '1' },
      { kind: 'student-name', value: 'GianMarco' },
    ],
    evidenceSignature: SIGNATURE,
  }
}

function dependencies(overrides = {}) {
  const calls = []
  const commits = []
  const uncertain = []
  return {
    calls,
    commits,
    uncertain,
    deps: {
      now: () => new Date('2026-08-20T18:00:00.000Z'),
      async resolveActiveTeacherTenant() {
        calls.push('tenant')
        return { teacherUid: 'teacher-a', classroomId: 'class-a' }
      },
      async loadQuestionEvidence(input) {
        calls.push('evidence')
        assert.equal(input.teacherUid, 'teacher-a')
        assert.equal(input.classroomId, 'class-a')
        return envelope()
      },
      async quoteWorstCaseCost({ providerInput }) {
        calls.push('quote')
        assert.doesNotMatch(JSON.stringify(providerInput), /GianMarco|teacher-a|class-a/)
        return { rateCardId: 'question-rate-v1', worstCaseCostMicroUsd: 100_000 }
      },
      provider: {
        async interpret({ providerInput }) {
          calls.push('provider')
          assert.doesNotMatch(JSON.stringify(providerInput), /GianMarco|teacher-a|class-a/)
          return {
            schemaVersion: 1,
            intent: 'student-top-earning-category',
            subjectAlias: 'student-001',
            usage: { inputTokens: 90, outputTokens: 18, thinkingTokens: 0 },
          }
        },
      },
      async priceActualUsage() {
        calls.push('price')
        return 25_000
      },
      usageLedger: {
        async reserve(input) {
          calls.push('reserve')
          assert.equal(input.mode, 'quick')
          assert.equal(input.evidenceSignature, SIGNATURE)
          return {
            kind: 'reserved',
            reservationId: 'b'.repeat(64),
            reservedCostMicroUsd: 100_000,
            remainingAfterReservationMicroUsd: 7_400_000,
          }
        },
        async commit(input) {
          calls.push('commit')
          commits.push(input)
        },
        async markUncertain(input) {
          calls.push('uncertain')
          uncertain.push(input)
        },
      },
      ...overrides,
    },
  }
}

test('resolves tenant, sanitizes evidence, reserves, interprets, calculates, and commits in order', async () => {
  const fixture = dependencies()
  const service = createInsightQuestionService(fixture.deps)
  const result = await service({ auth: { uid: 'teacher-a' }, data: request })
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'price', 'commit'])
  assert.match(result.answer, /GianMarco.*Class job.*\$20\.00/)
  assert.equal(result.source, 'ai-grounded')
  assert.equal(fixture.commits.length, 1)
  const stored = JSON.stringify(fixture.commits[0].result)
  assert.doesNotMatch(stored, /GianMarco|What category|Class job/)
  assert.match(stored, /student-001|student-top-earning-category/)
})

test('browser authority fields fail before tenant resolution', async () => {
  const fixture = dependencies()
  const service = createInsightQuestionService(fixture.deps)
  await assert.rejects(
    service({ auth: { uid: 'teacher-a' }, data: { ...request, classroomId: 'class-b' } }),
    error => error?.category === 'invalid-request',
  )
  assert.deepEqual(fixture.calls, [])
})

test('a declared roster name or name token cannot reach the provider', async () => {
  for (const { leakedQuestion, sensitiveName } of [
    { leakedQuestion: 'What category is GianMarco earning in?', sensitiveName: 'GianMarco' },
    { leakedQuestion: 'What category is gianmarco earning in?', sensitiveName: 'GianMarco' },
    { leakedQuestion: 'What category is GianMarcoBellini earning in?', sensitiveName: 'GianMarco Bellini' },
    { leakedQuestion: 'What category is BelliniGianMarco earning in?', sensitiveName: 'GianMarco Bellini' },
    { leakedQuestion: 'What category is Gian\u200BMarco earning in?', sensitiveName: 'GianMarco' },
    { leakedQuestion: 'What category is Gian-Marco earning in?', sensitiveName: 'GianMarco' },
    { leakedQuestion: 'What is KimVan earning?', sensitiveName: 'Kim Van Lee' },
    { leakedQuestion: 'What is VanLee earning?', sensitiveName: 'Kim Van Lee' },
    { leakedQuestion: 'What is KimLee earning?', sensitiveName: 'Kim Van Lee' },
    { leakedQuestion: 'What is LeeKim earning?', sensitiveName: 'Kim Van Lee' },
    { leakedQuestion: 'What is LeeVanKim earning?', sensitiveName: 'Kim Van Lee' },
    { leakedQuestion: 'What is MariaCruz earning?', sensitiveName: 'Ana Maria Lopez Cruz' },
    { leakedQuestion: 'What is AnaLopez earning?', sensitiveName: 'Ana Maria Lopez Cruz' },
    { leakedQuestion: 'What is CruzAnaMaria earning?', sensitiveName: 'Ana Maria Lopez Cruz' },
    { leakedQuestion: 'What is MarkA earning?', sensitiveName: 'Mark A Chen' },
    { leakedQuestion: 'What is AChen earning?', sensitiveName: 'Mark A Chen' },
    { leakedQuestion: 'What is ChenAMark earning?', sensitiveName: 'Mark A Chen' },
  ]) {
    const fixture = dependencies({
      async loadQuestionEvidence() {
        fixture.calls.push('evidence')
        return {
          ...envelope(),
          providerInput: { ...envelope().providerInput, question: leakedQuestion },
          sensitiveValues: envelope().sensitiveValues.map(entry => entry.kind === 'student-name'
            ? { ...entry, value: sensitiveName }
            : entry),
        }
      },
    })
    const service = createInsightQuestionService(fixture.deps)
    await assert.rejects(
      service({ auth: { uid: 'teacher-a' }, data: request }),
      error => error instanceof InsightQuestionServiceError && error.category === 'evidence-not-deidentified',
    )
    assert.deepEqual(fixture.calls, ['tenant', 'evidence'])
  }
})

test('ordinary words containing a declared name substring still reach the provider', async () => {
  for (const question of [
    'What is a benchmark total this week?',
    'How much did the kitchen job pay out?',
    'Were remarks or chenille supplies approved?',
    'What was earmarked for supplies?',
    'Is A the top earner?',
  ]) {
    const fixture = dependencies({
      async loadQuestionEvidence() {
        fixture.calls.push('evidence')
        return {
          ...envelope(),
          providerInput: { ...envelope().providerInput, question },
          sensitiveValues: envelope().sensitiveValues.map(entry => entry.kind === 'student-name'
            ? { ...entry, value: 'Mark A Chen' }
            : entry),
        }
      },
    })
    const service = createInsightQuestionService(fixture.deps)
    await service({ auth: { uid: 'teacher-a' }, data: request })
    assert.deepEqual(
      fixture.calls,
      ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'price', 'commit'],
    )
  }
})

test('provider failure retains the worst-case reservation and returns no answer', async () => {
  const fixture = dependencies({
    provider: {
      async interpret() {
        fixture.calls.push('provider')
        throw new Error('upstream detail')
      },
    },
  })
  const service = createInsightQuestionService(fixture.deps)
  await assert.rejects(
    service({ auth: { uid: 'teacher-a' }, data: request }),
    error => error instanceof InsightQuestionServiceError &&
      error.category === 'provider-unavailable' &&
      !error.message.includes('upstream'),
  )
  assert.equal(fixture.uncertain.length, 1)
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'uncertain'])
})

test('completed replay is signature-checked and recalculated from current server evidence', async () => {
  const completed = {
    schemaVersion: 1,
    source: 'provider-interpreted',
    periodDays: 30,
    evidenceSignature: SIGNATURE,
    generatedAt: '2026-08-20T18:00:00.000Z',
    intent: 'student-top-earning-category',
    subjectAlias: 'student-001',
    usage: { inputTokens: 90, outputTokens: 18, thinkingTokens: 0, costMicroUsd: 25_000 },
  }
  const fixture = dependencies({
    usageLedger: {
      async reserve() {
        fixture.calls.push('reserve')
        return { kind: 'completed', result: completed }
      },
      async commit() { throw new Error('must not commit') },
      async markUncertain() { throw new Error('must not mark') },
    },
  })
  const service = createInsightQuestionService(fixture.deps)
  const result = await service({ auth: { uid: 'teacher-a' }, data: request })
  assert.match(result.answer, /GianMarco.*\$20\.00/)
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve'])
})
