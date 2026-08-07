import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Pool } from "pg";

import { readDatabaseUrl } from "../config.js";
import { createDatabasePool } from "./pool.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../../database/migrations/", import.meta.url),
);

type AppliedMigration = {
  name: string;
  checksum: string;
};

type MigrationFile = AppliedMigration & {
  sql: string;
};

async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const filenames = (await readdir(directory))
    .filter((filename) => /^\d+_[a-z0-9_-]+\.sql$/i.test(filename))
    .sort();

  return Promise.all(
    filenames.map(async (name) => {
      const sql = await readFile(`${directory}/${name}`, "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export async function runMigrations(
  pool: Pool,
  directory = migrationsDirectory,
): Promise<string[]> {
  const migrations = await loadMigrationFiles(directory);
  const appliedNames: string[] = [];

  for (const { name, sql, checksum } of migrations) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_930_428_822]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const existing = await client.query<AppliedMigration>(
        "SELECT name, checksum FROM schema_migrations WHERE name = $1",
        [name],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.checksum !== checksum) {
          throw new Error(`Applied migration ${name} has changed`);
        }
        await client.query("COMMIT");
        continue;
      }

      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [name, checksum],
      );
      await client.query("COMMIT");
      appliedNames.push(name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return appliedNames;
}

const requiredTables = [
  "inbox_events",
  "lark_oauth_grants",
  "lark_oauth_sessions",
  "lark_delivery_jobs",
  "organize_folder_runs",
  "schema_migrations",
] as const;

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "42P01"
  );
}

export async function isDatabaseSchemaReady(
  pool: Pick<Pool, "query">,
  directory = migrationsDirectory,
): Promise<boolean> {
  const tableResult = await pool.query<{ table_name: string | null }>(
    `SELECT unnest(ARRAY[
        to_regclass('public.inbox_events')::text,
        to_regclass('public.lark_oauth_grants')::text,
        to_regclass('public.lark_oauth_sessions')::text,
        to_regclass('public.lark_delivery_jobs')::text,
        to_regclass('public.organize_folder_runs')::text,
        to_regclass('public.schema_migrations')::text
     ]) AS table_name`,
  );
  const observedTables = new Set(
    tableResult.rows
      .map((row) => row.table_name)
      .filter((name): name is string => typeof name === "string"),
  );
  if (!requiredTables.every((name) => observedTables.has(name))) {
    return false;
  }

  const expectedMigrations = await loadMigrationFiles(directory);
  if (expectedMigrations.length === 0) {
    return false;
  }

  try {
    const migrationResult = await pool.query<AppliedMigration>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    if (migrationResult.rows.length !== expectedMigrations.length) {
      return false;
    }
    return expectedMigrations.every(
      (expected, index) =>
        migrationResult.rows[index]?.name === expected.name &&
        migrationResult.rows[index]?.checksum === expected.checksum,
    );
  } catch (error) {
    if (isUndefinedTableError(error)) {
      return false;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const databaseUrl = readDatabaseUrl(process.env.DATABASE_URL);
  const pool = createDatabasePool(databaseUrl);
  try {
    const applied = await runMigrations(pool);
    console.info(`[database] applied ${applied.length} migration(s)`);
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch(() => {
    console.error("[database] migration failed");
    process.exitCode = 1;
  });
}
