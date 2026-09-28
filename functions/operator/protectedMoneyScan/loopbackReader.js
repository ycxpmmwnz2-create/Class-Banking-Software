import http from 'node:http'
import { URLSearchParams } from 'node:url'
import { setTimeout, clearTimeout } from 'node:timers'
import { Buffer } from 'node:buffer'
import { Timestamp } from 'firebase-admin/firestore'
import { DEMO_PROJECT, LIMITS, fail, id, exact, copyData } from './common.js'

function version(text) {
  if (typeof text !== 'string') fail('transport')
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(text)
  if (!match) fail('transport')
  const millis = Date.parse(match[1] + '.000Z')
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== match[1] + '.000Z') fail('transport')
  return [millis / 1000, Number((match[2] ?? '').padEnd(9, '0'))]
}
function decode(value, budget, depth = 0) {
  if (++budget.nodes > 100000 || depth > 32) fail('budget')
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1) fail('transport')
  if (Object.hasOwn(value, 'nullValue')) { if (value.nullValue !== null) fail('transport'); return null }
  if (Object.hasOwn(value, 'booleanValue')) { if (typeof value.booleanValue !== 'boolean') fail('transport');return value.booleanValue }
  if (Object.hasOwn(value, 'stringValue')) { if (typeof value.stringValue !== 'string') fail('transport');return value.stringValue }
  if (Object.hasOwn(value, 'integerValue')) {
    if (typeof value.integerValue !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value.integerValue) || !Number.isSafeInteger(Number(value.integerValue))) fail('transport')
    return Number(value.integerValue)
  }
  if (Object.hasOwn(value, 'doubleValue')) {
    if (typeof value.doubleValue !== 'number' && !['NaN', 'Infinity', '-Infinity'].includes(value.doubleValue)) fail('transport')
    return Number(value.doubleValue)
  }
  if (Object.hasOwn(value, 'timestampValue')) return new Timestamp(...version(value.timestampValue))
  if (Object.hasOwn(value, 'mapValue')) {
    const map = value.mapValue
    if (!map || Object.getPrototypeOf(map) !== Object.prototype || Object.keys(map).some(key => key !== 'fields') ||
        (Object.hasOwn(map, 'fields') && (!map.fields || Object.getPrototypeOf(map.fields) !== Object.prototype))) fail('transport')
    return fields(map.fields ?? {}, budget, depth + 1)
  }
  if (Object.hasOwn(value, 'arrayValue')) {
    const array = value.arrayValue
    if (!array || Object.getPrototypeOf(array) !== Object.prototype || Object.keys(array).some(key => key !== 'values') ||
        (Object.hasOwn(array, 'values') && !Array.isArray(array.values))) fail('transport')
    const entries = array.values ?? []
    if (!Array.isArray(entries)) fail('transport')
    return entries.map(entry => decode(entry, budget, depth + 1))
  }
  fail('transport') // Unsupported Firestore value never coerces into valid money.
}
function fields(raw, budget = { nodes: 0 }, depth = 0) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) fail('transport')
  const result = {}
  for (const [key, value] of Object.entries(raw)) Object.defineProperty(result, key, {
    value: decode(value, budget, depth), enumerable: true,
  })
  return result
}
// Only HTTP GET to a literal loopback endpoint. No SDK/ADC, real credentials, redirects,
// environment discovery, URL override, retries or production construction path.
export function createLoopbackReader({ projectId, rooms }) {
  if (projectId !== DEMO_PROJECT) fail('live-unavailable')
  rooms = copyData(rooms)
  if (!Array.isArray(rooms) || !rooms.length || rooms.length > LIMITS.classrooms ||
      rooms.some(room => !exact(room, ['classroomId', 'ownerUid', 'allowSuspended']) || !id(room.classroomId) || !id(room.ownerUid))) fail('scope')
  const prefix = `projects/${DEMO_PROJECT}/databases/(default)/documents/`
  let wireBytes = 0
  function allowed(path, list) {
    if (list && path === 'classrooms') return true
    return rooms.some(room => list
      ? ['students', 'transactions'].some(name => path === `classrooms/${room.classroomId}/${name}`)
      : path === `classrooms/${room.classroomId}` || path === `teachers/${room.ownerUid}` ||
        path === `classrooms/${room.classroomId}/studentDisplay/rent` || ['students', 'transactions'].some(name => {
          const head = `classrooms/${room.classroomId}/${name}/`;return path.startsWith(head) && id(path.slice(head.length))
        }))
  }
  async function request(path, query) {
    const target = '/v1/' + prefix + path.split('/').map(encodeURIComponent).join('/') + '?' + query.toString()
    return new Promise((resolve, reject) => {
      let bytes = 0;const chunks = []
      const timer = setTimeout(() => { request.destroy();rejectError('expired') }, 10000)
      const request = http.get({ hostname: '127.0.0.1', port: 8080, path: target, agent: false,
        // Emulator-only literal enables showMissing metadata. Never a real token.
        headers: { accept: 'application/json', authorization: 'Bearer owner' } }, response => {
        response.on('data', chunk => {
          bytes += chunk.length;wireBytes += chunk.length
          if (bytes > LIMITS.responseBytes || wireBytes > LIMITS.inputBytes) {
            request.destroy();rejectError('budget');return
          }
          chunks.push(chunk)
        })
        response.on('error', () => rejectError('transport'))
        response.on('end', () => {
          if (response.statusCode === 404) { resolve(null);return }
          if (response.statusCode !== 200) { rejectError('transport');return }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { rejectError('transport') }
        })
      })
      function rejectError(category) { try { fail(category) } catch (error) { reject(error) } }
      request.on('close', () => clearTimeout(timer))
      request.on('error', () => rejectError('transport'))
      request.setTimeout(10000, () => { request.destroy();rejectError('expired') })
    })
  }
  return Object.freeze({ kind: 'loopback-read-only', projectId: DEMO_PROJECT, databaseId: '(default)',
    async listPage(path, pageToken) {
      if (!allowed(path, true) || typeof pageToken !== 'string' || pageToken.length > 4096) fail('scope')
      // showMissing forbids orderBy: accept the service's name order and verify
      // monotonic membership in runner; never use auto-pagination/listDocuments.
      const query = new URLSearchParams({ pageSize: String(LIMITS.pageSize), showMissing: 'true', pageToken })
      query.append('mask.fieldPaths', '__name__')
      const raw = await request(path, query)
      if (!raw || !Array.isArray(raw.documents ?? []) || (raw.documents?.length ?? 0) > LIMITS.pageSize) fail('transport')
      return { documents: (raw.documents ?? []).map(doc => {
        if (typeof doc.name !== 'string' || !doc.name.startsWith(prefix + path + '/')) fail('scope')
        return { path: doc.name.slice(prefix.length), exists: !!doc.createTime && !!doc.updateTime }
      }), nextPageToken: raw.nextPageToken ?? '' }
    },
    async get(path, mask) {
      if (!allowed(path, false) || (mask !== null && (!Array.isArray(mask) || mask.some(x => !['uid', 'status', 'classroomId', 'ownerUid', 'accessControl'].includes(x))))) fail('scope')
      if (path.startsWith('teachers/') && (!Array.isArray(mask) || mask.some(x => !['uid', 'status', 'classroomId'].includes(x)))) fail('scope')
      const query = new URLSearchParams()
      if (mask !== null) for (const field of mask.length ? mask : ['__name__']) query.append('mask.fieldPaths', field)
      const raw = await request(path, query)
      if (raw === null) return { path, exists: false, createVersion: null, updateVersion: null, data: null }
      if (raw.name !== prefix + path) fail('scope')
      return { path, exists: true, createVersion: version(raw.createTime), updateVersion: version(raw.updateTime), data: fields(raw.fields ?? {}) }
    },
  })
}
