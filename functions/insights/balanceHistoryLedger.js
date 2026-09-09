// Server-owned version chain. Firestore updateTime, NOT an editable transaction
// date or a browser clock, binds every witness to a particular student version.
// Missing/out-of-order events leave a gap and therefore an unavailable answer.
import { warn as logWarning } from 'node:console'

export const BALANCE_HISTORY_READ_LIMIT = 5000

// Only errors created by our event validator may be acknowledged as permanent.
// Database/SDK errors and unexpected exceptions must still reach the retry layer.
class PermanentBalanceHistoryError extends Error {
  constructor(message, reason) {
    super(message)
    this.reason = reason
  }
}

export function versionKey(timestamp) {
  if (!Number.isSafeInteger(timestamp?.seconds) || timestamp.seconds < 0 || timestamp.seconds > 253402300799 ||
      !Number.isInteger(timestamp.nanoseconds) || timestamp.nanoseconds < 0 || timestamp.nanoseconds >= 1e9) return null
  return `${String(timestamp.seconds).padStart(12, '0')}-${String(timestamp.nanoseconds).padStart(9, '0')}`
}

function versionDay(version, formatter) {
  if (!/^\d{12}-\d{9}$/.test(version ?? '')) return null
  const parts = formatter.formatToParts(new Date(Number(version.slice(0, 12)) * 1000))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function snapshotBalanceVersion(snapshot) {
  const value = snapshot?.data?.()
  return {
    studentId: String(snapshot?.id ?? ''), balance: value?.balance,
    version: versionKey(snapshot?.updateTime), incarnation: versionKey(snapshot?.createTime),
  }
}

export function makeBalanceWitness(event) {
  const { classroomId, studentId } = event.params ?? {}
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(classroomId ?? '') ||
      !/^[1-9]\d*$/.test(studentId ?? '') || !Number.isSafeInteger(Number(studentId))) {
    throw new PermanentBalanceHistoryError('Invalid balance-history identity.', 'invalid-identity')
  }
  const after = event.data?.after
  if (!after?.exists) return null // Only current-roster history is supported.
  const before = event.data.before
  const path = `classrooms/${classroomId}/students/${studentId}`
  if (after.ref?.path !== path || (before?.exists && before.ref?.path !== path)) {
    throw new PermanentBalanceHistoryError('Balance-history event path mismatch.', 'path-mismatch')
  }
  const next = snapshotBalanceVersion(after)
  const prior = before?.exists ? snapshotBalanceVersion(before) : null
  if (next.studentId !== studentId || String(after.data()?.id) !== studentId || !validState(next) ||
      (prior && (prior.studentId !== studentId || String(before.data()?.id) !== studentId || !validState(prior) ||
        prior.incarnation !== next.incarnation || prior.version >= next.version))) {
    throw new PermanentBalanceHistoryError('Invalid balance-history event state.', 'invalid-state')
  }
  return {
    schemaVersion: 1, classroomId, studentId, incarnation: next.incarnation,
    afterVersion: next.version, afterBalance: next.balance,
    beforeVersion: prior?.version ?? null, beforeBalance: prior?.balance ?? null,
  }
}

export async function recordBalanceWitness(event, { firestore, warn = logWarning }) {
  let witness
  try {
    witness = makeBalanceWitness(event)
  } catch (error) {
    if (!(error instanceof PermanentBalanceHistoryError)) throw error
    // No event, identity, balance, path or exception text in logs. Skipping a
    // malformed/equal-version event cannot manufacture a link in the chain.
    warn('Balance-history event skipped.', { reason: error.reason })
    return
  }
  if (!witness) return
  // Create-only, deterministic event identity: retries cannot duplicate or
  // overwrite history, and event delivery order is irrelevant.
  const root = firestore.collection('classrooms').doc(witness.classroomId)
  const ref = root.collection('balanceHistory').doc(`${witness.studentId}-${witness.afterVersion}`)
  try {
    await ref.create(witness)
  } catch (error) {
    if (error.code !== 6 && error.code !== 'already-exists') throw error
    const existing = (await ref.get()).data()
    if (!existing || Object.keys(existing).length !== Object.keys(witness).length ||
        Object.entries(witness).some(([key, value]) => existing[key] !== value)) {
      // Retrying this immutable event cannot fix a conflicting stored witness.
      // Keep the first record; never overwrite it or log its private contents.
      warn('Balance-history event skipped.', { reason: 'witness-conflict' })
      return
    }
  }
}

function validState(state) {
  return /^\d{12}-\d{9}$/.test(state?.version ?? '') && /^\d{12}-\d{9}$/.test(state?.incarnation ?? '') &&
    Number(state.version.slice(0, 12)) <= 253402300799 && state.incarnation <= state.version &&
    Number.isFinite(state.balance) && Math.abs(state.balance) <= 1_000_000
}

// Return only dates proved by a connected version chain, never a guessed zero.
// A current document older than the cutoff proves its balance was unchanged
// since then. Otherwise every intervening version must be witnessed. An older
// deployment without witnesses cannot establish a false continuity boundary.
export function resolveBalanceDays(current, records, { classroomId, dates, timeZone }) {
  const output = {}
  if (!validState(current)) return output
  const byVersion = new Map()
  for (const record of records) {
    if (!record || record.schemaVersion !== 1 || record.classroomId !== classroomId ||
        record.studentId !== current.studentId || record.incarnation !== current.incarnation) continue
    if (byVersion.has(record.afterVersion)) return output
    byVersion.set(record.afterVersion, record)
  }
  let version = current.version
  let balance = current.balance
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  for (const date of [...dates].sort().reverse()) {
    while (versionDay(version, formatter) > date) {
      const record = byVersion.get(version)
      if (!record || record.afterBalance !== balance ||
          !/^\d{12}-\d{9}$/.test(record.beforeVersion ?? '') ||
          record.beforeVersion >= version || record.beforeVersion < current.incarnation ||
          !Number.isFinite(record.beforeBalance) || Math.abs(record.beforeBalance) > 1_000_000) return output
      version = record.beforeVersion
      balance = record.beforeBalance
    }
    output[date] = balance
  }
  return output
}
