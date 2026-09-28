import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, chmod, stat, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { createPrivatePublisher } from './reportStore.js'
import { makeFixture } from './fixtures.js'
import { runProtectedMoneyScan } from './runner.js'
import { hash, DEMO_PROJECT } from './common.js'

async function directory(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fictional-protected-report-')))
  await chmod(dir, 0o700);t.after(() => rm(dir, { recursive: true, force: true }));return dir
}
function payload(runId = 'fictional-run', extra = {}) {
  const contents = JSON.stringify({ kind: 'protected-money-scan-rehearsal-result', projectId: DEMO_PROJECT,
    runId, activationAllowed: false, initializationAllowed: false, artifactAccepted: false, productionEligible: false, ...extra })
  return { runId, contents, digest: hash(contents) }
}
test('real runner publishes a private exclusive report with matching digest and no raw names', async t => {
  const dir = await directory(t), f = makeFixture()
  f.dependencies.publisher = createPrivatePublisher(dir)
  const result = await runProtectedMoneyScan(f.plan, f.dependencies)
  assert.equal(result.status, 'complete')
  const run = join(dir, f.plan.runId), path = join(run, 'report.json')
  assert.equal((await stat(run)).mode & 0o777, 0o700)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const contents = await readFile(path, 'utf8')
  assert.equal(contents.includes('FICTIONAL_PRIVATE'), false)
  assert.deepEqual(JSON.parse(contents).summary, result)
  assert.deepEqual(await readdir(run), ['report.json'])
  const retry = await runProtectedMoneyScan(f.plan, f.dependencies)
  assert.equal(retry.category, 'storage'); assert.equal(retry.publication, 'unconfirmed')
  assert.equal(await readFile(path, 'utf8'), contents)
})
test('permissions, symlink ancestors, bad digests and live-tagged reports refuse safely', async t => {
  const dir = await directory(t), outside = await directory(t)
  await chmod(dir, 0o755)
  await assert.rejects(createPrivatePublisher(dir).publish(payload()), e => e.category === 'storage')
  assert.deepEqual(await readdir(dir), [])
  await chmod(dir, 0o700)
  await symlink(dir, join(outside, 'redirect'))
  await assert.rejects(createPrivatePublisher(join(outside, 'redirect')).publish(payload()), e => e.category === 'storage')
  await assert.rejects(createPrivatePublisher(dir).publish({ ...payload(), digest: '0'.repeat(64) }), e => e.category === 'storage')
  await assert.rejects(createPrivatePublisher(dir).publish(payload('fictional-run', { projectId: 'morgan-bank' })), e => e.category === 'storage')
  assert.deepEqual(await readdir(dir), [])
})
test('concurrent publication never overwrites the same run', async t => {
  const dir = await directory(t), pub = createPrivatePublisher(dir), value = payload()
  const results = await Promise.allSettled([pub.publish(value), pub.publish(value)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(await readFile(join(dir, value.runId, 'report.json'), 'utf8'), value.contents)
})
test('Python filesystem fault injection covers short writes, disk full, sync, readback, links and held-directory rename', () => {
  const output = execFileSync('/usr/bin/python3', [fileURLToPath(new URL('./reportStore_faults.py', import.meta.url))],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } })
  assert.match(output, /8 storage fault cases passed/)
})
