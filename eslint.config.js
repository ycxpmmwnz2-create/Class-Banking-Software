import js from '@eslint/js'
import globals from 'globals'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'test-results', 'playwright-report', 'blob-report']),
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
  },
  // Item 10 test tooling runs in Node, not the browser: Playwright specs, the
  // rules/build contracts, and the test Vite config. The browser harness under
  // tests/browser is deliberately NOT included here — it is injected into the
  // page and must keep browser globals (see the override below).
  {
    files: [
      'tests/**/*.js',
      'playwright.config.js',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Injected into the page, so it needs browser globals plus the Node globals
    // its sibling config files use. `process` is referenced only behind a typeof
    // guard for the environment flag.
    files: ['tests/browser/phase2b-browser-harness.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        // Compile-time literals substituted by Vite's `define` in
        // tests/browser/vite.phase2b.config.js. Read only behind typeof guards.
        __PHASE2B_BROWSER_TEST_ENV__: 'readonly',
        __PHASE2B_BROWSER_TEST_CONFIG__: 'readonly',
      },
    },
  },
])
