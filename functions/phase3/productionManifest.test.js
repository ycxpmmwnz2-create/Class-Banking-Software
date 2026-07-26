// Phase 3 Commit 3 — production manifest behavioral tests.
//
// EVIDENCE LAYER: behavioral unit tests. Filesystem effects are exercised against
// an injected fs surface, except the encoder-drift fixture which pins real output.
// No emulator, no network, no writes outside injected doubles.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, it } from 'node:test'
import { Timestamp } from 'firebase-admin/firestore'

import {
  serializeCanonicalState,
} from '../phase2/canonicalState.js'
import {
  encodeCanonicalFirestoreValue,
} from '../phase2/canonicalState.js'
import {
  ALLOWED_MANIFEST_PROJECT_IDS,
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
function fsDouble({
  existing = new Set(),
  failSync = false,
  failWrite = false,
  failLink = false,
  failUnlink = false,
  failDirSync = false,
} = {}) {
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
    // Models real hard-link semantics: the target becomes a second name for the
    // SAME bytes, and linking onto an existing name fails rather than replacing
    // it. Verified against the real filesystem before this double was written.
    link: async (from, to) => {
      calls.push({ op: 'link', from, to })
      if (failLink) {
        const error = new Error('link failed')
        error.code = failLink === true ? 'EIO' : failLink
        throw error
      }
      if (existing.has(to) || files.has(to)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      if (!files.has(from)) {
        const error = new Error('ENOENT')
        error.code = 'ENOENT'
        throw error
      }
      files.set(to, files.get(from))
    },
    unlink: async (filePath) => {
      calls.push({ op: 'unlink', filePath })
      if (failUnlink) throw new Error('unlink failed')
      // Removing one name never affects the other name's bytes.
      files.delete(filePath)
    },
    syncDirectory: async (dir) => {
      calls.push({ op: 'syncDirectory', dir })
      if (failDirSync) throw new Error('directory fsync failed')
    },
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

    it('accepts exactly the production and permitted emulator projects, by exact match', () => {
      const manifest = buildValidManifest()

      // Message-pinned, not category-pinned. Several guards in this function share
      // INVALID_SCHEMA, and a rejected project is ALSO caught downstream by the
      // content-address check — so asserting the category alone would still pass if
      // the project check were removed entirely. That is what happened when a
      // `demo-` PREFIX test was mutated back in: the assertion held for the wrong
      // reason.
      const assertProjectRejected = (projectId) => {
        assert.throws(
          () => validateProductionManifest({ ...manifest, projectId }),
          error => {
            assert.ok(error instanceof ProductionManifestError)
            assert.equal(error.category, PRODUCTION_MANIFEST_CATEGORIES.INVALID_SCHEMA)
            assert.match(
              error.message,
              /must name the production project or the permitted emulator project/,
              `projectId ${projectId} must be refused BY THE PROJECT CHECK`,
            )
            return true
          },
        )
      }

      // A prefix test would admit this entire family for no rehearsal benefit.
      for (const projectId of [
        'demo-x', 'demo-', 'demo-morgan-bank', 'demo-attacker-project',
        'demo-morgan-bank-phase2b-server-tes',
        'demo-morgan-bank-phase2b-server-test-2',
        'morgan-bank-staging', 'not-morgan-bank', 'MORGAN-BANK',
      ]) {
        assertProjectRejected(projectId)
      }

      // And exactly the two permitted values reach the later checks rather than
      // being refused here.
      for (const projectId of [...ALLOWED_MANIFEST_PROJECT_IDS]) {
        const candidate = { ...manifest, projectId }
        candidate.preflightManifestId = deriveManifestId(candidate)
        const validated = validateProductionManifest(candidate)
        assert.equal(validated.projectId, projectId)
      }
      assert.deepEqual(
        [...ALLOWED_MANIFEST_PROJECT_IDS].sort(),
        ['demo-morgan-bank-phase2b-server-test', 'morgan-bank'],
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
    it('installs the temp inode under the target name and fsyncs the directory', async () => {
      const manifest = buildValidManifest()
      const fs = fsDouble()
      const result = await persistProductionManifest(manifest, fs)

      assert.equal(result.preflightManifestId, manifest.preflightManifestId)

      const ops = fs.calls.map(call => call.op)
      assert.ok(ops.includes('mkdir'), 'must ensure the state directory')
      assert.ok(ops.includes('writeFile'), 'must write')
      assert.ok(ops.includes('fsync'), 'must flush to disk')
      assert.ok(ops.includes('link'), 'must install by link')
      assert.ok(ops.includes('syncDirectory'), 'must fsync the directory')

      const targetPath = resolveManifestPath(manifest.preflightManifestId)
      const tempOpen = fs.calls.find(
        call => call.op === 'open' && call.filePath.endsWith('.tmp'),
      )
      assert.ok(tempOpen, 'must write through a temporary file')
      assert.equal(tempOpen.flags, 'wx', 'temp file must be created exclusively')
      assert.equal(
        path.dirname(tempOpen.filePath),
        path.dirname(targetPath),
        'temp file must be a sibling so the link is same-filesystem',
      )

      // THE load-bearing assertion, and the one the previous version of this test
      // was missing: the temp file's exact bytes became the target. Observing that
      // "a temp write happened" proves nothing about what landed at the target.
      const link = fs.calls.find(call => call.op === 'link')
      assert.equal(link.from, tempOpen.filePath)
      assert.equal(link.to, targetPath)
      assert.equal(
        fs.files.get(targetPath),
        serializeCanonicalState(manifest),
        'the target must hold the exact canonical bytes that were fsynced',
      )

      // Ordering: the bytes are durable BEFORE the target name exists.
      assert.ok(
        ops.indexOf('fsync') < ops.indexOf('link'),
        'file fsync must precede the install so the target is never a partial file',
      )
      assert.ok(
        ops.indexOf('link') < ops.indexOf('syncDirectory'),
        'the new link must be fsynced after it is created',
      )

      // The temporary name is cleaned up, and doing so does not remove the
      // manifest, because both names referred to one inode.
      assert.ok(
        fs.calls.some(call => call.op === 'unlink' && call.filePath === tempOpen.filePath),
        'the temporary name must be released',
      )
      assert.ok(!fs.files.has(tempOpen.filePath), 'no .tmp file may be left behind')
      assert.ok(fs.files.has(targetPath), 'unlinking the temp name must not remove the manifest')
    })

    it('never writes the target path directly under any flag', async () => {
      const manifest = buildValidManifest()
      const fs = fsDouble()
      await persistProductionManifest(manifest, fs)

      const targetPath = resolveManifestPath(manifest.preflightManifestId)

      // The target may only ever be brought into existence by link(). If it were
      // opened for writing, a crash mid-write would leave a truncated file at a
      // content address that the immutability rule then makes permanent.
      const directWrite = fs.calls.find(
        call => call.op === 'open' && call.filePath === targetPath &&
          call.flags !== 'r',
      )
      assert.equal(
        directWrite,
        undefined,
        'the target must never be opened for writing; only link() may create it',
      )
      // rename() would silently replace an existing file; it must not be used.
      assert.ok(!fs.calls.some(call => call.op === 'rename'))
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

    it('refuses to replace a manifest that appears between the pre-check and the install', async () => {
      // The pre-check is a fast path, not the guarantee. link() is what enforces
      // immutability against a concurrent writer.
      const manifest = buildValidManifest()
      const fs = fsDouble({ failLink: 'EEXIST' })

      await assertRejectsAsync(
        () => persistProductionManifest(manifest, fs),
        PRODUCTION_MANIFEST_CATEGORIES.ALREADY_EXISTS,
        'a concurrently installed manifest must not be replaced',
      )
    })

    describe('crash points leave no partial manifest', () => {
      // At every failure point the target is either absent or complete. It is
      // never present-but-truncated, which under the never-overwrite rule would
      // permanently poison that content address.
      for (const [label, options] of [
        ['during the temp write', { failWrite: true }],
        ['during the temp fsync', { failSync: true }],
        ['during the install link', { failLink: true }],
        ['during the directory fsync', { failDirSync: true }],
      ]) {
        it(label, async () => {
          const manifest = buildValidManifest()
          const targetPath = resolveManifestPath(manifest.preflightManifestId)
          const fs = fsDouble(options)

          await assertRejectsAsync(
            () => persistProductionManifest(manifest, fs),
            PRODUCTION_MANIFEST_CATEGORIES.WRITE_FAILED,
            `${label} must not be reported as success`,
          )

          const installed = fs.files.get(targetPath)
          if (installed !== undefined) {
            // If the name exists at all it must hold the complete document —
            // only reachable when the failure was after a successful link.
            assert.equal(installed, serializeCanonicalState(manifest))
          }
          const leftovers = [...fs.files.keys()].filter(key => key.endsWith('.tmp'))
          assert.deepEqual(leftovers, [], 'no temporary file may be left behind')
        })
      }
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
