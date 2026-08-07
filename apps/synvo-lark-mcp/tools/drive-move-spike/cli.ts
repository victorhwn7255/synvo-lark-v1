import { pathToFileURL } from "node:url";

import {
  LarkOAuthHttpClient,
  LarkTokenBroker,
  DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
  DRIVE_MOVE_SPIKE_USER_SCOPES,
  PostgresOAuthGrantStore,
  TokenCipher,
} from "@synvo/lark-auth";
import { Pool } from "pg";

import { LarkDriveReader } from "../../src/modules/drive/read-client.js";
import { LarkDriveMover } from "../../src/modules/drive/move-client.js";
import { DriveMoveSpikeHarness } from "./round-trip.js";
import { PostgresDriveMoveSpikeStore } from "./mutation-repository.js";

type OperatorConfig = {
  appId: string;
  appSecret: string;
  databaseUrl: string;
  encryptionKey: string;
  rootToken: string;
  authorizedOpenId: string;
  authorizedTenantKey: string;
  writesEnabled: boolean;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || /replace|example/i.test(value)) {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

function loadOperatorConfig(): OperatorConfig {
  const writes = process.env.ORGANIZE_FOLDER_WRITE_ENABLED?.trim().toLowerCase();
  if (writes !== undefined && writes !== "true" && writes !== "false") {
    throw new Error("ORGANIZE_FOLDER_WRITE_ENABLED_INVALID");
  }
  return {
    appId: required("LARK_APP_ID"),
    appSecret: required("LARK_APP_SECRET"),
    databaseUrl: required("DATABASE_URL"),
    encryptionKey: required("OAUTH_TOKEN_ENCRYPTION_KEY"),
    rootToken: required("ORGANIZE_FOLDER_ROOT_TOKEN"),
    authorizedOpenId: required("LARK_AUTHORIZED_OPEN_ID"),
    authorizedTenantKey: required("LARK_AUTHORIZED_TENANT_KEY"),
    writesEnabled: writes === "true",
  };
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "PHASE3_OPERATOR_FAILED";
  return /^PHASE3_[A-Z0-9_:]+$/.test(message)
    ? message.split(":", 1)[0]!
    : "PHASE3_OPERATOR_FAILED";
}

export async function runDriveMoveSpikeCli(argv = process.argv.slice(2)): Promise<void> {
  const config = loadOperatorConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 3 });
  try {
    const cipher = TokenCipher.fromEncodedKey(config.encryptionKey);
    const grantStore = new PostgresOAuthGrantStore(pool, {
      scopeProfile: DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
    });
    const tokenBroker = new LarkTokenBroker({
      clientId: config.appId,
      clientSecret: config.appSecret,
      cipher,
      grantStore,
      oauthClient: new LarkOAuthHttpClient(),
      requiredScopes: DRIVE_MOVE_SPIKE_USER_SCOPES,
    });
    const harness = new DriveMoveSpikeHarness({
      store: new PostgresDriveMoveSpikeStore(pool),
      tokenBroker,
      cipher,
      reader: new LarkDriveReader(),
      mover: new LarkDriveMover(),
      rootToken: config.rootToken,
      authorizedOpenId: config.authorizedOpenId,
      authorizedTenantKey: config.authorizedTenantKey,
      writesEnabled: config.writesEnabled,
    });

    const command = argv[0];
    if (command === "prepare") {
      if (config.writesEnabled) {
        throw new Error("PHASE3_PREPARE_REQUIRES_WRITE_DISABLED");
      }
      const result = await harness.prepare();
      console.info(JSON.stringify(result, null, 2));
      return;
    }
    if (command === "execute") {
      const batchId = argv[1];
      const explicitlyConfirmed = argv.includes("--confirm-drive-round-trip");
      if (!batchId || !zUuid(batchId)) {
        throw new Error("PHASE3_BATCH_ID_REQUIRED");
      }
      const result = await harness.execute(batchId, explicitlyConfirmed);
      console.info(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error("PHASE3_OPERATOR_COMMAND_INVALID");
  } finally {
    await pool.end();
  }
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDriveMoveSpikeCli().catch((error: unknown) => {
    console.error(JSON.stringify({ status: "fail", code: safeErrorCode(error) }));
    process.exitCode = 1;
  });
}
