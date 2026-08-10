import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { cert } from 'firebase-admin/app'

import { serializeCanonicalState } from '../phase2/canonicalState.js'
import { normalizeClassroomCode } from '../phase2b/identityNormalization.js'

import {
  ALLOWED_EMULATOR_PROJECT_ID,
  EXECUTION_CONTEXT,
  PRODUCTION_ENVIRONMENT_CATEGORIES,
  ProductionEnvironmentError,
  assertServiceAccountArtifact,
  parseJsonArtifact,
  readHashedArtifact,
  redactEnvironmentError,
  validateExecutionEnvironment,
  validateExplicitCredential,
  validateRehearsalWriteAuthorization,
  validateWriteAuthorization,
} from './productionEnvironment.js'
import {
  PreflightAbortError,
  createProductionReaders,
  createRawDataReaders,
  createReadOnlyAdminHandles,
  createReadOnlyDataReaders,
  deriveStudentIdWatermark,
  sourceEntryFromEnvelope,
  summarizeHashedSource,
} from './productionPreflight.js'
import {
  JOURNAL_EVENTS,
  ProductionManifestError,
  computeFoundationStateDigest,
  assertManifestWriteEligible,
  createReadOnlyJournalView,
  hashDomain,
  readProductionManifest,
  sha256Hex,
} from './productionManifest.js'
import {
  ProductionReconciliationError,
  readAndReconcileWriteRun,
} from './productionReconciliation.js'
import { verifyReviewedCheckout } from './reviewedCheckout.js'

/**
 * Phase 3 Commit 5 — the read-only re-verification entrypoint.
 *
 * REMOTE READ-ONLY AND LOCAL STATE READ-ONLY.
 *
 * This module deliberately does NOT import `productionWriter.js`. That is a
 * structural guarantee, not a convention: the writer is the only module holding
 * transaction, create, update, and batch code, so not importing it means no
 * mutating call is reachable from this file at all. The shared
 * read-and-reconcile helper lives in `productionReconciliation.js` precisely so
 * this separation can hold.
 *
 * It appends no journal event, persists no manifest, and exposes no cleanup
 * operation. It succeeds only for a completed journal and exactly matching
 * state.
 *
 * Authority: PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md Sections 8, 9.
 */

export const REVERIFY_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  ARGUMENT_REJECTED: 1,
  ENVIRONMENT_REJECTED: 2,
  AUTHORIZATION_REJECTED: 3,
  REVERIFY_FAILED: 4,
  MANIFEST_FAILED: 5,
  JOURNAL_NOT_COMPLETED: 12,
})

/** The same artifact set write.js accepts. No more, no fewer. */
const VALUE_FLAGS = new Map([
  ['--write-authorization-file', 'writeAuthorizationFile'],
  ['--preflight-authorization-file', 'preflightAuthorizationFile'],
  ['--initialization-expectations-file', 'initializationExpectationsFile'],
  ['--copy-expectations-file', 'copyExpectationsFile'],
  ['--credential-file', 'credentialFile'],
])

const FORBIDDEN_FLAGS = Object.freeze(new Set([
  '--teacher-uid', '--teacher', '--uid',
  '--project-id', '--project',
  '--release-id', '--release',
  '--change-id', '--change',
  '--manifest', '--manifest-id', '--manifest-path', '--manifest-file',
  '--manifest-filename', '--manifest-dir',
  '--state-dir', '--state-directory', '--journal-dir', '--journal-path',
  '--stage', '--mode', '--phase', '--step',
  '--resume', '--retry', '--continue', '--restart',
  '--force', '--yes', '--confirm',
  '--dry-run', '--dry-run-override',
  '--production', '--production-override', '--allow-production',
  '--skip-preflight', '--skip-verification', '--bypass',
  '--login-code', '--student-login-code', '--classroom-code',
  '--preflight', '--reverify', '--write', '--repair', '--fix', '--cleanup',
]))

const FORBIDDEN_SUBCOMMANDS = Object.freeze(new Set([
  'write', 'preflight', 'reverify', 'migrate', 'deploy',
  'init', 'initialize', 'copy', 'resume', 'rollback', 'cleanup', 'repair',
]))

const ARTIFACT_ERROR_CATEGORIES = Object.freeze(new Set([
  PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_ARTIFACT,
  PRODUCTION_ENVIRONMENT_CATEGORIES.MALFORMED_CREDENTIAL,
  PRODUCTION_ENVIRONMENT_CATEGORIES.WRONG_PROJECT_CREDENTIAL,
]))

const CHECKOUT_ERROR_CATEGORIES = Object.freeze(new Set([
  PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_DIRTY,
  PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_MISMATCH,
  PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_UNVERIFIABLE,
]))

export class ReverifyArgumentError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'ReverifyArgumentError'
    this.code = 'PHASE3_REVERIFY_ARGUMENT_ERROR'
    this.category = category
    this.details = Object.freeze({ ...details })
  }
}

function failArgument(category, message, details) {
  throw new ReverifyArgumentError(category, message, details)
}

export function parseReverifyArguments(argv) {
  if (!Array.isArray(argv)) {
    failArgument('invalid-arguments', 'Arguments must be provided as an array.')
  }

  const values = {}
  const seen = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (typeof token !== 'string') {
      failArgument('invalid-argument', 'Every argument must be a string.', { index })
    }

    if (token.startsWith('--') && token.includes('=')) {
      const flag = token.slice(0, token.indexOf('='))
      failArgument(
        'inline-value-rejected',
        `${flag} must be given as a separate value, not --flag=value.`,
        { flag, index },
      )
    }

    if (FORBIDDEN_FLAGS.has(token)) {
      failArgument(
        'forbidden-flag',
        `${token} is not accepted by the reverify entrypoint.`,
        { flag: token, index },
      )
    }

    if (FORBIDDEN_SUBCOMMANDS.has(token)) {
      failArgument(
        'forbidden-subcommand',
        `${token} is not a subcommand; reverify is a separate executable.`,
        { token, index },
      )
    }

    if (VALUE_FLAGS.has(token)) {
      if (seen.has(token)) {
        failArgument('duplicate-flag', `Duplicate flag: ${token}.`, { flag: token, index })
      }
      seen.add(token)

      const value = argv[index + 1]
      if (typeof value !== 'string' || value === '' || value.trim() === '' ||
          value.startsWith('--')) {
        failArgument('missing-value', `${token} requires a value.`, { flag: token, index })
      }
      if (value !== value.trim()) {
        failArgument(
          'invalid-value',
          `${token} must not have surrounding whitespace.`,
          { flag: token, index },
        )
      }
      values[VALUE_FLAGS.get(token)] = value
      index += 1
      continue
    }

    if (token.startsWith('--')) {
      failArgument('unknown-flag', `Unknown flag: ${token}.`, { flag: token, index })
    }

    failArgument(
      'positional-argument',
      `Positional arguments are not supported: ${token}.`,
      { index },
    )
  }

  const missing = [...VALUE_FLAGS.keys()].filter(flag => !seen.has(flag))
  if (missing.length > 0) {
    failArgument(
      'missing-required-flag',
      `Missing required flag${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
      { flags: missing },
    )
  }

  return Object.freeze({
    writeAuthorizationFile: values.writeAuthorizationFile,
    preflightAuthorizationFile: values.preflightAuthorizationFile,
    initializationExpectationsFile: values.initializationExpectationsFile,
    copyExpectationsFile: values.copyExpectationsFile,
    credentialFile: values.credentialFile,
  })
}

/**
 * Replays the journal READ-ONLY and requires a completed chain.
 *
 * Reverify never appends, so it takes a replay-only view. A run that has not
 * completed is reported as such rather than being "finished" by this program.
 */
export function requireCompletedJournal(replay) {
  if (!replay?.exists || replay.events.length === 0) {
    failArgument('journal-absent', 'No journal exists for this manifest.')
  }
  const head = replay.head
  if (head.event !== JOURNAL_EVENTS.COMPLETED) {
    failArgument(
      'journal-not-completed',
      'The retained journal does not record a completed write.',
      { head: head.event },
    )
  }
  return replay
}

/** The complete deployment surface set — the same five the writer requires. */
const DEPLOYMENT_SURFACES = Object.freeze([
  'rules', 'functions', 'hosting', 'indexes', 'gateParameters',
])

/**
 * Compares the CURRENT deployment surfaces to the reviewed copy expectations.
 *
 * Every surface must be both expected and observed: an expectations artifact
 * that omits a surface must block rather than silently waive its comparison,
 * and an inventory that could not enumerate active writers must never read as
 * proof that there are none.
 */
export function assertCopyDeploymentState({ observed, expectations }) {
  if (observed === null || typeof observed !== 'object' ||
      expectations === null || typeof expectations !== 'object') {
    failArgument(
      'deployment-drift',
      'A deployment inventory and reviewed expectations are required.',
    )
  }
  const expectedKeys = [...DEPLOYMENT_SURFACES, 'acknowledgedWriters']
  const expectationKeys = Object.keys(expectations)
  if (expectationKeys.length !== expectedKeys.length ||
      expectedKeys.some(key => !Object.hasOwn(expectations, key))) {
    failArgument(
      'unbound-expectations',
      'The copy expectations do not have the exact reviewed surface schema.',
    )
  }
  const canonical = value => serializeCanonicalState(value ?? null)
  for (const surface of DEPLOYMENT_SURFACES) {
    if (!Object.hasOwn(expectations, surface)) {
      failArgument(
        'unbound-expectations',
        'The copy expectations omit a required deployment surface.',
        { surface },
      )
    }
    if (!Object.hasOwn(observed, surface)) {
      failArgument(
        'deployment-drift',
        'The deployment inventory omits a required surface.',
        { surface },
      )
    }
    if (canonical(observed[surface]) !== canonical(expectations[surface])) {
      failArgument(
        'deployment-drift',
        'The deployed state does not match the reviewed expectations.',
        { surface },
      )
    }
  }
  if (!Array.isArray(expectations.acknowledgedWriters)) {
    failArgument(
      'unbound-expectations',
      'The copy expectations must enumerate acknowledged active writers.',
    )
  }
  if (expectations.acknowledgedWriters.some(
    writer => typeof writer !== 'string' || writer === '',
  )) {
    failArgument(
      'unbound-expectations',
      'Acknowledged active-writer identifiers must be non-empty strings.',
    )
  }
  if (!Array.isArray(observed.activeWriters) ||
      observed.activeWritersObservationComplete !== true) {
    failArgument(
      'deployment-drift',
      'The active-writer observation is absent or not attested complete.',
    )
  }
  const unacknowledged = observed.activeWriters.filter(
    writer => !expectations.acknowledgedWriters.includes(writer),
  )
  if (unacknowledged.length > 0) {
    failArgument(
      'deployment-drift',
      'An active writer is not acknowledged by the reviewed expectations.',
      { count: unacknowledged.length },
    )
  }
  const gate = observed.gateParameters?.MULTI_TEACHER_V2_ENABLED
  if (gate !== 'false' && gate !== false) {
    failArgument(
      'deployment-drift',
      'The V2 gate is not in the expected copy-stage state.',
    )
  }
  return true
}

/**
 * Binds the journal header to the manifest, the authorization, and the exact
 * artifact bytes presented to THIS invocation.
 *
 * Reverify is an audit. Without this it would happily "verify" a run whose
 * header records a different manifest, release, authorization, or credential
 * than the artifacts it was handed.
 */
export function assertJournalHeaderBinding({
  header, manifest, validatedAuthorization, artifacts, canonicalLoginCode,
  classroomId,
}) {
  const sha = sha256Hex
  const expected = {
    projectId: manifest.projectId,
    teacherUidSha256: sha(manifest.teacherUid),
    releaseId: manifest.releaseId,
    changeId: manifest.changeId,
    authorizationId: validatedAuthorization.authorizationId,
    snapshotId: validatedAuthorization.snapshotId,
    writeFreezeProof: validatedAuthorization.writeFreezeProof,
    credentialProvenance: validatedAuthorization.credentialProvenance,
    preflightManifestId: manifest.preflightManifestId,
    preflightChecksum: manifest.preflightChecksum,
    writeAuthorizationSha256: artifacts.writeAuthorizationSha256,
    preflightAuthorizationSha256: artifacts.preflightAuthorizationSha256,
    credentialSha256: artifacts.credentialSha256,
    initializationExpectationsSha256: artifacts.initializationExpectationsSha256,
    copyExpectationsSha256: artifacts.copyExpectationsSha256,
    loginCodeSha256: sha(canonicalLoginCode),
    loginCodePathSha256: sha(`classroomLoginCodes/${canonicalLoginCode}`),
    classroomIdSha256: sha(classroomId),
    nextStudentNumber: manifest.observations.watermark.nextStudentNumber,
    foundationStateSha256: manifest.domainChecksums.foundationState,
    legacySourceStateSha256: manifest.domainChecksums.legacySourceState,
    destinationAbsenceSha256: manifest.domainChecksums.destinationAbsence,
    authCompatibilitySha256: manifest.domainChecksums.authCompatibility,
    watermarkSha256: manifest.domainChecksums.identityWatermark,
  }
  for (const [field, value] of Object.entries(expected)) {
    if (header[field] !== value) {
      failArgument(
        'header-binding-mismatch',
        'The journal header does not match the presented evidence.',
        { field },
      )
    }
  }
  return true
}

/**
 * Compares the login-code index document against the header's EXACT recorded
 * initialization Timestamp and the exact key/body shape.
 */
export function assertLoginCodeIndexMatchesHeader({
  document, classroomId, canonicalLoginCode, initializedAt,
}) {
  if (document?.exists !== true) {
    failArgument(
      'login-code-index-absent',
      'The authorized classroom login code index document is absent.',
    )
  }
  if (document.path !== `classroomLoginCodes/${canonicalLoginCode}`) {
    failArgument(
      'login-code-index-mismatch',
      'The login code index document is not at its authorized path.',
    )
  }
  const body = document.data ?? {}
  const keys = Object.keys(body).sort()
  // EXACT body shape: no extra field may have been added to the index document.
  if (keys.length !== 3 || keys[0] !== 'classroomId' ||
      keys[1] !== 'createdAt' || keys[2] !== 'status') {
    failArgument(
      'login-code-index-mismatch',
      'The login code index document does not have its exact reviewed shape.',
      { keys },
    )
  }
  if (body.classroomId !== classroomId || body.status !== 'active') {
    failArgument(
      'login-code-index-mismatch',
      'The login code index document does not name this classroom as active.',
    )
  }
  if (body.createdAt?.seconds !== initializedAt.seconds ||
      body.createdAt?.nanoseconds !== initializedAt.nanoseconds) {
    failArgument(
      'login-code-index-mismatch',
      'The login code index createdAt is not the recorded initialization time.',
    )
  }
  return true
}

/**
 * Enumerates the GLOBAL foundation roots and the FULL login-code index.
 *
 * A scoped read can only confirm the expected documents are right; it cannot
 * detect an EXTRA teacher, classroom, or code reservation created alongside
 * them. Those are exactly the collisions a copy must never leave behind.
 */
export async function assertNoExtraGlobalState({
  rawReaders, manifest, classroomId, canonicalLoginCode,
}) {
  const codeIndex = await rawReaders.readLoginCodeIndex()
  if (codeIndex.length !== 1) {
    failArgument(
      'extra-global-state',
      'The classroom login code index does not hold exactly one document.',
      { count: codeIndex.length },
    )
  }
  if (codeIndex[0].path !== `classroomLoginCodes/${canonicalLoginCode}`) {
    failArgument(
      'extra-global-state',
      'The login code index holds a code this run did not authorize.',
    )
  }
  if (typeof rawReaders.readCollection !== 'function') {
    failArgument(
      'extra-global-state',
      'The foundation root enumeration is unavailable.',
    )
  }
  const [teachers, classrooms] = await Promise.all([
    rawReaders.readCollection('teachers'),
    rawReaders.readCollection('classrooms'),
  ])
  if (teachers.length !== 1 ||
      teachers[0].path !== `teachers/${manifest.teacherUid}`) {
    failArgument(
      'extra-global-state',
      'The teacher root set is not exactly the authorized singleton.',
    )
  }
  if (classrooms.length !== 1 ||
      classrooms[0].path !== `classrooms/${classroomId}`) {
    failArgument(
      'extra-global-state',
      'The classroom root set is not exactly the authorized singleton.',
    )
  }
  return true
}

/** Rebinds the retained preflight authorization without renewing its validity. */
export function recoverReverifyLoginCode({
  manifest, preflightAuthorization, preflightAuthorizationSha256,
  credentialSha256,
}) {
  if (hashDomain({ sha256: preflightAuthorizationSha256 }) !==
      manifest.domainChecksums.authorizationArtifact) {
    failArgument(
      'preflight-authorization-mismatch',
      'The presented preflight authorization is not the retained artifact.',
    )
  }
  for (const [field, expected] of [
    ['projectId', manifest.projectId],
    ['teacherUid', manifest.teacherUid],
    ['releaseId', manifest.releaseId],
    ['changeId', manifest.changeId],
    ['credentialSha256', credentialSha256],
  ]) {
    if (preflightAuthorization?.[field] !== expected) {
      failArgument(
        'preflight-authorization-mismatch',
        'The preflight authorization does not match the retained evidence.',
        { field },
      )
    }
  }
  let canonical
  try {
    canonical = normalizeClassroomCode(
      preflightAuthorization.studentLoginCode,
    )
  } catch {
    failArgument(
      'preflight-authorization-mismatch',
      'The retained login code is malformed.',
    )
  }
  const retainedCodeSha256 = manifest.observations.selectedCodeSha256
  if (canonical !== preflightAuthorization.studentLoginCode ||
      (retainedCodeSha256 !== undefined &&
       sha256Hex(canonical) !== retainedCodeSha256)) {
    failArgument(
      'preflight-authorization-mismatch',
      'The retained login code does not match the code preflight inspected.',
    )
  }
  return canonical
}

/**
 * Builds the retained-evidence comparators the reconciler uses.
 *
 * The derivations are the SAME ones preflight used, so a digest computed here
 * over current state is directly comparable to the retained checksum.
 */
export function buildRetainedEvidence({ manifest, header }) {
  const ids = (entries, field) => entries
    .filter(entry => entry.data?.[field] != null)
    .map(entry => entry.data[field])
  return {
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
      noncanonicalValueCount: manifest.observations.noncanonicalValueCount ?? 0,
      sources: {
        flatAuthLogs: summarizeHashedSource(
          flatAuthLogs.map(e => sourceEntryFromEnvelope(e, 'flatAuthLogs')),
          'flatAuthLogs',
        ),
        flatCredentials: summarizeHashedSource(
          flatCredentials.map(e => sourceEntryFromEnvelope(e, 'flatCredentials')),
          'flatCredentials',
        ),
        legacyClassroom: summarizeHashedSource(
          [sourceEntryFromEnvelope(legacyClassroomData, 'legacyClassroom')],
          'legacyClassroom',
        ),
      },
    }),
    // The foundation digest compares the classroom with the initialization
    // delta removed, matching what preflight recorded before the write ran.
    computeFoundationDigest: ({ teacher, classroom }) => {
      const withoutDelta = { ...classroom.data }
      delete withoutDelta.studentLoginCode
      delete withoutDelta.nextStudentNumber
      delete withoutDelta.settings
      delete withoutDelta.lastBackupAt
      return computeFoundationStateDigest(teacher.data, withoutDelta)
    },
    computeTeacherSourceDigest: teacher => hashDomain(summarizeHashedSource(
      [sourceEntryFromEnvelope(teacher, 'foundationTeacher')],
      'foundationTeacher',
    )),
    computeWatermarkDigest: ({
      legacyClassroomData, flatCredentials, flatAuthLogs,
      students, transactions, loginHistory, scopedCredentials, scopedAuthLogs,
    }) => hashDomain(deriveStudentIdWatermark({
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
    })),
  }
}

export async function runReverifyMain(argv = process.argv.slice(2), dependencies = {}) {
  const logger = dependencies.logger ?? globalThis.console
  const environment = dependencies.environment ?? process.env

  let parsed
  let managedHandles
  try {
    parsed = parseReverifyArguments(argv)
  } catch (error) {
    logger.error(`Reverify rejected arguments: ${error.message}`)
    return { exitCode: REVERIFY_EXIT_CODES.ARGUMENT_REJECTED, error }
  }

  let validatedEnvironment
  try {
    validatedEnvironment = validateExecutionEnvironment(environment)
  } catch (error) {
    const redacted = error instanceof ProductionEnvironmentError
      ? redactEnvironmentError(error)
      : { category: 'unknown' }
    logger.error(`Reverify rejected the environment [${redacted.category}].`)
    return { exitCode: REVERIFY_EXIT_CODES.ENVIRONMENT_REJECTED, error }
  }

  const isProduction =
    validatedEnvironment.context === EXECUTION_CONTEXT.PRODUCTION

  try {
    const preflightAuthorizationArtifact = await readHashedArtifact(
      parsed.preflightAuthorizationFile, dependencies,
    )
    const preflightAuthorization = parseJsonArtifact(
      preflightAuthorizationArtifact.contents,
      'The preflight authorization file',
    )
    if (isProduction) {
      const checkoutVerifier = dependencies.verifyCheckout ??
        verifyReviewedCheckout
      await checkoutVerifier({
        expectedCommitSha: preflightAuthorization.commitSha,
        runGit: dependencies.runGit,
      })
    }

    // Do not open the credential or any write-stage artifact until the same
    // clean reviewed checkout that produced preflight has been proven again.
    const writeAuthorizationArtifact = await readHashedArtifact(
      parsed.writeAuthorizationFile, dependencies,
    )
    const initializationExpectationsArtifact = await readHashedArtifact(
      parsed.initializationExpectationsFile, dependencies,
    )
    const copyExpectationsArtifact = await readHashedArtifact(
      parsed.copyExpectationsFile, dependencies,
    )
    const credentialArtifact = await readHashedArtifact(
      parsed.credentialFile, dependencies,
    )

    const writeAuthorization = parseJsonArtifact(
      writeAuthorizationArtifact.contents, 'The write authorization file',
    )
    const copyExpectations = parseJsonArtifact(
      copyExpectationsArtifact.contents, 'The copy expectations file',
    )

    const nowMillis = dependencies.nowMillis ?? Date.now()
    const validateAuthorization = isProduction
      ? validateWriteAuthorization
      : validateRehearsalWriteAuthorization
    const validatedAuthorization = validateAuthorization(writeAuthorization, {
      environment,
      expectedReleaseId: writeAuthorization.releaseId,
      nowMillis,
    })
    if (validatedAuthorization.initializationExpectationsSha256 !==
          initializationExpectationsArtifact.sha256 ||
        validatedAuthorization.copyExpectationsSha256 !==
          copyExpectationsArtifact.sha256) {
      failArgument(
        'unbound-expectations',
        'A presented expectations artifact is not the authorized one.',
      )
    }

    const manifest = await readProductionManifest(
      validatedAuthorization.preflightManifestId,
      dependencies,
    )
    const canonicalLoginCode = recoverReverifyLoginCode({
      manifest,
      preflightAuthorization,
      preflightAuthorizationSha256: preflightAuthorizationArtifact.sha256,
      credentialSha256: credentialArtifact.sha256,
    })

    // The journal is read and required to be COMPLETE before any audit runs.
    // The default is a READ-ONLY view from productionManifest.js: it exposes
    // `replay` and nothing else, so this program cannot append even by mistake,
    // and reverify never imports productionWriter.js.
    const journal = dependencies.journal ?? createReadOnlyJournalView({
      preflightManifestId: manifest.preflightManifestId,
      ...(dependencies.stateRoot === undefined
        ? {}
        : { stateRoot: dependencies.stateRoot }),
    })
    // Replay-only: the view must expose no mutating operation at all. Checked
    // by key set rather than by naming the forbidden method, so the read-only
    // boundary contract's substring scan stays blunt.
    const journalOperations = Object.keys(journal).filter(
      key => typeof journal[key] === 'function',
    )
    if (!journalOperations.includes('replay') ||
        journalOperations.some(key => key !== 'replay')) {
      failArgument(
        'journal-unavailable',
        'Reverify requires a replay-only journal view with no mutating surface.',
        { operations: journalOperations },
      )
    }
    // Replay failures (including a malformed or forged hash chain) are manifest
    // failures, not merely an unfinished run. Only a valid replay whose head is
    // absent or incomplete receives the dedicated not-completed exit status.
    const journalReplay = await journal.replay()
    let replay
    try {
      replay = requireCompletedJournal(journalReplay)
    } catch (error) {
      logger.error(`Reverify: ${error.message}`)
      return { exitCode: REVERIFY_EXIT_CODES.JOURNAL_NOT_COMPLETED, error }
    }

    // The manifest must be the kind of manifest that could ever have authorized
    // this write. Reverify audits the same eligibility the writer required.
    assertManifestWriteEligible(manifest, {
      expectedProjectId: validatedEnvironment.projectId,
    })
    if (manifest.teacherUid !== validatedAuthorization.teacherUid ||
        manifest.releaseId !== validatedAuthorization.releaseId ||
        manifest.changeId !== validatedAuthorization.changeId) {
      failArgument(
        'authorization-manifest-mismatch',
        'The write authorization does not match the retained manifest.',
      )
    }

    let credential = null
    const parsedCredential = parseJsonArtifact(
      credentialArtifact.contents, 'The credential file',
    )
    if (isProduction) {
      credential = validateExplicitCredential(
        parsedCredential,
        dependencies.credentialFactory ?? cert,
      )
    } else {
      // Emulator: validated as a service-account-shaped artifact naming the
      // EXACT demo project, never constructed into a credential.
      assertServiceAccountArtifact(parsedCredential, ALLOWED_EMULATOR_PROJECT_ID)
    }
    const handles = await (dependencies.createHandles ?? defaultCreateHandles)({
      context: validatedEnvironment.context,
      projectId: validatedEnvironment.projectId,
      credential,
    })
    if (handles && typeof handles.close === 'function') managedHandles = handles

    // Current copy-stage deployment state is compared to the REVIEWED
    // expectations, surface by surface. Reverify compares; it never deploys or
    // repairs. Same strict schema the writer enforces, so an expectations file
    // cannot waive a comparison by omitting a surface.
    const readInventory = dependencies.readDeploymentInventory ??
      defaultDeploymentInventoryReader({
        context: validatedEnvironment.context,
        projectId: validatedEnvironment.projectId,
        credential,
        teacherUid: manifest.teacherUid,
      })
    if (typeof readInventory !== 'function') {
      failArgument(
        'inventory-unavailable',
        'No deployment inventory observation is available to compare.',
      )
    }
    assertCopyDeploymentState({
      observed: await readInventory(),
      expectations: copyExpectations,
    })

    const rawReaders = dependencies.rawReaders ?? createRawDataReaders({
      firestore: handles.firestore,
      teacherUid: manifest.teacherUid,
    })

    // Auth compatibility is REREAD, not assumed from the manifest. A UID
    // collision or incompatible user introduced after the copy is exactly the
    // condition an audit exists to surface.
    const readAuth = dependencies.readAuthCompatibility ??
      createReadOnlyDataReaders({
        firestore: handles.firestore,
        auth: handles.auth,
        teacherUid: manifest.teacherUid,
      }).readAuthCompatibility
    const authState = await readAuth()
    if (authState?.complete !== true ||
        !Array.isArray(authState.sourceEntries) ||
        authState.sourceEntries.length !== authState.examinedUserCount) {
      failArgument(
        'auth-inspection-unavailable',
        'The Auth compatibility observation is not complete.',
      )
    }
    const authCompatibilitySha256 = hashDomain({
      uidCollisions: authState.uidCollisions,
      incompatibleUsers: authState.incompatibleUsers,
      examinedUserCount: authState.examinedUserCount,
      sources: {
        authUsers: summarizeHashedSource(authState.sourceEntries, 'authUsers'),
      },
    })
    if (authCompatibilitySha256 !==
        manifest.domainChecksums.authCompatibility) {
      failArgument(
        'auth-incompatible',
        'Auth compatibility no longer matches the retained preflight evidence.',
      )
    }

    const teacher = await rawReaders.readTeacher()
    if (teacher.exists !== true) {
      failArgument('foundation-absent', 'The teacher foundation is absent.')
    }
    const classroomId = teacher.data.classroomId
    const classroom = await rawReaders.readClassroom(classroomId)
    if (classroom.exists !== true) {
      failArgument('foundation-absent', 'The classroom is absent.')
    }

    // ---- bind to the HISTORICAL record, not to current state ----
    const header = replay.events[0]
    assertJournalHeaderBinding({
      header, manifest, validatedAuthorization,
      artifacts: {
        writeAuthorizationSha256: writeAuthorizationArtifact.sha256,
        preflightAuthorizationSha256: preflightAuthorizationArtifact.sha256,
        credentialSha256: credentialArtifact.sha256,
        initializationExpectationsSha256:
          initializationExpectationsArtifact.sha256,
        copyExpectationsSha256: copyExpectationsArtifact.sha256,
      },
      canonicalLoginCode,
      classroomId,
    })

    // The initialization Timestamp the run actually recorded. Compared exactly:
    // a code-index document stamped with any other time was not written by the
    // run this journal describes.
    const recordedInitializedAt = Object.freeze({
      seconds: header.initializedAtSeconds,
      nanoseconds: header.initializedAtNanoseconds,
    })
    const codeIndexDocument = await rawReaders.readLoginCodeIndexDocument(
      canonicalLoginCode,
    )
    assertLoginCodeIndexMatchesHeader({
      document: codeIndexDocument,
      classroomId,
      canonicalLoginCode,
      initializedAt: recordedInitializedAt,
    })

    // Enumerate the GLOBAL roots and the FULL code index, so an extra teacher,
    // classroom, or code reservation cannot hide behind a scoped read.
    await assertNoExtraGlobalState({
      rawReaders, manifest, classroomId, canonicalLoginCode,
    })

    const reconciliation = await readAndReconcileWriteRun({
      rawReaders,
      foundation: { teacherUid: manifest.teacherUid, classroomId, classroom },
      initialization: {
        canonicalLoginCode,
        formattedLoginCode: classroom.data.studentLoginCode,
        nextStudentNumber: classroom.data.nextStudentNumber,
      },
      // Current state is compared against the RETAINED evidence rather than
      // against itself.
      retainedEvidence: buildRetainedEvidence({ manifest, header }),
    })

    logger.log('Reverify succeeded: state matches the reviewed projection.')
    return {
      exitCode: REVERIFY_EXIT_CODES.SUCCESS,
      reconciliation,
      journalHead: replay.head.event,
    }
  } catch (error) {
    if (error instanceof ReverifyArgumentError) {
      logger.error(`Reverify rejected an artifact: ${error.message}`)
      return { exitCode: REVERIFY_EXIT_CODES.AUTHORIZATION_REJECTED, error }
    }
    if (error instanceof ProductionReconciliationError) {
      logger.error(`Reverify found a mismatch [${error.category}].`)
      return { exitCode: REVERIFY_EXIT_CODES.REVERIFY_FAILED, error }
    }
    if (error instanceof PreflightAbortError) {
      logger.error(`Reverify aborted [${error.category}]: ${error.message}`)
      return { exitCode: REVERIFY_EXIT_CODES.REVERIFY_FAILED, error }
    }
    if (error instanceof ProductionManifestError) {
      logger.error(`Reverify manifest failed [${error.category}].`)
      return { exitCode: REVERIFY_EXIT_CODES.MANIFEST_FAILED, error }
    }
    if (error instanceof ProductionEnvironmentError) {
      const redacted = redactEnvironmentError(error)
      if (CHECKOUT_ERROR_CATEGORIES.has(error.category)) {
        logger.error(`Reverify rejected the checkout [${redacted.category}].`)
        return { exitCode: REVERIFY_EXIT_CODES.AUTHORIZATION_REJECTED, error }
      }
      if (ARTIFACT_ERROR_CATEGORIES.has(error.category)) {
        logger.error(`Reverify rejected an artifact [${redacted.category}].`)
        return { exitCode: REVERIFY_EXIT_CODES.AUTHORIZATION_REJECTED, error }
      }
      logger.error(`Reverify rejected the environment [${redacted.category}].`)
      return { exitCode: REVERIFY_EXIT_CODES.ENVIRONMENT_REJECTED, error }
    }
    logger.error(`Reverify failed: ${error?.message ?? 'unknown error'}`)
    return { exitCode: REVERIFY_EXIT_CODES.REVERIFY_FAILED, error }
  } finally {
    if (managedHandles !== undefined) {
      try {
        await managedHandles.close()
      } catch {
        logger.error('Reverify handle cleanup failed.')
      }
    }
  }
}

/**
 * The DEFAULT read-only handle factory.
 *
 * The same factory preflight and write use. Reverify holds only read handles;
 * it never imports the writer, so no transaction, batch, create, or update call
 * is reachable from this file at all.
 */
let reverifyHandleSequence = 0
async function defaultCreateHandles({ context, projectId, credential }) {
  if (context === EXECUTION_CONTEXT.PRODUCTION) {
    if (!credential || typeof credential.getAccessToken !== 'function') {
      failArgument(
        'credential-required',
        'A production reverify requires an explicit validated credential.',
      )
    }
    return createReadOnlyAdminHandles({
      projectId,
      credential,
      appName: `phase3-reverify-${process.pid}-${reverifyHandleSequence += 1}`,
    })
  }
  return createReadOnlyAdminHandles({
    projectId,
    appName: `phase3-reverify-${process.pid}-${reverifyHandleSequence += 1}`,
  })
}

/**
 * The DEFAULT bounded, READ-ONLY deployment-inventory reader.
 *
 * Identical bounds to the writer's: fixed origins, bounded pagination,
 * per-request timeouts, redirect rejection. Reverify compares; it never deploys
 * or repairs.
 */
function defaultDeploymentInventoryReader({ context, projectId, credential,
  teacherUid }) {
  if (context !== EXECUTION_CONTEXT.PRODUCTION) return null
  return async () => {
    const readers = createProductionReaders({
      projectId, teacherUid, credential,
    })
    try {
      const [inventory, writers] = await Promise.all([
        readers.readDeploymentInventory(),
        readers.readActiveWriters(),
      ])
      return Object.freeze({
        rules: inventory.rules,
        functions: inventory.functions,
        hosting: inventory.hosting,
        indexes: inventory.indexes,
        gateParameters: inventory.gateParameters,
        activeWriters: writers.writers,
        activeWritersObservationComplete:
          inventory.complete === true && writers.complete === true,
      })
    } finally {
      await readers.close()
    }
  }
}

const isDirectExecution = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectExecution) {
  runReverifyMain().then(({ exitCode }) => {
    process.exitCode = exitCode
  }).catch(() => {
    process.exitCode = REVERIFY_EXIT_CODES.REVERIFY_FAILED
  })
}
