const MAX_STUDENTS = 500
const MAX_TRANSACTIONS = 10000
const MAX_LOGIN_HISTORY = 500
const MAX_LIST_ITEMS = 100
const MAX_MONEY = 1_000_000_000

const STUDENT_KEYS = ['balance', 'frozen', 'id', 'name', 'pin']
const TRANSACTION_KEYS = [
  'amount', 'category', 'date', 'id', 'memo', 'reason', 'source',
  'status', 'studentId', 'studentName', 'type',
]
const LOGIN_HISTORY_KEYS = ['date', 'id', 'note', 'result', 'studentId', 'studentName']
const SETTINGS_KEYS = [
  'addMoneyCategories', 'purchaseCategories', 'purchaseRequestsEnabled', 'reasons',
  'requireTeacherApproval', 'studentAddRequestsEnabled',
  'studentRequestsEnabled', 'studentSubtractRequestsEnabled',
  'subtractMoneyCategories',
]
const TOP_LEVEL_KEYS = ['exportedAt', 'loginHistory', 'settings', 'students', 'transactions']

export class LegacyBackupValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LegacyBackupValidationError'
  }
}

function plainObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LegacyBackupValidationError(`${label} must be an object.`)
  }
  return value
}

function allowOnlyKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new LegacyBackupValidationError(`${label} contains unsupported fields.`)
  }
}

function boundedString(value, label, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    throw new LegacyBackupValidationError(`${label} is invalid.`)
  }
  return value
}

function positiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LegacyBackupValidationError(`${label} must be a positive integer.`)
  }
  return value
}

function finiteMoney(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_MONEY) {
    throw new LegacyBackupValidationError(`${label} is invalid.`)
  }
  return value
}

function boundedArray(value, label, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new LegacyBackupValidationError(`${label} is invalid.`)
  }
  return value
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new LegacyBackupValidationError(`${label} must be a boolean.`)
  }
  return value
}

function uniqueIds(records, label) {
  const ids = new Set()
  for (const record of records) {
    if (ids.has(record.id)) throw new LegacyBackupValidationError(`${label} contains duplicate IDs.`)
    ids.add(record.id)
  }
}

function sanitizeStudent(value, index) {
  const student = plainObject(value, `students[${index}]`)
  allowOnlyKeys(student, STUDENT_KEYS, `students[${index}]`)
  const keys = Object.keys(student).sort()
  if (keys.length !== STUDENT_KEYS.length || !keys.every((key, i) => key === STUDENT_KEYS[i])) {
    throw new LegacyBackupValidationError(`students[${index}] is incomplete.`)
  }
  return Object.freeze({
    id: positiveId(student.id, `students[${index}].id`),
    name: boundedString(student.name, `students[${index}].name`, 100),
    pin: boundedString(student.pin, `students[${index}].pin`, 4),
    balance: finiteMoney(student.balance, `students[${index}].balance`),
    frozen: exactBoolean(student.frozen, `students[${index}].frozen`),
  })
}

function sanitizeTransaction(value, index) {
  const transaction = plainObject(value, `transactions[${index}]`)
  allowOnlyKeys(transaction, TRANSACTION_KEYS, `transactions[${index}]`)
  const keys = Object.keys(transaction).sort()
  if (keys.length !== TRANSACTION_KEYS.length || !keys.every((key, i) => key === TRANSACTION_KEYS[i])) {
    throw new LegacyBackupValidationError(`transactions[${index}] is incomplete.`)
  }
  if (!['Add', 'Subtract'].includes(transaction.type)) {
    throw new LegacyBackupValidationError(`transactions[${index}].type is invalid.`)
  }
  if (!['Pending', 'Approved', 'Denied'].includes(transaction.status)) {
    throw new LegacyBackupValidationError(`transactions[${index}].status is invalid.`)
  }
  if (!['Teacher', 'Student'].includes(transaction.source)) {
    throw new LegacyBackupValidationError(`transactions[${index}].source is invalid.`)
  }
  return Object.freeze({
    id: positiveId(transaction.id, `transactions[${index}].id`),
    date: boundedString(transaction.date, `transactions[${index}].date`, 100),
    studentId: positiveId(transaction.studentId, `transactions[${index}].studentId`),
    studentName: boundedString(transaction.studentName, `transactions[${index}].studentName`, 100),
    type: transaction.type,
    amount: finiteMoney(transaction.amount, `transactions[${index}].amount`),
    reason: boundedString(transaction.reason, `transactions[${index}].reason`, 200),
    memo: boundedString(transaction.memo, `transactions[${index}].memo`, 500, { allowEmpty: true }),
    category: boundedString(transaction.category, `transactions[${index}].category`, 200, { allowEmpty: true }),
    status: transaction.status,
    source: transaction.source,
  })
}

function sanitizeLoginEntry(value, index) {
  const entry = plainObject(value, `loginHistory[${index}]`)
  allowOnlyKeys(entry, LOGIN_HISTORY_KEYS, `loginHistory[${index}]`)
  const keys = Object.keys(entry).sort()
  if (keys.length !== LOGIN_HISTORY_KEYS.length || !keys.every((key, i) => key === LOGIN_HISTORY_KEYS[i])) {
    throw new LegacyBackupValidationError(`loginHistory[${index}] is incomplete.`)
  }
  return Object.freeze({
    id: positiveId(entry.id, `loginHistory[${index}].id`),
    date: boundedString(entry.date, `loginHistory[${index}].date`, 100),
    studentId: entry.studentId === null ? null : positiveId(entry.studentId, `loginHistory[${index}].studentId`),
    studentName: boundedString(entry.studentName, `loginHistory[${index}].studentName`, 100),
    result: boundedString(entry.result, `loginHistory[${index}].result`, 100),
    note: boundedString(entry.note, `loginHistory[${index}].note`, 500, { allowEmpty: true }),
  })
}

function sanitizeStringList(value, label) {
  return boundedArray(value, label, MAX_LIST_ITEMS)
    .map((item, index) => boundedString(item, `${label}[${index}]`, 200))
}

function sanitizeSettings(value, fallbackSettings) {
  const settings = plainObject(value, 'settings')
  allowOnlyKeys(settings, SETTINGS_KEYS, 'settings')
  const result = { ...fallbackSettings }
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue
    result[key] = key.endsWith('Categories') || key === 'reasons'
      ? sanitizeStringList(settings[key], `settings.${key}`)
      : exactBoolean(settings[key], `settings.${key}`)
  }
  return Object.freeze(result)
}

export function sanitizeLegacyBackup(imported, {
  fallbackLoginHistory = [],
  fallbackSettings,
  now = () => new Date().toISOString(),
} = {}) {
  const backup = plainObject(imported, 'backup')
  allowOnlyKeys(backup, TOP_LEVEL_KEYS, 'backup')
  if (!fallbackSettings || typeof fallbackSettings !== 'object') {
    throw new TypeError('fallbackSettings is required.')
  }

  const students = boundedArray(backup.students, 'students', MAX_STUDENTS).map(sanitizeStudent)
  const transactions = boundedArray(backup.transactions, 'transactions', MAX_TRANSACTIONS).map(sanitizeTransaction)
  const loginHistory = boundedArray(
    backup.loginHistory ?? fallbackLoginHistory,
    'loginHistory',
    MAX_LOGIN_HISTORY,
  ).map(sanitizeLoginEntry)
  uniqueIds(students, 'students')
  uniqueIds(transactions, 'transactions')
  uniqueIds(loginHistory, 'loginHistory')

  let exportedAt = now()
  if (backup.exportedAt !== undefined && backup.exportedAt !== null) {
    exportedAt = boundedString(backup.exportedAt, 'exportedAt', 100)
    if (!Number.isFinite(Date.parse(exportedAt))) {
      throw new LegacyBackupValidationError('exportedAt is invalid.')
    }
  }

  return Object.freeze({
    students,
    transactions,
    loginHistory,
    settings: sanitizeSettings(backup.settings ?? fallbackSettings, fallbackSettings),
    lastBackupAt: exportedAt,
  })
}
