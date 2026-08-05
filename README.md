# Morgan Bank

Morgan Bank is a classroom banking web application for teachers and students. It uses Firebase Authentication, Firestore, and Cloud Functions, with tenant isolation so each teacher and classroom has its own data boundary.

The app is served by Vite from `index.html`. Firebase setup lives under `src/firebase`, tenant/session logic under `src/phase2b`, and tenant-data services under `src/phase3`.

## Local setup

Use Node.js 22 so the root project and Cloud Functions use the same major version. The Firebase emulator suites also require Java and the Firebase CLI.

```bash
npm ci
npm --prefix functions ci
npm run dev
```

The Vite development server prints its local URL. Local development does not authorize access to staging or production data.

## Verification

Start with the checks closest to the code being changed:

```bash
npm run lint
npm run build
npm run test:phase2b:client
npm run test:phase3:contracts
npm run test:staging:contracts
```

The permanent release gates include Chromium and WebKit/Desktop Safari browser coverage in separate Firebase emulator lifecycles:

```bash
npm run test:phase2b:browser
npm run test:phase3:release-rehearsal
```

Emulator scripts refuse to run when local Google Application Default Credentials exist. They use explicit `demo-` project IDs, temporary Firebase CLI configuration, and scrubbed deployment environment variables.

## Firebase safety

`.firebaserc` defaults to the production project, `morgan-bank`. Do not infer deployment authority from permission to build, test, commit, or push.

- Emulator commands must keep their explicit `demo-` project IDs.
- The staging project is `morgan-bank-staging`. Because `.firebaserc` defines no staging alias, every staging Firebase command must explicitly pass `--project morgan-bank-staging` and use the reviewed staging configuration.
- Never reuse production Firebase identity values for staging.
- Deployment, migration, production reads or writes, Auth-provider changes, billing changes, commits, and pushes are separate approval boundaries.

## Architecture and workflow

Read the documents relevant to the change before editing:

- [`AI_COLLABORATION_WORKFLOW.md`](AI_COLLABORATION_WORKFLOW.md) — implementation and independent-review sequence.
- [`MULTI_TEACHER_ARCHITECTURE_PLAN.md`](MULTI_TEACHER_ARCHITECTURE_PLAN.md) — tenant architecture and isolation model.
- [`PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md`](PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md) — current Phase 3 requirements and release gates.
- [`SECURITY_PLAN.md`](SECURITY_PLAN.md) — security constraints and threat model.
- [`CLEANUP_CHECKPOINTS.md`](CLEANUP_CHECKPOINTS.md) — evidence required before cleanup.
- [`tests/phase2b/README.md`](tests/phase2b/README.md) and [`tests/phase3/README.md`](tests/phase3/README.md) — test contracts and recorded evidence.

Material changes follow the Codex implementation, Claude detailed-review, and Grok final-review workflow. A review `PASS` does not authorize merge or deployment.
