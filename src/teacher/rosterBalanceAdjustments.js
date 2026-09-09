// Pure preparation only. The caller saves the returned balance and ledger in
// ONE existing tenant-saver transaction (which also rebuilds student mirrors).
export function applyRosterBalanceEdits(data, edits, { now = Date.now(), reason = 'Roster balance adjustment' } = {}) {
  if (!Array.isArray(edits) || !Array.isArray(data.students) || !Array.isArray(data.transactions)) {
    throw new Error('The roster could not be read. Reload before changing balances.');
  }
  const targets = new Map();
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.studentId) || edit.studentId <= 0 || targets.has(edit.studentId)) {
      throw new Error('Choose each student only once.');
    }
    targets.set(edit.studentId, cents(edit.balance));
  }
  if ([...targets.keys()].some(id => !data.students.some(student => student.id === id))) {
    throw new Error('A student is no longer in the roster. Reload and try again.');
  }
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isFinite(new Date(now).getTime())) {
    throw new Error('The adjustment date is invalid.');
  }
  let nextId = now;
  for (const transaction of data.transactions) {
    if (!Number.isSafeInteger(transaction.id) || transaction.id <= 0) {
      throw new Error('Transaction history is invalid. Reload before changing balances.');
    }
    nextId = Math.max(nextId, transaction.id + 1);
  }
  const additions = [];
  const students = data.students.map(student => {
    if (!targets.has(student.id)) return student;
    const before = cents(student.balance);
    const after = targets.get(student.id);
    const delta = after - before;
    if (delta === 0) return student;
    if (!Number.isSafeInteger(nextId) || Math.abs(delta) > 100_000_000) {
      throw new Error('The balance adjustment is too large.');
    }
    additions.push({
      id: nextId++, date: new Date(now).toISOString(),
      studentId: student.id, studentName: student.name,
      type: delta > 0 ? 'Add' : 'Subtract', amount: Math.abs(delta) / 100,
      reason, category: 'Balance adjustment',
      memo: `Balance changed from ${(before / 100).toFixed(2)} to ${(after / 100).toFixed(2)}. This is an adjustment, not earned money or a purchase.`,
      status: 'Approved', source: 'Teacher',
    });
    return { ...student, balance: after / 100 };
  });
  return { ...data, students, transactions: additions.concat(data.transactions) };
}

function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000 ||
      Math.abs(value * 100 - Math.round(value * 100)) > 0.0000001) {
    throw new Error('Enter a balance with at most two decimal places between -$1,000,000 and $1,000,000.');
  }
  return Math.round(value * 100);
}
