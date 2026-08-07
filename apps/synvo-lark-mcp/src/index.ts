import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  LarkOAuthHttpClient,
  LarkTokenBroker,
  DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
  DRIVE_MOVE_SPIKE_USER_SCOPES,
  PostgresOAuthGrantStore,
  TokenCipher,
} from "@synvo/lark-auth";
import { Pool } from "pg";

import { loadMcpConfig } from "./config.js";
import { LarkDriveReader } from "./modules/drive/read-client.js";
import { PostgresDriveInventoryRunRepository } from "./repositories/inventory-run.js";
import { createSynvoLarkMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadMcpConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  const cipher = TokenCipher.fromEncodedKey(config.oauthTokenEncryptionKey);
  const oauthClient = new LarkOAuthHttpClient();
  const grantStore = new PostgresOAuthGrantStore(pool, {
    scopeProfile: DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
  });
  const tokenBroker = new LarkTokenBroker({
    clientId: config.appId,
    clientSecret: config.appSecret,
    cipher,
    grantStore,
    oauthClient,
    requiredScopes: DRIVE_MOVE_SPIKE_USER_SCOPES,
  });
  const runRepository = new PostgresDriveInventoryRunRepository({
    pool,
    tokenBroker,
    cipher,
    rootToken: config.organizeFolderRootToken,
  });
  const driveReader = new LarkDriveReader();
  const server = createSynvoLarkMcpServer({ runRepository, driveReader });
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await server.close();
    await pool.end();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await server.connect(transport);
  console.error("[mcp] synvo-lark-mcp read-only server is ready");
}

void main().catch(() => {
  console.error("[mcp] synvo-lark-mcp failed to start");
  process.exitCode = 1;
});
