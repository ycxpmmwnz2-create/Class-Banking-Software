# Safari / WebKit Compatibility — Handoff to Codex

**Date:** 2026-08-02
**From:** Claude (Opus 5)
**Goal:** Make Morgan Bank work on Safari, not just Chrome. Andrew uses Safari personally; students use Chrome. Broad browser compatibility is a commercial requirement — he intends to sell this.

**Status:** Investigation complete, one real bug isolated and characterized. **No fix attempted.** No application code changed.

---

## TL;DR for the next agent

Run the existing 24-test Playwright browser suite against WebKit. It produces **exactly one reproducible Safari-specific failure**:

> `tests/phase3/tenant-data.browser.spec.js:177` — after the deliberately-inert `clearTransactions()` / `resetEverything()` calls, the student roster (`A_ONLY_STUDENT`) is **absent from the settings screen in WebKit** but present in Chromium.

Everything else that failed was either flaky-under-load or a timing artifact. Details and proof below.

---

## 1. Environment set up today (already done, don't redo)

| Thing | State |
|---|---|
| Safari Technology Preview 27.0 (release 249) | Installed at `/Applications/Safari Technology Preview.app`, Apple-signature verified |
| `safaridriver --mcp` | Works. 17 browser tools. STP-only — stable Safari's safaridriver has no `--mcp` flag |
| "Allow Remote Automation" | **Enabled.** On macOS 26+ it lives in Develop → **Developer Settings…**, NOT the Develop menu directly. `sudo safaridriver --enable` runs clean but does NOT flip this gate |
| MCP server in Claude | `safari-mcp-stp`, **local scope** (this repo only), in `~/.claude.json` |
| MCP server in Codex | `[mcp_servers.safari-mcp-stp]` in `~/.codex/config.toml`, verified via `codex mcp list` → `enabled` |
| Playwright WebKit | **Installed**: WebKit 26.5 (playwright webkit v2336) at `~/Library/Caches/ms-playwright/webkit-2336` |

Repo is clean — `git status` empty. `test-results/` is gitignored. This handoff file is the only new tracked-visible file.

---

## 2. Evidence gathered

### Chromium baseline — CLEAN
```
24 passed (1.7m), exit 0
```

### WebKit — two runs of the identical suite
| | Run 1 | Run 2 |
|---|---|---|
| Passed | 20 | 22 |
| Failed | 4 | 2 |

Run 1 failures:
- `tests/browser/tenant-isolation.spec.js:493`
- `tests/browser/tenant-isolation.spec.js:1021`
- `tests/phase3/tenant-data.browser.spec.js:49`
- `tests/phase3/tenant-data.browser.spec.js:143`

Run 2 failures:
- `tests/browser/tenant-isolation.spec.js:493`
- `tests/phase3/tenant-data.browser.spec.js:143`

### Slow-vs-hung discriminator (test timeout 240s, expect timeout 90s)
```
✓ tenant-isolation.spec.js:493  PASSED (4.4s)   <- was a timing/contention failure
✘ tenant-data.browser.spec.js:143  FAILED (3.8s) <- real; fails fast despite 90s budget
```

**This is the key result.** A test that fails in 3.8 seconds with a 90-second timeout is not slow — it is behaviorally different.

---

## 3. The one real bug

**Test:** `tests/phase3/tenant-data.browser.spec.js:143`
`'Phase 3 V2 destructive controls are absent and direct invocation is inert'`

**Failing assertion:** line 177
```js
const before = await page.evaluate(() => ({ uid, eventCount, body: document.body.innerText }))
await page.evaluate(() => window.clearTransactions())   // inert by design
await waitForQuiescence(page)
await page.evaluate(() => window.resetEverything())     // inert by design
await waitForQuiescence(page)
const after = await page.evaluate(() => ({ uid, eventCount, body: document.body.innerText }))

expect(after.uid).toBe(before.uid)               // PASSES in WebKit
expect(after.eventCount).toBe(before.eventCount) // PASSES in WebKit
expect(after.body).toContain('A_ONLY_STUDENT')   // <-- FAILS in WebKit, passes in Chromium
expect(before.body).toContain('A_ONLY_STUDENT')  // NEVER EXECUTED (177 throws first)
```

`A_ONLY_STUDENT` is `TENANT_A.studentMarker`, defined at `tests/browser/phase2b-fixtures.js:72`.

**Page snapshot at failure** (`test-results/tenant-isolation-Phase-3-V-f86d8--direct-invocation-is-inert-webkit/error-context.md`) shows the settings screen rendered correctly — "Student Login History", the "Student" dropdown label, the "separately reviewed server workflow" notice — but **no student name in the dropdown**.

### ⚠️ Critical open question — resolve this first

**Line 178 never ran.** So it is NOT established whether `before.body` contained the marker. Two very different diagnoses:

- **(a)** `before` HAS it, `after` LOST it → the inert destructive calls are destroying roster state in WebKit. Higher severity: an operation documented as inert has a visible side effect on Safari only.
- **(b)** NEITHER has it → the settings screen simply never renders student names in WebKit. Different bug, different fix.

**Weak evidence for (a):** `tenant-data.browser.spec.js:49` (which asserts the marker renders after sign-in) PASSED in WebKit run 2, so the roster does render in WebKit generally. Not conclusive — that's a different screen and a different point in the flow.

**Cheapest way to settle it:** swap the order of lines 177 and 178, or capture both bodies and diff them. Don't guess.

---

## 4. Hypotheses already DISPROVED — do not re-investigate

These looked like obvious Safari bugs. Both were tested and cleared. Re-"fixing" them would be churn.

**1. Date parsing — NOT a bug.**
The app stores dates as `new Date().toLocaleString()` (`index.html:1338`, `1605`, `1671`, `1732`, `1786`, `2485`, `2532`) and re-parses with `new Date(transaction.date)` (`index.html:1015`, `1024`, `1053`, `2724`). This is the classic Safari-breaks-on-non-ISO-dates pattern. Verified against **JavaScriptCore, the engine Safari actually ships**:
```
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
  -e 'print(new Date("8/2/2026, 9:15:30 AM").toString())'
# -> Sun Aug 02 2026 09:15:30 GMT-0600  (parses fine)
```
Modern JSC parses it. **Latent risk worth noting for the commercial goal, but not today's bug:** the stored string is locale-dependent. A browser set to en-GB or de-DE writes `02/08/2026, 09:15:30` or `2.8.2026, 09:15:30`, which is ambiguous or unparseable when read elsewhere. Storing ISO-8601 would be strictly more robust for a product you intend to sell. Not required to fix the WebKit failure.

**2. `innerText` on `<select>`/`<option>` — NOT a difference.**
Hypothesis was that WebKit excludes option text from `document.body.innerText`. Tested both engines head-to-head with a minimal page:
```
chromium: "Settings\nA_ONLY_STUDENT\nOTHER_KID\n1/1/2026\tSuccess"
webkit:   "Settings\nA_ONLY_STUDENT\nOTHER_KID\n1/1/2026\tSuccess"
```
Byte-identical. The missing marker is real absence, not an extraction artifact.

---

## 5. Traps that will waste your time

**⚠️ ALWAYS pass `--project=<name>` explicitly.**
Without it, runs reported `[webkit]` labels even when pointed at `playwright.config.js` (which defines only `chromium`). A Playwright **test-server from the VS Code extension** is running:
```
node_modules/@playwright/test/cli.js test-server -c playwright.config.js --host 127.0.0.1
```
This was **not fully root-caused** — I confirmed `--list` resolves correctly at every layer (plain, scrubbed env, inside `emulators:exec`), so the wrapper is not the cause. Treat any run without an explicit `--project` as untrustworthy evidence. The Chromium baseline and both cited WebKit runs used explicit `--project`.

**⚠️ The suite is flaky under full-suite load, independent of browser.**
Consecutive identical runs failed *different* tests. This is a release-gate liability worth raising with Andrew separately from the Safari work. Tests that failed under load but passed in isolation: `tenant-isolation.spec.js:493`, `:1021`, `tenant-data.browser.spec.js:49`.

**⚠️ ADC guard.** Every emulator script refuses to run if `~/.config/gcloud/application_default_credentials.json` exists. Do not create one — it silently disables most test gates. The commands below preserve that guard.

**⚠️ Orphaned Safari instances (only if you use the MCP server, not Playwright).**
Killing the MCP server without ending the WebDriver session leaves a full STP instance alive (~250–290 MB each). Verified behavior: quitting STP kills exactly one automation instance per quit, newest-first, and the user's normal window is always last.
```bash
# sweep orphans, leave the user's window alone
ps -Ao pid,args | grep "MacOS/Safari Technology Preview" | grep automation | grep -v grep | awk '{print $1}' | xargs kill
```

**⚠️ `evaluate_javascript` (Safari MCP tool)** takes `expression`, not `script`, and treats it as a **function body** — omit `return` and it silently yields `null` instead of erroring.

---

## 6. Copy-paste commands

All are self-contained, run from the repo root, and preserve the ADC guard and env scrubbing the npm scripts use.

### Create the WebKit config (lives outside the repo; recreate if missing)
```bash
mkdir -p /tmp/mb-webkit && cat > /tmp/mb-webkit/playwright.webkit.config.js <<'EOF'
import { defineConfig, devices } from "/Users/andrewmorgan/Documents/GitHub/Class-Banking-Software/node_modules/@playwright/test/index.mjs";
const REPO = "/Users/andrewmorgan/Documents/GitHub/Class-Banking-Software";
export const BROWSER_TEST_PORT = 5273;
export default defineConfig({
  testDir: `${REPO}/tests/browser`,
  testMatch: /.*\.spec\.js$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${BROWSER_TEST_PORT}`, trace: "retain-on-failure", video: "off" },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  webServer: {
    command: `npx vite --config tests/browser/vite.phase2b.config.js --port ${BROWSER_TEST_PORT} --strictPort`,
    cwd: REPO,
    url: `http://127.0.0.1:${BROWSER_TEST_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000
  }
});
EOF
```
Note the **absolute import specifier** — the config sits outside the repo, so bare-module resolution can't reach `node_modules`.

### Run the full suite against WebKit
```bash
cd /Users/andrewmorgan/Documents/GitHub/Class-Banking-Software && \
test ! -f "$HOME/.config/gcloud/application_default_credentials.json" || { echo "REFUSING: ADC exists."; exit 1; }; \
cfg=$(mktemp -d /tmp/mb-wk.XXXXXX) && mkdir -p "$cfg/configstore" && \
printf '%s\n' '{"motd":{"fetched":4102444800000}}' > "$cfg/configstore/firebase-tools.json" && \
env -u DEBUG -u PHASE3_REHEARSAL_MODE -u MULTI_TEACHER_V2_ENABLED -u MULTI_TEACHER_V2_RELEASE_ID \
    -u GOOGLE_APPLICATION_CREDENTIALS -u google_application_credentials -u FIREBASE_TOKEN \
    -u GCLOUD_PROJECT -u GOOGLE_CLOUD_PROJECT -u FIREBASE_CONFIG -u FIRESTORE_EMULATOR_HOST \
    -u FIREBASE_AUTH_EMULATOR_HOST -u FUNCTIONS_EMULATOR \
    XDG_CONFIG_HOME="$cfg" METADATA_SERVER_DETECTION=none CI=true FIREBASE_CLI_DISABLE_UPDATE_CHECK=true \
    firebase emulators:exec --project demo-morgan-bank-phase2b-server-test --only auth,functions,firestore \
    "npx playwright test --config /tmp/mb-webkit/playwright.webkit.config.js --project=webkit"; \
rm -rf "$cfg"
```

### Run ONLY the failing test (fast iteration)
Append to the playwright command above:
```
--grep 'destructive controls are absent'
```

### Chromium baseline (must stay 24/24)
```bash
cd /Users/andrewmorgan/Documents/GitHub/Class-Banking-Software && \
test ! -f "$HOME/.config/gcloud/application_default_credentials.json" || { echo "REFUSING: ADC exists."; exit 1; }; \
cfg=$(mktemp -d /tmp/mb-cr.XXXXXX) && mkdir -p "$cfg/configstore" && \
printf '%s\n' '{"motd":{"fetched":4102444800000}}' > "$cfg/configstore/firebase-tools.json" && \
env -u DEBUG -u PHASE3_REHEARSAL_MODE -u MULTI_TEACHER_V2_ENABLED -u MULTI_TEACHER_V2_RELEASE_ID \
    -u GOOGLE_APPLICATION_CREDENTIALS -u google_application_credentials -u FIREBASE_TOKEN \
    -u GCLOUD_PROJECT -u GOOGLE_CLOUD_PROJECT -u FIREBASE_CONFIG -u FIRESTORE_EMULATOR_HOST \
    -u FIREBASE_AUTH_EMULATOR_HOST -u FUNCTIONS_EMULATOR \
    XDG_CONFIG_HOME="$cfg" METADATA_SERVER_DETECTION=none CI=true FIREBASE_CLI_DISABLE_UPDATE_CHECK=true \
    firebase emulators:exec --project demo-morgan-bank-phase2b-server-test --only auth,functions,firestore \
    "npx playwright test --config playwright.config.js --project=chromium"; \
rm -rf "$cfg"
```

### Inspect the failure trace
```bash
cd /Users/andrewmorgan/Documents/GitHub/Class-Banking-Software && \
npx playwright show-trace "test-results/tenant-isolation-Phase-3-V-f86d8--direct-invocation-is-inert-webkit/trace.zip"
```

---

## 7. Suggested order of work

1. **Settle the (a)-vs-(b) question in §3.** Capture both `before.body` and `after.body` and diff them. Everything downstream depends on which one it is.
2. **Root-cause the roster disappearance.** Instrument the tenant/roster state across `clearTransactions()` and `resetEverything()` in WebKit. Both are supposed to be inert; `uid` and `eventCount` are unchanged, so whatever differs is render/state, not identity or event flow.
3. **Fix, then re-verify BOTH engines.** Chromium must stay 24/24 — this is Phase 3 release-gate code and a Safari fix that regresses Chrome is a net loss.
4. **Raise the flakiness separately.** Don't let it get conflated with the Safari work.
5. **Decide with Andrew** whether `webkit` becomes a permanent second project in `playwright.config.js`. That changes what the release gates assert, so it's his call, not ours. Deliberately not done.

## 8. Not verified

- **Real Safari has not been tested** — only Playwright's WebKit 26.5. It's Safari's engine but misses Safari-specific UI, ITP, and extension behavior. The `safari-mcp-stp` MCP server drives actual STP and is ready; in Claude it needs a session restart to load, and STP uses a separate profile so it starts logged out of everything.
- The VS Code Playwright test-server label anomaly (§5) was worked around, not explained.
- Only the Phase 2B/Phase 3 browser suite was run. No manual exploratory testing of the app in Safari was done.
