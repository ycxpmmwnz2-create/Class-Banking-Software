// Phase 2A Item 9 — deterministic synthetic legacy fixture builder.
//
// This module is PURE: it never touches Firestore, never reads the clock, and
// never reads process state. It only describes the legacy documents the
// rehearsal seeder writes into the emulator before the migration runtime
// starts. Every value is fixed so a rehearsal produces identical checksums,
// plans, and hashes on every run.
//
// Shapes deliberately mirror what the existing application produces:
// `morganBank/classroomData` with embedded students/transactions/loginHistory
// arrays, flat `studentCredentials` documents (see
// functions/syncStudentProfiles.js and functions/resetStudentPin.js), and flat
// `studentAuthLogs` documents (see functions/studentCredentialVerifier.js,
// whose log body omits `classroomId` whenever the credential record has none).

import { Timestamp } from 'firebase-admin/firestore'

export const LEGACY_CLASSROOM_ID = 'morgan'
export const LEGACY_CLASSROOM_DATA_PATH = 'morganBank/classroomData'
export const LEGACY_CREDENTIALS_COLLECTION = 'studentCredentials'
export const LEGACY_AUTH_LOGS_COLLECTION = 'studentAuthLogs'

// A fixed, arbitrary epoch second so every Timestamp in the fixture is
// deterministic. Nothing depends on this being "now".
const BASE_SECONDS = 1_700_000_000

export const REHEARSAL_FIXTURE_SIZES = Object.freeze({
  FULL: 'full',
  SMALL: 'small',
})

export const INVALID_DOCUMENT_ID_TARGETS = Object.freeze({
  STUDENTS: 'students',
  TRANSACTIONS: 'transactions',
  LOGIN_HISTORY: 'loginHistory',
})

// Synthetic secret-like material. The prefix is deliberately NOT hexadecimal
// so an "absent from the manifest" assertion cannot be satisfied or defeated
// by coincidental overlap with a SHA-256 digest.
export const SYNTHETIC_PIN_HASH_PREFIX =
  '$2b$10$phase2aRehearsalSyntheticPinHashZZ'

// Plaintext legacy PIN values. Legacy student records carried these directly
// on the embedded student objects; the migration must never copy them.
export const SYNTHETIC_PLAINTEXT_PINS = Object.freeze(['2718', '3141'])

// Field names that must never appear anywhere inside a manifest, because the
// manifest records only paths, hashes, and lifecycle state — never bodies.
export const SECRET_BEARING_FIELD_NAMES = Object.freeze([
  'pin',
  'pinHash',
  'loginId',
  'credentialActive',
  'authUid',
])

export const MAX_DOCUMENT_ID_UTF8_BYTES = 1500

function timestampAt(offsetSeconds, nanoseconds = 0) {
  return new Timestamp(BASE_SECONDS + offsetSeconds, nanoseconds)
}

function syntheticPinHash(credentialId) {
  return `${SYNTHETIC_PIN_HASH_PREFIX}-${credentialId}`
}

/** A student ID that intentionally matches no student in the roster. */
export const WITHDRAWN_STUDENT_ID = 's-withdrawn-0000'

function fullStudents() {
  return [
    {
      id: 's1',
      name: 'Avery Diaz',
      balance: 125,
      frozen: false,
      // Legacy leakage the destination student document must exclude.
      pin: SYNTHETIC_PLAINTEXT_PINS[0],
      loginId: 'avery-diaz',
      credentialActive: true,
      // Unknown/undocumented legacy fields must also be excluded.
      avatarColor: 'teal',
      notes: 'legacy free-text note',
    },
    {
      id: 's2',
      name: 'Bailey Cruz',
      balance: 40,
      frozen: true,
      pin: SYNTHETIC_PLAINTEXT_PINS[1],
      loginId: 'bailey-cruz',
      credentialActive: false,
    },
    { id: 's3', name: 'Casey Nolan', balance: 0, frozen: false },
    { id: 's4', name: 'Devon Park', balance: 15, frozen: false },
    { id: 's5', name: 'Emery Shaw', balance: 7, frozen: false },
    { id: 's6', name: 'Frankie Lo', balance: 3, frozen: false },
  ]
}

function fullTransactions() {
  return [
    {
      id: 't1',
      studentId: 's1',
      type: 'deposit',
      amount: 100,
      description: 'Weekly payroll',
      timestamp: timestampAt(100),
      createdBy: 'teacher',
    },
    {
      id: 't2',
      studentId: 's1',
      type: 'withdrawal',
      amount: -25,
      description: 'Class store purchase',
      timestamp: timestampAt(200),
      createdBy: 'teacher',
    },
    {
      id: 't3',
      studentId: 's2',
      type: 'deposit',
      amount: 40,
      description: 'Job bonus',
      timestamp: timestampAt(300),
      createdBy: 'teacher',
    },
    {
      // References no current student: proves per-student transaction
      // filtering while still migrating as its own transaction document.
      id: 't4',
      studentId: WITHDRAWN_STUDENT_ID,
      type: 'deposit',
      amount: 5,
      description: 'Transaction for a withdrawn student',
      timestamp: timestampAt(400),
      createdBy: 'teacher',
    },
  ]
}

function fullLoginHistory() {
  return [
    {
      id: 'h1',
      studentId: 's1',
      loginId: 'avery-diaz',
      success: true,
      at: timestampAt(500),
    },
    {
      id: 'h2',
      studentId: 's3',
      loginId: 'casey-nolan',
      success: true,
      at: timestampAt(600),
    },
    {
      // References no current student.
      id: 'h3',
      studentId: WITHDRAWN_STUDENT_ID,
      loginId: 'withdrawn-student',
      success: false,
      at: timestampAt(700),
    },
  ]
}

function credential({
  id,
  studentId,
  active,
  failedAttempts = 0,
  lockedUntilOffset = null,
}) {
  return {
    id,
    path: `${LEGACY_CREDENTIALS_COLLECTION}/${id}`,
    data: {
      schemaVersion: 1,
      authUid: id,
      classroomId: LEGACY_CLASSROOM_ID,
      studentId,
      pinHash: syntheticPinHash(id),
      active,
      failedAttempts,
      lockedUntil: lockedUntilOffset === null
        ? null
        : timestampAt(lockedUntilOffset),
      createdAt: timestampAt(10),
      updatedAt: timestampAt(20),
      pinUpdatedAt: timestampAt(20),
    },
  }
}

// Ten credentials exercise every documented state and, with an injected
// pageSize of 4, force three paginated source pages.
function fullCredentials() {
  return [
    // Matched + active.
    credential({ id: 'avery-diaz', studentId: 's1', active: true }),
    credential({ id: 'casey-nolan', studentId: 's3', active: true }),
    credential({ id: 'devon-park', studentId: 's4', active: true }),
    credential({
      id: 'emery-shaw',
      studentId: 's5',
      active: true,
      failedAttempts: 2,
    }),
    // Matched + inactive.
    credential({ id: 'bailey-cruz', studentId: 's2', active: false }),
    credential({
      id: 'frankie-lo',
      studentId: 's6',
      active: false,
      failedAttempts: 5,
      lockedUntilOffset: 900,
    }),
    // Orphaned + active. Orphan status is independent of `active`.
    credential({ id: 'harper-gone', studentId: 'sx-101', active: true }),
    credential({
      id: 'indigo-gone',
      studentId: 'sx-102',
      active: true,
      failedAttempts: 1,
    }),
    // Orphaned + inactive.
    credential({ id: 'jules-gone', studentId: 'sx-103', active: false }),
    credential({
      id: 'kai-gone',
      studentId: 'sx-104',
      active: false,
      failedAttempts: 5,
      lockedUntilOffset: 950,
    }),
  ]
}

function authLog({
  id,
  loginId,
  success,
  reason,
  offset,
  classroomId,
  studentId,
}) {
  const data = {
    loginId,
    success,
    reason,
    timestamp: timestampAt(offset),
  }

  // The production writer omits both fields when the credential record has
  // no matching value, so a missing classroomId is normal legacy data.
  if (classroomId !== undefined) {
    data.classroomId = classroomId
  }
  if (studentId !== undefined) {
    data.studentId = studentId
  }

  return { id, path: `${LEGACY_AUTH_LOGS_COLLECTION}/${id}`, data }
}

// Eight logs, so an injected pageSize of 4 forces multiple pages here too.
function fullAuthLogs() {
  return [
    authLog({
      id: 'log-01',
      loginId: 'avery-diaz',
      success: true,
      reason: 'ok',
      offset: 1000,
      classroomId: LEGACY_CLASSROOM_ID,
      studentId: 's1',
    }),
    authLog({
      id: 'log-02',
      loginId: 'bailey-cruz',
      success: false,
      reason: 'invalid_credentials',
      offset: 1010,
      classroomId: LEGACY_CLASSROOM_ID,
      studentId: 's2',
    }),
    authLog({
      id: 'log-03',
      loginId: 'frankie-lo',
      success: false,
      reason: 'locked',
      offset: 1020,
      classroomId: LEGACY_CLASSROOM_ID,
      studentId: 's6',
    }),
    // No embedded classroomId at all.
    authLog({
      id: 'log-04',
      loginId: 'unknown-login',
      success: false,
      reason: 'invalid_credentials',
      offset: 1030,
    }),
    authLog({
      id: 'log-05',
      loginId: 'casey-nolan',
      success: true,
      reason: 'ok',
      offset: 1040,
      studentId: 's3',
    }),
    authLog({
      id: 'log-06',
      loginId: 'devon-park',
      success: true,
      reason: 'ok',
      offset: 1050,
      studentId: 's4',
    }),
    authLog({
      id: 'log-07',
      loginId: 'emery-shaw',
      success: false,
      reason: 'invalid_credentials',
      offset: 1060,
      studentId: 's5',
    }),
    authLog({
      id: 'log-08',
      loginId: 'another-unknown-login',
      success: false,
      reason: 'invalid_credentials',
      offset: 1070,
    }),
  ]
}

function smallStudents() {
  return fullStudents().slice(0, 2)
}

function smallTransactions() {
  const transactions = fullTransactions()
  return [transactions[0]]
}

function smallLoginHistory() {
  const history = fullLoginHistory()
  return [history[0]]
}

function smallCredentials() {
  return [
    credential({ id: 'avery-diaz', studentId: 's1', active: true }),
    credential({ id: 'bailey-cruz', studentId: 's2', active: false }),
  ]
}

function smallAuthLogs() {
  const logs = fullAuthLogs()
  return [logs[0]]
}

function legacySettings() {
  return {
    currencyName: 'Morgan Bucks',
    payDay: 'friday',
    interestRate: 2,
    allowRequests: true,
    theme: { accent: 'indigo', density: 'compact' },
  }
}

/**
 * Every document-ID rejection category that can actually round-trip through
 * Firestore, plus the numeric/string collision pair.
 *
 * Two documented categories are deliberately absent because the offending
 * value cannot be stored in a Firestore document at all, so no emulator-backed
 * fixture can produce them: `invalid-unicode` (a lone surrogate is not valid
 * UTF-8) and `unsupported-type` (bigint and symbol are not Firestore values).
 * Those remain covered by functions/phase2/firestoreDocumentId.test.js.
 */
function invalidDocumentIdRecords() {
  return [
    { name: 'missing id field' },
    { id: null, name: 'null id' },
    { id: '', name: 'empty string id' },
    { id: '   ', name: 'whitespace-only id' },
    { id: ' padded-id ', name: 'surrounding whitespace id' },
    { id: 'nested/path', name: 'slash id' },
    { id: '.', name: 'single dot id' },
    { id: '..', name: 'double dot id' },
    { id: '__name__', name: 'reserved pattern id' },
    { id: 'x'.repeat(MAX_DOCUMENT_ID_UTF8_BYTES + 1), name: 'oversized id' },
    { id: true, name: 'boolean id' },
    // Firestore stores NaN and ±Infinity as real double values, so both
    // non-finite forms are reachable end to end.
    { id: Number.NaN, name: 'not-a-number id' },
    { id: Number.POSITIVE_INFINITY, name: 'infinite id' },
    { id: { nested: 'map' }, name: 'object id' },
    { id: ['array'], name: 'array id' },
    // Numeric 1 and string "1" normalize to the same document ID.
    { id: 1, name: 'numeric one id' },
    { id: '1', name: 'string one id' },
  ]
}

function validRecordsFor(target, size) {
  const small = size === REHEARSAL_FIXTURE_SIZES.SMALL

  return {
    students: target === INVALID_DOCUMENT_ID_TARGETS.STUDENTS
      ? invalidDocumentIdRecords()
      : (small ? smallStudents() : fullStudents()),
    transactions: target === INVALID_DOCUMENT_ID_TARGETS.TRANSACTIONS
      ? invalidDocumentIdRecords()
      : (small ? smallTransactions() : fullTransactions()),
    loginHistory: target === INVALID_DOCUMENT_ID_TARGETS.LOGIN_HISTORY
      ? invalidDocumentIdRecords()
      : (small ? smallLoginHistory() : fullLoginHistory()),
  }
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object' ||
      Array.isArray(options)) {
    throw new TypeError('buildRehearsalFixture requires an options object.')
  }

  const allowedKeys = new Set([
    'size',
    'unexpectedAuthLogClassroomId',
    'invalidDocumentIdTarget',
    'includeLastBackupAt',
    'invalidCredentialClassroomId',
  ])
  const unknownKey = Reflect.ownKeys(options).find(key =>
    typeof key !== 'string' || !allowedKeys.has(key),
  )

  if (unknownKey !== undefined) {
    throw new TypeError(`Unknown fixture option: ${String(unknownKey)}.`)
  }

  const size = options.size ?? REHEARSAL_FIXTURE_SIZES.FULL
  if (!Object.values(REHEARSAL_FIXTURE_SIZES).includes(size)) {
    throw new TypeError(`Unsupported fixture size: ${String(size)}.`)
  }

  const target = options.invalidDocumentIdTarget ?? null
  if (target !== null &&
      !Object.values(INVALID_DOCUMENT_ID_TARGETS).includes(target)) {
    throw new TypeError(
      `Unsupported invalid document ID target: ${String(target)}.`,
    )
  }

  return {
    size,
    invalidDocumentIdTarget: target,
    unexpectedAuthLogClassroomId:
      options.unexpectedAuthLogClassroomId ?? null,
    invalidCredentialClassroomId: options.invalidCredentialClassroomId ?? null,
    includeLastBackupAt: options.includeLastBackupAt ?? true,
  }
}

/**
 * Builds the complete synthetic legacy fixture.
 *
 * The result is data only. `seedRehearsal.js` is what writes it, and it does
 * so strictly before the migration runtime starts.
 */
export function buildRehearsalFixture(options = {}) {
  const {
    size,
    invalidDocumentIdTarget,
    unexpectedAuthLogClassroomId,
    invalidCredentialClassroomId,
    includeLastBackupAt,
  } = validateOptions(options)
  const small = size === REHEARSAL_FIXTURE_SIZES.SMALL
  const records = validRecordsFor(invalidDocumentIdTarget, size)
  const classroomData = {
    students: records.students,
    transactions: records.transactions,
    loginHistory: records.loginHistory,
    settings: legacySettings(),
  }

  if (includeLastBackupAt) {
    classroomData.lastBackupAt = timestampAt(800)
  }

  const studentCredentials = small ? smallCredentials() : fullCredentials()
  const studentAuthLogs = small ? smallAuthLogs() : fullAuthLogs()

  if (invalidCredentialClassroomId !== null) {
    // Exercises the blocking raw-credential validation: every legacy
    // credential must still be scoped to "morgan" before migration.
    studentCredentials[0].data.classroomId = invalidCredentialClassroomId
  }

  if (unexpectedAuthLogClassroomId !== null) {
    // Exercises the blocking auth-log anomaly path.
    studentAuthLogs.push(authLog({
      id: 'log-anomaly',
      loginId: 'anomalous-login',
      success: false,
      reason: 'invalid_credentials',
      offset: 1080,
      classroomId: unexpectedAuthLogClassroomId,
      studentId: 's1',
    }))
  }

  return Object.freeze({
    size,
    classroomData: Object.freeze({
      path: LEGACY_CLASSROOM_DATA_PATH,
      data: classroomData,
    }),
    studentCredentials: Object.freeze(studentCredentials),
    studentAuthLogs: Object.freeze(studentAuthLogs),
    expected: Object.freeze({
      studentIds: Object.freeze(
        records.students.map(student => student.id),
      ),
      transactionIds: Object.freeze(
        records.transactions.map(transaction => transaction.id),
      ),
      loginHistoryIds: Object.freeze(
        records.loginHistory.map(entry => entry.id),
      ),
      credentialIds: Object.freeze(
        studentCredentials.map(entry => entry.id),
      ),
      authLogIds: Object.freeze(studentAuthLogs.map(entry => entry.id)),
      orphanedCredentialPaths: Object.freeze(
        studentCredentials
          .filter(entry => !records.students.some(student =>
            student.id != null && String(student.id) ===
              String(entry.data.studentId),
          ))
          .map(entry => entry.path)
          .sort(),
      ),
      // Operation count = one classroom-field update + one create per
      // student/transaction/login-history/auth-log + one credential update.
      // Item 6 assigns exactly one operation per batch, so this is also the
      // expected batch count.
      operationCount: 1 +
        records.students.length +
        records.transactions.length +
        records.loginHistory.length +
        studentAuthLogs.length +
        studentCredentials.length,
    }),
  })
}

/**
 * A raw source mutation that changes the immutable-source checksum and the
 * projected plan without making the source invalid. Used to prove a corrected
 * source produces wholly new checksums, plan, and runId.
 */
export function buildCorrectedStudentBalanceMutation(fixture) {
  const students = fixture.classroomData.data.students.map(student =>
    student.id === 's1' ? { ...student, balance: 175 } : student,
  )

  return { students }
}

/**
 * A raw classroom-root mutation that advances `updateTime` and invalidates
 * the retained plan's classroom before-state and precondition.
 */
export function buildClassroomSettingsMutation() {
  return {
    settings: {
      ...legacySettings(),
      currencyName: 'Mutated Bucks',
    },
  }
}

/**
 * A raw credential mutation of a non-`classroomId` field. It advances
 * `updateTime` and changes the credential invariant.
 */
export function buildCredentialInvariantMutation() {
  return { failedAttempts: 41 }
}

/**
 * A destination student body that matches neither the expected-before
 * (absent) nor the expected-after state.
 */
export function buildDivergentStudentDocument() {
  return {
    id: 's1',
    name: 'Divergent Pre-Existing Student',
    balance: 999_999,
    frozen: true,
    transactions: [],
  }
}

/**
 * A destination auth-log body that matches neither expected state.
 */
export function buildDivergentAuthLogDocument() {
  return {
    loginId: 'divergent-pre-existing-log',
    success: true,
    reason: 'divergent',
    timestamp: timestampAt(9999),
  }
}
