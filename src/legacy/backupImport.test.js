import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeLegacyBackup } from './backupImport.js'

const SETTINGS = Object.freeze({
  studentRequestsEnabled: true,
  studentAddRequestsEnabled: true,
  studentSubtractRequestsEnabled: true,
  purchaseRequestsEnabled: true,
  requireTeacherApproval: true,
  reasons: ['Payday'],
  purchaseCategories: ['Store'],
  addMoneyCategories: ['Job'],
  subtractMoneyCategories: ['Rent'],
})

function validBackup() {
  return {
    students: [{ id: 1, name: 'Andrew', pin: '1234', balance: 10, frozen: false }],
    transactions: [{
      id: 10,
      date: '8/9/2026',
      studentId: 1,
      studentName: 'Andrew',
      type: 'Add',
      amount: 10,
      reason: 'Payday',
      memo: '',
      category: '',
      status: 'Approved',
      source: 'Teacher',
    }],
    loginHistory: [{
      id: 20,
      date: '8/9/2026',
      studentId: 1,
      studentName: 'Andrew',
      result: 'Success',
      note: '',
    }],
    settings: {
      ...SETTINGS,
      reasons: [...SETTINGS.reasons],
      purchaseCategories: [...SETTINGS.purchaseCategories],
      addMoneyCategories: [...SETTINGS.addMoneyCategories],
      subtractMoneyCategories: [...SETTINGS.subtractMoneyCategories],
    },
    exportedAt: '2026-08-09T00:00:00.000Z',
  }
}

test('accepts and canonicalizes one legitimate legacy backup', () => {
  const result = sanitizeLegacyBackup(validBackup(), { fallbackSettings: SETTINGS })
  assert.equal(result.students[0].id, 1)
  assert.equal(result.transactions[0].status, 'Approved')
  assert.equal(result.lastBackupAt, '2026-08-09T00:00:00.000Z')
})

test('rejects script-bearing IDs before they can reach inline handlers or attributes', () => {
  const backup = validBackup()
  backup.students[0].id = '1);globalThis.pwned=true;//'
  assert.throws(() => sanitizeLegacyBackup(backup, { fallbackSettings: SETTINGS }), /positive integer/)
})

test('rejects unknown and credential-bearing fields instead of silently preserving them', () => {
  for (const mutation of [
    backup => { backup.students[0].pinHash = 'secret' },
    backup => { backup.transactions[0].onclick = 'globalThis.pwned=true' },
    backup => { backup.authToken = 'secret' },
  ]) {
    const backup = validBackup()
    mutation(backup)
    assert.throws(() => sanitizeLegacyBackup(backup, { fallbackSettings: SETTINGS }), /unsupported fields/)
  }
})

test('rejects duplicate IDs, non-finite money, oversized lists, and malformed timestamps', () => {
  const duplicate = validBackup()
  duplicate.students.push({ ...duplicate.students[0] })
  assert.throws(() => sanitizeLegacyBackup(duplicate, { fallbackSettings: SETTINGS }), /duplicate IDs/)

  const nonFinite = validBackup()
  nonFinite.transactions[0].amount = Infinity
  assert.throws(() => sanitizeLegacyBackup(nonFinite, { fallbackSettings: SETTINGS }), /amount is invalid/)

  const oversized = validBackup()
  oversized.settings.reasons = Array.from({ length: 101 }, () => 'Reason')
  assert.throws(() => sanitizeLegacyBackup(oversized, { fallbackSettings: SETTINGS }), /reasons is invalid/)

  const badDate = validBackup()
  badDate.exportedAt = 'not-a-date'
  assert.throws(() => sanitizeLegacyBackup(badDate, { fallbackSettings: SETTINGS }), /exportedAt is invalid/)
})
