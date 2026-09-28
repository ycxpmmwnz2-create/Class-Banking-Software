import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { syncBuiltinESMExports } from 'node:module'
import { createLoopbackReader } from './loopbackReader.js'
import { makeFixture } from './fixtures.js'
import { LIMITS } from './common.js'

function response(t, status, body, capture = () => {}) {
  t.mock.method(http, 'get', (options, callback) => {
    capture(options)
    const req = new EventEmitter()
    req.destroy = () => req.emit('close')
    req.setTimeout = () => req
    Promise.resolve().then(() => {
      const res = new EventEmitter();res.statusCode = status;callback(res)
      res.emit('data', typeof body === 'string' ? Buffer.from(body) : body)
      res.emit('end');req.emit('close')
    })
    return req
  })
}
for (const timeout of ['absolute', 'inactivity']) test(`nonresponding request aborts on ${timeout} timeout`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // The reader imports named node:timers exports; bind them to the mock clock.
  syncBuiltinESMExports()
  t.after(() => { t.mock.timers.reset();syncBuiltinESMExports() })
  let destroyed = 0, inactivity
  t.mock.method(http, 'get', () => {
    const req = new EventEmitter()
    req.destroy = () => { destroyed++;req.emit('close') }
    req.setTimeout = (ms, callback) => { assert.equal(ms, 10000);inactivity = callback;return req }
    return req // Never opens a connection or emits a response.
  })
  const pending = createLoopbackReader(makeFixture().plan).listPage('classrooms', '')
  const rejected = assert.rejects(pending, error => error.category === 'expired')
  t.mock.timers.tick(9999)
  assert.equal(destroyed, 0)
  if (timeout === 'absolute') t.mock.timers.tick(1)
  else inactivity()
  await rejected
  assert.equal(destroyed, 1)
  t.mock.timers.tick(10000)
  assert.equal(destroyed, 1, 'close must clear the other request timer')
})
test('transport fixes GET destination and metadata mask; redirects/errors never return remote diagnostics', async t => {
  response(t, 302, 'FICTIONAL_PRIVATE_ERROR', options => {
    assert.equal(options.hostname, '127.0.0.1');assert.equal(options.port, 8080)
    assert.ok(options.path.startsWith('/v1/projects/demo-morgan-bank-protected-scan/databases/(default)/documents/'))
    assert.match(options.path, /mask.fieldPaths=__name__/)
    assert.equal(options.headers.authorization, 'Bearer owner') // fixed emulator literal
  })
  await assert.rejects(createLoopbackReader(makeFixture().plan).listPage('classrooms', ''), e => e.category === 'transport' && !e.message.includes('PRIVATE'))
})
test('wire byte limit rejects oversized response before JSON parsing', async t => {
  response(t, 200, Buffer.alloc(LIMITS.responseBytes + 1))
  await assert.rejects(createLoopbackReader(makeFixture().plan).listPage('classrooms', ''), e => e.category === 'budget')
})
test('unparseable body, unsupported Firestore values, and foreign document names are rejected', async t => {
  const path = 'classrooms/canary'
  for (const raw of ['{bad', JSON.stringify({ name: 'foreign' }), JSON.stringify({
    name: 'projects/demo-morgan-bank-protected-scan/databases/(default)/documents/' + path,
    createTime: '2026-09-27T00:00:00Z', updateTime: '2026-09-27T00:00:00Z', fields: { location: { geoPointValue: { latitude: 0, longitude: 0 } } },
  })]) {
    response(t, 200, raw)
    await assert.rejects(createLoopbackReader(makeFixture().plan).get(path, null), e => ['transport', 'scope'].includes(e.category))
    t.mock.restoreAll()
  }
})

test('malformed map/array/integer wire values never become empty defaults', async t => {
  for (const value of [{ mapValue: 'bad' }, { mapValue: { fields: null } }, { arrayValue: 'bad' },
    { arrayValue: { values: null } }, { integerValue: 1 }]) {
    response(t, 200, JSON.stringify({
      name: 'projects/demo-morgan-bank-protected-scan/databases/(default)/documents/classrooms/canary',
      createTime: '2026-09-27T00:00:00Z', updateTime: '2026-09-27T00:00:00Z', fields: { settings: value },
    }))
    await assert.rejects(createLoopbackReader(makeFixture().plan).get('classrooms/canary', null), e => e.category === 'transport')
    t.mock.restoreAll()
  }
})
