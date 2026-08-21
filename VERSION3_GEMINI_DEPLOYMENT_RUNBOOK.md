# Version 3 Gemini Functions deployment runbook

## Purpose

This runbook records the deployment coupling introduced by the protected live
Gemini callable. It does not authorize a secret change, Functions deployment,
feature-gate activation, provider call, or production operation.

The reviewed AI Insights experience requires release ID
`gemini-3.6-flash-morgan-bank-assistant-v3`. A deployment using another release
ID stays fail-closed. Changing the deployed runtime flag or release ID remains
a separate external-state authorization after code review.

## Shared-codebase secret requirement

`functions/index.js` declares `GEMINI_API_KEY` with `defineSecret` and binds it
only to `analyzeTeacherInsightsV3`. All production Functions nevertheless share
the single `default` codebase in `firebase.json`.

Firebase CLI discovers and resolves parameters for the entire targeted codebase
before applying an `--only functions:<name>` endpoint filter. Consequently, any
deployment from this reviewed Functions tree can require `GEMINI_API_KEY` to
exist even when the named function is unrelated and
`VERSION3_GEMINI_ENABLED=false`. The runtime feature gate does not bypass this
deploy-time requirement.

## Required order

1. Do not deploy this Functions tree to a project that lacks `GEMINI_API_KEY`.
   Hosting-only and rules-only deployments are outside this Functions coupling.
2. After the independent code reviews close and Andrew separately authorizes
   the secret operation for the exact Firebase project, create the restricted
   project-specific `GEMINI_API_KEY` secret. Never use a placeholder value and
   never copy the staging key into production.
3. Verify the secret metadata exists without reading or printing its value.
4. Deploy only the separately authorized function target. Deploying
   `analyzeTeacherInsightsV3` does not authorize enabling
   `VERSION3_GEMINI_ENABLED` or making a provider request.
5. Keep the Gemini runtime gate off until the callable, App Check enforcement,
   budget controls, and synthetic staging canary have each passed their own
   evidence and authorization gates.

If unrelated Functions must be independently deployable before the Gemini
secret is provisioned, stop and move the live callable to a separately reviewed
codebase first. Do not answer the CLI prompt by creating an unreviewed secret.
