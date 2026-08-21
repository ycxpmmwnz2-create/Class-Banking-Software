import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeStoredTransactionDate } from './storedTransactionDate.js'

test('keeps canonical ISO transaction instants unchanged', () => {
  assert.equal(
    normalizeStoredTransactionDate('2026-08-19T16:15:30.000Z'),
    '2026-08-19T16:15:30.000Z',
  )
})

test('normalizes the exact legacy en-US browser date in the requested time zone', () => {
  assert.equal(
    normalizeStoredTransactionDate('8/19/2026, 10:15:30 AM', { timeZone: 'America/Denver' }),
    '2026-08-19T16:15:30.000Z',
  )
  assert.equal(
    normalizeStoredTransactionDate('1/15/2026, 10:15:30 AM', { timeZone: 'America/Denver' }),
    '2026-01-15T17:15:30.000Z',
  )
  assert.equal(
    normalizeStoredTransactionDate('8/19/2026, 12:05:06 AM', { timeZone: 'UTC' }),
    '2026-08-19T00:05:06.000Z',
  )
  assert.equal(
    normalizeStoredTransactionDate('11/1/2026, 1:15:30 AM', { timeZone: 'America/Denver' }),
    '2026-11-01T07:15:30.000Z',
  )
})

test('rejects unknown parseable shapes, impossible wall times, and invalid zones', () => {
  for (const value of [
    '2026-08-19T16:15:30Z',
    '2026-08-19T10:15:30-06:00',
    '2026-08-19',
    '2/30/2026, 10:15:30 AM',
    '8/19/2026, 10:15 AM',
  ]) {
    assert.equal(normalizeStoredTransactionDate(value), null)
  }
  assert.equal(
    normalizeStoredTransactionDate('8/19/2026, 10:15:30 AM', { timeZone: 'Not/A_Zone' }),
    null,
  )
  assert.equal(
    normalizeStoredTransactionDate('3/8/2026, 2:15:30 AM', { timeZone: 'America/Denver' }),
    null,
  )
  assert.equal(normalizeStoredTransactionDate('8/19/2026, 10:15:30 AM'), null)
  assert.equal(
    normalizeStoredTransactionDate('12/31/9999, 11:59:59 PM', { timeZone: 'America/Denver' }),
    null,
  )
  assert.equal(normalizeStoredTransactionDate('+010000-01-01T00:00:00.000Z'), null)
})

test('canonicalizes formatter aliases without changing the normalized instant', () => {
  const value = '8/19/2026, 10:15:30 AM'
  assert.equal(
    normalizeStoredTransactionDate(value, { timeZone: 'aMeRiCa/DeNvEr' }),
    normalizeStoredTransactionDate(value, { timeZone: 'America/Denver' }),
  )
})
