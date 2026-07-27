// Phase 3 Commit 2 — production environment/project/authorization guard tests.
//
// EVIDENCE LAYER: behavioral unit tests. Every case invokes the real guard
// functions with a constructed environment and asserts the actual outcome and
// error category. No emulator, no network, no Firestore, no process.env
// mutation — environments are injected, which is why the negative cases can be
// exhaustive without contaminating the test runner.
//
// These tests prove the guards' decisions. They do NOT prove that the future
// runner calls them, that production state is as assumed, or that a release
// executes correctly.

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { describe, it } from 'node:test'
import { URL } from 'node:url'

import {
  ALLOWED_EMULATOR_PROJECT_ID,
  ALLOWED_PRODUCTION_PROJECT_ID,
  EMULATOR_FLAG_VARIABLES,
  EMULATOR_HOST_VARIABLES,
  EXECUTION_CONTEXT,
  PRODUCTION_ENVIRONMENT_CATEGORIES,
  PROHIBITED_AUTHORIZATION_KEYS,
  ProductionEnvironmentError,
  REQUIRED_WRITE_AUTHORIZATION_FIELDS,
  WRITE_AUTHORIZATION_UNPROVEN_IDENTIFIERS,
  assertServiceAccountArtifact,
  assertV2GateAllowed,
  classifyAllowedProject,
  isLoopbackHostPort,
  redactEnvironmentError,
  resolveRuntimeProjectId,
  parseJsonArtifact,
  readHashedArtifact,
  validateExecutionEnvironment,
  validateExplicitCredential,
  validateRehearsalWriteAuthorization,
  validateWriteAuthorization,
} from './productionEnvironment.js'

const RELEASE_ID = 'phase3-rel-2026-07-26a'

/** A minimal, valid production environment. */
function productionEnvironment(overrides = {}) {
  return { GCLOUD_PROJECT: ALLOWED_PRODUCTION_PROJECT_ID, ...overrides }
}

/** A minimal, valid emulator environment. */
function emulatorEnvironment(overrides = {}) {
  return {
    GCLOUD_PROJECT: ALLOWED_EMULATOR_PROJECT_ID,
    FUNCTIONS_EMULATOR: 'true',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    ...overrides,
  }
}

/**
 * A complete, valid write authorization.
 *
 * Commit 5 widened this contract: the project, teacher, change, both expectation
 * digests, and a strict validity window are now required, and the manifest ID is
 * a real content address rather than a loose identifier.
 */
function writeAuthorization(overrides = {}) {
  return {
    projectId: 'morgan-bank',
    teacherUid: 'YkYUzIzy0aW7roolM1VaLcIJPuN2',
    releaseId: RELEASE_ID,
    changeId: 'CHG-2026-07-26-001',
    authorizationId: 'AUTH-2026-07-26-001',
    snapshotId: 'snap-20260726T1200Z',
    writeFreezeProof: 'freeze-20260726T1155Z',
    credentialProvenance: 'operator-workstation-adc-rotated',
    preflightManifestId: 'a'.repeat(64),
    initializationExpectationsSha256: 'b'.repeat(64),
    copyExpectationsSha256: 'c'.repeat(64),
    notBefore: '2026-07-26T17:00:00.000Z',
    notAfter: '2026-07-26T23:00:00.000Z',
    ...overrides,
  }
}

/** A current instant inside the fixture's validity window. */
const WRITE_NOW_MILLIS = Date.parse('2026-07-26T18:00:00.000Z')

/** Asserts a call throws a guard error of an exact category. */
function assertRejects(fn, category, message) {
  assert.throws(fn, error => {
    assert.ok(
      error instanceof ProductionEnvironmentError,
      `${message}: expected ProductionEnvironmentError, got ${error?.name}`,
    )
    assert.equal(error.category, category, message)
    assert.equal(error.blocking, true)
    return true
  }, message)
}

describe('Phase 3 production environment guards', () => {
  describe('module loading is nonfatal', () => {
    it('importing the module never throws, whatever the ambient environment', async () => {
      // Section 6: module loading must not crash Functions discovery or take the
      // legacy exports down. A fresh import with a deliberately hostile ambient
      // environment must still resolve.
      const originalGcloud = process.env.GCLOUD_PROJECT
      const originalEnabled = process.env.MULTI_TEACHER_V2_ENABLED
      try {
        process.env.GCLOUD_PROJECT = 'some-unapproved-project'
        process.env.MULTI_TEACHER_V2_ENABLED = 'true'
        const fresh = await import(
          `./productionEnvironment.js?nonfatal=${Date.now()}`
        )
        assert.equal(typeof fresh.validateExecutionEnvironment, 'function')
      } finally {
        if (originalGcloud === undefined) delete process.env.GCLOUD_PROJECT
        else process.env.GCLOUD_PROJECT = originalGcloud
        if (originalEnabled === undefined) delete process.env.MULTI_TEACHER_V2_ENABLED
        else process.env.MULTI_TEACHER_V2_ENABLED = originalEnabled
      }
    })
  })

  describe('loopback host validation', () => {
    it('accepts only loopback hosts with a valid port', () => {
      for (const value of [
        '127.0.0.1:8080',
        'localhost:9099',
        '[::1]:5001',
        '127.0.0.1:1',
        '127.0.0.1:65535',
      ]) {
        assert.equal(isLoopbackHostPort(value), true, `should accept ${value}`)
      }
    })

    it('rejects non-loopback, malformed, and out-of-range hosts', () => {
      for (const value of [
        '10.0.0.5:8080',
        'firestore.googleapis.com:443',
        'evil.example.com:8080',
        '127.0.0.1',
        '127.0.0.1:',
        ':8080',
        '127.0.0.1:0',
        '127.0.0.1:65536',
        '127.0.0.1:abc',
        ' 127.0.0.1:8080',
        '127.0.0.1:8080 ',
        'http://127.0.0.1:8080',
        '',
        undefined,
        null,
        8080,
      ]) {
        assert.equal(
          isLoopbackHostPort(value),
          false,
          `should reject ${String(value)}`,
        )
      }
    })
  })

  describe('runtime project resolution', () => {
    it('resolves from each routing source alone', () => {
      // Every source is load-bearing. GOOGLE_CLOUD_PROJECT is included because
      // the repository's isolation contract already treats it as project-routing;
      // ignoring it here would let a contradictory value pass while another SDK
      // layer honored it.
      assert.equal(
        resolveRuntimeProjectId({ GCLOUD_PROJECT: 'morgan-bank' }),
        'morgan-bank',
      )
      assert.equal(
        resolveRuntimeProjectId({ GOOGLE_CLOUD_PROJECT: 'morgan-bank' }),
        'morgan-bank',
      )
      assert.equal(
        resolveRuntimeProjectId({
          FIREBASE_CONFIG: JSON.stringify({ projectId: 'morgan-bank' }),
        }),
        'morgan-bank',
      )
    })

    it('accepts all three sources when they agree exactly', () => {
      assert.equal(
        resolveRuntimeProjectId({
          GCLOUD_PROJECT: 'morgan-bank',
          GOOGLE_CLOUD_PROJECT: 'morgan-bank',
          FIREBASE_CONFIG: JSON.stringify({ projectId: 'morgan-bank' }),
        }),
        'morgan-bank',
      )
    })

    it('rejects every pairwise disagreement, including a dissenting third source', () => {
      const conflicts = [
        {
          label: 'GCLOUD_PROJECT vs GOOGLE_CLOUD_PROJECT',
          environment: {
            GCLOUD_PROJECT: 'morgan-bank',
            GOOGLE_CLOUD_PROJECT: ALLOWED_EMULATOR_PROJECT_ID,
          },
        },
        {
          label: 'GCLOUD_PROJECT vs FIREBASE_CONFIG',
          environment: {
            GCLOUD_PROJECT: 'morgan-bank',
            FIREBASE_CONFIG: JSON.stringify({ projectId: ALLOWED_EMULATOR_PROJECT_ID }),
          },
        },
        {
          label: 'GOOGLE_CLOUD_PROJECT vs FIREBASE_CONFIG',
          environment: {
            GOOGLE_CLOUD_PROJECT: 'morgan-bank',
            FIREBASE_CONFIG: JSON.stringify({ projectId: ALLOWED_EMULATOR_PROJECT_ID }),
          },
        },
        {
          label: 'two agree, third dissents',
          environment: {
            GCLOUD_PROJECT: 'morgan-bank',
            GOOGLE_CLOUD_PROJECT: 'morgan-bank',
            FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-something-else' }),
          },
        },
      ]

      for (const { label, environment } of conflicts) {
        assertRejects(
          () => resolveRuntimeProjectId(environment),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `${label} must block`,
        )
        // The same conflict must block the full guard, not only the resolver.
        assertRejects(
          () => validateExecutionEnvironment(environment),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `${label} must block validateExecutionEnvironment`,
        )
      }
    })

    it('rejects a padded value from every source instead of trimming it', () => {
      // Trimming would accept " morgan-bank" as production despite the exact
      // string requirement. Padding is evidence of a misconfigured caller.
      const padded = [
        { GCLOUD_PROJECT: ' morgan-bank' },
        { GCLOUD_PROJECT: 'morgan-bank ' },
        { GCLOUD_PROJECT: '\tmorgan-bank' },
        { GOOGLE_CLOUD_PROJECT: ' morgan-bank' },
        { GOOGLE_CLOUD_PROJECT: 'morgan-bank\n' },
        { FIREBASE_CONFIG: JSON.stringify({ projectId: ' morgan-bank' }) },
        { FIREBASE_CONFIG: JSON.stringify({ projectId: 'morgan-bank ' }) },
      ]
      for (const environment of padded) {
        assertRejects(
          () => resolveRuntimeProjectId(environment),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `padded ${JSON.stringify(environment)} must block`,
        )
        assertRejects(
          () => validateExecutionEnvironment(environment),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `padded ${JSON.stringify(environment)} must block the full guard`,
        )
      }
    })

    it('rejects a non-string routing value', () => {
      // `[]` is included here rather than treated as absent: a present variable
      // holding a non-string is a misconfiguration regardless of how it
      // stringifies.
      for (const value of [42, true, {}, [], ['morgan-bank']]) {
        assertRejects(
          () => resolveRuntimeProjectId({ GCLOUD_PROJECT: value }),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `non-string ${JSON.stringify(value)} must block`,
        )
      }
    })

    it('distinguishes an absent source from a present but blank one', () => {
      // Absence is the ONLY reason a source may be ignored. A variable that is
      // set-but-empty means something tried to configure it and failed, and that
      // failure must surface even when another source is valid — otherwise the
      // malformed source silently disappears behind the good one.
      const malformedSecondary = [
        { label: 'empty string', value: '' },
        { label: 'whitespace only', value: '   ' },
        { label: 'tab only', value: '\t' },
        { label: 'null', value: null },
        { label: 'empty array', value: [] },
        { label: 'number', value: 42 },
        { label: 'boolean', value: true },
        { label: 'object', value: {} },
      ]

      for (const { label, value } of malformedSecondary) {
        // Paired with a VALID production source, so the only reason to block is
        // the malformed secondary.
        const environment = {
          GCLOUD_PROJECT: ALLOWED_PRODUCTION_PROJECT_ID,
          GOOGLE_CLOUD_PROJECT: value,
        }
        assertRejects(
          () => resolveRuntimeProjectId(environment),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `GOOGLE_CLOUD_PROJECT=${label} must not disappear behind a valid GCLOUD_PROJECT`,
        )
        assertRejects(
          () => validateExecutionEnvironment(environment),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `GOOGLE_CLOUD_PROJECT=${label} must block the full guard too`,
        )

        // And in the mirror position: valid GOOGLE_CLOUD_PROJECT, malformed GCLOUD.
        assertRejects(
          () => resolveRuntimeProjectId({
            GCLOUD_PROJECT: value,
            GOOGLE_CLOUD_PROJECT: ALLOWED_PRODUCTION_PROJECT_ID,
          }),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `GCLOUD_PROJECT=${label} must not disappear behind a valid GOOGLE_CLOUD_PROJECT`,
        )
      }
    })

    it('treats an absent or undefined-valued source as genuinely absent', () => {
      // The permitted case: nothing set the variable at all.
      assert.equal(
        resolveRuntimeProjectId({ GCLOUD_PROJECT: ALLOWED_PRODUCTION_PROJECT_ID }),
        ALLOWED_PRODUCTION_PROJECT_ID,
      )
      // An explicitly `undefined` value is indistinguishable from unset in a
      // real process environment, so it is also treated as absent.
      assert.equal(
        resolveRuntimeProjectId({
          GCLOUD_PROJECT: ALLOWED_PRODUCTION_PROJECT_ID,
          GOOGLE_CLOUD_PROJECT: undefined,
          FIREBASE_CONFIG: undefined,
        }),
        ALLOWED_PRODUCTION_PROJECT_ID,
      )
    })

    it('treats a present but unusable FIREBASE_CONFIG as blocking, not absent', () => {
      const unusableConfigs = [
        { label: 'empty string', value: '' },
        { label: 'whitespace only', value: '   ' },
        { label: 'unparseable', value: '{not json' },
        { label: 'JSON null', value: 'null' },
        { label: 'JSON array', value: '[]' },
        { label: 'JSON string', value: '"morgan-bank"' },
        { label: 'JSON number', value: '42' },
        { label: 'object without projectId', value: '{}' },
        { label: 'object with other keys only', value: JSON.stringify({ databaseURL: 'x' }) },
        { label: 'projectId null', value: JSON.stringify({ projectId: null }) },
        { label: 'projectId empty', value: JSON.stringify({ projectId: '' }) },
        { label: 'projectId blank', value: JSON.stringify({ projectId: '   ' }) },
        { label: 'projectId padded', value: JSON.stringify({ projectId: ' morgan-bank' }) },
        { label: 'projectId numeric', value: JSON.stringify({ projectId: 42 }) },
        { label: 'projectId array', value: JSON.stringify({ projectId: [] }) },
      ]

      for (const { label, value } of unusableConfigs) {
        const environment = {
          GCLOUD_PROJECT: ALLOWED_PRODUCTION_PROJECT_ID,
          FIREBASE_CONFIG: value,
        }
        assertRejects(
          () => resolveRuntimeProjectId(environment),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `FIREBASE_CONFIG ${label} must not disappear behind a valid GCLOUD_PROJECT`,
        )
        assertRejects(
          () => validateExecutionEnvironment(environment),
          PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
          `FIREBASE_CONFIG ${label} must block the full guard too`,
        )
      }
    })

    it('names the specific FIREBASE_CONFIG defect rather than a downstream one', () => {
      // Several checks share the ambiguous-project-id category, so asserting the
      // category alone cannot tell them apart: removing the blank check still
      // trips the JSON-parse check, and removing the projectId check still trips
      // the value-type check. Pinning the message identifies which guard fired.
      // Verified by mutation.
      const expectations = [
        { value: '', message: /present but blank/ },
        { value: '   ', message: /present but blank/ },
        { value: '{not json', message: /not parseable JSON/ },
        { value: 'null', message: /not a JSON object/ },
        { value: '[]', message: /not a JSON object/ },
        { value: '42', message: /not a JSON object/ },
        { value: '"morgan-bank"', message: /not a JSON object/ },
        { value: '{}', message: /declares no projectId/ },
        { value: JSON.stringify({ databaseURL: 'x' }), message: /declares no projectId/ },
        { value: JSON.stringify({ projectId: null }), message: /must be a string/ },
        { value: JSON.stringify({ projectId: '' }), message: /present but blank/ },
        { value: JSON.stringify({ projectId: '  ' }), message: /present but blank/ },
        { value: JSON.stringify({ projectId: ' morgan-bank' }), message: /surrounding whitespace/ },
      ]

      for (const { value, message } of expectations) {
        try {
          resolveRuntimeProjectId({
            GCLOUD_PROJECT: ALLOWED_PRODUCTION_PROJECT_ID,
            FIREBASE_CONFIG: value,
          })
          assert.fail(`FIREBASE_CONFIG=${value} should have blocked`)
        } catch (error) {
          assert.ok(
            error instanceof ProductionEnvironmentError,
            `FIREBASE_CONFIG=${value}: wrong error type`,
          )
          assert.match(
            error.message,
            message,
            `FIREBASE_CONFIG=${value} must be rejected by the guard that owns it`,
          )
        }
      }
    })

    it('accepts a pre-parsed FIREBASE_CONFIG object with a canonical projectId', () => {
      // Functions passes FIREBASE_CONFIG as a JSON string, but the guard also
      // accepts an already-parsed object; it must apply identical rules.
      assert.equal(
        resolveRuntimeProjectId({
          FIREBASE_CONFIG: { projectId: ALLOWED_PRODUCTION_PROJECT_ID },
        }),
        ALLOWED_PRODUCTION_PROJECT_ID,
      )
      assertRejects(
        () => resolveRuntimeProjectId({ FIREBASE_CONFIG: { projectId: '' } }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
        'a parsed config with a blank projectId must block',
      )
      assertRejects(
        () => resolveRuntimeProjectId({ FIREBASE_CONFIG: {} }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
        'a parsed config without projectId must block',
      )
    })

    it('reports conflicting source names but never their values', () => {
      try {
        resolveRuntimeProjectId({
          GCLOUD_PROJECT: 'secret-project-a',
          GOOGLE_CLOUD_PROJECT: 'secret-project-b',
        })
        assert.fail('should have thrown')
      } catch (error) {
        const serialized = JSON.stringify(error.details)
        assert.ok(serialized.includes('GCLOUD_PROJECT'))
        assert.ok(serialized.includes('GOOGLE_CLOUD_PROJECT'))
        assert.ok(!serialized.includes('secret-project-a'))
        assert.ok(!serialized.includes('secret-project-b'))
        // Redaction preserves the names for an operator to act on.
        assert.deepEqual(
          redactEnvironmentError(error).details.sources,
          ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'],
        )
      }
    })

    it('an explicitly passed undefined environment fails closed on the resolver too', () => {
      // The resolver is part of the public guard surface, so it gets the same
      // protection as the high-level guards.
      assert.throws(() => resolveRuntimeProjectId(undefined), TypeError)
      assert.throws(() => resolveRuntimeProjectId(null), TypeError)
      assert.throws(() => resolveRuntimeProjectId([]), TypeError)
    })

    it('rejects unparseable FIREBASE_CONFIG instead of silently ignoring it', () => {
      assertRejects(
        () => resolveRuntimeProjectId({
          GCLOUD_PROJECT: 'morgan-bank',
          FIREBASE_CONFIG: '{not json',
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
        'malformed FIREBASE_CONFIG must block',
      )
    })

    it('rejects an environment with no project ID at all', () => {
      assertRejects(
        () => resolveRuntimeProjectId({}),
        PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_PROJECT_ID,
        'absent project must block',
      )
      // A whitespace-only value is PRESENT but blank, so it is a misconfigured
      // source (ambiguous) rather than an absent one (missing). The distinction
      // matters: only genuine absence may be ignored.
      assertRejects(
        () => resolveRuntimeProjectId({ GCLOUD_PROJECT: '   ' }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.AMBIGUOUS_PROJECT_ID,
        'whitespace-only project must block as a present-but-blank source',
      )
    })
  })

  describe('exact project allowlist', () => {
    it('classifies the two allowed projects', () => {
      assert.equal(
        classifyAllowedProject(ALLOWED_PRODUCTION_PROJECT_ID),
        EXECUTION_CONTEXT.PRODUCTION,
      )
      assert.equal(
        classifyAllowedProject(ALLOWED_EMULATOR_PROJECT_ID),
        EXECUTION_CONTEXT.EMULATOR,
      )
    })

    it('rejects lookalikes, prefixes, suffixes, and case variants', () => {
      for (const projectId of [
        'morgan-bank-staging',
        'morgan-bank-prod',
        'not-morgan-bank',
        'morgan-bank ',
        ' morgan-bank',
        'Morgan-Bank',
        'MORGAN-BANK',
        'morgan_bank',
        'morganbank',
        'demo-morgan-bank',
        'demo-morgan-bank-phase2b-server-off-test',
        'morgan-bank-migration-rehearsal',
      ]) {
        assertRejects(
          () => classifyAllowedProject(projectId),
          PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
          `must reject lookalike ${projectId}`,
        )
      }
    })

    it('rejects non-string and empty project IDs', () => {
      for (const projectId of [undefined, null, '', '   ', 42, {}, []]) {
        assertRejects(
          () => classifyAllowedProject(projectId),
          PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_PROJECT_ID,
          `must reject ${String(projectId)}`,
        )
      }
    })
  })

  describe('execution environment validation', () => {
    it('accepts a clean production environment', () => {
      const result = validateExecutionEnvironment(productionEnvironment())
      assert.equal(result.context, EXECUTION_CONTEXT.PRODUCTION)
      assert.equal(result.projectId, ALLOWED_PRODUCTION_PROJECT_ID)
    })

    it('accepts a clean emulator environment', () => {
      const result = validateExecutionEnvironment(emulatorEnvironment())
      assert.equal(result.context, EXECUTION_CONTEXT.EMULATOR)
      assert.equal(result.projectId, ALLOWED_EMULATOR_PROJECT_ID)
    })

    it('rejects each emulator host variable leaking into production', () => {
      for (const variable of EMULATOR_HOST_VARIABLES) {
        assertRejects(
          () => validateExecutionEnvironment(
            productionEnvironment({ [variable]: '127.0.0.1:8080' }),
          ),
          PRODUCTION_ENVIRONMENT_CATEGORIES.EMULATOR_HOST_IN_PRODUCTION,
          `${variable} must block a production context`,
        )
      }
    })

    it('rejects each emulator flag variable leaking into production', () => {
      for (const variable of EMULATOR_FLAG_VARIABLES) {
        assertRejects(
          () => validateExecutionEnvironment(
            productionEnvironment({ [variable]: 'true' }),
          ),
          PRODUCTION_ENVIRONMENT_CATEGORIES.EMULATOR_FLAG_IN_PRODUCTION,
          `${variable} must block a production context`,
        )
      }
    })

    it('rejects an emulator context missing the emulator flag', () => {
      assertRejects(
        () => validateExecutionEnvironment(
          emulatorEnvironment({ FUNCTIONS_EMULATOR: undefined }),
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_EMULATOR_FLAG,
        'absent FUNCTIONS_EMULATOR must block',
      )
      // Exact string equality: "1", "TRUE", "yes" are not "true".
      for (const value of ['1', 'TRUE', 'True', 'yes', '']) {
        assertRejects(
          () => validateExecutionEnvironment(
            emulatorEnvironment({ FUNCTIONS_EMULATOR: value }),
          ),
          PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_EMULATOR_FLAG,
          `FUNCTIONS_EMULATOR="${value}" must block`,
        )
      }
    })

    it('rejects an emulator context with a missing or non-loopback host', () => {
      for (const variable of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
        assertRejects(
          () => validateExecutionEnvironment(
            emulatorEnvironment({ [variable]: undefined }),
          ),
          PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_EMULATOR_HOST,
          `absent ${variable} must block`,
        )
        assertRejects(
          () => validateExecutionEnvironment(
            emulatorEnvironment({ [variable]: 'firestore.googleapis.com:443' }),
          ),
          PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_EMULATOR_HOST,
          `non-loopback ${variable} must block`,
        )
      }
    })

    it('rejects an unapproved project even with an otherwise valid shape', () => {
      assertRejects(
        () => validateExecutionEnvironment({ GCLOUD_PROJECT: 'morgan-bank-staging' }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
        'staging must never validate',
      )
    })

    it('rejects a non-object environment', () => {
      for (const environment of [null, undefined, 'PROD', 42]) {
        assert.throws(
          () => validateExecutionEnvironment(environment),
          TypeError,
          `must reject ${String(environment)}`,
        )
      }
    })

    it('returns a frozen result so a caller cannot mutate the verdict', () => {
      const result = validateExecutionEnvironment(productionEnvironment())
      assert.ok(Object.isFrozen(result))
    })

    it('an explicitly passed undefined environment fails closed, not to process.env', () => {
      // Regression guard. With a parameter default, `validate(maybeEnv)` where
      // maybeEnv is undefined would silently validate the AMBIENT environment
      // while the caller believed it supplied one. Under a real deployment that
      // is the difference between checking a constructed context and checking
      // whatever the production process happens to hold.
      assert.throws(
        () => validateExecutionEnvironment(undefined),
        TypeError,
        'explicit undefined must throw rather than read process.env',
      )

      // The gate propagates the same TypeError rather than falling back to the
      // ambient environment. A TypeError here is correct and load-bearing: it is
      // a caller bug, distinct from the ProductionEnvironmentError categories
      // that describe a genuine environment verdict.
      assert.throws(
        () => assertV2GateAllowed({ environment: undefined, v2Enabled: true }),
        TypeError,
        'gate check with explicit undefined environment must not use process.env',
      )

      assert.throws(
        () => validateWriteAuthorization(writeAuthorization(), {
          environment: undefined,
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        }),
        TypeError,
        'write authorization with explicit undefined environment must not use process.env',
      )
    })

    it('rejects an array as an environment', () => {
      assert.throws(() => validateExecutionEnvironment([]), TypeError)
    })
  })

  describe('V2 gate authorization', () => {
    it('rejects a disabled gate before touching the environment', () => {
      assertRejects(
        () => assertV2GateAllowed({
          environment: productionEnvironment(),
          v2Enabled: false,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.V2_NOT_ENABLED,
        'disabled gate must block',
      )
      // Non-boolean truthy values must not satisfy the gate.
      for (const value of ['true', 1, {}, 'yes']) {
        assertRejects(
          () => assertV2GateAllowed({
            environment: productionEnvironment(),
            v2Enabled: value,
          }),
          PRODUCTION_ENVIRONMENT_CATEGORIES.V2_NOT_ENABLED,
          `v2Enabled=${String(value)} must block`,
        )
      }
    })

    it('allows an enabled gate in the emulator context without a release ID', () => {
      const result = assertV2GateAllowed({
        environment: emulatorEnvironment(),
        v2Enabled: true,
      })
      assert.equal(result.context, EXECUTION_CONTEXT.EMULATOR)
    })

    it('allows an enabled production gate when the release ID matches', () => {
      const result = assertV2GateAllowed({
        environment: productionEnvironment({
          MULTI_TEACHER_V2_RELEASE_ID: RELEASE_ID,
        }),
        v2Enabled: true,
        expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
      })
      assert.equal(result.context, EXECUTION_CONTEXT.PRODUCTION)
      assert.equal(result.releaseIdVerified, true)
    })

    it('rejects a production gate with a missing release ID', () => {
      assertRejects(
        () => assertV2GateAllowed({
          environment: productionEnvironment(),
          v2Enabled: true,
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
        'absent deployed release ID must block',
      )
    })

    it('rejects a production gate with no expected release ID to compare against', () => {
      assertRejects(
        () => assertV2GateAllowed({
          environment: productionEnvironment({
            MULTI_TEACHER_V2_RELEASE_ID: RELEASE_ID,
          }),
          v2Enabled: true,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
        'absent expected release ID must block',
      )
    })

    it('rejects a mismatched release ID', () => {
      assertRejects(
        () => assertV2GateAllowed({
          environment: productionEnvironment({
            MULTI_TEACHER_V2_RELEASE_ID: 'phase3-rel-different',
          }),
          v2Enabled: true,
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.RELEASE_ID_MISMATCH,
        'mismatched release must block',
      )
    })

    it('rejects a malformed deployed release ID', () => {
      for (const value of ['has space', '-leading-dash', 'semi;colon', 'a'.repeat(129)]) {
        assertRejects(
          () => assertV2GateAllowed({
            environment: productionEnvironment({ MULTI_TEACHER_V2_RELEASE_ID: value }),
            v2Enabled: true,
            expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
          }),
          PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_RELEASE_ID,
          `malformed release "${value}" must block`,
        )
      }
    })

    it('requires the expected release ID to be a canonical string, never coerced', () => {
      // `String(123)` would let a numeric expectedReleaseId authorize release
      // "123", so a caller reading the value from JSON or a spreadsheet cell
      // could authorize a release it never named.
      const nonCanonical = [
        123,
        0,
        true,
        {},
        [],
        ['phase3-rel-2026-07-26a'],
        { toString: () => 'phase3-rel-2026-07-26a' },
        ' phase3-rel-2026-07-26a',
        'phase3-rel-2026-07-26a ',
        'has space',
        '-leading-dash',
        'semi;colon',
        'a'.repeat(129),
      ]
      for (const expected of nonCanonical) {
        assertRejects(
          () => assertV2GateAllowed({
            environment: productionEnvironment({
              // Deliberately matches what a coercion would produce.
              MULTI_TEACHER_V2_RELEASE_ID: String(
                Array.isArray(expected) ? expected[0] : expected,
              ),
            }),
            v2Enabled: true,
            expectedReleaseId: expected,
          nowMillis: WRITE_NOW_MILLIS,
          }),
          PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_RELEASE_ID,
          `non-canonical expected release ${JSON.stringify(expected)} must block the gate`,
        )
      }
    })

    it('never leaks release identifiers in a mismatch message', () => {
      try {
        assertV2GateAllowed({
          environment: productionEnvironment({
            MULTI_TEACHER_V2_RELEASE_ID: 'secret-deployed-id',
          }),
          v2Enabled: true,
          expectedReleaseId: 'secret-expected-id',
          nowMillis: WRITE_NOW_MILLIS,
        })
        assert.fail('should have thrown')
      } catch (error) {
        assert.ok(!error.message.includes('secret-deployed-id'))
        assert.ok(!error.message.includes('secret-expected-id'))
        assert.ok(!JSON.stringify(error.details).includes('secret-deployed-id'))
      }
    })
  })

  describe('write authorization', () => {
    it('accepts a complete authorization in the production context', () => {
      const result = validateWriteAuthorization(writeAuthorization(), {
        environment: productionEnvironment(),
        expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
      })
      assert.equal(result.context, EXECUTION_CONTEXT.PRODUCTION)
      assert.equal(result.authorizationId, 'AUTH-2026-07-26-001')
      assert.ok(Object.isFrozen(result))

      // Commit 5 correction G: EVERY validated safe field is returned. An
      // earlier version dropped writeFreezeProof and credentialProvenance, so
      // the journal could not record the identifiers the operator supplied.
      assert.equal(result.writeFreezeProof, 'freeze-20260726T1155Z')
      assert.equal(result.credentialProvenance, 'operator-workstation-adc-rotated')
      assert.equal(result.teacherUid, 'YkYUzIzy0aW7roolM1VaLcIJPuN2')
      assert.equal(result.changeId, 'CHG-2026-07-26-001')
      assert.equal(result.initializationExpectationsSha256, 'b'.repeat(64))
      assert.equal(result.copyExpectationsSha256, 'c'.repeat(64))
      assert.equal(result.notBefore, '2026-07-26T17:00:00.000Z')
      assert.equal(result.notAfter, '2026-07-26T23:00:00.000Z')
    })

    it('requires a current validity window for every mutating invocation', () => {
      // Unlike the read authorization — which a later write may legitimately
      // outlive — a stale write authorization must never mutate anything.
      for (const [label, nowMillis] of [
        ['before notBefore', Date.parse('2026-07-26T16:59:59.000Z')],
        ['after notAfter', Date.parse('2026-07-26T23:00:01.000Z')],
      ]) {
        assertRejects(
          () => validateWriteAuthorization(writeAuthorization(), {
            environment: productionEnvironment(),
            expectedReleaseId: RELEASE_ID,
            nowMillis,
          }),
          PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
          `${label} must block a write`,
        )
      }
      assertRejects(
        () => validateWriteAuthorization(
          writeAuthorization({ notAfter: '2026-07-26T16:00:00.000Z' }),
          {
            environment: productionEnvironment(),
            expectedReleaseId: RELEASE_ID,
            nowMillis: WRITE_NOW_MILLIS,
          },
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'an inverted window must block',
      )
    })

    it('requires digest-shaped fields to be lowercase SHA-256 values', () => {
      for (const field of [
        'preflightManifestId',
        'initializationExpectationsSha256',
        'copyExpectationsSha256',
      ]) {
        for (const value of ['A'.repeat(64), 'abc', 'a'.repeat(63)]) {
          assertRejects(
            () => validateWriteAuthorization(
              writeAuthorization({ [field]: value }),
              {
                environment: productionEnvironment(),
                expectedReleaseId: RELEASE_ID,
                nowMillis: WRITE_NOW_MILLIS,
              },
            ),
            PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
            `${field}=${value} must block`,
          )
        }
      }
    })

    it('rejects an authorization naming a different project', () => {
      assertRejects(
        () => validateWriteAuthorization(
          writeAuthorization({ projectId: 'some-other-project' }),
          {
            environment: productionEnvironment(),
            expectedReleaseId: RELEASE_ID,
            nowMillis: WRITE_NOW_MILLIS,
          },
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
        'a foreign project must block',
      )
    })

    it('names the supplied identifiers that are NOT proofs', () => {
      // Documentation-as-contract: these are operator-entered strings. Nothing
      // here proves a snapshot, freeze, provenance statement, or human approval
      // actually exists.
      assert.deepEqual([...WRITE_AUTHORIZATION_UNPROVEN_IDENTIFIERS].sort(), [
        'authorizationId', 'credentialProvenance', 'snapshotId',
        'writeFreezeProof',
      ])
    })

    it('rejects each individually missing required field', () => {
      for (const field of REQUIRED_WRITE_AUTHORIZATION_FIELDS) {
        const incomplete = writeAuthorization()
        delete incomplete[field]
        assertRejects(
          () => validateWriteAuthorization(incomplete, {
            environment: productionEnvironment(),
            expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
          }),
          PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
          `missing ${field} must block`,
        )
      }
    })

    it('rejects each blank required field', () => {
      for (const field of REQUIRED_WRITE_AUTHORIZATION_FIELDS) {
        assertRejects(
          () => validateWriteAuthorization(writeAuthorization({ [field]: '   ' }), {
            environment: productionEnvironment(),
            expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
          }),
          PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
          `blank ${field} must block`,
        )
      }
    })

    it('rejects every prohibited override key by name, not merely as unknown', () => {
      // The dedicated prohibited-key check must be what fires. The unknown-field
      // check would also reject these as a side effect and reports the same
      // category, so asserting the category alone cannot tell the two apart —
      // deleting the prohibited-key loop would still pass. Asserting on
      // `details.key` pins the specific guard. Verified by mutation.
      for (const key of PROHIBITED_AUTHORIZATION_KEYS) {
        let captured
        try {
          validateWriteAuthorization(
            { ...writeAuthorization(), [key]: true },
            { environment: productionEnvironment(), expectedReleaseId: RELEASE_ID },
          )
          assert.fail(`${key} must be refused`)
        } catch (error) {
          captured = error
        }

        assert.ok(captured instanceof ProductionEnvironmentError, `${key}: wrong error type`)
        assert.equal(
          captured.category,
          PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
          `${key}: wrong category`,
        )
        assert.equal(
          captured.details.key,
          key,
          `${key} must be rejected by the prohibited-key guard (details.key), ` +
            'not incidentally by the unknown-field guard',
        )
        assert.equal(
          captured.details.unknownKeys,
          undefined,
          `${key} must not be reported merely as an unknown field`,
        )
      }
    })

    it('rejects a prohibited key even when it is the only extra field', () => {
      // Ordering guard: the prohibited-key check must run before the
      // unknown-field check so an override flag is never merely "unsupported".
      const authorization = writeAuthorization()
      authorization.force = false // falsy, but still prohibited
      let captured
      try {
        validateWriteAuthorization(authorization, {
          environment: productionEnvironment(),
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        })
        assert.fail('force must be refused even when falsy')
      } catch (error) {
        captured = error
      }
      assert.equal(captured.details.key, 'force')
    })

    it('rejects unknown fields rather than ignoring them', () => {
      assertRejects(
        () => validateWriteAuthorization(
          { ...writeAuthorization(), somethingNew: 'x' },
          { environment: productionEnvironment(), expectedReleaseId: RELEASE_ID },
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'unknown field must block',
      )
    })

    it('rejects non-string and non-canonical field values', () => {
      assertRejects(
        () => validateWriteAuthorization(writeAuthorization({ snapshotId: 42 }), {
          environment: productionEnvironment(),
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'numeric field must block',
      )
      assertRejects(
        () => validateWriteAuthorization(
          writeAuthorization({ snapshotId: ' snap-1 ' }),
          { environment: productionEnvironment(), expectedReleaseId: RELEASE_ID },
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'padded field must block',
      )
      assertRejects(
        () => validateWriteAuthorization(
          writeAuthorization({ snapshotId: 'snap 1' }),
          { environment: productionEnvironment(), expectedReleaseId: RELEASE_ID },
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
        'field with space must block',
      )
    })

    it('rejects a non-object authorization', () => {
      for (const value of [null, undefined, 'CHG-1', 42, []]) {
        assertRejects(
          () => validateWriteAuthorization(value, {
            environment: productionEnvironment(),
            expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
          }),
          PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
          `must reject ${String(value)}`,
        )
      }
    })

    it('refuses to authorize a write in the emulator context', () => {
      // A rehearsal must not travel through the production write guard.
      assertRejects(
        () => validateWriteAuthorization(writeAuthorization(), {
          environment: emulatorEnvironment(),
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
        'emulator context must not authorize a production write',
      )
    })

    it('refuses when the environment itself is unrecognized', () => {
      assertRejects(
        () => validateWriteAuthorization(writeAuthorization(), {
          environment: { GCLOUD_PROJECT: 'morgan-bank-staging' },
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
        'unapproved project must block a write',
      )
    })

    it('refuses when a leaked emulator host contradicts the production project', () => {
      assertRejects(
        () => validateWriteAuthorization(writeAuthorization(), {
          environment: productionEnvironment({
            FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
          }),
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.EMULATOR_HOST_IN_PRODUCTION,
        'contradictory environment must block a write',
      )
    })

    it('rejects a release ID that does not match the reviewed artifact', () => {
      assertRejects(
        () => validateWriteAuthorization(
          writeAuthorization({ releaseId: 'phase3-rel-other' }),
          { environment: productionEnvironment(), expectedReleaseId: RELEASE_ID },
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.RELEASE_ID_MISMATCH,
        'mismatched release must block a write',
      )
    })

    it('rejects a write with no expected release ID supplied', () => {
      assertRejects(
        () => validateWriteAuthorization(writeAuthorization(), {
          environment: productionEnvironment(),
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
        'absent expected release must block a write',
      )
    })

    it('requires the expected release ID to be a canonical string for a write too', () => {
      // The write path carried the same String() coercion as the gate path: a
      // numeric expectedReleaseId of 123 would have authorized release "123".
      //
      // A canonical-looking authorization.releaseId is paired with each
      // non-canonical expected value, so the ONLY reason to reject is the
      // expected identifier itself.
      for (const expected of [
        123,
        0,
        true,
        { toString: () => 'phase3-rel-2026-07-26a' },
        ['phase3-rel-2026-07-26a'],
        ' phase3-rel-2026-07-26a',
        'phase3-rel-2026-07-26a ',
        'has space',
        '-leading-dash',
        'a'.repeat(129),
      ]) {
        assertRejects(
          () => validateWriteAuthorization(
            writeAuthorization({ releaseId: 'phase3-rel-2026-07-26a' }),
            { environment: productionEnvironment(), expectedReleaseId: expected },
          ),
          PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_RELEASE_ID,
          `non-canonical expected release ${JSON.stringify(expected)} must block a write`,
        )
      }
    })

    it('rejects a non-string releaseId inside the authorization itself', () => {
      // Distinct guard, distinct category: the field-type check on the supplied
      // authorization fires before the expected-identifier comparison.
      for (const value of [123, {}, true]) {
        assertRejects(
          () => validateWriteAuthorization(
            { ...writeAuthorization(), releaseId: value },
            { environment: productionEnvironment(), expectedReleaseId: RELEASE_ID },
          ),
          PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_AUTHORIZATION,
          `authorization.releaseId=${String(value)} must block as an invalid field`,
        )
      }
    })

    it('a valid environment alone never authorizes a write', () => {
      // The separation Section 2.10 requires: passing the environment guard must
      // not imply write permission.
      const environmentOk = validateExecutionEnvironment(productionEnvironment())
      assert.equal(environmentOk.context, EXECUTION_CONTEXT.PRODUCTION)
      assertRejects(
        () => validateWriteAuthorization({}, {
          environment: productionEnvironment(),
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.MISSING_AUTHORIZATION,
        'environment validity must not confer write authorization',
      )
    })
  })

  describe('telemetry redaction', () => {
    it('keeps category and safe names but drops values', () => {
      try {
        validateWriteAuthorization(
          writeAuthorization({ releaseId: 'sensitive-release-value' }),
          { environment: productionEnvironment(), expectedReleaseId: RELEASE_ID },
        )
        assert.fail('should have thrown')
      } catch (error) {
        const redacted = redactEnvironmentError(error)
        assert.equal(
          redacted.category,
          PRODUCTION_ENVIRONMENT_CATEGORIES.RELEASE_ID_MISMATCH,
        )
        const serialized = JSON.stringify(redacted)
        assert.ok(!serialized.includes('sensitive-release-value'))
        assert.ok(!serialized.includes(RELEASE_ID))
      }
    })

    it('preserves the variable name for an operator to act on', () => {
      try {
        validateExecutionEnvironment(
          productionEnvironment({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }),
        )
        assert.fail('should have thrown')
      } catch (error) {
        const redacted = redactEnvironmentError(error)
        assert.equal(redacted.details.variable, 'FIRESTORE_EMULATOR_HOST')
        assert.ok(!JSON.stringify(redacted).includes('127.0.0.1:8080'))
      }
    })

    it('never leaks a project ID through redaction', () => {
      try {
        validateExecutionEnvironment({ GCLOUD_PROJECT: 'secret-project-name' })
        assert.fail('should have thrown')
      } catch (error) {
        assert.ok(!JSON.stringify(redactEnvironmentError(error)).includes('secret-project-name'))
      }
    })

    it('degrades safely for a foreign error', () => {
      const redacted = redactEnvironmentError(new Error('boom'))
      assert.equal(redacted.category, 'unknown')
      assert.ok(Object.isFrozen(redacted))
    })
  })

  describe('scope boundary', () => {
    it('exposes no discovery, manifest, projection, or write capability', async () => {
      const module = await import('./productionEnvironment.js')
      const exported = Object.keys(module).sort()
      assert.deepEqual(exported, [
        'ALLOWED_EMULATOR_PROJECT_ID',
        'ALLOWED_PRODUCTION_PROJECT_ID',
        'EMULATOR_FLAG_VARIABLES',
        'EMULATOR_HOST_VARIABLES',
        'EXECUTION_CONTEXT',
        'PRODUCTION_ENVIRONMENT_CATEGORIES',
        'PROHIBITED_AUTHORIZATION_KEYS',
        'PROJECT_ROUTING_VARIABLES',
        'ProductionEnvironmentError',
        'REQUIRED_WRITE_AUTHORIZATION_FIELDS',
        // Commit 5 added the rehearsal validator and the shared local-artifact
        // helpers. All are guards or pure local validators; none performs
        // discovery, projection, manifest persistence, or any write.
        'WRITE_AUTHORIZATION_UNPROVEN_IDENTIFIERS',
        'assertServiceAccountArtifact',
        'assertV2GateAllowed',
        'classifyAllowedProject',
        'isLoopbackHostPort',
        'parseJsonArtifact',
        'readHashedArtifact',
        'redactEnvironmentError',
        'resolveRuntimeProjectId',
        'validateExecutionEnvironment',
        'validateExplicitCredential',
        'validateRehearsalWriteAuthorization',
        'validateWriteAuthorization',
      ], 'Commit 2/5 must expose guards only — no runner, manifest, or writer')
    })

    it('importing the module creates no SDK, network, or filesystem handle', async () => {
      // Correction I: the relocated helpers may read explicitly named local
      // artifacts and construct an injected credential ONLY when called.
      // Importing must stay side-effect-free.
      const source = await import('node:fs/promises')
        .then(fs => fs.readFile(
          new URL('./productionEnvironment.js', import.meta.url), 'utf8',
        ))
      assert.ok(
        !source.includes("from 'firebase-admin"),
        'the guard module must not import firebase-admin',
      )
      // Only type/util imports at module scope; no client is constructed.
      for (const forbidden of [
        'initializeApp(', 'getFirestore(', 'getAuth(', 'new URL(\'https',
      ]) {
        assert.ok(!source.includes(forbidden), `must not contain ${forbidden}`)
      }
    })
  })

  describe('rehearsal write authorization (correction H)', () => {
    it('accepts the exact demo project in the emulator context', () => {
      const result = validateRehearsalWriteAuthorization(
        writeAuthorization({ projectId: ALLOWED_EMULATOR_PROJECT_ID }),
        {
          environment: emulatorEnvironment(),
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        },
      )
      assert.equal(result.context, EXECUTION_CONTEXT.EMULATOR)
      assert.equal(result.projectId, ALLOWED_EMULATOR_PROJECT_ID)
    })

    it('can never authorize production', () => {
      assertRejects(
        () => validateRehearsalWriteAuthorization(writeAuthorization(), {
          environment: productionEnvironment(),
          expectedReleaseId: RELEASE_ID,
          nowMillis: WRITE_NOW_MILLIS,
        }),
        PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
        'a rehearsal authorization must never reach production',
      )
    })

    it('the production validator still rejects the emulator', () => {
      // The production guard is NOT weakened or parameterized to accommodate
      // rehearsal: the two paths are not interchangeable in either direction.
      assertRejects(
        () => validateWriteAuthorization(
          writeAuthorization({ projectId: ALLOWED_EMULATOR_PROJECT_ID }),
          {
            environment: emulatorEnvironment(),
            expectedReleaseId: RELEASE_ID,
            nowMillis: WRITE_NOW_MILLIS,
          },
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
        'production write authorization must reject the emulator',
      )
    })

    it('admits no demo-* project family and no remote emulator host', () => {
      for (const projectId of [
        'demo-anything-else', 'demo-', 'demo-morgan-bank', 'morgan-bank',
      ]) {
        // The exact refusal category differs — an unapproved demo-* name is
        // project-not-allowed, while `morgan-bank` carrying emulator hosts is
        // emulator-host-in-production. What matters is that NONE of them can
        // satisfy the rehearsal validator.
        assert.throws(
          () => validateRehearsalWriteAuthorization(
            writeAuthorization({ projectId }),
            {
              environment: emulatorEnvironment({ GCLOUD_PROJECT: projectId }),
              expectedReleaseId: RELEASE_ID,
              nowMillis: WRITE_NOW_MILLIS,
            },
          ),
          error => {
            assert.ok(error instanceof ProductionEnvironmentError)
            assert.equal(error.blocking, true)
            return true
          },
          `${projectId} must not satisfy the rehearsal validator`,
        )
      }
      // A non-loopback emulator host is refused by the environment guard.
      assertRejects(
        () => validateRehearsalWriteAuthorization(
          writeAuthorization({ projectId: ALLOWED_EMULATOR_PROJECT_ID }),
          {
            environment: emulatorEnvironment({
              FIRESTORE_EMULATOR_HOST: 'firestore.example.com:8080',
            }),
            expectedReleaseId: RELEASE_ID,
            nowMillis: WRITE_NOW_MILLIS,
          },
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.INVALID_EMULATOR_HOST,
        'a remote emulator host must block a rehearsal',
      )
    })

    it('shares the same strict shape and binding logic', () => {
      // The rehearsal path is not a laxer variant: the same required fields,
      // digest shapes, and validity window apply.
      for (const override of [
        { snapshotId: '' },
        { copyExpectationsSha256: 'not-a-digest' },
        { notAfter: '2026-07-26T16:00:00.000Z' },
      ]) {
        assert.throws(
          () => validateRehearsalWriteAuthorization(
            writeAuthorization({
              projectId: ALLOWED_EMULATOR_PROJECT_ID, ...override,
            }),
            {
              environment: emulatorEnvironment(),
              expectedReleaseId: RELEASE_ID,
              nowMillis: WRITE_NOW_MILLIS,
            },
          ),
          error => error instanceof ProductionEnvironmentError,
          `${JSON.stringify(override)} must block a rehearsal too`,
        )
      }
    })
  })

  describe('shared service-account artifact assertion (correction H)', () => {
    function serviceAccount(overrides = {}) {
      return {
        type: 'service_account',
        project_id: ALLOWED_PRODUCTION_PROJECT_ID,
        client_email: 'runner@morgan-bank.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n',
        ...overrides,
      }
    }

    it('requires an explicit expected project from the allowlist', () => {
      // No default, no fallback, no demo-* family: an absent or unrecognized
      // expectation fails closed before any SDK handle could exist.
      for (const expected of [
        undefined, null, '', 'demo-anything', 'morgan-bank-staging',
      ]) {
        assertRejects(
          () => assertServiceAccountArtifact(serviceAccount(), expected),
          PRODUCTION_ENVIRONMENT_CATEGORIES.PROJECT_NOT_ALLOWED,
          `expectedProjectId=${String(expected)} must fail closed`,
        )
      }
    })

    it('accepts each allowlisted project for its own artifact', () => {
      assert.deepEqual(
        assertServiceAccountArtifact(
          serviceAccount(), ALLOWED_PRODUCTION_PROJECT_ID,
        ),
        {
          projectId: ALLOWED_PRODUCTION_PROJECT_ID,
          clientEmail: 'runner@morgan-bank.iam.gserviceaccount.com',
          privateKey: serviceAccount().private_key,
        },
      )
      assert.equal(
        assertServiceAccountArtifact(
          serviceAccount({ project_id: ALLOWED_EMULATOR_PROJECT_ID }),
          ALLOWED_EMULATOR_PROJECT_ID,
        ).projectId,
        ALLOWED_EMULATOR_PROJECT_ID,
      )
    })

    it('rejects a cross-project, non-service-account, or incomplete artifact', () => {
      assertRejects(
        () => assertServiceAccountArtifact(
          serviceAccount({ project_id: ALLOWED_EMULATOR_PROJECT_ID }),
          ALLOWED_PRODUCTION_PROJECT_ID,
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.WRONG_PROJECT_CREDENTIAL,
        'a demo credential must not satisfy a production expectation',
      )
      for (const override of [
        { type: 'authorized_user' }, { client_email: '' }, { private_key: '  ' },
      ]) {
        assertRejects(
          () => assertServiceAccountArtifact(
            serviceAccount(override), ALLOWED_PRODUCTION_PROJECT_ID,
          ),
          PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
          `${JSON.stringify(override)} must block`,
        )
      }
    })

    it('is pure: it constructs no Admin credential', () => {
      let factoryCalls = 0
      assertServiceAccountArtifact(
        serviceAccount(), ALLOWED_PRODUCTION_PROJECT_ID,
      )
      assert.equal(factoryCalls, 0)
      // Only validateExplicitCredential constructs one, and only for production.
      const credential = validateExplicitCredential(serviceAccount(), () => {
        factoryCalls += 1
        return { getAccessToken: async () => ({ access_token: 'x' }) }
      })
      assert.equal(factoryCalls, 1)
      assert.equal(typeof credential.getAccessToken, 'function')
    })

    it('validateExplicitCredential is production-only', () => {
      // Emulator rehearsal must never manufacture a service-account Admin
      // credential; it validates shape and then uses the loopback handle path.
      assertRejects(
        () => validateExplicitCredential(
          serviceAccount({ project_id: ALLOWED_EMULATOR_PROJECT_ID }),
          () => ({ getAccessToken: async () => ({}) }),
        ),
        PRODUCTION_ENVIRONMENT_CATEGORIES.WRONG_PROJECT_CREDENTIAL,
        'a demo credential must never produce an Admin credential',
      )
    })
  })

  describe('shared artifact helpers (correction I)', () => {
    it('hashes raw bytes BEFORE decoding', async () => {
      const bytes = Buffer.from('{"a":1}', 'utf8')
      const artifact = await readHashedArtifact('/artifact.json', {
        readFile: async () => bytes,
      })
      assert.equal(
        artifact.sha256,
        createHash('sha256').update(bytes).digest('hex'),
      )
      assert.equal(artifact.contents, '{"a":1}')
    })

    it('rejects invalid UTF-8 rather than substituting replacement characters', async () => {
      // A lenient decode maps distinct invalid sequences onto the same
      // replacement character, so two different files could agree after
      // decoding while disagreeing on disk.
      await assert.rejects(
        readHashedArtifact('/artifact.json', {
          readFile: async () => Buffer.from([0xff, 0xfe, 0xfd]),
        }),
        error => error.category ===
          PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_ARTIFACT,
      )
    })

    it('rejects unparseable JSON without leaking contents', () => {
      assert.throws(
        () => parseJsonArtifact('{not json', 'The test artifact'),
        error => {
          assert.equal(
            error.category,
            PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_ARTIFACT,
          )
          assert.ok(!error.message.includes('{not json'))
          return true
        },
      )
    })
  })
})
