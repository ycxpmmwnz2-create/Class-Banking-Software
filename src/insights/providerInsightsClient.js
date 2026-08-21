/**
 * Browser boundary for the emulator-only provider-assisted Insights slice.
 *
 * This module is deliberately I/O-free except for the callable function that
 * the caller injects. It owns the exact browser request/response schema so an
 * unexpected server value is rejected before it can reach the teacher UI.
 */

export const VERSION3_GEMINI_BROWSER_PROJECT_ID =
  "demo-morgan-bank-version3-gemini-callable-browser";
export const VERSION3_GEMINI_LIVE_PROJECT_IDS = Object.freeze({
  production: "morgan-bank",
  staging: "morgan-bank-staging",
});
export const PROVIDER_INSIGHTS_MODES = Object.freeze(["quick", "deep"]);
export const PROVIDER_INSIGHTS_PERIODS = Object.freeze([7, 30, 90]);

const RESPONSE_FIELDS = Object.freeze([
  "schemaVersion",
  "source",
  "mode",
  "periodDays",
  "generatedAt",
  "observations",
  "orderedObservationIds",
  "groups",
  "teacherQuestions",
  "usage",
]);
const RUNTIME_FIELDS = Object.freeze([
  "enabled",
  "projectId",
  "host",
  "authPort",
  "functionsPort",
  "firestorePort",
]);
const REQUEST_FIELDS = Object.freeze(["requestId", "mode", "periodDays"]);
const QUESTION_REQUEST_FIELDS = Object.freeze([
  "requestId",
  "kind",
  "periodDays",
  "timeZone",
  "question",
]);
const QUESTION_RESPONSE_FIELDS = Object.freeze([
  "schemaVersion",
  "source",
  "periodDays",
  "generatedAt",
  "answer",
  "evidence",
  "usage",
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const OBSERVATION_ID_PATTERN = /^obs-[0-9]{3}$/;
const PRIORITIES = Object.freeze(["attention", "notable", "context"]);
const GROUP_LABELS = Object.freeze(["review-first", "watch", "context"]);
const MODE_LIMITS = Object.freeze({
  quick: Object.freeze({
    observations: 4,
    questions: 3,
    outputTokens: 350,
    thinkingTokens: 4_096,
  }),
  deep: Object.freeze({
    observations: 20,
    questions: 6,
    outputTokens: 900,
    thinkingTokens: 4_096,
  }),
});

export class ProviderInsightsClientError extends Error {
  constructor(category, message) {
    super(message);
    this.name = "ProviderInsightsClientError";
    this.category = category;
  }
}

function fail(category, message) {
  throw new ProviderInsightsClientError(category, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((field, index) => field === wanted[index]);
}

function requireExactObject(value, expected, label, category = "invalid-response") {
  if (!hasExactKeys(value, expected)) {
    fail(category, `${label} has an unexpected shape.`);
  }
}

function boundedText(value, minimum, maximum, label) {
  const hasDisallowedControl = typeof value === "string" && [...value].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint === 127
      || (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13);
  });
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || value.trim() !== value
    || hasDisallowedControl
  ) {
    fail("invalid-response", `${label} is malformed.`);
  }
  return value;
}

function nonNegativeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("invalid-response", `${label} is malformed.`);
  }
  return value;
}

/**
 * Default-off activation. Both compile-time values and the synchronously
 * injected runtime object must independently select the one demo project.
 */
export function resolveProviderInsightsBrowserActivation({
  buildEnabled,
  buildProjectId,
  runtimeConfig,
} = {}) {
  if (buildEnabled !== true || buildProjectId !== VERSION3_GEMINI_BROWSER_PROJECT_ID) {
    return false;
  }
  if (!hasExactKeys(runtimeConfig, RUNTIME_FIELDS)) return false;
  return runtimeConfig.enabled === true
    && runtimeConfig.projectId === VERSION3_GEMINI_BROWSER_PROJECT_ID
    && runtimeConfig.projectId === buildProjectId
    && (runtimeConfig.host === "127.0.0.1" || runtimeConfig.host === "localhost")
    && runtimeConfig.authPort === 9099
    && runtimeConfig.functionsPort === 5001
    && runtimeConfig.firestorePort === 8080;
}

export function resolveLiveProviderInsightsBrowserActivation({
  buildEnabled,
  buildProjectId,
  appProjectId,
  deploymentTier,
  appCheckReady,
  v2Enabled,
} = {}) {
  const expectedProjectId = VERSION3_GEMINI_LIVE_PROJECT_IDS[deploymentTier];
  return buildEnabled === true
    && appCheckReady === true
    && v2Enabled === true
    && typeof expectedProjectId === "string"
    && buildProjectId === expectedProjectId
    && appProjectId === expectedProjectId;
}

export function validateProviderInsightsRequest(value) {
  requireExactObject(value, REQUEST_FIELDS, "request", "invalid-request");
  if (!REQUEST_ID_PATTERN.test(value.requestId)) {
    fail("invalid-request", "requestId is malformed.");
  }
  if (!PROVIDER_INSIGHTS_MODES.includes(value.mode)) {
    fail("invalid-request", "mode is unsupported.");
  }
  if (!PROVIDER_INSIGHTS_PERIODS.includes(value.periodDays)) {
    fail("invalid-request", "periodDays is unsupported.");
  }
  return Object.freeze({
    requestId: value.requestId,
    mode: value.mode,
    periodDays: value.periodDays,
  });
}

export function createProviderInsightsRequestId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === "function") {
    const value = cryptoApi.randomUUID();
    if (REQUEST_ID_PATTERN.test(value)) return value;
  }
  if (typeof cryptoApi?.getRandomValues !== "function") {
    fail("crypto-unavailable", "Secure random request IDs are unavailable.");
  }
  const bytes = new Uint8Array(18);
  cryptoApi.getRandomValues(bytes);
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  if (!REQUEST_ID_PATTERN.test(value)) {
    fail("crypto-unavailable", "Secure random request IDs are unavailable.");
  }
  return value;
}

export function validateProviderQuestionRequest(value) {
  requireExactObject(value, QUESTION_REQUEST_FIELDS, "question request", "invalid-request");
  if (!REQUEST_ID_PATTERN.test(value.requestId) || value.kind !== "question") {
    fail("invalid-request", "Question request identity is malformed.");
  }
  if (!PROVIDER_INSIGHTS_PERIODS.includes(value.periodDays)) {
    fail("invalid-request", "Question period is unsupported.");
  }
  const question = boundedRequestText(value.question, 3, 500, "question");
  const timeZone = boundedRequestText(value.timeZone, 1, 80, "timeZone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    fail("invalid-request", "Question timeZone is unsupported.");
  }
  return Object.freeze({
    requestId: value.requestId,
    kind: "question",
    periodDays: value.periodDays,
    timeZone,
    question,
  });
}

export function validateProviderQuestionResponse(value, expected = {}) {
  requireExactObject(value, QUESTION_RESPONSE_FIELDS, "question response");
  if (
    value.schemaVersion !== 1
    || value.source !== "ai-grounded"
    || !PROVIDER_INSIGHTS_PERIODS.includes(value.periodDays)
    || (expected.periodDays !== undefined && value.periodDays !== expected.periodDays)
  ) {
    fail("invalid-response", "Question response metadata is malformed.");
  }
  validateIsoTimestamp(value.generatedAt, "generatedAt");
  const answer = boundedText(value.answer, 1, 500, "answer");
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 4) {
    fail("invalid-response", "Question evidence is malformed.");
  }
  requireExactObject(
    value.usage,
    ["inputTokens", "outputTokens", "thinkingTokens", "costMicroUsd"],
    "question usage",
  );
  return Object.freeze({
    schemaVersion: 1,
    source: "ai-grounded",
    periodDays: value.periodDays,
    generatedAt: value.generatedAt,
    answer,
    evidence: Object.freeze(value.evidence.map(item => boundedText(item, 1, 320, "evidence"))),
    usage: Object.freeze({
      inputTokens: nonNegativeInteger(value.usage.inputTokens, "inputTokens"),
      outputTokens: nonNegativeInteger(value.usage.outputTokens, "outputTokens", 96),
      thinkingTokens: nonNegativeInteger(value.usage.thinkingTokens, "thinkingTokens", 4_096),
      costMicroUsd: nonNegativeInteger(value.usage.costMicroUsd, "costMicroUsd", 7_500_000),
    }),
  });
}

function validateReferenceList(value, allowedIds, label, { minimum, maximum }) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail("invalid-response", `${label} is malformed.`);
  }
  const seen = new Set();
  return Object.freeze(value.map(reference => {
    if (typeof reference !== "string" || !allowedIds.has(reference) || seen.has(reference)) {
      fail("invalid-response", `${label} has an invalid reference.`);
    }
    seen.add(reference);
    return reference;
  }));
}

export function validateProviderInsightsResponse(value, expected = {}) {
  requireExactObject(value, RESPONSE_FIELDS, "response");
  if (
    value.schemaVersion !== 2
    || value.source !== "provider-assisted"
    || !PROVIDER_INSIGHTS_MODES.includes(value.mode)
    || !PROVIDER_INSIGHTS_PERIODS.includes(value.periodDays)
  ) {
    fail("invalid-response", "Response metadata is malformed.");
  }
  if (
    (expected.mode !== undefined && value.mode !== expected.mode)
    || (expected.periodDays !== undefined && value.periodDays !== expected.periodDays)
  ) {
    fail("invalid-response", "Response does not match the request.");
  }
  const generatedAt = new Date(value.generatedAt);
  if (
    typeof value.generatedAt !== "string"
    || !Number.isFinite(generatedAt.getTime())
    || generatedAt.toISOString() !== value.generatedAt
  ) {
    fail("invalid-response", "generatedAt is malformed.");
  }

  const limits = MODE_LIMITS[value.mode];
  if (
    !Array.isArray(value.observations)
    || value.observations.length < 1
    || value.observations.length > limits.observations
  ) {
    fail("invalid-response", "observations is malformed.");
  }
  const observationIds = new Set();
  const observations = Object.freeze(value.observations.map((observation, index) => {
    requireExactObject(
      observation,
      ["id", "priority", "category", "title", "summary", "evidence"],
      `observations[${index}]`,
    );
    if (
      !OBSERVATION_ID_PATTERN.test(observation.id)
      || observationIds.has(observation.id)
      || !PRIORITIES.includes(observation.priority)
    ) {
      fail("invalid-response", "An observation is malformed.");
    }
    observationIds.add(observation.id);
    return Object.freeze({
      id: observation.id,
      priority: observation.priority,
      category: boundedText(observation.category, 1, 60, "category"),
      title: boundedText(observation.title, 1, 120, "title"),
      summary: boundedText(observation.summary, 1, 320, "summary"),
      evidence: boundedText(observation.evidence, 1, 320, "evidence"),
    });
  }));

  const orderedObservationIds = validateReferenceList(
    value.orderedObservationIds,
    observationIds,
    "orderedObservationIds",
    { minimum: observationIds.size, maximum: observationIds.size },
  );
  const orderedIdSet = new Set(orderedObservationIds);

  if (!Array.isArray(value.groups) || value.groups.length > GROUP_LABELS.length) {
    fail("invalid-response", "groups is malformed.");
  }
  const seenLabels = new Set();
  const groupedIds = new Set();
  const groups = Object.freeze(value.groups.map((group, index) => {
    requireExactObject(group, ["label", "observationIds"], `groups[${index}]`);
    if (!GROUP_LABELS.includes(group.label) || seenLabels.has(group.label)) {
      fail("invalid-response", "A group is malformed.");
    }
    seenLabels.add(group.label);
    const observationIdsForGroup = validateReferenceList(
      group.observationIds,
      orderedIdSet,
      `groups[${index}].observationIds`,
      { minimum: 1, maximum: orderedIdSet.size },
    );
    for (const id of observationIdsForGroup) {
      if (groupedIds.has(id)) fail("invalid-response", "An observation appears twice in groups.");
      groupedIds.add(id);
    }
    return Object.freeze({ label: group.label, observationIds: observationIdsForGroup });
  }));

  if (!Array.isArray(value.teacherQuestions) || value.teacherQuestions.length > limits.questions) {
    fail("invalid-response", "teacherQuestions is malformed.");
  }
  const teacherQuestions = Object.freeze(value.teacherQuestions.map((question, index) => {
    requireExactObject(
      question,
      ["kind", "text", "observationIds"],
      `teacherQuestions[${index}]`,
    );
    const text = boundedText(question.text, 3, 240, "teacher question");
    if (question.kind !== "suggestion" || !text.endsWith("?")) {
      fail("invalid-response", "A teacher question is malformed.");
    }
    return Object.freeze({
      kind: "suggestion",
      text,
      observationIds: validateReferenceList(
        question.observationIds,
        orderedIdSet,
        `teacherQuestions[${index}].observationIds`,
        { minimum: 1, maximum: orderedIdSet.size },
      ),
    });
  }));

  requireExactObject(
    value.usage,
    ["inputTokens", "outputTokens", "thinkingTokens", "costMicroUsd"],
    "usage",
  );
  const usage = Object.freeze({
    inputTokens: nonNegativeInteger(value.usage.inputTokens, "inputTokens"),
    outputTokens: nonNegativeInteger(value.usage.outputTokens, "outputTokens", limits.outputTokens),
    thinkingTokens: nonNegativeInteger(
      value.usage.thinkingTokens,
      "thinkingTokens",
      limits.thinkingTokens,
    ),
    costMicroUsd: nonNegativeInteger(value.usage.costMicroUsd, "costMicroUsd", 7_500_000),
  });
  return Object.freeze({
    schemaVersion: 2,
    source: "provider-assisted",
    mode: value.mode,
    periodDays: value.periodDays,
    generatedAt: value.generatedAt,
    observations,
    orderedObservationIds,
    groups,
    teacherQuestions,
    usage,
  });
}

export function createProviderInsightsBrowserClient({ enabled, callable, cryptoApi } = {}) {
  if (enabled !== true) return null;
  if (typeof callable !== "function") {
    fail("invalid-client", "The provider Insights callable is unavailable.");
  }
  return Object.freeze({
    newRequestId: () => createProviderInsightsRequestId(cryptoApi),
    async analyze(request) {
      const accepted = validateProviderInsightsRequest(request);
      const result = await callable(accepted);
      return validateProviderInsightsResponse(result?.data, accepted);
    },
    async ask(request) {
      const accepted = validateProviderQuestionRequest(request);
      const result = await callable(accepted);
      return validateProviderQuestionResponse(result?.data, accepted);
    },
  });
}

/** Only allowlisted text reaches the page; raw SDK/provider errors are ignored. */
export function mapProviderInsightsError(error, { testMode = true } = {}) {
  const prefix = testMode ? "AI test" : "AI Insights";
  const featureLabel = testMode ? "AI test insights" : "AI Insights";
  const allowance = testMode ? "The test allowance" : "The AI Insights allowance";
  const code = String(error?.code || "").replace(/^functions\//, "");
  const details = error?.details;
  const detailCategory = isPlainObject(details) &&
    hasExactKeys(details, ["category"]) &&
    [
      "allowance-exhausted",
      "rate-limit-exhausted",
      "request-unavailable",
      "question-ambiguous",
      "question-sensitive",
    ].includes(details.category)
    ? details.category
    : "";
  if (detailCategory === "allowance-exhausted" && code === "resource-exhausted") {
    return Object.freeze({ ambiguous: false, message: `${allowance} is used up for now.` });
  }
  if (detailCategory === "rate-limit-exhausted" && code === "resource-exhausted") {
    return Object.freeze({ ambiguous: false, message: `The hourly ${prefix} limit was reached. Try again later.` });
  }
  if (detailCategory === "request-unavailable" && code === "failed-precondition") {
    return Object.freeze({ ambiguous: false, message: `This ${prefix} request cannot be retried. Start a new request.` });
  }
  if (detailCategory === "question-ambiguous" && code === "invalid-argument") {
    return Object.freeze({ ambiguous: false, message: "Ask about one student at a time and use the student’s full name." });
  }
  if (detailCategory === "question-sensitive" && code === "invalid-argument") {
    return Object.freeze({ ambiguous: false, message: "Remove email addresses, links, and phone numbers before asking." });
  }
  if (["unavailable", "deadline-exceeded", "internal", "unknown", "cancelled"].includes(code)) {
    return Object.freeze({
      ambiguous: true,
      message: "The result may still be finishing. Try the same request again.",
    });
  }
  if (code === "resource-exhausted") {
    return Object.freeze({ ambiguous: false, message: `${prefix} requests are temporarily limited. Try again later.` });
  }
  if (["unauthenticated", "permission-denied", "failed-precondition"].includes(code)) {
    return Object.freeze({ ambiguous: false, message: `${featureLabel} are not available for this classroom.` });
  }
  return Object.freeze({ ambiguous: false, message: `${featureLabel} could not be loaded. Try again later.` });
}

function boundedRequestText(value, minimum, maximum, label) {
  try {
    return boundedText(value, minimum, maximum, label);
  } catch {
    fail("invalid-request", `${label} is malformed.`);
  }
}

function validateIsoTimestamp(value, label) {
  const date = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail("invalid-response", `${label} is malformed.`);
  }
}
