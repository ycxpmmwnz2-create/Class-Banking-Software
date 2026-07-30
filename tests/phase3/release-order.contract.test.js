// Phase 3 — release-order SOURCE contract (added Commit 1; expands per commit).
//
// EVIDENCE LAYER: static analysis of PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md
// plus filesystem/checksum facts. This suite proves the brief still *states* the
// safe ordering and that the completed boundary has exactly the expected
// artifacts. It does NOT execute a release, deploy anything, or prove
// production ordering.
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
const runbook = readFileSync(
  new URL('../../PHASE3_RELEASE_RUNBOOK.md', import.meta.url),
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
  '414ab5cad328b4b254fe4397ec891f0b7639548c324d2ae0ee74c8db0a9639f3'
const EXPECTED_ROLLBACK_RULES_SHA256 =
  'c81a058e260502fe31c4240d547dcd731f130eb85be3a3c185caae681e4ef19d'

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

function assertOrderedMarkers(source, markers, description) {
  let previous = -1
  for (const marker of markers) {
    const current = source.indexOf(marker, previous + 1)
    assert.ok(current > previous, `${description}: ${marker} must appear in order`)
    previous = current
  }
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

  it('source contract: inventory, preflight, write, and reverify are separate entrypoints', () => {
    const section = brief.split('## 8. Production runner contract')[1].split('\n## ')[0]
    assert.match(section, /functions\/phase3\/inventory\.js/)
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

  it('boundary: Boundary 11 runbook binds release and rollback to the reviewed order', () => {
    assert.match(runbook, /local rehearsal evidence only; not production authorization/i)
    assertOrderedMarkers(runbook, [
      'control-plane-only inventory',
      'inventory.js',
      'Independently corroborate',
      'preflight expectations',
      'preflight.js',
      'maintenance/write freeze',
      'teacher/classroom foundation',
      'first invocation',
      'bridge-rules hash',
      'Functions with the V2 gate off',
      'second time',
      'reverify.js',
      'final-rules hash',
      'MULTI_TEACHER_V2_RELEASE_ID',
      'gate-on Hosting artifact',
      'existing-teacher and existing-student acceptance',
      'End the write freeze',
      'rollback window',
    ], 'production release checklist')
    assertOrderedMarkers(runbook, [
      'Retain or re-enter and verify the write freeze',
      'Roll Hosting back',
      'Disable the V2 server gate',
      'rollback-safe rules',
      'Reconcile the untouched legacy aggregate',
      'legacy existing-teacher and existing-student acceptance',
      'Resume writes',
    ], 'production rollback checklist')
    assert.match(runbook, /Never\s+deploy the recursive `firestore\.rules` baseline/i)
    assert.match(runbook, /Never record credential contents, private keys, access\/refresh tokens, PINs/i)
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
      // The production-read safety correction: the operator-only reviewed
      // checkout proof, split out of productionEnvironment.js so the deployed
      // Functions graph carries no subprocess capability.
      'reviewedCheckout.js', 'reviewedCheckout.test.js',
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

  it('boundary: the brief still declares itself planning-only', () => {
    assert.match(
      brief,
      /Status: \*\*planning and review only\*\*/,
      'the brief must not silently become an authorization document',
    )
  })
})
