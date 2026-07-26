import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyC-96VLdKfwtQ-WaFT6BA2q1WLnk8hDe1A",
  authDomain: "morgan-bank.firebaseapp.com",
  projectId: "morgan-bank",
  storageBucket: "morgan-bank.firebasestorage.app",
  messagingSenderId: "242031426628",
  appId: "1:242031426628:web:5caa4640a7eb7e3576d011",
  measurementId: "G-FG1ZHTHF7G"
};

let app = initializeApp(firebaseConfig);
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

  const host = config.host || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Emulator connection must use loopback host.");
  }

  if (config.authPort !== undefined && !isPortValid(config.authPort)) {
    throw new Error(`Invalid Auth emulator port: ${config.authPort}`);
  }
  if (config.firestorePort !== undefined && !isPortValid(config.firestorePort)) {
    throw new Error(`Invalid Firestore emulator port: ${config.firestorePort}`);
  }
  if (config.functionsPort !== undefined && !isPortValid(config.functionsPort)) {
    throw new Error(`Invalid Functions emulator port: ${config.functionsPort}`);
  }

  if (isEmulatorConnected) {
    if (
      connectedEmulatorConfig.projectId !== projectId ||
      connectedEmulatorConfig.host !== host ||
      connectedEmulatorConfig.authPort !== config.authPort ||
      connectedEmulatorConfig.firestorePort !== config.firestorePort ||
      connectedEmulatorConfig.functionsPort !== config.functionsPort
    ) {
      throw new Error("Conflicting emulator configuration.");
    }
    return { connected: true, reason: "already-connected", app, auth, db, functions };
  }

  if (app.options.projectId !== projectId) {
    const demoConfig = { ...firebaseConfig, projectId };
    app = initializeApp(demoConfig, "phase2b-emulator-app");
    auth = getAuth(app);
    db = getFirestore(app);
    functions = getFunctions(app);
  }

  if (config.authPort) {
    connectAuthEmulator(auth, `http://${host}:${config.authPort}`, { disableWarnings: true });
  }
  if (config.firestorePort) {
    connectFirestoreEmulator(db, host, config.firestorePort);
  }
  if (config.functionsPort) {
    connectFunctionsEmulator(functions, host, config.functionsPort);
  }

  isEmulatorConnected = true;
  connectedEmulatorConfig = {
    projectId,
    host,
    authPort: config.authPort,
    firestorePort: config.firestorePort,
    functionsPort: config.functionsPort
  };

  return { connected: true, app, auth, db, functions };
}

export { app, auth, db, functions };
