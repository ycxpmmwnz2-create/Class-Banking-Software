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
      doc(id) {
        return document(`${path}/${id}`)
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
            reads.push(reference.path)
            if (reference.kind === 'query') {
              const prefix = `${reference.path}/`
              const docs = [...store.keys()]
                .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
                .sort()
                .map(snapshot)
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
  const load = createFirestoreTenantEvidenceLoader({
    firestore: fake.firestore,
    calculateReport: buildClassInsightsReport,
    now: () => NOW,
  })
  const envelope = await load({ teacherUid: 'teacher-a', classroomId: 'class-a', periodDays: 30 })

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
  assert.deepEqual(fake.reads, [
    'teachers/teacher-a',
    'classrooms/class-a',
    'classrooms/class-a/students',
    'classrooms/class-a/transactions',
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
