import assert from "node:assert/strict";
import test from "node:test";

import { initializeProviderAppCheckAndVerify } from "../../src/firebase/providerAppCheck.js";

const SITE_KEY = "test-only-recaptcha-enterprise-site-key";

test("provider App Check readiness requires a successful limited-use token exchange", async () => {
  const app = { name: "test-app" };
  const provider = { kind: "enterprise" };
  const appCheck = { app };
  const calls = [];

  const ready = await initializeProviderAppCheckAndVerify({
    app,
    siteKey: SITE_KEY,
    createProvider(siteKey) {
      calls.push(["provider", siteKey]);
      return provider;
    },
    initializeAppCheckFn(receivedApp, options) {
      calls.push(["initialize", receivedApp, options]);
      return appCheck;
    },
    async getLimitedUseTokenFn(receivedAppCheck) {
      calls.push(["token", receivedAppCheck]);
      return { token: "test-only-limited-use-token" };
    },
  });

  assert.equal(ready, true);
  assert.deepEqual(calls, [
    ["provider", SITE_KEY],
    ["initialize", app, {
      provider,
      isTokenAutoRefreshEnabled: true,
    }],
    ["token", appCheck],
  ]);
});

test("provider App Check readiness fails closed when token exchange rejects", async () => {
  await assert.rejects(
    initializeProviderAppCheckAndVerify({
      app: { name: "test-app" },
      siteKey: SITE_KEY,
      createProvider: () => ({ kind: "enterprise" }),
      initializeAppCheckFn: () => ({ app: true }),
      getLimitedUseTokenFn: async () => {
        throw new Error("untrusted recaptcha detail");
      },
    }),
    /untrusted recaptcha detail/,
  );
});

test("provider App Check readiness rejects a missing or malformed token result", async () => {
  for (const tokenResult of [undefined, {}, { token: "" }, { token: " padded " }]) {
    await assert.rejects(
      initializeProviderAppCheckAndVerify({
        app: { name: "test-app" },
        siteKey: SITE_KEY,
        createProvider: () => ({ kind: "enterprise" }),
        initializeAppCheckFn: () => ({ app: true }),
        getLimitedUseTokenFn: async () => tokenResult,
      }),
      /usable limited-use token/,
    );
  }
});
