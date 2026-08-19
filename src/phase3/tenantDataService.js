/**
 * Phase 3 Commit 7 — tenant data service.
 *
 * The production V2 data adapters. Before this module the client referenced
 * `window.V2_TENANT_DATA_ADAPTER` / `window.V2_TENANT_DATA_SAVE_ADAPTER`, which
 * only the Item 10 browser harness ever defined; in V2 mode production had no
 * data layer at all. This module supplies it.
 *
 * Every Firestore primitive is injected rather than imported. A unit test can
 * therefore exercise the real read/write decisions without constructing a
 * Firebase handle, loading a credential, or reaching a network — which is what
 * keeps `test:phase3:unit` emulator-free and makes real-project access
 * impossible from tests.
 *
 * Boundaries this module holds:
 *  - it reads and writes ONLY under `classrooms/{resolvedClassroomId}/...`;
 *  - it never touches `studentCredentials` in either the flat or scoped shape;
 *  - it never creates or deletes a student document (Section 5: server-only);
 *  - it validates the session's captured identity before AND after every await
 *    that precedes an effect, so a stale completion cannot write; and
 *  - it fails closed, surfacing a `TenantProjectionError` rather than a partial
 *    classroom.
 */

import {
  decomposeClassroomMutation,
  projectClassroomData,
  projectStudentSelfData,
  TenantProjectionError
} from "./tenantDataProjection.js";

export class TenantDataServiceError extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = "TenantDataServiceError";
    this.reason = reason;
    this.details = details;
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TenantDataServiceError(
      "missing-firestore-adapter",
      `Firestore adapter "${name}" is required.`
    );
  }
  return value;
}

/**
 * Resolve the classroom this call is allowed to touch.
 *
 * Fail-closed on tenant/auth inconsistency (Section 4 and the Commit 7
 * requirements): the caller-supplied classroom id, the session's resolved
 * classroom, and the authenticated UID must all be present and mutually
 * consistent. A caller passing a different classroom than the session resolved
 * is a tenant-isolation failure, not a hint.
 */
function resolveTenant(session, { uid, classroomId } = {}) {
  if (!session || typeof session.captureIdentity !== "function") {
    throw new TenantDataServiceError("missing-session", "A tenant session is required.");
  }

  const rawSessionClassroomId = typeof session.classroomId === "string" ? session.classroomId : "";
  if (!rawSessionClassroomId) {
    throw new TenantDataServiceError(
      "unresolved-tenant",
      "The session has no resolved classroom."
    );
  }
  const sessionClassroomId = requireCanonicalClassroomId(rawSessionClassroomId);

  if (classroomId !== undefined && classroomId !== null) {
    const requested = requireCanonicalClassroomId(classroomId);
    if (requested !== sessionClassroomId) {
      throw new TenantDataServiceError(
        "tenant-mismatch",
        "The requested classroom does not match the resolved tenant."
      );
    }
  }

  const sessionUid = typeof session.uid === "string" ? session.uid.trim() : "";
  if (!sessionUid) {
    throw new TenantDataServiceError("unresolved-identity", "The session has no resolved identity.");
  }
  if (uid !== undefined && uid !== null) {
    const requested = typeof uid === "string" ? uid.trim() : "";
    if (!requested || requested !== sessionUid) {
      throw new TenantDataServiceError(
        "identity-mismatch",
        "The requesting identity does not match the resolved session identity."
      );
    }
  }

  return { classroomId: sessionClassroomId, uid: sessionUid };
}

/**
 * A read or write that completed after the tenant changed must produce no
 * effect. The orchestrators in `tenantClient.js` already gate their own state
 * application on the captured identity; this check makes the service itself
 * refuse to *write* under a stale identity, which the orchestrator cannot undo
 * once a document has been committed.
 */
function assertIdentityUnchanged(session, captured) {
  if (!session.validateCapturedIdentity(captured)) {
    throw new TenantDataServiceError(
      "stale-identity",
      "The tenant identity changed before the operation could complete."
    );
  }
}

function assertSessionRole(session, expectedRole) {
  if (session?.role !== expectedRole) {
    throw new TenantDataServiceError(
      "role-mismatch",
      `The tenant data operation requires the ${expectedRole} role.`
    );
  }
}

function requireCanonicalStudentId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new TenantDataServiceError(
      "invalid-student-id",
      "The student claim does not contain a canonical student id."
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TenantDataServiceError(
      "invalid-student-id",
      "The student claim does not contain a safe student id."
    );
  }
  return value;
}

function requireCanonicalClassroomId(value) {
  if (typeof value !== "string" || !value || value !== value.trim() ||
      value === "." || value === ".." || value.includes("/") ||
      /^__[\s\S]*__$/.test(value) || !isWellFormedUnicode(value) ||
      new TextEncoder().encode(value).length > 1500) {
    throw new TenantDataServiceError(
      "invalid-classroom-id",
      "The classroom identity is not canonical."
    );
  }
  return value;
}

function isWellFormedUnicode(value) {
  if (typeof String.prototype.isWellFormed === "function") {
    return value.isWellFormed();
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xDC00 || nextCodeUnit > 0xDFFF) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

/**
 * Build the production `loadNetworkFn` adapter: read the classroom root, the
 * narrowly scoped student rent display, and the three tenant collections, then
 * project them into the aggregate view.
 *
 * Credentials are never in the read set. There is no `studentCredentials`
 * reference anywhere in this function, so no read path can surface one even if
 * rules were misconfigured.
 */
export function createTenantDataLoader({
  db,
  session,
  firestore,
  defaultSettings = {}
}) {
  const doc = requireFunction(firestore?.doc, "doc");
  const getDoc = requireFunction(firestore?.getDoc, "getDoc");
  const collection = requireFunction(firestore?.collection, "collection");
  const getDocs = requireFunction(firestore?.getDocs, "getDocs");

  return async function loadTenantClassroomData(request = {}) {
    const { classroomId } = resolveTenant(session, request);
    assertSessionRole(session, "teacher");
    const captured = session.captureIdentity();

    const [rootSnapshot, rentSnapshot, studentsSnapshot, transactionsSnapshot, historySnapshot] = await Promise.all([
      getDoc(doc(db, `classrooms/${classroomId}`)),
      getDoc(doc(db, `classrooms/${classroomId}/studentDisplay/rent`)),
      getDocs(collection(db, `classrooms/${classroomId}/students`)),
      getDocs(collection(db, `classrooms/${classroomId}/transactions`)),
      getDocs(collection(db, `classrooms/${classroomId}/loginHistory`))
    ]);

    // A read that landed after a tenant switch must not be projected or
    // returned; the caller would otherwise cache it under the new tenant.
    assertIdentityUnchanged(session, captured);

    const root = readSnapshotData(rootSnapshot);
    if (!root) {
      throw new TenantDataServiceError(
        "classroom-root-missing",
        "The resolved classroom root document is missing."
      );
    }

    return projectClassroomData({
      classroomId,
      root,
      studentRent: readSnapshotData(rentSnapshot),
      students: readCollectionData(studentsSnapshot, "students"),
      transactions: readCollectionData(transactionsSnapshot, "transactions"),
      loginHistory: readCollectionData(historySnapshot, "loginHistory"),
      defaultSettings
    });
  };
}

/**
 * Build the production `loadStudentNetworkFn` adapter. A signed-in V2 student
 * reads exactly their own student document plus the classroom's narrowly
 * allowlisted rent display document. The classroom root, roster, other
 * students, transactions collection, and login history remain unreadable.
 */
export function createStudentDataLoader({ db, session, firestore, defaultSettings = {} }) {
  const doc = requireFunction(firestore?.doc, "doc");
  const getDoc = requireFunction(firestore?.getDoc, "getDoc");

  return async function loadTenantStudentData({ uid, classroomId, studentId } = {}) {
    // The student path runs while the session is still RESOLVING, so the
    // session's own classroom is not yet set. Validate the claims against each
    // other and require both, rather than against a resolved tenant that does
    // not exist yet.
    const tenant = typeof classroomId === "string" ? classroomId : "";
    const student = typeof studentId === "string" ? studentId : "";
    const identity = typeof uid === "string" ? uid : "";
    if (!tenant || !student || !identity) {
      throw new TenantDataServiceError(
        "incomplete-student-claims",
        "Student classroom, student id, and uid claims are all required."
      );
    }

    requireCanonicalClassroomId(tenant);
    if (identity !== identity.trim()) {
      throw new TenantDataServiceError(
        "identity-mismatch",
        "The requesting identity is not canonical."
      );
    }

    assertSessionRole(session, "student");
    const sessionUid = typeof session.uid === "string" ? session.uid.trim() : "";
    if (!sessionUid || sessionUid !== identity) {
      throw new TenantDataServiceError(
        "identity-mismatch",
        "The requesting identity does not match the student session."
      );
    }
    if (session.classroomId && session.classroomId !== tenant) {
      throw new TenantDataServiceError(
        "tenant-mismatch",
        "The student claim does not match the resolved tenant."
      );
    }
    requireCanonicalStudentId(student);

    const captured = session.captureIdentity();
    const [snapshot, rentSnapshot] = await Promise.all([
      getDoc(doc(db, `classrooms/${tenant}/students/${student}`)),
      getDoc(doc(db, `classrooms/${tenant}/studentDisplay/rent`))
    ]);
    assertIdentityUnchanged(session, captured);

    const body = readSnapshotData(snapshot);
    if (!body) {
      throw new TenantDataServiceError(
        "student-document-missing",
        "The authenticated student has no classroom record."
      );
    }

    return projectStudentSelfData({
      classroomId: tenant,
      studentId: student,
      student: body,
      studentRent: readSnapshotData(rentSnapshot),
      defaultSettings
    });
  };
}

/**
 * Build the production `V2_TENANT_DATA_SAVE_ADAPTER`.
 *
 * The aggregate is decomposed by path and applied through one bounded Firestore
 * transaction. The classroom root receives only teacher settings,
 * `lastBackupAt`, and a server-side `updatedAt`; the studentDisplay/rent document
 * receives only the safe rent amount and its timestamp; students receive only
 * their exact five-field body. Transactions and login history use canonical
 * deterministic IDs so a retry is idempotent rather than duplicating records.
 *
 * `previousRef` supplies the last-known-persisted aggregate so unchanged
 * documents are skipped. It is read through a getter because the caller holds
 * it in a mutable module-level variable.
 */
export function createTenantDataSaver({
  db,
  session,
  firestore,
  previousRef = null,
  // Firestore caps an atomic commit at 500 operations; 400 leaves headroom and is
  // also the maximum logical mutation size. A logical balance/history change
  // must never be split across commits.
  maxBatchSize = 400,
  maxWrites = 400,
  nowFn = () => new Date().toISOString()
}) {
  const doc = requireFunction(firestore?.doc, "doc");
  const runTransaction = requireFunction(firestore?.runTransaction, "runTransaction");

  return async function saveTenantClassroomData(data, capturedIdentity) {
    // The orchestrator captured the identity BEFORE it awaited. Honor that
    // target: it is the tenant whose data this write belongs to.
    const captured = capturedIdentity || session.captureIdentity();

    // Staleness is checked BEFORE tenant resolution. An invalidated session has
    // already cleared its classroom, so resolving first would report
    // "unresolved-tenant" and mask the real cause — a stale write attempt.
    // Both refuse the write; only this order names it correctly.
    assertIdentityUnchanged(session, captured);

    const { classroomId } = resolveTenant(session, { classroomId: captured?.classroomId });
    assertSessionRole(session, "teacher");

    const previous = typeof previousRef === "function" ? previousRef() : previousRef;

    const plan = decomposeClassroomMutation({
      classroomId,
      data,
      previous,
      maxWrites
    });

    // The baseline for the concurrency check must be the DOCUMENT the last
    // accepted save wrote, not the aggregate it was derived from. Those differ:
    // a student body's `transactions` mirror is re-derived here from the
    // authoritative top-level ledger, while no teacher code path updates the
    // aggregate's per-student copy. Comparing the stored document against the
    // raw aggregate student therefore reports the projection's own intended
    // correction as a concurrent change, and every teacher action following a
    // transaction edit fails once and has to be redone. Re-decomposing the
    // baseline through the same function yields the exact bodies that save
    // persisted. Only students and the ledger they mirror are fed in, so this
    // derivation cannot fail on a part of the baseline it does not read, and
    // `maxWrites` is lifted because it is a derivation, not a write plan — the
    // real plan above is still budget-checked.
    const baselineStudentBodies = new Map();
    const baselineTransactionBodies = new Map();
    if (previous) {
      const baselinePlan = decomposeClassroomMutation({
        classroomId,
        data: {
          students: Array.isArray(previous.students) ? previous.students : [],
          transactions: Array.isArray(previous.transactions) ? previous.transactions : [],
          loginHistory: []
        },
        previous: null,
        maxWrites: Number.MAX_SAFE_INTEGER
      });
      for (const write of baselinePlan.students) {
        baselineStudentBodies.set(write.id, write.body);
      }
      for (const write of baselinePlan.transactions) {
        baselineTransactionBodies.set(write.id, write.body);
      }
    }

    const operations = [];
    if (plan.root) {
      operations.push({
        kind: "set",
        path: plan.root.path,
        body: { ...plan.root.body, updatedAt: nowFn() },
        // The classroom root MUST be merged, never overwritten. It holds
        // server-owned tenant fields the client may not write (`ownerUid`,
        // `name`, activation state); an overwriting set deletes the unlisted
        // ones, which is both data loss and a rules violation — the proposed
        // rules allow a root update only when affectedKeys() is within
        // {settings, lastBackupAt, updatedAt}, and a full overwrite reports every
        // dropped field as affected.
        //
        // This was caught by the Item 10 browser suite against
        // firestore.phase2b.proposed.rules, which denied the write with
        // "false for 'create' @ L102, evaluation error at L103". Unit tests with
        // injected primitives could not have caught it: no rules layer runs
        // there.
        merge: true
      });
    }
    if (plan.studentRent) {
      operations.push({
        kind: "set",
        path: plan.studentRent.path,
        body: { ...plan.studentRent.body, updatedAt: nowFn() },
        merge: false
      });
    }
    // Students, transactions, and login history are overwritten deliberately.
    // Each has an exact-field document contract, and merge would let a field
    // removed from the aggregate survive server-side.
    for (const write of [...plan.students, ...plan.transactions, ...plan.loginHistory]) {
      operations.push({ kind: "set", path: write.path, body: write.body, merge: false });
    }
    for (const removal of plan.deletes) {
      operations.push({ kind: "delete", path: removal.path });
    }

    if (operations.length === 0) {
      return { written: 0, batches: 0, skipped: true };
    }

    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1 ||
        operations.length > maxBatchSize) {
      throw new TenantDataServiceError(
        "mutation-not-atomic",
        "The logical mutation exceeds the atomic batch limit."
      );
    }

    // Re-check immediately before entering the transaction. The callback also
    // checks again after its reads because Firestore may retry it.
    assertIdentityUnchanged(session, captured);

    await runTransaction(db, async transaction => {
      const read = async write => {
        const snapshot = await requireFunction(
          transaction.get?.bind(transaction),
          "transaction.get"
        )(doc(db, write.path));
        return { write, current: readSnapshotData(snapshot) };
      };
      // Every read completes before the first write, as a Firestore transaction
      // requires. Students and the ledger are read together for that reason.
      const [studentChecks, transactionChecks] = await Promise.all([
        Promise.all(plan.students.map(read)),
        Promise.all(plan.transactions.map(read))
      ]);

      const abortOnConcurrentChange = () => {
        throw new TenantDataServiceError(
          "concurrent-classroom-change",
          "The classroom changed after it was loaded."
        );
      };

      // A student callable can commit while the teacher holds an older aggregate.
      // Compare every student this save would overwrite against the document
      // body the last accepted save actually persisted. With no baseline entry
      // at all — a student some other writer created, which this teacher has no
      // confirmed prior state for — only an already-identical body is safe.
      // Any difference aborts the whole logical mutation before a write.
      for (const { write, current } of studentChecks) {
        const expectedCurrent = baselineStudentBodies.get(write.id) || write.body;
        if (!studentBodyEqual(current, expectedCurrent)) abortOnConcurrentChange();
      }

      // The ledger needs the same protection, and checking only students does
      // not provide it. Transaction ids come from the submitting client's
      // `Date.now()`, so a student's committed record and a later teacher record
      // for a DIFFERENT student can collide on id. The teacher's student
      // document then passes its own check while this overwrite replaces the
      // student's ledger record — leaving that student's mirror pointing at a
      // record the ledger no longer contains, which is exactly the divergence
      // that locks the teacher out of every subsequent load.
      for (const { write, current } of transactionChecks) {
        const baseline = baselineTransactionBodies.get(write.id);
        if (baseline === undefined) {
          // A record this teacher has no confirmed prior state for. Absent is
          // the expected case; an identical body is an accepted retry.
          if (current !== null && !exactValueEqual(current, write.body)) {
            abortOnConcurrentChange();
          }
        } else if (!exactValueEqual(current, baseline)) {
          abortOnConcurrentChange();
        }
      }

      assertIdentityUnchanged(session, captured);

      for (const operation of operations) {
        const reference = doc(db, operation.path);
        if (operation.kind === "delete") {
          requireFunction(transaction.delete?.bind(transaction), "transaction.delete")(
            reference
          );
        } else {
          requireFunction(transaction.set?.bind(transaction), "transaction.set")(
            reference,
            operation.body,
            { merge: operation.merge === true }
          );
        }
      }
    });

    return { written: operations.length, batches: 1, skipped: false };
  };
}

/**
 * Compare a stored student document against the body it is expected to hold.
 *
 * Every field is exact except the position of entries within the `transactions`
 * mirror, which is compared as an id-keyed collection. Order is deliberately
 * not part of the equality: the stored mirror keeps whatever order the writer
 * used — the student callable prepends its new record — while the baseline is
 * re-derived from the loader's id-descending ledger. A record whose id is lower
 * than one already stored therefore leaves the two permanently ordered
 * differently, and an order-sensitive comparison reads that as a concurrent
 * change on every save from then on, with no second writer and no way out.
 *
 * Nothing is lost by ignoring position here. A real concurrent write adds,
 * removes, or alters a record, and each of those still fails this comparison.
 */
function studentBodyEqual(current, expected) {
  if (!isPlainRecord(current) || !isPlainRecord(expected)) {
    return exactValueEqual(current, expected);
  }
  const currentKeys = Object.keys(current).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (currentKeys.length !== expectedKeys.length ||
      !currentKeys.every((key, index) => key === expectedKeys[index])) {
    return false;
  }
  for (const key of currentKeys) {
    if (key === "transactions") {
      if (!mirrorEqual(current.transactions, expected.transactions)) return false;
      continue;
    }
    if (!exactValueEqual(current[key], expected[key])) return false;
  }
  return true;
}

function mirrorEqual(current, expected) {
  if (!Array.isArray(current) || !Array.isArray(expected)) {
    return exactValueEqual(current, expected);
  }
  if (current.length !== expected.length) return false;
  const expectedById = new Map();
  for (const entry of expected) {
    // An entry without a usable id cannot be matched by identity, so fall back
    // to the strict positional comparison rather than guessing.
    if (!isPlainRecord(entry) || entry.id === undefined) return exactValueEqual(current, expected);
    if (expectedById.has(String(entry.id))) return exactValueEqual(current, expected);
    expectedById.set(String(entry.id), entry);
  }
  for (const entry of current) {
    if (!isPlainRecord(entry) || entry.id === undefined) return false;
    const match = expectedById.get(String(entry.id));
    if (!match || !exactValueEqual(entry, match)) return false;
  }
  return true;
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactValueEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => exactValueEqual(value, right[index]));
  }
  if (
    typeof left !== "object" || left === null ||
    typeof right !== "object" || right === null
  ) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && exactValueEqual(left[key], right[key])
    );
}

function readSnapshotData(snapshot) {
  if (!snapshot) return null;
  if (typeof snapshot.exists === "function" && !snapshot.exists()) return null;
  if (snapshot.exists === false) return null;
  const data = typeof snapshot.data === "function" ? snapshot.data() : null;
  return data ?? null;
}

function readCollectionData(snapshot, collectionName) {
  const docs = snapshot?.docs;
  if (!Array.isArray(docs)) return [];
  return docs.map(entry => {
    const body = typeof entry.data === "function" ? entry.data() : null;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
    // The path and body must name the same record. Never synthesize a missing
    // body id from the path: exact document contracts require both, and doing so
    // would hide malformed migrated state from the projection.
    if (!Object.prototype.hasOwnProperty.call(body, "id") ||
        typeof entry?.id !== "string" || String(body.id) !== entry.id) {
      throw new TenantDataServiceError(
        "document-id-mismatch",
        `A ${collectionName} document path disagrees with its body identity.`
      );
    }
    return body;
  });
}

export { TenantProjectionError };
