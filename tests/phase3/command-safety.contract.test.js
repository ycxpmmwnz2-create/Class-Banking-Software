// Phase 3 — command-safety SOURCE contract (added Commit 1; expands per commit).
//
// EVIDENCE LAYER: static analysis of package.json script text. This suite proves
// that every emulator-launching script *carries* the credential-isolation
// contract. The command set is DISCOVERED from the scripts themselves, so a new
// `firebase emulators:exec` script cannot escape these assertions by being
// omitted from a hand-maintained list. It does NOT execute the commands, does
// not start an emulator, and therefore does not prove the isolation works at
// runtime — see tests/phase3/README.md.
//
// Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 12 and 14.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)
const scripts = packageJson.scripts ?? {}

/** The marker that identifies a script as launching the Firebase emulators. */
const EMULATOR_LAUNCH_MARKER = 'firebase emulators:exec'

/**
 * Discovers every script that launches the Firebase emulators.
 *
 * DISCOVERY, NOT A MAINTAINED LIST. An earlier revision enumerated the command
 * names by hand, which meant a new `firebase emulators:exec` script silently
 * escaped every isolation assertion whenever its author forgot to append the
 * name. Deriving the set from the scripts themselves makes the contract apply
 * to future Phase 3 emulator commands automatically.
 *
 * Aggregators such as `test:phase2b:server`, which only chain other npm scripts
 * and contain no emulator invocation of their own, are correctly skipped: the
 * commands they delegate to are discovered and checked individually.
 */
function discoverIsolatedEmulatorCommands(allScripts) {
  return Object.freeze(
    Object.entries(allScripts)
      .filter(([, script]) => script.includes(EMULATOR_LAUNCH_MARKER))
      .map(([name]) => name)
      .sort(),
  )
}

const ISOLATED_EMULATOR_COMMANDS = discoverIsolatedEmulatorCommands(scripts)

/**
 * Variables that must be scrubbed before the Firebase CLI or Admin SDK starts.
 * A leaked value in any of these can silently redirect a "local" run at a real
 * project or authenticate it with real credentials.
 */
const REQUIRED_SCRUBBED_VARIABLES = Object.freeze([
  // Boundary 11's runner and browser harness use this selector to opt into
  // release-only behavior. Every emulator command clears an inherited value so
  // one named gate cannot silently impersonate another.
  'PHASE3_REHEARSAL_MODE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'google_application_credentials',
  'FIREBASE_TOKEN',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'FIREBASE_CONFIG',
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FUNCTIONS_EMULATOR',
  'MULTI_TEACHER_V2_ENABLED',
  // Added in Commit 2 alongside the production release gate. A leaked release
  // identifier could satisfy the production branch of the V2 gate during what
  // was meant to be a local run, so it belongs beside MULTI_TEACHER_V2_ENABLED.
  'MULTI_TEACHER_V2_RELEASE_ID',
])

// ---------------------------------------------------------------------------
// Matchers. Each is a pure predicate over script text so the same logic can be
// applied to the real scripts and to the negative-control fixtures below.
// ---------------------------------------------------------------------------

function refusesLocalAdc(script) {
  return /application_default_credentials\.json/.test(script) &&
    /\btest\s+!\s+-f\b/.test(script) &&
    /exit 1/.test(script)
}

function usesTemporaryCliConfig(script) {
  return /mktemp -d/.test(script) && /XDG_CONFIG_HOME=/.test(script)
}

function scrubsVariable(script, variable) {
  return new RegExp(`-u\\s+${variable}(?![A-Za-z0-9_])`).test(script)
}

function disablesMetadataServer(script) {
  return /METADATA_SERVER_DETECTION=none/.test(script)
}

/** Returns every `--project <value>` argument in the script. */
function projectArguments(script) {
  return [...script.matchAll(/--project\s+([^\s"']+)/g)].map(match => match[1])
}

function hasDeployMarker(script) {
  return /\bfirebase\s+deploy\b/.test(script) || /--only\s+hosting\b/.test(script)
}

function hasForceMarker(script) {
  return /--force\b/.test(script)
}

function hasProductionProjectMarker(script) {
  return projectArguments(script).some(value => value === 'morgan-bank')
}

/**
 * Any host:port pair in the script must be loopback. A non-loopback host would
 * point the Admin SDK at something other than the local emulator.
 */
function hasNonLoopbackHostMarker(script) {
  const hostPorts = [...script.matchAll(/([A-Za-z0-9.[\]:-]+):(\d{2,5})\b/g)]
  return hostPorts.some(([, host]) => {
    if (/^\d{2,5}$/.test(host)) return false
    return host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]'
  })
}

describe('Phase 3 command-safety source contract', () => {
  it('source contract: emulator commands are discovered automatically and the set is nonempty', () => {
    assert.ok(
      ISOLATED_EMULATOR_COMMANDS.length > 0,
      'discovery must find at least one emulator command; an empty set would ' +
        'make every isolation assertion below pass vacuously',
    )

    // test:migration is the command Commit 1 brought under this contract, so its
    // presence proves discovery reaches the intended target rather than only the
    // Phase 2B commands that were already hardened.
    assert.ok(
      ISOLATED_EMULATOR_COMMANDS.includes('test:migration'),
      `discovery must include test:migration; found ${ISOLATED_EMULATOR_COMMANDS.join(', ')}`,
    )

    for (const name of ISOLATED_EMULATOR_COMMANDS) {
      assert.equal(typeof scripts[name], 'string')
      assert.ok(scripts[name].length > 0, `${name} must not be empty`)
    }
  })

  it('source contract: discovery covers every script that launches the emulators', () => {
    // The complement check: no script may contain the emulator launch marker
    // while being absent from the discovered set. This is what makes the
    // contract self-expanding rather than dependent on a maintained list.
    const undiscovered = Object.entries(scripts)
      .filter(([name, script]) =>
        script.includes(EMULATOR_LAUNCH_MARKER) &&
        !ISOLATED_EMULATOR_COMMANDS.includes(name))
      .map(([name]) => name)

    assert.deepEqual(
      undiscovered,
      [],
      `these scripts launch emulators but escaped discovery: ${undiscovered.join(', ')}`,
    )
  })

  it('source contract: each isolated command refuses local Google ADC', () => {
    for (const name of ISOLATED_EMULATOR_COMMANDS) {
      assert.ok(
        refusesLocalAdc(scripts[name]),
        `${name} must refuse to run when local Google ADC exists`,
      )
    }
  })

  it('source contract: each isolated command uses a temporary Firebase CLI config', () => {
    for (const name of ISOLATED_EMULATOR_COMMANDS) {
      assert.ok(
        usesTemporaryCliConfig(scripts[name]),
        `${name} must create a temp dir and set XDG_CONFIG_HOME`,
      )
    }
  })

  it('source contract: each isolated command scrubs every credential/project/gate variable', () => {
    for (const name of ISOLATED_EMULATOR_COMMANDS) {
      for (const variable of REQUIRED_SCRUBBED_VARIABLES) {
        assert.ok(
          scrubsVariable(scripts[name], variable),
          `${name} must unset ${variable} before starting`,
        )
      }
    }
  })

  it('source contract: each isolated command disables metadata-server detection', () => {
    for (const name of ISOLATED_EMULATOR_COMMANDS) {
      assert.ok(
        disablesMetadataServer(scripts[name]),
        `${name} must set METADATA_SERVER_DETECTION=none`,
      )
    }
  })

  it('source contract: every --project argument names a demo- emulator project', () => {
    for (const name of ISOLATED_EMULATOR_COMMANDS) {
      const projects = projectArguments(scripts[name])
      assert.ok(projects.length > 0, `${name} must pass an explicit --project`)
      for (const project of projects) {
        assert.ok(
          project.startsWith('demo-'),
          `${name} must target a demo- project; found ${project}`,
        )
      }
    }
  })

  it('source contract: no script carries deploy, --force, production-project, or non-loopback markers', () => {
    for (const [name, script] of Object.entries(scripts)) {
      assert.ok(!hasDeployMarker(script), `${name} must not deploy`)
      assert.ok(!hasForceMarker(script), `${name} must not pass --force`)
      assert.ok(
        !hasProductionProjectMarker(script),
        `${name} must not target production project morgan-bank`,
      )
      assert.ok(
        !hasNonLoopbackHostMarker(script),
        `${name} must not reference a non-loopback host`,
      )
    }
  })

  /**
   * Couples the guard's project-routing list to the emulator isolation list.
   *
   * These two lists are related by intent, not by derivation: any variable the
   * production guard treats as project-routing can also redirect a "local"
   * emulator run at a real project, so it must be scrubbed. Without this
   * assertion a future commit could add a routing variable to the guard and
   * forget the scrub — the exact drift that let GOOGLE_CLOUD_PROJECT be ignored
   * by the guard while already being scrubbed here.
   */
  it('source contract: every project-routing variable the guard knows is also scrubbed', async () => {
    const { PROJECT_ROUTING_VARIABLES } = await import(
      '../../functions/phase3/productionEnvironment.js'
    )

    assert.ok(
      Array.isArray(PROJECT_ROUTING_VARIABLES) && PROJECT_ROUTING_VARIABLES.length > 0,
      'the guard must export a nonempty project-routing list',
    )

    for (const variable of PROJECT_ROUTING_VARIABLES) {
      assert.ok(
        REQUIRED_SCRUBBED_VARIABLES.includes(variable),
        `${variable} routes a project in the guard and must also be scrubbed by ` +
          'every emulator command',
      )
    }

    // FIREBASE_CONFIG carries projectId, so it is a routing source too even
    // though it is not a bare project variable.
    assert.ok(
      REQUIRED_SCRUBBED_VARIABLES.includes('FIREBASE_CONFIG'),
      'FIREBASE_CONFIG carries projectId and must be scrubbed',
    )

    // And the scrub must actually be present in every discovered command, not
    // merely listed in the contract.
    for (const name of ISOLATED_EMULATOR_COMMANDS) {
      for (const variable of [...PROJECT_ROUTING_VARIABLES, 'FIREBASE_CONFIG']) {
        assert.ok(
          scrubsVariable(scripts[name], variable),
          `${name} must unset the routing variable ${variable}`,
        )
      }
    }
  })

  it('source contract: the Phase 3 contracts command exists and needs no emulator', () => {
    const command = scripts['test:phase3:contracts']
    assert.equal(typeof command, 'string', 'test:phase3:contracts must exist')
    assert.match(command, /node --test/)
    assert.match(command, /tests\/phase3/)
    assert.ok(
      !/emulators:exec/.test(command),
      'the static contract suite must not start an emulator',
    )

    // The glob must be narrowed to *.contract.test.js. A broader
    // `tests/phase3/*.test.js` would also select the emulator-backed runner
    // suite and execute it with no emulator running — a green-looking run that
    // proved nothing, or a confusing hard failure.
    assert.match(
      command,
      /\*\.contract\.test\.js/,
      'the contracts glob must select only *.contract.test.js',
    )

    // Structural proof the narrowing matters: emulator-backed suites exist in
    // this directory and must not match the contracts glob.
    const emulatorSuites = readdirSync(
      new URL('../../tests/phase3/', import.meta.url),
    ).filter(name => name.endsWith('.emulator.test.js'))
    assert.ok(
      emulatorSuites.length > 0,
      'this assertion is only meaningful while an emulator suite exists here',
    )
    for (const suite of emulatorSuites) {
      assert.ok(
        !suite.endsWith('.contract.test.js'),
        `${suite} must not be selected by the emulator-free contracts glob`,
      )
    }
  })

  /**
   * Section 12 forbids adding a behavioral gate name before the suite it
   * executes exists. A gate is therefore permitted only once its suite is
   * present, and each entry below records which commit earned it.
   *
   * `test:phase3:unit` was added in Commit 2 alongside the colocated
   * `functions/phase3/*.test.js` guard suite it genuinely runs. Item 9 earns
   * `test:phase3:rules` alongside its bridge-rules emulator suite, and Item 10
   * extends that gate with the final and rollback-safe suites. Boundary 11 earns
   * both rehearsal gates alongside the behavioral suites they execute.
   */
  it('source contract: no behavioral gate exists without the suite it runs', () => {
    const releaseGate = scripts['test:phase3:release-rehearsal']
    assert.equal(typeof releaseGate, 'string')
    assert.equal(
      releaseGate,
      'npm run test:phase3:release-rehearsal:runner && npm run test:phase3:release-rehearsal:browser',
    )
    const releaseRunner = scripts['test:phase3:release-rehearsal:runner']
    const releaseBrowser = scripts['test:phase3:release-rehearsal:browser']
    assert.match(releaseRunner, /production-runner\.emulator\.test\.js/)
    assert.match(releaseBrowser, /playwright test/)
    assert.match(releaseRunner, /PHASE3_REHEARSAL_MODE=release/)
    assert.match(releaseBrowser, /PHASE3_REHEARSAL_MODE=release/)

    const rollbackGate = scripts['test:phase3:rollback-rehearsal']
    assert.equal(typeof rollbackGate, 'string')
    assert.match(rollbackGate, /rollback-rehearsal\.test\.js/)
    assert.match(rollbackGate, /PHASE3_REHEARSAL_MODE=rollback/)
    assert.ok(existsSync(new URL('./rollback-rehearsal.test.js', import.meta.url)))

    for (const name of [
      'test:phase3:release-rehearsal:runner',
      'test:phase3:release-rehearsal:browser',
      'test:phase3:rollback-rehearsal',
    ]) {
      assert.ok(ISOLATED_EMULATOR_COMMANDS.includes(name))
      assert.ok(
        scrubsVariable(scripts[name], 'PHASE3_REHEARSAL_MODE'),
        `${name} must scrub an inherited rehearsal selector before setting its own`,
      )
    }

    assert.ok(
      scrubsVariable(scripts['test:phase2b:browser'], 'PHASE3_REHEARSAL_MODE'),
      'the historical browser gate must scrub the final-rules rehearsal selector',
    )

    // test:phase3:migration was earned in Commit 3 alongside the real
    // production-runner emulator suite. It must name the suite it runs, and that
    // suite must exist on disk.
    const migrationGate = scripts['test:phase3:migration']
    assert.equal(
      typeof migrationGate,
      'string',
      'test:phase3:migration must exist in Commit 3',
    )
    assert.match(migrationGate, /production-runner\.emulator\.test\.js/)
    assert.ok(
      existsSync(new URL(
        '../../tests/phase3/production-runner.emulator.test.js',
        import.meta.url,
      )),
      'the emulator gate must have its suite present',
    )
    // It starts emulators, so discovery must have picked it up and applied the
    // full isolation contract without a special case.
    assert.ok(
      ISOLATED_EMULATOR_COMMANDS.includes('test:phase3:migration'),
      'the Phase 3 emulator gate must be covered by automatic discovery',
    )

    // test:phase3:rules is earned in Item 9 and extended in Item 10. It must
    // select every independently deployable rules suite, and automatic discovery
    // must apply the complete credential-isolation contract to the gate.
    const rulesGate = scripts['test:phase3:rules']
    assert.equal(
      typeof rulesGate,
      'string',
      'test:phase3:rules must exist from Item 9 onward',
    )
    for (const suite of [
      'rules.phase3.bridge.test.js',
      'rules.phase3.final.test.js',
      'rules.phase3.rollback.test.js',
    ]) {
      assert.match(rulesGate, new RegExp(suite.replaceAll('.', '\\.')))
      assert.ok(
        existsSync(new URL(`../../tests/firestore/${suite}`, import.meta.url)),
        `the Phase 3 rules gate must have ${suite} present`,
      )
    }
    assert.ok(
      ISOLATED_EMULATOR_COMMANDS.includes('test:phase3:rules'),
      'the Phase 3 rules gate must be covered by automatic discovery',
    )

    // test:phase3:unit must exist AND must actually execute the colocated
    // Phase 3 unit suites, so the gate name cannot drift away from its suite.
    const unitGate = scripts['test:phase3:unit']
    assert.equal(typeof unitGate, 'string', 'test:phase3:unit must exist in Commit 2')
    assert.match(unitGate, /node --test/)
    assert.match(unitGate, /functions\/phase3/)

    // Section 12 as amended: this gate is emulator-free and therefore needs no
    // isolation wrapper. It must not start the Firebase CLI or an emulator.
    assert.ok(
      !/emulators:exec/.test(unitGate),
      'the Phase 3 unit gate must not start an emulator',
    )
    assert.ok(
      !/\bfirebase\b/.test(unitGate),
      'the Phase 3 unit gate must not invoke the Firebase CLI',
    )

    const suiteFiles = readdirSync(new URL('../../functions/phase3/', import.meta.url))
      .filter(name => name.endsWith('.test.js'))
    assert.ok(
      suiteFiles.length > 0,
      'test:phase3:unit must have at least one colocated suite to execute',
    )
  })

  // -------------------------------------------------------------------------
  // Negative controls. These prove the matchers above have teeth: each fixture
  // omits exactly one protection and must be rejected by the matcher that
  // guards it. Without these, a matcher that silently always returned true
  // would let the whole suite pass vacuously.
  // -------------------------------------------------------------------------

  describe('negative controls prove the matchers reject violations', () => {
    const HARDENED_FIXTURE = [
      'sh -c \'test ! -f "$HOME/.config/gcloud/application_default_credentials.json"',
      '|| { echo refuse >&2; exit 1; };',
      'cfg=$(mktemp -d /tmp/x.XXXXXX) || exit 1;',
      `env ${REQUIRED_SCRUBBED_VARIABLES.map(v => `-u ${v}`).join(' ')}`,
      'XDG_CONFIG_HOME="$cfg" METADATA_SERVER_DETECTION=none',
      'firebase emulators:exec --project demo-x --only firestore "node --test t.js"\'',
    ].join(' ')

    it('the hardened fixture satisfies every matcher', () => {
      assert.ok(refusesLocalAdc(HARDENED_FIXTURE))
      assert.ok(usesTemporaryCliConfig(HARDENED_FIXTURE))
      assert.ok(disablesMetadataServer(HARDENED_FIXTURE))
      for (const variable of REQUIRED_SCRUBBED_VARIABLES) {
        assert.ok(scrubsVariable(HARDENED_FIXTURE, variable))
      }
      assert.ok(projectArguments(HARDENED_FIXTURE).every(p => p.startsWith('demo-')))
      assert.ok(!hasDeployMarker(HARDENED_FIXTURE))
      assert.ok(!hasForceMarker(HARDENED_FIXTURE))
      assert.ok(!hasProductionProjectMarker(HARDENED_FIXTURE))
      assert.ok(!hasNonLoopbackHostMarker(HARDENED_FIXTURE))
    })

    it('rejects a fixture missing the ADC guard', () => {
      const fixture = HARDENED_FIXTURE.replace(
        /test ! -f "\$HOME\/\.config\/gcloud\/application_default_credentials\.json"\s*\|\| \{ echo refuse >&2; exit 1; \};/,
        '',
      )
      assert.ok(!refusesLocalAdc(fixture))
    })

    it('rejects a fixture missing the temporary CLI config', () => {
      const fixture = HARDENED_FIXTURE
        .replace('cfg=$(mktemp -d /tmp/x.XXXXXX) || exit 1;', '')
        .replace('XDG_CONFIG_HOME="$cfg" ', '')
      assert.ok(!usesTemporaryCliConfig(fixture))
    })

    it('rejects a fixture missing metadata-server suppression', () => {
      const fixture = HARDENED_FIXTURE.replace('METADATA_SERVER_DETECTION=none', '')
      assert.ok(!disablesMetadataServer(fixture))
    })

    it('rejects a fixture that fails to scrub each required variable', () => {
      for (const variable of REQUIRED_SCRUBBED_VARIABLES) {
        const fixture = HARDENED_FIXTURE.replace(`-u ${variable}`, '')
        assert.ok(
          !scrubsVariable(fixture, variable),
          `matcher must reject a fixture that leaves ${variable} unscrubbed`,
        )
      }
    })

    it('rejects a non-demo project, including the real production project', () => {
      const nonDemo = HARDENED_FIXTURE.replace('--project demo-x', '--project morgan-bank-migration-rehearsal')
      assert.ok(!projectArguments(nonDemo).every(p => p.startsWith('demo-')))

      const production = HARDENED_FIXTURE.replace('--project demo-x', '--project morgan-bank')
      assert.ok(hasProductionProjectMarker(production))
    })

    it('rejects deploy, --force, and non-loopback host markers', () => {
      assert.ok(hasDeployMarker('firebase deploy --only hosting'))
      assert.ok(hasForceMarker('node run.js --force'))
      assert.ok(hasNonLoopbackHostMarker('FIRESTORE_EMULATOR_HOST=10.0.0.5:8080'))
      assert.ok(!hasNonLoopbackHostMarker('FIRESTORE_EMULATOR_HOST=127.0.0.1:8080'))
    })

    /**
     * Discovery-level negative control.
     *
     * Simulates the exact regression the manual list allowed: a NEW script that
     * launches the emulators but carries none of the protections. It must be
     * discovered (so it cannot escape the contract) and then rejected by the
     * isolation matchers. This is the assertion that proves automatic discovery
     * closes the escape rather than merely reorganizing the old list.
     */
    it('discovers and rejects a new emulator command that lacks the protections', () => {
      const unprotected =
        'firebase emulators:exec --project morgan-bank --only firestore "node --test new.js"'
      const withNewCommand = {
        ...scripts,
        'test:phase3:future-unprotected': unprotected,
      }

      const discovered = discoverIsolatedEmulatorCommands(withNewCommand)
      assert.ok(
        discovered.includes('test:phase3:future-unprotected'),
        'a new emulators:exec script must be discovered automatically',
      )
      assert.equal(
        discovered.length,
        ISOLATED_EMULATOR_COMMANDS.length + 1,
        'discovery must grow by exactly the added command',
      )

      // Every protection the real commands satisfy must fail for this one.
      assert.ok(!refusesLocalAdc(unprotected), 'must fail the ADC guard')
      assert.ok(!usesTemporaryCliConfig(unprotected), 'must fail the temp CLI config check')
      assert.ok(!disablesMetadataServer(unprotected), 'must fail metadata suppression')
      for (const variable of REQUIRED_SCRUBBED_VARIABLES) {
        assert.ok(
          !scrubsVariable(unprotected, variable),
          `must fail to scrub ${variable}`,
        )
      }
      assert.ok(
        !projectArguments(unprotected).every(project => project.startsWith('demo-')),
        'must fail the demo- project requirement',
      )
      assert.ok(hasProductionProjectMarker(unprotected), 'must trip the production-project marker')
    })

    /**
     * The inverse control: a new emulator command that IS hardened must be
     * discovered and must satisfy every matcher. Without this, the control above
     * could pass because the matchers reject everything indiscriminately.
     */
    it('discovers and accepts a new emulator command that carries the protections', () => {
      const withNewCommand = {
        ...scripts,
        'test:phase3:future-hardened': HARDENED_FIXTURE,
      }

      const discovered = discoverIsolatedEmulatorCommands(withNewCommand)
      assert.ok(discovered.includes('test:phase3:future-hardened'))

      assert.ok(refusesLocalAdc(HARDENED_FIXTURE))
      assert.ok(usesTemporaryCliConfig(HARDENED_FIXTURE))
      assert.ok(disablesMetadataServer(HARDENED_FIXTURE))
      for (const variable of REQUIRED_SCRUBBED_VARIABLES) {
        assert.ok(scrubsVariable(HARDENED_FIXTURE, variable))
      }
      assert.ok(projectArguments(HARDENED_FIXTURE).every(project => project.startsWith('demo-')))
      assert.ok(!hasProductionProjectMarker(HARDENED_FIXTURE))
    })

    /**
     * Targeted control for the newest scrub. A command can satisfy every other
     * protection and still leak the production release identifier, which would
     * let the V2 gate's production branch be satisfied during what was meant to
     * be a local run. Removing only this one `-u` must fail.
     */
    it('rejects an emulator command that omits only the release-ID scrub', () => {
      const missingReleaseScrub = HARDENED_FIXTURE.replace(
        '-u MULTI_TEACHER_V2_RELEASE_ID',
        '',
      )

      // Everything else still passes, isolating the single omission.
      assert.ok(refusesLocalAdc(missingReleaseScrub))
      assert.ok(usesTemporaryCliConfig(missingReleaseScrub))
      assert.ok(disablesMetadataServer(missingReleaseScrub))
      assert.ok(scrubsVariable(missingReleaseScrub, 'MULTI_TEACHER_V2_ENABLED'))
      assert.ok(projectArguments(missingReleaseScrub).every(p => p.startsWith('demo-')))

      // The release-ID scrub specifically is absent.
      assert.ok(
        !scrubsVariable(missingReleaseScrub, 'MULTI_TEACHER_V2_RELEASE_ID'),
        'the matcher must reject a command that leaves MULTI_TEACHER_V2_RELEASE_ID set',
      )

      // And the scrub list must actually contain it, or the loop above would
      // never check it for the real commands.
      assert.ok(
        REQUIRED_SCRUBBED_VARIABLES.includes('MULTI_TEACHER_V2_RELEASE_ID'),
        'MULTI_TEACHER_V2_RELEASE_ID must be part of the scrub contract',
      )
    })

    it('skips aggregator scripts that chain npm commands without launching emulators', () => {
      const discovered = discoverIsolatedEmulatorCommands({
        ...scripts,
        'test:phase3:aggregator': 'npm run test:migration && npm run test:rules',
      })
      assert.ok(
        !discovered.includes('test:phase3:aggregator'),
        'an aggregator has no emulator invocation of its own to isolate',
      )
    })
  })

  it('source contract: this suite lives in the repository it inspects', () => {
    // Guards against a future refactor that points the contract at a copied
    // or vendored package.json instead of the live one.
    assert.equal(typeof REPO_ROOT, 'string')
    assert.ok(REPO_ROOT.endsWith('/'))
    assert.equal(packageJson.name, 'class-banking-software')
  })
})
