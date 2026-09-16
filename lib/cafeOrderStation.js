/** Shared kitchen/bar routing — keep in sync with `lib/cafeOrderStation.ts` on the frontend. */

export function orderCategoryKey(category) {
  return String(category ?? "").trim().toLowerCase();
}

/** Food queue (Chef terminal): category food/others, or non-bar type. */
export function isKitchenStationOrder(order) {
  const c = orderCategoryKey(order?.category);
  if (
    c === "food" ||
    c === "others" ||
    c === "kitchen" ||
    c === "chef" ||
    c === "meal" ||
    c === "meals"
  ) {
    return true;
  }
  const t = String(order?.type ?? "").trim().toLowerCase();
  if (
    t === "bar" ||
    t === "beverage" ||
    t === "drink" ||
    t === "drinks" ||
    t === "barista"
  ) {
    return false;
  }
  if (t === "kitchen" || t === "food" || t === "chef") return true;
  return false;
}

/** Beverage queue (Bar / Barista terminal). */
export function isBarStationOrder(order) {
  const c = orderCategoryKey(order?.category);
  if (
    c === "beverage" ||
    c === "drink" ||
    c === "drinks" ||
    c === "bar" ||
    c === "barista"
  ) {
    return true;
  }
  const t = String(order?.type ?? "").trim().toLowerCase();
  return (
    t === "bar" ||
    t === "beverage" ||
    t === "drink" ||
    t === "drinks" ||
    t === "barista"
  );
}
