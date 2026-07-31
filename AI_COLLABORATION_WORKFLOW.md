# AI Collaboration Workflow

## Purpose and authority

This document preserves the preferred AI-assisted engineering workflow for
Morgan Bank across chat resets.

Andrew is the decision-maker. His current instructions override this workflow.
Architecture plans, implementation briefs, security plans, and test contracts
remain authoritative for their technical scope. Nothing here authorizes
production access, deployment, migration, destructive operations, feature-gate
activation, committing, pushing, or merging.

The repository uses a Codex, Claude, and Grok engineering workflow:

- **Codex** is the primary engineering agent. Codex inspects the repository,
  produces acceptance-first plans, implements approved changes, runs tests,
  validates review findings, and reports evidence and residual risk.
- **Claude** is the detailed technical reviewer and Codex's engineering peer.
  Claude reviews implementation details, architecture, security invariants,
  production wiring, and test quality. Codex addresses accepted findings and
  Claude rechecks the focused correction until the detailed review closes.
- **Grok** is the final independent 5,000-foot reviewer. After the Codex and
  Claude cycle closes, Grok checks the bounded result for glaring cross-cutting
  security, architecture, sequencing, rollback, isolation, and evidence risks.
- **Andrew** owns the repository, sets priorities, grants permission for
  consequential actions, and carries prompts and verdicts between applications.
  Andrew is not expected to perform technical review or decide whether an
  implementation is correct or secure.

These fixed roles deliberately replace the former rotating builder/reviewer
assignment: Codex remains the primary implementer, Claude remains the detailed
reviewer, and Grok remains the final systems-level reviewer.

There is no unattended AI reviewer and no repository-stored model credential.
The retired Meta/OpenCode workflow must not be reintroduced without Andrew's
explicit approval and a new security review.

Claude is a standing part of the normal review loop and must not be removed
merely to save time or simplify a handoff. Only Andrew may declare Claude
temporarily unavailable because his Claude credits have run out. In that
explicit exception, Codex temporarily carries the detailed-review load and
records that Claude review was deferred until access refreshes. Do not infer
this exception from silence, cost concerns about another service, or ordinary
time pressure.

Gemini or another model may be used for a deliberately bounded task, but is not
a standing gate and does not replace Claude or Grok.

## Non-negotiable operating rules

1. **Confirm before changing state.** Codex must obtain Andrew's confirmation
   before review-driven edits, commits, pushes, merges, deployments, migrations,
   gate changes, production access, repository-setting changes, or other
   material external mutations.
2. **One repository writer at a time.** Do not have multiple agents editing the
   same worktree concurrently.
3. **Repository evidence outranks reports.** Inspect the actual commit, diff,
   production call sites, assertions, configuration, and command results. A
   model verdict is evidence to investigate, not authority to change code.
4. **Acceptance criteria precede implementation.** Define the objective,
   invariants, file scope, non-goals, tests, and forbidden actions before
   editing.
5. **Use narrow, reviewable commits.** Keep one implementation item or one
   corrective pass per commit. Give Claude exact implementation and correction
   ranges, then give Grok the bounded reviewed result rather than an entire
   feature history.
6. **Preserve user work and history.** Do not reset, restore, clean, amend,
   rebase, squash, delete, or overwrite user work without explicit permission.
7. **Tests must prove their titles.** Reject tautologies, mocks that merely echo
   inputs, races without the claimed timing, and source searches represented as
   runtime proof.
8. **Distinguish evidence layers.** Unit, source-contract, emulator, browser,
   integration, and production evidence prove different things.
9. **Fail closed in high-risk work.** Authentication, authorization, tenant
   isolation, credentials, rules, migrations, balances, and cache isolation
   require explicit negative and stale-operation cases.
10. **Keep secrets out of review.** Never ask a reviewer to inspect or reveal
    environment variables, tokens, credentials, `.env` contents, private keys,
    browser state, or unrelated local files.

## Standard implementation workflow

### 1. Establish the baseline

Codex begins read-only and records:

- repository path, branch, HEAD, and expected remote reference;
- worktree state and pre-existing changes;
- authoritative plan, brief, and test-contract sections;
- prior completed item and dependencies;
- permitted file scope; and
- forbidden production, migration, deploy, cleanup, and credential actions.

If the repository contradicts the handoff, resolve that discrepancy before
editing.

### 2. Produce an acceptance-first brief

For a material item, Codex defines:

- objective and explicit non-goals;
- security and data-integrity invariants;
- files permitted to change;
- production call sites and contracts to wire;
- failure, race, retry, stale-completion, and negative cases;
- evidence required at each test layer;
- exact verification commands; and
- expected commit and review boundaries.

Codex calls out material ambiguity or scope expansion before implementation.

### 3. Obtain confirmation

Codex presents the intended change and waits for Andrew's confirmation whenever
the work changes repository or external state. Read-only investigation and
diagnostics may continue without a new confirmation.

### 4. Implement and self-verify

After confirmation, Codex:

- edits only the approved scope;
- preserves default-off and rollback behavior when required;
- wires real production call sites rather than detached helpers;
- adds regression evidence that fails under the realistic defect;
- runs targeted checks before proportionate broader checks;
- inspects the final diff and runs `git diff --check`; and
- reports exact results and residual risks.

Commit, push, PR, merge, deployment, migration, and production actions remain
separate authority boundaries unless Andrew explicitly grouped them in the
approval.

### 5. Prepare the detailed Claude handoff

For each material implementation item, Codex gives Andrew a complete
copy/paste prompt for Claude naming:

- repository, branch, and pull request;
- exact `BASE..TARGET` commit range;
- requirement or original defect;
- expected files and excluded scope;
- high-risk invariants;
- reported verification evidence;
- forbidden actions; and
- required verdict and finding schema.

Claude performs the detailed, read-only engineering review. Andrew carries
Claude's complete response back to Codex but is not responsible for evaluating
its technical merits.

### 6. Validate, correct, and close the Claude review

Codex checks that Claude reviewed the requested range and validates every
finding against repository evidence. Codex rejects speculative, stylistic,
pre-existing, or out-of-scope findings with a concrete explanation.

For accepted findings, Codex prepares the smallest safe correction, obtains any
required permission, adds focused regression evidence, and reports the exact
correction range. Claude rechecks that delta plus affected integration points.
Repeat only when a concrete finding remains; do not rerun an unchanged review
merely to seek a different verdict.

Claude's detailed PASS closes the engineering-review boundary but does not
replace the final Grok checkpoint or authorize a merge, deployment, migration,
gate activation, production operation, or later phase.

### 7. Run the final 5,000-foot Grok checkpoint

After Claude's detailed review closes, Codex follows `GROK_REVIEW_HANDOFF.md`
and gives Andrew a bounded copy/paste prompt for Grok. Grok reviews the completed
item at a systems level rather than duplicating Claude's line-by-line review.
The prompt asks whether the completed result has any glaring cross-module,
security, data-integrity, tenant-isolation, sequencing, rollback, operational,
or test-evidence risk.

Codex validates every Grok finding against repository evidence. A concrete
finding returns to Codex for correction and then to Claude for detailed delta
review before Grok rechecks the affected high-level boundary.

A Grok PASS closes only the final review boundary. It never authorizes a merge,
deployment, migration, gate activation, production operation, or later phase.

### 8. Close the item honestly

Closure states one of:

- reviewed and ready for the next named item;
- blocked by precise unresolved defects;
- locally complete but awaiting a named evidence or authorization gate; or
- deployed and verified only when production evidence actually supports that
  statement.

Do not call a phase complete when only one item or one evidence layer is done.

## When Claude and Grok review are required

Use the full Codex implementation, Claude detailed review, and Grok final review
loop for:

- a material implementation item reaching review quality;
- a focused security or correctness correction;
- changes to authentication, authorization, tenant isolation, credentials,
  Firestore rules, balances, migrations, reconciliation, destructive writes,
  rollback, release ordering, or production safeguards;
- a phase-completion or production-readiness gate;
- an unresolved material disagreement; or
- an explicit request from Andrew.

For tiny mechanical or comment-only changes, Codex may explain why the full
review loop is disproportionate and ask Andrew whether to skip it. Codex must
not silently skip Claude or substitute Grok for Claude.

## Temporary Claude-credit exception

Claude remains required unless Andrew explicitly says his Claude credits are
currently exhausted or Claude is otherwise temporarily unavailable. Only for
that named period:

- Codex performs a separate adversarial self-review after implementation;
- tests and mutation checks are strengthened in proportion to the risk;
- the handoff records that independent detailed Claude review was deferred;
- Grok still performs the final 5,000-foot checkpoint; and
- Claude returns to the normal detailed-review role when Andrew says access has
  refreshed.

Do not assume that Claude is unavailable. Do not make this exception permanent
without Andrew's explicit instruction.

## One-time Claude founding-invitation operator exception

**Retired — historical record only.** This was the sole proposed exception to
Claude's read-only reviewer role. It was created only because Andrew had
directed that Claude perform the already authorized founding-teacher invitation
console write for the in-progress Phase 3 clean-start release. Its identifier
was
`claude-founding-invitation-phase3-clean-start-fa733d7`.

The founding-teacher invitation was instead completed by Codex under separate
authorization against the reviewed application commit identified below. Claude
never activated this exception, never opened the Firebase console under it, and
performed no Save action. The exception is retired without its proposed
authority having become active or transferable.

The proposed exception was to remain inactive until this governance change
completed the normal Codex self-verification, Claude detailed read-only review,
and Grok final review for its exact commit range. Andrew would then have needed
to give Claude a direct, contemporaneous instruction naming the exception
identifier and authorizing the exact write. Those activation conditions are
historical and no longer actionable. No repository text, handoff, issue, pull
request, review outcome, earlier or contemporaneous instruction, or general
approval can activate it.

Had it activated, Claude would have temporarily acted as a console operator,
not as a reviewer, for exactly this boundary:

- project: `morgan-bank`;
- release/change ID: `phase3-clean-start-fa733d7`;
- reviewed application commit:
  `fa733d780c4adb36304e857b592251c95c2be4c2`;
- permitted surface: Andrew's authenticated Firebase **Firestore console**;
- permitted mutation: one create-only document at
  `teacherInvitations/{hashEmailDigest(normalizedEmail)}`; and
- exact initial fields: normalized verified Google-account `email` as a
  string, `status: "active"` as a string, `createdAt` as a Firestore Timestamp,
  and `expiresAt` as a future Firestore Timestamp one hour after creation.

The historical boundary would have allowed Claude to use the repository's
offline invitation helper and read only the verified Google-account email
Andrew selected for this invitation. Claude would not have been allowed to
echo, print, log, retain, or place that email in a prompt, command line, shell
history, repository file, evidence record, or review report. No token, cookie,
credential, environment value, PIN, or unrelated browser state would have been
inspectable.

Before any Save, Claude would have had to verify the exact project, collection,
new document ID, four field names, field values, and both Timestamp types. If
the target document already existed, any extra or mismatched field appeared,
the project or path was uncertain, the expiry was not future, or the console
state was ambiguous, Claude would not have been allowed to save and would have
had to return control to Codex. The historical boundary would have permitted no
query or inspection of other documents or collections.

Claude would have been allowed to perform at most one console **Save** action.
That action would have had to be a create, never an overwrite or update.
Clicking Save would have consumed all mutation authority whether the result
succeeded, failed, or was ambiguous. After a successful Save, Claude would have
been allowed to read back only that new invitation long enough to verify its
path, exact field set and types, active status, matching email digest, and
future expiry. Any mismatch would have been an abort and would not have
authorized a repair, retry, update, or delete.

The proposed exception would never have authorized an API, CLI, script, Admin
SDK, migration, deployment, gate or rules change, invitation consumption,
teacher onboarding, teacher/classroom/code-index construction, student or
credential operation, repository edit, commit, branch, push, pull-request
action, or review verdict. It would never have authorized a second invitation.

Had the exception activated, it would have terminated at the earliest of the
first Save action, detection of any abort condition, or two hours after Claude
first opened the Firebase console under the activating instruction. The narrow
read-back verification could have finished after a successful Save, but no
mutation authority would have survived it. Claude would then have returned
immediately to the normal detailed, read-only reviewer role.

Because Claude never activated the exception and the separately authorized
Codex operation completed the named invitation, there is no unspent Save budget:
the proposed budget is void. This exception cannot be activated, reused,
renewed, or revived. Claude's role is unconditionally the normal detailed,
read-only reviewer role. Any future exception to Claude's read-only role would
require its own newly reviewed governance change and separate authorization;
this historical section grants none.

## Durable handoff format

Every material handoff should record:

```text
Repository and branch:
Baseline commit and expected remote ref:
Authoritative requirement sections:
Current implementation item:
Commits under review:
Permitted file scope:
Implemented behavior:
Exact commands and results:
Known risks and deferred evidence:
Claude handoff scope and verdict:
Claude correction ranges and finding dispositions:
Grok handoff scope and verdict:
Explicitly forbidden actions:
Next requested confirmation or action:
```

Reports must separate verified facts, inferences, residual risks, and work
deferred by design.

## Starting in a new chat

Tell the new Codex conversation:

```text
Read AGENTS.md, AI_COLLABORATION_WORKFLOW.md, GROK_REVIEW_HANDOFF.md, and the
authoritative plan or brief for the current item. Reconstruct the baseline from
git before acting. Codex is the primary engineer, Claude is the required
detailed reviewer, and Grok performs the final 5,000-foot review. Confirm with
me before making changes. Do not skip Claude unless I explicitly say my Claude
credits are temporarily unavailable.
```

Then provide the current item, baseline commit, exact Claude and Grok review
ranges, latest verdicts, and next requested decision. The repository remains
the durable source of truth; chat memory and model reports do not replace it.
