import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { parseModule } from './functionsExportInventory.js'

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const index = read('functions/index.js')
const preflight = read('functions/phase3/productionPreflight.js')
const plans = ['AI_INSIGHTS_STRUCTURED_PRODUCTION_PLAN.md', 'AI_INSIGHTS_STRUCTURED_STAGING_PLAN.md'].map(read)
const historicalDeployMarker = '# Historical — do not run on maintenance-aware source; see Maintenance-aware redeployment prerequisite above.'
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const [key, child] of Object.entries(node)) {
    if (['parent', 'loc', 'range', 'tokens', 'comments'].includes(key)) continue
    if (Array.isArray(child)) child.forEach(value => walk(value, visit))
    else if (child && typeof child === 'object') walk(child, visit)
  }
}
function check(code = index, reader = preflight, documents = plans) {
  const program = parseModule(code)
  const release = program.body.filter(node => node.type === 'ExportNamedDeclaration')
    .flatMap(node => node.declaration?.declarations ?? [])
    .find(node => node.id.name === 'REVIEWED_V2_FUNCTIONS_RELEASE_ID')
  assert.equal(release?.init?.type, 'Literal', 'reviewed release ID must remain an explicit source literal')
  assert.equal(typeof release.init.value, 'string')
  assert.ok(release.init.value.length > 0)
  const expectedBindings = ['production', 'staging'].map(tier => ({
    MULTI_TEACHER_V2_ENABLED: 'true',
    MULTI_TEACHER_V2_RELEASE_ID: release.init.value,
    MULTI_TEACHER_V2_MAINTENANCE_MODE: 'normal',
    MORGAN_BANK_DEPLOYMENT_TIER: tier,
    MORGAN_BANK_STAGING_PROJECT_ID: tier === 'production' ? '' : 'morgan-bank-staging',
  }))
  const guard = program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'assertV2Invocation')
  const required = new Set(['MULTI_TEACHER_V2_RELEASE_ID']) // read by the real environment guard
  walk(guard, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.property.name === 'value' && node.callee.object.type === 'Identifier') required.add(node.callee.object.name)
  })
  assert.ok(required.has('MULTI_TEACHER_V2_MAINTENANCE_MODE'))
  const inventory = parseModule(reader).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'readFunctionsInventory')
  const enumerations = []
  walk(inventory, node => {
    if (node.type === 'ArrayExpression' && node.elements.some(item => item?.value === 'MULTI_TEACHER_V2_ENABLED')) {
      enumerations.push(node.elements.map(item => item.value))
    }
  })
  assert.equal(enumerations.length, 2, 'collection and summary gate lists must both be explicit')
  for (const names of enumerations) assert.deepEqual(names.sort(), [...required].sort())
  assert.equal(documents.length, expectedBindings.length)
  for (const [i, document] of documents.entries()) {
    const section = document.split('## Maintenance-aware redeployment prerequisite')[1]?.split('\n## ')[0]
    assert.ok(section, 'prospective prerequisite must be separate from historical metadata')
    assert.deepEqual(Object.keys(expectedBindings[i]).sort(), [...required].sort())
    const bindings = [...section.matchAll(/^\| `([^`]+)` \| `([^`]*)` \|$/gm)]
      .map(([, name, value]) => [name, value])
    assert.equal(bindings.length, required.size, 'exactly one binding per required parameter')
    assert.deepEqual(Object.fromEntries(bindings), expectedBindings[i], 'exact target-specific bindings must match reviewed source')
    for (const phrase of ['post-deploy', 'revision', 'Stop', 'authorization']) assert.ok(section.includes(phrase))
    const lines = document.split('\n').map(line => line.trim()).filter(Boolean)
    const commands = lines.flatMap((line, lineIndex) => /\bfirebase\s+deploy\b.*\bfunctions:/.test(line) ? [lineIndex] : [])
    assert.ok(commands.length > 0, 'historical Functions command must remain visible')
    for (const lineIndex of commands) {
      assert.equal(lines[lineIndex - 1], historicalDeployMarker, 'each historical Functions deploy needs its own adjacent warning')
    }
  }
}
test('every shared admission parameter is explicitly bound in both prospective plans and both preflight lists', () => check())
test('contract detects missing bindings, missing enumeration and a new unplanned guard parameter', () => {
  for (const i of [0, 1]) {
    const docs = [...plans]
    docs[i] = docs[i].replace(/^\| `MULTI_TEACHER_V2_MAINTENANCE_MODE`.*\n/m, '')
    assert.throws(() => check(index, preflight, docs))
  }
  assert.throws(() => check(index, preflight.replace("'MULTI_TEACHER_V2_MAINTENANCE_MODE',", '')))
  assert.throws(() => check(index.replace('function assertV2Invocation(operation) {',
    'function assertV2Invocation(operation) { FUTURE_GATE.value();')))
})

for (const [i, target] of ['production', 'staging'].entries()) {
  for (const parameter of ['MULTI_TEACHER_V2_ENABLED', 'MULTI_TEACHER_V2_RELEASE_ID',
    'MULTI_TEACHER_V2_MAINTENANCE_MODE', 'MORGAN_BANK_DEPLOYMENT_TIER', 'MORGAN_BANK_STAGING_PROJECT_ID']) {
    test(`${target} contract rejects an incorrect ${parameter} binding`, () => {
      check() // Prove the unchanged fixture passes before testing its mutation.
      const docs = [...plans]
      const wrongValue = parameter === 'MORGAN_BANK_DEPLOYMENT_TIER'
        ? (target === 'production' ? 'staging' : 'production') : 'stale-or-invalid'
      docs[i] = docs[i].replace(new RegExp(`^(\\| \\x60${parameter}\\x60 \\| )\\x60[^\\x60]*\\x60`, 'm'), `$1\`${wrongValue}\``)
      assert.notEqual(docs[i], plans[i])
      assert.throws(() => check(index, preflight, docs), /exact target-specific bindings/)
    })
  }
  test(`${target} contract rejects missing, detached and missing second-command warnings`, () => {
    check()
    for (const replacement of ['', `${historicalDeployMarker}\n# Unrelated intervening instruction`]) {
      const docs = [...plans]
      docs[i] = docs[i].replace(historicalDeployMarker, replacement)
      assert.notEqual(docs[i], plans[i])
      assert.throws(() => check(index, preflight, docs), /adjacent warning/)
    }
    const docs = [...plans]
    const command = plans[i].split('\n').find(line => /\bfirebase\s+deploy\b.*\bfunctions:/.test(line))
    docs[i] += `\n\nAnother historical command:\n${command}\n`
    assert.throws(() => check(index, preflight, docs), /adjacent warning/)
  })
}

test('release binding follows the reviewed source constant and rejects stale plan values', () => {
  check()
  const changed = index.replace(/(export const REVIEWED_V2_FUNCTIONS_RELEASE_ID = )'[^']*'/,
    "$1'future-reviewed-release'")
  assert.notEqual(changed, index)
  assert.throws(() => check(changed), /exact target-specific bindings/)
  const docs = plans.map(document => document.replace(/^(\| `MULTI_TEACHER_V2_RELEASE_ID` \| )`[^`]*`/m,
    '$1`future-reviewed-release`'))
  check(changed, preflight, docs)
})

function checkHistoricalProcedure(document = plans[0]) {
  const procedure = document.match(/^## ([^\n]*execution sequence[^\n]*)\n\n([^#]*?)\n1\. /m)
  assert.ok(procedure, 'production procedure must have a local heading and preface before step 1')
  assert.match(procedure[1], /^Historical /, 'whole production procedure must be labelled historical')
  assert.match(procedure[2], /original artifact only/, 'procedure must retain original-artifact scope')
  assert.match(procedure[2], /superseded by the prerequisite above/, 'procedure must retain supersession notice')
  assert.match(procedure[2], /grants no current merge, deployment, or mode-selection authority/, 'procedure must deny current authority')
  const section = document.slice(procedure.index).split(/\n(?=#{1,6} )/)[0]
  assert.deepEqual([...section.matchAll(/^([1-6])\. /gm)].map(match => match[1]),
    ['1', '2', '3', '4', '5', '6'], 'all six steps must remain under the historical heading')
}

test('whole production procedure labels historical scope and superseded authority before step 1', () => checkHistoricalProcedure())
test('production procedure contract rejects removed historical label or local authority disclaimer', () => {
  checkHistoricalProcedure()
  const procedureStart = plans[0].indexOf('## Historical execution sequence')
  assert.ok(procedureStart >= 0)
  for (const [text, replacement, failure] of [
    ['Historical execution sequence', 'Current execution sequence', /whole production procedure must be labelled historical/],
    ['original artifact only', 'removed', /procedure must retain original-artifact scope/],
    ['superseded by the prerequisite above', 'removed', /procedure must retain supersession notice/],
    ['grants no current merge, deployment, or mode-selection authority', 'removed', /procedure must deny current authority/],
    ['\n4. Only after callable verification', '\n## Current hosting procedure\n\n4. Only after callable verification', /all six steps must remain under the historical heading/],
  ]) {
    const changed = plans[0].slice(0, procedureStart) +
      plans[0].slice(procedureStart).replace(text, replacement)
    assert.notEqual(changed, plans[0])
    assert.throws(() => checkHistoricalProcedure(changed), failure)
  }
})

const historicalApprovalNotice = `**Historical context — original artifact only.**
All approval statements recorded in this document apply only to their original
artifacts. They grant no current authority to commit, push, merge, deploy, create
a parameter artifact, or select a maintenance mode.`

function checkApprovalScope(document) {
  const opening = document.split('\n').slice(1).join('\n').trimStart().split('\n## ')[0]
  assert.ok(opening.startsWith(`${historicalApprovalNotice}\n\n`),
    'historical approval notice must precede the original opening text')
  const prerequisite = document.split('## Maintenance-aware redeployment prerequisite')[1]?.split('\n## ')[0]
  assert.ok(prerequisite?.replace(/\s+/g, ' ').includes(
    "Historical metadata and approvals throughout this document describe their original artifacts, not this tree's current configuration or authorization."),
  'prerequisite must scope historical approvals throughout this document')
}

for (const [i, target] of ['production', 'staging'].entries()) {
  test(`${target} historical approvals cover opening and whole document`, () => checkApprovalScope(plans[i]))
  test(`${target} approval scope rejects absent, late, weakened or below-only notices`, () => {
    checkApprovalScope(plans[i])
    for (const [changed, failure] of [
      [plans[i].replace(`${historicalApprovalNotice}\n\n`, ''), /notice must precede/],
      [plans[i].replace(`${historicalApprovalNotice}\n\n`, '') + `\n${historicalApprovalNotice}\n`, /notice must precede/],
      [plans[i].replace('They grant no current authority', 'They grant current authority'), /notice must precede/],
      [plans[i].replace('approvals throughout this document', 'approvals below'), /prerequisite must scope/],
    ]) {
      assert.notEqual(changed, plans[i])
      assert.throws(() => checkApprovalScope(changed), failure)
    }
  })
}
