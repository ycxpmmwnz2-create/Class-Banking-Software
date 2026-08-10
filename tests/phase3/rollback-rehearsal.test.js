// Phase 3 Boundary 11 — credential-isolated rollback rehearsal.
//
// Run only through `npm run test:phase3:rollback-rehearsal`. Candidate rules
// are loaded directly into the local Firestore emulator. Nothing is copied over
// firestore.rules and no deploy, production project, or network path exists.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { after, before, describe, test } from 'node:test'

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'

assert.ok(
  typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0,
  'FIRESTORE_EMULATOR_HOST must be supplied by the rollback rehearsal harness.',
)
assert.equal(
  process.env.PHASE3_REHEARSAL_MODE,
  'rollback',
  'The rollback suite must run only through its explicit rehearsal command.',
)

const PROJECT_ID = 'demo-morgan-bank-phase3-rollback-test'
const LEGACY_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'
const CLASSROOM_ID = 'rollback-classroom'
const STUDENT_ID = '1'
const LOGIN_ID = 'rollback-student'

const FINAL_RULES = Object.freeze({
  path: 'firestore.phase3.final.rules',
  sha256: '1ed51ca745742cf2a76d910fc83b48df9300de1ddbcd2f438a050f748798f5bb',
})
const ROLLBACK_RULES = Object.freeze({
  path: 'firestore.phase3.rollback.rules',
  sha256: 'c81a058e260502fe31c4240d547dcd731f130eb85be3a3c185caae681e4ef19d',
})
const BASELINE_SHA256 =
  '0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50'

const ROLLBACK_SEQUENCE = Object.freeze([
  'freeze-retained',
  'hosting-default-off-restored',
  'server-gate-disabled',
  'rollback-rules-verified',
  'legacy-state-reconciled',
  'legacy-acceptance-passed',
  'writes-resumed',
])

class RollbackLedger {
  constructor() {
    this.events = []
  }

  append(event, evidence = {}) {
    const expected = ROLLBACK_SEQUENCE[this.events.length]
    if (event !== expected) {
      throw new Error(`rollback-order-abort: expected ${expected}, received ${event}`)
    }
    if (evidence === null || Array.isArray(evidence) || typeof evidence !== 'object') {
      throw new Error('rollback-evidence-abort: evidence must be an object')
    }
    const record = Object.freeze({ ...evidence, sequence: this.events.length + 1, event })
    const encoded = JSON.stringify(record)
    for (const forbidden of ['pinHash', 'rollback-secret-hash', 'access_token', 'private_key']) {
      if (encoded.includes(forbidden)) {
        throw new Error(`rollback-evidence-abort: secret-bearing marker ${forbidden}`)
      }
    }
    this.events.push(record)
    return record
  }

  complete() {
    if (this.events.length !== ROLLBACK_SEQUENCE.length) {
      throw new Error('rollback-order-abort: legacy writes cannot resume yet')
    }
    return Object.freeze([...this.events])
  }

  assertWritesMayResume() {
    if (this.events.at(-1)?.event !== 'writes-resumed') {
      throw new Error('rollback-order-abort: legacy writes cannot resume yet')
    }
  }
}

function rulesBytes(candidate) {
  const bytes = readFileSync(candidate.path)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), candidate.sha256)
  return bytes.toString('utf8')
}

function bodyDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

let environment

async function loadRules(candidate) {
  await environment?.cleanup()
  environment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: rulesBytes(candidate),
      host: '127.0.0.1',
      port: 8080,
    },
  })
  return environment
}

async function readPrivileged(path) {
  let value
  await environment.withSecurityRulesDisabled(async context => {
    const snapshot = await context.firestore().doc(path).get()
    assert.equal(snapshot.exists, true, `${path} must exist`)
    value = snapshot.data()
  })
  return value
}

before(async () => {
  await loadRules(FINAL_RULES)
  await environment.clearFirestore()
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore()
    await db.doc('morganBank/classroomData').set({
      students: [{ id: 1, name: 'Legacy Student', balance: 10 }],
      transactions: [{ id: 100, studentId: 1, amount: 10 }],
      settings: { reasons: ['Legacy'] },
    })
    await db.doc(`classrooms/morgan/students/${STUDENT_ID}`).set({
      id: 1, name: 'Legacy Student', balance: 10, frozen: false, transactions: [],
    })
    await db.doc(`studentCredentials/${LOGIN_ID}`).set({
      classroomId: 'morgan', studentId: STUDENT_ID,
      pinHash: 'rollback-secret-hash', active: true,
    })
    await db.doc(`studentAuthLogs/legacy-log`).set({ studentId: STUDENT_ID })
    await db.doc(`teachers/${LEGACY_UID}`).set({
      uid: LEGACY_UID, classroomId: CLASSROOM_ID, status: 'active',
    })
    await db.doc(`classrooms/${CLASSROOM_ID}`).set({
      ownerUid: LEGACY_UID, name: 'Scoped Classroom', settings: {},
    })
    await db.doc(`classrooms/${CLASSROOM_ID}/students/${STUDENT_ID}`).set({
      id: 1, name: 'Legacy Student', balance: 10, frozen: false, transactions: [],
    })
    await db.doc(`classrooms/${CLASSROOM_ID}/studentCredentials/${LOGIN_ID}`).set({
      classroomId: CLASSROOM_ID, studentId: STUDENT_ID,
      pinHash: 'rollback-secret-hash', active: true,
    })
    await db.doc(`studentAuthLogs/${CLASSROOM_ID}/logs/scoped-log`).set({
      studentId: STUDENT_ID,
    })
  })
})

after(async () => {
  await environment?.cleanup()
})

describe('Phase 3 rollback rehearsal', () => {
  test('restores default-off behavior in order while retained scoped credentials stay denied', async () => {
    const ledger = new RollbackLedger()
    const legacyBefore = await readPrivileged('morganBank/classroomData')
    const flatCredentialBefore = await readPrivileged(`studentCredentials/${LOGIN_ID}`)
    const scopedCredentialBefore = await readPrivileged(
      `classrooms/${CLASSROOM_ID}/studentCredentials/${LOGIN_ID}`,
    )

    // Starting point: final rules expose scoped classroom data, deny the legacy
    // aggregate, and deny the retained scoped credential even to its owner.
    const finalOwner = environment.authenticatedContext(LEGACY_UID).firestore()
    await assertSucceeds(finalOwner.doc(`classrooms/${CLASSROOM_ID}`).get())
    await assertFails(finalOwner.doc('morganBank/classroomData').get())
    await assertFails(finalOwner.doc(
      `classrooms/${CLASSROOM_ID}/studentCredentials/${LOGIN_ID}`,
    ).get())

    ledger.append('freeze-retained', {
      sourceChecksum: bodyDigest(legacyBefore),
      scopedCredentialCount: 1,
    })
    ledger.append('hosting-default-off-restored', {
      hostingArtifact: 'default-off-emulator-artifact',
    })
    ledger.append('server-gate-disabled', { gateEnabled: false })

    await loadRules(ROLLBACK_RULES)
    assert.notEqual(ROLLBACK_RULES.sha256, BASELINE_SHA256)
    assert.doesNotMatch(
      rulesBytes(ROLLBACK_RULES).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''),
      /match\s+\/classrooms\/\{\s*document\s*=\s*\*\*\s*\}/,
    )
    ledger.append('rollback-rules-verified', {
      rulesSha256: ROLLBACK_RULES.sha256,
      recursiveBaselineRejected: true,
    })

    const legacyAfter = await readPrivileged('morganBank/classroomData')
    const flatCredentialAfter = await readPrivileged(`studentCredentials/${LOGIN_ID}`)
    const scopedCredentialAfter = await readPrivileged(
      `classrooms/${CLASSROOM_ID}/studentCredentials/${LOGIN_ID}`,
    )
    assert.deepEqual(legacyAfter, legacyBefore)
    assert.deepEqual(flatCredentialAfter, flatCredentialBefore)
    assert.deepEqual(scopedCredentialAfter, scopedCredentialBefore)
    ledger.append('legacy-state-reconciled', {
      legacyChecksum: bodyDigest(legacyAfter),
      flatCredentialUnchanged: true,
      scopedCredentialRetained: true,
    })

    const legacyTeacher = environment.authenticatedContext(LEGACY_UID).firestore()
    const legacyStudent = environment.authenticatedContext('legacy-student-uid', {
      role: 'student', classroomId: 'morgan', studentId: STUDENT_ID,
    }).firestore()
    await assertSucceeds(legacyTeacher.doc('morganBank/classroomData').get())
    await assertSucceeds(legacyTeacher.collection('studentAuthLogs').get())
    await assertSucceeds(legacyStudent.doc(
      `classrooms/morgan/students/${STUDENT_ID}`,
    ).get())
    await assertFails(legacyTeacher.doc(`classrooms/${CLASSROOM_ID}`).get())
    await assertFails(legacyTeacher.doc(
      `classrooms/${CLASSROOM_ID}/studentCredentials/${LOGIN_ID}`,
    ).get())
    await assertFails(legacyTeacher.doc(`studentCredentials/${LOGIN_ID}`).get())
    ledger.append('legacy-acceptance-passed', {
      teacherAccepted: true,
      studentAccepted: true,
      scopedCredentialDenied: true,
    })

    // Only after acceptance may the modeled freeze end. Exercise one disposable
    // legacy write after that boundary without modifying the retained source.
    ledger.append('writes-resumed', { acceptancePassed: true })
    const evidence = ledger.complete()
    ledger.assertWritesMayResume()
    await assertSucceeds(legacyTeacher.doc('morganBank/rehearsal/probes/resumed').set({
      rehearsal: true,
    }))
    await assertSucceeds(legacyTeacher.doc('morganBank/rehearsal/probes/resumed').delete())

    assert.deepEqual(evidence.map(entry => entry.event), ROLLBACK_SEQUENCE)
    assert.deepEqual(await readPrivileged('morganBank/classroomData'), legacyBefore)
  })

  test('negative controls reject out-of-order rollback and early write resumption', () => {
    const gateFirst = new RollbackLedger()
    gateFirst.append('freeze-retained')
    assert.throws(
      () => gateFirst.append('server-gate-disabled'),
      /rollback-order-abort/,
    )

    const earlyResume = new RollbackLedger()
    earlyResume.append('freeze-retained')
    earlyResume.append('hosting-default-off-restored')
    earlyResume.append('server-gate-disabled')
    earlyResume.append('rollback-rules-verified')
    earlyResume.append('legacy-state-reconciled')
    assert.throws(() => earlyResume.assertWritesMayResume(), /cannot resume yet/)
    assert.throws(
      () => earlyResume.append('writes-resumed'),
      /rollback-order-abort/,
    )
    assert.throws(() => earlyResume.complete(), /cannot resume yet/)
  })

  test('negative control rejects secret-bearing observability evidence', () => {
    const ledger = new RollbackLedger()
    assert.throws(
      () => ledger.append('freeze-retained', { pinHash: 'rollback-secret-hash' }),
      /rollback-evidence-abort/,
    )
  })
})
