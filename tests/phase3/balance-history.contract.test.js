import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Static wiring evidence, not a claim about deployed trigger delivery.
const source = readFileSync(new URL('../../functions/index.js', import.meta.url), 'utf8')
test('balance-history trigger is scoped, retryable, and guarded before any Firestore handle', () => {
  const start = source.indexOf('export const recordStudentBalanceHistoryV3 = onDocumentWritten(')
  assert(start >= 0)
  const body = source.slice(start)
  assert.match(body, /document: 'classrooms\/\{classroomId\}\/students\/\{studentId\}'/u)
  assert.match(body, /retry: true/u)
  const off = body.indexOf('if (!MULTI_TEACHER_V2_ENABLED.value()) return')
  const guard = body.indexOf("assertV2Invocation('recordStudentBalanceHistoryV3')")
  const module = body.indexOf("await import('./insights/balanceHistoryLedger.js')")
  const db = body.indexOf('getFirestore()')
  assert(off >= 0 && guard > off && module > guard && db > module)
  assert.match(body, /recordBalanceWitness\(event, \{ firestore: getFirestore\(\) \}\)/u)
})
