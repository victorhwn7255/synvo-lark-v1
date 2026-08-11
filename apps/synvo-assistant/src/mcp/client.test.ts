import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import type { AnalyzeDriveFileResult } from "../workflows/analyze-drive-file/workflow.js";
import type { DriveFolderInventoryResult } from "../workflows/organize-folder/contracts.js";
import { SynvoMcpClient, SynvoMcpClientError } from "./client.js";
import { createSynvoMcpEndpoint } from "./server.js";

const authToken = "m".repeat(43);
const folderUrl = "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123";
const inventoryResult: DriveFolderInventoryResult = {
  ok: true,
  inventory: {
    run_id: "mcp-run",
    complete: true,
    baseline_matches: true,
    root: {
      ref: "root",
      identity_digest: "a".repeat(64),
      name: "Test_Synvo_AI_Assistant",
      parent_ref: null,
      owner_verification: "matched",
      child_count: 3,
    },
    destinations: [],
    files: [
      {
        ref: "f001",
        identity_digest: "b".repeat(64),
        name: "document-01.pdf",
        type: "file",
        parent_ref: "root",
        owner_verification: "matched",
      },
    ],
    skipped: [],
    issues: [],
    summary: {
      root_folder_count: 0,
      root_file_count: 1,
      root_skipped_count: 0,
      destination_child_count: 0,
    },
  },
};
const analysisResult: AnalyzeDriveFileResult = {
  ok: true,
  analysis: {
    filename: "document-01.pdf",
    page_count: 2,
    text: "Grounded analysis",
    input_truncated: false,
    output_truncated: false,
  },
};
const knowledgeResult = {
  supported: true,
  answer: "The workspace uses bounded retrieval.",
  citations: [{ sourceName: "document-01.pdf", pageNumber: 2 }],
};

async function withServer(
  run: (url: URL) => Promise<void>,
  options: { inventoryResult?: unknown } = {},
): Promise<void> {
  const endpoint = createSynvoMcpEndpoint({
    authToken,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    inventoryReader: {
      async readInventory() {
        return (options.inventoryResult ?? inventoryResult) as DriveFolderInventoryResult;
      },
    },
    driveFileAnalyzer: {
      async analyzeListedFile() { return analysisResult; },
    },
    knowledgeSearcher: {
      async searchWorkspace() { return knowledgeResult; },
    },
  });
  const server = createServer((request, response) => {
    void endpoint.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(new URL(`http://127.0.0.1:${address.port}/mcp`));
  } finally {
    await endpoint.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("calls the three exact read-only tools through the production MCP client", async () => {
  await withServer(async (url) => {
    const client = new SynvoMcpClient({ url, authToken });
    try {
      await client.connect();
      assert.deepEqual(await client.inventory(folderUrl), inventoryResult);
      assert.deepEqual(
        await client.analyze(folderUrl, "document-01.pdf"),
        analysisResult,
      );
      assert.deepEqual(
        await client.searchKnowledge("How does retrieval work?"),
        knowledgeResult,
      );
    } finally {
      await client.close();
    }
  });
});

test("fails safely when the MCP service credential is rejected", async () => {
  await withServer(async (url) => {
    const client = new SynvoMcpClient({
      url,
      authToken: "x".repeat(43),
    });
    await assert.rejects(
      client.connect(),
      (error: unknown) => error instanceof SynvoMcpClientError,
    );
  });
});

test("rejects malformed MCP structured content at the client boundary", async () => {
  await withServer(async (url) => {
    const client = new SynvoMcpClient({ url, authToken });
    try {
      await client.connect();
      await assert.rejects(
        client.inventory(folderUrl),
        (error: unknown) => error instanceof SynvoMcpClientError,
      );
    } finally {
      await client.close();
    }
  }, {
    inventoryResult: {
      ok: true,
      inventory: { baseline_matches: true, files: [] },
    },
  });
});
