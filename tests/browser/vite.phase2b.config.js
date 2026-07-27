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

// The exact production line in index.html that constructs the injected Firestore
// primitives shared by all three V2 data adapters.
//
// Commit 7 removed every `window.V2_TENANT_DATA_*` hook from index.html, so the
// browser suite can no longer replace the data adapters wholesale. Instead the
// served (test-only) copy of index.html is rewritten to let the harness DECORATE
// the primitives the production service already accepts by injection. The
// production source is untouched: this transform exists only in this config and
// runs only against the dev server this suite starts.
//
// Decorating the primitives — rather than substituting an adapter — is what keeps
// the response barriers and failure injection UNDER the real service code path,
// so the isolation assertions observe production decisions instead of harness
// ones.
export const FIRESTORE_SEAM_SOURCE =
  "const V2_FIRESTORE_ADAPTERS = { doc, getDoc, collection, getDocs, writeBatch };";

// Appended immediately after the seam line. Inert unless the harness installed a
// wrapper, so the transform cannot change behavior on its own.
//
// The wrapper is handed a SNAPSHOT ({ ...V2_FIRESTORE_ADAPTERS }), never the live
// object. Passing the live object and then Object.assign-ing the result back onto
// it makes each wrapper's captured `primitives.getDocs` resolve to the wrapper
// itself — unbounded recursion. That was observed, not theorized: it produced
// repeating "Transaction lock timeout" writes and then crashed the browser tab.
const FIRESTORE_SEAM_REWRITE = `${FIRESTORE_SEAM_SOURCE}
    {
      const __phase2bWrap = window.__PHASE2B_WRAP_FIRESTORE__;
      if (typeof __phase2bWrap === "function") {
        Object.assign(
          V2_FIRESTORE_ADAPTERS,
          __phase2bWrap({ ...V2_FIRESTORE_ADAPTERS })
        );
      }
    }`;

/**
 * Rewrite the served index.html so the harness can wrap the V2 Firestore
 * primitives.
 *
 * Throws if the seam line is absent. A silent no-op here would be the worst
 * outcome: the suite would run green-ish against unbarriered code and the
 * stale-completion tests would assert nothing. Failing the server start makes an
 * index.html edit that moves this line impossible to miss.
 */
export function applyFirestoreSeamRewrite(html) {
  const occurrences = html.split(FIRESTORE_SEAM_SOURCE).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Phase 2B browser harness seam not found exactly once in index.html ` +
        `(found ${occurrences}). The V2_FIRESTORE_ADAPTERS construction line changed; ` +
        `update FIRESTORE_SEAM_SOURCE in tests/browser/vite.phase2b.config.js to match.`
    );
  }
  return html.replace(FIRESTORE_SEAM_SOURCE, FIRESTORE_SEAM_REWRITE);
}

export default defineConfig({
  root: process.cwd(),
  plugins: [
    react(),
    {
      name: "phase2b-browser-harness-injector",
      // MUST be `pre`. Vite's main HTML transform hoists index.html's inline
      // module script out into a separate virtual module, so by the default
      // (post) phase the application source is no longer present in `html` and
      // the seam rewrite finds nothing. This was observed, not assumed: at `pre`
      // the seam matches once, at `post` zero times.
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return {
            html: applyFirestoreSeamRewrite(html),
            tags: [
              {
                tag: "script",
                attrs: { type: "module", src: HARNESS_SPECIFIER },
                injectTo: "head-prepend"
              }
            ]
          };
        }
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
