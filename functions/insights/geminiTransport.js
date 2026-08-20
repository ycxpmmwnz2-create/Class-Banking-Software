import { GoogleGenAI } from '@google/genai'

const ONE_ATTEMPT_HTTP_OPTIONS = Object.freeze({
  timeout: 60_000,
  retryOptions: Object.freeze({ attempts: 1 }),
})

export function createGeminiGenerateContentOnce({
  apiKey,
  GoogleGenAIClass = GoogleGenAI,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 20 || apiKey.trim() !== apiKey) {
    throw new TypeError('A canonical Gemini API key is required.')
  }
  if (typeof GoogleGenAIClass !== 'function') {
    throw new TypeError('GoogleGenAIClass must be a constructor.')
  }
  const client = new GoogleGenAIClass({
    apiKey,
    httpOptions: ONE_ATTEMPT_HTTP_OPTIONS,
  })
  if (typeof client?.models?.generateContent !== 'function') {
    throw new TypeError('The Gemini SDK client is unavailable.')
  }

  return async function generateContentOnce(request) {
    if (!isPlainObject(request) || !isPlainObject(request.config)) {
      throw new TypeError('A Gemini generate request is required.')
    }
    const response = await client.models.generateContent({
      ...request,
      config: {
        ...request.config,
        httpOptions: ONE_ATTEMPT_HTTP_OPTIONS,
      },
    })
    return Object.freeze({
      text: response?.text,
      usageMetadata: response?.usageMetadata,
    })
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
