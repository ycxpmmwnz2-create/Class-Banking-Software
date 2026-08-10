import { createHash } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'

const FIRESTORE_VALUE_TAG = '$phase2aFirestoreValue'
const FIRESTORE_VALUE_VERSION = 1
const FIRESTORE_TIMESTAMP_MIN_SECONDS = -62135596800
const FIRESTORE_TIMESTAMP_MAX_SECONDS = 253402300799

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

function failFirestoreValue(message, currentPath) {
  throw new TypeError(`${message} at ${currentPath}.`)
}

function requirePlainObject(value, currentPath, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failFirestoreValue(message, currentPath)
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    failFirestoreValue(message, currentPath)
  }

  return value
}

function enumerableDataDescriptor(value, key, currentPath) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)

  if (!descriptor || !descriptor.enumerable || descriptor.get ||
      descriptor.set) {
    failFirestoreValue(
      'Canonical Firestore value contains a non-data property',
      valuePath(currentPath, key),
    )
  }

  return descriptor
}

function requireExactObjectKeys(value, expectedKeys, currentPath) {
  requirePlainObject(
    value,
    currentPath,
    'Canonical Firestore value contains a malformed object',
  )

  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) {
    failFirestoreValue(
      'Canonical Firestore value contains a symbol-keyed property',
      currentPath,
    )
  }

  if (keys.length !== expectedKeys.length ||
      expectedKeys.some(key => !keys.includes(key))) {
    failFirestoreValue(
      'Canonical Firestore value contains an unexpected object shape',
      currentPath,
    )
  }

  for (const key of expectedKeys) {
    enumerableDataDescriptor(value, key, currentPath)
  }
}

function requireDenseStructuralArray(value, currentPath) {
  if (!Array.isArray(value)) {
    failFirestoreValue(
      'Canonical Firestore value contains a malformed structural array',
      currentPath,
    )
  }

  const expectedKeys = new Set(['length'])
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index)
    expectedKeys.add(key)
    enumerableDataDescriptor(value, key, currentPath)
  }

  if (Reflect.ownKeys(value).some(key => !expectedKeys.has(key))) {
    failFirestoreValue(
      'Canonical Firestore value contains a malformed structural array',
      currentPath,
    )
  }

  return value
}

function canonicalFirestoreWrapper(payload) {
  return {
    [FIRESTORE_VALUE_TAG]: payload,
  }
}

function encodeFirestoreValue(value, currentPath, ancestors) {
  if (value === null || typeof value === 'string' ||
      typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      failFirestoreValue(
        'Canonical Firestore value contains a non-finite number',
        currentPath,
      )
    }

    if (Object.is(value, -0)) {
      failFirestoreValue(
        'Canonical Firestore value contains negative zero',
        currentPath,
      )
    }

    return value
  }

  if (value instanceof Timestamp) {
    const { seconds, nanoseconds } = value

    if (Object.is(seconds, -0) || Object.is(nanoseconds, -0) ||
        !Number.isSafeInteger(seconds) ||
        seconds < FIRESTORE_TIMESTAMP_MIN_SECONDS ||
        seconds > FIRESTORE_TIMESTAMP_MAX_SECONDS ||
        !Number.isInteger(nanoseconds) ||
        nanoseconds < 0 || nanoseconds > 999999999) {
      failFirestoreValue(
        'Canonical Firestore value contains an invalid Timestamp',
        currentPath,
      )
    }

    return canonicalFirestoreWrapper({
      version: FIRESTORE_VALUE_VERSION,
      type: 'timestamp',
      seconds,
      nanoseconds,
    })
  }

  if (value === null || typeof value !== 'object') {
    failFirestoreValue(
      'Canonical Firestore value contains an unsupported value',
      currentPath,
    )
  }

  if (ancestors.has(value)) {
    failFirestoreValue(
      'Canonical Firestore value contains a cycle',
      currentPath,
    )
  }

  ancestors.add(value)

  try {
    if (Array.isArray(value)) {
      const expectedKeys = new Set(['length'])
      const values = []

      for (let index = 0; index < value.length; index += 1) {
        const key = String(index)
        expectedKeys.add(key)
        const descriptor = enumerableDataDescriptor(value, key, currentPath)
        values.push(encodeFirestoreValue(
          descriptor.value,
          valuePath(currentPath, index),
          ancestors,
        ))
      }

      if (Reflect.ownKeys(value).some(key => !expectedKeys.has(key))) {
        failFirestoreValue(
          'Canonical Firestore value contains a malformed array',
          currentPath,
        )
      }

      return canonicalFirestoreWrapper({
        version: FIRESTORE_VALUE_VERSION,
        type: 'array',
        values,
      })
    }

    requirePlainObject(
      value,
      currentPath,
      'Canonical Firestore value contains an unsupported object',
    )

    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== 'string')) {
      failFirestoreValue(
        'Canonical Firestore value contains a symbol-keyed property',
        currentPath,
      )
    }

    const entries = keys.sort().map(key => {
      const descriptor = enumerableDataDescriptor(value, key, currentPath)
      return [
        key,
        encodeFirestoreValue(
          descriptor.value,
          valuePath(currentPath, key),
          ancestors,
        ),
      ]
    })

    return canonicalFirestoreWrapper({
      version: FIRESTORE_VALUE_VERSION,
      type: 'map',
      entries,
    })
  } finally {
    ancestors.delete(value)
  }
}

function decodeFirestoreValue(value, currentPath, ancestors) {
  if (value === null || typeof value === 'string' ||
      typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      failFirestoreValue(
        'Canonical Firestore value contains a non-finite number',
        currentPath,
      )
    }

    if (Object.is(value, -0)) {
      failFirestoreValue(
        'Canonical Firestore value contains negative zero',
        currentPath,
      )
    }

    return value
  }

  if (value === null || typeof value !== 'object') {
    failFirestoreValue(
      'Canonical Firestore value contains an unsupported encoded value',
      currentPath,
    )
  }

  if (ancestors.has(value)) {
    failFirestoreValue(
      'Canonical Firestore value contains a cycle',
      currentPath,
    )
  }

  ancestors.add(value)

  try {
    requireExactObjectKeys(value, [FIRESTORE_VALUE_TAG], currentPath)
    const payload = value[FIRESTORE_VALUE_TAG]
    const payloadPath = valuePath(currentPath, FIRESTORE_VALUE_TAG)

    requirePlainObject(
      payload,
      payloadPath,
      'Canonical Firestore value contains a malformed wrapper',
    )

    const versionDescriptor = enumerableDataDescriptor(
      payload,
      'version',
      payloadPath,
    )
    const typeDescriptor = enumerableDataDescriptor(payload, 'type', payloadPath)

    if (versionDescriptor.value !== FIRESTORE_VALUE_VERSION) {
      failFirestoreValue(
        'Canonical Firestore value contains an unsupported wrapper version',
        valuePath(payloadPath, 'version'),
      )
    }

    const type = typeDescriptor.value

    if (type === 'timestamp') {
      requireExactObjectKeys(
        payload,
        ['version', 'type', 'seconds', 'nanoseconds'],
        payloadPath,
      )
      const seconds = payload.seconds
      const nanoseconds = payload.nanoseconds

      if (Object.is(seconds, -0) || Object.is(nanoseconds, -0) ||
          !Number.isSafeInteger(seconds) ||
          seconds < FIRESTORE_TIMESTAMP_MIN_SECONDS ||
          seconds > FIRESTORE_TIMESTAMP_MAX_SECONDS ||
          !Number.isInteger(nanoseconds) ||
          nanoseconds < 0 || nanoseconds > 999999999) {
        failFirestoreValue(
          'Canonical Firestore value contains an invalid Timestamp',
          payloadPath,
        )
      }

      return new Timestamp(seconds, nanoseconds)
    }

    if (type === 'array') {
      requireExactObjectKeys(
        payload,
        ['version', 'type', 'values'],
        payloadPath,
      )
      const valuesPath = valuePath(payloadPath, 'values')
      const values = requireDenseStructuralArray(payload.values, valuesPath)

      return values.map((entry, index) => decodeFirestoreValue(
        entry,
        valuePath(valuesPath, index),
        ancestors,
      ))
    }

    if (type === 'map') {
      requireExactObjectKeys(
        payload,
        ['version', 'type', 'entries'],
        payloadPath,
      )
      const entriesPath = valuePath(payloadPath, 'entries')
      const entries = requireDenseStructuralArray(payload.entries, entriesPath)
      const decoded = {}
      let previousKey

      for (let index = 0; index < entries.length; index += 1) {
        const entryPath = valuePath(entriesPath, index)
        const pair = requireDenseStructuralArray(entries[index], entryPath)

        if (pair.length !== 2 || typeof pair[0] !== 'string') {
          failFirestoreValue(
            'Canonical Firestore value contains a malformed map entry',
            entryPath,
          )
        }

        const key = pair[0]
        if (previousKey !== undefined && !(previousKey < key)) {
          failFirestoreValue(
            'Canonical Firestore value map entries are duplicated or out of order',
            entryPath,
          )
        }

        const decodedValue = decodeFirestoreValue(
          pair[1],
          valuePath(entryPath, 1),
          ancestors,
        )
        Object.defineProperty(decoded, key, {
          value: decodedValue,
          enumerable: true,
          writable: true,
          configurable: true,
        })
        previousKey = key
      }

      return decoded
    }

    failFirestoreValue(
      'Canonical Firestore value contains an unsupported wrapper type',
      valuePath(payloadPath, 'type'),
    )
  } finally {
    ancestors.delete(value)
  }
}

export function encodeCanonicalFirestoreValue(value) {
  return encodeFirestoreValue(value, '$', new Set())
}

export function decodeCanonicalFirestoreValue(value) {
  return decodeFirestoreValue(value, '$', new Set())
}
