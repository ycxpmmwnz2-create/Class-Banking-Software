import assert from 'node:assert/strict'
import test from 'node:test'

import { callableLogDiagnostic } from './callableErrors.js'
import { InsightToolQuestionServiceError } from './toolQuestionService.js'

function error(subcategory, diagnostic) {
  return { category: 'answer-unverified', subcategory, diagnostic }
}

// A refusal reason is worth nothing if reading it can put a child's balance in
// a log, so the allowlist is asserted from both directions: the known-safe
// fields survive, and everything else is dropped rather than redacted.
test('logs only allowlisted, value-free diagnostic fields', () => {
  assert.deepEqual(callableLogDiagnostic(error('unsupported-number', {
    claimKind: 'day-count',
    numericFactCount: 12,
    numericFactKinds: ['money', 'transaction-count'],
    distinctWindowCount: 2,
  })), {
    claimKind: 'day-count',
    numericFactCount: 12,
    numericFactKinds: ['money', 'transaction-count'],
    distinctWindowCount: 2,
  })

  assert.deepEqual(callableLogDiagnostic(error('truncation-not-disclosed', {
    returnedCount: 50,
    totalCount: 60,
    disclosureNumbersPresent: false,
    disclosureWordPresent: true,
  })), {
    returnedCount: 50,
    totalCount: 60,
    disclosureNumbersPresent: false,
    disclosureWordPresent: true,
  })
})

test('logs why an unsatisfiable truncation check fired', () => {
  assert.deepEqual(callableLogDiagnostic(error('truncation-not-disclosed', {
    toolName: 'list_transactions',
    returnedCountUsable: true,
    totalCountUsable: false,
  })), {
    toolName: 'list_transactions',
    returnedCountUsable: true,
    totalCountUsable: false,
  })
  // A tool name outside the real toolbox is not logged back.
  assert.equal(callableLogDiagnostic(error('truncation-not-disclosed', {
    toolName: 'Paid to GianMarco for chores',
  })), null)
})

test('drops any diagnostic field that could carry classroom content', () => {
  const logged = callableLogDiagnostic(error('unsupported-number', {
    claimKind: 'money',
    // None of these are allowlisted names.
    studentName: 'GianMarco Bellini',
    memo: 'Paid to GianMarco for chores',
    balance: 42,
    answer: 'GianMarco earned $42.',
  }))
  assert.deepEqual(logged, { claimKind: 'money' })
  assert.equal(JSON.stringify(logged).includes('Bellini'), false)
})

test('drops allowlisted names carrying the wrong shape', () => {
  // A free-text value smuggled under an allowlisted key is not a kind word.
  assert.equal(callableLogDiagnostic(error('unsupported-number', {
    claimKind: 'Paid to GianMarco for chores',
  })), null)
  // Kind arrays are bounded and vocabulary-checked.
  assert.equal(callableLogDiagnostic(error('unsupported-number', {
    numericFactKinds: ['money', 'GianMarco Bellini'],
  })), null)
  // Counts must be safe non-negative integers, not amounts or floats.
  assert.equal(callableLogDiagnostic(error('unsupported-number', {
    numericFactCount: -1,
  })), null)
  assert.equal(callableLogDiagnostic(error('unsupported-number', {
    totalCount: 42.5,
  })), null)
})

test('logs nothing for an unknown subcategory or a missing diagnostic', () => {
  assert.equal(callableLogDiagnostic(error('not-a-real-subcategory', { claimKind: 'money' })), null)
  assert.equal(callableLogDiagnostic(error('unsupported-number', null)), null)
  assert.equal(callableLogDiagnostic(error('unsupported-number', ['money'])), null)
  assert.equal(callableLogDiagnostic(undefined), null)
})

// The refusal crosses a re-wrap on its way to the log. Dropping the diagnostic
// there is what made a live refusal name its subcategory and nothing else.
test('the service re-wrap carries the diagnostic through to the log', () => {
  const wrapped = new InsightToolQuestionServiceError(
    'answer-unverified',
    'The classroom assistant could not complete the answer.',
    'truncation-not-disclosed',
    { toolName: 'list_transactions', returnedCountUsable: true, totalCountUsable: false },
  )
  assert.deepEqual(callableLogDiagnostic(wrapped), {
    toolName: 'list_transactions',
    returnedCountUsable: true,
    totalCountUsable: false,
  })
})
