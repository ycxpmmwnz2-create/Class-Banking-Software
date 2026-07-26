// Vite config for the Item 10 browser suite.
//
// Serves the real index.html with the V2 gate ON, and injects the harness module
// BEFORE the application's inline module script. index.html exposes no import
// specifier to intercept, so injection order via transformIndexHtml is the only
// available hook; `injectTo: "head-prepend"` guarantees the harness module is
// evaluated first.
//
// Deliberately NOT part of the production vite.config.js: nothing here can
// affect a normal dev or production build.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export const PHASE2B_BROWSER_PORT = 5273;

// Distinct from the emulator ports declared in firebase.json:
//   Auth 9099, Functions 5001, Firestore 8080.
export const PHASE2B_EMULATOR_CONFIG = {
  enabled: true,
  // Must match PROJECT_ID in tests/browser/phase2b-fixtures.js and the
  // --project passed to emulators:exec by test:phase2b:browser. Reusing the
  // gate-on server project means its .env contract activates V2 Functions.
  projectId: "demo-morgan-bank-phase2b-server-test",
  host: "127.0.0.1",
  authPort: 9099,
  firestorePort: 8080,
  functionsPort: 5001
};

const HARNESS_SPECIFIER = "/tests/browser/phase2b-browser-harness.js";

export default defineConfig({
  root: process.cwd(),
  plugins: [
    react(),
    {
      name: "phase2b-browser-harness-injector",
      transformIndexHtml() {
        return [
          {
            tag: "script",
            attrs: { type: "module", src: HARNESS_SPECIFIER },
            injectTo: "head-prepend"
          }
        ];
      }
    }
  ],
  // Activation and config travel via import.meta.env, which Vite substitutes
  // reliably in served ES modules. A bare `define` identifier was tried first and
  // did NOT get substituted here — it survived verbatim into the served module,
  // threw a ReferenceError, and silently left the harness inert. import.meta.env
  // avoids that failure mode entirely.
  envPrefix: ["VITE_", "PHASE2B_"],
  define: {
    // The suite exercises the V2 code paths, so the gate must be on.
    "import.meta.env.VITE_MULTI_TEACHER_V2_ENABLED": JSON.stringify("true"),
    "import.meta.env.PHASE2B_BROWSER_TEST": JSON.stringify(true),
    "import.meta.env.PHASE2B_BROWSER_TEST_CONFIG": JSON.stringify({
      emulator: PHASE2B_EMULATOR_CONFIG
    })
  },
  server: {
    host: "127.0.0.1",
    port: PHASE2B_BROWSER_PORT,
    strictPort: true
  }
});
