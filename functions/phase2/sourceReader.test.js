import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SOURCE_PAGE_SIZE,
  LEGACY_SOURCE_PATHS,
  readLegacySources,
  SOURCE_READER_ERROR_CATEGORIES,
  SourceReaderError,
} from './sourceReader.js'

function compareDocumentIds(left, right) {
  if (left.id < right.id) {
    return -1
  }

  if (left.id > right.id) {
    return 1
  }

  return 0
}

function createDocumentSnapshot(path, entry) {
  const id = path.split('/').at(-1)

  if (entry === undefined) {
    return {
      exists: false,
      id,
      ref: { path },
      data() {
        throw new Error('data() must not be called for a missing document.')
      },
    }
  }

  return {
    exists: true,
    id,
    ref: { path },
    updateTime: entry.updateTime,
    data: () => entry.data,
  }
}

class FakeQuery {
  constructor(database, collectionPath, state = {}) {
    this.database = database
    this.collectionPath = collectionPath
    this.state = {
      cursorId: state.cursorId ?? null,
      documentIdOrdered: state.documentIdOrdered ?? false,
      limit: state.limit ?? null,
    }
  }

  clone(changes) {
    return new FakeQuery(this.database, this.collectionPath, {
      ...this.state,
      ...changes,
    })
  }

  orderBy(fieldPath) {
    if (String(fieldPath) !== '__name__') {
      throw new Error('The fake accepts only explicit document-ID ordering.')
    }

    return this.clone({ documentIdOrdered: true })
  }

  startAfter(snapshot) {
    if (!this.state.documentIdOrdered || snapshot?.exists !== true) {
      throw new Error('startAfter requires an ordered document cursor.')
    }

    return this.clone({ cursorId: snapshot.id })
  }

  limit(pageSize) {
    return this.clone({ limit: pageSize })
  }

  add() {
    return this.database.recordWrite('add')
  }

  async get() {
    if (!this.state.documentIdOrdered || this.state.limit === null) {
      throw new Error('Every fake collection read must be ordered and limited.')
    }

    const records = [...this.database.collectionRecords(this.collectionPath)]
      .sort(compareDocumentIds)
    const cursorIndex = this.state.cursorId === null
      ? -1
      : records.findIndex(record => record.id === this.state.cursorId)

    if (this.state.cursorId !== null && cursorIndex === -1) {
      throw new Error(`Unknown cursor ${this.state.cursorId}.`)
    }

    const page = records.slice(
      cursorIndex + 1,
      cursorIndex + 1 + this.state.limit,
    )
    const docs = page.map(record => createDocumentSnapshot(
      `${this.collectionPath}/${record.id}`,
      record,
    ))

    this.database.reads.push({
      type: 'query',
      path: this.collectionPath,
      documentIdOrdered: this.state.documentIdOrdered,
      pageSize: this.state.limit,
      startAfter: this.state.cursorId,
      returnedIds: docs.map(snapshot => snapshot.id),
    })

    return { docs }
  }
}

class FakeFirestore {
  constructor({ classroomData, studentCredentials = [], studentAuthLogs = [] }) {
    this.classroomData = classroomData
    this.collections = new Map([
      [LEGACY_SOURCE_PATHS.STUDENT_CREDENTIALS, studentCredentials],
      [LEGACY_SOURCE_PATHS.STUDENT_AUTH_LOGS, studentAuthLogs],
    ])
    this.reads = []
    this.writeAttempts = []
    this.documentReadError = null
  }

  collectionRecords(path) {
    const records = this.collections.get(path)
    if (!records) {
      throw new Error(`Unexpected collection path ${path}.`)
    }

    return records
  }

  recordWrite(operation) {
    this.writeAttempts.push(operation)
    throw new Error(`Unexpected Firestore write: ${operation}.`)
  }

  doc(path) {
    if (path !== LEGACY_SOURCE_PATHS.CLASSROOM_DATA) {
      throw new Error(`Unexpected document path ${path}.`)
    }

    return {
      get: async () => {
        this.reads.push({ type: 'document', path })

        if (this.documentReadError) {
          throw this.documentReadError
        }

        return createDocumentSnapshot(path, this.classroomData)
      },
      create: () => this.recordWrite('create'),
      delete: () => this.recordWrite('delete'),
      set: () => this.recordWrite('set'),
      update: () => this.recordWrite('update'),
    }
  }

  collection(path) {
    return new FakeQuery(this, path)
  }

  batch() {
    return this.recordWrite('batch')
  }

  bulkWriter() {
    return this.recordWrite('bulkWriter')
  }

  recursiveDelete() {
    return this.recordWrite('recursiveDelete')
  }

  runTransaction() {
    return this.recordWrite('runTransaction')
  }
}

function record(id, data, updateTime) {
  return { id, data, updateTime }
}

function assertSourceReaderError(code) {
  return error => {
    assert.ok(error instanceof SourceReaderError)
    assert.equal(error.code, 'PHASE2A_SOURCE_READER_ERROR')
    assert.equal(error.category, code)
    assert.equal(error.blocking, true)
    return true
  }
}

test('reads every legacy source in deterministic document-ID pages', async () => {
  const classroomData = {
    data: {
      students: [{ id: 1 }, { id: 2 }, { id: 3 }],
      transactions: [
        { id: 'transaction-1' },
        { id: 'transaction-2' },
        { id: 'transaction-3' },
      ],
      loginHistory: [
        { id: 'history-1' },
        { id: 'history-2' },
        { id: 'history-3' },
      ],
      settings: { weeklyAllowance: 5 },
    },
    updateTime: { token: 'classroom-update-time' },
  }
  const credentialA = record(
    'credential-a',
    { classroomId: 'morgan', pinHash: 'secret-a' },
    { token: 'credential-a-update-time' },
  )
  const credentialM = record(
    'credential-m',
    { classroomId: 'morgan', pinHash: 'secret-m' },
    { token: 'credential-m-update-time' },
  )
  const credentialZ = record(
    'credential-z',
    { classroomId: 'morgan', pinHash: 'secret-z' },
    { token: 'credential-z-update-time' },
  )
  const logA = record(
    'log-a',
    { loginId: 'a', success: false },
    { token: 'log-a-update-time' },
  )
  const logM = record(
    'log-m',
    { classroomId: 'morgan', loginId: 'm', success: true },
    { token: 'log-m-update-time' },
  )
  const logZ = record(
    'log-z',
    { futureUnknownField: true, loginId: 'z', success: false },
    { token: 'log-z-update-time' },
  )
  const firestore = new FakeFirestore({
    classroomData,
    studentCredentials: [credentialZ, credentialA, credentialM],
    studentAuthLogs: [logM, logZ, logA],
  })

  const result = await readLegacySources({ firestore, pageSize: 2 })

  assert.deepEqual(Object.keys(result), [
    'classroomData',
    'studentCredentials',
    'studentAuthLogs',
  ])
  assert.deepEqual(result.classroomData, {
    id: 'classroomData',
    path: LEGACY_SOURCE_PATHS.CLASSROOM_DATA,
    data: classroomData.data,
    updateTime: classroomData.updateTime,
  })
  assert.deepEqual(
    result.studentCredentials.map(document => document.id),
    ['credential-a', 'credential-m', 'credential-z'],
  )
  assert.deepEqual(
    result.studentAuthLogs.map(document => document.id),
    ['log-a', 'log-m', 'log-z'],
  )
  assert.deepEqual(result.studentCredentials[0], {
    id: credentialA.id,
    path: `studentCredentials/${credentialA.id}`,
    data: credentialA.data,
    updateTime: credentialA.updateTime,
  })
  assert.deepEqual(result.studentAuthLogs[2], {
    id: logZ.id,
    path: `studentAuthLogs/${logZ.id}`,
    data: logZ.data,
    updateTime: logZ.updateTime,
  })
  assert.strictEqual(result.classroomData.data, classroomData.data)
  assert.strictEqual(result.classroomData.updateTime, classroomData.updateTime)
  assert.equal(result.classroomData.data.students.length, 3)
  assert.equal(result.classroomData.data.transactions.length, 3)
  assert.equal(result.classroomData.data.loginHistory.length, 3)
  assert.strictEqual(result.studentCredentials[0].data, credentialA.data)
  assert.strictEqual(
    result.studentCredentials[0].updateTime,
    credentialA.updateTime,
  )
  assert.deepEqual(firestore.reads, [
    { type: 'document', path: LEGACY_SOURCE_PATHS.CLASSROOM_DATA },
    {
      type: 'query',
      path: LEGACY_SOURCE_PATHS.STUDENT_CREDENTIALS,
      documentIdOrdered: true,
      pageSize: 2,
      startAfter: null,
      returnedIds: ['credential-a', 'credential-m'],
    },
    {
      type: 'query',
      path: LEGACY_SOURCE_PATHS.STUDENT_CREDENTIALS,
      documentIdOrdered: true,
      pageSize: 2,
      startAfter: 'credential-m',
      returnedIds: ['credential-z'],
    },
    {
      type: 'query',
      path: LEGACY_SOURCE_PATHS.STUDENT_AUTH_LOGS,
      documentIdOrdered: true,
      pageSize: 2,
      startAfter: null,
      returnedIds: ['log-a', 'log-m'],
    },
    {
      type: 'query',
      path: LEGACY_SOURCE_PATHS.STUDENT_AUTH_LOGS,
      documentIdOrdered: true,
      pageSize: 2,
      startAfter: 'log-m',
      returnedIds: ['log-z'],
    },
  ])
  assert.deepEqual(firestore.writeAttempts, [])
})

test('reads a final empty page at an exact page-size boundary', async () => {
  const credentials = [
    record('credential-b', { active: false }, { token: 'b' }),
    record(
      'credential-a',
      { active: true, classroomId: 'unexpected-source-id' },
      { token: 'a' },
    ),
  ]
  const logs = [
    record('log-d', { success: true }, { token: 'd' }),
    record('log-b', { success: true }, { token: 'b' }),
    record('log-c', { success: true }, { token: 'c' }),
    record('log-a', { success: true }, { token: 'a' }),
  ]
  const firestore = new FakeFirestore({
    studentCredentials: credentials,
    studentAuthLogs: logs,
  })

  const result = await readLegacySources({ firestore, pageSize: 2 })

  assert.deepEqual(
    result.studentCredentials.map(document => document.id),
    ['credential-a', 'credential-b'],
  )
  assert.equal(
    result.studentCredentials[0].data.classroomId,
    'unexpected-source-id',
  )
  assert.equal(
    Object.hasOwn(result.studentCredentials[1].data, 'classroomId'),
    false,
  )
  assert.deepEqual(
    result.studentAuthLogs.map(document => document.id),
    ['log-a', 'log-b', 'log-c', 'log-d'],
  )
  assert.deepEqual(
    firestore.reads
      .filter(read => read.type === 'query')
      .map(read => ({ path: read.path, ids: read.returnedIds })),
    [
      {
        path: LEGACY_SOURCE_PATHS.STUDENT_CREDENTIALS,
        ids: ['credential-a', 'credential-b'],
      },
      { path: LEGACY_SOURCE_PATHS.STUDENT_CREDENTIALS, ids: [] },
      {
        path: LEGACY_SOURCE_PATHS.STUDENT_AUTH_LOGS,
        ids: ['log-a', 'log-b'],
      },
      {
        path: LEGACY_SOURCE_PATHS.STUDENT_AUTH_LOGS,
        ids: ['log-c', 'log-d'],
      },
      { path: LEGACY_SOURCE_PATHS.STUDENT_AUTH_LOGS, ids: [] },
    ],
  )
  assert.deepEqual(firestore.writeAttempts, [])
})

test('returns null for a missing singleton and empty arrays for empty collections', async () => {
  const firestore = new FakeFirestore({})

  const result = await readLegacySources({ firestore })

  assert.equal(DEFAULT_SOURCE_PAGE_SIZE, 250)
  assert.deepEqual(result, {
    classroomData: null,
    studentCredentials: [],
    studentAuthLogs: [],
  })
  assert.deepEqual(
    firestore.reads.filter(read => read.type === 'query'),
    [
      {
        type: 'query',
        path: LEGACY_SOURCE_PATHS.STUDENT_CREDENTIALS,
        documentIdOrdered: true,
        pageSize: DEFAULT_SOURCE_PAGE_SIZE,
        startAfter: null,
        returnedIds: [],
      },
      {
        type: 'query',
        path: LEGACY_SOURCE_PATHS.STUDENT_AUTH_LOGS,
        documentIdOrdered: true,
        pageSize: DEFAULT_SOURCE_PAGE_SIZE,
        startAfter: null,
        returnedIds: [],
      },
    ],
  )
  assert.deepEqual(firestore.writeAttempts, [])
})

test('fails closed on invalid or unknown arguments before Firestore reads', async () => {
  for (const options of [undefined, null, [], 'options']) {
    await assert.rejects(
      readLegacySources(options),
      assertSourceReaderError(
        SOURCE_READER_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      ),
    )
  }

  for (const firestore of [undefined, null, {}, { doc() {} }]) {
    await assert.rejects(
      readLegacySources({ firestore }),
      assertSourceReaderError(
        SOURCE_READER_ERROR_CATEGORIES.INVALID_FIRESTORE,
      ),
    )
  }

  const firestore = new FakeFirestore({})
  for (const pageSize of [0, -1, 1.5, DEFAULT_SOURCE_PAGE_SIZE + 1,
    NaN, Infinity, '2', null]) {
    await assert.rejects(
      readLegacySources({ firestore, pageSize }),
      assertSourceReaderError(
        SOURCE_READER_ERROR_CATEGORIES.INVALID_PAGE_SIZE,
      ),
    )
  }

  await assert.rejects(
    readLegacySources({ firestore, unexpected: true }),
    assertSourceReaderError(SOURCE_READER_ERROR_CATEGORIES.UNKNOWN_ARGUMENT),
  )
  assert.deepEqual(firestore.reads, [])
  assert.deepEqual(firestore.writeAttempts, [])
})

test('propagates an injected Firestore read failure without attempting writes', async () => {
  const firestore = new FakeFirestore({})
  const readFailure = new Error('Firestore emulator read failed.')
  firestore.documentReadError = readFailure

  await assert.rejects(
    readLegacySources({ firestore, pageSize: 1 }),
    error => error === readFailure,
  )
  assert.deepEqual(firestore.reads, [
    { type: 'document', path: LEGACY_SOURCE_PATHS.CLASSROOM_DATA },
  ])
  assert.deepEqual(firestore.writeAttempts, [])
})
