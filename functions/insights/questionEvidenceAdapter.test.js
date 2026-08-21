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

function loader(data = fixture()) {
  return createFirestoreQuestionEvidenceLoader({
    firestore: createFirestoreDouble(data).firestore,
    now: () => NOW,
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
    assert.match(envelope.providerInput.question, /\[student-001\]/)
    assert.doesNotMatch(JSON.stringify(envelope.providerInput), /GianMarco|Bellini|Sofia|Reyes|teacher-a|class-a/)
    assert.equal(envelope.answerEvidence.students[0].name, 'GianMarco Bellini')
    assert.match(envelope.evidenceSignature, /^[a-f0-9]{64}$/)
  }
})

test('separator-obscured roster names fail before provider input can be constructed', async () => {
  for (const question of [
    'What category is GianMarcoBellini earning the most money in?',
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
