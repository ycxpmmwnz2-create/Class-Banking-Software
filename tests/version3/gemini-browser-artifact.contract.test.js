import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function collectJavaScript(outDir) {
  const assetsDir = join(outDir, "assets");
  assert.ok(existsSync(assetsDir), "production-form build produced no assets directory");
  const files = readdirSync(assetsDir).filter(name => name.endsWith(".js"));
  assert.ok(files.length > 0, "production-form build produced no JavaScript");
  return files.map(name => readFileSync(join(assetsDir, name), "utf8")).join("\n");
}

test("production-form artifact hard-disables assisted activation and keeps its controls gated", () => {
  const outDir = mkdtempSync(join(tmpdir(), "morgan-bank-version3-artifact-"));
  const env = {
    ...process.env,
    CI: "true",
    VITE_MULTI_TEACHER_V2_ENABLED: "true",
  };
  for (const name of [
    "VITE_VERSION3_GEMINI_BROWSER_TEST",
    "VITE_VERSION3_GEMINI_BROWSER_PROJECT_ID",
    "VITE_VERSION3_GEMINI_LIVE",
    "VITE_VERSION3_GEMINI_PROJECT_ID",
    "VITE_FIREBASE_APP_CHECK_SITE_KEY",
    "VITE_MORGAN_BANK_DEPLOYMENT_TIER",
    "VITE_FIREBASE_API_KEY",
    "VITE_FIREBASE_AUTH_DOMAIN",
    "VITE_FIREBASE_PROJECT_ID",
    "VITE_FIREBASE_STORAGE_BUCKET",
    "VITE_FIREBASE_MESSAGING_SENDER_ID",
    "VITE_FIREBASE_APP_ID",
    "VITE_FIREBASE_MEASUREMENT_ID",
  ]) {
    delete env[name];
  }

  try {
    execFileSync(
      "npx",
      ["vite", "build", "--minify=false", "--outDir", outDir, "--emptyOutDir"],
      { cwd: REPO_ROOT, env, encoding: "utf8", stdio: "pipe" },
    );
    const artifact = collectJavaScript(outDir);

    for (const forbidden of [
      "gemini-3.5-flash-lite",
      "gemini-3.5-flash-lite-standard-2026-08-19",
      "geminiProviderAdapter",
      "geminiCostPolicy",
    ]) {
      assert.ok(
        !artifact.includes(forbidden),
        `production artifact must not contain dormant real-Gemini marker ${forbidden}`,
      );
    }

    assert.match(artifact, /var VERSION3_GEMINI_BROWSER_BUILD_ENABLED = false;/);
    assert.match(artifact, /var VERSION3_GEMINI_BROWSER_BUILD_PROJECT_ID = void 0;/);
    assert.match(artifact, /var VERSION3_GEMINI_LIVE_BUILD_ENABLED = false;/);
    assert.match(artifact, /var VERSION3_GEMINI_LIVE_BUILD_PROJECT_ID = void 0;/);
    assert.match(
      artifact,
      /var providerInsightsEmulatorEnabled = resolveProviderInsightsBrowserActivation\(\{\s*buildEnabled: VERSION3_GEMINI_BROWSER_BUILD_ENABLED,\s*buildProjectId: VERSION3_GEMINI_BROWSER_BUILD_PROJECT_ID,/,
    );
    assert.match(
      artifact,
      /var providerInsightsLiveEnabled = resolveLiveProviderInsightsBrowserActivation\(\{\s*buildEnabled: VERSION3_GEMINI_LIVE_BUILD_ENABLED,\s*buildProjectId: VERSION3_GEMINI_LIVE_BUILD_PROJECT_ID,/,
    );
    assert.equal(
      artifact.match(/\bproviderInsightsEnabled\s*=/g)?.length,
      2,
      "the artifact may initialize and combine the two reviewed gates, but must not re-enable it elsewhere",
    );
    assert.match(
      artifact,
      /providerInsightsEnabled \? `[\s\S]{0,4000}?data-testid="provider-insights-controls"/,
      "the assisted controls must remain reachable only through the hard-disabled gate",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("authorized live artifact requires App Check and limited-use callable tokens", () => {
  const outDir = mkdtempSync(join(tmpdir(), "morgan-bank-version3-live-artifact-"));
  const siteKey = "test-only-recaptcha-enterprise-site-key";
  const env = {
    ...process.env,
    CI: "true",
    VITE_MULTI_TEACHER_V2_ENABLED: "true",
    VITE_VERSION3_GEMINI_LIVE: "true",
    VITE_VERSION3_GEMINI_PROJECT_ID: "morgan-bank",
    VITE_FIREBASE_APP_CHECK_SITE_KEY: siteKey,
  };
  for (const name of [
    "VITE_VERSION3_GEMINI_BROWSER_TEST",
    "VITE_VERSION3_GEMINI_BROWSER_PROJECT_ID",
    "VITE_MORGAN_BANK_DEPLOYMENT_TIER",
  ]) delete env[name];

  try {
    execFileSync(
      "npx",
      ["vite", "build", "--minify=false", "--outDir", outDir, "--emptyOutDir"],
      { cwd: REPO_ROOT, env, encoding: "utf8", stdio: "pipe" },
    );
    const artifact = collectJavaScript(outDir);
    assert.match(
      artifact,
      /if \(firebaseBuildEnvironment\.VITE_VERSION3_GEMINI_LIVE === "true"\)/,
    );
    assert.match(artifact, new RegExp(siteKey));
    assert.match(artifact, /new ReCaptchaEnterpriseProvider\(siteKey\)/);
    assert.match(artifact, /var VERSION3_GEMINI_LIVE_BUILD_ENABLED = true;/);
    assert.match(artifact, /var VERSION3_GEMINI_LIVE_BUILD_PROJECT_ID = "morgan-bank";/);
    assert.match(artifact, /limitedUseAppCheckTokens: true/);
    assert.match(artifact, /appCheckReady: providerAppCheckReady/);
    assert.match(artifact, /providerInsightsEnabled = providerInsightsEmulatorEnabled \|\| providerInsightsLiveEnabled/);
    assert.doesNotMatch(artifact, /GEMINI_API_KEY|@google\/genai|gemini-3\.5-flash-lite/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
