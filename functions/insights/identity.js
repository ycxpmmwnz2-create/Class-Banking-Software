export class InsightIdentityError extends Error {
  constructor(label) {
    super(`${label} is malformed.`)
    this.name = 'InsightIdentityError'
    this.category = 'invalid-identity'
  }
}

export function validateInsightIdentity(value, label = 'identity') {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    containsControlCharacter(value)
  ) {
    throw new InsightIdentityError(label)
  }
  return value
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true
  }
  return false
}
