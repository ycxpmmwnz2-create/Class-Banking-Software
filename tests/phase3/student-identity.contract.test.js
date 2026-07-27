// Phase 3 Commit 1, updated by Commit 6 — student-identity SOURCE contract.
//
// EVIDENCE LAYER: static analysis of index.html source text. This suite pins the
// client identity wiring and its remaining deferred gaps. It does NOT execute
// the client or prove runtime allocation behavior; the lifecycle unit/emulator
// suites own that evidence. See tests/phase3/README.md.
//
// Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 1, 4, 5, 14.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const indexHtml = readFileSync(
  new URL('../../index.html', import.meta.url),
  'utf8',
)
const lines = indexHtml.split('\n')

/** 1-indexed line numbers whose text matches a pattern. */
function matchingLines(pattern) {
  const found = []
  lines.forEach((line, index) => {
    if (pattern.test(line)) found.push(index + 1)
  })
  return found
}

/** Joined slice of source around a line, for sibling-field inspection. */
function contextAt(lineNumber, before = 2, after = 8) {
  return lines
    .slice(Math.max(0, lineNumber - 1 - before), lineNumber - 1 + after)
    .join('\n')
}

function enclosingV2Branch(needle) {
  const callIndex = indexHtml.indexOf(needle)
  assert.notEqual(callIndex, -1, `Expected ${needle} in index.html`)
  const marker = 'if (IS_MULTI_TEACHER_V2_ENABLED) {'
  const start = indexHtml.lastIndexOf(marker, callIndex)
  assert.notEqual(start, -1, `Expected a V2 branch enclosing ${needle}`)
  const openingBrace = indexHtml.indexOf('{', start)
  let depth = 0
  for (let index = openingBrace; index < indexHtml.length; index += 1) {
    if (indexHtml[index] === '{') depth += 1
    if (indexHtml[index] === '}') depth -= 1
    if (depth === 0) return indexHtml.slice(start, index + 1)
  }
  assert.fail(`Unterminated V2 branch enclosing ${needle}`)
}

describe('Phase 3 student-identity source contract', () => {
  it('source contract: V2 creation returns before the preserved legacy allocator', () => {
    const allocators = matchingLines(/id:\s*maxId \+ 1/)
    assert.equal(
      allocators.length,
      1,
      'the default-off legacy allocator must remain available for rollback',
    )

    const context = contextAt(allocators[0], 4, 8)
    assert.match(
      context,
      /data\.students\.reduce\(\(max, student\) => Math\.max\(max, student\.id\), 0\)/,
      'the allocator must still derive from the live roster maximum',
    )
    assert.match(context, /const newStudent = \{/)

    const v2Branch = enclosingV2Branch('orchestrateCreateStudent(v2TenantSession')
    assert.match(v2Branch, /orchestrateCreateStudent\(v2TenantSession, callableAdapter, \{/)
    assert.match(v2Branch, /name,\s*startingBalance,\s*pin/)
    assert.match(
      v2Branch,
      /data\.students\.push\(\{ \.\.\.result\.result\.student, transactions: \[\] \}\)/,
      'the four-field callable response must gain the required empty transaction mirror in the view',
    )
    assert.match(v2Branch, /return;/)
    assert.doesNotMatch(v2Branch, /maxId|saveData\(/)
  })

  it('source contract: V2 and legacy have exactly one isolated roster admission each', () => {
    const pushes = matchingLines(/data\.students\.push\(/)
    assert.equal(pushes.length, 2)
    assert.match(lines[pushes[0] - 1], /result\.result\.student, transactions: \[\]/)
    assert.match(lines[pushes[1] - 1], /newStudent/)
  })

  it('source contract: every Date.now() id is a transaction or login-history id, not a student id', () => {
    const dateNowIds = matchingLines(/id:\s*Date\.now\(\)/)
    assert.equal(
      dateNowIds.length,
      7,
      'the seven known Date.now() ID sites must remain accounted for',
    )

    for (const lineNumber of dateNowIds) {
      const context = contextAt(lineNumber, 2, 8)
      // A transaction/login-history record references an EXISTING student via
      // studentId/studentName siblings. A student allocator would not.
      assert.match(
        context,
        /studentId:/,
        `line ${lineNumber} must carry a studentId sibling proving it is not a student allocator`,
      )
      assert.match(
        context,
        /studentName:/,
        `line ${lineNumber} must carry a studentName sibling`,
      )
      assert.ok(
        !/const newStudent\b/.test(context),
        `line ${lineNumber} must not allocate a student`,
      )
    }
  })

  it('source contract: no student-ID literal outside the allocator and the claim echo', () => {
    // Guards the classification above against a NEW id-literal site appearing
    // unnoticed. Any addition here must be classified before Phase 3 derives
    // the historical-ID watermark.
    //
    // Deliberately NOT anchored to the start of a line. Every current literal
    // happens to be line-leading, but that is incidental formatting: an inline
    // `{ id: 999 }` would evade a `^\s*id:` matcher, which is exactly the
    // addition this assertion exists to catch. Verified by mutation.
    const idLiteralPattern = /(?:^|[{,(\s])id:\s/
    const idLiterals = matchingLines(idLiteralPattern)
    const totalOccurrences = (
      indexHtml.match(new RegExp(idLiteralPattern.source, 'g')) ?? []
    ).length
    assert.equal(
      idLiterals.length,
      9,
      `expected 9 known id: literals (1 allocator, 7 transaction/history, 1 claim echo); found ${idLiterals.length} at lines ${idLiterals.join(', ')}`,
    )
    // Guards against two literals hiding on one line, which the line-based
    // count above would report as one.
    assert.equal(
      totalOccurrences,
      9,
      `expected 9 total id: occurrences; found ${totalOccurrences}`,
    )

    const claimEcho = idLiterals.filter(lineNumber =>
      /id:\s*studentId,/.test(lines[lineNumber - 1]),
    )
    assert.equal(claimEcho.length, 1, 'exactly one claim-derived echo expected')
    // The enclosing function declaration sits 4 lines above the literal, so the
    // lookback must reach it; a narrower window would fail for the wrong reason.
    assert.match(
      contextAt(claimEcho[0], 6, 6),
      /function dataForSecureStudent/,
      'the echo must remain inside the read-only secure-student view model',
    )
  })

  /**
   * PINNED DEFECT. importBackup accepts arbitrary student objects from a user
   * file and reaches persistence through normalizeData without validating `id`.
   * This is why Section 4 disables V2 backup import for the initial cutover and
   * why Section 5's watermark must scan production-wide historical IDs. When
   * Commit 7 addresses it, this assertion is expected to be updated in that
   * commit — not silently deleted.
   */
  it('source contract: V2 disables backup import before it can reach normalizeData', () => {
    // Section 4: V2 backup import is disabled for the initial cutover. The
    // underlying defect below is unchanged and still pinned; Commit 7 closes it
    // for V2 by refusing the entry point, not by validating imported IDs.
    const importBackupLine = matchingLines(/function importBackup\(/)
    assert.equal(importBackupLine.length, 1)

    const body = contextAt(importBackupLine[0], 0, 40)
    const gateIndex = body.indexOf('IS_MULTI_TEACHER_V2_ENABLED')
    const parseIndex = body.indexOf('JSON.parse(e.target.result)')
    assert.ok(gateIndex !== -1, 'importBackup must gate on the V2 flag')
    assert.ok(parseIndex !== -1, 'the legacy parse path must remain for rollback')
    assert.ok(
      gateIndex < parseIndex,
      'the V2 refusal must precede any parsing of the imported file',
    )

    // The refusal must return, not merely warn and fall through.
    const gateBranch = body.slice(gateIndex, parseIndex)
    assert.match(gateBranch, /return;/)
    assert.ok(
      !/normalizeData\(/.test(gateBranch),
      'the V2 branch must never reach normalizeData',
    )

    // Pinned defect, unchanged: normalizeData still spreads imported student
    // objects and coerces only `frozen`, so an arbitrary `id` would survive
    // into persistence. Only the default-off legacy path can still reach it.
    const normalizeLine = matchingLines(/function normalizeData\(/)
    assert.equal(normalizeLine.length, 1)
    const normalizeBody = contextAt(normalizeLine[0], 0, 18)
    assert.match(
      normalizeBody,
      /parsed\.students\.map\(student => \(\{ \.\.\.student, frozen: Boolean\(student\.frozen\) \}\)\)/,
      'normalizeData still passes student ids through unvalidated (pinned defect)',
    )
  })

  it('source contract: plaintext pin remains only in the preserved legacy roster branch', () => {
    // Commit 6 keeps default-off rollback behavior intact. The V2 branch above
    // admits only the server response, which has no PIN; Commit 7 owns removal
    // of PIN displays and the remaining broader PIN-free V2 UI work.
    const allocator = matchingLines(/id:\s*maxId \+ 1/)[0]
    assert.match(
      contextAt(allocator, 2, 10),
      /^\s*pin,$/m,
      'the default-off legacy branch must remain unchanged',
    )
  })

  it('source contract: V2 removal calls only removeStudentV2 and returns before legacy save', () => {
    const branch = enclosingV2Branch('orchestrateRemoveStudent(v2TenantSession')
    assert.match(branch, /orchestrateRemoveStudent\(v2TenantSession, callableAdapter, \{/)
    assert.match(branch, /studentId: String\(student\.id\)/)
    assert.match(branch, /data\.students = data\.students\.filter/)
    assert.match(branch, /return;/)
    assert.doesNotMatch(branch, /saveData\(/)
  })

  it('source contract: the client supplies its own V2 data layer instead of a window hook', () => {
    // Commit 7 closes the Section 1 finding that the client data layer was
    // under-scoped. Through Commit 6 the client read both adapters off
    // `window`, and only the Item 10 browser harness ever defined them, so V2
    // mode had no production data layer at all.
    for (const adapter of [
      'V2_TENANT_DATA_ADAPTER',
      'V2_TENANT_DATA_SAVE_ADAPTER',
    ]) {
      assert.equal(
        matchingLines(new RegExp(`window\\.${adapter}`)).length,
        0,
        `${adapter} must no longer be read off window by production client code`,
      )
    }

    // The real service is imported from src/phase3 and constructed by the
    // client itself.
    assert.match(
      indexHtml,
      /import \{[^}]*createTenantDataLoader[^}]*\} from "\.\/src\/phase3\/tenantDataService\.js"/,
      'the client must import the production tenant data service',
    )
    for (const factory of [
      'createTenantDataLoader',
      'createStudentDataLoader',
      'createTenantDataSaver',
    ]) {
      assert.ok(
        matchingLines(new RegExp(`${factory}\\(`)).length > 0,
        `${factory} must be constructed by the client`,
      )
    }

    // Every constructed adapter is bound to the live tenant session, which is
    // what makes the stale-epoch and tenant-mismatch refusals reachable.
    for (const construction of [
      /createTenantDataLoader\(\{[\s\S]{0,200}?session: v2TenantSession/,
      /createStudentDataLoader\(\{[\s\S]{0,200}?session: v2TenantSession/,
      /createTenantDataSaver\(\{[\s\S]{0,200}?session: v2TenantSession/,
    ]) {
      assert.match(indexHtml, construction)
    }

    // The student loader was never wired before Commit 7, so every V2 student
    // failed with "student-access-unavailable".
    assert.match(
      indexHtml,
      /loadStudentNetworkFn,/,
      'the auth observer must pass the student loader to handleAuthTransition',
    )

    // The Item 10 harness no longer defines data adapters at all. It instruments
    // the production service by decorating the injected Firestore primitives, so
    // the browser suite's barriers sit UNDER the real code path.
    const harness = readFileSync(
      new URL('../../tests/browser/phase2b-browser-harness.js', import.meta.url),
      'utf8',
    )
    for (const adapter of ['V2_TENANT_DATA_ADAPTER', 'V2_TENANT_DATA_SAVE_ADAPTER']) {
      assert.doesNotMatch(
        harness,
        new RegExp(`window\\.${adapter}\\s*=(?!=)`),
        `the harness must not define ${adapter}: it would replace the production data layer ` +
          'and make every isolation assertion observe harness code instead',
      )
    }
    assert.match(
      harness,
      /window\.__PHASE2B_WRAP_FIRESTORE__\s*=(?!=)/,
      'the harness must instrument the production service by wrapping its injected primitives',
    )
    assert.match(
      harness,
      /Activates ONLY under an explicit browser-test flag/,
      'the harness must remain test-only, never a production adapter',
    )

    // The harness performs no Firestore I/O of its own. Were it to import the
    // SDK directly it could read or write behind the production path, which is
    // what made the pre-Commit-7 adapters able to fabricate data.
    assert.doesNotMatch(
      harness,
      /from "firebase\/firestore"/,
      'the harness must not import firebase/firestore: all I/O goes through the wrapped primitives',
    )
  })

  it('source contract: the browser harness seam matches index.html and is test-only', () => {
    // The browser suite instruments production by rewriting the served copy of
    // index.html (dev-server only) so the harness can decorate
    // V2_FIRESTORE_ADAPTERS. That rewrite is a literal string match against
    // production source, so a future index.html edit could silently disable
    // every response barrier. This pins the two halves together.
    const viteConfig = readFileSync(
      new URL('../../tests/browser/vite.phase2b.config.js', import.meta.url),
      'utf8',
    )

    const seamMatch = viteConfig.match(
      /export const FIRESTORE_SEAM_SOURCE\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)";/,
    )
    assert.ok(seamMatch, 'the vite config must export FIRESTORE_SEAM_SOURCE')
    const seam = seamMatch[1].replace(/\\"/g, '"')

    assert.equal(
      indexHtml.split(seam).length - 1,
      1,
      'FIRESTORE_SEAM_SOURCE must appear in index.html exactly once, or the browser ' +
        'suite silently loses its barriers',
    )

    // The rewrite must fail loudly rather than no-op, and must run in the `pre`
    // phase: Vite hoists index.html's inline module out of the HTML before the
    // default phase, so a `post` transform sees no application source.
    assert.match(viteConfig, /order:\s*"pre"/)
    assert.match(viteConfig, /throw new Error\(\s*\n?\s*`Phase 2B browser harness seam not found/)

    // Production source must carry no test affordance: the seam is a plain
    // production line, and the wrapper hook exists only in test files.
    assert.equal(
      matchingLines(/__PHASE2B_WRAP_FIRESTORE__/).length,
      0,
      'index.html must contain no browser-test hook; the seam is applied by the test config only',
    )
  })

  it('source contract: the V2 UI is PIN-free after authentication', () => {
    // Section 4: "do not display or edit stored PINs on roster/profile
    // screens". Both remaining `student.pin` renders must sit in the
    // default-off legacy arm of a V2 conditional.
    const pinRenders = matchingLines(/escapeHtml\((?:profileStudent|student)\.pin\)/)
    assert.equal(pinRenders.length, 2, 'exactly the roster input and profile line render a PIN')

    for (const line of pinRenders) {
      const context = contextAt(line, 12, 2)
      assert.match(
        context,
        /IS_MULTI_TEACHER_V2_ENABLED/,
        'each PIN render must be gated behind the V2 flag',
      )
    }

    // The roster PIN input is not merely hidden: updateStudent must not read it
    // in V2, or the Save button would throw on a missing element.
    const updateLine = matchingLines(/function updateStudent\(/)[0]
    const updateBody = contextAt(updateLine, 0, 50)
    const v2Index = updateBody.indexOf('IS_MULTI_TEACHER_V2_ENABLED')
    const pinReadIndex = updateBody.indexOf('getElementById("pin-"')
    assert.ok(v2Index !== -1 && pinReadIndex !== -1)
    assert.ok(
      v2Index < pinReadIndex,
      'the V2 branch must return before updateStudent reads the roster PIN input',
    )

    // Credential-activation state must not be written onto the student record:
    // the student document contract is exactly five fields.
    assert.ok(
      matchingLines(/v2ActivatedStudentIds/).length > 0,
      'V2 activation state must live in a view-only set',
    )
    for (const line of matchingLines(/\.credentialActive = true/)) {
      const context = contextAt(line, 14, 1)
      assert.ok(
        !/resetStudentPinV2/.test(context),
        'no V2 branch may assign credentialActive onto a student object',
      )
    }
  })

  it('source contract: V2 export is PIN-free and V2 import is disabled', () => {
    assert.match(
      indexHtml,
      /import \{ projectBackupExport \} from "\.\/src\/phase3\/tenantDataProjection\.js"/,
    )

    const exportLine = matchingLines(/function exportBackup\(/)[0]
    const exportBody = contextAt(exportLine, 0, 30)
    const gateIndex = exportBody.indexOf('IS_MULTI_TEACHER_V2_ENABLED')
    const legacyIndex = exportBody.indexOf('students: data.students')
    assert.ok(gateIndex !== -1 && legacyIndex !== -1)
    assert.ok(
      gateIndex < legacyIndex,
      'the V2 export branch must precede the legacy raw-aggregate body',
    )
    assert.match(exportBody, /projectBackupExport\(\{ data, exportedAt: data\.lastBackupAt \}\)/)
  })

  it('source contract: V2 save fails closed when no adapter is present', () => {
    assert.match(
      indexHtml,
      /reason: "missing-v2-save-adapter"/,
      'V2 persistence must still fail closed rather than writing the legacy blob',
    )
  })

  it('source contract: student login is not yet branched to the V2 callable', () => {
    // Pins the Section 4 gap that Commit 8 closes: the legacy payload shape and
    // the absence of a classroom-code input.
    assert.match(indexHtml, /httpsCallable\(functions, "studentPinLogin"\)/)
    assert.match(indexHtml, /studentPinLogin\(\{ loginId, pin \}\)/)
    assert.equal(
      matchingLines(/studentPinLoginV2/).length,
      0,
      'studentPinLoginV2 must not be wired until Commit 8',
    )
    assert.equal(
      matchingLines(/classroomCode/).length,
      0,
      'no classroom-code input exists yet',
    )
  })
})
