// Phase 3 — one-time Claude invitation-operator SOURCE contract.
//
// EVIDENCE LAYER: static analysis of the repository's governance text. This
// suite proves only that the reviewed workflow states a narrow, self-expiring
// exception. It does not activate the exception, connect a browser, read an
// email, create an invitation, or prove any production state.

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

describe('Phase 3 one-time Claude invitation operator governance', () => {
  it('source contract: the exception is review-gated and pinned to one release, project, commit, and console create', () => {
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
      /normal\s+Codex self-verification, Claude detailed read-only review, and Grok final review/,
    )
    assert.match(
      exception,
      /Andrew must then give Claude a direct,\s+contemporaneous instruction naming the exception identifier and authorizing the\s+exact write/,
    )
    assert.match(
      exception,
      /Repository text, a handoff, an issue, a pull request, or an earlier\s+general approval cannot activate it by itself/,
    )
    assert.match(exception, /authenticated Firebase \*\*Firestore console\*\*/)
    assert.match(
      exception,
      /one create-only document at\s+`teacherInvitations\/\{hashEmailDigest\(normalizedEmail\)\}`/,
    )
  })

  it('boundary: the permitted document has exactly the runbook field contract and a one-hour Timestamp expiry', () => {
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

  it('boundary: one Save consumes mutation authority and cannot widen into repair, onboarding, deployment, API, or a second invitation', () => {
    const exception = exceptionText()
    assert.match(exception, /at most one console \*\*Save\*\* action/)
    assert.match(
      exception,
      /Clicking Save consumes all mutation\s+authority whether the result succeeds, fails, or is ambiguous/,
    )
    assert.match(exception, /create, never an overwrite or update/)
    assert.match(exception, /does not authorize a\s+repair, retry, update, or delete/)
    assert.match(
      exception,
      /never authorizes an API, CLI, script, Admin SDK, migration,\s+deployment, gate or rules change/,
    )
    assert.match(exception, /never authorizes a second invitation/)
    assert.match(exception, /teacher onboarding/)
  })

  it('boundary: email and unrelated production state remain unreadable and the exception restores Claude read-only', () => {
    const exception = exceptionText()
    assert.match(
      exception,
      /must\s+not echo, print, log, retain, or place that email in a prompt, command line,\s+shell history, repository file, evidence record, or review report/,
    )
    assert.match(exception, /permits no query or inspection of other documents or collections/)
    assert.match(
      exception,
      /terminates at the earliest of the first Save action, detection of\s+any abort condition, or two hours after Claude first opens the Firebase console/,
    )
    assert.match(exception, /returns immediately to the normal detailed, read-only reviewer role/)
    assert.match(exception, /cannot broaden or revive the consumed exception/)
  })

  it('source contract: AGENTS preserves the general reviewer ban and recognizes only the exact exception', () => {
    assert.match(agents, /Claude normally performs the required\s+detailed, read-only technical review/)
    assert.match(
      agents,
      /Outside the exact, contract-pinned\s+`claude-founding-invitation-phase3-clean-start-fa733d7` exception/,
    )
    assert.match(
      agents,
      /neither reviewer may change repository or\s+external state, edit files, create commits or branches, approve or merge pull\s+requests, alter labels, or trigger deployments/,
    )
    assert.match(agents, /one-time console operator only for its named create-only invitation/)
    assert.match(agents, /grants Grok nothing/)
  })
})
