// Phase 3 Commit 3 — production preflight behavioral tests.
//
// EVIDENCE LAYER: behavioral unit tests with injected readers. Every abort
// category is exercised against the real runProductionPreflight. Spies prove no
// mutating Firestore/Auth/control-plane operation is reachable. No emulator, no
// network, no process.env mutation — environments are constructed inline.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  CLASSROOM_SUBCOLLECTION_SURFACES,
  COLLECTION_ENUMERATION_REQUIREMENT,
  DESTINATION_SURFACES,
  PREFLIGHT_ABORT_CATEGORIES,
  PRODUCTION_PREFLIGHT_AUTHORIZATION_KIND,
  PRODUCTION_PREFLIGHT_MAX_AUTHORIZATION_MS,
  PRODUCTION_GOOGLE_API_ORIGINS,
  PreflightAbortError,
  createBoundedGoogleApiClient,
  createProductionControlPlaneReaders,
  createProductionReaders,
  createReadOnlyDataReaders,
  deriveStudentIdWatermark,
  numericStudentId,
  runProductionPreflight,
  validateReadAuthorization,
} from './productionPreflight.js'
import { PREFLIGHT_EXIT_CODES, runPreflightMain } from './preflight.js'
import {
  PRODUCTION_ENVIRONMENT_CATEGORIES,
  ProductionEnvironmentError,
} from './productionEnvironment.js'
import { CHECKSUM_DOMAINS, hashDomain } from './productionManifest.js'
import {
  formatClassroomCode,
  normalizeClassroomCode,
} from '../phase2b/identityNormalization.js'

const PRODUCTION_ENVIRONMENT = Object.freeze({ GCLOUD_PROJECT: 'morgan-bank' })
const TEACHER_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'
const CREDENTIAL_SHA = 'c'.repeat(64)
const EXPECTATIONS_SHA = 'e'.repeat(64)
const AUTHORIZATION_SHA = 'd'.repeat(64)
const COMMIT_SHA = 'bdfd551b925dc24168b24bfc6d6dee7f73918c65'
const NOW = Date.parse('2026-07-26T18:00:00.000Z')
const OBSERVED_AT = '2026-07-26T18:00:00.000Z'

/**
 * A canonical classroom login code: uppercase, unformatted, exactly eight
 * characters drawn from the unambiguous alphabet. `normalizeClassroomCode` would
 * happily NORMALIZE `bcdf-ghjk`, ` BCDFGHJK `, or `BCDF GHJK` into this same
 * value — the read-authorization rule is stricter and requires the artifact to
 * already state it in exactly this form.
 */
const CANONICAL_LOGIN_CODE = 'BCDFGHJK'

/**
 * Builds `n` valid per-document evidence entries.
 *
 * Digests are derived from a label so they are distinct and reproducible without
 * embedding any identity-bearing string.
 */
function sourceEntries(label, count, overrides = []) {
  const entries = Array.from({ length: count }, (unused, index) => ({
    pathHash: createHash('sha256').update(`${label}/path/${index}`).digest('hex'),
    // Exact Firestore precision, not an ISO millisecond string.
    updateTime: { seconds: 1_785_000_000 + index, nanoseconds: 123_456_789 },
    documentHash: createHash('sha256').update(`${label}/body/${index}`).digest('hex'),
  }))
  overrides.forEach((override, index) => {
    if (override !== undefined) entries[index] = { ...entries[index], ...override }
  })
  return entries
}

function authorization(overrides = {}) {
  return {
    kind: PRODUCTION_PREFLIGHT_AUTHORIZATION_KIND,
    projectId: 'morgan-bank',
    commitSha: COMMIT_SHA,
    teacherUid: TEACHER_UID,
    releaseId: 'phase3-rel-2026-07-26a',
    changeId: 'CHG-2026-07-26-001',
    authorizationId: 'AUTH-2026-07-26-001',
    credentialProvenance: 'operator-workstation-key-rotated',
    credentialSha256: CREDENTIAL_SHA,
    expectationsSha256: EXPECTATIONS_SHA,
    // Already canonical: uppercase, unformatted, exactly eight unambiguous
    // characters. Any other rendering of the same code must be rejected.
    studentLoginCode: CANONICAL_LOGIN_CODE,
    notBefore: '2026-07-26T17:00:00.000Z',
    notAfter: '2026-07-26T19:00:00.000Z',
    ...overrides,
  }
}

function complete(payload) {
  return { complete: true, ...payload }
}

function expectations(overrides = {}) {
  return {
    deployment: {
      rules: { release: 'rules-release-42', checksum: 'a'.repeat(64) },
      functions: { studentPinLoginV2: 'rev-7' },
      hosting: { release: 'hosting-99' },
      indexes: { composite: 'none' },
      gateParameters: { MULTI_TEACHER_V2_ENABLED: 'false' },
    },
    acknowledgedWriters: ['legacy-teacher-browser'],
    acknowledgedAnomalies: [],
    acknowledgedDestinationCounts: {},
    ...overrides,
  }
}

/**
 * A complete destination reader result.
 *
 * Every surface in DESTINATION_SURFACES gets a count, an evidence set, and a raw
 * student-ID reference set. `counts` defaults to the evidence cardinality so a
 * fixture cannot accidentally declare an unsubstantiated count.
 */
function destinationResult({
  entries = {},
  ids = {},
  counts,
  coverage = {},
  selectedCodePresent = false,
} = {}) {
  const bySurface = Object.fromEntries(
    DESTINATION_SURFACES.map(surface => [surface, entries[surface] ?? []]),
  )
  const resolvedCounts = counts ?? Object.fromEntries(
    DESTINATION_SURFACES.map(surface => [surface, bySurface[surface].length]),
  )
  const resolvedIds = {
    destinationStudents: ids.destinationStudents ?? [],
    destinationCredentials: ids.destinationCredentials ?? [],
    destinationTransactions: ids.destinationTransactions ?? [],
    destinationLoginHistory: ids.destinationLoginHistory ?? [],
    destinationAuthLogs: ids.destinationAuthLogs ?? [],
  }
  const sourceSurface = {
    destinationStudents: 'classroomStudents',
    destinationCredentials: 'scopedCredentials',
    destinationTransactions: 'classroomTransactions',
    destinationLoginHistory: 'classroomLoginHistory',
    destinationAuthLogs: 'scopedLogs',
  }
  return complete({
    counts: resolvedCounts,
    sourceEntriesBySurface: bySurface,
    studentIdsBySurface: resolvedIds,
    studentIdCoverageBySurface: Object.fromEntries(
      Object.entries(resolvedIds).map(([setName, values]) => {
        const documentCount = resolvedCounts[sourceSurface[setName]]
        return [setName, coverage[setName] ?? {
          referencedCount: values.length,
          unassignedCount: Math.max(0, documentCount - values.length),
          inconsistentCount: 0,
        }]
      }),
    ),
    selectedCodePresent,
  })
}

/** A foundation reader result with enumerated roots. */
function foundationResult(overrides = {}) {
  const present = overrides.present ?? true
  const base = present
    ? {
      present: true,
      reciprocal: true,
      teacherStatus: 'active',
      classroomId: 'abc123',
      anomalies: [],
      sourceEntries: sourceEntries('foundation', 2),
      roots: { teacherIds: [TEACHER_UID], classroomIds: ['abc123'] },
    }
    : {
      present: false,
      anomalies: [],
      sourceEntries: [],
      roots: { teacherIds: [], classroomIds: [] },
    }
  return complete({ ...base, ...overrides })
}

/** Readers that all report healthy, complete, pre-migration production state. */
function readers(overrides = {}) {
  const base = {
    readDeploymentInventory: async () => complete({
      rules: { release: 'rules-release-42', checksum: 'a'.repeat(64) },
      functions: { studentPinLoginV2: 'rev-7' },
      hosting: { release: 'hosting-99' },
      indexes: { composite: 'none' },
      gateParameters: { MULTI_TEACHER_V2_ENABLED: 'false' },
    }),
    readActiveWriters: async () => complete({
      writers: ['legacy-teacher-browser'],
    }),
    readLegacyClassroomAggregate: async () => complete({
      counts: { students: 3, transactions: 10, loginHistory: 5 },
      studentIds: ['1', '2', '3'],
      transactionStudentIds: ['1', '2'],
      loginHistoryStudentIds: ['3'],
      noncanonicalValueCount: 0,
      anomalies: [],
      present: true,
      sourceEntries: sourceEntries('legacy', 1),
    }),
    readFlatCredentials: async () => complete({
      count: 3,
      studentIds: ['1', '2', '3'],
      duplicateLoginIds: 0,
      duplicateStudentIds: 0,
      noncanonicalLoginIds: 0,
      anomalies: [],
      sourceEntries: sourceEntries('credentials', 3),
    }),
    readFlatAuthLogs: async () => complete({
      count: 12,
      studentIds: ['1'],
      anomalies: [],
      sourceEntries: sourceEntries('authLogs', 12),
    }),
    readFoundation: async () => foundationResult(),
    readDestinationPaths: async () => destinationResult(),
    readAuthCompatibility: async () => complete({
      uidCollisions: 0,
      incompatibleUsers: 0,
      examinedUserCount: 3,
      sourceEntries: sourceEntries('authUsers', 3),
    }),
  }
  return { ...base, ...overrides }
}

/** The report a conforming persister returns for a manifest it retained. */
function echo(manifest) {
  return {
    preflightManifestId: manifest.preflightManifestId,
    preflightChecksum: manifest.preflightChecksum,
    manifestPath: `/state/preflight-${manifest.preflightManifestId}.json`,
  }
}

async function run(overrides = {}) {
  return runProductionPreflight({
    environment: PRODUCTION_ENVIRONMENT,
    readers: readers(),
    authorization: authorization(),
    expectations: expectations(),
    credentialSha256: CREDENTIAL_SHA,
    expectationsSha256: EXPECTATIONS_SHA,
    authorizationSha256: AUTHORIZATION_SHA,
    teacherUid: TEACHER_UID,
    nowMillis: NOW,
    observedAt: OBSERVED_AT,
    // A conforming persister echoes the identity of the manifest it was handed,
    // as the real one does. Persistence is mandatory, so this cannot be omitted.
    persistManifest: async manifest => echo(manifest),
    ...overrides,
  })
}

async function assertAborts(overrides, category, message) {
  await assert.rejects(() => run(overrides), error => {
    assert.ok(
      error instanceof PreflightAbortError,
      `${message}: expected PreflightAbortError, got ${error?.name}: ${error?.message}`,
    )
    assert.equal(error.category, category, `${message} (got ${error.category})`)
    assert.equal(error.blocking, true)
    return true
  }, message)
}

describe('Phase 3 production preflight', () => {
  describe('happy path', () => {
    it('succeeds and produces every checksum domain', async () => {
      const result = await run()
      assert.equal(result.outcome, 'succeeded')
      assert.equal(result.projectId, 'morgan-bank')
      assert.match(result.preflightManifestId, /^[0-9a-f]{64}$/)
      for (const domain of CHECKSUM_DOMAINS) {
        assert.match(
          result.domainChecksums[domain],
          /^[0-9a-f]{64}$/,
          `${domain} must have a checksum`,
        )
      }
    })

    it('derives the watermark above the historical maximum', async () => {
      const result = await run()
      assert.equal(result.watermark.observedMaximum, 3)
      assert.equal(result.watermark.nextStudentNumber, 4)
    })

    it('is deterministic: identical state yields identical checksums', async () => {
      const first = await run()
      const second = await run()
      assert.equal(first.preflightManifestId, second.preflightManifestId)
      assert.deepEqual(
        { ...first.domainChecksums },
        { ...second.domainChecksums },
      )
    })

    it('changes the manifest ID when any observed value changes', async () => {
      const baseline = await run()
      const changed = await run({
        readers: readers({
          readFlatAuthLogs: async () => complete({
            count: 13, studentIds: ['1'], anomalies: [],
            sourceEntries: sourceEntries('authLogs', 13),
          }),
        }),
      })
      assert.notEqual(baseline.preflightManifestId, changed.preflightManifestId)
    })
  })

  describe('environment guard runs before any reader', () => {
    it('aborts on an unrecognized project without invoking a reader', async () => {
      let invoked = 0
      const counting = Object.fromEntries(
        Object.entries(readers()).map(([name, fn]) => [
          name,
          async (...args) => { invoked += 1; return fn(...args) },
        ]),
      )

      await assert.rejects(() => run({
        environment: { GCLOUD_PROJECT: 'morgan-bank-staging' },
        readers: counting,
      }))
      assert.equal(invoked, 0, 'no reader may run before the environment passes')
    })

    it('aborts on an emulator-contaminated production environment', async () => {
      await assert.rejects(() => run({
        environment: {
          GCLOUD_PROJECT: 'morgan-bank',
          FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        },
      }))
    })

    it('aborts before readers when the authorization is unbound', async () => {
      let invoked = 0
      const counting = Object.fromEntries(
        Object.entries(readers()).map(([name, fn]) => [
          name,
          async (...args) => { invoked += 1; return fn(...args) },
        ]),
      )
      await assertAborts(
        { readers: counting, credentialSha256: 'f'.repeat(64) },
        PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_UNBOUND,
        'unbound credential must abort',
      )
      assert.equal(invoked, 0, 'authorization must be validated before reads')
    })

    it('rejects the wrong reviewed checkout before opening expectations or credential bytes',
      async () => {
        const pathsRead = []
        let readerFactoryCalls = 0
        const result = await runPreflightMain([
          '--teacher-uid', TEACHER_UID,
          '--authorization-file', '/artifacts/authorization.json',
          '--expectations-file', '/artifacts/expectations.json',
          '--credential-file', '/artifacts/credential.json',
        ], {
          environment: { GCLOUD_PROJECT: 'morgan-bank' },
          readFile: async filePath => {
            pathsRead.push(filePath)
            if (filePath === '/artifacts/authorization.json') {
              return JSON.stringify({ commitSha: COMMIT_SHA })
            }
            throw new Error('no later artifact may be opened')
          },
          verifyCheckout: async ({ expectedCommitSha }) => {
            assert.equal(expectedCommitSha, COMMIT_SHA)
            throw new ProductionEnvironmentError(
              PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_MISMATCH,
              'blocked test checkout',
            )
          },
          productionReaderFactory: () => {
            readerFactoryCalls += 1
            throw new Error('no reader may be constructed')
          },
          logger: { log() {}, error() {} },
        })

        assert.equal(result.exitCode, PREFLIGHT_EXIT_CODES.AUTHORIZATION_REJECTED)
        assert.equal(result.error.category,
          PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_MISMATCH)
        assert.deepEqual(pathsRead, ['/artifacts/authorization.json'])
        assert.equal(readerFactoryCalls, 0)
      })
  })

  describe('read authorization', () => {
    it('accepts a complete, bound, unexpired authorization', () => {
      const validated = validateReadAuthorization({
        authorization: authorization(),
        credentialSha256: CREDENTIAL_SHA,
        expectationsSha256: EXPECTATIONS_SHA,
        teacherUid: TEACHER_UID,
        projectId: 'morgan-bank',
        nowMillis: NOW,
      })
      assert.equal(validated.authorizationId, 'AUTH-2026-07-26-001')
      assert.equal(validated.commitSha, COMMIT_SHA)
      assert.equal(validated.canonicalLoginCode, CANONICAL_LOGIN_CODE)
    })

    it('rejects every non-canonical rendering the normalizer would accept', () => {
      // This is the crux of the canonical-code rule. `normalizeClassroomCode` is a
      // NORMALIZER: each value below normalizes successfully to BCDFGHJK, so a
      // check that merely called it would accept all of them. The authorization
      // rule additionally requires byte-for-byte identity with the canonical form,
      // so the reviewed artifact states the code in exactly one way.
      for (const variant of [
        'bcdfghjk',      // lowercase
        'BCDF-GHJK',     // formatted with the display hyphen
        'bcdf-ghjk',     // lowercase and formatted
        ' BCDFGHJK',     // leading whitespace
        'BCDFGHJK ',     // trailing whitespace
        'BCDF GHJK',     // internal space
      ]) {
        // Prove the premise: the Phase 2B normalizer really does accept it.
        assert.equal(
          normalizeClassroomCode(variant),
          CANONICAL_LOGIN_CODE,
          `${JSON.stringify(variant)} must normalize to the canonical code`,
        )
        // And prove the authorization rule is strictly stronger.
        assert.throws(
          () => validateReadAuthorization({
            authorization: authorization({ studentLoginCode: variant }),
            credentialSha256: CREDENTIAL_SHA,
            expectationsSha256: EXPECTATIONS_SHA,
            teacherUid: TEACHER_UID,
            projectId: 'morgan-bank',
            nowMillis: NOW,
          }),
          error => error.category ===
            PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
          `${JSON.stringify(variant)} must be rejected as non-canonical`,
        )
      }
    })

    it('rejects a code the normalizer itself refuses', () => {
      // Ambiguous characters, wrong length, and invalid punctuation never reach
      // the identity comparison at all.
      for (const invalid of ['BCDFGHJ', 'BCDFGHJKL', 'BCDF0HJK', 'BCDF@HJK', '']) {
        assert.throws(
          () => validateReadAuthorization({
            authorization: authorization({ studentLoginCode: invalid }),
            credentialSha256: CREDENTIAL_SHA,
            expectationsSha256: EXPECTATIONS_SHA,
            teacherUid: TEACHER_UID,
            projectId: 'morgan-bank',
            nowMillis: NOW,
          }),
          error => error.category ===
            PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
          `${JSON.stringify(invalid)} must be rejected`,
        )
      }
    })

    it('binds the classroom root format and index ID to the same code', () => {
      // The classroom root stores the FORMATTED code; the index document ID is the
      // canonical unformatted value. Pinned together so the two can never drift.
      assert.equal(formatClassroomCode(CANONICAL_LOGIN_CODE), 'BCDF-GHJK')
      assert.equal(normalizeClassroomCode('BCDF-GHJK'), CANONICAL_LOGIN_CODE)
    })

    it('aborts on each individually missing field', async () => {
      for (const field of Object.keys(authorization())) {
        const incomplete = authorization()
        delete incomplete[field]
        await assertAborts(
          { authorization: incomplete },
          PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
          `missing ${field} must abort`,
        )
      }
    })

    it('aborts on an unsupported extra field', async () => {
      await assertAborts(
        { authorization: { ...authorization(), approvedBy: 'someone' } },
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
        'extra authorization field must abort',
      )
    })

    it('aborts when the authorization names a different project or teacher', async () => {
      await assertAborts(
        { authorization: authorization({ projectId: 'demo-x' }) },
        PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_MISMATCH,
        'wrong project must abort',
      )
      await assertAborts(
        { authorization: authorization({ teacherUid: 'someone-else' }) },
        PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_MISMATCH,
        'wrong teacher must abort',
      )
    })

    it('aborts when the presented artifacts are not the authorized ones', async () => {
      await assertAborts(
        { credentialSha256: 'f'.repeat(64) },
        PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_UNBOUND,
        'credential not bound must abort',
      )
      await assertAborts(
        { expectationsSha256: 'f'.repeat(64) },
        PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_UNBOUND,
        'expectations not bound must abort',
      )
    })

    it('aborts outside the validity interval, on both sides', async () => {
      await assertAborts(
        { nowMillis: Date.parse('2026-07-26T16:59:59.000Z') },
        PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_EXPIRED,
        'before notBefore must abort',
      )
      await assertAborts(
        { nowMillis: Date.parse('2026-07-26T19:00:01.000Z') },
        PREFLIGHT_ABORT_CATEGORIES.AUTHORIZATION_EXPIRED,
        'after notAfter must abort',
      )
    })

    it('aborts on an inverted or empty validity interval', async () => {
      await assertAborts(
        {
          authorization: authorization({
            notBefore: '2026-07-26T23:00:00.000Z',
            notAfter: '2026-07-26T17:00:00.000Z',
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
        'inverted interval must abort',
      )
    })

    it('enforces the authorization kind, full commit SHA, and two-hour maximum', async () => {
      assert.equal(PRODUCTION_PREFLIGHT_MAX_AUTHORIZATION_MS, 7_200_000)
      for (const invalid of [
        authorization({ kind: 'phase3-production-control-plane-inventory' }),
        authorization({ commitSha: 'not-a-full-commit' }),
        authorization({ commitSha: 'A'.repeat(40) }),
        authorization({
          notBefore: '2026-07-26T16:59:59.999Z',
          notAfter: '2026-07-26T19:00:00.000Z',
        }),
      ]) {
        await assertAborts(
          { authorization: invalid },
          PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
          'kind, commit, and maximum-window violations must abort',
        )
      }
    })

    it('aborts on unparseable validity bounds and non-canonical identifiers', async () => {
      await assertAborts(
        { authorization: authorization({ notAfter: 'whenever' }) },
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
        'unparseable bound must abort',
      )
      await assertAborts(
        { authorization: authorization({ changeId: 'has space' }) },
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
        'non-canonical changeId must abort',
      )
      await assertAborts(
        { authorization: authorization({ credentialSha256: 'nothex' }) },
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
        'non-SHA256 checksum must abort',
      )
    })
  })

  describe('completeness and pagination', () => {
    it('aborts when any reader reports an incomplete result', async () => {
      for (const name of Object.keys(readers())) {
        await assertAborts(
          { readers: readers({ [name]: async () => ({ complete: false }) }) },
          PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
          `${name} incomplete must abort`,
        )
      }
    })

    it('aborts when a reader reports unread pages', async () => {
      await assertAborts(
        {
          readers: readers({
            readFlatCredentials: async () => ({
              complete: true, nextPageToken: 'more', count: 3,
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
        'nextPageToken must abort',
      )
      await assertAborts(
        {
          readers: readers({
            readFlatAuthLogs: async () => ({
              complete: true, truncated: true, count: 3,
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
        'truncated must abort',
      )
    })

    it('aborts when a reader returns no structured result', async () => {
      await assertAborts(
        { readers: readers({ readFoundation: async () => null }) },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'null result must abort',
      )
    })

    it('aborts when a required reader is absent', async () => {
      const incomplete = readers()
      delete incomplete.readAuthCompatibility
      await assertAborts(
        { readers: incomplete },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'missing reader must abort',
      )
    })

    it('aborts when a reader throws rather than treating it as empty', async () => {
      await assert.rejects(() => run({
        readers: readers({
          readLegacyClassroomAggregate: async () => {
            throw new Error('deadline exceeded')
          },
        }),
      }))
    })
  })

  describe('deployment inventory versus expectations', () => {
    it('aborts on an artifact expectations do not describe', async () => {
      await assertAborts(
        {
          readers: readers({
            readDeploymentInventory: async () => complete({
              rules: { release: 'rules-release-42', checksum: 'a'.repeat(64) },
              functions: { studentPinLoginV2: 'rev-7', mysteryFn: 'rev-1' },
              hosting: { release: 'hosting-99' },
              indexes: { composite: 'none' },
              gateParameters: { MULTI_TEACHER_V2_ENABLED: 'false' },
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.UNKNOWN_DEPLOYED_ARTIFACT,
        'undescribed function must abort',
      )
    })

    it('aborts when an expected artifact is absent from production', async () => {
      await assertAborts(
        {
          expectations: expectations({
            deployment: {
              ...expectations().deployment,
              functions: { studentPinLoginV2: 'rev-7', missingFn: 'rev-2' },
            },
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
        'absent expected artifact must abort',
      )
    })

    it('aborts on a divergent deployed value', async () => {
      await assertAborts(
        {
          readers: readers({
            readDeploymentInventory: async () => complete({
              rules: { release: 'rules-release-43', checksum: 'a'.repeat(64) },
              functions: { studentPinLoginV2: 'rev-7' },
              hosting: { release: 'hosting-99' },
              indexes: { composite: 'none' },
              gateParameters: { MULTI_TEACHER_V2_ENABLED: 'false' },
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
        'divergent rules release must abort',
      )
    })

    it('aborts on an unexpected gate-parameter value', async () => {
      await assertAborts(
        {
          readers: readers({
            readDeploymentInventory: async () => complete({
              rules: { release: 'rules-release-42', checksum: 'a'.repeat(64) },
              functions: { studentPinLoginV2: 'rev-7' },
              hosting: { release: 'hosting-99' },
              indexes: { composite: 'none' },
              gateParameters: { MULTI_TEACHER_V2_ENABLED: 'true' },
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
        'an already-enabled gate must abort',
      )
    })

    it('aborts when a required surface is missing from the inventory', async () => {
      // The inventory omits gateParameters while expectations still describe it.
      // Surfaces are checked in declared order, so `rules` is compared first and
      // matches; the run then reaches gateParameters and finds it absent. The
      // expectations-mismatch category is correct here: production failed to
      // present a surface the reviewed artifact requires.
      await assertAborts(
        {
          readers: readers({
            readDeploymentInventory: async () => complete({
              rules: { release: 'rules-release-42', checksum: 'a'.repeat(64) },
              functions: { studentPinLoginV2: 'rev-7' },
              hosting: { release: 'hosting-99' },
              indexes: { composite: 'none' },
              // gateParameters omitted entirely
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'a surface absent from the inventory must abort as unavailable',
      )
    })

    it('aborts when the expectations artifact omits a required surface', async () => {
      // The mirror case: production presents the surface but nothing reviewed
      // describes it, so there is no baseline to compare against.
      const withoutGate = expectations()
      delete withoutGate.deployment.gateParameters
      await assertAborts(
        { expectations: withoutGate },
        PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
        'an undescribed surface must abort',
      )
    })

    it('aborts on an unacknowledged active writer', async () => {
      await assertAborts(
        {
          readers: readers({
            readActiveWriters: async () => complete({
              writers: ['legacy-teacher-browser', 'unknown-cron-job'],
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.UNKNOWN_DEPLOYED_ARTIFACT,
        'unknown writer must abort',
      )
    })

    it('aborts when expectations do not enumerate acknowledged writers', async () => {
      const withoutWriters = expectations()
      delete withoutWriters.acknowledgedWriters
      await assertAborts(
        { expectations: withoutWriters },
        PREFLIGHT_ABORT_CATEGORIES.EXPECTATIONS_MISMATCH,
        'missing writer enumeration must abort',
      )
    })
  })

  describe('foundation classification', () => {
    it('accepts an unambiguously absent foundation', async () => {
      const result = await run({
        readers: readers({
          readFoundation: async () => foundationResult({ present: false }),
        }),
      })
      assert.equal(result.outcome, 'succeeded')
    })

    it('aborts on a non-reciprocal or inactive foundation', async () => {
      await assertAborts(
        {
          readers: readers({
            readFoundation: async () => foundationResult({ reciprocal: false }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
        'non-reciprocal link must abort',
      )
      await assertAborts(
        {
          readers: readers({
            readFoundation: async () => foundationResult({ teacherStatus: 'disabled' }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
        'inactive teacher must abort',
      )
    })

    it('aborts on ambiguous foundation presence', async () => {
      for (const present of [undefined, null, 'yes', 1]) {
        await assertAborts(
          {
            readers: readers({
              readFoundation: async () => foundationResult({
                present, sourceEntries: [], roots: { teacherIds: [], classroomIds: [] },
              }),
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
          `present=${String(present)} must abort`,
        )
      }
    })
  })

  describe('destination and scoped-path absence', () => {
    it('aborts on unexpected scoped credentials before bridge rules', async () => {
      await assertAborts(
        {
          readers: readers({
            readDestinationPaths: async () => destinationResult({
              entries: { scopedCredentials: sourceEntries('destCreds', 3) },
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.DESTINATION_DATA_PRESENT,
        'scoped credentials must abort',
      )
    })

    it('accepts destination data only when expectations acknowledge the exact count', async () => {
      const result = await run({
        readers: readers({
          readDestinationPaths: async () => destinationResult({
            entries: { classroomStudents: sourceEntries('destStudents', 3) },
            ids: { destinationStudents: ['1', '2', '3'] },
          }),
        }),
        expectations: expectations({
          acknowledgedDestinationCounts: {
            classroomStudents: 3, scopedCredentials: 0, scopedLogs: 0,
          },
        }),
      })
      assert.equal(result.outcome, 'succeeded')
    })

    it('aborts when an acknowledged count does not match exactly', async () => {
      await assertAborts(
        {
          readers: readers({
            readDestinationPaths: async () => complete({
              counts: { classroomStudents: 4, scopedCredentials: 0, scopedLogs: 0 },
              studentIds: [],
            }),
          }),
          expectations: expectations({
            acknowledgedDestinationCounts: { classroomStudents: 3 },
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.DESTINATION_DATA_PRESENT,
        'count mismatch must abort',
      )
    })

    it('aborts on a malformed destination count', async () => {
      await assertAborts(
        {
          readers: readers({
            readDestinationPaths: async () => complete({
              counts: { scopedCredentials: -1 }, studentIds: [],
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'negative count must abort',
      )
    })
  })

  describe('Auth compatibility', () => {
    it('aborts on a deterministic UID collision', async () => {
      await assertAborts(
        {
          readers: readers({
            readAuthCompatibility: async () => complete({
              uidCollisions: 1, incompatibleUsers: 0, examinedUserCount: 3,
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.AUTH_INCOMPATIBLE,
        'UID collision must abort',
      )
    })

    it('aborts on an incompatible existing Auth user', async () => {
      await assertAborts(
        {
          readers: readers({
            readAuthCompatibility: async () => complete({
              uidCollisions: 0, incompatibleUsers: 2, examinedUserCount: 5,
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.AUTH_INCOMPATIBLE,
        'incompatible user must abort',
      )
    })
  })

  describe('identity, anomalies, and canonical safety', () => {
    it('aborts on non-checksum-safe legacy values', async () => {
      await assertAborts(
        {
          readers: readers({
            readLegacyClassroomAggregate: async () => complete({
              counts: { students: 3 },
              studentIds: ['1'],
              noncanonicalValueCount: 2,
              anomalies: [],
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.NONCANONICAL_VALUE,
        'noncanonical values must abort',
      )
    })

    it('aborts on duplicate credential identities', async () => {
      for (const field of ['duplicateLoginIds', 'duplicateStudentIds']) {
        await assertAborts(
          {
            readers: readers({
              readFlatCredentials: async () => complete({
                count: 3, studentIds: ['1'],
                duplicateLoginIds: 0, duplicateStudentIds: 0,
                noncanonicalLoginIds: 0, anomalies: [],
                [field]: 1,
              }),
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.IDENTITY_COLLISION,
          `${field} must abort`,
        )
      }
    })

    it('aborts on a non-canonical login ID', async () => {
      await assertAborts(
        {
          readers: readers({
            readFlatCredentials: async () => complete({
              count: 3, studentIds: ['1'],
              duplicateLoginIds: 0, duplicateStudentIds: 0,
              noncanonicalLoginIds: 1, anomalies: [],
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
        'noncanonical login ID must abort',
      )
    })

    it('aborts on an anomaly the expectations do not acknowledge', async () => {
      await assertAborts(
        {
          readers: readers({
            readFlatAuthLogs: async () => complete({
              count: 12, studentIds: ['1'],
              anomalies: ['auth-log-missing-classroom-id'],
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.UNREVIEWED_ANOMALY,
        'unacknowledged anomaly must abort',
      )
    })

    it('accepts an anomaly the checksum-bound expectations acknowledge', async () => {
      const result = await run({
        readers: readers({
          readFlatAuthLogs: async () => complete({
            count: 12, studentIds: ['1'],
            anomalies: ['auth-log-missing-classroom-id'],
            sourceEntries: sourceEntries('authLogs', 12),
          }),
        }),
        expectations: expectations({
          acknowledgedAnomalies: ['auth-log-missing-classroom-id'],
        }),
      })
      assert.equal(result.outcome, 'succeeded')
    })
  })

  describe('student-ID watermark', () => {
    it('classifies numeric IDs strictly', () => {
      assert.equal(numericStudentId('7'), 7)
      assert.equal(numericStudentId(7), 7)
      assert.equal(numericStudentId('0'), 0)
      // Normalization hazards are not numbers.
      assert.equal(numericStudentId('007'), null)
      assert.equal(numericStudentId(' 7'), null)
      assert.equal(numericStudentId('7 '), null)
      assert.equal(numericStudentId('7.0'), null)
      assert.equal(numericStudentId('-7'), null)
      assert.equal(numericStudentId('1e3'), null)
      assert.equal(numericStudentId('abc'), null)
      assert.equal(numericStudentId(''), null)
      assert.equal(numericStudentId(null), null)
      assert.equal(numericStudentId(1.5), null)
      assert.equal(numericStudentId(Number.MAX_SAFE_INTEGER + 2), null)
    })

    it('takes the maximum across every source', () => {
      const watermark = deriveStudentIdWatermark({
        roster: ['1', '2'],
        credentials: ['2', '9'],
        transactions: ['1'],
        loginHistory: [],
        authLogs: ['4'],
        destinationStudents: [],
      })
      assert.equal(watermark.observedMaximum, 9)
      assert.equal(watermark.nextStudentNumber, 10)
      // Distinct NUMERIC identities across all sources: 1, 2, 9, 4. The repeated
      // '1' and '2' are the same student appearing in several sources.
      assert.equal(watermark.distinctCount, 4)
    })

    it('starts at 1 for a classroom with no history', () => {
      const watermark = deriveStudentIdWatermark({ roster: [] })
      assert.equal(watermark.observedMaximum, null)
      assert.equal(watermark.nextStudentNumber, 1)
    })

    it('normalizes numeric/string equivalents of one student across sources', () => {
      // The brief's own expected shape: the legacy roster stores `id: 7` while a
      // credential stores `studentId: "7"` and a transaction cites 7. That is ONE
      // student referenced three ways, and Section 5 requires it be normalized.
      //
      // An earlier version pooled all sources and compared `typeof:String(raw)`,
      // so this exact shape aborted as a collision — the emulator suite only
      // passed because its readers pre-stringified every ID, hiding the behavior.
      const watermark = deriveStudentIdWatermark({
        roster: [7],
        credentials: ['7'],
        transactions: [7],
        loginHistory: ['7'],
        authLogs: [7],
        destinationStudents: [],
      })
      assert.equal(watermark.observedMaximum, 7)
      assert.equal(watermark.nextStudentNumber, 8)
      assert.equal(watermark.distinctCount, 1, 'one student, not five')
    })

    it('aborts when two distinct records in one identity set share a normalized ID', () => {
      // Within an identity set, one entry is one student record. Two roster
      // students normalizing to 7 are two students claiming one identity, whatever
      // their spelling.
      for (const roster of [[7, '7'], ['7', 7], [7, 7], ['7', '7']]) {
        assert.throws(
          () => deriveStudentIdWatermark({ roster }),
          error => {
            assert.equal(
              error.category,
              PREFLIGHT_ABORT_CATEGORIES.IDENTITY_COLLISION,
            )
            assert.match(error.message, /identity set/)
            return true
          },
          `roster ${JSON.stringify(roster)} holds two records for one identity`,
        )
      }

      // Credentials and destination students are identity sets too.
      for (const source of ['credentials', 'destinationStudents']) {
        assert.throws(
          () => deriveStudentIdWatermark({ [source]: [4, '4'] }),
          error => error.category === PREFLIGHT_ABORT_CATEGORIES.IDENTITY_COLLISION,
          `${source} is an identity set`,
        )
      }

      // Reference sources are NOT identity sets: a student is cited repeatedly by
      // design, so a repeat there must not block.
      for (const source of ['transactions', 'loginHistory', 'authLogs']) {
        const watermark = deriveStudentIdWatermark({ [source]: [4, '4', 4] })
        assert.equal(watermark.observedMaximum, 4, `${source} may repeat a citation`)
      }
    })

    it('aborts on a malformed historical ID', async () => {
      assert.throws(
        () => deriveStudentIdWatermark({ roster: ['abc'] }),
        error => error.category === PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
      )
      await assertAborts(
        {
          readers: readers({
            readLegacyClassroomAggregate: async () => complete({
              counts: { students: 1 },
              studentIds: ['007'],
              noncanonicalValueCount: 0,
              anomalies: [],
              present: true,
              sourceEntries: sourceEntries('legacy', 1),
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
        'a padded historical ID must abort the run',
      )
    })

    it('aborts when a watermark source is not an array', () => {
      assert.throws(
        () => deriveStudentIdWatermark({ roster: 'nope' }),
        error => error.category === PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
      )
    })
  })

  describe('no remote mutation is reachable', () => {
    it('invokes only the declared read functions', async () => {
      const invoked = []
      const spied = Object.fromEntries(
        Object.entries(readers()).map(([name, fn]) => [
          name,
          async (...args) => { invoked.push(name); return fn(...args) },
        ]),
      )
      await run({ readers: spied })

      // Every invoked name must begin with `read`.
      for (const name of invoked) {
        assert.match(name, /^read/, `${name} is not a read operation`)
      }
      assert.equal(new Set(invoked).size, invoked.length, 'no reader ran twice')
    })

    it('never touches a mutating Firestore or Auth surface', async () => {
      // A reader set that also exposes mutating methods; any call to one fails.
      const forbidden = [
        'set', 'update', 'delete', 'create', 'add', 'commit',
        'batch', 'runTransaction', 'bulkWriter', 'writeBatch',
        'setCustomUserClaims', 'createUser', 'updateUser', 'deleteUser',
        'deploy', 'patch', 'setParameter',
      ]
      const trap = {}
      for (const name of forbidden) {
        trap[name] = () => {
          throw new Error(`forbidden mutating call: ${name}`)
        }
      }

      const result = await run({ readers: { ...readers(), ...trap } })
      assert.equal(result.outcome, 'succeeded')
    })

    it('passes no writable handle to any reader', async () => {
      const seenArguments = []
      const spied = Object.fromEntries(
        Object.entries(readers()).map(([name, fn]) => [
          name,
          async (...args) => { seenArguments.push(args); return fn(...args) },
        ]),
      )
      await run({ readers: spied })
      // Readers receive only plain, inert data — never a Firestore/Auth handle,
      // client, transaction, batch, or writer. The destination reader legitimately
      // takes the canonical login code so it can inspect the exact index document;
      // that is a string, not a capability.
      for (const args of seenArguments) {
        for (const arg of args) {
          assert.ok(
            arg === undefined || (
              arg !== null && typeof arg === 'object' &&
              Object.getPrototypeOf(arg) === Object.prototype
            ),
            'a reader argument must be a plain options object, never a handle',
          )
          for (const value of Object.values(arg ?? {})) {
            assert.equal(
              typeof value === 'function' ? 'function' : 'inert',
              'inert',
              'no reader argument may carry a callable capability',
            )
          }
        }
      }
    })
  })

  describe('manifest persistence discipline', () => {
    it('persists exactly once on success', async () => {
      let calls = 0
      await run({
        persistManifest: async (manifest) => {
          calls += 1
          assert.equal(manifest.outcome, 'succeeded')
          return echo(manifest)
        },
      })
      assert.equal(calls, 1)
    })

    it('never persists a manifest for a failed preflight', async () => {
      let calls = 0
      const persistManifest = async () => { calls += 1; return {} }

      const failures = [
        { credentialSha256: 'f'.repeat(64) },
        { authorization: authorization({ projectId: 'demo-x' }) },
        { nowMillis: Date.parse('2027-01-01T00:00:00.000Z') },
        {
          readers: readers({
            readAuthCompatibility: async () => complete({
              uidCollisions: 1, incompatibleUsers: 0, examinedUserCount: 1,
            }),
          }),
        },
        {
          readers: readers({
            readFoundation: async () => complete({
              present: true, reciprocal: false, teacherStatus: 'active',
              anomalies: [],
            }),
          }),
        },
        { readers: readers({ readFlatCredentials: async () => ({ complete: false }) }) },
        { environment: { GCLOUD_PROJECT: 'morgan-bank-staging' } },
      ]

      for (const override of failures) {
        await assert.rejects(() => run({ ...override, persistManifest }))
      }
      assert.equal(calls, 0, 'a failed preflight must never write a manifest')
    })

    it('refuses to succeed without a persister', async () => {
      // The Commit 3 contract is that a SUCCESSFUL preflight produces a retained
      // record. An earlier version of this test asserted the opposite — success
      // with `persisted: null` — which would let a later writer believe a
      // preflight occurred that left no verifiable evidence.
      for (const persistManifest of [undefined, null, {}, 'persist']) {
        await assertAborts(
          { persistManifest },
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `persister ${String(persistManifest)} must not be accepted`,
        )
      }
    })

    it('aborts when the persister reports a different record than was built', async () => {
      // The retained record and the reported one must be the same document.
      await assertAborts(
        {
          persistManifest: async manifest => ({
            preflightManifestId: 'f'.repeat(64),
            preflightChecksum: manifest.preflightChecksum,
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'a mismatched manifest ID must abort',
      )
      await assertAborts(
        {
          persistManifest: async manifest => ({
            preflightManifestId: manifest.preflightManifestId,
            preflightChecksum: 'f'.repeat(64),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'a mismatched preflight checksum must abort',
      )
      for (const reported of [undefined, null, 'ok', []]) {
        await assertAborts(
          { persistManifest: async () => reported },
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `persister report ${String(reported)} must abort`,
        )
      }
    })

    it('returns the retained record on success', async () => {
      const result = await run()
      assert.equal(result.persisted.preflightManifestId, result.preflightManifestId)
      assert.equal(result.persisted.preflightChecksum, result.preflightChecksum)
    })
  })

  describe('per-document source hashing', () => {
    /**
     * A count-only domain cannot detect a changed balance, transaction body, PIN
     * hash, or update time while counts stay constant — which would let a later
     * writer operate on state that never passed preflight. These tests are the
     * teeth on that requirement.
     */
    async function captureDomains(overrides = {}) {
      let captured
      await run({
        persistManifest: async (manifest) => { captured = manifest; return echo(manifest) },
        ...overrides,
      })
      return captured
    }

    it('changes the domain checksum when a document body changes but counts do not', async () => {
      const baseline = await captureDomains()
      const changed = await captureDomains({
        readers: readers({
          readFlatCredentials: async () => complete({
            count: 3,
            studentIds: ['1', '2', '3'],
            duplicateLoginIds: 0,
            duplicateStudentIds: 0,
            noncanonicalLoginIds: 0,
            anomalies: [],
            // Same count, same paths, same update times — one body differs.
            sourceEntries: sourceEntries('credentials', 3, [
              undefined,
              { documentHash: 'a'.repeat(64) },
            ]),
          }),
        }),
      })

      assert.notEqual(
        baseline.domainChecksums.legacySourceState,
        changed.domainChecksums.legacySourceState,
        'a changed document body must change the domain checksum',
      )
      assert.notEqual(baseline.preflightManifestId, changed.preflightManifestId)
    })

    it('changes the domain checksum when only an update time changes', async () => {
      const baseline = await captureDomains()
      const changed = await captureDomains({
        readers: readers({
          readFlatCredentials: async () => complete({
            count: 3,
            studentIds: ['1', '2', '3'],
            duplicateLoginIds: 0,
            duplicateStudentIds: 0,
            noncanonicalLoginIds: 0,
            anomalies: [],
            // A NANOSECOND-only change, within the same millisecond. An ISO
            // millisecond representation would have discarded this entirely, so
            // two writes inside one millisecond restoring the same body would
            // have produced identical evidence.
            sourceEntries: sourceEntries('credentials', 3, [
              { updateTime: { seconds: 1_785_000_000, nanoseconds: 123_456_790 } },
            ]),
          }),
        }),
      })
      assert.notEqual(
        baseline.domainChecksums.legacySourceState,
        changed.domainChecksums.legacySourceState,
        'a same-shape rewrite must still be detected',
      )
    })

    it('is independent of reader iteration order', async () => {
      const forward = sourceEntries('credentials', 3)
      const baseline = await captureDomains()
      const reversed = await captureDomains({
        readers: readers({
          readFlatCredentials: async () => complete({
            count: 3,
            studentIds: ['1', '2', '3'],
            duplicateLoginIds: 0,
            duplicateStudentIds: 0,
            noncanonicalLoginIds: 0,
            anomalies: [],
            sourceEntries: [...forward].reverse(),
          }),
        }),
      })
      assert.equal(
        baseline.domainChecksums.legacySourceState,
        reversed.domainChecksums.legacySourceState,
        'the same documents in a different order must hash identically',
      )
    })

    it('retains no raw path, and no entry field beyond the hashed schema', async () => {
      const captured = await captureDomains()
      const serialized = JSON.stringify(captured)

      // A raw path like classrooms/x/studentCredentials/ada.smith embeds student
      // identity; only its hash may be retained.
      assert.ok(!serialized.includes('studentCredentials/'), 'no raw path may appear')
      assert.ok(!/"path"\s*:/.test(serialized), 'no raw path field may appear')

      const summary = captured.domainChecksums.legacySourceState
      assert.match(summary, /^[0-9a-f]{64}$/)
    })

    it('records document counts alongside the digests for audit visibility', async () => {
      const captured = await captureDomains()
      assert.equal(typeof captured.observations.counts.flatCredentials, 'number')
    })

    it('rejects a source entry that is malformed or carries extra fields', async () => {
      const cases = [
        ['not an array', 'nope'],
        ['a missing array', undefined],
        ['a non-object entry', ['x']],
        ['a bad pathHash', [{ pathHash: 'short', updateTime: '2026-07-26T12:00:00.000Z', documentHash: 'a'.repeat(64) }]],
        ['a bad documentHash', [{ pathHash: 'a'.repeat(64), updateTime: '2026-07-26T12:00:00.000Z', documentHash: 'NOTHEX' }]],
        ['a non-canonical updateTime', [{ pathHash: 'a'.repeat(64), updateTime: '2026-07-26 12:00:00', documentHash: 'b'.repeat(64) }]],
        ['a missing updateTime', [{ pathHash: 'a'.repeat(64), documentHash: 'b'.repeat(64) }]],
        // The route by which raw material would reach the manifest.
        ['an extra field', [{ pathHash: 'a'.repeat(64), updateTime: '2026-07-26T12:00:00.000Z', documentHash: 'b'.repeat(64), path: 'classrooms/x/studentCredentials/ada' }]],
        ['a duplicate path', [
          { pathHash: 'a'.repeat(64), updateTime: '2026-07-26T12:00:00.000Z', documentHash: 'b'.repeat(64) },
          { pathHash: 'a'.repeat(64), updateTime: '2026-07-26T12:00:00.000Z', documentHash: 'c'.repeat(64) },
        ]],
      ]

      for (const [label, entries] of cases) {
        await assertAborts(
          {
            readers: readers({
              readFoundation: async () => complete({
                present: false, anomalies: [], sourceEntries: entries,
              }),
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `${label} must abort`,
        )
      }
    })

    it('aborts when a declared count disagrees with the hashed evidence', async () => {
      // A count reported independently of the documents actually hashed would let
      // the manifest's counts and digests describe different sets of documents.
      await assertAborts(
        {
          readers: readers({
            readFlatCredentials: async () => complete({
              count: 99,
              studentIds: ['1', '2', '3'],
              duplicateLoginIds: 0,
              duplicateStudentIds: 0,
              noncanonicalLoginIds: 0,
              anomalies: [],
              sourceEntries: sourceEntries('credentials', 3),
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'an unsubstantiated count must abort',
      )
      await assertAborts(
        {
          readers: readers({
            readFlatAuthLogs: async () => complete({
              count: 12,
              studentIds: ['1'],
              anomalies: [],
              sourceEntries: sourceEntries('authLogs', 11),
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'an auth-log count mismatch must abort',
      )
    })

    it('evidences destination absence rather than asserting a bare zero', async () => {
      const captured = await captureDomains()
      assert.match(captured.domainChecksums.destinationAbsence, /^[0-9a-f]{64}$/)
      // A destination reader that reported zero counts but refused to say what it
      // examined is not evidence of absence.
      await assertAborts(
        {
          readers: readers({
            readDestinationPaths: async () => complete({
              counts: { scopedCredentials: 0, scopedLogs: 0, classroomStudents: 0 },
              studentIds: [],
            }),
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'destination absence without evidence must abort',
      )
    })
  })

  describe('evidence cardinality is bound for every surface', () => {
    /**
     * An earlier version bound only flatCredentials and flatAuthLogs, so a reader
     * could report ten examined Auth users while supplying nine hashes and the
     * manifest would retain evidence that never covered the omitted state.
     */
    it('binds every declared count to its evidence, not just the flat collections', async () => {
      const cases = [
        ['authUsers', {
          readAuthCompatibility: async () => complete({
            uidCollisions: 0, incompatibleUsers: 0,
            examinedUserCount: 10,
            sourceEntries: sourceEntries('authUsers', 9),
          }),
        }],
        ['legacyClassroom', {
          readLegacyClassroomAggregate: async () => complete({
            counts: { students: 3, transactions: 10, loginHistory: 5 },
            studentIds: ['1'], transactionStudentIds: [], loginHistoryStudentIds: [],
            noncanonicalValueCount: 0, anomalies: [],
            // Claims the aggregate exists but supplies no document evidence.
            present: true, sourceEntries: [],
          }),
        }],
        ['foundationPresent', {
          readFoundation: async () => complete({
            present: true, reciprocal: true, teacherStatus: 'active',
            classroomId: 'abc123', anomalies: [],
            // Present means teacher + reciprocal classroom: two documents.
            sourceEntries: sourceEntries('foundation', 1),
          }),
        }],
        ['foundationAbsent', {
          readFoundation: async () => complete({
            present: false, anomalies: [],
            // Absent must mean nothing was hashed.
            sourceEntries: sourceEntries('foundation', 1),
          }),
        }],
      ]

      for (const [label, override] of cases) {
        await assertAborts(
          { readers: readers(override) },
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `${label} must bind its declared count to its evidence`,
        )
      }
    })

    it('requires an explicit boolean presence rather than treating absent as proven', async () => {
      for (const present of [undefined, null, 'yes', 0]) {
        await assertAborts(
          {
            readers: readers({
              readLegacyClassroomAggregate: async () => complete({
                counts: { students: 3 }, studentIds: ['1'],
                transactionStudentIds: [], loginHistoryStudentIds: [],
                noncanonicalValueCount: 0, anomalies: [],
                present,
                sourceEntries: sourceEntries('legacy', 1),
              }),
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `present=${String(present)} must not be read as a determination`,
        )
      }
    })

    it('binds destination surfaces individually, not as one pooled total', async () => {
      // The counts SUM correctly (2 total) but are individually wrong: two scoped
      // logs were found and reported as classroomStudents. A pooled total check
      // would accept this, so only per-surface binding catches it.
      //
      // The all-zero-vs-nonzero case would pass under pooling too, which is why
      // this fixture is deliberately sum-preserving.
      await assertAborts(
        {
          readers: readers({
            readDestinationPaths: async () => complete({
              counts: { scopedCredentials: 0, scopedLogs: 0, classroomStudents: 2 },
              studentIds: [],
              sourceEntriesBySurface: {
                scopedCredentials: [],
                scopedLogs: sourceEntries('scopedLogs', 2),
                classroomStudents: [],
              },
            }),
            // classroomStudents: 2 would otherwise abort as destination data
            // present, masking the binding failure this test is about.
          }),
          expectations: expectations({
            acknowledgedDestinationCounts: {
              scopedCredentials: 0, scopedLogs: 0, classroomStudents: 2,
            },
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
        'a per-surface count must match that surface\'s own evidence',
      )
    })

    it('requires every scoped surface to be enumerated', async () => {
      const cases = [
        ['missing scopedLogs entirely', {
          scopedCredentials: [], classroomStudents: [],
        }],
        ['missing classroomStudents', {
          scopedCredentials: [], scopedLogs: [],
        }],
        ['an unrecognized surface', {
          scopedCredentials: [], scopedLogs: [], classroomStudents: [],
          somethingElse: [],
        }],
      ]
      for (const [label, sourceEntriesBySurface] of cases) {
        await assertAborts(
          {
            readers: readers({
              readDestinationPaths: async () => complete({
                counts: { scopedCredentials: 0, scopedLogs: 0, classroomStudents: 0 },
                studentIds: [],
                sourceEntriesBySurface,
              }),
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `${label} must abort`,
        )
      }
    })

    it('requires a count for exactly the contract surfaces', async () => {
      for (const counts of [
        { scopedCredentials: 0, scopedLogs: 0 },
        { scopedCredentials: 0, scopedLogs: 0, classroomStudents: 0, extra: 0 },
        'none',
      ]) {
        await assertAborts(
          {
            readers: readers({
              readDestinationPaths: async () => complete({
                counts,
                studentIds: [],
                sourceEntriesBySurface: {
                  scopedCredentials: [], scopedLogs: [], classroomStudents: [],
                },
              }),
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `counts ${JSON.stringify(counts)} must abort`,
        )
      }
    })

    it('gives each destination surface its own retained digest', async () => {
      let captured
      await run({
        persistManifest: async (manifest) => { captured = manifest; return echo(manifest) },
      })
      assert.match(captured.domainChecksums.destinationAbsence, /^[0-9a-f]{64}$/)
    })
  })

  describe('complete destination surface coverage', () => {
    it('declares every scoped subcollection Phase 2A can write', () => {
      // Sourced from Phase 2A's own destination model. Naming only students,
      // credentials and logs left a pre-existing transaction or login-history
      // document invisible while preflight reported absence.
      // `loginCodeIndex` is the root code-reservation collection. It is a
      // separately bound surface so a pre-existing reservation cannot hide behind
      // another surface's zero.
      assert.deepEqual([...DESTINATION_SURFACES].sort(), [
        'classroomLoginHistory',
        'classroomStudents',
        'classroomTransactions',
        'loginCodeIndex',
        'scopedCredentials',
        'scopedLogs',
      ])
      assert.deepEqual(
        Object.keys(CLASSROOM_SUBCOLLECTION_SURFACES).sort(),
        ['loginHistory', 'studentCredentials', 'students', 'transactions'],
      )
    })

    it('aborts on a destination transaction or login-history record', async () => {
      for (const surface of ['classroomTransactions', 'classroomLoginHistory']) {
        await assertAborts(
          {
            readers: readers({
              readDestinationPaths: async () => destinationResult({
                entries: { [surface]: sourceEntries(surface, 1) },
              }),
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.DESTINATION_DATA_PRESENT,
          `a pre-existing ${surface} document must abort`,
        )
      }
    })

    it('requires an evidence set and a count for every new surface', async () => {
      for (const omitted of DESTINATION_SURFACES) {
        const entries = Object.fromEntries(
          DESTINATION_SURFACES.filter(s => s !== omitted).map(s => [s, []]),
        )
        await assertAborts(
          {
            readers: readers({
              readDestinationPaths: async () => complete({
                counts: Object.fromEntries(
                  DESTINATION_SURFACES.map(s => [s, 0]),
                ),
                sourceEntriesBySurface: entries,
                studentIdsBySurface: {
                  destinationStudents: [], destinationCredentials: [],
                  destinationTransactions: [], destinationLoginHistory: [],
                  destinationAuthLogs: [],
                },
              }),
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `omitting ${omitted} evidence must abort`,
        )
      }
    })
  })

  describe('acknowledged destination records still feed the watermark', () => {
    /**
     * "It normally aborts on nonzero destination counts" is not sufficient: a count
     * can be explicitly acknowledged, and an acknowledged record still carries a
     * historical identity a later allocator must start above.
     */
    async function acknowledgedRun({ surface, idSet, ids, entryCount }) {
      return run({
        readers: readers({
          readDestinationPaths: async () => destinationResult({
            entries: { [surface]: sourceEntries(surface, entryCount) },
            ids: { [idSet]: ids },
          }),
        }),
        expectations: expectations({
          acknowledgedDestinationCounts: { [surface]: entryCount },
        }),
      })
    }

    it('raises the watermark from an acknowledged scoped credential', async () => {
      // Baseline watermark from the legacy fixture is 3. An acknowledged scoped
      // credential for student 900 must move it to 901 — dropping these sets is
      // exactly how an acknowledged record would leave the watermark at 4.
      const result = await acknowledgedRun({
        surface: 'scopedCredentials',
        idSet: 'destinationCredentials',
        ids: [900],
        entryCount: 1,
      })
      assert.equal(result.outcome, 'succeeded')
      assert.equal(result.watermark.observedMaximum, 900)
      assert.equal(result.watermark.nextStudentNumber, 901)
    })

    it('raises the watermark from acknowledged destination students, transactions, history and logs', async () => {
      const cases = [
        ['classroomStudents', 'destinationStudents', 500],
        ['classroomTransactions', 'destinationTransactions', 600],
        ['classroomLoginHistory', 'destinationLoginHistory', 700],
        ['scopedLogs', 'destinationAuthLogs', 800],
      ]
      for (const [surface, idSet, id] of cases) {
        const result = await acknowledgedRun({
          surface, idSet, ids: [id], entryCount: 1,
        })
        assert.equal(
          result.watermark.nextStudentNumber,
          id + 1,
          `${idSet} must contribute its historical ID`,
        )
      }
    })

    it('preserves raw ID types from every destination set', async () => {
      // A string reference and a numeric reference to one student normalize.
      const result = await acknowledgedRun({
        surface: 'classroomTransactions',
        idSet: 'destinationTransactions',
        ids: ['42', 42, '42'],
        entryCount: 3,
      })
      assert.equal(result.watermark.observedMaximum, 42)
    })

    it('refuses an acknowledged student or credential with no identity', async () => {
      for (const [surface, idSet] of [
        ['classroomStudents', 'destinationStudents'],
        ['scopedCredentials', 'destinationCredentials'],
      ]) {
        await assertAborts(
          {
            readers: readers({
              readDestinationPaths: async () => destinationResult({
                entries: { [surface]: sourceEntries(surface, 1) },
              }),
            }),
            expectations: expectations({
              acknowledgedDestinationCounts: { [surface]: 1 },
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
          `${idSet} must classify one identity for every evidenced document`,
        )
      }
    })

    it('refuses an identity inconsistent with its document path', async () => {
      await assertAborts(
        {
          readers: readers({
            readDestinationPaths: async () => destinationResult({
              entries: { classroomStudents: sourceEntries('students', 1) },
              ids: { destinationStudents: [8] },
              coverage: {
                destinationStudents: {
                  referencedCount: 1, unassignedCount: 0, inconsistentCount: 1,
                },
              },
            }),
          }),
          expectations: expectations({
            acknowledgedDestinationCounts: { classroomStudents: 1 },
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
        'a body/path identity mismatch must block',
      )
    })

    it('accepts an explicitly classified unassigned reference', async () => {
      const result = await acknowledgedRun({
        surface: 'classroomTransactions',
        idSet: 'destinationTransactions',
        ids: [],
        entryCount: 1,
      })
      assert.equal(result.outcome, 'succeeded')
      assert.equal(result.watermark.observedMaximum, 3)
    })

    it('rejects malformed non-null references and incomplete coverage', async () => {
      await assert.rejects(
        () => acknowledgedRun({
          surface: 'classroomTransactions',
          idSet: 'destinationTransactions',
          ids: [{ malformed: true }],
          entryCount: 1,
        }),
        error => error.category === PREFLIGHT_ABORT_CATEGORIES.MALFORMED_ID,
      )

      await assertAborts(
        {
          readers: readers({
            readDestinationPaths: async () => destinationResult({
              entries: { classroomTransactions: sourceEntries('transactions', 1) },
              coverage: {
                destinationTransactions: {
                  referencedCount: 0, unassignedCount: 0, inconsistentCount: 0,
                },
              },
            }),
          }),
          expectations: expectations({
            acknowledgedDestinationCounts: { classroomTransactions: 1 },
          }),
        },
        PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
        'every evidenced reference document must be classified',
      )
    })

    it('treats destination students and credentials as identity sets', async () => {
      for (const [surface, idSet] of [
        ['classroomStudents', 'destinationStudents'],
        ['scopedCredentials', 'destinationCredentials'],
      ]) {
        await assert.rejects(
          () => acknowledgedRun({ surface, idSet, ids: [8, '8'], entryCount: 2 }),
          error => {
            assert.equal(error.category, PREFLIGHT_ABORT_CATEGORIES.IDENTITY_COLLISION)
            assert.match(error.message, /identity set/)
            return true
          },
          `${idSet} is an identity set`,
        )
      }
    })

    it('requires every destination ID set to be stated', async () => {
      for (const omitted of [
        'destinationStudents', 'destinationCredentials',
        'destinationTransactions', 'destinationLoginHistory',
        'destinationAuthLogs',
      ]) {
        const ids = {
          destinationStudents: [], destinationCredentials: [],
          destinationTransactions: [], destinationLoginHistory: [],
          destinationAuthLogs: [],
        }
        delete ids[omitted]
        await assertAborts(
          {
            readers: readers({
              readDestinationPaths: async () => complete({
                counts: Object.fromEntries(DESTINATION_SURFACES.map(s => [s, 0])),
                sourceEntriesBySurface: Object.fromEntries(
                  DESTINATION_SURFACES.map(s => [s, []]),
                ),
                studentIdsBySurface: ids,
                // Stated so the omitted ID set is what this case actually
                // exercises, rather than the code classification firing first.
                selectedCodePresent: false,
              }),
            }),
          },
          PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED,
          `omitting ${omitted} must abort rather than default to empty`,
        )
      }
    })

    it('refuses an unclassified watermark source', () => {
      assert.throws(
        () => deriveStudentIdWatermark({ someNewSource: [1] }),
        error => {
          assert.equal(error.category, PREFLIGHT_ABORT_CATEGORIES.WATERMARK_UNRESOLVED)
          assert.match(error.message, /not classified/)
          return true
        },
        'an unclassified source must not silently skip collision detection',
      )
    })
  })

  describe('foundation root enumeration', () => {
    it('aborts on an unrelated teacher or an extra classroom root', async () => {
      const cases = [
        ['a second teacher', {
          roots: { teacherIds: [TEACHER_UID, 'other-teacher'], classroomIds: ['abc123'] },
        }],
        ['an extra classroom root', {
          roots: { teacherIds: [TEACHER_UID], classroomIds: ['abc123', 'extra'] },
        }],
        ['a teacher root while the foundation is absent', {
          present: false, sourceEntries: [],
          roots: { teacherIds: ['someone-else'], classroomIds: [] },
        }],
        ['a classroom root while the foundation is absent', {
          present: false, sourceEntries: [],
          roots: { teacherIds: [], classroomIds: ['stray-classroom'] },
        }],
        ['a different teacher than the invocation names', {
          roots: { teacherIds: ['someone-else'], classroomIds: ['abc123'] },
        }],
        ['a different classroom than the foundation names', {
          roots: { teacherIds: [TEACHER_UID], classroomIds: ['different'] },
        }],
      ]
      for (const [label, override] of cases) {
        await assertAborts(
          { readers: readers({ readFoundation: async () => foundationResult(override) }) },
          PREFLIGHT_ABORT_CATEGORIES.FOUNDATION_PARTIAL,
          `${label} must abort`,
        )
      }
    })

    it('requires enumerated root lists rather than trusting the named pair', async () => {
      for (const roots of [
        undefined, null, 'none', {},
        { teacherIds: [TEACHER_UID] },
        { classroomIds: ['abc123'] },
        { teacherIds: [TEACHER_UID], classroomIds: ['abc123'], extra: [] },
        { teacherIds: [TEACHER_UID, TEACHER_UID], classroomIds: ['abc123'] },
        { teacherIds: [7], classroomIds: ['abc123'] },
      ]) {
        await assertAborts(
          { readers: readers({ readFoundation: async () => foundationResult({ roots }) }) },
          PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `roots ${JSON.stringify(roots)} must abort`,
        )
      }
    })

    it('retains the enumerated root counts in the manifest', async () => {
      let captured
      await run({
        persistManifest: async (manifest) => { captured = manifest; return echo(manifest) },
      })
      assert.match(captured.domainChecksums.foundationState, /^[0-9a-f]{64}$/)

      // A different root population must change the domain, so the counts are
      // genuinely attested rather than merely computed and discarded.
      let other
      await run({
        readers: readers({
          readFoundation: async () => foundationResult({ present: false }),
        }),
        persistManifest: async (manifest) => { other = manifest; return echo(manifest) },
      })
      assert.notEqual(
        captured.domainChecksums.foundationState,
        other.domainChecksums.foundationState,
      )
    })
  })

  describe('exact Firestore update-time precision', () => {
    async function withUpdateTime(updateTime) {
      return run({
        readers: readers({
          readFlatCredentials: async () => complete({
            count: 1, studentIds: ['1'],
            duplicateLoginIds: 0, duplicateStudentIds: 0, noncanonicalLoginIds: 0,
            anomalies: [],
            sourceEntries: [{
              pathHash: 'a'.repeat(64),
              updateTime,
              documentHash: 'b'.repeat(64),
            }],
          }),
        }),
      })
    }

    it('rejects an ISO millisecond string, which would discard nanoseconds', async () => {
      await assert.rejects(
        () => withUpdateTime('2026-07-26T12:00:00.000Z'),
        error => {
          assert.equal(error.category, PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE)
          assert.match(error.message, /exact \{seconds, nanoseconds\}/)
          return true
        },
      )
    })

    it('rejects malformed or out-of-range components', async () => {
      for (const updateTime of [
        { seconds: 1, nanoseconds: 1_000_000_000 },
        { seconds: 1, nanoseconds: -1 },
        { seconds: -1, nanoseconds: 0 },
        { seconds: 1.5, nanoseconds: 0 },
        { seconds: 1 },
        { nanoseconds: 0 },
        { seconds: 1, nanoseconds: 0, extra: true },
        { seconds: '1', nanoseconds: 0 },
        null,
      ]) {
        await assert.rejects(
          () => withUpdateTime(updateTime),
          error => error.category === PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
          `updateTime ${JSON.stringify(updateTime)} must be refused`,
        )
      }
    })

    it('distinguishes two writes inside the same millisecond', async () => {
      const first = await withUpdateTime({ seconds: 1_785_000_000, nanoseconds: 1_000_000 })
      const second = await withUpdateTime({ seconds: 1_785_000_000, nanoseconds: 1_000_001 })
      assert.notEqual(
        first.domainChecksums.legacySourceState,
        second.domainChecksums.legacySourceState,
        'a one-nanosecond difference must change the digest',
      )
    })
  })

  describe('raw authorization-artifact binding', () => {
    it('binds the digest of the authorization file bytes, not a field subset', async () => {
      let captured
      await run({
        persistManifest: async (manifest) => { captured = manifest; return echo(manifest) },
      })

      // The domain must be exactly the pre-parse digest the entrypoint computed —
      // the artifact's raw bytes, carried through untouched.
      assert.equal(
        captured.domainChecksums.authorizationArtifact,
        hashDomain({ sha256: AUTHORIZATION_SHA }),
      )
    })

    it('changes the domain when a field the preflight never interprets changes', async () => {
      // A reconstruction from selected fields left projectId, teacherUid,
      // credentialProvenance, notBefore and notAfter out of the checksum, so
      // altering provenance or expiry changed nothing. Two different artifact
      // bytes must produce two different domains.
      let first
      await run({
        persistManifest: async (manifest) => { first = manifest; return echo(manifest) },
      })
      let second
      await run({
        authorizationSha256: 'b'.repeat(64),
        persistManifest: async (manifest) => { second = manifest; return echo(manifest) },
      })
      assert.notEqual(
        first.domainChecksums.authorizationArtifact,
        second.domainChecksums.authorizationArtifact,
      )
      assert.notEqual(first.preflightManifestId, second.preflightManifestId)
    })

    it('requires the raw digest and rejects a non-digest', async () => {
      for (const authorizationSha256 of [
        undefined, null, '', 'short', 'A'.repeat(64), 'g'.repeat(64), 42,
      ]) {
        await assertAborts(
          { authorizationSha256 },
          PREFLIGHT_ABORT_CATEGORIES.MALFORMED_AUTHORIZATION,
          `digest ${String(authorizationSha256)} must be refused`,
        )
      }
    })
  })

  describe('manifest content safety', () => {
    it('records only counts, classifications, and hashes', async () => {
      let captured
      await run({
        persistManifest: async (manifest) => { captured = manifest; return echo(manifest) },
      })

      const serialized = JSON.stringify(captured)
      // No raw identifiers or secret-shaped material may appear.
      assert.ok(!serialized.includes('private'))
      assert.ok(!/-----BEGIN/.test(serialized))
      assert.ok(!serialized.includes('@'), 'no email may appear')

      // The observations carry aggregates, not records.
      assert.equal(typeof captured.observations.counts.flatCredentials, 'number')
      assert.equal(captured.observations.foundationPresent, true)
    })

    it('binds the expectations checksum into its own domain', async () => {
      let captured
      await run({
        persistManifest: async (manifest) => { captured = manifest; return echo(manifest) },
      })
      const other = await run({ expectationsSha256: EXPECTATIONS_SHA })
      assert.match(captured.domainChecksums.expectationsArtifact, /^[0-9a-f]{64}$/)
      assert.equal(other.outcome, 'succeeded')
    })
  })

  describe('bounded production readers', () => {
    const credential = Object.freeze({
      getAccessToken: async () => ({ access_token: 'unit-test-token' }),
    })

    function jsonResponse(payload, overrides = {}) {
      return {
        status: 200,
        redirected: false,
        json: async () => payload,
        ...overrides,
      }
    }

    const EVENT_FILTERS = Object.freeze([
      Object.freeze({ attribute: 'database', value: '(default)' }),
      Object.freeze({ attribute: 'document', value: 'morganBank/{documentId}' }),
      Object.freeze({ attribute: 'namespace', value: 'morgan-bank' }),
    ])

    function triggerFunctionResource(overrides = {}) {
      return {
        name: 'projects/morgan-bank/locations/us-central1/functions/trigger',
        state: 'ACTIVE',
        updateTime: '2026-07-26T18:00:00.000Z',
        buildConfig: { runtime: 'nodejs20', entryPoint: 'trigger' },
        serviceConfig: {
          revision: 'trigger-00001',
          environmentVariables: {
            MULTI_TEACHER_V2_ENABLED: 'false',
            MULTI_TEACHER_V2_RELEASE_ID: 'phase3-release-1',
          },
        },
        eventTrigger: {
          eventType: 'google.cloud.firestore.document.v1.written',
          eventFilters: EVENT_FILTERS,
        },
        stateMessages: [
          { severity: 'INFO', type: 'First', message: 'first' },
          { severity: 'WARNING', type: 'Second', message: 'second' },
        ],
        ...overrides,
      }
    }

    async function readFunctionRevision(functionResource) {
      const readers = createProductionControlPlaneReaders({
        projectId: 'morgan-bank',
        credential,
        fetchImpl: async url => {
          const pathname = new globalThis.URL(url).pathname
          if (pathname.endsWith('/releases/cloud.firestore')) {
            return jsonResponse({
              name: 'projects/morgan-bank/releases/cloud.firestore',
              rulesetName: 'projects/morgan-bank/rulesets/ruleset-1',
            })
          }
          if (pathname.endsWith('/rulesets/ruleset-1')) {
            return jsonResponse({
              name: 'projects/morgan-bank/rulesets/ruleset-1',
              source: { files: [{ name: 'firestore.rules', content: 'rules' }] },
            })
          }
          if (pathname.endsWith('/locations/-/functions')) {
            return jsonResponse({ functions: [functionResource] })
          }
          if (pathname.endsWith('/projects/morgan-bank/sites')) {
            return jsonResponse({ sites: [] })
          }
          if (pathname.endsWith('/indexes')) {
            return jsonResponse({ indexes: [] })
          }
          if (pathname.endsWith('/fields')) {
            return jsonResponse({ fields: [] })
          }
          throw new Error(`unhandled fake URL: ${pathname}`)
        },
      })
      const deployment = await readers.readDeploymentInventory()
      return deployment.functions['us-central1/functions/trigger']
    }

    it('normalizes EventTrigger filter permutations before hashing', async () => {
      const originalOrder = EVENT_FILTERS.map(filter => ({ ...filter }))
      const permutedOrder = [EVENT_FILTERS[2], EVENT_FILTERS[0], EVENT_FILTERS[1]]

      const originalRevision = await readFunctionRevision(
        triggerFunctionResource(),
      )
      const permutedRevision = await readFunctionRevision(
        triggerFunctionResource({
          eventTrigger: {
            eventType: 'google.cloud.firestore.document.v1.written',
            eventFilters: permutedOrder,
          },
        }),
      )

      assert.equal(permutedRevision, originalRevision)
      assert.deepEqual(EVENT_FILTERS, originalOrder,
        'normalization must not mutate the provider response')
    })

    it('keeps EventTrigger filter content in the function revision', async () => {
      const originalRevision = await readFunctionRevision(
        triggerFunctionResource(),
      )
      const changedRevision = await readFunctionRevision(
        triggerFunctionResource({
          eventTrigger: {
            eventType: 'google.cloud.firestore.document.v1.written',
            eventFilters: EVENT_FILTERS.map((filter, index) => index === 1
              ? { ...filter, value: 'classrooms/{classroomId}' }
              : filter),
          },
        }),
      )

      assert.notEqual(changedRevision, originalRevision)
    })

    it('does not normalize unrelated arrays in the function resource', async () => {
      const resource = triggerFunctionResource()
      const originalRevision = await readFunctionRevision(resource)
      const reorderedRevision = await readFunctionRevision(
        triggerFunctionResource({
          stateMessages: [...resource.stateMessages].reverse(),
        }),
      )

      assert.notEqual(reorderedRevision, originalRevision)
    })

    it('locks control-plane requests to fixed GET-only origins and exhausts pages', async () => {
      const calls = []
      const pages = [
        { values: [{ name: 'one' }], nextPageToken: 'next' },
        { values: [{ name: 'two' }] },
      ]
      const client = createBoundedGoogleApiClient({
        credential,
        fetchImpl: async (url, options) => {
          calls.push({ url, options })
          return jsonResponse(pages.shift())
        },
      })
      const values = await client.listAll({
        originKey: 'hosting',
        apiPath: '/v1beta1/projects/morgan-bank/sites',
        itemsField: 'values',
      })

      assert.deepEqual(values, [{ name: 'one' }, { name: 'two' }])
      assert.equal(calls.length, 2)
      for (const call of calls) {
        assert.equal(new globalThis.URL(call.url).origin,
          PRODUCTION_GOOGLE_API_ORIGINS.hosting)
        assert.equal(call.options.method, 'GET')
        assert.equal(call.options.redirect, 'manual')
        assert.equal(call.options.body, undefined)
        assert.equal(call.options.headers.Authorization, 'Bearer unit-test-token')
      }
      assert.equal(new globalThis.URL(calls[1].url).searchParams.get('pageToken'),
        'next')
    })

    it('fails closed on redirects, repeated tokens, unreachable regions and timeouts', async () => {
      const redirecting = createBoundedGoogleApiClient({
        credential,
        fetchImpl: async () => jsonResponse({}, { status: 307 }),
      })
      await assert.rejects(
        () => redirecting.getJson('rules', '/v1/projects/morgan-bank/releases/x'),
        error => error instanceof PreflightAbortError &&
          error.category === PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      )

      const repeated = createBoundedGoogleApiClient({
        credential,
        fetchImpl: async () => jsonResponse({ values: [], nextPageToken: 'same' }),
      })
      await assert.rejects(
        () => repeated.listAll({
          originKey: 'hosting', apiPath: '/v1/list', itemsField: 'values',
        }),
        error => error instanceof PreflightAbortError &&
          error.category === PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
      )

      const unreachable = createBoundedGoogleApiClient({
        credential,
        fetchImpl: async () => jsonResponse({
          functions: [], unreachable: ['locations/example'],
        }),
      })
      await assert.rejects(
        () => unreachable.listAll({
          originKey: 'functions', apiPath: '/v2/list', itemsField: 'functions',
          rejectUnreachable: true,
        }),
        error => error instanceof PreflightAbortError &&
          error.category === PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
      )

      const timingOut = createBoundedGoogleApiClient({
        credential,
        timeoutMs: 1,
        fetchImpl: async (unusedUrl, options) => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      })
      await assert.rejects(
        () => timingOut.getJson('rules', '/v1/projects/morgan-bank/releases/x'),
        error => error instanceof PreflightAbortError &&
          error.category === PREFLIGHT_ABORT_CATEGORIES.INSPECTION_UNAVAILABLE,
      )
    })

    it('paginates Firestore and Auth without coercing IDs or accepting duplicates', async () => {
      function document(index) {
        return {
          id: `student-${index}`,
          exists: true,
          ref: { path: `studentCredentials/student-${index}` },
          updateTime: { seconds: 1_700_000_000 + index, nanoseconds: index },
          data: () => ({ studentId: index }),
        }
      }
      const firstPage = Array.from({ length: 250 }, (unused, index) =>
        document(index + 1))
      const secondPage = [document(251)]
      const firestoreCursors = []
      let firestoreReads = 0
      const firestore = {
        doc() {},
        collection(collectionPath) {
          assert.equal(collectionPath, 'studentCredentials')
          const query = {
            orderBy() { return query },
            limit(value) { assert.equal(value, 250); return query },
            startAfter(cursor) { firestoreCursors.push(cursor.id); return query },
            async get() {
              firestoreReads += 1
              return { docs: firestoreReads === 1 ? firstPage : secondPage }
            },
          }
          return query
        },
      }
      const authTokens = []
      const auth = {
        async listUsers(limit, token) {
          assert.equal(limit, 1000)
          authTokens.push(token ?? null)
          if (token === undefined) {
            return { users: [authUser('legacy-a')], pageToken: 'auth-next' }
          }
          return { users: [authUser('legacy-b')] }
        },
      }
      function authUser(uid) {
        return {
          uid,
          disabled: false,
          providerData: [],
          metadata: { creationTime: '2026-07-26T18:00:00.123Z' },
        }
      }

      const dataReaders = createReadOnlyDataReaders({
        firestore,
        auth,
        teacherUid: TEACHER_UID,
      })
      const credentials = await dataReaders.readFlatCredentials()
      const users = await dataReaders.readAuthCompatibility()
      assert.equal(credentials.count, 251)
      assert.equal(firestoreReads, 2)
      assert.deepEqual(firestoreCursors, ['student-250'])
      assert.deepEqual(credentials.studentIds.slice(-2), [250, 251])
      assert.equal(users.examinedUserCount, 2)
      assert.deepEqual(authTokens, [null, 'auth-next'])
      assert.equal(users.sourceEntries[0].updateTime.nanoseconds, 123_000_000)

      const duplicateAuth = createReadOnlyDataReaders({
        firestore,
        auth: {
          async listUsers() {
            return { users: [authUser('same')], pageToken: 'repeat' }
          },
        },
        teacherUid: TEACHER_UID,
      })
      await assert.rejects(
        () => duplicateAuth.readAuthCompatibility(),
        error => error instanceof PreflightAbortError &&
          error.category === PREFLIGHT_ABORT_CATEGORIES.INCOMPLETE_PAGINATION,
      )
    })

    it('assembles and caches the complete production inventory with no mutating call', async () => {
      const calls = []
      const firestorePageTokens = { indexes: [], fields: [] }
      const firestoreParent =
        '/v1/projects/morgan-bank/databases/(default)/collectionGroups/-'
      let closed = 0
      let factoryArguments
      const payloadFor = url => {
        const parsed = new globalThis.URL(url)
        if (parsed.pathname.endsWith('/releases/cloud.firestore')) {
          return {
            name: 'projects/morgan-bank/releases/cloud.firestore',
            rulesetName: 'projects/morgan-bank/rulesets/ruleset-1',
          }
        }
        if (parsed.pathname.endsWith('/rulesets/ruleset-1')) {
          return {
            name: 'projects/morgan-bank/rulesets/ruleset-1',
            source: { files: [{ name: 'firestore.rules', content: 'rules' }] },
          }
        }
        if (parsed.pathname.endsWith('/locations/-/functions')) {
          return { functions: [{
            name: 'projects/morgan-bank/locations/us-central1/functions/writer',
            state: 'ACTIVE',
            updateTime: '2026-07-26T18:00:00.000Z',
            buildConfig: { runtime: 'nodejs20', entryPoint: 'writer' },
            serviceConfig: {
              revision: 'writer-00001',
              environmentVariables: {
                MULTI_TEACHER_V2_ENABLED: 'false',
                MULTI_TEACHER_V2_RELEASE_ID: 'phase3-release-1',
              },
            },
          }] }
        }
        if (parsed.pathname.endsWith('/projects/morgan-bank/sites')) {
          return { sites: [{ name: 'projects/morgan-bank/sites/morgan-bank' }] }
        }
        if (parsed.pathname.endsWith('/sites/morgan-bank/releases')) {
          return { releases: [
            {
              name: 'sites/morgan-bank/releases/release-1',
              releaseTime: '2026-07-26T18:00:00.000Z',
              version: { name: 'sites/morgan-bank/versions/version-1' },
            },
            {
              name: 'sites/morgan-bank/channels/review/releases/release-old',
              releaseTime: '2026-07-25T18:00:00.000Z',
              version: { name: 'sites/morgan-bank/versions/version-old' },
            },
            {
              name: 'sites/morgan-bank/channels/review/releases/release-2',
              releaseTime: '2026-07-26T19:00:00.000Z',
              version: { name: 'sites/morgan-bank/versions/version-2' },
            },
          ] }
        }
        if (parsed.pathname === `${firestoreParent}/indexes`) {
          const expectedToken = firestorePageTokens.indexes.length % 2 === 0
            ? null
            : 'indexes-next'
          assert.equal(parsed.searchParams.get('filter'), null)
          // Firestore Admin rejects any non-zero pageSize on the wildcard.
          assert.equal(parsed.searchParams.get('pageSize'), '0')
          assert.equal(parsed.searchParams.get('pageToken'), expectedToken)
          assert.deepEqual([...parsed.searchParams.keys()].sort(),
            expectedToken === null ? ['pageSize'] : ['pageSize', 'pageToken'])
          firestorePageTokens.indexes.push(expectedToken)
          return expectedToken === null
            ? { indexes: [], nextPageToken: 'indexes-next' }
            : { indexes: [] }
        }
        if (parsed.pathname === `${firestoreParent}/fields`) {
          const expectedToken = firestorePageTokens.fields.length % 2 === 0
            ? null
            : 'fields-next'
          assert.equal(
            parsed.searchParams.get('filter'),
            'indexConfig.usesAncestorConfig:false',
          )
          // Firestore Admin rejects any non-zero pageSize on the wildcard.
          assert.equal(parsed.searchParams.get('pageSize'), '0')
          assert.equal(parsed.searchParams.get('pageToken'), expectedToken)
          assert.deepEqual([...parsed.searchParams.keys()].sort(), expectedToken === null
            ? ['filter', 'pageSize']
            : ['filter', 'pageSize', 'pageToken'])
          firestorePageTokens.fields.push(expectedToken)
          return expectedToken === null
            ? { fields: [], nextPageToken: 'fields-next' }
            : { fields: [] }
        }
        throw new Error(`unhandled fake URL: ${parsed.pathname}`)
      }
      const readers = createProductionReaders({
        projectId: 'morgan-bank',
        teacherUid: TEACHER_UID,
        credential,
        adminHandleFactory: argumentsValue => {
          factoryArguments = argumentsValue
          return {
            firestore: { doc() {}, collection() {} },
            auth: { listUsers() {} },
            close: async () => { closed += 1 },
          }
        },
        fetchImpl: async (url, options) => {
          calls.push({ url, options })
          return jsonResponse(payloadFor(url))
        },
      })

      const deployment = await readers.readDeploymentInventory()
      assert.deepEqual(firestorePageTokens, {
        indexes: [null, 'indexes-next'],
        fields: [null, 'fields-next'],
      })
      const callCount = calls.length
      const writers = await readers.readActiveWriters()
      assert.equal(calls.length, callCount, 'inventory must be cached across readers')
      assert.equal(factoryArguments.projectId, 'morgan-bank')
      assert.strictEqual(factoryArguments.credential, credential)
      assert.match(factoryArguments.appName, /^phase3-production-preflight-/)
      assert.equal(deployment.complete, true)
      assert.equal(deployment.gateParameters.MULTI_TEACHER_V2_ENABLED, 'false')
      assert.equal(deployment.gateParameters.MULTI_TEACHER_V2_RELEASE_ID,
        'phase3-release-1')
      assert.equal(
        deployment.hosting['morgan-bank:channel:review'],
        'sites/morgan-bank/channels/review/releases/release-2|' +
          'sites/morgan-bank/versions/version-2',
      )
      assert.deepEqual(writers.writers, [
        'function:us-central1/functions/writer',
        'hosting:morgan-bank:channel:review:version-2',
        'hosting:morgan-bank:version-1',
      ])
      assert.ok(calls.every(call => call.options.method === 'GET' &&
        call.options.redirect === 'manual' && call.options.body === undefined))
      await readers.close()
      assert.equal(closed, 1)

      let forbiddenAdminFactoryCalls = 0
      const controlPlaneReaders = createProductionControlPlaneReaders({
        projectId: 'morgan-bank',
        credential,
        // Deliberately passed as an extra property: the control-plane factory
        // has no such seam and must neither inspect nor invoke it.
        adminHandleFactory: () => { forbiddenAdminFactoryCalls += 1 },
        fetchImpl: async (url, options) => {
          calls.push({ url, options })
          return jsonResponse(payloadFor(url))
        },
      })
      assert.deepEqual(Object.keys(controlPlaneReaders).sort(), [
        'readActiveWriters',
        'readDeploymentInventory',
      ])
      await controlPlaneReaders.readDeploymentInventory()
      await controlPlaneReaders.readActiveWriters()
      assert.equal(forbiddenAdminFactoryCalls, 0)
      assert.ok(calls.every(call => call.options.method === 'GET' &&
        call.options.redirect === 'manual' && call.options.body === undefined))
    })

    it('refuses project lookalikes, ambient credentials and widened timeouts', () => {
      const handles = () => ({
        firestore: { doc() {}, collection() {} },
        auth: { listUsers() {} },
        close: async () => {},
      })
      assert.throws(
        () => createProductionReaders({
          projectId: 'morgan-bank-dev', teacherUid: TEACHER_UID,
          credential, adminHandleFactory: handles,
        }),
        PreflightAbortError,
      )
      assert.throws(
        () => createProductionReaders({
          projectId: 'morgan-bank', teacherUid: TEACHER_UID,
          credential: null, adminHandleFactory: handles,
        }),
        PreflightAbortError,
      )
      assert.throws(
        () => createBoundedGoogleApiClient({ credential, timeoutMs: 10_001 }),
        PreflightAbortError,
      )
    })
  })

  describe('phantom-parent enumeration requirement', () => {
    it('declares listDocuments as the required enumeration method', () => {
      // A Firestore document holding only subcollections does not exist as a
      // document, so collection().get() returns zero rows while its
      // subcollections remain readable. A destination-absence check built on
      // get() would miss scoped credentials orphaned under such a parent. Found
      // against the real emulator during Commit 3 (get() saw 0, listDocuments()
      // saw 1); pinned here so the requirement survives into the production
      // reader implementation.
      assert.equal(COLLECTION_ENUMERATION_REQUIREMENT.method, 'listDocuments')
      assert.equal(COLLECTION_ENUMERATION_REQUIREMENT.rejected, 'get')
      assert.match(COLLECTION_ENUMERATION_REQUIREMENT.reason, /phantom-parent/)
    })

    it('the shared production data reader enumerates paths with listDocuments', async () => {
      // The emulator suite now calls createReadOnlyDataReaders, so this guard
      // inspects the implementation that both emulator and production execute.
      // Reverting it to get() would silently reintroduce the phantom-parent blind
      // spot even if a parallel test helper remained correct.
      const { readFileSync } = await import('node:fs')
      const { fileURLToPath } = await import('node:url')
      const source = readFileSync(
        fileURLToPath(new globalThis.URL(
          './productionPreflight.js',
          import.meta.url,
        )),
        'utf8',
      )
      // Comment lines are stripped before matching: the suite documents WHY
      // get() is wrong, and that prose must not trip the check on itself.
      const code = source
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n')
      assert.match(
        code,
        /collection\('classrooms'\)\.listDocuments\(\)/,
        'destination enumeration must use listDocuments',
      )
      assert.ok(
        !/collection\('classrooms'\)\.get\(\)/.test(code),
        'destination enumeration must not use get(), which hides phantom parents',
      )

      const emulatorSource = readFileSync(
        fileURLToPath(new globalThis.URL(
          '../../tests/phase3/production-runner.emulator.test.js',
          import.meta.url,
        )),
        'utf8',
      )
      assert.match(emulatorSource, /createReadOnlyDataReaders\(\{/)
    })
  })
})
