import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.ts";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

/**
 * Shared MariaDB pool for all HotCol backends (user / apex / owner / room).
 * Keep this aligned with a known-working mariadb.createPool config.
 */
function resolveConnectionLimit() {
  const raw = process.env.DB_CONNECTION_LIMIT;
  const n = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
  if (Number.isFinite(n) && n >= 1 && n <= 50) return n;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return 3;
  return 5;
}

export function createPrismaClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Prisma");
  }

  const parsed = new URL(databaseUrl);
  const adapter = new PrismaMariaDb({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    connectionLimit: resolveConnectionLimit(),
    connectTimeout: 30_000,
    acquireTimeout: 30_000,
    allowPublicKeyRetrieval: true,
    ssl:
      parsed.searchParams.get("sslaccept") === "strict"
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false },
  });

  return new PrismaClient({ adapter });
}
