/** Test-only browser harness for the exact Version 3 demo project. */

import {
  browserSessionPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { app, auth } from "../../../src/firebase/firebase.js";

const enabled = import.meta.env.VERSION3_GEMINI_BROWSER_HARNESS === true;
if (enabled) installHarness();

function installHarness() {
  const config = import.meta.env.VERSION3_GEMINI_BROWSER_TEST_CONFIG;
  const isWebKit = navigator.userAgent.includes("AppleWebKit")
    && !/(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent);

  window.PHASE2B_EMULATOR_TEST_CONFIG = {
    enabled: true,
    projectId: config.projectId,
    host: config.host,
    authPort: config.authPort,
    functionsPort: config.functionsPort,
    firestorePort: config.firestorePort,
    forceLongPolling: isWebKit,
  };
  window.VERSION3_GEMINI_BROWSER_TEST_CONFIG = { ...config };

  const observations = {
    calls: [],
    readyResponses: 0,
    holdCount: 0,
    heldResolvers: [],
    ambiguousAfterResponse: false,
    corruptAfterResponse: false,
    lastError: null,
  };

  window.__VERSION3_WRAP_PROVIDER_CALL__ = realCallable => async payload => {
    observations.calls.push(JSON.parse(JSON.stringify(payload)));
    const result = await realCallable(payload);
    observations.readyResponses += 1;
    if (observations.holdCount > 0) {
      observations.holdCount -= 1;
      await new Promise(resolve => observations.heldResolvers.push(resolve));
    }
    if (observations.ambiguousAfterResponse) {
      observations.ambiguousAfterResponse = false;
      const error = new Error("synthetic hidden detail");
      error.code = "functions/unavailable";
      throw error;
    }
    if (observations.corruptAfterResponse) {
      observations.corruptAfterResponse = false;
      return { data: { ...result.data, unexpected: "must not render" } };
    }
    return result;
  };

  // The Checkpoint A demo Functions dotenv intentionally leaves every V2
  // callable disabled. This test-only resolver lets the real browser load its
  // real Auth/Firestore tenant without changing that server gate. The Insights
  // callable still derives and revalidates the tenant independently on the
  // server; no browser tenant value enters its allowlisted request.
  window.__VERSION3_RESOLVE_TEACHER_TENANT__ = () => {
    const tenant = auth.currentUser?.email === "browser-teacher-a@example.test"
      ? {
          classroomId: "class-browser-a",
          classroomName: "Synthetic Browser Room A",
          studentLoginCode: "AAAA-2345",
        }
      : auth.currentUser?.email === "browser-teacher-b@example.test"
        ? {
            classroomId: "class-browser-b",
            classroomName: "Synthetic Browser Room B",
            studentLoginCode: "BBBB-6789",
          }
        : null;
    if (!tenant || !auth.currentUser?.uid) {
      throw new Error("Version 3 browser harness has no synthetic teacher mapping.");
    }
    return {
      state: "active",
      teacher: {
        uid: auth.currentUser.uid,
        displayName: "Synthetic Teacher",
        email: auth.currentUser.email,
      },
      classroom: {
        id: tenant.classroomId,
        name: tenant.classroomName,
        studentLoginCode: tenant.studentLoginCode,
      },
    };
  };

  window.__VERSION3_GEMINI_TEST__ = {
    ready: true,
    projectId: () => app.options.projectId,
    authAppName: () => auth.app.name,
    currentUid: () => auth.currentUser?.uid || null,
    calls: () => observations.calls.map(call => ({ ...call })),
    callCount: () => observations.calls.length,
    readyResponseCount: () => observations.readyResponses,
    holdNextResponse: () => { observations.holdCount += 1; },
    releaseResponses: () => {
      const resolvers = observations.heldResolvers.splice(0);
      for (const resolve of resolvers) resolve();
      return resolvers.length;
    },
    makeNextOutcomeAmbiguous: () => { observations.ambiguousAfterResponse = true; },
    corruptNextResponse: () => { observations.corruptAfterResponse = true; },
    signInTeacher: async (email, password) => {
      await setPersistence(auth, browserSessionPersistence);
      return (await signInWithEmailAndPassword(auth, email, password)).user.uid;
    },
    signOutCurrent: () => signOut(auth),
    lastError: () => observations.lastError,
  };

  window.addEventListener("error", event => {
    observations.lastError = String(event?.message || event);
  });
  window.addEventListener("unhandledrejection", event => {
    observations.lastError = String(event?.reason?.message || event?.reason || event);
  });
}
