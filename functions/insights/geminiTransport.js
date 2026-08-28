import { GoogleGenAI } from '@google/genai'
import { setTimeout as delayTimeout } from 'node:timers/promises'

const ONE_ATTEMPT_HTTP_OPTIONS = Object.freeze({
  timeout: 60_000,
  retryOptions: Object.freeze({ attempts: 1 }),
})

const TRANSIENT_HTTP_STATUSES = Object.freeze(new Set([408, 429, 500, 502, 503, 504]))
const TRANSIENT_ERROR_CODES = Object.freeze(new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]))

export class GeminiTransportError extends Error {
  constructor(category, message, { retryable = false, status = null } = {}) {
    super(message)
    this.name = 'GeminiTransportError'
    this.category = category
    this.retryable = retryable
    this.status = status
  }
}

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
    const requestedTimeout = request.config.httpOptions?.timeout ?? ONE_ATTEMPT_HTTP_OPTIONS.timeout
    if (!Number.isInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > ONE_ATTEMPT_HTTP_OPTIONS.timeout) {
      throw new TypeError('The Gemini request timeout is invalid.')
    }
    const response = await client.models.generateContent({
      ...request,
      config: {
        ...request.config,
        httpOptions: {
          ...ONE_ATTEMPT_HTTP_OPTIONS,
          timeout: requestedTimeout,
        },
      },
    })
    const firstCandidate = Array.isArray(response?.candidates) ? response.candidates[0] : undefined
    return Object.freeze({
      text: response?.text,
      functionCalls: Array.isArray(response?.functionCalls)
        ? Object.freeze(response.functionCalls.map(call => Object.freeze({
          id: call?.id,
          name: call?.name,
          args: call?.args,
        })))
        : undefined,
      candidateContent: firstCandidate?.content,
      finishReason: firstCandidate?.finishReason,
      usageMetadata: response?.usageMetadata,
    })
  }
}

export function createGeminiGenerateContent({
  apiKey,
  GoogleGenAIClass = GoogleGenAI,
  maxAttempts = 3,
  delay = milliseconds => delayTimeout(milliseconds),
  retryDelays = Object.freeze([250, 750]),
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new TypeError('maxAttempts must be between one and three.')
  }
  if (typeof delay !== 'function') throw new TypeError('delay must be a function.')
  const generateOnce = createGeminiGenerateContentOnce({ apiKey, GoogleGenAIClass })
  return async function generateContent(request) {
    const totalTimeoutMs = request?.config?.httpOptions?.timeout ?? ONE_ATTEMPT_HTTP_OPTIONS.timeout
    if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > ONE_ATTEMPT_HTTP_OPTIONS.timeout) {
      throw new TypeError('The Gemini request timeout is invalid.')
    }
    const deadline = Date.now() + totalTimeoutMs
    let lastError
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingDurationMs = Math.floor(deadline - Date.now())
      if (remainingDurationMs < 1) throw transportError('provider-timeout', true, 408)
      try {
        return await generateOnce({
          ...request,
          config: {
            ...request.config,
            httpOptions: { timeout: remainingDurationMs },
          },
        })
      } catch (error) {
        lastError = classifyGeminiTransportError(error)
        if (!lastError.retryable || attempt === maxAttempts) throw lastError
        const retryDelayMs = retryDelays[attempt - 1] ?? retryDelays.at(-1) ?? 0
        if (Date.now() + retryDelayMs >= deadline) throw transportError('provider-timeout', true, 408)
        await delay(retryDelayMs)
      }
    }
    throw lastError
  }
}

export function classifyGeminiTransportError(error) {
  if (error instanceof GeminiTransportError) return error
  const status = numericStatus(error)
  const code = typeof error?.code === 'string' ? error.code.toLocaleUpperCase('en-US') : ''
  if (status === 401 || status === 403) return transportError('provider-authentication-failed', false, status)
  if (status === 429) return transportError('provider-rate-limited', true, status)
  if (status === 408 || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return transportError('provider-timeout', true, status)
  }
  if ([400, 404, 409, 422].includes(status)) {
    return transportError('provider-request-rejected', false, status)
  }
  if (TRANSIENT_HTTP_STATUSES.has(status) || TRANSIENT_ERROR_CODES.has(code)) {
    return transportError('provider-unavailable', true, status)
  }
  return transportError('provider-unavailable', false, status)
}

function transportError(category, retryable, status) {
  return new GeminiTransportError(category, 'The Gemini request did not complete.', { retryable, status })
}

function numericStatus(error) {
  for (const value of [error?.status, error?.statusCode, error?.response?.status, error?.cause?.status]) {
    const numeric = typeof value === 'string' ? Number(value) : value
    if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric
  }
  return null
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
