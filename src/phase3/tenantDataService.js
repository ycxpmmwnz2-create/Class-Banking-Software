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

  const sessionClassroomId = typeof session.classroomId === "string" ? session.classroomId.trim() : "";
  if (!sessionClassroomId) {
    throw new TenantDataServiceError(
      "unresolved-tenant",
      "The session has no resolved classroom."
    );
  }

  if (classroomId !== undefined && classroomId !== null) {
    const requested = typeof classroomId === "string" ? classroomId.trim() : "";
    if (!requested || requested !== sessionClassroomId) {
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

/**
 * Build the production `loadNetworkFn` adapter: read the classroom root and the
 * three scoped collections, then project them into the aggregate view.
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

    const [rootSnapshot, studentsSnapshot, transactionsSnapshot, historySnapshot] = await Promise.all([
      getDoc(doc(db, `classrooms/${classroomId}`)),
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
      students: readCollectionData(studentsSnapshot, "students"),
      transactions: readCollectionData(transactionsSnapshot, "transactions"),
      loginHistory: readCollectionData(historySnapshot, "loginHistory"),
      defaultSettings
    });
  };
}

/**
 * Build the production `loadStudentNetworkFn` adapter. A signed-in V2 student
 * reads exactly one document: their own. The roster, other students'
 * documents, the transaction collection, and login history are all outside
 * what a student may read.
 */
export function createStudentDataLoader({ db, session, firestore, defaultSettings = {} }) {
  const doc = requireFunction(firestore?.doc, "doc");
  const getDoc = requireFunction(firestore?.getDoc, "getDoc");

  return async function loadTenantStudentData({ uid, classroomId, studentId } = {}) {
    // The student path runs while the session is still RESOLVING, so the
    // session's own classroom is not yet set. Validate the claims against each
    // other and require both, rather than against a resolved tenant that does
    // not exist yet.
    const tenant = typeof classroomId === "string" ? classroomId.trim() : "";
    const student = typeof studentId === "string" ? studentId.trim() : "";
    const identity = typeof uid === "string" ? uid.trim() : "";
    if (!tenant || !student || !identity) {
      throw new TenantDataServiceError(
        "incomplete-student-claims",
        "Student classroom, student id, and uid claims are all required."
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
    const snapshot = await getDoc(doc(db, `classrooms/${tenant}/students/${student}`));
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
      defaultSettings
    });
  };
}

/**
 * Build the production `V2_TENANT_DATA_SAVE_ADAPTER`.
 *
 * The aggregate is decomposed by path and applied through one bounded atomic batch. The
 * classroom root receives only `settings`, `lastBackupAt`, and a server-side
 * `updatedAt`; students receive only their exact five-field body; transactions
 * and login history are written at canonical deterministic IDs so a retry is
 * idempotent rather than duplicating records.
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
  // Firestore caps a WriteBatch at 500 operations; 400 leaves headroom and is
  // also the maximum logical mutation size. A logical balance/history change
  // must never be split across commits.
  maxBatchSize = 400,
  maxWrites = 400,
  nowFn = () => new Date().toISOString()
}) {
  const doc = requireFunction(firestore?.doc, "doc");
  const writeBatch = requireFunction(firestore?.writeBatch, "writeBatch");

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

    // Re-check immediately before the first commit. Everything above is
    // synchronous, so this closes the window opened by the awaits the caller
    // performed before invoking the adapter.
    assertIdentityUnchanged(session, captured);

    const batch = writeBatch(db);
    for (const operation of operations) {
      const reference = doc(db, operation.path);
      if (operation.kind === "delete") {
        requireFunction(batch.delete?.bind(batch), "batch.delete")(reference);
      } else {
        requireFunction(batch.set?.bind(batch), "batch.set")(reference, operation.body, {
          merge: operation.merge === true
        });
      }
    }
    await requireFunction(batch.commit?.bind(batch), "batch.commit")();

    return { written: operations.length, batches: 1, skipped: false };
  };
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
