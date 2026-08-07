import { TokenCipher } from "@synvo/lark-auth";

export type McpConfig = {
  appId: string;
  appSecret: string;
  databaseUrl: string;
  oauthTokenEncryptionKey: string;
  organizeFolderRootToken: string;
};

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized || /replace|example/i.test(normalized)) {
    throw new Error(`${name} is missing from the MCP environment`);
  }
  return normalized;
}

export function loadMcpConfig(
  environment: NodeJS.ProcessEnv = process.env,
): McpConfig {
  const appId = required(environment.LARK_APP_ID, "LARK_APP_ID");
  const appSecret = required(environment.LARK_APP_SECRET, "LARK_APP_SECRET");
  const databaseUrl = required(environment.DATABASE_URL, "DATABASE_URL");
  const oauthTokenEncryptionKey = required(
    environment.OAUTH_TOKEN_ENCRYPTION_KEY,
    "OAUTH_TOKEN_ENCRYPTION_KEY",
  );
  const organizeFolderRootToken = required(
    environment.ORGANIZE_FOLDER_ROOT_TOKEN,
    "ORGANIZE_FOLDER_ROOT_TOKEN",
  );
  const writesEnabled = environment.ORGANIZE_FOLDER_WRITE_ENABLED?.trim().toLowerCase();

  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new Error("LARK_APP_ID has an invalid format");
  }
  if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  TokenCipher.fromEncodedKey(oauthTokenEncryptionKey);
  if (!/^[A-Za-z0-9_-]+$/.test(organizeFolderRootToken)) {
    throw new Error("ORGANIZE_FOLDER_ROOT_TOKEN has an invalid format");
  }
  if (writesEnabled && writesEnabled !== "false") {
    throw new Error(
      "ORGANIZE_FOLDER_WRITE_ENABLED must remain false in the normal MCP server",
    );
  }

  return {
    appId,
    appSecret,
    databaseUrl,
    oauthTokenEncryptionKey,
    organizeFolderRootToken,
  };
}
