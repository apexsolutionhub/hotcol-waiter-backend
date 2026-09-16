/**
 * HotCol Waiter GraphQL API — waiter-facing auth + ordering only.
 * Shares Cafe_DB with hotcol-user (do not db push from here in production).
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import { ApolloServer, gql } from "apollo-server-express";
import jwt from "jsonwebtoken";
import { DateTimeResolver, GraphQLJSON } from "graphql-scalars";
import { createPrismaClient } from "./lib/prismaClient.js";
import { assertRecipeStationStockForOrder } from "./lib/recipeStockDecrement.js";
import { isSameCafeBusinessDay } from "./lib/cafeBusinessDay.js";

const prisma = createPrismaClient();
const JWT_Secret = process.env.JWT_Secret || "dev-waiter-secret";
const PORT = Number(process.env.PORT) || 4002;

function resolveJwtExpiresIn() {
  const raw = process.env.JWT_EXPIRES_IN;
  if (raw == null || String(raw).trim() === "") return "12h";
  return String(raw).trim();
}

function parseModulesJson(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      return parseModulesJson(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function tenantHasModule(modules, required) {
  const list = parseModulesJson(modules);
  if (list.length === 0) return true;
  return list.includes(required);
}

/**
 * Waiter.HotelName may be TIN (new) or display name (legacy).
 * tenant_account is always keyed by tinNumber.
 */
async function resolveTenantForWaiter(waiter) {
  const hotelKey = String(waiter.HotelName || "").trim();
  if (!hotelKey) {
    throw new Error("Waiter property scope is missing");
  }

  let account = await prisma.tenant_account.findUnique({
    where: { tinNumber: hotelKey },
  });

  let tin = hotelKey;
  if (!account) {
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ tinNumber: hotelKey }, { HotelName: hotelKey }],
      },
      orderBy: { id: "asc" },
      select: { tinNumber: true, HotelName: true, modules: true },
    });
    tin = String(user?.tinNumber || "").trim() || hotelKey;
    if (tin) {
      account = await prisma.tenant_account.findUnique({
        where: { tinNumber: tin },
      });
    }
    if (!account && user) {
      // Property has users but no tenant_account row yet — use user modules.
      return {
        tin,
        hotelKeys: [...new Set([tin, hotelKey, String(user.HotelName || "").trim()].filter(Boolean))],
        account: null,
        modules: parseModulesJson(user.modules),
        waiterOrderingEnabled: false,
        waiterPaymentApprovalEnabled: false,
      };
    }
  }

  if (!account) {
    throw new Error(
      "Property account not found for this waiter. Ask admin to check HotCol setup.",
    );
  }

  const display = String(account.hotelDisplayName || "").trim();
  const hotelKeys = [...new Set([account.tinNumber, display, hotelKey].filter(Boolean))];

  return {
    tin: account.tinNumber,
    hotelKeys,
    account,
    modules: parseModulesJson(account.modules),
    waiterOrderingEnabled: Boolean(account.waiterOrderingEnabled),
    waiterPaymentApprovalEnabled: Boolean(account.waiterPaymentApprovalEnabled),
  };
}

async function loadWaiterSession(waiterId) {
  const waiter = await prisma.waiter.findUnique({ where: { id: waiterId } });
  if (!waiter) throw new Error("Waiter not found");
  if (!waiter.isActive) throw new Error("Your account is deactivated");
  if (!waiter.passkey) throw new Error("Passkey not set");

  const scope = await resolveTenantForWaiter(waiter);
  if (!tenantHasModule(scope.modules, "Cafe and Restaurant")) {
    throw new Error("Café and Restaurant module is not active");
  }
  if (!scope.waiterOrderingEnabled) {
    throw new Error(
      "Waiter ordering is not permitted for this property. Ask Apex to enable Waiter ordering on the tenant modules tab.",
    );
  }

  // Prefer TIN on the waiter row so later lookups stay aligned with tenant_account.
  if (waiter.HotelName !== scope.tin) {
    try {
      await prisma.waiter.update({
        where: { id: waiter.id },
        data: { HotelName: scope.tin },
      });
      waiter.HotelName = scope.tin;
    } catch {
      /* non-fatal — scope.tin is still used for orders */
    }
  }

  return {
    waiter,
    account: scope.account,
    modules: scope.modules,
    tin: scope.tin,
    hotelKeys: scope.hotelKeys,
    waiterPaymentApprovalEnabled: scope.waiterPaymentApprovalEnabled,
  };
}

function normalizePasskey(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d{6}$/.test(s)) throw new Error("Passkey must be exactly 6 digits");
  return s;
}

function authenticate(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_Secret);
  } catch {
    return null;
  }
}

function assertWaiter(context) {
  if (!context.user?.waiterId) throw new Error("Not Authenticated");
  return context.user;
}

function hotelNameWhere(hotelKeys) {
  const keys = [...new Set((hotelKeys || []).map((k) => String(k || "").trim()).filter(Boolean))];
  if (keys.length === 0) return { HotelName: "__none__" };
  if (keys.length === 1) return { HotelName: keys[0] };
  return { HotelName: { in: keys } };
}

function unitCostAtSaleFromItems(menuItems, title) {
  const hit = menuItems.find(
    (i) =>
      String(i.name || "")
        .trim()
        .toLowerCase() === String(title || "").trim().toLowerCase(),
  );
  const recipe = hit?.recipeJson;
  const ingredients = Array.isArray(recipe?.ingredients)
    ? recipe.ingredients
    : Array.isArray(recipe)
      ? recipe
      : [];
  if (!ingredients.length) return null;
  let sum = 0;
  for (const ing of ingredients) {
    const amount = Number(ing.amount) || 0;
    const unitPrice = Number(ing.unitPrice) || 0;
    sum += amount * unitPrice;
  }
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}

async function serviceCaptionForTableNo(tableNo, hotelKeys) {
  const table = await prisma.table.findFirst({
    where: { ...hotelNameWhere(hotelKeys), tableNo: Number(tableNo) },
  });
  return table?.orderCaption ? String(table.orderCaption).trim() : null;
}

/** Unpaid active ticket from today's café business day — locks the table. */
function isOpenOrderLockingTable(order) {
  if (String(order.payment || "").toLowerCase() === "paid") return false;
  const status = String(order.status || "").toLowerCase();
  if (status === "cancelled" || status === "failed") return false;
  return isSameCafeBusinessDay(order.createdAt);
}

async function assertTableAvailableForNewOrder(
  hotelKeys,
  tableNo,
  waiter,
  { allowOwned = false } = {},
) {
  const candidates = await prisma.order.findMany({
    where: {
      ...hotelNameWhere(hotelKeys),
      tableNo: Number(tableNo),
      payment: { not: "Paid" },
      NOT: {
        OR: [
          { status: "Cancelled" },
          { status: "cancelled" },
          { status: "Failed" },
          { status: "failed" },
        ],
      },
    },
    select: {
      waiterId: true,
      waiterName: true,
      payment: true,
      status: true,
      createdAt: true,
    },
    take: 50,
  });
  const open = candidates.filter(isOpenOrderLockingTable);
  if (open.length === 0) return;

  const ownedByMe = open.every((o) => {
    if (o.waiterId != null) return Number(o.waiterId) === Number(waiter.id);
    return (
      String(o.waiterName || "").trim() === String(waiter.name || "").trim()
    );
  });

  // From-scratch: never allow on an occupied table (matches cashier).
  // Add-to-existing (My orders): only the owning waiter may add lines.
  if (!allowOwned || !ownedByMe) {
    throw new Error(
      `Table ${tableNo} is in use until payment is completed`,
    );
  }
}

function sessionPayload(session) {
  const displayName =
    String(session.account?.hotelDisplayName || "").trim() || session.tin;
  const logoUrl =
    String(session.account?.logoUrl || "").trim() || null;
  const modules = session.modules || [];
  const recipeStockEnforced =
    tenantHasModule(modules, "Inventory") &&
    tenantHasModule(modules, "Cafe and Restaurant");
  return {
    id: session.waiter.id,
    name: session.waiter.name,
    HotelName: session.tin,
    tin: session.tin,
    displayName,
    logoUrl,
    phoneNumber: session.waiter.phoneNumber,
    waiterPaymentApprovalEnabled: session.waiterPaymentApprovalEnabled,
    recipeStockEnforced,
  };
}

const typeDefs = gql`
  scalar JSON
  scalar DateTime

  type WaiterSession {
    id: Int!
    name: String!
    """TIN — API scope key (also exposed as tin)."""
    HotelName: String!
    tin: String!
    displayName: String!
    logoUrl: String
    phoneNumber: String!
    waiterPaymentApprovalEnabled: Boolean!
    """True when Cafe + Inventory — recipe station stock blocks ordering."""
    recipeStockEnforced: Boolean!
  }

  type AuthPayload {
    token: String!
    waiter: WaiterSession!
  }

  type MenuItem {
    id: Int!
    name: String!
    price: Float!
    category: String!
    type: String!
    imageUrl: String!
    isSuspended: Boolean
    recipeJson: JSON
  }

  type TableRow {
    id: Int!
    tableNo: Int!
    capacity: Int!
    orderCaption: String
    inUse: Boolean!
    ownedByMe: Boolean!
  }

  type Order {
    id: Int!
    title: String!
    imageUrl: String!
    tableNo: Int!
    HotelName: String!
    orderAmount: Int!
    category: String!
    type: String!
    price: Float!
    unitCostAtSale: Float
    waiterName: String!
    waiterId: Int
    status: String
    payment: String
    serviceCaption: String
    paymentApprovalRequestId: Int
    createdAt: DateTime!
  }

  type WaiterPaymentApprovalRequest {
    id: Int!
    status: String!
    amountPaid: Float!
    paymentMethod: String!
    orderIds: JSON!
    tableNo: Int
    requestedAt: DateTime!
  }

  type StationIngredientStock {
    id: Int!
    station: String!
    itemName: String!
    amount: Float!
    measuredBy: String
  }

  input WaiterOrderInput {
    title: String!
    imageUrl: String!
    tableNo: Int!
    orderAmount: Int!
    category: String!
    type: String!
    price: Float!
    status: String
    payment: String
    serviceCaption: String
  }

  type Query {
    me: WaiterSession
    menuItems: [MenuItem!]!
    tables: [TableRow!]!
    myOrders: [Order!]!
    stationIngredientStocks: [StationIngredientStock!]!
    myPendingPaymentApprovals: [WaiterPaymentApprovalRequest!]!
  }

  type Mutation {
    WaiterLogin(passkey: String!): AuthPayload!
    ChangeWaiterPasskey(currentPasskey: String!, newPasskey: String!): WaiterSession!
    WaiterOrderCreation(
      input: WaiterOrderInput!
      """When true, allow adding lines only if this waiter already owns the open table."""
      addingToExistingTable: Boolean
    ): Order!
    WaiterBatchOrderCreation(
      orders: [WaiterOrderInput!]!
      """When true, allow adding lines only if this waiter already owns the open table."""
      addingToExistingTable: Boolean
    ): [Order!]!
    WaiterUpdateLiveOrder(
      id: Int!
      tableNo: Int
      orderAmount: Int
      title: String
    ): Order!
    RequestWaiterPaymentApproval(
      orderIds: [Int!]!
      amountPaid: Float!
      paymentMethod: String!
      withBank: Boolean
      requestNote: String
      tableNo: Int
    ): WaiterPaymentApprovalRequest!
  }
`;

const resolvers = {
  JSON: GraphQLJSON,
  DateTime: DateTimeResolver,
  Query: {
    me: async (_, __, context) => {
      if (!context.user?.waiterId) return null;
      const session = await loadWaiterSession(context.user.waiterId);
      return sessionPayload(session);
    },
    menuItems: async (_, __, context) => {
      const user = assertWaiter(context);
      const { hotelKeys } = await loadWaiterSession(user.waiterId);
      return prisma.item.findMany({
        where: hotelNameWhere(hotelKeys),
        orderBy: { name: "asc" },
      });
    },
    tables: async (_, __, context) => {
      const user = assertWaiter(context);
      const { waiter, hotelKeys } = await loadWaiterSession(user.waiterId);
      const [tables, openOrders] = await Promise.all([
        prisma.table.findMany({
          where: hotelNameWhere(hotelKeys),
          orderBy: { tableNo: "asc" },
        }),
        prisma.order.findMany({
          where: {
            ...hotelNameWhere(hotelKeys),
            payment: { not: "Paid" },
            NOT: {
              OR: [
                { status: "Cancelled" },
                { status: "cancelled" },
                { status: "Failed" },
                { status: "failed" },
              ],
            },
          },
          select: {
            tableNo: true,
            waiterId: true,
            waiterName: true,
            payment: true,
            status: true,
            createdAt: true,
          },
        }),
      ]);
      const byTable = new Map();
      for (const o of openOrders) {
        if (!isOpenOrderLockingTable(o)) continue;
        const list = byTable.get(o.tableNo) || [];
        list.push(o);
        byTable.set(o.tableNo, list);
      }
      return tables.map((t) => {
        const open = byTable.get(t.tableNo) || [];
        const inUse = open.length > 0;
        const ownedByMe =
          inUse &&
          open.every((o) => {
            if (o.waiterId != null) return Number(o.waiterId) === waiter.id;
            return (
              String(o.waiterName || "").trim() ===
              String(waiter.name || "").trim()
            );
          });
        return {
          ...t,
          inUse,
          ownedByMe: Boolean(ownedByMe),
        };
      });
    },
    myOrders: async (_, __, context) => {
      const user = assertWaiter(context);
      const { waiter } = await loadWaiterSession(user.waiterId);
      return prisma.order.findMany({
        where: { waiterId: waiter.id },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
    },
    stationIngredientStocks: async (_, __, context) => {
      const user = assertWaiter(context);
      const { hotelKeys } = await loadWaiterSession(user.waiterId);
      return prisma.stationIngredientStock.findMany({
        where: hotelNameWhere(hotelKeys),
      });
    },
    myPendingPaymentApprovals: async (_, __, context) => {
      const user = assertWaiter(context);
      const { waiter, tin } = await loadWaiterSession(user.waiterId);
      return prisma.waiter_payment_approval_request.findMany({
        where: {
          HotelName: tin,
          waiterId: waiter.id,
          status: "pending",
        },
        orderBy: { requestedAt: "desc" },
      });
    },
  },
  Mutation: {
    WaiterLogin: async (_, { passkey }) => {
      const pin = normalizePasskey(passkey);
      const found = await prisma.waiter.findUnique({ where: { passkey: pin } });
      if (!found) throw new Error("Invalid passkey");
      const session = await loadWaiterSession(found.id);
      const token = jwt.sign(
        {
          waiterId: session.waiter.id,
          HotelName: session.tin,
          role: "Waiter",
          name: session.waiter.name,
        },
        JWT_Secret,
        { expiresIn: resolveJwtExpiresIn() },
      );
      return {
        token,
        waiter: sessionPayload(session),
      };
    },
    ChangeWaiterPasskey: async (_, { currentPasskey, newPasskey }, context) => {
      const user = assertWaiter(context);
      const session = await loadWaiterSession(user.waiterId);
      const { waiter } = session;
      if (normalizePasskey(currentPasskey) !== waiter.passkey) {
        throw new Error("Current passkey is incorrect");
      }
      const next = normalizePasskey(newPasskey);
      const clash = await prisma.waiter.findFirst({
        where: { passkey: next, id: { not: waiter.id } },
        select: { id: true },
      });
      if (clash) throw new Error("That passkey is already in use");
      const updated = await prisma.waiter.update({
        where: { id: waiter.id },
        data: { passkey: next },
      });
      return sessionPayload({
        ...session,
        waiter: updated,
      });
    },
    WaiterOrderCreation: async (
      _,
      { input, addingToExistingTable },
      context,
    ) => {
      const user = assertWaiter(context);
      const { waiter, modules, tin, hotelKeys } = await loadWaiterSession(
        user.waiterId,
      );
      await assertTableAvailableForNewOrder(hotelKeys, input.tableNo, waiter, {
        allowOwned: Boolean(addingToExistingTable),
      });
      const menuItems = await prisma.item.findMany({
        where: hotelNameWhere(hotelKeys),
        select: {
          name: true,
          recipeJson: true,
          isSuspended: true,
        },
      });
      const title = String(input.title || "").trim();
      const menuHit = menuItems.find(
        (i) =>
          String(i.name || "")
            .trim()
            .toLowerCase() === title.toLowerCase(),
      );
      if (menuHit?.isSuspended) {
        throw new Error(`“${title}” is suspended and cannot be ordered.`);
      }
      await assertRecipeStationStockForOrder(prisma, {
        hotelName: tin,
        hotelKeys,
        title,
        category: input.category,
        type: input.type,
        servings: input.orderAmount,
        modules,
        tenantHasModule,
      });
      const serviceCaption =
        (input.serviceCaption && String(input.serviceCaption).trim()) ||
        (await serviceCaptionForTableNo(input.tableNo, hotelKeys));
      return prisma.order.create({
        data: {
          title,
          imageUrl: input.imageUrl,
          tableNo: input.tableNo,
          waiterName: waiter.name,
          waiterId: waiter.id,
          orderAmount: input.orderAmount,
          status: input.status || "Pending",
          HotelName: tin,
          payment: input.payment || "Unpaid",
          category: input.category,
          type: input.type,
          price: input.price,
          unitCostAtSale: unitCostAtSaleFromItems(menuItems, title),
          serviceCaption,
        },
      });
    },
    WaiterBatchOrderCreation: async (
      _,
      { orders, addingToExistingTable },
      context,
    ) => {
      const user = assertWaiter(context);
      const { waiter, modules, tin, hotelKeys } = await loadWaiterSession(
        user.waiterId,
      );
      if (!orders?.length) return [];
      const tableNos = [...new Set(orders.map((o) => Number(o.tableNo)))];
      for (const tableNo of tableNos) {
        await assertTableAvailableForNewOrder(hotelKeys, tableNo, waiter, {
          allowOwned: Boolean(addingToExistingTable),
        });
      }
      const menuItems = await prisma.item.findMany({
        where: hotelNameWhere(hotelKeys),
        select: {
          name: true,
          recipeJson: true,
          isSuspended: true,
        },
      });
      for (const orderData of orders) {
        const title = String(orderData.title || "").trim();
        const menuHit = menuItems.find(
          (i) =>
            String(i.name || "")
              .trim()
              .toLowerCase() === title.toLowerCase(),
        );
        if (menuHit?.isSuspended) {
          throw new Error(`“${title}” is suspended and cannot be ordered.`);
        }
        await assertRecipeStationStockForOrder(prisma, {
          hotelName: tin,
          hotelKeys,
          title,
          category: orderData.category,
          type: orderData.type,
          servings: orderData.orderAmount,
          modules,
          tenantHasModule,
        });
      }
      const rows = [];
      for (const orderData of orders) {
        const title = String(orderData.title || "").trim();
        const serviceCaption =
          (orderData.serviceCaption &&
            String(orderData.serviceCaption).trim()) ||
          (await serviceCaptionForTableNo(orderData.tableNo, hotelKeys));
        rows.push(
          await prisma.order.create({
            data: {
              title,
              imageUrl: orderData.imageUrl,
              tableNo: orderData.tableNo,
              waiterName: waiter.name,
              waiterId: waiter.id,
              orderAmount: orderData.orderAmount,
              status: orderData.status || "Pending",
              HotelName: tin,
              payment: orderData.payment || "Unpaid",
              category: orderData.category,
              type: orderData.type,
              price: orderData.price,
              unitCostAtSale: unitCostAtSaleFromItems(menuItems, title),
              serviceCaption,
            },
          }),
        );
      }
      return rows;
    },
    WaiterUpdateLiveOrder: async (
      _,
      { id, tableNo, orderAmount, title },
      context,
    ) => {
      const user = assertWaiter(context);
      const { waiter, modules, tin, hotelKeys } = await loadWaiterSession(
        user.waiterId,
      );
      const order = await prisma.order.findUnique({ where: { id } });
      if (!order || Number(order.waiterId) !== waiter.id) {
        throw new Error("Order not found or not yours");
      }
      if (String(order.payment || "").toLowerCase() === "paid") {
        throw new Error("Paid orders cannot be edited");
      }
      const data = {};
      if (tableNo != null) data.tableNo = tableNo;
      if (orderAmount != null) data.orderAmount = orderAmount;
      if (title != null) data.title = title;
      if (orderAmount != null || title != null) {
        const menuItems = await prisma.item.findMany({
          where: hotelNameWhere(hotelKeys),
          select: {
            name: true,
            recipeJson: true,
            isSuspended: true,
          },
        });
        const nextTitle = title != null ? String(title).trim() : order.title;
        const menuHit = menuItems.find(
          (i) =>
            String(i.name || "")
              .trim()
              .toLowerCase() === nextTitle.toLowerCase(),
        );
        if (menuHit?.isSuspended) {
          throw new Error(`“${nextTitle}” is suspended and cannot be ordered.`);
        }
        await assertRecipeStationStockForOrder(prisma, {
          hotelName: tin,
          hotelKeys,
          title: nextTitle,
          category: order.category,
          type: order.type,
          servings: orderAmount != null ? orderAmount : order.orderAmount,
          modules,
          tenantHasModule,
        });
      }
      data.orderRevisedAt = new Date();
      data.orderRevisionCount = (order.orderRevisionCount || 0) + 1;
      return prisma.order.update({ where: { id }, data });
    },
    RequestWaiterPaymentApproval: async (
      _,
      { orderIds, amountPaid, paymentMethod, withBank, requestNote, tableNo },
      context,
    ) => {
      const user = assertWaiter(context);
      const session = await loadWaiterSession(user.waiterId);
      const { waiter, tin } = session;
      if (!session.waiterPaymentApprovalEnabled) {
        throw new Error("Payment approval requests are not enabled");
      }
      const ids = (orderIds || [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) throw new Error("Select at least one order");
      const method = String(paymentMethod || "").trim();
      if (!method) throw new Error("Payment method is required");
      const amount = Number(amountPaid);
      if (!(amount > 0)) throw new Error("Amount paid must be greater than zero");

      const orders = await prisma.order.findMany({
        where: {
          id: { in: ids },
          waiterId: waiter.id,
        },
      });
      if (orders.length !== ids.length) {
        throw new Error("One or more orders are not yours");
      }
      for (const o of orders) {
        if (String(o.payment || "").toLowerCase() === "paid") {
          throw new Error("Cannot request approval for a paid order");
        }
        if (o.paymentApprovalRequestId) {
          throw new Error("An approval request is already pending for an order");
        }
        const status = String(o.status || "").toLowerCase();
        if (status === "cancelled" || status === "failed") {
          throw new Error("Cancelled or failed orders cannot be submitted");
        }
        if (status !== "completed") {
          throw new Error(
            "Only kitchen/bar completed orders can request payment approval",
          );
        }
      }

      const selectedTotal = orders.reduce(
        (sum, o) =>
          sum + (Number(o.price) || 0) * (Number(o.orderAmount) || 0),
        0,
      );
      if (amount > selectedTotal + 0.001) {
        throw new Error("Amount paid cannot exceed the selected total");
      }

      const bank =
        withBank === true ||
        ["bank", "transfer", "withbank"].includes(method.toLowerCase());

      const request = await prisma.waiter_payment_approval_request.create({
        data: {
          HotelName: tin,
          waiterId: waiter.id,
          waiterName: waiter.name,
          orderIds: ids,
          tableNo: tableNo != null ? Number(tableNo) : orders[0]?.tableNo ?? null,
          amountPaid: amount,
          paymentMethod: method,
          withBank: bank,
          status: "pending",
          requestNote:
            requestNote != null && String(requestNote).trim() !== ""
              ? String(requestNote).trim()
              : null,
        },
      });

      await prisma.order.updateMany({
        where: { id: { in: ids } },
        data: { paymentApprovalRequestId: request.id },
      });

      return request;
    },
  },
};

const app = express();
app.use(cors());

const server = new ApolloServer({
  typeDefs,
  resolvers,
  context: ({ req }) => ({ user: authenticate(req), prisma }),
});

await server.start();
server.applyMiddleware({ app, path: "/graphql" });

app.get("/health", (_req, res) => res.json({ ok: true, service: "hotcol-waiter" }));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`HotCol Waiter GraphQL on http://localhost:${PORT}/graphql`);
  });
}

export default app;
