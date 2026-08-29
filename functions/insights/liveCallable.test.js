import assert from 'node:assert/strict'
import test from 'node:test'

import { callableErrorDetails } from './callableErrors.js'
import { createVersion3GeminiLiveHandler } from './liveCallable.js'

test('the validation subcategory never reaches the client', () => {
  assert.deepEqual(callableErrorDetails({
    category: 'answer-unverified',
    subcategory: 'unsupported-number',
  }), { category: 'answer-unverified' })
})

test('live composition returns the reviewed service without contacting Gemini', () => {
  let sdkConstructors = 0
  class FakeGoogleGenAI {
    constructor() {
      sdkConstructors += 1
      this.models = { generateContent: async () => { throw new Error('must not run') } }
    }
  }
  const analyze = createVersion3GeminiLiveHandler({
    firestore: {
      collection() { throw new Error('must not run') },
      runTransaction() { throw new Error('must not run') },
    },
    apiKey: 'test-only-key-with-more-than-twenty-characters',
    GoogleGenAIClass: FakeGoogleGenAI,
  })
  assert.equal(typeof analyze, 'function')
  assert.equal(sdkConstructors, 1)
})

test('tool assistant is constructed only when its separate rollback gate is enabled', () => {
  let sdkConstructors = 0
  class FakeGoogleGenAI {
    constructor() {
      sdkConstructors += 1
      this.models = { generateContent: async () => { throw new Error('must not run') } }
    }
  }
  const handler = createVersion3GeminiLiveHandler({
    firestore: {
      collection() { throw new Error('must not run') },
      runTransaction() { throw new Error('must not run') },
    },
    apiKey: 'test-only-key-with-more-than-twenty-characters',
    GoogleGenAIClass: FakeGoogleGenAI,
    toolAssistantEnabled: true,
  })
  assert.equal(typeof handler, 'function')
  assert.equal(sdkConstructors, 2)
})
