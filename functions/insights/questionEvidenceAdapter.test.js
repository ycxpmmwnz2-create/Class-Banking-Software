import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InsightQuestionEvidenceError,
  createFirestoreQuestionEvidenceLoader,
} from './questionEvidenceAdapter.js'

const NOW = new Date('2026-08-20T18:00:00.000Z')

function fixture(overrides = {}) {
  return {
    'teachers/teacher-a': { uid: 'teacher-a', status: 'active', classroomId: 'class-a' },
    'classrooms/class-a': { ownerUid: 'teacher-a' },
    'classrooms/class-a/students/1': {
      id: 1,
      name: 'GianMarco Bellini',
      balance: 42,
      frozen: false,
      transactions: [],
    },
    'classrooms/class-a/students/2': {
      id: 2,
      name: 'Sofia Reyes',
      balance: 75,
      frozen: false,
      transactions: [],
    },
    'classrooms/class-a/transactions/101': {
      id: 101,
      date: '2026-08-19T16:00:00.000Z',
      studentId: 1,
      studentName: 'GianMarco Bellini',
      type: 'Add',
      amount: 20,
      reason: 'Class job',
      memo: '',
      category: 'Class job',
      status: 'Approved',
      source: 'Teacher',
    },
    ...overrides,
  }
}

function createFirestoreDouble(initial) {
  const store = new Map(Object.entries(initial))
  const reads = []
  function document(path) {
    return {
      path,
      id: path.split('/').at(-1),
      collection(name) { return query(`${path}/${name}`) },
    }
  }
  function query(path) {
    return {
      path,
      kind: 'query',
      limitCount: null,
      doc(id) { return document(`${path}/${id}`) },
      limit(count) { return { ...this, limitCount: count } },
    }
  }
  function snapshot(path) {
    return { exists: store.has(path), id: path.split('/').at(-1), data: () => store.get(path) }
  }
  return {
    reads,
    firestore: {
      collection(name) { return query(name) },
      async runTransaction(callback) {
        return callback({
          async get(reference) {
            reads.push(reference.kind === 'query' ? `${reference.path}|limit=${reference.limitCount}` : reference.path)
            if (reference.kind !== 'query') return snapshot(reference.path)
            const prefix = `${reference.path}/`
            const docs = [...store.keys()]
              .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
              .sort()
              .map(snapshot)
              .slice(0, reference.limitCount ?? undefined)
            return { size: docs.length, docs }
          },
        })
      },
    },
  }
}

function loader(data = fixture(), currentTime = NOW) {
  return createFirestoreQuestionEvidenceLoader({
    firestore: createFirestoreDouble(data).firestore,
    now: () => currentTime,
  })
}

test('replaces a full or unique partial roster name before constructing provider input', async () => {
  for (const question of [
    'What category is GianMarco Bellini earning the most money in?',
    'What category is GianMarco earning the most money in?',
  ]) {
    const envelope = await loader()({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question,
    })
    assert.deepEqual(envelope.providerInput.subjectAliases, ['student-001'])
    assert.equal(envelope.providerInput.schemaVersion, 4)
    assert.deepEqual(envelope.providerInput.categoryCatalog, [{
      alias: 'category-001',
      label: 'Class job',
      transactionTypes: ['Add'],
    }])
    assert.deepEqual(envelope.allowedAliases, {
      studentAliases: ['student-001'],
      categoryAliases: ['category-001'],
    })
    assert.match(envelope.providerInput.question, /\[student-001\]/)
    assert.doesNotMatch(JSON.stringify(envelope.providerInput), /GianMarco|Bellini|Sofia|Reyes|teacher-a|class-a/)
    assert.equal(envelope.answerEvidence.students[0].name, 'GianMarco Bellini')
    assert.equal(envelope.answerEvidence.transactions[0].categoryAlias, 'category-001')
    assert.equal(envelope.answerEvidence.transactions[0].purpose, 'other')
    assert.equal(envelope.answerEvidence.asOfDate, '2026-08-20')
    assert.match(envelope.evidenceSignature, /^[a-f0-9]{64}$/)
  }
})

test('classifies a V2 blank-category Rent reason only in server answer evidence', async () => {
  const base = fixture()['classrooms/class-a/transactions/101']
  const envelope = await loader(fixture({
    'classrooms/class-a/transactions/101': {
      ...base,
      date: '2026-08-20T16:00:00.000Z',
      type: 'Subtract',
      amount: 10,
      reason: 'Rent',
      category: '',
    },
  }))({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Which students did not pay $10 in rent today?',
  })
  assert.equal(envelope.answerEvidence.transactions[0].purpose, 'rent')
  assert.equal(envelope.answerEvidence.asOfDate, '2026-08-20')
  assert.deepEqual(envelope.providerInput.categoryCatalog, [{
    alias: 'category-001',
    label: 'Uncategorized',
    transactionTypes: ['Subtract'],
  }])
  assert.doesNotMatch(JSON.stringify(envelope.providerInput), /GianMarco|Sofia|teacher-a|class-a/)
})

test('binds today questions to the classroom local date without exposing it to the provider', async () => {
  const input = {
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Which students did not pay rent today?',
  }
  const first = await loader(fixture(), new Date('2026-08-20T23:59:00.000Z'))(input)
  const next = await loader(fixture(), new Date('2026-08-21T06:01:00.000Z'))(input)
  assert.equal(first.answerEvidence.asOfDate, '2026-08-20')
  assert.equal(next.answerEvidence.asOfDate, '2026-08-21')
  assert.notEqual(first.evidenceSignature, next.evidenceSignature)
  assert.equal(Object.hasOwn(first.providerInput, 'asOfDate'), false)
})

test('provider receives only a bounded category catalog and never raw transaction reasons or facts', async () => {
  const envelope = await loader(fixture({
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      type: 'Subtract',
      amount: 500,
      reason: 'Private free-form teacher explanation',
      category: 'Bathroom break',
    },
  }))({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Who has used the restroom the most?',
  })
  const serialized = JSON.stringify(envelope.providerInput)
  assert.match(serialized, /Bathroom break/)
  assert.doesNotMatch(serialized, /Private free-form|500|GianMarco|Sofia/)
  assert.deepEqual(envelope.providerInput.categoryCatalog[0].transactionTypes, ['Subtract'])
})

test('historical transaction participants remain answerable without entering provider input', async () => {
  const envelope = await loader(fixture({
    'classrooms/class-a/transactions/102': {
      ...fixture()['classrooms/class-a/transactions/101'],
      id: 102,
      studentId: 3,
      studentName: 'Former Student',
      type: 'Subtract',
      amount: 1,
      category: 'Bathroom break',
    },
  }))({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Who has used the restroom the most?',
  })
  assert.deepEqual(envelope.answerEvidence.participants.at(-1), {
    id: 3,
    alias: 'student-003',
    name: 'Former Student',
  })
  assert.ok(envelope.sensitiveValues.some(entry => (
    entry.kind === 'student-name' && entry.value === 'Former Student'
  )))
  assert.doesNotMatch(JSON.stringify(envelope.providerInput), /Former Student/)
})

test('up to eight named students become opaque aliases for grounded comparisons', async () => {
  const envelope = await loader()({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Compare GianMarco Bellini and Sofia Reyes by current balance.',
  })
  assert.deepEqual(envelope.providerInput.subjectAliases, ['student-001', 'student-002'])
  assert.match(envelope.providerInput.question, /\[student-001\].*\[student-002\]/)
  assert.doesNotMatch(JSON.stringify(envelope.providerInput), /GianMarco|Bellini|Sofia|Reyes/)
})

test('unsafe category labels become deterministic neutral aliases without blocking safe classroom data', async () => {
  const base = fixture()['classrooms/class-a/transactions/101']
  const envelope = await loader(fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Grace',
    },
    'classrooms/class-a/students/2': {
      ...fixture()['classrooms/class-a/students/2'],
      name: 'Private category 001',
    },
    'classrooms/class-a/transactions/101': {
      ...base,
      studentName: 'Grace',
      category: 'Grace period fee',
    },
    'classrooms/class-a/transactions/102': {
      ...base,
      id: 102,
      studentName: 'Grace',
      category: 'Class job',
    },
    'classrooms/class-a/transactions/103': {
      ...base,
      id: 103,
      studentName: 'Grace',
      category: '2026 08 21',
    },
    'classrooms/class-a/transactions/104': {
      ...base,
      id: 104,
      studentName: 'Grace',
      category: 'teacher@example.com',
    },
  }))({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'How many approved transactions are there?',
  })
  const providerText = JSON.stringify(envelope.providerInput)
  assert.match(providerText, /Class job/)
  assert.match(providerText, /◆◆/)
  assert.match(providerText, /Restricted label 003/)
  assert.match(providerText, /Restricted label 004/)
  assert.doesNotMatch(providerText, /Grace period fee|2026 08 21|teacher@example\.com/)
  assert.deepEqual(
    envelope.answerEvidence.categories.map(category => category.label),
    envelope.providerInput.categoryCatalog.map(category => category.label),
  )
})

test('deduplicates case and whitespace equivalent categories while accumulating transaction types', async () => {
  const base = fixture()['classrooms/class-a/transactions/101']
  const envelope = await loader(fixture({
    'classrooms/class-a/transactions/101': { ...base, category: '  Class   Job  ', type: 'Add' },
    'classrooms/class-a/transactions/102': { ...base, id: 102, category: 'class job', type: 'Subtract' },
  }))({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Which category has the most transactions?',
  })
  assert.deepEqual(envelope.providerInput.categoryCatalog, [{
    alias: 'category-001',
    label: 'Class Job',
    transactionTypes: ['Add', 'Subtract'],
  }])
  assert.ok(envelope.answerEvidence.transactions.every(transaction => (
    transaction.categoryAlias === 'category-001'
  )))
})

test('validates one distinct category label rather than repeating roster checks at read ceilings', { timeout: 10_000 }, async () => {
  const base = fixture()['classrooms/class-a/transactions/101']
  const students = Object.fromEntries(Array.from({ length: 498 }, (_, index) => {
    const id = index + 3
    return [`classrooms/class-a/students/${id}`, {
      ...fixture()['classrooms/class-a/students/1'],
      id,
      name: `Roster Student ${String(id).padStart(3, '0')}`,
    }]
  }))
  const transactions = Object.fromEntries(Array.from({ length: 19_999 }, (_, index) => {
    const id = index + 1_000
    return [`classrooms/class-a/transactions/${id}`, {
      ...base,
      id,
      type: index % 2 ? 'Add' : 'Subtract',
      category: index % 2 ? 'Class job' : '  CLASS   JOB ',
    }]
  }))
  const startedAt = Date.now()
  const envelope = await loader(fixture({ ...students, ...transactions }))({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Which category has the most transactions?',
  })
  assert.ok(Date.now() - startedAt < 5_000)
  assert.deepEqual(envelope.providerInput.categoryCatalog, [{
    alias: 'category-001',
    label: 'Class job',
    transactionTypes: ['Add', 'Subtract'],
  }])
})

test('category aliases are stable across transaction order and category catalog size fails closed', async () => {
  const categories = Object.fromEntries(Array.from({ length: 129 }, (_, index) => {
    const id = 200 + index
    return [`classrooms/class-a/transactions/${id}`, {
      ...fixture()['classrooms/class-a/transactions/101'],
      id,
      category: `Category ${String(index).padStart(3, '0')}`,
    }]
  }))
  await assert.rejects(
    loader(fixture(categories))({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question: 'Which category has the most transactions?',
    }),
    error => error instanceof InsightQuestionEvidenceError && error.category === 'evidence-too-large',
  )
})

test('normalizes the exact legacy browser date using the teacher time zone', async () => {
  const envelope = await loader(fixture({
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      date: '8/19/2026, 10:00:00 AM',
    },
  }))({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'When is the class earning the most money?',
  })
  assert.equal(envelope.answerEvidence.transactions[0].date, '2026-08-19T16:00:00.000Z')
})

test('rejects parseable date shapes outside the stored Morgan Bank contract', async () => {
  const load = loader(fixture({
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      date: '2026-08-19T16:00:00Z',
    },
  }))
  await assert.rejects(
    load({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question: 'When is the class earning the most money?',
    }),
    error => error instanceof InsightQuestionEvidenceError && error.category === 'evidence-malformed',
  )
})

test('separator-obscured roster names fail before provider input can be constructed', async () => {
  for (const question of [
    'What category is GianMarcoBellini earning the most money in?',
    'What category is BelliniGianMarco earning the most money in?',
    'What category is Gian\u200BMarco earning the most money in?',
    'What category is Gian-Marco earning the most money in?',
    'What category is ＧｉａｎＭａｒｃｏ earning the most money in?',
    'What category is Gian[student-001]MarcoBellini earning the most money in?',
  ]) {
    await assert.rejects(
      loader()({
        teacherUid: 'teacher-a',
        classroomId: 'class-a',
        periodDays: 30,
        timeZone: 'America/Denver',
        question,
      }),
      error => error instanceof InsightQuestionEvidenceError &&
        error.category === 'evidence-not-deidentified',
    )
  }

  const shortTokenRoster = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Kim Van Lee',
    },
  })
  for (const question of [
    'What is KimVan earning?',
    'What is VanLee earning?',
    'What is KimLee earning?',
    'What is LeeKim earning?',
    'What is LeeVanKim earning?',
  ]) {
    await assert.rejects(
      loader(shortTokenRoster)({
        teacherUid: 'teacher-a',
        classroomId: 'class-a',
        periodDays: 30,
        timeZone: 'America/Denver',
        question,
      }),
      error => error instanceof InsightQuestionEvidenceError &&
        error.category === 'evidence-not-deidentified',
    )
  }

  const multiTokenRoster = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Ana Maria Lopez Cruz',
    },
  })
  for (const question of [
    'What is MariaCruz earning?',
    'What is AnaLopez earning?',
    'What is CruzAnaMaria earning?',
  ]) {
    await assert.rejects(
      loader(multiTokenRoster)({
        teacherUid: 'teacher-a',
        classroomId: 'class-a',
        periodDays: 30,
        timeZone: 'America/Denver',
        question,
      }),
      error => error instanceof InsightQuestionEvidenceError &&
      error.category === 'evidence-not-deidentified',
    )
  }

  const initialRoster = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Mark A Chen',
    },
  })
  for (const question of [
    'What is MarkA earning?',
    'What is AChen earning?',
    'What is ChenAMark earning?',
  ]) {
    await assert.rejects(
      loader(initialRoster)({
        teacherUid: 'teacher-a',
        classroomId: 'class-a',
        periodDays: 30,
        timeZone: 'America/Denver',
        question,
      }),
      error => error instanceof InsightQuestionEvidenceError &&
        error.category === 'evidence-not-deidentified',
    )
  }
})

test('ordinary words containing a roster-name substring remain valid questions', async () => {
  const commonSubstringRoster = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Mark A Chen',
    },
  })
  for (const question of [
    'What is a benchmark total this week?',
    'How much did the kitchen job pay out?',
    'Were remarks or chenille supplies approved?',
    'What was earmarked for supplies?',
    'Is A the top earner?',
  ]) {
    const result = await loader(commonSubstringRoster)({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question,
    })
    assert.equal(result.providerInput.question, question)
    assert.deepEqual(result.providerInput.subjectAliases, [])
  }
})

test('reads only the active reciprocal tenant and bounds the period server-side', async () => {
  const fake = createFirestoreDouble(fixture({
    'classrooms/class-a/transactions/102': {
      ...fixture()['classrooms/class-a/transactions/101'],
      id: 102,
      date: '2026-06-01T16:00:00.000Z',
    },
  }))
  const load = createFirestoreQuestionEvidenceLoader({ firestore: fake.firestore, now: () => NOW })
  const envelope = await load({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'What time are students losing the most money?',
  })
  assert.equal(envelope.answerEvidence.transactions.length, 1)
  assert.deepEqual(fake.reads, [
    'teachers/teacher-a',
    'classrooms/class-a',
    'classrooms/class-a/students|limit=501',
    'classrooms/class-a/transactions|limit=20001',
  ])
})

test('ambiguous names and likely contact details fail before provider input exists', async () => {
  const ambiguous = fixture({
    'classrooms/class-a/students/3': {
      id: 3,
      name: 'GianMarco Smith',
      balance: 5,
      frozen: false,
      transactions: [],
    },
  })
  await assert.rejects(
    loader(ambiguous)({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question: 'What is GianMarco earning?',
    }),
    error => error instanceof InsightQuestionEvidenceError && error.category === 'question-ambiguous',
  )
  await assert.rejects(
    loader()({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question: 'Email the answer to teacher@example.com',
    }),
    error => error instanceof InsightQuestionEvidenceError && error.category === 'question-sensitive',
  )
})
