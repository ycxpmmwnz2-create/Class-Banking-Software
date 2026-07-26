// Phase 3 — release-order SOURCE contract (added Commit 1; expands per commit).
//
// EVIDENCE LAYER: static analysis of PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md
// plus filesystem/checksum facts. This suite proves the brief still *states* the
// safe ordering and that Commit 1 has not created later-commit artifacts. It
// does NOT execute a release, deploy anything, or prove production ordering.
// See tests/phase3/README.md.
//
// Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 2, 9, 11, 14.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const brief = readFileSync(
  new URL('../../PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md', import.meta.url),
  'utf8',
)

/** The Item 10 pin, extended into Phase 3. Commit 1 must not touch rules. */
const EXPECTED_RULES_SHA256 =
  '0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50'

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
  const beforeRollback = section.split('Rollback after scoped credentials exist')[0]
  const steps = parseNumberedSteps(beforeRollback)
  assert.ok(steps.length >= 19, `expected the full ordering list, got ${steps.length}`)
  return steps
}

function rollbackSteps() {
  const section = brief.split('Rollback after scoped credentials exist')[1]
  assert.ok(section, 'the rollback sequence must exist in the brief')
  const steps = parseNumberedSteps(section.split('\n## ')[0])
  assert.ok(steps.length >= 6, `expected the rollback list, got ${steps.length}`)
  return steps
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

describe('Phase 3 release-order source contract', () => {
  it('source contract: the existing foundation precedes bridge-rules deploy', () => {
    const steps = releaseOrderingSteps()
    const foundation = stepIndex(steps, /foundation/i, /validate|create/i)
    const bridge = stepIndex(steps, /bridge rules/i, /deploy/i)
    assert.ok(
      foundation < bridge,
      `foundation (step ${steps[foundation].number}) must precede bridge rules (step ${steps[bridge].number})`,
    )
  })

  it('source contract: bridge rules precede the first scoped credential write', () => {
    const steps = releaseOrderingSteps()
    const bridge = stepIndex(steps, /bridge rules/i, /deploy/i)
    // Anchored on "Run classroom migration and scoped credential/log copy".
    // A looser /copy|migration/ also matches the step-2 rehearsal line, which
    // would make this assertion pass for the wrong reason.
    const credentialCopy = stepIndex(steps, /scoped credential\/log copy/i)
    assert.ok(
      bridge < credentialCopy,
      'no scoped credential may be written while a recursive classrooms/** allow could be deployed',
    )
  })

  it('source contract: final rules precede gate enable, which precedes gate-on Hosting', () => {
    const steps = releaseOrderingSteps()
    const finalRules = stepIndex(steps, /final/i, /rules/i, /deploy/i)
    const gateEnable = stepIndex(steps, /enable/i, /gate/i)
    const hosting = stepIndex(steps, /hosting/i, /gate-on/i)
    assert.ok(finalRules < gateEnable, 'final rules must precede gate enable')
    assert.ok(gateEnable < hosting, 'gate enable must precede gate-on Hosting')
  })

  it('source contract: reconciliation precedes activation and any mismatch aborts', () => {
    const steps = releaseOrderingSteps()
    const reconcile = stepIndex(steps, /reconcile/i)
    const finalRules = stepIndex(steps, /final/i, /rules/i, /deploy/i)
    assert.ok(reconcile < finalRules, 'reconciliation must precede final rules')
    assert.match(
      steps[reconcile].text,
      /abort/i,
      'the reconciliation step must state that a mismatch aborts',
    )
  })

  it('source contract: rollback rolls Hosting back, disables the gate, then installs rollback-safe rules', () => {
    const steps = rollbackSteps()
    const hosting = stepIndex(steps, /hosting/i, /roll/i)
    const gateDisable = stepIndex(steps, /disable/i, /gate/i)
    const rollbackRules = stepIndex(steps, /rollback-safe rules/i)
    const resume = stepIndex(steps, /resume/i)
    assert.ok(hosting < gateDisable, 'Hosting default-off precedes gate disable')
    assert.ok(gateDisable < rollbackRules, 'gate disable precedes rollback-safe rules')
    assert.ok(
      rollbackRules < resume,
      'rollback-safe rules must be installed before legacy writes resume',
    )
  })

  it('source contract: the recursive classrooms/** baseline is never redeployed', () => {
    assert.match(
      brief,
      /Never redeploy the current recursive baseline rules while scoped credentials\s+exist\./,
      'the brief must retain the absolute prohibition on the recursive baseline rule',
    )
    assert.match(
      brief,
      /All three artifacts delete the recursive `classrooms\/\{document=\*\*\}` client/,
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
      /foundation precedes ownership-dependent bridge rules/i,
      /separate checksum-pinned and\s+independently tested artifacts/i,
      /separate entrypoints/i,
    ]) {
      assert.match(section, pattern)
    }
  })

  it('source contract: preflight, write, and reverify are separate entrypoints', () => {
    const section = brief.split('## 8. Production runner contract')[1].split('\n## ')[0]
    assert.match(section, /functions\/phase3\/preflight\.js/)
    assert.match(section, /functions\/phase3\/write\.js/)
    assert.match(section, /functions\/phase3\/reverify\.js/)
    assert.match(
      section,
      /no shared write subcommand, `--force`, production override/,
      'the brief must forbid a shared subcommand and override flags',
    )
  })

  // -------------------------------------------------------------------------
  // Commit 1 boundary. These assertions fail if a later commit's artifacts are
  // created early, which is the specific scope risk of a multi-commit plan.
  // -------------------------------------------------------------------------

  it('boundary: the three future rules artifacts are absent in Commit 1', () => {
    for (const file of [
      'firestore.phase3.bridge.rules',
      'firestore.phase3.final.rules',
      'firestore.phase3.rollback.rules',
    ]) {
      assert.equal(
        existsSync(new URL(`../../${file}`, import.meta.url)),
        false,
        `${file} belongs to Commit 9/10, not Commit 1`,
      )
    }
  })

  it('boundary: src/phase3 remains absent until its client commit', () => {
    // src/phase3 is Commit 7 (tenant data projection/service). functions/phase3
    // legitimately exists from Commit 2 onward, so it is scoped by content in
    // the next assertion rather than by absence.
    assert.equal(
      existsSync(new URL('../../src/phase3', import.meta.url)),
      false,
      'src/phase3 belongs to the client data commit',
    )
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
      'productionWriter.js', 'productionWriter.test.js',
      'productionReconciliation.js', 'productionReconciliation.test.js',
      'preflight.js', 'write.js', 'reverify.js',
      'studentLifecycle.js', 'studentLifecycle.test.js',
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

    // Commit 2 earns exactly the environment guard module and its test.
    // Everything else in Section 11's list belongs to Commits 3-6. Both the
    // implementation AND its test are pinned: listing only the .js files would
    // let a later commit's test file appear without its implementation, which is
    // the mirror image of the placeholder problem Section 12 forbids.
    // Commit 3 earned productionPreflight, productionManifest, and preflight.js.
    // Everything below still belongs to Commits 4-6. Both implementation and
    // test names stay pinned, so a later commit's test cannot appear without its
    // implementation either.
    const NOT_YET_EARNED = [
      'productionProjection.js', 'productionProjection.test.js',
      'productionWriter.js', 'productionWriter.test.js',
      'productionReconciliation.js', 'productionReconciliation.test.js',
      'write.js', 'reverify.js',
      'studentLifecycle.js', 'studentLifecycle.test.js',
    ]
    for (const name of NOT_YET_EARNED) {
      assert.ok(
        !actual.includes(name),
        `functions/phase3/${name} belongs to a later commit than the current one`,
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
      './write.js', './reverify.js', './productionWriter.js',
      './productionProjection.js', './productionReconciliation.js',
      './studentLifecycle.js',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `preflight.js must not import ${forbidden}`,
      )
    }

    // And the sibling entrypoints must still be absent entirely.
    for (const sibling of ['write.js', 'reverify.js']) {
      assert.equal(
        existsSync(new URL(`../../functions/phase3/${sibling}`, import.meta.url)),
        false,
        `${sibling} belongs to a later commit`,
      )
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

  it('invariant: the emulator readers preserve raw ID types and read every scoped surface', () => {
    // Two regressions this pins, both found in delta review of correction A:
    //
    // 1. The readers coerced every student ID with String(...), which hid the
    //    cross-source numeric/string equivalence the watermark must normalize —
    //    the live suite therefore did not exercise the claimed behavior.
    // 2. `scopedLogs` was hardcoded to 0 with no read at all, so preflight would
    //    report absence for a surface nobody examined.
    const source = readFileSync(
      new URL('./production-runner.emulator.test.js', import.meta.url),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

    assert.ok(
      !/String\(\s*(?:student\.id|entry\.studentId|doc\.data\(\)\.studentId)\s*\)/
        .test(code),
      'the emulator readers must preserve raw student-ID types, not stringify them',
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

  it('boundary: the brief still declares itself planning-only', () => {
    assert.match(
      brief,
      /Status: \*\*planning and review only\*\*/,
      'the brief must not silently become an authorization document',
    )
  })
})
