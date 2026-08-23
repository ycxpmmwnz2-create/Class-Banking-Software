import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, initializeFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";
import { resolveFirebaseBuildConfiguration } from "./firebaseConfig.js";
import { VERSION3_GEMINI_LIVE_PROJECT_IDS } from "../insights/providerInsightsClient.js";

const firebaseBuildEnvironment = import.meta.env || {};
const resolvedFirebaseBuild = resolveFirebaseBuildConfiguration(firebaseBuildEnvironment);
const firebaseConfig = resolvedFirebaseBuild.firebaseConfig;

export const firebaseDeploymentTier = resolvedFirebaseBuild.tier;
export const isStagingDeployment = resolvedFirebaseBuild.isStaging;

if (isStagingDeployment && typeof document !== "undefined") {
  const stagingDeploymentBanner = document.getElementById("stagingDeploymentBanner");
  if (!stagingDeploymentBanner) {
    throw new Error("The staging deployment warning is missing.");
  }
  stagingDeploymentBanner.hidden = false;
}

let app = initializeApp(firebaseConfig);
const providerAppCheckReadyPromise = (async () => {
  if (import.meta.env?.VITE_VERSION3_GEMINI_LIVE !== "true") return false;

  const expectedProjectId = VERSION3_GEMINI_LIVE_PROJECT_IDS[firebaseDeploymentTier];
  const buildProjectId = firebaseBuildEnvironment.VITE_VERSION3_GEMINI_PROJECT_ID;
  const siteKey = firebaseBuildEnvironment.VITE_FIREBASE_APP_CHECK_SITE_KEY;
  const validSiteKey = typeof siteKey === "string"
    && siteKey.length >= 20
    && siteKey.length <= 256
    && siteKey.trim() === siteKey;
  if (
    expectedProjectId === firebaseConfig.projectId
    && buildProjectId === expectedProjectId
    && validSiteKey
  ) {
    try {
      const { initializeProviderAppCheckAndVerify } = await import("./providerAppCheck.build.js");
      return await initializeProviderAppCheckAndVerify({
        app,
        siteKey,
      });
    } catch {
      globalThis.console.warn("Gemini App Check initialization refused.", {
        category: "invalid-runtime",
      });
      return false;
    }
  } else {
    globalThis.console.warn("Gemini App Check configuration refused.", {
      category: "invalid-runtime",
    });
    return false;
  }
})();
export { providerAppCheckReadyPromise };
let auth = getAuth(app);
let db = getFirestore(app);
let functions = getFunctions(app);
let isEmulatorConnected = false;
let connectedEmulatorConfig = null;

export function isPortValid(port) {
  if (typeof port !== "number" || !Number.isInteger(port)) return false;
  return port > 0 && port <= 65535;
}

export function connectPhase2bEmulatorsIfConfigured(testConfig = null) {
  const config = testConfig || (typeof window !== "undefined" && window.PHASE2B_EMULATOR_TEST_CONFIG);
  if (!config || !config.enabled) return { connected: false, reason: "disabled" };

  const projectId = config.projectId || "";
  if (!projectId || typeof projectId !== "string" || !projectId.startsWith("demo-")) {
    throw new Error("Emulator connection requires an explicit demo- project ID.");
  }

  const host = config.host || "";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Emulator connection must use loopback host.");
  }

  if (!isPortValid(config.authPort)) {
    throw new Error(`Invalid Auth emulator port: ${config.authPort}`);
  }
  if (!isPortValid(config.firestorePort)) {
    throw new Error(`Invalid Firestore emulator port: ${config.firestorePort}`);
  }
  if (!isPortValid(config.functionsPort)) {
    throw new Error(`Invalid Functions emulator port: ${config.functionsPort}`);
  }
  if (config.forceLongPolling !== undefined && typeof config.forceLongPolling !== "boolean") {
    throw new Error("Emulator forceLongPolling must be a boolean when provided.");
  }

  const forceLongPolling = config.forceLongPolling === true;

  if (isEmulatorConnected) {
    if (
      connectedEmulatorConfig.projectId !== projectId ||
      connectedEmulatorConfig.host !== host ||
      connectedEmulatorConfig.authPort !== config.authPort ||
      connectedEmulatorConfig.firestorePort !== config.firestorePort ||
      connectedEmulatorConfig.functionsPort !== config.functionsPort ||
      connectedEmulatorConfig.forceLongPolling !== forceLongPolling
    ) {
      throw new Error("Conflicting emulator configuration.");
    }
    return { connected: true, reason: "already-connected", app, auth, db, functions };
  }

  if (app.options.projectId !== projectId) {
    const demoConfig = { ...firebaseConfig, projectId };
    app = initializeApp(demoConfig, "phase2b-emulator-app");
    auth = getAuth(app);
    db = forceLongPolling
      ? initializeFirestore(app, { experimentalForceLongPolling: true })
      : getFirestore(app);
    functions = getFunctions(app);
  }

  connectAuthEmulator(auth, `http://${host}:${config.authPort}`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, config.firestorePort);
  connectFunctionsEmulator(functions, host, config.functionsPort);

  isEmulatorConnected = true;
  connectedEmulatorConfig = {
    projectId,
    host,
    authPort: config.authPort,
    firestorePort: config.firestorePort,
    functionsPort: config.functionsPort,
    forceLongPolling
  };

  return { connected: true, app, auth, db, functions };
}

export { app, auth, db, functions };
