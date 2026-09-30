import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateMoneyDocumentBytes, MoneyDocumentSizeError } from './moneyDocumentSize.js'
import { estimateMoneyDocumentBytes as legacy, MoneyCompatibilityError } from './moneyCompatibility.js'

test('extracted estimator preserves scanner sizes and old error contract', () => {
  for (const data of [null, { id: 1, name: 'Fictional', balance: 1.1, frozen: false, transactions: [] }, { a: [true, 3, 'é'] }]) {
    assert.equal(estimateMoneyDocumentBytes('classrooms/c/students/1', data), legacy('classrooms/c/students/1', data))
  }
  assert.equal(estimateMoneyDocumentBytes('x', { a: 1 }), 1164)
  const cycle = {}; cycle.self = cycle
  for (const data of [undefined, cycle, new Date(), new Array(1)]) {
    assert.throws(() => estimateMoneyDocumentBytes('x', data), MoneyDocumentSizeError)
    assert.throws(() => legacy('x', data), error => error instanceof MoneyCompatibilityError && error.category === 'unsupported-encoding')
  }
})
