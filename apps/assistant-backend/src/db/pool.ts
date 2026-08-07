import { Pool } from "pg";

export function createDatabasePool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", () => {
    console.error("[database] an idle PostgreSQL connection failed");
  });

  return pool;
}
