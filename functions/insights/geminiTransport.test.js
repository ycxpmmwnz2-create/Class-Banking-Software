import assert from 'node:assert/strict'
import test from 'node:test'

import { createGeminiGenerateContentOnce } from './geminiTransport.js'

const API_KEY = 'test-only-key-with-more-than-twenty-characters'

test('official SDK transport makes one bounded request with retries disabled', async () => {
  const constructorCalls = []
  const generateCalls = []
  class FakeGoogleGenAI {
    constructor(options) {
      constructorCalls.push(options)
      this.models = {
        generateContent: async request => {
          generateCalls.push(request)
          return {
            text: '{"schemaVersion":2}',
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          }
        },
      }
    }
  }
  const generateOnce = createGeminiGenerateContentOnce({
    apiKey: API_KEY,
    GoogleGenAIClass: FakeGoogleGenAI,
  })
  const request = {
    model: 'gemini-3.5-flash-lite',
    contents: [{ role: 'user', parts: [{ text: '{}' }] }],
    config: { responseMimeType: 'application/json' },
  }
  const result = await generateOnce(request)

  assert.equal(constructorCalls.length, 1)
  assert.equal(constructorCalls[0].apiKey, API_KEY)
  assert.deepEqual(constructorCalls[0].httpOptions, {
    timeout: 60_000,
    retryOptions: { attempts: 1 },
  })
  assert.equal(generateCalls.length, 1)
  assert.equal(generateCalls[0].config.httpOptions.retryOptions.attempts, 1)
  assert.equal(generateCalls[0].config.httpOptions.timeout, 60_000)
  assert.equal(Object.hasOwn(request.config, 'httpOptions'), false)
  assert.equal(result.text, '{"schemaVersion":2}')
})

test('transport rejects missing key or malformed injected SDK before any request', () => {
  assert.throws(() => createGeminiGenerateContentOnce({ apiKey: '' }), /canonical/)
  assert.throws(() => createGeminiGenerateContentOnce({
    apiKey: API_KEY,
    GoogleGenAIClass: class {},
  }), /unavailable/)
})
