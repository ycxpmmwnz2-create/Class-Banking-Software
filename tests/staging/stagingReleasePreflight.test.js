import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  STAGING_REVIEWED_FUNCTIONS_RELEASE_ID,
  validateStagingReleasePreflight
} from "../../scripts/stagingReleasePreflight.js";
import { PRODUCTION_FIREBASE_CONFIG } from "../../src/firebase/firebaseConfig.js";

function validEnvironment(overrides = {}) {
  const projectId = "morgan-bank-staging-test";
  return {
    MORGAN_BANK_DEPLOYMENT_TIER: "staging",
    MORGAN_BANK_STAGING_PROJECT_ID: projectId,
    MORGAN_BANK_DEPLOY_PROJECT_ID: projectId,
    MULTI_TEACHER_V2_ENABLED: "true",
    MULTI_TEACHER_V2_RELEASE_ID: STAGING_REVIEWED_FUNCTIONS_RELEASE_ID,
    VITE_MORGAN_BANK_DEPLOYMENT_TIER: "staging",
    VITE_MULTI_TEACHER_V2_ENABLED: "true",
    VITE_FIREBASE_API_KEY: "staging-public-api-key",
    VITE_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
    VITE_FIREBASE_PROJECT_ID: projectId,
    VITE_FIREBASE_STORAGE_BUCKET: `${projectId}.firebasestorage.app`,
    VITE_FIREBASE_MESSAGING_SENDER_ID: "123456789012",
    VITE_FIREBASE_APP_ID: "1:123456789012:web:abcdef123456",
    ...overrides
  };
}

describe("staging release preflight", () => {
  test("accepts one exact internally consistent staging release", () => {
    const result = validateStagingReleasePreflight(validEnvironment());
    assert.deepEqual(result, {
      deploymentTier: "staging",
      projectId: "morgan-bank-staging-test",
      releaseId: "student-money-functions-v2",
      rulesFile: "firestore.phase3.final.rules"
    });
    assert.ok(Object.isFrozen(result));
  });

  test("rejects missing, blank, or padded release boundary values", () => {
    for (const key of [
      "MORGAN_BANK_DEPLOYMENT_TIER",
      "MORGAN_BANK_STAGING_PROJECT_ID",
      "MORGAN_BANK_DEPLOY_PROJECT_ID",
      "MULTI_TEACHER_V2_ENABLED",
      "MULTI_TEACHER_V2_RELEASE_ID",
      "VITE_MORGAN_BANK_DEPLOYMENT_TIER",
      "VITE_MULTI_TEACHER_V2_ENABLED",
      "VITE_FIREBASE_PROJECT_ID"
    ]) {
      const missing = validEnvironment();
      delete missing[key];
      assert.throws(() => validateStagingReleasePreflight(missing), new RegExp(key));
      assert.throws(
        () => validateStagingReleasePreflight(validEnvironment({ [key]: " padded " })),
        new RegExp(key)
      );
    }
  });

  test("rejects production, demo, malformed, and mismatched targets", () => {
    for (const projectId of ["morgan-bank", "demo-staging-project", "Bad_Project", "short"]) {
      assert.throws(
        () => validateStagingReleasePreflight(validEnvironment({
          MORGAN_BANK_STAGING_PROJECT_ID: projectId,
          MORGAN_BANK_DEPLOY_PROJECT_ID: projectId,
          VITE_FIREBASE_PROJECT_ID: projectId,
          VITE_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
          VITE_FIREBASE_STORAGE_BUCKET: `${projectId}.firebasestorage.app`
        })),
        /project ID is invalid or prohibited/
      );
    }

    for (const key of ["MORGAN_BANK_DEPLOY_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID"]) {
      assert.throws(
        () => validateStagingReleasePreflight(validEnvironment({
          [key]: "another-staging-project"
        })),
        /must match exactly/
      );
    }
  });

  test("rejects disabled gates, incorrect tiers, and a mismatched release", () => {
    assert.throws(
      () => validateStagingReleasePreflight(validEnvironment({
        MORGAN_BANK_DEPLOYMENT_TIER: "production"
      })),
      /must be exactly staging/
    );
    assert.throws(
      () => validateStagingReleasePreflight(validEnvironment({
        MULTI_TEACHER_V2_ENABLED: "false"
      })),
      /must be exactly true/
    );
    assert.throws(
      () => validateStagingReleasePreflight(validEnvironment({
        VITE_MULTI_TEACHER_V2_ENABLED: "false"
      })),
      /must be exactly true/
    );
    assert.throws(
      () => validateStagingReleasePreflight(validEnvironment({
        MULTI_TEACHER_V2_RELEASE_ID: "unreviewed-functions"
      })),
      /does not match the reviewed artifact/
    );
  });

  test("rejects conflicting project routing and every emulator marker", () => {
    assert.throws(
      () => validateStagingReleasePreflight(validEnvironment({
        GCLOUD_PROJECT: "morgan-bank"
      })),
      /must match the exact staging project ID/
    );
    assert.doesNotThrow(() => validateStagingReleasePreflight(validEnvironment({
      GCLOUD_PROJECT: "morgan-bank-staging-test",
      GOOGLE_CLOUD_PROJECT: "morgan-bank-staging-test"
    })));
    assert.throws(
      () => validateStagingReleasePreflight(validEnvironment({
        FIREBASE_CONFIG: JSON.stringify({ projectId: "morgan-bank-staging-test" })
      })),
      /FIREBASE_CONFIG must be absent/
    );

    for (const key of [
      "FIRESTORE_EMULATOR_HOST",
      "FIREBASE_AUTH_EMULATOR_HOST",
      "FIREBASE_DATABASE_EMULATOR_HOST",
      "FIREBASE_STORAGE_EMULATOR_HOST",
      "PUBSUB_EMULATOR_HOST",
      "FUNCTIONS_EMULATOR",
      "FIREBASE_EMULATOR_HUB"
    ]) {
      assert.throws(
        () => validateStagingReleasePreflight(validEnvironment({ [key]: "configured" })),
        new RegExp(key)
      );
    }
  });

  test("reuses the client resolver for auth domain and bucket consistency", () => {
    assert.throws(
      () => validateStagingReleasePreflight(validEnvironment({
        VITE_FIREBASE_AUTH_DOMAIN: "morgan-bank.firebaseapp.com"
      })),
      /auth domain must match/
    );
    assert.throws(
      () => validateStagingReleasePreflight(validEnvironment({
        VITE_FIREBASE_STORAGE_BUCKET: "morgan-bank.firebasestorage.app"
      })),
      /storage bucket must match/
    );
  });

  test("inherits production identity and sender-binding refusals from the client resolver", () => {
    for (const [environmentKey, productionValue] of [
      ["VITE_FIREBASE_API_KEY", PRODUCTION_FIREBASE_CONFIG.apiKey],
      ["VITE_FIREBASE_MESSAGING_SENDER_ID", PRODUCTION_FIREBASE_CONFIG.messagingSenderId],
      ["VITE_FIREBASE_APP_ID", PRODUCTION_FIREBASE_CONFIG.appId],
      ["VITE_FIREBASE_MEASUREMENT_ID", PRODUCTION_FIREBASE_CONFIG.measurementId]
    ]) {
      assert.throws(
        () => validateStagingReleasePreflight(validEnvironment({
          [environmentKey]: productionValue
        })),
        /must not reuse the production value/
      );
    }
    assert.throws(
      () => validateStagingReleasePreflight(validEnvironment({
        VITE_FIREBASE_APP_ID: "1:999999999999:web:abcdef123456"
      })),
      /app ID must match its messaging sender ID/
    );
  });
});
