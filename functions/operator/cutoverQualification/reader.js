import timers from 'node:timers'
import http from 'node:http'
import { Buffer } from 'node:buffer'
import { URLSearchParams } from 'node:url'
import { performance } from 'node:perf_hooks'
import { DEMO_PROJECT, LIMITS, RESERVATION_MASK, DISPATCH_MASK, ROOT_MASK, OWNER_MASK,
  demo, fail, id, digest, exact } from './common.js'

function timestamp(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (!match) fail('transport')
  const millis = Date.parse(match[1] + '.000Z')
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== match[1] + '.000Z') fail('transport')
  return [millis / 1000, Number((match[2] ?? '').padEnd(9, '0'))]
}
function fields(input, budget = { nodes: 0 }, depth = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 12) fail('transport')
  const result = {}
  for (const [key, value] of Object.entries(input)) {
    if (++budget.nodes > 10000 || !value || Object.keys(value).length !== 1) fail('budget')
    let decoded
    if (typeof value.stringValue === 'string') decoded = value.stringValue
    else if (typeof value.booleanValue === 'boolean') decoded = value.booleanValue
    else if (value.nullValue === null) decoded = null
    else if (typeof value.integerValue === 'string' && /^-?(0|[1-9]\d*)$/.test(value.integerValue) && Number.isSafeInteger(Number(value.integerValue))) decoded = Number(value.integerValue)
    else if (value.mapValue && Object.keys(value.mapValue).every(k => k === 'fields')) decoded = fields(value.mapValue.fields ?? {}, budget, depth + 1)
    else fail('transport') // Metadata only: unsupported values cannot be coerced.
    Object.defineProperty(result, key, { value: decoded, enumerable: true })
  }
  return result
}
function maskFor(profile, path, list) {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 512) fail('scope')
  const parts = path.split('/')
  if (profile === 'inventory') {
    if (list && path === 'classrooms') return ['__name__']
    if (!list && parts.length === 2 && id(parts[1])) {
      if (parts[0] === 'classrooms') return ROOT_MASK
      if (parts[0] === 'teachers') return OWNER_MASK
    }
  }
  if (profile === 'provider-claims' && list) {
    if (path === 'insightUsageReservations') return RESERVATION_MASK
    if (parts.length === 3 && parts[0] === 'insightUsageReservations' && digest(parts[1]) && parts[2] === 'dispatches') return DISPATCH_MASK
  }
  fail('scope')
}
export function createQualificationReader(input) {
  demo(input.projectId) // Refuse before any client, credential or transport construction.
  if (!exact(input, ['projectId', 'profile'])) fail('scope')
  const { projectId, profile } = input
  if (!['inventory', 'provider-claims'].includes(profile)) fail('scope')
  const prefix = `projects/${DEMO_PROJECT}/databases/(default)/documents/`
  const started = performance.now(); let wireBytes = 0
  function request(path, mask, token, list) {
    if (performance.now() - started >= LIMITS.durationMs) fail('expired')
    const query = new URLSearchParams()
    for (const key of mask) query.append('mask.fieldPaths', key)
    if (list) { query.set('showMissing', 'true'); query.set('pageSize', String(LIMITS.page)); query.set('pageToken', token) }
    const target = '/v1/' + prefix + path.split('/').map(encodeURIComponent).join('/') + '?' + query.toString()
    return new Promise((resolve, reject) => {
      let bytes = 0, ended = false; const chunks = []
      const refuse = category => { try { fail(category) } catch (error) { reject(error) } }
      const req = http.get({ hostname: '127.0.0.1', port: 8080, agent: false, path: target,
        headers: { accept: 'application/json', authorization: 'Bearer owner' } }, response => {
        response.on('data', chunk => {
          bytes += chunk.length; wireBytes += chunk.length
          if (bytes > LIMITS.responseBytes || wireBytes > LIMITS.wireBytes) { refuse('budget'); req.destroy(); return }
          chunks.push(chunk)
        })
        response.on('error', () => refuse('transport'))
        response.on('aborted', () => refuse('transport'))
        response.on('end', () => {
          ended = true
          if (response.statusCode === 404 && !list) { resolve(null); return }
          if (response.statusCode !== 200) { refuse('transport'); return }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { refuse('transport') }
        })
      })
      const timer = timers.setTimeout(() => { refuse('expired'); req.destroy() }, Math.min(10000, LIMITS.durationMs - (performance.now() - started)))
      req.once('close', () => { timers.clearTimeout(timer); if (!ended) refuse('transport') })
      req.on('error', () => refuse('transport'))
    })
  }
  function document(raw, path, mask, list) {
    if (!raw || typeof raw.name !== 'string' || !raw.name.startsWith(prefix) || Buffer.byteLength(raw.name) > 512 + prefix.length) fail('scope')
    const relative = raw.name.slice(prefix.length)
    if (list ? !relative.startsWith(path + '/') || relative.slice(path.length + 1).includes('/') : relative !== path) fail('scope')
    if (!relative.slice(path.length + 1) && list) fail('scope')
    if (!raw.createTime && !raw.updateTime) {
      if (Object.keys(raw.fields ?? {}).length) fail('transport')
      return { path: relative, exists: false, createVersion: null, updateVersion: null, data: null }
    }
    if (Object.keys(raw.fields ?? {}).some(key => !mask.includes(key))) fail('transport')
    const data = fields(raw.fields ?? {})
    return { path: relative, exists: true, createVersion: timestamp(raw.createTime), updateVersion: timestamp(raw.updateTime), data }
  }
  return Object.freeze({ kind: 'cutover-loopback-reader', projectId, databaseId: '(default)', profile,
    async listPage(path, token = '') {
      const mask = maskFor(profile, path, true)
      if (typeof token !== 'string' || token.length > 4096) fail('scope')
      const raw = await request(path, mask, token, true)
      if (!raw || !Array.isArray(raw.documents ?? []) || (raw.documents?.length ?? 0) > LIMITS.page ||
          typeof (raw.nextPageToken ?? '') !== 'string' || (raw.nextPageToken?.length ?? 0) > 4096) fail('transport')
      return { documents: (raw.documents ?? []).map(doc => document(doc, path, mask, true)), nextPageToken: raw.nextPageToken ?? '' }
    },
    async get(path) {
      const mask = maskFor(profile, path, false), raw = await request(path, mask, '', false)
      return raw === null ? { path, exists: false, createVersion: null, updateVersion: null, data: null } : document(raw, path, mask, false)
    },
  })
}
