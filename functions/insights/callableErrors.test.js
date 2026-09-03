import assert from 'node:assert/strict'
import test from 'node:test'

import { callableLogDiagnostic } from './callableErrors.js'
import { CLASSROOM_ASSISTANT_CLAIM_PREDICATES } from './geminiClassroomAssistant.js'
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
  })), {
    returnedCount: 50,
    totalCount: 60,
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

// The tool-loop refusals reached production naming neither a subcategory nor a
// cause. Their diagnostics are counts and flags about the loop itself, so they
// must survive the allowlist while carrying nothing from the classroom.
test('logs the tool-loop diagnostic counts and flags', () => {
  assert.deepEqual(callableLogDiagnostic(error('tool-call-limit', {
    turnIndex: 0,
    toolCallCount: 6,
    requestedCallCount: 9,
  })), {
    turnIndex: 0,
    toolCallCount: 6,
    requestedCallCount: 9,
  })

  assert.deepEqual(callableLogDiagnostic(error('tool-call-id-repeated', {
    turnIndex: 2,
    toolCallCount: 3,
    providerCallIdPresent: false,
  })), {
    turnIndex: 2,
    toolCallCount: 3,
    providerCallIdPresent: false,
  })

  assert.deepEqual(
    callableLogDiagnostic(error('tool-turn-limit', { turnIndex: 4, toolCallCount: 4 })),
    { turnIndex: 4, toolCallCount: 4 },
  )
  assert.deepEqual(
    callableLogDiagnostic(error('tool-turn-content-missing', { turnIndex: 1, toolCallCount: 0 })),
    { turnIndex: 1, toolCallCount: 0 },
  )
})

test('a tool-loop diagnostic carrying classroom content is dropped', () => {
  // A tool-call ID is provider text, not a count, and never belongs in a log.
  assert.equal(callableLogDiagnostic(error('tool-call-id-repeated', {
    turnIndex: 'Paid to GianMarco for chores',
    toolCallCount: 'call-GianMarco-01',
    providerCallIdPresent: 'yes',
  })), null)
  assert.equal(callableLogDiagnostic(error('tool-turn-limit', {
    turnIndex: -1,
    toolCallCount: 2.5,
  })), null)
})

// Every predicate name a refusal can carry has to be a word this vocabulary
// knows, or the field is dropped and the refusal reaches the logs with the most
// useful part of its diagnosis missing. 'listing' was emitted for a whole round
// without being listed here. The two allowlists are cross-checked the way the
// subcategory pair is, so neither can gain a member the other does not know.
test('the predicate vocabulary covers every predicate a refusal can name', () => {
  assert.equal(CLASSROOM_ASSISTANT_CLAIM_PREDICATES.size > 0, true)
  for (const predicate of CLASSROOM_ASSISTANT_CLAIM_PREDICATES) {
    assert.deepEqual(
      callableLogDiagnostic({ subcategory: 'unsupported-predicate', diagnostic: { claimPredicate: predicate } }),
      { claimPredicate: predicate },
      `predicate ${predicate} must survive the log vocabulary`,
    )
  }
  // And nothing the validator cannot produce is accepted here either, so the
  // vocabulary cannot drift into words that are no longer reachable.
  for (const word of ['students', 'enrolled', 'former-students']) {
    assert.equal(CLASSROOM_ASSISTANT_CLAIM_PREDICATES.has(word), false)
    assert.equal(
      callableLogDiagnostic({ subcategory: 'unsupported-predicate', diagnostic: { claimPredicate: word } }),
      null,
      `${word} is not a predicate the validator names`,
    )
  }
})
