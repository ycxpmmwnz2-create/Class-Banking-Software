/**
 * Phase 3 Commit 7 — tenant data projection.
 *
 * Pure, I/O-free translation between the V2 per-path Firestore documents and
 * the aggregate `data` view model the legacy UI renders. Section 4 of
 * PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md makes the aggregate a *view* model
 * only: it is no longer the persistence model, so every crossing of that
 * boundary is validated here rather than trusted.
 *
 * This module never performs I/O, never reads `window`, and never touches a
 * credential path. It fails closed: an unexpected shape, a duplicate ID, a
 * foreign tenant reference, or a credential field is an error, never a
 * best-effort coercion. A partially-valid classroom is not rendered.
 */

/**
 * Section 4: "Every written student document must have exactly: id, name,
 * balance, frozen, transactions". Exact, not minimum — a write carrying any
 * further key is rejected before it leaves the client.
 */
export const STUDENT_DOCUMENT_FIELDS = Object.freeze([
  "id",
  "name",
  "balance",
  "frozen",
  "transactions"
]);

/**
 * The keys a client may ever cause to change on an existing student document.
 * `id` is immutable and is therefore absent here even though it is a required
 * document field.
 */
export const STUDENT_MUTABLE_FIELDS = Object.freeze([
  "name",
  "balance",
  "frozen",
  "transactions"
]);

/** Section 4: the classroom root accepts only these client-writable keys. */
export const CLASSROOM_ROOT_FIELDS = Object.freeze([
  "settings",
  "lastBackupAt",
  "updatedAt"
]);

export const TRANSACTION_DOCUMENT_FIELDS = Object.freeze([
  "id",
  "date",
  "studentId",
  "studentName",
  "type",
  "amount",
  "reason",
  "memo",
  "category",
  "status",
  "source"
]);

export const LOGIN_HISTORY_DOCUMENT_FIELDS = Object.freeze([
  "id",
  "date",
  "studentId",
  "studentName",
  "result",
  "note"
]);

/**
 * Fields that identify or authenticate a student. Section 4: "No write payload
 * or cache envelope may contain `pin`, `pinHash`, `loginId`, `authUid`,
 * credential activation, or lockout state."
 *
 * Enforced in BOTH directions. Inbound, a credential field in a student
 * document means a rules or migration defect and must fail loudly rather than
 * be silently dropped into the render path. Outbound, it must never be written.
 */
export const FORBIDDEN_CREDENTIAL_FIELDS = Object.freeze([
  "pin",
  "pinHash",
  "pinSalt",
  "loginId",
  "authUid",
  "credentialActive",
  "active",
  "lockedUntil",
  "failedAttempts",
  "lockoutCount",
  "token",
  "password",
  "passwordHash"
]);

export const LOGIN_HISTORY_LIMIT = 500;

export const PROJECTION_CATEGORIES = Object.freeze({
  SHAPE: "shape",
  TENANT: "tenant",
  DUPLICATE: "duplicate",
  CREDENTIAL: "credential",
  REFERENCE: "reference"
});

export class TenantProjectionError extends Error {
  constructor(category, message, details = {}) {
    super(message);
    this.name = "TenantProjectionError";
    this.category = category;
    this.details = details;
  }
}

function fail(category, message, details) {
  throw new TenantProjectionError(category, message, details);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i]);
}

/**
 * A credential field anywhere in a document body is fatal. Checked before any
 * other field validation so the error names the real problem rather than
 * reporting an unexpected extra key.
 */
function assertNoCredentialFields(record, where) {
  if (!isPlainObject(record)) return;
  for (const field of FORBIDDEN_CREDENTIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      // The field NAME is reported; the value never is.
      fail(
        PROJECTION_CATEGORIES.CREDENTIAL,
        `${where} must not carry credential field "${field}".`,
        { where, field }
      );
    }
  }
}

/**
 * Student IDs are positive safe integers. Firestore document IDs are strings,
 * so an ID arriving as `"7"` is normalized to `7` — but only when the string is
 * an exact canonical decimal. `"07"`, `" 7"`, `"7.0"`, and `"7e0"` are refused:
 * each would map two distinct document IDs onto one student and silently merge
 * two records.
 */
function normalizeStudentId(value, where) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail(PROJECTION_CATEGORIES.SHAPE, `${where} has a non-positive or unsafe student id.`, { where });
    }
    return value;
  }
  if (typeof value === "string") {
    if (!/^[1-9][0-9]*$/.test(value)) {
      fail(PROJECTION_CATEGORIES.SHAPE, `${where} has a non-canonical student id.`, { where });
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      fail(PROJECTION_CATEGORIES.SHAPE, `${where} has an unsafe student id.`, { where });
    }
    return parsed;
  }
  fail(PROJECTION_CATEGORIES.SHAPE, `${where} has a missing or non-scalar student id.`, { where });
  return null;
}

function requireString(value, where, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    fail(PROJECTION_CATEGORIES.SHAPE, `${where} field "${field}" must be a string.`, { where, field });
  }
  if (!allowEmpty && !value.trim()) {
    fail(PROJECTION_CATEGORIES.SHAPE, `${where} field "${field}" must not be empty.`, { where, field });
  }
  return value;
}

function requireFiniteNumber(value, where, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(PROJECTION_CATEGORIES.SHAPE, `${where} field "${field}" must be a finite number.`, { where, field });
  }
  return value;
}

function requireBoolean(value, where, field) {
  if (typeof value !== "boolean") {
    fail(PROJECTION_CATEGORIES.SHAPE, `${where} field "${field}" must be a boolean.`, { where, field });
  }
  return value;
}

/**
 * Every document read must carry the classroom it was read from, and it must
 * be the classroom the session resolved. Section 4 requires rejecting "foreign
 * paths before render or cache admission" — a document surfacing under another
 * tenant's ID is an isolation failure, not a recoverable read.
 */
function requireTenantMatch(documentClassroomId, expectedClassroomId, where) {
  if (typeof expectedClassroomId !== "string" || !expectedClassroomId.trim()) {
    fail(PROJECTION_CATEGORIES.TENANT, "A resolved classroom id is required to project tenant data.", { where });
  }
  if (documentClassroomId === undefined || documentClassroomId === null) return;
  if (typeof documentClassroomId !== "string" || documentClassroomId !== expectedClassroomId) {
    fail(
      PROJECTION_CATEGORIES.TENANT,
      `${where} belongs to a different classroom than the resolved tenant.`,
      { where }
    );
  }
}

function projectStudent(raw, expectedClassroomId, index) {
  const where = `students[${index}]`;
  if (!isPlainObject(raw)) {
    fail(PROJECTION_CATEGORIES.SHAPE, `${where} must be an object.`, { where });
  }
  assertNoCredentialFields(raw, where);
  requireTenantMatch(raw.classroomId, expectedClassroomId, where);
  if (!hasExactKeys(raw, STUDENT_DOCUMENT_FIELDS)) {
    fail(
      PROJECTION_CATEGORIES.SHAPE,
      `${where} does not match the exact student field contract.`,
      { where }
    );
  }

  const id = normalizeStudentId(raw.id, where);
  const name = requireString(raw.name, where, "name");
  const balance = requireFiniteNumber(raw.balance, where, "balance");
  const frozen = requireBoolean(raw.frozen, where, "frozen");

  // `transactions` is the required per-student mirror. It must be present and
  // an array; an absent mirror would render a student whose history silently
  // disappears, and a later save would then persist that loss.
  if (!Array.isArray(raw.transactions)) {
    fail(PROJECTION_CATEGORIES.SHAPE, `${where} field "transactions" must be an array.`, { where });
  }

  const transactions = [];
  const seenTransactionIds = new Set();
  const knownStudentIds = new Set([id]);
  for (let transactionIndex = 0; transactionIndex < raw.transactions.length; transactionIndex += 1) {
    const transaction = projectTransaction(
      raw.transactions[transactionIndex],
      expectedClassroomId,
      transactionIndex,
      knownStudentIds,
      `${where}.transactions[${transactionIndex}]`
    );
    if (seenTransactionIds.has(transaction.id)) {
      fail(
        PROJECTION_CATEGORIES.DUPLICATE,
        `${where} repeats transaction mirror id ${transaction.id}.`,
        { where }
      );
    }
    seenTransactionIds.add(transaction.id);
    transactions.push(transaction);
  }

  return { id, name, balance, frozen, transactions };
}

function projectTransaction(
  raw,
  expectedClassroomId,
  index,
  knownStudentIds,
  where = `transactions[${index}]`
) {
  if (!isPlainObject(raw)) {
    fail(PROJECTION_CATEGORIES.SHAPE, `${where} must be an object.`, { where });
  }
  assertNoCredentialFields(raw, where);
  requireTenantMatch(raw.classroomId, expectedClassroomId, where);

  if (!hasExactKeys(stripTenantKey(raw), TRANSACTION_DOCUMENT_FIELDS)) {
    fail(
      PROJECTION_CATEGORIES.SHAPE,
      `${where} does not match the exact transaction field contract.`,
      { where }
    );
  }

  const studentId = normalizeStudentId(raw.studentId, where);
  // A transaction referencing a student outside this roster is an inconsistent
  // reference, which Section 4 requires rejecting before render.
  if (!knownStudentIds.has(studentId)) {
    fail(
      PROJECTION_CATEGORIES.REFERENCE,
      `${where} references a student that is not on this classroom roster.`,
      { where }
    );
  }

  return {
    id: requireTransactionId(raw.id, where),
    date: requireString(raw.date, where, "date"),
    studentId,
    studentName: requireString(raw.studentName, where, "studentName"),
    type: requireString(raw.type, where, "type"),
    amount: requireFiniteNumber(raw.amount, where, "amount"),
    reason: requireString(raw.reason, where, "reason", { allowEmpty: true }),
    memo: requireString(raw.memo, where, "memo", { allowEmpty: true }),
    category: requireString(raw.category, where, "category", { allowEmpty: true }),
    status: requireString(raw.status, where, "status"),
    source: requireString(raw.source, where, "source")
  };
}

function projectLoginHistoryEntry(raw, expectedClassroomId, index, knownStudentIds) {
  const where = `loginHistory[${index}]`;
  if (!isPlainObject(raw)) {
    fail(PROJECTION_CATEGORIES.SHAPE, `${where} must be an object.`, { where });
  }
  assertNoCredentialFields(raw, where);
  requireTenantMatch(raw.classroomId, expectedClassroomId, where);

  if (!hasExactKeys(stripTenantKey(raw), LOGIN_HISTORY_DOCUMENT_FIELDS)) {
    fail(
      PROJECTION_CATEGORIES.SHAPE,
      `${where} does not match the exact login-history field contract.`,
      { where }
    );
  }

  // A failed login legitimately has no student, so `null` is allowed here in a
  // way it is not for a transaction. A non-null value must still resolve.
  let studentId = null;
  if (raw.studentId !== null) {
    studentId = normalizeStudentId(raw.studentId, where);
    if (!knownStudentIds.has(studentId)) {
      fail(
        PROJECTION_CATEGORIES.REFERENCE,
        `${where} references a student that is not on this classroom roster.`,
        { where }
      );
    }
  }

  return {
    id: requireTransactionId(raw.id, where),
    date: requireString(raw.date, where, "date"),
    studentId,
    studentName: requireString(raw.studentName, where, "studentName"),
    result: requireString(raw.result, where, "result"),
    note: requireString(raw.note, where, "note", { allowEmpty: true })
  };
}

/**
 * Transaction and login-history IDs are the legacy `Date.now()` millisecond
 * values, which are safe integers rather than student numbers. They are
 * accepted as a number or as its exact canonical decimal string, on the same
 * reasoning as `normalizeStudentId`.
 */
function requireTransactionId(value, where) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(PROJECTION_CATEGORIES.SHAPE, `${where} has a non-canonical record id.`, { where });
    }
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      fail(PROJECTION_CATEGORIES.SHAPE, `${where} has an unsafe record id.`, { where });
    }
    return parsed;
  }
  fail(PROJECTION_CATEGORIES.SHAPE, `${where} has a missing or non-canonical record id.`, { where });
  return null;
}

/**
 * `classroomId` is a tenant tag carried by stored documents, not part of the
 * field contract the aggregate view uses. It is validated by
 * `requireTenantMatch` and then excluded from the exact-key comparison.
 */
function stripTenantKey(raw) {
  if (!Object.prototype.hasOwnProperty.call(raw, "classroomId")) return raw;
  const { classroomId, ...rest } = raw;
  void classroomId;
  return rest;
}

function projectSettings(raw, defaultSettings) {
  if (raw === undefined || raw === null) return cloneSettings(defaultSettings);
  if (!isPlainObject(raw)) {
    fail(PROJECTION_CATEGORIES.SHAPE, "Classroom settings must be an object.", { where: "settings" });
  }
  assertNoCredentialFields(raw, "settings");

  const merged = { ...cloneSettings(defaultSettings) };
  // The defaults define the known settings schema. When the caller supplies
  // none there is no schema to check against, so stored settings pass through
  // rather than being silently emptied — dropping every key against an absent
  // schema would erase the classroom's settings on load.
  const hasSchema = Object.keys(merged).length > 0;

  for (const [key, value] of Object.entries(raw)) {
    // Against a known schema, an unrecognized key is dropped rather than fatal:
    // settings is an open-ended UI preference bag whose shape legitimately
    // drifts across releases, unlike the four closed document contracts above.
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      if (hasSchema) continue;
      merged[key] = Array.isArray(value) ? [...value] : value;
      continue;
    }
    if (Array.isArray(merged[key])) {
      if (!Array.isArray(value)) continue;
      merged[key] = value.filter(entry => typeof entry === "string");
      continue;
    }
    if (typeof merged[key] === "boolean") {
      if (typeof value !== "boolean") continue;
      merged[key] = value;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function cloneSettings(settings) {
  if (!isPlainObject(settings)) return {};
  const clone = {};
  for (const [key, value] of Object.entries(settings)) {
    clone[key] = Array.isArray(value) ? [...value] : value;
  }
  return clone;
}

function transactionBodiesEqual(left, right) {
  return TRANSACTION_DOCUMENT_FIELDS.every(field => left[field] === right[field]);
}

function assertTransactionMirrorParity(students, transactions) {
  const authoritativeByStudent = new Map(students.map(student => [student.id, new Map()]));
  for (const transaction of transactions) {
    authoritativeByStudent.get(transaction.studentId).set(transaction.id, transaction);
  }

  for (const student of students) {
    const authoritative = authoritativeByStudent.get(student.id);
    if (student.transactions.length !== authoritative.size) {
      fail(
        PROJECTION_CATEGORIES.REFERENCE,
        `Student ${student.id} has a transaction mirror that disagrees with the classroom ledger.`,
        { where: `students/${student.id}/transactions` }
      );
    }
    for (const mirrored of student.transactions) {
      const canonical = authoritative.get(mirrored.id);
      if (!canonical || !transactionBodiesEqual(mirrored, canonical)) {
        fail(
          PROJECTION_CATEGORIES.REFERENCE,
          `Student ${student.id} has a transaction mirror that disagrees with the classroom ledger.`,
          { where: `students/${student.id}/transactions` }
        );
      }
    }
  }
}

/**
 * Rebuild the aggregate view model from separately-read V2 documents.
 *
 * Throws `TenantProjectionError` on any shape, tenant, duplicate, reference, or
 * credential violation. The caller must treat a throw as "do not render, do not
 * cache" — a partially-valid classroom is never returned.
 */
export function projectClassroomData({
  classroomId,
  root,
  students,
  transactions,
  loginHistory,
  defaultSettings = {}
} = {}) {
  if (typeof classroomId !== "string" || !classroomId.trim()) {
    fail(PROJECTION_CATEGORIES.TENANT, "A resolved classroom id is required to project tenant data.", {});
  }
  if (root !== null && root !== undefined && !isPlainObject(root)) {
    fail(PROJECTION_CATEGORIES.SHAPE, "The classroom root document must be an object when present.", { where: "root" });
  }
  for (const [name, value] of [
    ["students", students],
    ["transactions", transactions],
    ["loginHistory", loginHistory]
  ]) {
    if (!Array.isArray(value)) {
      fail(PROJECTION_CATEGORIES.SHAPE, `"${name}" must be an array of documents.`, { where: name });
    }
  }

  if (root) {
    assertNoCredentialFields(root, "root");
    requireTenantMatch(root.classroomId, classroomId, "root");
  }

  const projectedStudents = [];
  const seenStudentIds = new Set();
  for (let index = 0; index < students.length; index += 1) {
    const student = projectStudent(students[index], classroomId, index);
    if (seenStudentIds.has(student.id)) {
      fail(
        PROJECTION_CATEGORIES.DUPLICATE,
        `students[${index}] repeats student id ${student.id}.`,
        { where: `students[${index}]` }
      );
    }
    seenStudentIds.add(student.id);
    projectedStudents.push(student);
  }

  const projectedTransactions = [];
  const seenTransactionIds = new Set();
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = projectTransaction(transactions[index], classroomId, index, seenStudentIds);
    if (seenTransactionIds.has(transaction.id)) {
      fail(
        PROJECTION_CATEGORIES.DUPLICATE,
        `transactions[${index}] repeats record id ${transaction.id}.`,
        { where: `transactions[${index}]` }
      );
    }
    seenTransactionIds.add(transaction.id);
    projectedTransactions.push(transaction);
  }

  const projectedHistory = [];
  const seenHistoryIds = new Set();
  for (let index = 0; index < loginHistory.length; index += 1) {
    const entry = projectLoginHistoryEntry(loginHistory[index], classroomId, index, seenStudentIds);
    if (seenHistoryIds.has(entry.id)) {
      fail(
        PROJECTION_CATEGORIES.DUPLICATE,
        `loginHistory[${index}] repeats record id ${entry.id}.`,
        { where: `loginHistory[${index}]` }
      );
    }
    seenHistoryIds.add(entry.id);
    projectedHistory.push(entry);
  }

  // The legacy view renders newest-first and the UI relies on that ordering.
  // Sorting here rather than depending on read order keeps the aggregate
  // deterministic regardless of how the service paginated.
  projectedTransactions.sort((a, b) => b.id - a.id);
  projectedHistory.sort((a, b) => b.id - a.id);
  assertTransactionMirrorParity(projectedStudents, projectedTransactions);

  const lastBackupAt = root && root.lastBackupAt !== undefined && root.lastBackupAt !== null
    ? requireString(root.lastBackupAt, "root", "lastBackupAt")
    : null;

  return {
    students: projectedStudents,
    transactions: projectedTransactions,
    loginHistory: projectedHistory.slice(0, LOGIN_HISTORY_LIMIT),
    settings: projectSettings(root ? root.settings : null, defaultSettings),
    lastBackupAt
  };
}

/**
 * Decompose an aggregate mutation into per-path write intents.
 *
 * Returns `{ root, students, transactions, loginHistory, deletes }`. Each entry
 * is `{ path, id, body }` with `body` already reduced to its exact field
 * contract, so the service layer writes what this function produced and never
 * re-derives a payload from the aggregate.
 *
 * Deletion of a student document is NOT produced here: Section 5 makes student
 * creation and deletion server-only. A student missing from the aggregate is
 * simply not written; `removeStudentV2` owns its removal.
 */
export function decomposeClassroomMutation({
  classroomId,
  data,
  previous = null,
  maxWrites = 400
} = {}) {
  if (typeof classroomId !== "string" || !classroomId.trim()) {
    fail(PROJECTION_CATEGORIES.TENANT, "A resolved classroom id is required to decompose a mutation.", {});
  }
  if (!isPlainObject(data)) {
    fail(PROJECTION_CATEGORIES.SHAPE, "A mutation requires an aggregate data object.", { where: "data" });
  }

  if (!Array.isArray(data.students) ||
      !Array.isArray(data.transactions) ||
      !Array.isArray(data.loginHistory)) {
    fail(
      PROJECTION_CATEGORIES.SHAPE,
      "A mutation requires student, transaction, and login-history arrays.",
      { where: "data" }
    );
  }
  const students = data.students;
  const transactions = data.transactions;
  const loginHistory = data.loginHistory;

  const previousStudents = new Map();
  if (previous && Array.isArray(previous.students)) {
    for (const student of previous.students) {
      if (isPlainObject(student)) {
        const id = normalizeStudentId(student.id, "previous.students");
        previousStudents.set(id, student);
      }
    }
  }

  const seenStudentIds = new Set();
  const projectedStudents = [];
  for (let index = 0; index < students.length; index += 1) {
    const where = `students[${index}]`;
    const projected = projectStudent(students[index], classroomId, index);
    const id = projected.id;
    if (seenStudentIds.has(id)) {
      fail(PROJECTION_CATEGORIES.DUPLICATE, `${where} repeats student id ${id}.`, { where });
    }
    seenStudentIds.add(id);
    projectedStudents.push(projected);
  }

  const projectedTransactions = [];
  const seenTransactionIds = new Set();
  for (let index = 0; index < transactions.length; index += 1) {
    const projected = projectTransaction(
      transactions[index],
      classroomId,
      index,
      seenStudentIds
    );
    if (seenTransactionIds.has(projected.id)) {
      fail(
        PROJECTION_CATEGORIES.DUPLICATE,
        `transactions[${index}] repeats record id ${projected.id}.`,
        { where: `transactions[${index}]` }
      );
    }
    seenTransactionIds.add(projected.id);
    projectedTransactions.push(projected);
  }

  const projectedHistory = [];
  const seenHistoryIds = new Set();
  for (let index = 0; index < loginHistory.length; index += 1) {
    const projected = projectLoginHistoryEntry(
      loginHistory[index],
      classroomId,
      index,
      seenStudentIds
    );
    if (seenHistoryIds.has(projected.id)) {
      fail(
        PROJECTION_CATEGORIES.DUPLICATE,
        `loginHistory[${index}] repeats record id ${projected.id}.`,
        { where: `loginHistory[${index}]` }
      );
    }
    seenHistoryIds.add(projected.id);
    projectedHistory.push(projected);
  }

  const studentWrites = [];
  for (const projected of projectedStudents) {
    const id = projected.id;
    const body = {
      id,
      name: projected.name,
      balance: projected.balance,
      frozen: projected.frozen,
      // The top-level transaction collection is the aggregate's authoritative
      // source. Deriving the required per-student mirror here prevents a
      // balance/transaction save from leaving the student's self-read stale.
      transactions: projectedTransactions.filter(transaction => transaction.studentId === id)
    };

    // Only write students that actually changed. This is what keeps an
    // ordinary single-student edit inside the bounded write budget instead of
    // rewriting the whole roster on every save.
    const before = previousStudents.get(id);
    if (before && !studentBodyChanged(before, body)) continue;

    studentWrites.push({
      path: `classrooms/${classroomId}/students/${id}`,
      id: String(id),
      body
    });
  }

  const transactionWrites = collectRecordWrites({
    records: projectedTransactions,
    classroomId,
    collection: "transactions",
    fields: TRANSACTION_DOCUMENT_FIELDS,
    previous: previous && Array.isArray(previous.transactions) ? previous.transactions : null,
    label: "transactions"
  });

  const historyWrites = collectRecordWrites({
    records: projectedHistory.slice(0, LOGIN_HISTORY_LIMIT),
    classroomId,
    collection: "loginHistory",
    fields: LOGIN_HISTORY_DOCUMENT_FIELDS,
    previous: previous && Array.isArray(previous.loginHistory) ? previous.loginHistory : null,
    label: "loginHistory"
  });

  // Login history is explicitly capped and trimmed by the UI. A record that was
  // present before and is now beyond the cap must actually be deleted, or the
  // stored collection grows without bound and diverges from the rendered view.
  const historyDeletes = [];
  if (previous && Array.isArray(previous.loginHistory)) {
    const retained = new Set(historyWrites.map(entry => entry.id));
    for (const entry of projectedHistory.slice(0, LOGIN_HISTORY_LIMIT)) {
      retained.add(String(entry.id));
    }
    for (const entry of previous.loginHistory) {
      if (!isPlainObject(entry)) continue;
      const id = String(requireTransactionId(entry.id, "previous.loginHistory"));
      if (retained.has(id)) continue;
      historyDeletes.push({
        path: `classrooms/${classroomId}/loginHistory/${id}`,
        id
      });
    }
  }

  const root = buildRootPatch(classroomId, data, previous);

  const totalWrites =
    (root ? 1 : 0) +
    studentWrites.length +
    transactionWrites.length +
    historyWrites.length +
    historyDeletes.length;

  if (totalWrites > maxWrites) {
    fail(
      PROJECTION_CATEGORIES.SHAPE,
      `A single mutation may not exceed ${maxWrites} document writes.`,
      { totalWrites, maxWrites }
    );
  }

  return {
    root,
    students: studentWrites,
    transactions: transactionWrites,
    loginHistory: historyWrites,
    deletes: historyDeletes,
    totalWrites
  };
}

function studentBodyChanged(before, body) {
  for (const field of STUDENT_MUTABLE_FIELDS) {
    if (field === "transactions") {
      if (JSON.stringify(before.transactions ?? []) !== JSON.stringify(body.transactions)) return true;
      continue;
    }
    if (before[field] !== body[field]) return true;
  }
  return false;
}

function collectRecordWrites({ records, classroomId, collection, fields, previous, label }) {
  const previousById = new Map();
  if (previous) {
    for (const record of previous) {
      if (isPlainObject(record)) {
        previousById.set(String(requireTransactionId(record.id, `previous.${label}`)), record);
      }
    }
  }

  const seen = new Set();
  const writes = [];
  for (let index = 0; index < records.length; index += 1) {
    const where = `${label}[${index}]`;
    const raw = records[index];
    if (!isPlainObject(raw)) {
      fail(PROJECTION_CATEGORIES.SHAPE, `${where} must be an object.`, { where });
    }
    assertNoCredentialFields(raw, where);

    const body = {};
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(raw, field)) {
        fail(PROJECTION_CATEGORIES.SHAPE, `${where} is missing required field "${field}".`, { where, field });
      }
      body[field] = raw[field];
    }
    if (!hasExactKeys(stripTenantKey(raw), fields)) {
      fail(PROJECTION_CATEGORIES.SHAPE, `${where} does not match its exact field contract.`, { where });
    }

    // Canonical deterministic document ID: the record's own immutable id. Using
    // the record id rather than an auto-ID is what makes a retried save
    // idempotent instead of duplicating the record.
    const id = String(requireTransactionId(raw.id, where));
    if (seen.has(id)) {
      fail(PROJECTION_CATEGORIES.DUPLICATE, `${where} repeats record id ${id}.`, { where });
    }
    seen.add(id);

    const before = previousById.get(id);
    if (before && JSON.stringify(pick(before, fields)) === JSON.stringify(body)) continue;

    writes.push({ path: `classrooms/${classroomId}/${collection}/${id}`, id, body });
  }
  return writes;
}

function pick(record, fields) {
  const picked = {};
  for (const field of fields) picked[field] = record[field];
  return picked;
}

function buildRootPatch(classroomId, data, previous) {
  const settings = isPlainObject(data.settings) ? data.settings : null;
  const lastBackupAt = data.lastBackupAt ?? null;

  if (settings) assertNoCredentialFields(settings, "settings");

  if (previous) {
    const settingsUnchanged =
      JSON.stringify(isPlainObject(previous.settings) ? previous.settings : null) === JSON.stringify(settings);
    const backupUnchanged = (previous.lastBackupAt ?? null) === lastBackupAt;
    if (settingsUnchanged && backupUnchanged) return null;
  }

  const body = {};
  if (settings) body.settings = settings;
  if (lastBackupAt !== null) {
    body.lastBackupAt = requireString(lastBackupAt, "root", "lastBackupAt");
  }
  if (Object.keys(body).length === 0) return null;

  for (const key of Object.keys(body)) {
    if (!CLASSROOM_ROOT_FIELDS.includes(key)) {
      fail(PROJECTION_CATEGORIES.SHAPE, `The classroom root may not be written with key "${key}".`, { key });
    }
  }

  return { path: `classrooms/${classroomId}`, id: classroomId, body };
}

/**
 * Reduce the aggregate to the PIN-free backup body Section 4 requires for V2
 * export. Throws if a credential field is present rather than stripping it: a
 * silent strip would let a real leak pass a test that only checked the output.
 */
export function projectBackupExport({ data, exportedAt } = {}) {
  if (!isPlainObject(data)) {
    fail(PROJECTION_CATEGORIES.SHAPE, "A backup export requires an aggregate data object.", { where: "data" });
  }
  requireString(exportedAt, "backup", "exportedAt");

  const students = Array.isArray(data.students) ? data.students : [];
  const exportedStudents = students.map((student, index) => {
    const where = `students[${index}]`;
    if (!isPlainObject(student)) {
      fail(PROJECTION_CATEGORIES.SHAPE, `${where} must be an object.`, { where });
    }
    assertNoCredentialFields(student, where);
    return {
      id: normalizeStudentId(student.id, where),
      name: requireString(student.name, where, "name"),
      balance: requireFiniteNumber(student.balance, where, "balance"),
      frozen: requireBoolean(student.frozen, where, "frozen"),
      transactions: Array.isArray(student.transactions) ? student.transactions : []
    };
  });

  for (const [label, records] of [
    ["transactions", data.transactions],
    ["loginHistory", data.loginHistory]
  ]) {
    if (!Array.isArray(records)) continue;
    records.forEach((record, index) => assertNoCredentialFields(record, `${label}[${index}]`));
  }

  return {
    students: exportedStudents,
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
    loginHistory: Array.isArray(data.loginHistory) ? data.loginHistory : [],
    settings: isPlainObject(data.settings) ? data.settings : {},
    exportedAt
  };
}

/**
 * Project the single-student view a signed-in V2 student is allowed to see.
 * The student's own document plus its transaction mirror — never the roster,
 * never another student's record, never a credential.
 */
export function projectStudentSelfData({
  classroomId,
  studentId,
  student,
  defaultSettings = {}
} = {}) {
  if (typeof classroomId !== "string" || !classroomId.trim()) {
    fail(PROJECTION_CATEGORIES.TENANT, "A resolved classroom id is required to project student data.", {});
  }
  const expectedId = normalizeStudentId(studentId, "studentSelf");
  const projectedStudent = projectStudent(student, classroomId, 0);
  const actualId = projectedStudent.id;
  // The claim and the document must name the same student. A mismatch means
  // the read resolved someone else's record and must fail closed.
  if (actualId !== expectedId) {
    fail(
      PROJECTION_CATEGORIES.TENANT,
      "The student document does not match the authenticated student claim.",
      { where: "studentSelf" }
    );
  }

  return {
    students: [projectedStudent],
    transactions: projectedStudent.transactions,
    loginHistory: [],
    settings: cloneSettings(defaultSettings),
    lastBackupAt: null
  };
}
