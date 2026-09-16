/**
 * Recipe → station stock decrement when kitchen/bar completes an order line.
 * Keep ingredient parse helpers aligned with cafeRecipe.js.
 */

import {
  isBarStationOrder,
  isKitchenStationOrder,
} from "./cafeOrderStation.js";
import { parseMenuRecipe } from "./cafeRecipe.js";

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Case-insensitive ingredient / menu match key.
 * Milk === milk; also collapses whitespace / unicode so typos of spacing do not miss.
 */
function normalizeItemNameKey(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function asHotelKeyList(hotelNameOrKeys) {
  if (Array.isArray(hotelNameOrKeys)) {
    return [
      ...new Set(
        hotelNameOrKeys
          .map((k) => String(k ?? "").trim())
          .filter(Boolean),
      ),
    ];
  }
  const one = String(hotelNameOrKeys ?? "").trim();
  return one ? [one] : [];
}

function hotelNameWhere(hotelNameOrKeys) {
  const keys = asHotelKeyList(hotelNameOrKeys);
  if (keys.length === 0) return null;
  if (keys.length === 1) return { HotelName: keys[0] };
  return { HotelName: { in: keys } };
}

/** Station that owns the finished menu line (KITCHEN | BAR). */
export function stationKeyForCompletedOrder(order) {
  if (isBarStationOrder(order)) return "BAR";
  if (isKitchenStationOrder(order)) return "KITCHEN";
  return "KITCHEN";
}

/** True when a stock-out destination should feed station ingredient stock. */
export function isRecipeStationKey(stationKey) {
  const c = canonicalizeRecipeStation(stationKey);
  return c === "KITCHEN" || c === "BAR";
}

/**
 * Canonical recipe stations.
 * Store UI says "Barista"; daily counts / ledger use "BAR". Same for Chef → KITCHEN.
 */
export function canonicalizeRecipeStation(raw, normalizeStation) {
  if (typeof normalizeStation === "function") {
    const n = String(normalizeStation(raw) || "").trim().toUpperCase();
    if (n === "KITCHEN" || n === "BAR") return n;
  }
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!s) return "";
  if (
    s === "kitchen" ||
    s === "chef" ||
    s === "chef (kitchen)" ||
    s.startsWith("kitchen") ||
    s.startsWith("chef")
  ) {
    return "KITCHEN";
  }
  if (
    s === "bar" ||
    s === "barista" ||
    s.startsWith("bar") ||
    s.startsWith("barista")
  ) {
    return "BAR";
  }
  const up = String(raw ?? "").trim().toUpperCase();
  if (up === "KITCHEN" || up === "CHEF") return "KITCHEN";
  if (up === "BAR" || up === "BARISTA") return "BAR";
  return "";
}

/** DB values that may appear for the same logical station. */
export function recipeStationAliases(canonical) {
  const c = canonicalizeRecipeStation(canonical) || String(canonical || "").trim().toUpperCase();
  if (c === "KITCHEN") {
    return ["KITCHEN", "CHEF", "Kitchen", "Chef", "kitchen", "chef"];
  }
  if (c === "BAR") {
    return ["BAR", "BARISTA", "Bar", "Barista", "bar", "barista"];
  }
  return c ? [c] : [];
}

function stationWhere(canonical) {
  const aliases = recipeStationAliases(canonical);
  if (aliases.length === 0) return null;
  if (aliases.length === 1) return { station: aliases[0] };
  return { station: { in: aliases } };
}

/**
 * Find all on-hand rows for an ingredient at a logical station (BAR≈Barista, etc.).
 * Case-insensitive name; searches all tenant HotelName keys.
 */
async function findStationStockMatches(
  client,
  hotelNameOrKeys,
  stationCanonical,
  itemName,
) {
  const key = normalizeItemNameKey(itemName);
  const hotelWhere = hotelNameWhere(hotelNameOrKeys);
  const stWhere = stationWhere(stationCanonical);
  if (!key || !hotelWhere || !stWhere) return [];
  const rows = await client.stationIngredientStock.findMany({
    where: { ...hotelWhere, ...stWhere },
  });
  return rows
    .filter((r) => normalizeItemNameKey(r.itemName) === key)
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
}

/**
 * Prefer a canonical-station row; if stock is split across Bar/Barista (or
 * Chef/Kitchen) aliases, fold qty into one canonical row.
 */
async function consolidateStationStockMatches(
  client,
  matches,
  {
    writeHotel,
    canonicalStation,
    fallbackName,
    measuredBy = "",
    unitPrice = 0,
  },
) {
  if (!matches.length) return null;
  const canonical = canonicalizeRecipeStation(canonicalStation) || "KITCHEN";
  const preferred =
    matches.find((r) => canonicalizeRecipeStation(r.station) === canonical) ||
    matches[0];

  let total = 0;
  let name = String(preferred.itemName || fallbackName || "").trim();
  let unit = String(measuredBy || preferred.measuredBy || "").trim();
  let price = Number(unitPrice) > 0 ? Number(unitPrice) : Number(preferred.unitPrice) || 0;

  for (const row of matches) {
    total = round2(total + (Number(row.amount) || 0));
    if (!unit && row.measuredBy) unit = String(row.measuredBy).trim();
    if (!(price > 0) && Number(row.unitPrice) > 0) price = Number(row.unitPrice);
    if (row.itemName && String(row.itemName).trim()) {
      // Prefer existing stock casing (milk) over recipe casing (Milk).
      name = String(row.itemName).trim();
    }
  }

  const survivors = matches.filter((r) => r.id === preferred.id);
  const extras = matches.filter((r) => r.id !== preferred.id);

  for (const extra of extras) {
    await client.stationIngredientStock.update({
      where: { id: extra.id },
      data: { amount: 0 },
    });
  }

  const targetHotel = String(preferred.HotelName || writeHotel).trim();
  return client.stationIngredientStock.update({
    where: { id: preferred.id },
    data: {
      HotelName: targetHotel,
      station: canonical,
      itemName: name || fallbackName,
      measuredBy: unit,
      unitPrice: price,
      amount: total,
    },
  });
}

async function findStationStockRow(client, hotelNameOrKeys, station, itemName) {
  const matches = await findStationStockMatches(
    client,
    hotelNameOrKeys,
    station,
    itemName,
  );
  return matches[0] || null;
}

async function findMenuItemRecipe(client, hotelNameOrKeys, title) {
  const key = normalizeItemNameKey(title);
  const hotelWhere = hotelNameWhere(hotelNameOrKeys);
  if (!key || !hotelWhere) return null;
  const items = await client.item.findMany({
    where: hotelWhere,
    select: { recipeJson: true, name: true },
  });
  const menuItem = items.find((i) => normalizeItemNameKey(i.name) === key);
  if (!menuItem) return null;
  return { menuItem, recipe: parseMenuRecipe(menuItem.recipeJson) };
}

/**
 * One-time (per empty ledger) rebuild from historical stock-outs − consumptions
 * so existing kitchens are not starting from a blank on-hand after deploy.
 */
export async function ensureStationIngredientStockSeeded(
  client,
  hotelName,
  normalizeStation,
) {
  const hotel = String(hotelName || "").trim();
  if (!hotel || typeof normalizeStation !== "function") return;

  const existing = await client.stationIngredientStock.count({
    where: { HotelName: hotel },
  });
  if (existing > 0) return;

  /** @type {Map<string, { station: string, itemName: string, measuredBy: string, unitPrice: number, amount: number }>} */
  const map = new Map();

  const bump = (stationKey, itemName, amount, measuredBy, unitPrice, sign) => {
    const station = canonicalizeRecipeStation(stationKey, normalizeStation);
    if (!isRecipeStationKey(station)) return;
    const name = String(itemName || "").trim();
    const qty = round2(Number(amount) || 0);
    if (!name || !(qty > 0)) return;
    const key = `${station}\t${normalizeItemNameKey(name)}`;
    const row = map.get(key) || {
      station,
      itemName: name,
      measuredBy: String(measuredBy || "").trim(),
      unitPrice: Number(unitPrice) || 0,
      amount: 0,
    };
    row.amount = round2(row.amount + sign * qty);
    if (measuredBy) row.measuredBy = String(measuredBy).trim();
    if (Number(unitPrice) > 0) row.unitPrice = Number(unitPrice);
    map.set(key, row);
  };

  const cafeStatuses = await client.itemStatus.findMany({
    where: {
      HotelName: hotel,
      status: "Stock Out",
      stockOutRequestId: null,
    },
    select: {
      name: true,
      amount: true,
      measuredBy: true,
      unitPrice: true,
      statusBy: true,
    },
  });
  for (const s of cafeStatuses) {
    bump(
      normalizeStation(s.statusBy),
      s.name,
      s.amount,
      s.measuredBy,
      s.unitPrice,
      1,
    );
  }

  const hotelOuts = await client.stockOutRequest.findMany({
    where: {
      HotelName: hotel,
      status: "APPROVED",
      movementType: "STOCK_OUT",
    },
    select: {
      itemNameSnapshot: true,
      amount: true,
      stakeHolderOrReason: true,
      itemRegistrationId: true,
    },
  });
  const regIds = [
    ...new Set(
      hotelOuts
        .map((r) => Number(r.itemRegistrationId))
        .filter((id) => id > 0),
    ),
  ];
  const regs =
    regIds.length > 0
      ? await client.itemRegistration.findMany({
          where: { id: { in: regIds } },
          select: { id: true, name: true, unitPrice: true, measuredBy: true },
        })
      : [];
  const regById = new Map(regs.map((r) => [r.id, r]));
  for (const o of hotelOuts) {
    const reg = regById.get(Number(o.itemRegistrationId));
    const itemName =
      String(o.itemNameSnapshot || "").trim() ||
      String(reg?.name || "").trim();
    bump(
      normalizeStation(o.stakeHolderOrReason),
      itemName,
      o.amount,
      reg?.measuredBy,
      reg?.unitPrice,
      1,
    );
  }

  const consumptions = await client.recipeStockConsumption.findMany({
    where: { HotelName: hotel },
    select: {
      station: true,
      ingredientName: true,
      amount: true,
      measuredBy: true,
      unitPrice: true,
    },
  });
  for (const c of consumptions) {
    bump(
      canonicalizeRecipeStation(c.station, normalizeStation) || c.station,
      c.ingredientName,
      c.amount,
      c.measuredBy,
      c.unitPrice,
      -1,
    );
  }

  const rows = [...map.values()].map((r) => ({
    HotelName: hotel,
    station: r.station,
    itemName: r.itemName,
    measuredBy: r.measuredBy,
    unitPrice: r.unitPrice,
    amount: round2(Math.max(0, r.amount)),
  }));
  if (rows.length === 0) return;
  await client.stationIngredientStock.createMany({ data: rows });
}

/**
 * Increase on-hand at kitchen/bar after store stocks out ingredients.
 * Accepts Barista/Bar/BAR (and Chef/Kitchen) and writes the canonical key.
 */
export async function creditStationIngredientStock(
  client,
  {
    hotelName,
    hotelKeys,
    stationKey,
    itemName,
    amount,
    measuredBy = "",
    unitPrice = 0,
    normalizeStation,
  },
) {
  const station = canonicalizeRecipeStation(stationKey, normalizeStation);
  if (!isRecipeStationKey(station)) return null;
  const name = String(itemName || "").trim();
  const qty = round2(Number(amount) || 0);
  if (!name || !(qty > 0)) return null;

  const scopeKeys = asHotelKeyList(
    hotelKeys?.length ? hotelKeys : hotelName,
  );
  if (scopeKeys.length === 0) return null;
  const writeHotel = String(hotelName || scopeKeys[0]).trim();

  if (typeof normalizeStation === "function") {
    const before = await client.stationIngredientStock.count({
      where: hotelNameWhere(scopeKeys),
    });
    if (before === 0) {
      for (const key of scopeKeys) {
        await ensureStationIngredientStockSeeded(
          client,
          key,
          normalizeStation,
        );
      }
      const after = await client.stationIngredientStock.count({
        where: hotelNameWhere(scopeKeys),
      });
      // History rebuild already includes this stock-out — don't double-credit.
      if (after > 0) {
        const seeded = await findStationStockMatches(
          client,
          scopeKeys,
          station,
          name,
        );
        return seeded[0] || null;
      }
    }
  }

  const matches = await findStationStockMatches(
    client,
    scopeKeys,
    station,
    name,
  );

  if (matches.length > 0) {
    const consolidated = await consolidateStationStockMatches(client, matches, {
      writeHotel,
      canonicalStation: station,
      fallbackName: name,
      measuredBy,
      unitPrice,
    });
    if (!consolidated) return null;
    return client.stationIngredientStock.update({
      where: { id: consolidated.id },
      data: {
        amount: round2(Number(consolidated.amount) + qty),
        measuredBy: String(measuredBy || consolidated.measuredBy || "").trim(),
        unitPrice:
          Number(unitPrice) > 0
            ? Number(unitPrice)
            : Number(consolidated.unitPrice) || 0,
        station,
        itemName: String(consolidated.itemName || name).trim() || name,
      },
    });
  }

  return client.stationIngredientStock.create({
    data: {
      HotelName: writeHotel,
      station,
      itemName: name,
      measuredBy: String(measuredBy || "").trim(),
      unitPrice: Number(unitPrice) || 0,
      amount: qty,
    },
  });
}

/**
 * Deduct recipe qty from station stock. Clamps at 0; returns shortfall.
 * - Name: case-insensitive (Milk === milk)
 * - Station: BAR ≈ Barista / BARISTA; KITCHEN ≈ Chef / CHEF
 * Drains across split alias rows, then consolidates leftovers onto canonical.
 */
export async function debitStationIngredientStock(
  client,
  {
    hotelName,
    hotelKeys,
    stationKey,
    itemName,
    amount,
    measuredBy = "",
    unitPrice = 0,
    normalizeStation,
  },
) {
  const station = canonicalizeRecipeStation(stationKey, normalizeStation);
  const name = String(itemName || "").trim();
  const needed = round2(Number(amount) || 0);
  if (!isRecipeStationKey(station) || !name || !(needed > 0)) {
    return { applied: 0, shortfall: needed > 0 ? needed : 0 };
  }

  const scopeKeys = asHotelKeyList(
    hotelKeys?.length ? hotelKeys : hotelName,
  );
  if (scopeKeys.length === 0) {
    return { applied: 0, shortfall: needed };
  }
  const writeHotel = String(hotelName || scopeKeys[0]).trim();

  if (typeof normalizeStation === "function") {
    for (const key of scopeKeys) {
      await ensureStationIngredientStockSeeded(
        client,
        key,
        normalizeStation,
      );
    }
  }

  let matches = await findStationStockMatches(
    client,
    scopeKeys,
    station,
    name,
  );

  if (matches.length === 0) {
    try {
      await client.stationIngredientStock.create({
        data: {
          HotelName: writeHotel,
          station,
          itemName: name,
          measuredBy: String(measuredBy || "").trim(),
          unitPrice: Number(unitPrice) || 0,
          amount: 0,
        },
      });
    } catch {
      // Unique clash — treat as empty on-hand.
    }
    return { applied: 0, shortfall: needed };
  }

  // Drain needed qty across all alias / casing duplicates (highest on-hand first).
  let remaining = needed;
  let applied = 0;
  for (const row of matches) {
    if (remaining <= 0) break;
    const onHand = round2(Number(row.amount) || 0);
    if (!(onHand > 0)) continue;
    const take = round2(Math.min(onHand, remaining));
    const next = round2(Math.max(0, onHand - take));
    await client.stationIngredientStock.update({
      where: { id: row.id },
      data: {
        amount: next,
        measuredBy:
          String(measuredBy || row.measuredBy || "").trim() || row.measuredBy,
        unitPrice:
          Number(unitPrice) > 0
            ? Number(unitPrice)
            : Number(row.unitPrice) || 0,
      },
    });
    applied = round2(applied + take);
    remaining = round2(Math.max(0, remaining - take));
  }

  // Fold leftover alias rows into canonical BAR/KITCHEN for cleaner on-hand.
  matches = await findStationStockMatches(client, scopeKeys, station, name);
  if (matches.length > 1) {
    await consolidateStationStockMatches(client, matches, {
      writeHotel,
      canonicalStation: station,
      fallbackName: name,
      measuredBy,
      unitPrice,
    });
  } else if (matches.length === 1) {
    const only = matches[0];
    if (canonicalizeRecipeStation(only.station) !== station) {
      try {
        await client.stationIngredientStock.update({
          where: { id: only.id },
          data: { station },
        });
      } catch {
        // Unique clash with an empty canonical row — consolidate next pass.
      }
    }
  }

  return { applied, shortfall: round2(Math.max(0, needed - applied)) };
}

/**
 * When a daily-count row exists for this station+ingredient+day, bump salesDay
 * so hotel closing on-hand stays aligned with recipe consumption.
 */
export async function bumpKitchenBarSalesForRecipe(
  client,
  {
    hotelName,
    hotelKeys,
    stationKey,
    itemName,
    calendarDateYmd,
    qty,
    normalizeStation,
    kitchenBarStationPrismaWhere,
    sumApprovedStockOutToStation,
    findPreviousKitchenBarRow,
    computeClosingOnHand,
  },
) {
  const station = String(stationKey || "").trim().toUpperCase();
  const name = String(itemName || "").trim();
  const day = String(calendarDateYmd || "").trim().slice(0, 10);
  const delta = round2(Number(qty) || 0);
  if (!isRecipeStationKey(station) || !name || !day || !(delta > 0)) return;

  const scopeKeys = asHotelKeyList(
    hotelKeys?.length ? hotelKeys : hotelName,
  );
  if (scopeKeys.length === 0) return;

  const stationNorm = normalizeStation(station);
  const candidates = await client.kitchenBarBeginning.findMany({
    where: {
      ...hotelNameWhere(scopeKeys),
      calendarDate: day,
      ...kitchenBarStationPrismaWhere(stationNorm),
    },
  });
  const key = normalizeItemNameKey(name);
  const row = candidates.find(
    (r) => normalizeItemNameKey(r.itemName) === key,
  );
  if (!row) return;

  const currentSales =
    row.salesDay != null && Number.isFinite(Number(row.salesDay))
      ? round2(Number(row.salesDay) || 0)
      : 0;
  const nextSales = round2(currentSales + delta);
  const sum = await sumApprovedStockOutToStation(
    client,
    row.HotelName,
    stationNorm,
    String(row.itemName).trim(),
    day,
  );
  const prev = await findPreviousKitchenBarRow(
    client,
    row.HotelName,
    stationNorm,
    String(row.itemName).trim(),
    day,
  );
  const closing = round2(
    computeClosingOnHand(
      Number(row.amount),
      sum,
      Number(row.managementTakenDay ?? 0),
      prev,
      Number(row.invitationTakenDay ?? 0),
      nextSales,
    ),
  );

  await client.kitchenBarBeginning.update({
    where: { id: row.id },
    data: {
      salesDay: nextSales,
      stockOutDay: round2(sum),
      closingOnHand: closing,
    },
  });
}

/**
 * Apply recipe stock deduction for a newly completed café order line.
 * Idempotent per orderId. No-ops when Inventory module is off or no recipe.
 *
 * Matching rules for effectiveness:
 * - Ingredient names case-insensitive (Milk === milk)
 * - Station aliases: Barista/BARISTA/Bar === BAR; Chef/CHEF === KITCHEN
 * - HotelName searches TIN + display name keys
 */
export async function applyRecipeStockDecrementOnComplete(
  client,
  {
    order,
    hotelKeys,
    completedBy = "",
    modules,
    tenantHasModule,
    calendarDateYmd,
    normalizeStation,
    kitchenBarStationPrismaWhere,
    sumApprovedStockOutToStation,
    findPreviousKitchenBarRow,
    computeClosingOnHand,
  },
) {
  const logSkip = (reason) => {
    console.info(
      `[hotcol] Recipe stock decrement skipped order=${order?.id ?? "?"} reason=${reason}`,
    );
    return { skipped: true, reason };
  };

  if (!order?.id) return logSkip("no-order");
  if (!tenantHasModule(modules, "Inventory")) {
    return logSkip("no-inventory-module");
  }

  const already = await client.recipeStockConsumption.count({
    where: { orderId: order.id },
  });
  if (already > 0) return logSkip("already-consumed");

  const hotelName = String(order.HotelName || "").trim();
  if (!hotelName) return logSkip("no-hotel");

  const scopeKeys = asHotelKeyList(
    hotelKeys?.length ? [...hotelKeys, hotelName] : hotelName,
  );

  const title = String(order.title || "").trim();
  const servings = Math.max(0, Math.floor(Number(order.orderAmount) || 0));
  if (!title || servings <= 0) {
    return logSkip("empty-line");
  }

  const found = await findMenuItemRecipe(client, scopeKeys, title);
  const recipe = found?.recipe;
  if (!recipe?.ingredients?.length) {
    return logSkip("no-recipe");
  }

  const station =
    canonicalizeRecipeStation(
      stationKeyForCompletedOrder(order),
      normalizeStation,
    ) || stationKeyForCompletedOrder(order);
  const day = String(calendarDateYmd || "").trim().slice(0, 10);
  const actor = String(completedBy || "").trim();
  const created = [];
  let totalShortfall = 0;

  for (const key of scopeKeys) {
    await ensureStationIngredientStockSeeded(
      client,
      key,
      normalizeStation,
    );
  }

  for (const ing of recipe.ingredients) {
    const ingredientName = String(ing.name || "").trim();
    const perServing = round2(Number(ing.amount) || 0);
    if (!ingredientName || !(perServing > 0)) continue;

    const totalQty = round2(perServing * servings);
    const { applied, shortfall } = await debitStationIngredientStock(client, {
      hotelName,
      hotelKeys: scopeKeys,
      stationKey: station,
      itemName: ingredientName,
      amount: totalQty,
      measuredBy: ing.measuredBy,
      unitPrice: ing.unitPrice,
      normalizeStation,
    });
    totalShortfall = round2(totalShortfall + (shortfall || 0));

    await bumpKitchenBarSalesForRecipe(client, {
      hotelName,
      hotelKeys: scopeKeys,
      stationKey: station,
      itemName: ingredientName,
      calendarDateYmd: day,
      qty: totalQty,
      normalizeStation,
      kitchenBarStationPrismaWhere,
      sumApprovedStockOutToStation,
      findPreviousKitchenBarRow,
      computeClosingOnHand,
    });

    const row = await client.recipeStockConsumption.create({
      data: {
        HotelName: hotelName,
        orderId: order.id,
        menuItemTitle: title,
        orderAmount: servings,
        station,
        ingredientName,
        amount: totalQty,
        measuredBy: String(ing.measuredBy || "").trim(),
        unitPrice: Number(ing.unitPrice) || 0,
        shortfallAmount: shortfall,
        completedBy: actor,
      },
    });
    created.push({ ...row, applied });
  }

  console.info(
    `[hotcol] Recipe stock decrement order=${order.id} station=${station} ingredients=${created.length} shortfall=${totalShortfall}`,
  );

  return { skipped: false, rows: created, station, totalShortfall };
}

/**
 * Dual-module guard: Cafe + Inventory tenants cannot place an order whose
 * recipe ingredients are missing from kitchen/bar station on-hand.
 * No recipe → allowed. Missing Inventory or Cafe module → allowed.
 */
export async function assertRecipeStationStockForOrder(
  client,
  {
    hotelName,
    hotelKeys,
    title,
    category,
    type,
    servings,
    modules,
    tenantHasModule,
    normalizeStation,
  },
) {
  const hasInv = tenantHasModule(modules, "Inventory");
  const hasCafe = tenantHasModule(modules, "Cafe and Restaurant");
  if (!hasInv || !hasCafe) {
    return { ok: true, skipped: true, reason: "modules-not-both" };
  }

  const qty = Math.max(0, Math.floor(Number(servings) || 0));
  if (!(qty > 0)) {
    return { ok: true, skipped: true, reason: "empty-qty" };
  }

  const scopeKeys = asHotelKeyList(
    hotelKeys?.length ? [...hotelKeys, hotelName] : hotelName,
  );
  const found = await findMenuItemRecipe(client, scopeKeys, title);
  const recipe = found?.recipe;
  if (!recipe?.ingredients?.length) {
    return { ok: true, skipped: true, reason: "no-recipe" };
  }

  const station =
    canonicalizeRecipeStation(
      stationKeyForCompletedOrder({ category, type }),
      normalizeStation,
    ) || stationKeyForCompletedOrder({ category, type });

  for (const key of scopeKeys) {
    await ensureStationIngredientStockSeeded(client, key, normalizeStation);
  }

  const gaps = [];
  for (const ing of recipe.ingredients) {
    const ingredientName = String(ing.name || "").trim();
    const perServing = round2(Number(ing.amount) || 0);
    if (!ingredientName || !(perServing > 0)) continue;
    const needed = round2(perServing * qty);
    const matches = await findStationStockMatches(
      client,
      scopeKeys,
      station,
      ingredientName,
    );
    const onHand = round2(
      matches.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    );
    if (onHand + 1e-9 < needed) {
      gaps.push({
        ingredientName,
        measuredBy: String(ing.measuredBy || "").trim(),
        needed,
        onHand,
        shortfall: round2(needed - onHand),
      });
    }
  }

  if (gaps.length === 0) return { ok: true, station, gaps: [] };

  const detail = gaps
    .slice(0, 4)
    .map((g) => {
      const u = g.measuredBy ? ` ${g.measuredBy}` : "";
      return `${g.ingredientName} (need ${g.needed}${u}, on hand ${g.onHand}${u})`;
    })
    .join("; ");
  const more = gaps.length > 4 ? ` (+${gaps.length - 4} more)` : "";
  const stationLabel = station === "BAR" ? "Bar / Barista" : "Kitchen";
  throw new Error(
    `Cannot order “${String(title || "").trim()}”: recipe ingredients are short at ${stationLabel} — ${detail}${more}. Stock out to that station first.`,
  );
}

export {
  normalizeItemNameKey,
  round2 as roundRecipeStock2,
  canonicalizeRecipeStation as canonicalizeRecipeStationKey,
};
