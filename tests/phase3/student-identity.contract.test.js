// Phase 3 Commit 1 — student-identity SOURCE contract.
//
// EVIDENCE LAYER: static analysis of index.html source text. This suite pins the
// CURRENT (pre-Phase-3) client identity facts that the Phase 3 student-lifecycle
// and tenant-data work must change. It does NOT execute the client, does not
// prove runtime allocation behavior, and does NOT assert the desired end state —
// several assertions deliberately pin a known DEFECT so it cannot be forgotten
// or silently altered before the commit that fixes it. See tests/phase3/README.md.
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

describe('Phase 3 student-identity source contract', () => {
  it('source contract: exactly one live student-ID allocator exists', () => {
    const allocators = matchingLines(/id:\s*maxId \+ 1/)
    assert.equal(
      allocators.length,
      1,
      'max(roster)+1 must be the single student allocator',
    )

    const context = contextAt(allocators[0], 4, 8)
    assert.match(
      context,
      /data\.students\.reduce\(\(max, student\) => Math\.max\(max, student\.id\), 0\)/,
      'the allocator must still derive from the live roster maximum',
    )
    assert.match(context, /const newStudent = \{/)
  })

  it('source contract: exactly one data.students.push allocation site exists', () => {
    assert.equal(matchingLines(/data\.students\.push\(/).length, 1)
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
  it('source contract: importBackup is an unvalidated student-ID entry path', () => {
    const importBackupLine = matchingLines(/function importBackup\(/)
    assert.equal(importBackupLine.length, 1)

    const body = contextAt(importBackupLine[0], 0, 30)
    assert.match(body, /JSON\.parse\(e\.target\.result\)/)
    assert.match(body, /imported\.students/)
    assert.match(body, /normalizeData\(/)
    assert.match(body, /saveData\(\)/)
    assert.ok(
      !/nextStudentNumber|allocateStudentId|validateStudentId/.test(body),
      'importBackup must still lack ID allocation/validation (pinned defect)',
    )

    // normalizeData spreads imported student objects and coerces only `frozen`,
    // so an arbitrary `id` survives into persistence.
    const normalizeLine = matchingLines(/function normalizeData\(/)
    assert.equal(normalizeLine.length, 1)
    const normalizeBody = contextAt(normalizeLine[0], 0, 18)
    assert.match(
      normalizeBody,
      /parsed\.students\.map\(student => \(\{ \.\.\.student, frozen: Boolean\(student\.frozen\) \}\)\)/,
      'normalizeData must still pass through student ids unvalidated (pinned defect)',
    )
  })

  it('source contract: plaintext pin still enters the roster object (pinned defect)', () => {
    // Section 4 requires PIN-free V2 writes. Commit 7 removes this; until then
    // the defect is pinned so the requirement cannot be quietly dropped.
    const allocator = matchingLines(/id:\s*maxId \+ 1/)[0]
    assert.match(
      contextAt(allocator, 2, 10),
      /^\s*pin,$/m,
      'addStudent must still be shown to place a plaintext pin on the roster object',
    )
  })

  it('source contract: both V2 data adapters are referenced by the client but never defined by it', () => {
    for (const adapter of [
      'V2_TENANT_DATA_ADAPTER',
      'V2_TENANT_DATA_SAVE_ADAPTER',
    ]) {
      const references = matchingLines(new RegExp(`window\\.${adapter}`))
      assert.ok(
        references.length > 0,
        `${adapter} must still be referenced by the client`,
      )
      // The client only ever reads these off `window`; it never assigns them.
      // `=(?!=)` is required: `typeof window.X === "function"` is a comparison,
      // not an assignment, and a bare `=` matcher would report a false positive.
      const assignments = matchingLines(
        new RegExp(`window\\.${adapter}\\s*=(?!=)`),
      )
      assert.equal(
        assignments.length,
        0,
        `${adapter} must not be defined by production client code`,
      )
    }

    // Precision matters: the adapters ARE defined, but only by the Item 10
    // browser harness, which activates solely under an explicit test flag.
    const harness = readFileSync(
      new URL('../../tests/browser/phase2b-browser-harness.js', import.meta.url),
      'utf8',
    )
    assert.match(harness, /window\.V2_TENANT_DATA_ADAPTER\s*=(?!=)/)
    assert.match(harness, /window\.V2_TENANT_DATA_SAVE_ADAPTER\s*=(?!=)/)
    assert.match(
      harness,
      /Activates ONLY under an explicit browser-test flag/,
      'the harness definitions must remain test-only, never a production adapter',
    )
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
