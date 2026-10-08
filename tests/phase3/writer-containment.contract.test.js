import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { useReviewedNonMoneySaver } from '../browser/vite.writer-containment.config.js';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('combined test composition changes only the reviewed saver import and fails on a missing or duplicate seam', () => {
  const page = read('../../index.html');
  const candidate = useReviewedNonMoneySaver(page);
  const oldLine = 'import { createTenantDataLoader, createStudentDataLoader, createTenantDataSaver } from "./src/phase3/tenantDataService.js";';
  const newLines = 'import { createTenantDataLoader, createStudentDataLoader } from "./src/phase3/tenantDataService.js";\n' +
    'import { createNonMoneyTenantDataSaver as createTenantDataSaver } from "./src/phase3/nonMoneyTenantDataSaver.js";';
  assert.equal(candidate, page, 'normal release already selects the tested saver');
  assert.equal(useReviewedNonMoneySaver(page.replace(newLines, oldLine)), page);
  assert.throws(() => useReviewedNonMoneySaver(page.replace(newLines, '')), /exactly once/);
  assert.throws(() => useReviewedNonMoneySaver(page + newLines), /exactly once/);
  assert.throws(() => useReviewedNonMoneySaver(page + oldLine), /exactly once/);
  assert.equal(JSON.parse(read('../../firebase.json')).firestore.rules, 'firestore.phase3.money.rules');
});

test('combined runner refuses arbitrary modes and arguments before launching any services', () => {
  for (const args of [['production'], ['gate-off', 'combined-writers'], ['gate-on', 'unknown'], ['gate-on', 'combined-writers', 'morgan-bank']]) {
    const result = spawnSync(process.execPath, ['tests/phase2b/runServerEmulatorTests.js', ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Select gate-on or gate-off/);
  }
});
