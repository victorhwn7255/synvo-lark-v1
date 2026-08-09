export type AppConfig = {
  appId: string;
  appSecret: string;
  databaseUrl: string;
  httpHost: string;
  httpPort: number;
  larkOAuthRedirectUri: string;
  oauthTokenEncryptionKey: string;
  authorizedOpenId?: string;
  authorizedTenantKey?: string;
  synvoMcpAuthToken?: string;
  organizeFolderRootToken: string;
  organizeFolderWriteEnabled: boolean;
  llmApiKey: string;
};

function readRequiredValue(
  value: string | undefined,
  name: string,
  placeholders: readonly string[] = [],
): string {
  const normalized = value?.trim();
  if (!normalized || placeholders.includes(normalized)) {
    throw new Error(`${name} is missing from .env`);
  }
  return normalized;
}

function readBooleanFlag(value: string | undefined, name: string): boolean {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized === "false") {
    return false;
  }

  if (normalized === "true") {
    return true;
  }

  throw new Error(`${name} must be true or false`);
}

function readFolderToken(value: string | undefined): string {
  const token = value?.trim();

  if (!token) {
    throw new Error("ORGANIZE_FOLDER_ROOT_TOKEN is missing from .env");
  }

  if (
    token.includes("://") ||
    token.includes("/") ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new Error(
      "ORGANIZE_FOLDER_ROOT_TOKEN must be a folder token, not a URL",
    );
  }

  if (/replace|example/i.test(token)) {
    throw new Error("ORGANIZE_FOLDER_ROOT_TOKEN is missing from .env");
  }

  return token;
}

export function readDatabaseUrl(value: string | undefined): string {
  const databaseUrl = readRequiredValue(value, "DATABASE_URL", [
    "postgresql://replace_me",
  ]);
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  }
  return databaseUrl;
}

function readOAuthRedirectUri(value: string | undefined): string {
  const redirectUri = readRequiredValue(value, "LARK_OAUTH_REDIRECT_URI", [
    "https://replace.example/oauth/lark/callback",
  ]);
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error("LARK_OAUTH_REDIRECT_URI must be an absolute URL");
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const secure = parsed.protocol === "https:";
  const local = parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname);
  if (!secure && !local) {
    throw new Error(
      "LARK_OAUTH_REDIRECT_URI must use HTTPS or an HTTP loopback host",
    );
  }
  if (
    parsed.pathname !== "/oauth/lark/callback" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "LARK_OAUTH_REDIRECT_URI must be the exact /oauth/lark/callback URL",
    );
  }
  return parsed.toString();
}

function readEncryptionKey(value: string | undefined): string {
  const encoded = readRequiredValue(value, "OAUTH_TOKEN_ENCRYPTION_KEY", [
    "replace_with_32_random_bytes_base64url",
  ]);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 32) {
    throw new Error(
      "OAUTH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes",
    );
  }
  return encoded;
}

function readHttpPort(value: string | undefined): number {
  if (!value?.trim()) {
    return 3000;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HTTP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readHttpHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (!new Set(["127.0.0.1", "0.0.0.0", "::1", "::"]).has(host)) {
    throw new Error("HTTP_HOST must be an explicit loopback or wildcard address");
  }
  return host;
}

function readLlmApiKey(environment: NodeJS.ProcessEnv): string {
  const apiKey = readRequiredValue(environment.LLM_API_KEY, "LLM_API_KEY", [
    "replace_with_nvidia_api_key",
    "replace_locally_only",
  ]);
  if (apiKey.length < 20 || apiKey.length > 512 || /\s/u.test(apiKey)) {
    throw new Error("LLM_API_KEY is malformed");
  }
  return apiKey;
}

// Defends Synvo tools against callers using a guessable MCP bearer credential.
function readOptionalMcpAuthToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) {
    throw new Error(
      "SYNVO_MCP_AUTH_TOKEN must be 43-256 base64url characters",
    );
  }
  return token;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const appId = environment.LARK_APP_ID?.trim();
  const appSecret = environment.LARK_APP_SECRET?.trim();
  const organizeFolderWriteEnabled = readBooleanFlag(
    environment.ORGANIZE_FOLDER_WRITE_ENABLED,
    "ORGANIZE_FOLDER_WRITE_ENABLED",
  );

  if (!appId || appId === "cli_replace_me") {
    throw new Error("LARK_APP_ID is missing from .env");
  }

  if (!appSecret || appSecret === "replace_me") {
    throw new Error("LARK_APP_SECRET is missing from .env");
  }

  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new Error("LARK_APP_ID must look like cli_ followed by 16 hexadecimal characters");
  }

  const databaseUrl = readDatabaseUrl(environment.DATABASE_URL);
  const larkOAuthRedirectUri = readOAuthRedirectUri(
    environment.LARK_OAUTH_REDIRECT_URI,
  );
  const oauthTokenEncryptionKey = readEncryptionKey(
    environment.OAUTH_TOKEN_ENCRYPTION_KEY,
  );
  const authorizedOpenId = environment.LARK_AUTHORIZED_OPEN_ID?.trim() || undefined;
  const authorizedTenantKey =
    environment.LARK_AUTHORIZED_TENANT_KEY?.trim() || undefined;
  if (Boolean(authorizedOpenId) !== Boolean(authorizedTenantKey)) {
    throw new Error(
      "LARK_AUTHORIZED_OPEN_ID and LARK_AUTHORIZED_TENANT_KEY must be configured together",
    );
  }
  const synvoMcpAuthToken = readOptionalMcpAuthToken(
    environment.SYNVO_MCP_AUTH_TOKEN,
  );
  if (synvoMcpAuthToken && (!authorizedOpenId || !authorizedTenantKey)) {
    throw new Error(
      "SYNVO_MCP_AUTH_TOKEN requires the authorized pilot identity",
    );
  }
  const organizeFolderRootToken = readFolderToken(
    environment.ORGANIZE_FOLDER_ROOT_TOKEN,
  );
  const llmApiKey = readLlmApiKey(environment);

  return {
    appId,
    appSecret,
    databaseUrl,
    httpHost: readHttpHost(environment.HTTP_HOST),
    httpPort: readHttpPort(environment.HTTP_PORT),
    larkOAuthRedirectUri,
    oauthTokenEncryptionKey,
    authorizedOpenId,
    authorizedTenantKey,
    synvoMcpAuthToken,
    organizeFolderRootToken,
    organizeFolderWriteEnabled,
    llmApiKey,
  };
}
