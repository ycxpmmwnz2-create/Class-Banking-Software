export const DEPLOYMENT_TIERS = Object.freeze({
  PRODUCTION: "production",
  STAGING: "staging"
});

export const PRODUCTION_FIREBASE_CONFIG = Object.freeze({
  apiKey: "AIzaSyC-96VLdKfwtQ-WaFT6BA2q1WLnk8hDe1A",
  authDomain: "morgan-bank.firebaseapp.com",
  projectId: "morgan-bank",
  storageBucket: "morgan-bank.firebasestorage.app",
  messagingSenderId: "242031426628",
  appId: "1:242031426628:web:5caa4640a7eb7e3576d011",
  measurementId: "G-FG1ZHTHF7G"
});

const STAGING_ENV_FIELDS = Object.freeze({
  VITE_FIREBASE_API_KEY: "apiKey",
  VITE_FIREBASE_AUTH_DOMAIN: "authDomain",
  VITE_FIREBASE_PROJECT_ID: "projectId",
  VITE_FIREBASE_STORAGE_BUCKET: "storageBucket",
  VITE_FIREBASE_MESSAGING_SENDER_ID: "messagingSenderId",
  VITE_FIREBASE_APP_ID: "appId"
});

const OPTIONAL_STAGING_ENV_FIELDS = Object.freeze({
  VITE_FIREBASE_MEASUREMENT_ID: "measurementId"
});

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

function exactNonBlankString(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${key} must be a non-empty canonical string.`);
  }
  return value;
}

function hasConfiguredStagingField(environment) {
  return [...Object.keys(STAGING_ENV_FIELDS), ...Object.keys(OPTIONAL_STAGING_ENV_FIELDS)]
    .some((key) => Object.prototype.hasOwnProperty.call(environment, key));
}

export function resolveFirebaseBuildConfiguration(environment = {}) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Firebase build environment must be an object.");
  }

  const rawTier = environment.VITE_MORGAN_BANK_DEPLOYMENT_TIER;
  const tier = rawTier === undefined ? DEPLOYMENT_TIERS.PRODUCTION : rawTier;

  if (tier === DEPLOYMENT_TIERS.PRODUCTION) {
    if (hasConfiguredStagingField(environment)) {
      throw new Error("Staging Firebase fields require the staging deployment tier.");
    }
    return Object.freeze({
      tier,
      isStaging: false,
      firebaseConfig: PRODUCTION_FIREBASE_CONFIG
    });
  }

  if (tier !== DEPLOYMENT_TIERS.STAGING) {
    throw new Error("VITE_MORGAN_BANK_DEPLOYMENT_TIER must be production or staging.");
  }
  if (environment.VITE_MULTI_TEACHER_V2_ENABLED !== "true") {
    throw new Error("A staging build requires VITE_MULTI_TEACHER_V2_ENABLED=true.");
  }

  const firebaseConfig = {};
  for (const [environmentKey, configKey] of Object.entries(STAGING_ENV_FIELDS)) {
    firebaseConfig[configKey] = exactNonBlankString(environment, environmentKey);
  }
  for (const [environmentKey, configKey] of Object.entries(OPTIONAL_STAGING_ENV_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(environment, environmentKey)) {
      firebaseConfig[configKey] = exactNonBlankString(environment, environmentKey);
    }
  }

  if (
    !PROJECT_ID_PATTERN.test(firebaseConfig.projectId) ||
    firebaseConfig.projectId === PRODUCTION_FIREBASE_CONFIG.projectId ||
    firebaseConfig.projectId.startsWith("demo-")
  ) {
    throw new Error("The staging Firebase project ID is invalid or prohibited.");
  }
  if (firebaseConfig.authDomain !== `${firebaseConfig.projectId}.firebaseapp.com`) {
    throw new Error("The staging Firebase auth domain must match its exact project ID.");
  }
  if (![
    `${firebaseConfig.projectId}.firebasestorage.app`,
    `${firebaseConfig.projectId}.appspot.com`
  ].includes(firebaseConfig.storageBucket)) {
    throw new Error("The staging Firebase storage bucket must match its exact project ID.");
  }
  if (!/^\d+$/.test(firebaseConfig.messagingSenderId)) {
    throw new Error("The staging Firebase messaging sender ID is invalid.");
  }
  if (!/^\d+:\d+:web:[A-Za-z0-9]+$/.test(firebaseConfig.appId)) {
    throw new Error("The staging Firebase app ID is invalid.");
  }

  return Object.freeze({
    tier,
    isStaging: true,
    firebaseConfig: Object.freeze(firebaseConfig)
  });
}
