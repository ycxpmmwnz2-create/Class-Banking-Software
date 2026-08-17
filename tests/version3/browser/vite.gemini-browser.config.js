import { defineConfig } from "vite";

export const VERSION3_BROWSER_PORT = 5274;
export const VERSION3_BROWSER_PROJECT_ID =
  "demo-morgan-bank-version3-gemini-callable-browser";

const runtimeConfig = Object.freeze({
  enabled: true,
  projectId: VERSION3_BROWSER_PROJECT_ID,
  host: "127.0.0.1",
  authPort: 9099,
  functionsPort: 5001,
  firestorePort: 8080,
});

export default defineConfig({
  root: process.cwd(),
  plugins: [{
    name: "version3-gemini-browser-harness-injector",
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [{
          tag: "script",
          attrs: {
            type: "module",
            src: "/tests/version3/browser/gemini-browser-harness.js",
          },
          injectTo: "head-prepend",
        }];
      },
    },
  }],
  define: {
    "import.meta.env.VITE_MULTI_TEACHER_V2_ENABLED": JSON.stringify("true"),
    "import.meta.env.VITE_VERSION3_GEMINI_BROWSER_TEST": JSON.stringify("true"),
    "import.meta.env.VITE_VERSION3_GEMINI_BROWSER_PROJECT_ID": JSON.stringify(
      VERSION3_BROWSER_PROJECT_ID,
    ),
    "import.meta.env.VERSION3_GEMINI_BROWSER_HARNESS": JSON.stringify(true),
    "import.meta.env.VERSION3_GEMINI_BROWSER_TEST_CONFIG": JSON.stringify(runtimeConfig),
  },
  server: {
    host: "127.0.0.1",
    port: VERSION3_BROWSER_PORT,
    strictPort: true,
  },
});
