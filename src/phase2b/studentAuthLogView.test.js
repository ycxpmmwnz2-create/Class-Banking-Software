import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatStudentAuthLogTimestamp,
  studentAuthLogOutcomeLabel,
  studentAuthLogResultLabel,
  studentAuthLogStudentLabel
} from "./studentAuthLogView.js";

test("formats current numeric timestamps and legacy Firestore timestamps", () => {
  const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5);
  const expected = new Date(timestamp).toLocaleString();

  assert.equal(formatStudentAuthLogTimestamp(timestamp), expected);
  assert.equal(
    formatStudentAuthLogTimestamp({ toDate: () => new Date(timestamp) }),
    expected
  );
  assert.equal(formatStudentAuthLogTimestamp(new Date(timestamp)), expected);
  assert.equal(formatStudentAuthLogTimestamp(Number.NaN), "Unknown time");
  assert.equal(formatStudentAuthLogTimestamp(null), "Unknown time");
  assert.equal(
    formatStudentAuthLogTimestamp({ toDate: () => { throw new Error("bad timestamp"); } }),
    "Unknown time"
  );
});

test("maps current outcomes and migrated legacy reasons to teacher-friendly labels", () => {
  assert.equal(studentAuthLogOutcomeLabel({ outcome: "success" }), "Authenticated");
  assert.equal(studentAuthLogOutcomeLabel({ outcome: "invalid_credentials" }), "Invalid credentials");
  assert.equal(studentAuthLogOutcomeLabel({ outcome: "locked" }), "Account temporarily locked");
  assert.equal(studentAuthLogOutcomeLabel({ outcome: "throttled" }), "Too many attempts");
  assert.equal(studentAuthLogOutcomeLabel({ reason: "invalid_credentials" }), "Invalid credentials");
  assert.equal(studentAuthLogOutcomeLabel({ outcome: "unrecognized" }), "Unknown outcome");
  assert.equal(studentAuthLogOutcomeLabel(null), "Unknown outcome");
});

test("labels results without treating a missing boolean as a failure", () => {
  assert.equal(studentAuthLogResultLabel(true), "Success");
  assert.equal(studentAuthLogResultLabel(false), "Failure");
  assert.equal(studentAuthLogResultLabel(undefined), "Unknown");
});

test("resolves a student name from the teacher roster without requiring a login ID", () => {
  const students = [
    { id: 1, name: "Michael Jordan" },
    { id: "2", name: "Serena Williams" }
  ];

  assert.equal(
    studentAuthLogStudentLabel({ studentId: "1" }, students),
    "Michael Jordan (ID 1)"
  );
  assert.equal(
    studentAuthLogStudentLabel({ studentId: 2 }, students),
    "Serena Williams (ID 2)"
  );
  assert.equal(
    studentAuthLogStudentLabel({ studentId: "3" }, students),
    "Student ID 3"
  );
  assert.equal(studentAuthLogStudentLabel({}, students), "Unknown student");
  assert.equal(studentAuthLogStudentLabel({ studentId: {} }, students), "Unknown student");
});
