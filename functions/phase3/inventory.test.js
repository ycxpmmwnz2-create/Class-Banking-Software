import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  INVENTORY_EXIT_CODES,
  InventoryArgumentError,
  parseInventoryArguments,
  runInventoryMain,
  verifyReviewedCheckout,
} from './inventory.js'
import {
  PREFLIGHT_ABORT_CATEGORIES,
  PreflightAbortError,
} from './productionPreflight.js'

const COMMIT_SHA = 'c39b40c50abd5e31e56d68eb9d80ae3ba5761215'
const NOW = Date.parse('2026-07-28T18:00:00.000Z')
const OBSERVED_AT = '2026-07-28T18:00:00.000Z'
const ARGV = Object.freeze([
  '--commit-sha', COMMIT_SHA,
  '--authorization-file', '/operator/inventory-authorization.json',
  '--credential-file', '/operator/service-account.json',
])

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function credentialBytes(overrides = {}) {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'morgan-bank',
    client_email: 'inventory-reader@example.invalid',
    private_key: 'test-only-private-key-material',
    ...overrides,
  })
}

function authorizationBytes(credentialSha256, overrides = {}) {
  return JSON.stringify({
    kind: 'phase3-production-control-plane-inventory',
    projectId: 'morgan-bank',
    commitSha: COMMIT_SHA,
    changeId: 'CHG-phase3-inventory-bootstrap',
    authorizationId: 'AUTH-phase3-inventory-bootstrap',
    credentialProvenance: 'operator-provided-read-only-service-account',
    credentialSha256,
    notBefore: '2026-07-28T17:00:00.000Z',
    notAfter: '2026-07-28T19:00:00.000Z',
    ...overrides,
  })
}

function deploymentInventory() {
  return Object.freeze({
    complete: true,
    rules: Object.freeze({ firestore: 'rules-digest' }),
    functions: Object.freeze({ callable: 'function-digest' }),
    hosting: Object.freeze({ live: 'hosting-release-id' }),
    indexes: Object.freeze({ byStudent: 'index-digest' }),
    gateParameters: Object.freeze({ MULTI_TEACHER_V2_ENABLED: 'false' }),
  })
}

function logger() {
  const messages = []
  return {
    messages,
    log(message) { messages.push(String(message)) },
    error(message) { messages.push(String(message)) },
  }
}

function dependencies({
  authorization = undefined,
  credential = credentialBytes(),
  credentialFactory = undefined,
  createReaders = undefined,
  persistInventory = undefined,
  testLogger = logger(),
} = {}) {
  const credentialSha256 = sha256(credential)
  const authorizationDocument = authorization ??
    authorizationBytes(credentialSha256)
  const files = new Map([
    ['/operator/inventory-authorization.json', authorizationDocument],
    ['/operator/service-account.json', credential],
  ])
  return {
    environment: { GCLOUD_PROJECT: 'morgan-bank' },
    verifyCheckout: async ({ expectedCommitSha }) => {
      assert.equal(expectedCommitSha, COMMIT_SHA)
      return { commitSha: COMMIT_SHA }
    },
    readFile: async filePath => {
      assert.ok(files.has(filePath), `unexpected artifact path: ${filePath}`)
      return files.get(filePath)
    },
    credentialFactory: credentialFactory ?? (fields => {
      assert.equal(fields.projectId, 'morgan-bank')
      assert.equal(fields.clientEmail, 'inventory-reader@example.invalid')
      assert.equal(fields.privateKey, 'test-only-private-key-material')
      return { getAccessToken: async () => ({ access_token: 'test-only' }) }
    }),
    createReaders: createReaders ?? (async ({ projectId, credential: value }) => {
      assert.equal(projectId, 'morgan-bank')
      assert.equal(typeof value.getAccessToken, 'function')
      return {
        readDeploymentInventory: async () => deploymentInventory(),
        readActiveWriters: async () => ({
          complete: true,
          writers: Object.freeze(['function:callable']),
        }),
      }
    }),
    persistInventory: persistInventory ?? (async artifact => ({
      inventoryId: artifact.inventoryId,
      inventoryChecksum: artifact.inventoryChecksum,
      inventoryPath: `/retained/inventory-${artifact.inventoryId}.json`,
    })),
    nowMillis: NOW,
    observedAt: OBSERVED_AT,
    clock: () => NOW,
    logger: testLogger,
  }
}

function assertArgumentRejected(argv, category) {
  assert.throws(
    () => parseInventoryArguments(argv),
    error => {
      assert.ok(error instanceof InventoryArgumentError)
      assert.equal(error.category, category)
      return true
    },
  )
}

describe('Phase 3 production inventory entrypoint', () => {
  describe('strict arguments', () => {
    it('accepts exactly the three separately valued required flags', () => {
      assert.deepEqual(parseInventoryArguments(ARGV), {
        commitSha: COMMIT_SHA,
        authorizationFile: '/operator/inventory-authorization.json',
        credentialFile: '/operator/service-account.json',
      })
    })

    it('rejects missing, duplicate, inline, unknown, and positional inputs', () => {
      assertArgumentRejected(ARGV.slice(0, -2), 'missing-required-flag')
      assertArgumentRejected([...ARGV, '--commit-sha', COMMIT_SHA], 'duplicate-flag')
      assertArgumentRejected([`--commit-sha=${COMMIT_SHA}`], 'inline-value-rejected')
      assertArgumentRejected([...ARGV, '--unknown'], 'unknown-flag')
      assertArgumentRejected([...ARGV, 'extra'], 'positional-argument')
    })

    it('rejects every write, target, preflight, and state-widening switch', () => {
      for (const flag of [
        '--write',
        '--force',
        '--project',
        '--teacher-uid',
        '--expectations-file',
        '--manifest-path',
        '--state-dir',
        '--production-override',
        '--preflight',
        '--reverify',
        '--migrate',
        '--deploy',
        '--bypass',
      ]) {
        assertArgumentRejected([...ARGV, flag], 'forbidden-flag')
      }
    })
  })

  it('captures one non-authorizing inventory after every binding succeeds', async () => {
    const testLogger = logger()
    let readerFactoryCalls = 0
    let persistenceCalls = 0
    const base = dependencies({ testLogger })
    const result = await runInventoryMain(ARGV, {
      ...base,
      createReaders: async options => {
        readerFactoryCalls += 1
        return base.createReaders(options)
      },
      persistInventory: async artifact => {
        persistenceCalls += 1
        assert.equal(Object.hasOwn(artifact, 'writeEligible'), false)
        assert.equal(Object.hasOwn(artifact, 'preflightManifestId'), false)
        assert.equal(Object.hasOwn(artifact, 'expectations'), false)
        return base.persistInventory(artifact)
      },
    })

    assert.equal(result.exitCode, INVENTORY_EXIT_CODES.SUCCESS)
    assert.equal(readerFactoryCalls, 1)
    assert.equal(persistenceCalls, 1)
    assert.equal(result.result.artifact.projectId, 'morgan-bank')
    assert.equal(result.result.artifact.commitSha, COMMIT_SHA)
    assert.equal(result.result.artifact.outcome, 'observed')
    assert.deepEqual(testLogger.messages, [
      `Control-plane inventory ${result.result.artifact.inventoryId} retained.`,
    ])
  })

  it('verifies exact HEAD and a clean worktree using local read-only Git calls', async () => {
    const calls = []
    const result = await verifyReviewedCheckout({
      expectedCommitSha: COMMIT_SHA,
      runGit: async argumentsValue => {
        calls.push(argumentsValue)
        if (argumentsValue.includes('--show-toplevel')) {
          return '/Users/andrewmorgan/Documents/GitHub/Class-Banking-Software\n'
        }
        if (argumentsValue.includes('--verify')) return `${COMMIT_SHA}\n`
        return ''
      },
    })
    assert.equal(result.commitSha, COMMIT_SHA)
    assert.deepEqual(calls, [
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--verify', 'HEAD'],
      ['status', '--porcelain=v1', '--untracked-files=all'],
    ])
  })

  it('rejects a mismatched or dirty checkout before opening either artifact', async () => {
    for (const category of ['checkout-mismatch', 'checkout-dirty']) {
      let fileReads = 0
      const result = await runInventoryMain(ARGV, {
        environment: { GCLOUD_PROJECT: 'morgan-bank' },
        verifyCheckout: async () => {
          throw new InventoryArgumentError(category, 'blocked')
        },
        readFile: async () => { fileReads += 1; return '{}' },
        logger: logger(),
      })
      assert.equal(result.exitCode, INVENTORY_EXIT_CODES.CHECKOUT_REJECTED)
      assert.equal(fileReads, 0)
    }
  })

  it('does not construct a reader or persist when authorization is mismatched', async () => {
    const credential = credentialBytes()
    let credentialFactoryCalls = 0
    let readerFactoryCalls = 0
    let persistenceCalls = 0
    const result = await runInventoryMain(ARGV, dependencies({
      credential,
      authorization: authorizationBytes(sha256(credential), {
        commitSha: 'a'.repeat(40),
      }),
      credentialFactory: () => {
        credentialFactoryCalls += 1
        throw new Error('must not run')
      },
      createReaders: async () => {
        readerFactoryCalls += 1
        throw new Error('must not run')
      },
      persistInventory: async () => {
        persistenceCalls += 1
        throw new Error('must not run')
      },
    }))

    assert.equal(result.exitCode, INVENTORY_EXIT_CODES.INVENTORY_ABORTED)
    assert.equal(credentialFactoryCalls, 0)
    assert.equal(readerFactoryCalls, 0)
    assert.equal(persistenceCalls, 0)
  })

  it('rejects emulator, unknown, and conflicting project routing before file reads', async () => {
    for (const environment of [
      {
        GCLOUD_PROJECT: 'demo-morgan-bank-phase2b-server-test',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
        FUNCTIONS_EMULATOR: 'true',
      },
      { GCLOUD_PROJECT: 'some-other-project' },
      {
        GCLOUD_PROJECT: 'morgan-bank',
        GOOGLE_CLOUD_PROJECT: 'some-other-project',
      },
    ]) {
      let fileReads = 0
      const result = await runInventoryMain(ARGV, {
        environment,
        verifyCheckout: async () => ({ commitSha: COMMIT_SHA }),
        readFile: async () => { fileReads += 1; return '{}' },
        logger: logger(),
      })
      assert.equal(result.exitCode, INVENTORY_EXIT_CODES.ENVIRONMENT_REJECTED)
      assert.equal(fileReads, 0)
    }
  })

  it('never logs credential contents or unexpected dependency messages', async () => {
    const testLogger = logger()
    const secret = 'test-only-private-key-material'
    const result = await runInventoryMain(ARGV, dependencies({
      testLogger,
      createReaders: async () => {
        throw new Error(`provider diagnostic included ${secret}`)
      },
    }))

    assert.equal(result.exitCode, INVENTORY_EXIT_CODES.INVENTORY_ABORTED)
    const output = testLogger.messages.join('\n')
    assert.equal(output.includes(secret), false)
    assert.equal(output.includes('provider diagnostic'), false)
    assert.match(output, /unexpected/)
  })

  it('reports only allowlisted diagnostics for known control-plane aborts', async () => {
    const testLogger = logger()
    const secret = 'provider-secret-response-body-and-token'
    const knownError = new PreflightAbortError(
      PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      `provider diagnostic included ${secret}`,
      {
        service: 'hosting',
        status: 403,
        responseBody: secret,
        token: secret,
      },
    )
    let persistenceCalls = 0
    const result = await runInventoryMain(ARGV, dependencies({
      testLogger,
      createReaders: async () => ({
        readDeploymentInventory: async () => { throw knownError },
        readActiveWriters: async () => ({ complete: true, writers: [] }),
      }),
      persistInventory: async () => {
        persistenceCalls += 1
        throw new Error('must not persist')
      },
    }))

    assert.equal(result.exitCode, INVENTORY_EXIT_CODES.INVENTORY_ABORTED)
    assert.equal(result.error, knownError)
    assert.equal(persistenceCalls, 0)
    assert.deepEqual(testLogger.messages, [
      'Inventory aborted [inspection-unavailable] (service=hosting, status=403).',
    ])
    const output = testLogger.messages.join('\n')
    assert.equal(output.includes(secret), false)
    assert.equal(output.includes('responseBody'), false)
    assert.equal(output.includes('token'), false)
  })

  it('redacts unrecognized categories, services, statuses, and messages', async () => {
    const testLogger = logger()
    const secret = 'untrusted-provider-diagnostic'
    const unrecognizedError = new PreflightAbortError(
      `secret-category-${secret}`,
      `secret-message-${secret}`,
      {
        service: `secret-service-${secret}`,
        status: 999,
        arbitrary: secret,
      },
    )
    const result = await runInventoryMain(ARGV, dependencies({
      testLogger,
      createReaders: async () => ({
        readDeploymentInventory: async () => { throw unrecognizedError },
        readActiveWriters: async () => ({ complete: true, writers: [] }),
      }),
    }))

    assert.equal(result.exitCode, INVENTORY_EXIT_CODES.INVENTORY_ABORTED)
    assert.equal(result.error, unrecognizedError)
    assert.deepEqual(testLogger.messages, ['Inventory aborted [unknown].'])
    assert.equal(testLogger.messages.join('\n').includes(secret), false)
  })
})
