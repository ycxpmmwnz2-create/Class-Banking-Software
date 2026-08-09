# Morgan Bank staging-environment implementation brief

Status: **local implementation authorized; external project creation and deployment not authorized**

This brief defines one remotely accessible Morgan Bank test environment for
friends to exercise independent teacher accounts without touching the existing
`morgan-bank` production project or its observation window.

## Objective

Morgan Bank continues to have one source tree, while two Firebase deployments
may run different reviewed commits:

- production: the existing `morgan-bank` project and public site; and
- staging: one separately created Firebase project, Auth tenant, Firestore
  database, Functions deployment, and Hosting URL used only for fake test data.

Andrew sends friends only the staging URL. Andrew creates staging invitations
for their exact Google-account emails, and each friend onboards an isolated
staging classroom through the existing V2 path. Staging accounts and data are
never copied to production.

## Explicit non-goals

- Creating a Firebase or Google Cloud project in this implementation item.
- Enabling Google Authentication, billing, IAM, APIs, or an authorized domain.
- Deploying Functions, rules, indexes, or Hosting anywhere.
- Reading or changing the production project, its accounts, or its data.
- Changing the production observation or second-teacher schedule.
- Migrating staging users or test data into production.
- Assigning the first staging `platformAdmin` custom claim.
- Automatic invitation email, public signup, co-teachers, or shared classrooms.
- Safari compatibility work or `SAFARI_COMPAT_HANDOFF.md`.

Every external staging action remains a separate authorization boundary.

## Threat model and invariants

The staging path must prevent these failures:

1. A staging web build silently using the production Firebase configuration.
2. A production build accepting staging Firebase fields or displaying a test
   banner.
3. An arbitrary real Firebase project becoming an allowed V2 Functions target.
4. Staging widening the production migration runner's exact project allowlist.
5. A staging deployment using the recursive baseline, bridge, or rollback rules
   instead of `firestore.phase3.final.rules`.
6. A friend confusing the staging site or fake balances with the real product.
7. Emulator tests reaching a real staging or production project.
8. A staging admin capability coming from request data, local storage, or a
   browser flag rather than the existing signed custom-claim contract.

Production remains the fail-closed default. A missing, padded, malformed,
mixed, or contradictory staging value blocks startup or the V2 invocation.

## Client build contract

`src/firebase/firebaseConfig.js` is the pure configuration boundary.

When `VITE_MORGAN_BANK_DEPLOYMENT_TIER` is absent or exactly `production`, it
returns the existing production Firebase configuration byte-for-byte and
rejects every staging-only Firebase field.

When the tier is exactly `staging`, the build must also set:

```text
VITE_MULTI_TEACHER_V2_ENABLED=true
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
```

The staging project ID must be a canonical real Google Cloud project ID, must
not equal `morgan-bank`, and must not begin with `demo-`. The default auth
domain must equal `<projectId>.firebaseapp.com`. Unknown fields are not read
from a runtime `window` object.

Every staging screen displays a persistent, non-dismissible banner:

```text
TEST VERSION - USE FAKE DATA ONLY
```

The banner lives outside the application render root so authentication,
quarantine, loading, and error early returns cannot erase it.

## Functions staging contract

The production migration and write-authorization guards continue to recognize
exactly `morgan-bank` and the existing loopback demo project. They do not learn
about staging.

Only `assertV2GateAllowed` receives two new explicit inputs from reviewed
Firebase Parameters:

```text
MORGAN_BANK_DEPLOYMENT_TIER
MORGAN_BANK_STAGING_PROJECT_ID
```

A real staging V2 invocation is allowed only when all are true:

- the tier parameter is exactly `staging`;
- the configured staging project ID is canonical, non-production, and
  non-demo;
- every runtime project-routing source agrees with that exact ID;
- no emulator host or emulator flag exists;
- `MULTI_TEACHER_V2_ENABLED` is exactly true; and
- `MULTI_TEACHER_V2_RELEASE_ID` matches the reviewed Functions artifact.

Production requires tier `production`. Emulator behavior remains unchanged.
An unknown project with absent or mismatched staging inputs remains
`project-not-allowed`.

The reviewed Functions identity for this source becomes:

```text
student-money-functions-v2
```

## Deployment-artifact contract

`firebase.staging.json` is a separate, checked-in deployment description. It:

- points Firestore rules only at `firestore.phase3.final.rules`;
- uses the existing indexes, Functions source, and `dist` Hosting output;
- never names the production project; and
- contains no deploy command, credential, project alias, or authorization.

A pure staging preflight validates that the client project ID, server staging
project ID, requested deploy project, V2 gate, tier, and reviewed release ID
all agree exactly before a later operator may request deployment approval.

## Administrator bootstrap boundary

The staging project will require Andrew's staging Google account to receive the
existing signed `platformAdmin: true` custom claim. This item does not assign
that claim or introduce a browser bootstrap bypass. A later procedure must be
staging-only, refuse `morgan-bank`, disclose no email or UID in evidence, make
one reviewed claim mutation, and require separate authorization.

## Permitted files

- this brief;
- `src/firebase/firebaseConfig.js` and focused tests;
- `src/firebase/firebase.js`;
- `index.html` and focused source/browser contracts;
- `functions/phase3/productionEnvironment.js` and focused tests;
- `functions/index.js` and the two demo Functions environment fixtures;
- `firebase.staging.json`;
- one pure local staging-preflight module and tests;
- the existing emulator command-safety contract for the new server parameters;
- `package.json` only for local staging verification scripts; and
- narrowly affected test documentation.

Production data, `.firebaserc`, deployed rules, the historical Phase 3
runbook, migration tools, credentials, IAM, and Safari files are excluded.

## Required evidence

At minimum:

```text
npm run lint
npm --prefix functions run lint
npm run build
VITE_MULTI_TEACHER_V2_ENABLED=true npm run build
npm run test:functions
npm run test:phase2b:client
npm run test:phase2b:build-contract
npm run test:staging:contracts
npm run test:phase2b:server
npm run test:phase3:contracts
npm run test:phase3:unit
git diff --check
```

Focused tests must prove production defaults are unchanged; incomplete or
mixed staging configuration fails before Firebase initialization; the banner
cannot be erased by render; only one exact configured staging project reaches
the V2 gate; production and emulator behavior remain unchanged; migration
write authorization still rejects staging; the staging config pins final
rules; and the preflight rejects every production, demo, mismatch, unknown,
blank, padded, or malformed target.

## Review and release boundary

Codex self-verification is followed by Claude detailed read-only review and
Grok final read-only review. Review does not authorize project creation,
provider configuration, custom-claim assignment, deployment, invitation
creation, onboarding, or friend access.

After review, Andrew must separately authorize each external stage: create the
staging project, configure Google Auth, deploy final rules and indexes, deploy
the exact Functions parameters and source, build and deploy staging Hosting,
assign the staging admin claim, perform sanitized acceptance, create named
invitations, and share the staging URL.
