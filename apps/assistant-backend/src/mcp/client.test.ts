import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "../config.js";
import {
  type McpClientConnection,
  SynvoLarkMcpClient,
} from "./client.js";

const config: AppConfig = {
  appId: "cli_0123456789abcdef",
  appSecret: "secret",
  databaseUrl: "postgresql://localhost/database",
  httpHost: "127.0.0.1",
  httpPort: 3000,
  larkOAuthRedirectUri: "http://localhost:3000/oauth/lark/callback",
  oauthTokenEncryptionKey: Buffer.alloc(32, 1).toString("base64url"),
  organizeFolderRootToken: "fldcnRoot",
  organizeFolderWriteEnabled: false,
};

test("discards a failed MCP connection and reconnects on the next job attempt", async () => {
  let connections = 0;
  let closed = 0;
  const client = new SynvoLarkMcpClient(config, {
    connect: async () => {
      connections += 1;
      if (connections === 1) {
        return {
          async callTool() {
            throw new Error("stdio disconnected");
          },
          async close() {
            closed += 1;
          },
        } as unknown as McpClientConnection;
      }
      return {
        async callTool() {
          return {
            content: [],
            structuredContent: {
              ok: false,
              error: {
                code: "LARK_RETRYABLE",
                message: "Lark Drive is temporarily unavailable.",
                retryable: true,
              },
            },
          };
        },
        async close() {
          closed += 1;
        },
      } as unknown as McpClientConnection;
    },
  });

  await assert.rejects(
    client.scanFolder("9d8b0137-ab5d-4b88-bbc3-fef37e1849a2"),
    /stdio disconnected/,
  );
  const result = await client.scanFolder(
    "9d8b0137-ab5d-4b88-bbc3-fef37e1849a2",
  );

  assert.equal(connections, 2);
  assert.equal(closed, 1);
  assert.equal(result.ok, false);
  await client.close();
  assert.equal(closed, 2);
});
