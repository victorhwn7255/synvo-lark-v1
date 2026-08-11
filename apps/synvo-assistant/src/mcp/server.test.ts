import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import type { AnalyzeDriveFileResult } from "../workflows/analyze-drive-file/workflow.js";
import type { DriveFolderInventoryResult } from "../workflows/organize-folder/contracts.js";
import {
  createSynvoMcpEndpoint,
  type SynvoMcpEndpoint,
} from "./server.js";

const authToken = "m".repeat(43);
const identityDigest = "a".repeat(64);
const folderUrl =
  "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123";
const fileName = "pilot.pdf";
const inventoryResult: DriveFolderInventoryResult = {
  ok: true,
  inventory: {
    run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
    complete: true,
    baseline_matches: true,
    root: {
      ref: "root",
      identity_digest: identityDigest,
      name: "Test_Synvo_AI_Assistant",
      parent_ref: null,
      owner_verification: "matched",
      child_count: 3,
    },
    destinations: [
      {
        ref: "d001",
        identity_digest: "b".repeat(64),
        name: "Product",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
      {
        ref: "d002",
        identity_digest: "c".repeat(64),
        name: "Research",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
    ],
    files: [
      {
        ref: "f001",
        identity_digest: "d".repeat(64),
        name: fileName,
        type: "file",
        parent_ref: "root",
        owner_verification: "matched",
      },
    ],
    skipped: [],
    issues: [],
    summary: {
      root_folder_count: 2,
      root_file_count: 1,
      root_skipped_count: 0,
      destination_child_count: 0,
    },
  },
};
const analysisResult: AnalyzeDriveFileResult = {
  ok: true,
  analysis: {
    filename: "pilot.pdf",
    page_count: 2,
    text: "Grounded result",
    input_truncated: false,
    output_truncated: false,
  },
};
const knowledgeResult = {
  supported: true,
  answer: "The workspace uses bounded retrieval.",
  citations: [{ sourceName: "pilot.pdf", pageNumber: 2 }],
};

async function withEndpoint(
  endpoint: SynvoMcpEndpoint,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void endpoint.handle(request, response);
  });
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

test("rejects an MCP request without the configured bearer credential", async () => {
  const endpoint = createSynvoMcpEndpoint({
    authToken,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    inventoryReader: {
      async readInventory() {
        throw new Error("must not be called");
      },
    },
    driveFileAnalyzer: {
      async analyzeListedFile() {
        throw new Error("must not be called");
      },
    },
    knowledgeSearcher: {
      async searchWorkspace() {
        throw new Error("must not be called");
      },
    },
  });

  await withEndpoint(endpoint, async (origin) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
  });
});

test("lists and calls all read-only Synvo tools over Streamable HTTP", async () => {
  const inventoryCalls: unknown[] = [];
  const analysisCalls: unknown[] = [];
  const knowledgeCalls: unknown[] = [];
  const endpoint = createSynvoMcpEndpoint({
    authToken,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    inventoryReader: {
      async readInventory(request) {
        inventoryCalls.push(request);
        return inventoryResult;
      },
    },
    driveFileAnalyzer: {
      async analyzeListedFile(request) {
        analysisCalls.push(request);
        return analysisResult;
      },
    },
    knowledgeSearcher: {
      async searchWorkspace(question) {
        knowledgeCalls.push(question);
        return knowledgeResult;
      },
    },
  });

  await withEndpoint(endpoint, async (origin) => {
    const client = new Client(
      { name: "synvo-mcp-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${authToken}` },
        },
      },
    );

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        [
          "organize_folder_inventory",
          "analyze_drive_file",
          "search_workspace_knowledge",
        ],
      );
      for (const tool of listed.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
        assert.equal(tool.inputSchema.additionalProperties, false);
      }

      const result = await client.callTool({
        name: "organize_folder_inventory",
        arguments: { folder_url: folderUrl },
      });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, inventoryResult);
      assert.deepEqual(inventoryCalls, [
        {
          requesterOpenId: "ou_victor",
          tenantKey: "tenant_synvo",
          folderLink: folderUrl,
        },
      ]);

      const selectedFileName = inventoryResult.inventory.files[0]?.name;
      assert.equal(selectedFileName, fileName);
      const analysis = await client.callTool({
        name: "analyze_drive_file",
        arguments: { folder_url: folderUrl, file_name: selectedFileName },
      });
      assert.equal(analysis.isError, false);
      assert.deepEqual(analysis.structuredContent, analysisResult);
      assert.deepEqual(analysisCalls, [
        {
          requesterOpenId: "ou_victor",
          tenantKey: "tenant_synvo",
          folderLink: folderUrl,
          fileName,
        },
      ]);

      const identityOverride = await client.callTool({
        name: "organize_folder_inventory",
        arguments: {
          folder_url: folderUrl,
          requester_open_id: "ou_other",
        },
      });
      assert.equal(identityOverride.isError, true);
      assert.equal(inventoryCalls.length, 1);

      const analysisIdentityOverride = await client.callTool({
        name: "analyze_drive_file",
        arguments: {
          folder_url: folderUrl,
          file_name: fileName,
          requester_open_id: "ou_other",
        },
      });
      assert.equal(analysisIdentityOverride.isError, true);
      assert.equal(analysisCalls.length, 1);

      const knowledge = await client.callTool({
        name: "search_workspace_knowledge",
        arguments: { question: "How does retrieval work?" },
      });
      assert.equal(knowledge.isError, false);
      assert.deepEqual(knowledge.structuredContent, knowledgeResult);
      assert.deepEqual(knowledgeCalls, ["How does retrieval work?"]);

      const invalidKnowledge = await client.callTool({
        name: "search_workspace_knowledge",
        arguments: {
          question: "How does retrieval work?",
          workspace_folder_token: "fldcnOther",
        },
      });
      assert.equal(invalidKnowledge.isError, true);
      assert.equal(knowledgeCalls.length, 1);

      const obsoleteFileUrlContract = await client.callTool({
        name: "analyze_drive_file",
        arguments: {
          file_url: "https://synvo-ai.larksuite.com/file/boxcnPdf123",
        },
      });
      assert.equal(obsoleteFileUrlContract.isError, true);
      assert.equal(analysisCalls.length, 1);
    } finally {
      await client.close();
    }
  });
});
