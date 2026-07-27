# AI Collaboration Workflow

## Purpose and authority

This document preserves the preferred AI-assisted engineering workflow for
Morgan Bank across chat resets.

Andrew is the decision-maker. His current instructions override this workflow.
Architecture plans, implementation briefs, security plans, and test contracts
remain authoritative for their technical scope. Nothing here authorizes
production access, deployment, migration, destructive operations, feature-gate
activation, committing, pushing, or merging.

The repository uses a human-gated Codex and Grok workflow:

- **Codex** is the primary engineering agent. Codex inspects the repository,
  produces acceptance-first plans, implements approved changes, runs tests,
  validates review findings, and reports evidence and residual risk.
- **Andrew** approves material repository and external-state changes and carries
  review prompts and verdicts between Codex and the Grok app.
- **Grok** is the independent, read-only reviewer. Grok uses Andrew's GitHub
  connection and receives a bounded copy/paste handoff prepared by Codex.

There is no unattended AI reviewer and no repository-stored model credential.
The retired Meta/OpenCode workflow must not be reintroduced without Andrew's
explicit approval and a new security review.

Claude is optional, not required. Andrew may request Claude for another
architecture opinion, a genuine high-risk disagreement, or an unusually
important production-readiness decision. Gemini or another model may likewise
be used only for a deliberately bounded task. Neither is a standing gate.

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
   corrective pass per commit. Do not send Grok an entire feature history when
   a focused commit range proves the behavior.
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

### 5. Prepare the manual Grok handoff

When independent review is warranted, Codex follows
`GROK_REVIEW_HANDOFF.md` and gives Andrew a complete copy/paste prompt naming:

- repository, branch, and pull request;
- exact `BASE..TARGET` commit range;
- requirement or original defect;
- expected files and excluded scope;
- high-risk invariants;
- reported verification evidence;
- forbidden actions; and
- required verdict and finding schema.

Andrew pastes the prompt into the Grok app using Grok's GitHub connector and
returns Grok's complete response to Codex.

### 6. Validate the verdict

Codex checks that Grok reviewed the requested range and validates every finding
against repository evidence. Codex must reject speculative, stylistic,
pre-existing, or out-of-scope findings with a concrete explanation.

A Grok PASS closes only the requested review boundary. It never authorizes a
merge, deployment, migration, gate activation, production operation, or later
phase.

### 7. Confirm and correct

If Grok reports an actionable defect, Codex explains whether it is accepted,
rejected, or needs a human decision. Codex obtains Andrew's confirmation before
making a correction.

An accepted correction should be a narrow delta with focused regression
evidence. Grok then reviews only the correction range plus affected integration
points unless the correction changes architecture or invalidates the earlier
review boundary.

Do not rerun an unchanged review merely to seek a different verdict.

### 8. Close the item honestly

Closure states one of:

- reviewed and ready for the next named item;
- blocked by precise unresolved defects;
- locally complete but awaiting a named evidence or authorization gate; or
- deployed and verified only when production evidence actually supports that
  statement.

Do not call a phase complete when only one item or one evidence layer is done.

## When Grok review is required

Use a manual Grok handoff for:

- a material implementation item reaching review quality;
- a focused security or correctness correction;
- changes to authentication, authorization, tenant isolation, credentials,
  Firestore rules, balances, migrations, reconciliation, destructive writes,
  rollback, release ordering, or production safeguards;
- a phase-completion or production-readiness gate;
- an unresolved material disagreement; or
- an explicit request from Andrew.

For tiny mechanical or comment-only changes, Codex may explain why independent
review is disproportionate and ask Andrew whether to skip it.

## When another model may help

Claude, Gemini, or another model is optional. Consider another bounded opinion
only when:

- Andrew explicitly requests it;
- Codex and Grok materially disagree on a high-risk invariant;
- requirements conflict and repository evidence cannot resolve them;
- several substantive correction rounds fail to close an issue; or
- a production operation has exceptional irreversible risk.

Another model does not replace Andrew's authority or the requirement to verify
claims against the repository.

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
Grok handoff scope and verdict:
Finding dispositions:
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
git before acting. Confirm with me before making changes. Use a manual Grok
copy/paste handoff when independent review is required.
```

Then provide the current item, baseline commit, exact review range, latest Grok
verdict, and next requested decision. The repository remains the durable source
of truth; chat memory and model reports do not replace it.
