import assert from 'node:assert/strict'
import test from 'node:test'

import { buildClassInsightsReport } from '../../src/insights/classInsights.js'
import {
  TenantEvidenceAdapterError,
  createFirestoreTenantEvidenceLoader,
} from './tenantEvidenceAdapter.js'

const NOW = new Date('2026-08-16T18:00:00.000Z')

function transaction(overrides = {}) {
  return {
    id: 101,
    date: '2026-08-15T16:30:00.000Z',
    studentId: 1,
    studentName: 'May',
    type: 'Add',
    amount: 25,
    reason: 'Paid Jordan Reyes back',
    memo: '',
    category: '',
    status: 'Pending',
    source: 'Student',
    ...overrides,
  }
}

function fixture(overrides = {}) {
  return {
    'teachers/teacher-a': {
      uid: 'teacher-a',
      status: 'active',
      classroomId: 'class-a',
      displayName: 'Teacher A',
    },
    'classrooms/class-a': { ownerUid: 'teacher-a', version: 1 },
    'classrooms/class-a/students/1': {
      id: 1,
      name: 'May',
      balance: 45,
      frozen: false,
      transactions: [],
    },
    'classrooms/class-a/students/2': {
      id: 2,
      name: 'Jordan Reyes',
      balance: 25,
      frozen: false,
      transactions: [],
    },
    'classrooms/class-a/transactions/101': transaction(),
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
      collection(name) {
        return query(`${path}/${name}`)
      },
    }
  }
  function query(path) {
    return {
      path,
      kind: 'query',
      limitCount: null,
      doc(id) {
        return document(`${path}/${id}`)
      },
      limit(count) {
        return { ...this, limitCount: count }
      },
    }
  }
  function snapshot(path) {
    const exists = store.has(path)
    return { exists, id: path.split('/').at(-1), data: () => store.get(path) }
  }
  return {
    store,
    reads,
    firestore: {
      collection(name) {
        return query(name)
      },
      async runTransaction(callback) {
        return callback({
          async get(reference) {
            reads.push(reference.kind === 'query'
              ? `${reference.path}|limit=${reference.limitCount}`
              : reference.path)
            if (reference.kind === 'query') {
              const prefix = `${reference.path}/`
              const docs = [...store.keys()]
                .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
                .sort()
                .map(snapshot)
                .slice(0, reference.limitCount ?? undefined)
              return { size: docs.length, docs }
            }
            return snapshot(reference.path)
          },
        })
      },
    },
  }
}

test('loads one tenant transactionally and removes identities and raw reasons', async () => {
  const fake = createFirestoreDouble(fixture())
  const calculatorInputs = []
  const load = createFirestoreTenantEvidenceLoader({
    firestore: fake.firestore,
    calculateReport(input) {
      calculatorInputs.push(input)
      return buildClassInsightsReport(input)
    },
    now: () => NOW,
  })
  const envelope = await load({ teacherUid: 'teacher-a', classroomId: 'class-a', periodDays: 30 })

  assert.equal(calculatorInputs.length, 2)
  assert.deepEqual(calculatorInputs[0].students.map(student => student.name), [
    'A student',
    'A student',
  ])
  assert.deepEqual(calculatorInputs[0].transactions.map(item => item.studentName), [
    'A student',
  ])
  assert.deepEqual(calculatorInputs[1].students.map(student => student.name), [
    'May',
    'Jordan Reyes',
  ])
  assert.deepEqual(calculatorInputs[1].transactions.map(item => item.studentName), [
    'May',
  ])
  assert.match(envelope.evidenceSignature, /^[a-f0-9]{64}$/)
  assert.ok(envelope.sensitiveValues.length >= 6)
  assert.ok(envelope.sensitiveValues.some(item => item.kind === 'student-name' && item.value === 'May'))
  assert.ok(envelope.sensitiveValues.some(item => item.kind === 'student-id' && item.value === '1'))
  const serializedEvidence = JSON.stringify(envelope.analysisEvidence)
  for (const forbidden of [
    'teacher-a',
    'class-a',
    'May',
    'Jordan Reyes',
    'Paid Jordan Reyes back',
    '101',
  ]) {
    assert.doesNotMatch(serializedEvidence, new RegExp(forbidden, 'i'))
  }
  const serializedDisplay = JSON.stringify(envelope.displayEvidence)
  assert.match(serializedDisplay, /May|Jordan Reyes/)
  assert.match(serializedDisplay, /Paid Jordan Reyes back/)
  assert.equal(
    envelope.analysisEvidence.observations.length,
    envelope.displayEvidence.observations.length,
  )
  assert.deepEqual(
    envelope.analysisEvidence.observations.map(({ priority, category, title }) => ({
      priority, category, title,
    })),
    envelope.displayEvidence.observations.map(({ priority, category, title }) => ({
      priority, category, title,
    })),
  )
  assert.deepEqual(fake.reads, [
    'teachers/teacher-a',
    'classrooms/class-a',
    'classrooms/class-a/students|limit=501',
    'classrooms/class-a/transactions|limit=20001',
  ])
})

test('the signature is stable across read order and changes with relevant evidence', async () => {
  const loadFrom = async data => createFirestoreTenantEvidenceLoader({
    firestore: createFirestoreDouble(data).firestore,
    calculateReport: buildClassInsightsReport,
    now: () => NOW,
  })({ teacherUid: 'teacher-a', classroomId: 'class-a', periodDays: 30 })

  const original = await loadFrom(fixture())
  const reordered = await loadFrom(Object.fromEntries(Object.entries(fixture()).reverse()))
  const changed = await loadFrom(fixture({
    'classrooms/class-a/transactions/101': transaction({ amount: 26 }),
  }))
  assert.equal(original.evidenceSignature, reordered.evidenceSignature)
  assert.notEqual(original.evidenceSignature, changed.evidenceSignature)
})

test('a broken reciprocal foundation fails before any classroom collection read', async () => {
  const fake = createFirestoreDouble(fixture({
    'classrooms/class-a': { ownerUid: 'teacher-b', version: 1 },
  }))
  const load = createFirestoreTenantEvidenceLoader({
    firestore: fake.firestore,
    calculateReport: buildClassInsightsReport,
    now: () => NOW,
  })
  await assert.rejects(
    load({ teacherUid: 'teacher-a', classroomId: 'class-a', periodDays: 30 }),
    error => error instanceof TenantEvidenceAdapterError && error.category === 'tenant-invalid',
  )
  assert.deepEqual(fake.reads, ['teachers/teacher-a', 'classrooms/class-a'])
})

test('bounded query overflow fails before the deterministic calculator runs', async () => {
  const oversized = fixture()
  for (let id = 3; id <= 501; id += 1) {
    oversized[`classrooms/class-a/students/${id}`] = {
      id,
      name: `Student ${id}`,
      balance: 1,
      frozen: false,
      transactions: [],
    }
  }
  let calculatorCalls = 0
  const load = createFirestoreTenantEvidenceLoader({
    firestore: createFirestoreDouble(oversized).firestore,
    calculateReport() {
      calculatorCalls += 1
      return {}
    },
    now: () => NOW,
  })
  await assert.rejects(
    load({ teacherUid: 'teacher-a', classroomId: 'class-a', periodDays: 30 }),
    error => error instanceof TenantEvidenceAdapterError && error.category === 'evidence-too-large',
  )
  assert.equal(calculatorCalls, 0)
})

test('misaligned provider and display reports fail closed', async () => {
  let calls = 0
  const load = createFirestoreTenantEvidenceLoader({
    firestore: createFirestoreDouble(fixture()).firestore,
    calculateReport(input) {
      calls += 1
      const report = buildClassInsightsReport(input)
      if (calls === 2) {
        return {
          ...report,
          observations: [
            { ...report.observations[0], title: 'Mismatched title' },
            ...report.observations.slice(1),
          ],
        }
      }
      return report
    },
    now: () => NOW,
  })
  await assert.rejects(
    load({ teacherUid: 'teacher-a', classroomId: 'class-a', periodDays: 30 }),
    error => error instanceof TenantEvidenceAdapterError && error.category === 'calculator-invalid',
  )
})

test('paired reports stay aligned across every deterministic observation generator', async () => {
  const comprehensive = fixture({
    'classrooms/class-a/students/1': {
      id: 1,
      name: 'Jordan Reyes',
      balance: -10,
      frozen: false,
      transactions: [],
    },
    'classrooms/class-a/students/2': {
      id: 2,
      name: 'May',
      balance: 40,
      frozen: false,
      transactions: [],
    },
    'classrooms/class-a/students/3': {
      id: 3,
      name: 'Avery Example',
      balance: 100,
      frozen: false,
      transactions: [],
    },
    'classrooms/class-a/transactions/101': transaction({
      id: 101,
      studentId: 1,
      studentName: 'Jordan Reyes',
      amount: 25,
      reason: 'Robotics reward',
    }),
    'classrooms/class-a/transactions/102': transaction({
      id: 102,
      studentId: 2,
      studentName: 'May',
      amount: 5,
      reason: 'Repeated reward',
      date: '2026-08-15T16:31:00.000Z',
    }),
    'classrooms/class-a/transactions/103': transaction({
      id: 103,
      studentId: 2,
      studentName: 'May',
      amount: 5,
      reason: 'Repeated reward',
      date: '2026-08-15T16:32:00.000Z',
    }),
    'classrooms/class-a/transactions/104': transaction({
      id: 104,
      studentId: 2,
      studentName: 'May',
      amount: 5,
      reason: 'Repeated reward',
      date: '2026-08-15T16:33:00.000Z',
    }),
    'classrooms/class-a/transactions/105': transaction({
      id: 105,
      studentId: 3,
      studentName: 'Avery Example',
      type: 'Subtract',
      amount: 6,
      reason: 'Morning store',
      status: 'Approved',
      source: 'Teacher',
      date: '2026-08-15T15:00:00.000Z',
    }),
    'classrooms/class-a/transactions/106': transaction({
      id: 106,
      studentId: 3,
      studentName: 'Avery Example',
      type: 'Subtract',
      amount: 7,
      reason: 'Morning store',
      status: 'Approved',
      source: 'Teacher',
      date: '2026-08-15T15:10:00.000Z',
    }),
    'classrooms/class-a/transactions/107': transaction({
      id: 107,
      studentId: 2,
      studentName: 'May',
      amount: 8,
      reason: 'Afternoon work',
      status: 'Approved',
      source: 'Teacher',
      date: '2026-08-15T21:00:00.000Z',
    }),
    'classrooms/class-a/transactions/108': transaction({
      id: 108,
      studentId: 2,
      studentName: 'May',
      amount: 9,
      reason: 'Afternoon work',
      status: 'Approved',
      source: 'Teacher',
      date: '2026-08-15T21:10:00.000Z',
    }),
  })
  const load = createFirestoreTenantEvidenceLoader({
    firestore: createFirestoreDouble(comprehensive).firestore,
    calculateReport: buildClassInsightsReport,
    now: () => NOW,
  })
  const envelope = await load({
    teacherUid: 'teacher-a',
    classroomId: 'class-a',
    periodDays: 30,
  })
  const titles = envelope.analysisEvidence.observations.map(item => item.title)
  for (const expected of [
    /Add Money request meets review threshold/,
    /Repeated student request/,
    /Negative current balance/,
    /Balance well above the class midpoint/,
    /pending requests/,
    /Class cash/,
  ]) {
    assert.ok(titles.some(title => expected.test(title)), `missing ${expected}`)
  }
  assert.equal(
    envelope.analysisEvidence.observations.some(item => item.category === 'Timing patterns'),
    false,
  )
  assert.equal(
    envelope.displayEvidence.observations.some(item => item.category === 'Timing patterns'),
    false,
  )
  assert.deepEqual(
    envelope.analysisEvidence.observations.map(({ priority, category, title }) => ({
      priority, category, title,
    })),
    envelope.displayEvidence.observations.map(({ priority, category, title }) => ({
      priority, category, title,
    })),
  )
})
