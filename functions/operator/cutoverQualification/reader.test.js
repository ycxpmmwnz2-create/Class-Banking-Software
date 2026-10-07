import { Buffer } from 'node:buffer'
import { URL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createQualificationReader } from './reader.js'
import { DEMO_PROJECT as projectId, LIMITS } from './common.js'

const name = `projects/${projectId}/databases/(default)/documents/teachers/owner`
const rawDoc = { name, createTime: '2026-10-01T00:00:00.000000001Z', updateTime: '2026-10-01T00:00:00.123456789Z',
  fields: { uid: { stringValue: 'owner' }, classroomId: { stringValue: 'room' }, status: { stringValue: 'active' } } }
function transport(t, body, statusCode = 200) {
  const calls = [], requests = []
  t.mock.method(http, 'get', (options, callback) => {
    calls.push(options)
    const request = new EventEmitter(); requests.push(request)
    request.destroy = () => { request.emit('close') }
    if (body !== undefined) Promise.resolve().then(() => {
      const response = new EventEmitter(); response.statusCode = statusCode; callback(response)
      response.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      response.emit('end'); request.emit('close')
    })
    return request
  })
  return { calls, requests }
}

test('transport is fixed loopback GET with explicit masks; nanoseconds are preserved', async t => {
  const f = transport(t, rawDoc), reader = createQualificationReader({ projectId, profile: 'inventory' })
  assert.throws(() => createQualificationReader({ projectId, profile: 'inventory', endpoint: 'https://untrusted.invalid' }), { category: 'scope' })
  const doc = await reader.get('teachers/owner')
  assert.deepEqual(doc.updateVersion, [1790812800, 123456789]); assert.equal(doc.data.uid, 'owner')
  const options = f.calls[0]
  assert.equal(options.hostname, '127.0.0.1'); assert.equal(options.port, 8080)
  assert.equal(options.headers.authorization, 'Bearer owner') // Public emulator convention, not a token.
  assert.deepEqual(new URL('http://localhost' + options.path).searchParams.getAll('mask.fieldPaths').sort(), ['classroomId', 'status', 'uid'])
})

test('showMissing uses bounded pages and omits forbidden orderBy; list response cannot escape collection', async t => {
  const f = transport(t, { documents: [], nextPageToken: '' }), reader = createQualificationReader({ projectId, profile: 'provider-claims' })
  await reader.listPage('insightUsageReservations')
  const query = new URL('http://localhost' + f.calls[0].path).searchParams
  assert.equal(query.get('showMissing'), 'true'); assert.equal(query.get('pageSize'), '25'); assert.equal(query.has('orderBy'), false)
  assert.equal(query.getAll('mask.fieldPaths').includes('result'), false)
})

test('redirect, malformed JSON, foreign document and unmasked fields fail with fixed diagnostics', async t => {
  for (const [body, status] of [['PRIVATE REDIRECT', 302], ['PRIVATE MALFORMED JSON', 200],
    [{ ...rawDoc, name: name.replace('teachers/owner', 'teachers/foreign') }, 200],
    [{ ...rawDoc, fields: { ...rawDoc.fields, result: { stringValue: 'PRIVATE ANSWER' } } }, 200]]) {
    t.mock.restoreAll(); const f = transport(t, body, status)
    const reader = createQualificationReader({ projectId, profile: 'inventory' })
    await assert.rejects(reader.get('teachers/owner'), error => error.message === 'Cutover qualification unavailable.' && !String(error.stack).includes('PRIVATE'))
    assert.equal(f.calls.length, 1)
  }
})

test('oversized response stops before JSON parsing or record publication', async t => {
  transport(t, 'x'.repeat(LIMITS.responseBytes + 1))
  await assert.rejects(createQualificationReader({ projectId, profile: 'inventory' }).get('teachers/owner'), { category: 'budget' })
})

test('absolute transport timeout destroys request and cannot return a successful prefix', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = transport(t, undefined), promise = createQualificationReader({ projectId, profile: 'inventory' }).get('teachers/owner')
  let closed = false; f.requests[0].once('close', () => { closed = true })
  const rejection = assert.rejects(promise, { category: 'expired' })
  t.mock.timers.tick(10001); await rejection; assert.equal(closed, true)
})

test('real target refusal occurs before profile getter and all transport access', t => {
  const f = transport(t, rawDoc)
  assert.throws(() => createQualificationReader({ projectId: 'morgan-bank', get profile() { throw Error('PRIVATE') } }), { category: 'live-unavailable' })
  assert.equal(f.calls.length, 0)
})


test('premature socket close rejects rather than leaving a pending read', async t => {
  const f = transport(t, undefined)
  const pending = createQualificationReader({ projectId, profile: 'inventory' }).get('teachers/owner')
  const refusal = assert.rejects(pending, { category: 'transport' })
  f.requests[0].emit('close'); await refusal
})
