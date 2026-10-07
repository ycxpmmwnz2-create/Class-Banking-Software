// Server-reserved source semantics, classified before reporting reductions.
export function transactionClassification(transaction) {
  if (transaction.source === 'Opening Balance') return 'opening'
  if (transaction.source === 'Operator correction' ||
      (transaction.source === 'Teacher' && transaction.category === 'Balance adjustment')) return 'adjustment'
  return 'activity'
}
export function isReportingAdjustment(transaction) {
  return ['opening', 'adjustment'].includes(transaction.purpose ?? transactionClassification(transaction))
}
export function adjustmentTotals(transactions) {
  const totals = { opening: 0, adjustment: 0 }
  for (const row of transactions) {
    const kind = row.purpose ?? transactionClassification(row)
    if (row.status === 'Approved' && Object.hasOwn(totals, kind)) totals[kind] += (row.type === 'Subtract' ? -1 : 1) * row.amount
  }
  return totals
}
