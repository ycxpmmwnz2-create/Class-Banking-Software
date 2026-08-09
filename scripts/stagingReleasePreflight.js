import process from "node:process";
import { pathToFileURL } from "node:url";

import { resolveFirebaseBuildConfiguration } from "../src/firebase/firebaseConfig.js";

export const STAGING_REVIEWED_FUNCTIONS_RELEASE_ID = "student-money-functions-v3";

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PROJECT_ROUTING_VARIABLES = Object.freeze([
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT"
]);
const EMULATOR_VARIABLES = Object.freeze([
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_DATABASE_EMULATOR_HOST",
  "FIREBASE_STORAGE_EMULATOR_HOST",
  "PUBSUB_EMULATOR_HOST",
  "FUNCTIONS_EMULATOR",
  "FIREBASE_EMULATOR_HUB"
]);

function exactString(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${key} must be a non-empty canonical string.`);
  }
  return value;
}

function rejectConfiguredEmulatorRouting(environment) {
  for (const key of EMULATOR_VARIABLES) {
    if (Object.prototype.hasOwnProperty.call(environment, key) &&
        environment[key] !== undefined && environment[key] !== "") {
      throw new Error(`${key} must be absent for a staging release.`);
    }
  }
}

export function validateStagingReleasePreflight(environment = {}) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Staging release environment must be an object.");
  }

  if (exactString(environment, "MORGAN_BANK_DEPLOYMENT_TIER") !== "staging") {
    throw new Error("MORGAN_BANK_DEPLOYMENT_TIER must be exactly staging.");
  }
  if (exactString(environment, "MULTI_TEACHER_V2_ENABLED") !== "true") {
    throw new Error("MULTI_TEACHER_V2_ENABLED must be exactly true.");
  }
  if (exactString(environment, "VITE_MORGAN_BANK_DEPLOYMENT_TIER") !== "staging") {
    throw new Error("VITE_MORGAN_BANK_DEPLOYMENT_TIER must be exactly staging.");
  }
  if (exactString(environment, "VITE_MULTI_TEACHER_V2_ENABLED") !== "true") {
    throw new Error("VITE_MULTI_TEACHER_V2_ENABLED must be exactly true.");
  }

  const configuredProjectId = exactString(environment, "MORGAN_BANK_STAGING_PROJECT_ID");
  const deployProjectId = exactString(environment, "MORGAN_BANK_DEPLOY_PROJECT_ID");
  const clientProjectId = exactString(environment, "VITE_FIREBASE_PROJECT_ID");

  if (!PROJECT_ID_PATTERN.test(configuredProjectId) ||
      configuredProjectId === "morgan-bank" || configuredProjectId.startsWith("demo-")) {
    throw new Error("The staging release project ID is invalid or prohibited.");
  }
  if (deployProjectId !== configuredProjectId || clientProjectId !== configuredProjectId) {
    throw new Error("The staging client, server, and deploy project IDs must match exactly.");
  }

  for (const key of PROJECT_ROUTING_VARIABLES) {
    if (!Object.prototype.hasOwnProperty.call(environment, key) ||
        environment[key] === undefined) continue;
    if (exactString(environment, key) !== configuredProjectId) {
      throw new Error(`${key} must match the exact staging project ID.`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(environment, "FIREBASE_CONFIG") &&
      environment.FIREBASE_CONFIG !== undefined && environment.FIREBASE_CONFIG !== "") {
    throw new Error("FIREBASE_CONFIG must be absent for the explicit staging release preflight.");
  }
  rejectConfiguredEmulatorRouting(environment);

  const releaseId = exactString(environment, "MULTI_TEACHER_V2_RELEASE_ID");
  if (releaseId !== STAGING_REVIEWED_FUNCTIONS_RELEASE_ID) {
    throw new Error("MULTI_TEACHER_V2_RELEASE_ID does not match the reviewed artifact.");
  }

  const client = resolveFirebaseBuildConfiguration(environment);
  if (!client.isStaging || client.firebaseConfig.projectId !== configuredProjectId) {
    throw new Error("The resolved client configuration is not the requested staging project.");
  }

  return Object.freeze({
    deploymentTier: "staging",
    projectId: configuredProjectId,
    releaseId,
    rulesFile: "firestore.phase3.final.rules"
  });
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    validateStagingReleasePreflight(process.env);
    globalThis.console.log("Staging release configuration preflight passed.");
  } catch (error) {
    globalThis.console.error(`Staging release configuration preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
