// Fictional reporting cases: two approved additions on ONE day, plus excluded
// pending, other-category and other-student records to distinguish day counts.
export function reportingEvidence() {
  const transaction = (id, studentRef, date, amount, category = 'Technology', status = 'Approved') => ({ ref: `transaction-${String(id).padStart(5, '0')}`, studentRef, date, amount, category, type: 'Add', purpose: 'other', status })
  return { question: '', generatedAt: '2026-09-06T18:00:00.000Z', asOfDate: '2026-09-06', timeZone: 'America/Denver', periodDays: 30, periodStart: '2026-08-07T18:00:00.000Z', historyStart: '2026-06-08T18:00:00.000Z', configuredRentAmount: 5,
    students: [{ ref: 'student-001', displayName: 'Fable', current: true, balance: 12, frozen: false }, { ref: 'student-002', displayName: 'Quill', current: true, balance: 4, frozen: false }],
    categories: [{ label: 'Technology', transactionTypes: ['Add'] }, { label: 'Homework', transactionTypes: ['Add'] }],
    transactions: [transaction(1, 'student-001', '2026-08-28T16:00:00.000Z', 2), transaction(2, 'student-001', '2026-08-28T19:00:00.000Z', 3), transaction(3, 'student-001', '2026-08-27T16:00:00.000Z', 50, 'Technology', 'Pending'), transaction(4, 'student-001', '2026-08-26T16:00:00.000Z', 1, 'Homework'), transaction(5, 'student-002', '2026-08-25T16:00:00.000Z', 4)] }
}
const filters = { studentRefs: ['student-001'], startDate: '2026-08-24', endDate: '2026-08-30', transactionType: 'Add', status: 'Approved', categoryContains: 'Technology' }
export const REPORTING_CASES = [
  { id: 'distinct-days', question: 'How many days did Fable earn money for Technology last week?', tool: 'aggregate_transactions', args: { ...filters, metric: 'distinctDays', groupBy: [] }, expected: /1 \(2 transactions\)/u },
  { id: 'balances', question: 'What is the total class balance and average balance?', tool: 'get_balances', args: {}, expected: /Total balance: \$16.00. Average: \$8.00/u },
  { id: 'transaction-list', question: 'List Fable’s approved Technology additions last week.', tool: 'list_transactions', args: filters, expected: /2 matching transactions/u },
  { id: 'absence', question: 'Who had no approved Homework additions last week?', tool: 'find_students_without_transactions', args: { startDate: '2026-08-24', endDate: '2026-08-30', status: 'Approved', transactionType: 'Add', categoryContains: 'Homework' }, expected: /"Quill"/u },
  { id: 'comparison', question: 'Compare Fable’s approved Technology additions on August 27 and August 28, 2026.', tool: 'compare_periods', args: { studentRefs: ['student-001'], transactionType: 'Add', status: 'Approved', categoryContains: 'Technology', metric: 'amountTotal', firstStartDate: '2026-08-27', firstEndDate: '2026-08-27', secondStartDate: '2026-08-28', secondEndDate: '2026-08-28' }, expected: /\$5.00/u },
  { id: 'history', question: 'What was Fable’s closing balance on August 28, 2026?', tool: 'get_balance_history', args: { studentRefs: ['student-001'], startDate: '2026-08-28', endDate: '2026-08-28' }, expected: /\$12.00/u },
  { id: 'earnings', question: 'Who had the most and least money added last week?', tool: 'compare_student_earnings', args: { window: 'last-week' }, expected: /Most money added: "Fable" — \$6.00/u },
]
