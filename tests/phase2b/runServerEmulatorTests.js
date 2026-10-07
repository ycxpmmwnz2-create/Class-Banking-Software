// Emulator-only test runner. Firebase's parameter resolver reads dotenv files
// rather than shell overrides and can persist prompted values. Isolate all of
// that behavior in a disposable public-source copy; never read real dotenv.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const mode = process.argv[2]
const focus = process.argv[3]
if (!['gate-on', 'gate-off'].includes(mode) || process.argv.length > 4 ||
    (focus !== undefined && (mode !== 'gate-on' || !['teacher-writers', 'student-writers', 'credential-writers', 'combined-writers', 'combined-server'].includes(focus)))) throw new Error('Select gate-on or gate-off; gate-on optionally accepts teacher-writers, student-writers, credential-writers, combined-writers or combined-server.')
if (existsSync(path.join(homedir(), '.config/gcloud/application_default_credentials.json'))) {
  throw new Error('Refusing Phase 2B emulator test: local Google ADC exists.')
}
const root = fileURLToPath(new URL('../../', import.meta.url))
const projectId = mode === 'gate-on' ? 'demo-morgan-bank-phase2b-server-test' : 'demo-morgan-bank-phase2b-server-off-test'
const runtime = mkdtempSync(path.join(tmpdir(), 'morgan-bank-server-demo-'))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
try {
  const functionsDir = path.join(runtime, 'functions')
  mkdirSync(functionsDir)
  function copyPublicSources(source, target) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const from = path.join(source, entry.name), to = path.join(target, entry.name)
      if (entry.isDirectory()) { mkdirSync(to); copyPublicSources(from, to) }
      else if (entry.isFile() && (entry.name.endsWith('.js') || ['package.json', 'package-lock.json'].includes(entry.name))) copyFileSync(from, to)
    }
  }
  copyPublicSources(path.join(root, 'functions'), functionsDir)
  symlinkSync(path.join(root, 'functions/node_modules'), path.join(functionsDir, 'node_modules'))
  writeFileSync(path.join(functionsDir, '.env.local'), [
    `MULTI_TEACHER_V2_ENABLED=${mode === 'gate-on'}`,
    `MULTI_TEACHER_V2_MAINTENANCE_MODE=${mode === 'gate-on' ? 'normal' : 'closed'}`,
    'MULTI_TEACHER_V2_RELEASE_ID=student-money-functions-v3',
    'MORGAN_BANK_DEPLOYMENT_TIER=production', 'MORGAN_BANK_STAGING_PROJECT_ID=',
    'VERSION3_GEMINI_ENABLED=false', 'VERSION3_GEMINI_RELEASE_ID=', 'VERSION3_GEMINI_TOOL_ASSISTANT_ENABLED=false', '',
  ].join('\n'))
  writeFileSync(path.join(functionsDir, '.secret.local'), 'GEMINI_API_KEY=fictional-disabled-provider-key\nSTUDENT_CREATION_HMAC_KEYS=' + JSON.stringify({currentVersion:'fixture-v1',keys:{'fixture-v1':'ab'.repeat(32)}}) + '\n')
  const cliConfig = path.join(runtime, 'cli-config')
  mkdirSync(path.join(cliConfig, 'configstore'), { recursive: true })
  writeFileSync(path.join(cliConfig, 'configstore/firebase-tools.json'), JSON.stringify({ motd: { fetched: 4102444800000 } }))
  copyFileSync(path.join(root, focus?.startsWith('combined-') ? 'firestore.phase3.money.rules' : 'firestore.phase3.final.rules'), path.join(runtime, 'firestore.rules'))
  writeFileSync(path.join(runtime, 'firebase.json'), JSON.stringify({
    functions: [{ source: 'functions', codebase: 'default' }],
    firestore: { rules: 'firestore.rules' },
    emulators: { auth: { host: '127.0.0.1', port: 9099 }, functions: { host: '127.0.0.1', port: 5001 },
      firestore: { host: '127.0.0.1', port: 8080 }, ui: { enabled: false } },
  }))
  // Allow system runtime paths only, rather than trying to enumerate every
  // spelling of a credential/provider/project environment variable to scrub.
  const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'JAVA_HOME', 'LANG', 'LC_ALL']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(environment, { XDG_CONFIG_HOME: cliConfig, METADATA_SERVER_DETECTION: 'none', CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' })
  const command = focus === 'combined-writers'
    ? `cd ${quote(root)} && ${quote(process.execPath)} ${quote(path.join(root, 'node_modules/@playwright/test/cli.js'))} test --config tests/browser/playwright.writer-containment.config.js`
    : `env PHASE2B_EMULATOR_TEST_MODE=${mode} PHASE3_WRITER_CONTAINMENT=${focus === 'combined-server' ? 'true' : 'false'} ${quote(process.execPath)} --test ${focus && focus !== 'combined-server' ? quote(focus === 'teacher-writers' ? '--test-name-pattern=C1b|new routes deny anonymous access' : focus === 'credential-writers' ? '--test-name-pattern=C3|D\\. V2 student sync|E\\. Tenant-derived|F\\. Student login' : '--test-name-pattern=C2|new routes deny anonymous access') + ' ' : ''}${quote(path.join(root, 'tests/phase2b/functions-auth.emulator.test.js'))}`
  const result = spawnSync('firebase', ['emulators:exec', '--config', path.join(runtime, 'firebase.json'),
    '--project', projectId, '--only', 'auth,functions,firestore', command], { cwd: runtime, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { rmSync(runtime, { recursive: true, force: true }) }
