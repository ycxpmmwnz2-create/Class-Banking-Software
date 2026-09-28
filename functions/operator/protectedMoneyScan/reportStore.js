import { execFile } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { Buffer } from 'node:buffer'
import { LIMITS, fail, hash } from './common.js'

const helper = fileURLToPath(new URL('./reportStore.py', import.meta.url))
// Only reports generated from fictional data are permitted by the Python helper.
// Live storage needs its own reviewed runtime/authority/terminal boundary.
export function createPrivatePublisher(directory) {
  return Object.freeze({ async publish({ runId, contents, digest }) {
    if (typeof contents !== 'string' || Buffer.byteLength(contents) > LIMITS.reportBytes || hash(contents) !== digest) fail('storage')
    return new Promise((resolve, reject) => {
      function refuse() { try { fail('storage') } catch (error) { reject(error) } }
      const child = execFile('/usr/bin/python3', [helper], { timeout: 30000, maxBuffer: 4096,
        env: { PATH: '/usr/bin:/bin', PYTHONIOENCODING: 'utf-8' } }, (error, stdout) => {
        if (error) { refuse();return }
        try { resolve(JSON.parse(stdout)) } catch { refuse() }
      })
      child.stdin.on('error', refuse)
      child.stdin.end(JSON.stringify({ directory, runId, contents, digest }))
    })
  } })
}
