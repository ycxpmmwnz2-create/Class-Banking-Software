// Queue decisions, not snapshots: each job is prepared from the last confirmed
// classroom state. No optimistic balance/status changes or automatic retries.
export function createApprovalQueue({ capture, isCurrent, getData, save, publish, notify, changed }) {
  const jobs = [];
  const pending = new Set();
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (jobs.length) {
        const job = jobs[0];
        if (!isCurrent(job.identity)) break;
        const before = getData();
        const stamp = JSON.stringify(before);
        let prepared;
        let committed = false;
        try {
          prepared = job.prepare(JSON.parse(stamp));
          if (prepared) {
            const result = await save(prepared.data);
            if (!isCurrent(job.identity)) break;
            if (!result?.executed) {
              if (result?.reason === 'concurrent-classroom-change' && result.reloaded === true) {
                notify('The classroom was reloaded after another change. Remaining decisions were stopped; review the pending requests and try again.', { requiresRefresh: false });
              } else {
                notify('The request could not be confirmed. Remaining decisions were stopped. Refresh the classroom before retrying.', { requiresRefresh: true });
              }
              break;
            }
            committed = true;
            // Another local load or mutation must never be overwritten by a
            // completed approval. The committed result can be recovered by reload.
            if (getData() !== before || JSON.stringify(getData()) !== stamp) {
              notify('The decision was saved, but the classroom changed during the save. Remaining decisions were stopped. Refresh before processing more requests.', { requiresRefresh: true });
              break;
            }
            publish(prepared.data);
            notify(prepared.message);
          }
        } catch {
          if (isCurrent(job.identity)) notify(committed
            ? 'The decision was saved, but its display could not be updated. Remaining decisions were stopped. Refresh before processing more requests.'
            : 'The request could not be confirmed. Remaining decisions were stopped. Refresh the classroom before retrying.',
          { requiresRefresh: true });
          break;
        }
        jobs.shift();
        job.ids.forEach(id => pending.delete(id));
        changed();
      }
    } finally {
      jobs.length = 0;
      pending.clear();
      running = false;
      changed();
    }
  }
  return {
    get busy() { return running || jobs.length > 0; },
    has: id => Boolean(jobs.length && isCurrent(jobs[0].identity) && pending.has(id)),
    enqueue(ids, prepare) {
      if (!ids.length || ids.some(id => pending.has(id)) ||
          (jobs.length && !isCurrent(jobs[0].identity))) return false;
      const identity = capture();
      ids.forEach(id => pending.add(id));
      jobs.push({ ids, prepare, identity });
      changed();
      void drain();
      return true;
    },
  };
}

export function prepareApprovalDecision(data, ids, status, confirmNegative = () => false) {
  const wanted = new Set(ids);
  const targets = data.transactions.filter(t => wanted.has(t.id) && t.status === 'Pending');
  if (!targets.length) return null;
  for (const transaction of targets) {
    const student = data.students.find(s => s.id === transaction.studentId);
    if (!student || !['Add', 'Subtract'].includes(transaction.type) ||
        !Number.isFinite(transaction.amount) || transaction.amount <= 0 ||
        !Number.isFinite(student.balance)) throw new Error('Invalid pending request');
    if (status === 'Approved') {
      if (transaction.type === 'Subtract' && transaction.amount > student.balance && !confirmNegative(student)) return null;
      student.balance += transaction.type === 'Add' ? transaction.amount : -transaction.amount;
    } else if (status !== 'Denied') throw new Error('Invalid decision');
    transaction.status = status;
  }
  return { data, message: `${targets.length} request(s) ${status === 'Approved' ? 'approved' : 'denied'}.` };
}
