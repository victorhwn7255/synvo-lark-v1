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
    workspace_identity_digest: "a".repeat(64),
    complete: true,
    folders: [{
      ref: "folder-1",
      identity_digest: "b".repeat(64),
      name: "Research",
      relative_path: "Research",
      parent_ref: "root",
      depth: 1,
      owned_by_requester: true,
    }],
    files: [{
      ref: "file-1",
      identity_digest: "c".repeat(64),
      name: "paper.pdf",
      relative_path: "Research / paper.pdf",
      parent_ref: "folder-1",
      parent_path: "Research",
      version: "1",
    }],
  },
};
const safeInventory = {
  ok: true,
  workspace: {
    complete: true,
    folders: [{ name: "Research", path: "Research", depth: 1 }],
    pdfs: [{
      name: "paper.pdf",
      path: "Research / paper.pdf",
      parent_path: "Research",
    }],
    totals: { folders: 1, eligible_pdfs: 1 },
  },
};
const analysisResult: AnalyzeDriveFileResult = {
  ok: true,
  analysis: {
    filename: "paper.pdf",
    page_count: 2,
    text: "Grounded analysis",
    input_truncated: false,
    output_truncated: false,
  },
};
const knowledgeResult = {
  supported: true,
  answer: "The workspace uses bounded retrieval.",
  citations: [{ sourceName: "Research / paper.pdf", pageNumber: 2 }],
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
      assert.deepEqual(await client.inspectWorkspace(folderUrl), safeInventory);
      assert.deepEqual(
        await client.analyze(folderUrl, "Research / paper.pdf"),
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

test("fails safely for a rejected credential or malformed structured result", async () => {
  await withServer(async (url) => {
    const rejected = new SynvoMcpClient({ url, authToken: "x".repeat(43) });
    await assert.rejects(rejected.connect(), SynvoMcpClientError);
  });
  await withServer(async (url) => {
    const client = new SynvoMcpClient({ url, authToken });
    try {
      await client.connect();
      await assert.rejects(client.inspectWorkspace(folderUrl), SynvoMcpClientError);
    } finally {
      await client.close();
    }
  }, { inventoryResult: { ok: true, inventory: { files: [] } } });
});
