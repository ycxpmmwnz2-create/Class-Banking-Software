export const VERSION3_GEMINI_LIVE_PROJECTS = Object.freeze({
  production: 'morgan-bank',
  staging: 'morgan-bank-staging',
})

export const REVIEWED_VERSION3_GEMINI_RELEASE_ID =
  'gemini-3.6-flash-minimal-ai-insights-v2'

export class Version3GeminiLiveRuntimeError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'Version3GeminiLiveRuntimeError'
    this.category = category
  }
}

export function assertVersion3GeminiLiveRuntime({
  enabled,
  releaseId,
  deploymentTier,
  v2Runtime,
  adminAppCount,
  adminProjectId,
  apiKey,
} = {}) {
  const expectedProjectId = VERSION3_GEMINI_LIVE_PROJECTS[deploymentTier]
  if (
    enabled !== true ||
    releaseId !== REVIEWED_VERSION3_GEMINI_RELEASE_ID ||
    !expectedProjectId ||
    !isPlainObject(v2Runtime) ||
    v2Runtime.context !== deploymentTier ||
    v2Runtime.projectId !== expectedProjectId ||
    v2Runtime.releaseIdVerified !== true ||
    adminAppCount !== 1 ||
    adminProjectId !== expectedProjectId ||
    !isCanonicalSecret(apiKey)
  ) {
    throw new Version3GeminiLiveRuntimeError(
      'invalid-runtime',
      'Version 3 Gemini live analysis is disabled.',
    )
  }
  return Object.freeze({ deploymentTier, projectId: expectedProjectId })
}

function isCanonicalSecret(value) {
  const hasDisallowedCharacter = typeof value === 'string' && [...value].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 32 || codePoint === 127
  })
  return typeof value === 'string' &&
    value.length >= 20 &&
    value.length <= 256 &&
    value.trim() === value &&
    !hasDisallowedCharacter
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
