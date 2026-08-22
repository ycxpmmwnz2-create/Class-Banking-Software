import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_ADD_MONEY_CATEGORIES,
  LEGACY_DEFAULT_ADD_MONEY_CATEGORIES,
  effectiveAddMoneyCategories,
  sortTransactionCategories
} from "./transactionCategoryDisplay.js";

test("transaction categories display alphabetically without changing stored order", () => {
  const stored = ["Technology", "Class Job", "Homework"];

  assert.deepEqual(sortTransactionCategories(stored), ["Class Job", "Homework", "Technology"]);
  assert.deepEqual(stored, ["Technology", "Class Job", "Homework"]);
});

test("malformed category entries are omitted without breaking the menu", () => {
  const stored = ["Homework", null, 3, "Class Job"];

  assert.deepEqual(sortTransactionCategories(stored), ["Class Job", "Homework"]);
  assert.deepEqual(stored, ["Homework", null, 3, "Class Job"]);
});

test("the former standard add-money list gains Technology", () => {
  const stored = [...LEGACY_DEFAULT_ADD_MONEY_CATEGORIES];

  assert.deepEqual(effectiveAddMoneyCategories(stored), [...DEFAULT_ADD_MONEY_CATEGORIES]);
  assert.deepEqual(stored, [...LEGACY_DEFAULT_ADD_MONEY_CATEGORIES]);
});

test("custom add-money lists remain custom", () => {
  const stored = ["Kindness", "Leadership"];

  assert.deepEqual(effectiveAddMoneyCategories(stored), stored);
  assert.deepEqual(stored, ["Kindness", "Leadership"]);
});

test("removing Technology from the new standard list remains a customization", () => {
  const stored = DEFAULT_ADD_MONEY_CATEGORIES.filter(category => category !== "Technology");

  assert.deepEqual(effectiveAddMoneyCategories(stored), stored);
  assert.equal(effectiveAddMoneyCategories(stored).includes("Technology"), false);
});

test("the transaction menus use the alphabetical display helpers", () => {
  const source = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

  assert.match(source, /function categoryOptions[\s\S]*?sortTransactionCategories\(categories\)\.map/);
  assert.match(source, /function studentCategoryOptions[\s\S]*?sortTransactionCategories\(categories\)/);
  assert.match(
    source,
    /categoryOptions\(effectiveAddMoneyCategories\(data\.settings\.addMoneyCategories\), "Homework"\)/
  );
  assert.match(
    source,
    /<textarea id="addMoneyCategoryList">\$\{escapeHtml\(effectiveAddMoneyCategories\(data\.settings\.addMoneyCategories\)\.join\("\\n"\)\)\}<\/textarea>/
  );
  assert.match(
    source,
    /<textarea id="subtractMoneyCategoryList">\$\{escapeHtml\(data\.settings\.subtractMoneyCategories\.join\("\\n"\)\)\}<\/textarea>/
  );
});
