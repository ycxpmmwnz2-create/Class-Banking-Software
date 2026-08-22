export const LEGACY_DEFAULT_ADD_MONEY_CATEGORIES = Object.freeze([
  "Homework",
  "Class Job",
  "Positive Consequence",
  "Going Above and Beyond",
  "Showing Work",
  "Earned Class Cash in Specials",
  "Teacher's Choice"
]);

export const DEFAULT_ADD_MONEY_CATEGORIES = Object.freeze([
  "Class Job",
  "Earned Class Cash in Specials",
  "Going Above and Beyond",
  "Homework",
  "Positive Consequence",
  "Showing Work",
  "Teacher's Choice",
  "Technology"
]);

function hasSameCategories(categories, expected) {
  if (!Array.isArray(categories) || categories.length !== expected.length) return false;
  return expected.every((category, index) => categories[index] === category);
}

export function effectiveAddMoneyCategories(categories) {
  if (hasSameCategories(categories, LEGACY_DEFAULT_ADD_MONEY_CATEGORIES)) {
    return [...DEFAULT_ADD_MONEY_CATEGORIES];
  }
  return Array.isArray(categories) ? [...categories] : [...DEFAULT_ADD_MONEY_CATEGORIES];
}

export function sortTransactionCategories(categories) {
  return categories
    .filter(category => typeof category === "string")
    .sort((left, right) => left.localeCompare(right));
}
