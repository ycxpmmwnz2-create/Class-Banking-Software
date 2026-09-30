import { Buffer } from 'node:buffer'
import { hasExactDataKeys } from './classroomAccess.js'

export class MoneyDocumentSizeError extends Error {
  constructor() { super('Money document encoding is unsupported.'); this.name = 'MoneyDocumentSizeError' }
}
const fail = () => { throw new MoneyDocumentSizeError() }

// Conservative local estimate for scalar/map/array money documents, not Firestore
// billing/index size or a guarantee that a future SDK write fits. No JSON coercion.
export function estimateMoneyDocumentBytes(path, value) {
  let nodes = 0
  const seen = new Set()
  const stringBytes = text => Buffer.byteLength(text, 'utf8') * 2 + 32
  function visit(item, depth) {
    if (++nodes > 100_000 || depth > 20) fail('unsupported-encoding')
    if (typeof item === 'string') return stringBytes(item)
    if (typeof item === 'number') return 40
    if (typeof item === 'boolean' || item === null) return 33
    if (!item || typeof item !== 'object' || seen.has(item)) fail('unsupported-encoding')
    seen.add(item)
    let size = 32
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) fail('unsupported-encoding')
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i))
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('unsupported-encoding')
        size += 32 + visit(descriptor.value, depth + 1)
      }
    } else {
      const keys = Object.keys(item)
      if (!hasExactDataKeys(item, keys)) fail('unsupported-encoding')
      for (const key of keys) size += stringBytes(key) + visit(item[key], depth + 1)
    }
    seen.delete(item)
    return size
  }
  if (typeof path !== 'string') fail('unsupported-encoding')
  return 1024 + stringBytes(path) + visit(value, 0)
}
