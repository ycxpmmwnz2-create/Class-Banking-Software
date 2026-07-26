// Phase 3 Commit 3 — production manifest behavioral tests.
//
// EVIDENCE LAYER: behavioral unit tests. Filesystem effects are exercised against
// an injected fs surface, except the encoder-drift fixture which pins real output.
// No emulator, no network, no writes outside injected doubles.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { Timestamp } from 'firebase-admin/firestore'

import {
  serializeCanonicalState,
} from '../phase2/canonicalState.js'
import {
  encodeCanonicalFirestoreValue,
} from '../phase2/canonicalState.js'
import {
  CHECKSUM_DOMAINS,
  PRODUCTION_MANIFEST_CATEGORIES,
  PRODUCTION_MANIFEST_SCHEMA_VERSION,
  PRODUCTION_PREFLIGHT_KIND,
  PRODUCTION_STATE_DIRECTORY,
  ProductionManifestError,
  assertNoSecretMaterial,
  buildProductionManifest,
  computePreflightChecksum,
  deriveManifestId,
  hashDomain,
  persistProductionManifest,
  readProductionManifest,
  resolveManifestPath,
  validateProductionManifest,
} from './productionManifest.js'

const OBSERVED_AT = '2026-07-26T18:00:00.000Z'

function domainPayloads(overrides = {}) {
  const base = {
    deploymentInventory: { rules: { release: 'r1' } },
    legacySourceState: { counts: { students: 3 } },
    foundationState: { present: true },
    destinationAbsence: { counts: { scopedCredentials: 0 } },
    authCompatibility: { uidCollisions: 0 },
    identityWatermark: { nextStudentNumber: 4 },
    expectationsArtifact: { sha256: 'a'.repeat(64) },
    authorizationArtifact: { sha256: 'b'.repeat(64) },
  }
  return { ...base, ...overrides }
}

function buildValidManifest(overrides = {}) {
  return buildProductionManifest({
    projectId: 'morgan-bank',
    teacherUid: 'YkYUzIzy0aW7roolM1VaLcIJPuN2',
    releaseId: 'phase3-rel-2026-07-26a',
    changeId: 'CHG-2026-07-26-001',
    authorizationId: 'AUTH-2026-07-26-001',
    observedAt: OBSERVED_AT,
    domains: domainPayloads(),
    observations: { foundationPresent: true },
    ...overrides,
  })
}

function assertRejects(fn, category, message) {
  assert.throws(fn, error => {
    assert.ok(
      error instanceof ProductionManifestError,
      `${message}: expected ProductionManifestError, got ${error?.name}`,
    )
    assert.equal(error.category, category, message)
    return true
  }, message)
}

async function assertRejectsAsync(fn, category, message) {
  await assert.rejects(fn, error => {
    assert.ok(
      error instanceof ProductionManifestError,
      `${message}: expected ProductionManifestError, got ${error?.name}`,
    )
    assert.equal(error.category, category, message)
    return true
  }, message)
}

/** Minimal in-memory fs double recording every call. */
function fsDouble({ existing = new Set(), failSync = false, failWrite = false } = {}) {
  const calls = []
  const files = new Map()

  return {
    calls,
    files,
    mkdir: async (dir, options) => {
      calls.push({ op: 'mkdir', dir, options })
    },
    open: async (filePath, flags, mode) => {
      calls.push({ op: 'open', filePath, flags, mode })

      if (flags === 'r') {
        if (!existing.has(filePath) && !files.has(filePath)) {
          const error = new Error('ENOENT')
          error.code = 'ENOENT'
          throw error
        }
        return { sync: async () => {}, close: async () => {} }
      }

      if (flags === 'wx') {
        if (existing.has(filePath) || files.has(filePath)) {
          const error = new Error('EEXIST')
          error.code = 'EEXIST'
          throw error
        }
        return {
          writeFile: async (contents) => {
            if (failWrite) throw new Error('disk full')
            files.set(filePath, contents)
            calls.push({ op: 'writeFile', filePath })
          },
          sync: async () => {
            if (failSync) throw new Error('fsync failed')
            calls.push({ op: 'fsync', filePath })
          },
          close: async () => { calls.push({ op: 'close', filePath }) },
        }
      }

      throw new Error(`unexpected flags ${flags}`)
    },
    syncDirectory: async (dir) => { calls.push({ op: 'syncDirectory', dir }) },
  }
}

describe('Phase 3 production manifest', () => {
  describe('Phase 2A canonical encoder drift fixture', () => {
    /**
     * Required by the Section 8 amendment. Phase 3 imports Phase 2A's encoder
     * rather than vendoring it, so a future Phase 2A change would silently alter
     * retained Phase 3 manifest checksums. These pins fail loudly first.
     */
    it('pins the imported encoder output and hash for a fixed fixture', () => {
      const fixture = {
        classroomId: 'abc123',
        balance: 42,
        frozen: false,
        missing: null,
        nested: { b: 2, a: 1 },
        list: [1, 'two', true],
        updatedAt: new Timestamp(1769450400, 123456789),
      }

      const encoded = encodeCanonicalFirestoreValue(fixture)
      const serialized = serializeCanonicalState(encoded)
      const digest = createHash('sha256').update(serialized, 'utf8').digest('hex')

      // Timestamp precision must survive exactly: seconds and nanoseconds both.
      assert.match(serialized, /"seconds":1769450400/)
      assert.match(serialized, /"nanoseconds":123456789/)

      // Map keys are sorted by the encoder, so this ordering is contractual.
      assert.ok(
        serialized.indexOf('"balance"') < serialized.indexOf('"classroomId"'),
        'encoder must emit sorted map entries',
      )

      // The pin. If Phase 2A's encoder changes shape, this fails before any
      // retained Phase 3 manifest becomes unverifiable.
      assert.equal(
        digest,
        '6d09f6031599d692aad06280973f22c8c69a4e9080cc694723b2b7ea382e81b9',
        'Phase 2A canonical encoder output changed; retained Phase 3 manifest ' +
          'checksums would be invalidated. Investigate before updating this pin.',
      )
    })

    it('round-trips a Timestamp without losing nanosecond precision', () => {
      const encoded = encodeCanonicalFirestoreValue({
        at: new Timestamp(1769450400, 1),
      })
      assert.match(serializeCanonicalState(encoded), /"nanoseconds":1\b/)
    })
  })

  describe('checksum domains', () => {
    it('requires exactly the declared domains', () => {
      assertRejects(
        () => computePreflightChecksum({}),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'empty domain set must block',
      )

      const partial = {}
      for (const domain of CHECKSUM_DOMAINS.slice(0, 3)) {
        partial[domain] = 'a'.repeat(64)
      }
      assertRejects(
        () => computePreflightChecksum(partial),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'partial domain set must block',
      )

      const extra = {}
      for (const domain of CHECKSUM_DOMAINS) extra[domain] = 'a'.repeat(64)
      extra.somethingElse = 'a'.repeat(64)
      assertRejects(
        () => computePreflightChecksum(extra),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'extra domain must block',
      )
    })

    it('is order-independent over object keys but order-dependent over domains', () => {
      const forward = {}
      const reverse = {}
      CHECKSUM_DOMAINS.forEach((domain, index) => {
        forward[domain] = String(index).repeat(64).slice(0, 64)
      })
      for (const domain of [...CHECKSUM_DOMAINS].reverse()) {
        reverse[domain] = forward[domain]
      }
      // Same values, different insertion order -> same checksum, because the
      // domains are hashed in declared order.
      assert.equal(
        computePreflightChecksum(forward),
        computePreflightChecksum(reverse),
      )
    })

    it('changes when any single domain changes', () => {
      const base = {}
      for (const domain of CHECKSUM_DOMAINS) base[domain] = 'a'.repeat(64)
      const baseline = computePreflightChecksum(base)

      for (const domain of CHECKSUM_DOMAINS) {
        const mutated = { ...base, [domain]: 'b'.repeat(64) }
        assert.notEqual(
          computePreflightChecksum(mutated),
          baseline,
          `changing ${domain} must change the final checksum`,
        )
      }
    })

    it('rejects a non-SHA256 domain digest', () => {
      const bad = {}
      for (const domain of CHECKSUM_DOMAINS) bad[domain] = 'a'.repeat(64)
      bad.foundationState = 'NOTAHASH'
      assertRejects(
        () => computePreflightChecksum(bad),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'malformed digest must block',
      )
    })
  })

  describe('schema validation', () => {
    it('accepts a well-formed manifest', () => {
      const manifest = buildValidManifest()
      assert.equal(manifest.schemaVersion, PRODUCTION_MANIFEST_SCHEMA_VERSION)
      assert.equal(manifest.kind, PRODUCTION_PREFLIGHT_KIND)
      assert.equal(manifest.outcome, 'succeeded')
      assert.match(manifest.preflightManifestId, /^[0-9a-f]{64}$/)
      assert.equal(validateProductionManifest(manifest), manifest)
    })

    it('rejects an unknown or missing field', () => {
      const manifest = buildValidManifest()
      assertRejects(
        () => validateProductionManifest({ ...manifest, extra: 1 }),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'extra field must block',
      )
      const incomplete = { ...manifest }
      delete incomplete.observedAt
      assertRejects(
        () => validateProductionManifest(incomplete),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'missing field must block',
      )
    })

    it('rejects a non-production project', () => {
      const manifest = buildValidManifest()
      assertRejects(
        () => validateProductionManifest({ ...manifest, projectId: 'demo-x' }),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'non-production project must block',
      )
    })

    it('rejects any outcome other than succeeded', () => {
      const manifest = buildValidManifest()
      for (const outcome of ['failed', 'aborted', 'partial', 'pending']) {
        assertRejects(
          () => validateProductionManifest({ ...manifest, outcome }),
          PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
          `outcome ${outcome} must block — only success is persisted`,
        )
      }
    })

    it('rejects a tampered checksum or manifest ID', () => {
      const manifest = buildValidManifest()
      assertRejects(
        () => validateProductionManifest({
          ...manifest,
          preflightChecksum: 'c'.repeat(64),
        }),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'checksum tamper must block',
      )
      assertRejects(
        () => validateProductionManifest({
          ...manifest,
          preflightManifestId: 'd'.repeat(64),
        }),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'ID tamper must block',
      )
    })

    it('rejects a malformed observedAt', () => {
      const manifest = buildValidManifest()
      for (const observedAt of [
        '2026-07-26', '26/07/2026', 'now', '2026-07-26T18:00:00',
      ]) {
        assertRejects(
          () => validateProductionManifest({ ...manifest, observedAt }),
          PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
          `observedAt=${observedAt} must block`,
        )
      }
    })

    it('rejects a non-canonical identifier', () => {
      for (const field of ['teacherUid', 'releaseId', 'changeId', 'authorizationId']) {
        assert.throws(
          () => buildValidManifest({ [field]: 'has space' }),
          error => error instanceof ProductionManifestError,
          `${field} with a space must block`,
        )
      }
    })
  })

  describe('content-addressed identity', () => {
    it('is stable for identical content and differs for any change', () => {
      const a = buildValidManifest()
      const b = buildValidManifest()
      assert.equal(a.preflightManifestId, b.preflightManifestId)

      const changed = buildValidManifest({
        domains: domainPayloads({ legacySourceState: { counts: { students: 4 } } }),
      })
      assert.notEqual(a.preflightManifestId, changed.preflightManifestId)
    })

    it('excludes the ID itself from its own derivation', () => {
      const manifest = buildValidManifest()
      const withoutId = { ...manifest }
      delete withoutId.preflightManifestId
      assert.equal(deriveManifestId(withoutId), manifest.preflightManifestId)
      assert.equal(deriveManifestId(manifest), manifest.preflightManifestId)
    })

    it('is insensitive to key insertion order', () => {
      const manifest = buildValidManifest()
      const reordered = {}
      for (const key of Object.keys(manifest).reverse()) {
        reordered[key] = manifest[key]
      }
      assert.equal(deriveManifestId(reordered), manifest.preflightManifestId)
    })
  })

  describe('secret-material negative controls', () => {
    it('rejects forbidden key names at any depth', () => {
      for (const key of [
        'pin', 'pinHash', 'password', 'secret', 'token', 'privateKey',
        'private_key', 'email', 'authRecord', 'accessToken', 'client_secret',
        'credentialPath', 'credentialFile', 'credentialBody', 'rawCredential',
        'serviceAccount', 'refresh_token',
      ]) {
        assertRejects(
          () => assertNoSecretMaterial({ observations: { [key]: 'x' } }),
          PRODUCTION_MANIFEST_CATEGORIES.SECRET_MATERIAL,
          `key ${key} must be refused`,
        )
      }
    })

    it('permits a credentials COUNT while refusing credential material', () => {
      // A deliberate distinction. Blocking every key containing "credential"
      // would reject `counts.credentials`, which this manifest is required to
      // carry. The dangerous compounds — path, file, body, raw — stay blocked.
      assert.doesNotThrow(
        () => assertNoSecretMaterial({ counts: { credentials: 3 } }),
        'a credentials count is legitimate manifest content',
      )
      assert.doesNotThrow(
        () => assertNoSecretMaterial({ flatCredentialCount: 12 }),
      )
      for (const key of [
        'credentialPath', 'credential_file', 'credentialBody', 'rawCredentials',
      ]) {
        assertRejects(
          () => assertNoSecretMaterial({ [key]: 'x' }),
          PRODUCTION_MANIFEST_CATEGORIES.SECRET_MATERIAL,
          `${key} must still be refused`,
        )
      }
    })

    it('rejects secret-shaped values regardless of key name', () => {
      const leaks = [
        '-----BEGIN PRIVATE KEY-----\nMIIE...',
        '-----BEGIN RSA PRIVATE KEY-----',
        'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiJ1c2VyIn0.sig',
        'ya29.a0AfH6SMBxxxxxxxxxxxxxxxx',
        '/Users/andrew/keys/service-account.json',
        'Bearer abcdefghijklmnop',
        '1234',
      ]
      for (const value of leaks) {
        assertRejects(
          () => assertNoSecretMaterial({ harmlessName: value }),
          PRODUCTION_MANIFEST_CATEGORIES.SECRET_MATERIAL,
          `value ${value.slice(0, 24)} must be refused`,
        )
      }
    })

    it('permits counts, hashes, and safe identifiers', () => {
      assert.doesNotThrow(() => assertNoSecretMaterial({
        counts: { students: 3, credentials: 3 },
        sha256: 'a'.repeat(64),
        classroomId: 'abc123',
        teacherUid: 'YkYUzIzy0aW7roolM1VaLcIJPuN2',
        outcome: 'succeeded',
        nextStudentNumber: 4,
      }))
    })

    it('blocks a manifest carrying a leak in observations', () => {
      assert.throws(
        () => buildValidManifest({
          observations: { pinHash: '$2a$12$abcdefghijklmnopqrstuv' },
        }),
        error => error.category === PRODUCTION_MANIFEST_CATEGORIES.SECRET_MATERIAL,
        'a leak in observations must block manifest construction',
      )
    })

    it('blocks a leak inside a domain payload before it can be hashed', () => {
      assert.throws(
        () => hashDomain({ credentialPath: '/tmp/key.json' }),
        error => error.category === PRODUCTION_MANIFEST_CATEGORIES.SECRET_MATERIAL,
        'hashDomain must screen before hashing',
      )
    })
  })

  describe('path resolution', () => {
    it('accepts only a SHA-256 identifier', () => {
      const resolved = resolveManifestPath('a'.repeat(64))
      assert.ok(resolved.startsWith(PRODUCTION_STATE_DIRECTORY))
      assert.ok(resolved.endsWith(`preflight-${'a'.repeat(64)}.json`))
    })

    it('rejects traversal, absolute paths, and non-checksum identifiers', () => {
      for (const id of [
        '../escape', '../../etc/passwd', '/etc/passwd', 'a/b',
        'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64),
        '', '.', '..', 'preflight-x.json', null, undefined, 42,
      ]) {
        assertRejects(
          () => resolveManifestPath(id),
          PRODUCTION_MANIFEST_CATEGORIES.INVALID_IDENTIFIER,
          `identifier ${String(id)} must be refused`,
        )
      }
    })

    it('anchors to the Phase 3 directory, never the Phase 2A slot', () => {
      assert.ok(PRODUCTION_STATE_DIRECTORY.includes('phase3'))
      assert.ok(!PRODUCTION_STATE_DIRECTORY.includes('phase2'))
    })
  })

  describe('durable atomic install', () => {
    it('writes through a temp file, fsyncs, installs, and fsyncs the directory', async () => {
      const manifest = buildValidManifest()
      const fs = fsDouble()
      const result = await persistProductionManifest(manifest, fs)

      assert.equal(result.preflightManifestId, manifest.preflightManifestId)

      const ops = fs.calls.map(call => call.op)
      assert.ok(ops.includes('mkdir'), 'must ensure the state directory')
      assert.ok(ops.includes('writeFile'), 'must write')
      assert.ok(ops.includes('fsync'), 'must flush to disk')
      assert.ok(ops.includes('syncDirectory'), 'must fsync the directory')

      // A temp file is used, and it is a sibling in the same directory so the
      // install is atomic on one filesystem.
      const tempWrite = fs.calls.find(
        call => call.op === 'open' && call.filePath.endsWith('.tmp'),
      )
      assert.ok(tempWrite, 'must write through a temporary file')
      assert.equal(tempWrite.flags, 'wx', 'temp file must be created exclusively')

      // Ordering: fsync precedes the final install.
      const firstSync = ops.indexOf('fsync')
      const dirSync = ops.indexOf('syncDirectory')
      assert.ok(firstSync < dirSync, 'file fsync must precede directory fsync')
    })

    it('never overwrites an existing manifest', async () => {
      const manifest = buildValidManifest()
      const targetPath = resolveManifestPath(manifest.preflightManifestId)
      const fs = fsDouble({ existing: new Set([targetPath]) })

      await assertRejectsAsync(
        () => persistProductionManifest(manifest, fs),
        PRODUCTION_MANIFEST_CATEGORIES.ALREADY_EXISTS,
        'an existing manifest is immutable',
      )

      // Nothing was written.
      assert.ok(!fs.calls.some(call => call.op === 'writeFile'))
    })

    it('uses exclusive create on the destination, not a clobbering rename', async () => {
      const manifest = buildValidManifest()
      const fs = fsDouble()
      await persistProductionManifest(manifest, fs)

      const targetPath = resolveManifestPath(manifest.preflightManifestId)
      const destinationOpen = fs.calls.find(
        call => call.op === 'open' && call.filePath === targetPath &&
          call.flags === 'wx',
      )
      assert.ok(
        destinationOpen,
        'destination must be created exclusively so a concurrent writer cannot be clobbered',
      )
      // rename() would silently replace an existing file; it must not be used.
      assert.ok(!fs.calls.some(call => call.op === 'rename'))
    })

    it('surfaces an fsync failure as a write failure', async () => {
      const manifest = buildValidManifest()
      await assertRejectsAsync(
        () => persistProductionManifest(manifest, fsDouble({ failSync: true })),
        PRODUCTION_MANIFEST_CATEGORIES.WRITE_FAILED,
        'fsync failure must not be reported as success',
      )
    })

    it('surfaces a write failure', async () => {
      const manifest = buildValidManifest()
      await assertRejectsAsync(
        () => persistProductionManifest(manifest, fsDouble({ failWrite: true })),
        PRODUCTION_MANIFEST_CATEGORIES.WRITE_FAILED,
        'write failure must not be reported as success',
      )
    })

    it('refuses to persist an invalid manifest before touching the filesystem', async () => {
      const fs = fsDouble()
      await assertRejectsAsync(
        () => persistProductionManifest({ schemaVersion: 1 }, fs),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'invalid manifest must block',
      )
      assert.equal(fs.calls.length, 0, 'no filesystem call may occur')
    })

    it('creates the state directory with restrictive permissions', async () => {
      const fs = fsDouble()
      await persistProductionManifest(buildValidManifest(), fs)
      const mkdirCall = fs.calls.find(call => call.op === 'mkdir')
      assert.equal(mkdirCall.options.mode, 0o700)
    })
  })

  describe('read by content address only', () => {
    it('round-trips a persisted manifest', async () => {
      const manifest = buildValidManifest()
      const serialized = serializeCanonicalState(manifest)
      const loaded = await readProductionManifest(manifest.preflightManifestId, {
        readFile: async () => serialized,
      })
      assert.equal(loaded.preflightManifestId, manifest.preflightManifestId)
      assert.equal(loaded.preflightChecksum, manifest.preflightChecksum)
    })

    it('reports a missing manifest distinctly', async () => {
      await assertRejectsAsync(
        () => readProductionManifest('a'.repeat(64), {
          readFile: async () => {
            const error = new Error('ENOENT')
            error.code = 'ENOENT'
            throw error
          },
        }),
        PRODUCTION_MANIFEST_CATEGORIES.NOT_FOUND,
        'absent manifest must be NOT_FOUND',
      )
    })

    it('rejects a non-canonical stored file even when it parses', async () => {
      const manifest = buildValidManifest()
      // Semantically equal, textually different (whitespace) — must be refused,
      // because canonical bytes are what the checksum covers.
      const pretty = JSON.stringify(manifest, null, 2)
      await assertRejectsAsync(
        () => readProductionManifest(manifest.preflightManifestId, {
          readFile: async () => pretty,
        }),
        PRODUCTION_MANIFEST_CATEGORIES.NOT_CANONICAL,
        'non-canonical bytes must block',
      )
    })

    it('rejects a corrupted file', async () => {
      await assertRejectsAsync(
        () => readProductionManifest('a'.repeat(64), {
          readFile: async () => '{truncated',
        }),
        PRODUCTION_MANIFEST_CATEGORIES.NOT_CANONICAL,
        'corrupt file must block',
      )
    })

    it('rejects a manifest whose content address does not match the request', async () => {
      const manifest = buildValidManifest()
      const serialized = serializeCanonicalState(manifest)
      await assertRejectsAsync(
        () => readProductionManifest('b'.repeat(64), {
          readFile: async () => serialized,
        }),
        PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA,
        'mismatched content address must block',
      )
    })
  })

  describe('scope boundary', () => {
    it('exposes no cleanup, delete, or prune operation', async () => {
      const module = await import('./productionManifest.js')
      const names = Object.keys(module)
      for (const forbidden of [
        'delete', 'remove', 'prune', 'cleanup', 'clear', 'unlink', 'reset',
      ]) {
        assert.ok(
          !names.some(name => name.toLowerCase().includes(forbidden)),
          `manifest module must expose no ${forbidden} operation`,
        )
      }
    })

    it('exposes no path-based reader', async () => {
      const module = await import('./productionManifest.js')
      assert.equal(module.readManifestAtPath, undefined)
      assert.equal(module.readManifestFrom, undefined)
    })
  })
})
