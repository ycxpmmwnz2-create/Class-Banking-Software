// Phase 3 — release-order SOURCE contract (added Commit 1; expands per commit).
//
// EVIDENCE LAYER: static analysis of PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md
// plus filesystem/checksum facts. This suite proves the brief still *states* the
// safe ordering and that the completed boundary has exactly the expected
// artifacts. It does NOT execute a release, deploy anything, or prove
// production ordering.
// See tests/phase3/README.md.
//
// Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 2, 8, 9, 11.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const brief = readFileSync(
  new URL('../../PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md', import.meta.url),
  'utf8',
)
const runbook = readFileSync(
  new URL('../../PHASE3_RELEASE_RUNBOOK.md', import.meta.url),
  'utf8',
)
const architecture = readFileSync(
  new URL('../../MULTI_TEACHER_ARCHITECTURE_PLAN.md', import.meta.url),
  'utf8',
)
const securityPlan = readFileSync(
  new URL('../../SECURITY_PLAN.md', import.meta.url),
  'utf8',
)
const phase3Readme = readFileSync(
  new URL('./README.md', import.meta.url),
  'utf8',
)
const releaseOrderContractSource = readFileSync(
  new URL('./release-order.contract.test.js', import.meta.url),
  'utf8',
)
const iamEvidence = readFileSync(
  new URL('../../PHASE3_IAM_PERMISSION_EVIDENCE.md', import.meta.url),
  'utf8',
)
const releaseRehearsal = readFileSync(
  new URL('./production-runner.emulator.test.js', import.meta.url),
  'utf8',
)
const rollbackRehearsal = readFileSync(
  new URL('./rollback-rehearsal.test.js', import.meta.url),
  'utf8',
)

/** The unchanged production-rules pin carried throughout Phase 3. */
const EXPECTED_RULES_SHA256 =
  '0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50'
const EXPECTED_BRIDGE_RULES_SHA256 =
  '4bf76a85e576a1d5b30573c3c3d5eba0d3561fb9d9a19ac14ac6382dced8d7f0'
const EXPECTED_FINAL_RULES_SHA256 =
  '1a5994098bd3041c578bb5578cd299fe24b12263ce390e65c4f21fb274849c71'
const EXPECTED_ROLLBACK_RULES_SHA256 =
  'c81a058e260502fe31c4240d547dcd731f130eb85be3a3c185caae681e4ef19d'
const EXPECTED_PHASE3_DATA_PLANE_READER_SHA256 =
  '4c4259c12d3d1f0188e997baac0a7fed000510357cb4b5c453de342123fad8d5'
const EXPECTED_PHASE3_MIGRATION_WRITER_SHA256 =
  'a97924dbbdbf025cca740a6c952791a3ec5a774b0c2277f0228d029fd272d1bf'
const TERMINATED_INVITATION_RECOVERY_V1_ID =
  'phase3-expired-founding-invitation-recovery-fa733d7-v1'
const PRIVACY_SAFE_INVITATION_RECOVERY_V2_ID =
  'phase3-expired-founding-invitation-recovery-fa733d7-v2'
const REVIEWED_CLEAN_START_COMMIT =
  'fa733d780c4adb36304e857b592251c95c2be4c2'
const RELEASE_SEQUENCE_009_SHA256 =
  'd503f6e423998f438d04af7b6978006e6db7d6804c0f904aea142f6f67b37c3d'

/**
 * Parses a markdown numbered list into whole steps.
 *
 * Steps in the brief wrap onto indented continuation lines, and load-bearing
 * text lands on them — step 13's "Any mismatch aborts before activation" is a
 * continuation. Joining continuations into their owning step is therefore
 * required for correctness, not tidiness: a line-at-a-time parser would drop
 * that clause and the abort assertion would fail for the wrong reason.
 */
function parseNumberedSteps(markdown) {
  const steps = []
  for (const rawLine of markdown.split('\n')) {
    const started = /^\s*(\d+)\.\s+(.*)$/.exec(rawLine)
    if (started) {
      steps.push({ number: Number(started[1]), text: started[2].trim() })
      continue
    }
    // An indented, non-empty, non-list line continues the current step.
    if (steps.length > 0 && /^\s+\S/.test(rawLine)) {
      steps[steps.length - 1].text += ` ${rawLine.trim()}`
    }
  }
  return steps
}

/**
 * Extracts the numbered release-ordering list from Section 9 so ordering
 * assertions run against the parsed sequence rather than raw file offsets.
 * Raw `indexOf` over the whole document would also match the identical words in
 * Sections 2 and 7 and could pass for the wrong reason.
 */
function releaseOrderingSteps() {
  const section = brief.split('## 9. Release ordering and abort criteria')[1]
  assert.ok(section, 'Section 9 must exist in the brief')
  const beforeRollback = section.split(
    'Clean-start rollback before real-student rollout:',
  )[0]
  const steps = parseNumberedSteps(beforeRollback)
  assert.ok(steps.length >= 13, `expected the full ordering list, got ${steps.length}`)
  return steps
}

function rollbackSteps() {
  const section = brief.split(
    'Clean-start rollback before real-student rollout:',
  )[1]
  assert.ok(section, 'the rollback sequence must exist in the brief')
  const steps = parseNumberedSteps(section.split('\n## ')[0])
  assert.ok(steps.length >= 6, `expected the rollback list, got ${steps.length}`)
  return steps
}

function runbookReleaseSteps() {
  const section = runbook.split('## Production release sequence')[1]
  assert.ok(section, 'the runbook production release sequence must exist')
  const steps = parseNumberedSteps(section.split('\n## Abort criteria')[0])
  assert.equal(steps.length, 12, 'the runbook must retain all 12 clean-start steps')
  return steps
}

function runbookAbortCriteria() {
  const section = runbook.split('## Abort criteria')[1]
  assert.ok(section, 'the runbook abort criteria must exist')
  return section.split(
    '\n## Clean-start rollback before real-student rollout',
  )[0]
}

function runbookRollbackSteps() {
  const section = runbook.split(
    '## Clean-start rollback before real-student rollout',
  )[1]
  assert.ok(section, 'the runbook clean-start rollback sequence must exist')
  const steps = parseNumberedSteps(section.split('\n## Evidence record')[0])
  assert.equal(steps.length, 6, 'the runbook must retain all 6 rollback steps')
  return steps
}

function currentPhase3StatusSections({
  briefMarkdown = brief,
  runbookMarkdown = runbook,
  architectureMarkdown = architecture,
  phase3ReadmeMarkdown = phase3Readme,
} = {}) {
  const briefSection = briefMarkdown.split('\n## 1. Historical challenge-finding disposition')[0]

  assert.ok(
    runbookMarkdown.includes('## Reconciled release status'),
    'the runbook reconciled release status must exist',
  )
  const runbookSection = runbookMarkdown.split('\n## What the local evidence proves')[0]

  const architectureAfterHeading = architectureMarkdown.split('**Phase 3 —')[1]
  assert.ok(architectureAfterHeading, 'the architecture Phase 3 status must exist')
  const architectureSection = `**Phase 3 —${architectureAfterHeading.split('\n**Phase 4 —')[0]}`

  const phase3ReadmeSection = phase3ReadmeMarkdown.split(
    '\nItem 15 added no runtime behavior.',
  )[0]

  return [
    {
      label: 'brief',
      section: briefSection,
      completion: /Status: \*\*clean-start production Steps 10–11 completed and privacy-safely\s+verified; observation window incomplete; not production authorization\*\*/i,
    },
    {
      label: 'runbook',
      section: runbookSection,
      completion: /Status: \*\*production Steps 10–11 completed and privacy-safely verified;\s+observation window incomplete; not production authorization\*\*/i,
    },
    {
      label: 'architecture',
      section: architectureSection,
      completion: /\*\*Phase 3 — Items 1–16 implemented; clean-start production Steps 10–11\s+completed and privacy-safely verified; observation window incomplete\*\*/i,
    },
    {
      label: 'Phase 3 README',
      section: phase3ReadmeSection,
      completion: /\| 16 \|[^\n]+\| production recovery and Steps 10–11 complete; reviews explicitly skipped by Andrew for recovery\/onboarding \|/i,
    },
  ]
}

function assertCompletedProductionStatus({
  briefMarkdown = brief,
  runbookMarkdown = runbook,
  architectureMarkdown = architecture,
  phase3ReadmeMarkdown = phase3Readme,
} = {}) {
  const statusSections = currentPhase3StatusSections({
    briefMarkdown,
    runbookMarkdown,
    architectureMarkdown,
    phase3ReadmeMarkdown,
  })

  for (const { label, section, completion } of statusSections) {
    assert.match(section, new RegExp(REVIEWED_CLEAN_START_COMMIT), `${label} binds the release`)
    assert.match(
      section,
      /founding(?:-teacher)?[- ]invitation/i,
      `${label} retains the invitation boundary`,
    )
    assert.match(section, completion, `${label} records Steps 10–11 as complete`)
    assert.match(
      section,
      /(?:verified\s+all\s+five\s+sanitized\s+foundation\s+checks\s+`true`|(?:^|[.;]\s+)all\s+five\s+(?:sanitized\s+)?(?:Boolean\s+)?(?:results|foundation\s+checks)\s+(?:were\s+`true`|are\s+directly\s+verified|`true`))/im,
      `${label} records a positive all-five foundation verdict`,
    )
    assert.match(
      section,
      /independent\s+sanitized\s+reads\s+verified\s+the\s+student\s+absent,\s+(?:its\s+)?credential\s+retained\/inactive,\s+(?:the\s+)?transaction\s+preserved,\s+and\s+`nextStudentNumber(?::\s*2`|`\s+(?:still|remains)\s+`2`)/i,
      `${label} records all four positive cleanup-retention facts`,
    )
    assert.match(
      section,
      /observation\s+window(?:\s+and\s+every\s+later\s+production\s+transition)?\s+(?:remains?\s+incomplete(?:\s+and\s+unauthorized)?|has\s+not\s+begun|is\s+incomplete)/i,
      `${label} keeps the observation window incomplete`,
    )
  }

  assert.match(
    runbookMarkdown,
    /Step 12's\s+observation window has not begun and is not authorized by this record\./i,
    'the runbook must keep Step 12 both unstarted and unauthorized',
  )
}

function invitationRecoverySection(markdown = runbook) {
  const heading = '## One-time expired founding-invitation recovery'
  assert.equal(
    markdown.split(heading).length,
    2,
    'the runbook must contain exactly one isolated invitation-recovery section',
  )
  const afterHeading = markdown.split(heading)[1]
  const section = afterHeading.split('\n## Production release sequence')[0]
  assert.ok(section, 'the invitation-recovery section must precede the release sequence')
  return section
}

function terminatedRecoveryV1Section(markdown = runbook) {
  const section = invitationRecoverySection(markdown)
  const heading = '### Terminated v1 attempt — historical record only'
  assert.equal(
    section.split(heading).length,
    2,
    'the recovery section must contain one terminated-v1 subsection',
  )
  return section.split(heading)[1].split(
    '### Privacy-preserving v2 proposal and completed execution record',
  )[0]
}

function privacyRecoveryV2Section(markdown = runbook) {
  const section = invitationRecoverySection(markdown)
  const heading = '### Privacy-preserving v2 proposal and completed execution record'
  assert.equal(
    section.split(heading).length,
    2,
    'the recovery section must contain one privacy-preserving-v2 subsection',
  )
  return section.split(heading)[1]
}

const EXPECTED_PRIVACY_BOOLEAN_SCHEMAS = [
  [
    'projectIsMorganBank',
    'databaseIsDefault',
    'documentExists',
    'documentIdMatchesEmailDigest',
    'emailMatchesSelectedVerifiedGoogleAccount',
    'hasExactFourFieldShape',
    'statusIsActiveString',
    'createdAtIsTimestamp',
    'expiresAtIsTimestamp',
    'expiresAtIsNotFuture',
    'hasNoConsumedFields',
    'hasNoUnexpectedFields',
    'hasNoPendingEdit',
    'hasNoAmbiguity',
    'privacyBoundaryIntact',
  ],
  [
    'onlyExpiresAtIsPending',
    'targetTypeIsTimestamp',
    'targetIsExactlyOneHourAfterConfirmedTime',
    'emailStatusAndCreatedAtAreUnchanged',
    'noFieldIsAddedOrRemoved',
    'saveControlIsUnique',
    'privacyBoundaryIntact',
  ],
  [
    'saveClearlySucceeded',
    'sameDocument',
    'hasExactFourFieldShape',
    'emailStatusAndCreatedAtAreUnchanged',
    'expiresAtIsTimestamp',
    'expiresAtMatchesTarget',
    'privacyBoundaryIntact',
  ],
]

function assertExactPrivacyBooleanSchemas(section) {
  const blocks = [...section.matchAll(/^[ \t]*```text\n([\s\S]*?)\n[ \t]*```$/gm)]
    .map(match => match[1])
  assert.equal(
    blocks.length,
    EXPECTED_PRIVACY_BOOLEAN_SCHEMAS.length,
    'v2 must define exactly the pre-edit, pre-Save, and post-Save boolean objects',
  )

  blocks.forEach((block, index) => {
    const keys = block.split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && line !== '{' && line !== '}')
      .map(line => {
        const match = /^([A-Za-z][A-Za-z0-9]*),?$/.exec(line)
        assert.ok(match, `boolean schema ${index + 1} contains only bare keys`)
        return match[1]
      })
    assert.deepEqual(
      keys,
      EXPECTED_PRIVACY_BOOLEAN_SCHEMAS[index],
      `boolean schema ${index + 1} must retain its exact ordered key set`,
    )
    assert.equal(
      new Set(keys).size,
      keys.length,
      `boolean schema ${index + 1} must not repeat a key`,
    )
  })
}

function assertTerminatedRecoveryV1Contract(markdown = runbook) {
  const section = terminatedRecoveryV1Section(markdown)
  assert.equal(
    section.match(new RegExp(TERMINATED_INVITATION_RECOVERY_V1_ID, 'g'))?.length,
    1,
    'the terminated v1 identifier must appear exactly once in its subsection',
  )
  assert.match(section, /privacy and evidence boundary/i)
  assert.match(
    section,
    /No field was edited, no Save was clicked, no Firestore mutation occurred, and\s+onboarding did not begin/i,
  )
  assert.match(section, /v1 identifier terminated before any Save/i)
  assert.match(section, /unused Save budget is void/i)
  assert.match(section, /cannot be activated, reused, retried, renewed/i)
  assert.match(section, /Deleting, hiding, or losing the conversation\s+cannot undo the violation or restore v1 authority/i)
  assert.match(section, /historical subsection\s+grants no production or review exception/i)
}

/**
 * Pins v2 as static governance evidence. It deliberately validates the isolated
 * subsection because v1 is a terminated historical record and the original
 * create authority uses overlapping invitation vocabulary.
 */
function assertPrivacyRecoveryV2Contract(markdown = runbook) {
  const section = privacyRecoveryV2Section(markdown)

  assert.equal(
    section.match(new RegExp(PRIVACY_SAFE_INVITATION_RECOVERY_V2_ID, 'g'))?.length,
    1,
    'the unique v2 identifier must appear exactly once in its subsection',
  )
  assert.match(section, /new repository-defined\s+recovery proposal, not present mutation\s+authority/i)
  assert.match(
    section,
    /Codex\s+self-verification,\s+Claude\s+detailed\s+read-only\s+review,\s+Grok\s+final\s+read-only\s+review,\s+and\s+Andrew's\s+new\s+separate\s+contemporaneous\s+production\s+instruction\s+naming\s+the\s+v2\s+identifier/i,
  )
  assert.match(
    section,
    /no\s+repository\s+text,\s+handoff,\s+review\s+verdict,\s+v1\s+authorization,\s+earlier\s+approval,\s+or\s+general\s+request\s+can\s+activate\s+v2/i,
  )

  const consoleBoundary = section.split(
    'The v2 recovery permits only this console boundary:',
  )[1]?.split('Before any invitation document can render')[0]
  assert.ok(consoleBoundary, 'the exact v2 console boundary must be isolated')
  assert.match(consoleBoundary, /project: `morgan-bank`/)
  assert.match(consoleBoundary, /release\/change ID: `phase3-clean-start-fa733d7`/)
  assert.match(consoleBoundary, new RegExp(REVIEWED_CLEAN_START_COMMIT))
  assert.match(consoleBoundary, /Codex controlling Andrew's user-connected Chrome\s+session in Andrew's authenticated Firebase Firestore console/)
  assert.match(consoleBoundary, /existing exact\s+`teacherInvitations\/\{hashEmailDigest\(normalizedEmail\)\}`/)
  assert.match(consoleBoundary, /permitted mutation: change only `expiresAt`/)
  assert.match(consoleBoundary, /Firestore Timestamp exactly\s+one hour after the operator-confirmed current time/i)

  assert.match(
    section,
    /selected Chrome\s+runtime's required control documentation[\s\S]*every planned\s+read and action can suppress automatic screenshots, snapshots, page text,\s+content-bearing notifications, and action diagnostics while returning only\s+caller-selected booleans/i,
  )
  assert.match(
    section,
    /If that capability is absent, undocumented, or\s+ambiguous, v2 terminates before any invitation read/i,
  )
  assert.match(
    section,
    /No raw screenshot, DOM or accessibility snapshot, page text, clipboard,\s+console log, network record, account label, document ID, email, timestamp,\s+status value, raw field name\/value pair, or invitation content may be emitted/i,
  )
  assert.match(
    section,
    /Once the\s+`teacherInvitations` collection is selected, no page snapshot, screenshot,\s+page text, or content excerpt may be emitted at all/i,
  )
  assert.match(section, /inspection occurs only in transient browser-control memory/i)
  assert.match(
    section,
    /Raw values must never be returned or logged[\s\S]*only as\s+the minimum non-output baseline needed to compare the same document and\s+target through pre-Save and post-Save verification, and must be cleared on\s+any abort or immediately after the final comparison/i,
  )
  assert.match(
    section,
    /Apart from the exact\s+Boolean comparisons and one-hour target addition required below, the only\s+computation on an identity value permitted there is the reviewed pure\s+`hashEmailDigest\(normalizedEmail\)` helper/i,
  )
  assert.match(section, /no API,\s+CLI, Admin SDK, shell\s+command, repository write, standalone script, or\s+clipboard transfer is\s+permitted/i)
  assertExactPrivacyBooleanSchemas(section)
  assert.match(section, /Every key must exist exactly once, every value must be the boolean `true`, and\s+no extra key or diagnostic text may appear/i)
  assert.match(
    section,
    /A raw or extra output, a missing or\s+false key, a non-boolean value, an automatic browser notification containing\s+page content, or any uncertainty aborts without a Save, terminates v2/i,
  )

  const preconditions = section.split(
    'Those booleans represent all of these preconditions, which remain normative:',
  )[1]?.split('The operator may read only')[0]
  assert.ok(preconditions, 'the v2 pre-Save conditions must be isolated')
  assert.match(preconditions, /exactly the four keys `email`, `status`,\s+`createdAt`, and `expiresAt`/)
  assert.match(
    preconditions,
    /normalized email of the already selected verified Google\s+account intended for step 10 and currently authenticating the console\s+session/i,
  )
  assert.match(preconditions, /hashes\s+to the existing document ID/)
  assert.match(preconditions, /`status` is exactly the string `"active"`/)
  assert.match(preconditions, /`createdAt` and `expiresAt` are Firestore Timestamps/)
  assert.match(preconditions, /`expiresAt` is no\s+longer in the future/)
  assert.match(
    preconditions,
    /No `consumedAt`, `consumedByUid`, unexpected field, pending console edit, or\s+ambiguous state exists/,
  )

  assert.match(section, /operator may read only that exact invitation document/i)
  assert.match(section, /must not inspect\s+a teacher, classroom, code index, student, credential, log, Auth user/i)
  assert.match(section, /invoke the unique `Edit expiresAt field` control/i)
  assert.match(section, /Any mismatch closes the tab without Save and\s+terminates v2; there is no repair, second edit, or retry/i)
  assert.match(section, /At most one Firestore console \*\*Save\*\* is permitted/)
  assert.match(section, /Clicking Save consumes all\s+v2 recovery mutation authority whether the result succeeds, fails, or is\s+ambiguous/i)
  assert.match(
    section,
    /authorizes no create, delete, delete-and-recreate,\s+duplicate document, API, CLI, standalone script, Admin SDK, deployment,\s+parameter change, rules change, migration, reconciliation, onboarding, student\s+operation, or credential operation/i,
  )
  assert.match(section, /inspect only the same document in\s+transient browser-control memory/i)
  assert.match(section, /Raw invitation content must never be recorded/i)
  assert.match(section, /Step 10 onboarding still requires a\s+separate contemporaneous authorization/i)
  assert.match(section, /separately\s+worded clause conditional on a clearly successful v2 recovery/i)
  assert.match(section, /v2 is spent and cannot authorize\s+another Save or extension/i)
  assert.match(section, /Any further recovery requires a newly reviewed\s+procedure and new authorization/i)
}

function assertInvitationRecoveryContract(markdown = runbook) {
  assertTerminatedRecoveryV1Contract(markdown)
  assertPrivacyRecoveryV2Contract(markdown)
}

/** Index of the first step whose text matches every supplied pattern. */
function stepIndex(steps, ...patterns) {
  const index = steps.findIndex(step =>
    patterns.every(pattern => pattern.test(step.text)),
  )
  assert.notEqual(
    index,
    -1,
    `no step matched ${patterns.map(String).join(' + ')}`,
  )
  return index
}

function assertOrderedMarkers(source, markers, description) {
  let previous = -1
  for (const marker of markers) {
    const current = source.indexOf(marker, previous + 1)
    assert.ok(current > previous, `${description}: ${marker} must appear in order`)
    previous = current
  }
}

describe('Phase 3 release-order source contract', () => {
  it('source contract: gate-off Functions precede final rules, then gate enable, then gate-on Hosting', () => {
    const steps = releaseOrderingSteps()
    const functionsGateOff = stepIndex(
      steps,
      /deploy/i,
      /V2 Functions/i,
      /MULTI_TEACHER_V2_ENABLED=false/i,
    )
    const finalRules = stepIndex(steps, /final/i, /rules/i, /deploy/i)
    const gateEnable = stepIndex(
      steps,
      /MULTI_TEACHER_V2_ENABLED=true/i,
      /MULTI_TEACHER_V2_RELEASE_ID/i,
    )
    const hosting = stepIndex(steps, /deploy/i, /hosting/i, /gate-on/i)
    assert.ok(functionsGateOff < finalRules, 'gate-off Functions must precede final rules')
    assert.ok(finalRules < gateEnable, 'final rules must precede gate enable')
    assert.ok(gateEnable < hosting, 'gate enable must precede gate-on Hosting')
  })

  it('source contract: final-rules verification aborts before activation on any mismatch', () => {
    const steps = releaseOrderingSteps()
    const verification = stepIndex(
      steps,
      /final rules/i,
      /phantom-parent legacy mirrors/i,
    )
    const gateEnable = stepIndex(
      steps,
      /MULTI_TEACHER_V2_ENABLED=true/i,
      /MULTI_TEACHER_V2_RELEASE_ID/i,
    )
    assert.ok(verification < gateEnable, 'rules verification must precede gate enable')
    assert.match(
      steps[verification].text,
      /deny/i,
      'the rules verification must require explicit legacy and isolation denials',
    )
  })

  it('source contract: invitation precedes normal onboarding, which precedes fresh-account acceptance', () => {
    const steps = releaseOrderingSteps()
    const invitation = stepIndex(steps, /invitation/i, /Firebase console/i)
    const onboarding = stepIndex(steps, /onboardTeacherClassroomV2/i)
    const acceptance = stepIndex(steps, /fresh-account acceptance/i)
    assert.ok(invitation < onboarding, 'the time-bounded invitation must precede onboarding')
    assert.ok(onboarding < acceptance, 'normal onboarding must precede fresh acceptance')
    assert.match(steps[onboarding].text, /nextStudentNumber: 1/)
    for (const marker of [
      /createStudentV2/,
      /studentPinLoginV2/,
      /balance\/transaction batch/,
      /cross-tenant reads fail/,
      /removeStudentV2/,
      /counter at `2`/,
    ]) {
      assert.match(steps[acceptance].text, marker)
    }
  })

  it('source contract: migration operations are retired rather than silently reordered', () => {
    const steps = releaseOrderingSteps()
    const sequence = steps.map(step => step.text).join('\n')
    for (const forbidden of [
      /functions\/phase3\/inventory\.js/,
      /functions\/phase3\/preflight\.js/,
      /functions\/phase3\/write\.js/,
      /functions\/phase3\/reverify\.js/,
      /deploy (?:and verify )?bridge rules/i,
      /create and bind Role B/i,
      /maintenance\/write freeze/i,
      /existing-student acceptance/i,
    ]) {
      assert.doesNotMatch(sequence, forbidden)
    }
    assert.match(brief, /N11 therefore has no surviving\s+release requirement: it is dissolved/)
    assert.match(brief, /Role B must remain uncreated and unbound/)
  })

  it('source contract: rollback withdraws Hosting and the gate while retaining final rules and no legacy writes', () => {
    const steps = rollbackSteps()
    const hosting = stepIndex(steps, /hosting/i, /roll/i)
    const gateDisable = stepIndex(steps, /disable/i, /gate/i)
    const finalRules = stepIndex(steps, /retain/i, /final rules/i)
    const preserve = stepIndex(steps, /preserve/i, /legacy write resumption/i)
    assert.ok(hosting < gateDisable, 'Hosting default-off precedes gate disable')
    assert.ok(gateDisable < finalRules, 'gate disable precedes final-rules retention proof')
    assert.ok(finalRules < preserve, 'final rules stay active before preservation is claimed')
    assert.match(steps[finalRules].text, /neither rollback-safe rules nor\s+the recursive baseline/i)
  })

  it('source contract: the recursive classrooms/** baseline is never redeployed', () => {
    assert.match(
      brief,
      /deploy neither rollback-safe rules nor\s+the recursive baseline/,
      'the brief must retain the absolute prohibition on the recursive baseline rule',
    )
    assert.match(
      brief,
      /All three retained artifacts delete the recursive\s+`classrooms\/\{document=\*\*\}` client/,
      'all three rules artifacts must delete the recursive client allow',
    )
  })

  it('source contract: the ten non-negotiable decisions are all present', () => {
    const section = brief.split('## 2. Non-negotiable decisions')[1].split('\n## ')[0]
    for (const pattern of [
      /Student creation and deletion are server-only/i,
      /Rules deny browser `create` and `delete`/i,
      /Flat credentials are immutable/i,
      /login UI requires classroom code/i,
      /calls versioned V2 Function names/i,
      /not silently mapped to incompatible V2/i,
      /fail closed for stale\s+clients/i,
      /final rules before the V2 server gate/i,
      /only final rules are deployed/i,
      /not run for the clean-start release/i,
    ]) {
      assert.match(section, pattern)
    }
  })

  it('source contract: retained migration entrypoints stay separate and dormant', () => {
    const section = brief.split('## 8. Retained migration runner contract')[1]
      .split('\n## ')[0]
    assert.match(section, /functions\/phase3\/inventory\.js/)
    assert.match(section, /functions\/phase3\/preflight\.js/)
    assert.match(section, /functions\/phase3\/write\.js/)
    assert.match(section, /functions\/phase3\/reverify\.js/)
    assert.match(section, /clean-start release does not run\s+any of them/)
    assert.match(
      section,
      /no shared write subcommand, `--force`, production override/,
      'the brief must forbid a shared subcommand and override flags',
    )
  })

  // -------------------------------------------------------------------------
  // Commit boundary. Item 10 earns all three separately deployable rules
  // artifacts while the production rules file remains unchanged.
  // -------------------------------------------------------------------------

  it('boundary: Item 10 delivers three independently checksum-pinned rules artifacts', () => {
    for (const [file, expectedHash] of [
      ['firestore.phase3.bridge.rules', EXPECTED_BRIDGE_RULES_SHA256],
      ['firestore.phase3.final.rules', EXPECTED_FINAL_RULES_SHA256],
      ['firestore.phase3.rollback.rules', EXPECTED_ROLLBACK_RULES_SHA256],
    ]) {
      const artifact = readFileSync(new URL(`../../${file}`, import.meta.url))
      assert.equal(
        createHash('sha256').update(artifact).digest('hex'),
        expectedHash,
        `${file} must match its reviewed checksum`,
      )
    }
  })

  it('boundary: the default production Firebase config can deploy only final rules', () => {
    const firebaseConfig = JSON.parse(
      readFileSync(new URL('../../firebase.json', import.meta.url), 'utf8'),
    )
    assert.equal(
      firebaseConfig.firestore?.rules,
      'firestore.phase3.final.rules',
      'a routine production rules deploy must never select the recursive legacy baseline',
    )
  })

  it('boundary: the security plan records the safe default rules target', () => {
    assert.match(
      securityPlan,
      /default deployment target in `firebase\.json`\s+is now `firestore\.phase3\.final\.rules`/,
      'the security plan must identify final rules as the default deployment target',
    )
    assert.doesNotMatch(
      securityPlan,
      /`firebase\.json` still targets/,
      'the security plan must not retain the superseded legacy-target warning',
    )
  })

  it('boundary: IAM role definitions and all governing references are checksum-pinned', () => {
    const governingDocuments = [brief, runbook, iamEvidence]
    for (const [file, expectedHash] of [
      ['iam/phase3/phase3DataPlaneReader.yaml', EXPECTED_PHASE3_DATA_PLANE_READER_SHA256],
      ['iam/phase3/phase3MigrationWriter.yaml', EXPECTED_PHASE3_MIGRATION_WRITER_SHA256],
    ]) {
      const artifact = readFileSync(new URL(`../../${file}`, import.meta.url))
      assert.equal(
        createHash('sha256').update(artifact).digest('hex'),
        expectedHash,
        `${file} must match its reviewed checksum`,
      )
      for (const document of governingDocuments) {
        assert.equal(
          document.match(new RegExp(expectedHash, 'g'))?.length,
          1,
          `each governing document must state ${file}'s checksum exactly once`,
        )
      }
    }
  })

  it('boundary: the runbook binds the clean-start release and withdrawal rollback to the reviewed order', () => {
    assert.match(
      runbook,
      /production Steps 10–11 completed and privacy-safely verified;\s+observation window incomplete; not production authorization/i,
    )
    const release = runbookReleaseSteps()
    const functionsGateOff = stepIndex(release, /deploy/i, /V2 Functions/i, /false/i)
    const finalRules = stepIndex(release, /Deploy/i, /final-rules hash/i)
    const gate = stepIndex(release, /MULTI_TEACHER_V2_RELEASE_ID/i, /true/i)
    const hosting = stepIndex(release, /Deploy/i, /gate-on Hosting/i)
    const invitation = stepIndex(release, /invitation/i, /administrative-data-write/i)
    const onboarding = stepIndex(release, /onboardTeacherClassroomV2/i)
    const acceptance = stepIndex(release, /fresh-account acceptance/i)
    const window = stepIndex(release, /rollback window/i)
    assert.ok(functionsGateOff < finalRules)
    assert.ok(finalRules < gate)
    assert.ok(gate < hosting)
    assert.ok(hosting < invitation)
    assert.ok(invitation < onboarding)
    assert.ok(onboarding < acceptance)
    assert.ok(acceptance < window)

    const rollback = runbookRollbackSteps()
    const hostingOff = stepIndex(rollback, /Hosting/i, /default-off/i)
    const gateOff = stepIndex(rollback, /disable/i, /V2 server gate/i)
    const keepFinal = stepIndex(rollback, /Keep/i, /final rules/i)
    const noLegacy = stepIndex(rollback, /no legacy writes resume/i)
    assert.ok(hostingOff < gateOff)
    assert.ok(gateOff < keepFinal)
    assert.ok(keepFinal <= noLegacy)

    assert.match(runbook, /Never deploy the\s+recursive baseline, bridge, or rollback-safe rules/i)
    assert.match(runbook, /Never record credential contents, private keys,\s+access\/refresh tokens, PINs/i)
    assert.match(runbook, /Disabling the Functions gate does not revoke an already authenticated teacher's\s+direct Firestore permission/i)
  })

  it('boundary: the founding invitation must remain time-bounded and end consumed', () => {
    const abortCriteria = runbookAbortCriteria()
    assert.match(
      abortCriteria,
      /founding invitation lacks an `expiresAt` field containing a future\s+Firestore Timestamp when step 9 is verified/i,
    )
    assert.match(
      abortCriteria,
      /invitation is not\s+`consumed` after step 10/i,
    )
  })

  it('source contract: v1 is terminated and privacy-preserving v2 is one-field, one-Save, and separately authorized', () => {
    assertInvitationRecoveryContract()

    const release = runbookReleaseSteps()
    const invitation = stepIndex(release, /invitation/i, /administrative-data-write/i)
    const onboarding = stepIndex(release, /onboardTeacherClassroomV2/i)
    assert.ok(invitation < onboarding, 'conditional recovery must remain before onboarding')
    assert.match(release[invitation].text, /expires before step 10, stop/i)
    assert.match(release[invitation].text, /separately reviewed and authorized one-time recovery/i)
    assert.match(release[invitation].text, /never by improvising an update, retry, delete, or recreation/i)

    const abortCriteria = runbookAbortCriteria()
    assert.match(abortCriteria, /one-time recovery lacks its exact reviews/i)
    assert.match(abortCriteria, /v1 is reused/i)
    assert.match(abortCriteria, /Chrome runtime cannot establish\s+content-silent control/i)
    assert.match(abortCriteria, /fixed-key boolean\s+fails/i)
    assert.match(abortCriteria, /browser output contains raw or extra page content/i)
    assert.match(abortCriteria, /expected control\s+is\s+non-unique/i)
    assert.match(abortCriteria, /any field other than\s+`expiresAt` would change/i)
    assert.match(abortCriteria, /single Save\s+is\s+failed or ambiguous/i)
    assert.match(abortCriteria, /refreshed invitation expires before\s+onboarding/i)
  })

  it('source contract: recovery assertions reject restored v1, unsafe output, weakened preconditions, or widened authority', () => {
    assertInvitationRecoveryContract(runbook)

    for (const [label, before, after] of [
      [
        'restored v1 authority',
        'it cannot be activated, reused, retried, renewed,\nor treated as authority for v2',
        'it may be reused after new authorization',
      ],
      [
        'raw invitation snapshots',
        'no page snapshot, screenshot,\n   page text, or content excerpt may be emitted at all',
        'raw page snapshots may be emitted',
      ],
      [
        'missing runtime suppression prerequisite',
        'If that capability is absent, undocumented, or\n   ambiguous, v2 terminates before any invitation read.',
        'If that capability is absent, continue anyway.',
      ],
      [
        'missing privacy key',
        '     privacyBoundaryIntact\n   }',
        '   }',
      ],
      [
        'diagnostic output widening',
        'no extra key or diagnostic text may appear',
        'diagnostic text may appear',
      ],
      [
        'unbound selected account',
        'normalized email of the already selected verified Google\n   account intended for step 10 and currently authenticating the console\n   session.',
        'normalized email of any Google account.',
      ],
      [
        'weakened Timestamp types',
        '`createdAt` and `expiresAt` are Firestore Timestamps, and',
        '`createdAt` and `expiresAt` are any date-like values, and',
      ],
      [
        'removed pending-edit and ambiguity guard',
        ', unexpected field, pending console edit, or\n   ambiguous state exists.',
        ', unexpected field exists.',
      ],
      [
        'widened field mutation',
        'permitted mutation: change only `expiresAt`',
        'permitted mutation: change `expiresAt` and `status`',
      ],
      [
        'second Save',
        'At most one Firestore console **Save** is permitted.',
        'At most two Firestore console **Save** actions are permitted.',
      ],
      [
        'retry authority',
        'terminates v2; there is no repair, second edit, or retry.',
        'terminates v2; one repair or retry is permitted.',
      ],
      [
        'implicit onboarding',
        'Step 10 onboarding still requires a\nseparate contemporaneous authorization',
        'Step 10 onboarding is authorized by v2',
      ],
    ]) {
      assert.ok(runbook.includes(before), `${label} negative control must mutate real text`)
      assert.throws(
        () => assertInvitationRecoveryContract(runbook.replace(before, after)),
        assert.AssertionError,
        `${label} must fail the recovery source contract`,
      )
    }
  })

  it('source contract: status documents agree on completed Steps 10–11 and the remaining observation boundary', () => {
    assertCompletedProductionStatus()

    assert.match(runbook, new RegExp(RELEASE_SEQUENCE_009_SHA256))
    assert.match(phase3Readme, new RegExp(RELEASE_SEQUENCE_009_SHA256))
    assert.match(brief, /retained release archive closes steps 1–9 only/i)
    assert.match(architecture, /external\s+release record.*production steps\s+1–9/is)
    assert.match(architecture, /Items 1–16 implemented; clean-start production Steps 10–11\s+completed/i)
    assert.match(phase3Readme, /\| 13 \|[^\n]+\| reviewed; dormant under clean start \|/)
    assert.match(phase3Readme, /\| 14 \|[^\n]+\| reviewed; release recorded through step 9 \|/)
    assert.match(phase3Readme, /\| 15 \|[^\n]+\| reviewed; v1 terminated without Save or mutation \|/)
    assert.match(phase3Readme, /\| 16 \|[^\n]+\| production recovery and Steps 10–11 complete; reviews explicitly skipped by Andrew for recovery\/onboarding \|/)
    assert.match(brief, /15\. Expired founding-invitation recovery and status reconciliation/)
    assert.match(brief, /16\. Privacy-preserving expired-invitation recovery/)

    const statusSources = [
      brief,
      runbook,
      architecture,
      phase3Readme,
      releaseOrderContractSource,
    ]
    for (const identifier of [
      TERMINATED_INVITATION_RECOVERY_V1_ID,
      PRIVACY_SAFE_INVITATION_RECOVERY_V2_ID,
    ]) {
      const occurrences = statusSources.reduce(
        (count, document) => count + (document.match(new RegExp(identifier, 'g'))?.length ?? 0),
        0,
      )
      assert.equal(occurrences, 3, `${identifier} must appear once in runbook, brief, and contract`)
    }
  })

  it('source contract: status assertions reject negated completion, retention, and Step 12 facts', () => {
    for (const [label, before, after] of [
      [
        'incomplete Steps 10–11',
        'Status: **production Steps 10–11 completed and privacy-safely verified;\nobservation window incomplete; not production authorization**',
        'Status: **production Steps 10–11 incomplete and not verified;\nobservation window incomplete; not production authorization**',
      ],
      [
        'negated foundation verdict',
        'All five\nresults were `true`.',
        'Not all five\nresults were `true`; two checks failed.',
      ],
      [
        'negated cleanup retention',
        'Independent sanitized reads verified the student absent, credential\nretained/inactive, transaction preserved, and `nextStudentNumber` still `2`.',
        'Independent sanitized reads did not verify the student absent, credential\nretained/inactive, transaction preserved, or `nextStudentNumber` still `2`.',
      ],
      [
        'started and authorized Step 12',
        "Step 12's\nobservation window has not begun and is not authorized by this record.",
        "Step 12's\nobservation window has begun and is fully authorized by this record.",
      ],
    ]) {
      assert.ok(runbook.includes(before), `${label} negative control must mutate real text`)
      assert.throws(
        () => assertCompletedProductionStatus({
          runbookMarkdown: runbook.replace(before, after),
        }),
        assert.AssertionError,
        `${label} must fail the completed-status source contract`,
      )
    }
  })

  it('boundary: the release rehearsal executes real runner and candidate-rules evidence', () => {
    assert.match(releaseRehearsal, /initializeTestEnvironment/)
    assert.match(releaseRehearsal, /runWriteMain/)
    assert.match(releaseRehearsal, /runReverifyMain/)
    assertOrderedMarkers(releaseRehearsal, [
      "'freeze-entered'",
      "'foundation-verified'",
      "'initialization-verified'",
      "'bridge-rules-verified'",
      "'functions-gate-off-verified'",
      "'copy-reconciled'",
      "'final-rules-verified'",
      "'release-id-gate-enabled'",
      "'gate-on-hosting-verified'",
      "'existing-user-acceptance-passed'",
      "'freeze-released'",
      "'rollback-window-observing'",
    ], 'release rehearsal ledger')
    for (const hash of [EXPECTED_BRIDGE_RULES_SHA256, EXPECTED_FINAL_RULES_SHA256]) {
      assert.match(releaseRehearsal, new RegExp(hash))
    }
    assert.doesNotMatch(
      releaseRehearsal,
      /firebase\s+deploy|copyFileSync\([^)]*firestore\.rules/,
    )
  })

  it('boundary: the rollback rehearsal retains credentials and blocks early writes', () => {
    assert.match(rollbackRehearsal, /initializeTestEnvironment/)
    assertOrderedMarkers(rollbackRehearsal, [
      "'freeze-retained'",
      "'hosting-default-off-restored'",
      "'server-gate-disabled'",
      "'rollback-rules-verified'",
      "'legacy-state-reconciled'",
      "'legacy-acceptance-passed'",
      "'writes-resumed'",
    ], 'rollback rehearsal ledger')
    assert.match(rollbackRehearsal, new RegExp(EXPECTED_FINAL_RULES_SHA256))
    assert.match(rollbackRehearsal, new RegExp(EXPECTED_ROLLBACK_RULES_SHA256))
    assert.match(rollbackRehearsal, /legacy writes cannot resume yet/)
    assert.doesNotMatch(
      rollbackRehearsal,
      /firebase\s+deploy|copyFileSync\([^)]*firestore\.rules/,
    )
  })

  it('boundary: src/phase3 contains only the modules Section 11 permits', () => {
    // src/phase3 is Commit 7 (tenant data projection/service). It was absent
    // through Commit 6; from Commit 7 it is scoped by content, exactly as
    // functions/phase3 is in the next assertion.
    const directory = new URL('../../src/phase3/', import.meta.url)
    assert.ok(existsSync(directory), 'src/phase3 exists from Commit 7 onward')

    // The complete Section 11 src/phase3 list. An unlisted file requires an
    // architecture update before it may be added.
    const PERMITTED = new Set([
      'tenantDataProjection.js',
      'tenantDataProjection.test.js',
      'tenantDataService.js',
      'tenantDataService.test.js',
    ])

    for (const entry of readdirSync(directory)) {
      assert.ok(PERMITTED.has(entry), `src/phase3/${entry} is not permitted by Section 11`)
    }

    // Each implementation module must ship with its colocated suite in the same
    // commit; Section 11 forbids adding either as a placeholder.
    for (const module of ['tenantDataProjection', 'tenantDataService']) {
      assert.ok(
        existsSync(new URL(`${module}.js`, directory)),
        `${module}.js must exist`,
      )
      assert.ok(
        existsSync(new URL(`${module}.test.js`, directory)),
        `${module}.test.js must accompany its implementation`,
      )
    }
  })

  it('boundary: functions/phase3 contains only modules earned by completed commits', () => {
    const directory = new URL('../../functions/phase3/', import.meta.url)
    if (!existsSync(directory)) {
      // Before Commit 2 the directory is absent, which is also in-bounds.
      return
    }

    // Every file permitted by Section 11's functions/phase3 list. Presence here
    // means "allowed to exist eventually"; the sets below pin what the CURRENT
    // commit has actually earned, so a later commit's module cannot appear early.
    const SECTION_11_PERMITTED = new Set([
      'productionEnvironment.js', 'productionEnvironment.test.js',
      'productionPreflight.js', 'productionPreflight.test.js',
      'productionProjection.js', 'productionProjection.test.js',
      'productionManifest.js', 'productionManifest.test.js',
      'productionInventory.js', 'productionInventory.test.js',
      'productionWriter.js', 'productionWriter.test.js',
      'productionReconciliation.js', 'productionReconciliation.test.js',
      'inventory.js', 'inventory.test.js',
      'preflight.js', 'write.js', 'reverify.js',
      'studentLifecycle.js', 'studentLifecycle.test.js',
      // Approved student-money regression fix. Student writes remain denied by
      // rules; this paired module owns the claim-derived, atomic callable path.
      'studentMoney.js', 'studentMoney.test.js',
      // The production-read safety correction: the operator-only reviewed
      // checkout proof, split out of productionEnvironment.js so the deployed
      // Functions graph carries no subprocess capability.
      'reviewedCheckout.js', 'reviewedCheckout.test.js',
      // Teacher-visible current student PINs. Andrew approved recoverable PINs so
      // a teacher can look one up instead of resetting blind. Deliberately a
      // separate module and a separate Firestore collection, so the reviewed
      // credential document keeps its exact key set and its authentication
      // material is untouched.
      'studentPinDirectory.js', 'studentPinDirectory.test.js',
    ])

    /**
     * The canonical runtime state directory the Section 11 amendment permits. It
     * holds retained manifests, not source, so it is excluded from the source
     * boundary below — but it must be a DIRECTORY, and it must be gitignored, so a
     * stray file of that name cannot smuggle content in.
     */
    const RUNTIME_STATE_DIRECTORY = '.state'

    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === RUNTIME_STATE_DIRECTORY) {
        assert.ok(
          entry.isDirectory(),
          'functions/phase3/.state must be the runtime state directory, not a file',
        )
        continue
      }
      assert.ok(
        SECTION_11_PERMITTED.has(entry.name),
        `functions/phase3/${entry.name} is outside Section 11's permitted file list`,
      )
    }

    const actual = entries.map(entry => entry.name)

    // The source boundary above exempts .state/ from the permitted-file list, so
    // the ignore rule is what keeps a retained manifest — which records production
    // observations — from becoming committable. Coupled here deliberately: the
    // exemption and the ignore rule must stand or fall together.
    const gitignore = readFileSync(
      new URL('../../.gitignore', import.meta.url), 'utf8',
    )
    assert.ok(
      gitignore.split('\n').map(line => line.trim())
        .includes('functions/phase3/.state/'),
      '.gitignore must ignore functions/phase3/.state/ so retained manifests are never committed',
    )

    // Commit 2 earned exactly the environment guard module and its test.
    // Everything else in Section 11's list belongs to Commits 3-6. Both the
    // implementation AND its test are pinned: listing only the .js files would
    // let a later commit's test file appear without its implementation, which is
    // the mirror image of the placeholder problem Section 12 forbids.
    // Commit 3 earned productionPreflight, productionManifest, and preflight.js;
    // Commit 4 earned productionProjection and productionReconciliation;
    // Commit 5 earned productionWriter (with its colocated test), write.js, and
    // reverify.js. Commit 6 earns the student lifecycle module and its test.
    // Item 13 earns the control-plane inventory module and separate entrypoint,
    // each with its colocated behavioral test.

    // Completed commits must actually deliver their files, not merely be permitted to.
    // Pinning presence here is what stops the boundary test from silently
    // passing if the writer were dropped from the commit.
    for (const name of [
      'productionWriter.js', 'productionWriter.test.js',
      'write.js', 'reverify.js',
      'studentLifecycle.js', 'studentLifecycle.test.js',
      'studentMoney.js', 'studentMoney.test.js',
      'productionInventory.js', 'productionInventory.test.js',
      'inventory.js', 'inventory.test.js',
      'reviewedCheckout.js', 'reviewedCheckout.test.js',
    ]) {
      assert.ok(
        actual.includes(name),
        `functions/phase3/${name} is earned by a completed commit and must exist`,
      )
    }

    /**
     * The three CLI entrypoints are exempt from colocation: the amended Section
     * 11 assigns their coverage to the production-runner suites under
     * `tests/phase3/`, and no `preflight.test.js` / `write.test.js` /
     * `reverify.test.js` is permitted to exist. Requiring a colocated test for
     * them would demand an unpermitted file.
     */
    const COLOCATION_EXEMPT_ENTRYPOINTS = new Set([
      'preflight.js', 'write.js', 'reverify.js',
    ])

    for (const name of COLOCATION_EXEMPT_ENTRYPOINTS) {
      const forbiddenTest = name.replace(/\.js$/, '.test.js')
      assert.ok(
        !SECTION_11_PERMITTED.has(forbiddenTest),
        `${forbiddenTest} is not a permitted file; entrypoints are covered by the runner suites`,
      )
      assert.ok(
        !actual.includes(forbiddenTest),
        `${forbiddenTest} must not exist — entrypoint coverage lives in tests/phase3/`,
      )
    }

    // Every non-entrypoint implementation module present must ship with its
    // colocated test in the same commit, per the Section 11 amendment.
    const implementationModules = actual.filter(name =>
      name.endsWith('.js') &&
      !name.endsWith('.test.js') &&
      !COLOCATION_EXEMPT_ENTRYPOINTS.has(name))

    for (const name of implementationModules) {
      const expectedTest = name.replace(/\.js$/, '.test.js')
      assert.ok(
        actual.includes(expectedTest),
        `${name} must ship with ${expectedTest} in the same commit`,
      )
    }

    // The converse: no colocated test may exist without its implementation.
    for (const name of actual.filter(f => f.endsWith('.test.js'))) {
      const implementation = name.replace(/\.test\.js$/, '.js')
      assert.ok(
        actual.includes(implementation),
        `${name} must not exist without ${implementation}`,
      )
    }
  })

  /**
   * The deployed Functions artifact and the operator tooling share this
   * directory, so "operator-only" has to be a proven graph property rather than
   * a naming convention. `functions/package.json` sets `main: index.js` and
   * firebase.json's functions `ignore` list does not exclude `phase3/`, so every
   * module transitively imported by `index.js` is loaded in a Cloud Functions
   * runtime on every cold start.
   *
   * This walks that real graph from `index.js` and requires that it never
   * reaches the reviewed-checkout module or any subprocess capability. The
   * checkout proof is an operator-workstation concern; nothing that runs inside
   * a deployed function may be able to spawn a process.
   */
  it('boundary: the deployed Functions graph reaches no subprocess or checkout module', () => {
    const functionsRoot = new URL('../../functions/', import.meta.url)
    const OPERATOR_ONLY = 'phase3/reviewedCheckout.js'

    const resolveSpecifier = (fromEntry, specifier) => {
      const segments = fromEntry.split('/').slice(0, -1)
      for (const segment of specifier.split('/')) {
        if (segment === '.' || segment === '') continue
        if (segment === '..') segments.pop()
        else segments.push(segment)
      }
      return segments.join('/')
    }

    /**
     * Extracts every relative module specifier an ES module actually imports.
     *
     * Both quote styles are recognized, and the closing quote must match the
     * opening one. The repository's ESLint configuration sets no `quotes` rule,
     * so a double-quoted edge lints clean; a single-quote-only pattern here
     * would let `import "./phase3/reviewedCheckout.js"` reach the deployed graph
     * while this contract still passed. A specifier never spans a line, so
     * newlines are excluded from both bodies — that is what keeps an unclosed
     * quote from swallowing the following lines and inventing a match.
     */
    const extractLocalSpecifiers = source =>
      [...source.matchAll(
        /(?:from|import)\s*\(?\s*(?:'(\.\.?\/[^'\n]+)'|"(\.\.?\/[^"\n]+)")/g,
      )].map(([, single, double]) => single ?? double)

    // Negative control for the extractor the walk below depends on. If it ever
    // regresses to one quote style, or starts accepting a mismatched pair, the
    // graph assertions would silently pass on an under-collected graph.
    const quotedImportFixture = [
      "import './a-side-effect.js'",
      'import "./b-side-effect.js"',
      "import value from './c-from.js'",
      'import other from "./d-from.js"',
      "export { thing } from './e-reexport.js'",
      'export { alias } from "./f-reexport.js"',
      "const g = await import('./g-dynamic.js')",
      'const h = await import("./h-dynamic.js")',
      // A quote that does not close with its own kind is not a specifier.
      "import './i-mismatched.js\"",
      'import "./j-mismatched.js\'',
    ].join('\n')

    assert.deepEqual(
      extractLocalSpecifiers(quotedImportFixture),
      [
        './a-side-effect.js', './b-side-effect.js',
        './c-from.js', './d-from.js',
        './e-reexport.js', './f-reexport.js',
        './g-dynamic.js', './h-dynamic.js',
      ],
      'the walker must see both quote styles for side-effect, from, and ' +
        'dynamic imports, and must reject a mismatched quote pair',
    )

    const visited = new Set()
    const queue = ['index.js']
    while (queue.length > 0) {
      const entry = queue.shift()
      if (visited.has(entry)) continue
      visited.add(entry)

      const location = new URL(entry, functionsRoot)
      // A specifier that escapes functions/ or names a package is out of this
      // boundary's scope; only real local files are walked.
      if (!existsSync(location)) continue
      const source = readFileSync(location, 'utf8')

      for (const quoted of ['\'node:child_process\'', '"node:child_process"']) {
        assert.ok(
          !source.includes(quoted),
          `functions/${entry} is reachable from the deployed index.js and ` +
            'must not import node:child_process',
        )
      }

      // Static `from`, side-effect `import`, re-export, and dynamic
      // `import()` forms of a relative specifier, in either quote style.
      for (const specifier of extractLocalSpecifiers(source)) {
        queue.push(resolveSpecifier(entry, specifier))
      }
    }

    // Sanity: the walk must actually be reaching Phase 3, otherwise the
    // assertions above would pass on an empty graph.
    assert.ok(
      visited.has('phase3/productionEnvironment.js'),
      'the walk must reach the guard module index.js imports for the V2 gate',
    )
    assert.ok(
      visited.has('phase3/studentLifecycle.js'),
      'the walk must reach the deployed Phase 3 callables',
    )
    assert.ok(
      visited.has('phase3/studentMoney.js'),
      'the walk must reach the deployed student-money callable',
    )
    assert.ok(
      !visited.has(OPERATOR_ONLY),
      `${OPERATOR_ONLY} is operator-only and must stay out of the deployed graph`,
    )

    // The converse: the operator entrypoints must actually use it, so the
    // separation cannot be satisfied by deleting the proof outright.
    for (const entrypoint of [
      'inventory.js', 'preflight.js', 'write.js', 'reverify.js',
    ]) {
      const source = readFileSync(
        new URL(`phase3/${entrypoint}`, functionsRoot), 'utf8',
      )
      assert.match(
        source,
        /from '\.\/reviewedCheckout\.js'/,
        `phase3/${entrypoint} must obtain its checkout proof from the ` +
          'operator-only module',
      )
    }
  })

  it('boundary: the preflight entrypoint cannot reach write or reverify code', () => {
    const preflightPath = new URL(
      '../../functions/phase3/preflight.js', import.meta.url,
    )
    if (!existsSync(preflightPath)) return

    const source = readFileSync(preflightPath, 'utf8')

    // Decision 2.10: no argument or subcommand typo may turn preflight into a
    // write. The structural guarantee is that the write path is not importable
    // from here — the sibling entrypoints do not exist yet, and this file must
    // never import them or a writer module.
    for (const forbidden of [
      './inventory.js', './write.js', './reverify.js', './productionWriter.js',
      './productionProjection.js', './productionReconciliation.js',
      './studentLifecycle.js',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `preflight.js must not import ${forbidden}`,
      )
    }

  })

  it('boundary: reverify cannot import the writer or reach a mutation', () => {
    const source = readFileSync(
      new URL('../../functions/phase3/reverify.js', import.meta.url), 'utf8',
    )

    // The structural guarantee that makes reverify read-only: the writer is the
    // only module holding transaction/create/update code, so not importing it
    // means no mutating call is reachable from this file at all.
    //
    // Matched against actual import statements rather than a bare substring —
    // the forbidden-vocabulary list in this very test file would otherwise make
    // a naive `includes` check match itself.
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(m => m[1])
    assert.ok(
      !imports.some(specifier => specifier.includes('productionWriter')),
      `reverify.js must never import productionWriter.js (imports: ${imports})`,
    )

    for (const forbidden of [
      'runTransaction', '.batch(', 'writeBatch',
      '.create(', '.update(', '.set(', '.delete(',
      'createUser', 'updateUser', 'deleteUser', 'setCustomUserClaims',
      'persistProductionManifest', 'journal.append',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `reverify.js must contain no ${forbidden} call path`,
      )
    }
  })

  it('boundary: write.js has no subcommand dispatch or forbidden override', () => {
    const source = readFileSync(
      new URL('../../functions/phase3/write.js', import.meta.url), 'utf8',
    )

    // The stage is derived from the journal alone. A stage/mode/resume flag
    // would reintroduce exactly the bypass the two-invocation design removes.
    for (const forbidden of [
      "'--stage'", "'--mode'", "'--resume'", "'--force'", "'--dry-run'",
      "'--teacher-uid'", "'--manifest-id'", "'--state-dir'",
    ]) {
      // Each appears ONLY inside the forbidden-vocabulary set, never as an
      // accepted value flag.
      const acceptedFlags = source.slice(
        source.indexOf('const VALUE_FLAGS'),
        source.indexOf('const FORBIDDEN_FLAGS'),
      )
      assert.ok(
        !acceptedFlags.includes(forbidden),
        `write.js must not accept ${forbidden}`,
      )
    }

    assert.ok(
      source.includes('FORBIDDEN_SUBCOMMANDS'),
      'write.js must reject subcommands by name',
    )
    assert.ok(
      !/switch\s*\(\s*(subcommand|command|argv\[0\])/.test(source),
      'write.js must have no subcommand dispatch',
    )
  })

  it('boundary: the production writer holds no delete or Auth mutation path', () => {
    const source = readFileSync(
      new URL('../../functions/phase3/productionWriter.js', import.meta.url),
      'utf8',
    )
    for (const forbidden of [
      '.delete(', 'deleteDoc', 'recursiveDelete', 'bulkWriter',
      'createUser', 'updateUser', 'deleteUser', 'setCustomUserClaims',
      '.batch(', 'writeBatch',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `productionWriter.js must not contain ${forbidden}`,
      )
    }
    // Transactions, not blind batches.
    assert.ok(source.includes('runTransaction'))
    // No cleanup/prune surface may be exported.
    for (const forbidden of [
      'export function cleanup', 'export function prune',
      'export function deleteJournal',
    ]) {
      assert.ok(!source.includes(forbidden), `must not export ${forbidden}`)
    }
  })

  it('invariant: the manifest installs by link and never opens the target for writing', () => {
    // The original implementation wrote a temp file and then INDEPENDENTLY opened
    // and wrote the target, leaving the temp file uninstalled. A crash after the
    // target was created left a truncated file at a content address that the
    // never-overwrite rule then made permanent. Pinned here because the behavioral
    // tests use an injected fs double, so only a source guard catches a revert to
    // a direct target write or to a clobbering rename.
    const source = readFileSync(
      new URL('../../functions/phase3/productionManifest.js', import.meta.url),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

    assert.ok(
      /fs\.link\(\s*temporaryPath\s*,\s*targetPath\s*\)/.test(code),
      'the manifest must be installed by linking the temp file onto the target',
    )
    assert.ok(
      !/fs\.open\(\s*targetPath\s*,\s*'wx'/.test(code),
      'the target must never be opened for writing; only link() may create it',
    )
    assert.ok(
      !/\brename\b/.test(code),
      'rename() silently replaces an existing file and must not be used',
    )
  })

  it('invariant: a successful preflight cannot skip manifest persistence', () => {
    // An earlier version treated the persister as optional and a test REQUIRED
    // success with `persisted: null`, which would let a later writer believe a
    // preflight occurred that left no verifiable record.
    const source = readFileSync(
      new URL('../../functions/phase3/productionPreflight.js', import.meta.url),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

    assert.ok(
      !/typeof\s+persistManifest\s*===\s*'function'\s*\n?\s*\?/.test(code),
      'persistence must not be conditional on a persister being supplied',
    )
    assert.ok(
      /const\s+persisted\s*=\s*await\s+persistManifest\(/.test(code),
      'the persister must be invoked unconditionally',
    )
    // And the domain must carry the raw artifact digest, not a field subset.
    assert.ok(
      /authorizationArtifact:\s*\{\s*sha256:\s*authorizationSha256\s*\}/.test(code),
      'the authorization domain must be the pre-parse digest of the artifact bytes',
    )
  })

  it('invariant: the shared data readers preserve raw ID types and read every scoped surface', () => {
    // Two regressions this pins, both found in delta review of correction A:
    //
    // 1. The readers coerced every student ID with String(...), which hid the
    //    cross-source numeric/string equivalence the watermark must normalize —
    //    the live suite therefore did not exercise the claimed behavior.
    // 2. `scopedLogs` was hardcoded to 0 with no read at all, so preflight would
    //    report absence for a surface nobody examined.
    const source = readFileSync(
      new URL('../../functions/phase3/productionPreflight.js', import.meta.url),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

    assert.ok(
      !/String\(\s*(?:student\.id|entry\.studentId|doc\.data\(\)\.studentId)\s*\)/
        .test(code),
      'the production data readers must preserve raw student-ID types, not stringify them',
    )
    assert.ok(
      !/scopedLogs:\s*0\b/.test(code),
      'scopedLogs must be enumerated, never hardcoded to zero',
    )
    assert.ok(
      /collection\('studentAuthLogs'\)\s*\n?\s*\.listDocuments\(\)|collection\('studentAuthLogs'\)\.listDocuments\(\)/
        .test(code),
      'scoped auth logs must be enumerated with listDocuments()',
    )
    // Full timestamp precision, not an ISO millisecond string.
    assert.ok(
      !/updateTime:\s*[^,\n]*toISOString\(\)/.test(code),
      'evidence update times must carry exact nanoseconds, not an ISO millisecond string',
    )
  })

  it('invariant: every destination surface is enumerated and feeds the watermark', () => {
    // The gap this pins: the surface contract named only students, credentials and
    // logs, so a pre-existing transaction or login-history document — Phase 2A
    // writes both — stayed invisible while preflight retained an absence manifest.
    // Removing any one enumeration, or re-stringifying any watermark source, must
    // fail rather than silently narrowing coverage.
    const preflight = readFileSync(
      new URL('../../functions/phase3/productionPreflight.js', import.meta.url),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    const emulator = readFileSync(
      new URL('./production-runner.emulator.test.js', import.meta.url),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

    // Phase 2A's destination model, mirrored in the Phase 3 contract.
    for (const collection of [
      'students', 'transactions', 'loginHistory', 'studentCredentials',
    ]) {
      assert.ok(
        new RegExp(`${collection}:\\s*'`).test(preflight),
        `CLASSROOM_SUBCOLLECTION_SURFACES must map ${collection}`,
      )
    }
    for (const surface of [
      'classroomStudents', 'classroomTransactions', 'classroomLoginHistory',
      'scopedCredentials', 'scopedLogs',
      // Commit 5: the root login-code index is a separately bound surface, so a
      // pre-existing reservation cannot hide behind another surface's zero.
      'loginCodeIndex',
    ]) {
      assert.ok(
        preflight.includes(`'${surface}'`),
        `DESTINATION_SURFACES must declare ${surface}`,
      )
    }
    // The whole collection AND the exact selected document must be inspected.
    assert.ok(
      /collectionPath:\s*'classroomLoginCodes'/.test(preflight),
      'the login-code index collection must be enumerated completely',
    )
    assert.ok(
      /classroomLoginCodes\/\$\{canonicalLoginCode\}/.test(preflight),
      'the exact selected login-code document must be inspected',
    )

    // Every destination reference set must reach the watermark.
    for (const idSet of [
      'destinationStudents', 'destinationCredentials', 'destinationTransactions',
      'destinationLoginHistory', 'destinationAuthLogs',
    ]) {
      assert.ok(
        preflight.includes(idSet),
        `${idSet} must contribute to watermark derivation`,
      )
    }

    // Identity versus reference classification must stay explicit.
    assert.ok(
      /WATERMARK_IDENTITY_SOURCES\s*=/.test(preflight) &&
        /WATERMARK_REFERENCE_SOURCES\s*=/.test(preflight),
      'watermark sources must be explicitly classified',
    )

    // The shared production reader must enumerate roots and preserve raw ID
    // types; the emulator suite must invoke that reader rather than a copy.
    assert.ok(
      /collectionPath:\s*'teachers'/.test(preflight) &&
        /collectionPath:\s*'classrooms'/.test(preflight),
      'teacher and classroom roots must both be enumerated',
    )
    assert.ok(
      /\.collection\(collectionPath\)\.listDocuments\(\)/.test(preflight),
      'root enumeration must use listDocuments() so phantom parents are reachable',
    )
    assert.ok(
      /if \(snapshot\.exists\) ids\.push\(reference\.id\)/.test(preflight),
      'only EXISTING documents may count as roots; a phantom parent is not a root',
    )
    assert.ok(
      !/String\(\s*document\.data\(\)\.studentId\s*\)/.test(preflight) &&
        !/destination\w*:\s*[^,\n]*\.map\(\s*\w+\s*=>\s*String\(/.test(preflight),
      'destination watermark sources must preserve raw ID types',
    )

    const destinationReader = preflight.match(
      /async function readDestinationPaths\([^)]*\)\s*\{[\s\S]*?async function readAuthCompatibility/,
    )?.[0] ?? ''
    assert.ok(
      destinationReader.length > 0,
      'the destination reader must be locatable for inspection',
    )
    assert.ok(
      /studentIdCoverageBySurface/.test(destinationReader) &&
        /recordIdentity/.test(destinationReader) &&
        /recordReference/.test(destinationReader),
      'every destination document must be classified as referenced or unassigned',
    )
    assert.ok(
      !/doc\.data\(\)\.id\s*\?\?\s*doc\.id/.test(destinationReader),
      'a missing student body ID must never fall back to the document ID',
    )
    assert.ok(
      !destinationReader.includes(
        '.filter(doc => doc.data().studentId != null)',
      ),
      'destination readers must classify missing IDs rather than filter them out',
    )
    assert.ok(
      /createReadOnlyDataReaders\(\{/.test(emulator),
      'the emulator suite must exercise the shared production data reader',
    )
    assert.ok(
      /referencedCount\s*\+\s*classification\.unassignedCount\s*!==\s*declaredDocuments/
        .test(preflight),
      'ID coverage must be cardinality-bound to the evidenced destination documents',
    )
  })

  it('boundary: the checked-in firestore.rules is byte-for-byte unchanged', () => {
    const contents = readFileSync(
      new URL('../../firestore.rules', import.meta.url),
    )
    assert.equal(
      createHash('sha256').update(contents).digest('hex'),
      EXPECTED_RULES_SHA256,
      'Commit 1 must not edit firestore.rules',
    )
  })

  it('boundary: the baseline rules still contain the hole Phase 3 must remove', () => {
    // Asserted positively so the checksum pin above cannot silently become
    // vacuous if the file were replaced by something unrelated.
    const rules = readFileSync(
      new URL('../../firestore.rules', import.meta.url),
      'utf8',
    )
    assert.match(
      rules,
      /match \/classrooms\/\{document=\*\*\}/,
      'the recursive allow is the documented starting condition for Phase 3',
    )
  })

  it('boundary: the reconciled brief remains evidence rather than authorization', () => {
    assert.match(
      brief,
      /Status: \*\*clean-start production Steps 10–11 completed and privacy-safely\s+verified; observation window incomplete; not production authorization\*\*/,
      'the brief must not silently become an authorization document',
    )
    assert.match(brief, /This document does not authorize production inspection/)
    assert.match(brief, /invitation\s+recovery,\s+real-account onboarding/)
  })
})
