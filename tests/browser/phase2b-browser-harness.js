// Phase 2B Item 10 browser test harness.
//
// This module is injected by tests/browser/vite.phase2b.config.js as a module
// script placed BEFORE index.html's inline application module. index.html has no
// import specifier to intercept, so injection order is the only hook available.
//
// HARD CONSTRAINTS (violating any of these silently breaks the suite):
//
//  1. Import-time synchronous. The application module begins executing as soon
//     as this one finishes. Any top-level `await` here would yield to the
//     microtask queue and let the app run first, so every side effect below is
//     either a plain assignment or a lazily-invoked closure.
//  2. Static imports only, for the same reason — a dynamic import() resolves
//     asynchronously.
//  3. Reuses the src/firebase/firebase.js singleton. Calling initializeApp()
//     again under the name "phase2b-emulator-app" throws, because
//     connectPhase2bEmulatorsIfConfigured() already claims that name when it
//     rebinds the app to a demo project.
//  4. window.PHASE2B_EMULATOR_TEST_CONFIG must be set before the app calls
//     connectPhase2bEmulatorsIfConfigured(), which the app does at import time.
//  5. Activates ONLY under an explicit browser-test flag, so this file can never
//     alter behavior of a normal dev or production build.
//  6. window.__PHASE2B_WRAP_FIRESTORE__ must be installed before index.html's
//     module builds V2_FIRESTORE_ADAPTERS. Constraint 1 already guarantees this,
//     but the coupling is load-order-sensitive: making the wrapper installation
//     lazy or async would leave the barriers silently uninstalled.

import {
  browserSessionPersistence,
  setPersistence,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut
} from "firebase/auth";
// No `firebase/firestore` import: since Commit 7 the harness performs no reads or
// writes of its own. It only decorates the primitives the production service was
// constructed with, which is what guarantees every assertion observes production
// I/O rather than harness I/O.
import { app, auth } from "../../src/firebase/firebase.js";

const FLAG = "__PHASE2B_BROWSER_TEST__";

// Activation comes from import.meta.env, substituted by the test Vite config.
// A bare `define` identifier was tried first and was NOT substituted in the
// served module — it threw and left the harness silently inert, which is a
// failure mode worth naming here so it is not reintroduced.
const ENABLED =
  (typeof window !== "undefined" && window[FLAG] === true) ||
  import.meta.env.PHASE2B_BROWSER_TEST === true;

if (ENABLED) {
  installHarness();
}

function installHarness() {
  const cfg = readInjectedConfig();

  // MUST happen before the app module imports firebase.js and connects.
  // Limit the emulator transport workaround to WebKit. Chromium's normal
  // streaming path remains covered, while WebKit closes each long-poll response
  // as soon as emulator data arrives instead of indefinitely buffering it.
  const isWebKit =
    navigator.userAgent.includes("AppleWebKit") &&
    !/(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent);
  window.PHASE2B_EMULATOR_TEST_CONFIG = {
    ...cfg.emulator,
    forceLongPolling: cfg.forceLongPollingForWebKit === true && isWebKit
  };

  // ---------------------------------------------------------------------------
  // Observation surface. Purely additive: the harness records what the app did,
  // it never drives application state. Counters are monotonic so the specs can
  // poll for a stable steady state instead of asserting an exact delta, which
  // would be wrong given the auth observer's known double-invalidation.
  // ---------------------------------------------------------------------------
  const obs = {
    events: [],
    counters: {
      broadcastsSent: 0,
      broadcastsReceived: 0,
      storageEventsReceived: 0,
      loadAdapterCalls: 0,
      saveAdapterCalls: 0
    },
    outboundPayloads: [],
    lastError: null
  };

  function record(type, detail) {
    obs.events.push({ type, detail: detail || null, seq: obs.events.length });
  }

  // ---------------------------------------------------------------------------
  // Response barriers. The specs need to hold a real emulator response open,
  // switch tenants, then release it and prove the late completion is inert.
  // Each barrier gates the RESOLUTION of a genuine Firestore call, so nothing
  // here fabricates data.
  // ---------------------------------------------------------------------------
  const barriers = new Map();

  function barrier(name) {
    if (!barriers.has(name)) {
      barriers.set(name, { held: false, waiters: [] });
    }
    return barriers.get(name);
  }

  async function gate(name) {
    const b = barrier(name);
    if (!b.held) return;
    await new Promise((resolve) => b.waiters.push(resolve));
  }

  // ---------------------------------------------------------------------------
  // Firestore primitive wrapper.
  //
  // Commit 7 gave the client a real production data layer
  // (src/phase3/tenantDataService.js) and removed the `window.V2_TENANT_DATA_*`
  // adapter hooks this harness used to define. Replacing the adapters is
  // therefore no longer possible — and no longer desirable: a harness-owned
  // adapter meant the barriers gated HARNESS code, so the isolation specs were
  // observing the harness's own stale-completion decisions rather than
  // production's.
  //
  // Instead the harness decorates the injected Firestore primitives that the
  // production service already accepts as a constructor argument. Every real
  // read, projection, tenant check, staleness re-check, and bounded batch commit
  // runs exactly as in production; the wrapper only parks and counts the I/O
  // underneath. The served index.html is rewritten by vite.phase2b.config.js to
  // pick this up (see applyFirestoreSeamRewrite) — production source is
  // untouched, and the wrapper is inert unless this harness installed it.
  //
  // Nothing here fabricates data: each barrier gates the RESOLUTION of a genuine
  // emulator call.
  // ---------------------------------------------------------------------------
  // One-shot injected failure, used to distinguish transient (cache-eligible)
  // from permission/integrity (never-cache-eligible) load failures. The error
  // shape matches what the client's classifier reads, so the classification
  // under test is the real one.
  //
  // Stored in sessionStorage because the specs arm it and then RELOAD: an
  // in-memory flag would not survive to the load it is meant to fail.
  const FAIL_KEY = "__phase2b_fail_next_load__";
  const takeNextLoadFailure = () => {
    try {
      const v = sessionStorage.getItem(FAIL_KEY);
      if (v) sessionStorage.removeItem(FAIL_KEY);
      return v;
    } catch {
      return null;
    }
  };

  // Only classroom-scoped traffic is instrumented. The app performs other reads
  // (teacher profile, classroom resolution) through the same primitives, and
  // counting or barriering those would make `loadAdapterCalls` mean something
  // different from "the V2 data service ran".
  const CLASSROOM_ROOT = /^classrooms\/[^/]+$/;
  const CLASSROOM_SCOPED = /^classrooms\/[^/]+\/(students|transactions|loginHistory)$/;
  const CLASSROOM_SCOPED_DOC = /^classrooms\/[^/]+\/(students|transactions|loginHistory)\/[^/]+$/;
  const STUDENT_SELF_DOC = /^classrooms\/[^/]+\/students\/[^/]+$/;

  const refPath = (ref) => (typeof ref?.path === "string" ? ref.path : "");

  let alreadyWrapped = false;

  window.__PHASE2B_WRAP_FIRESTORE__ = (incoming) => {
    // Checked FIRST, before anything is captured: wrapping twice would
    // double-count and double-barrier every call, and a second call may already
    // be receiving wrapped functions.
    if (alreadyWrapped) {
      throw new Error(
        "Phase 2B harness: __PHASE2B_WRAP_FIRESTORE__ invoked twice. " +
          "The V2 Firestore primitives must be wrapped exactly once."
      );
    }
    alreadyWrapped = true;

    // Capture the originals up front and call ONLY these below. Reading through
    // the passed object later would re-enter the wrapper if the caller assigned
    // the result back onto the same object, which is unbounded recursion.
    const primitives = {
      doc: incoming.doc,
      getDoc: incoming.getDoc,
      collection: incoming.collection,
      getDocs: incoming.getDocs,
      writeBatch: incoming.writeBatch
    };

    record("firestore:wrapped", null);

    // The service issues the classroom-root getDoc and the three collection
    // getDocs together in one Promise.all. Counting every one would make
    // `loadAdapterCalls` count reads, not service invocations, so the count is
    // attributed to the students collection — read exactly once per load.
    const wrappedGetDocs = async (ref) => {
      const path = refPath(ref);
      if (!CLASSROOM_SCOPED.test(path)) return primitives.getDocs(ref);

      const isLoadAnchor = path.endsWith("/students");
      if (isLoadAnchor) {
        obs.counters.loadAdapterCalls++;
        record("loadAdapter:start", { path });
      }

      // Armed failures are consumed on the anchor read only, so one armed code
      // fails one load rather than being consumed by whichever of the four
      // concurrent reads happens to resolve first.
      if (isLoadAnchor) {
        const injected = takeNextLoadFailure();
        if (injected) {
          record("loadAdapter:injectedFailure", { code: injected });
          const err = new Error(`harness injected ${injected}`);
          err.code = injected;
          throw err;
        }
      }

      // Start the genuine emulator request before entering the barrier. The
      // barrier models a completed response arriving late; delaying invocation
      // would instead start stale and incoming requests together after release.
      // Capture rejection immediately so a held, failed request cannot surface
      // as an unhandled rejection while the test is waiting to release it.
      const pending = primitives.getDocs(ref).then(
        (snapshot) => ({ ok: true, snapshot }),
        (error) => ({ ok: false, error })
      );
      await gate("classroomLoad");
      const outcome = await pending;
      if (!outcome.ok) throw outcome.error;

      const snapshot = outcome.snapshot;
      if (isLoadAnchor) {
        record("loadAdapter:done", { path, docCount: snapshot?.docs?.length ?? 0 });
      }
      return snapshot;
    };

    // A student session reads exactly one document, so the student loader's read
    // is barriered and counted here too — otherwise holding "classroomLoad"
    // would not park a student load at all.
    const wrappedGetDoc = async (ref) => {
      const path = refPath(ref);
      const isStudentSelfRead = STUDENT_SELF_DOC.test(path);
      if (!isStudentSelfRead) return primitives.getDoc(ref);

      obs.counters.loadAdapterCalls++;
      record("loadAdapter:start", { path });

      const injected = takeNextLoadFailure();
      if (injected) {
        record("loadAdapter:injectedFailure", { code: injected });
        const err = new Error(`harness injected ${injected}`);
        err.code = injected;
        throw err;
      }

      const pending = primitives.getDoc(ref).then(
        (snapshot) => ({ ok: true, snapshot }),
        (error) => ({ ok: false, error })
      );
      await gate("classroomLoad");
      const outcome = await pending;
      if (!outcome.ok) throw outcome.error;

      const snapshot = outcome.snapshot;
      record("loadAdapter:done", { path });
      return snapshot;
    };

    // The save barrier gates the COMMIT, not batch construction. The service
    // re-validates the captured identity immediately before its single atomic
    // commit, so parking here exercises the production stale-write
    // refusal rather than bypassing it.
    const wrappedWriteBatch = (handle) => {
      const batch = primitives.writeBatch(handle);
      let touchesClassroom = false;
      let counted = false;

      const originalSet = batch.set.bind(batch);
      const originalDelete = batch.delete.bind(batch);
      const originalCommit = batch.commit.bind(batch);

      const noteRef = (ref) => {
        const path = refPath(ref);
        // Either the classroom root doc, or a doc inside one of the three scoped
        // collections.
        if (CLASSROOM_ROOT.test(path) || CLASSROOM_SCOPED_DOC.test(path)) {
          touchesClassroom = true;
        }
      };

      batch.set = (ref, ...rest) => {
        noteRef(ref);
        return originalSet(ref, ...rest);
      };
      batch.delete = (ref, ...rest) => {
        noteRef(ref);
        return originalDelete(ref, ...rest);
      };
      batch.commit = async () => {
        if (!touchesClassroom) return originalCommit();

        // A classroom mutation is one logical, atomic save; count it once.
        if (!counted) {
          counted = true;
          obs.counters.saveAdapterCalls++;
          record("saveAdapter:start", null);
        }

        await gate("classroomSave");
        try {
          const result = await originalCommit();
          record("saveAdapter:done", null);
          return result;
        } catch (error) {
          // Recorded so a rejected commit is diagnosable. A save that fails is a
          // real outcome the specs may assert on; swallowing it here would make
          // a rules denial look like a hang.
          record("saveAdapter:failed", {
            code: error?.code || null,
            message: String(error?.message || error).slice(0, 200)
          });
          throw error;
        }
      };

      return batch;
    };

    return {
      getDoc: wrappedGetDoc,
      getDocs: wrappedGetDocs,
      writeBatch: wrappedWriteBatch
    };
  };

  // ---------------------------------------------------------------------------
  // Transport observation. Wraps the real BroadcastChannel so the specs can
  // assert exact outbound payload keys and count deliveries, while leaving the
  // genuine native transport in place. When the spec deletes BroadcastChannel
  // via addInitScript, this wrapper is simply never installed.
  // ---------------------------------------------------------------------------
  const NativeBC = window.BroadcastChannel;
  if (typeof NativeBC === "function") {
    window.BroadcastChannel = function ObservedBroadcastChannel(name) {
      const ch = new NativeBC(name);
      const originalPost = ch.postMessage.bind(ch);
      ch.postMessage = (msg) => {
        obs.counters.broadcastsSent++;
        obs.outboundPayloads.push(msg);
        record("broadcast:sent", { keys: Object.keys(msg || {}).sort() });
        return originalPost(msg);
      };
      ch.addEventListener("message", (event) => {
        obs.counters.broadcastsReceived++;
        record("broadcast:received", { keys: Object.keys(event?.data || {}).sort() });
      });
      return ch;
    };
    window.BroadcastChannel.prototype = NativeBC.prototype;
  }

  window.addEventListener("storage", (event) => {
    if (event?.key === "morganBank:v2:invalidation") {
      obs.counters.storageEventsReceived++;
      record("storage:received", { key: event.key });
    }
  });

  // ---------------------------------------------------------------------------
  // Test-only control surface.
  // ---------------------------------------------------------------------------
  window.__PHASE2B_TEST__ = {
    ready: true,
    projectId: () => app.options.projectId,

    events: () => obs.events.slice(),
    counters: () => ({ ...obs.counters }),
    outboundPayloads: () => obs.outboundPayloads.map((p) => ({ ...p })),
    eventTypes: () => obs.events.map((e) => e.type),

    // Monotonic total used for quiescence polling: the specs wait until this
    // stops changing across a documented interval rather than asserting a delta.
    activityTotal: () =>
      Object.values(obs.counters).reduce((a, b) => a + b, 0) + obs.events.length,

    // Arms a one-shot load failure that survives a reload. "unavailable" is
    // transient (cache-eligible); "permission-denied" must never serve cache.
    failNextLoad: (code) => {
      try {
        sessionStorage.setItem(FAIL_KEY, String(code));
      } catch {
        // ignore
      }
    },

    hold: (name) => { barrier(name).held = true; },
    release: (name) => {
      const b = barrier(name);
      b.held = false;
      const waiters = b.waiters.splice(0);
      for (const w of waiters) w();
      return waiters.length;
    },
    isHeld: (name) => barrier(name).held,

    // index.html does NOT expose its TenantSession on window, and Item 10 is
    // tests-only, so the session object cannot be reached from here. Everything
    // below is derived from genuinely observable browser state: Firebase Auth,
    // the cache keys the app writes, and the DOM. That is a real limitation —
    // the specs assert user-visible and storage-visible effects, not internal
    // session fields.
    // Auth control MUST go through these, never through a bare getAuth() in a
    // spec. getAuth() with no argument resolves the DEFAULT app — which is the
    // production morgan-bank app initialized at firebase.js import time — not the
    // named "phase2b-emulator-app" that connectPhase2bEmulatorsIfConfigured()
    // rebinds to the emulator. A spec calling getAuth() would authenticate
    // against production while asserting against emulator data.
    //
    // `auth` here is the ES live binding from firebase.js, so it observes the
    // rebind performed during emulator connection.
    signInTeacher: async (email, password) => {
      // Matches production (index.html sets this before its own sign-ins), and
      // it is the persistence mode the cross-tab reanimation tests depend on.
      await setPersistence(auth, browserSessionPersistence);
      const cred = await signInWithEmailAndPassword(auth, email, password);
      return cred.user.uid;
    },
    signInWithToken: async (token) => {
      await setPersistence(auth, browserSessionPersistence);
      const cred = await signInWithCustomToken(auth, token);
      return cred.user.uid;
    },
    signOutCurrent: async () => {
      await signOut(auth);
    },
    authAppName: () => auth.app.name,

    currentUid: () => auth.currentUser?.uid || null,

    // Recovered from the V2 cache key the app writes:
    // morganBank:v2:<projectId>:teacher:<uid>:classroom:<classroomId>:data:v1
    currentClassroomId: () => {
      const uid = auth.currentUser?.uid;
      if (!uid) return null;
      const prefix = `morganBank:v2:${app.options.projectId}:teacher:${uid}:classroom:`;
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(prefix)) return k.slice(prefix.length).split(":classroom")[0].replace(/:data:v1$/, "");
      }
      return null;
    },

    // Storage inspection, for cache-envelope and quarantine assertions.
    localKeys: () => Object.keys(localStorage),
    localGet: (k) => localStorage.getItem(k),
    localSet: (k, v) => localStorage.setItem(k, v),
    localRemove: (k) => localStorage.removeItem(k),
    sessionGet: (k) => sessionStorage.getItem(k),
    sessionSet: (k, v) => sessionStorage.setItem(k, v),
    sessionRemove: (k) => sessionStorage.removeItem(k),

    // NOTE: there is deliberately no noteInvalidation/noteRender hook. The
    // application cannot call into the harness (tests-only scope forbids editing
    // index.html), so invalidation and render counts are NOT directly
    // observable. The specs instead observe transport counters above, DOM
    // mutations via MutationObserver, and storage effects. Claiming an
    // invalidation counter here would be reporting coverage we do not have.
    lastError: () => obs.lastError
  };

  window.addEventListener("error", (e) => { obs.lastError = String(e?.message || e); });
  window.addEventListener("unhandledrejection", (e) => {
    obs.lastError = String(e?.reason?.message || e?.reason || e);
  });

  record("harness:installed", { projectId: cfg.emulator.projectId });
}

function readInjectedConfig() {
  // Injected as a literal by the test Vite config so it is available
  // synchronously, with no fetch and no top-level await.
  const injected = import.meta.env.PHASE2B_BROWSER_TEST_CONFIG || null;
  if (injected && injected.emulator) return injected;
  throw new Error("Phase 2B browser harness enabled without an injected emulator config.");
}
