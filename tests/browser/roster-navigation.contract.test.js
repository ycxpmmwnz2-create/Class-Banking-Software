import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INDEX_HTML_PATH = fileURLToPath(new URL("../../index.html", import.meta.url));

test("teacher navigation hides the legacy Payments tab while preserving Approvals and its compatibility screen", () => {
  const source = readFileSync(INDEX_HTML_PATH, "utf8");
  const navigationStart = source.indexOf('${(isTeacher || loggedInStudentId) ? `');
  const navigationEnd = source.indexOf('\n        ` : ""}', navigationStart);

  assert.ok(navigationStart >= 0, "the authenticated navigation must exist");
  assert.ok(navigationEnd > navigationStart, "the authenticated navigation must have a bounded end");

  const navigationSource = source.slice(navigationStart, navigationEnd);
  assert.match(
    navigationSource,
    /setScreen\('approvals'\)[^]*>Approvals<\/button>/,
    "the active credit-approval navigation must remain available"
  );
  assert.doesNotMatch(
    navigationSource,
    /setScreen\('purchases'\)|>Payments<\/button>/,
    "the obsolete Payments entry must not render in teacher navigation"
  );
  assert.match(
    source,
    /if \(screen === "purchases" && isTeacher\)/,
    "the legacy compatibility screen must remain intact during this navigation-only change"
  );
});

test("roster rows use the alphabetical display copy without mutating stored roster order", () => {
  const source = readFileSync(INDEX_HTML_PATH, "utf8");
  const rosterStart = source.indexOf('if (screen === "roster" && isTeacher) {');
  const profileStart = source.indexOf('if (screen === "studentProfile" && isTeacher) {', rosterStart);

  assert.ok(rosterStart >= 0, "the teacher roster screen must exist");
  assert.ok(profileStart > rosterStart, "the teacher roster screen must have a bounded end");

  const rosterSource = source.slice(rosterStart, profileStart);
  assert.match(
    rosterSource,
    /sortStudentsByName\(data\.students\)\.map\(student\s*=>/,
    "the roster must render the alphabetical display copy"
  );
  assert.doesNotMatch(
    rosterSource,
    /data\.students\.sort\(/,
    "the stored roster must never be sorted in place"
  );
});
