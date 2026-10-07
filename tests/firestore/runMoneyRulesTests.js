// A fixed demo-only runner; no Functions discovery or dotenv loading.
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.argv.length !== 2) throw new Error('No project or runtime arguments are accepted.');
if (existsSync(path.join(homedir(), '.config/gcloud/application_default_credentials.json'))) {
  throw new Error('Refusing rules test: local Google ADC exists.');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = mkdtempSync(path.join(tmpdir(), 'morgan-money-rules-demo-'));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  const cliConfig = path.join(runtime, 'cli-config');
  mkdirSync(path.join(cliConfig, 'configstore'), { recursive: true });
  writeFileSync(path.join(cliConfig, 'configstore/firebase-tools.json'), JSON.stringify({ motd: { fetched: 4102444800000 } }));
  copyFileSync(path.join(root, 'firestore.phase3.money.rules'), path.join(runtime, 'firestore.rules'));
  writeFileSync(path.join(runtime, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' },
    emulators: { firestore: { host: '127.0.0.1', port: 8080 }, ui: { enabled: false } } }));
  const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'JAVA_HOME', 'LANG', 'LC_ALL']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(environment, { XDG_CONFIG_HOME: cliConfig, METADATA_SERVER_DETECTION: 'none', CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' });
  const command = `${quote(process.execPath)} --test ${quote(path.join(root, 'tests/firestore/rules.phase3.money.test.js'))}`;
  const result = spawnSync('firebase', ['emulators:exec', '--config', path.join(runtime, 'firebase.json'),
    '--project', 'demo-morgan-bank-money-rules', '--only', 'firestore', command],
  { cwd: runtime, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(runtime, { recursive: true, force: true }); }
