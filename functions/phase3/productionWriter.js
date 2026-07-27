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
const MAX_JOURNAL_EVENTS = 100_000

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

export const JOURNAL_SCHEMA_VERSION = 1
export const JOURNAL_KIND = 'phase3-production-write-journal'

/**
 * The event vocabulary. Order in this list is NOT the transition order; the
 * legal transitions are declared separately below.
 */
export const JOURNAL_EVENTS = Object.freeze({
  PLANNED: 'planned',
  INITIALIZATION_IN_FLIGHT: 'initialization-in-flight',
  INITIALIZATION_VERIFIED: 'initialization-verified',
  AWAITING_COPY_DEPLOYMENT: 'awaiting-copy-deployment',
  BATCH_IN_FLIGHT: 'batch-in-flight',
  BATCH_COMMITTED: 'batch-committed',
  BATCH_VERIFIED: 'batch-verified',
  COPY_VERIFYING: 'copy-verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INDETERMINATE: 'indeterminate',
})

/**
 * Legal successors for each event kind.
 *
 * `indeterminate` and `failed` are terminal for automated progress: recovery
 * from them requires human review, which is the entire point of recording them.
 */
const LEGAL_TRANSITIONS = Object.freeze({
  [JOURNAL_EVENTS.PLANNED]: Object.freeze([
    JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT]: Object.freeze([
    JOURNAL_EVENTS.INITIALIZATION_VERIFIED,
    JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.INITIALIZATION_VERIFIED]: Object.freeze([
    JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT]: Object.freeze([
    JOURNAL_EVENTS.BATCH_IN_FLIGHT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.BATCH_IN_FLIGHT]: Object.freeze([
    JOURNAL_EVENTS.BATCH_COMMITTED,
    JOURNAL_EVENTS.BATCH_IN_FLIGHT,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.BATCH_COMMITTED]: Object.freeze([
    JOURNAL_EVENTS.BATCH_VERIFIED,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.BATCH_VERIFIED]: Object.freeze([
    JOURNAL_EVENTS.BATCH_IN_FLIGHT,
    JOURNAL_EVENTS.COPY_VERIFYING,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.COPY_VERIFYING]: Object.freeze([
    JOURNAL_EVENTS.COMPLETED,
    JOURNAL_EVENTS.FAILED,
    JOURNAL_EVENTS.INDETERMINATE,
  ]),
  [JOURNAL_EVENTS.COMPLETED]: Object.freeze([]),
  [JOURNAL_EVENTS.FAILED]: Object.freeze([]),
  [JOURNAL_EVENTS.INDETERMINATE]: Object.freeze([]),
})

/** The deterministic copy surface order. Never reordered at runtime. */
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

/**
 * The exact foundation-state digest.
 *
 * Exported and shared so the entrypoint that BINDS the digest and the
 * transaction that REPROVES it can never compute it two different ways — a
 * drift there would either block every legitimate run or, worse, silently
 * compare nothing meaningful.
 */
export function computeFoundationDigest(teacherData, classroomData) {
  return canonicalDigest({
    teacher: encodeCanonicalFirestoreValue(teacherData),
    classroom: encodeCanonicalFirestoreValue(classroomData),
  })
}

/* ------------------------------------------------------------------------- *
 * Journal secret scanning
 * ------------------------------------------------------------------------- */

/**
 * Key names that must never appear in a journal event at any depth.
 *
 * A journal records HASHES and CLASSIFICATIONS. A raw document body, a login
 * code, a full Firestore path, an email, or a PIN hash in an append-only file
 * that is never deleted would be a durable disclosure, so the scan is applied
 * before any bytes are written.
 */
const FORBIDDEN_JOURNAL_KEYS = Object.freeze(new Set([
  'pin', 'pins', 'pinhash', 'pinhashes', 'password', 'passwords',
  'secret', 'secrets', 'token', 'tokens', 'email', 'emails',
  'emailaddress', 'email_address', 'privatekey', 'private_key',
  'apikey', 'api_key', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'clientsecret', 'client_secret',
  'logincode', 'login_code', 'studentlogincode', 'student_login_code',
  'classroomcode', 'classroom_code', 'code', 'rawcode', 'raw_code',
  'data', 'body', 'document', 'documents', 'contents',
  'path', 'paths', 'documentpath', 'document_path', 'sourcepath',
  'targetpath', 'credentialpath', 'credential_path',
  'credentialbody', 'credential_body', 'rawcredential', 'raw_credential',
  'serviceaccount', 'service_account',
]))

const FORBIDDEN_JOURNAL_SUBSTRINGS = Object.freeze([
  'pinhash', 'privatekey', 'private_key', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'clientsecret', 'client_secret',
  'credentialpath', 'credentialbody', 'rawcredential',
  'serviceaccount', 'service_account',
])

/**
 * Value shapes that indicate leaked material regardless of key name. The
 * Firestore-path pattern is what catches a raw `classrooms/x/students/3` that
 * slipped into an otherwise innocuous field.
 */
const FORBIDDEN_JOURNAL_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\bya29\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/i,
  /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\$2[aby]\$\d{2}\$/,
  /\b(?:classrooms|teachers|studentCredentials|studentAuthLogs|morganBank|classroomLoginCodes)\/[^\s"]+/,
])

function isForbiddenJournalKey(key) {
  const normalized = key.toLowerCase()
  if (FORBIDDEN_JOURNAL_KEYS.has(normalized)) return true
  return FORBIDDEN_JOURNAL_SUBSTRINGS.some(part => normalized.includes(part))
}

/**
 * Walks a candidate event for secret material. Runs before serialization so a
 * leak can never reach the filesystem, and again on read so a hand-edited file
 * cannot reintroduce one.
 */
export function assertNoJournalSecrets(value, label = '$') {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_JOURNAL_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.SECRET_MATERIAL,
          'A journal event contains sensitive material.',
          { label },
        )
      }
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoJournalSecrets(entry, `${label}[${index}]`))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (isForbiddenJournalKey(key)) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.SECRET_MATERIAL,
          'A journal event contains a forbidden field name.',
          { label: `${label}.${key}` },
        )
      }
      assertNoJournalSecrets(entry, `${label}.${key}`)
    }
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

  /** Reads and validates the complete contiguous chain from sequence 0. */
  async function replay() {
    let names
    try {
      names = await fs.readdir(directory)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return Object.freeze({ exists: false, events: Object.freeze([]) })
      }
      throw error
    }

    const eventFiles = names
      .filter(name => /^\d{6}\.json$/.test(name))
      .sort()

    const events = []
    let previousDigest = null
    for (let sequence = 0; sequence < eventFiles.length; sequence += 1) {
      const expectedName = sequenceFilename(sequence)
      if (eventFiles[sequence] !== expectedName) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
          'The journal has a gap or out-of-order sequence file.',
          { sequence },
        )
      }
      const contents = await fs.readFile(
        path.join(directory, expectedName),
        'utf8',
      )
      let parsed
      try {
        parsed = JSON.parse(contents)
      } catch {
        fail(
          PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
          'A journal event is not parseable JSON.',
          { sequence },
        )
      }
      // Canonical round-trip: proves the stored bytes were not hand-edited into
      // an equivalent-but-different form.
      if (serializeCanonicalState(parsed) !== contents) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
          'A journal event is not in canonical serialized form.',
          { sequence },
        )
      }
      assertNoJournalSecrets(parsed, `event[${sequence}]`)
      requireEventShape(parsed, sequence)

      // The hash chain is what makes a mid-chain substitution detectable: each
      // event names its predecessor's digest, so replacing event N invalidates
      // every event after it.
      if (parsed.previousDigest !== previousDigest) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
          'A journal event does not chain to its predecessor.',
          { sequence },
        )
      }
      if (sequence > 0) {
        const previous = events[sequence - 1]
        const legal = LEGAL_TRANSITIONS[previous.event] ?? []
        if (!legal.includes(parsed.event)) {
          fail(
            PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
            'A journal event is not a legal successor of its predecessor.',
            { sequence, from: previous.event, to: parsed.event },
          )
        }
      } else if (parsed.event !== JOURNAL_EVENTS.PLANNED) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
          'A journal must begin with a planned header event.',
        )
      }

      events.push(parsed)
      previousDigest = canonicalDigest(parsed)
      if (sequence >= MAX_JOURNAL_EVENTS) {
        fail(
          PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
          'The journal exceeded its bounded event count.',
        )
      }
    }

    return Object.freeze({
      exists: true,
      events: Object.freeze(events),
      head: events.at(-1),
      headDigest: previousDigest,
      nextSequence: events.length,
    })
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
  async function append(event, { expectedSequence, expectedPreviousDigest }) {
    const body = {
      ...event,
      sequence: expectedSequence,
      previousDigest: expectedPreviousDigest,
    }
    requireEventShape(body, expectedSequence)
    assertNoJournalSecrets(body, 'event')
    const serialized = serializeCanonicalState(body)

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

/** Required fields per event kind. */
const EVENT_BASE_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'event', 'sequence', 'previousDigest',
])

function requireEventShape(event, sequence) {
  if (!isPlainObject(event)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
      'A journal event must be a plain object.',
      { sequence },
    )
  }
  for (const key of EVENT_BASE_KEYS) {
    if (!Object.hasOwn(event, key)) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
        'A journal event is missing a required field.',
        { sequence, field: key },
      )
    }
  }
  if (event.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
      event.kind !== JOURNAL_KIND) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
      'A journal event declares an unsupported schema or kind.',
      { sequence },
    )
  }
  if (!Object.values(JOURNAL_EVENTS).includes(event.event)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
      'A journal event declares an unrecognized event kind.',
      { sequence },
    )
  }
  if (event.sequence !== sequence) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
      'A journal event declares the wrong sequence.',
      { sequence },
    )
  }
  if (sequence === 0) {
    if (event.previousDigest !== null) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
        'The header event must have a null predecessor digest.',
      )
    }
  } else if (typeof event.previousDigest !== 'string' ||
      !SHA256_HEX.test(event.previousDigest)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.JOURNAL_CORRUPT,
      'A journal event has no valid predecessor digest.',
      { sequence },
    )
  }
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
export function buildCopyPlan({ projection, foundation, initialization }) {
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
  operations.push({
    surface: 'classroom',
    type: 'update',
    path: foundation.classroom.path,
    data: {
      settings: projection.classroom.data.settings,
      lastBackupAt: projection.classroom.data.lastBackupAt,
    },
    expectedBefore: 'initialized',
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
      expectedAfterSha256: canonicalDigest(operation.data),
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
  })
}

/* ------------------------------------------------------------------------- *
 * Manifest eligibility
 * ------------------------------------------------------------------------- */

/**
 * Proves a retained manifest may authorize Commit 5 writes.
 *
 * A diagnostic manifest — foundation absent, an acknowledged anomaly, an
 * acknowledged destination count, or a present code — is explicitly NOT
 * write-eligible. Correction A: the existing foundation is created or repaired
 * administratively under Release Order step 8 and preflight is rerun; this
 * writer validates an existing reciprocal foundation and never invents one.
 */
export function assertManifestWriteEligible(manifest, { expectedProjectId }) {
  if (!isPlainObject(manifest)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.INVALID_ARGUMENTS,
      'A retained manifest is required.',
    )
  }
  if (manifest.schemaVersion !== 2) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'Only a schema v2 manifest may authorize a write.',
    )
  }
  if (manifest.outcome !== 'succeeded') {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'Only a succeeded preflight may authorize a write.',
    )
  }
  if (manifest.projectId !== expectedProjectId) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'The retained manifest names a different project than this invocation.',
    )
  }
  const observations = manifest.observations
  if (!isPlainObject(observations)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'The retained manifest has no observations.',
    )
  }
  if (observations.foundationPresent !== true) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'A manifest recording an absent foundation must not authorize a write.',
    )
  }
  if (observations.selectedCodePresent !== false) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'The selected classroom login code was already present at preflight.',
    )
  }
  if (observations.acknowledgedAnomalyCount !== 0) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'An acknowledged-anomaly manifest must not authorize a write.',
    )
  }
  const counts = observations.destinationCounts
  if (!isPlainObject(counts)) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'The retained manifest records no destination counts.',
    )
  }
  // Every surface must be exactly zero, and the login-code index must be one of
  // the surfaces actually counted. A manifest that never examined it cannot
  // satisfy this check by omission.
  if (!Object.hasOwn(counts, 'loginCodeIndex')) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'The retained manifest never counted the login-code index.',
    )
  }
  for (const [surface, count] of Object.entries(counts)) {
    if (count !== 0) {
      fail(
        PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
        'A destination surface was not empty at preflight.',
        { surface },
      )
    }
  }
  if (observations.writeEligible !== true) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.MANIFEST_NOT_ELIGIBLE,
      'The retained manifest does not declare itself write-eligible.',
    )
  }
  return manifest
}

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
    // The classroom update is classified by whether the projected fields are
    // already exactly applied.
    if (!state || state.exists === false) return BATCH_CLASSIFICATIONS.MIXED
    const applied = Object.entries(operation.data).every(([key, value]) =>
      canonicalDigest(state.data?.[key]) === canonicalDigest(value))
    if (applied) after += 1
    else before += 1
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
    if (computeFoundationDigest(teacher, classroom) !==
        foundation.foundationStateDigest) {
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
        const body = snapshot.data()
        const alreadyApplied = Object.entries(operation.data).every(
          ([key, value]) =>
            canonicalDigest(body?.[key]) === canonicalDigest(value),
        )
        decisions.push({
          operation,
          action: alreadyApplied ? 'skip' : 'update',
        })
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
  for (const surface of ['rules', 'functions', 'hosting', 'indexes',
    'gateParameters']) {
    if (!Object.hasOwn(expectations, surface)) continue
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

  const acknowledged = Array.isArray(expectations.acknowledgedWriters)
    ? expectations.acknowledgedWriters
    : null
  if (acknowledged === null) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.DEPLOYMENT_DRIFT,
      'The expectations artifact must enumerate acknowledged active writers.',
      { stage },
    )
  }
  const unacknowledged = (observed.activeWriters ?? []).filter(
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

  if (stage === WRITE_STAGES.COMPLETE) {
    return Object.freeze({
      result: WRITE_RESULTS.ALREADY_COMPLETED,
      stage,
      migrationRan: false,
    })
  }

  if (stage === WRITE_STAGES.INITIALIZATION) {
    return await runInitializationStage({
      firestore, journal, replay, head, manifest, authorization,
      initialization, foundation, deployment, rawReaders, nowTimestamp, logger,
    })
  }

  return await runCopyStage({
    firestore, journal, replay, head, manifest, authorization,
    initialization, foundation, deployment, rawReaders, logger,
  })
}

async function runInitializationStage({
  firestore, journal, replay, head, manifest, authorization,
  initialization, foundation, deployment, rawReaders, nowTimestamp, logger,
}) {
  // Deployment is reinspected immediately before planning or continuing remote
  // writes, on EVERY mutating invocation — never trusted from the journal.
  assertDeploymentExpectations({
    observed: await deployment.readInventory(),
    expectations: deployment.initializationExpectations,
    stage: WRITE_STAGES.INITIALIZATION,
  })

  let sequence = replay.exists ? replay.nextSequence : 0
  let previousDigest = replay.exists ? replay.headDigest : null

  // The header binds everything an auditor needs to prove what this run was
  // authorized to do — and binds BOTH expectations digests, so neither can be
  // substituted between the two invocations.
  if (!replay.exists || replay.events.length === 0) {
    const header = event(JOURNAL_EVENTS.PLANNED, {
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
    })
    const installed = await journal.append(header, {
      expectedSequence: sequence,
      expectedPreviousDigest: previousDigest,
    })
    sequence += 1
    previousDigest = installed.digest
  }

  // If a prior attempt left initialization in flight, classify remote state
  // rather than blindly retrying the transaction.
  if (head?.event === JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT) {
    const classroom = await rawReaders.readClassroom(foundation.classroomId)
    const code = await rawReaders.readLoginCodeIndexDocument(
      initialization.canonicalLoginCode,
    )
    const classroomApplied = classroom.exists === true &&
      classroom.data.studentLoginCode === initialization.formattedLoginCode &&
      classroom.data.nextStudentNumber === initialization.nextStudentNumber
    const codeApplied = code.exists === true &&
      code.data.classroomId === foundation.classroomId &&
      code.data.status === 'active'

    if (classroomApplied && codeApplied) {
      const verified = await journal.append(
        event(JOURNAL_EVENTS.INITIALIZATION_VERIFIED, {
          recoveredByClassification: true,
        }),
        { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
      )
      sequence += 1
      previousDigest = verified.digest
      return await finishInitialization({
        journal, sequence, previousDigest, logger,
      })
    }
    if (classroomApplied !== codeApplied) {
      // Partially applied: a Firestore transaction should be atomic, so this is
      // evidence of interference or a broken assumption. Block for human review.
      await journal.append(
        event(JOURNAL_EVENTS.INDETERMINATE, { phase: 'initialization' }),
        { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
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
    const inFlight = await journal.append(
      event(JOURNAL_EVENTS.INITIALIZATION_IN_FLIGHT, {
        initializedAtSeconds: nowTimestamp.seconds,
        initializedAtNanoseconds: nowTimestamp.nanoseconds,
      }),
      { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
    )
    sequence += 1
    previousDigest = inFlight.digest

    await runInitializationTransaction({
      firestore, foundation, initialization,
      initializedAt: nowTimestamp, manifest,
    })

    // Read back and verify exactly before recording success.
    const classroom = await rawReaders.readClassroom(foundation.classroomId)
    const code = await rawReaders.readLoginCodeIndexDocument(
      initialization.canonicalLoginCode,
    )
    if (classroom.exists !== true ||
        classroom.data.studentLoginCode !== initialization.formattedLoginCode ||
        classroom.data.nextStudentNumber !== initialization.nextStudentNumber ||
        code.exists !== true ||
        code.data.classroomId !== foundation.classroomId ||
        code.data.status !== 'active') {
      fail(
        PRODUCTION_WRITER_CATEGORIES.STATE_DIVERGED,
        'The committed initialization did not read back exactly.',
      )
    }

    const verified = await journal.append(
      event(JOURNAL_EVENTS.INITIALIZATION_VERIFIED, {}),
      { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
    )
    sequence += 1
    previousDigest = verified.digest
  }

  return await finishInitialization({ journal, sequence, previousDigest, logger })
}

/**
 * Appends the awaiting-copy-deployment event and STOPS.
 *
 * No destination student, transaction, history, credential, or log write can
 * occur in this invocation: this function is the only exit from the
 * initialization stage, and it returns before any copy code is reachable.
 */
async function finishInitialization({ journal, sequence, previousDigest, logger }) {
  await journal.append(
    event(JOURNAL_EVENTS.AWAITING_COPY_DEPLOYMENT, {}),
    { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
  )
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
  firestore, journal, replay, authorization,
  initialization, foundation, deployment, rawReaders, logger,
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

  // Rederive the plan from unchanged sources plus the header's exact
  // initialization values. It must reproduce the stored plan digest.
  const plan = buildCopyPlan({
    projection: initialization.projection,
    foundation,
    initialization,
  })
  if (plan.planDigest !== header.planDigest) {
    fail(
      PRODUCTION_WRITER_CATEGORIES.PLAN_DIVERGED,
      'The rederived plan does not reproduce the retained plan digest.',
    )
  }

  let sequence = replay.nextSequence
  let previousDigest = replay.headDigest
  const verifiedBatches = new Set(
    replay.events
      .filter(entry => entry.event === JOURNAL_EVENTS.BATCH_VERIFIED)
      .map(entry => entry.batchIndex),
  )
  const head = replay.head

  for (const batch of plan.batches) {
    if (verifiedBatches.has(batch.batchIndex)) continue

    // A batch left in-flight or committed is classified by reading every
    // document in it before any retry decision.
    const resuming = (head?.event === JOURNAL_EVENTS.BATCH_IN_FLIGHT ||
      head?.event === JOURNAL_EVENTS.BATCH_COMMITTED) &&
      head.batchIndex === batch.batchIndex
    if (resuming) {
      const observed = new Map()
      for (const operation of batch.operations) {
        observed.set(operation.path, await rawReaders.readDocument(operation.path))
      }
      const classification = classifyBatchState(batch, observed)
      if (classification === BATCH_CLASSIFICATIONS.MIXED) {
        await journal.append(
          event(JOURNAL_EVENTS.INDETERMINATE, {
            phase: 'copy', batchIndex: batch.batchIndex,
          }),
          { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
        )
        return Object.freeze({
          result: WRITE_RESULTS.BLOCKED_INDETERMINATE,
          stage: WRITE_STAGES.COPY,
          migrationRan: false,
        })
      }
      if (classification === BATCH_CLASSIFICATIONS.ALL_AFTER) {
        const verified = await journal.append(
          event(JOURNAL_EVENTS.BATCH_VERIFIED, {
            batchIndex: batch.batchIndex,
            batchDigest: batch.batchDigest,
            recoveredByClassification: true,
          }),
          { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
        )
        sequence += 1
        previousDigest = verified.digest
        continue
      }
      // ALL_BEFORE: safe to retry with freshly observed preconditions.
    }

    const inFlight = await journal.append(
      event(JOURNAL_EVENTS.BATCH_IN_FLIGHT, {
        batchIndex: batch.batchIndex,
        batchDigest: batch.batchDigest,
        operationCount: batch.operations.length,
        estimatedBytes: batch.estimatedBytes,
      }),
      { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
    )
    sequence += 1
    previousDigest = inFlight.digest

    await commitCopyBatch({ firestore, batch })

    const committed = await journal.append(
      event(JOURNAL_EVENTS.BATCH_COMMITTED, {
        batchIndex: batch.batchIndex,
        batchDigest: batch.batchDigest,
      }),
      { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
    )
    sequence += 1
    previousDigest = committed.digest

    const verified = await journal.append(
      event(JOURNAL_EVENTS.BATCH_VERIFIED, {
        batchIndex: batch.batchIndex,
        batchDigest: batch.batchDigest,
      }),
      { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
    )
    sequence += 1
    previousDigest = verified.digest
  }

  const verifying = await journal.append(
    event(JOURNAL_EVENTS.COPY_VERIFYING, {}),
    { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
  )
  sequence += 1
  previousDigest = verifying.digest

  const reconciliation = await readAndReconcileWriteRun({
    rawReaders, foundation, initialization,
  })

  await journal.append(
    event(JOURNAL_EVENTS.COMPLETED, {
      countsBySurface: plan.countsBySurface,
    }),
    { expectedSequence: sequence, expectedPreviousDigest: previousDigest },
  )
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
