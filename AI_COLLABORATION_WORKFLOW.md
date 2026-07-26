# AI Collaboration Workflow

## Purpose and authority

This document preserves the preferred AI-assisted engineering workflow for
this repository across chat resets. When Andrew says to use "the AI
collaboration workflow," "our Claude/Codex workflow," or similar language,
the agents should read and follow this document before planning or editing.

Andrew's current instructions always take precedence. Security plans,
architecture plans, implementation checklists, and repository-specific agent
instructions remain authoritative for their respective technical scope. This
workflow governs who plans, builds, reviews, and verifies the work; it does not
expand the scope of an implementation item or authorize production access,
deployment, migration, destructive operations, or pushing commits.

## Core team

Claude and Codex are the primary engineering pair. They rotate roles between
material implementation items so neither becomes permanently associated with
planning or coding:

- **Architect/reviewer:** derives the item from authoritative repository
  documents, defines its invariants and acceptance evidence, challenges scope,
  and independently reviews the implementation.
- **Builder:** challenges the proposed plan, implements the approved item,
  verifies it, and corrects concrete review findings.

For the next material item, normally swap the roles. Record the role assignment
in the handoff so a new chat can reconstruct it without relying on memory.

Gemini is not part of the primary planning or implementation loop. It may be
used only for deliberately bounded mechanical work or as a specifically
requested additional opinion. Do not send it broad architecture or
security-sensitive implementation work merely because it participated in an
earlier phase.

Grok is the preferred lightweight third set of eyes: an independent
systems-level reviewer and residual-risk inspector. At the close of each
material implementation item, and again at a phase or production-readiness
gate, give Grok a bounded, read-only "5,000-foot" review: a quick perusal for
glaring security, data-integrity, scope, sequencing, rollback, isolation, or
test-evidence problems. The useful question is whether the completed house is
livable, not whether Grok would have selected every nail or built it the same
way. Grok does not redo or replace any Claude/Codex plan-build-review-correct
loop, become the architect or builder, or write to the repository during this
checkpoint.

Gemini or another model may still provide an additional opinion when the
escalation conditions below apply. A lightweight Grok checkpoint or any other
third reviewer does not replace the Claude/Codex review cycle.

## Non-negotiable operating rules

1. **One repository writer at a time.** Never have two agents editing the same
   worktree concurrently. A reviewer begins read-only and does not interfere
   while a builder is working.
2. **Repository evidence outranks reports.** Inspect the actual commit, diff,
   production call sites, assertions, configuration, and command results.
   Never accept an agent's narrative report as proof by itself.
3. **Acceptance criteria precede implementation.** Define exact invariants,
   file scope, non-goals, expected call sites, tests, and verification commands
   before editing.
4. **Use narrow, reviewable commits.** One logical implementation item or one
   explicitly identified corrective pass per commit. Do not mix documentation,
   cleanup, refactoring, and feature work unless the approved scope requires
   all of them.
5. **Preserve user work and history.** Do not reset, restore, clean, amend,
   rebase, squash, push, deploy, migrate, or access production unless Andrew
   explicitly authorizes that action.
6. **Tests must prove their titles.** Reject tautologies, mocks that merely echo
   inputs, source searches represented as behavioral proof, races without the
   claimed timing, and helper tests disconnected from production wiring.
7. **Distinguish evidence layers.** Unit tests, static/source guards, emulator
   tests, real-browser tests, and production acceptance prove different things.
   Reports must not blur those boundaries.
8. **Fail closed on ambiguity in security-sensitive work.** Authentication,
   authorization, tenant isolation, credentials, rules, migration, and cache
   isolation require explicit negative cases and stale-operation tests.

## Standard item workflow

### 1. Establish the baseline

The architect/reviewer begins read-only and records:

- repository path and branch;
- local HEAD and expected remote reference;
- worktree state and any pre-existing user changes;
- authoritative plan/checklist sections;
- dependencies and the prior completed item;
- permitted file scope;
- forbidden production, migration, push, deploy, and cleanup actions.

If the worktree or history differs from the handoff, stop and resolve that
discrepancy before implementation.

### 2. Produce an acceptance-first implementation brief

The architect/reviewer writes a bounded brief containing:

- objective and explicit non-goals;
- security and data-integrity invariants;
- exact files permitted to change;
- production call sites and contracts that must be wired;
- failure, race, stale-completion, and negative cases;
- honest evidence required at each test layer;
- exact verification commands;
- expected commit boundary and handoff format.

Prefer adapting an existing authoritative plan over inventing a parallel
design. Any material deviation must be called out before coding.

### 3. Builder challenge

Before editing, the builder inspects the repository and challenges the brief:

- identify requirements that conflict with current code;
- locate missing production adapters or impossible test assumptions;
- flag file-scope omissions;
- distinguish work belonging to a later item;
- propose the smallest coherent implementation.

Resolve material disagreements before implementation. Silence is not approval
of an internally inconsistent plan.

### 4. Implement and self-verify

The builder:

- edits only the approved scope;
- keeps legacy/default-off behavior intact when required;
- wires real production call sites, not detached demonstration helpers;
- writes tests that fail under realistic regression mutations;
- runs targeted checks first, then the proportionate broader matrix;
- inspects the final diff and `git diff --check`;
- creates one focused local commit when authorized by the task;
- does not push or deploy without separate explicit authorization.

The builder's report lists the commit, files, behavior changed, exact command
results, remaining risks, and evidence deferred to later items.

### 5. Independent read-only review

The architect/reviewer reviews the actual implementation without repeating
work indiscriminately. At minimum:

- confirm repository safety and scope;
- inspect the incremental diff and affected production call sites;
- inspect assertions intended to prove those call sites;
- look for stale effects, failure-path escapes, default-off side effects,
  incorrect adapters, test-title inflation, and plan deviations;
- rerun proportionate checks independently;
- report findings ordered by severity with file/line evidence.

The reviewer initially reports findings rather than editing. This preserves a
clear separation between implementation and independent judgment.

### 6. Builder correction

The original builder corrects accepted findings in one narrow pass, adds or
strengthens regression evidence, reruns the verification matrix, and creates a
separate local correction commit. Findings that belong to a later item must be
recorded explicitly rather than silently expanded into the current scope.

### 7. Delta-only re-review and closure

The reviewer checks only the correction delta plus the affected integration
points. A complete cumulative re-audit is unnecessary unless the correction
changed architecture or revealed that the initial review boundary was wrong.

Closure must state one of:

- review-quality and ready for the next numbered item;
- blocked by precise unresolved defects;
- structurally complete but awaiting a named later evidence layer.

Do not call a phase complete when only an individual item is complete.

### 8. Lightweight Grok checkpoint

After Claude and Codex agree that a material item is review-quality, send Grok
the authoritative requirement, the exact commit or commit range, the permitted
scope, the verification summary, and the known deferred risks. Ask for a
bounded, read-only perusal rather than a full independent re-audit.

Grok's default questions are:

- Is there a realistic cross-module sequence, race window, state-machine
  transition, pre-identity event, cache/auth interaction, or isolation-boundary
  failure the primary pair missed?
- Does any ambiguity fail open where it should fail closed, or does a
  fail-closed choice create an unstated operational cost?
- Does the implementation or release ordering create a glaring security,
  credential, migration, rollback, or data-loss risk?
- Do the architecture, rules, Functions, client behavior, migration plan, and
  test claims remain mutually consistent when viewed together?
- Do the stated tests actually prove their titles at the claimed evidence
  layer, or is a safety conclusion over-claimed or under-specified?
- Did a correction create a new high-level failure mode, and is any residual
  risk being accepted without being named?
- Is any finding serious enough to reopen the item before the next commit?

This checkpoint is deliberately not an exhaustive checklist, a deep
line-by-line or symbolic proof, or a substitute for detailed low-level edge-case
enumeration. Claude and Codex retain those responsibilities throughout the
normal build-and-check loop. Grok should follow a cross-cutting concern into
specific files or lines when needed to support a concrete finding, but should
not expand the checkpoint into a duplicate full implementation review.

The expected response is short and severity-ordered. "No glaring issue found"
is a valid result. Low-value style preferences and speculative redesigns do not
reopen an item. A concrete Blocking or High finding returns to the original
builder for correction and then to the Claude/Codex delta-review loop. Medium
findings are recorded and either accepted explicitly or assigned to a named
follow-up. Run this checkpoint once per material item rather than after every
small corrective commit; at phase-completion and production-readiness gates,
give Grok the cumulative range and ask for the same high-level pass.

## When to use a deeper third review

The lightweight Grok checkpoint above is the normal third-eye pass. Request a
deeper independent review from Grok, Gemini, or another model when any of the
following is true:

- a phase-completion, production-readiness, migration, or deployment gate is
  approaching;
- Firestore/security rules, authentication, authorization, credentials,
  secrets, tenant isolation, destructive writes, or rollback controls changed;
- Claude and Codex materially disagree on a requirement or finding;
- an item requires multiple substantive correction rounds;
- tests pass but production behavior remains difficult to connect to them;
- Andrew explicitly requests an adversarial or additional audit.

The deeper reviewer should receive the authoritative requirement, exact commit
range, permitted scope, known disagreements, and requested checks. It should
begin read-only. Use a narrow review request rather than asking it to redo the
entire project history.

## Handoff format

Every material handoff should include:

```text
Repository:
Branch:
Role assignment (architect/reviewer and builder):
Authoritative requirement sections:
Baseline commit and expected remote ref:
Commits under review:
Permitted file scope:
Implemented behavior:
Exact commands and results:
Known risks/deferred evidence:
Lightweight Grok checkpoint scope and verdict:
Explicitly forbidden actions:
Next requested decision or action:
```

Reports should separate verified facts, inferences, residual risks, and work
deferred by design.

## Starting in a new chat

At the beginning of a replacement chat, tell the agent:

```text
Read AI_COLLABORATION_WORKFLOW.md and the authoritative plan/checklist for the
current item. Reconstruct the baseline from git before acting. Follow the
Claude/Codex rotating architect-builder-reviewer workflow. Do not rely on a
prior chat report without inspecting the referenced commits and repository
state.
```

Then provide the current item number, role assignment, baseline commit, commit
range, and latest reviewer report. This makes the repository—not conversational
memory—the durable source of truth.
