import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

const REPO_ROOT = new URL("../../", import.meta.url);

describe("staging deployment artifacts", () => {
  test("the staging Firebase config pins final rules and contains no project identity", async () => {
    const raw = await readFile(new URL("firebase.staging.json", REPO_ROOT), "utf8");
    const config = JSON.parse(raw);

    assert.equal(config.firestore.rules, "firestore.phase3.final.rules");
    assert.equal(config.firestore.indexes, "firestore.indexes.json");
    assert.equal(config.functions[0].source, "functions");
    assert.equal(config.hosting.public, "dist");
    assert.equal(Object.prototype.hasOwnProperty.call(config, "project"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(config, "projects"), false);
    assert.equal(raw.includes('"morgan-bank"'), false);
    assert.equal(raw.includes("firebase deploy"), false);
    assert.equal(raw.includes("credential"), false);
  });

  test("the staging warning is static, outside the render root, and enabled only by the resolved tier", async () => {
    const source = await readFile(new URL("index.html", REPO_ROOT), "utf8");
    const bannerStart = source.indexOf('<div id="stagingDeploymentBanner"');
    const appStart = source.indexOf('<div id="app"></div>');

    assert.notEqual(bannerStart, -1);
    assert.notEqual(appStart, -1);
    assert.ok(bannerStart < appStart, "the persistent warning must precede the render root");
    assert.match(source, /TEST VERSION - USE FAKE DATA ONLY/);
    assert.match(source, /staging-deployment-banner\[hidden\] \{ display: none; \}/);
  });

  test("the warning is enabled before Firebase initialization consumes the resolver result", async () => {
    const source = await readFile(new URL("src/firebase/firebase.js", REPO_ROOT), "utf8");
    assert.match(source, /resolveFirebaseBuildConfiguration\(firebaseBuildEnvironment\)/);
    assert.match(source, /initializeApp\(firebaseConfig\)/);
    assert.match(source, /stagingDeploymentBanner\.hidden = false;/);
    assert.ok(
      source.indexOf("stagingDeploymentBanner.hidden = false;") <
        source.indexOf("initializeApp(firebaseConfig)"),
      "the static staging warning must be visible before Firebase initializes"
    );
    assert.doesNotMatch(source, /projectId:\s*"morgan-bank"/);
    assert.doesNotMatch(source, /window\..*FIREBASE/i);
  });

  test("Functions wires reviewed staging parameters only into the V2 invocation guard", async () => {
    const source = await readFile(new URL("functions/index.js", REPO_ROOT), "utf8");
    assert.match(
      source,
      /MORGAN_BANK_DEPLOYMENT_TIER = defineString\('MORGAN_BANK_DEPLOYMENT_TIER',[\s\S]*?default: 'production'/
    );
    assert.match(
      source,
      /MORGAN_BANK_STAGING_PROJECT_ID = defineString\('MORGAN_BANK_STAGING_PROJECT_ID',[\s\S]*?default: ''/
    );
    assert.match(
      source,
      /REVIEWED_V2_FUNCTIONS_RELEASE_ID = 'student-money-functions-v1'/
    );
    assert.match(source, /deploymentTier: MORGAN_BANK_DEPLOYMENT_TIER\.value\(\)/);
    assert.match(source, /stagingProjectId: MORGAN_BANK_STAGING_PROJECT_ID\.value\(\)/);
  });
});
