import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { URL } from 'node:url'
import { describe, it } from 'node:test'

import {
  BATCH_CLASSIFICATIONS,
  COPY_SURFACE_ORDER,
  JOURNAL_EVENTS,
  PRODUCTION_WRITER_CATEGORIES,
  ProductionWriterError,
  WRITE_RESULTS,
  WRITE_STAGES,
  assertDeploymentExpectations,
  assertManifestWriteEligible,
  assertNoJournalSecrets,
  buildCopyPlan,
  classifyBatchState,
  commitCopyBatch,
  computeFoundationDigest,
  createWriteJournal,
  deriveStage,
  recoverAuthorizedLoginCode,
  runInitializationTransaction,
  runProductionWrite,
} from './productionWriter.js'
import {
  encodeCanonicalFirestoreValue,
  serializeCanonicalState,
} from '../phase2/canonicalState.js'
import { Timestamp } from 'firebase-admin/firestore'

/**
 * Phase 3 Commit 5 — production writer unit behavior.
 *
 * These are REAL behavioral tests over the module's own logic. The Firestore
 * doubles below implement genuine transaction semantics — reads observe a
 * snapshot, writes are buffered and applied on commit, and a failure discards
 * them — so a test that claims "reads happen before writes" or "a retry is
 * safe" is exercising that property rather than asserting on a mock's echo.
 *
 * The emulator suite proves the same paths against real Firestore; this file
 * proves the decision logic, the journal, and the recovery classifier.
 */

const MANIFEST_ID = 'a'.repeat(64)
const TEACHER_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'
const CLASSROOM_ID = 'classroom-alpha'
const CANONICAL_CODE = 'BCDFGHJK'
const FORMATTED_CODE = 'BCDF-GHJK'

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Real Admin Timestamps, not a double.
 *
 * The canonical encoder recognizes only genuine `Timestamp` instances, and this
 * suite hashes real document bodies through it — so using the real type is both
 * required and more faithful to production behavior.
 */
function FakeTimestamp(seconds, nanoseconds) {
  return new Timestamp(seconds, nanoseconds)
}

const INITIALIZED_AT = new Timestamp(1_790_000_000, 123_456_789)

/**
 * An in-memory Firestore with real transaction semantics.
 *
 * Deliberately NOT a mock that echoes inputs: it records the exact order of
 * reads and writes inside each transaction, buffers writes until commit,
 * enforces create-vs-update semantics, and can be told to fail a commit or to
 * force one retry — which is what makes the retry-safety and
 * crash-after-commit tests meaningful.
 */
function createFakeFirestore(seed = {}, options = {}) {
  const documents = new Map(Object.entries(seed))
  const calls = { transactions: 0, reads: [], writes: [], order: [] }
  let remainingRetries = options.retries ?? 0

  /**
   * Deep copy that PRESERVES Timestamp instances.
   *
   * `structuredClone` silently downgrades a Timestamp to a plain object, which
   * the canonical encoder then rejects. Real Firestore returns real Timestamps,
   * so the double must too — otherwise these tests would exercise a value shape
   * production never produces.
   */
  function clone(value) {
    if (value instanceof Timestamp) return value
    if (Array.isArray(value)) return value.map(clone)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, clone(entry)]),
      )
    }
    return value
  }

  function snapshotOf(docPath) {
    const stored = documents.get(docPath)
    return {
      exists: stored !== undefined,
      id: docPath.split('/').at(-1),
      ref: { path: docPath },
      data: () => (stored === undefined ? undefined : clone(stored.data)),
      updateTime: stored?.updateTime,
    }
  }

  const firestore = {
    doc(docPath) {
      return { path: docPath }
    },
    collection() {
      throw new Error('collection() is not used by the writer')
    },
    async runTransaction(callback) {
      for (;;) {
        calls.transactions += 1
        const buffered = []
        let sawWrite = false
        let readAfterWrite = false

        const transaction = {
          async get(ref) {
            calls.reads.push(ref.path)
            calls.order.push({ op: 'read', path: ref.path })
            if (sawWrite) readAfterWrite = true
            return snapshotOf(ref.path)
          },
          create(ref, data) {
            sawWrite = true
            calls.order.push({ op: 'create', path: ref.path })
            buffered.push({ type: 'create', path: ref.path, data })
          },
          update(ref, data) {
            sawWrite = true
            calls.order.push({ op: 'update', path: ref.path })
            buffered.push({ type: 'update', path: ref.path, data })
          },
          set() {
            throw new Error('set() must never be used by the writer')
          },
          delete() {
            throw new Error('delete() must never be used by the writer')
          },
        }

        await callback(transaction)

        // The callback must not read after writing; a Firestore transaction
        // requires all reads first and would reject otherwise.
        assert.equal(
          readAfterWrite, false,
          'a transaction callback must perform every read before any write',
        )

        if (remainingRetries > 0) {
          // Discard buffered writes and re-run, exactly as a contended
          // transaction would. A callback with a side effect would corrupt here.
          remainingRetries -= 1
          continue
        }
        if (options.failCommit) {
          throw new Error('commit failed')
        }

        for (const write of buffered) {
          if (write.type === 'create') {
            if (documents.has(write.path)) {
              throw new Error(`create on existing document ${write.path}`)
            }
            documents.set(write.path, {
              data: clone(write.data),
              updateTime: INITIALIZED_AT,
            })
          } else {
            const existing = documents.get(write.path)
            if (!existing) throw new Error(`update on missing ${write.path}`)
            documents.set(write.path, {
              data: { ...existing.data, ...clone(write.data) },
              updateTime: INITIALIZED_AT,
            })
          }
          calls.writes.push(write)
        }
        return undefined
      }
    },
  }

  return { firestore, documents, calls, snapshotOf }
}

function teacherDoc() {
  return {
    data: { uid: TEACHER_UID, classroomId: CLASSROOM_ID, status: 'active' },
    updateTime: FakeTimestamp(1_700_000_000, 1),
  }
}

function classroomDoc(extra = {}) {
  return {
    data: {
      ownerUid: TEACHER_UID,
      name: 'Period 1',
      createdAt: FakeTimestamp(1_600_000_000, 2),
      settings: { legacy: true },
      ...extra,
    },
    updateTime: FakeTimestamp(1_700_000_000, 3),
  }
}

function foundationFixture(classroomExtra = {}) {
  const teacher = teacherDoc()
  const classroom = classroomDoc(classroomExtra)
  return {
    teacherUid: TEACHER_UID,
    classroomId: CLASSROOM_ID,
    teacher: {
      id: TEACHER_UID,
      path: `teachers/${TEACHER_UID}`,
      data: teacher.data,
      exists: true,
      updateTime: teacher.updateTime,
    },
    classroom: {
      id: CLASSROOM_ID,
      path: `classrooms/${CLASSROOM_ID}`,
      data: classroom.data,
      exists: true,
      updateTime: classroom.updateTime,
    },
    foundationStateDigest: computeFoundationDigest(
      teacher.data, classroom.data,
    ),
  }
}

const INITIALIZATION = Object.freeze({
  canonicalLoginCode: CANONICAL_CODE,
  formattedLoginCode: FORMATTED_CODE,
  nextStudentNumber: 12,
})

function eligibleManifest(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: 'phase3-production-preflight',
    preflightManifestId: MANIFEST_ID,
    projectId: 'morgan-bank',
    teacherUid: TEACHER_UID,
    releaseId: 'phase3-rel-2026-07-26a',
    changeId: 'CHG-2026-07-26-001',
    authorizationId: 'AUTH-2026-07-26-001',
    observedAt: '2026-07-26T18:00:00.000Z',
    outcome: 'succeeded',
    domainChecksums: { authorizationArtifact: 'f'.repeat(64) },
    preflightChecksum: 'b'.repeat(64),
    observations: {
      foundationPresent: true,
      writeEligible: true,
      selectedCodePresent: false,
      acknowledgedAnomalyCount: 0,
      destinationCounts: {
        classroomStudents: 0,
        classroomTransactions: 0,
        classroomLoginHistory: 0,
        scopedCredentials: 0,
        scopedLogs: 0,
        loginCodeIndex: 0,
      },
      watermark: { nextStudentNumber: 12 },
    },
    ...overrides,
  }
}

async function withTempState(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'phase3-writer-test-'))
  try {
    return await run(root)
  } finally {
    // Removes ONLY this test's isolated temporary root. Operator .state contents
    // are never touched by this suite.
    await rm(root, { recursive: true, force: true })
  }
}

function journalFor(root, overrides = {}) {
  return createWriteJournal({
    preflightManifestId: MANIFEST_ID,
    stateRoot: root,
    ...overrides,
  })
}

function headerEvent(extra = {}) {
  return {
    schemaVersion: 1,
    kind: 'phase3-production-write-journal',
    event: JOURNAL_EVENTS.PLANNED,
    projectId: 'morgan-bank',
    preflightManifestId: MANIFEST_ID,
    planDigest: sha256('plan'),
    initializationExpectationsSha256: sha256('init-exp'),
    copyExpectationsSha256: sha256('copy-exp'),
    ...extra,
  }
}

function assertWriterError(category) {
  return error => {
    assert.ok(error instanceof ProductionWriterError, 'expected a writer error')
    assert.equal(error.code, 'PHASE3_PRODUCTION_WRITER_ERROR')
    assert.equal(error.category, category)
    assert.equal(error.blocking, true)
    return true
  }
}

describe('Phase 3 production writer', () => {
  describe('manifest eligibility', () => {
    it('accepts an eligible v2 manifest', () => {
      const manifest = eligibleManifest()
      assert.equal(
        assertManifestWriteEligible(manifest, { expectedProjectId: 'morgan-bank' }),
        manifest,
      )
    })

    it('rejects a v1 manifest outright', () => {
      assert.throws(
        () => assertManifestWriteEligible(
          eligibleManifest({ schemaVersion: 1 }),
          { expectedProjectId: 'morgan-bank' },
        ),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE),
      )
    })

    it('rejects a foundation-absent manifest', () => {
      // Correction A: a diagnostic manifest recording an absent foundation must
      // never authorize a write. Foundation identity cannot be invented.
      const manifest = eligibleManifest()
      manifest.observations = {
        ...manifest.observations, foundationPresent: false, writeEligible: false,
      }
      assert.throws(
        () => assertManifestWriteEligible(manifest, {
          expectedProjectId: 'morgan-bank',
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE),
      )
    })

    it('rejects acknowledged anomalies and any nonzero destination surface', () => {
      for (const override of [
        { acknowledgedAnomalyCount: 1 },
        { selectedCodePresent: true },
        { destinationCounts: { classroomStudents: 1, loginCodeIndex: 0 } },
        { destinationCounts: { classroomStudents: 0, loginCodeIndex: 1 } },
        { writeEligible: false },
      ]) {
        const manifest = eligibleManifest()
        manifest.observations = { ...manifest.observations, ...override }
        assert.throws(
          () => assertManifestWriteEligible(manifest, {
            expectedProjectId: 'morgan-bank',
          }),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE),
          `${JSON.stringify(override)} must block`,
        )
      }
    })

    it('each eligibility precondition blocks INDEPENDENTLY of writeEligible', () => {
      // Mutation-driven. An earlier version of these cases left
      // `writeEligible: false` alongside the defect, so deleting the
      // foundation-present or per-surface-zero check individually still failed
      // via the writeEligible check and the mutation escaped. Here
      // `writeEligible` stays TRUE, so each specific guard is the only thing
      // that can reject — which is what makes removing it detectable.
      const cases = [
        ['foundation absent', { foundationPresent: false }],
        ['selected code present', { selectedCodePresent: true }],
        ['acknowledged anomaly', { acknowledgedAnomalyCount: 2 }],
        ...[
          'classroomStudents', 'classroomTransactions', 'classroomLoginHistory',
          'scopedCredentials', 'scopedLogs', 'loginCodeIndex',
        ].map(surface => [`nonzero ${surface}`, {
          destinationCounts: {
            classroomStudents: 0,
            classroomTransactions: 0,
            classroomLoginHistory: 0,
            scopedCredentials: 0,
            scopedLogs: 0,
            loginCodeIndex: 0,
            [surface]: 1,
          },
        }]),
      ]
      for (const [label, override] of cases) {
        const manifest = eligibleManifest()
        manifest.observations = {
          ...manifest.observations,
          ...override,
          writeEligible: true,
        }
        assert.throws(
          () => assertManifestWriteEligible(manifest, {
            expectedProjectId: 'morgan-bank',
          }),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE),
          `${label} must block on its own guard, not only via writeEligible`,
        )
      }
    })

    it('rejects a manifest that never counted the login-code index', () => {
      // Omission must not satisfy the all-zero rule by default.
      const manifest = eligibleManifest()
      manifest.observations = {
        ...manifest.observations,
        destinationCounts: {
          classroomStudents: 0,
          classroomTransactions: 0,
          classroomLoginHistory: 0,
          scopedCredentials: 0,
          scopedLogs: 0,
        },
      }
      assert.throws(
        () => assertManifestWriteEligible(manifest, {
          expectedProjectId: 'morgan-bank',
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE),
      )
    })

    it('rejects a manifest for a different project', () => {
      assert.throws(
        () => assertManifestWriteEligible(eligibleManifest(), {
          expectedProjectId: 'demo-morgan-bank-phase2b-server-test',
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE),
      )
    })
  })

  describe('login-code recovery from the re-presented artifact', () => {
    const credentialSha = sha256('credential-bytes')
    const authorizationBytes = '{"authorization":"bytes"}'
    const authorizationSha = sha256(authorizationBytes)

    function manifestBinding() {
      return eligibleManifest({
        domainChecksums: {
          authorizationArtifact: sha256(
            serializeCanonicalState({ sha256: authorizationSha }),
          ),
        },
      })
    }

    function preflightAuthorization(overrides = {}) {
      return {
        projectId: 'morgan-bank',
        teacherUid: TEACHER_UID,
        releaseId: 'phase3-rel-2026-07-26a',
        changeId: 'CHG-2026-07-26-001',
        credentialSha256: credentialSha,
        studentLoginCode: CANONICAL_CODE,
        ...overrides,
      }
    }

    it('recovers the canonical code without the manifest retaining it', () => {
      const manifest = manifestBinding()
      // The manifest carries no raw code anywhere.
      assert.ok(!JSON.stringify(manifest).includes(CANONICAL_CODE))

      const recovered = recoverAuthorizedLoginCode({
        manifest,
        preflightAuthorization: preflightAuthorization(),
        preflightAuthorizationSha256: authorizationSha,
        credentialSha256: credentialSha,
      })
      assert.equal(recovered.canonicalLoginCode, CANONICAL_CODE)
      assert.equal(recovered.formattedLoginCode, FORMATTED_CODE)
    })

    it('rejects an authorization whose raw digest is not the bound one', () => {
      assert.throws(
        () => recoverAuthorizedLoginCode({
          manifest: manifestBinding(),
          preflightAuthorization: preflightAuthorization(),
          preflightAuthorizationSha256: sha256('different-bytes'),
          credentialSha256: credentialSha,
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED),
      )
    })

    it('rejects a mismatched credential or identity binding', () => {
      for (const [label, args] of [
        ['credential', { credentialSha256: sha256('other-credential') }],
        ['project', { authorization: { projectId: 'other-project' } }],
        ['teacher', { authorization: { teacherUid: 'other-teacher' } }],
        ['release', { authorization: { releaseId: 'other-release' } }],
        ['change', { authorization: { changeId: 'other-change' } }],
      ]) {
        assert.throws(
          () => recoverAuthorizedLoginCode({
            manifest: manifestBinding(),
            preflightAuthorization: preflightAuthorization(args.authorization),
            preflightAuthorizationSha256: authorizationSha,
            credentialSha256: args.credentialSha256 ?? credentialSha,
          }),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED),
          `${label} mismatch must block`,
        )
      }
    })

    it('rejects a non-canonical code in the re-presented artifact', () => {
      for (const variant of ['bcdfghjk', 'BCDF-GHJK', ' BCDFGHJK']) {
        assert.throws(
          () => recoverAuthorizedLoginCode({
            manifest: manifestBinding(),
            preflightAuthorization: preflightAuthorization({
              studentLoginCode: variant,
            }),
            preflightAuthorizationSha256: authorizationSha,
            credentialSha256: credentialSha,
          }),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS),
          `${variant} must be rejected`,
        )
      }
    })
  })

  describe('append-only hash-chained journal', () => {
    it('installs a header and chains successors by predecessor digest', async () => {
      await withTempState(async root => {
        const journal = journalFor(root)
        const first = await journal.append(headerEvent(), {
          expectedSequence: 0, expectedPreviousDigest: null,
        })
        const second = await journal.append(
          { schemaVersion: 1, kind: 'phase3-production-write-journal',
            event: JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT },
          { expectedSequence: 1, expectedPreviousDigest: first.digest },
        )
        const replay = await journal.replay()
        assert.equal(replay.events.length, 2)
        assert.equal(replay.events[0].previousDigest, null)
        assert.equal(replay.events[1].previousDigest, first.digest)
        assert.equal(replay.headDigest, second.digest)
      })
    })

    it('replay rejects an event that does not chain to its predecessor', async () => {
      await withTempState(async root => {
        const journal = journalFor(root)
        await journal.append(headerEvent(), {
          expectedSequence: 0, expectedPreviousDigest: null,
        })
        // Install an event naming a predecessor digest that is not the real
        // header digest. The write itself cannot know it is wrong — the chain is
        // what makes it detectable, and replay is where that check lives.
        await journal.append(
          { schemaVersion: 1, kind: 'phase3-production-write-journal',
            event: JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT },
          { expectedSequence: 1, expectedPreviousDigest: sha256('wrong') },
        )
        await assert.rejects(
          journal.replay(),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT),
          'a broken chain must be rejected on replay',
        )
      })
    })

    it('detects a tampered mid-chain event on replay', async () => {
      await withTempState(async root => {
        const journal = journalFor(root)
        const first = await journal.append(headerEvent(), {
          expectedSequence: 0, expectedPreviousDigest: null,
        })
        await journal.append(
          { schemaVersion: 1, kind: 'phase3-production-write-journal',
            event: JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT },
          { expectedSequence: 1, expectedPreviousDigest: first.digest },
        )
        // Rewrite event 0 with different-but-valid content. Its digest changes,
        // so event 1's recorded predecessor no longer matches.
        const { writeFile, chmod } = await import('node:fs/promises')
        const target = path.join(journal.directory, '000000.json')
        await chmod(target, 0o600)
        await writeFile(
          target,
          serializeCanonicalState(headerEvent({ planDigest: sha256('tampered') })),
          'utf8',
        )
        await assert.rejects(
          journal.replay(),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT),
        )
      })
    })

    it('arbitrates a concurrent identical event and rejects a fork', async () => {
      await withTempState(async root => {
        const journal = journalFor(root)
        const first = await journal.append(headerEvent(), {
          expectedSequence: 0, expectedPreviousDigest: null,
        })

        const identical = {
          schemaVersion: 1, kind: 'phase3-production-write-journal',
          event: JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT,
        }
        // Two processes observed the same predecessor and intend the SAME next
        // event. Exactly one file exists afterwards and both calls succeed.
        const a = await journal.append(identical, {
          expectedSequence: 1, expectedPreviousDigest: first.digest,
        })
        const b = await journal.append(identical, {
          expectedSequence: 1, expectedPreviousDigest: first.digest,
        })
        assert.equal(a.digest, b.digest)
        assert.equal(b.installedByPeer, true)
        const names = (await readdir(journal.directory))
          .filter(name => name.endsWith('.json'))
        assert.deepEqual(names.sort(), ['000000.json', '000001.json'])

        // A DIFFERENT event at the same sequence is a fork and must block.
        await assert.rejects(
          journal.append(
            { schemaVersion: 1, kind: 'phase3-production-write-journal',
              event: JOURNAL_EVENTS.INDETERMINATE },
            { expectedSequence: 1, expectedPreviousDigest: first.digest },
          ),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.JOURNAL_CONFLICT),
        )
      })
    })

    it('never overwrites or renames over an installed event', async () => {
      await withTempState(async root => {
        const linkCalls = []
        const renameCalls = []
        const journal = journalFor(root, {
          fs: {
            link: async (from, to) => {
              linkCalls.push(to)
              const { link } = await import('node:fs/promises')
              return link(from, to)
            },
            rename: async (...args) => { renameCalls.push(args); },
          },
        })
        await journal.append(headerEvent(), {
          expectedSequence: 0, expectedPreviousDigest: null,
        })
        assert.equal(linkCalls.length, 1, 'install must use link, not rename')
        assert.equal(renameCalls.length, 0, 'rename must never be used')

        // The installed file is read-only, so an accidental rewrite fails loudly.
        const mode = (await stat(path.join(journal.directory, '000000.json'))).mode
        assert.equal(mode & 0o200, 0, 'an installed event must not be writable')
      })
    })

    it('fsyncs the file and the directory before reporting durability', async () => {
      await withTempState(async root => {
        let fileSyncs = 0
        let directorySyncs = 0
        const { open: realOpen } = await import('node:fs/promises')
        const journal = journalFor(root, {
          fs: {
            open: async (...args) => {
              const handle = await realOpen(...args)
              const originalSync = handle.sync.bind(handle)
              handle.sync = async () => { fileSyncs += 1; return originalSync() }
              return handle
            },
            syncDirectory: async () => { directorySyncs += 1 },
          },
        })
        await journal.append(headerEvent(), {
          expectedSequence: 0, expectedPreviousDigest: null,
        })
        assert.equal(fileSyncs, 1, 'the event bytes must be fsynced')
        assert.equal(directorySyncs, 1, 'the directory link must be fsynced')
      })
    })

    it('a journal durability failure never reports success', async () => {
      await withTempState(async root => {
        // Failure injected at the link (install) point.
        const journal = journalFor(root, {
          fs: {
            link: async () => {
              const error = new Error('disk full')
              error.code = 'ENOSPC'
              throw error
            },
          },
        })
        await assert.rejects(
          journal.append(headerEvent(), {
            expectedSequence: 0, expectedPreviousDigest: null,
          }),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.JOURNAL_WRITE_FAILED),
        )
        const replay = await journal.replay()
        assert.equal(replay.events.length, 0, 'no event may be visible')
      })
    })

    it('fails closed on a directory fsync failure', async () => {
      await withTempState(async root => {
        const journal = journalFor(root, {
          fs: { syncDirectory: async () => { throw new Error('fsync failed') } },
        })
        await assert.rejects(
          journal.append(headerEvent(), {
            expectedSequence: 0, expectedPreviousDigest: null,
          }),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.JOURNAL_WRITE_FAILED),
        )
      })
    })

    it('rejects a gap in the sequence', async () => {
      await withTempState(async root => {
        const journal = journalFor(root)
        const first = await journal.append(headerEvent(), {
          expectedSequence: 0, expectedPreviousDigest: null,
        })
        await journal.append(
          { schemaVersion: 1, kind: 'phase3-production-write-journal',
            event: JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT },
          { expectedSequence: 2, expectedPreviousDigest: first.digest },
        )
        await assert.rejects(
          journal.replay(),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT),
        )
      })
    })

    it('rejects an illegal state transition', async () => {
      await withTempState(async root => {
        const journal = journalFor(root)
        const first = await journal.append(headerEvent(), {
          expectedSequence: 0, expectedPreviousDigest: null,
        })
        // planned -> completed is not a legal successor.
        await journal.append(
          { schemaVersion: 1, kind: 'phase3-production-write-journal',
            event: JOURNAL_EVENTS.COMPLETED },
          { expectedSequence: 1, expectedPreviousDigest: first.digest },
        )
        await assert.rejects(
          journal.replay(),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT),
        )
      })
    })

    it('exposes no cleanup, prune, or delete operation', () => {
      const journal = createWriteJournal({
        preflightManifestId: MANIFEST_ID, stateRoot: tmpdir(),
      })
      assert.deepEqual(
        Object.keys(journal).sort(), ['append', 'directory', 'replay'],
      )
      for (const forbidden of ['cleanup', 'prune', 'delete', 'remove', 'reset']) {
        assert.equal(journal[forbidden], undefined)
      }
    })
  })

  describe('journal secret scanning', () => {
    it('blocks sensitive keys, codes, bodies, and raw paths', () => {
      const cases = [
        ['pin', { pin: '1234' }],
        ['pinHash', { pinHash: '$2a$12$abcdefghijklmnopqrst' }],
        ['email', { email: 'student@example.com' }],
        ['token', { token: 'abc' }],
        ['raw code', { loginCode: CANONICAL_CODE }],
        ['document body', { data: { balance: 5 } }],
        ['raw path key', { path: 'classrooms/x/students/1' }],
        ['credential path', { credentialPath: '/tmp/key.json' }],
      ]
      for (const [label, payload] of cases) {
        assert.throws(
          () => assertNoJournalSecrets(payload),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.SECRET_MATERIAL),
          `${label} must be blocked`,
        )
      }
    })

    it('blocks a raw Firestore path appearing as a value', () => {
      assert.throws(
        () => assertNoJournalSecrets({ note: 'classrooms/alpha/students/3' }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.SECRET_MATERIAL),
      )
    })

    it('permits hashes, counts, and classifications', () => {
      assert.doesNotThrow(() => assertNoJournalSecrets({
        destinationPathSha256: sha256('classrooms/alpha/students/3'),
        loginCodeSha256: sha256(CANONICAL_CODE),
        batchIndex: 0,
        operationCount: 12,
        expectedBefore: 'absent',
      }))
    })

    it('an installed event contains no sensitive material', async () => {
      await withTempState(async root => {
        const journal = journalFor(root)
        await journal.append(headerEvent({
          loginCodeSha256: sha256(CANONICAL_CODE),
          teacherUidSha256: sha256(TEACHER_UID),
        }), { expectedSequence: 0, expectedPreviousDigest: null })
        const bytes = await readFile(
          path.join(journal.directory, '000000.json'), 'utf8',
        )
        for (const forbidden of [
          CANONICAL_CODE, FORMATTED_CODE, TEACHER_UID,
          'classrooms/', 'teachers/', 'studentCredentials',
        ]) {
          assert.ok(
            !bytes.includes(forbidden),
            `the journal must not contain ${forbidden}`,
          )
        }
      })
    })
  })

  describe('deterministic copy plan', () => {
    function projectionFixture(studentCount = 3) {
      const students = Array.from({ length: studentCount }, (unused, index) => ({
        id: String(index + 1),
        path: `classrooms/${CLASSROOM_ID}/students/${index + 1}`,
        data: { id: index + 1, name: `S${index}`, balance: 0, frozen: false,
          transactions: [] },
      }))
      return {
        classroomId: CLASSROOM_ID,
        classroom: {
          id: CLASSROOM_ID,
          path: `classrooms/${CLASSROOM_ID}`,
          data: { settings: { theme: 'v2' }, lastBackupAt: null },
        },
        students,
        transactions: [],
        loginHistory: [],
        scopedCredentials: [],
        scopedAuthLogs: [],
      }
    }

    it('orders operations classroom, students, transactions, history, credentials, logs', () => {
      assert.deepEqual([...COPY_SURFACE_ORDER], [
        'classroom', 'students', 'transactions', 'loginHistory',
        'scopedCredentials', 'scopedAuthLogs',
      ])
      const plan = buildCopyPlan({
        projection: projectionFixture(),
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
      })
      const surfaces = plan.batches.flatMap(
        batch => batch.operations.map(operation => operation.surface),
      )
      assert.equal(surfaces[0], 'classroom')
      // Surface order is non-decreasing across the whole plan.
      const rank = surfaces.map(surface => COPY_SURFACE_ORDER.indexOf(surface))
      assert.deepEqual(rank, [...rank].sort((a, b) => a - b))
    })

    it('produces a stable plan digest across rebuilds', () => {
      const build = () => buildCopyPlan({
        projection: projectionFixture(5),
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
      })
      assert.equal(build().planDigest, build().planDigest)
    })

    it('bounds batches at 400 writes', () => {
      const plan = buildCopyPlan({
        projection: projectionFixture(1000),
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
      })
      for (const batch of plan.batches) {
        assert.ok(
          batch.operations.length <= 400,
          `batch ${batch.batchIndex} exceeded the 400-write cap`,
        )
      }
      assert.equal(plan.operationCount, 1001)
      assert.ok(plan.batches.length >= 3)
    })

    it('aborts on a single oversized operation', () => {
      const projection = projectionFixture(1)
      projection.students[0].data.blob = 'x'.repeat(9 * 1024 * 1024)
      assert.throws(
        () => buildCopyPlan({
          projection,
          foundation: foundationFixture(),
          initialization: INITIALIZATION,
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.PLAN_DIVERGED),
      )
    })

    it('creates destinations and never deletes or overwrites', () => {
      const plan = buildCopyPlan({
        projection: projectionFixture(),
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
      })
      const types = new Set(plan.batches.flatMap(
        batch => batch.operations.map(operation => operation.type),
      ))
      assert.deepEqual([...types].sort(), ['create', 'update'])
      assert.ok(!types.has('delete'), 'no delete operation may be planned')
      assert.ok(!types.has('set'), 'no blind set may be planned')
    })

    it('never targets a flat credential, flat log, teacher, or legacy source', () => {
      const plan = buildCopyPlan({
        projection: projectionFixture(),
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
      })
      for (const batch of plan.batches) {
        for (const operation of batch.operations) {
          assert.ok(!/^studentCredentials\//.test(operation.path))
          assert.ok(!/^studentAuthLogs\/[^/]+$/.test(operation.path))
          assert.ok(!/^teachers\//.test(operation.path))
          assert.ok(!/^morganBank\//.test(operation.path))
        }
      }
    })
  })

  describe('initialization transaction', () => {
    function seedFoundation(extra = {}) {
      return {
        [`teachers/${TEACHER_UID}`]: teacherDoc(),
        [`classrooms/${CLASSROOM_ID}`]: classroomDoc(extra),
      }
    }

    it('touches exactly the classroom root and the code index', async () => {
      const { firestore, documents, calls } = createFakeFirestore(seedFoundation())
      await runInitializationTransaction({
        firestore,
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
        initializedAt: INITIALIZED_AT,
        manifest: eligibleManifest(),
      })

      assert.deepEqual(
        calls.writes.map(write => write.path).sort(),
        [`classroomLoginCodes/${CANONICAL_CODE}`, `classrooms/${CLASSROOM_ID}`],
      )
      // The teacher document is read but never written.
      assert.ok(calls.reads.includes(`teachers/${TEACHER_UID}`))
      assert.ok(!calls.writes.some(
        write => write.path === `teachers/${TEACHER_UID}`,
      ))
      // No invitation is created.
      assert.ok(![...documents.keys()].some(key => key.startsWith('invitations/')))
    })

    it('preserves every other classroom field exactly', async () => {
      const { firestore, documents } = createFakeFirestore(seedFoundation())
      // Captured by reference before the write; the double stores a fresh object
      // on update, so this snapshot is not mutated in place.
      const before = { ...documents.get(`classrooms/${CLASSROOM_ID}`).data }
      await runInitializationTransaction({
        firestore,
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
        initializedAt: INITIALIZED_AT,
        manifest: eligibleManifest(),
      })
      const after = documents.get(`classrooms/${CLASSROOM_ID}`).data
      assert.equal(after.studentLoginCode, FORMATTED_CODE)
      assert.equal(after.nextStudentNumber, 12)
      for (const key of Object.keys(before)) {
        // Compared through the canonical encoder so a Timestamp is judged by its
        // exact seconds/nanoseconds rather than by object identity.
        assert.equal(
          serializeCanonicalState(encodeCanonicalFirestoreValue(after[key])),
          serializeCanonicalState(encodeCanonicalFirestoreValue(before[key])),
          `${key} must be preserved`,
        )
      }
      // No field was added or removed beyond the two initialization fields.
      assert.deepEqual(
        Object.keys(after).sort(),
        [...new Set([...Object.keys(before),
          'studentLoginCode', 'nextStudentNumber'])].sort(),
      )
      // updatedAt is NOT introduced or modified: the default contract is
      // preservation.
      assert.equal(Object.hasOwn(after, 'updatedAt'), false)
    })

    it('writes the code index with exactly the reviewed fields', async () => {
      const { firestore, documents } = createFakeFirestore(seedFoundation())
      await runInitializationTransaction({
        firestore,
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
        initializedAt: INITIALIZED_AT,
        manifest: eligibleManifest(),
      })
      const index = documents.get(`classroomLoginCodes/${CANONICAL_CODE}`)
      assert.deepEqual(Object.keys(index.data).sort(),
        ['classroomId', 'createdAt', 'status'])
      assert.equal(index.data.classroomId, CLASSROOM_ID)
      assert.equal(index.data.status, 'active')
      // The exact pre-captured Timestamp, not a server-assigned value.
      assert.equal(index.data.createdAt, INITIALIZED_AT)
    })

    it('performs every read before any write', async () => {
      const { firestore, calls } = createFakeFirestore(seedFoundation())
      await runInitializationTransaction({
        firestore,
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
        initializedAt: INITIALIZED_AT,
        manifest: eligibleManifest(),
      })
      const firstWrite = calls.order.findIndex(entry => entry.op !== 'read')
      const lastRead = calls.order.map(entry => entry.op)
        .lastIndexOf('read')
      assert.ok(lastRead < firstWrite, 'all reads must precede all writes')
    })

    it('is retry-safe and reuses the exact captured timestamp', async () => {
      // Force one transaction retry. A callback with a side effect or a
      // re-derived timestamp would produce a different result here.
      const { firestore, documents, calls } = createFakeFirestore(
        seedFoundation(), { retries: 1 },
      )
      await runInitializationTransaction({
        firestore,
        foundation: foundationFixture(),
        initialization: INITIALIZATION,
        initializedAt: INITIALIZED_AT,
        manifest: eligibleManifest(),
      })
      assert.equal(calls.transactions, 2, 'the callback must have been retried')
      assert.equal(
        documents.get(`classroomLoginCodes/${CANONICAL_CODE}`).data.createdAt,
        INITIALIZED_AT,
      )
      assert.equal(calls.writes.length, 2, 'exactly two writes may be applied')
    })

    it('blocks a code collision without overwriting the existing index', async () => {
      const seed = seedFoundation()
      seed[`classroomLoginCodes/${CANONICAL_CODE}`] = {
        data: { classroomId: 'someone-else', status: 'active' },
        updateTime: FakeTimestamp(1_600_000_000, 0),
      }
      const { firestore, documents } = createFakeFirestore(seed)
      await assert.rejects(
        runInitializationTransaction({
          firestore,
          foundation: foundationFixture(),
          initialization: INITIALIZATION,
          initializedAt: INITIALIZED_AT,
          manifest: eligibleManifest(),
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED),
      )
      assert.equal(
        documents.get(`classroomLoginCodes/${CANONICAL_CODE}`).data.classroomId,
        'someone-else',
        'an existing code index must never be overwritten',
      )
    })

    it('blocks an absent, non-reciprocal, or inactive foundation', async () => {
      const variants = [
        ['absent teacher', {}],
        ['absent classroom', { [`teachers/${TEACHER_UID}`]: teacherDoc() }],
        ['inactive teacher', {
          [`teachers/${TEACHER_UID}`]: {
            data: { uid: TEACHER_UID, classroomId: CLASSROOM_ID,
              status: 'suspended' },
            updateTime: FakeTimestamp(1_700_000_000, 1),
          },
          [`classrooms/${CLASSROOM_ID}`]: classroomDoc(),
        }],
        ['non-reciprocal classroom', {
          [`teachers/${TEACHER_UID}`]: teacherDoc(),
          [`classrooms/${CLASSROOM_ID}`]: {
            data: { ownerUid: 'other-owner' },
            updateTime: FakeTimestamp(1_700_000_000, 3),
          },
        }],
      ]
      for (const [label, seed] of variants) {
        const { firestore, calls } = createFakeFirestore(seed)
        await assert.rejects(
          runInitializationTransaction({
            firestore,
            foundation: foundationFixture(),
            initialization: INITIALIZATION,
            initializedAt: INITIALIZED_AT,
            manifest: eligibleManifest(),
          }),
          error => error instanceof ProductionWriterError,
          `${label} must block`,
        )
        assert.equal(calls.writes.length, 0, `${label} must write nothing`)
      }
    })

    it('blocks when the foundation drifted from the retained evidence', async () => {
      const { firestore, calls } = createFakeFirestore(
        seedFoundation({ name: 'Renamed After Preflight' }),
      )
      await assert.rejects(
        runInitializationTransaction({
          firestore,
          // The digest was computed over the ORIGINAL classroom body.
          foundation: foundationFixture(),
          initialization: INITIALIZATION,
          initializedAt: INITIALIZED_AT,
          manifest: eligibleManifest(),
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED),
      )
      assert.equal(calls.writes.length, 0)
    })

    it('refuses to renumber an already-initialized classroom', async () => {
      const { firestore, calls } = createFakeFirestore(seedFoundation({
        studentLoginCode: 'WXYZ-WXYZ', nextStudentNumber: 40,
      }))
      await assert.rejects(
        runInitializationTransaction({
          firestore,
          foundation: foundationFixture({
            studentLoginCode: 'WXYZ-WXYZ', nextStudentNumber: 40,
          }),
          initialization: INITIALIZATION,
          initializedAt: INITIALIZED_AT,
          manifest: eligibleManifest(),
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED),
      )
      assert.equal(calls.writes.length, 0, 'the counter must never be reduced')
    })
  })

  describe('copy batch transactions', () => {
    function copyBatch() {
      return {
        batchIndex: 0,
        batchDigest: sha256('batch'),
        operations: [
          {
            operationId: 'op-000000',
            surface: 'students',
            type: 'create',
            path: `classrooms/${CLASSROOM_ID}/students/1`,
            data: { id: 1, name: 'A', balance: 0, frozen: false, transactions: [] },
            expectedBefore: 'absent',
          },
          {
            operationId: 'op-000001',
            surface: 'scopedCredentials',
            type: 'create',
            path: `classrooms/${CLASSROOM_ID}/studentCredentials/a.b`,
            data: { studentId: 1, classroomId: CLASSROOM_ID, authUid: 's_x' },
            sourcePath: 'studentCredentials/a.b',
            sourceUpdateTime: { seconds: 1_600_000_000, nanoseconds: 5 },
            expectedBefore: 'absent',
          },
        ],
      }
    }

    function copySeed() {
      return {
        'studentCredentials/a.b': {
          data: { studentId: 1, loginId: 'a.b' },
          updateTime: FakeTimestamp(1_600_000_000, 5),
        },
      }
    }

    it('creates absent targets after proving source preconditions', async () => {
      const { firestore, documents, calls } = createFakeFirestore(copySeed())
      const result = await commitCopyBatch({ firestore, batch: copyBatch() })
      assert.equal(result.applied, 2)
      assert.equal(result.skipped, 0)
      assert.ok(documents.has(`classrooms/${CLASSROOM_ID}/students/1`))
      // The immutable flat source was read and left untouched.
      assert.ok(calls.reads.includes('studentCredentials/a.b'))
      assert.ok(!calls.writes.some(
        write => write.path === 'studentCredentials/a.b',
      ))
    })

    it('performs all reads before all writes', async () => {
      const { firestore, calls } = createFakeFirestore(copySeed())
      await commitCopyBatch({ firestore, batch: copyBatch() })
      const firstWrite = calls.order.findIndex(entry => entry.op !== 'read')
      const lastRead = calls.order.map(entry => entry.op).lastIndexOf('read')
      assert.ok(lastRead < firstWrite)
    })

    it('aborts when an immutable source changed after planning', async () => {
      const seed = copySeed()
      seed['studentCredentials/a.b'].updateTime =
        FakeTimestamp(1_600_000_099, 5)
      const { firestore, calls } = createFakeFirestore(seed)
      await assert.rejects(
        commitCopyBatch({ firestore, batch: copyBatch() }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED),
      )
      assert.equal(calls.writes.length, 0)
    })

    it('aborts when an immutable source disappeared', async () => {
      const { firestore, calls } = createFakeFirestore({})
      await assert.rejects(
        commitCopyBatch({ firestore, batch: copyBatch() }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED),
      )
      assert.equal(calls.writes.length, 0)
    })

    it('skips a target already exactly expected-after without rewriting', async () => {
      // The crash-after-commit recovery case: the destination already holds
      // exactly what this batch would write.
      const batch = copyBatch()
      const seed = copySeed()
      for (const operation of batch.operations) {
        seed[operation.path] = {
          data: { ...operation.data },
          updateTime: FakeTimestamp(1_700_000_000, 7),
        }
      }
      const { firestore, calls } = createFakeFirestore(seed)
      const result = await commitCopyBatch({ firestore, batch })
      assert.equal(result.applied, 0)
      assert.equal(result.skipped, 2)
      assert.equal(calls.writes.length, 0, 'no duplicate write may occur')
    })

    it('aborts when a target exists with unexpected content', async () => {
      const batch = copyBatch()
      const seed = copySeed()
      seed[batch.operations[0].path] = {
        data: { id: 1, name: 'SOMEONE ELSE', balance: 999, frozen: false,
          transactions: [] },
        updateTime: FakeTimestamp(1_700_000_000, 7),
      }
      const { firestore, calls } = createFakeFirestore(seed)
      await assert.rejects(
        commitCopyBatch({ firestore, batch }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED),
      )
      assert.equal(calls.writes.length, 0)
    })

    it('is retry-safe: a forced retry applies each write exactly once', async () => {
      const { firestore, calls } = createFakeFirestore(copySeed(), { retries: 2 })
      const result = await commitCopyBatch({ firestore, batch: copyBatch() })
      assert.equal(calls.transactions, 3)
      assert.equal(result.applied, 2)
      assert.equal(calls.writes.length, 2, 'retries must not duplicate writes')
    })

    it('never invokes a delete or blind set', async () => {
      // The Firestore double throws on delete()/set(); reaching either fails.
      const { firestore } = createFakeFirestore(copySeed())
      await assert.doesNotReject(
        commitCopyBatch({ firestore, batch: copyBatch() }),
      )
    })
  })

  describe('batch recovery classification', () => {
    const batch = {
      batchIndex: 0,
      operations: [
        { operationId: 'op-0', type: 'create', surface: 'students',
          path: 'classrooms/c/students/1', data: { id: 1 } },
        { operationId: 'op-1', type: 'create', surface: 'students',
          path: 'classrooms/c/students/2', data: { id: 2 } },
      ],
    }

    it('classifies an untouched batch as all-expected-before', () => {
      const observed = new Map([
        ['classrooms/c/students/1', { exists: false }],
        ['classrooms/c/students/2', { exists: false }],
      ])
      assert.equal(
        classifyBatchState(batch, observed), BATCH_CLASSIFICATIONS.ALL_BEFORE,
      )
    })

    it('classifies a fully applied batch as all-expected-after', () => {
      const observed = new Map([
        ['classrooms/c/students/1', { exists: true, data: { id: 1 } }],
        ['classrooms/c/students/2', { exists: true, data: { id: 2 } }],
      ])
      assert.equal(
        classifyBatchState(batch, observed), BATCH_CLASSIFICATIONS.ALL_AFTER,
      )
    })

    it('classifies a partially applied batch as mixed', () => {
      // A Firestore transaction is atomic, so this is evidence of interference
      // or a broken assumption — never a success and never a blind retry.
      const observed = new Map([
        ['classrooms/c/students/1', { exists: true, data: { id: 1 } }],
        ['classrooms/c/students/2', { exists: false }],
      ])
      assert.equal(
        classifyBatchState(batch, observed), BATCH_CLASSIFICATIONS.MIXED,
      )
    })

    it('classifies a divergent body as mixed rather than after', () => {
      const observed = new Map([
        ['classrooms/c/students/1', { exists: true, data: { id: 1 } }],
        ['classrooms/c/students/2', { exists: true, data: { id: 999 } }],
      ])
      assert.equal(
        classifyBatchState(batch, observed), BATCH_CLASSIFICATIONS.MIXED,
      )
    })
  })

  describe('stage derivation', () => {
    it('starts at the initialization stage with no journal', () => {
      assert.equal(
        deriveStage({ exists: false, events: [] }).stage,
        WRITE_STAGES.INITIALIZATION,
      )
    })

    it('remains at initialization until awaiting-copy-deployment', () => {
      for (const kind of [
        JOURNAL_EVENTS.PLANNED,
        JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT,
        JOURNAL_EVENTS.INITIALIZATION_VERIFIED,
      ]) {
        assert.equal(
          deriveStage({
            exists: true, events: [{ event: kind }], head: { event: kind },
          }).stage,
          WRITE_STAGES.INITIALIZATION,
          `${kind} must remain at the initialization stage`,
        )
      }
    })

    it('moves to copy only from awaiting-copy-deployment onward', () => {
      for (const kind of [
        JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT,
        JOURNAL_EVENTS.BATCH_IN_FLIGHT,
        JOURNAL_EVENTS.BATCH_COMMITTED,
        JOURNAL_EVENTS.BATCH_VERIFIED,
        JOURNAL_EVENTS.COPY_VERIFYING,
      ]) {
        assert.equal(
          deriveStage({
            exists: true, events: [{ event: kind }], head: { event: kind },
          }).stage,
          WRITE_STAGES.COPY,
        )
      }
    })

    it('blocks on indeterminate or failed and completes on completed', () => {
      for (const kind of [JOURNAL_EVENTS.INDETERMINATE, JOURNAL_EVENTS.FAILED]) {
        assert.equal(
          deriveStage({
            exists: true, events: [{ event: kind }], head: { event: kind },
          }).stage,
          WRITE_STAGES.BLOCKED,
        )
      }
      assert.equal(
        deriveStage({
          exists: true,
          events: [{ event: JOURNAL_EVENTS.COMPLETED }],
          head: { event: JOURNAL_EVENTS.COMPLETED },
        }).stage,
        WRITE_STAGES.COMPLETE,
      )
    })
  })

  describe('deployment expectations', () => {
    const observed = {
      rules: { release: 'bridge-1' },
      functions: { studentPinLoginV2: 'rev-7' },
      hosting: { release: 'hosting-default-off' },
      indexes: { composite: 'none' },
      gateParameters: { MULTI_TEACHER_V2_ENABLED: 'false' },
      activeWriters: ['legacy-teacher-browser'],
    }
    const expectations = {
      rules: { release: 'bridge-1' },
      functions: { studentPinLoginV2: 'rev-7' },
      hosting: { release: 'hosting-default-off' },
      indexes: { composite: 'none' },
      gateParameters: { MULTI_TEACHER_V2_ENABLED: 'false' },
      acknowledgedWriters: ['legacy-teacher-browser'],
    }

    it('accepts an exactly matching copy-stage inventory', () => {
      assert.equal(
        assertDeploymentExpectations({
          observed, expectations, stage: WRITE_STAGES.COPY,
        }),
        true,
      )
    })

    it('blocks the copy stage when the V2 gate is on', () => {
      assert.throws(
        () => assertDeploymentExpectations({
          observed: {
            ...observed,
            gateParameters: { MULTI_TEACHER_V2_ENABLED: 'true' },
          },
          expectations: {
            ...expectations,
            gateParameters: { MULTI_TEACHER_V2_ENABLED: 'true' },
          },
          stage: WRITE_STAGES.COPY,
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT),
      )
    })

    it('blocks on drift in any inspected surface', () => {
      for (const surface of ['rules', 'functions', 'hosting', 'indexes']) {
        assert.throws(
          () => assertDeploymentExpectations({
            observed: { ...observed, [surface]: { release: 'unexpected' } },
            expectations,
            stage: WRITE_STAGES.COPY,
          }),
          assertWriterError(PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT),
          `${surface} drift must block`,
        )
      }
    })

    it('blocks on an unacknowledged active writer', () => {
      assert.throws(
        () => assertDeploymentExpectations({
          observed: { ...observed, activeWriters: ['unknown-process'] },
          expectations,
          stage: WRITE_STAGES.COPY,
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT),
      )
    })

    it('requires the expectations to enumerate acknowledged writers', () => {
      const { acknowledgedWriters, ...withoutWriters } = expectations
      assert.ok(acknowledgedWriters)
      assert.throws(
        () => assertDeploymentExpectations({
          observed, expectations: withoutWriters, stage: WRITE_STAGES.COPY,
        }),
        assertWriterError(PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT),
      )
    })
  })

  describe('two-invocation stage separation', () => {
    /** A journal double that records appended events in memory. */
    function fakeJournal(initialEvents = []) {
      const events = [...initialEvents]
      return {
        events,
        directory: '/dev/null',
        async replay() {
          if (events.length === 0) return { exists: false, events: [] }
          return {
            exists: true,
            events,
            head: events.at(-1),
            headDigest: sha256(String(events.length)),
            nextSequence: events.length,
          }
        },
        async append(event, { expectedSequence }) {
          events.push({ ...event, sequence: expectedSequence })
          return { sequence: expectedSequence, digest: sha256(String(events.length)) }
        },
      }
    }

    const deployment = {
      readInventory: async () => ({
        rules: { release: 'bridge-1' },
        gateParameters: { MULTI_TEACHER_V2_ENABLED: 'false' },
        activeWriters: [],
      }),
      initializationExpectations: {
        rules: { release: 'bridge-1' },
        acknowledgedWriters: [],
      },
      copyExpectations: {
        rules: { release: 'bridge-1' },
        acknowledgedWriters: [],
      },
    }

    function rawReadersFor(documents) {
      return {
        readClassroom: async () => documents.get(`classrooms/${CLASSROOM_ID}`)
          ? {
            exists: true,
            id: CLASSROOM_ID,
            path: `classrooms/${CLASSROOM_ID}`,
            data: documents.get(`classrooms/${CLASSROOM_ID}`).data,
          }
          : { exists: false },
        readLoginCodeIndexDocument: async () =>
          documents.get(`classroomLoginCodes/${CANONICAL_CODE}`)
            ? {
              exists: true,
              id: CANONICAL_CODE,
              path: `classroomLoginCodes/${CANONICAL_CODE}`,
              data: documents.get(`classroomLoginCodes/${CANONICAL_CODE}`).data,
            }
            : { exists: false },
        readDocument: async docPath => documents.get(docPath)
          ? { exists: true, path: docPath, data: documents.get(docPath).data }
          : { exists: false, path: docPath },
      }
    }

    it('first invocation initializes only and reports awaiting deployment', async () => {
      const { firestore, documents, calls } = createFakeFirestore({
        [`teachers/${TEACHER_UID}`]: teacherDoc(),
        [`classrooms/${CLASSROOM_ID}`]: classroomDoc(),
      })
      const journal = fakeJournal()

      const outcome = await runProductionWrite({
        firestore,
        journal,
        manifest: eligibleManifest(),
        authorization: {
          authorizationId: 'AUTH-1', snapshotId: 'SNAP-1',
          writeFreezeProof: 'FREEZE-1', credentialProvenance: 'PROV-1',
          writeAuthorizationSha256: sha256('wa'),
          preflightAuthorizationSha256: sha256('pa'),
          credentialSha256: sha256('cred'),
          initializationExpectationsSha256: sha256('init-exp'),
          copyExpectationsSha256: sha256('copy-exp'),
        },
        initialization: {
          ...INITIALIZATION,
          projection: { classroomId: CLASSROOM_ID },
          planDigest: sha256('plan'),
          batchCount: 1,
          countsBySurface: {},
        },
        foundation: foundationFixture(),
        deployment,
        rawReaders: rawReadersFor(documents),
        nowTimestamp: INITIALIZED_AT,
        logger: { log() {}, error() {} },
      })

      assert.equal(outcome.result, WRITE_RESULTS.AWAITING_DEPLOYMENT)
      assert.equal(outcome.migrationRan, false)

      // ONLY the two initialization writes occurred. No student, transaction,
      // history, credential, or log document exists.
      assert.deepEqual(
        calls.writes.map(write => write.path).sort(),
        [`classroomLoginCodes/${CANONICAL_CODE}`, `classrooms/${CLASSROOM_ID}`],
      )
      const copyPaths = [...documents.keys()].filter(key =>
        /\/(students|transactions|loginHistory|studentCredentials|logs)\//
          .test(key))
      assert.deepEqual(copyPaths, [], 'no copy document may exist yet')

      // The journal stops at awaiting-copy-deployment.
      assert.equal(journal.events.at(-1).event,
        JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT)
      assert.ok(!journal.events.some(
        entry => entry.event === JOURNAL_EVENTS.BATCH_IN_FLIGHT,
      ))
    })

    it('reports already completed without writing', async () => {
      const { firestore, calls } = createFakeFirestore({})
      const outcome = await runProductionWrite({
        firestore,
        journal: fakeJournal([{ event: JOURNAL_EVENTS.COMPLETED }]),
        manifest: eligibleManifest(),
        authorization: {},
        initialization: INITIALIZATION,
        foundation: foundationFixture(),
        deployment,
        rawReaders: {},
        nowTimestamp: INITIALIZED_AT,
        logger: { log() {}, error() {} },
      })
      assert.equal(outcome.result, WRITE_RESULTS.ALREADY_COMPLETED)
      assert.equal(calls.writes.length, 0)
    })

    it('blocks on an indeterminate head without writing', async () => {
      const { firestore, calls } = createFakeFirestore({})
      const outcome = await runProductionWrite({
        firestore,
        journal: fakeJournal([{ event: JOURNAL_EVENTS.INDETERMINATE }]),
        manifest: eligibleManifest(),
        authorization: {},
        initialization: INITIALIZATION,
        foundation: foundationFixture(),
        deployment,
        rawReaders: {},
        nowTimestamp: INITIALIZED_AT,
        logger: { log() {}, error() {} },
      })
      assert.equal(outcome.result, WRITE_RESULTS.BLOCKED_INDETERMINATE)
      assert.equal(calls.writes.length, 0)
    })

    it('recovers a crash after commit before the journal event', async () => {
      // The mandatory recovery control: initialization committed remotely, but
      // the process died before the verified event was installed.
      const { firestore, documents, calls } = createFakeFirestore({
        [`teachers/${TEACHER_UID}`]: teacherDoc(),
        [`classrooms/${CLASSROOM_ID}`]: classroomDoc({
          studentLoginCode: FORMATTED_CODE, nextStudentNumber: 12,
        }),
        [`classroomLoginCodes/${CANONICAL_CODE}`]: {
          data: { classroomId: CLASSROOM_ID, status: 'active',
            createdAt: INITIALIZED_AT },
          updateTime: INITIALIZED_AT,
        },
      })
      const journal = fakeJournal([
        { event: JOURNAL_EVENTS.PLANNED },
        { event: JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT },
      ])

      const outcome = await runProductionWrite({
        firestore,
        journal,
        manifest: eligibleManifest(),
        authorization: {},
        initialization: INITIALIZATION,
        foundation: foundationFixture(),
        deployment,
        rawReaders: rawReadersFor(documents),
        nowTimestamp: INITIALIZED_AT,
        logger: { log() {}, error() {} },
      })

      assert.equal(outcome.result, WRITE_RESULTS.AWAITING_DEPLOYMENT)
      // Recovery reclassified remote state rather than retrying the write.
      assert.equal(calls.writes.length, 0, 'recovery must not duplicate writes')
      const verified = journal.events.find(
        entry => entry.event === JOURNAL_EVENTS.INITIALIZATION_VERIFIED,
      )
      assert.equal(verified.recoveredByClassification, true)
    })

    it('blocks a partially applied initialization as indeterminate', async () => {
      // Classroom updated but the code index missing: a transaction should be
      // atomic, so this is interference and must never be auto-repaired.
      const { firestore, documents, calls } = createFakeFirestore({
        [`teachers/${TEACHER_UID}`]: teacherDoc(),
        [`classrooms/${CLASSROOM_ID}`]: classroomDoc({
          studentLoginCode: FORMATTED_CODE, nextStudentNumber: 12,
        }),
      })
      const journal = fakeJournal([
        { event: JOURNAL_EVENTS.PLANNED },
        { event: JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT },
      ])

      const outcome = await runProductionWrite({
        firestore,
        journal,
        manifest: eligibleManifest(),
        authorization: {},
        initialization: INITIALIZATION,
        foundation: foundationFixture(),
        deployment,
        rawReaders: rawReadersFor(documents),
        nowTimestamp: INITIALIZED_AT,
        logger: { log() {}, error() {} },
      })

      assert.equal(outcome.result, WRITE_RESULTS.BLOCKED_INDETERMINATE)
      assert.equal(calls.writes.length, 0)
      assert.equal(journal.events.at(-1).event, JOURNAL_EVENTS.INDETERMINATE)
    })
  })

  describe('write entrypoint ordering', () => {
    it('validates the environment BEFORE constructing any handle', async () => {
      // Mutation-driven (M01). Without this case, replacing the environment
      // guard with a hardcoded production context escaped every suite.
      const { runWriteMain, WRITE_EXIT_CODES } = await import('./write.js')

      let handleFactoryCalls = 0
      let readFileCalls = 0
      const { exitCode } = await runWriteMain([
        '--write-authorization-file', '/artifacts/write.json',
        '--preflight-authorization-file', '/artifacts/preflight.json',
        '--initialization-expectations-file', '/artifacts/init.json',
        '--copy-expectations-file', '/artifacts/copy.json',
        '--credential-file', '/artifacts/credential.json',
      ], {
        // An unapproved project: the guard must refuse it.
        environment: { GCLOUD_PROJECT: 'some-unapproved-project' },
        readFile: async () => { readFileCalls += 1; return '{}' },
        createHandles: async () => {
          handleFactoryCalls += 1
          return { firestore: {}, close: async () => {} }
        },
        logger: { log() {}, error() {} },
      })

      assert.equal(exitCode, WRITE_EXIT_CODES.ENVIRONMENT_REJECTED)
      assert.equal(
        handleFactoryCalls, 0,
        'no Admin/SDK handle may be constructed for a rejected environment',
      )
      assert.equal(
        readFileCalls, 0,
        'no artifact may even be read before the environment is accepted',
      )
    })

    it('rejects the complete forbidden-override vocabulary', async () => {
      const { parseWriteArguments } = await import('./write.js')
      const valid = [
        '--write-authorization-file', '/a.json',
        '--preflight-authorization-file', '/b.json',
        '--initialization-expectations-file', '/c.json',
        '--copy-expectations-file', '/d.json',
        '--credential-file', '/e.json',
      ]
      // The stage is derived from the journal alone; none of these may exist.
      for (const flag of [
        '--stage', '--mode', '--resume', '--retry', '--force', '--dry-run',
        '--teacher-uid', '--project-id', '--release-id', '--manifest-id',
        '--manifest-path', '--state-dir', '--journal-dir', '--login-code',
        '--allow-production', '--bypass', '--skip-preflight',
      ]) {
        assert.throws(
          () => parseWriteArguments([...valid, flag, 'value']),
          error => error.category === 'forbidden-flag',
          `${flag} must be rejected by name`,
        )
      }
      for (const token of [
        'write', 'copy', 'resume', 'migrate', 'deploy', 'rollback', 'cleanup',
      ]) {
        assert.throws(
          () => parseWriteArguments([token, ...valid]),
          error => error.category === 'forbidden-subcommand',
          `${token} must be rejected as a subcommand`,
        )
      }
      // Inline form, duplicates, positionals, and padded values.
      assert.throws(
        () => parseWriteArguments(['--credential-file=/e.json']),
        error => error.category === 'inline-value-rejected',
      )
      assert.throws(
        () => parseWriteArguments([...valid, '--credential-file', '/f.json']),
        error => error.category === 'duplicate-flag',
      )
      assert.throws(
        () => parseWriteArguments([...valid, 'extra']),
        error => error.category === 'positional-argument',
      )
      assert.throws(
        () => parseWriteArguments([
          ...valid.slice(0, 8), '--credential-file', ' /e.json ',
        ]),
        error => error.category === 'invalid-value',
      )
      assert.deepEqual(parseWriteArguments(valid), {
        writeAuthorizationFile: '/a.json',
        preflightAuthorizationFile: '/b.json',
        initializationExpectationsFile: '/c.json',
        copyExpectationsFile: '/d.json',
        credentialFile: '/e.json',
      })
    })
  })

  describe('scope boundary', () => {
    it('the initialization callback reads every document before writing', async () => {
      // Mutation-driven (M21). Source-level, and labelled as such: it pins the
      // structural ordering inside the transaction callback so an added read
      // after the first write — which real Firestore rejects but an in-memory
      // double may tolerate — is caught here.
      const source = await readFile(
        new URL('./productionWriter.js', import.meta.url), 'utf8',
      )
      // Bounded to the initialization transaction specifically, by slicing
      // between its opening call and the function's return.
      const start = source.indexOf(
        'await firestore.runTransaction(async transaction => {',
      )
      const end = source.indexOf(
        'return Object.freeze({\n    classroomPathSha256', start,
      )
      assert.ok(start > 0 && end > start,
        'the initialization callback must be locatable')
      const callback = source.slice(start, end)

      const firstWrite = Math.min(
        ...['transaction.update(', 'transaction.create(']
          .map(marker => callback.indexOf(marker))
          .filter(index => index >= 0),
      )
      const lastRead = callback.lastIndexOf('transaction.get(')
      assert.ok(firstWrite > 0, 'the callback must contain a write')
      assert.ok(lastRead >= 0, 'the callback must contain a read')
      assert.ok(
        lastRead < firstWrite,
        'every transaction.get must precede every transaction write',
      )

      // And the callback must have no filesystem, logging, or journal effect.
      for (const forbidden of [
        'journal.', 'logger.', 'writeFile', 'appendEvent', 'console.',
      ]) {
        assert.ok(
          !callback.includes(forbidden),
          `the transaction callback must not contain ${forbidden}`,
        )
      }
    })

    it('exposes no delete, Auth, or control-plane mutation surface', async () => {
      const source = await readFile(
        new URL('./productionWriter.js', import.meta.url), 'utf8',
      )
      // Deliberately source-level evidence, labelled as such: it proves the
      // module contains no such call site at all, which behavior alone cannot.
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
      // Firestore transactions are used, batches are not.
      assert.ok(source.includes('runTransaction'))
    })
  })
})
