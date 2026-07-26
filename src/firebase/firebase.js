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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

export function connectPhase2bEmulatorsIfConfigured(testConfig = null) {
  const config = testConfig || (typeof window !== "undefined" && window.PHASE2B_EMULATOR_TEST_CONFIG);
  if (!config || !config.enabled) return;

  const projectId = config.projectId || "";
  if (!projectId.startsWith("demo-")) {
    throw new Error("Emulator project ID must use demo- prefix for safety.");
  }

  const host = config.host || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Emulator connection must use loopback host.");
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
}

export { app, auth, db, functions };
