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
      "gemini-3.6-flash",
      "gemini-3.6-flash-standard-ceiling-2027-01-01",
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
    assert.match(artifact, /providerAppCheckReadyPromise\.then\(\(appCheckReady\) =>/);
    assert.match(
      artifact,
      /resolveLiveProviderInsightsBrowserActivation\(\{\s*buildEnabled: VERSION3_GEMINI_LIVE_BUILD_ENABLED,\s*buildProjectId: VERSION3_GEMINI_LIVE_BUILD_PROJECT_ID,/,
    );
    assert.equal(
      artifact.match(/\bproviderInsightsEnabled\s*=/g)?.length,
      2,
      "the artifact may initialize and combine the two reviewed gates, but must not re-enable it elsewhere",
    );
    assert.match(artifact, /!providerInsightsEnabled \|\| providerQuestionLoading/);
    assert.match(artifact, /data-testid="provider-quick-question"/);
    assert.match(artifact, /data-testid="provider-question-submit"/);
    assert.doesNotMatch(artifact, /data-testid="provider-insights-action"/);
    assert.doesNotMatch(
      artifact,
      /ReCaptchaEnterpriseProvider|getLimitedUseTokenFn/,
      "the default production artifact must not ship the disabled App Check implementation",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("authorized live artifact requires verified App Check, V2, and limited-use callable tokens", () => {
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
    assert.match(artifact, new RegExp(siteKey));
    assert.match(artifact, /new ReCaptchaEnterpriseProvider\(key\)/);
    assert.match(artifact, /const tokenResult = await getLimitedUseTokenFn\(/);
    assert.match(artifact, /var VERSION3_GEMINI_LIVE_BUILD_ENABLED = true;/);
    assert.match(artifact, /var VERSION3_GEMINI_LIVE_BUILD_PROJECT_ID = "morgan-bank";/);
    assert.match(artifact, /limitedUseAppCheckTokens: true/);
    assert.match(artifact, /providerAppCheckReadyPromise\.then\(\(appCheckReady\) =>/);
    assert.match(artifact, /appCheckReady,/);
    assert.match(artifact, /v2Enabled: IS_MULTI_TEACHER_V2_ENABLED/);
    assert.match(artifact, /providerInsightsEnabled = true/);
    assert.doesNotMatch(artifact, /GEMINI_API_KEY|@google\/genai|gemini-3\.(?:5|6)-flash/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("live production-form artifact remains disabled when the V2 build flag is absent", () => {
  const outDir = mkdtempSync(join(tmpdir(), "morgan-bank-version3-live-v2-off-artifact-"));
  const env = {
    ...process.env,
    CI: "true",
    VITE_VERSION3_GEMINI_LIVE: "true",
    VITE_VERSION3_GEMINI_PROJECT_ID: "morgan-bank",
    VITE_FIREBASE_APP_CHECK_SITE_KEY: "test-only-recaptcha-enterprise-site-key",
  };
  delete env.VITE_MULTI_TEACHER_V2_ENABLED;
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
    assert.match(artifact, /var IS_MULTI_TEACHER_V2_ENABLED = false;/);
    assert.match(artifact, /v2Enabled: IS_MULTI_TEACHER_V2_ENABLED/);
    assert.match(artifact, /&& v2Enabled === true/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
