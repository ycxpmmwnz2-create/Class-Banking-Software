# Multi-account teacher invitation implementation brief

Status: **locally implemented; independent review and production authorization pending**

This brief governs the post-Phase-3 workflow that lets Andrew invite additional
teachers without manually writing invitation documents in the Firestore
console. It does not authorize a commit, push, deployment, production read or
write, release-parameter change, invitation, onboarding, or observation-window
change.

## Objective

Morgan Bank must support multiple independent teacher accounts. Andrew can
create or revoke a time-bounded invitation for the exact email on a teacher's
Google account. The invited teacher then uses the existing
`onboardTeacherClassroomV2` path to create one independently owned classroom.

This item completes the administrative entrypoint. The existing V2 tenant,
onboarding, classroom-code, student-credential, data, and final-rules contracts
remain authoritative.

## Explicit non-goals

- Public or unrestricted teacher signup.
- More than one classroom per teacher.
- Co-teachers or shared classroom ownership.
- Customer-delegated administrators.
- Automatic invitation email.
- Billing, subscriptions, or licensing.
- Firestore rule changes, production migration, cleanup, or legacy deletion.
- Safari compatibility work in `SAFARI_COMPAT_HANDOFF.md`.

## Administrative authority

The server accepts either of two signed Firebase identities:

1. the exact existing founding Firebase UID, which lets Andrew use the feature
   without a separate production Auth mutation; or
2. the exact custom claim `platformAdmin: true`, reserved for a later reviewed
   administrator assignment.

A request field, browser variable, local-storage value, email address, teacher
document, or classroom owner relationship never grants platform-administrator
authority. Ordinary teachers and students are denied before invitation data is
read or written. The browser's visibility check is convenience only; both
callables independently enforce authority.

## Server contracts

### Create

```text
createTeacherInvitationV2({ email, expiresInHours }) ->
  { success: true, status: "active", created: boolean }
```

- `email` uses the existing ASCII-lowercase and SHA-256 document-key contract.
- `expiresInHours` must be an integer from 1 through 168; the UI offers 24, 48,
  72, and 168 hours.
- An absent invitation is created with exactly `email`, `status`, `createdAt`,
  and `expiresAt`.
- A currently active invitation is idempotent and is not silently extended.
- An expired or revoked invitation may be replaced with a new exact active
  document.
- A consumed invitation is permanently non-reactivatable.
- Malformed identities, timestamps, fields, and statuses fail closed without a
  write.

### Revoke

```text
revokeTeacherInvitationV2({ email }) ->
  { success: true, status: "revoked" | "not-found", revoked: boolean }
```

- Revoking an active invitation changes only its status.
- Revoking an already revoked or absent invitation is idempotent.
- A consumed invitation cannot be revoked because onboarding already created a
  teacher foundation; teacher disabling is a different, separately reviewed
  workflow.

Both operations use Firestore transactions. Callable errors are fixed,
allowlisted messages and never return a raw email, digest, document path,
invitation body, token, or internal integrity detail.

## Client contract

The V2 teacher navigation displays **Teacher Invitations** only for the founding
UID or a signed `platformAdmin: true` claim. The screen collects the exact Google
email and expiration, calls only the two versioned Functions above, and never
accesses `teacherInvitations` through the client Firestore SDK.

The invitation screen tells the administrator that no email is sent
automatically. The teacher must visit Morgan Bank and choose **Continue with
Google** before expiry. The existing onboarding screen creates the classroom;
the administrator must never hand-build a teacher, classroom, classroom-code
index, student, or credential document.

Admin-call completions are tenant-epoch checked. A result that arrives after
sign-out or identity change is inert and cannot update the incoming account's
screen.

## Security and data-integrity invariants

- `teacherInvitations` and `classroomLoginCodes` remain denied to all browser
  Firestore clients under the unchanged final rules.
- Onboarding still requires a verified Google email and an exact active,
  unexpired invitation.
- One teacher still owns exactly one reciprocal classroom foundation.
- Invitation consumption and teacher/classroom/code creation remain atomic.
- Teachers can read only their own classroom; tests prove both isolation
  directions for two accounts created from administrator-issued invitations.
- No raw invitation email appears in a document path, log, callable error, test
  title, review evidence, or release evidence.
- No production operation is reachable from unit or browser fixtures; emulator
  suites refuse non-demo projects, ambient credentials, and non-loopback hosts.

## Reviewed Functions identity

This source changes the reviewed Functions artifact identifier to:

```text
multi-account-invitations-functions-v1
```

A future production Functions deployment must configure
`MULTI_TEACHER_V2_RELEASE_ID` to that exact value in the same reviewed release.
Deploying this source with the previous value must fail every V2 invocation
closed. The original Phase 3 runbook and its prior release identifier remain a
historical record and are not rewritten by this item.

## Permitted implementation files

- `functions/phase2b/teacherInvitationAdmin.js`
- `functions/phase2b/teacherInvitationAdmin.test.js`
- `functions/index.js`
- the two demo-project Functions environment fixtures
- `src/phase2b/tenantClient.js` and its test
- `index.html`
- Phase 2B Auth/Functions/Firestore emulator tests
- Phase 2B browser fixtures and browser isolation tests
- this brief and the Phase 2B test README

`SAFARI_COMPAT_HANDOFF.md`, deployed rules, production data, migration tools,
legacy data, and unrelated UI are excluded.

## Required local evidence

At minimum, the reviewed source must pass:

```text
npm run lint
npm --prefix functions run lint
npm run build
VITE_MULTI_TEACHER_V2_ENABLED=true npm run build
npm run test:functions
npm run test:phase2b:client
npm run test:phase2b:server
npm run test:phase2b:browser
npm run test:phase3:contracts
npm run test:phase3:unit
npm run test:phase3:rules
git diff --check
```

Focused evidence must additionally prove:

- founding UID and exact custom-claim authorization;
- unauthenticated, ordinary-teacher, student, and request-forged denial;
- exact document shape and bounded expiry;
- create/revoke idempotency and simultaneous-create serialization;
- expired/revoked reissue and permanent consumed-invitation refusal;
- fixed client error messages with no invitation detail;
- two administrator-invited Google teachers create different classrooms;
- both cross-tenant read directions fail under the final rules; and
- the real browser hides the control from an ordinary teacher and creates the
  invitation only through the production client/callable path.

## Review and release boundary

Codex self-verification is followed by Claude's detailed read-only review and
Grok's final read-only 5,000-foot review. Findings return to Codex for a focused
correction and Claude delta review. Review completion does not authorize commit,
push, deployment, release-parameter changes, production access, invitation
creation, or teacher onboarding.

Before any production release, reconcile the still-incomplete Phase 3
observation gate against current repository evidence and obtain Andrew's
separate release decision. If release is later authorized, deploy Functions
with the new exact release ID before Hosting exposes the control, verify the
founding account alone sees it, create only explicitly approved time-bounded
invitations, and perform privacy-preserving multi-tenant acceptance. Every
active invitation created during a failed release must be revoked before a
Functions rollback; consumed invitations and created tenant foundations are
never deleted or silently repaired by rollback.
