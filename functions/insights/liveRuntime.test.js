import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REVIEWED_VERSION3_GEMINI_RELEASE_ID,
  Version3GeminiLiveRuntimeError,
  assertVersion3GeminiLiveRuntime,
} from './liveRuntime.js'

const API_KEY = 'test-only-key-with-more-than-twenty-characters'

function validInput(overrides = {}) {
  return {
    enabled: true,
    releaseId: REVIEWED_VERSION3_GEMINI_RELEASE_ID,
    deploymentTier: 'production',
    v2Runtime: {
      context: 'production',
      projectId: 'morgan-bank',
      releaseIdVerified: true,
    },
    adminAppCount: 1,
    adminProjectId: 'morgan-bank',
    apiKey: API_KEY,
    ...overrides,
  }
}

test('accepts only the exact production and staging runtime identities', () => {
  assert.deepEqual(assertVersion3GeminiLiveRuntime(validInput()), {
    deploymentTier: 'production',
    projectId: 'morgan-bank',
  })
  assert.deepEqual(assertVersion3GeminiLiveRuntime(validInput({
    deploymentTier: 'staging',
    v2Runtime: {
      context: 'staging',
      projectId: 'morgan-bank-staging',
      releaseIdVerified: true,
    },
    adminProjectId: 'morgan-bank-staging',
  })), {
    deploymentTier: 'staging',
    projectId: 'morgan-bank-staging',
  })
})

test('fails closed for every live activation boundary mismatch', () => {
  const invalid = [
    { enabled: false },
    { releaseId: 'different-release' },
    { deploymentTier: 'preview' },
    { v2Runtime: { context: 'staging', projectId: 'morgan-bank' } },
    { v2Runtime: { context: 'production', projectId: 'morgan-bank-staging', releaseIdVerified: true } },
    { v2Runtime: { context: 'production', projectId: 'morgan-bank' } },
    { adminAppCount: 0 },
    { adminAppCount: 2 },
    { adminProjectId: 'morgan-bank-staging' },
    { apiKey: '' },
    { apiKey: ` ${API_KEY}` },
  ]
  for (const override of invalid) {
    assert.throws(
      () => assertVersion3GeminiLiveRuntime(validInput(override)),
      error => error instanceof Version3GeminiLiveRuntimeError &&
        error.category === 'invalid-runtime',
    )
  }
})
