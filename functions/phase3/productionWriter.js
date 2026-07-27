import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, link, unlink, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { URL, fileURLToPath } from 'node:url'

import {
  MAX_BATCH_OPERATIONS,
  MAX_BATCH_PAYLOAD_BYTES,
  ESTIMATED_WRITE_OVERHEAD_BYTES,
} from '../phase2/batchWriter.js'
import {
  encodeCanonicalFirestoreValue,
  serializeCanonicalState,
} from '../phase2/canonicalState.js'
import {
  formatClassroomCode,
  normalizeClassroomCode,
} from '../phase2b/identityNormalization.js'
import {
  DESTINATION_SURFACES,
  deriveStudentIdWatermark,
  sourceEntryFromEnvelope,
  summarizeHashedSource,
} from './productionPreflight.js'
import {
  JOURNAL_EVENTS,
  JOURNAL_KIND,
  JOURNAL_SCHEMA_VERSION,
  LEGAL_TRANSITIONS,
  PRODUCTION_MANIFEST_CATEGORIES,
  ProductionManifestError,
  assertNoJournalSecrets as assertNoJournalSecretsFromManifest,
  computeFoundationStateDigest,
  hashDomain,
  replayWriteJournal,
  validateJournalEvent,
  validateJournalSemantics,
} from './productionManifest.js'
import { buildProductionProjection } from './productionProjection.js'
import {
  readAndReconcileWriteRun,
  reconcileProductionWriteRun,
} from './productionReconciliation.js'

/**
 * Phase 3 Commit 5 — the bounded production writer and its durable journal.
 *
 * Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 2, 5, 8, 9, 11
 * as amended by the Commit 5 builder brief and architect sign-off.
 *
 * This module owns exactly two remote mutations:
 *
 *   1. ONE initialization transaction that reserves the classroom login code and
 *      sets the student counter on an ALREADY EXISTING foundation.
 *   2. A bounded series of copy transactions that project the legacy classroom
 *      into its V2 scoped destination.
 *
 * Everything else is deliberately absent. There is no delete API anywhere in
 * this file, no Auth mutation, no control-plane mutation, and no path that can
 * write a flat credential, a flat auth log, the legacy source, or the teacher
 * document. The foundation is validated, never created: Phase 1 foundation
 * creation does not establish `studentLoginCode` or `nextStudentNumber`, so an
 * identity cannot be safely invented from a manifest that recorded its absence.
 *
 * STAGE DERIVATION. The two mutations happen in two SEPARATE INVOCATIONS,
 * because Release Order steps 10-11 (deploy bridge rules, deploy V2 Functions
 * with the gate off) must happen between them. There is no stage flag, mode
 * argument, or resume switch: the stage is derived solely by replaying the
 * durable journal. The copy path is reachable only from an
 * `awaiting-copy-deployment` event, which only a verified initialization can
 * append. A first invocation therefore cannot reach a copy write even if every
 * other check were bypassed.
 */

/** Zero-padded width for journal sequence filenames. */
const SEQUENCE_WIDTH = 6

/** Bounded replay ceiling; far above any real plan's event count. */

/**
 * The canonical, module-anchored Phase 3 state directory.
 *
 * There is deliberately NO CLI or environment override. Tests inject an
 * isolated root through the dependency object only, so an operator can never
 * redirect the durable record of a production write with an argument.
 */
export const PRODUCTION_STATE_DIRECTORY = fileURLToPath(
  new URL('./.state/', import.meta.url),
)


/**
 * The journal vocabulary and legal transitions are owned by
 * `productionManifest.js` — a module with NO mutation capability — and
 * re-exported here for existing callers. One declaration means the read-only
 * re-verifier and this writer can never disagree about what a valid chain is.
 */
export { JOURNAL_EVENTS, JOURNAL_KIND, JOURNAL_SCHEMA_VERSION, LEGAL_TRANSITIONS }

/** The deterministic copy surface order. Never reordered at runtime. */
/**
 * The complete deployment surface set. Every one must be both expected and
 * observed before any stage runs; there is no optional surface.
 */
export const DEPLOYMENT_SURFACES = Object.freeze([
  'rules',
  'functions',
  'hosting',
  'indexes',
  'gateParameters',
])

export const COPY_SURFACE_ORDER = Object.freeze([
  'classroom',
  'students',
  'transactions',
  'loginHistory',
  'scopedCredentials',
  'scopedAuthLogs',
])

export const PRODUCTION_WRITER_CATEGORIES = Object.freeze({
  DEPLOYMENT_DRIFT: 'deployment-drift',
  INDETERMINATE: 'indeterminate-state',
  INVALID_ARGUMENTS: 'invalid-arguments',
  JOURNAL_CONFLICT: 'journal-conflict',
  JOURNAL_CORRUPT: 'journal-corrupt',
  JOURNAL_WRITE_FAILED: 'journal-write-failed',
  MANIFEST_NOT_ELIGIBLE: 'manifest-not-eligible',
  PLAN_DIVERGED: 'plan-diverged',
  SECRET_MATERIAL: 'secret-material',
  SOURCE_DIVERGED: 'source-diverged',
  STATE_DIVERGED: 'state-diverged',
})

export class ProductionWriterError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ProductionWriterError'
    this.code = 'PHASE3_PRODUCTION_WRITER_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function fail(category, message, details) {
  throw new ProductionWriterError(category, message, details)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Hashes a canonically serialized value. */
function canonicalDigest(value) {
  return sha256Hex(serializeCanonicalState(value))
}

/** Exact digest of one Firestore document body, including native values. */
function documentBodyDigest(value) {
  return canonicalDigest(encodeCanonicalFirestoreValue(value))
}

/**
 * The exact foundation-state digest.
 *
 * Exported and shared so the entrypoint that BINDS the digest and the
 * transaction that REPROVES it can never compute it two different ways — a
 * drift there would either block every legitimate run or, worse, silently
 * compare nothing meaningful.
 */
export function computeFoundationDigest(teacherData, classroomData) {
  // Delegates to the single shared derivation in productionManifest.js so the
  // writer, the transaction, and the read-only re-verifier cannot drift apart.
  return computeFoundationStateDigest(teacherData, classroomData)
}

/**
 * Walks a candidate event for secret material. Runs before serialization so a
 * leak can never reach the filesystem, and again on read so a hand-edited file
 * cannot reintroduce one.
 */
export function assertNoJournalSecrets(value, label = '$') {
  try {
    return assertNoJournalSecretsFromManifest(value, label)
  } catch (error) {
    if (error instanceof ProductionManifestError) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.SECRET_MATERIAL,
        error.message,
        error.details,
      )
    }
    throw error
  }
}

/* ------------------------------------------------------------------------- *
 * Append-only, hash-chained journal
 * ------------------------------------------------------------------------- */

async function syncDirectory(directory) {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    // Directory fsync is unsupported on some platforms/filesystems. Mirrors the
    // tolerance list already proven in productionManifest.js rather than
    // inventing a second policy.
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS']).has(error?.code)
    const unsupportedOnWindows = process.platform === 'win32' &&
      new Set(['EISDIR', 'EPERM']).has(error?.code)
    if (!unsupported && !unsupportedOnWindows) throw error
  } finally {
    await handle?.close()
  }
}

function sequenceFilename(sequence) {
  return `${String(sequence).padStart(SEQUENCE_WIDTH, '0')}.json`
}

/**
 * Creates a journal bound to one preflight manifest ID.
 *
 * `stateRoot` is injectable for tests ONLY through this dependency object. No
 * argument parser exposes it, so an operator cannot relocate the record.
 */
export function createWriteJournal({
  preflightManifestId,
  stateRoot = PRODUCTION_STATE_DIRECTORY,
  fs: injectedFs = {},
} = {}) {
  if (typeof preflightManifestId !== 'string' ||
      !SHA256_HEX.test(preflightManifestId)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'A journal requires a SHA-256 preflight manifest ID.',
    )
  }

  const fs = {
    mkdir: injectedFs.mkdir ?? mkdir,
    open: injectedFs.open ?? open,
    link: injectedFs.link ?? link,
    unlink: injectedFs.unlink ?? unlink,
    readdir: injectedFs.readdir ?? readdir,
    readFile: injectedFs.readFile ?? readFile,
    syncDirectory: injectedFs.syncDirectory ?? syncDirectory,
  }

  const directory = path.join(stateRoot, `write-${preflightManifestId}`)

  // Containment barrier. The manifest ID is checksum-shaped so it cannot contain
  // a separator, but the assertion is a second independent guard.
  const expectedPrefix = stateRoot.endsWith(path.sep)
    ? stateRoot
    : `${stateRoot}${path.sep}`
  if (!directory.startsWith(expectedPrefix)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'A resolved journal directory escaped the Phase 3 state directory.',
    )
  }

  /**
   * Reads and validates the complete contiguous chain from sequence 0.
   *
   * Delegates to the READ-ONLY primitive in `productionManifest.js` so the
   * writer and the re-verifier validate a stored journal with exactly the same
   * code. Duplicating this logic is what let `append` and `replay` disagree
   * about which transitions are legal.
   */
  async function replay() {
    try {
      return await replayWriteJournal({
        directory,
        fs,
      })
    } catch (error) {
      // Surface journal corruption in the writer's own error vocabulary so
      // callers keep matching on a single category.
      if (error instanceof ProductionManifestError &&
          error.category === PRODUCTION_MANIFEST_CATEGORIES.JOURNAL_CORRUPT) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
          error.message,
          error.details,
        )
      }
      throw error
    }
  }

  /**
   * Atomically installs the next event.
   *
   * The fixed sequence filename IS the arbitration mechanism. Two processes that
   * observed the same predecessor race to create the same name; `link` fails
   * with EEXIST for the loser rather than replacing the winner's file. The loser
   * then compares bytes: an IDENTICAL intended event is accepted (both processes
   * were doing the same thing), while any difference is a fork and blocks.
   *
   * `link` is used rather than `rename` precisely because `rename` silently
   * replaces. An immutable event must never be overwritten, not even by an
   * identical one.
   */
  async function append(event, {
    expectedSequence, expectedPreviousDigest, expectedPreviousEvent,
  }) {
    const body = {
      ...event,
      sequence: expectedSequence,
      previousDigest: expectedPreviousDigest,
    }
    assertNoJournalSecrets(body, 'event')
    try {
      validateJournalEvent(body, expectedSequence)
    } catch (error) {
      if (error instanceof ProductionManifestError) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
          error.message,
          error.details,
        )
      }
      throw error
    }
    // The transition is proven BEFORE the event is made durable, using the same
    // table replay enforces. Installing an illegal event would brick every later
    // replay with journal-corrupt.
    if (expectedPreviousEvent === undefined) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
        'An append must declare the predecessor event it transitions from.',
        { sequence: expectedSequence },
      )
    }
    assertLegalTransition(expectedPreviousEvent, body.event, expectedSequence)
    const serialized = serializeCanonicalState(body)

    // Rebind the append to the actual durable prefix and validate cross-event
    // semantics BEFORE installing a new immutable name. This also handles the
    // benign race where a peer already installed the byte-identical event.
    const durable = await replay()
    if (durable.nextSequence === expectedSequence + 1) {
      const installed = durable.events[expectedSequence]
      if (serializeCanonicalState(installed) === serialized) {
        return Object.freeze({
          event: installed,
          digest: createHash('sha256').update(serialized, 'utf8').digest('hex'),
          installedByPeer: true,
        })
      }
      fail(
        PRODUCTION_WRITER_CATEGORIES.JOURNAL_CONFLICT,
        'A different journal event already occupies this sequence.',
        { sequence: expectedSequence },
      )
    }
    if (durable.nextSequence !== expectedSequence ||
        durable.headDigest !== expectedPreviousDigest ||
        (durable.head?.event ?? null) !== expectedPreviousEvent) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.JOURNAL_CONFLICT,
        'The journal advanced from the predecessor this append observed.',
        { sequence: expectedSequence },
      )
    }
    try {
      validateJournalSemantics([...durable.events, body])
    } catch (error) {
      if (error instanceof ProductionManifestError) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
          error.message,
          error.details,
        )
      }
      throw error
    }

    const targetPath = path.join(directory, sequenceFilename(expectedSequence))
    const temporaryPath = path.join(
      directory,
      `${sequenceFilename(expectedSequence)}.${randomUUID()}.tmp`,
    )

    let handle
    let temporaryCreated = false
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })

      // Complete bytes are flushed to stable storage BEFORE the target name
      // exists, so the target is never a partially written file: it only ever
      // comes into existence as a second name for an already-durable inode.
      handle = await fs.open(temporaryPath, 'wx', 0o400)
      temporaryCreated = true
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined

      try {
        await fs.link(temporaryPath, targetPath)
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const existing = await fs.readFile(targetPath, 'utf8')
          if (existing === serialized) {
            // A concurrent process installed the byte-identical event. That is a
            // benign race: exactly one file exists and it says what this process
            // intended to say.
            return Object.freeze({
              sequence: expectedSequence,
              digest: canonicalDigest(body),
              installedByPeer: true,
            })
          }
          fail(
            PRODUCTION_WRITER_CATEGORIES.JOURNAL_CONFLICT,
            'A different event already occupies this journal sequence.',
            { sequence: expectedSequence },
          )
        }
        throw error
      }

      // Directory fsync makes the new link itself durable, not just its contents.
      await fs.syncDirectory(directory)
    } catch (error) {
      try {
        await handle?.close()
      } catch {
        // The original durability failure remains the blocking cause.
      }
      if (error instanceof ProductionWriterError) throw error
      // A journal durability failure must NEVER permit the next remote batch.
      fail(
        PRODUCTION_WRITER_CATEGORIES.JOURNAL_WRITE_FAILED,
        'A journal event could not be durably installed.',
        { sequence: expectedSequence },
      )
    } finally {
      if (temporaryCreated) {
        try {
          await fs.unlink(temporaryPath)
        } catch {
          // A stale .tmp is inert: never read, and its name embeds a UUID.
        }
      }
    }

    return Object.freeze({
      sequence: expectedSequence,
      digest: canonicalDigest(body),
      installedByPeer: false,
    })
  }

  return Object.freeze({ directory, replay, append })
}

/**
 * Proves a transition is legal BEFORE it is installed.
 *
 * The same table `replay` enforces. Validating only on read meant an illegal
 * event could be made durable and then brick every subsequent replay as
 * `journal-corrupt` — a write that succeeds and a read that refuses to accept
 * it is the worst possible outcome for a crash-recovery record.
 */
export function assertLegalTransition(previousEvent, nextEvent, sequence) {
  if (previousEvent === null || previousEvent === undefined) {
    if (nextEvent !== JOURNAL_EVENTS.PLANNED) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
        'A journal must begin with a planned header event.',
        { sequence, to: nextEvent },
      )
    }
    return true
  }
  const legal = LEGAL_TRANSITIONS[previousEvent] ?? []
  if (!legal.includes(nextEvent)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
      'A journal event is not a legal successor of its predecessor.',
      { sequence, from: previousEvent, to: nextEvent },
    )
  }
  return true
}

/* ------------------------------------------------------------------------- *
 * Deterministic copy plan
 * ------------------------------------------------------------------------- */

/**
 * Estimates one operation's canonical content size.
 *
 * Mirrors Phase 2A's proven accounting (body + path + overhead) using the
 * exported constants rather than vendoring a second copy of the estimator.
 */
function estimateOperationBytes(operation) {
  const encoded = serializeCanonicalState(
    encodeCanonicalFirestoreValue(operation.data),
  )
  return Buffer.byteLength(encoded, 'utf8') +
    Buffer.byteLength(operation.path, 'utf8') +
    ESTIMATED_WRITE_OVERHEAD_BYTES
}

/**
 * Translates the reviewed projection plus the initialization result into a
 * deterministic, bounded operation plan.
 *
 * Determinism matters for recovery: the plan is rederived from unchanged sources
 * after a restart and must reproduce the stored plan digest before any further
 * remote write. Sorting is by path within each surface, and surfaces follow the
 * fixed COPY_SURFACE_ORDER, so batch membership is stable across retries.
 */
export function buildCopyPlan({
  projection,
  foundation,
  initialization,
  retainedFoundationBodiesSha256,
  retainedClassroomInitializedBodySha256,
  retainedClassroomProjectedBodySha256,
}) {
  if (!isPlainObject(projection) || !isPlainObject(foundation) ||
      !isPlainObject(initialization)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'A copy plan requires a projection, foundation, and initialization.',
    )
  }

  const operations = []

  // 1. The classroom projection update. Only settings and lastBackupAt change;
  //    initialization fields were already committed and are asserted, not
  //    rewritten, so the copy stage cannot silently alter the reserved code.
  // The complete classroom root as it must exist BEFORE the copy update: every
  // pre-existing field, plus exactly the two identity fields initialization
  // committed. Comparing the whole root — rather than only the two keys this
  // operation writes — is what detects an extra, removed, or altered field
  // introduced between initialization and copy.
  const expectedClassroomBefore = Object.freeze({
    ...foundation.classroom.data,
    studentLoginCode: initialization.formattedLoginCode,
    nextStudentNumber: initialization.nextStudentNumber,
  })
  const expectedClassroomAfter = Object.freeze({
    ...expectedClassroomBefore,
    settings: projection.classroom.data.settings,
    lastBackupAt: projection.classroom.data.lastBackupAt,
  })
  const classroomInitializedBodySha256 =
    retainedClassroomInitializedBodySha256 ??
    documentBodyDigest(expectedClassroomBefore)
  const classroomProjectedBodySha256 =
    retainedClassroomProjectedBodySha256 ??
    documentBodyDigest(expectedClassroomAfter)
  if (!SHA256_HEX.test(classroomInitializedBodySha256) ||
      !SHA256_HEX.test(classroomProjectedBodySha256)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'A copy plan requires exact initialized and projected classroom digests.',
    )
  }
  const foundationEvidenceSha256 = retainedFoundationBodiesSha256 ??
    foundation.foundationStateDigest
  if (typeof foundationEvidenceSha256 !== 'string' ||
      !SHA256_HEX.test(foundationEvidenceSha256)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'A copy plan requires the retained foundation evidence digest.',
    )
  }

  operations.push({
    surface: 'classroom',
    type: 'update',
    path: foundation.classroom.path,
    data: {
      settings: projection.classroom.data.settings,
      lastBackupAt: projection.classroom.data.lastBackupAt,
    },
    sourcePath: projection.classroom.sourcePath ?? null,
    sourceUpdateTime: projection.classroom.sourceUpdateTime ?? null,
    expectedBefore: 'initialized',
    expectedBeforeRoot: expectedClassroomBefore,
    expectedAfterRoot: expectedClassroomAfter,
    expectedAfterDigest: classroomProjectedBodySha256,
    // Firestore-encoded before hashing: the classroom root carries Timestamp
    // values, which are not plain JSON.
    // The pre-copy root itself is retained in memory for the transaction. The
    // durable plan binds its secret-free evidence digest so a restart can
    // reproduce the SAME plan even when the classroom operation already applied.
    expectedBeforeDigest: classroomInitializedBodySha256,
  })

  const collections = [
    ['students', projection.students],
    ['transactions', projection.transactions],
    ['loginHistory', projection.loginHistory],
    ['scopedCredentials', projection.scopedCredentials],
    ['scopedAuthLogs', projection.scopedAuthLogs],
  ]
  for (const [surface, entries] of collections) {
    const sorted = [...entries].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    for (const entry of sorted) {
      operations.push({
        surface,
        // Every destination document is CREATED, never overwritten. A target
        // that already exists is either an exact recovery match or a blocking
        // divergence; there is no set-with-merge path.
        type: 'create',
        path: entry.path,
        data: entry.data,
        sourcePath: entry.sourcePath,
        sourceUpdateTime: entry.sourceUpdateTime,
        expectedBefore: 'absent',
      })
    }
  }

  // Assign deterministic operation IDs and bound the batches.
  const batches = []
  let current = { operations: [], bytes: 0 }
  operations.forEach((operation, index) => {
    const bytes = estimateOperationBytes(operation)
    if (bytes > MAX_BATCH_PAYLOAD_BYTES) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.PLAN_DIVERGED,
        'A single operation exceeds the 8 MiB payload ceiling.',
        { surface: operation.surface, index },
      )
    }
    operation.operationId = `op-${String(index).padStart(6, '0')}`
    operation.bytes = bytes

    if (current.operations.length >= MAX_BATCH_OPERATIONS ||
        (current.operations.length > 0 &&
          current.bytes + bytes > MAX_BATCH_PAYLOAD_BYTES)) {
      batches.push(current)
      current = { operations: [], bytes: 0 }
    }
    current.operations.push(operation)
    current.bytes += bytes
  })
  if (current.operations.length > 0) batches.push(current)

  const plan = batches.map((batch, batchIndex) => Object.freeze({
    batchIndex,
    operations: Object.freeze(batch.operations.map(Object.freeze)),
    estimatedBytes: batch.bytes,
    // The batch digest binds membership and order, so a retry that produced a
    // different grouping is detectable rather than silently accepted.
    batchDigest: canonicalDigest(batch.operations.map(operation => ({
      operationId: operation.operationId,
      surface: operation.surface,
      type: operation.type,
      destinationPathSha256: sha256Hex(operation.path),
      expectedAfterSha256: operation.expectedAfterDigest ??
        canonicalDigest(operation.data),
      // The source precondition is part of the plan's identity. Binding the
      // source path hash, its exact Timestamp, and the expected-before state
      // means a plan rederived against an edited source cannot reproduce the
      // retained digest, so recovery blocks instead of copying new bytes.
      sourcePathSha256: typeof operation.sourcePath === 'string'
        ? sha256Hex(operation.sourcePath)
        : null,
      sourceUpdateTime: encodeCanonicalFirestoreValue(
        operation.sourceUpdateTime ?? null,
      ),
      expectedBefore: operation.expectedBefore,
      expectedBeforeSha256: operation.expectedBeforeDigest ?? null,
    }))),
  }))

  return Object.freeze({
    batches: Object.freeze(plan),
    operationCount: operations.length,
    countsBySurface: Object.freeze(
      COPY_SURFACE_ORDER.reduce((counts, surface) => {
        counts[surface] = operations.filter(
          operation => operation.surface === surface,
        ).length
        return counts
      }, {}),
    ),
    planDigest: canonicalDigest(plan.map(batch => batch.batchDigest)),
    classroomInitializedBodySha256,
    classroomProjectedBodySha256,
  })
}

/* ------------------------------------------------------------------------- *
 * Retained-evidence reproving
 * ------------------------------------------------------------------------- */

/**
 * Reproves the RETAINED preflight evidence against current production state.
 *
 * This is the control that makes the manifest the baseline. Rereading current
 * state and treating it as the new baseline — which is what the writer used to
 * do — means a production change made after preflight simply becomes the
 * accepted starting point, and the reviewed evidence never constrains anything.
 *
 * Each domain below is recomputed with the SAME derivation preflight used
 * (`sourceEntryFromEnvelope` + `summarizeHashedSource`) and compared to the
 * retained `domainChecksums`. Any drift aborts before a transaction opens.
 *
 * The stage-specific authorized deltas are the ONLY permitted differences:
 *   - initialization may add `studentLoginCode`/`nextStudentNumber` to the
 *     classroom and create the login-code index document;
 *   - copy may additionally populate the projected destination surfaces.
 */
export async function reproveRetainedEvidence({
  manifest,
  rawReaders,
  readAuthCompatibility,
  foundation,
  canonicalLoginCode,
  formattedLoginCode,
  stage,
  resuming = false,
  expectedFoundationBodiesSha256,
  expectedFoundationStableBodiesSha256,
  expectedTeacherSourceSha256,
  requireFullFoundationBodies = true,
  requireDestinationAbsence = false,
  initializedAt,
  allowedDestinationPaths,
}) {
  const observed = {}

  // ---- legacy source state: the immutable copy inputs ----
  const legacyClassroom = await rawReaders.readLegacyClassroomAggregate()
  if (legacyClassroom.exists !== true) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
      'The legacy source document is absent at write time.',
    )
  }
  const flatCredentials = await rawReaders.readFlatCredentials()
  const flatAuthLogs = await rawReaders.readFlatAuthLogs()
  observed.legacySource = summarizeHashedSource(
    [sourceEntryFromEnvelope(legacyClassroom, 'legacyClassroom')],
    'legacyClassroom',
  )
  observed.flatCredentials = summarizeHashedSource(
    flatCredentials.map(e => sourceEntryFromEnvelope(e, 'flatCredentials')),
    'flatCredentials',
  )
  observed.flatAuthLogs = summarizeHashedSource(
    flatAuthLogs.map(e => sourceEntryFromEnvelope(e, 'flatAuthLogs')),
    'flatAuthLogs',
  )

  // The retained legacySourceState domain is a checksum over a fully determined
  // payload: counts plus these three hashed source summaries. Every input is
  // either recomputed here or recorded in the manifest's own observations, so
  // the whole domain can be REBUILT and its checksum compared. That comparison —
  // not a fresh read — is what proves the copy inputs are byte-identical to the
  // reviewed ones.
  const retainedCounts = manifest.observations?.counts
  if (!isPlainObject(retainedCounts)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'The retained manifest records no legacy source counts to reprove.',
    )
  }
  const rebuiltLegacyDomain = {
    present: true,
    counts: retainedCounts.legacy,
    credentialCount: flatCredentials.length,
    authLogCount: flatAuthLogs.length,
    noncanonicalValueCount: manifest.observations.noncanonicalValueCount ?? 0,
    sources: {
      flatAuthLogs: observed.flatAuthLogs,
      flatCredentials: observed.flatCredentials,
      legacyClassroom: observed.legacySource,
    },
  }
  observed.legacySourceStateDigest = hashDomain(rebuiltLegacyDomain)
  if (observed.legacySourceStateDigest !==
      manifest.domainChecksums.legacySourceState) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
      'The legacy source changed after preflight recorded its evidence.',
    )
  }
  if (retainedCounts.flatCredentials !== flatCredentials.length ||
      retainedCounts.flatAuthLogs !== flatAuthLogs.length) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
      'A flat source collection changed size after preflight.',
    )
  }

  // ---- foundation: reproved against the RETAINED digest, not a fresh read ----
  const teacher = await rawReaders.readTeacher()
  const classroom = await rawReaders.readClassroom(foundation.classroomId)
  if (teacher.exists !== true || classroom.exists !== true) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'The foundation is absent at write time.',
    )
  }

  // The classroom carries the stage's authorized delta, so it is compared by
  // removing exactly that delta and requiring the REMAINDER to be unchanged.
  const classroomWithoutDelta = { ...classroom.data }
  const deltaKeys = ['studentLoginCode', 'nextStudentNumber']
  const observedDelta = {}
  for (const key of deltaKeys) {
    if (Object.hasOwn(classroomWithoutDelta, key)) {
      observedDelta[key] = classroomWithoutDelta[key]
      delete classroomWithoutDelta[key]
    }
  }
  // A FRESH initialization requires the delta to be absent. A RESUMED one may
  // legitimately find it already applied — that is precisely the crash-recovery
  // case — so the presence of the delta is only an error when this run has not
  // yet recorded an attempt. The initialization transaction independently
  // refuses to overwrite an existing code or counter.
  if (stage === WRITE_STAGES.INITIALIZATION && resuming !== true &&
      Object.keys(observedDelta).length > 0) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'The classroom already carries initialization identity fields.',
    )
  }
  if (Object.hasOwn(observedDelta, 'studentLoginCode') &&
      observedDelta.studentLoginCode !== formattedLoginCode) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'The classroom carries a login code this run did not authorize.',
    )
  }
  // The foundation evidence preflight retained is a hashed source summary over
  // the teacher and classroom documents AS THEY WERE BEFORE initialization.
  // Reproving it means summarizing the same two documents the same way, with the
  // classroom's authorized delta removed so the pre-initialization body is what
  // gets hashed.
  observed.foundation = summarizeHashedSource(
    [
      sourceEntryFromEnvelope(teacher, 'foundation'),
      sourceEntryFromEnvelope(
        { ...classroom, data: classroomWithoutDelta }, 'foundation',
      ),
    ],
    'foundation',
  )
  observed.teacherSourceSha256 = hashDomain(summarizeHashedSource(
    [sourceEntryFromEnvelope(teacher, 'foundationTeacher')],
    'foundationTeacher',
  ))
  // The document bodies are what must not have drifted. updateTime necessarily
  // advances when initialization writes the classroom, so the body digests —
  // not the entry summary — are the stable evidence across both stages.
  observed.foundationStateDigest = computeFoundationDigest(
    teacher.data, classroomWithoutDelta,
  )
  observed.foundationBodiesSha256 = observed.foundationStateDigest
  const classroomStable = { ...classroomWithoutDelta }
  delete classroomStable.settings
  delete classroomStable.lastBackupAt
  observed.foundationStableBodiesSha256 = computeFoundationDigest(
    teacher.data, classroomStable,
  )

  // The preflight domain included the COMPLETE root enumeration. Repeating that
  // enumeration prevents an extra teacher/classroom from hiding behind reads of
  // only the authorized pair. The raw production reader always exposes this
  // method; an injected reader that cannot enumerate is incomplete, not empty.
  if (typeof rawReaders.readCollection !== 'function') {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'The foundation root enumeration is unavailable at write time.',
    )
  }
  const [teacherRoots, classroomRoots] = await Promise.all([
    rawReaders.readCollection('teachers'),
    rawReaders.readCollection('classrooms'),
  ])
  if (teacherRoots.length !== 1 || classroomRoots.length !== 1 ||
      teacherRoots[0].path !== `teachers/${foundation.teacherUid}` ||
      classroomRoots[0].path !== `classrooms/${foundation.classroomId}`) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'The foundation root set changed after preflight.',
    )
  }

  if (resuming !== true) {
    const rebuiltFoundationDomain = {
      present: true,
      reciprocal: teacher.data.classroomId === foundation.classroomId &&
        classroomWithoutDelta.ownerUid === foundation.teacherUid,
      teacherStatus: teacher.data.status,
      classroomIdPresent: Boolean(teacher.data.classroomId),
      existingTeacherCount: teacherRoots.length,
      existingClassroomCount: classroomRoots.length,
      sources: { foundation: observed.foundation },
    }
    observed.foundationStateDomainSha256 = hashDomain(rebuiltFoundationDomain)
    if (observed.foundationStateDomainSha256 !==
        manifest.domainChecksums.foundationState) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The foundation changed after preflight recorded its evidence.',
      )
    }
  } else {
    if (typeof expectedTeacherSourceSha256 !== 'string' ||
        observed.teacherSourceSha256 !== expectedTeacherSourceSha256) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The immutable teacher evidence no longer matches the journal baseline.',
      )
    }
    if (typeof expectedFoundationStableBodiesSha256 !== 'string' ||
        observed.foundationStableBodiesSha256 !==
          expectedFoundationStableBodiesSha256) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The immutable foundation fields no longer match the journal baseline.',
      )
    }
    if (requireFullFoundationBodies &&
        (typeof expectedFoundationBodiesSha256 !== 'string' ||
         observed.foundationBodiesSha256 !== expectedFoundationBodiesSha256)) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The foundation bodies no longer match the journal baseline.',
      )
    }
  }

  // ---- Auth compatibility: complete, exact, and retained ----
  if (typeof readAuthCompatibility !== 'function') {
    fail(
      PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
      'The Auth compatibility observation is unavailable at write time.',
    )
  }
  const authCompatibility = await readAuthCompatibility()
  if (authCompatibility?.complete !== true ||
      !Array.isArray(authCompatibility.sourceEntries) ||
      !Number.isInteger(authCompatibility.examinedUserCount) ||
      authCompatibility.examinedUserCount !==
        authCompatibility.sourceEntries.length) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
      'The Auth compatibility observation is incomplete.',
    )
  }
  const rebuiltAuthDomain = {
    uidCollisions: authCompatibility.uidCollisions,
    incompatibleUsers: authCompatibility.incompatibleUsers,
    examinedUserCount: authCompatibility.examinedUserCount,
    sources: {
      authUsers: summarizeHashedSource(
        authCompatibility.sourceEntries, 'authUsers',
      ),
    },
  }
  observed.authCompatibilitySha256 = hashDomain(rebuiltAuthDomain)
  if (observed.authCompatibilitySha256 !==
      manifest.domainChecksums.authCompatibility) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
      'Auth compatibility changed after preflight recorded its evidence.',
    )
  }

  // ---- destination absence: exactly the authorized stage delta ----
  const destinationReaders = [
    ['classroomStudents', () =>
      rawReaders.readClassroomStudents(foundation.classroomId)],
    ['classroomTransactions', () =>
      rawReaders.readClassroomTransactions(foundation.classroomId)],
    ['classroomLoginHistory', () =>
      rawReaders.readClassroomLoginHistory(foundation.classroomId)],
    ['scopedCredentials', () =>
      rawReaders.readScopedCredentials(foundation.classroomId)],
    ['scopedLogs', () =>
      rawReaders.readScopedAuthLogs(foundation.classroomId)],
  ]
  const destinationCounts = {}
  const destinationEntries = {}
  for (const [surface, read] of destinationReaders) {
    destinationEntries[surface] = await read()
    destinationCounts[surface] = destinationEntries[surface].length
  }
  const codeIndex = await rawReaders.readLoginCodeIndex()
  destinationEntries.loginCodeIndex = codeIndex
  destinationCounts.loginCodeIndex = codeIndex.length

  if (stage === WRITE_STAGES.INITIALIZATION) {
    for (const surface of DESTINATION_SURFACES) {
      // The login-code index is the ONE surface initialization itself creates,
      // so a resumed run may legitimately observe its own authorized document
      // there. Every other surface must still be empty: initialization writes
      // nothing else, and the copy stage has not run.
      const permitted = surface === 'loginCodeIndex' && resuming === true ? 1 : 0
      if (destinationCounts[surface] > permitted) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
          'A destination surface is no longer empty.',
          { surface },
        )
      }
    }
    const indexed = codeIndex[0]
    if (indexed !== undefined &&
        indexed.path !== `classroomLoginCodes/${canonicalLoginCode}`) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The login code index names a code this run did not authorize.',
      )
    }

    // A fresh invocation must reproduce the retained absence domain exactly.
    // Once initialization has created its authorized code document, the journal
    // is the durable proof that this comparison already succeeded.
    if (resuming !== true) {
      const emptyCoverage = Object.fromEntries([
        'destinationStudents',
        'destinationCredentials',
        'destinationTransactions',
        'destinationLoginHistory',
        'destinationAuthLogs',
      ].map(name => [name, {
        referencedCount: 0, unassignedCount: 0, inconsistentCount: 0,
      }]))
      const rebuiltDestinationDomain = {
        counts: destinationCounts,
        studentIdCoverage: emptyCoverage,
        selectedCodePresent: false,
        selectedCodeSha256: sha256Hex(canonicalLoginCode),
        selectedCodePathSha256: sha256Hex(
          `classroomLoginCodes/${canonicalLoginCode}`,
        ),
        sources: Object.fromEntries(
          [...DESTINATION_SURFACES].sort().map(surface => [
            surface,
            summarizeHashedSource(
              destinationEntries[surface].map(entry =>
                sourceEntryFromEnvelope(entry, surface)),
              surface,
            ),
          ]),
        ),
      }
      observed.destinationAbsenceSha256 = hashDomain(rebuiltDestinationDomain)
      if (observed.destinationAbsenceSha256 !==
          manifest.domainChecksums.destinationAbsence) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
          'Destination absence no longer matches the retained evidence.',
        )
      }
    }
  } else {
    // At copy time exactly ONE code-index document — the authorized one — must
    // exist. Its exact body is checked below; absence is not a recoverable copy
    // state because initialization is already durably recorded as verified.
    if (destinationCounts.loginCodeIndex !== 1) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The authorized classroom login code index is absent or duplicated.',
      )
    }
    const indexed = codeIndex[0]
    if (indexed !== undefined &&
        indexed.path !== `classroomLoginCodes/${canonicalLoginCode}`) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The login code index names a code this run did not authorize.',
      )
    }
    if (!(allowedDestinationPaths instanceof Set)) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.PLAN_DIVERGED,
        'The copy stage has no bounded destination path set.',
      )
    }
    for (const [surface, entries] of Object.entries(destinationEntries)) {
      if (surface === 'loginCodeIndex') continue
      if (requireDestinationAbsence && entries.length !== 0) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
          'A copy destination appeared before any batch attempt was recorded.',
          { surface },
        )
      }
      const unexpected = entries.find(entry =>
        !allowedDestinationPaths.has(entry.path))
      if (unexpected !== undefined) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
          'A destination document exists outside the authorized copy plan.',
          { surface },
        )
      }
    }
  }

  if (codeIndex.length === 1 && !isExactLoginCodeIndex({
    document: codeIndex[0],
    classroomId: foundation.classroomId,
    canonicalLoginCode,
    initializedAt,
  })) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'The classroom login code index does not match the recorded initialization.',
    )
  }

  // ---- identity watermark: every historical source, including destination ----
  const legacyData = legacyClassroom.data
  const requireArray = (value, name) => {
    if (!Array.isArray(value)) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
        'A legacy watermark source is malformed.',
        { source: name },
      )
    }
    return value
  }
  const ids = (entries, field) => entries
    .filter(entry => entry.data?.[field] != null)
    .map(entry => entry.data[field])
  const watermark = deriveStudentIdWatermark({
    roster: requireArray(legacyData.students, 'roster').map(entry => entry?.id),
    credentials: ids(flatCredentials, 'studentId'),
    transactions: requireArray(legacyData.transactions, 'transactions')
      .filter(entry => entry?.studentId != null).map(entry => entry.studentId),
    loginHistory: requireArray(legacyData.loginHistory, 'loginHistory')
      .filter(entry => entry?.studentId != null).map(entry => entry.studentId),
    authLogs: ids(flatAuthLogs, 'studentId'),
    destinationStudents: ids(destinationEntries.classroomStudents, 'id'),
    destinationCredentials: ids(destinationEntries.scopedCredentials, 'studentId'),
    destinationTransactions: ids(
      destinationEntries.classroomTransactions, 'studentId',
    ),
    destinationLoginHistory: ids(
      destinationEntries.classroomLoginHistory, 'studentId',
    ),
    destinationAuthLogs: ids(destinationEntries.scopedLogs, 'studentId'),
  })
  observed.watermarkSha256 = hashDomain(watermark)
  if (observed.watermarkSha256 !== manifest.domainChecksums.identityWatermark) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
      'The identity watermark changed after preflight recorded its evidence.',
    )
  }

  observed.destinationCounts = Object.freeze(destinationCounts)
  return Object.freeze(observed)
}

/**
 * Binds a resumed or completed run to the FULL journal header.
 *
 * A second invocation presents its own artifacts. Without this, it could carry a
 * different manifest, authorization, credential, or login code and still resume
 * a journal planned from something else entirely — the header would record one
 * run's provenance while the copy executed another's.
 */
export function assertHeaderBinding(header, {
  manifest, authorization, initialization, foundation,
}) {
  const expected = {
    projectId: manifest.projectId,
    teacherUidSha256: sha256Hex(manifest.teacherUid),
    releaseId: manifest.releaseId,
    changeId: manifest.changeId,
    authorizationId: authorization.authorizationId,
    snapshotId: authorization.snapshotId,
    writeFreezeProof: authorization.writeFreezeProof,
    credentialProvenance: authorization.credentialProvenance,
    preflightManifestId: manifest.preflightManifestId,
    preflightChecksum: manifest.preflightChecksum,
    writeAuthorizationSha256: authorization.writeAuthorizationSha256,
    preflightAuthorizationSha256: authorization.preflightAuthorizationSha256,
    credentialSha256: authorization.credentialSha256,
    initializationExpectationsSha256:
      authorization.initializationExpectationsSha256,
    copyExpectationsSha256: authorization.copyExpectationsSha256,
    loginCodeSha256: sha256Hex(initialization.canonicalLoginCode),
    loginCodePathSha256: sha256Hex(
      `classroomLoginCodes/${initialization.canonicalLoginCode}`,
    ),
    classroomIdSha256: sha256Hex(foundation.classroomId),
    nextStudentNumber: initialization.nextStudentNumber,
    foundationStateSha256: manifest.domainChecksums.foundationState,
    legacySourceStateSha256: manifest.domainChecksums.legacySourceState,
    destinationAbsenceSha256: manifest.domainChecksums.destinationAbsence,
    authCompatibilitySha256: manifest.domainChecksums.authCompatibility,
    watermarkSha256: manifest.domainChecksums.identityWatermark,
  }

  for (const [field, value] of Object.entries(expected)) {
    if (header[field] !== value) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The resumed run does not match the journal header it is continuing.',
        { field },
      )
    }
  }
  return true
}

/* ------------------------------------------------------------------------- *
 * Manifest eligibility
 * ------------------------------------------------------------------------- */

/**
 * Manifest write-eligibility is a pure predicate over a retained manifest with
 * no mutation surface, so it lives in `productionManifest.js`. That lets the
 * READ-ONLY re-verifier audit the same eligibility the writer required without
 * importing this module. Re-exported here for existing callers.
 */
export { assertManifestWriteEligible } from './productionManifest.js'

/**
 * Proves the re-presented preflight authorization artifact is the exact one the
 * manifest bound, and recovers the canonical login code from it.
 *
 * This is what lets the manifest omit the raw code entirely: the code lives only
 * in the operator's authorization file, whose raw-byte digest must equal the
 * manifest's `authorizationArtifact` domain.
 */
export function recoverAuthorizedLoginCode({
  manifest,
  preflightAuthorization,
  preflightAuthorizationSha256,
  credentialSha256,
}) {
  const expected = manifest.domainChecksums?.authorizationArtifact
  if (typeof expected !== 'string' || !SHA256_HEX.test(expected)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'The retained manifest has no authorization-artifact digest.',
    )
  }
  // hashDomain wraps the raw digest in a domain object, so recompute the same
  // shape rather than comparing a bare hash to a domain checksum.
  const observed = canonicalDigest({ sha256: preflightAuthorizationSha256 })
  if (observed !== expected) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'The presented preflight authorization is not the one the manifest bound.',
    )
  }
  if (!isPlainObject(preflightAuthorization)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'The preflight authorization must be a JSON object.',
    )
  }
  for (const [field, expectedValue] of [
    ['projectId', manifest.projectId],
    ['teacherUid', manifest.teacherUid],
    ['releaseId', manifest.releaseId],
    ['changeId', manifest.changeId],
  ]) {
    if (preflightAuthorization[field] !== expectedValue) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The preflight authorization does not match the retained manifest.',
        { field },
      )
    }
  }
  if (preflightAuthorization.credentialSha256 !== credentialSha256) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'The presented credential is not the authorized credential.',
    )
  }

  const raw = preflightAuthorization.studentLoginCode
  let canonical
  try {
    canonical = normalizeClassroomCode(raw)
  } catch {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'The authorized classroom login code is not a valid classroom code.',
    )
  }
  if (raw !== canonical) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'The authorized classroom login code is not already canonical.',
    )
  }

  // The recovered code must be the same one preflight proved absent.
  const absence = manifest.observations?.selectedCodeSha256 ??
    manifest.domainChecksums?.destinationAbsence
  if (typeof absence === 'string' && SHA256_HEX.test(absence) &&
      Object.hasOwn(manifest.observations ?? {}, 'selectedCodeSha256') &&
      sha256Hex(canonical) !== absence) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'The recovered login code is not the code preflight proved absent.',
    )
  }

  return Object.freeze({
    canonicalLoginCode: canonical,
    formattedLoginCode: formatClassroomCode(canonical),
  })
}

/* ------------------------------------------------------------------------- *
 * Recovery classification
 * ------------------------------------------------------------------------- */

export const BATCH_CLASSIFICATIONS = Object.freeze({
  ALL_BEFORE: 'all-expected-before',
  ALL_AFTER: 'all-expected-after',
  MIXED: 'mixed',
})

/**
 * Classifies an entire batch against observed remote state.
 *
 * This is the mandatory recovery control for the crash-after-commit-before-event
 * window. A Firestore transaction is atomic, so a batch must be uniformly
 * before or uniformly after. Anything mixed is evidence of interference or a
 * broken assumption and must never be treated as success or blindly retried.
 */
export function classifyBatchState(batch, observed) {
  if (!isPlainObject(batch) || !Array.isArray(batch.operations) ||
      !(observed instanceof Map)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'Batch classification requires a plan batch and an observed state map.',
    )
  }
  let before = 0
  let after = 0
  for (const operation of batch.operations) {
    const state = observed.get(operation.path)
    if (operation.type === 'create') {
      if (!state || state.exists === false) {
        before += 1
        continue
      }
      if (canonicalDigest(state.data) === canonicalDigest(operation.data)) {
        after += 1
        continue
      }
      // Present but different: not our write, or a partial/divergent one.
      return BATCH_CLASSIFICATIONS.MIXED
    }
    // The classroom update is classified by its COMPLETE exact before/after
    // body digests. Comparing only the two projected fields would misclassify
    // an unrelated edit elsewhere in the root as this run's recovery state.
    if (!state || state.exists === false) return BATCH_CLASSIFICATIONS.MIXED
    const observedDigest = documentBodyDigest(state.data)
    if (observedDigest === operation.expectedAfterDigest) after += 1
    else if (observedDigest === operation.expectedBeforeDigest) before += 1
    else return BATCH_CLASSIFICATIONS.MIXED
  }
  if (before === batch.operations.length) return BATCH_CLASSIFICATIONS.ALL_BEFORE
  if (after === batch.operations.length) return BATCH_CLASSIFICATIONS.ALL_AFTER
  return BATCH_CLASSIFICATIONS.MIXED
}

/* ------------------------------------------------------------------------- *
 * Initialization transaction
 * ------------------------------------------------------------------------- */

/**
 * Executes the single atomic initialization transaction.
 *
 * The callback performs ALL READS BEFORE ANY WRITE and has no filesystem,
 * logging, or journal side effect, so Firestore may safely retry it. Exactly two
 * documents are touched:
 *
 *   - `classrooms/{classroomId}`: only `studentLoginCode` and
 *     `nextStudentNumber` are set. Every other field is preserved by using an
 *     `update` with exactly those two keys rather than a `set`. `updatedAt` is
 *     deliberately NOT touched — the default contract is preservation.
 *   - `classroomLoginCodes/{canonicalCode}`: created with exactly
 *     `{ classroomId, status, createdAt }`, and only if absent.
 *
 * The teacher document is not modified. No invitation is created. The watermark
 * is never reduced. An existing code index is never overwritten.
 *
 * `initializedAt` is a Firestore Timestamp captured ONCE before the transaction
 * and reused across retries and recovery. serverTimestamp() is deliberately not
 * used: reconciliation must compare this value exactly, and a server-assigned
 * time would differ on every retry.
 */
export async function runInitializationTransaction({
  firestore,
  foundation,
  initialization,
  initializedAt,
  manifest,
}) {
  if (!firestore || typeof firestore.runTransaction !== 'function') {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'Initialization requires a Firestore handle.',
    )
  }
  const classroomRef = firestore.doc(`classrooms/${foundation.classroomId}`)
  const teacherRef = firestore.doc(`teachers/${foundation.teacherUid}`)
  const codeRef = firestore.doc(
    `classroomLoginCodes/${initialization.canonicalLoginCode}`,
  )

  await firestore.runTransaction(async transaction => {
    // ---- all reads first ----
    const [teacherSnapshot, classroomSnapshot, codeSnapshot] = await Promise.all([
      transaction.get(teacherRef),
      transaction.get(classroomRef),
      transaction.get(codeRef),
    ])

    // Reciprocity, status, and body/update-time agreement with the manifest are
    // reproven INSIDE the transaction, so a foundation that changed between
    // preflight and now cannot be initialized on stale evidence.
    if (teacherSnapshot.exists !== true || classroomSnapshot.exists !== true) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The existing foundation is no longer present.',
      )
    }
    const teacher = teacherSnapshot.data()
    const classroom = classroomSnapshot.data()
    if (teacher?.uid !== foundation.teacherUid ||
        teacher?.classroomId !== foundation.classroomId ||
        teacher?.status !== 'active' ||
        classroom?.ownerUid !== foundation.teacherUid) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The foundation is not an active reciprocal pair.',
      )
    }
    // Compared against the digest the WRITER REPROVED against retained preflight
    // evidence — never against one recomputed from a read taken moments earlier
    // in the same invocation. Two digests both derived from current state agree
    // by construction, so such a comparison can never detect post-preflight
    // drift; this one can.
    if (typeof foundation.reprovedFoundationStateDigest !== 'string') {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The initialization transaction was given no reproved foundation digest.',
      )
    }
    if (computeFoundationDigest(teacher, classroom) !==
        foundation.reprovedFoundationStateDigest) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The foundation state no longer matches the retained evidence.',
      )
    }
    // The classroom must not already carry an initialization; re-running must
    // never renumber a counter or replace a live code.
    if (classroom.studentLoginCode !== undefined ||
        classroom.nextStudentNumber !== undefined) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The classroom is already initialized.',
      )
    }
    if (codeSnapshot.exists === true) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The selected classroom login code is already reserved.',
      )
    }

    // ---- writes only after every read ----
    transaction.update(classroomRef, {
      studentLoginCode: initialization.formattedLoginCode,
      nextStudentNumber: initialization.nextStudentNumber,
    })
    transaction.create(codeRef, {
      classroomId: foundation.classroomId,
      status: 'active',
      createdAt: initializedAt,
    })
  })

  return Object.freeze({
    classroomPathSha256: sha256Hex(`classrooms/${foundation.classroomId}`),
    codePathSha256: sha256Hex(
      `classroomLoginCodes/${initialization.canonicalLoginCode}`,
    ),
    manifestId: manifest.preflightManifestId,
  })
}

/** Exact login-code index shape and Timestamp recorded by this run. */
function isExactLoginCodeIndex({
  document, classroomId, canonicalLoginCode, initializedAt,
}) {
  if (document?.exists !== true ||
      document.path !== `classroomLoginCodes/${canonicalLoginCode}` ||
      !isPlainObject(document.data) || initializedAt == null) return false
  const keys = Object.keys(document.data).sort()
  return keys.length === 3 && keys[0] === 'classroomId' &&
    keys[1] === 'createdAt' && keys[2] === 'status' &&
    document.data.classroomId === classroomId &&
    document.data.status === 'active' &&
    document.data.createdAt?.seconds === initializedAt.seconds &&
    document.data.createdAt?.nanoseconds === initializedAt.nanoseconds
}

/* ------------------------------------------------------------------------- *
 * Copy transactions
 * ------------------------------------------------------------------------- */

/**
 * Commits one deterministic batch inside a Firestore transaction.
 *
 * Contract for the callback, all of which exist so a retry is safe:
 *
 *  - every read happens before every write;
 *  - it performs no filesystem, logging, or journal side effect;
 *  - it reproves each relevant immutable source and each target's
 *    expected-before state;
 *  - a target must be ABSENT unless it is already exactly expected-after
 *    (the recovery case), in which case it is skipped rather than rewritten;
 *  - any divergent source or target aborts the whole transaction.
 *
 * `create` is used for every destination document. There is no set-with-merge
 * and no delete anywhere in this function.
 */
export async function commitCopyBatch({
  firestore,
  batch,
}) {
  let applied = 0
  let skipped = 0

  await firestore.runTransaction(async transaction => {
    applied = 0
    skipped = 0

    // ---- all reads first ----
    const targetRefs = batch.operations.map(
      operation => firestore.doc(operation.path),
    )
    const sourceRefs = [...new Set(
      batch.operations
        .map(operation => operation.sourcePath)
        .filter(sourcePath => typeof sourcePath === 'string'),
    )].map(sourcePath => ({ sourcePath, ref: firestore.doc(sourcePath) }))

    const [targetSnapshots, sourceSnapshots] = await Promise.all([
      Promise.all(targetRefs.map(ref => transaction.get(ref))),
      Promise.all(sourceRefs.map(async ({ sourcePath, ref }) => ({
        sourcePath,
        snapshot: await transaction.get(ref),
      }))),
    ])

    // Each immutable source is reread and bound in EVERY affected batch. For the
    // embedded legacy singleton this means the same document is rebound per
    // batch, which is what detects a source edit part-way through a copy.
    const sourceByPath = new Map(
      sourceSnapshots.map(({ sourcePath, snapshot }) => [sourcePath, snapshot]),
    )
    for (const operation of batch.operations) {
      if (typeof operation.sourcePath !== 'string') continue
      const snapshot = sourceByPath.get(operation.sourcePath)
      if (!snapshot || snapshot.exists !== true) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
          'An immutable source document is no longer present.',
          { operationId: operation.operationId },
        )
      }
      const observed = snapshot.updateTime
      const expected = operation.sourceUpdateTime
      if (expected && (observed?.seconds !== expected.seconds ||
          observed?.nanoseconds !== expected.nanoseconds)) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.SOURCE_DIVERGED,
          'An immutable source changed after the plan was built.',
          { operationId: operation.operationId },
        )
      }
    }

    const decisions = []
    for (let index = 0; index < batch.operations.length; index += 1) {
      const operation = batch.operations[index]
      const snapshot = targetSnapshots[index]
      if (operation.type === 'create') {
        if (snapshot.exists !== true) {
          decisions.push({ operation, action: 'create' })
          continue
        }
        // Already exactly expected-after: a prior attempt committed this batch
        // and crashed before its journal event. Skipping is what makes recovery
        // free of duplicate writes.
        if (canonicalDigest(snapshot.data()) === canonicalDigest(operation.data)) {
          decisions.push({ operation, action: 'skip' })
          continue
        }
        fail(
          PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
          'A destination document exists with unexpected content.',
          { operationId: operation.operationId },
        )
      } else {
        if (snapshot.exists !== true) {
          fail(
            PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
            'The classroom root is missing at copy time.',
            { operationId: operation.operationId },
          )
        }
        // The COMPLETE root is compared, not merely the two keys this operation
        // writes. An extra, removed, or altered field anywhere in the classroom
        // is a divergence: the reviewed plan was built against an exact root and
        // this update must not be applied on top of a different one.
        const body = snapshot.data()
        const observedDigest = documentBodyDigest(body)
        if (observedDigest === operation.expectedAfterDigest) {
          // Already exactly expected-after: a prior attempt applied this update
          // and crashed before its journal event.
          decisions.push({ operation, action: 'skip' })
          continue
        }
        if (observedDigest !== operation.expectedBeforeDigest) {
          fail(
            PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
            'The classroom root does not match its expected pre-copy state.',
            { operationId: operation.operationId },
          )
        }
        decisions.push({ operation, action: 'update' })
      }
    }

    // ---- writes only after every read ----
    for (const { operation, action } of decisions) {
      const ref = firestore.doc(operation.path)
      if (action === 'create') {
        transaction.create(ref, operation.data)
        applied += 1
      } else if (action === 'update') {
        transaction.update(ref, operation.data)
        applied += 1
      } else {
        skipped += 1
      }
    }
  })

  return Object.freeze({ applied, skipped })
}

/* ------------------------------------------------------------------------- *
 * Stage derivation and orchestration
 * ------------------------------------------------------------------------- */

export const WRITE_RESULTS = Object.freeze({
  AWAITING_DEPLOYMENT: 'ACTION_REQUIRED/AWAITING_DEPLOYMENT',
  COMPLETED: 'COMPLETED',
  ALREADY_COMPLETED: 'ALREADY_COMPLETED',
  BLOCKED_INDETERMINATE: 'BLOCKED/INDETERMINATE',
})

export const WRITE_STAGES = Object.freeze({
  INITIALIZATION: 'initialization',
  COPY: 'copy',
  COMPLETE: 'complete',
  BLOCKED: 'blocked',
})

/**
 * Derives the stage SOLELY from the replayed journal.
 *
 * This is the mechanism that makes a stage flag unnecessary and a stage bypass
 * impossible. There is no argument, environment variable, or manifest field that
 * can move the run to the copy stage: only an `awaiting-copy-deployment` event —
 * which only a verified initialization can append — does that.
 */
export function deriveStage(replay) {
  if (!replay?.exists || replay.events.length === 0) {
    return Object.freeze({ stage: WRITE_STAGES.INITIALIZATION, head: null })
  }
  const head = replay.head
  switch (head.event) {
    case JOURNAL_EVENTS.PLANNED:
    case JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT:
    case JOURNAL_EVENTS.INITIALIZATION_VERIFIED:
      return Object.freeze({ stage: WRITE_STAGES.INITIALIZATION, head })
    case JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT:
    case JOURNAL_EVENTS.BATCH_IN_FLIGHT:
    case JOURNAL_EVENTS.BATCH_COMMITTED:
    case JOURNAL_EVENTS.BATCH_VERIFIED:
    case JOURNAL_EVENTS.COPY_VERIFYING:
      return Object.freeze({ stage: WRITE_STAGES.COPY, head })
    case JOURNAL_EVENTS.COMPLETED:
      return Object.freeze({ stage: WRITE_STAGES.COMPLETE, head })
    default:
      return Object.freeze({ stage: WRITE_STAGES.BLOCKED, head })
  }
}

/**
 * Compares an observed deployment inventory against the reviewed expectations
 * for the stage about to run.
 *
 * The writer INSPECTS; it never deploys. Unavailable inspection, an unexpected
 * artifact, a gate-on state, Hosting drift, an unacknowledged writer, or any
 * expectations mismatch aborts before a transaction is opened.
 */
/**
 * The exact top-level keys a reviewed expectations artifact may carry.
 *
 * Strict and exhaustive: an artifact with an extra key is rejected rather than
 * ignored, because a misspelled surface name would otherwise be silently
 * unenforced while appearing — to a human reviewer reading the file — to be
 * constraining the deployment.
 */
const EXPECTATIONS_KEYS = Object.freeze([
  ...DEPLOYMENT_SURFACES,
  'acknowledgedWriters',
])

export function assertExpectationsArtifactSchema(expectations, stage) {
  const keys = Object.keys(expectations)
  const missing = EXPECTATIONS_KEYS.filter(
    key => !Object.hasOwn(expectations, key),
  )
  if (missing.length > 0) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
      'The reviewed expectations artifact is missing required keys.',
      { stage, missing },
    )
  }
  const extra = keys.filter(key => !EXPECTATIONS_KEYS.includes(key))
  if (extra.length > 0) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
      'The reviewed expectations artifact carries undeclared keys.',
      { stage, extra },
    )
  }
  if (!Array.isArray(expectations.acknowledgedWriters) ||
      expectations.acknowledgedWriters.some(
        writer => typeof writer !== 'string' || writer === '',
      )) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
      'acknowledgedWriters must be an array of non-empty strings.',
      { stage },
    )
  }
  if (!isPlainObject(expectations.gateParameters)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
      'gateParameters must be an object.',
      { stage },
    )
  }
  return true
}

export function assertDeploymentExpectations({
  observed,
  expectations,
  stage,
}) {
  if (!isPlainObject(observed) || !isPlainObject(expectations)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
      'A deployment inventory and reviewed expectations are required.',
      { stage },
    )
  }
  assertExpectationsArtifactSchema(expectations, stage)
  // ALL five surfaces are required. Skipping an absent expected surface meant a
  // reviewed-expectations artifact that simply omitted `rules` silently waived
  // the rules comparison — an expectations file could authorize a write by
  // saying less, which is exactly backwards.
  for (const surface of DEPLOYMENT_SURFACES) {
    if (!Object.hasOwn(expectations, surface)) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
        'The reviewed expectations omit a required deployment surface.',
        { stage, surface },
      )
    }
    if (!Object.hasOwn(observed, surface)) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
        'The deployment inventory omits a required surface.',
        { stage, surface },
      )
    }
    if (canonicalDigest(observed[surface]) !==
        canonicalDigest(expectations[surface])) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
        'The deployed state does not match the reviewed expectations.',
        { stage, surface },
      )
    }
  }

  // The V2 gate must be OFF for the copy stage. Release Order step 11 deploys V2
  // Functions with the gate off; copying under a live gate would expose a
  // half-migrated classroom to real traffic.
  if (stage === WRITE_STAGES.COPY) {
    const gate = observed.gateParameters?.MULTI_TEACHER_V2_ENABLED
    if (gate !== 'false' && gate !== false) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
        'The V2 gate must be off before the copy stage may run.',
        { stage },
      )
    }
  }

  // Shape already proven by assertExpectationsArtifactSchema above.
  const acknowledged = expectations.acknowledgedWriters
  // An ABSENT observation is not an empty observation. Defaulting to [] meant an
  // inventory that could not inspect active writers was treated as proof there
  // were none — the copy would proceed against a live writer precisely when the
  // evidence was missing. The observation must be explicitly complete.
  if (!Array.isArray(observed.activeWriters)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
      'The deployment inventory did not enumerate active writers.',
      { stage },
    )
  }
  if (observed.activeWritersObservationComplete !== true) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
      'The active-writer observation is not attested complete.',
      { stage },
    )
  }
  const unacknowledged = observed.activeWriters.filter(
    writer => !acknowledged.includes(writer),
  )
  if (unacknowledged.length > 0) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
      'An active writer is not acknowledged by the reviewed expectations.',
      { stage, count: unacknowledged.length },
    )
  }
  return true
}

/** Builds a journal event body with the fixed schema envelope. */
function event(kind, payload = {}) {
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, kind: JOURNAL_KIND,
    event: kind, ...payload }
}

/**
 * The complete journal-driven write run.
 *
 * Invocation 1 performs ONLY the initialization transaction and stops with
 * AWAITING_DEPLOYMENT. Invocation 2 resumes at the copy stage. The distinction
 * is derived from the journal alone.
 */
export async function runProductionWrite({
  firestore,
  journal,
  manifest,
  authorization,
  initialization,
  foundation,
  deployment,
  rawReaders,
  readAuthCompatibility,
  nowTimestamp,
  logger,
}) {
  const replay = await journal.replay()
  const { stage, head } = deriveStage(replay)

  if (stage === WRITE_STAGES.BLOCKED) {
    // An indeterminate or failed head must never be advanced automatically.
    return Object.freeze({
      result: WRITE_RESULTS.BLOCKED_INDETERMINATE,
      stage,
      migrationRan: false,
    })
  }

  if (stage === WRITE_STAGES.INITIALIZATION) {
    return await runInitializationStage({
      firestore, journal, replay, head, manifest, authorization,
      initialization, foundation, deployment, rawReaders,
      readAuthCompatibility, nowTimestamp, logger,
    })
  }

  return await runCopyStage({
    firestore, journal, replay, head, manifest, authorization,
    initialization, foundation, deployment, rawReaders,
    readAuthCompatibility, logger,
    completed: stage === WRITE_STAGES.COMPLETE,
  })
}

/**
 * Keeps sequence, predecessor digest, and predecessor event kind in lockstep.
 *
 * Every append needs all three. Threading them as separate mutable locals is how
 * a call site silently loses track of which event it is transitioning from, so
 * the cursor owns them together and no append can omit the predecessor.
 */
function createJournalCursor(journal, replay) {
  let sequence = replay?.exists ? replay.nextSequence : 0
  let previousDigest = replay?.exists ? replay.headDigest : null
  let previousEvent = replay?.exists ? (replay.head?.event ?? null) : null

  return {
    get sequence() { return sequence },
    get previousEvent() { return previousEvent },
    async append(body) {
      const installed = await journal.append(body, {
        expectedSequence: sequence,
        expectedPreviousDigest: previousDigest,
        expectedPreviousEvent: previousEvent,
      })
      sequence += 1
      previousDigest = installed.digest
      previousEvent = body.event
      return installed
    },
  }
}

async function runInitializationStage({
  firestore, journal, replay, head, manifest, authorization,
  initialization, foundation, deployment, rawReaders, readAuthCompatibility,
  nowTimestamp, logger,
}) {
  const recordedInitializedAt = recoverInitializationTimestamp(
    replay, nowTimestamp,
  )
  // Deployment is reinspected immediately before planning or continuing remote
  // writes, on EVERY mutating invocation — never trusted from the journal.
  assertDeploymentExpectations({
    observed: await deployment.readInventory(),
    expectations: deployment.initializationExpectations,
    stage: WRITE_STAGES.INITIALIZATION,
  })

  // The RETAINED manifest — not a fresh read — is the baseline. Reproved before
  // the header is written and before any transaction opens. The digest it
  // returns is what the transaction reasserts atomically.
  const reproved = await reproveRetainedEvidence({
    manifest,
    rawReaders,
    readAuthCompatibility,
    foundation,
    canonicalLoginCode: initialization.canonicalLoginCode,
    formattedLoginCode: initialization.formattedLoginCode,
    stage: WRITE_STAGES.INITIALIZATION,
    // A journal that already records an attempt means remote state may
    // legitimately carry this run's own partial work.
    resuming: replay.exists && replay.events.length > 0,
    expectedFoundationBodiesSha256: replay.exists
      ? replay.events[0]?.foundationBodiesSha256
      : undefined,
    expectedFoundationStableBodiesSha256: replay.exists
      ? replay.events[0]?.foundationStableBodiesSha256
      : undefined,
    expectedTeacherSourceSha256: replay.exists
      ? replay.events[0]?.teacherSourceSha256
      : undefined,
    initializedAt: recordedInitializedAt,
  })
  const boundFoundation = {
    ...foundation,
    reprovedFoundationStateDigest: reproved.foundationStateDigest,
  }
  const initializedClassroomBody = {
    ...foundation.classroom.data,
    studentLoginCode: initialization.formattedLoginCode,
    nextStudentNumber: initialization.nextStudentNumber,
  }
  const derivedInitializedBodySha256 = documentBodyDigest(
    initializedClassroomBody,
  )
  const projectedClassroomData = initialization.projection?.classroom?.data
  const derivedProjectedBodySha256 = documentBodyDigest(
    projectedClassroomData === undefined
      ? initializedClassroomBody
      : {
          ...initializedClassroomBody,
          settings: projectedClassroomData.settings,
          lastBackupAt: projectedClassroomData.lastBackupAt,
        },
  )
  if ((initialization.classroomInitializedBodySha256 !== undefined &&
       initialization.classroomInitializedBodySha256 !==
         derivedInitializedBodySha256) ||
      (initialization.classroomProjectedBodySha256 !== undefined &&
       initialization.classroomProjectedBodySha256 !==
         derivedProjectedBodySha256)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.PLAN_DIVERGED,
      'The initialization classroom digests do not match the planned bodies.',
    )
  }

  const cursor = createJournalCursor(journal, replay)

  // The header binds everything an auditor needs to prove what this run was
  // authorized to do — and binds BOTH expectations digests, so neither can be
  // substituted between the two invocations.
  let plannedHeader
  if (!replay.exists || replay.events.length === 0) {
    plannedHeader = event(JOURNAL_EVENTS.PLANNED, {
      projectId: manifest.projectId,
      teacherUidSha256: sha256Hex(manifest.teacherUid),
      releaseId: manifest.releaseId,
      changeId: manifest.changeId,
      authorizationId: authorization.authorizationId,
      snapshotId: authorization.snapshotId,
      writeFreezeProof: authorization.writeFreezeProof,
      credentialProvenance: authorization.credentialProvenance,
      preflightManifestId: manifest.preflightManifestId,
      preflightChecksum: manifest.preflightChecksum,
      writeAuthorizationSha256: authorization.writeAuthorizationSha256,
      preflightAuthorizationSha256: authorization.preflightAuthorizationSha256,
      credentialSha256: authorization.credentialSha256,
      initializationExpectationsSha256:
        authorization.initializationExpectationsSha256,
      copyExpectationsSha256: authorization.copyExpectationsSha256,
      loginCodeSha256: sha256Hex(initialization.canonicalLoginCode),
      loginCodePathSha256: sha256Hex(
        `classroomLoginCodes/${initialization.canonicalLoginCode}`,
      ),
      classroomIdSha256: sha256Hex(foundation.classroomId),
      nextStudentNumber: initialization.nextStudentNumber,
      initializedAtSeconds: nowTimestamp.seconds,
      initializedAtNanoseconds: nowTimestamp.nanoseconds,
      planDigest: initialization.planDigest,
      batchCount: initialization.batchCount,
      countsBySurface: initialization.countsBySurface,
      // The immutable manifest domains this run is bound to. Recording them in
      // the header is what lets a later invocation — or an auditor — prove the
      // run was planned against the reviewed evidence rather than against
      // whatever production happened to contain at resume time.
      foundationStateSha256: manifest.domainChecksums.foundationState,
      foundationBodiesSha256: reproved.foundationBodiesSha256,
      foundationStableBodiesSha256: reproved.foundationStableBodiesSha256,
      teacherSourceSha256: reproved.teacherSourceSha256,
      classroomInitializedBodySha256:
        derivedInitializedBodySha256,
      classroomProjectedBodySha256:
        derivedProjectedBodySha256,
      legacySourceStateSha256: manifest.domainChecksums.legacySourceState,
      destinationAbsenceSha256: manifest.domainChecksums.destinationAbsence,
      authCompatibilitySha256: manifest.domainChecksums.authCompatibility,
      watermarkSha256: manifest.domainChecksums.identityWatermark,
    })
    await cursor.append(plannedHeader)
  } else {
    plannedHeader = replay.events[0]
    assertHeaderBinding(replay.events[0], {
      manifest, authorization, initialization, foundation,
    })
  }

  // If a prior attempt left initialization in flight, classify remote state
  // rather than blindly retrying the transaction.
  if (head?.event === JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT) {
    const classroom = await rawReaders.readClassroom(foundation.classroomId)
    const code = await rawReaders.readLoginCodeIndexDocument(
      initialization.canonicalLoginCode,
    )
    const classroomApplied = classroom.exists === true &&
      documentBodyDigest(classroom.data) ===
        plannedHeader.classroomInitializedBodySha256
    const codeApplied = isExactLoginCodeIndex({
      document: code,
      classroomId: foundation.classroomId,
      canonicalLoginCode: initialization.canonicalLoginCode,
      initializedAt: recordedInitializedAt,
    })

    if (classroomApplied && codeApplied) {
      await cursor.append(
        event(JOURNAL_EVENTS.INITIALIZATION_VERIFIED, {
          recoveredByClassification: true,
        }),
      )
      return await finishInitialization({ journal, cursor, logger })
    }
    if (classroomApplied !== codeApplied) {
      // Partially applied: a Firestore transaction should be atomic, so this is
      // evidence of interference or a broken assumption. Block for human review.
      await cursor.append(
        event(JOURNAL_EVENTS.INDETERMINATE, { phase: 'initialization' }),
      )
      return Object.freeze({
        result: WRITE_RESULTS.BLOCKED_INDETERMINATE,
        stage: WRITE_STAGES.INITIALIZATION,
        migrationRan: false,
      })
    }
    // Neither applied: safe to retry.
  }

  if (head?.event !== JOURNAL_EVENTS.INITIALIZATION_VERIFIED) {
    // A resumed run reuses the header's initialization Timestamp so a retry
    // cannot stamp a different initializedAt than the one already recorded.
    const initializedAt = recordedInitializedAt
    await cursor.append(
      event(JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT, {
        initializedAtSeconds: initializedAt.seconds,
        initializedAtNanoseconds: initializedAt.nanoseconds,
      }),
    )

    await runInitializationTransaction({
      firestore, foundation: boundFoundation, initialization,
      initializedAt, manifest,
    })

    // Read back and verify exactly before recording success.
    const classroom = await rawReaders.readClassroom(foundation.classroomId)
    const code = await rawReaders.readLoginCodeIndexDocument(
      initialization.canonicalLoginCode,
    )
    if (classroom.exists !== true ||
        documentBodyDigest(classroom.data) !==
          plannedHeader.classroomInitializedBodySha256 ||
        !isExactLoginCodeIndex({
          document: code,
          classroomId: foundation.classroomId,
          canonicalLoginCode: initialization.canonicalLoginCode,
          initializedAt,
        })) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The committed initialization did not read back exactly.',
      )
    }

    await cursor.append(event(JOURNAL_EVENTS.INITIALIZATION_VERIFIED, {}))
  }

  return await finishInitialization({ journal, cursor, logger })
}

/**
 * Recovers the initialization Timestamp from the journal header.
 *
 * A resumed initialization must commit the SAME `initializedAt` the run was
 * planned with. Taking a fresh clock reading on retry would write a different
 * value than the header records, so a readback comparison against retained
 * evidence could never be exact.
 */
export function recoverInitializationTimestamp(replay, fallback) {
  const header = replay?.exists ? replay.events[0] : null
  if (!header || header.event !== JOURNAL_EVENTS.PLANNED) return fallback
  if (!Number.isInteger(header.initializedAtSeconds) ||
      !Number.isInteger(header.initializedAtNanoseconds)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
      'The journal header carries no valid initialization Timestamp.',
    )
  }
  // Rebuilt from the caller's injected Timestamp class so this module keeps
  // importing no Firestore SDK surface. Falls back to a structurally identical
  // plain object when the caller supplied one.
  const constructor = fallback?.constructor
  if (typeof constructor === 'function' && constructor.length >= 2) {
    return new constructor(
      header.initializedAtSeconds, header.initializedAtNanoseconds,
    )
  }
  return Object.freeze({
    seconds: header.initializedAtSeconds,
    nanoseconds: header.initializedAtNanoseconds,
  })
}

/**
 * Appends the awaiting-copy-deployment event and STOPS.
 *
 * No destination student, transaction, history, credential, or log write can
 * occur in this invocation: this function is the only exit from the
 * initialization stage, and it returns before any copy code is reachable.
 */
async function finishInitialization({ cursor, logger }) {
  await cursor.append(event(JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT, {}))
  logger?.log(
    'Initialization committed and verified. MIGRATION HAS NOT RUN. ' +
    'Deploy bridge rules and V2 Functions with the V2 gate off, then run ' +
    'write.js again to perform the copy.',
  )
  return Object.freeze({
    result: WRITE_RESULTS.AWAITING_DEPLOYMENT,
    stage: WRITE_STAGES.INITIALIZATION,
    migrationRan: false,
  })
}

async function runCopyStage({
  firestore, journal, replay, manifest, authorization,
  initialization, foundation, deployment, rawReaders, readAuthCompatibility,
  logger, completed = false,
}) {
  // The COPY expectations artifact is validated here — not the initialization
  // one — and the inventory is reread immediately before continuing.
  assertDeploymentExpectations({
    observed: await deployment.readInventory(),
    expectations: deployment.copyExpectations,
    stage: WRITE_STAGES.COPY,
  })

  const header = replay.events[0]
  // Neither expectations artifact can be substituted between invocations: the
  // header bound both digests when the run was planned.
  if (header.copyExpectationsSha256 !==
        authorization.copyExpectationsSha256 ||
      header.initializationExpectationsSha256 !==
        authorization.initializationExpectationsSha256) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
      'A deployment expectations artifact was substituted between invocations.',
    )
  }
  // The resumed run must be the SAME run, bound to the same manifest, the same
  // artifacts, and the same retained evidence. Every header field is compared;
  // a second invocation presenting a different manifest or a different
  // authorization cannot continue this journal.
  assertHeaderBinding(header, { manifest, authorization, initialization,
    foundation })

  // Rederive the plan from unchanged sources plus the header's exact
  // initialization values. It must reproduce the stored plan digest.
  const plan = buildCopyPlan({
    projection: initialization.projection,
    foundation,
    initialization,
    retainedFoundationBodiesSha256: header.foundationBodiesSha256,
    retainedClassroomInitializedBodySha256:
      header.classroomInitializedBodySha256,
    retainedClassroomProjectedBodySha256:
      header.classroomProjectedBodySha256,
  })
  if (plan.planDigest !== header.planDigest ||
      plan.batches.length !== header.batchCount ||
      canonicalDigest(plan.countsBySurface) !==
        canonicalDigest(header.countsBySurface)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.PLAN_DIVERGED,
      'The rederived plan does not reproduce the retained plan header.',
    )
  }

  const allowedDestinationPaths = new Set([
    ...plan.batches.flatMap(batch =>
      batch.operations.map(operation => operation.path)),
  ])

  // The retained evidence is reproved again on every later invocation, before
  // any copy write. A source, Auth, foundation, or path-set change made after
  // preflight must block rather than become the run's accepted baseline.
  await reproveRetainedEvidence({
    manifest,
    rawReaders,
    readAuthCompatibility,
    foundation,
    canonicalLoginCode: initialization.canonicalLoginCode,
    formattedLoginCode: initialization.formattedLoginCode,
    stage: WRITE_STAGES.COPY,
    resuming: true,
    expectedFoundationBodiesSha256: header.foundationBodiesSha256,
    expectedFoundationStableBodiesSha256:
      header.foundationStableBodiesSha256,
    expectedTeacherSourceSha256: header.teacherSourceSha256,
    requireFullFoundationBodies:
      replay.head.event === JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT,
    requireDestinationAbsence:
      replay.head.event === JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT,
    initializedAt: Object.freeze({
      seconds: header.initializedAtSeconds,
      nanoseconds: header.initializedAtNanoseconds,
    }),
    allowedDestinationPaths,
  })

  const retainedEvidence = {
    legacySourceStateSha256: header.legacySourceStateSha256,
    foundationBodiesSha256: header.foundationStableBodiesSha256,
    teacherSourceSha256: header.teacherSourceSha256,
    watermarkSha256: header.watermarkSha256,
    computeLegacySourceDigest: ({
      legacyClassroomData, flatCredentials, flatAuthLogs,
    }) => hashDomain({
      present: true,
      counts: manifest.observations.counts.legacy,
      credentialCount: flatCredentials.length,
      authLogCount: flatAuthLogs.length,
      noncanonicalValueCount:
        manifest.observations.noncanonicalValueCount ?? 0,
      sources: {
        flatAuthLogs: summarizeHashedSource(
          flatAuthLogs.map(entry =>
            sourceEntryFromEnvelope(entry, 'flatAuthLogs')),
          'flatAuthLogs',
        ),
        flatCredentials: summarizeHashedSource(
          flatCredentials.map(entry =>
            sourceEntryFromEnvelope(entry, 'flatCredentials')),
          'flatCredentials',
        ),
        legacyClassroom: summarizeHashedSource(
          [sourceEntryFromEnvelope(
            legacyClassroomData, 'legacyClassroom',
          )],
          'legacyClassroom',
        ),
      },
    }),
    computeFoundationDigest: ({ teacher, classroom }) => {
      const withoutDelta = { ...classroom.data }
      delete withoutDelta.studentLoginCode
      delete withoutDelta.nextStudentNumber
      delete withoutDelta.settings
      delete withoutDelta.lastBackupAt
      return computeFoundationDigest(teacher.data, withoutDelta)
    },
    computeTeacherSourceDigest: teacher => hashDomain(summarizeHashedSource(
      [sourceEntryFromEnvelope(teacher, 'foundationTeacher')],
      'foundationTeacher',
    )),
    computeWatermarkDigest: ({
      legacyClassroomData, flatCredentials, flatAuthLogs,
      students, transactions, loginHistory, scopedCredentials, scopedAuthLogs,
    }) => {
      const ids = (entries, field) => entries
        .filter(entry => entry.data?.[field] != null)
        .map(entry => entry.data[field])
      return hashDomain(deriveStudentIdWatermark({
        roster: legacyClassroomData.data.students.map(entry => entry?.id),
        credentials: ids(flatCredentials, 'studentId'),
        transactions: legacyClassroomData.data.transactions
          .filter(entry => entry?.studentId != null).map(entry => entry.studentId),
        loginHistory: legacyClassroomData.data.loginHistory
          .filter(entry => entry?.studentId != null).map(entry => entry.studentId),
        authLogs: ids(flatAuthLogs, 'studentId'),
        destinationStudents: ids(students, 'id'),
        destinationCredentials: ids(scopedCredentials, 'studentId'),
        destinationTransactions: ids(transactions, 'studentId'),
        destinationLoginHistory: ids(loginHistory, 'studentId'),
        destinationAuthLogs: ids(scopedAuthLogs, 'studentId'),
      }))
    },
  }

  if (completed) {
    const reconciliation = await readAndReconcileWriteRun({
      rawReaders, foundation, initialization, retainedEvidence,
    })
    return Object.freeze({
      result: WRITE_RESULTS.ALREADY_COMPLETED,
      stage: WRITE_STAGES.COMPLETE,
      migrationRan: false,
      reconciliation,
    })
  }

  const cursor = createJournalCursor(journal, replay)
  const verifiedBatches = new Set(
    replay.events
      .filter(entry => entry.event === JOURNAL_EVENTS.BATCH_VERIFIED)
      .map(entry => entry.batchIndex),
  )
  const head = replay.head

  /**
   * Reads every destination in a batch and proves it is exactly expected-after.
   * A `batch-verified` event asserts the remote state IS the projection, so it
   * may only be appended after this returns.
   */
  async function proveBatchApplied(batch) {
    const observed = new Map()
    for (const operation of batch.operations) {
      observed.set(operation.path, await rawReaders.readDocument(operation.path))
    }
    return classifyBatchState(batch, observed)
  }

  async function blockIndeterminate(batchIndex) {
    await cursor.append(
      event(JOURNAL_EVENTS.INDETERMINATE, { phase: 'copy', batchIndex }),
    )
    return Object.freeze({
      result: WRITE_RESULTS.BLOCKED_INDETERMINATE,
      stage: WRITE_STAGES.COPY,
      migrationRan: false,
    })
  }

  for (const batch of plan.batches) {
    if (verifiedBatches.has(batch.batchIndex)) continue

    const resumingInFlight = head?.event === JOURNAL_EVENTS.BATCH_IN_FLIGHT &&
      head.batchIndex === batch.batchIndex &&
      cursor.previousEvent === JOURNAL_EVENTS.BATCH_IN_FLIGHT
    const resumingCommitted = head?.event === JOURNAL_EVENTS.BATCH_COMMITTED &&
      head.batchIndex === batch.batchIndex &&
      cursor.previousEvent === JOURNAL_EVENTS.BATCH_COMMITTED

    if (resumingInFlight) {
      const classification = await proveBatchApplied(batch)
      if (classification === BATCH_CLASSIFICATIONS.MIXED) {
        return await blockIndeterminate(batch.batchIndex)
      }
      if (classification === BATCH_CLASSIFICATIONS.ALL_AFTER) {
        // The batch committed but crashed before its journal event. Recovery
        // walks the LEGAL path in-flight -> committed -> verified rather than
        // jumping straight to verified, which the transition table forbids and
        // which would make every later replay fail as journal-corrupt.
        await cursor.append(
          event(JOURNAL_EVENTS.BATCH_COMMITTED, {
            batchIndex: batch.batchIndex,
            batchDigest: batch.batchDigest,
            recoveredByClassification: true,
          }),
        )
        await cursor.append(
          event(JOURNAL_EVENTS.BATCH_VERIFIED, {
            batchIndex: batch.batchIndex,
            batchDigest: batch.batchDigest,
            recoveredByClassification: true,
          }),
        )
        continue
      }
      // ALL_BEFORE: nothing was applied, so the batch is retried below. The
      // in-flight head permits a repeated batch-in-flight event.
    } else if (resumingCommitted) {
      const classification = await proveBatchApplied(batch)
      if (classification !== BATCH_CLASSIFICATIONS.ALL_AFTER) {
        // A committed batch whose documents are absent or partial means
        // something outside this writer changed the destination. There is no
        // safe automated recovery: retrying would rewrite state a committed
        // event already claimed, so this blocks for human review.
        return await blockIndeterminate(batch.batchIndex)
      }
      await cursor.append(
        event(JOURNAL_EVENTS.BATCH_VERIFIED, {
          batchIndex: batch.batchIndex,
          batchDigest: batch.batchDigest,
          recoveredByClassification: true,
        }),
      )
      continue
    }

    await cursor.append(
      event(JOURNAL_EVENTS.BATCH_IN_FLIGHT, {
        batchIndex: batch.batchIndex,
        batchDigest: batch.batchDigest,
        operationCount: batch.operations.length,
        estimatedBytes: batch.estimatedBytes,
      }),
    )

    await commitCopyBatch({ firestore, batch })

    await cursor.append(
      event(JOURNAL_EVENTS.BATCH_COMMITTED, {
        batchIndex: batch.batchIndex,
        batchDigest: batch.batchDigest,
      }),
    )

    // Real readback before claiming verification. The commit returning without
    // throwing is not proof the destination holds the projected bytes.
    const applied = await proveBatchApplied(batch)
    if (applied !== BATCH_CLASSIFICATIONS.ALL_AFTER) {
      return await blockIndeterminate(batch.batchIndex)
    }

    await cursor.append(
      event(JOURNAL_EVENTS.BATCH_VERIFIED, {
        batchIndex: batch.batchIndex,
        batchDigest: batch.batchDigest,
      }),
    )
  }

  // A restart whose head is already copy-verifying must NOT append a second
  // copy-verifying event: that transition is illegal and would corrupt the
  // chain. Reconciliation runs and the run then completes or blocks.
  if (cursor.previousEvent !== JOURNAL_EVENTS.COPY_VERIFYING) {
    await cursor.append(event(JOURNAL_EVENTS.COPY_VERIFYING, {}))
  }

  const reconciliation = await readAndReconcileWriteRun({
    rawReaders, foundation, initialization, retainedEvidence,
  })

  await cursor.append(event(JOURNAL_EVENTS.COMPLETED, {}))
  logger?.log('Copy committed and reconciled.')
  return Object.freeze({
    result: WRITE_RESULTS.COMPLETED,
    stage: WRITE_STAGES.COPY,
    migrationRan: true,
    reconciliation,
  })
}

export { formatClassroomCode, normalizeClassroomCode }
export { buildProductionProjection, reconcileProductionWriteRun }

/**
 * Re-exported so callers under `tests/` can construct the exact pre-transaction
 * Timestamp without importing `firebase-admin` directly — it resolves only from
 * `functions/node_modules`, the same convention the read-only handle factory
 * follows. This is a type re-export; it constructs nothing at import time.
 */
export { Timestamp } from 'firebase-admin/firestore'
