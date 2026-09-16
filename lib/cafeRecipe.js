/** Café recipe / profit math — mirrors hotcol-user lib/cafeRecipe.ts */

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Stable money rounding for freeze / report totals (2 decimal places). */
export function roundMoneyETB(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * Parse stored recipe JSON from API/DB.
 * Accepts object or JSON string (legacy rows).
 */
export function parseMenuRecipe(raw) {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const ingredients = value.ingredients;
  if (!Array.isArray(ingredients) || ingredients.length === 0) return null;

  const parsed = [];
  for (const row of ingredients) {
    if (!row || typeof row !== "object") continue;
    const name = String(row.name ?? "").trim();
    if (!name) continue;
    parsed.push({
      name,
      amount: asNumber(row.amount),
      measuredBy: String(row.measuredBy ?? "").trim(),
      unitPrice: asNumber(row.unitPrice),
    });
  }
  return parsed.length > 0 ? { ingredients: parsed } : null;
}

export function recipeCostPerUnit(recipe) {
  return roundMoneyETB(
    recipe.ingredients.reduce(
      (sum, line) => sum + line.amount * line.unitPrice,
      0,
    ),
  );
}

export function orderLineIngredientCost(recipe, orderAmount) {
  const qty = Math.max(0, Number(orderAmount) || 0);
  return roundMoneyETB(recipeCostPerUnit(recipe) * qty);
}

export function findItemRecipeByTitle(items, title) {
  const key = String(title ?? "").trim().toLowerCase();
  if (!key) return null;
  const item = items.find(
    (i) => String(i.name ?? "").trim().toLowerCase() === key,
  );
  return item ? parseMenuRecipe(item.recipeJson) : null;
}

/** Per-serving ingredient cost to freeze on the order at sale time. */
export function unitCostAtSaleFromItems(items, title) {
  const recipe = findItemRecipeByTitle(items, title);
  if (!recipe) return null;
  const cost = recipeCostPerUnit(recipe);
  return Number.isFinite(cost) ? cost : null;
}
