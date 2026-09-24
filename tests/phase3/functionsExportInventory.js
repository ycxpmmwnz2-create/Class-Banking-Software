import assert from 'node:assert/strict'
import { Linter } from 'eslint'

// Deliberately explicit: adding a planned policy row does not activate a route.
const baselineCallables = [
  'studentPinLogin', 'resetStudentPin', 'ensureTeacherClassroom',
  'resolveTeacherTenantV2', 'onboardTeacherClassroomV2',
  'createTeacherInvitationV2', 'revokeTeacherInvitationV2',
  'studentPinLoginV2', 'resetStudentPinV2', 'createStudentV2', 'removeStudentV2',
  'listStudentPinsV2', 'submitStudentTransactionV2', 'analyzeTeacherInsightsV3',
]
const baselineTriggers = [
  'syncStudentProfiles', 'syncStudentProfilesV2', 'recordStudentBalanceHistoryV3',
]
const planned = [
  'planTeacherMoneyV2', 'executeTeacherMoneyV2', 'getTeacherMoneyStatusV2',
  'acknowledgeTeacherMoneyV2', 'cancelTeacherMoneyV2', 'editStudentProfileV2',
]
const configuration = {
  MULTI_TEACHER_V2_ENABLED: 'defineBoolean',
  MULTI_TEACHER_V2_MAINTENANCE_MODE: 'defineString',
  MULTI_TEACHER_V2_RELEASE_ID: 'defineString',
  MORGAN_BANK_DEPLOYMENT_TIER: 'defineString',
  MORGAN_BANK_STAGING_PROJECT_ID: 'defineString',
  VERSION3_GEMINI_ENABLED: 'defineBoolean',
  VERSION3_GEMINI_RELEASE_ID: 'defineString',
  VERSION3_GEMINI_TOOL_ASSISTANT_ENABLED: 'defineBoolean',
  GEMINI_API_KEY: 'defineSecret',
  REVIEWED_V2_FUNCTIONS_RELEASE_ID: 'literal',
}
const factoryModules = {
  onCall: 'firebase-functions/v2/https',
  onDocumentWritten: 'firebase-functions/v2/firestore',
  defineBoolean: 'firebase-functions/params',
  defineString: 'firebase-functions/params',
  defineSecret: 'firebase-functions/params',
}

// Parse without importing Functions, initializing Admin, or reading runtime config.
export function parseModule(source) {
  let program
  const messages = new Linter().verify(source, [{
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { inventory: { rules: { capture: {
      create: () => ({ Program(node) { program = node } }),
    } } } },
    rules: { 'inventory/capture': 'error' },
  }])
  assert.equal(messages.length, 0, 'Functions source must parse without errors')
  assert.ok(program, 'Functions program must be captured')
  return program
}

export function extractExports(source) {
  const program = parseModule(source)
  const factories = new Map()
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration') continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier' &&
          factoryModules[specifier.imported.name] === node.source.value) {
        factories.set(specifier.local.name, specifier.imported.name)
      }
    }
  }
  const exports = new Map()
  for (const node of program.body) {
    if (!node.type.startsWith('Export')) continue
    assert.ok(node.type === 'ExportNamedDeclaration' && !node.source &&
      node.specifiers.length === 0 && node.declaration?.type === 'VariableDeclaration' &&
      node.declaration.kind === 'const', 'Unsupported export form; classify it explicitly')
    for (const declaration of node.declaration.declarations) {
      assert.equal(declaration.id.type, 'Identifier', 'Unsupported export binding')
      const name = declaration.id.name
      assert.ok(!exports.has(name), `Duplicate export: ${name}`)
      const init = declaration.init
      let factory
      if (init?.type === 'Literal' && typeof init.value === 'string') factory = 'literal'
      else if (init?.type === 'CallExpression' && init.callee.type === 'Identifier') {
        factory = factories.get(init.callee.name)
      }
      assert.ok(factory, `Unsupported export factory: ${name}`)
      exports.set(name, factory)
    }
  }
  return exports
}

function policyRows(markdown, heading, columns) {
  const sections = markdown.split(`## ${heading}\n`)
  assert.equal(sections.length, 2, `Exactly one ${heading} section required`)
  const lines = sections[1].split('\n## ')[0].split('\n').filter(line => line.startsWith('|'))
  assert.ok(lines.length >= 2, `${heading} table required`)
  const rows = new Map()
  for (const line of lines.slice(2)) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    assert.equal(cells.length, columns, `Malformed policy row: ${line}`)
    const name = cells[0].replace(/^`(.*)`$/, '$1')
    assert.ok(!rows.has(name), `Duplicate policy: ${name}`)
    assert.ok(cells.every(Boolean), `Empty policy: ${name}`)
    rows.set(name, cells.slice(1))
  }
  return rows
}

export function assertExportPolicyInventory(source, markdown) {
  const baseline = policyRows(markdown, 'Baseline exports', 3)
  const future = policyRows(markdown, 'New planned surfaces', 2)
  const equalNames = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort())
  equalNames(baseline.keys(), [...baselineCallables, ...baselineTriggers])
  equalNames(future.keys(), [...planned, 'getClassroomAccessV2', 'Local operator CLI'])
  const expected = new Map([
    ...baselineCallables.map(name => [name, 'onCall']),
    ...baselineTriggers.map(name => [name, 'onDocumentWritten']),
    ['getClassroomAccessV2', 'onCall'],
    ...Object.entries(configuration),
  ])
  const actual = extractExports(source)
  equalNames(actual.keys(), expected.keys())
  for (const [name, factory] of expected) assert.equal(actual.get(name), factory, name)
  return actual
}
