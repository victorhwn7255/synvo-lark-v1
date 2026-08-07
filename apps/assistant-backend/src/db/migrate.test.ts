import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Pool } from "pg";

import { isPhase2SchemaReady } from "./migrate.js";

type MigrationRecord = {
  name: string;
  checksum: string;
};

const completeTables = [
  "inbox_events",
  "lark_oauth_grants",
  "lark_oauth_sessions",
  "lark_delivery_jobs",
  "organize_folder_runs",
  "schema_migrations",
] as const;

function queryResult<T>(rows: T[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function poolWithSchema(options: {
  tableNames?: Array<string | null>;
  migrations?: MigrationRecord[];
  migrationError?: unknown;
  onMigrationQuery?: () => void;
}): Pick<Pool, "query"> {
  return {
    async query(query: unknown) {
      const sql = typeof query === "string" ? query : "";
      if (sql.includes("to_regclass")) {
        return queryResult(
          (options.tableNames ?? [...completeTables]).map((table_name) => ({
            table_name,
          })),
        );
      }
      if (sql.includes("FROM schema_migrations")) {
        options.onMigrationQuery?.();
        if (options.migrationError) {
          throw options.migrationError;
        }
        return queryResult(options.migrations ?? []);
      }
      throw new Error("Unexpected schema readiness query");
    },
  } as Pick<Pool, "query">;
}

async function withMigrationDirectory(
  files: Record<string, string>,
  run: (directory: string, expected: MigrationRecord[]) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "synvo-phase2-migrations-"));
  const expected = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, sql]) => ({
      name,
      checksum: createHash("sha256").update(sql).digest("hex"),
    }));
  try {
    await Promise.all(
      Object.entries(files).map(([name, sql]) =>
        writeFile(join(directory, name), sql, "utf8"),
      ),
    );
    await run(directory, expected);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const migrationFiles = {
  "0001_phase2.sql": "SELECT 1;\n",
  "0002_delivery.sql": "SELECT 2;\n",
};

test("reports the complete Phase 2 schema and migration ledger as ready", async () => {
  await withMigrationDirectory(migrationFiles, async (directory, expected) => {
    assert.equal(
      await isPhase2SchemaReady(
        poolWithSchema({ migrations: expected }),
        directory,
      ),
      true,
    );
  });
});

test("fails readiness without querying a missing schema_migrations table", async () => {
  let queriedMigrationLedger = false;
  assert.equal(
    await isPhase2SchemaReady(
      poolWithSchema({
        tableNames: [...completeTables.slice(0, -1), null],
        onMigrationQuery: () => {
          queriedMigrationLedger = true;
        },
      }),
      "/unused-because-the-table-check-fails",
    ),
    false,
  );
  assert.equal(queriedMigrationLedger, false);
});

test("fails readiness when another required Phase 2 table is missing", async () => {
  assert.equal(
    await isPhase2SchemaReady(
      poolWithSchema({
        tableNames: completeTables.map((name) =>
          name === "lark_delivery_jobs" ? null : name,
        ),
      }),
      "/unused-because-the-table-check-fails",
    ),
    false,
  );
});

test("fails readiness when an expected migration is missing", async () => {
  await withMigrationDirectory(migrationFiles, async (directory, expected) => {
    assert.equal(
      await isPhase2SchemaReady(
        poolWithSchema({ migrations: expected.slice(0, 1) }),
        directory,
      ),
      false,
    );
  });
});

test("fails readiness when an applied migration checksum differs", async () => {
  await withMigrationDirectory(migrationFiles, async (directory, expected) => {
    const changed = expected.map((migration, index) =>
      index === 0 ? { ...migration, checksum: "0".repeat(64) } : migration,
    );
    assert.equal(
      await isPhase2SchemaReady(
        poolWithSchema({ migrations: changed }),
        directory,
      ),
      false,
    );
  });
});

test("fails readiness when the migration ledger has an unexpected entry", async () => {
  await withMigrationDirectory(migrationFiles, async (directory, expected) => {
    assert.equal(
      await isPhase2SchemaReady(
        poolWithSchema({
          migrations: [
            ...expected,
            { name: "9999_unknown.sql", checksum: "f".repeat(64) },
          ],
        }),
        directory,
      ),
      false,
    );
  });
});

test("fails readiness if schema_migrations disappears between checks", async () => {
  await withMigrationDirectory(migrationFiles, async (directory) => {
    const missingTableError = Object.assign(new Error("relation missing"), {
      code: "42P01",
    });
    assert.equal(
      await isPhase2SchemaReady(
        poolWithSchema({ migrationError: missingTableError }),
        directory,
      ),
      false,
    );
  });
});
