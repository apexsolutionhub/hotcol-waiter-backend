import "dotenv/config";
import { createPrismaClient } from "../lib/prismaClient.js";

const prisma = createPrismaClient();
const w = await prisma.waiter.findUnique({ where: { passkey: "123456" } });
console.log(
  "waiter",
  w
    ? {
        id: w.id,
        name: w.name,
        HotelName: w.HotelName,
        isActive: w.isActive,
      }
    : null,
);
if (w) {
  const byTin = await prisma.tenant_account.findUnique({
    where: { tinNumber: w.HotelName },
  });
  console.log(
    "accountByHotelNameAsTin",
    byTin
      ? {
          tin: byTin.tinNumber,
          waiterOrderingEnabled: byTin.waiterOrderingEnabled,
          modules: byTin.modules,
        }
      : null,
  );
  const users = await prisma.user.findMany({
    where: {
      OR: [{ tinNumber: w.HotelName }, { HotelName: w.HotelName }],
    },
    select: {
      id: true,
      Role: true,
      HotelName: true,
      tinNumber: true,
      modules: true,
    },
    take: 5,
  });
  console.log("users", users);
  for (const u of users) {
    const tin = String(u.tinNumber || "").trim();
    if (!tin) continue;
    const acc = await prisma.tenant_account.findUnique({
      where: { tinNumber: tin },
    });
    console.log("accountForUserTin", tin, {
      waiterOrderingEnabled: acc?.waiterOrderingEnabled,
      display: acc?.hotelDisplayName,
    });
  }
}
await prisma.$disconnect();
