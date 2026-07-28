// Phase 3 Item 13 — control-plane inventory SOURCE contract.
//
// EVIDENCE LAYER: static analysis of the implementation boundary and governing
// documents. Behavioral decisions are covered by the colocated unit suites.
// This file performs no network access and proves no production state.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const entrypoint = readFileSync(
  new URL('../../functions/phase3/inventory.js', import.meta.url),
  'utf8',
)
const inventoryModule = readFileSync(
  new URL('../../functions/phase3/productionInventory.js', import.meta.url),
  'utf8',
)
const preflightModule = readFileSync(
  new URL('../../functions/phase3/productionPreflight.js', import.meta.url),
  'utf8',
)
const brief = readFileSync(
  new URL('../../PHASE3_RECONCILED_IMPLEMENTATION_BRIEF.md', import.meta.url),
  'utf8',
)
const runbook = readFileSync(
  new URL('../../PHASE3_RELEASE_RUNBOOK.md', import.meta.url),
  'utf8',
)

function imports(source) {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])
}

function exportedFunctionBody(source, name, nextName) {
  const startMarker = `export function ${name}`
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${name} must remain exported`)
  const end = source.indexOf(`export function ${nextName}`, start + startMarker.length)
  assert.notEqual(end, -1, `${nextName} must follow ${name}`)
  return source.slice(start, end)
}

function stringArray(source, constantName) {
  const match = new RegExp(
    `const ${constantName} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`,
  ).exec(source)
  assert.ok(match, `${constantName} must remain an explicit frozen array`)
  return [...match[1].matchAll(/'([^']+)'/g)].map(value => value[1])
}

function assertOrdered(source, markers, label) {
  let previous = -1
  for (const marker of markers) {
    const current = source.indexOf(marker, previous + 1)
    assert.ok(current > previous, `${label}: ${marker} must appear in order`)
    previous = current
  }
}

describe('Phase 3 control-plane inventory source contract', () => {
  it('entrypoint has no writer, data-reader, Auth-reader, or sibling CLI import', () => {
    const actualImports = imports(entrypoint)
    for (const forbidden of [
      'productionWriter',
      'productionProjection',
      'productionReconciliation',
      'studentLifecycle',
      './preflight.js',
      './write.js',
      './reverify.js',
      'firebase-admin/firestore',
      'firebase-admin/auth',
    ]) {
      assert.equal(
        actualImports.some(specifier => specifier.includes(forbidden)),
        false,
        `inventory.js must not import ${forbidden}: ${actualImports.join(', ')}`,
      )
    }
    assert.ok(
      actualImports.includes('./productionInventory.js'),
      'inventory.js must use the non-authorizing inventory module',
    )
    assert.match(entrypoint, /createProductionControlPlaneReaders/)
    assert.doesNotMatch(entrypoint, /createProductionReaders\s*[,}]/)
    for (const forbiddenCall of [
      'readLegacyClassroomAggregate',
      'readFlatCredentials',
      'readFlatAuthLogs',
      'readFoundation',
      'readDestinationPaths',
      'readAuthCompatibility',
      'runTransaction',
      '.batch(',
      '.set(',
      '.update(',
      '.delete(',
    ]) {
      assert.equal(
        entrypoint.includes(forbiddenCall),
        false,
        `inventory.js must contain no ${forbiddenCall} call path`,
      )
    }
  })

  it('control-plane factory creates no Admin/data handles and exposes two reads', () => {
    const factory = exportedFunctionBody(
      preflightModule,
      'createProductionControlPlaneReaders',
      'createProductionReaders',
    )
    for (const forbidden of [
      'createReadOnlyAdminHandles',
      'createReadOnlyDataReaders',
      'adminHandleFactory',
      'getFirestore',
      'getAuth',
      'teacherUid',
      'readLegacyClassroomAggregate',
      'readAuthCompatibility',
    ]) {
      assert.equal(
        factory.includes(forbidden),
        false,
        `control-plane factory must not contain ${forbidden}`,
      )
    }
    for (const required of [
      'createBoundedGoogleApiClient',
      'readRulesInventory',
      'readFunctionsInventory',
      'readHostingInventory',
      'readIndexesInventory',
      'readDeploymentInventory',
      'readActiveWriters',
    ]) {
      assert.ok(factory.includes(required), `control-plane factory must use ${required}`)
    }
  })

  it('retained artifact is an exact observation with no authorization widening', () => {
    assert.deepEqual(stringArray(inventoryModule, 'ARTIFACT_FIELDS'), [
      'schemaVersion',
      'kind',
      'inventoryId',
      'projectId',
      'commitSha',
      'changeId',
      'authorizationId',
      'credentialProvenance',
      'credentialSha256',
      'authorizationSha256',
      'observedAt',
      'outcome',
      'deployment',
      'activeWriters',
      'inventoryChecksum',
    ])
    assert.match(inventoryModule, /outcome:\s*'observed'/)
    assert.match(inventoryModule, /assertNoSecretMaterial\(artifact\)/)
    assert.match(inventoryModule, /fs\.link\(temporaryPath, targetPath\)/)
    assert.match(inventoryModule, /PRODUCTION_STATE_DIRECTORY/)
    assert.doesNotMatch(inventoryModule, /productionWriter|runTransaction/)
  })

  it('governing documents put reviewed inventory before expectations and preflight', () => {
    const releaseOrder = brief.split(
      '## 9. Release ordering and abort criteria',
    )[1].split('\n## ')[0]
    assertOrdered(releaseOrder, [
      'Obtain separate, checksum-bound authorization',
      'functions/phase3/inventory.js',
      'Independently corroborate',
      'Author and checksum the exact preflight expectations',
      'production preflight.',
      'production write/deploy authorization',
    ], 'brief')
    assertOrdered(runbook, [
      'control-plane-only inventory',
      'inventory.js',
      'Independently corroborate',
      'checksum the exact preflight expectations',
      'preflight.js',
      'production write/deploy authorization',
    ], 'runbook')
    for (const source of [brief, runbook]) {
      assert.match(source, /not an? (?:authorization or )?expectation/i)
      assert.match(
        source,
        /not[^\n]*(?:\n[^\n]*)?preflight manifest|does not create a preflight manifest/i,
      )
      assert.match(
        source,
        /does not authorize production inspection|not production authorization|not permission/i,
      )
    }
  })
})
