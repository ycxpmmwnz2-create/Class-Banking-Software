import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VERSION3_GEMINI_CALLABLE_DEMO_PROJECT,
  Version3GeminiEmulatorError,
  assertVersion3GeminiEmulatorRuntime,
  callableErrorCode,
  callableLogCategory,
} from './emulatorCallable.js'

function validRuntime(overrides = {}) {
  return {
    environment: {
      VERSION3_GEMINI_EMULATOR_ENABLED: 'true',
      FUNCTIONS_EMULATOR: 'true',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
    },
    projectId: VERSION3_GEMINI_CALLABLE_DEMO_PROJECT,
    adminAppCount: 1,
    adminProjectId: VERSION3_GEMINI_CALLABLE_DEMO_PROJECT,
    ...overrides,
  }
}

test('accepts only the exact demo project with all emulator guards', () => {
  assert.deepEqual(assertVersion3GeminiEmulatorRuntime(validRuntime()), {
    projectId: VERSION3_GEMINI_CALLABLE_DEMO_PROJECT,
  })
  for (const candidate of [
    validRuntime({ projectId: 'morgan-bank' }),
    validRuntime({ adminAppCount: 0 }),
    validRuntime({ adminProjectId: 'morgan-bank' }),
    validRuntime({ environment: { ...validRuntime().environment, FUNCTIONS_EMULATOR: 'false' } }),
    validRuntime({ environment: { ...validRuntime().environment, FIRESTORE_EMULATOR_HOST: 'example.com:8080' } }),
    validRuntime({ environment: { ...validRuntime().environment, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:0' } }),
  ]) {
    assert.throws(
      () => assertVersion3GeminiEmulatorRuntime(candidate),
      Version3GeminiEmulatorError,
    )
  }
})

test('maps only allowlisted callable error categories', () => {
  assert.equal(callableErrorCode({ category: 'authorization-failed' }), 'unauthenticated')
  assert.equal(callableErrorCode({ category: 'budget-unavailable' }), 'resource-exhausted')
  assert.equal(callableErrorCode({ category: 'private-internal-detail' }), 'internal')
  assert.equal(callableLogCategory({ category: 'budget-unavailable' }), 'budget-unavailable')
  assert.equal(callableLogCategory({ category: 'private-internal-detail' }), 'internal')
})
