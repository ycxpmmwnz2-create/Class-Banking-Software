import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath, URL } from 'node:url'

import { PRODUCTION_ENVIRONMENT_CATEGORIES } from './productionEnvironment.js'
import {
  ANCHORED_REPOSITORY_ROOT,
  SCRUBBED_GIT_ROUTING_VARIABLES,
  verifyReviewedCheckout,
} from './reviewedCheckout.js'

const COMMIT_SHA = 'c39b40c50abd5e31e56d68eb9d80ae3ba5761215'

/**
 * The repository root observed INDEPENDENTLY of the module under test, so the
 * anchoring assertion is corroboration rather than a tautology.
 */
const OBSERVED_REPOSITORY_ROOT = path.resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
)

/**
 * Runs Git test-side with the ambient environment, deliberately NOT reusing the
 * module's own hardened invocation. If the two ever disagree about HEAD, the
 * root, or cleanliness, that is exactly the drift these tests exist to catch.
 *
 * Every caller observes with the ambient environment restored, so this helper
 * never has to reason about a hostile one.
 */
function observeGit(argumentsValue) {
  return execFileSync('git', argumentsValue, {
    cwd: OBSERVED_REPOSITORY_ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

function observeCheckout() {
  return {
    root: observeGit(['rev-parse', '--show-toplevel']).trimEnd(),
    head: observeGit(['rev-parse', '--verify', 'HEAD']).trimEnd(),
    status: observeGit(['status', '--porcelain=v1', '--untracked-files=all']),
  }
}

/** Captures the verifier's outcome without letting a rejection end the test. */
async function runRealVerifier(expectedCommitSha) {
  try {
    return { resolved: await verifyReviewedCheckout({ expectedCommitSha }) }
  } catch (error) {
    return { rejected: error }
  }
}

/**
 * Requires that a real-Git invocation actually reached the anchored repository
 * and resolved the reviewed commit.
 *
 * The strict outcome is chosen from an INDEPENDENT status observation, not
 * relaxed to whatever happened:
 *
 *  - clean tracked worktree  -> must resolve to the observed root and HEAD
 *  - dirty worktree          -> must reject with exactly `checkout-dirty`
 *
 * `checkout-unverifiable` and `checkout-mismatch` are always failures here: the
 * first means Git never reached the anchored repository, the second means it
 * reached a different commit than the one independently observed. That is the
 * assertion a dirty development worktree must never be allowed to soften.
 */
function assertReachedAnchoredRepository(before, outcome, after, label) {
  const { resolved, rejected } = outcome

  assert.equal(after.head, before.head,
    `${label}: HEAD moved mid-test; rerun on a stable checkout`)

  if (rejected !== undefined) {
    for (const forbidden of [
      PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_UNVERIFIABLE,
      PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_MISMATCH,
    ]) {
      assert.notEqual(
        rejected.category,
        forbidden,
        `${label}: real Git must reach the anchored repository at the ` +
          `observed HEAD; got ${rejected.category}`,
      )
    }
  }

  // A concurrent writer inside the repository would make the strict branch
  // below ambiguous. Nothing in this suite writes here, so an inconsistent
  // pair is reported rather than silently tolerated.
  assert.equal(before.status, after.status,
    `${label}: the worktree changed during the test; rerun without a ` +
      'concurrent writer in the repository')

  if (before.status === '') {
    assert.equal(rejected, undefined,
      `${label}: a clean worktree at the expected commit must resolve`)
    assert.deepEqual({ ...resolved }, {
      repositoryRoot: before.root,
      commitSha: before.head,
    }, `${label}: must resolve to the independently observed checkout`)
    return
  }

  assert.equal(rejected?.category,
    PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_DIRTY,
    `${label}: a dirty worktree must reject with exactly checkout-dirty`)
}

describe('Phase 3 reviewed-checkout proof', () => {
  describe('operator-only module boundary', () => {
    it('exposes only the checkout proof and its anchoring facts', async () => {
      const module = await import('./reviewedCheckout.js')
      assert.deepEqual(Object.keys(module).sort(), [
        'ANCHORED_REPOSITORY_ROOT',
        'SCRUBBED_GIT_ROUTING_VARIABLES',
        'verifyReviewedCheckout',
      ], 'the operator-only checkout module must expose no other capability')
    })

    it('imports no Admin SDK, reader, writer, manifest, network, or deploy code',
      async () => {
        const source = await readFile(
          new URL('./reviewedCheckout.js', import.meta.url), 'utf8',
        )
        for (const forbidden of [
          'firebase-admin', 'firebase-functions', 'googleapis',
          './productionInventory.js', './productionPreflight.js',
          './productionProjection.js', './productionManifest.js',
          './productionWriter.js', './productionReconciliation.js',
          './studentLifecycle.js', './inventory.js', './preflight.js',
          './write.js', './reverify.js',
          'initializeApp(', 'getFirestore(', 'getAuth(', 'fetch(',
          "new URL('https",
        ]) {
          assert.ok(
            !source.includes(forbidden),
            `reviewedCheckout.js must not contain ${forbidden}`,
          )
        }
        // The proof is read-only Git inspection: no mutating or network Git
        // verb may appear as an argument literal.
        for (const verb of [
          'commit', 'checkout', 'reset', 'clean', 'fetch', 'push', 'pull',
          'stash', 'apply', 'add',
        ]) {
          assert.ok(
            !source.includes(`'${verb}'`),
            `reviewedCheckout.js must not issue git ${verb}`,
          )
        }
      })
  })

  describe('injected behavior', () => {
    const responses = ({
      head = COMMIT_SHA,
      root = ANCHORED_REPOSITORY_ROOT,
      status = '',
    } = {}) => async argumentsValue => {
      if (argumentsValue.includes('--show-toplevel')) return `${root}\n`
      if (argumentsValue.includes('--verify')) return `${head}\n`
      return status
    }

    it('verifies exact HEAD and a clean worktree using local read-only Git calls',
      async () => {
        const calls = []
        const result = await verifyReviewedCheckout({
          expectedCommitSha: COMMIT_SHA,
          runGit: async argumentsValue => {
            calls.push(argumentsValue)
            return responses()(argumentsValue)
          },
        })
        assert.equal(result.commitSha, COMMIT_SHA)
        assert.equal(result.repositoryRoot, ANCHORED_REPOSITORY_ROOT)
        assert.deepEqual(calls, [
          ['rev-parse', '--show-toplevel'],
          ['rev-parse', '--verify', 'HEAD'],
          ['status', '--porcelain=v1', '--untracked-files=all'],
        ])
      })

    it('the shared checkout verifier rejects a wrong commit and every dirty status',
      async () => {
        await assert.rejects(
          verifyReviewedCheckout({
            expectedCommitSha: COMMIT_SHA,
            runGit: responses({ head: 'a'.repeat(40) }),
          }),
          error => error.category === 'checkout-mismatch',
        )
        for (const status of [
          ' M functions/phase3/preflight.js\n',
          '?? untracked-review-input.txt\n',
        ]) {
          await assert.rejects(
            verifyReviewedCheckout({
              expectedCommitSha: COMMIT_SHA,
              runGit: responses({ status }),
            }),
            error => error.category === 'checkout-dirty',
          )
        }
      })

    it('treats a foreign root, non-canonical Git output, or a failed call as unverifiable',
      async () => {
        const unverifiable = error =>
          error.category === PRODUCTION_ENVIRONMENT_CATEGORIES
            .CHECKOUT_UNVERIFIABLE

        // A different repository must never satisfy the anchored proof.
        await assert.rejects(
          verifyReviewedCheckout({
            expectedCommitSha: COMMIT_SHA,
            runGit: responses({ root: '/tmp/some-other-checkout' }),
          }),
          unverifiable,
        )

        // Missing newline, embedded newline, and CR are rejected rather than
        // trimmed: a trimmed value could hide a second line.
        for (const head of [
          COMMIT_SHA,
          `${COMMIT_SHA}\nextra\n`,
          `${COMMIT_SHA}\r\n`,
        ]) {
          await assert.rejects(
            verifyReviewedCheckout({
              expectedCommitSha: COMMIT_SHA,
              runGit: async argumentsValue => {
                if (argumentsValue.includes('--show-toplevel')) {
                  return `${ANCHORED_REPOSITORY_ROOT}\n`
                }
                if (argumentsValue.includes('--verify')) return head
                return ''
              },
            }),
            unverifiable,
          )
        }

        // A failing Git call is closed, and its message never propagates.
        await assert.rejects(
          verifyReviewedCheckout({
            expectedCommitSha: COMMIT_SHA,
            runGit: async () => {
              throw new Error('git: fatal: /operator/secret-path not found')
            },
          }),
          error => unverifiable(error) &&
            !error.message.includes('secret-path'),
        )

        // A caller-supplied expectation that is not a full lowercase SHA is
        // rejected before Git runs at all.
        for (const expectedCommitSha of [
          undefined, '', 'HEAD', COMMIT_SHA.toUpperCase(),
          COMMIT_SHA.slice(0, 39),
        ]) {
          let ran = 0
          await assert.rejects(
            verifyReviewedCheckout({
              expectedCommitSha,
              runGit: async () => {
                ran += 1
                return ''
              },
            }),
            unverifiable,
          )
          assert.equal(ran, 0, 'Git must not run for an invalid expectation')
        }
      })
  })

  describe('real Git execution with no injection', () => {
    it('anchors to the repository an independent Git call reports', () => {
      const { root } = observeCheckout()
      assert.equal(
        ANCHORED_REPOSITORY_ROOT,
        root,
        'the module must anchor to this repository, not a discovered parent',
      )
      assert.equal(ANCHORED_REPOSITORY_ROOT, OBSERVED_REPOSITORY_ROOT)
    })

    it('resolves the independently observed HEAD, or rejects a dirty worktree',
      async () => {
        const before = observeCheckout()
        const outcome = await runRealVerifier(before.head)
        assertReachedAnchoredRepository(
          before, outcome, observeCheckout(), 'real Git',
        )
      })

    it('rejects a fabricated commit with checkout-mismatch against real Git',
      async () => {
        const fabricated = 'b'.repeat(40)
        const { head } = observeCheckout()
        assert.notEqual(head, fabricated)
        await assert.rejects(
          verifyReviewedCheckout({ expectedCommitSha: fabricated }),
          error => error.category ===
            PRODUCTION_ENVIRONMENT_CATEGORIES.CHECKOUT_MISMATCH,
          'real Git must report a mismatch, not an unverifiable checkout',
        )
      })

    it('scrubs every routing variable so an inherited environment cannot redirect it',
      async () => {
        // Observed BEFORE the hostile environment is installed, so the
        // expectation itself cannot be contaminated by it.
        const before = observeCheckout()
        assert.ok(
          SCRUBBED_GIT_ROUTING_VARIABLES.includes('GIT_DIR') &&
            SCRUBBED_GIT_ROUTING_VARIABLES.includes('GIT_WORK_TREE'),
          'the scrub list must cover the primary routing variables',
        )

        // Hostile values for every variable the module claims to scrub, plus
        // the indexed config pair it filters by prefix. Unscrubbed, each of
        // these would redirect Git at another checkout or make it fatal, which
        // would surface as checkout-unverifiable.
        const hostile = {
          ...Object.fromEntries(
            SCRUBBED_GIT_ROUTING_VARIABLES.map(name => [
              name, '/nonexistent/hostile-git-routing',
            ]),
          ),
          GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
          GIT_CONFIG_NOSYSTEM: '0',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.bare',
          GIT_CONFIG_VALUE_0: 'true',
        }
        const saved = new Map(
          Object.keys(hostile).map(name => [name, process.env[name]]),
        )

        let outcome
        try {
          for (const [name, value] of Object.entries(hostile)) {
            process.env[name] = value
          }
          outcome = await runRealVerifier(before.head)
        } finally {
          for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
          }
        }

        for (const [name, value] of saved) {
          assert.equal(process.env[name], value,
            `${name} must be restored exactly`)
        }
        // Observed only after the environment is restored, so the observation
        // itself is never made through the hostile routing.
        assertReachedAnchoredRepository(
          before, outcome, observeCheckout(), 'scrubbed environment',
        )
      })
  })
})
