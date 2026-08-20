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
    assert.match(
      artifact,
      /providerInsightsEnabled = resolveProviderInsightsBrowserActivation\(\{\s*buildEnabled: VERSION3_GEMINI_BROWSER_BUILD_ENABLED,\s*buildProjectId: VERSION3_GEMINI_BROWSER_BUILD_PROJECT_ID,/,
    );
    assert.equal(
      artifact.match(/\bproviderInsightsEnabled\s*=/g)?.length,
      2,
      "the artifact may initialize and resolve the gate, but must not re-enable it elsewhere",
    );
    assert.match(
      artifact,
      /providerInsightsEnabled \? `[\s\S]{0,2000}?data-testid="provider-insights-controls"/,
      "the assisted controls must remain reachable only through the hard-disabled gate",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
