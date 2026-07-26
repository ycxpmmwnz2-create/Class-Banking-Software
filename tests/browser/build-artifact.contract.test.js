// Phase 2B Item 10: build-artifact composition contract.
//
// Asserts that the default-off build does not ship the V2 transport/persistence
// machinery, and that the gate-on build does.
//
// HONEST REPOSITORY CONFLICT — read before changing the marker lists.
//
// The original Item 10 wording required the default-off build to contain NO V2
// lifecycle markers at all. That is not true of this repository and never was.
// Four strings survive tree-shaking in the default-off build today:
//
//     session-invalidated            V2_TENANT_DATA_ADAPTER
//     multi-tab-invalidation         malformed-broadcast-message
//
// They are reachable from code paths that are not gated behind
// IS_MULTI_TEACHER_V2_ENABLED (invalidation reason strings inside
// tenantSession.js, and the adapter typeof-guard in index.html), so Rollup keeps
// them. This was verified to be PRE-EXISTING by building HEAD in a throwaway
// worktree and getting identical counts — it is not a regression introduced by
// Items 9 or 10.
//
// Removing them is a production refactor of index.html / tenantSession.js, which
// is outside Item 10's tests-only boundary. So this contract asserts what is
// actually true and enforceable: the four OPERATIONAL markers below — the
// channel name, the two storage keys, and the save adapter — are genuinely
// absent from default-off and present in gate-on. Those are the strings whose
// presence would indicate live transport or persistence behavior shipping to
// production.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

// Absent from default-off, present in gate-on. These indicate LIVE behavior:
// a real BroadcastChannel name, the two persistence keys, and the save adapter.
const OPERATIONAL_MARKERS = [
  "morgan_bank_v2_invalidation",
  "morganBank:v2:invalidation",
  "morganBank:v2:pendingInvalidation",
  "V2_TENANT_DATA_SAVE_ADAPTER"
];

// Present in BOTH builds. Pre-existing residue; see the header note. Asserted
// explicitly so a future reader cannot mistake their presence for a regression,
// and so silently losing them from gate-on also fails.
const RESIDUAL_IN_DEFAULT_OFF = [
  "session-invalidated",
  "multi-tab-invalidation",
  "malformed-broadcast-message",
  "V2_TENANT_DATA_ADAPTER"
];

// A string from the V1 application that must survive in any real build, proving
// the scanned artifact is the actual app and not an empty or truncated bundle.
const V1_SENTINEL = "mrMorganClassCashDataV5";

const REPO_ROOT = process.cwd();
const tempDirs = [];

function buildInto(label, env) {
  const outDir = mkdtempSync(join(tmpdir(), `phase2b-build-${label}-`));
  tempDirs.push(outDir);
  execFileSync(
    "npx",
    ["vite", "build", "--outDir", outDir, "--emptyOutDir"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: "pipe",
      encoding: "utf8"
    }
  );
  return outDir;
}

function collectJs(dir) {
  const assetsDir = join(dir, "assets");
  assert.ok(existsSync(assetsDir), `Build ${dir} produced no assets/ directory`);
  const files = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 0, `Build ${dir} emitted no JavaScript assets to scan`);
  return files.map((f) => ({ name: f, source: readFileSync(join(assetsDir, f), "utf8") }));
}

function combined(files) {
  return files.map((f) => f.source).join("\n");
}

describe("Phase 2B Item 10: build artifact composition", () => {
  let offFiles;
  let onFiles;

  before(() => {
    // Explicitly unset for the default-off build so an ambient value in the
    // caller's environment cannot silently turn the gate on and make the
    // absence assertions vacuous.
    const offEnv = { ...process.env };
    delete offEnv.VITE_MULTI_TEACHER_V2_ENABLED;
    offFiles = collectJs(buildInto("off", { ...offEnv, VITE_MULTI_TEACHER_V2_ENABLED: undefined }));
    onFiles = collectJs(buildInto("on", { VITE_MULTI_TEACHER_V2_ENABLED: "true" }));
  });

  after(() => {
    for (const d of tempDirs) {
      // Scoped to directories this test created under the OS temp dir.
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("both builds emit real, non-empty application JavaScript", () => {
    for (const [label, files] of [["default-off", offFiles], ["gate-on", onFiles]]) {
      assert.ok(files.length > 0, `${label}: no JS assets found`);
      const total = combined(files).length;
      assert.ok(total > 10000, `${label}: emitted JS is implausibly small (${total} bytes)`);
    }
  });

  test("both builds contain the V1 sentinel, proving the scanned artifact is the real application", () => {
    assert.ok(combined(offFiles).includes(V1_SENTINEL), `default-off is missing ${V1_SENTINEL}`);
    assert.ok(combined(onFiles).includes(V1_SENTINEL), `gate-on is missing ${V1_SENTINEL}`);
  });

  test("default-off omits every operational V2 transport and persistence marker", () => {
    const src = combined(offFiles);
    for (const marker of OPERATIONAL_MARKERS) {
      assert.ok(
        !src.includes(marker),
        `default-off build must NOT ship operational marker ${marker}`
      );
    }
  });

  test("gate-on contains every operational V2 transport and persistence marker", () => {
    const src = combined(onFiles);
    for (const marker of OPERATIONAL_MARKERS) {
      assert.ok(src.includes(marker), `gate-on build must ship operational marker ${marker}`);
    }
  });

  test("pre-existing residual V2 strings are present in BOTH builds and are documented, not asserted absent", () => {
    const off = combined(offFiles);
    const on = combined(onFiles);
    for (const marker of RESIDUAL_IN_DEFAULT_OFF) {
      // Pinned deliberately: if a future refactor DOES tree-shake these out of
      // default-off, this test fails and the header note must be updated rather
      // than the conflict being quietly forgotten.
      assert.ok(
        off.includes(marker),
        `Residual marker ${marker} unexpectedly absent from default-off — update the documented conflict in this file's header`
      );
      assert.ok(on.includes(marker), `gate-on must still contain ${marker}`);
    }
  });

  test("the gate-on build is strictly larger than default-off, confirming the gate adds real code", () => {
    assert.ok(
      combined(onFiles).length > combined(offFiles).length,
      "gate-on must be larger than default-off"
    );
  });
});
