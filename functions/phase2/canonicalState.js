import { createHash } from 'node:crypto'

function valuePath(parentPath, key) {
  return `${parentPath}[${JSON.stringify(key)}]`
}

function canonicalizeJsonValue(value, currentPath, ancestors) {
  if (value === null || typeof value === 'string' ||
      typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `Canonical state contains a non-finite number at ${currentPath}.`,
      )
    }

    return value
  }

  if (typeof value !== 'object') {
    throw new TypeError(
      `Canonical state contains a non-JSON value at ${currentPath}.`,
    )
  }

  if (ancestors.has(value)) {
    throw new TypeError(`Canonical state contains a cycle at ${currentPath}.`)
  }

  ancestors.add(value)

  try {
    if (Array.isArray(value)) {
      const expectedKeys = new Set(['length'])
      const canonicalArray = []

      for (let index = 0; index < value.length; index += 1) {
        const key = String(index)
        expectedKeys.add(key)

        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor) {
          throw new TypeError(
            `Canonical state contains a sparse array at ${currentPath}.`,
          )
        }

        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new TypeError(
            `Canonical state contains a non-JSON property at ${valuePath(currentPath, index)}.`,
          )
        }

        canonicalArray.push(canonicalizeJsonValue(
          descriptor.value,
          valuePath(currentPath, index),
          ancestors,
        ))
      }

      if (Reflect.ownKeys(value).some(key => !expectedKeys.has(key))) {
        throw new TypeError(
          `Canonical state contains a non-JSON array property at ${currentPath}.`,
        )
      }

      return canonicalArray
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `Canonical state contains a non-JSON object at ${currentPath}.`,
      )
    }

    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== 'string')) {
      throw new TypeError(
        `Canonical state contains a symbol-keyed value at ${currentPath}.`,
      )
    }

    const canonicalObject = Object.create(null)
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor.enumerable || descriptor.get || descriptor.set) {
        throw new TypeError(
          `Canonical state contains a non-JSON property at ${valuePath(currentPath, key)}.`,
        )
      }

      canonicalObject[key] = canonicalizeJsonValue(
        descriptor.value,
        valuePath(currentPath, key),
        ancestors,
      )
    }

    return canonicalObject
  } finally {
    ancestors.delete(value)
  }
}

export function serializeCanonicalState(value) {
  return JSON.stringify(canonicalizeJsonValue(value, '$', new Set()))
}

export function hashCanonicalState(value) {
  return createHash('sha256')
    .update(serializeCanonicalState(value), 'utf8')
    .digest('hex')
}
