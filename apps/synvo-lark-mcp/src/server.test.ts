import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { DriveScanFolderResult } from "@synvo/contracts";
import { LarkAuthError, type LarkAuthErrorCode } from "@synvo/lark-auth";

import type { DriveReader } from "./modules/drive/client.js";
import { driveToolError } from "./modules/drive/errors.js";
import type { PostgresDriveRunRepository } from "./repositories/run-context.js";
import { createSynvoLarkMcpServer } from "./server.js";

const runId = "4d872758-1f71-4ed8-b141-a2d193ceea91";

async function callToolWithAuthError(error: LarkAuthError): Promise<{
  failedCode: string | null;
  result: DriveScanFolderResult;
}> {
  let failedCode: string | null = null;
  const runRepository = {
    async resolve() {
      return {
        kind: "claimed" as const,
        scanAttempt: 7,
        async loadContext() {
          throw error;
        },
      };
    },
    async complete() {},
    async fail(
      _runId: string,
      scanAttempt: number,
      result: DriveScanFolderResult,
    ) {
      assert.equal(scanAttempt, 7);
      failedCode = result.error?.code ?? null;
    },
  } as unknown as PostgresDriveRunRepository;
  const driveReader = {
    async listFolderPage() {
      throw new Error("unused");
    },
    async getMetadata() {
      throw new Error("unused");
    },
  } as DriveReader;
  const server = createSynvoLarkMcpServer({ runRepository, driveReader });
  const client = new Client({ name: "phase2-error-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const response = await client.callTool({
      name: "drive_scan_folder",
      arguments: { run_id: runId },
    });
    return {
      failedCode,
      result: response.structuredContent as DriveScanFolderResult,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

test("exposes only the bounded read-only Drive inventory tool", async () => {
  const runRepository = {
    async resolve() {
      throw new Error("unused");
    },
    async complete() {},
    async fail() {},
  } as unknown as PostgresDriveRunRepository;
  const driveReader = {
    async listFolderPage() {
      throw new Error("unused");
    },
    async getMetadata() {
      throw new Error("unused");
    },
  } as DriveReader;
  const server = createSynvoLarkMcpServer({ runRepository, driveReader });
  const client = new Client({ name: "phase2-contract-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["drive_scan_folder"],
    );
    assert.deepEqual(
      Object.keys(tools.tools[0]?.inputSchema.properties ?? {}),
      ["run_id"],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("rejects every MCP argument except the server-owned run ID", async () => {
  let resolveCalls = 0;
  const runRepository = {
    async resolve() {
      resolveCalls += 1;
      throw new Error("must not be called");
    },
    async complete() {},
    async fail() {},
  } as unknown as PostgresDriveRunRepository;
  const driveReader = {
    async listFolderPage() {
      throw new Error("unused");
    },
    async getMetadata() {
      throw new Error("unused");
    },
  } as DriveReader;
  const server = createSynvoLarkMcpServer({ runRepository, driveReader });
  const client = new Client({ name: "phase2-strict-input-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const privateValue = "must-not-cross-the-boundary";
    const response = await client.callTool({
      name: "drive_scan_folder",
      arguments: { run_id: runId, access_token: privateValue },
    });
    assert.equal(response.isError, true);
    assert.equal(JSON.stringify(response).includes(privateValue), false);
    assert.equal(resolveCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("does not fail a run that the MCP process did not claim", async () => {
  let failCalls = 0;
  const runRepository = {
    async resolve() {
      throw driveToolError(
        "RUN_NOT_READY",
        "Another process owns the active scan lease.",
        true,
      );
    },
    async complete() {},
    async fail() {
      failCalls += 1;
    },
  } as unknown as PostgresDriveRunRepository;
  const driveReader = {
    async listFolderPage() {
      throw new Error("unused");
    },
    async getMetadata() {
      throw new Error("unused");
    },
  } as DriveReader;
  const server = createSynvoLarkMcpServer({ runRepository, driveReader });
  const client = new Client({ name: "phase2-lease-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const response = await client.callTool({
      name: "drive_scan_folder",
      arguments: { run_id: runId },
    });
    const result = response.structuredContent as DriveScanFolderResult;
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "RUN_NOT_READY");
    assert.equal(result.error?.retryable, true);
    assert.equal(failCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("maps every Lark authorization failure deliberately", async (t) => {
  const cases: ReadonlyArray<{
    authCode: LarkAuthErrorCode;
    safeCode:
      | "OAUTH_REQUIRED"
      | "OAUTH_REVOKED"
      | "LARK_RETRYABLE"
      | "WRONG_TENANT"
      | "UNAUTHORIZED"
      | "LARK_PERMANENT";
    retryable: boolean;
  }> = [
    {
      authCode: "OAUTH_REQUIRED",
      safeCode: "OAUTH_REQUIRED",
      retryable: false,
    },
    {
      authCode: "OAUTH_REVOKED",
      safeCode: "OAUTH_REVOKED",
      retryable: false,
    },
    {
      authCode: "OAUTH_RETRYABLE",
      safeCode: "LARK_RETRYABLE",
      retryable: true,
    },
    {
      authCode: "WRONG_SCOPE",
      safeCode: "OAUTH_REQUIRED",
      retryable: false,
    },
    {
      authCode: "WRONG_TENANT",
      safeCode: "WRONG_TENANT",
      retryable: false,
    },
    {
      authCode: "WRONG_USER",
      safeCode: "UNAUTHORIZED",
      retryable: false,
    },
    {
      authCode: "OAUTH_REJECTED",
      safeCode: "LARK_PERMANENT",
      retryable: false,
    },
    {
      authCode: "OAUTH_MALFORMED",
      safeCode: "LARK_PERMANENT",
      retryable: false,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.authCode, async () => {
      const { failedCode, result } = await callToolWithAuthError(
        new LarkAuthError(
          testCase.authCode,
          "Provider details must not cross the MCP boundary.",
        ),
      );

      assert.equal(result.ok, false);
      assert.equal(result.error?.code, testCase.safeCode);
      assert.equal(result.error?.retryable, testCase.retryable);
      assert.equal(
        result.error?.message.includes("Provider details"),
        false,
      );
      assert.equal(failedCode, testCase.safeCode);
    });
  }
});
