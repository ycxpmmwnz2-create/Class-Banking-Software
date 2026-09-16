import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import * as firestore from 'firebase/firestore/lite';
import { TenantSession, SESSION_STATES } from './tenantSession.js';
import { loadClassroomDataWithCacheFallback, handleAuthTransition } from './tenantClient.js';
import { buildCacheKey, createEnvelope, purgeTenantCache, purgeLegacyCache, writeTeacherCache } from './tenantCache.js';
import { TenantProjectionError } from '../phase3/tenantDataProjection.js';
import { TenantDataServiceError, createTenantDataLoader } from '../phase3/tenantDataService.js';

const projectId = 'demo-morgan-load-recovery';
const cachedData = { students: [{ id: 1, name: 'Fable', balance: 4 }] };
const freshData = { students: [{ id: 1, name: 'Fable', balance: 9 }] };
const transportError = () => Object.assign(new Error('Request failed with error: undefined'), { code: 'unknown' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
function fixture({ cache = true } = {}) {
  const values = new Map();
  const storageAdapter = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  };
  const session = new TenantSession({ projectId, storageAdapter, cacheModule: { buildCacheKey, purgeTenantCache, purgeLegacyCache } });
  session.transitionTo(SESSION_STATES.AUTHENTICATING);
  session.transitionTo(SESSION_STATES.RESOLVING);
  session.transitionTo(SESSION_STATES.ACTIVE, { uid: 'teacher-a', role: 'teacher', classroomId: 'room-a' });
  if (cache) {
    session.transitionTo(SESSION_STATES.CLASSROOM_LOADING);
    session.transitionTo(SESSION_STATES.READY);
    writeTeacherCache(storageAdapter, session, projectId, cachedData, session.captureIdentity());
    session.transitionTo(SESSION_STATES.RESOLVING);
    session.transitionTo(SESSION_STATES.ACTIVE);
  }
  return { session, storageAdapter, projectId, values, key: buildCacheKey(projectId, 'teacher-a', 'room-a') };
}

// Models an independently written, same-tenant cache arriving during a retry.
function seedCache(f) {
  f.storageAdapter.setItem(f.key, JSON.stringify(createEnvelope(projectId, 'teacher-a', 'room-a', cachedData)));
}

for (const cache of [true, false]) {
  test(`transport failure uses an existing cache immediately or retries a cache miss (cache=${cache})`, async () => {
    const f = fixture({ cache });
    let attempts = 0, waits = 0;
    const result = await loadClassroomDataWithCacheFallback(f.session, { ...f,
      loadNetworkFn: async () => { if (++attempts === 1) throw transportError(); return freshData; },
      waitBeforeRetry: async () => { waits++; assert.equal(f.session.state, SESSION_STATES.CLASSROOM_LOADING); }
    });
    assert.deepEqual(result, { executed: true, data: cache ? cachedData : freshData, isOffline: cache });
    assert.equal(attempts, cache ? 1 : 2);
    assert.equal(waits, cache ? 0 : 1);
    assert.equal(f.session.state, SESSION_STATES.READY);
    assert.deepEqual(JSON.parse(f.storageAdapter.getItem(f.key)).data, cache ? cachedData : freshData);
  });
}

for (const cache of [true, false]) {
  test(`persistent connection failure retries only a cache miss and preserves existing fallback (cache=${cache})`, async () => {
    const f = fixture({ cache }); let attempts = 0, waits = 0;
    const original = f.storageAdapter.getItem(f.key);
    const result = await loadClassroomDataWithCacheFallback(f.session, { ...f,
      loadNetworkFn: async () => { attempts++; throw transportError(); },
      waitBeforeRetry: async () => { waits++; }
    });
    assert.equal(attempts, cache ? 1 : 2); assert.equal(waits, cache ? 0 : 1);
    if (cache) {
      assert.deepEqual(result, { executed: true, data: cachedData, isOffline: true });
      assert.equal(f.storageAdapter.getItem(f.key), original, 'failed reads must not refresh cache age or contents');
    } else {
      assert.equal(result.reason, 'transient-load-failure-no-cache');
      assert.equal(f.session.state, SESSION_STATES.DENIED_OR_INCONSISTENT);
    }
  });
}

for (const code of ['permission-denied', 'unauthenticated', 'failed-precondition', 'invalid-argument', 'unknown']) {
  for (const afterTransient of [false, true]) {
    test(`${code} fails closed with no cached admission (after transient=${afterTransient})`, async () => {
      const f = fixture({ cache: !afterTransient }); let attempts = 0, waits = 0;
      const result = await loadClassroomDataWithCacheFallback(f.session, { ...f,
        loadNetworkFn: async () => {
          attempts++;
          if (afterTransient && attempts === 1) throw transportError();
          throw Object.assign(new Error('authoritative failure'), { code });
        }, waitBeforeRetry: async () => { waits++; seedCache(f); }
      });
      assert.equal(result.reason, 'non-transient-network-failure');
      assert.equal(result.data, undefined);
      assert.equal(attempts, afterTransient ? 2 : 1);
      assert.equal(waits, afterTransient ? 1 : 0);
      assert.equal(f.storageAdapter.getItem(f.key), null);
      assert.equal(f.session.state, SESSION_STATES.DENIED_OR_INCONSISTENT);
    });
  }
}

for (const change of ['sign-out', 'same-uid-new-classroom']) {
  test(`${change} during retry delay cancels further reads and state/cache admission`, async () => {
    const f = fixture({ cache: false }); const waiting = deferred(), release = deferred(); let attempts = 0;
    const pending = loadClassroomDataWithCacheFallback(f.session, { ...f,
      loadNetworkFn: async () => { attempts++; throw transportError(); },
      waitBeforeRetry: async () => { seedCache(f); waiting.resolve('waiting'); await release.promise; }
    });
    assert.equal(await Promise.race([waiting.promise, pending.then(() => 'finished-too-early')]), 'waiting');
    assert.equal(f.session.state, SESSION_STATES.CLASSROOM_LOADING);
    f.session.invalidate(change, { uid: change === 'sign-out' ? null : 'teacher-a', role: change === 'sign-out' ? null : 'teacher', classroomId: change === 'sign-out' ? null : 'room-b', state: change === 'sign-out' ? SESSION_STATES.SIGNED_OUT : SESSION_STATES.RESOLVING });
    const state = f.session.state;
    release.resolve();
    assert.deepEqual(await pending, { executed: false, reason: 'stale-epoch-ignored' });
    assert.equal(attempts, 1);
    assert.equal(f.session.state, state);
    assert.equal(f.storageAdapter.getItem(f.key), null);
  });
}

test('identity changed during the second read cannot render or cache its late success', async () => {
  const f = fixture({ cache: false }); const second = deferred(), release = deferred(); let attempts = 0;
  const pending = loadClassroomDataWithCacheFallback(f.session, { ...f,
    loadNetworkFn: async () => { if (++attempts === 1) throw transportError(); seedCache(f); second.resolve('second'); return release.promise; },
    waitBeforeRetry: async () => {}
  });
  assert.equal(await Promise.race([second.promise, pending.then(() => 'finished-too-early')]), 'second');
  f.session.invalidate('sign-out', { uid: null, role: null, state: SESSION_STATES.SIGNED_OUT });
  release.resolve(freshData);
  assert.deepEqual(await pending, { executed: false, reason: 'stale-epoch-ignored' });
  assert.equal(f.session.state, SESSION_STATES.SIGNED_OUT);
  assert.equal(f.storageAdapter.getItem(f.key), null);
});

test('healthy reads do not delay or retry', async () => {
  const f = fixture(); let attempts = 0;
  const result = await loadClassroomDataWithCacheFallback(f.session, { ...f,
    loadNetworkFn: async () => { attempts++; return freshData; },
    waitBeforeRetry: async () => assert.fail('successful load must not wait')
  });
  assert.equal(result.isOffline, false); assert.equal(attempts, 1);
});

for (const invalid of ['malformed', 'wrong-owner', 'wrong-classroom', 'wrong-project', 'wrong-schema']) {
  test(`an ineligible ${invalid} cache cannot suppress recovery or be displayed`, async () => {
    const f = fixture();
    const envelope = JSON.parse(f.storageAdapter.getItem(f.key));
    if (invalid === 'wrong-owner') envelope.ownerUid = 'teacher-b';
    if (invalid === 'wrong-classroom') envelope.classroomId = 'room-b';
    if (invalid === 'wrong-project') envelope.projectId = 'demo-other-project';
    if (invalid === 'wrong-schema') envelope.schemaVersion = 'unknown';
    f.storageAdapter.setItem(f.key, invalid === 'malformed' ? '{broken' : JSON.stringify(envelope));
    let attempts = 0, waits = 0;
    const result = await loadClassroomDataWithCacheFallback(f.session, { ...f,
      loadNetworkFn: async () => { if (++attempts === 1) throw transportError(); return freshData; },
      waitBeforeRetry: async () => { waits++; assert.equal(f.storageAdapter.getItem(f.key), null); }
    });
    assert.deepEqual(result, { executed: true, data: freshData, isOffline: false });
    assert.equal(attempts, 2); assert.equal(waits, 1);
    assert.deepEqual(JSON.parse(f.storageAdapter.getItem(f.key)).data, freshData);
  });
}

test('real Firestore Lite fetch failure recovers through teacher auth and the production loader', async t => {
  const f = fixture(); f.session.invalidate('new-page', { state: SESSION_STATES.SIGNED_OUT });
  const app = initializeApp({ projectId, apiKey: 'fictional-public-api-key' }, 'load-recovery-test');
  const db = firestore.getFirestore(app); firestore.setLogLevel('silent');
  const fetchBefore = globalThis.fetch; let failed = false, resolveCalls = 0;
  const paths = [], violations = [];
  function fields(value) {
    if (value === null) return { nullValue: null };
    if (typeof value === 'number') return { integerValue: String(value) };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (Array.isArray(value)) return { arrayValue: { values: value.map(fields) } };
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fields(v)])) } };
  }
  const root = `projects/${projectId}/databases/(default)/documents/`;
  const documents = Object.fromEntries(Object.entries({
    'classrooms/room-a': { settings: { requireTeacherApproval: true }, lastBackupAt: null },
    'classrooms/room-a/studentDisplay/rent': { rentAmount: 0, updatedAt: '2026-09-01T12:00:00.000Z' },
    'classrooms/room-a/students/1': { id: 1, name: 'Fable', balance: 9, frozen: false, transactions: [] }
  }).map(([path, value]) => [root + path, { name: root + path, fields: fields(value).mapValue.fields, createTime: '2026-09-01T12:00:00.000Z', updateTime: '2026-09-01T12:00:00.000Z' }]));
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(`https://firestore.googleapis.com/v1/projects/${projectId}/`) || options.method !== 'POST') {
      violations.push('unexpected project, origin or method');
      return new Response('{}', { status: 400 });
    }
    const body = JSON.parse(options.body);
    const batch = new URL(url).pathname.endsWith(':batchGet');
    if (!batch && !new URL(url).pathname.endsWith(':runQuery')) {
      violations.push('unexpected RPC: only reads allowed');
      return new Response('{}', { status: 400 });
    }
    if (batch) {
      paths.push(...body.documents);
      if (!failed) { failed = true; throw new TypeError('simulated connection interruption'); }
      return new Response(JSON.stringify(body.documents.map(name => ({ found: documents[name] }))));
    }
    const collection = body.structuredQuery.from[0].collectionId;
    if (!['students', 'transactions', 'loginHistory'].includes(collection)) {
      violations.push('unexpected collection');
      return new Response('{}', { status: 400 });
    }
    const prefix = root + 'classrooms/room-a/' + collection + '/'; paths.push(prefix);
    return new Response(JSON.stringify(Object.values(documents).filter(d => d.name.startsWith(prefix)).map(document => ({ document }))));
  };
  t.after(async () => {
    try { await deleteApp(app); }
    finally { globalThis.fetch = fetchBefore; firestore.setLogLevel('warn'); }
  });
  const actualLoader = createTenantDataLoader({ db, session: f.session, firestore });
  const errors = [];
  const loadNetworkFn = async () => {
    try { return await actualLoader(); } catch (error) { errors.push({ code: error.code, reason: error.reason, message: error.message }); throw error; }
  };
  const result = await handleAuthTransition(f.session, { uid: 'teacher-a' }, { claims: {} }, { ...f,
    callAdapter: async name => {
      assert.equal(name, 'resolveTeacherTenantV2'); resolveCalls++;
      return { state: 'active', teacher: { uid: 'teacher-a' }, classroom: { id: 'room-a' } };
    }, loadNetworkFn
  });
  assert.deepEqual(violations, [], 'fetch isolation guard violations');
  assert.equal(result.executed, true, JSON.stringify({ result, errors }));
  assert.equal(result.isOffline, false);
  assert.equal(result.data.students[0].balance, 9);
  assert.equal(resolveCalls, 1, 'retry reads only; do not repeat tenant resolution or callables');
  assert.deepEqual(errors, [{ code: 'unknown', reason: undefined, message: 'Request failed with error: undefined' }]);
  assert.equal(paths.length, 10, 'one complete failed load and one complete successful load');
  assert.ok(paths.every(path => path.startsWith(root + 'classrooms/room-a')));
  assert.equal(f.session.state, SESSION_STATES.READY);
});

// The installed SDK maps these actual HTTP responses; do not hand-build its errors.
for (const [status, code, allowsFallback, body = '{}'] of [
  [409, 'aborted', true], [429, 'resource-exhausted', true], [502, 'internal', true],
  [500, 'unknown', true], [400, 'failed-precondition', false],
  [401, 'unauthenticated', false], [403, 'permission-denied', false],
  [404, 'not-found', false], [501, 'unimplemented', false],
  // An HTML retry remains ambiguous when no cache was eligible before retry.
  [502, 'unknown', false, '<html>502 Bad Gateway</html>']
]) {
  for (const cacheMode of ['initial', 'late', 'none']) {
    const cache = cacheMode !== 'none';
    test(`real SDK transport failure then HTTP ${status} (${body === '{}' ? 'JSON' : 'HTML'}) verifies fallback boundary (cache=${cacheMode})`, async t => {
      const f = fixture({ cache: cacheMode === 'initial' });
      let original = f.storageAdapter.getItem(f.key);
      const app = initializeApp({ projectId, apiKey: 'fictional-public-api-key' }, `http-${status}-${cacheMode}`);
      const db = firestore.getFirestore(app);
      const fetchBefore = globalThis.fetch;
      const violations = [], errors = [];
      let attempts = 0;
      firestore.setLogLevel('silent');
      t.after(async () => {
        try { await deleteApp(app); }
        finally { globalThis.fetch = fetchBefore; firestore.setLogLevel('warn'); }
      });
      globalThis.fetch = async (url, options) => {
        attempts++;
        if (new URL(url).origin !== 'https://firestore.googleapis.com' ||
            new URL(url).pathname !== `/v1/projects/${projectId}/databases/(default)/documents:batchGet` ||
            options.method !== 'POST' ||
            JSON.stringify(JSON.parse(options.body).documents) !== JSON.stringify([
              `projects/${projectId}/databases/(default)/documents/classrooms/room-a`
            ])) {
          violations.push('unexpected project, document or RPC');
          return new Response('{}', { status: 400 });
        }
        if (attempts === 1) throw new TypeError('simulated connection interruption');
        return new Response(body, { status, statusText: 'simulated server response' });
      };
      const result = await loadClassroomDataWithCacheFallback(f.session, { ...f,
        loadNetworkFn: async () => {
          try { await firestore.getDoc(firestore.doc(db, 'classrooms/room-a')); }
          catch (error) { errors.push({ name: error.name, code: error.code, message: error.message }); throw error; }
          assert.fail('both reads are simulated failures');
        },
        waitBeforeRetry: async () => {
          if (cacheMode === 'late') { seedCache(f); original = f.storageAdapter.getItem(f.key); }
        }
      });
      assert.deepEqual(violations, [], 'fetch isolation guard violations');
      if (cacheMode === 'initial') {
        assert.equal(attempts, 1, 'never expose the valid cache to an optional second failure');
        assert.equal(errors.length, 1);
        assert.deepEqual(result, { executed: true, data: cachedData, isOffline: true });
        assert.equal(f.storageAdapter.getItem(f.key), original, 'cache bytes and age are preserved');
        return;
      }
      assert.equal(attempts, 2);
      assert.equal(errors.length, 2);
      assert.deepEqual(errors[0], { name: 'FirebaseError', code: 'unknown', message: 'Request failed with error: undefined' });
      if (body === '{}') {
        assert.deepEqual(errors[1], { name: 'FirebaseError', code, message: 'Request failed with error: simulated server response' });
      } else {
        // The SDK wraps the response parser failure but loses the HTTP status.
        // Do not admit an ambiguous parse failure as an offline classroom.
        assert.equal(errors[1].name, 'FirebaseError');
        assert.equal(errors[1].code, 'unknown');
        assert.match(errors[1].message, /^SyntaxError:/);
        t.diagnostic(JSON.stringify({ nonJsonRetryError: errors[1], outcome: result.reason }));
      }
      if (allowsFallback && cache) {
        assert.deepEqual(result, { executed: true, data: cachedData, isOffline: true });
        assert.equal(f.session.state, SESSION_STATES.READY);
        assert.equal(f.storageAdapter.getItem(f.key), original, 'do not refresh cache contents or age');
      } else {
        assert.equal(result.reason, allowsFallback ? 'transient-load-failure-no-cache' : 'non-transient-network-failure');
        assert.equal(result.data, undefined);
        assert.equal(f.session.state, SESSION_STATES.DENIED_OR_INCONSISTENT);
        assert.equal(f.storageAdapter.getItem(f.key), null);
      }
    });
  }
}

for (const retryError of [
  new TenantProjectionError('malformed-student', 'Student data is invalid.'),
  new TenantDataServiceError('tenant-mismatch', 'Resolved classroom does not match.'),
  ...['aborted', 'resource-exhausted', 'internal'].flatMap(code => [
    Object.assign(new Error('Request failed with error: simulated server response'), { code }),
    Object.assign(new Error('Unrecognized failure'), { name: 'FirebaseError', code })
  ])
]) {
  test(`second failure stays closed without a recognized SDK envelope: ${retryError.name}/${retryError.code || retryError.category || retryError.reason}/${retryError.message}`, async () => {
    const f = fixture({ cache: false }); let attempts = 0;
    const result = await loadClassroomDataWithCacheFallback(f.session, { ...f,
      loadNetworkFn: async () => { if (++attempts === 1) throw transportError(); throw retryError; },
      waitBeforeRetry: async () => { seedCache(f); }
    });
    assert.equal(attempts, 2);
    assert.equal(result.reason, 'non-transient-network-failure');
    assert.equal(result.data, undefined);
    assert.equal(f.session.state, SESSION_STATES.DENIED_OR_INCONSISTENT);
    assert.equal(f.storageAdapter.getItem(f.key), null);
  });
}

for (const code of ['aborted', 'resource-exhausted', 'internal']) {
  test(`first-attempt ${code} classification is unchanged`, async () => {
    const f = fixture(); let attempts = 0;
    const result = await loadClassroomDataWithCacheFallback(f.session, { ...f,
      loadNetworkFn: async () => {
        attempts++;
        throw Object.assign(new Error('Request failed with error: simulated server response'), { name: 'FirebaseError', code });
      }, waitBeforeRetry: async () => assert.fail('existing first-attempt classification must be preserved')
    });
    assert.equal(attempts, 1);
    assert.equal(result.reason, 'non-transient-network-failure');
    assert.equal(f.storageAdapter.getItem(f.key), null);
  });
}

for (const code of ['aborted', 'permission-denied']) {
  for (const change of ['sign-out', 'same-uid-new-classroom']) {
    test(`${change} during second-read ${code} rejection ignores both retry catch branches`, async () => {
      const f = fixture({ cache: false }); const second = deferred(), release = deferred(); let attempts = 0;
      const pending = loadClassroomDataWithCacheFallback(f.session, { ...f,
        loadNetworkFn: async () => {
          if (++attempts === 1) throw transportError();
          seedCache(f); second.resolve('second');
          return release.promise;
        }, waitBeforeRetry: async () => {}
      });
      assert.equal(await Promise.race([second.promise, pending.then(() => 'finished-too-early')]), 'second');
      f.session.invalidate(change, {
        uid: change === 'sign-out' ? null : 'teacher-a',
        role: change === 'sign-out' ? null : 'teacher',
        classroomId: change === 'sign-out' ? null : 'room-b',
        state: change === 'sign-out' ? SESSION_STATES.SIGNED_OUT : SESSION_STATES.RESOLVING
      });
      // Invalidation itself must purge the outgoing tenant; the late rejection
      // must make no further storage reads, writes, purges or state transitions.
      assert.equal(f.storageAdapter.getItem(f.key), null);
      const afterInvalidation = [...f.values];
      const identity = f.session.captureIdentity();
      const state = f.session.state;
      const storageCalls = [], transitions = [];
      for (const method of ['getItem', 'setItem', 'removeItem', 'key']) {
        const original = f.storageAdapter[method];
        f.storageAdapter[method] = (...args) => { storageCalls.push(method); return original(...args); };
      }
      f.session.onStateChange = next => transitions.push(next);
      release.reject(Object.assign(new Error('Request failed with error: simulated server response'), { name: 'FirebaseError', code }));
      assert.deepEqual(await pending, { executed: false, reason: 'stale-epoch-ignored' });
      assert.equal(attempts, 2);
      assert.deepEqual(storageCalls, []);
      assert.deepEqual(transitions, []);
      assert.deepEqual([...f.values], afterInvalidation);
      assert.deepEqual(f.session.captureIdentity(), identity);
      assert.equal(f.session.state, state);
    });
  }
}
