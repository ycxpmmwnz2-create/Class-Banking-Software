import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEPLOYMENT_TIERS,
  PRODUCTION_FIREBASE_CONFIG,
  resolveFirebaseBuildConfiguration
} from "./firebaseConfig.js";

function stagingEnvironment(overrides = {}) {
  const projectId = "morgan-bank-staging-test";
  return {
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

describe("Firebase build configuration isolation", () => {
  test("an absent tier preserves the exact production configuration", () => {
    const resolved = resolveFirebaseBuildConfiguration({});
    assert.equal(resolved.tier, DEPLOYMENT_TIERS.PRODUCTION);
    assert.equal(resolved.isStaging, false);
    assert.equal(resolved.firebaseConfig, PRODUCTION_FIREBASE_CONFIG);
    assert.deepEqual(resolved.firebaseConfig, {
      apiKey: "AIzaSyC-96VLdKfwtQ-WaFT6BA2q1WLnk8hDe1A",
      authDomain: "morgan-bank.firebaseapp.com",
      projectId: "morgan-bank",
      storageBucket: "morgan-bank.firebasestorage.app",
      messagingSenderId: "242031426628",
      appId: "1:242031426628:web:5caa4640a7eb7e3576d011",
      measurementId: "G-FG1ZHTHF7G"
    });
  });

  test("an explicit production tier rejects every staging Firebase field", () => {
    for (const key of [
      "VITE_FIREBASE_API_KEY",
      "VITE_FIREBASE_AUTH_DOMAIN",
      "VITE_FIREBASE_PROJECT_ID",
      "VITE_FIREBASE_STORAGE_BUCKET",
      "VITE_FIREBASE_MESSAGING_SENDER_ID",
      "VITE_FIREBASE_APP_ID",
      "VITE_FIREBASE_MEASUREMENT_ID"
    ]) {
      assert.throws(
        () => resolveFirebaseBuildConfiguration({
          VITE_MORGAN_BANK_DEPLOYMENT_TIER: "production",
          [key]: "unexpected"
        }),
        /Staging Firebase fields require/
      );
    }
  });

  test("a complete staging environment resolves a frozen isolated configuration", () => {
    const resolved = resolveFirebaseBuildConfiguration(stagingEnvironment());
    assert.equal(resolved.tier, DEPLOYMENT_TIERS.STAGING);
    assert.equal(resolved.isStaging, true);
    assert.equal(resolved.firebaseConfig.projectId, "morgan-bank-staging-test");
    assert.ok(Object.isFrozen(resolved));
    assert.ok(Object.isFrozen(resolved.firebaseConfig));
  });

  test("staging rejects each missing or non-canonical required field", () => {
    const required = [
      "VITE_FIREBASE_API_KEY",
      "VITE_FIREBASE_AUTH_DOMAIN",
      "VITE_FIREBASE_PROJECT_ID",
      "VITE_FIREBASE_STORAGE_BUCKET",
      "VITE_FIREBASE_MESSAGING_SENDER_ID",
      "VITE_FIREBASE_APP_ID"
    ];
    for (const key of required) {
      const environment = stagingEnvironment();
      delete environment[key];
      assert.throws(() => resolveFirebaseBuildConfiguration(environment), new RegExp(key));
      assert.throws(
        () => resolveFirebaseBuildConfiguration(stagingEnvironment({ [key]: ` padded ` })),
        new RegExp(key)
      );
    }
  });

  test("staging rejects a disabled V2 gate, unknown tier, and prohibited projects", () => {
    assert.throws(
      () => resolveFirebaseBuildConfiguration(stagingEnvironment({
        VITE_MULTI_TEACHER_V2_ENABLED: "false"
      })),
      /requires VITE_MULTI_TEACHER_V2_ENABLED=true/
    );
    assert.throws(
      () => resolveFirebaseBuildConfiguration({ VITE_MORGAN_BANK_DEPLOYMENT_TIER: "preview" }),
      /must be production or staging/
    );
    for (const projectId of ["morgan-bank", "demo-staging-project", "Bad_Project", "short"]) {
      assert.throws(
        () => resolveFirebaseBuildConfiguration(stagingEnvironment({
          VITE_FIREBASE_PROJECT_ID: projectId,
          VITE_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
          VITE_FIREBASE_STORAGE_BUCKET: `${projectId}.firebasestorage.app`
        })),
        /project ID is invalid or prohibited/
      );
    }
  });

  test("staging requires auth domain, bucket, sender, and app identity consistency", () => {
    assert.throws(
      () => resolveFirebaseBuildConfiguration(stagingEnvironment({
        VITE_FIREBASE_AUTH_DOMAIN: "morgan-bank.firebaseapp.com"
      })),
      /auth domain must match/
    );
    assert.throws(
      () => resolveFirebaseBuildConfiguration(stagingEnvironment({
        VITE_FIREBASE_STORAGE_BUCKET: "morgan-bank.firebasestorage.app"
      })),
      /storage bucket must match/
    );
    assert.throws(
      () => resolveFirebaseBuildConfiguration(stagingEnvironment({
        VITE_FIREBASE_MESSAGING_SENDER_ID: "sender-id"
      })),
      /sender ID is invalid/
    );
    assert.throws(
      () => resolveFirebaseBuildConfiguration(stagingEnvironment({
        VITE_FIREBASE_APP_ID: "not-an-app-id"
      })),
      /app ID is invalid/
    );
    assert.throws(
      () => resolveFirebaseBuildConfiguration(stagingEnvironment({
        VITE_FIREBASE_APP_ID: "1:999999999999:web:abcdef123456"
      })),
      /app ID must match its messaging sender ID/
    );
  });

  test("staging rejects every production Firebase identity value", () => {
    for (const [environmentKey, productionValue] of [
      ["VITE_FIREBASE_API_KEY", PRODUCTION_FIREBASE_CONFIG.apiKey],
      ["VITE_FIREBASE_MESSAGING_SENDER_ID", PRODUCTION_FIREBASE_CONFIG.messagingSenderId],
      ["VITE_FIREBASE_APP_ID", PRODUCTION_FIREBASE_CONFIG.appId],
      ["VITE_FIREBASE_MEASUREMENT_ID", PRODUCTION_FIREBASE_CONFIG.measurementId]
    ]) {
      assert.throws(
        () => resolveFirebaseBuildConfiguration(stagingEnvironment({
          [environmentKey]: productionValue
        })),
        /must not reuse the production value/
      );
    }
  });
});
