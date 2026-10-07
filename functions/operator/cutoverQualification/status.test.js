import { URL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
const entry = new URL('./status.js', import.meta.url)
test('public status command is static NO-GO and accepts no operation or identity arguments', () => {
  const plain = spawnSync(process.execPath, [entry.pathname], { encoding: 'utf8', env: {} })
  assert.equal(plain.status, 0); assert.equal(plain.stderr, '')
  const status = JSON.parse(plain.stdout)
  assert.equal(status.decision, 'NO-GO'); assert.equal(status.productionEligible, false)
  assert.ok(status.capabilities.every(row => row.status === 'UNVERIFIED'))
  const refused = spawnSync(process.execPath, [entry.pathname, 'PRIVATE ARGUMENT'], { encoding: 'utf8', env: {} })
  assert.equal(refused.status, 2); assert.equal(refused.stdout, '')
  assert.equal(refused.stderr, 'Qualification status accepts no arguments.\n')
})
