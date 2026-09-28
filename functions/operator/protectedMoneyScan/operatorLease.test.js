import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import test from 'node:test'

test('private operator lease exercises actual filesystem and process lifetime safeguards', () => {
  const output = execFileSync('/usr/bin/python3', [fileURLToPath(new URL('./operatorLease_tests.py', import.meta.url))], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 16384,
    env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.equal(output, '') // Module and test workers must not echo private input.
})
