import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import type { AnalyzeDriveFileResult } from "../workflows/analyze-drive-file/workflow.js";
import type { DriveFolderInventoryResult } from "../workflows/organize-folder/contracts.js";
import { createSynvoMcpEndpoint, type SynvoMcpEndpoint } from "./server.js";

const authToken = "m".repeat(43);
const folderUrl = "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123";
const inventoryResult: DriveFolderInventoryResult = {
  ok: true,
  inventory: {
    run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
    workspace_identity_digest: "a".repeat(64),
    complete: true,
    folders: [{
      ref: "folder-1", identity_digest: "b".repeat(64), name: "Research",
      relative_path: "Research", parent_ref: "root", depth: 1,
      owned_by_requester: true,
    }],
    files: [{
      ref: "file-1", identity_digest: "c".repeat(64), name: "paper.pdf",
      relative_path: "Research / paper.pdf", parent_ref: "folder-1",
      parent_path: "Research", version: "1",
    }],
  },
};
const analysisResult: AnalyzeDriveFileResult = {
  ok: true,
  analysis: {
    filename: "paper.pdf", page_count: 2, text: "Grounded result",
    input_truncated: false, output_truncated: false,
  },
};
const knowledgeResult = {
  supported: true,
  answer: "The workspace uses bounded retrieval.",
  citations: [{ sourceName: "Research / paper.pdf", pageNumber: 2 }],
};

async function withEndpoint(
  endpoint: SynvoMcpEndpoint,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => void endpoint.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await endpoint.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function endpoint(options: {
  inventoryCalls?: unknown[];
  analysisCalls?: unknown[];
  knowledgeCalls?: unknown[];
} = {}) {
  return createSynvoMcpEndpoint({
    authToken,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    inventoryReader: {
      async readInventory(request) {
        options.inventoryCalls?.push(request);
        return inventoryResult;
      },
    },
    driveFileAnalyzer: {
      async analyzeListedFile(request) {
        options.analysisCalls?.push(request);
        return analysisResult;
      },
    },
    knowledgeSearcher: {
      async searchWorkspace(question) {
        options.knowledgeCalls?.push(question);
        return knowledgeResult;
      },
    },
  });
}

test("rejects requests without the configured bearer credential", async () => {
  await withEndpoint(endpoint(), async (origin) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("exposes exactly three read-only, identity-pinned tools with safe inventory output", async () => {
  const inventoryCalls: unknown[] = [];
  const analysisCalls: unknown[] = [];
  const knowledgeCalls: unknown[] = [];
  await withEndpoint(endpoint({ inventoryCalls, analysisCalls, knowledgeCalls }), async (origin) => {
    const client = new Client({ name: "synvo-mcp-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), [
        "inspect_workspace", "analyze_drive_file", "search_workspace_knowledge",
      ]);
      assert.ok(listed.tools.every((tool) =>
        tool.annotations?.readOnlyHint === true &&
        tool.annotations.destructiveHint === false &&
        tool.inputSchema.additionalProperties === false
      ));

      const inspection = await client.callTool({
        name: "inspect_workspace", arguments: { folder_url: folderUrl },
      });
      assert.equal(inspection.isError, false);
      assert.deepEqual(inspection.structuredContent, {
        ok: true,
        workspace: {
          complete: true,
          folders: [{ name: "Research", path: "Research", depth: 1 }],
          pdfs: [{ name: "paper.pdf", path: "Research / paper.pdf", parent_path: "Research" }],
          totals: { folders: 1, eligible_pdfs: 1 },
        },
      });
      assert.doesNotMatch(JSON.stringify(inspection.structuredContent), /file-1|folder-1|identity_digest/u);
      assert.deepEqual(inventoryCalls, [{
        requesterOpenId: "ou_victor", tenantKey: "tenant_synvo", folderLink: folderUrl,
      }]);

      const analysis = await client.callTool({
        name: "analyze_drive_file",
        arguments: { folder_url: folderUrl, relative_path: "Research / paper.pdf" },
      });
      assert.equal(analysis.isError, false);
      assert.deepEqual(analysisCalls, [{
        requesterOpenId: "ou_victor", tenantKey: "tenant_synvo",
        folderLink: folderUrl, relativePath: "Research / paper.pdf",
      }]);

      await client.callTool({
        name: "search_workspace_knowledge", arguments: { question: "How does retrieval work?" },
      });
      assert.deepEqual(knowledgeCalls, ["How does retrieval work?"]);

      for (const invalid of [
        { name: "inspect_workspace", arguments: { folder_url: folderUrl, requester_open_id: "other" } },
        { name: "analyze_drive_file", arguments: { folder_url: folderUrl, file_name: "paper.pdf" } },
        { name: "search_workspace_knowledge", arguments: { question: "x", root_token: "other" } },
      ]) {
        assert.equal((await client.callTool(invalid)).isError, true);
      }
      assert.equal(inventoryCalls.length, 1);
      assert.equal(analysisCalls.length, 1);
      assert.equal(knowledgeCalls.length, 1);
    } finally {
      await client.close();
    }
  });
});
