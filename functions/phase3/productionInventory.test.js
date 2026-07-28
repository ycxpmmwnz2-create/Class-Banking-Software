import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  PRODUCTION_INVENTORY_CATEGORIES,
  PRODUCTION_INVENTORY_KIND,
  PRODUCTION_INVENTORY_MAX_AUTHORIZATION_MS,
  ProductionInventoryError,
  buildProductionInventoryArtifact,
  captureProductionControlPlaneInventory,
  persistProductionInventory,
  resolveInventoryPath,
  validateInventoryAuthorization,
  validateProductionInventoryArtifact,
} from './productionInventory.js'
import { serializeCanonicalState } from '../phase2/canonicalState.js'

const COMMIT_SHA = 'c39b40c50abd5e31e56d68eb9d80ae3ba5761215'
const CREDENTIAL_SHA = 'a'.repeat(64)
const AUTHORIZATION_SHA = 'b'.repeat(64)

function productionEnvironment() {
  return { GCLOUD_PROJECT: 'morgan-bank' }
}

function authorization(overrides = {}) {
  return {
    kind: PRODUCTION_INVENTORY_KIND,
    projectId: 'morgan-bank',
    commitSha: COMMIT_SHA,
    changeId: 'CHG-PHASE3-INVENTORY-001',
    authorizationId: 'AUTH-PHASE3-INVENTORY-001',
    credentialProvenance: 'dedicated-read-only-service-account',
    credentialSha256: CREDENTIAL_SHA,
    notBefore: '2026-07-28T20:00:00.000Z',
    notAfter: '2026-07-28T22:00:00.000Z',
    ...overrides,
  }
}

function deployment(overrides = {}) {
  return {
    rules: { release: 'rules-release', checksum: 'c'.repeat(64) },
    functions: { 'us-central1/functions/legacy': 'd'.repeat(64) },
    hosting: { 'morgan-bank': 'sites/morgan-bank/releases/1|sites/morgan-bank/versions/1' },
    indexes: { composite: 'none', fieldOverrides: 'none' },
    gateParameters: {
      MULTI_TEACHER_V2_ENABLED: 'absent',
      MULTI_TEACHER_V2_RELEASE_ID: 'absent',
    },
    ...overrides,
  }
}

function artifact(overrides = {}) {
  return buildProductionInventoryArtifact({
    authorization: authorization(),
    authorizationSha256: AUTHORIZATION_SHA,
    observedAt: '2026-07-28T21:00:00.000Z',
    deployment: deployment(),
    activeWriters: ['function:us-central1/functions/legacy'],
    ...overrides,
  })
}

async function rejectsCategory(operation, category) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ProductionInventoryError)
    assert.equal(error.category, category)
    return true
  })
}

describe('Phase 3 production control-plane inventory', () => {
  describe('authorization boundary', () => {
    it('accepts an exact checksum-bound, commit-bound, current authorization', () => {
      const result = validateInventoryAuthorization({
        authorization: authorization(),
        projectId: 'morgan-bank',
        commitSha: COMMIT_SHA,
        credentialSha256: CREDENTIAL_SHA,
        nowMillis: Date.parse('2026-07-28T21:00:00.000Z'),
      })
      assert.equal(result.authorizationId, 'AUTH-PHASE3-INVENTORY-001')
    })

    it('rejects project, commit, credential, time, shape, and purpose mismatches', () => {
      const base = {
        projectId: 'morgan-bank',
        commitSha: COMMIT_SHA,
        credentialSha256: CREDENTIAL_SHA,
        nowMillis: Date.parse('2026-07-28T21:00:00.000Z'),
      }
      for (const candidate of [
        authorization({ projectId: 'other-project' }),
        authorization({ commitSha: 'e'.repeat(40) }),
        authorization({ credentialSha256: 'f'.repeat(64) }),
      ]) {
        assert.throws(
          () => validateInventoryAuthorization({ ...base, authorization: candidate }),
          ProductionInventoryError,
        )
      }
      assert.throws(() => validateInventoryAuthorization({
        ...base,
        authorization: authorization({ kind: 'phase3-production-preflight' }),
      }), ProductionInventoryError)
      for (const malformedInstant of [
        '2026-07-28T20:00:00Z',
        '2026-07-28T20:00:00.00Z',
        '2026-02-30T20:00:00.000Z',
      ]) {
        assert.throws(() => validateInventoryAuthorization({
          ...base,
          authorization: authorization({ notBefore: malformedInstant }),
        }), ProductionInventoryError)
      }
      assert.throws(() => validateInventoryAuthorization({
        ...base,
        authorization: authorization({
          notAfter: new Date(
            Date.parse('2026-07-28T20:00:00.000Z') +
              PRODUCTION_INVENTORY_MAX_AUTHORIZATION_MS + 1,
          ).toISOString(),
        }),
      }), ProductionInventoryError)
      assert.throws(() => validateInventoryAuthorization({
        ...base,
        authorization: { ...authorization(), extra: true },
      }), ProductionInventoryError)
      assert.throws(() => validateInventoryAuthorization({
        ...base,
        nowMillis: Date.parse('2026-07-29T00:00:00.000Z'),
        authorization: authorization(),
      }), ProductionInventoryError)
    })
  })

  describe('non-authorizing immutable artifact', () => {
    it('retains exact opaque inventory and writers without a preflight or write grant', () => {
      const result = artifact()
      assert.deepEqual(result.deployment, deployment())
      assert.deepEqual(result.activeWriters, [
        'function:us-central1/functions/legacy',
      ])
      assert.equal(result.outcome, 'observed')
      assert.equal(Object.hasOwn(result, 'writeEligible'), false)
      assert.equal(Object.hasOwn(result, 'preflightManifestId'), false)
      assert.equal(Object.hasOwn(result, 'expectations'), false)
      assert.equal(validateProductionInventoryArtifact(result), result)
    })

    it('content-addresses the observation and changes on any inventory drift', () => {
      const first = artifact()
      const second = artifact({
        deployment: deployment({
          hosting: { 'morgan-bank': 'sites/morgan-bank/releases/2|sites/morgan-bank/versions/2' },
        }),
      })
      assert.notEqual(first.inventoryChecksum, second.inventoryChecksum)
      assert.notEqual(first.inventoryId, second.inventoryId)
      assert.match(first.inventoryId, /^[0-9a-f]{64}$/)
    })

    it('rejects secret-shaped values and every schema widening', () => {
      assert.throws(() => artifact({
        activeWriters: ['Bearer abcdefghijklmnopqrstuvwxyz'],
      }), /secret-material/i)
      const widened = { ...artifact(), writeEligible: true }
      assert.throws(
        () => validateProductionInventoryArtifact(widened),
        ProductionInventoryError,
      )
    })
  })

  describe('read boundary', () => {
    it('invokes only deployment-inventory and active-writer readers', async () => {
      const calls = []
      let persisted
      const readers = new Proxy({
        readDeploymentInventory: async () => {
          calls.push('deployment')
          return { complete: true, ...deployment() }
        },
        readActiveWriters: async () => {
          calls.push('writers')
          return {
            complete: true,
            writers: ['function:us-central1/functions/legacy'],
          }
        },
      }, {
        get(target, property) {
          if (property in target) return target[property]
          throw new Error(`unexpected reader access: ${String(property)}`)
        },
      })

      const result = await captureProductionControlPlaneInventory({
        environment: productionEnvironment(),
        readers,
        authorization: authorization(),
        authorizationSha256: AUTHORIZATION_SHA,
        credentialSha256: CREDENTIAL_SHA,
        commitSha: COMMIT_SHA,
        nowMillis: Date.parse('2026-07-28T21:00:00.000Z'),
        observedAt: '2026-07-28T21:00:00.000Z',
        completionNow: () => Date.parse('2026-07-28T21:00:00.000Z'),
        persistInventory: async value => {
          persisted = value
          return {
            inventoryId: value.inventoryId,
            inventoryChecksum: value.inventoryChecksum,
          }
        },
      })
      assert.deepEqual(calls.sort(), ['deployment', 'writers'])
      assert.equal(result.artifact, persisted)
    })

    it('does not read or persist when authorization or environment fails', async () => {
      let reads = 0
      let persists = 0
      const readers = {
        readDeploymentInventory: async () => { reads += 1 },
        readActiveWriters: async () => { reads += 1 },
      }
      await rejectsCategory(
        () => captureProductionControlPlaneInventory({
          environment: productionEnvironment(),
          readers,
          authorization: authorization({ credentialSha256: 'f'.repeat(64) }),
          authorizationSha256: AUTHORIZATION_SHA,
          credentialSha256: CREDENTIAL_SHA,
          commitSha: COMMIT_SHA,
          nowMillis: Date.parse('2026-07-28T21:00:00.000Z'),
          observedAt: '2026-07-28T21:00:00.000Z',
          completionNow: () => Date.parse('2026-07-28T21:00:00.000Z'),
          persistInventory: async () => { persists += 1 },
        }),
        PRODUCTION_INVENTORY_CATEGORIES.AUTHORIZATION_UNBOUND,
      )
      await rejectsCategory(
        () => captureProductionControlPlaneInventory({
          environment: {
            GCLOUD_PROJECT: 'demo-morgan-bank-phase2b-server-test',
            FUNCTIONS_EMULATOR: 'true',
            FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
            FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
          },
          readers,
          authorization: authorization(),
          authorizationSha256: AUTHORIZATION_SHA,
          credentialSha256: CREDENTIAL_SHA,
          commitSha: COMMIT_SHA,
          nowMillis: Date.parse('2026-07-28T21:00:00.000Z'),
          observedAt: '2026-07-28T21:00:00.000Z',
          completionNow: () => Date.parse('2026-07-28T21:00:00.000Z'),
          persistInventory: async () => { persists += 1 },
        }),
        PRODUCTION_INVENTORY_CATEGORIES.NOT_PRODUCTION,
      )
      assert.equal(reads, 0)
      assert.equal(persists, 0)
    })

    it('fails closed on incomplete observations and never persists them', async () => {
      let persists = 0
      await rejectsCategory(
        () => captureProductionControlPlaneInventory({
          environment: productionEnvironment(),
          readers: {
            readDeploymentInventory: async () => ({
              complete: false,
              ...deployment(),
            }),
            readActiveWriters: async () => ({ complete: true, writers: [] }),
          },
          authorization: authorization(),
          authorizationSha256: AUTHORIZATION_SHA,
          credentialSha256: CREDENTIAL_SHA,
          commitSha: COMMIT_SHA,
          nowMillis: Date.parse('2026-07-28T21:00:00.000Z'),
          observedAt: '2026-07-28T21:00:00.000Z',
          completionNow: () => Date.parse('2026-07-28T21:00:00.000Z'),
          persistInventory: async () => { persists += 1 },
        }),
        PRODUCTION_INVENTORY_CATEGORIES.INCOMPLETE,
      )
      assert.equal(persists, 0)
    })

    it('does not retain an inventory that completes after authorization expiry', async () => {
      let persists = 0
      await rejectsCategory(
        () => captureProductionControlPlaneInventory({
          environment: productionEnvironment(),
          readers: {
            readDeploymentInventory: async () => ({
              complete: true,
              ...deployment(),
            }),
            readActiveWriters: async () => ({ complete: true, writers: [] }),
          },
          authorization: authorization(),
          authorizationSha256: AUTHORIZATION_SHA,
          credentialSha256: CREDENTIAL_SHA,
          commitSha: COMMIT_SHA,
          nowMillis: Date.parse('2026-07-28T21:00:00.000Z'),
          observedAt: '2026-07-28T21:00:00.000Z',
          completionNow: () => Date.parse('2026-07-28T22:00:00.001Z'),
          persistInventory: async () => { persists += 1 },
        }),
        PRODUCTION_INVENTORY_CATEGORIES.AUTHORIZATION_EXPIRED,
      )
      assert.equal(persists, 0)
    })
  })

  describe('durable install', () => {
    it('writes a canonical read-only temp file and installs without replacement', async () => {
      const value = artifact()
      const files = new Map()
      const calls = []
      const fs = {
        mkdir: async (directory, options) => calls.push({ op: 'mkdir', directory, options }),
        open: async (filePath, flags, mode) => {
          calls.push({ op: 'open', filePath, flags, mode })
          if (flags === 'r') {
            const error = new Error('missing')
            error.code = 'ENOENT'
            throw error
          }
          let contents = ''
          return {
            writeFile: async valueToWrite => { contents = valueToWrite },
            sync: async () => {},
            close: async () => { files.set(filePath, contents) },
          }
        },
        link: async (source, target) => {
          files.set(target, files.get(source))
          calls.push({ op: 'link', source, target })
        },
        unlink: async filePath => { files.delete(filePath) },
        syncDirectory: async () => calls.push({ op: 'syncDirectory' }),
      }
      const result = await persistProductionInventory(value, fs)
      assert.equal(result.inventoryId, value.inventoryId)
      assert.equal(
        files.get(resolveInventoryPath(value.inventoryId)),
        serializeCanonicalState(value),
      )
      const writeOpen = calls.find(call => call.op === 'open' && call.flags === 'wx')
      assert.equal(writeOpen.mode, 0o400)
      assert.equal(calls.find(call => call.op === 'mkdir').options.mode, 0o700)
    })

    it('refuses an already installed content address before writing', async () => {
      const value = artifact()
      await rejectsCategory(
        () => persistProductionInventory(value, {
          mkdir: async () => {},
          open: async (filePath, flags) => {
            if (flags === 'r') return { close: async () => {} }
            throw new Error('write must be unreachable')
          },
          link: async () => {},
          unlink: async () => {},
          syncDirectory: async () => {},
        }),
        PRODUCTION_INVENTORY_CATEGORIES.ALREADY_EXISTS,
      )
    })
  })

  it('binds raw authorization bytes by SHA-256', () => {
    const first = createHash('sha256').update('authorization-one').digest('hex')
    const second = createHash('sha256').update('authorization-two').digest('hex')
    const one = artifact({ authorizationSha256: first })
    const two = artifact({ authorizationSha256: second })
    assert.notEqual(one.inventoryId, two.inventoryId)
  })
})
