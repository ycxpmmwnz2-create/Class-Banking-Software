import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { collectSourcePlan, prepareSourcePlan, allowedSource } from './prepare.js'

const root = new URL('../../', import.meta.url)
const collected = collectSourcePlan(root.pathname)
const original = new Map(collected.files.map(row => [row.path, readFileSync(new URL(row.path, root))]))
const run = (sources = new Map(original), clean = false) => prepareSourcePlan({ sources, clean, commit: 'a'.repeat(40) })
const edit = (path, fn) => { const files = new Map(original); files.set(path, Buffer.from(fn(files.get(path).toString()))); return files }

test('actual selected source composes rules, restricted saver, closed admission, exports and secret names without live authority', () => {
  const plan = run()
  assert.equal(plan.sourceState, 'UNCOMMITTED_REHEARSAL_CANDIDATE')
  assert.equal(plan.r1RequiredConfiguration.MULTI_TEACHER_V2_ENABLED, true)
  assert.equal(plan.r1RequiredConfiguration.MULTI_TEACHER_V2_MAINTENANCE_MODE, 'closed')
  assert.equal(plan.r1RequiredConfiguration.MULTI_TEACHER_V2_RELEASE_ID, 'student-money-functions-v3')
  assert.deepEqual(plan.secretNames, ['GEMINI_API_KEY', 'STUDENT_CREATION_HMAC_KEYS'])
  assert.equal(plan.invocations.length, 25)
  assert.equal(plan.invocations.filter(row => row.factory === 'onDocumentWritten').length, 3)
  assert.equal(plan.nodeMajor, '22')
  for (const clean of [false, true]) {
    const result = run(new Map(original), clean)
    assert.equal(result.productionEligible, false)
    assert.equal(result.initializationAllowed, false)
    assert.equal(result.activationAllowed, false)
    assert.ok(result.prerequisites.every(item => item.status === 'UNVERIFIED'))
  }
})

test('source hash is order-independent and changes with a runtime byte, including unimported code', () => {
  assert.equal(run(new Map([...original].reverse())).sourceTreeSha256, run().sourceTreeSha256)
  const changed = edit('functions/index.js', text => text + '\nthrow new Error("MUST NEVER IMPORT FUNCTIONS");\n')
  assert.notEqual(run(changed).sourceTreeSha256, run().sourceTreeSha256)
})

for (const [name, path, mutate] of [
  ['broad rules', 'firebase.json', text => text.replace('firestore.phase3.money.rules', 'firestore.phase3.final.rules')],
  ['foreign database', 'firebase.json', text => text.replace('(default)', 'another')],
  ['wrong runtime', 'functions/package.json', text => text.replace('"22"', '"24"')],
  ['broad saver', 'index.html', text => text.replace('createNonMoneyTenantDataSaver as ', '')],
  ['duplicate saver', 'index.html', text => text + '\nimport { createNonMoneyTenantDataSaver as createTenantDataSaver } from "./src/phase3/nonMoneyTenantDataSaver.js";'],
  ['modified owner proposal', 'docs/controlled-maintenance/APPROVED-PROPOSAL.md', text => text + 'accepted elsewhere'],
  ['unknown invocation form', 'functions/index.js', text => text + '\nexport const surprise = unknownFactory();'],
  ['nonliteral release binding', 'functions/index.js', text => text.replace("'student-money-functions-v3'", 'process.env.RELEASE')],
  ['missing creation secret declaration', 'functions/index.js', text => text.replace("defineSecret('STUDENT_CREATION_HMAC_KEYS')", "defineSecret('SOMETHING_ELSE')")],
]) test(`refuses ${name}`, () => assert.throws(() => run(edit(path, mutate))))

test('private paths, path traversal, unsupported files and over-budget input refuse', () => {
  for (const path of ['.env', 'functions/.env.morgan-bank', '../firebase.json', '/firebase.json',
    'functions/../firebase.json', 'functions\\index.js', 'private/report.json', 'functions/key.pem']) {
    assert.equal(allowedSource(path), false, path)
    const files = new Map(original); files.set(path, Buffer.from('fictional-private-sentinel'))
    assert.throws(() => run(files))
  }
  const missing = new Map(original); missing.delete('functions/index.js'); assert.throws(() => run(missing))
  const oversized = new Map(original); oversized.set('src/oversized.js', Buffer.alloc(2 * 1024 * 1024 + 1))
  assert.throws(() => run(oversized))
})

test('CLI refuses operation/target arguments without echoing them or leaking source', () => {
  const result = spawnSync(process.execPath, [new URL('./prepare.js', import.meta.url).pathname, 'fictional-private-sentinel'],
    { encoding: 'utf8', env: {} })
  assert.equal(result.status, 2); assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Local maintenance preparation refused. Check source composition and required files; no cloud action occurred.\n')
})

test('clean-source claim binds HEAD bytes even when Git hides changes, and refuses symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'morgan-source-plan-test-'))
  const git = args => execFileSync('/usr/bin/git', args, { cwd: directory, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  try {
    for (const [path, bytes] of original) {
      const file = join(directory, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes)
    }
    git(['init', '--quiet']); git(['add', '.'])
    git(['-c', 'user.name=Fictional Test', '-c', 'user.email=fictional@example.invalid', 'commit', '--quiet', '-m', 'Fictional source fixture'])
    assert.equal(collectSourcePlan(directory).sourceState, 'CLEAN_SOURCE_CANDIDATE')
    const path = 'src/phase3/nonMoneyTenantDataSaver.js'
    git(['update-index', '--assume-unchanged', path])
    writeFileSync(join(directory, path), original.get(path).toString() + '\n// hidden modification\n')
    assert.equal(git(['status', '--porcelain']).trim(), '')
    assert.throws(() => collectSourcePlan(directory), /preparation refused/)
    unlinkSync(join(directory, path)); symlinkSync(join(directory, 'functions/index.js'), join(directory, path))
    assert.throws(() => collectSourcePlan(directory), /preparation refused/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
