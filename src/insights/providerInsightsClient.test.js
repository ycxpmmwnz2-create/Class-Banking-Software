import assert from "node:assert/strict";
import test from "node:test";

import {
  VERSION3_GEMINI_BROWSER_PROJECT_ID,
  VERSION3_GEMINI_LIVE_PROJECT_IDS,
  createProviderInsightsBrowserClient,
  createProviderInsightsRequestId,
  mapProviderInsightsError,
  resolveLiveProviderInsightsBrowserActivation,
  resolveProviderInsightsBrowserActivation,
  validateProviderInsightsRequest,
  validateProviderInsightsResponse,
} from "./providerInsightsClient.js";

function response(overrides = {}) {
  return {
    schemaVersion: 2,
    source: "provider-assisted",
    mode: "quick",
    periodDays: 30,
    generatedAt: "2026-08-16T18:00:00.000Z",
    observations: [{
      id: "obs-001",
      priority: "attention",
      category: "Requests",
      title: "One request needs review",
      summary: "A student submitted one pending request.",
      evidence: "$25 is waiting for review.",
    }],
    orderedObservationIds: ["obs-001"],
    groups: [{ label: "review-first", observationIds: ["obs-001"] }],
    teacherQuestions: [{
      kind: "suggestion",
      text: "Would you like to review this request?",
      observationIds: ["obs-001"],
    }],
    usage: { inputTokens: 120, outputTokens: 70, thinkingTokens: 10, costMicroUsd: 500 },
    ...overrides,
  };
}

const runtimeConfig = {
  enabled: true,
  projectId: VERSION3_GEMINI_BROWSER_PROJECT_ID,
  host: "127.0.0.1",
  authPort: 9099,
  functionsPort: 5001,
  firestorePort: 8080,
};

test("activation requires the exact build flag, demo project, loopback host, and three ports", () => {
  const accepted = {
    buildEnabled: true,
    buildProjectId: VERSION3_GEMINI_BROWSER_PROJECT_ID,
    runtimeConfig,
  };
  assert.equal(resolveProviderInsightsBrowserActivation(accepted), true);
  assert.equal(resolveProviderInsightsBrowserActivation({ ...accepted, buildEnabled: false }), false);
  assert.equal(resolveProviderInsightsBrowserActivation({ ...accepted, buildProjectId: "morgan-bank" }), false);
  assert.equal(resolveProviderInsightsBrowserActivation({
    ...accepted,
    runtimeConfig: { ...runtimeConfig, host: "192.0.2.1" },
  }), false);
  assert.equal(resolveProviderInsightsBrowserActivation({
    ...accepted,
    runtimeConfig: { ...runtimeConfig, functionsPort: 443 },
  }), false);
  assert.equal(resolveProviderInsightsBrowserActivation({
    ...accepted,
    runtimeConfig: { ...runtimeConfig, extra: true },
  }), false);
});

test("live activation requires exact tier, project, build flag, and App Check", () => {
  for (const deploymentTier of ["production", "staging"]) {
    const projectId = VERSION3_GEMINI_LIVE_PROJECT_IDS[deploymentTier];
    const accepted = {
      buildEnabled: true,
      buildProjectId: projectId,
      appProjectId: projectId,
      deploymentTier,
      appCheckReady: true,
      v2Enabled: true,
    };
    assert.equal(resolveLiveProviderInsightsBrowserActivation(accepted), true);
    assert.equal(resolveLiveProviderInsightsBrowserActivation({ ...accepted, buildEnabled: false }), false);
    assert.equal(resolveLiveProviderInsightsBrowserActivation({ ...accepted, appCheckReady: false }), false);
    assert.equal(resolveLiveProviderInsightsBrowserActivation({ ...accepted, v2Enabled: false }), false);
    assert.equal(resolveLiveProviderInsightsBrowserActivation({ ...accepted, v2Enabled: undefined }), false);
    assert.equal(resolveLiveProviderInsightsBrowserActivation({ ...accepted, appProjectId: "morgan-bank-lookalike" }), false);
    assert.equal(resolveLiveProviderInsightsBrowserActivation({ ...accepted, deploymentTier: "preview" }), false);
  }
});

test("request IDs use cryptographic randomness and requests have exactly three fields", () => {
  const generated = createProviderInsightsRequestId({ randomUUID: () => "12345678-1234-4234-8234-123456789abc" });
  assert.equal(generated, "12345678-1234-4234-8234-123456789abc");
  assert.deepEqual(validateProviderInsightsRequest({
    requestId: generated,
    mode: "deep",
    periodDays: 90,
  }), { requestId: generated, mode: "deep", periodDays: 90 });
  assert.throws(
    () => validateProviderInsightsRequest({ requestId: generated, mode: "deep", periodDays: 90, classroomId: "x" }),
    /unexpected shape/,
  );
});

test("missing secure randomness fails closed through the generic allowlisted message", () => {
  let failure;
  try {
    createProviderInsightsRequestId({});
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.category, "crypto-unavailable");
  const safeError = mapProviderInsightsError(failure);
  assert.deepEqual(safeError, {
    ambiguous: false,
    message: "AI test insights could not be loaded. Try again later.",
  });
  assert.doesNotMatch(safeError.message, /crypto|random|unavailable/i);
});

test("validates and freezes the exact teacher response before returning it", () => {
  const accepted = validateProviderInsightsResponse(response(), { mode: "quick", periodDays: 30 });
  assert.equal(accepted.observations[0].evidence, "$25 is waiting for review.");
  assert.equal(Object.isFrozen(accepted), true);
  assert.throws(() => validateProviderInsightsResponse(response({ secret: "no" })), /unexpected shape/);
  assert.throws(() => validateProviderInsightsResponse(response({ orderedObservationIds: [] })), /malformed/);
  assert.throws(() => validateProviderInsightsResponse(response({ mode: "deep" }), { mode: "quick" }), /does not match/);
  assert.throws(() => validateProviderInsightsResponse(response({
    observations: [{ ...response().observations[0], title: " leading whitespace" }],
  })), /malformed/);
  assert.throws(() => validateProviderInsightsResponse(response({
    usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, costMicroUsd: 7_500_001 },
  })), /malformed/);
});

test("client sends only the accepted request and validates the callable envelope", async () => {
  const calls = [];
  const client = createProviderInsightsBrowserClient({
    enabled: true,
    cryptoApi: { randomUUID: () => "12345678-1234-4234-8234-123456789abc" },
    callable: async request => {
      calls.push(request);
      return { data: response() };
    },
  });
  const requestId = client.newRequestId();
  const result = await client.analyze({ requestId, mode: "quick", periodDays: 30 });
  assert.deepEqual(calls, [{ requestId, mode: "quick", periodDays: 30 }]);
  assert.equal(result.source, "provider-assisted");
  assert.equal(createProviderInsightsBrowserClient({ enabled: false }), null);
});

test("maps errors to short allowlisted messages and marks only ambiguous outcomes retryable", () => {
  assert.deepEqual(mapProviderInsightsError({ code: "functions/unavailable", message: "raw" }), {
    ambiguous: true,
    message: "The result may still be finishing. Try the same request again.",
  });
  assert.deepEqual(mapProviderInsightsError({ code: "functions/resource-exhausted" }), {
    ambiguous: false,
    message: "AI test requests are temporarily limited. Try again later.",
  });
  assert.deepEqual(mapProviderInsightsError({
    code: "functions/resource-exhausted",
    details: { category: "allowance-exhausted" },
  }), {
    ambiguous: false,
    message: "The test allowance is used up for now.",
  });
  assert.deepEqual(mapProviderInsightsError({
    code: "functions/resource-exhausted",
    details: { category: "rate-limit-exhausted" },
  }), {
    ambiguous: false,
    message: "The hourly AI test limit was reached. Try again later.",
  });
  assert.deepEqual(mapProviderInsightsError({
    code: "functions/failed-precondition",
    details: { category: "request-unavailable" },
  }), {
    ambiguous: false,
    message: "This AI test request cannot be retried. Start a new request.",
  });
  assert.deepEqual(mapProviderInsightsError({
    code: "functions/resource-exhausted",
    details: { category: "rate-limit-exhausted", raw: "do not render" },
  }), {
    ambiguous: false,
    message: "AI test requests are temporarily limited. Try again later.",
  });
  assert.deepEqual(mapProviderInsightsError({
    code: "functions/failed-precondition",
    details: { category: "allowance-exhausted" },
  }), {
    ambiguous: false,
    message: "AI test insights are not available for this classroom.",
  });
  const unknown = mapProviderInsightsError({ code: "functions/raw-secret", message: "do not render" });
  assert.equal(unknown.ambiguous, false);
  assert.doesNotMatch(unknown.message, /raw-secret|do not render/);
});

test("live errors use allowlisted Gemini wording without exposing raw details", () => {
  assert.deepEqual(mapProviderInsightsError({
    code: "functions/resource-exhausted",
    details: { category: "allowance-exhausted" },
    message: "sensitive upstream detail",
  }, { testMode: false }), {
    ambiguous: false,
    message: "The Gemini allowance is used up for now.",
  });
  const unknown = mapProviderInsightsError({
    code: "functions/raw-secret",
    message: "sensitive upstream detail",
  }, { testMode: false });
  assert.equal(unknown.message, "Gemini-assisted insights could not be loaded. Try again later.");
  assert.doesNotMatch(unknown.message, /sensitive|upstream/);
});
