// Phase 3 Commit 1 — command-safety SOURCE contract.
//
// EVIDENCE LAYER: static analysis of package.json script text. This suite proves
// that the declared emulator commands *carry* the credential-isolation contract.
// It does NOT execute them, does not start an emulator, and therefore does not
// prove the isolation works at runtime — see tests/phase3/README.md.
//
// Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 12 and 14.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)
const scripts = packageJson.scripts ?? {}

/**
 * Every emulator-backed command that touches Firestore/Auth/Functions must
 * carry the full isolation contract. Phase 2B's commands already do; Commit 1
 * adds `test:migration` to the list. As later Phase 3 emulator commands land,
 * append their names here — that is the mechanism by which this contract
 * expands per Section 14.
 */
const ISOLATED_EMULATOR_COMMANDS = Object.freeze([
  'test:rules',
  'test:migration',
  'test:phase2b:server:gate-off',
  'test:phase2b:server:gate-on',
  'test:phase2b:rules',
  'test:phase2b:browser',
])

/**
 * Variables that must be scrubbed before the Firebase CLI or Admin SDK starts.
 * A leaked value in any of these can silently redirect a "local" run at a real
 * project or authenticate it with real credentials.
 */
const REQUIRED_SCRUBBED_VARIABLES = Object.freeze([
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
  it('source contract: every isolated emulator command is declared', () => {
    for (const name of ISOLATED_EMULATOR_COMMANDS) {
      assert.equal(
        typeof scripts[name],
        'string',
        `package.json must declare script ${name}`,
      )
      assert.ok(scripts[name].length > 0, `${name} must not be empty`)
    }
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

  it('source contract: the Phase 3 contracts command exists and needs no emulator', () => {
    const command = scripts['test:phase3:contracts']
    assert.equal(typeof command, 'string', 'test:phase3:contracts must exist')
    assert.match(command, /node --test/)
    assert.match(command, /tests\/phase3/)
    assert.ok(
      !/emulators:exec/.test(command),
      'the static contract suite must not start an emulator',
    )
  })

  /**
   * Section 12/14 forbid adding the five future behavioral gate names as
   * passing placeholders. Their absence is the assertion: a placeholder that
   * exits 0 would report green for work that does not exist.
   */
  it('source contract: future behavioral gate names are not yet declared', () => {
    for (const name of [
      'test:phase3:unit',
      'test:phase3:rules',
      'test:phase3:migration',
      'test:phase3:release-rehearsal',
      'test:phase3:rollback-rehearsal',
    ]) {
      assert.equal(
        scripts[name],
        undefined,
        `${name} must not exist until its behavioral suite does`,
      )
    }
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
  })

  it('source contract: this suite lives in the repository it inspects', () => {
    // Guards against a future refactor that points the contract at a copied
    // or vendored package.json instead of the live one.
    assert.equal(typeof REPO_ROOT, 'string')
    assert.ok(REPO_ROOT.endsWith('/'))
    assert.equal(packageJson.name, 'class-banking-software')
  })
})
