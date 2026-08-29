import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GeminiTransportError,
  classifyGeminiTransportError,
  createGeminiGenerateContent,
  createGeminiGenerateContentOnce,
} from './geminiTransport.js'

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

test('does not read response text when the candidate returned function calls', async () => {
  let textReads = 0
  class FakeGoogleGenAI {
    constructor() {
      this.models = {
        generateContent: async () => ({
          get text() {
            textReads += 1
            throw new Error('text getter must not run for a tool-call turn')
          },
          functionCalls: [{ id: 'call', name: 'get_balances', args: {} }],
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_balances' } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      }
    }
  }
  const generateOnce = createGeminiGenerateContentOnce({
    apiKey: API_KEY,
    GoogleGenAIClass: FakeGoogleGenAI,
  })
  const result = await generateOnce({ model: 'gemini-test', contents: [], config: {} })
  assert.equal(textReads, 0)
  assert.equal(result.text, undefined)
  assert.equal(result.functionCalls.length, 1)
})

test('reads response text when no function calls are returned', async () => {
  let textReads = 0
  class FakeGoogleGenAI {
    constructor() {
      this.models = {
        generateContent: async () => ({
          get text() {
            textReads += 1
            return '{"answer":"done"}'
          },
          functionCalls: [],
          candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      }
    }
  }
  const generateOnce = createGeminiGenerateContentOnce({
    apiKey: API_KEY,
    GoogleGenAIClass: FakeGoogleGenAI,
  })
  const result = await generateOnce({ model: 'gemini-test', contents: [], config: {} })
  assert.equal(textReads, 1)
  assert.equal(result.text, '{"answer":"done"}')
  assert.deepEqual(result.functionCalls, [])
})

test('retrying transport retries only transient failures and preserves a safe category', async () => {
  let attempts = 0
  const delays = []
  class FakeGoogleGenAI {
    constructor() {
      this.models = {
        async generateContent() {
          attempts += 1
          if (attempts < 3) throw Object.assign(new Error('secret provider detail'), { status: 503 })
          return { text: '{}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }
        },
      }
    }
  }
  const generate = createGeminiGenerateContent({
    apiKey: API_KEY,
    GoogleGenAIClass: FakeGoogleGenAI,
    delay: async value => delays.push(value),
  })
  await generate({ model: 'gemini-test', contents: [], config: {} })
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [250, 750])
  const rejected = classifyGeminiTransportError({ status: 400, message: 'raw' })
  assert.equal(rejected.category, 'provider-request-rejected')
  assert.equal(rejected.retryable, false)
  assert.equal(rejected.message, 'The Gemini request did not complete.')
  assert.equal(rejected instanceof GeminiTransportError, true)
})
