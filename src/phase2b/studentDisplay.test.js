import { test } from "node:test";
import assert from "node:assert/strict";

import { sortStudentsByName } from "./studentDisplay.js";

test("sortStudentsByName returns an alphabetical copy without changing roster order", () => {
  const students = [
    { id: 12, name: "Zoe" },
    { id: 3, name: "alex 10" },
    { id: 2, name: "Alex 2" },
    { id: 9, name: "brayden" }
  ];

  const sorted = sortStudentsByName(students);

  assert.deepEqual(
    sorted.map(student => student.id),
    [2, 3, 9, 12]
  );
  assert.deepEqual(
    students.map(student => student.id),
    [12, 3, 2, 9],
    "display sorting must not reorder the stored roster"
  );
  assert.notEqual(sorted, students);
});

test("sortStudentsByName uses student ID as a deterministic tie-breaker", () => {
  const sorted = sortStudentsByName([
    { id: 10, name: "Sam" },
    { id: 2, name: "sam" }
  ]);

  assert.deepEqual(sorted.map(student => student.id), [2, 10]);
});
