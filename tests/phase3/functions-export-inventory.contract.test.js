import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertExportPolicyInventory } from './functionsExportInventory.js'

const source = readFileSync(new URL('../../functions/index.js', import.meta.url), 'utf8')
const policy = readFileSync(new URL('../../TEACHER_MONEY_ACCESS_SURFACE.md', import.meta.url), 'utf8')
const check = (code = source, markdown = policy) => assertExportPolicyInventory(code, markdown)

test('source contract: all 18 invocation and ten configuration exports have an exact classification', () => {
  assert.equal(check().size, 28)
})

test('source contract: added, removed, renamed, and changed-type invocation exports fail', () => {
  for (const code of [
    source + '\nexport const extraRoute = onCall(() => {});',
    source + '\nexport const planTeacherMoneyV2 = onCall(() => {});',
    source.replace('export const listStudentPinsV2 =', 'const listStudentPinsV2 ='),
    source.replace('export const listStudentPinsV2 =', 'export const renamed ='),
    source.replace('export const listStudentPinsV2 = onCall', 'export const listStudentPinsV2 = onDocumentWritten'),
    source.replace('export const GEMINI_API_KEY = defineSecret', 'export const GEMINI_API_KEY = onCall'),
    source.replace('export const MULTI_TEACHER_V2_MAINTENANCE_MODE =', 'const MULTI_TEACHER_V2_MAINTENANCE_MODE ='),
    source.replace("defineString('MULTI_TEACHER_V2_MAINTENANCE_MODE'", "defineBoolean('MULTI_TEACHER_V2_MAINTENANCE_MODE'"),
  ]) assert.throws(() => check(code))
})

test('source contract: unsupported exports and factories cannot disappear from inventory', () => {
  for (const addition of [
    'export default onCall(() => {});',
    'export { hiddenRoute } from "./hidden.js";',
    'export * from "./hidden.js";',
    'const hidden = onCall(() => {}); export { hidden };',
    'export const hidden = wrapper(onCall(() => {}));',
    'export const hidden = unknownFactory(() => {});',
    'export const hidden = namespace.onCall(() => {});',
    'export const { hidden } = object;',
    'export function hidden() {}',
    'export let hidden = onCall(() => {});',
    'export const hidden = "unclassified";',
    'export const listStudentPinsV2 = onCall(() => {});',
  ]) assert.throws(() => check(source + '\n' + addition), addition)
  assert.throws(() => check(source.replace('firebase-functions/v2/https', 'untrusted-module')))
})

test('source contract: named import aliases are resolved; comments and strings are not exports', () => {
  check(source.replace('{ HttpsError, onCall }', '{ HttpsError, onCall as callable }')
    .replaceAll('= onCall(', '= callable('))
  check(source + '\n// export const fake = onCall(() => {});\n' +
    'const text = "export default hidden()";\n' +
    '/* export const other = onDocumentWritten(() => {}); */')
})

test('source contract: missing, extra, duplicate, and empty policy rows fail in both policy sections', () => {
  for (const name of ['listStudentPinsV2', 'planTeacherMoneyV2', 'getClassroomAccessV2']) {
    const row = policy.split('\n').find(line => line.startsWith(`| \`${name}\` |`))
    assert.ok(row)
    for (const markdown of [
      policy.replace(row, ''),
      policy.replace(row, row + '\n' + row),
      policy.replace(row, row + '\n' + row.replace(name, 'unknownRoute')),
      policy.replace(row, row.replace(/\| [^|]+ \|$/, '|  |')),
    ]) assert.throws(() => check(source, markdown))
  }
})
