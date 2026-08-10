import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

const validEnvironment = {
  LARK_APP_ID: "cli_0123456789abcdef",
  LARK_APP_SECRET: "local-secret",
  DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/database",
  LARK_OAUTH_REDIRECT_URI: "http://localhost:3000/oauth/lark/callback",
  OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64url"),
  ORGANIZE_FOLDER_ROOT_TOKEN: "fldcnRoot123",
  LLM_API_KEY: "nvidia-test-key-with-safe-length",
};

test("loads production-aligned assistant configuration", () => {
  assert.deepEqual(loadConfig(validEnvironment), {
    appId: "cli_0123456789abcdef",
    appSecret: "local-secret",
    databaseUrl: "postgresql://user:password@127.0.0.1:5432/database",
    httpHost: "127.0.0.1",
    httpPort: 3000,
    larkOAuthRedirectUri: "http://localhost:3000/oauth/lark/callback",
    oauthTokenEncryptionKey: Buffer.alloc(32, 4).toString("base64url"),
    authorizedOpenId: undefined,
    authorizedTenantKey: undefined,
    authorizedFirstName: undefined,
    larkLoadingImageKey: undefined,
    synvoMcpAuthToken: undefined,
    organizeFolderRootToken: "fldcnRoot123",
    organizeFolderWriteEnabled: false,
    llmApiKey: "nvidia-test-key-with-safe-length",
  });
});

test("loads explicit pilot identity and write switch configuration", () => {
  const config = loadConfig({
    ...validEnvironment,
    LARK_AUTHORIZED_OPEN_ID: "ou_victor",
    LARK_AUTHORIZED_TENANT_KEY: "tenant_synvo",
    LARK_AUTHORIZED_FIRST_NAME: "Victor",
    LARK_LOADING_IMAGE_KEY: "img_v2_loading_hourglass",
    ORGANIZE_FOLDER_WRITE_ENABLED: "true",
    SYNVO_MCP_AUTH_TOKEN: "m".repeat(43),
  });

  assert.equal(config.authorizedOpenId, "ou_victor");
  assert.equal(config.authorizedTenantKey, "tenant_synvo");
  assert.equal(config.authorizedFirstName, "Victor");
  assert.equal(config.larkLoadingImageKey, "img_v2_loading_hourglass");
  assert.equal(config.synvoMcpAuthToken, "m".repeat(43));
  assert.equal(config.organizeFolderWriteEnabled, true);
});

test("rejects a first name without the authorized pilot identity", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        LARK_AUTHORIZED_FIRST_NAME: "Victor",
      }),
    /requires the authorized pilot identity/,
  );
});

test("rejects an invalid organize-folder write switch", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        ORGANIZE_FOLDER_WRITE_ENABLED: "yes",
      }),
    /ORGANIZE_FOLDER_WRITE_ENABLED must be true or false/,
  );
});

test("rejects a missing organize-folder root token", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        ORGANIZE_FOLDER_ROOT_TOKEN: "",
      }),
    /ORGANIZE_FOLDER_ROOT_TOKEN is missing/,
  );
});

test("rejects a folder URL instead of a root token", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        ORGANIZE_FOLDER_ROOT_TOKEN:
          "https://example.larksuite.com/drive/folder/fldcnRoot123",
      }),
    /ORGANIZE_FOLDER_ROOT_TOKEN must be a folder token/,
  );
});

test("rejects missing credentials", () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, LARK_APP_ID: "" }),
    /LARK_APP_ID is missing/,
  );
});

test("rejects an invalid App ID", () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, LARK_APP_ID: "not-an-app-id" }),
    /LARK_APP_ID must look like/,
  );
});

test("rejects a non-loopback HTTP OAuth redirect", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        LARK_OAUTH_REDIRECT_URI:
          "http://synvo-assistant-staging.synvo.ai/oauth/lark/callback",
      }),
    /must use HTTPS or an HTTP loopback host/,
  );
});

test("rejects an OAuth redirect with the wrong path", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        LARK_OAUTH_REDIRECT_URI: "http://localhost:3000/other-callback",
      }),
    /exact \/oauth\/lark\/callback/,
  );
});

test("rejects an invalid token-encryption key", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64url"),
      }),
    /exactly 32 bytes/,
  );
});

test("requires both optional pilot identity values together", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        LARK_AUTHORIZED_OPEN_ID: "ou_victor",
      }),
    /must be configured together/,
  );
});

test("rejects a weak MCP bearer token", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        LARK_AUTHORIZED_OPEN_ID: "ou_victor",
        LARK_AUTHORIZED_TENANT_KEY: "tenant_synvo",
        SYNVO_MCP_AUTH_TOKEN: "too-short",
      }),
    /SYNVO_MCP_AUTH_TOKEN must be 43-256 base64url characters/,
  );
});

test("requires a fixed pilot identity when MCP is enabled", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        SYNVO_MCP_AUTH_TOKEN: "m".repeat(43),
      }),
    /SYNVO_MCP_AUTH_TOKEN requires the authorized pilot identity/,
  );
});

test("rejects missing, placeholder, and malformed NVIDIA credentials", () => {
  for (const apiKey of ["", "replace_with_nvidia_api_key", "too-short"]) {
    assert.throws(
      () => loadConfig({ ...validEnvironment, LLM_API_KEY: apiKey }),
      /LLM_API_KEY/,
    );
  }
});
