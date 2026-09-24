import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import vm from 'node:vm'
import { HttpsError } from 'firebase-functions/v2/https'
import { assertMaintenanceAdmission } from './maintenanceMode.js'
import { assertV2GateAllowed, ALLOWED_PRODUCTION_PROJECT_ID } from './productionEnvironment.js'
import { extractExports, parseModule } from '../../tests/phase3/functionsExportInventory.js'
import { getClassroomAccessCallable } from './classroomAccess.js'
import { resolveTeacherTenantCallable, onboardTeacherClassroomCallable } from '../phase2b/teacherCallables.js'
import { createTeacherInvitationCallable } from '../phase2b/teacherInvitationAdmin.js'
import { hashEmailDigest } from '../phase2b/identityNormalization.js'
import { makeBalanceWitness, recordBalanceWitness } from '../insights/balanceHistoryLedger.js'
import { control } from '../../tests/phase3/classroomAccess.fixture.js'

const reads = ['getClassroomAccessV2', 'resolveTeacherTenantV2']
const blocked = ['onboardTeacherClassroomV2', 'createTeacherInvitationV2', 'revokeTeacherInvitationV2',
  'studentPinLoginV2', 'resetStudentPinV2', 'createStudentV2', 'removeStudentV2', 'listStudentPinsV2',
  'submitStudentTransactionV2', 'analyzeTeacherInsightsV3', 'syncStudentProfilesV2']
const auditOperation = 'recordStudentBalanceHistoryV3'
const operations = [...reads, ...blocked, auditOperation]
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const program = parseModule(source)
const auth = { uid: 'fictional-teacher', token: { email: 'fictional@example.com', email_verified: true,
  firebase: { sign_in_provider: 'google.com' } } }
const request = { auth, data: {} }

// Evaluate the actual index declarations and callback bodies with injected SDK
// factories/config/handles. No Admin initialization, environment access, network,
// SDK transaction or real trigger delivery. Imports are resolved explicitly here.
function runtime({ mode = 'verification', omitMode = false, database = {}, overrides = {}, environment,
  enabled = true, appCount = 1 } = {}) {
  const events = [], logs = [], params = {
    MULTI_TEACHER_V2_ENABLED: enabled,
    ...(!omitMode && { MULTI_TEACHER_V2_MAINTENANCE_MODE: mode }),
  }
  const valuesRead = []
  const define = (name, options = {}) => ({ value() {
    valuesRead.push(name)
    const value = Object.hasOwn(params, name) ? params[name] : options.default
    if (value instanceof Error) throw value
    return value
  } })
  const stubs = {}
  for (const node of program.body.filter(node => node.type === 'ImportDeclaration')) {
    for (const specifier of node.specifiers) {
      const name = specifier.local.name
      stubs[name] = (...args) => { events.push(name); return { stub: name, count: args.length } }
    }
  }
  const context = vm.createContext({ ...stubs,
    process: { env: environment ?? { GCLOUD_PROJECT: 'demo-morgan-bank-phase2b-server-test',
      FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' } },
    console: { warn: (...args) => logs.push(args) }, HttpsError,
    defineBoolean: define, defineString: define, defineSecret: define,
    projectID: { equals: () => ({ thenElse: () => 0 }) },
    getApps: () => Array.from({ length: appCount }, () => ({})),
    initializeApp: () => { events.push('initializeApp') },
    getFirestore: () => { events.push('getFirestore'); return database },
    getAuth: () => { events.push('getAuth'); return {} },
    onCall: (...args) => args.at(-1), onDocumentWritten: (...args) => args.at(-1),
    assertV2GateAllowed, assertMaintenanceAdmission, ALLOWED_PRODUCTION_PROJECT_ID,
    loadBalanceHistory: async () => ({ recordBalanceWitness: (event, options) => recordBalanceWitness(event, {
      ...options, warn: (...args) => logs.push(args),
    }) }),
    ...overrides,
  })
  const code = program.body.filter(node => node.type !== 'ImportDeclaration')
    .map(node => source.slice(node.type === 'ExportNamedDeclaration' ? node.declaration.start : node.start, node.end)).join('\n')
  // Replace only module loading with an injected real recorder; keep actual gate/callback body.
  const lazyImport = "import('./insights/balanceHistoryLedger.js')"
  assert.equal(code.split(lazyImport).length, 2)
  vm.runInContext(code.replace(lazyImport, 'loadBalanceHistory()'), context)
  const handlers = vm.runInContext(`({${operations.join(',')}, assertV2Invocation,
    studentPinLogin, resetStudentPin, ensureTeacherClassroom, syncStudentProfiles})`, context)
  return { handlers, events, logs, params, valuesRead }
}
const genericDenial = error => {
  assert.equal(error.code, 'failed-precondition')
  assert.equal(error.message, 'Multi-teacher V2 is disabled.')
  assert.equal(error.details, undefined)
  return true
}

test('maintenance route matrix is the exact current V2 callable/trigger inventory', () => {
  const legacy = ['studentPinLogin', 'resetStudentPin', 'ensureTeacherClassroom', 'syncStudentProfiles']
  const current = [...extractExports(source)].filter(([name, kind]) =>
    ['onCall', 'onDocumentWritten'].includes(kind) && !legacy.includes(name)).map(([name]) => name)
  assert.deepEqual(current.sort(), [...operations].sort())
  for (const operation of operations) {
    const node = program.body.find(node => node.type === 'ExportNamedDeclaration' &&
      node.declaration.declarations[0].id.name === operation)
    assert.ok(source.slice(node.start, node.end).includes(`assertV2Invocation('${operation}')`), operation)
  }
  const helperImport = program.body.find(node => node.type === 'ImportDeclaration' &&
    node.source.value === './phase3/maintenanceMode.js')
  assert.ok(helperImport?.specifiers.some(item => item.imported?.name === 'assertMaintenanceAdmission'))
})

test('exact maintenance policy permits only two verification reads; normal still rejects unknown operations', () => {
  for (const operation of operations) {
    assert.doesNotThrow(() => assertMaintenanceAdmission({ mode: 'normal', operation }))
    if (reads.includes(operation) || operation === auditOperation) assert.doesNotThrow(() => assertMaintenanceAdmission({ mode: 'verification', operation }))
    else assert.throws(() => assertMaintenanceAdmission({ mode: 'verification', operation }), /admission refused/)
    if (operation === auditOperation) assert.doesNotThrow(() => assertMaintenanceAdmission({ mode: 'closed', operation }))
    else assert.throws(() => assertMaintenanceAdmission({ mode: 'closed', operation }))
  }
  for (const operation of ['futureRoute', 'toString', '__proto__', '', undefined, null, {}]) {
    for (const mode of ['normal', 'verification']) assert.throws(() => assertMaintenanceAdmission({ mode, operation }))
  }
})

test('missing, malformed and unreadable mode fails closed in actual invocation gate without leaking values', () => {
  for (const mode of [undefined, null, '', 'NORMAL', ' normal', 'verification ', true, false, 1, {}, [],
    'PRIVATE-config', new Error('PRIVATE-config')]) {
    const r = runtime(); r.params.MULTI_TEACHER_V2_MAINTENANCE_MODE = mode
    for (const operation of operations) assert.throws(() => r.handlers.assertV2Invocation(operation), genericDenial)
    assert.deepEqual(r.events, [])
    assert.equal(JSON.stringify(r.logs).includes('PRIVATE'), false)
  }
})

test('actual parameter defaults closed and is not read during discovery', () => {
  const r = runtime({ omitMode: true })
  assert.deepEqual(r.valuesRead, [])
  for (const operation of [...reads, ...blocked]) assert.throws(() => r.handlers.assertV2Invocation(operation), genericDenial)
  assert.doesNotThrow(() => r.handlers.assertV2Invocation(auditOperation))
  assert.deepEqual(r.events, [])
})

for (const operation of blocked) {
  test(`actual ${operation} wrapper denies verification before handles, service, auth or provider access`, async () => {
    const r = runtime()
    await assert.rejects(r.handlers[operation](request), genericDenial)
    assert.deepEqual(r.events, [])
    assert.ok(!r.valuesRead.includes('GEMINI_API_KEY'))
    assert.equal(r.logs.length, 1)
    assert.equal(r.logs[0][1].category, 'maintenance-denied')
  })
}

test('global gate, project/release guard and Admin availability cannot be bypassed by normal or verification mode', () => {
  for (const mode of ['normal', 'verification', 'closed']) for (const options of [
    { enabled: false }, { enabled: 'true' }, { environment: {} },
    { environment: { GCLOUD_PROJECT: 'wrong-project' } },
    { environment: { GCLOUD_PROJECT: 'morgan-bank', MULTI_TEACHER_V2_RELEASE_ID: 'wrong-release' } },
    { appCount: 2 },
  ]) {
    const r = runtime({ mode, ...options })
    for (const operation of operations) assert.throws(() => r.handlers.assertV2Invocation(operation), genericDenial)
    assert.deepEqual(r.events, [])
  }
})

test('real runtime guard accepts canonical production/staging identity before applying verification restrictions', () => {
  for (const [project, tier] of [['morgan-bank', 'production'], ['morgan-bank-staging-test', 'staging']]) {
    const r = runtime({ environment: { GCLOUD_PROJECT: project,
      MULTI_TEACHER_V2_RELEASE_ID: 'student-money-functions-v3' } })
    r.params.MORGAN_BANK_DEPLOYMENT_TIER = tier
    r.params.MORGAN_BANK_STAGING_PROJECT_ID = tier === 'staging' ? project : ''
    for (const operation of reads) assert.doesNotThrow(() => r.handlers.assertV2Invocation(operation))
    for (const operation of blocked) assert.throws(() => r.handlers.assertV2Invocation(operation), genericDenial)
    assert.deepEqual(r.events, [])
  }
})

test('every new admission resamples mode: normal then verification then closed; denied trigger retry stays denied', async () => {
  const r = runtime({ mode: 'normal' })
  assert.doesNotThrow(() => r.handlers.assertV2Invocation('onboardTeacherClassroomV2'))
  r.params.MULTI_TEACHER_V2_MAINTENANCE_MODE = 'verification'
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(r.handlers.onboardTeacherClassroomV2(request), genericDenial)
    await assert.rejects(r.handlers.syncStudentProfilesV2(request), genericDenial)
  }
  assert.doesNotThrow(() => r.handlers.assertV2Invocation('getClassroomAccessV2'))
  r.params.MULTI_TEACHER_V2_MAINTENANCE_MODE = 'closed'
  assert.throws(() => r.handlers.assertV2Invocation('getClassroomAccessV2'), genericDenial)
  assert.deepEqual(r.events, [])
})

// Read fixture with actual service/callable logic. All mutations throw. This is
// synthetic storage, not Firestore isolation or deployed rules evidence.
function foundation(mode = 'readOnly') {
  const documents = {
    'teachers/teacher-b': { uid: 'teacher-b', status: 'active', classroomId: 'room-b' },
    'classrooms/room-b': { ownerUid: 'teacher-b', name: 'Fictional B', studentLoginCode: '2345-678A', accessControl: control({ mode, generation: 9 }) },
    'teachers/fictional-teacher': { uid: auth.uid, status: 'active', classroomId: 'room-a' },
    'classrooms/room-a': { ownerUid: auth.uid, name: 'Fictional', studentLoginCode: '2345-6789', accessControl: control({ mode, generation: 1 }) },
  }
  const accesses = []
  const snapshot = path => ({ exists: Object.hasOwn(documents, path), data: () => documents[path] })
  const doc = path => ({ path, async get() { accesses.push(path); return snapshot(path) } })
  const database = { doc, collection: name => ({ doc: id => doc(`${name}/${id}`) }),
    async runTransaction(callback) {
      return callback({ get: async ref => { accesses.push(ref.path); return snapshot(ref.path) },
        create() { assert.fail('No writes during verification') }, update() { assert.fail('No writes during verification') },
        set() { assert.fail('No writes during verification') }, delete() { assert.fail('No writes during verification') } })
    } }
  return { database, documents, accesses }
}

test('actual wrappers plus real read services preserve auth, tenant and control checks in verification', async () => {
  for (const mode of ['active', 'readOnly', 'suspended']) {
    const f = foundation(mode), before = globalThis.structuredClone(f.documents)
    const r = runtime({ database: f.database, overrides: { getClassroomAccessCallable, resolveTeacherTenantCallable } })
    for (const name of reads) {
      f.accesses.length = 0
      if (mode === 'suspended') await assert.rejects(r.handlers[name](request), { code: 'permission-denied' })
      else {
        const result = await r.handlers[name](request)
        assert.equal(result.mode, mode); assert.equal(result.generation, 1)
      }
      assert.ok(f.accesses.length > 0)
      assert.ok(f.accesses.every(path => ['teachers/fictional-teacher', 'classrooms/room-a'].includes(path)))
      f.accesses.length = 0
      const teacherB = { auth: { uid: 'teacher-b', token: {} }, data: {} }
      if (mode === 'suspended') await assert.rejects(r.handlers[name](teacherB), { code: 'permission-denied' })
      else { const result = await r.handlers[name](teacherB); assert.equal(result.generation, 9) }
      assert.ok(f.accesses.length > 0)
      assert.ok(f.accesses.every(path => ['teachers/teacher-b', 'classrooms/room-b'].includes(path)))
      f.accesses.length = 0
      await assert.rejects(r.handlers[name]({ data: {} }), { code: 'unauthenticated' })
      assert.deepEqual(f.accesses, [])
      await assert.rejects(r.handlers[name]({ auth: { uid: 'missing-teacher', token: {} }, data: {} }), { code: 'permission-denied' })
      assert.deepEqual(f.accesses, ['teachers/missing-teacher'])
    }
    assert.deepEqual(f.documents, before)
  }
})

test('pre-issued valid invitation and forged request mode cannot admit onboarding or invitation creation', async () => {
  const f = foundation()
  delete f.documents['teachers/fictional-teacher']; delete f.documents['classrooms/room-a']
  const invitation = `teacherInvitations/${hashEmailDigest(auth.token.email)}`
  f.documents[invitation] = { email: auth.token.email, status: 'active', expiresAt: Date.now() + 3600000 }
  const before = globalThis.structuredClone(f.documents)
  const r = runtime({ database: f.database, overrides: { onboardTeacherClassroomCallable, createTeacherInvitationCallable } })
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(r.handlers.onboardTeacherClassroomV2({ auth,
      data: { classroomName: 'Fictional' } }), genericDenial)
    await assert.rejects(r.handlers.onboardTeacherClassroomV2({ auth,
      data: { classroomName: 'Fictional', mode: 'normal', maintenanceMode: 'normal' } }), genericDenial)
    await assert.rejects(r.handlers.createTeacherInvitationV2({ auth: { uid: 'fictional-admin', token: { platformAdmin: true } },
      data: { email: 'fictional@example.com', expiryHours: 1 } }), genericDenial)
  }
  assert.deepEqual(r.events, []); assert.deepEqual(f.accesses, []); assert.deepEqual(f.documents, before)
})

test('populated foreign owner cannot be resolved through a corrupted reciprocal binding', async () => {
  for (const name of reads) {
    const f = foundation()
    f.documents['teachers/fictional-teacher'].classroomId = 'room-b'
    const r = runtime({ database: f.database, overrides: { getClassroomAccessCallable, resolveTeacherTenantCallable } })
    await assert.rejects(r.handlers[name](request), {
      code: name === 'getClassroomAccessV2' ? 'permission-denied' : 'failed-precondition',
    })
    assert.deepEqual(f.accesses, ['teachers/fictional-teacher', 'classrooms/room-b'])
  }
})

const timestamp = seconds => ({ seconds, nanoseconds: 0 })
function balanceEvent(beforeSeconds = 200, afterSeconds = 300, balance = 20) {
  const snap = (seconds, amount) => ({ exists: true, id: '1',
    ref: { path: 'classrooms/room-a/students/1' }, createTime: timestamp(100),
    updateTime: timestamp(seconds), data: () => ({ id: 1, balance: amount }) })
  return { params: { classroomId: 'room-a', studentId: '1' },
    data: { before: snap(beforeSeconds, 10), after: snap(afterSeconds, balance) } }
}
function witnessDatabase() {
  const store = new Map(), attempts = [], reads = []
  let failure
  const ref = path => ({
    collection: name => ({ doc: id => ref(`${path}/${name}/${id}`) }),
    async create(value) {
      assert.match(path, /^classrooms\/room-a\/balanceHistory\/1-\d{12}-\d{9}$/)
      attempts.push(path)
      if (failure) throw failure
      if (store.has(path)) throw Object.assign(new Error('duplicate'), { code: 6 })
      store.set(path, globalThis.structuredClone(value))
    },
    async get() { reads.push(path); return { data: () => store.get(path) } },
  })
  return { store, attempts, reads, fail: error => { failure = error },
    collection: name => ({ doc: id => ref(`${name}/${id}`) }) }
}

test('actual witness wrapper records a delayed post-closure event in closed and verification; duplicates never rewrite', async () => {
  for (const mode of ['closed', 'verification', 'normal']) {
    const db = witnessDatabase()
    let finish
    const pending = new Promise(resolve => { finish = resolve })
    const r = runtime({ mode: 'normal', database: db, overrides: { onboardTeacherClassroomCallable: () => pending } })
    const admitted = r.handlers.onboardTeacherClassroomV2(request)
    r.params.MULTI_TEACHER_V2_MAINTENANCE_MODE = mode
    // Synthetic transition barrier: a previously admitted operation finishes,
    // then its event is delivered. This is not actual platform delivery evidence.
    finish(balanceEvent())
    const event = await admitted
    r.events.length = 0
    await r.handlers[auditOperation](event)
    const saved = [...db.store.entries()]
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0][1], makeBalanceWitness(event))
    await r.handlers[auditOperation](event)
    assert.deepEqual([...db.store.entries()], saved)
    assert.equal(db.reads.length, 1)
    assert.deepEqual(r.events, ['getFirestore', 'getFirestore'])
    assert.ok(!r.valuesRead.includes('GEMINI_API_KEY'))
    // Business writers do not inherit the audit exception.
    if (mode !== 'normal') for (const operation of blocked) {
      await assert.rejects(r.handlers[operation](request), genericDenial)
    }
  }
})

test('maintenance witness keeps exact duplicate comparison, out-of-order acceptance and malformed-event refusal', async () => {
  const db = witnessDatabase(), r = runtime({ mode: 'closed', database: db })
  await r.handlers[auditOperation](balanceEvent(300, 400))
  await r.handlers[auditOperation](balanceEvent(200, 300))
  const saved = [...db.store.entries()]
  await r.handlers[auditOperation](balanceEvent(200, 300, 999))
  assert.deepEqual([...db.store.entries()], saved)
  assert.equal(r.logs.at(-1)[1].reason, 'witness-conflict')
  const attempts = db.attempts.length
  const malformed = balanceEvent(); malformed.params.classroomId = '../foreign'
  await r.handlers[auditOperation](malformed)
  assert.equal(db.attempts.length, attempts)
  assert.equal(r.logs.at(-1)[1].reason, 'invalid-identity')
})

test('maintenance witness propagates transient storage failure for existing retry policy and remains guarded', async () => {
  const db = witnessDatabase(), r = runtime({ mode: 'verification', database: db })
  const failure = Object.assign(new Error('synthetic unavailable'), { code: 14 })
  db.fail(failure)
  await assert.rejects(r.handlers[auditOperation](balanceEvent()), error => error === failure)
  assert.equal(db.store.size, 0)
  db.fail(undefined)
  await r.handlers[auditOperation](balanceEvent())
  assert.equal(db.store.size, 1)
  for (const mode of [undefined, '', 'CLOSED', true]) {
    r.params.MULTI_TEACHER_V2_MAINTENANCE_MODE = mode; r.events.length = 0
    await assert.rejects(r.handlers[auditOperation](balanceEvent()), genericDenial)
    assert.deepEqual(r.events, [])
  }
  r.params.MULTI_TEACHER_V2_ENABLED = false; r.events.length = 0
  assert.equal(await r.handlers[auditOperation](balanceEvent()), undefined)
  assert.deepEqual(r.events, []) // Preserved global-off early return, not queued replay.
})

test('normal mode preserves existing wrappers while global-on still denies legacy writers', async () => {
  const r = runtime({ mode: 'normal' })
  for (const operation of operations) assert.doesNotThrow(() => r.handlers.assertV2Invocation(operation))
  await r.handlers.onboardTeacherClassroomV2(request)
  assert.deepEqual(r.events, ['getFirestore', 'getAuth', 'onboardTeacherClassroomCallable'])
  r.events.length = 0
  for (const mode of ['normal', 'verification', 'closed']) {
    r.params.MULTI_TEACHER_V2_MAINTENANCE_MODE = mode
    for (const name of ['studentPinLogin', 'resetStudentPin', 'ensureTeacherClassroom']) {
      await assert.rejects(r.handlers[name](request), { code: 'failed-precondition' })
    }
    assert.equal(await r.handlers.syncStudentProfiles(request), undefined)
  }
  assert.deepEqual(r.events, [])
})

test('admission cannot cancel an already-started invocation; release must drain it before initializing data', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const r = runtime({ mode: 'normal', overrides: { onboardTeacherClassroomCallable: () => pending } })
  const admitted = r.handlers.onboardTeacherClassroomV2(request)
  r.params.MULTI_TEACHER_V2_MAINTENANCE_MODE = 'closed'
  const second = r.handlers.onboardTeacherClassroomV2(request)
  finish('already-admitted')
  await assert.rejects(second, genericDenial)
  assert.equal(await admitted, 'already-admitted')
  assert.deepEqual(r.events, ['getFirestore', 'getAuth'])
})
