// Cutover candidate. Wire only after every money/profile action has a reviewed
// server route; the existing page intentionally still imports the old saver.
import { createTenantDataSaver, TenantDataServiceError } from './tenantDataService.js';

function refuse() {
  throw new TenantDataServiceError('server-money-required',
    'Refresh the classroom and use the server action for money or roster changes.');
}

function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' ||
      Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

// Compare raw mirrors too: decomposition must not silently discard an attempted
// mirror edit. The established projection validator still validates whole shapes.
export function assertNonMoneyClassroomChange(next, previous) {
  if (!previous || !Array.isArray(previous.students) || !Array.isArray(next?.students) ||
      !Array.isArray(previous.transactions) || !Array.isArray(next.transactions) ||
      next.students.length !== previous.students.length ||
      !equal(next.transactions, previous.transactions)) refuse();
  const prior = new Map(previous.students.map(student => [student.id, student]));
  if (prior.size !== previous.students.length) refuse();
  const seen = new Set();
  for (const student of next.students) {
    const old = prior.get(student.id);
    if (!old || seen.has(student.id)) refuse();
    seen.add(student.id);
    for (const key of new Set([...Object.keys(old), ...Object.keys(student)])) {
      if (key !== 'frozen' && !equal(student[key], old[key])) refuse();
    }
  }
}

export function createNonMoneyTenantDataSaver(options) {
  return async (data, capturedIdentity) => {
    // Snapshot before any await; later draft/baseline mutations cannot change the
    // authorized proposal while the Firestore transaction is pending or retried.
    const previous = structuredClone(typeof options.previousRef === 'function'
      ? options.previousRef() : options.previousRef);
    const next = structuredClone(data);
    assertNonMoneyClassroomChange(next, previous);
    const firestore = {
      ...options.firestore,
      runTransaction: (db, callback) => options.firestore.runTransaction(db, transaction => callback({
        get: reference => transaction.get(reference),
        delete: reference => transaction.delete(reference),
        set: (reference, body, settings) => {
          // Freeze-only writes must not normalize/reorder historical mirrors.
          // The base saver still checks the complete current student snapshot
          // for concurrency before this narrow update is staged.
          if (/^classrooms\/[^/]+\/students\/[^/]+$/.test(reference.path)) {
            return transaction.update(reference, { frozen: body.frozen });
          }
          return transaction.set(reference, body, settings);
        },
      })),
    };
    return createTenantDataSaver({ ...options, firestore, previousRef: () => previous })(next, capturedIdentity);
  };
}
