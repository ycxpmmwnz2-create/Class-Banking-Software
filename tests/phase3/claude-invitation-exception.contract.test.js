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
const brief = readFileSync(
  new URL('../../PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md', import.meta.url),
  'utf8',
)

function paragraphContaining(markdown, marker) {
  const matches = markdown.split(/\n\s*\n/).filter(part => part.includes(marker))
  assert.equal(matches.length, 1, `one paragraph must contain ${marker}`)
  return matches[0].replace(/\s+/g, ' ')
}

function assertCurrentReviewOrder(text) {
  assert.match(text, /Muse Spark's detailed read-only check, then Claude's final independent 100-foot review/)
  assert.doesNotMatch(text, /Grok|Claude's detailed/)
}

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
  const marker = '## Historical retired operator exception — not current policy'
  const sections = workflow.split(marker)
  assert.equal(sections.length, 2, 'one terminal historical parent section')
  const heading = '### One-time Claude founding-invitation operator exception'
  const record = sections[1].split(heading)
  assert.equal(record.length, 2, 'one nested retired invitation record')
  assert.doesNotMatch(record[1], /^## /m, 'no current section inside historical tail')
  return record[1]
}

describe('Phase 3 retired Claude invitation operator governance', () => {
  it('source contract: historical scope is the terminal parent section, with no active handoff policy hidden below it', () => {
    const marker = '## Historical retired operator exception — not current policy'
    const pieces = workflow.split(marker)
    assert.equal(pieces.length, 2)
    assert.match(pieces[0], /^## Durable handoff format$/m)
    assert.doesNotMatch(pieces[1], /^## /m)
    assert.deepEqual(pieces[1].match(/^### .+$/gm), ['### One-time Claude founding-invitation operator exception'])
    assert.doesNotMatch(pieces[1], /Muse Spark|100-foot|## Durable handoff/)
  })
  it('source contract: brief and runbook gates resolve to Muse checking followed by Claude final review', () => {
    for (const text of [
      paragraphContaining(brief, 'inventory for'),
      paragraphContaining(brief, 'final-read-set observation is the fresh inventory'),
      paragraphContaining(brief, '1. Complete Codex implementation'),
      paragraphContaining(brief, 'Codex remains the primary builder'),
      paragraphContaining(runbook, 'That candidate and the matching Hosting build'),
      paragraphContaining(runbook, '1. Complete Codex implementation'),
      paragraphContaining(runbook, '6. Diagnose and correct forward.'),
    ]) assertCurrentReviewOrder(text)
    const standing = paragraphContaining(brief, 'Codex remains the primary builder')
    assert.match(standing, /defined in `AI_COLLABORATION_WORKFLOW.md`/)
    assert.match(workflow, /^### 3\. Muse Spark checks the implementation$/m)
    assert.match(workflow, /^### 4\. Claude gives the final independent 100-foot review$/m)
  })
  it('source contract: retired review history is attributed, not reactivated as a current gate', () => {
    assert.match(brief, /The original review required focused Claude review,\s+Grok independent review/)
    assert.match(brief, /the v1 identifier is permanently terminated\s+and cannot be activated/)
    assert.match(brief, /Any newly authorized reuse would require\s+Muse Spark's detailed read-only check, then Claude's final independent\s+100-foot review/)
    assert.match(brief, /clean-start release does not run\s+any of them/)
    // Keep the recorded reviews/waivers, never relabel them as Muse reviews.
    assert.match(runbook, /Its Codex, Claude, and\s+Grok review gates closed/)
    assert.match(runbook, /Andrew explicitly directed Codex to skip the proposal's Claude and Grok reviews/)
    assert.match(brief, /Andrew later explicitly instructed Codex to skip Claude and Grok review/)
  })
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
      /Muse Spark is the default independent, read-only implementation checker/,
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
  it('source contract: the permanent order covers Insights and preserves independent final review', () => {
    assert.match(agents, /Codex \/ Astra is the primary builder and engineering lead for all Morgan Bank\s+work, including AI Insights/)
    assert.match(agents, /Claude provides the\s+final independent, read-only 100-foot review/)
    const active = workflow.split('## Historical retired operator exception')[0]
    assert.match(active, /permanent role change, not a temporary credit exception/)
    assert.match(active, /Claude must form an independent judgment from the actual\s+candidate and requirements/)
    assert.match(active, /Any resulting code correction returns to\s+Muse for detailed delta checking, then to Claude/)
    assert.match(active, /Review PASS closes only that review gate/)
  })
})
