import { createHash } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { extractExports, parseModule } from '../../tests/phase3/functionsExportInventory.js'

// Local source preparation only. Never imports Functions or constructs a cloud client.
const root = fileURLToPath(new URL('../../', import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const approvalHash = 'd662d9379f282a47139eb82debf04e7fe17436149eef82f6ea57a4e1d25c1e99'
const required = ['firebase.json', 'firestore.indexes.json', 'index.html', 'package.json', 'package-lock.json',
  'functions/index.js', 'functions/package.json', 'functions/package-lock.json',
  'firestore.phase3.money.rules', 'firestore.phase3.maintenance.rules',
  'firestore.phase3.final.rules', 'firestore.phase3.rollback.rules',
  'src/phase3/nonMoneyTenantDataSaver.js', 'vite.config.js',
  'CONTROLLED_MAINTENANCE_CONTRACT.md', 'docs/controlled-maintenance/APPROVED-PROPOSAL.md',
  'scripts/controlledMaintenance/prepare.js', 'tests/phase3/functionsExportInventory.js']
const extensions = new Set(['.js', '.json', '.html', '.css', '.svg', '.png', '.jpg', '.webp', '.ico', '.rules', '.md'])
const selectedSaver = 'import { createNonMoneyTenantDataSaver as createTenantDataSaver } from "./src/phase3/nonMoneyTenantDataSaver.js";'
function requireCondition(ok) { if (!ok) throw new Error('Local maintenance preparation refused.') }
export function allowedSource(path) {
  return typeof path === 'string' && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '..' && !part.startsWith('.')) &&
    extensions.has(extname(path)) &&
    (required.includes(path) || /^(src|functions|public)\//.test(path) || /^firestore[^/]*\.rules$/.test(path))
}
const readText = (sources, path) => {
  const value = sources.get(path)
  requireCondition(value instanceof Uint8Array)
  return new TextDecoder('utf-8', { fatal: true }).decode(value)
}
const literal = (program, name) => {
  const declarations = program.body.flatMap(node => (node.declaration ?? node).declarations ?? [])
    .filter(node => node.id?.name === name)
  requireCondition(declarations.length === 1 && declarations[0].init?.type === 'Literal')
  return declarations[0].init.value
}

export function prepareSourcePlan({ sources, commit, clean }) {
  requireCondition(sources instanceof Map && sources.size <= 2000 &&
    /^[a-f0-9]{40}$/.test(commit) && typeof clean === 'boolean')
  for (const path of required) requireCondition(sources.has(path))
  const files = []
  let total = 0
  for (const [path, bytes] of sources) {
    requireCondition(allowedSource(path) && bytes instanceof Uint8Array && bytes.length <= 2 * 1024 * 1024)
    total += bytes.length
    requireCondition(total <= 64 * 1024 * 1024)
    files.push({ path, bytes: bytes.length, sha256: sha(bytes) })
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const firebase = JSON.parse(readText(sources, 'firebase.json'))
  requireCondition(firebase.firestore?.rules === 'firestore.phase3.money.rules' &&
    firebase.firestore.database === '(default)' && firebase.firestore.indexes === 'firestore.indexes.json' &&
    firebase.hosting?.public === 'dist' &&
    firebase.functions?.length === 1 && firebase.functions[0].source === 'functions')
  const html = readText(sources, 'index.html')
  requireCondition(html.split(selectedSaver).length === 2 &&
    !/import\s*\{[^}]*\bcreateTenantDataSaver\b[^}]*\}\s*from\s*["'][^"']*tenantDataService/.test(html))
  const nodeMajor = JSON.parse(readText(sources, 'functions/package.json')).engines?.node
  requireCondition(nodeMajor === '22')
  requireCondition(sha(sources.get('docs/controlled-maintenance/APPROVED-PROPOSAL.md')) === approvalHash)
  const code = readText(sources, 'functions/index.js')
  const exports = extractExports(code)
  const program = parseModule(code)
  const releaseId = literal(program, 'REVIEWED_V2_FUNCTIONS_RELEASE_ID')
  requireCondition(typeof releaseId === 'string' && /^[a-z0-9-]{1,100}$/.test(releaseId))
  const secretFactory = program.body.filter(n => n.type === 'ImportDeclaration' && n.source.value === 'firebase-functions/params')
    .flatMap(n => n.specifiers).find(n => n.imported?.name === 'defineSecret')?.local.name
  requireCondition(secretFactory)
  const secretNames = program.body.flatMap(n => (n.declaration ?? n).declarations ?? [])
    .filter(n => n.init?.type === 'CallExpression' && n.init.callee.name === secretFactory)
    .map(n => {
      requireCondition(n.init.arguments.length === 1 && n.init.arguments[0].type === 'Literal' &&
        /^[A-Z][A-Z0-9_]{0,100}$/.test(n.init.arguments[0].value))
      return n.init.arguments[0].value
    }).sort()
  requireCondition(secretNames.includes('GEMINI_API_KEY') && secretNames.includes('STUDENT_CREATION_HMAC_KEYS'))
  const invocations = [...exports].filter(([, kind]) => ['onCall', 'onDocumentWritten'].includes(kind))
    .map(([name, factory]) => ({ name, factory })).sort((a, b) => a.name.localeCompare(b.name))
  requireCondition(invocations.some(row => row.name === 'recordStudentBalanceHistoryV3') &&
    invocations.some(row => row.name === 'getStudentSettingsV2'))
  return {
    schemaVersion: 1, kind: 'controlled-maintenance-local-source-plan',
    assuranceVersion: 'controlled-maintenance-2026-10-08', proposalSha256: approvalHash,
    sourceState: clean ? 'CLEAN_SOURCE_CANDIDATE' : 'UNCOMMITTED_REHEARSAL_CANDIDATE',
    baseCommit: commit, sourceTreeSha256: sha(JSON.stringify(files)), files,
    target: { projectId: 'morgan-bank', databaseId: '(default)' }, nodeMajor,
    r1RequiredConfiguration: { MULTI_TEACHER_V2_ENABLED: true,
      MULTI_TEACHER_V2_MAINTENANCE_MODE: 'closed', MULTI_TEACHER_V2_RELEASE_ID: releaseId,
      MORGAN_BANK_DEPLOYMENT_TIER: 'production', MORGAN_BANK_STAGING_PROJECT_ID: '' },
    invocations, secretNames,
    prerequisites: ['built-assets-and-reviewed-clean-commit', 'live-project-database-identity',
      'secret-version-access-and-provider-configuration', 'all-deployed-writers-and-routes',
      'per-writer-stop-signals-and-delivery-dispositions', 'database-request-settlement',
      'private-operator-and-effective-iam', 'wire-masks-and-bounded-inventory',
      'authenticated-rules-propagation', 'credential-and-witness-reconciliation',
      'journal-storage-and-recovery', 'signed-in-live-acceptance']
      .map(requirement => ({ requirement, status: 'UNVERIFIED' })),
    productionEligible: false, initializationAllowed: false, activationAllowed: false,
  }
}

export function collectSourcePlan(directory = root) {
  const git = args => execFileSync('/usr/bin/git', args, { cwd: directory, encoding: 'utf8',
    maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  const commit = git(['rev-parse', 'HEAD']).trim()
  const clean = git(['status', '--porcelain']).trim() === ''
  const tracked = git(['ls-files', '-z']).split('\0').filter(path => path && allowedSource(path))
  // Required new tooling/docs may be untracked during rehearsal; status stays dirty.
  const paths = [...new Set([...tracked, ...required])].sort()
  const sources = new Map()
  for (const path of paths) {
    for (const prefix of path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))) {
      requireCondition(!lstatSync(resolve(directory, prefix)).isSymbolicLink())
    }
    const filename = resolve(directory, path)
    requireCondition(relative(directory, filename) === path)
    const stat = lstatSync(filename)
    requireCondition(stat.isFile() && stat.size <= 2 * 1024 * 1024)
    sources.set(path, readFileSync(filename))
  }
  // Detect source drift across collection. This local check is not a private-host fence.
  for (const [path, bytes] of sources) requireCondition(sha(readFileSync(resolve(directory, path))) === sha(bytes))
  if (clean) {
    // Status can hide skip-worktree/assume-unchanged changes. Bind the actual
    // collected bytes to HEAD blobs independently before calling source clean.
    const tree = git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean)
      .map(row => { const [metadata, path] = row.split('\t'); return { path, metadata: metadata.split(' ') } })
      .filter(row => allowedSource(row.path))
    requireCondition(tree.length === sources.size)
    for (const { path, metadata: [mode, type, object] } of tree) {
      const bytes = sources.get(path)
      requireCondition(['100644', '100755'].includes(mode) && type === 'blob' && bytes)
      const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      requireCondition(actual === object)
    }
  }
  requireCondition(git(['rev-parse', 'HEAD']).trim() === commit && (git(['status', '--porcelain']).trim() === '') === clean)
  return prepareSourcePlan({ sources, commit, clean })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCondition(process.argv.length === 2)
    process.stdout.write(JSON.stringify(collectSourcePlan(), null, 2) + '\n')
  } catch {
    process.stderr.write('Local maintenance preparation refused. Check source composition and required files; no cloud action occurred.\n')
    process.exitCode = 2
  }
}
