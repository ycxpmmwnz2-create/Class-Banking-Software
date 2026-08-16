export const INSIGHTS_BUDGETS = Object.freeze({
  geminiMonthlyUsd: 7.5,
  firebaseMonthlyUsd: 5,
  combinedMonthlyUsd: 12.5,
});

export const INSIGHTS_PERIODS = Object.freeze([7, 30, 90]);

const PRIORITY_ORDER = Object.freeze({ attention: 0, notable: 1, context: 2 });
const QUICK_OBSERVATION_LIMIT = 4;
const LARGE_STUDENT_ADD_THRESHOLD = 20;
const STUDENT_SIGNATURE_FIELDS = Object.freeze(["id", "name", "balance"]);
const TRANSACTION_SIGNATURE_FIELDS = Object.freeze([
  "id",
  "studentId",
  "studentName",
  "date",
  "type",
  "amount",
  "reason",
  "status",
  "source",
]);

const TIME_WINDOWS = Object.freeze([
  Object.freeze({ id: "morning", label: "before 11:30 a.m.", start: 0, end: 11 * 60 + 30 }),
  Object.freeze({ id: "midday", label: "between 11:30 a.m. and 1:30 p.m.", start: 11 * 60 + 30, end: 13 * 60 + 30 }),
  Object.freeze({ id: "afternoon", label: "after 1:30 p.m.", start: 13 * 60 + 30, end: 24 * 60 }),
]);

function currency(value) {
  const hasCents = Math.round(value * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return count === 1 ? singular : pluralValue;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function studentKey(value) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeStudents(students) {
  if (!Array.isArray(students)) return [];
  return students.flatMap((student) => {
    const id = studentKey(student?.id);
    const balance = typeof student?.balance === "number" && Number.isFinite(student.balance)
      ? student.balance
      : null;
    if (id === null || balance === null) return [];
    const suppliedName = typeof student?.name === "string" ? student.name.trim() : "";
    return [{
      id,
      name: suppliedName || `Student ${id}`,
      balance,
    }];
  });
}

function normalizeTransactions(transactions, studentNames, cutoff, now) {
  if (!Array.isArray(transactions)) return [];
  const normalized = transactions.flatMap((transaction) => {
    const studentId = studentKey(transaction?.studentId);
    const date = validDate(transaction?.date);
    const amount = Number(transaction?.amount);
    if (
      studentId === null
      || !date
      || date < cutoff
      || date > now
      || !["Add", "Subtract"].includes(transaction?.type)
      || !Number.isFinite(amount)
      || amount <= 0
      || !["Pending", "Approved", "Denied"].includes(transaction?.status)
    ) {
      return [];
    }

    const suppliedName = typeof transaction?.studentName === "string"
      ? transaction.studentName.trim()
      : "";
    const reason = typeof transaction?.reason === "string" && transaction.reason.trim()
      ? transaction.reason.trim()
      : "Unspecified";

    const suppliedId = studentKey(transaction?.id);
    return [{
      id: suppliedId || `${studentId}-${date.getTime()}-${transaction.type}-${amount}`,
      studentId,
      studentName: suppliedName || studentNames.get(studentId) || `Student ${studentId}`,
      date,
      type: transaction.type,
      amount,
      reason,
      status: transaction.status,
      source: typeof transaction?.source === "string" ? transaction.source : "",
    }];
  });

  const seenTransactions = new Set();
  for (const transaction of normalized) {
    transaction.identityKey = JSON.stringify([
      transaction.id,
      transaction.studentId,
      transaction.studentName,
      transaction.date.getTime(),
      transaction.type,
      transaction.amount,
      transaction.reason,
      transaction.status,
      transaction.source,
    ]);
  }
  return normalized.filter((transaction) => {
    if (seenTransactions.has(transaction.identityKey)) return false;
    seenTransactions.add(transaction.identityKey);
    delete transaction.identityKey;
    return true;
  });
}

function timeWindowFor(date) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return TIME_WINDOWS.find((window) => minutes >= window.start && minutes < window.end)
    || TIME_WINDOWS[TIME_WINDOWS.length - 1];
}

function formatEvidenceDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function largeStudentAddObservations(transactions) {
  return transactions
    .filter((transaction) => (
      transaction.source === "Student"
      && transaction.type === "Add"
      && transaction.status === "Pending"
      && transaction.amount >= LARGE_STUDENT_ADD_THRESHOLD
    ))
    .sort((left, right) => right.amount - left.amount || right.date - left.date)
    .slice(0, 3)
    .map((transaction) => ({
      id: `large-student-add-${transaction.studentId}-${transaction.id}`,
      priority: "attention",
      category: "Needs attention",
      title: `${currency(transaction.amount)} Add Money request meets review threshold`,
      summary: `${transaction.studentName} submitted an Add Money request at or above the ${currency(LARGE_STUDENT_ADD_THRESHOLD)} review threshold.`,
      evidence: `${transaction.reason} · Pending · Student submitted · ${formatEvidenceDate(transaction.date)}`,
      studentId: transaction.studentId,
    }));
}

function repeatedRequestObservations(transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    if (transaction.source !== "Student") continue;
    const key = [
      transaction.studentId,
      transaction.type,
      transaction.amount,
      transaction.reason.toLocaleLowerCase("en-US"),
    ].join("\u0000");
    const group = groups.get(key) || [];
    group.push(transaction);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((group) => group.length >= 3)
    .sort((left, right) => right.length - left.length || right[0].amount - left[0].amount)
    .slice(0, 3)
    .map((group) => {
      const sample = group[0];
      return {
        id: `repeated-request-${sample.studentId}-${sample.type}-${sample.amount}-${sample.reason}`,
        priority: "notable",
        category: "Request patterns",
        title: "Repeated student request",
        summary: `${sample.studentName} submitted the same ${currency(sample.amount)} ${sample.type} request ${group.length} times during this period.`,
        evidence: `${sample.reason} · ${group.length} matching ${plural(group.length, "request")}`,
        studentId: sample.studentId,
      };
    });
}

function balanceObservations(students) {
  if (students.length === 0) return [];
  const typicalBalance = median(students.map((student) => student.balance));
  const distanceThreshold = Math.max(20, Math.abs(typicalBalance));
  const observations = [];

  const negativeBalances = students
    .filter((student) => student.balance < 0)
    .sort((left, right) => left.balance - right.balance);
  for (const student of negativeBalances.slice(0, 2)) {
    observations.push({
      id: `negative-balance-${student.id}`,
      priority: "attention",
      category: "Balance anomalies",
      title: "Negative current balance",
      summary: `${student.name}'s current balance is ${currency(student.balance)}.`,
      evidence: `Class median: ${currency(typicalBalance)} · Difference: ${currency(student.balance - typicalBalance)}`,
      studentId: student.id,
    });
  }

  if (students.length >= 3) {
    const high = [...students].sort((left, right) => right.balance - left.balance)[0];
    if (high.balance - typicalBalance >= distanceThreshold) {
      observations.push({
        id: `high-balance-${high.id}`,
        priority: "notable",
        category: "Balance anomalies",
        title: "Balance well above the class midpoint",
        summary: `${high.name}'s ${currency(high.balance)} balance is notably above the current class median.`,
        evidence: `Class median: ${currency(typicalBalance)} · Difference: +${currency(high.balance - typicalBalance)}`,
        studentId: high.id,
      });
    }

    const low = students
      .filter((student) => student.balance >= 0)
      .sort((left, right) => left.balance - right.balance)[0];
    if (low && typicalBalance - low.balance >= distanceThreshold) {
      observations.push({
        id: `low-balance-${low.id}`,
        priority: "notable",
        category: "Balance anomalies",
        title: "Balance well below the class midpoint",
        summary: `${low.name}'s ${currency(low.balance)} balance is notably below the current class median.`,
        evidence: `Class median: ${currency(typicalBalance)} · Difference: ${currency(low.balance - typicalBalance)}`,
        studentId: low.id,
      });
    }
  }

  return observations;
}

function timingObservation(transactions, type) {
  const matching = transactions.filter((transaction) => (
    transaction.status === "Approved" && transaction.type === type
  ));
  if (matching.length < 2) return null;

  const windows = new Map(TIME_WINDOWS.map((window) => [window.id, {
    ...window,
    count: 0,
    total: 0,
  }]));
  for (const transaction of matching) {
    const window = windows.get(timeWindowFor(transaction.date).id);
    window.count += 1;
    window.total += transaction.amount;
  }

  const dominant = [...windows.values()]
    .filter((window) => window.count >= 2)
    .sort((left, right) => right.total - left.total || right.count - left.count)[0];
  if (!dominant) return null;

  const action = type === "Add" ? "added" : "deducted";
  const noun = type === "Add" ? "earning" : "spending";
  return {
    id: `timing-${type.toLocaleLowerCase("en-US")}-${dominant.id}`,
    priority: "context",
    category: "Timing patterns",
    title: `${type === "Add" ? "Earning" : "Spending"} clusters ${dominant.label}`,
    summary: `${currency(dominant.total)} was ${action} across ${dominant.count} approved ${plural(dominant.count, "transaction")} ${dominant.label}${dominant.label.endsWith(".") ? "" : "."}`,
    evidence: `${dominant.count} of ${matching.length} approved ${noun} ${plural(matching.length, "transaction")} in this period`,
  };
}

function classMovementObservation(transactions, days) {
  const approved = transactions.filter((transaction) => transaction.status === "Approved");
  const added = approved
    .filter((transaction) => transaction.type === "Add")
    .reduce((total, transaction) => total + transaction.amount, 0);
  const subtracted = approved
    .filter((transaction) => transaction.type === "Subtract")
    .reduce((total, transaction) => total + transaction.amount, 0);
  const net = added - subtracted;
  if (approved.length === 0) return null;

  const direction = net === 0 ? "held steady" : net > 0 ? "increased" : "decreased";
  return {
    id: "class-money-movement",
    priority: "context",
    category: "Classwide trends",
    title: `Class cash ${direction}`,
    summary: `Approved activity produced a net ${net >= 0 ? "+" : "−"}${currency(Math.abs(net))} movement over ${days} days.`,
    evidence: `${currency(added)} added · ${currency(subtracted)} subtracted · ${approved.length} approved ${plural(approved.length, "transaction")}`,
  };
}

function pendingVolumeObservation(transactions) {
  const pending = transactions.filter((transaction) => transaction.status === "Pending");
  if (pending.length === 0) return null;
  const pendingAdds = pending.filter((transaction) => transaction.type === "Add");
  const pendingSubtracts = pending.filter((transaction) => transaction.type === "Subtract");
  const addTotal = pendingAdds.reduce((sum, transaction) => sum + transaction.amount, 0);
  const subtractTotal = pendingSubtracts.reduce((sum, transaction) => sum + transaction.amount, 0);
  const total = addTotal + subtractTotal;
  const summary = pendingAdds.length > 0 && pendingSubtracts.length > 0
    ? `${currency(total)} in gross request volume is currently waiting for teacher review.`
    : pendingAdds.length > 0
      ? `${currency(addTotal)} in Add Money requests is currently waiting for teacher review.`
      : `${currency(subtractTotal)} in Subtract Money requests is currently waiting for teacher review.`;
  return {
    id: "pending-request-volume",
    priority: "context",
    category: "Request patterns",
    title: `${pending.length} pending ${plural(pending.length, "request")}`,
    summary,
    evidence: `${pendingAdds.length} Add · ${pendingSubtracts.length} Subtract · ${pending.filter((transaction) => transaction.source === "Student").length} student-submitted`,
  };
}

function compareObservations(left, right) {
  return (PRIORITY_ORDER[left.priority] ?? 99) - (PRIORITY_ORDER[right.priority] ?? 99)
    || left.category.localeCompare(right.category)
    || left.title.localeCompare(right.title);
}

function normalizePeriod(days) {
  const numeric = Number(days);
  return INSIGHTS_PERIODS.includes(numeric) ? numeric : 30;
}

function normalizeMode(mode) {
  return mode === "deep" ? "deep" : "quick";
}

export function buildInsightsDataSignature({ students = [], transactions = [] } = {}) {
  const stableRows = (records, fields) => (Array.isArray(records) ? records : [])
    .map((record) => fields.map((field) => record?.[field] ?? null))
    .sort((left, right) => {
      const leftValue = JSON.stringify(left);
      const rightValue = JSON.stringify(right);
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });
  return JSON.stringify({
    students: stableRows(students, STUDENT_SIGNATURE_FIELDS),
    transactions: stableRows(transactions, TRANSACTION_SIGNATURE_FIELDS),
  });
}

export function buildClassInsightsReport({
  students = [],
  transactions = [],
  days = 30,
  mode = "quick",
  now = new Date(),
} = {}) {
  const generatedAt = validDate(now) || new Date();
  const periodDays = normalizePeriod(days);
  const reportMode = normalizeMode(mode);
  const cutoff = new Date(generatedAt.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const normalizedStudents = normalizeStudents(students);
  const studentNames = new Map(normalizedStudents.map((student) => [student.id, student.name]));
  const periodTransactions = normalizeTransactions(
    transactions,
    studentNames,
    cutoff,
    generatedAt,
  );

  const observations = [
    ...largeStudentAddObservations(periodTransactions),
    ...repeatedRequestObservations(periodTransactions),
    ...balanceObservations(normalizedStudents),
    timingObservation(periodTransactions, "Subtract"),
    timingObservation(periodTransactions, "Add"),
    pendingVolumeObservation(periodTransactions),
    classMovementObservation(periodTransactions, periodDays),
  ].filter(Boolean).sort(compareObservations);

  if (observations.length === 0) {
    observations.push({
      id: "no-noteworthy-activity",
      priority: "context",
      category: "Classwide trends",
      title: "Nothing noteworthy yet",
      summary: `There is not enough valid activity in the last ${periodDays} days to identify a useful pattern.`,
      evidence: `${normalizedStudents.length} ${plural(normalizedStudents.length, "student")} · ${periodTransactions.length} valid ${plural(periodTransactions.length, "transaction")}`,
    });
  }

  const selected = reportMode === "deep"
    ? observations
    : observations.slice(0, QUICK_OBSERVATION_LIMIT);
  const approved = periodTransactions.filter((transaction) => transaction.status === "Approved");
  const pending = periodTransactions.filter((transaction) => transaction.status === "Pending");

  return Object.freeze({
    source: "local-preview",
    mode: reportMode,
    days: periodDays,
    generatedAt: generatedAt.toISOString(),
    estimatedApiCostUsd: 0,
    totalObservationCount: observations.length,
    observations: Object.freeze(selected.map((observation) => Object.freeze({ ...observation }))),
    metrics: Object.freeze({
      studentCount: normalizedStudents.length,
      transactionCount: periodTransactions.length,
      approvedCount: approved.length,
      pendingCount: pending.length,
      totalClassCash: normalizedStudents.reduce((total, student) => total + student.balance, 0),
    }),
  });
}
