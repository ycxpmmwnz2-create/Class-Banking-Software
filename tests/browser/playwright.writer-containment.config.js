// Fictional combined writer rehearsal of the now-selected rules/saver composition.
import { fileURLToPath } from 'node:url';
import base from '../../playwright.config.js';
export default {
  ...base,
  testDir: '../phase3',
  testMatch: 'writer-containment.browser.spec.js',
  timeout: 180_000,
  use: { ...base.use, actionTimeout: 15_000 },
  webServer: { ...base.webServer, cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'node node_modules/vite/bin/vite.js --config tests/browser/vite.writer-containment.config.js --port 5273 --strictPort' },
};
