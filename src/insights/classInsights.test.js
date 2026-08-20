import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  buildClassInsightsReport,
  buildInsightsDataSignature,
  INSIGHTS_BUDGETS,
  INSIGHTS_PERIODS,
} from "./classInsights.js";

const NOW = new Date(2026, 7, 16, 15, 0, 0);

function transaction(overrides = {}) {
  return {
    id: overrides.id ?? Math.random(),
    date: overrides.date ?? new Date(2026, 7, 16, 10, 0, 0).toISOString(),
    studentId: overrides.studentId ?? 1,
    studentName: overrides.studentName ?? "Alex",
    type: overrides.type ?? "Add",
    amount: overrides.amount ?? 5,
    reason: overrides.reason ?? "Class Job",
    status: overrides.status ?? "Approved",
    source: overrides.source ?? "Student",
  };
}

function report(overrides = {}) {
  return buildClassInsightsReport({
    students: overrides.students ?? [
      { id: 1, name: "Alex", balance: 10 },
      { id: 2, name: "Blair", balance: 12 },
      { id: 3, name: "Casey", balance: 11 },
    ],
    transactions: overrides.transactions ?? [],
    days: overrides.days ?? 30,
    mode: overrides.mode ?? "deep",
    now: overrides.now ?? NOW,
  });
}

test("pins the approved Gemini, Firebase, and combined monthly allowances", () => {
  assert.deepEqual(INSIGHTS_BUDGETS, {
    geminiMonthlyUsd: 7.5,
    firebaseMonthlyUsd: 5,
    combinedMonthlyUsd: 12.5,
  });
  assert.deepEqual(INSIGHTS_PERIODS, [7, 30, 90]);
});

test("flags a student-originated pending Add request at the $20 threshold", () => {
  const result = report({
    transactions: [transaction({
      id: "large-add",
      amount: 20,
      status: "Pending",
      source: "Student",
      reason: "Going Above and Beyond",
    })],
  });

  const observation = result.observations.find((item) => item.id === "large-student-add-1-large-add");
  assert.ok(observation);
  assert.equal(observation.priority, "attention");
  assert.equal(observation.title, "$20 Add Money request meets review threshold");
  assert.doesNotMatch(observation.title, /unusual/i);
  assert.match(observation.summary, /Alex submitted/);
  assert.match(observation.evidence, /Pending · Student submitted/);
});

test("pending-request evidence is independent of the Functions process timezone", () => {
  const originalTimeZone = process.env.TZ;
  const evidenceForTimeZone = (timeZone) => {
    process.env.TZ = timeZone;
    const localHour = new Date("2026-08-19T02:30:00.000Z").getHours();
    const result = report({
      now: new Date("2026-08-20T00:00:00.000Z"),
      transactions: [transaction({
        id: "timezone-boundary",
        date: "2026-08-19T02:30:00.000Z",
        amount: 20,
        status: "Pending",
        source: "Student",
        reason: "Chores",
      })],
    });
    return {
      evidence: result.observations.find(
        item => item.id === "large-student-add-1-timezone-boundary",
      )?.evidence,
      localHour,
    };
  };

  try {
    const utc = evidenceForTimeZone("UTC");
    const denver = evidenceForTimeZone("America/Denver");
    assert.equal(utc.localHour, 2);
    assert.equal(denver.localHour, 20);
    assert.notEqual(denver.localHour, utc.localHour);
    assert.equal(utc.evidence, "Chores · Pending · Student submitted");
    assert.equal(denver.evidence, utc.evidence);
    assert.doesNotMatch(utc.evidence, /\b(?:AM|PM|UTC)\b|Aug 1[89]/);
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
});

test("does not treat teacher credits or approved student credits as pending-request anomalies", () => {
  const result = report({
    transactions: [
      transaction({ id: "teacher", amount: 50, status: "Pending", source: "Teacher" }),
      transaction({ id: "approved", amount: 50, status: "Approved", source: "Student" }),
    ],
  });

  assert.equal(result.observations.some((item) => item.id.startsWith("large-student-add-")), false);
});

test("identifies a repeated same-student request without combining different students", () => {
  const matching = [1, 2, 3].map((id) => transaction({
    id,
    studentId: 1,
    amount: 5,
    reason: "Class Job",
    status: "Pending",
  }));
  const otherStudent = transaction({
    id: 4,
    studentId: 2,
    studentName: "Blair",
    amount: 5,
    reason: "Class Job",
    status: "Pending",
  });

  const result = report({ transactions: [...matching, otherStudent] });
  const observation = result.observations.find((item) => item.id.startsWith("repeated-request-1-"));
  assert.ok(observation);
  assert.match(observation.summary, /3 times/);
  assert.doesNotMatch(observation.summary, /4 times/);
});

test("reports the predominant approved spending and earning time windows", () => {
  const result = report({
    transactions: [
      transaction({ id: 1, type: "Subtract", amount: 8, date: new Date(2026, 7, 16, 14, 0).toISOString() }),
      transaction({ id: 2, type: "Subtract", amount: 7, date: new Date(2026, 7, 16, 14, 30).toISOString() }),
      transaction({ id: 3, type: "Subtract", amount: 2, date: new Date(2026, 7, 16, 9, 0).toISOString() }),
      transaction({ id: 4, type: "Add", amount: 6, date: new Date(2026, 7, 16, 10, 0).toISOString() }),
      transaction({ id: 5, type: "Add", amount: 5, date: new Date(2026, 7, 16, 10, 30).toISOString() }),
    ],
  });

  const spending = result.observations.find((item) => item.id === "timing-subtract-afternoon");
  const earning = result.observations.find((item) => item.id === "timing-add-morning");
  assert.ok(spending);
  assert.match(spending.summary, /^\$15 was deducted across 2 approved transactions after 1:30 p\.m\.$/);
  assert.ok(earning);
  assert.match(earning.summary, /^\$11 was added across 2 approved transactions before 11:30 a\.m\.$/);
});

test("requires at least two transactions in a time window before calling it a cluster", () => {
  const result = report({
    transactions: [
      transaction({ id: "large-morning", type: "Add", amount: 100, date: new Date(2026, 7, 16, 9, 0).toISOString() }),
      transaction({ id: "afternoon-one", type: "Add", amount: 4, date: new Date(2026, 7, 16, 14, 0).toISOString() }),
      transaction({ id: "afternoon-two", type: "Add", amount: 4, date: new Date(2026, 7, 16, 14, 30).toISOString() }),
    ],
  });

  assert.equal(result.observations.some((item) => item.id === "timing-add-morning"), false);
  assert.ok(result.observations.some((item) => item.id === "timing-add-afternoon"));
});

test("finds current balance outliers while keeping the explanation evidence-based", () => {
  const result = report({
    students: [
      { id: 1, name: "Alex", balance: 10 },
      { id: 2, name: "Blair", balance: 11 },
      { id: 3, name: "Casey", balance: 12 },
      { id: 4, name: "Drew", balance: 60 },
      { id: 5, name: "Emery", balance: -5 },
    ],
  });

  const high = result.observations.find((item) => item.id === "high-balance-4");
  const negative = result.observations.find((item) => item.id === "negative-balance-5");
  assert.ok(high);
  assert.match(high.summary, /current class median/);
  assert.ok(negative);
  assert.match(negative.summary, /current balance is -\$5/);
});

test("can report a low non-negative balance even when other students are negative", () => {
  const result = report({
    students: [
      { id: 1, name: "A", balance: -50 },
      { id: 2, name: "B", balance: -40 },
      { id: 3, name: "C", balance: 0 },
      { id: 4, name: "D", balance: 50 },
      { id: 5, name: "E", balance: 52 },
      { id: 6, name: "F", balance: 54 },
      { id: 7, name: "G", balance: 120 },
    ],
  });

  assert.ok(result.observations.some((item) => item.id === "low-balance-3"));
  assert.ok(result.observations.some((item) => item.id === "negative-balance-1"));
});

test("excludes unknown legacy balances instead of converting them to zero", () => {
  const result = report({
    students: [
      { id: 1, name: "Known A", balance: 40 },
      { id: 2, name: "Known B", balance: 42 },
      { id: 3, name: "Known C", balance: 44 },
      { id: 4, name: "Null", balance: null },
      { id: 5, name: "Blank", balance: "" },
      { id: 6, name: "Array", balance: [] },
      { id: 7, name: "Missing" },
    ],
  });

  assert.equal(result.metrics.studentCount, 3);
  assert.equal(result.metrics.totalClassCash, 126);
  assert.equal(result.observations.some((item) => /balance-(4|5|6|7)$/.test(item.id)), false);
  assert.ok(result.observations[0].evidence.includes("3 students"));
});

test("filters malformed, future, and outside-period transactions", () => {
  const result = report({
    days: 7,
    transactions: [
      transaction({ id: "valid", status: "Pending", amount: 20 }),
      transaction({ id: "bad-date", date: "not-a-date", status: "Pending", amount: 100 }),
      transaction({ id: "future", date: new Date(2026, 7, 17, 10).toISOString(), status: "Pending", amount: 100 }),
      transaction({ id: "old", date: new Date(2026, 6, 1, 10).toISOString(), status: "Pending", amount: 100 }),
      transaction({ id: "bad-amount", amount: -20, status: "Pending" }),
      transaction({ id: "bad-type", type: "Credit", status: "Pending", amount: 100 }),
    ],
  });

  assert.equal(result.metrics.transactionCount, 1);
  assert.equal(result.metrics.pendingCount, 1);
  assert.ok(result.observations.some((item) => item.id === "large-student-add-1-valid"));
});

test("preserves cents in evidence and rejects blank or non-finite student IDs", () => {
  const result = report({
    transactions: [
      transaction({ id: "cents", amount: 20.25, status: "Pending" }),
      transaction({ id: "blank-id", studentId: "   ", amount: 100, status: "Pending" }),
      transaction({ id: "nan-id", studentId: Number.NaN, amount: 100, status: "Pending" }),
    ],
  });

  assert.equal(result.metrics.transactionCount, 1);
  const observation = result.observations.find((item) => item.id === "large-student-add-1-cents");
  assert.ok(observation);
  assert.match(observation.title, /\$20\.25 Add Money request/);
});

test("collapses field-identical transaction copies to one real transaction", () => {
  const duplicated = [1, 2, 3].map(() => transaction({
    id: "same-transaction",
    amount: 25,
    status: "Pending",
    source: "Student",
  }));
  const result = report({ transactions: duplicated });

  assert.equal(result.metrics.transactionCount, 1);
  assert.equal(result.metrics.pendingCount, 1);
  assert.equal(result.observations.filter((item) => item.id.startsWith("large-student-add-")).length, 1);
  assert.equal(result.observations.some((item) => item.id.startsWith("repeated-request-")), false);
});

test("keeps distinct transactions that happen to share one timestamp ID", () => {
  const result = report({
    transactions: [
      transaction({ id: "shared-id", studentId: 1, studentName: "Alex", amount: 25, reason: "First", status: "Pending" }),
      transaction({ id: "shared-id", studentId: 2, studentName: "Blair", amount: 40, reason: "Second", status: "Pending" }),
    ],
  });

  assert.equal(result.metrics.transactionCount, 2);
  assert.equal(result.metrics.pendingCount, 2);
  const attentionStudents = result.observations
    .filter((item) => item.id.startsWith("large-student-add-"))
    .map((item) => item.studentId)
    .sort();
  assert.deepEqual(attentionStudents, ["1", "2"]);
  const pending = result.observations.find((item) => item.id === "pending-request-volume");
  assert.equal(pending.summary, "$65 in Add Money requests is currently waiting for teacher review.");
});

test("labels mixed pending directions as gross request volume", () => {
  const result = report({
    transactions: [
      transaction({ id: "pending-add", type: "Add", amount: 10, status: "Pending" }),
      transaction({ id: "pending-subtract", type: "Subtract", amount: 5, status: "Pending" }),
    ],
  });
  const observation = result.observations.find((item) => item.id === "pending-request-volume");

  assert.ok(observation);
  assert.equal(observation.summary, "$15 in gross request volume is currently waiting for teacher review.");
  assert.equal(observation.evidence, "1 Add · 1 Subtract · 2 student-submitted");
});

test("Quick Insights stays compact while Deep Analysis reveals the fuller set", () => {
  const transactions = [
    transaction({ id: 1, amount: 20, status: "Pending" }),
    transaction({ id: 2, amount: 25, status: "Pending", studentId: 2, studentName: "Blair" }),
    transaction({ id: 3, amount: 30, status: "Pending", studentId: 3, studentName: "Casey" }),
    transaction({ id: 4, type: "Subtract", amount: 8, date: new Date(2026, 7, 16, 14, 0).toISOString() }),
    transaction({ id: 5, type: "Subtract", amount: 7, date: new Date(2026, 7, 16, 14, 30).toISOString() }),
    transaction({ id: 6, type: "Add", amount: 4, date: new Date(2026, 7, 16, 10, 0).toISOString() }),
    transaction({ id: 7, type: "Add", amount: 4, date: new Date(2026, 7, 16, 10, 30).toISOString() }),
  ];

  const quick = report({ transactions, mode: "quick" });
  const deep = report({ transactions, mode: "deep" });
  assert.equal(quick.observations.length, 4);
  assert.ok(deep.observations.length > quick.observations.length);
  assert.equal(quick.totalObservationCount, deep.totalObservationCount);
});

test("Deep Analysis returns every generated observation without a hidden limit", () => {
  const students = [
    { id: 1, name: "A", balance: -50 },
    { id: 2, name: "B", balance: -40 },
    { id: 3, name: "C", balance: 0 },
    { id: 4, name: "D", balance: 50 },
    { id: 5, name: "E", balance: 52 },
    { id: 6, name: "F", balance: 54 },
    { id: 7, name: "G", balance: 120 },
  ];
  const transactions = [
    ...[0, 1, 2].map((offset) => transaction({
      id: `large-${offset}`,
      studentId: offset + 1,
      amount: 20 + offset,
      reason: `Large ${offset}`,
      status: "Pending",
    })),
    ...[0, 1, 2].flatMap((group) => [0, 1, 2].map((offset) => transaction({
      id: `repeat-${group}-${offset}`,
      studentId: group + 1,
      type: "Subtract",
      amount: 5 + group,
      reason: `Repeat ${group}`,
      status: "Pending",
    }))),
    transaction({ id: "subtract-a", studentId: 4, type: "Subtract", amount: 8, date: new Date(2026, 7, 16, 14, 0).toISOString() }),
    transaction({ id: "subtract-b", studentId: 5, type: "Subtract", amount: 7, date: new Date(2026, 7, 16, 14, 30).toISOString() }),
    transaction({ id: "add-a", studentId: 4, type: "Add", amount: 8, date: new Date(2026, 7, 16, 10, 0).toISOString() }),
    transaction({ id: "add-b", studentId: 5, type: "Add", amount: 7, date: new Date(2026, 7, 16, 10, 30).toISOString() }),
  ];
  const result = report({ students, transactions, mode: "deep" });

  assert.ok(result.totalObservationCount > 12);
  assert.equal(result.observations.length, result.totalObservationCount);
});

test("classroom-data signatures ignore record ordering but change with report evidence", () => {
  const students = [
    { id: 1, name: "Alex", balance: 10 },
    { id: 2, name: "Blair", balance: 20 },
  ];
  const transactions = [
    transaction({ id: "a", studentId: 1, amount: 5, status: "Pending" }),
    transaction({ id: "b", studentId: 2, amount: 4, status: "Approved" }),
  ];
  const baseline = buildInsightsDataSignature({ students, transactions });

  assert.equal(
    buildInsightsDataSignature({ students: [...students].reverse(), transactions: [...transactions].reverse() }),
    baseline,
  );
  assert.notEqual(
    buildInsightsDataSignature({
      students: [{ ...students[0], balance: 11 }, students[1]],
      transactions,
    }),
    baseline,
  );
  assert.notEqual(
    buildInsightsDataSignature({
      students,
      transactions: [{ ...transactions[0], status: "Approved" }, transactions[1]],
    }),
    baseline,
  );
});

test("local previews always report zero API cost and do not mutate inputs", () => {
  const students = [{ id: 1, name: "Alex", balance: 10 }];
  const transactions = [transaction({ id: 1 })];
  const before = JSON.stringify({ students, transactions });

  const result = report({ students, transactions });

  assert.equal(result.source, "local-preview");
  assert.equal(result.estimatedApiCostUsd, 0);
  assert.equal(JSON.stringify({ students, transactions }), before);
});

test("returns a calm empty state when there is not enough valid activity", () => {
  const result = report({ students: [], transactions: [] });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].id, "no-noteworthy-activity");
  assert.match(result.observations[0].summary, /not enough valid activity/);
});
