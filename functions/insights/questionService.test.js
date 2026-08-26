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
      schemaVersion: 6,
      question: 'What category is [student-001] earning the most money in?',
      subjectAliases: ['student-001'],
      subjectHints: [],
      categoryCatalog: [{ alias: 'category-001', label: 'Class job', transactionTypes: ['Add'] }],
      periodDays: 30,
    },
    answerEvidence: {
      configuredRentAmount: 10,
      periodDays: 30,
      periodStart: '2026-07-21T18:00:00.000Z',
      timeZone: 'America/Denver',
      asOfDate: '2026-08-20',
      participants: [{ id: 1, alias: 'student-001', name: 'GianMarco' }],
      students: [{ id: 1, alias: 'student-001', name: 'GianMarco', balance: 42, frozen: false }],
      categories: [{ alias: 'category-001', label: 'Class job' }],
      transactions: [{
        id: 1,
        studentId: 1,
        date: '2026-08-19T16:00:00.000Z',
        type: 'Add',
        amount: 20,
        categoryAlias: 'category-001',
        purpose: 'other',
        status: 'Approved',
      }],
    },
    allowedAliases: {
      studentAliases: ['student-001'],
      categoryAliases: ['category-001'],
    },
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
            schemaVersion: 6,
            kind: 'query',
            plan: {
              dataset: 'transactions',
              metric: 'amount-total',
              filters: {
                subjectAliases: ['student-001'],
                categoryAlias: null,
                transactionType: 'Add',
                status: 'Approved',
                dateScope: 'period',
                timeBucket: null,
                studentState: 'any',
              },
              groupBy: 'category',
              order: 'highest',
              limit: 1,
            },
            guidance: null,
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
  assert.match(result.answer, /GianMarco.*class job.*\$20\.00/i)
  assert.equal(result.source, 'ai-grounded')
  assert.equal(result.schemaVersion, 2)
  assert.equal(fixture.commits.length, 1)
  const stored = JSON.stringify(fixture.commits[0].result)
  assert.doesNotMatch(stored, /GianMarco|What category|Class job/)
  assert.match(stored, /student-001|amount-total/)
})

test('commits broad Morgan Bank guidance without turning it into a classroom-data claim', async () => {
  const guidance = 'Set a small weekly savings goal, keep earning categories predictable, and offer optional purchases so students can practice choosing between spending now and saving.'
  const fixture = dependencies({
    provider: {
      async interpret({ providerInput }) {
        fixture.calls.push('provider')
        assert.doesNotMatch(JSON.stringify(providerInput), /GianMarco|teacher-a|class-a/)
        return {
          schemaVersion: 6,
          kind: 'guidance',
          plan: null,
          guidance,
          usage: { inputTokens: 110, outputTokens: 42, thinkingTokens: 0 },
        }
      },
    },
  })
  const result = await createInsightQuestionService(fixture.deps)({
    auth: { uid: 'teacher-a' },
    data: { ...request, question: 'How can I encourage students to save in Morgan Bank?' },
  })
  assert.equal(result.answer, guidance)
  assert.deepEqual(result.evidence, [
    'General Morgan Bank guidance; no classroom records were used to make a factual claim.',
  ])
  assert.equal(fixture.commits.length, 1)
  assert.equal(fixture.commits[0].result.kind, 'guidance')
  assert.equal(fixture.commits[0].result.plan, null)
  assert.equal(fixture.commits[0].result.guidance, guidance)
  assert.doesNotMatch(JSON.stringify(fixture.commits[0].result), /GianMarco/)
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'price', 'commit'])
})

test('commits a bounded refusal for unrelated or data-changing requests', async () => {
  for (const question of [
    'Write a poem about the moon.',
    'Change every student balance to $100.',
  ]) {
    const fixture = dependencies({
      provider: {
        async interpret() {
          fixture.calls.push('provider')
          return {
            schemaVersion: 6,
            kind: 'unsupported',
            plan: null,
            guidance: null,
            usage: { inputTokens: 80, outputTokens: 12, thinkingTokens: 0 },
          }
        },
      },
    })
    const result = await createInsightQuestionService(fixture.deps)({
      auth: { uid: 'teacher-a' },
      data: { ...request, question },
    })
    assert.match(result.answer, /Morgan Bank.*classroom-economy routines/i)
    assert.match(result.evidence[0], /No answer was generated outside/)
    assert.equal(fixture.commits.length, 1)
    assert.equal(fixture.commits[0].result.kind, 'unsupported')
    assert.equal(fixture.commits[0].result.plan, null)
    assert.equal(fixture.commits[0].result.guidance, null)
    assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'price', 'commit'])
  }
})

test('commits a grounded answer naming current students without todays exact rent payment', async () => {
  const value = envelope()
  const students = [
    { id: 1, alias: 'student-001', name: 'Genesis', balance: 42, frozen: false },
    { id: 2, alias: 'student-002', name: 'Sofia', balance: 75, frozen: false },
    { id: 3, alias: 'student-003', name: 'Mateo', balance: 25, frozen: false },
  ]
  const rentEnvelope = {
    ...value,
    providerInput: {
      ...value.providerInput,
      question: 'Are there current students who did not pay $10 in rent today?',
      subjectAliases: [],
    },
    answerEvidence: {
      ...value.answerEvidence,
      participants: students.map(({ id, alias, name }) => ({ id, alias, name })),
      students,
      transactions: [
        { id: 1, studentId: 1, date: '2026-08-20T16:00:00.000Z', type: 'Subtract', amount: 10, categoryAlias: 'category-001', purpose: 'rent', status: 'Approved' },
        { id: 2, studentId: 2, date: '2026-08-20T16:05:00.000Z', type: 'Subtract', amount: 5, categoryAlias: 'category-001', purpose: 'rent', status: 'Approved' },
      ],
    },
    allowedAliases: { studentAliases: [], categoryAliases: ['category-001'] },
    sensitiveValues: [
      { kind: 'teacher-uid', value: 'teacher-a' },
      { kind: 'classroom-id', value: 'class-a' },
      ...students.flatMap(student => [
        { kind: 'student-id', value: String(student.id) },
        { kind: 'student-name', value: student.name },
      ]),
    ],
  }
  const fixture = dependencies({
    async loadQuestionEvidence() {
      fixture.calls.push('evidence')
      return rentEnvelope
    },
    provider: {
      async interpret() {
        fixture.calls.push('provider')
        return {
          schemaVersion: 6,
          kind: 'query',
          plan: {
            operation: 'students-without-transactions',
            subjectAliases: [],
            categoryAlias: null,
            purpose: 'rent',
            transactionType: 'Subtract',
            status: 'Approved',
            dateScope: 'today',
            amountExact: 10,
            studentState: 'any',
            limit: 8,
          },
          guidance: null,
          usage: { inputTokens: 90, outputTokens: 18, thinkingTokens: 0 },
        }
      },
    },
  })
  const result = await createInsightQuestionService(fixture.deps)({
    auth: { uid: 'teacher-a' },
    data: { ...request, question: 'Are there current students who did not pay $10 in rent today?' },
  })
  assert.match(result.answer, /^Yes\. 2 of 3 current students/)
  assert.match(result.answer, /Mateo.*Sofia/)
  assert.doesNotMatch(result.answer, /exactly \$10\.00/)
  assert.match(result.evidence.join(' '), /exactly \$10\.00/)
  assert.equal(fixture.commits.length, 1)
  assert.equal(fixture.uncertain.length, 0)
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'price', 'commit'])
  assert.doesNotMatch(JSON.stringify(fixture.commits[0].result), /Genesis|Sofia|Mateo/)
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

test('a declared multi-part roster identity cannot be reconstructed in provider text', async () => {
  for (const { leakedQuestion, sensitiveName } of [
    { leakedQuestion: 'What category is GianMarcoBellini earning in?', sensitiveName: 'GianMarco Bellini' },
    { leakedQuestion: 'What category is BelliniGianMarco earning in?', sensitiveName: 'GianMarco Bellini' },
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
    { leakedQuestion: 'Did An T Vu earn money?', sensitiveName: 'An Vu' },
    { leakedQuestion: 'Did Rose X Garden earn money?', sensitiveName: 'Rose Garden' },
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

test('ordinary category and question words may match a partial or single-token roster name', async () => {
  const fixture = dependencies({
    async loadQuestionEvidence() {
      fixture.calls.push('evidence')
      const value = envelope()
      return {
        ...value,
        providerInput: {
          ...value.providerInput,
          question: 'Has [student-001] been paid yesterday and today for technology?',
          categoryCatalog: [{
            ...value.providerInput.categoryCatalog[0],
            label: 'Technology',
          }],
        },
        sensitiveValues: [
          ...value.sensitiveValues.filter(entry => entry.kind !== 'student-name'),
          { kind: 'student-name', value: 'Taylor Technology' },
          { kind: 'student-name', value: 'Paid' },
        ],
      }
    },
  })
  const service = createInsightQuestionService(fixture.deps)
  await service({ auth: { uid: 'teacher-a' }, data: request })
  assert.deepEqual(
    fixture.calls,
    ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'price', 'commit'],
  )
})

test('single-token roster names retain separator-obscured defense in the service layer', async () => {
  const fixture = dependencies({
    async loadQuestionEvidence() {
      fixture.calls.push('evidence')
      const value = envelope()
      return {
        ...value,
        providerInput: {
          ...value.providerInput,
          question: 'What is Gian-Marco earning?',
        },
        sensitiveValues: [
          ...value.sensitiveValues.filter(entry => entry.kind !== 'student-name'),
          { kind: 'student-name', value: 'GianMarco' },
        ],
      }
    },
  })
  const service = createInsightQuestionService(fixture.deps)
  await assert.rejects(
    service({ auth: { uid: 'teacher-a' }, data: request }),
    error => error instanceof InsightQuestionServiceError &&
      error.category === 'evidence-not-deidentified',
  )
  assert.deepEqual(fixture.calls, ['tenant', 'evidence'])
})

test('subject hints cannot carry a complete single-token roster identity past the service boundary', async () => {
  const fixture = dependencies({
    async loadQuestionEvidence() {
      fixture.calls.push('evidence')
      const value = envelope()
      return {
        ...value,
        providerInput: {
          ...value.providerInput,
          question: 'Which category does GianMarco use most?',
          subjectHints: [{ text: 'GianMarco', studentAlias: 'student-001' }],
        },
        sensitiveValues: value.sensitiveValues.map(entry => entry.kind === 'student-name'
          ? { ...entry, value: 'GianMarco' }
          : entry),
      }
    },
  })
  const service = createInsightQuestionService(fixture.deps)
  await assert.rejects(
    service({ auth: { uid: 'teacher-a' }, data: request }),
    error => error instanceof InsightQuestionServiceError &&
      error.category === 'evidence-not-deidentified',
  )
  assert.deepEqual(fixture.calls, ['tenant', 'evidence'])
})

test('declared tenant identities cannot be smuggled through category catalog labels', async () => {
  for (const label of ['class-a', 'classa', 'teacher.a']) {
    const fixture = dependencies({
      async loadQuestionEvidence() {
        fixture.calls.push('evidence')
        const value = envelope()
        return {
          ...value,
          providerInput: {
            ...value.providerInput,
            categoryCatalog: [{ ...value.providerInput.categoryCatalog[0], label }],
          },
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

test('unsafe provider guidance is rejected before pricing or commit and retains the reservation', async () => {
  const fixture = dependencies({
    provider: {
      async interpret() {
        fixture.calls.push('provider')
        return {
          schemaVersion: 6,
          kind: 'guidance',
          plan: null,
          guidance: 'Tell student-001 to visit https://example.com and change the account immediately.',
          usage: { inputTokens: 100, outputTokens: 25, thinkingTokens: 0 },
        }
      },
    },
  })
  await assert.rejects(
    createInsightQuestionService(fixture.deps)({ auth: { uid: 'teacher-a' }, data: request }),
    error => error instanceof InsightQuestionServiceError && error.category === 'provider-output-invalid',
  )
  assert.equal(fixture.commits.length, 0)
  assert.equal(fixture.uncertain.length, 1)
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'uncertain'])
})

test('server calculation must succeed before pricing or commit and failures retain worst-case cost', async () => {
  const fixture = dependencies({
    async loadQuestionEvidence() {
      fixture.calls.push('evidence')
      const value = envelope()
      return {
        ...value,
        answerEvidence: {
          ...value.answerEvidence,
          transactions: value.answerEvidence.transactions.map(transaction => ({
            ...transaction,
            categoryAlias: 'category-999',
          })),
        },
      }
    },
  })
  const service = createInsightQuestionService(fixture.deps)
  await assert.rejects(
    service({ auth: { uid: 'teacher-a' }, data: request }),
    error => error instanceof InsightQuestionServiceError && error.category === 'answer-unavailable',
  )
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'uncertain'])
  assert.equal(fixture.commits.length, 0)
  assert.equal(fixture.uncertain.length, 1)
})

test('completed replay is signature-checked and recalculated from current server evidence', async () => {
  const completed = {
    schemaVersion: 6,
    source: 'provider-interpreted',
    periodDays: 30,
    evidenceSignature: SIGNATURE,
    generatedAt: '2026-08-20T18:00:00.000Z',
    kind: 'query',
    plan: {
      dataset: 'transactions',
      metric: 'amount-total',
      filters: {
        subjectAliases: ['student-001'],
        categoryAlias: null,
        transactionType: 'Add',
        status: 'Approved',
        dateScope: 'period',
        timeBucket: null,
        studentState: 'any',
      },
      groupBy: 'category',
      order: 'highest',
      limit: 1,
    },
    guidance: null,
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

test('completed Morgan Bank guidance replays only after current evidence binding succeeds', async () => {
  const guidance = 'Use consistent categories and a visible class goal so students can connect everyday earning choices with longer-term saving.'
  const completed = {
    schemaVersion: 6,
    source: 'provider-interpreted',
    periodDays: 30,
    evidenceSignature: SIGNATURE,
    generatedAt: '2026-08-20T18:00:00.000Z',
    kind: 'guidance',
    plan: null,
    guidance,
    usage: { inputTokens: 100, outputTokens: 30, thinkingTokens: 0, costMicroUsd: 25_000 },
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
  const result = await createInsightQuestionService(fixture.deps)({
    auth: { uid: 'teacher-a' },
    data: { ...request, question: 'How can I make saving feel meaningful?' },
  })
  assert.equal(result.answer, guidance)
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve'])
})

test('maximum-length category rankings are validated before a successful ledger commit', async () => {
  const categories = Array.from({ length: 8 }, (_, index) => ({
    alias: `category-${String(index + 1).padStart(3, '0')}`,
    label: `${String(index + 1).padStart(3, '0')}-${'Long category label '.repeat(8)}`.slice(0, 120),
  }))
  const value = envelope()
  const rankedEnvelope = {
    ...value,
    providerInput: {
      ...value.providerInput,
      categoryCatalog: categories.map(category => ({
        ...category,
        transactionTypes: ['Add'],
      })),
    },
    answerEvidence: {
      ...value.answerEvidence,
      categories,
      transactions: categories.map((category, index) => ({
        ...value.answerEvidence.transactions[0],
        id: index + 1,
        amount: 100 - index,
        categoryAlias: category.alias,
      })),
    },
    allowedAliases: {
      ...value.allowedAliases,
      categoryAliases: categories.map(category => category.alias),
    },
  }
  const fixture = dependencies({
    async loadQuestionEvidence() {
      fixture.calls.push('evidence')
      return rankedEnvelope
    },
    provider: {
      async interpret() {
        fixture.calls.push('provider')
        return {
          schemaVersion: 6,
          kind: 'query',
          plan: {
            dataset: 'transactions',
            metric: 'amount-total',
            filters: {
              subjectAliases: ['student-001'],
              categoryAlias: null,
              transactionType: 'Add',
              status: 'Approved',
              dateScope: 'period',
              timeBucket: null,
              studentState: 'any',
            },
            groupBy: 'category',
            order: 'highest',
            limit: 8,
          },
          guidance: null,
          usage: { inputTokens: 90, outputTokens: 18, thinkingTokens: 0 },
        }
      },
    },
  })
  const result = await createInsightQuestionService(fixture.deps)({
    auth: { uid: 'teacher-a' },
    data: request,
  })
  assert.ok(result.answer.length <= 800)
  assert.equal(result.evidence.length, 8)
  assert.ok(result.evidence.every(line => line.length <= 320))
  assert.equal(fixture.commits.length, 1)
  assert.equal(fixture.uncertain.length, 0)
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'price', 'commit'])
})

test('ranked and aggregate maximum-length named-student queries commit valid responses', async () => {
  const value = envelope()
  const students = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    alias: `student-${String(index + 1).padStart(3, '0')}`,
    name: String.fromCharCode(65 + index).repeat(120),
    balance: 10,
    frozen: true,
  }))
  const category = {
    alias: 'category-001',
    label: `Rent ${'R'.repeat(115)}`,
  }
  const transactions = students.map((student, index) => ({
    id: index + 1,
    studentId: student.id,
    date: '2026-08-19T20:00:00.000Z',
    type: index % 2 ? 'Add' : 'Subtract',
    amount: 10,
    categoryAlias: category.alias,
    purpose: 'other',
    status: index % 3 ? 'Approved' : 'Pending',
  }))
  const aliases = students.map(student => student.alias)
  const rankedEnvelope = {
    ...value,
    providerInput: {
      ...value.providerInput,
      subjectAliases: aliases,
      categoryCatalog: [{ ...category, transactionTypes: ['Add', 'Subtract'] }],
    },
    answerEvidence: {
      ...value.answerEvidence,
      participants: students.map(({ id, alias, name }) => ({ id, alias, name })),
      students,
      categories: [category],
      transactions,
    },
    allowedAliases: {
      studentAliases: aliases,
      categoryAliases: [category.alias],
    },
    sensitiveValues: [
      { kind: 'teacher-uid', value: 'teacher-a' },
      { kind: 'classroom-id', value: 'class-a' },
      ...students.flatMap(student => [
        { kind: 'student-id', value: String(student.id) },
        { kind: 'student-name', value: student.name },
      ]),
    ],
  }
  for (const [groupBy, limit, evidenceCount] of [['student', 8, 8], ['none', 1, 1]]) {
    const fixture = dependencies({
      async loadQuestionEvidence() {
        fixture.calls.push('evidence')
        return rankedEnvelope
      },
      provider: {
        async interpret() {
          fixture.calls.push('provider')
          return {
            schemaVersion: 6,
            kind: 'query',
            plan: {
              dataset: 'transactions',
              metric: 'count',
              filters: {
                subjectAliases: aliases,
                categoryAlias: category.alias,
                transactionType: 'any',
                status: 'any',
                dateScope: 'period',
                timeBucket: 'afternoon',
                studentState: 'frozen',
              },
              groupBy,
              order: 'highest',
              limit,
            },
            guidance: null,
            usage: { inputTokens: 90, outputTokens: 18, thinkingTokens: 0 },
          }
        },
      },
    })
    const result = await createInsightQuestionService(fixture.deps)({
      auth: { uid: 'teacher-a' },
      data: request,
    })
    assert.equal(result.schemaVersion, 2)
    assert.ok(result.answer.length <= 800)
    assert.equal(result.evidence.length, evidenceCount)
    assert.ok(result.evidence.every(line => line.length <= 320))
    assert.match(result.answer, /…/)
    assert.equal(fixture.commits.length, 1)
    assert.equal(fixture.uncertain.length, 0)
    assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'price', 'commit'])
  }
})

test('response construction failures retain the reservation without committing or blaming the provider', async () => {
  const fixture = dependencies({
    async loadQuestionEvidence() {
      fixture.calls.push('evidence')
      const value = envelope()
      const unsafeName = 'Unsafe\u007fName'
      return {
        ...value,
        answerEvidence: {
          ...value.answerEvidence,
          participants: [{ ...value.answerEvidence.participants[0], name: unsafeName }],
          students: [{ ...value.answerEvidence.students[0], name: unsafeName }],
        },
        sensitiveValues: value.sensitiveValues.map(entry => (
          entry.kind === 'student-name' ? { ...entry, value: unsafeName } : entry
        )),
      }
    },
    provider: {
      async interpret() {
        fixture.calls.push('provider')
        return {
          schemaVersion: 6,
          kind: 'query',
          plan: {
            dataset: 'transactions',
            metric: 'amount-total',
            filters: {
              subjectAliases: [],
              categoryAlias: null,
              transactionType: 'Add',
              status: 'Approved',
              dateScope: 'period',
              timeBucket: null,
              studentState: 'any',
            },
            groupBy: 'student',
            order: 'highest',
            limit: 1,
          },
          guidance: null,
          usage: { inputTokens: 90, outputTokens: 18, thinkingTokens: 0 },
        }
      },
    },
  })
  const service = createInsightQuestionService(fixture.deps)
  await assert.rejects(
    service({ auth: { uid: 'teacher-a' }, data: request }),
    error => error instanceof InsightQuestionServiceError && error.category === 'answer-unavailable',
  )
  assert.equal(fixture.commits.length, 0)
  assert.equal(fixture.uncertain.length, 1)
  assert.deepEqual(fixture.calls, ['tenant', 'evidence', 'quote', 'reserve', 'provider', 'price', 'uncertain'])
})
