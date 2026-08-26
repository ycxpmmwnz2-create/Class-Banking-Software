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
    'classrooms/class-a/studentDisplay/rent': {
      rentAmount: 10,
      updatedAt: '2026-08-20T17:00:00.000Z',
    },
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
    assert.equal(envelope.providerInput.schemaVersion, 7)
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
    assert.equal(envelope.answerEvidence.configuredRentAmount, 10)
    assert.equal(Object.hasOwn(envelope.providerInput, 'configuredRentAmount'), false)
    assert.equal(envelope.answerEvidence.asOfDate, '2026-08-20')
    assert.match(envelope.evidenceSignature, /^[a-f0-9]{64}$/)
  }
})

test('safe student aliases do not collide with an unrelated roster name token', async () => {
  const data = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Maribel Rivera',
    },
    'classrooms/class-a/students/2': {
      ...fixture()['classrooms/class-a/students/2'],
      name: 'Test Student',
    },
  })
  const envelope = await loader(data)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Did Maribel submit technology yesterday to add to her account? Or just today?',
  })

  assert.deepEqual(envelope.providerInput.subjectAliases, ['student-001'])
  assert.deepEqual(envelope.providerInput.subjectHints, [])
  assert.match(envelope.providerInput.question, /\[student-001\]/)
  assert.doesNotMatch(JSON.stringify(envelope.providerInput), /Maribel|Rivera|Test Student/)
})

test('category words that overlap an unrelated roster name stay available to the question planner', async () => {
  const data = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Avery Parker',
    },
    'classrooms/class-a/students/2': {
      ...fixture()['classrooms/class-a/students/2'],
      name: 'Taylor Technology',
    },
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      studentName: 'Avery Parker',
      category: 'Technology supplies',
      reason: 'Technology supplies',
    },
  })
  const envelope = await loader(data)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Has Avery been paid yesterday and today for technology?',
  })

  assert.deepEqual(envelope.providerInput.subjectAliases, ['student-001', 'student-002'])
  assert.deepEqual(envelope.providerInput.subjectHints, [{
    text: 'technology',
    studentAlias: 'student-002',
  }])
  assert.equal(
    envelope.providerInput.question,
    'Has [student-001] been paid yesterday and today for technology?',
  )
  assert.deepEqual(envelope.providerInput.categoryCatalog, [{
    alias: 'category-001',
    label: 'Technology supplies',
    transactionTypes: ['Add'],
  }])
  assert.doesNotMatch(JSON.stringify(envelope.providerInput), /Avery|Parker|Taylor/)

  for (const question of [
    'How much technology did the class buy?',
    'Which technology charges are pending?',
    'Show technology totals by week.',
  ]) {
    const categoryResult = await loader(data)({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question,
    })
    assert.equal(categoryResult.providerInput.question, question)
    assert.deepEqual(categoryResult.providerInput.subjectAliases, ['student-002'])
    assert.deepEqual(categoryResult.providerInput.subjectHints, [{
      text: 'technology',
      studentAlias: 'student-002',
    }])
  }
})

test('collision handling applies across category phrases, shared name tokens, and mixed name styles', async () => {
  const mixedNames = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Rose Garden',
    },
    'classrooms/class-a/students/2': {
      ...fixture()['classrooms/class-a/students/2'],
      name: 'Sofia Reyes',
    },
  })
  for (const question of [
    'Compare Sofia Reyes and Rose by current balance.',
    'Compare Rose and Sofia Reyes by current balance.',
  ]) {
    const result = await loader(mixedNames)({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question,
    })
    assert.deepEqual(result.providerInput.subjectAliases, ['student-001', 'student-002'])
    assert.doesNotMatch(JSON.stringify(result.providerInput), /Rose|Sofia|Reyes/)
  }

  const shortName = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'An Vu',
    },
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      studentName: 'An Vu',
    },
  })
  const reconstructed = await loader(shortName)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Did An T Vu earn money?',
  })
  assert.deepEqual(reconstructed.providerInput.subjectAliases, ['student-001'])
  assert.doesNotMatch(JSON.stringify(reconstructed.providerInput), /\bAn\b|\bVu\b/)

  const sharedToken = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Grace Liu',
    },
    'classrooms/class-a/students/2': {
      ...fixture()['classrooms/class-a/students/2'],
      name: 'Mia Grace',
    },
  })
  const ordinaryQuestion = 'Did anyone receive a grace period bonus this week?'
  const ordinary = await loader(sharedToken)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: ordinaryQuestion,
  })
  assert.equal(ordinary.providerInput.question, ordinaryQuestion)
  assert.deepEqual(ordinary.providerInput.subjectAliases, [])
  for (const question of [
    'Has grace been given to late payments?',
    'Did grace apply to anyone this week?',
  ]) {
    const result = await loader(sharedToken)({
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

test('a category catalog token is exempt only when its provider-visible phrase is in the question', async () => {
  const data = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Grace Liu',
    },
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      studentName: 'Grace Liu',
      category: 'Grace period fee',
      reason: 'Grace period fee',
    },
  })
  const studentQuestion = await loader(data)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'How much has Grace earned this month?',
  })
  assert.deepEqual(studentQuestion.providerInput.subjectAliases, ['student-001'])
  assert.deepEqual(studentQuestion.providerInput.subjectHints, [])
  assert.match(studentQuestion.providerInput.question, /\[student-001\]/)

  const contextualStudentQuestion = await loader(data)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Which category does Grace use most?',
  })
  assert.equal(contextualStudentQuestion.providerInput.question, 'Which category does Grace use most?')
  assert.deepEqual(contextualStudentQuestion.providerInput.subjectAliases, ['student-001'])
  assert.deepEqual(contextualStudentQuestion.providerInput.subjectHints, [{
    text: 'grace',
    studentAlias: 'student-001',
  }])

  const neutralizedCategory = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Grace Liu',
    },
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      studentName: 'Grace Liu',
      category: 'Grace Liu award',
      reason: 'Grace Liu award',
    },
  })
  const neutralizedResult = await loader(neutralizedCategory)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'How much has Grace earned this month?',
  })
  assert.deepEqual(neutralizedResult.providerInput.subjectAliases, ['student-001'])
  assert.match(neutralizedResult.providerInput.question, /\[student-001\]/)
  assert.doesNotMatch(JSON.stringify(neutralizedResult.providerInput.categoryCatalog), /Grace|Liu/)
})

test('single-token identities and reconstructed multi-part identities never become subject hints', async () => {
  const singleToken = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Grace',
    },
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      studentName: 'Grace',
      category: 'Grace period fee',
      reason: 'Grace period fee',
    },
  })
  const singleResult = await loader(singleToken)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'How much has Grace earned?',
  })
  assert.deepEqual(singleResult.providerInput.subjectAliases, ['student-001'])
  assert.deepEqual(singleResult.providerInput.subjectHints, [])
  assert.match(singleResult.providerInput.question, /\[student-001\]/)
  assert.doesNotMatch(JSON.stringify(singleResult.providerInput.categoryCatalog), /Grace/)

  const reconstructed = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Rose Garden',
    },
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      studentName: 'Rose Garden',
      category: 'Rose',
      reason: 'Garden',
    },
  })
  const reconstructedResult = await loader(reconstructed)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'How much was spent on rose and on garden?',
  })
  assert.deepEqual(reconstructedResult.providerInput.subjectAliases, ['student-001'])
  assert.deepEqual(reconstructedResult.providerInput.subjectHints, [])
  assert.doesNotMatch(reconstructedResult.providerInput.question, /rose|garden/i)
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

test('classifies a renamed rent-like category without exposing the configured rent amount', async () => {
  const base = fixture()['classrooms/class-a/transactions/101']
  const envelope = await loader(fixture({
    'classrooms/class-a/transactions/101': {
      ...base,
      date: '2026-08-20T16:00:00.000Z',
      type: 'Subtract',
      amount: 10,
      reason: 'Monthly payment',
      category: 'Monthly Class Rent',
    },
  }))({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Which students did not pay rent today?',
  })
  assert.equal(envelope.answerEvidence.transactions[0].purpose, 'rent')
  assert.equal(envelope.answerEvidence.configuredRentAmount, 10)
  assert.doesNotMatch(JSON.stringify(envelope.providerInput), /configuredRentAmount|rentAmount|\$10|teacher-a|class-a/)
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

test('binds the configured rent amount into server evidence and replay identity', async () => {
  const input = {
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'Which students did not pay rent today?',
  }
  const first = await loader(fixture())(input)
  const changed = await loader(fixture({
    'classrooms/class-a/studentDisplay/rent': {
      rentAmount: 15,
      updatedAt: '2026-08-20T17:30:00.000Z',
    },
  }))(input)
  assert.equal(first.answerEvidence.configuredRentAmount, 10)
  assert.equal(changed.answerEvidence.configuredRentAmount, 15)
  assert.notEqual(first.evidenceSignature, changed.evidenceSignature)
  assert.deepEqual(first.providerInput, changed.providerInput)
  await assert.rejects(
    loader(fixture({
      'classrooms/class-a/studentDisplay/rent': {
        rentAmount: 10.5,
        updatedAt: '2026-08-20T17:30:00.000Z',
      },
    }))(input),
    error => error instanceof InsightQuestionEvidenceError && error.category === 'evidence-malformed',
  )
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
  assert.match(providerText, /Restricted label 001/)
  assert.match(providerText, /Restricted label 003/)
  assert.match(providerText, /Restricted label 004/)
  assert.doesNotMatch(providerText, /Grace period fee|2026 08 21|teacher@example\.com|Private category 001/)
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

  const normalizedCompatibilityName = await loader()({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: 'What category is ＧｉａｎＭａｒｃｏ earning the most money in?',
  })
  assert.match(normalizedCompatibilityName.providerInput.question, /\[student-001\]/)
  assert.doesNotMatch(JSON.stringify(normalizedCompatibilityName.providerInput), /GianMarco|ＧｉａｎＭａｒｃｏ/)

  for (const question of [
    'What category is Gian[student-001]MarcoBellini earning the most money in?',
    'What did [ category-001] students earn?',
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
        error.category === 'question-sensitive',
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

  const singleTokenRoster = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Alan',
    },
  })
  const balanceQuestion = 'List for me each student and their current balance'
  const balanceResult = await loader(singleTokenRoster)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
    timeZone: 'America/Denver',
    question: balanceQuestion,
  })
  assert.equal(balanceResult.providerInput.question, balanceQuestion)
  assert.deepEqual(balanceResult.providerInput.subjectAliases, [])
})

test('reads only the active reciprocal tenant and retains at most 90 days for flexible questions', async () => {
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
  assert.equal(envelope.answerEvidence.transactions.length, 2)
  assert.deepEqual(fake.reads, [
    'teachers/teacher-a',
    'classrooms/class-a',
    'classrooms/class-a/studentDisplay/rent',
    'classrooms/class-a/students|limit=501',
    'classrooms/class-a/transactions|limit=20001',
  ])
})

test('loads the full current local week across fall-back DST while recording the rolling cutoff', async () => {
  const currentTime = new Date('2026-11-02T06:30:00.000Z')
  const data = fixture({
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      date: '2026-10-26T06:20:00.000Z',
      category: 'Technology',
      reason: 'Technology',
    },
  })
  const envelope = await loader(data, currentTime)({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 7,
    timeZone: 'America/Denver',
    question: 'Were there Technology credits this week?',
  })

  assert.equal(envelope.answerEvidence.asOfDate, '2026-11-01')
  assert.equal(envelope.answerEvidence.periodStart, '2026-10-26T06:30:00.000Z')
  assert.equal(envelope.answerEvidence.transactions.length, 1)
  assert.equal(envelope.answerEvidence.transactions[0].date, '2026-10-26T06:20:00.000Z')
})

test('changes replay identity when the rolling cutoff crosses a retained current-week transaction', async () => {
  const data = fixture({
    'classrooms/class-a/transactions/101': {
      ...fixture()['classrooms/class-a/transactions/101'],
      date: '2026-10-26T06:20:00.000Z',
    },
  })
  const request = {
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 7,
    timeZone: 'America/Denver',
    question: 'Were there Class job credits this week?',
  }
  const before = await loader(data, new Date('2026-11-02T06:15:00.000Z'))(request)
  const stable = await loader(data, new Date('2026-11-02T06:16:00.000Z'))(request)
  const after = await loader(data, new Date('2026-11-02T06:30:00.000Z'))(request)

  assert.equal(before.answerEvidence.transactions.length, 1)
  assert.equal(stable.answerEvidence.transactions.length, 1)
  assert.equal(after.answerEvidence.transactions.length, 1)
  assert.equal(before.evidenceSignature, stable.evidenceSignature)
  assert.notEqual(before.evidenceSignature, after.evidenceSignature)
})

test('shared partial student subjects request a full name while duplicate full names and contact details fail', async () => {
  const sharedPartial = fixture({
    'classrooms/class-a/students/3': {
      id: 3,
      name: 'GianMarco Smith',
      balance: 5,
      frozen: false,
      transactions: [],
    },
  })
  await assert.rejects(
    loader(sharedPartial)({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question: 'What is GianMarco earning?',
    }),
    error => error instanceof InsightQuestionEvidenceError && error.category === 'question-ambiguous',
  )

  const sharedSubject = fixture({
    'classrooms/class-a/students/1': {
      ...fixture()['classrooms/class-a/students/1'],
      name: 'Grace Liu',
    },
    'classrooms/class-a/students/2': {
      ...fixture()['classrooms/class-a/students/2'],
      name: 'Mia Grace',
    },
  })
  await assert.rejects(
    loader(sharedSubject)({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question: 'How much has Grace earned?',
    }),
    error => error instanceof InsightQuestionEvidenceError && error.category === 'question-ambiguous',
  )

  const duplicateFullName = fixture({
    'classrooms/class-a/students/3': {
      id: 3,
      name: 'GianMarco Bellini',
      balance: 5,
      frozen: false,
      transactions: [],
    },
  })
  await assert.rejects(
    loader(duplicateFullName)({
      teacherUid: 'teacher-a',
      classroomId: 'class-a',
      periodDays: 30,
      timeZone: 'America/Denver',
      question: 'What is GianMarco Bellini earning?',
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
