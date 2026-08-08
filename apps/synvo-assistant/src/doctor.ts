import { loadConfig } from "./config.js";
import { isDatabaseSchemaReady } from "./db/migrate.js";
import { createDatabasePool } from "./db/pool.js";
import {
  DRIVE_INVENTORY_USER_SCOPES,
  hasExactScopes,
  PostgresOAuthGrantStore,
} from "./lark/auth/index.js";
import { digestFolderToken } from "./lark/drive/index.js";

type LatestRunRow = {
  state: string;
  root_token_digest: string;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createDatabasePool(config.databaseUrl);

  try {
    const schemaReady = await isDatabaseSchemaReady(pool);
    const identityConfigured = Boolean(
      config.authorizedOpenId && config.authorizedTenantKey,
    );
    const grant = identityConfigured
      ? await new PostgresOAuthGrantStore(pool).findBySubject(
          config.authorizedOpenId!,
          config.authorizedTenantKey!,
        )
      : null;
    const grantUsable = Boolean(
      grant &&
        !grant.revokedAt &&
        grant.refreshExpiresAt > new Date() &&
        hasExactScopes(grant.grantedScopes, DRIVE_INVENTORY_USER_SCOPES),
    );
    const latest = await pool.query<LatestRunRow>(
      `SELECT state, root_token_digest
         FROM organize_folder_runs
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    const latestRun = latest.rows[0];
    const latestRunTargetsRoot = latestRun
      ? latestRun.root_token_digest ===
        digestFolderToken(config.organizeFolderRootToken)
      : null;
    const latestRunTerminal = latestRun
      ? ["COMPLETED", "FAILED_NO_CHANGE"].includes(latestRun.state)
      : null;

    const report = {
      config_loaded: true,
      schema_ready: schemaReady,
      write_enabled: config.organizeFolderWriteEnabled,
      pilot_identity_configured: identityConfigured,
      mcp_enabled: Boolean(config.synvoMcpAuthToken),
      readonly_grant_usable: grantUsable,
      latest_run_targets_allowlisted_root: latestRunTargetsRoot,
      latest_run_terminal: latestRunTerminal,
    };
    console.info(JSON.stringify(report, null, 2));
    if (
      !schemaReady ||
      config.organizeFolderWriteEnabled ||
      !identityConfigured ||
      !grantUsable ||
      latestRunTargetsRoot === false
    ) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  console.error("Doctor checks could not be completed safely.");
  process.exitCode = 1;
});
