import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('money-control release selects the reviewed rules and saver while preserving old artifacts', () => {
  const read = name => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
  assert.equal(JSON.parse(read('firebase.json')).firestore.rules, 'firestore.phase3.money.rules');
  assert.equal(createHash('sha256').update(read('firestore.phase3.final.rules')).digest('hex'),
    'f071377d7abf8d1d0009e5b9083a42f3cc7c69cdc6b501f6ea6eaf8bc4791702');
  assert.equal(createHash('sha256').update(read('firestore.rules')).digest('hex'),
    '0659a85719b24bb700048f6c6fc0b1fd3536936ed804b184986a7a54cff2cf50');
  assert.ok(read('index.html').includes('createNonMoneyTenantDataSaver as createTenantDataSaver'));
  assert.ok(read('firestore.phase3.money.rules').includes('SELECTED LOCAL RELEASE CANDIDATE'));
});
