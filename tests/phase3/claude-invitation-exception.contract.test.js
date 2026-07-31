// Phase 3 — one-time Claude invitation-operator SOURCE contract.
//
// EVIDENCE LAYER: static analysis of the repository's governance text. This
// suite proves only that the reviewed workflow retains a narrow historical
// exception and states that it is permanently retired. It does not connect a
// browser, read an email, create an invitation, or prove any production state.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const workflow = readFileSync(
  new URL('../../AI_COLLABORATION_WORKFLOW.md', import.meta.url),
  'utf8',
)
const agents = readFileSync(
  new URL('../../AGENTS.md', import.meta.url),
  'utf8',
)
const runbook = readFileSync(
  new URL('../../PHASE3_RELEASE_RUNBOOK.md', import.meta.url),
  'utf8',
)

function isolatedSection(markdown, startHeading, endHeading) {
  const startMarker = `## ${startHeading}`
  const endMarker = `\n## ${endHeading}`
  assert.equal(
    markdown.split(startMarker).length,
    2,
    `${startHeading} must occur exactly once`,
  )
  const afterStart = markdown.split(startMarker)[1]
  assert.equal(
    afterStart.split(endMarker).length,
    2,
    `${endHeading} must terminate ${startHeading} exactly once`,
  )
  return afterStart.split(endMarker)[0]
}

function exceptionText() {
  return isolatedSection(
    workflow,
    'One-time Claude founding-invitation operator exception',
    'Durable handoff format',
  )
}

describe('Phase 3 retired Claude invitation operator governance', () => {
  it('source contract: the retired exception is pinned to one release, project, commit, console create, and permanent non-activation', () => {
    const exception = exceptionText()
    assert.match(
      exception,
      /claude-founding-invitation-phase3-clean-start-fa733d7/,
    )
    assert.match(exception, /project: `morgan-bank`/)
    assert.match(exception, /release\/change ID: `phase3-clean-start-fa733d7`/)
    assert.match(
      exception,
      /fa733d780c4adb36304e857b592251c95c2be4c2/,
    )
    assert.match(
      exception,
      /proposed exception was to remain inactive until this governance change\s+completed the normal Codex self-verification, Claude detailed read-only review,\s+and Grok final review/,
    )
    assert.match(
      exception,
      /founding-teacher invitation was instead completed by Codex under separate\s+authorization/,
    )
    assert.match(
      exception,
      /Claude\s+never activated this exception, never opened the Firebase console under it, and\s+performed no Save action/,
    )
    assert.match(
      exception,
      /retired without its proposed\s+authority having become active or transferable/,
    )
    assert.match(
      exception,
      /No repository text, handoff, issue, pull\s+request, review outcome, earlier or contemporaneous instruction, or general\s+approval can activate it/,
    )
    assert.doesNotMatch(exception, /The exception is inactive until/)
    assert.doesNotMatch(exception, /Andrew must then give Claude/)
    assert.doesNotMatch(exception, /When active, Claude/)
    assert.match(exception, /authenticated Firebase \*\*Firestore console\*\*/)
    assert.match(
      exception,
      /one create-only document at\s+`teacherInvitations\/\{hashEmailDigest\(normalizedEmail\)\}`/,
    )
  })

  it('boundary: the historical document contract retains the exact runbook fields and one-hour Timestamp expiry', () => {
    const exception = exceptionText()
    const invitationSection = isolatedSection(
      runbook,
      'Founding-teacher invitation',
      'Production release sequence',
    )
    for (const required of [
      /normalized verified Google-account `email` as a\s+string/,
      /`status: "active"` as a string/,
      /`createdAt` as a Firestore Timestamp/,
      /`expiresAt` as a future Firestore Timestamp one hour after creation/,
    ]) {
      assert.match(exception, required)
    }
    for (const required of [
      /email: normalized verified Google-account email/,
      /status: "active"/,
      /createdAt: Firestore Timestamp/,
      /expiresAt: future Firestore Timestamp/,
    ]) {
      assert.match(invitationSection, required)
    }
  })

  it('boundary: the historical one-Save limit cannot widen into repair, onboarding, deployment, API, or a second invitation', () => {
    const exception = exceptionText()
    assert.match(exception, /at most one console \*\*Save\*\* action/)
    assert.match(exception, /Clicking Save would have consumed all mutation authority/)
    assert.match(exception, /create, never an overwrite or update/)
    assert.match(
      exception,
      /would not have\s+authorized a repair, retry, update, or delete/,
    )
    assert.match(
      exception,
      /would never have authorized an API, CLI, script, Admin\s+SDK, migration, deployment, gate or rules change/,
    )
    assert.match(exception, /would never have authorized a second invitation/)
    assert.match(exception, /teacher onboarding/)
  })

  it('boundary: the historical privacy rules remain pinned and retirement leaves Claude unconditionally read-only', () => {
    const exception = exceptionText()
    assert.match(
      exception,
      /would not have been allowed to\s+echo, print, log, retain, or place that email in a prompt, command line, shell\s+history, repository file, evidence record, or review report/,
    )
    assert.match(
      exception,
      /would have permitted no\s+query or inspection of other documents or collections/,
    )
    assert.match(
      exception,
      /would have terminated at the earliest of the\s+first Save action, detection of any abort condition, or two hours after Claude\s+first opened the Firebase console/,
    )
    assert.match(
      exception,
      /there is no unspent Save budget:\s+the proposed budget is void/,
    )
    assert.match(exception, /cannot be activated, reused,\s+renewed, or revived/)
    assert.match(
      exception,
      /Claude's role is unconditionally the normal detailed,\s+read-only reviewer role/,
    )
  })

  it('source contract: AGENTS preserves the reviewer ban and records the exact exception as retired', () => {
    assert.match(
      agents,
      /Claude normally performs the required\s+detailed, read-only technical review/,
    )
    assert.match(
      agents,
      /The exact, contract-pinned\s+`claude-founding-invitation-phase3-clean-start-fa733d7` exception/,
    )
    assert.match(
      agents,
      /Neither reviewer may change repository or external state, edit files, create\s+commits or branches, approve or merge pull requests, alter labels, or trigger\s+deployments/,
    )
    assert.match(agents, /was retired without Claude activating it/)
    assert.match(agents, /retained solely as a historical record/)
    assert.match(agents, /grants no current exception/)
    assert.match(agents, /leaves Claude\s+unconditionally read-only/)
    assert.match(agents, /granted Grok nothing/)
    assert.doesNotMatch(agents, /Outside the exact, contract-pinned/)
  })
})
